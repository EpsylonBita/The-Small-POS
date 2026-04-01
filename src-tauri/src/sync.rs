//! Background sync engine for The Small POS.
//!
//! Manages order creation (local insert + sync queue entry) and a background
//! loop that batches pending sync operations and POSTs them to the admin
//! dashboard. Each entity type is synced independently so a failure in one
//! category does not block the others.
//!
//! # Partition Strategy
//!
//! Sync queue rows are partitioned by `entity_type` into seven categories,
//! each routed to a dedicated endpoint:
//!
//! | Category     | Entity types                                             | Endpoint                        |
//! |--------------|----------------------------------------------------------|---------------------------------|
//! | **Order**    | `order` (and any unrecognized type — catch-all)          | `POST /api/pos/orders` (direct) |
//! | **Shift**    | `shift`                                                  | `POST /api/pos/shifts/sync`     |
//! | **Financial**| `shift_expense`, `staff_payment`, `driver_earning(s)`    | `POST /api/pos/financial/sync`  |
//! | **Payment**  | `payment`                                                | `POST /api/pos/financial/sync`  |
//! | **Adjustment**| `payment_adjustment`                                    | `POST /api/pos/financial/sync`  |
//! | **ZReport**  | `z_report`                                               | `POST /api/pos/z-report/submit` |
//! | **Loyalty**  | `loyalty_transaction`                                    | `POST /api/pos/loyalty/sync`    |
//!
//! # State Machine
//!
//! Each `sync_queue` row transitions through:
//!
//! ```text
//! pending → in_progress → applied   (success)
//!                        → pending   (transient failure, retry scheduled)
//!                        → failed    (max retries exhausted)
//! deferred → pending                 (reconciliation promotes once parent synced)
//! waiting_parent → pending           (parent entity reached 'applied')
//! ```
//!
//! # Retry Strategy
//!
//! - Base delay: 5 seconds (`DEFAULT_RETRY_DELAY_MS`)
//! - Multiplier: 2× exponential backoff per retry
//! - Max delay: 5 minutes (`MAX_RETRY_DELAY_MS`)
//! - Max retries: 5 (default, per-row configurable)
//! - Backpressure (HTTP 429): delay extended, does not count as a failure
//!
//! # Background Loop
//!
//! [`start_sync_loop`] spawns a tokio task that runs every N seconds:
//!
//! 1. Check network connectivity
//! 2. Reconcile deferred payments and adjustments (promote to pending)
//! 3. Fetch up to 10 pending queue rows, mark as `in_progress`
//! 4. Partition by entity type and dispatch to batch sync functions
//! 5. Mark rows as `applied` or schedule retry on failure
//! 6. Emit `sync_status` event to the frontend

use chrono::{DateTime, Duration as ChronoDuration, Local, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tracing::{debug, error, info, trace, warn};
use uuid::Uuid;
use zeroize::Zeroizing;

use serde::Deserialize;

use crate::api;
use crate::business_day;
use crate::can_transition_locally;
use crate::db;
use crate::db::DbState;
use crate::normalize_status_for_storage;
use crate::order_ownership;
use crate::payments;
use crate::print;
use crate::storage;
use crate::APP_START_EPOCH;

// ---------------------------------------------------------------------------
// Typed sync response schemas
// ---------------------------------------------------------------------------

/// Response from `POST /api/pos/orders/sync` (batch queue endpoint).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct OrderBatchSyncResponse {
    #[serde(default)]
    pub receipt_id: Option<String>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Response from `POST /api/pos/orders` (direct single-order endpoint).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct OrderDirectSyncResponse {
    #[serde(default, alias = "id")]
    pub order_id: Option<String>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Individual result item in a financial batch sync response.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct FinancialSyncResultItem {
    #[serde(default)]
    pub entity_type: Option<String>,
    #[serde(default)]
    pub entity_id: Option<String>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub retryable: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub supabase_id: Option<String>,
}

/// Response from `POST /api/pos/financial/sync` (batch financial endpoint).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct FinancialBatchSyncResponse {
    #[serde(default)]
    pub results: Vec<FinancialSyncResultItem>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Response from `POST /api/pos/payments` (single payment sync).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct PaymentSyncResponse {
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default, alias = "id")]
    pub payment_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Response from `GET /api/pos/payments` (canonical payment sync-down).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct PaymentIncrementalSyncResponse {
    #[serde(default)]
    pub payments: Vec<Value>,
    #[serde(default)]
    pub sync_timestamp: Option<String>,
    #[serde(default)]
    pub total_count: Option<usize>,
    #[serde(default)]
    pub has_more: Option<bool>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Response from `POST /api/pos/z-report/submit`.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct ZReportSyncResponse {
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default, alias = "id")]
    pub report_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

const CLOSEOUT_SYNC_DRAIN_MAX_PASSES: usize = 4;
const CLOSEOUT_SYNC_BLOCKER_SUMMARY_LIMIT: i64 = 5;
const ADJUSTMENT_BLOCKER_PARENT_PAYMENT_NOT_SYNCED: &str = "parent_payment_not_synced";
const ADJUSTMENT_BLOCKER_PARENT_PAYMENT_MISSING_CANONICAL_REMOTE_ID: &str =
    "parent_payment_missing_canonical_remote_id";
const ADJUSTMENT_QUEUE_ERROR_PARENT_PAYMENT_NOT_SYNCED: &str = "Payment not yet synced";
const ADJUSTMENT_QUEUE_ERROR_PARENT_PAYMENT_MISSING_CANONICAL_REMOTE_ID: &str =
    "Parent payment missing canonical remote id";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnsyncedSyncQueueSnapshot {
    pub count: i64,
    pub blockers_summary: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloseoutSyncDrainState {
    pub passes_executed: usize,
    pub any_progress: bool,
    pub remaining_unsynced_count: i64,
    pub remaining_blockers_summary: String,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct DeferredAdjustmentAutoHealSummary {
    candidate_orders: usize,
    repaired_payment_mirrors: usize,
    rebound_adjustments: usize,
    promoted_adjustments: usize,
}

// ---------------------------------------------------------------------------
// Auth failure detection
// ---------------------------------------------------------------------------

fn is_terminal_auth_failure(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("invalid api key for terminal")
        || lower.contains("terminal identity mismatch")
        || lower.contains("api key is invalid or expired")
        || lower.contains("terminal not authorized")
        || lower.contains("terminal not found or inactive")
        || lower.contains("terminal not found")
}

fn load_zeroized_pos_api_key_optional() -> Option<Zeroizing<String>> {
    let raw_api_key = Zeroizing::new(storage::get_credential("pos_api_key")?);
    Some(Zeroizing::new(
        api::extract_api_key_from_connection_string(&raw_api_key)
            .unwrap_or_else(|| (*raw_api_key).clone()),
    ))
}

/// Handle terminal auth failures discovered inside the sync loop.
/// This preserves local operational data and only revokes credentials so the
/// terminal can be reconfigured without destroying recoverable state.
fn handle_terminal_auth_failure_from_sync(db: &DbState, app: &AppHandle, error: &str) {
    let reason = crate::terminal_access_reset_reason(error);
    warn!(
        reason = %reason,
        error = %error,
        "Sync loop detected terminal access revocation; preserving local data and forcing re-onboarding"
    );
    crate::handle_invalid_terminal_credentials(Some(db), app, "sync_loop", error);
}

// ---------------------------------------------------------------------------
// Sync engine state (managed by Tauri)
// ---------------------------------------------------------------------------

/// Managed state for the background sync engine.
pub struct SyncState {
    pub is_running: Arc<AtomicBool>,
    pub last_sync: Arc<std::sync::Mutex<Option<String>>>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct RecurringSyncRecoverySummary {
    business_day_repairs: usize,
    cashier_reference_requeues: usize,
    retryable_shift_requeues: usize,
    failed_shift_bound_financial_recoveries: usize,
    deferred_payment_promotions: usize,
    deferred_adjustment_promotions: usize,
    deferred_financial_promotions: usize,
}

impl RecurringSyncRecoverySummary {
    fn total_actions(&self) -> usize {
        self.business_day_repairs
            + self.cashier_reference_requeues
            + self.retryable_shift_requeues
            + self.failed_shift_bound_financial_recoveries
            + self.deferred_payment_promotions
            + self.deferred_adjustment_promotions
            + self.deferred_financial_promotions
    }
}

/// Ensure failed-order validation requeue runs once per process start.
static FAILED_ORDER_REQUEUE_DONE: AtomicBool = AtomicBool::new(false);
/// Disable stuck-receipt cleanup DELETE calls for this process when backend does not support it.
#[allow(dead_code)]
static STUCK_RECEIPT_CLEANUP_UNSUPPORTED: AtomicBool = AtomicBool::new(false);
/// Ensure old sync failure pruning runs once per process start.
static SYNC_FAILURE_PRUNE_DONE: AtomicBool = AtomicBool::new(false);
/// Ensure failed financial items (shift-not-found) are requeued once per session.
static FAILED_FINANCIAL_REQUEUE_DONE: AtomicBool = AtomicBool::new(false);
/// Requeue payment adjustments that failed against the old missing backend endpoint.
static PAYMENT_ADJUSTMENT_REQUEUE_DONE: AtomicBool = AtomicBool::new(false);
/// Re-enqueue shifts that were wrongly marked synced due to ignored per-event errors.
static SHIFT_REQUEUE_DONE: AtomicBool = AtomicBool::new(false);
/// Repair historical local z-report rows after cutoff so stale duplicates stop blocking close-day.
static Z_REPORT_HISTORY_REPAIR_DONE: AtomicBool = AtomicBool::new(false);
const DEFAULT_RETRY_DELAY_MS: i64 = 5_000;
const MAX_RETRY_DELAY_MS: i64 = 300_000;
const ORDER_SYNC_SINCE_FALLBACK: &str = "1970-01-01T00:00:00.000Z";
const SYNC_BOOTSTRAP_CATEGORY: &str = "sync";
const SYNC_BOOTSTRAP_MODE_KEY: &str = "bootstrap_mode";
const SYNC_BOOTSTRAP_MODE_LIVE: &str = "live";
const SYNC_BOOTSTRAP_MODE_REMOTE_REBUILD: &str = "bootstrap_remote_rebuild";
const SYNC_BOOTSTRAP_MODE_EMPTY_DB: &str = "bootstrap_empty_db";
#[allow(dead_code)]
const ORDER_DIRECT_FALLBACK_QUEUE_AGE_SEC: i64 = 600;
const SYNC_LOG_DEDUPE_COOLDOWN_SECS: i64 = 120;
pub(crate) const HISTORICAL_Z_REPORT_CONFLICT_PREFIX: &str = "historical_z_report_conflict:";
const Z_REPORT_FINALIZED_BOUND_CONFLICT_MESSAGE: &str =
    "Finalized Z-report period bounds cannot be changed without a rebuild flow";

#[derive(Debug, Clone)]
struct QueueFailureSnapshot {
    queue_id: i64,
    entity_type: String,
    entity_id: String,
    operation: String,
    status: String,
    retry_count: i64,
    max_retries: i64,
    next_retry_at: Option<String>,
    last_error: String,
    classification: String,
}

impl QueueFailureSnapshot {
    fn fingerprint(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}",
            self.entity_type,
            self.entity_id,
            self.last_error,
            self.retry_count,
            self.max_retries,
            self.status
        )
    }

    fn to_json(&self) -> Value {
        serde_json::json!({
            "queueId": self.queue_id,
            "entityType": self.entity_type,
            "entityId": self.entity_id,
            "operation": self.operation,
            "status": self.status,
            "retryCount": self.retry_count,
            "maxRetries": self.max_retries,
            "nextRetryAt": self.next_retry_at,
            "lastError": self.last_error,
            "classification": self.classification,
        })
    }

    fn next_retry_timestamp(&self) -> Option<DateTime<Utc>> {
        self.next_retry_at
            .as_deref()
            .and_then(parse_retry_timestamp)
    }

    fn has_future_retry(&self, now: DateTime<Utc>) -> bool {
        self.next_retry_timestamp()
            .map(|ts| ts > now)
            .unwrap_or(false)
    }

    fn blocker_rank(&self, now: DateTime<Utc>) -> i32 {
        let status = self.status.to_lowercase();
        let is_future_retry = self.has_future_retry(now);

        if status == "failed" || self.classification == "permanent" {
            return 0;
        }
        if status == "in_progress" {
            return 1;
        }
        if status == "pending" && !is_future_retry {
            return 2;
        }
        if status == "pending" {
            return 3;
        }
        4
    }
}

#[derive(Debug, Clone, Default)]
struct WarnLogDedupeState {
    last_fingerprint: Option<String>,
    last_warned_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default)]
struct ReconcileSkipLogState {
    last_logged_at: Option<DateTime<Utc>>,
    suppressed_count: u32,
}

static SYNC_WARN_LOG_DEDUPE_STATE: OnceLock<Mutex<WarnLogDedupeState>> = OnceLock::new();
static SYNC_BOOTSTRAP_LOG_DEDUPE_STATE: OnceLock<Mutex<WarnLogDedupeState>> = OnceLock::new();
static RECONCILE_SKIP_LOG_STATE: OnceLock<Mutex<HashMap<String, ReconcileSkipLogState>>> =
    OnceLock::new();

#[derive(Debug, Clone, Default)]
struct FinancialSyncStats {
    pending_payments: i64,
    failed_payments: i64,
    pending_adjustments: i64,
    failed_adjustments: i64,
    pending_driver_earnings: i64,
    failed_driver_earnings: i64,
    pending_staff_payments: i64,
    failed_staff_payments: i64,
    pending_shift_expenses: i64,
    failed_shift_expenses: i64,
}

impl FinancialSyncStats {
    fn pending_payment_items(&self) -> i64 {
        self.pending_payments + self.pending_adjustments
    }

    fn failed_payment_items(&self) -> i64 {
        self.failed_payments + self.failed_adjustments
    }

    fn total_pending(&self) -> i64 {
        self.pending_payment_items()
            + self.pending_driver_earnings
            + self.pending_staff_payments
            + self.pending_shift_expenses
    }

    fn total_failed(&self) -> i64 {
        self.failed_payment_items()
            + self.failed_driver_earnings
            + self.failed_staff_payments
            + self.failed_shift_expenses
    }

    fn to_json(&self) -> Value {
        serde_json::json!({
            "driver_earnings": {
                "pending": self.pending_driver_earnings,
                "failed": self.failed_driver_earnings,
            },
            "staff_payments": {
                "pending": self.pending_staff_payments,
                "failed": self.failed_staff_payments,
            },
            "shift_expenses": {
                "pending": self.pending_shift_expenses,
                "failed": self.failed_shift_expenses,
            },
            "payments": {
                "pending": self.pending_payment_items(),
                "failed": self.failed_payment_items(),
            },
            // Compatibility aliases for legacy UI call sites
            "pendingPayments": self.pending_payments,
            "failedPayments": self.failed_payments,
            "pendingAdjustments": self.pending_adjustments,
            "failedAdjustments": self.failed_adjustments,
            "pendingPaymentItems": self.pending_payment_items(),
            "failedPaymentItems": self.failed_payment_items(),
            "totalPending": self.total_pending(),
            "totalFailed": self.total_failed(),
        })
    }
}

/// Count rows in sync_queue matching the given WHERE clause.
///
/// SAFETY: `where_clause` is always a hardcoded string literal from
/// `collect_financial_sync_stats` — never user input. The callers pass
/// compile-time constant expressions containing entity_type/status filters.
fn count_sync_queue_rows(conn: &rusqlite::Connection, where_clause: &str) -> i64 {
    let query = format!("SELECT COUNT(*) FROM sync_queue WHERE {where_clause}");
    conn.query_row(&query, [], |row| row.get(0)).unwrap_or(0)
}

fn collect_financial_sync_stats(conn: &rusqlite::Connection) -> FinancialSyncStats {
    // Include deferred/queued rows because they still represent unsynced work.
    let pending_states = "('pending', 'in_progress', 'queued_remote', 'deferred')";
    let failed_states = "('failed')";

    FinancialSyncStats {
        pending_payments: count_sync_queue_rows(
            conn,
            &format!("entity_type IN ('payment', 'order_payment') AND status IN {pending_states}"),
        ),
        failed_payments: count_sync_queue_rows(
            conn,
            &format!("entity_type IN ('payment', 'order_payment') AND status IN {failed_states}"),
        ),
        pending_adjustments: count_sync_queue_rows(
            conn,
            &format!("entity_type = 'payment_adjustment' AND status IN {pending_states}"),
        ),
        failed_adjustments: count_sync_queue_rows(
            conn,
            &format!("entity_type = 'payment_adjustment' AND status IN {failed_states}"),
        ),
        pending_driver_earnings: count_sync_queue_rows(
            conn,
            &format!("entity_type IN ('driver_earning', 'driver_earnings') AND status IN {pending_states}"),
        ),
        failed_driver_earnings: count_sync_queue_rows(
            conn,
            &format!("entity_type IN ('driver_earning', 'driver_earnings') AND status IN {failed_states}"),
        ),
        pending_staff_payments: count_sync_queue_rows(
            conn,
            &format!("entity_type = 'staff_payment' AND status IN {pending_states}"),
        ),
        failed_staff_payments: count_sync_queue_rows(
            conn,
            &format!("entity_type = 'staff_payment' AND status IN {failed_states}"),
        ),
        pending_shift_expenses: count_sync_queue_rows(
            conn,
            &format!("entity_type = 'shift_expense' AND status IN {pending_states}"),
        ),
        failed_shift_expenses: count_sync_queue_rows(
            conn,
            &format!("entity_type = 'shift_expense' AND status IN {failed_states}"),
        ),
    }
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
            last_sync: Arc::new(std::sync::Mutex::new(None)),
        }
    }
}

// ---------------------------------------------------------------------------
// Order number generation
// ---------------------------------------------------------------------------

/// Generate a sequential order number in format ORD-DDMMYYYY-NNNNN.
///
/// Uses `local_settings` (category='orders', key='order_counter') as a
/// persistent counter. The counter is reset to 0 when a Z-report is generated
/// via `submit_z_report()`.
fn next_order_number(conn: &rusqlite::Connection) -> String {
    let today = chrono::Local::now();
    let date_display = today.format("%d%m%Y").to_string();

    let current: i64 = conn
        .query_row(
            "SELECT setting_value FROM local_settings \
             WHERE setting_category = 'orders' AND setting_key = 'order_counter'",
            [],
            |row| {
                row.get::<_, String>(0)
                    .map(|v| v.parse::<i64>().unwrap_or(0))
            },
        )
        .unwrap_or(0);

    let next = current + 1;
    let _ = conn.execute(
        "INSERT INTO local_settings (setting_category, setting_key, setting_value, updated_at) \
         VALUES ('orders', 'order_counter', ?1, datetime('now')) \
         ON CONFLICT(setting_category, setting_key) DO UPDATE SET \
            setting_value = excluded.setting_value, updated_at = excluded.updated_at",
        params![next.to_string()],
    );

    format!("ORD-{}-{:05}", date_display, next)
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

fn validate_string_length(field: &str, value: &str, max: usize) -> Result<(), String> {
    if value.len() > max {
        return Err(format!(
            "{field} exceeds maximum length of {max} characters"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Order creation
// ---------------------------------------------------------------------------

/// Create an order locally: insert into `orders` table and enqueue for sync.
pub fn create_order(db: &DbState, payload: &Value) -> Result<Value, String> {
    // Validate menu items BEFORE acquiring the connection lock to avoid
    // deadlock: menu::read_cache() also calls db.conn.lock() and
    // std::sync::Mutex is not reentrant.
    if let Some(items_val) = payload.get("items") {
        if let Err(invalid_ids) = validate_menu_items_against_cache(db, items_val) {
            warn!(
                invalid_ids = ?invalid_ids,
                "Order creation blocked: menu items not in local cache"
            );
            return Err(format!(
                "Cannot create order: menu items not found in local cache: {}. Please refresh menu.",
                invalid_ids.join(", ")
            ));
        }
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let client_request_id = str_field(payload, "clientRequestId")
        .or_else(|| str_field(payload, "client_request_id"))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    // Idempotency guard: if this checkout request has already created an order,
    // return that existing order id instead of inserting a duplicate row.
    if let Some(req_id) = client_request_id.as_deref() {
        let existing_order_id: Option<String> = conn
            .query_row(
                "SELECT id FROM orders WHERE client_request_id = ?1 LIMIT 1",
                params![req_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("query idempotent order: {e}"))?;

        if let Some(order_id) = existing_order_id {
            info!(
                order_id = %order_id,
                client_request_id = %req_id,
                "Order create deduplicated via client_request_id"
            );
            return Ok(serde_json::json!({
                "success": true,
                "orderId": &order_id,
                "data": { "orderId": &order_id },
                "order": { "id": &order_id },
                "deduplicated": true
            }));
        }
    }

    let order_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    let normalize_identity = |value: Option<String>| -> Option<String> {
        value.and_then(|raw| {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                return None;
            }
            let lower = trimmed.to_ascii_lowercase();
            if lower == "default-branch"
                || lower == "default-terminal"
                || lower == "default-organization"
                || lower == "default-org"
                || lower == "default"
            {
                return None;
            }
            Some(trimmed)
        })
    };

    let terminal_id = normalize_identity(
        str_field(payload, "terminalId").or_else(|| str_field(payload, "terminal_id")),
    )
    .or_else(|| normalize_identity(storage::get_credential("terminal_id")))
    .unwrap_or_default();

    let branch_id = normalize_identity(
        str_field(payload, "branchId").or_else(|| str_field(payload, "branch_id")),
    )
    .or_else(|| normalize_identity(storage::get_credential("branch_id")))
    .unwrap_or_default();

    let organization_id = normalize_identity(
        str_field(payload, "organizationId").or_else(|| str_field(payload, "organization_id")),
    )
    .or_else(|| normalize_identity(storage::get_credential("organization_id")));

    // Extract fields from payload with defaults
    let order_number = Some(next_order_number(&conn));
    let customer_name =
        str_field(payload, "customerName").or_else(|| str_field(payload, "customer_name"));
    let customer_phone =
        str_field(payload, "customerPhone").or_else(|| str_field(payload, "customer_phone"));
    let customer_email =
        str_field(payload, "customerEmail").or_else(|| str_field(payload, "customer_email"));
    let customer_id =
        str_field(payload, "customerId").or_else(|| str_field(payload, "customer_id"));

    // Validate user-facing string field lengths
    if let Some(ref v) = customer_name {
        validate_string_length("customer_name", v, 200)?;
    }
    if let Some(ref v) = customer_phone {
        validate_string_length("customer_phone", v, 50)?;
    }
    if let Some(ref v) = customer_email {
        validate_string_length("customer_email", v, 254)?;
    }

    let items = payload
        .get("items")
        .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string()))
        .unwrap_or_else(|| "[]".to_string());
    let total_amount = num_field(payload, "totalAmount")
        .or_else(|| num_field(payload, "total_amount"))
        .unwrap_or(0.0);
    let tax_amount = num_field(payload, "taxAmount")
        .or_else(|| num_field(payload, "tax_amount"))
        .unwrap_or(0.0);
    let subtotal = num_field(payload, "subtotal").unwrap_or(0.0);
    let status = str_field(payload, "status").unwrap_or_else(|| "pending".to_string());
    let order_type = str_field(payload, "orderType")
        .or_else(|| str_field(payload, "order_type"))
        .unwrap_or_else(|| "dine-in".to_string());
    let table_number =
        str_field(payload, "tableNumber").or_else(|| str_field(payload, "table_number"));
    let delivery_address =
        str_field(payload, "deliveryAddress").or_else(|| str_field(payload, "delivery_address"));
    let delivery_city =
        str_field(payload, "deliveryCity").or_else(|| str_field(payload, "delivery_city"));
    let delivery_postal_code = str_field(payload, "deliveryPostalCode")
        .or_else(|| str_field(payload, "delivery_postal_code"));
    let delivery_floor =
        str_field(payload, "deliveryFloor").or_else(|| str_field(payload, "delivery_floor"));
    let delivery_notes =
        str_field(payload, "deliveryNotes").or_else(|| str_field(payload, "delivery_notes"));
    let name_on_ringer =
        str_field(payload, "nameOnRinger").or_else(|| str_field(payload, "name_on_ringer"));
    let special_instructions = str_field(payload, "specialInstructions")
        .or_else(|| str_field(payload, "special_instructions"));
    if let Some(ref v) = delivery_notes {
        validate_string_length("delivery_notes", v, 2000)?;
    }
    if let Some(ref v) = special_instructions {
        validate_string_length("special_instructions", v, 2000)?;
    }
    if let Some(ref v) = delivery_address {
        validate_string_length("delivery_address", v, 500)?;
    }
    let estimated_time = payload
        .get("estimatedTime")
        .or_else(|| payload.get("estimated_time"))
        .and_then(Value::as_i64);
    let initial_payment_payload = payload
        .get("initialPayment")
        .or_else(|| payload.get("initial_payment"))
        .cloned();
    let payment_status = str_field(payload, "paymentStatus")
        .or_else(|| str_field(payload, "payment_status"))
        .unwrap_or_else(|| "pending".to_string());
    let payment_method =
        str_field(payload, "paymentMethod").or_else(|| str_field(payload, "payment_method"));
    let persisted_payment_status = if initial_payment_payload.is_some() {
        "pending".to_string()
    } else {
        payment_status.clone()
    };
    let requested_staff_id =
        str_field(payload, "staffId").or_else(|| str_field(payload, "staff_id"));
    let requested_driver_id =
        str_field(payload, "driverId").or_else(|| str_field(payload, "driver_id"));
    let driver_id = if order_type.eq_ignore_ascii_case("delivery") {
        requested_driver_id
    } else {
        None
    };
    let driver_name = if order_type.eq_ignore_ascii_case("delivery") {
        str_field(payload, "driverName").or_else(|| str_field(payload, "driver_name"))
    } else {
        None
    };
    let requested_staff_shift_id =
        str_field(payload, "staffShiftId").or_else(|| str_field(payload, "staff_shift_id"));
    let discount_percentage = num_field(payload, "discountPercentage")
        .or_else(|| num_field(payload, "discount_percentage"))
        .unwrap_or(0.0);
    let discount_amount = num_field(payload, "discountAmount")
        .or_else(|| num_field(payload, "discount_amount"))
        .unwrap_or(0.0);
    let tip_amount = num_field(payload, "tipAmount")
        .or_else(|| num_field(payload, "tip_amount"))
        .unwrap_or(0.0);
    let tax_rate = num_field(payload, "taxRate").or_else(|| num_field(payload, "tax_rate"));
    let delivery_fee = num_field(payload, "deliveryFee")
        .or_else(|| num_field(payload, "delivery_fee"))
        .unwrap_or(0.0);
    let plugin = str_field(payload, "plugin");
    let is_ghost = payload
        .get("is_ghost")
        .or_else(|| payload.get("isGhost"))
        .and_then(|value| {
            if let Some(flag) = value.as_bool() {
                return Some(flag);
            }
            if let Some(flag) = value.as_i64() {
                return Some(flag == 1);
            }
            value.as_str().and_then(|flag| {
                let normalized = flag.trim().to_ascii_lowercase();
                if normalized == "true"
                    || normalized == "1"
                    || normalized == "yes"
                    || normalized == "on"
                {
                    Some(true)
                } else if normalized == "false"
                    || normalized == "0"
                    || normalized == "no"
                    || normalized == "off"
                {
                    Some(false)
                } else {
                    None
                }
            })
        })
        .unwrap_or(false);
    let ghost_source =
        str_field(payload, "ghost_source").or_else(|| str_field(payload, "ghostSource"));
    let ghost_metadata = payload
        .get("ghost_metadata")
        .or_else(|| payload.get("ghostMetadata"))
        .and_then(|value| {
            if value.is_null() {
                return None;
            }
            if let Some(raw) = value.as_str() {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return None;
                }
                return Some(trimmed.to_string());
            }
            Some(value.to_string())
        });

    let (resolved_staff_shift_id, resolved_staff_id) = order_ownership::resolve_order_owner(
        &conn,
        &order_type,
        &branch_id,
        &terminal_id,
        driver_id.as_deref(),
        requested_staff_shift_id.as_deref(),
        requested_staff_id.as_deref(),
    )?;

    // Wrap order + sync_queue inserts in a transaction to prevent
    // orphaned orders (order exists locally but never syncs).
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin order transaction: {e}"))?;

    conn.execute(
        "INSERT INTO orders (
            id, order_number, customer_name, customer_phone, customer_email, customer_id,
            items, total_amount, tax_amount, subtotal, status,
            order_type, table_number, delivery_address, delivery_city, delivery_postal_code,
            delivery_floor, delivery_notes, name_on_ringer, special_instructions,
            created_at, updated_at, estimated_time, sync_status, payment_status, payment_method,
            staff_shift_id, staff_id, driver_id, driver_name, discount_percentage,
            discount_amount, tip_amount, version, terminal_id, branch_id, plugin, tax_rate,
            delivery_fee, client_request_id, is_ghost, ghost_source, ghost_metadata
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9, ?10, ?11,
            ?12, ?13, ?14, ?15, ?16,
            ?17, ?18, ?19, ?20,
            ?21, ?22, ?23, 'pending', ?24, ?25,
            ?26, ?27, ?28, ?29, ?30,
            ?31, ?32, 1, ?33, ?34, ?35, ?36,
            ?37, ?38, ?39, ?40, ?41
        )",
        params![
            &order_id,
            &order_number,
            &customer_name,
            &customer_phone,
            &customer_email,
            &customer_id,
            &items,
            &total_amount,
            &tax_amount,
            &subtotal,
            &status,
            &order_type,
            &table_number,
            &delivery_address,
            &delivery_city,
            &delivery_postal_code,
            &delivery_floor,
            &delivery_notes,
            &name_on_ringer,
            &special_instructions,
            &now,
            &now,
            &estimated_time,
            &persisted_payment_status,
            &payment_method,
            &resolved_staff_shift_id,
            &resolved_staff_id,
            &driver_id,
            &driver_name,
            &discount_percentage,
            &discount_amount,
            &tip_amount,
            &terminal_id,
            &branch_id,
            &plugin,
            &tax_rate,
            &delivery_fee,
            &client_request_id,
            &(if is_ghost { 1_i64 } else { 0_i64 }),
            &ghost_source,
            &ghost_metadata,
        ],
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK");
        format!("insert order: {e}")
    })?;

    if let Some(initial_payment_payload) = initial_payment_payload.clone() {
        let mut enriched_initial_payment = initial_payment_payload;
        if let Value::Object(obj) = &mut enriched_initial_payment {
            obj.insert("orderId".to_string(), Value::String(order_id.clone()));
            obj.entry("staffShiftId".to_string()).or_insert_with(|| {
                resolved_staff_shift_id
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null)
            });
            obj.entry("staffId".to_string()).or_insert_with(|| {
                resolved_staff_id
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null)
            });
        }

        let payment_input = crate::payments::build_payment_record_input(&enriched_initial_payment)
            .map_err(|e| {
                let _ = conn.execute_batch("ROLLBACK");
                format!("prepare initial payment: {e}")
            })?;

        crate::payments::record_payment_in_connection(
            &conn,
            &payment_input,
            &crate::payments::PaymentInsertOptions::local(),
        )
        .map_err(|e| {
            let _ = conn.execute_batch("ROLLBACK");
            format!("record initial payment: {e}")
        })?;
    }

    // Enqueue for sync
    let idempotency_key = format!("{terminal_id}:{order_id}:{}", Uuid::new_v4());
    let mut sync_data = payload.clone();
    if let Value::Object(obj) = &mut sync_data {
        obj.remove("initialPayment");
        obj.remove("initial_payment");
        obj.entry("orderId".to_string())
            .or_insert_with(|| Value::String(order_id.clone()));
        if !terminal_id.trim().is_empty() {
            obj.insert("terminalId".to_string(), Value::String(terminal_id.clone()));
            obj.insert(
                "terminal_id".to_string(),
                Value::String(terminal_id.clone()),
            );
        }
        if !branch_id.trim().is_empty() {
            obj.insert("branchId".to_string(), Value::String(branch_id.clone()));
            obj.insert("branch_id".to_string(), Value::String(branch_id.clone()));
        }
        if let Some(org_id) = organization_id.as_ref() {
            obj.insert("organizationId".to_string(), Value::String(org_id.clone()));
            obj.insert("organization_id".to_string(), Value::String(org_id.clone()));
        }
        // Ensure the Rust-generated order number is synced to admin
        if let Some(ref num) = order_number {
            obj.insert("orderNumber".to_string(), Value::String(num.clone()));
            obj.insert("order_number".to_string(), Value::String(num.clone()));
        }
        if let Some(req_id) = client_request_id.as_ref() {
            obj.entry("clientRequestId".to_string())
                .or_insert_with(|| Value::String(req_id.clone()));
        }
        match resolved_staff_shift_id.as_ref() {
            Some(shift_id) => {
                obj.insert("staffShiftId".to_string(), Value::String(shift_id.clone()));
                obj.insert(
                    "staff_shift_id".to_string(),
                    Value::String(shift_id.clone()),
                );
            }
            None => {
                obj.insert("staffShiftId".to_string(), Value::Null);
                obj.insert("staff_shift_id".to_string(), Value::Null);
            }
        }
        match resolved_staff_id.as_ref() {
            Some(staff_id) => {
                obj.insert("staffId".to_string(), Value::String(staff_id.clone()));
                obj.insert("staff_id".to_string(), Value::String(staff_id.clone()));
            }
            None => {
                obj.insert("staffId".to_string(), Value::Null);
                obj.insert("staff_id".to_string(), Value::Null);
            }
        }
        match driver_id.as_ref() {
            Some(driver_id) => {
                obj.insert("driverId".to_string(), Value::String(driver_id.clone()));
                obj.insert("driver_id".to_string(), Value::String(driver_id.clone()));
            }
            None => {
                obj.insert("driverId".to_string(), Value::Null);
                obj.insert("driver_id".to_string(), Value::Null);
            }
        }
        match driver_name.as_ref() {
            Some(driver_name) => {
                obj.insert("driverName".to_string(), Value::String(driver_name.clone()));
                obj.insert(
                    "driver_name".to_string(),
                    Value::String(driver_name.clone()),
                );
            }
            None => {
                obj.insert("driverName".to_string(), Value::Null);
                obj.insert("driver_name".to_string(), Value::Null);
            }
        }
    }
    let sync_payload = serde_json::to_string(&sync_data).unwrap_or_else(|_| "{}".to_string());

    conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('order', ?1, 'insert', ?2, ?3)",
        params![&order_id, sync_payload, idempotency_key],
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK");
        format!("enqueue sync: {e}")
    })?;

    conn.execute_batch("COMMIT")
        .map_err(|e| format!("commit order transaction: {e}"))?;

    drop(conn);

    // Skip auto-print for ghost orders and pending/split payment orders.
    // Split payment receipts are printed after individual payments are recorded.
    let skip_auto_print = is_ghost || payment_method.as_deref() == Some("pending");
    info!(
        order_id = %order_id,
        payment_method = ?payment_method,
        is_ghost = %is_ghost,
        skip_auto_print = %skip_auto_print,
        "Auto-print decision for new order"
    );
    if !skip_auto_print {
        for entity_type in print::auto_print_entity_types_for_order_type(&order_type) {
            if let Err(error) = print::enqueue_print_job(db, entity_type, &order_id, None) {
                warn!(
                    order_id = %order_id,
                    entity_type = %entity_type,
                    error = %error,
                    "Failed to enqueue automatic print job after local create"
                );
            }
        }
    }

    info!(order_id = %order_id, "Order created and queued for sync");

    Ok(serde_json::json!({
        "success": true,
        "orderId": &order_id,
        "data": {
            "orderId": &order_id
        },
        "order": {
            "id": &order_id,
            "orderNumber": &order_number,
            "status": &status,
            "orderType": &order_type,
            "totalAmount": total_amount,
            "taxAmount": tax_amount,
            "subtotal": subtotal,
            "syncStatus": "pending",
            "createdAt": &now,
            "terminalId": &terminal_id,
            "branchId": &branch_id,
        }
    }))
}

// ---------------------------------------------------------------------------
// Order queries
// ---------------------------------------------------------------------------

/// Get all orders, most recent first.
pub fn get_all_orders(db: &DbState) -> Result<Vec<Value>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, order_number, customer_name, customer_phone, customer_email, customer_id,
                    items, total_amount, tax_amount, subtotal, status,
                    cancellation_reason, order_type, table_number, delivery_address,
                    delivery_notes, name_on_ringer, special_instructions,
                    created_at, updated_at, estimated_time, supabase_id,
                    sync_status, payment_status, payment_method,
                    payment_transaction_id, staff_shift_id, staff_id,
                    discount_percentage, discount_amount, tip_amount,
                    version, updated_by, last_synced_at, remote_version,
                    terminal_id, branch_id, plugin, external_plugin_order_id,
                    tax_rate, delivery_fee, is_ghost, ghost_source, ghost_metadata,
                    delivery_city, delivery_postal_code, delivery_floor, driver_id, driver_name
             FROM orders
             WHERE COALESCE(is_ghost, 0) = 0
             ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            // Parse items JSON
            let items_str: String = row.get(6)?;
            let items: Value = serde_json::from_str(&items_str).unwrap_or_else(|e| {
                warn!("JSON parse fallback (items): {e}");
                Value::Array(vec![])
            });
            let ghost_metadata_str: Option<String> = row.get(43)?;
            let ghost_metadata = ghost_metadata_str
                .as_deref()
                .map(|raw| {
                    serde_json::from_str::<Value>(raw).unwrap_or_else(|e| {
                        warn!("JSON parse fallback (ghost_metadata): {e}");
                        Value::Null
                    })
                })
                .unwrap_or(Value::Null);
            let is_ghost = row.get::<_, Option<i64>>(41)?.unwrap_or(0) != 0;

            Ok(serde_json::json!({
                "id": row.get::<_, Option<String>>(0)?,
                "orderNumber": row.get::<_, Option<String>>(1)?,
                "customerName": row.get::<_, Option<String>>(2)?,
                "customerPhone": row.get::<_, Option<String>>(3)?,
                "customerEmail": row.get::<_, Option<String>>(4)?,
                "customerId": row.get::<_, Option<String>>(5)?,
                "customer_id": row.get::<_, Option<String>>(5)?,
                "items": items,
                "totalAmount": row.get::<_, f64>(7)?,
                "taxAmount": row.get::<_, Option<f64>>(8)?,
                "subtotal": row.get::<_, Option<f64>>(9)?,
                "status": row.get::<_, String>(10)?,
                "cancellationReason": row.get::<_, Option<String>>(11)?,
                "orderType": row.get::<_, Option<String>>(12)?,
                "tableNumber": row.get::<_, Option<String>>(13)?,
                "deliveryAddress": row.get::<_, Option<String>>(14)?,
                "deliveryNotes": row.get::<_, Option<String>>(15)?,
                "nameOnRinger": row.get::<_, Option<String>>(16)?,
                "specialInstructions": row.get::<_, Option<String>>(17)?,
                "createdAt": row.get::<_, Option<String>>(18)?,
                "updatedAt": row.get::<_, Option<String>>(19)?,
                "estimatedTime": row.get::<_, Option<i64>>(20)?,
                "supabaseId": row.get::<_, Option<String>>(21)?,
                "syncStatus": row.get::<_, String>(22)?,
                "paymentStatus": row.get::<_, Option<String>>(23)?,
                "paymentMethod": row.get::<_, Option<String>>(24)?,
                "paymentTransactionId": row.get::<_, Option<String>>(25)?,
                "staffShiftId": row.get::<_, Option<String>>(26)?,
                "staffId": row.get::<_, Option<String>>(27)?,
                "discountPercentage": row.get::<_, Option<f64>>(28)?,
                "discountAmount": row.get::<_, Option<f64>>(29)?,
                "tipAmount": row.get::<_, Option<f64>>(30)?,
                "version": row.get::<_, Option<i64>>(31)?,
                "updatedBy": row.get::<_, Option<String>>(32)?,
                "lastSyncedAt": row.get::<_, Option<String>>(33)?,
                "remoteVersion": row.get::<_, Option<i64>>(34)?,
                "terminalId": row.get::<_, Option<String>>(35)?,
                "branchId": row.get::<_, Option<String>>(36)?,
                "plugin": row.get::<_, Option<String>>(37)?,
                "externalPluginOrderId": row.get::<_, Option<String>>(38)?,
                "taxRate": row.get::<_, Option<f64>>(39)?,
                "deliveryFee": row.get::<_, Option<f64>>(40)?,
                "is_ghost": is_ghost,
                "isGhost": is_ghost,
                "ghost_source": row.get::<_, Option<String>>(42)?,
                "ghostSource": row.get::<_, Option<String>>(42)?,
                "ghost_metadata": ghost_metadata,
                "ghostMetadata": ghost_metadata,
                "deliveryCity": row.get::<_, Option<String>>(44)?,
                "delivery_city": row.get::<_, Option<String>>(44)?,
                "deliveryPostalCode": row.get::<_, Option<String>>(45)?,
                "delivery_postal_code": row.get::<_, Option<String>>(45)?,
                "deliveryFloor": row.get::<_, Option<String>>(46)?,
                "delivery_floor": row.get::<_, Option<String>>(46)?,
                "driverId": row.get::<_, Option<String>>(47)?,
                "driver_id": row.get::<_, Option<String>>(47)?,
                "driverName": row.get::<_, Option<String>>(48)?,
                "driver_name": row.get::<_, Option<String>>(48)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut orders = Vec::new();
    for row in rows {
        match row {
            Ok(order) => orders.push(order),
            Err(e) => warn!("skipping malformed order row: {e}"),
        }
    }
    Ok(orders)
}

/// Get a single order by ID.
pub fn get_order_by_id(db: &DbState, id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let result = conn.query_row(
        "SELECT id, order_number, customer_name, customer_phone, customer_email, customer_id,
                items, total_amount, tax_amount, subtotal, status,
                cancellation_reason, order_type, table_number, delivery_address,
                delivery_notes, name_on_ringer, special_instructions,
                created_at, updated_at, estimated_time, supabase_id,
                sync_status, payment_status, payment_method,
                payment_transaction_id, staff_shift_id, staff_id,
                discount_percentage, discount_amount, tip_amount,
                version, updated_by, last_synced_at, remote_version,
                terminal_id, branch_id, plugin, external_plugin_order_id,
                tax_rate, delivery_fee, is_ghost, ghost_source, ghost_metadata,
                delivery_city, delivery_postal_code, delivery_floor, driver_id, driver_name
        FROM orders WHERE id = ?1",
        params![id],
        |row| {
            let items_str: String = row.get(6)?;
            let items: Value = serde_json::from_str(&items_str).unwrap_or_else(|e| {
                warn!("JSON parse fallback (items): {e}");
                Value::Array(vec![])
            });
            let ghost_metadata_str: Option<String> = row.get(43)?;
            let ghost_metadata = ghost_metadata_str
                .as_deref()
                .map(|raw| {
                    serde_json::from_str::<Value>(raw).unwrap_or_else(|e| {
                        warn!("JSON parse fallback (ghost_metadata): {e}");
                        Value::Null
                    })
                })
                .unwrap_or(Value::Null);
            let is_ghost = row.get::<_, Option<i64>>(41)?.unwrap_or(0) != 0;
            let ghost_source: Option<String> = row.get(42)?;

            Ok(serde_json::json!({
                "id": row.get::<_, Option<String>>(0)?,
                "orderNumber": row.get::<_, Option<String>>(1)?,
                "customerName": row.get::<_, Option<String>>(2)?,
                "customerPhone": row.get::<_, Option<String>>(3)?,
                "customerEmail": row.get::<_, Option<String>>(4)?,
                "customerId": row.get::<_, Option<String>>(5)?,
                "customer_id": row.get::<_, Option<String>>(5)?,
                "items": items,
                "totalAmount": row.get::<_, f64>(7)?,
                "taxAmount": row.get::<_, Option<f64>>(8)?,
                "subtotal": row.get::<_, Option<f64>>(9)?,
                "status": row.get::<_, String>(10)?,
                "cancellationReason": row.get::<_, Option<String>>(11)?,
                "orderType": row.get::<_, Option<String>>(12)?,
                "tableNumber": row.get::<_, Option<String>>(13)?,
                "deliveryAddress": row.get::<_, Option<String>>(14)?,
                "deliveryNotes": row.get::<_, Option<String>>(15)?,
                "nameOnRinger": row.get::<_, Option<String>>(16)?,
                "specialInstructions": row.get::<_, Option<String>>(17)?,
                "createdAt": row.get::<_, Option<String>>(18)?,
                "updatedAt": row.get::<_, Option<String>>(19)?,
                "estimatedTime": row.get::<_, Option<i64>>(20)?,
                "supabaseId": row.get::<_, Option<String>>(21)?,
                "syncStatus": row.get::<_, String>(22)?,
                "paymentStatus": row.get::<_, Option<String>>(23)?,
                "paymentMethod": row.get::<_, Option<String>>(24)?,
                "paymentTransactionId": row.get::<_, Option<String>>(25)?,
                "staffShiftId": row.get::<_, Option<String>>(26)?,
                "staffId": row.get::<_, Option<String>>(27)?,
                "discountPercentage": row.get::<_, Option<f64>>(28)?,
                "discountAmount": row.get::<_, Option<f64>>(29)?,
                "tipAmount": row.get::<_, Option<f64>>(30)?,
                "version": row.get::<_, Option<i64>>(31)?,
                "updatedBy": row.get::<_, Option<String>>(32)?,
                "lastSyncedAt": row.get::<_, Option<String>>(33)?,
                "remoteVersion": row.get::<_, Option<i64>>(34)?,
                "terminalId": row.get::<_, Option<String>>(35)?,
                "branchId": row.get::<_, Option<String>>(36)?,
                "plugin": row.get::<_, Option<String>>(37)?,
                "externalPluginOrderId": row.get::<_, Option<String>>(38)?,
                "taxRate": row.get::<_, Option<f64>>(39)?,
                "deliveryFee": row.get::<_, Option<f64>>(40)?,
                "is_ghost": is_ghost,
                "isGhost": is_ghost,
                "ghost_source": ghost_source,
                "ghostSource": ghost_source,
                "ghost_metadata": ghost_metadata,
                "ghostMetadata": ghost_metadata,
                "deliveryCity": row.get::<_, Option<String>>(44)?,
                "delivery_city": row.get::<_, Option<String>>(44)?,
                "deliveryPostalCode": row.get::<_, Option<String>>(45)?,
                "delivery_postal_code": row.get::<_, Option<String>>(45)?,
                "deliveryFloor": row.get::<_, Option<String>>(46)?,
                "delivery_floor": row.get::<_, Option<String>>(46)?,
                "driverId": row.get::<_, Option<String>>(47)?,
                "driver_id": row.get::<_, Option<String>>(47)?,
                "driverName": row.get::<_, Option<String>>(48)?,
                "driver_name": row.get::<_, Option<String>>(48)?,
            }))
        },
    );

    match result {
        Ok(order) => Ok(order),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Value::Null),
        Err(e) => Err(format!("get order: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Sync repair and diagnostics
// ---------------------------------------------------------------------------

/// Validate all pending orders in the sync queue against the local menu cache.
/// Returns a report of valid and invalid orders with details.
pub fn validate_pending_orders(db: &DbState) -> Result<Value, String> {
    // Step 1: Collect pending entry IDs under the lock, then release it.
    // We must NOT call get_order_by_id() or validate_menu_items_against_cache()
    // while holding the lock — both re-acquire db.conn.lock() internally,
    // which would deadlock (std::sync::Mutex is not reentrant).
    let pending_entries: Vec<(i64, String, Option<String>)> = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, entity_id, created_at
                 FROM sync_queue
                 WHERE entity_type = 'order'
                   AND status IN ('pending', 'in_progress', 'queued_remote')
                 ORDER BY created_at ASC",
            )
            .map_err(|e| format!("prepare query: {e}"))?;

        let result: Vec<_> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| format!("query sync_queue: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        result
    }; // lock released here

    // Step 2: Validate each order without holding the lock.
    let mut valid_count = 0;
    let mut invalid_count = 0;
    let mut invalid_orders = Vec::new();

    for (queue_id, entity_id, created_at) in pending_entries {
        // get_order_by_id acquires its own lock internally
        let order = get_order_by_id(db, &entity_id).unwrap_or_else(|e| {
            warn!(order_id = %entity_id, "get_order_by_id fallback: {e}");
            Value::Null
        });

        if order.is_null() {
            invalid_count += 1;
            invalid_orders.push(serde_json::json!({
                "order_id": entity_id,
                "queue_id": queue_id,
                "invalid_menu_items": [],
                "created_at": created_at,
                "reason": "Order not found in local database"
            }));
            continue;
        }

        // Validate menu items — also acquires its own lock internally
        if let Some(items) = order.get("items") {
            match validate_menu_items_against_cache(db, items) {
                Ok(()) => {
                    valid_count += 1;
                }
                Err(invalid_ids) => {
                    invalid_count += 1;
                    invalid_orders.push(serde_json::json!({
                        "order_id": entity_id,
                        "queue_id": queue_id,
                        "invalid_menu_items": invalid_ids,
                        "created_at": created_at,
                        "reason": "Menu items not found in local cache"
                    }));
                }
            }
        } else {
            // No items field, consider valid (might be a deletion or other operation)
            valid_count += 1;
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "total_pending": valid_count + invalid_count,
        "valid": valid_count,
        "invalid": invalid_count,
        "invalid_orders": invalid_orders
    }))
}

/// Remove specified orders from the sync queue.
/// This is a repair operation for orders that cannot be synced (e.g., invalid menu items).
pub fn remove_invalid_orders(db: &DbState, order_ids: Vec<String>) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    if order_ids.is_empty() {
        return Ok(serde_json::json!({
            "success": true,
            "removed": 0,
            "message": "No order IDs provided"
        }));
    }

    // Build placeholders for the IN clause
    let placeholders = order_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query = format!(
        "DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id IN ({})",
        placeholders
    );

    let params: Vec<&dyn rusqlite::ToSql> = order_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();

    let removed = conn
        .execute(&query, params.as_slice())
        .map_err(|e| format!("delete from sync_queue: {e}"))?;

    info!(
        removed = removed,
        order_ids = ?order_ids,
        "Removed invalid orders from sync queue"
    );

    Ok(serde_json::json!({
        "success": true,
        "removed": removed,
        "order_ids": order_ids
    }))
}

// ---------------------------------------------------------------------------
// Sync status queries
// ---------------------------------------------------------------------------

fn historical_z_report_conflict_pattern() -> String {
    format!("{HISTORICAL_Z_REPORT_CONFLICT_PREFIX}%")
}

fn is_historical_z_report_conflict_error(error: &str) -> bool {
    let trimmed = error.trim();
    if trimmed.starts_with(HISTORICAL_Z_REPORT_CONFLICT_PREFIX) {
        return true;
    }

    let lower = trimmed.to_ascii_lowercase();
    lower.contains(&Z_REPORT_FINALIZED_BOUND_CONFLICT_MESSAGE.to_ascii_lowercase())
        && lower.contains("http 409")
}

fn park_historical_z_report_conflict_error(error: &str) -> String {
    if error
        .trim()
        .starts_with(HISTORICAL_Z_REPORT_CONFLICT_PREFIX)
    {
        error.trim().to_string()
    } else {
        format!("{HISTORICAL_Z_REPORT_CONFLICT_PREFIX}{error}")
    }
}

fn count_historical_z_report_conflicts(conn: &rusqlite::Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*)
         FROM sync_queue
         WHERE entity_type = 'z_report'
           AND last_error LIKE ?1",
        params![historical_z_report_conflict_pattern()],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

/// Get sync queue statistics.
pub fn get_sync_status(db: &DbState, sync_state: &SyncState) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    cleanup_order_update_queue_rows(&conn, None)?;
    let historical_pattern = historical_z_report_conflict_pattern();

    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status IN ('pending', 'in_progress')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let queued_remote: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'queued_remote'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let errors: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM sync_queue
             WHERE status = 'failed'
               AND NOT (
                    entity_type = 'z_report'
                    AND last_error LIKE ?1
               )",
            params![historical_pattern.clone()],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let in_progress: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'in_progress'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let backpressure_deferred: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM sync_queue
             WHERE status IN ('pending', 'queued_remote')
               AND next_retry_at IS NOT NULL
               AND julianday(next_retry_at) > julianday('now')
               AND last_error IS NOT NULL
               AND (
                    lower(last_error) LIKE '%429%'
                    OR lower(last_error) LIKE '%queue is backed up%'
                    OR lower(last_error) LIKE '%retry later%'
               )",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let oldest_next_retry_at: Option<String> = conn
        .query_row(
            "SELECT MIN(next_retry_at)
             FROM sync_queue
             WHERE status IN ('pending', 'queued_remote')
               AND next_retry_at IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    let financial_stats = collect_financial_sync_stats(&conn);
    let last_queue_failure = extract_last_queue_failure_snapshot(&conn).map(|s| s.to_json());
    let historical_z_report_conflicts = count_historical_z_report_conflicts(&conn);

    let is_online = storage::is_configured();
    let last_sync = sync_state.last_sync.lock().ok().and_then(|g| g.clone());
    let pending_total = pending + queued_remote;

    Ok(serde_json::json!({
        "isOnline": is_online,
        "lastSync": last_sync,
        "lastSyncAt": last_sync,
        "pendingItems": pending_total,
        "pendingChanges": pending_total,
        "syncInProgress": in_progress > 0,
        "error": if errors > 0 {
            Value::String("sync_queue_failed_items".to_string())
        } else {
            Value::Null
        },
        "syncErrors": errors,
        "queuedRemote": queued_remote,
        "backpressureDeferred": backpressure_deferred,
        "oldestNextRetryAt": oldest_next_retry_at,
        "lastQueueFailure": last_queue_failure,
        "historicalZReportConflicts": historical_z_report_conflicts,
        "pendingPaymentItems": financial_stats.pending_payment_items(),
        "failedPaymentItems": financial_stats.failed_payment_items(),
        "financialStats": financial_stats.to_json(),
    }))
}

/// Get financial sync queue statistics in UI-friendly and compatibility formats.
pub fn get_financial_stats(db: &DbState) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let stats = collect_financial_sync_stats(&conn);
    Ok(stats.to_json())
}

/// Quick network check: HEAD request to admin URL.
pub async fn check_network_status() -> Value {
    let admin_url = match storage::get_credential("admin_dashboard_url") {
        Some(url) => url,
        None => return serde_json::json!({ "isOnline": false }),
    };
    let api_key = match load_zeroized_pos_api_key_optional() {
        Some(k) => k,
        None => return serde_json::json!({ "isOnline": false }),
    };

    let base = api::normalize_admin_url(&admin_url);
    let health_url = format!("{base}/api/health");

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return serde_json::json!({ "isOnline": false }),
    };

    match client
        .head(&health_url)
        .header("X-POS-API-Key", api_key.as_str())
        .send()
        .await
    {
        Ok(resp) => serde_json::json!({ "isOnline": resp.status().is_success() }),
        Err(_) => serde_json::json!({ "isOnline": false }),
    }
}

fn run_recurring_sync_recovery(db: &DbState) -> RecurringSyncRecoverySummary {
    let mut summary = RecurringSyncRecoverySummary::default();

    match backfill_active_shift_business_day_context(db) {
        Ok(repaired) => {
            summary.business_day_repairs = repaired;
            if repaired > 0 {
                info!(
                    repaired,
                    "Recurring sync recovery repaired active shift business-day metadata"
                );
            }
        }
        Err(error) => {
            warn!(error = %error, "Recurring sync recovery failed to repair business-day metadata");
        }
    }

    match requeue_failed_shift_cashier_reference_rows(db) {
        Ok(requeued) => {
            summary.cashier_reference_requeues = requeued;
            if requeued > 0 {
                info!(
                    requeued,
                    "Recurring sync recovery requeued failed shift cashier-reference rows"
                );
            }
        }
        Err(error) => {
            warn!(error = %error, "Recurring sync recovery failed to requeue cashier-reference rows");
        }
    }

    match requeue_retryable_failed_shift_rows(db) {
        Ok(requeued) => {
            summary.retryable_shift_requeues = requeued;
            if requeued > 0 {
                info!(
                    requeued,
                    "Recurring sync recovery requeued retryable failed shifts"
                );
            }
        }
        Err(error) => {
            warn!(error = %error, "Recurring sync recovery failed to requeue retryable shifts");
        }
    }

    match reconcile_failed_shift_bound_financials(db) {
        Ok(recovered) => {
            summary.failed_shift_bound_financial_recoveries = recovered;
            if recovered > 0 {
                info!(
                    recovered,
                    "Recurring sync recovery recovered failed shift-bound financial rows"
                );
            }
        }
        Err(error) => {
            warn!(error = %error, "Recurring sync recovery failed to recover shift-bound financial rows");
        }
    }

    match reconcile_deferred_payments(db) {
        Ok(promoted) => {
            summary.deferred_payment_promotions = promoted;
        }
        Err(error) => {
            warn!(error = %error, "Recurring sync recovery failed to reconcile deferred payments");
        }
    }

    match reconcile_deferred_adjustments(db) {
        Ok(promoted) => {
            summary.deferred_adjustment_promotions = promoted;
        }
        Err(error) => {
            warn!(error = %error, "Recurring sync recovery failed to reconcile deferred adjustments");
        }
    }

    match reconcile_deferred_financials(db) {
        Ok(promoted) => {
            summary.deferred_financial_promotions = promoted;
        }
        Err(error) => {
            warn!(error = %error, "Recurring sync recovery failed to reconcile deferred financials");
        }
    }

    summary
}

fn has_actionable_remote_sync_work(db: &DbState) -> Result<bool, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let actionable: Option<i64> = conn
        .query_row(
            "SELECT 1
             FROM sync_queue
             WHERE status = 'queued_remote'
                OR (
                    status IN ('pending', 'in_progress')
                    AND retry_count < max_retries
                    AND (
                        next_retry_at IS NULL
                        OR julianday(next_retry_at) <= julianday('now')
                    )
                )
             LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("inspect actionable sync queue rows: {e}"))?;

    Ok(actionable.is_some())
}

fn read_terminal_setting(conn: &rusqlite::Connection, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| db::get_setting(conn, "terminal", key))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_terminal_setting_json(conn: &rusqlite::Connection, keys: &[&str]) -> Option<Value> {
    keys.iter().find_map(|key| {
        db::get_setting(conn, "terminal", key).and_then(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            serde_json::from_str::<Value>(trimmed)
                .ok()
                .filter(Value::is_object)
        })
    })
}

fn resolve_heartbeat_platform() -> Option<&'static str> {
    match std::env::consts::OS {
        "windows" => Some("windows"),
        "android" => Some("android"),
        "ios" => Some("ios"),
        _ => None,
    }
}

fn compute_uptime_seconds() -> u64 {
    let started_at = APP_START_EPOCH.load(Ordering::Relaxed);
    if started_at == 0 {
        return 0;
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    now.saturating_sub(started_at)
}

fn build_terminal_heartbeat_payload(
    db: &DbState,
    sync_state: &SyncState,
    network_is_online: bool,
) -> Option<Value> {
    if !network_is_online {
        return None;
    }

    let terminal_id = storage::get_credential("terminal_id").or_else(|| {
        db.conn
            .lock()
            .ok()
            .and_then(|conn| read_terminal_setting(&conn, &["terminal_id"]))
    })?;
    let terminal_id = terminal_id.trim().to_string();
    if terminal_id.is_empty() {
        return None;
    }

    let status_payload = get_sync_status_for_event(db, &sync_state.last_sync, network_is_online);
    let pending_updates = status_payload
        .get("pendingItems")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let sync_errors = status_payload
        .get("syncErrors")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let sync_in_progress = status_payload
        .get("syncInProgress")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let sync_status = if sync_errors > 0 {
        "failed"
    } else if pending_updates > 0 || sync_in_progress {
        "pending"
    } else {
        "synced"
    };

    let (branch_id, terminal_name, terminal_location, settings_hash, remote_view_capabilities) =
        match db.conn.lock() {
            Ok(conn) => (
                storage::get_credential("branch_id")
                    .or_else(|| read_terminal_setting(&conn, &["branch_id"])),
                read_terminal_setting(&conn, &["name", "display_name", "displayName"]),
                read_terminal_setting(&conn, &["location", "display_location", "displayLocation"]),
                read_terminal_setting(&conn, &["settings_hash"]).unwrap_or_default(),
                read_terminal_setting_json(
                    &conn,
                    &["remote_view_capabilities", "remoteViewCapabilities"],
                ),
            ),
            Err(_) => (
                storage::get_credential("branch_id"),
                None,
                None,
                String::new(),
                None,
            ),
        };

    let financial_stats = status_payload
        .get("financialStats")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    let mut payload = serde_json::json!({
        "terminal_id": terminal_id,
        "status": "online",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime": compute_uptime_seconds(),
        "memory_usage": 0,
        "cpu_usage": 0,
        "settings_hash": settings_hash,
        "sync_status": sync_status,
        "pending_updates": pending_updates,
        "sync_stats": {
            "driver_earnings": financial_stats.get("driver_earnings").cloned().unwrap_or_else(|| serde_json::json!({ "pending": 0, "failed": 0 })),
            "staff_payments": financial_stats.get("staff_payments").cloned().unwrap_or_else(|| serde_json::json!({ "pending": 0, "failed": 0 })),
            "shift_expenses": financial_stats.get("shift_expenses").cloned().unwrap_or_else(|| serde_json::json!({ "pending": 0, "failed": 0 })),
        }
    });

    if let Some(branch_id) = branch_id {
        payload["branch_id"] = Value::String(branch_id);
    }
    if let Some(name) = terminal_name {
        payload["name"] = Value::String(name);
    }
    if let Some(location) = terminal_location {
        payload["location"] = Value::String(location);
    }
    if let Some(platform) = resolve_heartbeat_platform() {
        payload["platform"] = Value::String(platform.to_string());
    }
    if let Some(remote_view_capabilities) = remote_view_capabilities {
        payload["remote_view_capabilities"] = remote_view_capabilities;
    }

    Some(payload)
}

async fn send_terminal_heartbeat_with_sender<F, Fut>(
    db: &DbState,
    sync_state: &SyncState,
    network_is_online: bool,
    sender: F,
) -> Result<bool, String>
where
    F: FnOnce(Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let Some(payload) = build_terminal_heartbeat_payload(db, sync_state, network_is_online) else {
        return Ok(false);
    };

    sender(payload).await.map(|_| true)
}

pub async fn send_terminal_heartbeat_now(
    db: &DbState,
    sync_state: &SyncState,
) -> Result<bool, String> {
    let network_status = check_network_status().await;
    let network_is_online = network_status
        .get("isOnline")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let (admin_url, api_key) = match db.conn.lock() {
        Ok(conn) => {
            let admin_url = storage::get_credential("admin_dashboard_url")
                .or_else(|| read_terminal_setting(&conn, &["admin_dashboard_url", "admin_url"]))
                .map(|value| api::normalize_admin_url(&value))
                .filter(|value| !value.trim().is_empty());
            let api_key = load_zeroized_pos_api_key_optional()
                .or_else(|| read_terminal_setting(&conn, &["pos_api_key"]).map(Zeroizing::new));
            match (admin_url, api_key) {
                (Some(admin_url), Some(api_key)) => (admin_url, api_key),
                _ => return Ok(false),
            }
        }
        Err(_) => return Ok(false),
    };

    send_terminal_heartbeat_with_sender(db, sync_state, network_is_online, |payload| async {
        api::fetch_from_admin(
            &admin_url,
            api_key.as_str(),
            "/api/pos/terminal-heartbeat",
            "POST",
            Some(payload),
        )
        .await
    })
    .await
}

pub fn start_terminal_heartbeat_loop(
    db: Arc<DbState>,
    sync_state: Arc<SyncState>,
    interval_secs: u64,
    cancel: tokio_util::sync::CancellationToken,
) {
    tauri::async_runtime::spawn(async move {
        info!("Terminal heartbeat loop started (interval: {interval_secs}s)");
        let mut should_wait = false;

        loop {
            if cancel.is_cancelled() {
                info!("Terminal heartbeat loop cancelled");
                break;
            }

            if should_wait {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(interval_secs)) => {}
                    _ = cancel.cancelled() => {
                        info!("Terminal heartbeat loop cancelled");
                        break;
                    }
                }
            }
            should_wait = true;

            if cancel.is_cancelled() {
                break;
            }

            match send_terminal_heartbeat_now(db.as_ref(), sync_state.as_ref()).await {
                Ok(true) => trace!("Terminal heartbeat sent"),
                Ok(false) => trace!("Terminal heartbeat skipped"),
                Err(error) => warn!(error = %error, "Terminal heartbeat failed"),
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Background sync loop
// ---------------------------------------------------------------------------

/// Start the background sync loop. Spawns a tokio task that runs every
/// `interval` seconds, processing pending sync_queue entries in batches.
pub fn start_sync_loop(
    app: AppHandle,
    db: Arc<DbState>,
    sync_state: Arc<SyncState>,
    interval_secs: u64,
    cancel: tokio_util::sync::CancellationToken,
) {
    let is_running = sync_state.is_running.clone();
    let last_sync = sync_state.last_sync.clone();

    // Mark as running
    is_running.store(true, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        info!("Sync loop started (interval: {interval_secs}s)");
        let mut previous_network_online: Option<bool> = None;

        loop {
            if cancel.is_cancelled() || !is_running.load(Ordering::SeqCst) {
                info!("Sync loop stopped");
                break;
            }

            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(interval_secs)) => {}
                _ = cancel.cancelled() => {
                    info!("Sync loop cancelled");
                    break;
                }
            }

            if cancel.is_cancelled() || !is_running.load(Ordering::SeqCst) {
                break;
            }

            // Emit network status every cycle so renderer indicators can
            // stay event-driven without command polling.
            let network_status = check_network_status().await;
            let network_is_online = network_status
                .get("isOnline")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let _ = app.emit("network_status", &network_status);

            // If terminal is not configured yet, still emit sync status so
            // UI state remains consistent.
            if !storage::is_configured() {
                previous_network_online = None;
                let status = get_sync_status_for_event(&db, &last_sync, network_is_online);
                let _ = app.emit("sync_status", &status);
                let _ = app.emit("sync-status-changed", &status);
                continue;
            }

            let recovery_summary = run_recurring_sync_recovery(&db);
            let actionable_remote_work = match has_actionable_remote_sync_work(&db) {
                Ok(has_work) => has_work,
                Err(error) => {
                    warn!(error = %error, "Failed to inspect actionable sync queue work");
                    false
                }
            };

            if !network_is_online {
                if previous_network_online != Some(false) {
                    if actionable_remote_work {
                        info!(
                            recovery_actions = recovery_summary.total_actions(),
                            "Network probe offline; attempting remote sync because actionable queue work remains"
                        );
                    } else {
                        info!("Network offline; deferring remote sync and keeping queue pending");
                    }
                }
                previous_network_online = Some(false);

                if !actionable_remote_work {
                    let status = get_sync_status_for_event(&db, &last_sync, false);
                    let _ = app.emit("sync_status", &status);
                    let _ = app.emit("sync-status-changed", &status);
                    continue;
                }
            } else {
                if previous_network_online == Some(false) {
                    info!("Network restored; resuming queued sync");
                }
                previous_network_online = Some(true);
            }

            match run_sync_cycle(&db, &app).await {
                Ok(synced) => {
                    if synced > 0 {
                        info!("Sync cycle complete: {synced} items synced");
                    }
                    if let Ok(mut guard) = last_sync.lock() {
                        *guard = Some(Utc::now().to_rfc3339());
                    }
                }
                Err(e) => {
                    if is_terminal_auth_failure(&e) {
                        handle_terminal_auth_failure_from_sync(&db, &app, &e);
                        is_running.store(false, Ordering::SeqCst);
                        info!("Sync loop stopped — terminal access revoked");
                        break;
                    }
                    log_sync_cycle_failure_with_context(&db, &e);
                }
            }

            // Emit sync status events to frontend.
            // `sync_status` is the canonical Tauri event consumed by the
            // event bridge; keep `sync-status-changed` for backward compatibility.
            let status = get_sync_status_for_event(&db, &last_sync, network_is_online);
            let _ = app.emit("sync_status", &status);
            let _ = app.emit("sync-status-changed", &status);
        }
    });
}

/// Trigger an immediate sync cycle (called by `sync_force`).
fn capture_unsynced_sync_queue_snapshot_with_limit(
    db: &DbState,
    limit: i64,
) -> Result<UnsyncedSyncQueueSnapshot, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let historical_pattern = format!("{HISTORICAL_Z_REPORT_CONFLICT_PREFIX}%");

    let count = conn
        .query_row(
            "SELECT COUNT(*)
             FROM sync_queue
             WHERE status NOT IN ('synced', 'applied')
               AND NOT (
                    entity_type = 'z_report'
                    AND last_error LIKE ?1
               )",
            params![historical_pattern.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("count unsynced sync queue items: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT entity_type, status, COUNT(*) AS total
             FROM sync_queue
             WHERE status NOT IN ('synced', 'applied')
               AND NOT (
                    entity_type = 'z_report'
                    AND last_error LIKE ?2
               )
             GROUP BY entity_type, status
             ORDER BY total DESC, entity_type ASC, status ASC
             LIMIT ?1",
        )
        .map_err(|e| format!("prepare unsynced sync queue summary: {e}"))?;
    let rows = stmt
        .query_map(params![limit, historical_pattern.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("query unsynced sync queue summary: {e}"))?;

    let blockers_summary = rows
        .filter_map(Result::ok)
        .map(|(entity_type, status, total)| format!("{entity_type}:{status} x{total}"))
        .collect::<Vec<_>>()
        .join(", ");

    Ok(UnsyncedSyncQueueSnapshot {
        count,
        blockers_summary,
    })
}

pub fn capture_unsynced_sync_queue_snapshot(
    db: &DbState,
) -> Result<UnsyncedSyncQueueSnapshot, String> {
    capture_unsynced_sync_queue_snapshot_with_limit(db, CLOSEOUT_SYNC_BLOCKER_SUMMARY_LIMIT)
}

pub fn ensure_sync_queue_clear_for_z_report(db: &DbState, stage: &str) -> Result<(), String> {
    let snapshot = capture_unsynced_sync_queue_snapshot(db)?;
    if snapshot.count == 0 {
        return Ok(());
    }

    let detail = if snapshot.blockers_summary.is_empty() {
        String::new()
    } else {
        format!(" Blocking items: {}.", snapshot.blockers_summary)
    };

    Err(format!(
        "Cannot close day during {stage}: {} sync item(s) are still pending or failed.{detail}",
        snapshot.count
    ))
}

async fn drain_sync_until_closeout_stable<PassFn, PassFuture, SnapshotFn>(
    max_passes: usize,
    mut run_pass: PassFn,
    mut snapshot_fn: SnapshotFn,
) -> Result<CloseoutSyncDrainState, String>
where
    PassFn: FnMut() -> PassFuture,
    PassFuture: Future<Output = Result<usize, String>>,
    SnapshotFn: FnMut() -> Result<UnsyncedSyncQueueSnapshot, String>,
{
    let mut state = CloseoutSyncDrainState::default();
    let mut previous_zero_progress_snapshot: Option<UnsyncedSyncQueueSnapshot> = None;

    for _ in 0..max_passes {
        let synced = run_pass().await?;
        state.passes_executed += 1;
        state.any_progress |= synced > 0;

        let snapshot = snapshot_fn()?;
        state.remaining_unsynced_count = snapshot.count;
        state.remaining_blockers_summary = snapshot.blockers_summary.clone();

        if snapshot.count == 0 {
            break;
        }

        if synced == 0 {
            if previous_zero_progress_snapshot
                .as_ref()
                .map(|previous| previous == &snapshot)
                .unwrap_or(false)
            {
                break;
            }
            previous_zero_progress_snapshot = Some(snapshot);
        } else {
            previous_zero_progress_snapshot = None;
        }
    }

    Ok(state)
}

async fn force_sync_once(
    db: &DbState,
    sync_state: &SyncState,
    app: &AppHandle,
) -> Result<usize, String> {
    if !storage::is_configured() {
        return Err("Terminal not configured".into());
    }

    let _ = run_recurring_sync_recovery(db);

    let synced = run_sync_cycle(db, app).await?;
    info!("Force sync complete: {synced} items synced");

    if let Ok(mut guard) = sync_state.last_sync.lock() {
        *guard = Some(Utc::now().to_rfc3339());
    }

    Ok(synced)
}

/// Trigger an immediate sync cycle (called by `sync_force`).
pub async fn force_sync(
    db: &DbState,
    sync_state: &SyncState,
    app: &AppHandle,
) -> Result<(), String> {
    let _ = force_sync_once(db, sync_state, app).await?;
    Ok(())
}

pub async fn force_sync_until_closeout_stable(
    db: &DbState,
    sync_state: &SyncState,
    app: &AppHandle,
) -> Result<CloseoutSyncDrainState, String> {
    let state = drain_sync_until_closeout_stable(
        CLOSEOUT_SYNC_DRAIN_MAX_PASSES,
        || force_sync_once(db, sync_state, app),
        || capture_unsynced_sync_queue_snapshot(db),
    )
    .await?;

    info!(
        passes_executed = state.passes_executed,
        any_progress = state.any_progress,
        remaining_unsynced_count = state.remaining_unsynced_count,
        remaining_blockers_summary = if state.remaining_blockers_summary.is_empty() {
            "none"
        } else {
            state.remaining_blockers_summary.as_str()
        },
        "Closeout sync drain complete"
    );

    Ok(state)
}

/// Remove unsupported order delete operations from the sync queue.
///
/// Electron parity keeps deletes local; `/api/pos/orders/sync` only supports
/// insert/update operations.
fn cleanup_unsupported_order_delete_ops(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM sync_queue WHERE entity_type = 'order' AND operation = 'delete'",
        [],
    )
    .map_err(|e| format!("cleanup order delete ops: {e}"))
}

/// Requeue failed order sync rows that failed with validation errors so they
/// can be retried after deploy fixes.
fn requeue_failed_order_validation_rows(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sync_queue
         SET status = 'pending',
             retry_count = 0,
             last_error = NULL,
             updated_at = datetime('now')
         WHERE entity_type = 'order'
           AND status = 'failed'
           AND last_error IS NOT NULL
           AND (
             lower(last_error) LIKE '%validation failed%'
             OR lower(last_error) LIKE '%validation%'
             OR lower(last_error) LIKE '%invalid%'
           )",
        [],
    )
    .map_err(|e| format!("requeue failed order validation rows: {e}"))
}

/// Maximum age (in days) for failed sync entries before they are pruned.
const SYNC_FAILURE_MAX_AGE_DAYS: i64 = 30;

/// Delete `sync_queue` entries with `status = 'failed'` that are older than
/// [`SYNC_FAILURE_MAX_AGE_DAYS`] days. This prevents the sync queue from
/// growing indefinitely with permanently-failed entries that will never be
/// retried.
///
/// Called once per process start from [`run_sync_cycle`] (guarded by
/// [`SYNC_FAILURE_PRUNE_DONE`]).
fn prune_old_sync_failures(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM sync_queue
         WHERE status = 'failed'
           AND updated_at < datetime('now', ?1)",
        params![format!("-{SYNC_FAILURE_MAX_AGE_DAYS} days")],
    )
    .map_err(|e| format!("prune old sync failures: {e}"))
}

/// A sync queue row with all fields needed for processing.
type SyncItem = (
    i64,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    Option<String>,
    i64,
    Option<String>,
);
// Fields:
// (id, entity_type, entity_id, operation, payload, idempotency_key,
//  retry_count, max_retries, next_retry_at, retry_delay_ms, remote_receipt_id)

#[derive(Debug, Clone, Copy)]
struct BatchFailureResult {
    backpressure_deferred: bool,
}

#[derive(Debug, Default)]
struct DirectOrderFallbackOutcome {
    synced_queue_ids: HashSet<i64>,
    permanent_failures: HashMap<i64, String>,
    transient_failures: HashMap<i64, String>,
}

impl DirectOrderFallbackOutcome {
    fn record_synced(&mut self, queue_id: i64) {
        self.synced_queue_ids.insert(queue_id);
        self.permanent_failures.remove(&queue_id);
        self.transient_failures.remove(&queue_id);
    }

    fn record_permanent_failure(&mut self, queue_id: i64, error: String) {
        self.transient_failures.remove(&queue_id);
        self.permanent_failures.insert(queue_id, error);
    }

    fn record_transient_failure(&mut self, queue_id: i64, error: String) {
        self.permanent_failures.remove(&queue_id);
        self.transient_failures.insert(queue_id, error);
    }

    fn all_handled_ids(&self) -> HashSet<i64> {
        let mut ids = self.synced_queue_ids.clone();
        ids.extend(self.permanent_failures.keys());
        ids.extend(self.transient_failures.keys());
        ids
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncItemCategory {
    Order,
    Shift,
    Financial,
    Payment,
    Adjustment,
    ZReport,
    Loyalty,
}

fn categorize_sync_item(entity_type: &str) -> SyncItemCategory {
    match entity_type {
        "shift" => SyncItemCategory::Shift,
        "shift_expense" | "staff_payment" | "driver_earning" | "driver_earnings" => {
            SyncItemCategory::Financial
        }
        "payment" => SyncItemCategory::Payment,
        "payment_adjustment" => SyncItemCategory::Adjustment,
        "z_report" => SyncItemCategory::ZReport,
        "loyalty_transaction" => SyncItemCategory::Loyalty,
        _ => SyncItemCategory::Order,
    }
}

#[derive(Debug, Default)]
struct FinancialBatchOutcome {
    synced: usize,
    had_non_backpressure_failure: bool,
}

fn percent_encode(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for b in input.bytes() {
        let is_unreserved =
            b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~';
        if is_unreserved {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    encoded
}

fn is_backpressure_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("http 429")
        || lower.contains("status 429")
        || lower.contains("queue is backed up")
        || lower.contains("retry later")
}

#[allow(dead_code)]
fn is_stuck_receipt_cleanup_unsupported_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("http 405")
        || lower.contains("status 405")
        || lower.contains("method not allowed")
        || lower.contains("http 404")
        || lower.contains("status 404")
        || lower.contains("endpoint not found")
}

#[allow(dead_code)]
fn should_attempt_stuck_receipt_cleanup() -> bool {
    !STUCK_RECEIPT_CLEANUP_UNSUPPORTED.load(Ordering::SeqCst)
}

#[allow(dead_code)]
fn disable_stuck_receipt_cleanup_for_session() -> bool {
    !STUCK_RECEIPT_CLEANUP_UNSUPPORTED.swap(true, Ordering::SeqCst)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReceiptStatusRecoveryHint {
    DirectOrderFallback,
    RetryLocalQueue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueuedRemoteDisposition {
    Retryable,
    Permanent,
}

fn is_permanent_order_sync_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("invalid menu items")
        || lower.contains("customer not found in organization")
        || lower.contains("driver not found")
        || lower.contains("driver must be from the same branch")
        || lower.contains("branch access denied")
        || lower.contains("cannot update order from different branch")
        || lower.contains("total mismatch")
        || lower.contains("order totals do not match")
        || lower.contains("validation failed")
        || lower.contains("permanent direct fallback failure")
        || lower.contains("invalid customer")
        || lower.contains("invalid driver")
        || lower.contains("missing required parameter")
        || lower.contains("payload too large")
        || lower.contains("invalid json")
        || lower.contains("invalid status transition")
}

fn is_legacy_unclaimed_receipt_timeout_message(error: &str) -> bool {
    error
        .to_lowercase()
        .contains("legacy pos_ingest_queue receipt was not claimed within")
}

fn parse_retry_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn is_transient_order_sync_error(error: &str) -> bool {
    if is_permanent_order_sync_error(error) {
        return false;
    }

    let lower = error.to_lowercase();
    if is_backpressure_error(error)
        || lower.contains("network error")
        || lower.contains("cannot reach admin dashboard")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("server error")
        || lower.contains("http 5")
        || lower.contains("connection refused")
    {
        return true;
    }

    // Unknown failures are treated as transient by default.
    true
}

fn is_transient_receipt_poll_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    is_backpressure_error(error)
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("network error")
        || lower.contains("cannot reach admin dashboard")
        || lower.contains("connection refused")
        || lower.contains("connection reset")
}

fn classify_queue_failure(entity_type: &str, last_error: &str) -> &'static str {
    if is_backpressure_error(last_error) {
        return "backpressure";
    }

    if entity_type == "order" {
        if is_permanent_order_sync_error(last_error) {
            return "permanent";
        }
        if is_transient_order_sync_error(last_error) {
            return "transient";
        }
    }

    "unknown"
}

#[derive(Debug)]
struct OrderUpdateQueueRow {
    queue_id: i64,
    entity_id: String,
    status: String,
    synced_at: Option<String>,
    payload: String,
    local_status: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrderUpdateLocalResolution {
    RestoreSyncedHistory,
    ResolveSupersededStatus,
}

fn extract_explicit_order_update_status(payload: &str) -> Option<String> {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|value| {
            value
                .get("status")
                .and_then(Value::as_str)
                .map(str::trim)
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty())
        .map(|value| normalize_status_for_storage(&value))
}

fn classify_order_update_local_resolution(
    row: &OrderUpdateQueueRow,
) -> Option<OrderUpdateLocalResolution> {
    if row.synced_at.is_some() {
        return Some(OrderUpdateLocalResolution::RestoreSyncedHistory);
    }

    let queued_status = extract_explicit_order_update_status(&row.payload)?;
    let local_status = row
        .local_status
        .as_deref()
        .map(normalize_status_for_storage)
        .filter(|value| !value.is_empty())?;

    if local_status == queued_status {
        return None;
    }

    if can_transition_locally(&queued_status, &local_status) {
        Some(OrderUpdateLocalResolution::ResolveSupersededStatus)
    } else {
        None
    }
}

fn refresh_order_sync_status_for_queue_cleanup(
    conn: &Connection,
    order_ids: &HashSet<String>,
    now: &str,
) -> Result<(), String> {
    for order_id in order_ids {
        let has_remaining_rows: bool = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1
                    FROM sync_queue
                    WHERE entity_type = 'order'
                      AND entity_id = ?1
                      AND status IN ('pending', 'in_progress', 'queued_remote', 'failed')
                )",
                params![order_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("inspect remaining order queue rows: {e}"))?;

        if has_remaining_rows {
            continue;
        }

        conn.execute(
            "UPDATE orders
             SET sync_status = 'synced',
                 updated_at = ?1
             WHERE id = ?2",
            params![now, order_id],
        )
        .map_err(|e| format!("refresh order sync status: {e}"))?;
    }

    Ok(())
}

fn cleanup_order_update_queue_rows(
    conn: &Connection,
    order_id: Option<&str>,
) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "SELECT sq.id, sq.entity_id, sq.status, sq.synced_at, sq.payload, o.status
             FROM sync_queue sq
             LEFT JOIN orders o ON o.id = sq.entity_id
             WHERE sq.entity_type = 'order'
               AND sq.operation = 'update'
               AND (?1 IS NULL OR sq.entity_id = ?1)
               AND (
                    (sq.synced_at IS NOT NULL AND sq.status != 'synced')
                    OR sq.status IN ('failed', 'pending', 'in_progress')
               )
             ORDER BY sq.id ASC",
        )
        .map_err(|e| format!("prepare order queue cleanup query: {e}"))?;

    let rows: Vec<OrderUpdateQueueRow> = stmt
        .query_map(params![order_id], |row| {
            Ok(OrderUpdateQueueRow {
                queue_id: row.get(0)?,
                entity_id: row.get(1)?,
                status: row.get(2)?,
                synced_at: row.get(3)?,
                payload: row.get(4)?,
                local_status: row.get(5)?,
            })
        })
        .map_err(|e| format!("load order queue cleanup candidates: {e}"))?
        .filter_map(|row| row.ok())
        .collect();

    if rows.is_empty() {
        return Ok(0);
    }

    let now = Utc::now().to_rfc3339();
    let mut affected_order_ids = HashSet::new();
    let mut resolved_rows = 0usize;

    for row in rows {
        if classify_order_update_local_resolution(&row).is_none() {
            continue;
        }

        conn.execute(
            "UPDATE sync_queue
             SET status = 'synced',
                 synced_at = COALESCE(synced_at, ?1),
                 last_error = NULL,
                 next_retry_at = NULL,
                 updated_at = ?1
             WHERE id = ?2",
            params![now, row.queue_id],
        )
        .map_err(|e| {
            format!(
                "resolve obsolete order queue row {} ({}): {e}",
                row.queue_id, row.status
            )
        })?;
        affected_order_ids.insert(row.entity_id);
        resolved_rows += 1;
    }

    refresh_order_sync_status_for_queue_cleanup(conn, &affected_order_ids, &now)?;
    Ok(resolved_rows)
}

pub(crate) fn cleanup_order_update_queue_rows_for_order(
    db: &DbState,
    order_id: Option<&str>,
) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    cleanup_order_update_queue_rows(&conn, order_id)
}

fn extract_last_queue_failure_snapshot(
    conn: &rusqlite::Connection,
) -> Option<QueueFailureSnapshot> {
    let mut stmt = conn
        .prepare(
            "SELECT id, entity_type, entity_id, operation, status, retry_count, max_retries,
                    next_retry_at, last_error
             FROM sync_queue
             WHERE last_error IS NOT NULL
               AND trim(last_error) != ''
               AND NOT (
                    entity_type = 'z_report'
                    AND last_error LIKE ?1
               )
               AND (
                    status IN ('in_progress', 'pending')
                    OR status = 'failed'
               )
             ORDER BY
               COALESCE(updated_at, created_at) DESC,
               id DESC
             LIMIT 25",
        )
        .ok()?;

    let candidates: Vec<QueueFailureSnapshot> = stmt
        .query_map(params![historical_z_report_conflict_pattern()], |row| {
            let entity_type: String = row.get(1)?;
            let last_error: String = row.get(8)?;
            Ok(QueueFailureSnapshot {
                queue_id: row.get(0)?,
                entity_type: entity_type.clone(),
                entity_id: row.get(2)?,
                operation: row.get(3)?,
                status: row.get(4)?,
                retry_count: row.get(5)?,
                max_retries: row.get(6)?,
                next_retry_at: row.get(7)?,
                classification: classify_queue_failure(&entity_type, &last_error).to_string(),
                last_error,
            })
        })
        .ok()?
        .filter_map(|row| row.ok())
        .collect();

    let now = Utc::now();
    candidates
        .into_iter()
        .min_by_key(|snapshot| snapshot.blocker_rank(now))
}

fn should_emit_deduped_warn(fingerprint: &str, now: DateTime<Utc>) -> bool {
    let state =
        SYNC_WARN_LOG_DEDUPE_STATE.get_or_init(|| Mutex::new(WarnLogDedupeState::default()));
    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(_) => return true,
    };

    let should_emit = !matches!(
        (&guard.last_fingerprint, guard.last_warned_at),
        (Some(last), Some(last_at))
            if last == fingerprint
                && (now - last_at) < ChronoDuration::seconds(SYNC_LOG_DEDUPE_COOLDOWN_SECS)
    );

    if should_emit {
        guard.last_fingerprint = Some(fingerprint.to_string());
        guard.last_warned_at = Some(now);
    }

    should_emit
}

fn log_sync_cycle_failure_with_context(db: &DbState, error: &str) {
    let snapshot = match db.conn.lock() {
        Ok(conn) => extract_last_queue_failure_snapshot(&conn),
        Err(_) => None,
    };

    let now = Utc::now();
    let fingerprint = match &snapshot {
        Some(snapshot) => format!("{error}|{}", snapshot.fingerprint()),
        None => error.to_string(),
    };

    if should_emit_deduped_warn(&fingerprint, now) {
        if let Some(snapshot) = snapshot {
            warn!(
                error = %error,
                queue_id = snapshot.queue_id,
                entity_type = %snapshot.entity_type,
                entity_id = %snapshot.entity_id,
                operation = %snapshot.operation,
                queue_status = %snapshot.status,
                retry_count = snapshot.retry_count,
                max_retries = snapshot.max_retries,
                next_retry_at = ?snapshot.next_retry_at,
                classification = %snapshot.classification,
                last_error = %snapshot.last_error,
                "Sync cycle failed"
            );
        } else {
            warn!("Sync cycle failed: {error}");
        }
    } else if let Some(snapshot) = snapshot {
        debug!(
            error = %error,
            queue_id = snapshot.queue_id,
            entity_type = %snapshot.entity_type,
            entity_id = %snapshot.entity_id,
            queue_status = %snapshot.status,
            retry_count = snapshot.retry_count,
            max_retries = snapshot.max_retries,
            next_retry_at = ?snapshot.next_retry_at,
            classification = %snapshot.classification,
            "Sync cycle failed (deduped)"
        );
    } else {
        debug!("Sync cycle failed (deduped): {error}");
    }
}

fn log_reconcile_skip_throttled(local_id: &str) {
    let state = RECONCILE_SKIP_LOG_STATE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(_) => {
            debug!(
                local_id = %local_id,
                "Skipped reconcile — order has pending sync queue entries"
            );
            return;
        }
    };

    let now = Utc::now();
    let entry = guard.entry(local_id.to_string()).or_default();
    let cooldown = ChronoDuration::seconds(SYNC_LOG_DEDUPE_COOLDOWN_SECS);
    let should_log_now = match entry.last_logged_at {
        Some(last) => (now - last) >= cooldown,
        None => true,
    };

    if should_log_now {
        if entry.suppressed_count > 0 {
            debug!(
                local_id = %local_id,
                suppressed = entry.suppressed_count,
                "Skipped reconcile — order has pending sync queue entries (repeated)"
            );
            entry.suppressed_count = 0;
        } else {
            debug!(
                local_id = %local_id,
                "Skipped reconcile — order has pending sync queue entries"
            );
        }
        entry.last_logged_at = Some(now);
    } else {
        entry.suppressed_count = entry.suppressed_count.saturating_add(1);
    }
}

fn extract_first_numeric_after(haystack: &str, key: &str) -> Option<i64> {
    let idx = haystack.find(key)?;
    let tail = &haystack[idx + key.len()..];
    let mut started = false;
    let mut buf = String::new();
    for ch in tail.chars() {
        if ch.is_ascii_digit() || (ch == '.' && started) {
            started = true;
            buf.push(ch);
            continue;
        }
        if started {
            break;
        }
    }
    if buf.is_empty() {
        return None;
    }
    if let Ok(v) = buf.parse::<i64>() {
        return Some(v);
    }
    buf.parse::<f64>().ok().map(|v| v.round() as i64)
}

#[allow(dead_code)]
fn extract_first_float_after(haystack: &str, key: &str) -> Option<f64> {
    let idx = haystack.find(key)?;
    let tail = &haystack[idx + key.len()..];
    let mut started = false;
    let mut buf = String::new();
    for ch in tail.chars() {
        if ch.is_ascii_digit() || (ch == '.' && started) {
            started = true;
            buf.push(ch);
            continue;
        }
        if started {
            break;
        }
    }
    if buf.is_empty() {
        return None;
    }
    buf.parse::<f64>().ok()
}

fn extract_retry_after_seconds(error: &str) -> Option<i64> {
    extract_first_numeric_after(error, "\"retry_after_seconds\"")
        .or_else(|| extract_first_numeric_after(error, "retry_after_seconds"))
        .or_else(|| extract_first_numeric_after(error, "retry-after"))
        .filter(|v| *v > 0)
}

#[allow(dead_code)]
fn extract_queue_age_seconds(error: &str) -> Option<f64> {
    extract_first_float_after(error, "\"queue_age_seconds\"")
        .or_else(|| extract_first_float_after(error, "queue_age_seconds"))
        .filter(|v| *v >= 0.0)
}

#[allow(dead_code)]
fn should_use_direct_order_fallback(error: &str) -> bool {
    if !is_backpressure_error(error) {
        return false;
    }
    match extract_queue_age_seconds(error) {
        Some(age) => age >= ORDER_DIRECT_FALLBACK_QUEUE_AGE_SEC as f64,
        None => false,
    }
}

fn deterministic_jitter_ms(seed: i64) -> i64 {
    let positive = if seed < 0 { -seed } else { seed };
    (positive % 700) + 50
}

fn schedule_next_retry(delay_ms: i64, seed: i64) -> String {
    let bounded = delay_ms.clamp(1_000, MAX_RETRY_DELAY_MS);
    let jitter = deterministic_jitter_ms(seed);
    (Utc::now() + ChronoDuration::milliseconds(bounded + jitter)).to_rfc3339()
}

fn local_setting_get(db: &DbState, category: &str, key: &str) -> Option<String> {
    let conn = db.conn.lock().ok()?;
    conn.query_row(
        "SELECT setting_value FROM local_settings WHERE setting_category = ?1 AND setting_key = ?2",
        params![category, key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn local_setting_set(db: &DbState, category: &str, key: &str, value: &str) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO local_settings (setting_category, setting_key, setting_value, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(setting_category, setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at",
        params![category, key, value],
    )
    .map_err(|e| format!("set local setting: {e}"))?;
    Ok(())
}

pub(crate) fn get_sync_bootstrap_mode(db: &DbState) -> String {
    local_setting_get(db, SYNC_BOOTSTRAP_CATEGORY, SYNC_BOOTSTRAP_MODE_KEY)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| {
            matches!(
                value.as_str(),
                SYNC_BOOTSTRAP_MODE_LIVE
                    | SYNC_BOOTSTRAP_MODE_REMOTE_REBUILD
                    | SYNC_BOOTSTRAP_MODE_EMPTY_DB
            )
        })
        .unwrap_or_else(|| SYNC_BOOTSTRAP_MODE_LIVE.to_string())
}

pub(crate) fn set_sync_bootstrap_mode(db: &DbState, mode: &str) -> Result<(), String> {
    local_setting_set(db, SYNC_BOOTSTRAP_CATEGORY, SYNC_BOOTSTRAP_MODE_KEY, mode)
}

#[derive(Debug, Clone)]
struct SyncBootstrapInspection {
    current_mode: String,
    orders_since_cursor: String,
    order_count: i64,
}

fn inspect_sync_bootstrap_state(db: &DbState) -> Result<SyncBootstrapInspection, String> {
    let current_mode = get_sync_bootstrap_mode(db);
    let orders_since_cursor =
        sanitize_orders_since_cursor(local_setting_get(db, "sync", "orders_since"));
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
        .unwrap_or(0);

    Ok(SyncBootstrapInspection {
        current_mode,
        orders_since_cursor,
        order_count,
    })
}

fn should_emit_bootstrap_transition_log(fingerprint: &str, now: DateTime<Utc>) -> bool {
    let state =
        SYNC_BOOTSTRAP_LOG_DEDUPE_STATE.get_or_init(|| Mutex::new(WarnLogDedupeState::default()));
    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(_) => return true,
    };

    let should_emit = !matches!(
        (&guard.last_fingerprint, guard.last_warned_at),
        (Some(last), Some(last_at))
            if last == fingerprint
                && (now - last_at) < ChronoDuration::seconds(SYNC_LOG_DEDUPE_COOLDOWN_SECS)
    );

    if should_emit {
        guard.last_fingerprint = Some(fingerprint.to_string());
        guard.last_warned_at = Some(now);
    }

    should_emit
}

fn log_sync_bootstrap_transition(
    previous_mode: &str,
    next_mode: &str,
    reason: &str,
    orders_since_cursor: &str,
    order_count: i64,
) {
    let now = Utc::now();
    let fingerprint =
        format!("{previous_mode}|{next_mode}|{reason}|{orders_since_cursor}|{order_count}");

    if should_emit_bootstrap_transition_log(&fingerprint, now) {
        info!(
            previous_mode = %previous_mode,
            next_mode = %next_mode,
            reason = %reason,
            orders_since_cursor = %orders_since_cursor,
            order_count,
            "Sync bootstrap mode transition"
        );
    } else {
        debug!(
            previous_mode = %previous_mode,
            next_mode = %next_mode,
            reason = %reason,
            orders_since_cursor = %orders_since_cursor,
            order_count,
            "Sync bootstrap mode transition (deduped)"
        );
    }
}

fn transition_sync_bootstrap_mode(
    db: &DbState,
    next_mode: &str,
    reason: &str,
) -> Result<String, String> {
    let inspection = inspect_sync_bootstrap_state(db)?;
    if inspection.current_mode == next_mode {
        return Ok(inspection.current_mode);
    }

    set_sync_bootstrap_mode(db, next_mode)?;
    log_sync_bootstrap_transition(
        inspection.current_mode.as_str(),
        next_mode,
        reason,
        inspection.orders_since_cursor.as_str(),
        inspection.order_count,
    );

    Ok(next_mode.to_string())
}

fn ensure_sync_bootstrap_mode(db: &DbState) -> Result<String, String> {
    let inspection = inspect_sync_bootstrap_state(db)?;
    if inspection.current_mode != SYNC_BOOTSTRAP_MODE_LIVE {
        return Ok(inspection.current_mode);
    }

    // Keep the sync mode live once a cursor exists, even if the local cache is
    // temporarily empty after cleanup. Re-enter bootstrap only when the sync
    // state is genuinely uninitialized.
    if inspection.order_count == 0 && inspection.orders_since_cursor == ORDER_SYNC_SINCE_FALLBACK {
        return transition_sync_bootstrap_mode(
            db,
            SYNC_BOOTSTRAP_MODE_EMPTY_DB,
            "empty_local_orders_with_fallback_cursor",
        );
    }

    Ok(inspection.current_mode)
}

fn finalize_sync_bootstrap_mode_after_remote_catchup(
    db: &DbState,
    outcome: &RemoteOrderReconcileOutcome,
) -> Result<(), String> {
    if !outcome.history_complete || outcome.bootstrap_mode == SYNC_BOOTSTRAP_MODE_LIVE {
        return Ok(());
    }

    let _ = transition_sync_bootstrap_mode(
        db,
        SYNC_BOOTSTRAP_MODE_LIVE,
        "remote_order_history_complete",
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
struct RemoteOrderReconcileOutcome {
    reconciled: usize,
    history_complete: bool,
    bootstrap_mode: String,
}

fn sanitize_orders_since_cursor(raw: Option<String>) -> String {
    let candidate = raw.map(|v| v.trim().to_string()).unwrap_or_default();
    if candidate.is_empty()
        || candidate.eq_ignore_ascii_case("null")
        || candidate.eq_ignore_ascii_case("undefined")
    {
        return ORDER_SYNC_SINCE_FALLBACK.to_string();
    }

    match DateTime::parse_from_rfc3339(&candidate) {
        Ok(dt) => dt
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        Err(_) => ORDER_SYNC_SINCE_FALLBACK.to_string(),
    }
}

fn sanitize_payments_since_cursor(raw: Option<String>) -> String {
    sanitize_orders_since_cursor(raw)
}

#[allow(dead_code)]
fn mark_order_queue_as_queued_remote(
    db: &DbState,
    order_items: &[&SyncItem],
    receipt_id: &str,
) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let next_retry_at = schedule_next_retry(DEFAULT_RETRY_DELAY_MS, 0);
    let mut queued = 0usize;

    for item in order_items {
        let (id, _, entity_id, _, _, _, _, _, _, retry_delay_ms, _) = item;
        let _ = conn.execute(
            "UPDATE sync_queue
             SET status = 'queued_remote',
                 remote_receipt_id = ?1,
                 next_retry_at = ?2,
                 retry_delay_ms = ?3,
                 last_error = NULL,
                 updated_at = datetime('now')
             WHERE id = ?4",
            params![
                receipt_id,
                next_retry_at,
                (*retry_delay_ms).max(DEFAULT_RETRY_DELAY_MS),
                id
            ],
        );

        let _ = conn.execute(
            "UPDATE orders
             SET sync_status = 'queued',
                 last_synced_at = ?1,
                 updated_at = ?1
             WHERE id = ?2",
            params![now, entity_id],
        );
        queued += 1;
    }

    Ok(queued)
}

fn receipt_poll_candidates(db: &DbState) -> Result<Vec<String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT remote_receipt_id
             FROM sync_queue
             WHERE entity_type = 'order'
               AND status = 'queued_remote'
               AND remote_receipt_id IS NOT NULL
               AND (
                    next_retry_at IS NULL
                    OR julianday(next_retry_at) <= julianday('now')
               )
             ORDER BY updated_at ASC
             LIMIT 20",
        )
        .map_err(|e| format!("receipt poll candidates prepare: {e}"))?;

    let receipts = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("receipt poll candidates query: {e}"))?
        .filter_map(|r| r.ok())
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>();
    Ok(receipts)
}

fn mark_receipt_completed(db: &DbState, receipt_id: &str) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let _ = conn.execute(
        "UPDATE orders
         SET sync_status = 'synced',
             last_synced_at = ?1,
             updated_at = ?1
         WHERE id IN (
            SELECT entity_id
            FROM sync_queue
            WHERE entity_type = 'order'
              AND status = 'queued_remote'
              AND remote_receipt_id = ?2
         )",
        params![now, receipt_id],
    );
    let updated = conn
        .execute(
            "UPDATE sync_queue
             SET status = 'synced',
                 synced_at = ?1,
                 last_error = NULL,
                 next_retry_at = NULL,
                 updated_at = datetime('now')
             WHERE entity_type = 'order'
               AND status = 'queued_remote'
               AND remote_receipt_id = ?2",
            params![now, receipt_id],
        )
        .map_err(|e| format!("mark receipt completed: {e}"))?;

    Ok(updated)
}

fn defer_receipt_poll(
    db: &DbState,
    receipt_id: &str,
    delay_ms: i64,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let next_retry_at = schedule_next_retry(delay_ms, receipt_id.bytes().map(i64::from).sum());
    conn.execute(
        "UPDATE sync_queue
         SET next_retry_at = ?1,
             retry_delay_ms = ?2,
             last_error = COALESCE(?3, last_error),
             updated_at = datetime('now')
         WHERE entity_type = 'order'
           AND status = 'queued_remote'
           AND remote_receipt_id = ?4",
        params![
            next_retry_at,
            delay_ms.clamp(1_000, MAX_RETRY_DELAY_MS),
            error,
            receipt_id
        ],
    )
    .map_err(|e| format!("defer receipt poll: {e}"))?;
    Ok(())
}

fn move_receipt_back_to_pending(
    db: &DbState,
    receipt_id: &str,
    reason: &str,
    delay_ms: i64,
) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let next_retry_at = schedule_next_retry(delay_ms, receipt_id.bytes().map(i64::from).sum());

    let mut stmt = conn
        .prepare(
            "SELECT entity_id, retry_count, max_retries
             FROM sync_queue
             WHERE entity_type = 'order'
               AND status = 'queued_remote'
               AND remote_receipt_id = ?1",
        )
        .map_err(|e| format!("prepare dead_letter rows: {e}"))?;
    let rows: Vec<(String, i64, i64)> = stmt
        .query_map(params![receipt_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| format!("query dead_letter rows: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut moved = 0usize;
    for (entity_id, retry_count, max_retries) in rows {
        let new_retry = retry_count + 1;
        let new_status = if new_retry >= max_retries {
            "failed"
        } else {
            "pending"
        };
        let _ = conn.execute(
            "UPDATE sync_queue
             SET status = ?1,
                 retry_count = ?2,
                 remote_receipt_id = NULL,
                 next_retry_at = CASE WHEN ?1 = 'failed' THEN NULL ELSE ?3 END,
                 retry_delay_ms = ?4,
                 last_error = ?5,
                 updated_at = datetime('now')
             WHERE entity_type = 'order'
               AND remote_receipt_id = ?6
               AND entity_id = ?7",
            params![
                new_status,
                new_retry,
                next_retry_at,
                delay_ms.clamp(1_000, MAX_RETRY_DELAY_MS),
                reason,
                receipt_id,
                entity_id
            ],
        );
        let _ = conn.execute(
            "UPDATE orders
             SET sync_status = CASE WHEN ?1 = 'failed' THEN 'failed' ELSE 'pending' END,
                 updated_at = datetime('now')
             WHERE id = ?2",
            params![new_status, entity_id],
        );
        moved += 1;
    }

    Ok(moved)
}

fn receipt_status_recovery_hint(
    response: &Value,
    error_message: &str,
) -> ReceiptStatusRecoveryHint {
    if let Some(hint) = response.get("recovery_hint").and_then(Value::as_str) {
        match hint.trim().to_lowercase().as_str() {
            "direct_order_fallback" => return ReceiptStatusRecoveryHint::DirectOrderFallback,
            "retry_local_queue" => return ReceiptStatusRecoveryHint::RetryLocalQueue,
            _ => {}
        }
    }

    if response
        .get("reason_code")
        .and_then(Value::as_str)
        .map(|value| value.eq_ignore_ascii_case("legacy_receipt_unclaimed_timeout"))
        .unwrap_or(false)
        || is_legacy_unclaimed_receipt_timeout_message(error_message)
    {
        return ReceiptStatusRecoveryHint::DirectOrderFallback;
    }

    ReceiptStatusRecoveryHint::RetryLocalQueue
}

fn load_queued_remote_receipt_items(
    db: &DbState,
    receipt_id: &str,
) -> Result<Vec<SyncItem>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, entity_type, entity_id, operation, payload, idempotency_key,
                    retry_count, max_retries, next_retry_at,
                    COALESCE(retry_delay_ms, 5000), remote_receipt_id
             FROM sync_queue
             WHERE entity_type = 'order'
               AND status = 'queued_remote'
               AND remote_receipt_id = ?1
             ORDER BY id ASC",
        )
        .map_err(|e| format!("queued remote receipt items prepare: {e}"))?;

    let rows = stmt
        .query_map(params![receipt_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
            ))
        })
        .map_err(|e| format!("queued remote receipt items query: {e}"))?;

    Ok(rows.filter_map(|row| row.ok()).collect())
}

fn release_queued_remote_item(
    db: &DbState,
    item: &SyncItem,
    error: &str,
    disposition: QueuedRemoteDisposition,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (id, _, entity_id, _, _, _, retry_count, max_retries, _, retry_delay_ms, _) = item;

    match disposition {
        QueuedRemoteDisposition::Permanent => {
            let final_retry_count = (*retry_count + 1).max(*max_retries);
            conn.execute(
                "UPDATE sync_queue
                 SET status = 'failed',
                     retry_count = ?1,
                     remote_receipt_id = NULL,
                     next_retry_at = NULL,
                     last_error = ?2,
                     updated_at = datetime('now')
                 WHERE id = ?3",
                params![final_retry_count, error, id],
            )
            .map_err(|e| format!("release queued remote item permanently: {e}"))?;
            conn.execute(
                "UPDATE orders
                 SET sync_status = 'failed',
                     updated_at = datetime('now')
                 WHERE id = ?1",
                params![entity_id],
            )
            .map_err(|e| format!("mark order failed after remote release: {e}"))?;
        }
        QueuedRemoteDisposition::Retryable => {
            if is_backpressure_error(error) {
                let delay_ms = (extract_retry_after_seconds(error).unwrap_or(5).max(1) * 1000)
                    .clamp(1_000, MAX_RETRY_DELAY_MS);
                let next_retry_at = schedule_next_retry(delay_ms, *id);
                conn.execute(
                    "UPDATE sync_queue
                     SET status = 'pending',
                         remote_receipt_id = NULL,
                         next_retry_at = ?1,
                         retry_delay_ms = ?2,
                         last_error = ?3,
                         updated_at = datetime('now')
                     WHERE id = ?4",
                    params![next_retry_at, delay_ms, error, id],
                )
                .map_err(|e| format!("release queued remote item for backpressure retry: {e}"))?;
                conn.execute(
                    "UPDATE orders
                     SET sync_status = 'pending',
                         updated_at = datetime('now')
                     WHERE id = ?1",
                    params![entity_id],
                )
                .map_err(|e| format!("mark order pending after backpressure retry: {e}"))?;
                return Ok(());
            }

            let new_retry = *retry_count + 1;
            let exhausted = new_retry >= *max_retries;
            let new_status = if exhausted { "failed" } else { "pending" };
            let next_delay =
                ((*retry_delay_ms).max(DEFAULT_RETRY_DELAY_MS) * 2).min(MAX_RETRY_DELAY_MS);
            let next_retry_at = if exhausted {
                None
            } else {
                Some(schedule_next_retry(next_delay, *id))
            };

            conn.execute(
                "UPDATE sync_queue
                 SET status = ?1,
                     retry_count = ?2,
                     remote_receipt_id = NULL,
                     next_retry_at = ?3,
                     retry_delay_ms = ?4,
                     last_error = ?5,
                     updated_at = datetime('now')
                 WHERE id = ?6",
                params![new_status, new_retry, next_retry_at, next_delay, error, id],
            )
            .map_err(|e| format!("release queued remote item for retry: {e}"))?;
            conn.execute(
                "UPDATE orders
                 SET sync_status = CASE WHEN ?1 = 'failed' THEN 'failed' ELSE 'pending' END,
                     updated_at = datetime('now')
                 WHERE id = ?2",
                params![new_status, entity_id],
            )
            .map_err(|e| format!("mark order pending after remote retry: {e}"))?;
        }
    }

    Ok(())
}

#[derive(Debug, Default)]
struct ReceiptRecoveryOutcome {
    synced_rows: usize,
    requeued_rows: usize,
    failed_rows: usize,
}

impl ReceiptRecoveryOutcome {
    fn handled_rows(&self) -> usize {
        self.synced_rows + self.requeued_rows + self.failed_rows
    }
}

async fn recover_legacy_unclaimed_receipt_via_direct_fallback(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
    fallback_branch_id: &str,
    receipt_id: &str,
    original_error: &str,
) -> Result<ReceiptRecoveryOutcome, String> {
    let receipt_items = load_queued_remote_receipt_items(db, receipt_id)?;
    if receipt_items.is_empty() {
        return Ok(ReceiptRecoveryOutcome::default());
    }

    let mut outcome = ReceiptRecoveryOutcome::default();
    let mut eligible_items: Vec<&SyncItem> = Vec::new();
    let mut non_insert_items: Vec<&SyncItem> = Vec::new();

    for item in &receipt_items {
        if item.3.trim().eq_ignore_ascii_case("insert") {
            eligible_items.push(item);
        } else {
            non_insert_items.push(item);
        }
    }

    if !eligible_items.is_empty() {
        match sync_order_batch_via_direct_api(
            db,
            admin_url,
            api_key,
            fallback_branch_id,
            &eligible_items,
        )
        .await
        {
            Ok(direct_outcome) => {
                for item in &eligible_items {
                    if direct_outcome.synced_queue_ids.contains(&item.0) {
                        outcome.synced_rows += 1;
                        continue;
                    }

                    if let Some(error) = direct_outcome.permanent_failures.get(&item.0) {
                        release_queued_remote_item(
                            db,
                            item,
                            error,
                            QueuedRemoteDisposition::Permanent,
                        )?;
                        outcome.failed_rows += 1;
                        continue;
                    }

                    if let Some(error) = direct_outcome.transient_failures.get(&item.0) {
                        release_queued_remote_item(
                            db,
                            item,
                            error,
                            QueuedRemoteDisposition::Retryable,
                        )?;
                        outcome.requeued_rows += 1;
                        continue;
                    }

                    release_queued_remote_item(
                        db,
                        item,
                        original_error,
                        QueuedRemoteDisposition::Retryable,
                    )?;
                    outcome.requeued_rows += 1;
                }
            }
            Err(error) => {
                let retry_error = format!("Transient direct fallback failure: {error}");
                for item in &eligible_items {
                    release_queued_remote_item(
                        db,
                        item,
                        &retry_error,
                        QueuedRemoteDisposition::Retryable,
                    )?;
                    outcome.requeued_rows += 1;
                }
            }
        }
    }

    for item in non_insert_items {
        release_queued_remote_item(db, item, original_error, QueuedRemoteDisposition::Retryable)?;
        outcome.requeued_rows += 1;
    }

    Ok(outcome)
}

async fn poll_order_receipt_statuses(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
    fallback_branch_id: &str,
) -> Result<usize, String> {
    let receipt_ids = receipt_poll_candidates(db)?;
    if receipt_ids.is_empty() {
        return Ok(0);
    }

    let mut completed_rows = 0usize;
    for receipt_id in receipt_ids {
        let path = format!(
            "/api/pos/orders/sync/status?receipt_id={}",
            percent_encode(&receipt_id)
        );
        match api::fetch_from_admin(admin_url, api_key, &path, "GET", None).await {
            Ok(resp) => {
                let status = resp
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_lowercase();
                let error_message = resp
                    .get("error_message")
                    .and_then(Value::as_str)
                    .unwrap_or("remote receipt processing failed");
                let recovery_hint = receipt_status_recovery_hint(&resp, error_message);
                match status.as_str() {
                    "completed" => {
                        let updated = mark_receipt_completed(db, &receipt_id)?;
                        if updated > 0 {
                            info!(
                                receipt_id = %receipt_id,
                                rows = updated,
                                "Remote order receipt completed"
                            );
                            completed_rows += updated;
                        }
                    }
                    "dead_letter" => {
                        if recovery_hint == ReceiptStatusRecoveryHint::DirectOrderFallback {
                            let recovery = recover_legacy_unclaimed_receipt_via_direct_fallback(
                                db,
                                admin_url,
                                api_key,
                                fallback_branch_id,
                                &receipt_id,
                                error_message,
                            )
                            .await?;
                            if recovery.handled_rows() > 0 {
                                if recovery.synced_rows > 0 {
                                    completed_rows += recovery.synced_rows;
                                }
                                warn!(
                                    receipt_id = %receipt_id,
                                    synced_rows = recovery.synced_rows,
                                    requeued_rows = recovery.requeued_rows,
                                    failed_rows = recovery.failed_rows,
                                    error = error_message,
                                    "Legacy unclaimed remote receipt recovered via direct-order fallback"
                                );
                            }
                        } else {
                            let moved = move_receipt_back_to_pending(
                                db,
                                &receipt_id,
                                error_message,
                                DEFAULT_RETRY_DELAY_MS,
                            )?;
                            if moved > 0 {
                                warn!(
                                    receipt_id = %receipt_id,
                                    rows = moved,
                                    error = error_message,
                                    "Remote order receipt dead-lettered; moved back to local pending queue"
                                );
                            }
                        }
                    }
                    "failed" => {
                        if recovery_hint == ReceiptStatusRecoveryHint::DirectOrderFallback {
                            let recovery = recover_legacy_unclaimed_receipt_via_direct_fallback(
                                db,
                                admin_url,
                                api_key,
                                fallback_branch_id,
                                &receipt_id,
                                error_message,
                            )
                            .await?;
                            if recovery.handled_rows() > 0 {
                                if recovery.synced_rows > 0 {
                                    completed_rows += recovery.synced_rows;
                                }
                                warn!(
                                    receipt_id = %receipt_id,
                                    synced_rows = recovery.synced_rows,
                                    requeued_rows = recovery.requeued_rows,
                                    failed_rows = recovery.failed_rows,
                                    error = error_message,
                                    "Remote order receipt failed after legacy claim-timeout; recovered via direct-order fallback"
                                );
                            }
                        } else {
                            let moved = move_receipt_back_to_pending(
                                db,
                                &receipt_id,
                                error_message,
                                DEFAULT_RETRY_DELAY_MS,
                            )?;
                            if moved > 0 {
                                warn!(
                                    receipt_id = %receipt_id,
                                    rows = moved,
                                    error = error_message,
                                    "Remote order receipt failed; moved back to local queue for retry/failure handling"
                                );
                            }
                        }
                    }
                    "pending" | "processing" => {
                        defer_receipt_poll(
                            db,
                            &receipt_id,
                            DEFAULT_RETRY_DELAY_MS,
                            Some(error_message),
                        )?;
                    }
                    _ => {
                        defer_receipt_poll(
                            db,
                            &receipt_id,
                            DEFAULT_RETRY_DELAY_MS,
                            Some("Unknown remote receipt status"),
                        )?;
                    }
                }
            }
            Err(e) => {
                if is_backpressure_error(&e) {
                    let retry_after = extract_retry_after_seconds(&e).unwrap_or(5).max(1);
                    defer_receipt_poll(db, &receipt_id, retry_after * 1000, Some(&e))?;
                } else {
                    defer_receipt_poll(db, &receipt_id, DEFAULT_RETRY_DELAY_MS, Some(&e))?;
                }
                if is_transient_receipt_poll_error(&e) {
                    debug!(
                        receipt_id = %receipt_id,
                        error = %e,
                        "Order receipt poll deferred after transient failure"
                    );
                } else {
                    warn!(receipt_id = %receipt_id, error = %e, "Order receipt poll failed");
                }
            }
        }
    }

    Ok(completed_rows)
}

fn resolve_local_order_id(conn: &rusqlite::Connection, remote_order: &Value) -> Option<String> {
    let remote_id = remote_order.get("id").and_then(Value::as_str);
    let client_order_id = remote_order.get("client_order_id").and_then(Value::as_str);
    let order_number = remote_order.get("order_number").and_then(Value::as_str);

    if let Some(client_id) = client_order_id {
        if let Ok(id) = conn.query_row(
            "SELECT id FROM orders WHERE id = ?1 LIMIT 1",
            params![client_id],
            |row| row.get::<_, String>(0),
        ) {
            return Some(id);
        }
    }

    if let Some(remote_id) = remote_id {
        if let Ok(id) = conn.query_row(
            "SELECT id FROM orders WHERE supabase_id = ?1 LIMIT 1",
            params![remote_id],
            |row| row.get::<_, String>(0),
        ) {
            return Some(id);
        }
    }

    if let Some(order_number) = order_number {
        if let Ok(id) = conn.query_row(
            "SELECT id FROM orders WHERE order_number = ?1 LIMIT 1",
            params![order_number],
            |row| row.get::<_, String>(0),
        ) {
            return Some(id);
        }
    }

    None
}

fn materialize_remote_order(
    conn: &rusqlite::Connection,
    remote_order: &Value,
) -> Result<Option<String>, String> {
    let remote_id = match remote_order.get("id").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => return Ok(None),
    };

    let existing_local_id: Option<String> = conn
        .query_row(
            "SELECT id FROM orders WHERE supabase_id = ?1 LIMIT 1",
            params![remote_id.clone()],
            |row| row.get(0),
        )
        .ok();
    if existing_local_id.is_some() {
        return Ok(existing_local_id);
    }

    let client_order_id = remote_order
        .get("client_order_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let local_id = client_order_id.unwrap_or_else(|| Uuid::new_v4().to_string());

    let items_json = match remote_order.get("items") {
        Some(Value::String(raw)) => raw.clone(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "[]".to_string()),
        None => "[]".to_string(),
    };

    let order_number = str_any(remote_order, &["order_number", "orderNumber"]);
    let customer_name = str_any(remote_order, &["customer_name", "customerName"]);
    let customer_phone = str_any(remote_order, &["customer_phone", "customerPhone"]);
    let customer_email = str_any(remote_order, &["customer_email", "customerEmail"]);
    let customer_id = str_any(remote_order, &["customer_id", "customerId"]);
    let total_amount = num_any(remote_order, &["total_amount", "totalAmount"]).unwrap_or(0.0);
    let tax_amount = num_any(remote_order, &["tax_amount", "taxAmount"]).unwrap_or(0.0);
    let subtotal = num_any(remote_order, &["subtotal"]).unwrap_or(total_amount);
    let status = normalize_order_status_for_sync(
        remote_order
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending"),
    );
    let order_type =
        str_any(remote_order, &["order_type", "orderType"]).unwrap_or_else(|| "pickup".to_string());
    let table_number = str_any(remote_order, &["table_number", "tableNumber"]);
    let delivery_address = str_any(remote_order, &["delivery_address", "deliveryAddress"]);
    let delivery_city = str_any(remote_order, &["delivery_city", "deliveryCity"]);
    let delivery_postal_code = str_any(
        remote_order,
        &["delivery_postal_code", "deliveryPostalCode"],
    );
    let delivery_floor = str_any(remote_order, &["delivery_floor", "deliveryFloor"]);
    let delivery_notes = str_any(remote_order, &["delivery_notes", "deliveryNotes"]);
    let name_on_ringer = str_any(remote_order, &["name_on_ringer", "nameOnRinger"]);
    let special_instructions = str_any(
        remote_order,
        &["special_instructions", "specialInstructions", "notes"],
    );
    let created_at = str_any(remote_order, &["created_at", "createdAt"])
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let updated_at =
        str_any(remote_order, &["updated_at", "updatedAt"]).unwrap_or_else(|| created_at.clone());
    let estimated_time = i64_any(remote_order, &["estimated_time", "estimatedTime"]);
    let payment_status = normalize_payment_status_for_sync(
        remote_order.get("payment_status").and_then(Value::as_str),
    );
    let payment_method = str_any(remote_order, &["payment_method", "paymentMethod"]);
    let payment_tx = str_any(
        remote_order,
        &["payment_transaction_id", "paymentTransactionId"],
    );
    let staff_shift_id = str_any(remote_order, &["staff_shift_id", "staffShiftId"]);
    let staff_id = str_any(remote_order, &["staff_id", "staffId"]);
    let driver_id = str_any(remote_order, &["driver_id", "driverId"]);
    let driver_name = str_any(remote_order, &["driver_name", "driverName"]);
    let discount_percentage =
        num_any(remote_order, &["discount_percentage", "discountPercentage"]).unwrap_or(0.0);
    let discount_amount =
        num_any(remote_order, &["discount_amount", "discountAmount"]).unwrap_or(0.0);
    let tip_amount = num_any(remote_order, &["tip_amount", "tipAmount"]).unwrap_or(0.0);
    let version = remote_order
        .get("version")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let terminal_id = str_any(remote_order, &["terminal_id", "terminalId"]);
    let branch_id = str_any(remote_order, &["branch_id", "branchId"]);
    let plugin = str_any(remote_order, &["plugin", "platform"]);
    let external_plugin_order_id = str_any(
        remote_order,
        &["external_plugin_order_id", "externalPluginOrderId"],
    );
    let tax_rate = num_any(remote_order, &["tax_rate", "taxRate"]);
    let delivery_fee = num_any(remote_order, &["delivery_fee", "deliveryFee"]).unwrap_or(0.0);
    let is_ghost = bool_any(remote_order, &["is_ghost", "isGhost"]).unwrap_or(false);
    let ghost_source = str_any(remote_order, &["ghost_source", "ghostSource"]);
    let ghost_metadata = remote_order
        .get("ghost_metadata")
        .or_else(|| remote_order.get("ghostMetadata"))
        .and_then(|value| {
            if value.is_null() {
                return None;
            }
            if let Some(raw) = value.as_str() {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return None;
                }
                return Some(trimmed.to_string());
            }
            Some(value.to_string())
        });

    conn.execute(
        "INSERT INTO orders (
            id, order_number, customer_name, customer_phone, customer_email, customer_id,
            items, total_amount, tax_amount, subtotal, status,
            order_type, table_number, delivery_address, delivery_city, delivery_postal_code,
            delivery_floor, delivery_notes, name_on_ringer, special_instructions,
            created_at, updated_at, estimated_time, supabase_id, sync_status,
            payment_status, payment_method, payment_transaction_id, staff_shift_id,
            staff_id, driver_id, driver_name, discount_percentage, discount_amount,
            tip_amount, version, terminal_id, branch_id, plugin, external_plugin_order_id,
            tax_rate, delivery_fee, is_ghost, ghost_source, ghost_metadata
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9, ?10, ?11,
            ?12, ?13, ?14, ?15, ?16,
            ?17, ?18, ?19, ?20,
            ?21, ?22, ?23, ?24, 'synced',
            ?25, ?26, ?27, ?28,
            ?29, ?30, ?31, ?32, ?33,
            ?34, ?35, ?36, ?37, ?38,
            ?39, ?40, ?41, ?42,
            ?43, ?44
        )",
        params![
            local_id,
            order_number,
            customer_name,
            customer_phone,
            customer_email,
            customer_id,
            items_json,
            total_amount,
            tax_amount,
            subtotal,
            status,
            order_type,
            table_number,
            delivery_address,
            delivery_city,
            delivery_postal_code,
            delivery_floor,
            delivery_notes,
            name_on_ringer,
            special_instructions,
            created_at,
            updated_at,
            estimated_time,
            remote_id,
            payment_status,
            payment_method,
            payment_tx,
            staff_shift_id,
            staff_id,
            driver_id,
            driver_name,
            discount_percentage,
            discount_amount,
            tip_amount,
            version,
            terminal_id,
            branch_id,
            plugin,
            external_plugin_order_id,
            tax_rate,
            delivery_fee,
            if is_ghost { 1_i64 } else { 0_i64 },
            ghost_source,
            ghost_metadata,
        ],
    )
    .map_err(|e| format!("materialize remote order: {e}"))?;

    Ok(Some(local_id))
}

fn remote_payment_changed_at(remote_payment: &Value) -> String {
    remote_payment
        .get("updated_at")
        .or_else(|| remote_payment.get("updatedAt"))
        .or_else(|| remote_payment.get("created_at"))
        .or_else(|| remote_payment.get("createdAt"))
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .unwrap_or_default()
}

fn replace_local_payment_items(
    conn: &Connection,
    local_payment_id: &str,
    order_id: &str,
    items: Option<&Value>,
    created_at: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM payment_items WHERE payment_id = ?1",
        params![local_payment_id],
    )
    .map_err(|e| format!("clear local payment items: {e}"))?;

    let Some(item_rows) = items.and_then(Value::as_array) else {
        return Ok(());
    };

    for (fallback_index, item) in item_rows.iter().enumerate() {
        let item_index = item
            .get("item_index")
            .or_else(|| item.get("itemIndex"))
            .and_then(Value::as_i64)
            .unwrap_or(fallback_index as i64) as i32;
        let item_name = item
            .get("item_name")
            .or_else(|| item.get("itemName"))
            .or_else(|| item.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Item");
        let item_quantity = item
            .get("item_quantity")
            .or_else(|| item.get("itemQuantity"))
            .or_else(|| item.get("quantity"))
            .and_then(Value::as_i64)
            .unwrap_or(1) as i32;
        let item_amount = item
            .get("item_amount")
            .or_else(|| item.get("itemAmount"))
            .or_else(|| item.get("amount"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);

        conn.execute(
            "INSERT INTO payment_items (
                id, payment_id, order_id, item_index, item_name,
                item_quantity, item_amount, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                Uuid::new_v4().to_string(),
                local_payment_id,
                order_id,
                item_index,
                item_name,
                item_quantity,
                item_amount,
                created_at,
            ],
        )
        .map_err(|e| format!("insert local payment item: {e}"))?;
    }

    Ok(())
}

fn mark_payment_queue_row_synced(
    conn: &Connection,
    payment_id: &str,
    synced_at: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE sync_queue
         SET status = 'synced',
             synced_at = ?1,
             retry_count = 0,
             next_retry_at = NULL,
             last_error = NULL,
             updated_at = ?1
         WHERE entity_type IN ('payment', 'order_payments')
           AND entity_id = ?2
           AND status != 'synced'",
        params![synced_at, payment_id],
    )
    .map_err(|e| format!("mark payment queue row synced: {e}"))?;

    Ok(())
}

fn mark_local_payment_applied(
    conn: &Connection,
    payment_id: &str,
    synced_at: &str,
    remote_payment_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE order_payments
         SET sync_status = 'synced',
             sync_state = 'applied',
             remote_payment_id = COALESCE(?1, remote_payment_id),
             sync_retry_count = 0,
             sync_last_error = NULL,
             sync_next_retry_at = NULL,
             updated_at = ?2
         WHERE id = ?3",
        params![remote_payment_id, synced_at, payment_id],
    )
    .map_err(|e| format!("mark local payment applied: {e}"))?;

    mark_payment_queue_row_synced(conn, payment_id, synced_at)
}

fn find_canonical_duplicate_payment_target_with_conn(
    conn: &Connection,
    payment_id: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    let payment_context: Option<(String, String, f64, Option<String>)> = conn
        .query_row(
            "SELECT
                 order_id,
                 method,
                 amount,
                 NULLIF(TRIM(COALESCE(transaction_ref, '')), '')
             FROM order_payments op
             WHERE op.id = ?1
             LIMIT 1",
            params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| format!("load canonical duplicate payment context: {e}"))?;

    let Some((order_id, method, amount, transaction_ref)) = payment_context else {
        return Ok(None);
    };

    conn.query_row(
        "SELECT
             id,
             NULLIF(TRIM(COALESCE(remote_payment_id, '')), '')
         FROM order_payments
         WHERE order_id = ?1
           AND id != ?2
           AND status = 'completed'
           AND method = ?3
           AND ABS(amount - ?4) < 0.01
           AND (
                NULLIF(TRIM(COALESCE(remote_payment_id, '')), '') IS NOT NULL
                OR COALESCE(sync_state, '') = 'applied'
           )
           AND (
                ?5 IS NULL
                OR NULLIF(TRIM(COALESCE(transaction_ref, '')), '') = ?5
                OR NULLIF(TRIM(COALESCE(transaction_ref, '')), '') IS NULL
           )
         ORDER BY
             CASE
                 WHEN NULLIF(TRIM(COALESCE(remote_payment_id, '')), '') IS NOT NULL THEN 0
                 ELSE 1
             END,
             COALESCE(updated_at, created_at, '') ASC,
             id ASC
         LIMIT 1",
        params![order_id, payment_id, method, amount, transaction_ref],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|e| format!("resolve canonical duplicate payment target: {e}"))
}

fn rewrite_adjustment_sync_payload_payment_id(
    payload: &str,
    canonical_payment_id: &str,
) -> Result<String, String> {
    let mut data = match serde_json::from_str::<Value>(payload) {
        Ok(Value::Object(map)) => Value::Object(map),
        Ok(_) | Err(_) => Value::Object(Map::new()),
    };

    if let Some(object) = data.as_object_mut() {
        object.insert(
            "paymentId".to_string(),
            Value::String(canonical_payment_id.to_string()),
        );
        object.insert(
            "payment_id".to_string(),
            Value::String(canonical_payment_id.to_string()),
        );
    }

    serde_json::to_string(&data)
        .map_err(|e| format!("serialize rebound adjustment sync payload: {e}"))
}

fn rebind_waiting_adjustments_to_canonical_duplicate_payments(
    db: &DbState,
) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT pa.id, pa.payment_id
             FROM payment_adjustments pa
             JOIN order_payments op ON op.id = pa.payment_id
             WHERE pa.sync_state = 'waiting_parent'
               AND op.sync_state = 'applied'
               AND NULLIF(TRIM(COALESCE(op.remote_payment_id, '')), '') IS NULL",
        )
        .map_err(|e| format!("prepare waiting adjustment duplicate parent scan: {e}"))?;

    let candidates: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| format!("query waiting adjustment duplicate parent scan: {e}"))?
        .filter_map(|row| row.ok())
        .collect();
    drop(stmt);

    if candidates.is_empty() {
        return Ok(0);
    }

    let rebound_at = Utc::now().to_rfc3339();
    let mut rebound = 0usize;
    let mut stale_payment_ids = HashSet::new();

    for (adjustment_id, stale_payment_id) in candidates {
        let Some((canonical_payment_id, canonical_remote_payment_id)) =
            find_canonical_duplicate_payment_target_with_conn(&conn, &stale_payment_id)?
        else {
            continue;
        };

        if normalize_optional_uuid_str(canonical_remote_payment_id.as_deref()).is_none() {
            continue;
        }

        let updated = conn
            .execute(
                "UPDATE payment_adjustments
                 SET payment_id = ?1,
                     sync_last_error = NULL,
                     updated_at = ?2
                 WHERE id = ?3
                   AND sync_state = 'waiting_parent'
                   AND payment_id = ?4",
                params![
                    canonical_payment_id.as_str(),
                    rebound_at.as_str(),
                    adjustment_id.as_str(),
                    stale_payment_id.as_str()
                ],
            )
            .map_err(|e| format!("rebind waiting adjustment to canonical payment: {e}"))?;

        if updated == 0 {
            continue;
        }

        let mut queue_stmt = conn
            .prepare(
                "SELECT id, payload
                 FROM sync_queue
                 WHERE entity_type = 'payment_adjustment'
                   AND entity_id = ?1
                   AND status != 'synced'",
            )
            .map_err(|e| format!("prepare waiting adjustment queue payload rewrite: {e}"))?;
        let queue_rows: Vec<(i64, String)> = queue_stmt
            .query_map(params![adjustment_id.as_str()], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("query waiting adjustment queue payload rewrite: {e}"))?
            .filter_map(|row| row.ok())
            .collect();
        drop(queue_stmt);

        for (queue_id, payload) in queue_rows {
            let rewritten_payload =
                rewrite_adjustment_sync_payload_payment_id(&payload, &canonical_payment_id)?;
            conn.execute(
                "UPDATE sync_queue
                 SET payload = ?1,
                     updated_at = datetime('now')
                 WHERE id = ?2",
                params![rewritten_payload, queue_id],
            )
            .map_err(|e| format!("persist rebound adjustment queue payload: {e}"))?;
        }

        info!(
            adjustment_id = %adjustment_id,
            stale_payment_id = %stale_payment_id,
            canonical_payment_id = %canonical_payment_id,
            canonical_remote_payment_id = %canonical_remote_payment_id.unwrap_or_default(),
            "Rebound waiting adjustment to canonical sibling payment after payment repair"
        );

        rebound += 1;
        stale_payment_ids.insert(stale_payment_id);
    }

    for stale_payment_id in stale_payment_ids {
        if let Some(canonical_payment_id) =
            resolve_duplicate_payment_total_conflict_with_conn(&conn, &stale_payment_id, &rebound_at)?
        {
            info!(
                stale_payment_id = %stale_payment_id,
                canonical_payment_id = %canonical_payment_id,
                "Void stale duplicate parent payment after adjustment rebind"
            );
        }
    }

    Ok(rebound)
}

fn resolve_duplicate_payment_total_conflict_with_conn(
    conn: &Connection,
    payment_id: &str,
    resolved_at: &str,
) -> Result<Option<String>, String> {
    let order_id: Option<String> = conn
        .query_row(
            "SELECT order_id
             FROM order_payments
             WHERE id = ?1
             LIMIT 1",
            params![payment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("load duplicate payment order id: {e}"))?;
    let Some(order_id) = order_id else {
        return Ok(None);
    };

    let adjustment_count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM payment_adjustments
             WHERE payment_id = ?1",
            params![payment_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("load duplicate payment adjustment count: {e}"))?;

    if adjustment_count > 0 {
        return Ok(None);
    }

    let Some((canonical_payment_id, _canonical_remote_payment_id)) =
        find_canonical_duplicate_payment_target_with_conn(conn, payment_id)?
    else {
        return Ok(None);
    };

    let void_reason = format!(
        "Superseded duplicate local payment replay; canonical payment {canonical_payment_id}"
    );

    conn.execute(
        "UPDATE order_payments
         SET status = 'voided',
             voided_at = ?1,
             void_reason = ?2,
             sync_status = 'synced',
             sync_state = 'applied',
             sync_retry_count = 0,
             sync_last_error = NULL,
             sync_next_retry_at = NULL,
             updated_at = ?1
         WHERE id = ?3",
        params![resolved_at, void_reason, payment_id],
    )
    .map_err(|e| format!("void stale duplicate payment row: {e}"))?;

    mark_payment_queue_row_synced(conn, payment_id, resolved_at)?;
    recompute_local_order_payment_snapshot(conn, &order_id, resolved_at)?;

    Ok(Some(canonical_payment_id))
}

fn resolve_duplicate_payment_total_conflict(
    db: &DbState,
    payment_id: &str,
) -> Result<Option<String>, String> {
    let resolved_at = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    resolve_duplicate_payment_total_conflict_with_conn(&conn, payment_id, &resolved_at)
}

#[derive(Debug, Clone)]
pub(crate) struct StaleLocalPaymentConflictResolution {
    pub order_id: String,
    pub amount: f64,
    pub outstanding_before: f64,
}

pub(crate) fn resolve_stale_local_payment_total_conflict_with_conn(
    conn: &Connection,
    payment_id: &str,
    resolved_at: &str,
) -> Result<Option<StaleLocalPaymentConflictResolution>, String> {
    let payment_context: Option<(String, f64, String, String, Option<String>, i64)> = conn
        .query_row(
            "SELECT
                 order_id,
                 amount,
                 COALESCE(sync_status, ''),
                 COALESCE(sync_state, ''),
                 NULLIF(TRIM(COALESCE(remote_payment_id, '')), ''),
                 (
                     SELECT COUNT(*)
                     FROM payment_adjustments
                     WHERE payment_id = op.id
                 )
             FROM order_payments op
             WHERE op.id = ?1
               AND op.status = 'completed'
             LIMIT 1",
            params![payment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("load stale payment conflict context: {e}"))?;

    let Some((order_id, amount, sync_status, sync_state, remote_payment_id, adjustment_count)) =
        payment_context
    else {
        return Ok(None);
    };

    if adjustment_count > 0
        || remote_payment_id.is_some()
        || (sync_status.eq_ignore_ascii_case("synced")
            && sync_state.eq_ignore_ascii_case("applied"))
    {
        return Ok(None);
    }

    let order_total: f64 = conn
        .query_row(
            "SELECT COALESCE(total_amount, 0)
             FROM orders
             WHERE id = ?1",
            params![order_id.as_str()],
            |row| row.get(0),
        )
        .map_err(|e| format!("load stale payment conflict order total: {e}"))?;

    let other_net_paid: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(
                CASE
                    WHEN op.amount - COALESCE((
                        SELECT SUM(pa.amount)
                        FROM payment_adjustments pa
                        WHERE pa.payment_id = op.id
                          AND pa.adjustment_type = 'refund'
                    ), 0) > 0
                    THEN op.amount - COALESCE((
                        SELECT SUM(pa.amount)
                        FROM payment_adjustments pa
                        WHERE pa.payment_id = op.id
                          AND pa.adjustment_type = 'refund'
                    ), 0)
                    ELSE 0
                END
             ), 0)
             FROM order_payments op
             WHERE op.order_id = ?1
               AND op.id != ?2
               AND op.status = 'completed'",
            params![order_id.as_str(), payment_id],
            |row| row.get(0),
        )
        .unwrap_or(0.0);

    let outstanding_before = (order_total - other_net_paid).max(0.0);
    let exceeds_order_total = amount > order_total + 0.01;
    let exceeds_outstanding = amount > outstanding_before + 0.01;
    if !exceeds_order_total && !exceeds_outstanding {
        return Ok(None);
    }

    let void_reason = format!(
        "Auto-voided stale unsynced local payment after order total changed; no canonical remote payment found (order total {order_total:.2}, outstanding {outstanding_before:.2})"
    );

    conn.execute(
        "UPDATE order_payments
         SET status = 'voided',
             voided_at = ?1,
             void_reason = ?2,
             sync_status = 'synced',
             sync_state = 'applied',
             sync_retry_count = 0,
             sync_last_error = NULL,
             sync_next_retry_at = NULL,
             updated_at = ?1
         WHERE id = ?3
           AND status = 'completed'
           AND NULLIF(TRIM(COALESCE(remote_payment_id, '')), '') IS NULL",
        params![resolved_at, void_reason, payment_id],
    )
    .map_err(|e| format!("void stale local overpay payment row: {e}"))?;

    mark_payment_queue_row_synced(conn, payment_id, resolved_at)?;
    recompute_local_order_payment_snapshot(conn, &order_id, resolved_at)?;

    Ok(Some(StaleLocalPaymentConflictResolution {
        order_id,
        amount,
        outstanding_before,
    }))
}

pub(crate) fn resolve_stale_local_payment_total_conflict(
    db: &DbState,
    payment_id: &str,
) -> Result<Option<StaleLocalPaymentConflictResolution>, String> {
    let resolved_at = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    resolve_stale_local_payment_total_conflict_with_conn(&conn, payment_id, &resolved_at)
}

fn recompute_local_order_payment_snapshot(
    conn: &Connection,
    order_id: &str,
    now: &str,
) -> Result<(), String> {
    let payment_context: Option<(String, String)> = conn
        .query_row(
            "SELECT
                 op.id,
                 COALESCE(NULLIF(TRIM(op.method), ''), 'split')
             FROM order_payments op
             WHERE op.order_id = ?1
               AND op.status = 'completed'
             ORDER BY COALESCE(op.updated_at, op.created_at, '') DESC, op.id DESC
             LIMIT 1",
            params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("load local payment snapshot for order recompute: {e}"))?;

    let Some((payment_id, method)) = payment_context else {
        conn.execute(
            "UPDATE orders
             SET payment_status = 'pending',
                 payment_method = 'pending',
                 payment_transaction_id = NULL,
                 updated_at = ?1
             WHERE id = ?2",
            params![now, order_id],
        )
        .map_err(|e| {
            format!("reset local payment snapshot after completed payment removal: {e}")
        })?;
        return Ok(());
    };

    let has_item_assignments = match conn.query_row(
        "SELECT COUNT(*)
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'order_payment_items'",
        [],
        |row| row.get::<_, i64>(0),
    ) {
        Ok(table_count) if table_count > 0 => {
            conn.query_row(
                "SELECT EXISTS(
                    SELECT 1
                    FROM order_payment_items
                    WHERE payment_id = ?1
                    LIMIT 1
                )",
                params![payment_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
                != 0
        }
        _ => false,
    };

    payments::recompute_order_payment_state(
        conn,
        order_id,
        &method,
        has_item_assignments,
        now,
        &payment_id,
    )
}

fn hydrate_local_payment_from_remote(
    conn: &Connection,
    local_order_id: &str,
    local_payment_id: &str,
    remote_payment_id: &str,
    method: &str,
    amount: f64,
    currency: &str,
    transaction_ref: Option<&str>,
    items: Option<&Value>,
    created_at: &str,
    updated_at: &str,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE order_payments
         SET method = ?1,
             amount = ?2,
             currency = ?3,
             transaction_ref = COALESCE(?4, transaction_ref),
             updated_at = ?5
         WHERE id = ?6",
        params![
            method,
            amount,
            currency,
            transaction_ref,
            updated_at,
            local_payment_id,
        ],
    )
    .map_err(|e| format!("update remote payment mirror: {e}"))?;
    mark_local_payment_applied(conn, local_payment_id, updated_at, Some(remote_payment_id))?;
    replace_local_payment_items(conn, local_payment_id, local_order_id, items, created_at)?;
    payments::recompute_order_payment_state(
        conn,
        local_order_id,
        method,
        items
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false),
        updated_at,
        local_payment_id,
    )?;

    Ok(1)
}

fn sync_remote_payment_into_local(
    conn: &Connection,
    remote_payment: &Value,
) -> Result<usize, String> {
    let Some(remote_payment_id) = str_any(remote_payment, &["id", "payment_id", "paymentId"])
    else {
        return Ok(0);
    };
    let Some(remote_order_id) = str_any(remote_payment, &["order_id", "orderId"]) else {
        return Ok(0);
    };

    let local_order_id: Option<String> = conn
        .query_row(
            "SELECT id FROM orders WHERE supabase_id = ?1 OR id = ?1 LIMIT 1",
            params![remote_order_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("resolve local order for remote payment: {e}"))?;
    let Some(local_order_id) = local_order_id else {
        return Ok(0);
    };

    let raw_method = str_any(
        remote_payment,
        &["payment_method", "paymentMethod", "method"],
    )
    .unwrap_or_else(|| "other".to_string());
    let Some(method) = payments::normalize_external_payment_method(&raw_method) else {
        return Ok(0);
    };

    let amount = num_any(remote_payment, &["amount"]).unwrap_or(0.0);
    if amount <= 0.0 {
        return Ok(0);
    }

    let created_at = str_any(remote_payment, &["created_at", "createdAt"])
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let updated_at =
        str_any(remote_payment, &["updated_at", "updatedAt"]).unwrap_or_else(|| created_at.clone());
    let currency = str_any(remote_payment, &["currency"]).unwrap_or_else(|| "EUR".to_string());
    let transaction_ref = str_any(
        remote_payment,
        &[
            "external_transaction_id",
            "externalTransactionId",
            "transaction_ref",
            "transactionRef",
        ],
    );
    let items = remote_payment.get("items");
    let metadata_local_payment_id = remote_payment
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| {
            metadata
                .get("local_payment_id")
                .or_else(|| metadata.get("localPaymentId"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    let existing_local_payment_id: Option<String> = conn
        .query_row(
            "SELECT id
             FROM order_payments
             WHERE remote_payment_id = ?1
             LIMIT 1",
            params![remote_payment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("resolve local payment by remote_payment_id: {e}"))?;

    if let Some(local_payment_id) = existing_local_payment_id {
        return hydrate_local_payment_from_remote(
            conn,
            &local_order_id,
            &local_payment_id,
            &remote_payment_id,
            &method,
            amount,
            &currency,
            transaction_ref.as_deref(),
            items,
            &created_at,
            &updated_at,
        );
    }

    if let Some(local_payment_id) = metadata_local_payment_id {
        let exact_local_payment_id: Option<String> = conn
            .query_row(
                "SELECT id
                 FROM order_payments
                 WHERE id = ?1
                   AND order_id = ?2
                 LIMIT 1",
                params![local_payment_id, local_order_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("resolve local payment from remote metadata: {e}"))?;

        if let Some(local_payment_id) = exact_local_payment_id {
            return hydrate_local_payment_from_remote(
                conn,
                &local_order_id,
                &local_payment_id,
                &remote_payment_id,
                &method,
                amount,
                &currency,
                transaction_ref.as_deref(),
                items,
                &created_at,
                &updated_at,
            );
        }
    }

    let placeholder_payment_id: Option<String> = conn
        .query_row(
            "SELECT id
             FROM order_payments
             WHERE order_id = ?1
               AND payment_origin = 'sync_reconstructed'
               AND remote_payment_id IS NULL
               AND status = 'completed'
               AND method = ?2
               AND ABS(amount - ?3) < 0.01
             ORDER BY created_at ASC
             LIMIT 1",
            params![local_order_id, method, amount],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("resolve reconstructed payment placeholder: {e}"))?;

    if let Some(local_payment_id) = placeholder_payment_id {
        return hydrate_local_payment_from_remote(
            conn,
            &local_order_id,
            &local_payment_id,
            &remote_payment_id,
            &method,
            amount,
            &currency,
            transaction_ref.as_deref(),
            items,
            &created_at,
            &updated_at,
        );
    }

    if let Some(transaction_ref) = transaction_ref.as_deref() {
        let orphan_local_payment_id: Option<String> = conn
            .query_row(
                "SELECT id
                 FROM order_payments
                 WHERE order_id = ?1
                   AND remote_payment_id IS NULL
                   AND status = 'completed'
                   AND method = ?2
                   AND ABS(amount - ?3) < 0.01
                   AND COALESCE(transaction_ref, '') = ?4
                 ORDER BY created_at ASC
                 LIMIT 1",
                params![local_order_id, method, amount, transaction_ref],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("resolve orphan local payment mirror: {e}"))?;

        if let Some(local_payment_id) = orphan_local_payment_id {
            return hydrate_local_payment_from_remote(
                conn,
                &local_order_id,
                &local_payment_id,
                &remote_payment_id,
                &method,
                amount,
                &currency,
                Some(transaction_ref),
                items,
                &created_at,
                &updated_at,
            );
        }
    }

    let payload = serde_json::json!({
        "orderId": local_order_id,
        "method": method,
        "amount": amount,
        "currency": currency,
        "transactionRef": transaction_ref,
        "paymentOrigin": "sync_reconstructed",
        "items": items.cloned().unwrap_or(Value::Array(Vec::new())),
    });
    let input = payments::build_payment_record_input(&payload)
        .map_err(|e| format!("prepare remote payment mirror: {e}"))?;
    let mut options = payments::PaymentInsertOptions::applied(Some(remote_payment_id));
    options.created_at = Some(created_at);
    options.updated_at = Some(updated_at);
    payments::record_payment_in_connection(conn, &input, &options)
        .map_err(|e| format!("insert remote payment mirror: {e}"))?;

    Ok(1)
}

fn reconcile_applied_payment_queue_rows(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT op.id
             FROM sync_queue sq
             JOIN order_payments op ON op.id = sq.entity_id
             WHERE sq.entity_type IN ('payment', 'order_payments')
               AND sq.status != 'synced'
               AND (
                    COALESCE(op.remote_payment_id, '') != ''
                    OR COALESCE(op.sync_state, '') = 'applied'
               )
             ORDER BY op.id ASC",
        )
        .map_err(|e| e.to_string())?;

    let payment_ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|row| row.ok())
        .collect();
    drop(stmt);

    if payment_ids.is_empty() {
        return Ok(0);
    }

    let now = Utc::now().to_rfc3339();
    let mut reconciled = 0usize;
    for payment_id in payment_ids {
        mark_local_payment_applied(&conn, &payment_id, &now, None)?;
        reconciled += 1;
    }

    if reconciled > 0 {
        info!(
            reconciled,
            "Payment reconciliation: marked locally applied payment queue rows as synced"
        );
    }

    Ok(reconciled)
}

fn maybe_reconstruct_paid_remote_order_payment(
    conn: &Connection,
    remote_order: &Value,
) -> Result<usize, String> {
    let Some(remote_order_id) = remote_order
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
    else {
        return Ok(0);
    };

    let payment_status = normalize_payment_status_for_sync(
        remote_order.get("payment_status").and_then(Value::as_str),
    );
    if payment_status != "paid" {
        return Ok(0);
    }

    let order_status = normalize_order_status_for_sync(
        remote_order
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending"),
    );
    if matches!(order_status.as_str(), "cancelled" | "canceled" | "refunded") {
        return Ok(0);
    }

    let raw_method = str_any(remote_order, &["payment_method", "paymentMethod"])
        .unwrap_or_default()
        .to_ascii_lowercase();
    if raw_method != "cash" && raw_method != "card" {
        return Ok(0);
    }

    let local_order_id: Option<String> = conn
        .query_row(
            "SELECT id FROM orders WHERE supabase_id = ?1 OR id = ?1 LIMIT 1",
            params![remote_order_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("resolve local order for reconstruction: {e}"))?;
    let Some(local_order_id) = local_order_id else {
        return Ok(0);
    };

    let (order_total, local_status, is_ghost): (f64, String, i64) = conn
        .query_row(
            "SELECT COALESCE(total_amount, 0), COALESCE(status, 'pending'), COALESCE(is_ghost, 0)
             FROM orders
             WHERE id = ?1",
            params![local_order_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| format!("load local reconstruction context: {e}"))?;

    if is_ghost != 0
        || order_total <= 0.0
        || matches!(local_status.as_str(), "cancelled" | "canceled" | "refunded")
    {
        return Ok(0);
    }

    let completed_payments: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM order_payments
             WHERE order_id = ?1
               AND status = 'completed'",
            params![local_order_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if completed_payments > 0 {
        return Ok(0);
    }

    let effective_business_timestamp =
        crate::business_day::resolve_order_financial_effective_at(conn, &local_order_id)
            .unwrap_or_else(|_| {
                str_any(
                    remote_order,
                    &["updated_at", "updatedAt", "created_at", "createdAt"],
                )
                .unwrap_or_else(|| Utc::now().to_rfc3339())
            });
    let payload = serde_json::json!({
        "orderId": local_order_id,
        "method": raw_method,
        "amount": order_total,
        "currency": "EUR",
        "transactionRef": str_any(
            remote_order,
            &["payment_transaction_id", "paymentTransactionId"],
        ),
        "paymentOrigin": "sync_reconstructed",
    });
    let input = payments::build_payment_record_input(&payload)
        .map_err(|e| format!("prepare sync reconstruction: {e}"))?;
    let mut options = payments::PaymentInsertOptions::applied(None);
    options.created_at = Some(effective_business_timestamp.clone());
    options.updated_at = Some(effective_business_timestamp);
    payments::record_payment_in_connection(conn, &input, &options)
        .map_err(|e| format!("record sync reconstruction: {e}"))?;

    Ok(1)
}

fn remote_order_changed_at(remote_order: &Value) -> String {
    remote_order
        .get("updated_at")
        .or_else(|| remote_order.get("updatedAt"))
        .or_else(|| remote_order.get("created_at"))
        .or_else(|| remote_order.get("createdAt"))
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .unwrap_or_default()
}

fn has_outstanding_local_order_queue(conn: &Connection, local_id: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM sync_queue
         WHERE entity_type = 'order'
           AND entity_id = ?1
           AND status IN ('pending', 'in_progress', 'queued_remote')",
        params![local_id],
        |row| row.get(0),
    )
    .unwrap_or(false)
}

fn should_preserve_local_cancelled(previous_status: Option<&str>, incoming_status: &str) -> bool {
    matches!(previous_status, Some("cancelled" | "canceled"))
        && !matches!(incoming_status, "cancelled" | "canceled")
}

async fn reconcile_remote_orders(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
    app: &AppHandle,
) -> Result<RemoteOrderReconcileOutcome, String> {
    let mut since_cursor =
        sanitize_orders_since_cursor(local_setting_get(db, "sync", "orders_since"));
    let _ = local_setting_set(db, "sync", "orders_since", &since_cursor);
    let bootstrap_mode = ensure_sync_bootstrap_mode(db)?;
    let bootstrap_active = bootstrap_mode != SYNC_BOOTSTRAP_MODE_LIVE;
    let mut reconciled = 0usize;
    let mut history_complete = false;

    for _page in 0..4 {
        let mut path = "/api/pos/orders/sync?limit=200&include_deleted=true&since=".to_string();
        path.push_str(&percent_encode(&since_cursor));

        let resp = match api::fetch_from_admin(admin_url, api_key, &path, "GET", None).await {
            Ok(v) => v,
            Err(e) => {
                if is_backpressure_error(&e) {
                    warn!(error = %e, "Remote order reconciliation deferred due to backpressure");
                    return Ok(RemoteOrderReconcileOutcome {
                        reconciled,
                        history_complete: false,
                        bootstrap_mode,
                    });
                }
                return Err(format!("reconcile remote orders: {e}"));
            }
        };

        let orders = resp
            .get("orders")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let has_more = resp
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let sync_timestamp = resp
            .get("sync_timestamp")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .unwrap_or_else(|| Utc::now().to_rfc3339());

        // Process deleted orders from admin dashboard
        let deleted_ids = resp
            .get("deleted_ids")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !deleted_ids.is_empty() {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            for deleted_id in &deleted_ids {
                let Some(remote_id) = deleted_id.as_str().filter(|s| !s.trim().is_empty()) else {
                    continue;
                };
                let local_id: Option<String> = conn
                    .query_row(
                        "SELECT id FROM orders WHERE supabase_id = ?1 OR id = ?1 LIMIT 1",
                        params![remote_id],
                        |row| row.get(0),
                    )
                    .ok();
                if let Some(local_id) = local_id {
                    // Clean up sync_queue entries (no FK cascade to orders)
                    let _ = conn.execute(
                        "DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id = ?1",
                        params![local_id],
                    );
                    let _ = conn.execute(
                        "DELETE FROM sync_queue WHERE entity_type = 'payment' AND entity_id IN (SELECT id FROM order_payments WHERE order_id = ?1)",
                        params![local_id],
                    );
                    let _ = conn.execute(
                        "DELETE FROM sync_queue WHERE entity_type = 'payment_adjustment' AND entity_id IN (SELECT id FROM payment_adjustments WHERE order_id = ?1)",
                        params![local_id],
                    );
                    // Delete the order — FK CASCADE cleans order_payments, payment_adjustments, driver_earnings
                    let deleted = conn
                        .execute("DELETE FROM orders WHERE id = ?1", params![local_id])
                        .unwrap_or(0);
                    if deleted > 0 {
                        reconciled += 1;
                        let _ =
                            app.emit("order_deleted", serde_json::json!({ "orderId": local_id }));
                        info!(
                            remote_id = %remote_id,
                            local_id = %local_id,
                            "Deleted local order (removed from admin dashboard)"
                        );
                    }
                }
            }
        }

        let mut newest_updated_at: Option<String> = None;
        let mut newly_materialized_order_ids: Vec<String> = Vec::new();
        let mut reconciled_order_events: Vec<(String, Option<String>)> = Vec::new();

        {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;

            // Orders created at or before the last Z-report were already counted
            // and cleared by the local day-rollover cleanup — do not re-materialize them.
            let eod_cutoff: Option<String> =
                crate::db::get_setting(&conn, "system", "last_z_report_timestamp");

            for remote_order in orders {
                let remote_id = match remote_order.get("id").and_then(Value::as_str) {
                    Some(v) if !v.trim().is_empty() => v.to_string(),
                    _ => continue,
                };
                let local_id = match resolve_local_order_id(&conn, &remote_order) {
                    Some(v) => v,
                    None => {
                        // Skip materialization of orders that predate the last Z-report
                        if let Some(ref cutoff) = eod_cutoff {
                            let order_created = remote_order
                                .get("created_at")
                                .or_else(|| remote_order.get("createdAt"))
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if !order_created.is_empty() && order_created <= cutoff.as_str() {
                                debug!(
                                    remote_id = %remote_id,
                                    created_at = %order_created,
                                    cutoff = %cutoff,
                                    "Skipping materialization of pre-Z-report order"
                                );
                                continue;
                            }
                        }
                        match materialize_remote_order(&conn, &remote_order) {
                            Ok(Some(inserted_id)) => {
                                info!(
                                    local_id = %inserted_id,
                                    remote_id = %remote_id,
                                    "Materialized missing remote order into local cache"
                                );
                                newly_materialized_order_ids.push(inserted_id.clone());
                                reconciled += 1;
                                inserted_id
                            }
                            Ok(None) => continue,
                            Err(error) => {
                                warn!(
                                    remote_id = %remote_id,
                                    error = %error,
                                    "Failed to materialize remote order"
                                );
                                continue;
                            }
                        }
                    }
                };

                let updated_at = remote_order_changed_at(&remote_order);
                if newest_updated_at
                    .as_ref()
                    .map(|cur| updated_at > *cur)
                    .unwrap_or(true)
                {
                    newest_updated_at = Some(updated_at.clone());
                }

                let status = remote_order
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending");
                let payment_status = remote_order
                    .get("payment_status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending");
                let payment_method = normalize_payment_method_for_sync(
                    str_any(&remote_order, &["payment_method", "paymentMethod"]).as_deref(),
                );
                let payment_transaction_id = str_any(
                    &remote_order,
                    &["payment_transaction_id", "paymentTransactionId"],
                );
                let cancellation_reason = str_any(
                    &remote_order,
                    &["cancellation_reason", "cancellationReason"],
                );

                // Check if order has genuinely unsynced queue entries rather than
                // relying on orders.sync_status which can be reset by concurrent edits.
                let has_pending_queue = has_outstanding_local_order_queue(&conn, &local_id);

                if has_pending_queue {
                    // Still set supabase_id (needed for resolution)
                    let _ = conn.execute(
                        "UPDATE orders SET supabase_id = ?1 WHERE id = ?2 AND supabase_id IS NULL",
                        params![remote_id, local_id],
                    );
                    log_reconcile_skip_throttled(&local_id);
                } else {
                    // Only apply remote changes if they're at least as new as local
                    let previous_status: Option<String> = conn
                        .query_row(
                            "SELECT status FROM orders WHERE id = ?1",
                            params![local_id],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten();

                    let local_updated_at: Option<String> = conn
                        .query_row(
                            "SELECT updated_at FROM orders WHERE id = ?1",
                            params![local_id],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten();

                    let should_update = if updated_at.is_empty() {
                        local_updated_at.is_none()
                    } else {
                        local_updated_at
                            .as_ref()
                            .map(|local| updated_at >= *local)
                            .unwrap_or(true)
                    };

                    if should_update {
                        if should_preserve_local_cancelled(previous_status.as_deref(), status) {
                            let _ = conn.execute(
                                "UPDATE orders
                                 SET supabase_id = COALESCE(?1, supabase_id),
                                     sync_status = CASE
                                         WHEN COALESCE(sync_status, '') = 'pending' THEN sync_status
                                         ELSE 'synced'
                                     END,
                                     last_synced_at = datetime('now')
                                 WHERE id = ?2",
                                params![remote_id, local_id],
                            );
                            continue;
                        }

                        let updated = conn
                            .execute(
                                "UPDATE orders
                                 SET supabase_id = ?1,
                                     status = ?2,
                                     payment_status = ?3,
                                     payment_method = COALESCE(?4, payment_method),
                                     payment_transaction_id = COALESCE(?5, payment_transaction_id),
                                     sync_status = 'synced',
                                     last_synced_at = datetime('now'),
                                     updated_at = ?6,
                                     cancellation_reason = COALESCE(?8, cancellation_reason)
                                 WHERE id = ?7
                                   AND (
                                     COALESCE(supabase_id, '') != COALESCE(?1, '')
                                     OR COALESCE(status, '') != COALESCE(?2, '')
                                     OR COALESCE(payment_status, '') != COALESCE(?3, '')
                                     OR COALESCE(payment_method, '') != COALESCE(?4, '')
                                     OR COALESCE(payment_transaction_id, '') != COALESCE(?5, '')
                                     OR COALESCE(sync_status, '') != 'synced'
                                     OR COALESCE(updated_at, '') != COALESCE(?6, '')
                                     OR COALESCE(cancellation_reason, '') != COALESCE(?8, '')
                                   )",
                                params![
                                    remote_id,
                                    status,
                                    payment_status,
                                    payment_method,
                                    payment_transaction_id,
                                    updated_at,
                                    local_id,
                                    cancellation_reason.as_deref()
                                ],
                            )
                            .unwrap_or(0);
                        if updated > 0 {
                            reconciled += 1;
                            let status_changed = previous_status
                                .as_deref()
                                .map(|prev| prev != status)
                                .unwrap_or(true);
                            reconciled_order_events.push((
                                local_id.clone(),
                                if status_changed {
                                    Some(status.to_string())
                                } else {
                                    None
                                },
                            ));
                        }
                    } else {
                        // Remote is stale, just ensure supabase_id is set
                        let _ = conn.execute(
                            "UPDATE orders SET supabase_id = ?1 WHERE id = ?2 AND supabase_id IS NULL",
                            params![remote_id, local_id],
                        );
                    }
                }

                if !has_pending_queue {
                    if let Err(error) =
                        maybe_reconstruct_paid_remote_order_payment(&conn, &remote_order)
                    {
                        warn!(
                            order_id = %local_id,
                            remote_id = %remote_id,
                            error = %error,
                            "Failed to reconstruct missing local payment row from remote order"
                        );
                    }
                }

                // Always promote payments regardless of reconciliation outcome
                promote_payments_for_order(&conn, &local_id);
            }
        }

        for (local_id, status_event) in reconciled_order_events {
            if let Ok(order_json) = get_order_by_id(db, &local_id) {
                let _ = app.emit("order_realtime_update", order_json);
            } else {
                let _ = app.emit(
                    "order_realtime_update",
                    serde_json::json!({ "orderId": local_id.clone() }),
                );
            }

            if let Some(ref new_status) = status_event {
                let _ = app.emit(
                    "order_status_updated",
                    serde_json::json!({
                        "orderId": local_id.clone(),
                        "status": new_status
                    }),
                );

                // on_complete trigger — enqueue completed/delivered receipt
                if !bootstrap_active
                    && matches!(new_status.as_str(), "completed" | "delivered")
                    && crate::print::is_print_action_enabled(db, "on_complete")
                {
                    if let Err(e) =
                        print::enqueue_print_job(db, "order_completed_receipt", &local_id, None)
                    {
                        warn!(
                            order_id = %local_id,
                            error = %e,
                            "Failed to enqueue order_completed_receipt"
                        );
                    }
                }

                // on_cancel trigger — re-read reason after UPDATE to get server-provided value
                if !bootstrap_active
                    && matches!(new_status.as_str(), "cancelled" | "canceled")
                    && crate::print::is_print_action_enabled(db, "on_cancel")
                {
                    let reason: Option<String> = {
                        let conn = db.conn.lock().unwrap();
                        conn.query_row(
                            "SELECT cancellation_reason FROM orders WHERE id = ?1",
                            params![local_id],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten()
                    };
                    let payload = serde_json::json!({ "cancellationReason": reason });
                    if let Err(e) = print::enqueue_print_job_with_payload(
                        db,
                        "order_canceled_receipt",
                        &local_id,
                        None,
                        Some(&payload),
                    ) {
                        warn!(
                            order_id = %local_id,
                            error = %e,
                            "Failed to enqueue order_canceled_receipt"
                        );
                    }
                }
            }
        }

        for local_id in newly_materialized_order_ids {
            let mut auto_print_types = print::auto_print_entity_types_for_order_type("pickup");
            let mut skip_auto_print = false;
            if let Ok(order_json) = get_order_by_id(db, &local_id) {
                if let Some(order_type) = order_json.get("orderType").and_then(|v| v.as_str()) {
                    auto_print_types = print::auto_print_entity_types_for_order_type(order_type);
                }
                // Skip auto-print for ghost and split/pending payment orders (receipt
                // will be printed after split payments are individually recorded).
                let is_ghost = order_json
                    .get("isGhost")
                    .and_then(|v| v.as_bool())
                    .or_else(|| order_json.get("is_ghost").and_then(|v| v.as_bool()))
                    .unwrap_or(false);
                let payment_method = order_json
                    .get("paymentMethod")
                    .or_else(|| order_json.get("payment_method"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if is_ghost || payment_method == "pending" {
                    skip_auto_print = true;
                }
                let _ = app.emit("order_created", order_json.clone());
                let _ = app.emit("order_realtime_update", order_json);
            } else {
                let _ = app.emit(
                    "order_created",
                    serde_json::json!({ "orderId": local_id.clone() }),
                );
            }

            if !bootstrap_active
                && !skip_auto_print
                && crate::print::is_print_action_enabled(db, "after_order")
            {
                for entity_type in auto_print_types {
                    if let Err(error) = print::enqueue_print_job(db, entity_type, &local_id, None) {
                        warn!(
                            order_id = %local_id,
                            entity_type = %entity_type,
                            error = %error,
                            "Failed to enqueue print job for newly materialized remote order"
                        );
                    }
                }
            }
        }

        let next_cursor = sanitize_orders_since_cursor(newest_updated_at.or(Some(sync_timestamp)));
        // Only advance cursor forward — never regress.  This protects against
        // a Z-report updating the cursor to "now" while we hold a stale
        // response whose newest_updated_at predates the cleanup.
        {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            let current_stored =
                sanitize_orders_since_cursor(crate::db::get_setting(&conn, "sync", "orders_since"));
            if next_cursor > current_stored {
                since_cursor = next_cursor.clone();
                crate::db::set_setting(&conn, "sync", "orders_since", &next_cursor)?;
            } else if since_cursor != current_stored {
                // Another path (e.g. Z-report) advanced the cursor past us — adopt it
                since_cursor = current_stored;
            }
        }

        if !has_more {
            history_complete = true;
            break;
        }
    }

    Ok(RemoteOrderReconcileOutcome {
        reconciled,
        history_complete,
        bootstrap_mode,
    })
}

async fn reconcile_remote_payments(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
) -> Result<usize, String> {
    let mut since_cursor =
        sanitize_payments_since_cursor(local_setting_get(db, "sync", "payments_since"));
    let _ = local_setting_set(db, "sync", "payments_since", &since_cursor);
    let mut reconciled = 0usize;

    for _page in 0..4 {
        let mut path = "/api/pos/payments?limit=200&since=".to_string();
        path.push_str(&percent_encode(&since_cursor));

        let resp = match api::fetch_from_admin(admin_url, api_key, &path, "GET", None).await {
            Ok(v) => v,
            Err(e) => {
                if is_backpressure_error(&e) {
                    warn!(error = %e, "Remote payment reconciliation deferred due to backpressure");
                    return Ok(reconciled);
                }
                return Err(format!("reconcile remote payments: {e}"));
            }
        };

        let typed: Option<PaymentIncrementalSyncResponse> =
            serde_json::from_value(resp.clone()).ok();
        let payments = typed
            .as_ref()
            .map(|value| value.payments.clone())
            .unwrap_or_else(|| {
                resp.get("payments")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
            });
        let has_more = typed
            .as_ref()
            .and_then(|value| value.has_more)
            .or_else(|| resp.get("has_more").and_then(Value::as_bool))
            .unwrap_or(false);
        let sync_timestamp = typed
            .as_ref()
            .and_then(|value| value.sync_timestamp.clone())
            .or_else(|| {
                resp.get("sync_timestamp")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string())
            })
            .unwrap_or_else(|| Utc::now().to_rfc3339());

        let mut newest_updated_at: Option<String> = None;
        {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            for remote_payment in payments {
                let updated_at = remote_payment_changed_at(&remote_payment);
                if newest_updated_at
                    .as_ref()
                    .map(|current| updated_at > *current)
                    .unwrap_or(true)
                {
                    newest_updated_at = Some(updated_at);
                }

                match sync_remote_payment_into_local(&conn, &remote_payment) {
                    Ok(changed) => {
                        reconciled += changed;
                    }
                    Err(error) => {
                        let remote_payment_id =
                            str_any(&remote_payment, &["id", "payment_id", "paymentId"])
                                .unwrap_or_else(|| "<unknown>".to_string());
                        warn!(
                            remote_payment_id = %remote_payment_id,
                            error = %error,
                            "Failed to mirror canonical remote payment into local cache"
                        );
                    }
                }
            }
        }

        let next_cursor =
            sanitize_payments_since_cursor(newest_updated_at.or(Some(sync_timestamp)));
        {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            let current_stored = sanitize_payments_since_cursor(crate::db::get_setting(
                &conn,
                "sync",
                "payments_since",
            ));
            if next_cursor > current_stored {
                since_cursor = next_cursor.clone();
                crate::db::set_setting(&conn, "sync", "payments_since", &next_cursor)?;
            } else if since_cursor != current_stored {
                since_cursor = current_stored;
            }
        }

        if !has_more {
            break;
        }
    }

    Ok(reconciled)
}

fn is_payment_total_conflict_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("payment exceeds order total")
        || (lower.contains("http 422") && lower.contains("existing completed"))
}

#[derive(Clone, Debug)]
struct LocalOrderRemoteLookup {
    local_order_id: String,
    supabase_id: Option<String>,
    order_number: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

fn load_local_order_remote_lookup(
    conn: &Connection,
    local_order_id: &str,
) -> Result<Option<LocalOrderRemoteLookup>, String> {
    conn.query_row(
        "SELECT
             id,
             NULLIF(TRIM(COALESCE(supabase_id, '')), ''),
             NULLIF(TRIM(COALESCE(order_number, '')), ''),
             NULLIF(TRIM(COALESCE(created_at, '')), ''),
             NULLIF(TRIM(COALESCE(updated_at, '')), '')
         FROM orders
         WHERE id = ?1
         LIMIT 1",
        params![local_order_id],
        |row| {
            Ok(LocalOrderRemoteLookup {
                local_order_id: row.get(0)?,
                supabase_id: row.get(1)?,
                order_number: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("load local order lookup context for payment recovery: {e}"))
}

fn build_remote_order_repair_since_cursor(lookup: &LocalOrderRemoteLookup) -> String {
    for candidate in [&lookup.updated_at, &lookup.created_at] {
        let Some(raw_value) = candidate
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };

        if let Ok(parsed) = DateTime::parse_from_rfc3339(raw_value) {
            return parsed
                .with_timezone(&Utc)
                .checked_sub_signed(ChronoDuration::days(1))
                .unwrap_or_else(|| DateTime::<Utc>::from(UNIX_EPOCH))
                .to_rfc3339_opts(SecondsFormat::Secs, true);
        }
    }

    "1970-01-01T00:00:00Z".to_string()
}

fn select_remote_order_match<'a>(
    lookup: &LocalOrderRemoteLookup,
    remote_orders: &'a [Value],
) -> Option<&'a Value> {
    remote_orders.iter().find(|remote_order| {
        let remote_id_matches = lookup
            .supabase_id
            .as_ref()
            .map(|remote_id| {
                str_any(remote_order, &["id"])
                    .map(|candidate| candidate == *remote_id)
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if remote_id_matches {
            return true;
        }

        let client_order_id_matches = str_any(remote_order, &["client_order_id", "clientOrderId"])
            .map(|candidate| candidate == lookup.local_order_id)
            .unwrap_or(false);
        if client_order_id_matches {
            return true;
        }

        lookup
            .order_number
            .as_ref()
            .map(|order_number| {
                str_any(remote_order, &["order_number", "orderNumber"])
                    .map(|candidate| candidate.eq_ignore_ascii_case(order_number))
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    })
}

fn attach_remote_order_identity_to_local_order(
    conn: &Connection,
    local_order_id: &str,
    remote_order: &Value,
    now: &str,
) -> Result<Option<String>, String> {
    let Some(remote_order_id) = str_any(remote_order, &["id"]) else {
        return Ok(None);
    };

    conn.execute(
        "UPDATE orders
         SET supabase_id = ?1,
             updated_at = ?2
         WHERE id = ?3
           AND COALESCE(NULLIF(TRIM(COALESCE(supabase_id, '')), ''), '') != ?1",
        params![remote_order_id, now, local_order_id],
    )
    .map_err(|e| format!("attach remote order identity for payment recovery: {e}"))?;

    Ok(Some(remote_order_id))
}

fn sync_remote_order_snapshot_into_local(
    conn: &Connection,
    local_order_id: &str,
    remote_order: &Value,
    repaired_at: &str,
) -> Result<usize, String> {
    let remote_order_id = str_any(remote_order, &["id"]);
    let order_number = str_any(remote_order, &["order_number", "orderNumber"]);
    let items_json = remote_order.get("items").map(|items| match items {
        Value::String(raw) => raw.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "[]".to_string()),
    });
    let total_amount = num_any(remote_order, &["total_amount", "totalAmount"]);
    let tax_amount = num_any(remote_order, &["tax_amount", "taxAmount"]);
    let subtotal = num_any(remote_order, &["subtotal"]);
    let status = remote_order
        .get("status")
        .and_then(Value::as_str)
        .map(normalize_order_status_for_sync);
    let order_type = str_any(remote_order, &["order_type", "orderType"]);
    let table_number = str_any(remote_order, &["table_number", "tableNumber"]);
    let delivery_address = str_any(remote_order, &["delivery_address", "deliveryAddress"]);
    let delivery_city = str_any(remote_order, &["delivery_city", "deliveryCity"]);
    let delivery_postal_code = str_any(
        remote_order,
        &["delivery_postal_code", "deliveryPostalCode"],
    );
    let delivery_floor = str_any(remote_order, &["delivery_floor", "deliveryFloor"]);
    let delivery_notes = str_any(remote_order, &["delivery_notes", "deliveryNotes"]);
    let name_on_ringer = str_any(remote_order, &["name_on_ringer", "nameOnRinger"]);
    let special_instructions = str_any(
        remote_order,
        &["special_instructions", "specialInstructions", "notes"],
    );
    let updated_at = str_any(remote_order, &["updated_at", "updatedAt"])
        .unwrap_or_else(|| repaired_at.to_string());
    let estimated_time = i64_any(remote_order, &["estimated_time", "estimatedTime"]);
    let payment_status = remote_order
        .get("payment_status")
        .and_then(Value::as_str)
        .map(|value| normalize_payment_status_for_sync(Some(value)));
    let payment_method = normalize_payment_method_for_sync(
        str_any(remote_order, &["payment_method", "paymentMethod"]).as_deref(),
    );
    let payment_tx = str_any(
        remote_order,
        &["payment_transaction_id", "paymentTransactionId"],
    );
    let staff_shift_id = str_any(remote_order, &["staff_shift_id", "staffShiftId"]);
    let staff_id = str_any(remote_order, &["staff_id", "staffId"]);
    let driver_id = str_any(remote_order, &["driver_id", "driverId"]);
    let driver_name = str_any(remote_order, &["driver_name", "driverName"]);
    let discount_percentage = num_any(remote_order, &["discount_percentage", "discountPercentage"]);
    let discount_amount = num_any(remote_order, &["discount_amount", "discountAmount"]);
    let tip_amount = num_any(remote_order, &["tip_amount", "tipAmount"]);
    let version = remote_order
        .get("version")
        .and_then(Value::as_i64)
        .map(|value| value.max(1));
    let terminal_id = str_any(remote_order, &["terminal_id", "terminalId"]);
    let branch_id = str_any(remote_order, &["branch_id", "branchId"]);
    let plugin = str_any(remote_order, &["plugin", "platform"]);
    let external_plugin_order_id = str_any(
        remote_order,
        &["external_plugin_order_id", "externalPluginOrderId"],
    );
    let tax_rate = num_any(remote_order, &["tax_rate", "taxRate"]);
    let delivery_fee = num_any(remote_order, &["delivery_fee", "deliveryFee"]);
    let is_ghost = bool_any(remote_order, &["is_ghost", "isGhost"]).map(i64::from);
    let ghost_source = str_any(remote_order, &["ghost_source", "ghostSource"]);
    let ghost_metadata = remote_order
        .get("ghost_metadata")
        .or_else(|| remote_order.get("ghostMetadata"))
        .and_then(|value| {
            if value.is_null() {
                return None;
            }
            if let Some(raw) = value.as_str() {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return None;
                }
                return Some(trimmed.to_string());
            }
            Some(value.to_string())
        });

    conn.execute(
        "UPDATE orders
         SET supabase_id = COALESCE(?1, supabase_id),
             order_number = COALESCE(?2, order_number),
             items = COALESCE(?3, items),
             total_amount = COALESCE(?4, total_amount),
             tax_amount = COALESCE(?5, tax_amount),
             subtotal = COALESCE(?6, subtotal),
             status = COALESCE(?7, status),
             order_type = COALESCE(?8, order_type),
             table_number = COALESCE(?9, table_number),
             delivery_address = COALESCE(?10, delivery_address),
             delivery_city = COALESCE(?11, delivery_city),
             delivery_postal_code = COALESCE(?12, delivery_postal_code),
             delivery_floor = COALESCE(?13, delivery_floor),
             delivery_notes = COALESCE(?14, delivery_notes),
             name_on_ringer = COALESCE(?15, name_on_ringer),
             special_instructions = COALESCE(?16, special_instructions),
             estimated_time = COALESCE(?17, estimated_time),
             payment_status = COALESCE(?18, payment_status),
             payment_method = COALESCE(?19, payment_method),
             payment_transaction_id = COALESCE(?20, payment_transaction_id),
             staff_shift_id = COALESCE(?21, staff_shift_id),
             staff_id = COALESCE(?22, staff_id),
             driver_id = COALESCE(?23, driver_id),
             driver_name = COALESCE(?24, driver_name),
             discount_percentage = COALESCE(?25, discount_percentage),
             discount_amount = COALESCE(?26, discount_amount),
             tip_amount = COALESCE(?27, tip_amount),
             version = COALESCE(?28, version),
             terminal_id = COALESCE(?29, terminal_id),
             branch_id = COALESCE(?30, branch_id),
             plugin = COALESCE(?31, plugin),
             external_plugin_order_id = COALESCE(?32, external_plugin_order_id),
             tax_rate = COALESCE(?33, tax_rate),
             delivery_fee = COALESCE(?34, delivery_fee),
             is_ghost = COALESCE(?35, is_ghost),
             ghost_source = COALESCE(?36, ghost_source),
             ghost_metadata = COALESCE(?37, ghost_metadata),
             sync_status = 'synced',
             last_synced_at = datetime('now'),
             updated_at = COALESCE(?38, updated_at, ?39)
         WHERE id = ?40",
        params![
            remote_order_id,
            order_number,
            items_json,
            total_amount,
            tax_amount,
            subtotal,
            status,
            order_type,
            table_number,
            delivery_address,
            delivery_city,
            delivery_postal_code,
            delivery_floor,
            delivery_notes,
            name_on_ringer,
            special_instructions,
            estimated_time,
            payment_status,
            payment_method,
            payment_tx,
            staff_shift_id,
            staff_id,
            driver_id,
            driver_name,
            discount_percentage,
            discount_amount,
            tip_amount,
            version,
            terminal_id,
            branch_id,
            plugin,
            external_plugin_order_id,
            tax_rate,
            delivery_fee,
            is_ghost,
            ghost_source,
            ghost_metadata,
            Some(updated_at.clone()),
            repaired_at,
            local_order_id,
        ],
    )
    .map_err(|e| format!("sync remote order snapshot into local cache: {e}"))
}

fn extract_remote_orders_from_response(response: &Value) -> Vec<Value> {
    response
        .get("orders")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

async fn resolve_remote_order_for_local_order(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
    local_order_id: &str,
) -> Result<Option<(String, Option<Value>)>, String> {
    let lookup = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        load_local_order_remote_lookup(&conn, local_order_id)?
    };

    let Some(lookup) = lookup else {
        return Ok(None);
    };

    let mut search_terms = Vec::new();
    if let Some(remote_order_id) = lookup.supabase_id.as_ref() {
        search_terms.push(remote_order_id.clone());
    }
    if let Some(order_number) = lookup.order_number.as_ref() {
        search_terms.push(order_number.clone());
    }
    search_terms.push(lookup.local_order_id.clone());

    for search_term in search_terms {
        if search_term.trim().is_empty() {
            continue;
        }

        let path = format!(
            "/api/pos/orders?limit=25&search={}",
            percent_encode(search_term.trim())
        );
        let response = api::fetch_from_admin(admin_url, api_key, &path, "GET", None)
            .await
            .map_err(|e| format!("search remote order during payment recovery: {e}"))?;
        let remote_orders = extract_remote_orders_from_response(&response);

        if let Some(remote_order) = select_remote_order_match(&lookup, &remote_orders) {
            let now = Utc::now().to_rfc3339();
            let remote_order_value = remote_order.clone();
            let remote_order_id = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                attach_remote_order_identity_to_local_order(
                    &conn,
                    local_order_id,
                    &remote_order_value,
                    &now,
                )?
            };
            if let Some(remote_order_id) = remote_order_id {
                return Ok(Some((remote_order_id, Some(remote_order_value))));
            }
        }
    }

    let mut sync_since_cursor = build_remote_order_repair_since_cursor(&lookup);
    for _page in 0..3 {
        let path = format!(
            "/api/pos/orders/sync?limit=200&since={}",
            percent_encode(sync_since_cursor.trim())
        );
        let response = api::fetch_from_admin(admin_url, api_key, &path, "GET", None)
            .await
            .map_err(|e| format!("scan remote order sync history during payment recovery: {e}"))?;
        let remote_orders = extract_remote_orders_from_response(&response);

        if let Some(remote_order) = select_remote_order_match(&lookup, &remote_orders) {
            let now = Utc::now().to_rfc3339();
            let remote_order_value = remote_order.clone();
            let remote_order_id = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                attach_remote_order_identity_to_local_order(
                    &conn,
                    local_order_id,
                    &remote_order_value,
                    &now,
                )?
            };
            if let Some(remote_order_id) = remote_order_id {
                return Ok(Some((remote_order_id, Some(remote_order_value))));
            }
        }

        let has_more = response
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !has_more {
            break;
        }

        let Some(next_cursor) = remote_orders
            .iter()
            .map(remote_order_changed_at)
            .filter(|value| !value.trim().is_empty())
            .next_back()
        else {
            break;
        };
        sync_since_cursor = next_cursor;
    }

    if let Some(remote_order_id) = lookup.supabase_id {
        return Ok(Some((remote_order_id, None)));
    }

    Ok(None)
}

async fn reconcile_remote_payments_for_local_order(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
    local_order_id: &str,
) -> Result<usize, String> {
    let Some((remote_order_id, remote_order_context)) =
        resolve_remote_order_for_local_order(db, admin_url, api_key, local_order_id).await?
    else {
        return Ok(0);
    };

    if let Some(remote_order) = remote_order_context.as_ref() {
        let synced_at = Utc::now().to_rfc3339();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        sync_remote_order_snapshot_into_local(&conn, local_order_id, remote_order, &synced_at)?;
    }

    let path = format!(
        "/api/pos/payments?limit=200&order_id={}",
        percent_encode(&remote_order_id)
    );
    let resp = api::fetch_from_admin(admin_url, api_key, &path, "GET", None)
        .await
        .map_err(|e| format!("recover remote payments for order {local_order_id}: {e}"))?;

    let typed: Option<PaymentIncrementalSyncResponse> = serde_json::from_value(resp.clone()).ok();
    let payments = typed
        .as_ref()
        .map(|value| value.payments.clone())
        .unwrap_or_else(|| {
            resp.get("payments")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        });

    if payments.is_empty() {
        if let Some(remote_order) = remote_order_context {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            return maybe_reconstruct_paid_remote_order_payment(&conn, &remote_order);
        }
        return Ok(0);
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut reconciled = 0usize;
    for remote_payment in payments {
        match sync_remote_payment_into_local(&conn, &remote_payment) {
            Ok(changed) => {
                reconciled += changed;
            }
            Err(error) => {
                let remote_payment_id =
                    str_any(&remote_payment, &["id", "payment_id", "paymentId"])
                        .unwrap_or_else(|| "<unknown>".to_string());
                warn!(
                    local_order_id = %local_order_id,
                    remote_payment_id = %remote_payment_id,
                    error = %error,
                    "Failed targeted canonical payment recovery for local order"
                );
            }
        }
    }

    Ok(reconciled)
}

fn collect_waiting_adjustment_order_ids_missing_canonical_remote_payment_id(
    db: &DbState,
) -> Result<Vec<String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(NULLIF(pa.order_id, ''), NULLIF(op.order_id, '')) AS order_id,
                    op.remote_payment_id
             FROM payment_adjustments pa
             JOIN order_payments op ON op.id = pa.payment_id
             WHERE pa.sync_state = 'waiting_parent'
               AND op.sync_state = 'applied'",
        )
        .map_err(|e| format!("prepare waiting adjustment repair candidates: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        })
        .map_err(|e| format!("query waiting adjustment repair candidates: {e}"))?;

    let mut order_ids = Vec::new();
    let mut seen = HashSet::new();

    for row in rows {
        let (order_id, remote_payment_id) =
            row.map_err(|e| format!("read waiting adjustment repair candidate: {e}"))?;
        if normalize_optional_uuid_str(remote_payment_id.as_deref()).is_some() {
            continue;
        }

        let Some(order_id) = order_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };

        if seen.insert(order_id.clone()) {
            order_ids.push(order_id);
        }
    }

    Ok(order_ids)
}

async fn auto_heal_waiting_adjustments_missing_canonical_remote_payment_ids_with<
    RepairFn,
    RepairFuture,
>(
    db: &DbState,
    mut repair_orders: RepairFn,
) -> Result<DeferredAdjustmentAutoHealSummary, String>
where
    RepairFn: FnMut(Vec<String>) -> RepairFuture,
    RepairFuture: Future<Output = Result<usize, String>>,
{
    let order_ids = collect_waiting_adjustment_order_ids_missing_canonical_remote_payment_id(db)?;
    let candidate_orders = order_ids.len();
    let repaired_payment_mirrors = if candidate_orders == 0 {
        0
    } else {
        repair_orders(order_ids).await?
    };
    let rebound_adjustments = rebind_waiting_adjustments_to_canonical_duplicate_payments(db)?;
    let promoted_adjustments = reconcile_deferred_adjustments(db)?;

    let summary = DeferredAdjustmentAutoHealSummary {
        candidate_orders,
        repaired_payment_mirrors,
        rebound_adjustments,
        promoted_adjustments,
    };

    if summary.candidate_orders > 0
        || summary.repaired_payment_mirrors > 0
        || summary.rebound_adjustments > 0
        || summary.promoted_adjustments > 0
    {
        info!(
            candidate_orders = summary.candidate_orders,
            repaired_payment_mirrors = summary.repaired_payment_mirrors,
            rebound_adjustments = summary.rebound_adjustments,
            promoted_adjustments = summary.promoted_adjustments,
            "Auto-healed waiting adjustments before adjustment sync dispatch"
        );
    }

    Ok(summary)
}

async fn auto_heal_waiting_adjustments_missing_canonical_remote_payment_ids(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
) -> Result<DeferredAdjustmentAutoHealSummary, String> {
    auto_heal_waiting_adjustments_missing_canonical_remote_payment_ids_with(
        db,
        |order_ids| async move {
            repair_local_payment_mirrors_for_orders_with_auth(db, &order_ids, admin_url, api_key)
                .await
        },
    )
    .await
}

async fn repair_local_payment_mirrors_for_orders_with_auth(
    db: &DbState,
    order_ids: &[String],
    admin_url: &str,
    api_key: &str,
) -> Result<usize, String> {
    if order_ids.is_empty() {
        return Ok(0);
    }

    let now = Utc::now().to_rfc3339();
    let mut repaired = 0usize;
    let mut seen = HashSet::new();

    for order_id in order_ids {
        let normalized = order_id.trim();
        if normalized.is_empty() || !seen.insert(normalized.to_string()) {
            continue;
        }

        repaired +=
            reconcile_remote_payments_for_local_order(db, admin_url, api_key, normalized).await?;

        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        recompute_local_order_payment_snapshot(&conn, normalized, &now)?;
    }

    Ok(repaired)
}

pub(crate) async fn repair_local_payment_mirrors_for_orders(
    db: &DbState,
    order_ids: &[String],
) -> Result<usize, String> {
    let admin_url = storage::get_credential("admin_dashboard_url")
        .ok_or("Missing admin dashboard URL for blocking payment repair")?;
    let api_key = load_zeroized_pos_api_key_optional()
        .ok_or("Missing POS API key for blocking payment repair")?;
    repair_local_payment_mirrors_for_orders_with_auth(db, order_ids, &admin_url, &api_key).await
}

async fn recover_payment_total_conflicts(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
) -> Result<usize, String> {
    let pending_conflicts: Vec<(String, String)> = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT op.id, op.order_id
                 FROM sync_queue sq
                 JOIN order_payments op ON op.id = sq.entity_id
                 WHERE sq.entity_type IN ('payment', 'order_payments')
                   AND sq.status != 'synced'
                   AND LOWER(COALESCE(sq.last_error, '')) LIKE '%payment exceeds order total%'",
            )
            .map_err(|e| format!("prepare payment conflict recovery query: {e}"))?;

        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("query payment conflict recovery rows: {e}"))?
            .filter_map(|row| row.ok())
            .collect();
        drop(stmt);
        rows
    };

    let mut remote_reconciled = 0usize;
    let mut duplicate_resolved = 0usize;
    let mut stale_overpay_resolved = 0usize;

    for (payment_id, local_order_id) in pending_conflicts {
        remote_reconciled +=
            reconcile_remote_payments_for_local_order(db, admin_url, api_key, &local_order_id)
                .await?;

        if let Some(canonical_payment_id) =
            resolve_duplicate_payment_total_conflict(db, &payment_id)?
        {
            duplicate_resolved += 1;
            info!(
                payment_id = %payment_id,
                order_id = %local_order_id,
                canonical_payment_id = %canonical_payment_id,
                "Resolved stale duplicate local payment conflict after canonical payment recovery"
            );
            continue;
        }

        if let Some(resolution) = resolve_stale_local_payment_total_conflict(db, &payment_id)? {
            stale_overpay_resolved += 1;
            info!(
                payment_id = %payment_id,
                order_id = %resolution.order_id,
                amount = resolution.amount,
                outstanding_before = resolution.outstanding_before,
                "Resolved stale unsynced local overpay after payment total conflict"
            );
        }
    }

    if remote_reconciled > 0 || duplicate_resolved > 0 || stale_overpay_resolved > 0 {
        info!(
            remote_reconciled,
            duplicate_resolved,
            stale_overpay_resolved,
            "Recovered stale payment total-conflict rows from canonical remote payments"
        );
    }

    Ok(remote_reconciled + duplicate_resolved + stale_overpay_resolved)
}

/// Execute one sync cycle: read pending queue items and POST to admin.
///
/// Orders and shifts are synced to separate endpoints so a failure in one
/// category does not block the other.
async fn run_sync_cycle(db: &DbState, app: &AppHandle) -> Result<usize, String> {
    let admin_url = match storage::get_credential("admin_dashboard_url") {
        Some(url) => url,
        None => return Ok(0),
    };
    let api_key = match load_zeroized_pos_api_key_optional() {
        Some(k) => k,
        None => return Ok(0),
    };
    let terminal_id = storage::get_credential("terminal_id").unwrap_or_default();
    let branch_id = storage::get_credential("branch_id").unwrap_or_default();

    if let Ok(cleaned) = cleanup_unsupported_order_delete_ops(db) {
        if cleaned > 0 {
            info!(cleaned, "Removed unsupported order delete sync rows");
        }
    }

    if FAILED_ORDER_REQUEUE_DONE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
        .is_ok()
    {
        if let Ok(requeued) = requeue_failed_order_validation_rows(db) {
            if requeued > 0 {
                info!(requeued, "Requeued failed order validation sync rows");
            }
        }
    }

    // Prune permanently-failed sync entries older than 30 days (once per session).
    if SYNC_FAILURE_PRUNE_DONE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
        .is_ok()
    {
        if let Ok(pruned) = prune_old_sync_failures(db) {
            if pruned > 0 {
                info!(pruned, "Pruned old failed sync queue entries");
            }
        }
    }

    // One-time recovery: requeue stale financial rows created by older dependency
    // logic so the current shift/order gating can reevaluate them.
    if FAILED_FINANCIAL_REQUEUE_DONE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
        .is_ok()
    {
        if let Ok(requeued) = requeue_failed_financial_shift_rows(db) {
            if requeued > 0 {
                info!(
                    requeued,
                    "Requeued failed financial sync rows (shift not found)"
                );
            }
        }
        if let Ok(requeued) = requeue_deferred_driver_earning_parent_shift_rows(db) {
            if requeued > 0 {
                info!(
                    requeued,
                    "Requeued deferred driver earnings blocked by legacy parent-shift gating"
                );
            }
        }
    }

    if PAYMENT_ADJUSTMENT_REQUEUE_DONE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
        .is_ok()
    {
        if let Ok(requeued) = requeue_failed_adjustment_missing_endpoint_rows(db) {
            if requeued > 0 {
                info!(
                    requeued,
                    "Requeued failed payment adjustments blocked by the old missing sync endpoint"
                );
            }
        }
        if let Ok(requeued) = requeue_failed_adjustment_legacy_validation_rows(db) {
            if requeued > 0 {
                info!(
                    requeued,
                    "Requeued failed payment adjustments blocked by the old validation payload shape"
                );
            }
        }
    }

    // One-time recovery: re-enqueue shifts that were wrongly marked as synced
    // due to the old sync_shift_batch ignoring per-event server errors.
    if SHIFT_REQUEUE_DONE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
        .is_ok()
    {
        if let Ok(requeued) = requeue_falsely_synced_shifts(db) {
            if requeued > 0 {
                info!(
                    requeued,
                    "Re-enqueued falsely-synced shifts for server verification"
                );
            }
        }
    }

    if Z_REPORT_HISTORY_REPAIR_DONE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
        .is_ok()
    {
        match repair_historical_z_report_rows_after_cutoff(
            db,
            &admin_url,
            api_key.as_str(),
            &terminal_id,
            &branch_id,
        )
        .await
        {
            Ok(repaired) if repaired > 0 => {
                info!(
                    repaired,
                    "Repaired historical local z-report rows after cutoff"
                );
            }
            Ok(_) => {}
            Err(error) => {
                warn!(error = %error, "Historical z-report repair skipped");
            }
        }
    }

    // Poll queued remote receipts first and reconcile remote-assigned IDs
    // before sending new batches.
    let mut total_progress: usize = 0;
    let receipt_updates = poll_order_receipt_statuses(db, &admin_url, &api_key, &branch_id).await?;
    total_progress += receipt_updates;

    let reconciled_orders = reconcile_remote_orders(db, &admin_url, &api_key, app).await?;
    total_progress += reconciled_orders.reconciled;
    if let Err(error) = finalize_sync_bootstrap_mode_after_remote_catchup(db, &reconciled_orders) {
        warn!(error = %error, "Failed to clear sync bootstrap mode after remote catch-up");
    }
    let reconciled_payments = reconcile_remote_payments(db, &admin_url, &api_key).await?;
    total_progress += reconciled_payments;
    let recovered_payment_conflicts =
        recover_payment_total_conflicts(db, &admin_url, &api_key).await?;
    total_progress += recovered_payment_conflicts;
    let reconciled_applied_payments = reconcile_applied_payment_queue_rows(db)?;
    total_progress += reconciled_applied_payments;
    let auto_healed_adjustments =
        auto_heal_waiting_adjustments_missing_canonical_remote_payment_ids(
            db, &admin_url, &api_key,
        )
        .await?;
    total_progress += auto_healed_adjustments.repaired_payment_mirrors;
    total_progress += auto_healed_adjustments.promoted_adjustments;

    cleanup_order_update_queue_rows_for_order(db, None)?;

    // Read pending items (limit 10)
    let pending_items: Vec<SyncItem> = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, entity_type, entity_id, operation, payload, idempotency_key,
                        retry_count, max_retries, next_retry_at,
                        COALESCE(retry_delay_ms, 5000), remote_receipt_id
                 FROM sync_queue
                 WHERE status IN ('pending', 'in_progress')
                   AND retry_count < max_retries
                   AND (
                        next_retry_at IS NULL
                        OR julianday(next_retry_at) <= julianday('now')
                   )
                 ORDER BY COALESCE(next_retry_at, created_at) ASC, created_at ASC
                 LIMIT 25",
            )
            .map_err(|e| e.to_string())?;

        let items: Vec<SyncItem> = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        // Mark as in_progress
        for (id, _, _, _, _, _, _, _, _, _, _) in &items {
            let _ = conn.execute(
                "UPDATE sync_queue SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?1",
                params![id],
            );
        }

        items
    };

    if pending_items.is_empty() {
        return Ok(total_progress);
    }

    // Partition by entity_type
    let mut order_items: Vec<&SyncItem> = Vec::new();
    let mut shift_items: Vec<&SyncItem> = Vec::new();
    let mut financial_items: Vec<&SyncItem> = Vec::new();
    let mut payment_items: Vec<&SyncItem> = Vec::new();
    let mut adjustment_items: Vec<&SyncItem> = Vec::new();
    let mut zreport_items: Vec<&SyncItem> = Vec::new();
    let mut loyalty_items: Vec<&SyncItem> = Vec::new();
    for item in &pending_items {
        match categorize_sync_item(item.1.as_str()) {
            SyncItemCategory::Order => order_items.push(item),
            SyncItemCategory::Shift => shift_items.push(item),
            SyncItemCategory::Financial => financial_items.push(item),
            SyncItemCategory::Payment => payment_items.push(item),
            SyncItemCategory::Adjustment => adjustment_items.push(item),
            SyncItemCategory::ZReport => zreport_items.push(item),
            SyncItemCategory::Loyalty => loyalty_items.push(item),
        }
    }

    let mut had_non_backpressure_failure = false;

    // Sync orders — use direct API (POST /api/pos/orders) as primary path
    // for insert operations. The queue-based endpoint (/api/pos/orders/sync)
    // only enqueues; its background worker is not yet implemented, so orders
    // would sit as 'pending' forever. Direct API does synchronous inserts.
    if !order_items.is_empty() {
        match sync_order_batch_via_direct_api(db, &admin_url, &api_key, &branch_id, &order_items)
            .await
        {
            Ok(direct_outcome) => {
                if !direct_outcome.synced_queue_ids.is_empty() {
                    total_progress += direct_outcome.synced_queue_ids.len();
                    info!(
                        synced = direct_outcome.synced_queue_ids.len(),
                        "Orders synced via direct API"
                    );
                }

                // Record per-item failures from the direct path
                let direct_error_summary = if direct_outcome.permanent_failures.is_empty()
                    && direct_outcome.transient_failures.is_empty()
                {
                    None
                } else {
                    Some("Direct order sync had per-item failures".to_string())
                };
                if let Some(ref err) = direct_error_summary {
                    if mark_order_batch_failures(db, &order_items, err, &direct_outcome)? {
                        had_non_backpressure_failure = true;
                    }
                }

                // Any items not handled by direct API (inserts + updates)
                // stay pending for retry next cycle. Do NOT route to the
                // queue endpoint — its background worker is unreliable and
                // causes "receipt not claimed within 30s" failures.
                let handled = direct_outcome.all_handled_ids();
                let remaining: Vec<&SyncItem> = order_items
                    .iter()
                    .filter(|item| !handled.contains(&item.0))
                    .copied()
                    .collect();

                if !remaining.is_empty() {
                    info!(
                        remaining_count = remaining.len(),
                        "Unhandled order sync items will retry next cycle"
                    );
                }
            }
            Err(e) => {
                // Direct API completely failed — do NOT fall back to the queue
                // endpoint for insert operations. The queue's background worker
                // may not process receipts within the 30s stale timeout, causing
                // orders to be dead-lettered. Instead, let the normal retry
                // mechanism schedule retries on the direct API path.
                warn!(error = %e, "Direct order API failed, scheduling retry (no queue fallback)");
                let empty = DirectOrderFallbackOutcome::default();
                if mark_order_batch_failures(db, &order_items, &e, &empty)? {
                    had_non_backpressure_failure = true;
                }
            }
        }
    }

    // Sync shifts
    if !shift_items.is_empty() {
        match sync_shift_batch(&admin_url, &api_key, &terminal_id, &branch_id, &shift_items).await {
            Ok(shift_outcome) => {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                let now = Utc::now().to_rfc3339();

                // Mark successfully synced shifts
                let synced_set: std::collections::HashSet<&str> = shift_outcome
                    .synced_shift_ids
                    .iter()
                    .map(|s| s.as_str())
                    .collect();
                for item in &shift_items {
                    let (id, _, entity_id, _, _, _, _, _, _, _, _) = item;
                    if synced_set.contains(entity_id.as_str()) {
                        let _ = conn.execute(
                            "UPDATE sync_queue SET status = 'synced', synced_at = ?1, updated_at = ?1 WHERE id = ?2",
                            params![now, id],
                        );
                        let _ = conn.execute(
                            "UPDATE staff_shifts SET sync_status = 'synced', updated_at = ?1 WHERE id = ?2",
                            params![now, entity_id],
                        );
                        // Inline-promote any deferred financial items for this shift
                        promote_financials_for_shift(&conn, entity_id);
                    }
                }
                total_progress += shift_outcome.synced_shift_ids.len();

                // Mark per-event failures
                if !shift_outcome.failed_shift_ids.is_empty() {
                    let failed_set: std::collections::HashMap<&str, &str> = shift_outcome
                        .failed_shift_ids
                        .iter()
                        .map(|(sid, msg)| (sid.as_str(), msg.as_str()))
                        .collect();
                    for item in &shift_items {
                        let (_, _, entity_id, _, _, _, _, _, _, _, _) = item;
                        if let Some(err_msg) = failed_set.get(entity_id.as_str()) {
                            let single = [*item];
                            let failure = mark_batch_failed(db, &single, err_msg)?;
                            if !failure.backpressure_deferred {
                                had_non_backpressure_failure = true;
                            }
                        }
                    }
                }
            }
            Err(e) => {
                warn!("Shift sync failed: {e}");
                let outcome = mark_batch_failed(db, &shift_items, &e)?;
                if !outcome.backpressure_deferred {
                    had_non_backpressure_failure = true;
                }
            }
        }
    }

    if !financial_items.is_empty() {
        match sync_financial_batch(
            &admin_url,
            &api_key,
            &terminal_id,
            &branch_id,
            db,
            &financial_items,
        )
        .await
        {
            Ok(outcome) => {
                total_progress += outcome.synced;
                if outcome.had_non_backpressure_failure {
                    had_non_backpressure_failure = true;
                }
            }
            Err(e) => {
                warn!("Financial sync failed: {e}");
                let outcome = mark_batch_failed(db, &financial_items, &e)?;
                if !outcome.backpressure_deferred {
                    had_non_backpressure_failure = true;
                }
            }
        }
    }

    // Sync payments (individually to /api/pos/payments)
    if !payment_items.is_empty() {
        let synced =
            sync_payment_items(&admin_url, &api_key, &terminal_id, db, &payment_items).await;
        total_progress += synced;
    }

    // Sync payment adjustments (voids/refunds)
    if !adjustment_items.is_empty() {
        let synced = sync_adjustment_items(
            &admin_url,
            &api_key,
            &terminal_id,
            &branch_id,
            db,
            &adjustment_items,
        )
        .await;
        total_progress += synced;
    }

    // Sync z-reports
    if !zreport_items.is_empty() {
        let synced = sync_z_report_items(
            &admin_url,
            &api_key,
            &terminal_id,
            &branch_id,
            db,
            &zreport_items,
        )
        .await;
        total_progress += synced;
    }

    // Sync loyalty transactions (earn/redeem)
    if !loyalty_items.is_empty() {
        let synced = sync_loyalty_items(&admin_url, &api_key, db, &loyalty_items).await;
        total_progress += synced;
    }

    if total_progress == 0 && !pending_items.is_empty() && had_non_backpressure_failure {
        return Err("All sync batches failed".into());
    }

    Ok(total_progress)
}

fn str_any(v: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = v.get(*key).and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn mark_adjustment_waiting_on_parent(
    conn: &Connection,
    queue_id: i64,
    adjustment_id: &str,
    queue_error: &str,
    blocker_reason: &str,
) {
    let _ = conn.execute(
        "UPDATE sync_queue
         SET status = 'deferred',
             last_error = ?2,
             updated_at = datetime('now')
         WHERE id = ?1",
        params![queue_id, queue_error],
    );
    let _ = conn.execute(
        "UPDATE payment_adjustments
         SET sync_state = 'waiting_parent',
             sync_last_error = ?2,
             updated_at = datetime('now')
         WHERE id = ?1",
        params![adjustment_id, blocker_reason],
    );
}

pub(crate) fn normalize_optional_uuid_str(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| {
            if Uuid::parse_str(value).is_ok() {
                Some(value.to_string())
            } else {
                None
            }
        })
}

fn lookup_staff_id_for_shift(conn: &Connection, staff_shift_id: &str) -> Option<String> {
    let normalized_shift_id = normalize_optional_uuid_str(Some(staff_shift_id))?;
    conn.query_row(
        "SELECT staff_id
         FROM staff_shifts
         WHERE id = ?1
         LIMIT 1",
        params![normalized_shift_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
    .and_then(|candidate| normalize_optional_uuid_str(Some(candidate.as_str())))
}

fn normalize_adjustment_staff_ids(
    conn: &Connection,
    payload: &Value,
) -> (Option<String>, Option<String>) {
    let staff_shift_id = normalize_optional_uuid_str(
        str_any(payload, &["staffShiftId", "staff_shift_id"]).as_deref(),
    );
    let staff_id = normalize_optional_uuid_str(
        str_any(payload, &["staffId", "staff_id"]).as_deref(),
    )
    .or_else(|| {
        staff_shift_id
            .as_deref()
            .and_then(|staff_shift_id| lookup_staff_id_for_shift(conn, staff_shift_id))
    });

    (staff_id, staff_shift_id)
}

#[allow(clippy::too_many_arguments)]
fn build_adjustment_sync_body(
    adjustment_id: &str,
    payment_id: &str,
    order_id: Option<&str>,
    adjustment_type: Option<&str>,
    amount: Option<f64>,
    reason: Option<&str>,
    staff_id: Option<&str>,
    staff_shift_id: Option<&str>,
    terminal_id: &str,
    branch_id: &str,
    idempotency_key: &str,
    refund_method: Option<&str>,
    cash_handler: Option<&str>,
    adjustment_context: Option<&str>,
    remote_payment_id: Option<&str>,
    canonical_payment_id: Option<&str>,
) -> Value {
    let mut body = Map::new();
    body.insert(
        "adjustment_id".to_string(),
        Value::String(adjustment_id.to_string()),
    );
    body.insert(
        "payment_id".to_string(),
        Value::String(payment_id.to_string()),
    );
    if let Some(order_id) = order_id {
        body.insert("order_id".to_string(), Value::String(order_id.to_string()));
    }
    if let Some(adjustment_type) = adjustment_type {
        body.insert(
            "adjustment_type".to_string(),
            Value::String(adjustment_type.to_string()),
        );
    }
    if let Some(amount) = amount {
        body.insert("amount".to_string(), Value::from(amount));
    }
    if let Some(reason) = reason {
        body.insert("reason".to_string(), Value::String(reason.to_string()));
    }
    body.insert(
        "terminal_id".to_string(),
        Value::String(terminal_id.to_string()),
    );
    body.insert(
        "branch_id".to_string(),
        Value::String(branch_id.to_string()),
    );
    body.insert(
        "idempotency_key".to_string(),
        Value::String(idempotency_key.to_string()),
    );

    if let Some(staff_id) = staff_id {
        body.insert("staff_id".to_string(), Value::String(staff_id.to_string()));
    }
    if let Some(staff_shift_id) = staff_shift_id {
        body.insert(
            "staff_shift_id".to_string(),
            Value::String(staff_shift_id.to_string()),
        );
    }
    if let Some(refund_method) = refund_method {
        body.insert(
            "refund_method".to_string(),
            Value::String(refund_method.to_string()),
        );
    }
    if let Some(cash_handler) = cash_handler {
        body.insert(
            "cash_handler".to_string(),
            Value::String(cash_handler.to_string()),
        );
    }
    if let Some(adjustment_context) = adjustment_context {
        body.insert(
            "adjustment_context".to_string(),
            Value::String(adjustment_context.to_string()),
        );
    }
    if let Some(remote_payment_id) = remote_payment_id {
        body.insert(
            "remote_payment_id".to_string(),
            Value::String(remote_payment_id.to_string()),
        );
    }
    if let Some(canonical_payment_id) = canonical_payment_id {
        body.insert(
            "canonical_payment_id".to_string(),
            Value::String(canonical_payment_id.to_string()),
        );
    }

    Value::Object(body)
}

fn num_any(v: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(n) = v.get(*key).and_then(Value::as_f64) {
            return Some(n);
        }
    }
    None
}

fn i64_any(v: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(n) = v.get(*key).and_then(Value::as_i64) {
            return Some(n);
        }
    }
    None
}

fn bool_any(v: &Value, keys: &[&str]) -> Option<bool> {
    for key in keys {
        let value = match v.get(*key) {
            Some(value) => value,
            None => continue,
        };

        if let Some(flag) = value.as_bool() {
            return Some(flag);
        }
        if let Some(flag) = value.as_i64() {
            return Some(flag == 1);
        }
        if let Some(flag) = value.as_str() {
            let normalized = flag.trim().to_ascii_lowercase();
            if matches!(normalized.as_str(), "true" | "1" | "yes" | "on") {
                return Some(true);
            }
            if matches!(normalized.as_str(), "false" | "0" | "no" | "off") {
                return Some(false);
            }
        }
    }
    None
}

fn normalize_order_status_for_sync(raw_status: &str) -> String {
    match raw_status.trim().to_lowercase().as_str() {
        "approved" => "confirmed".to_string(),
        "declined" | "rejected" | "canceled" | "cancelled" => "cancelled".to_string(),
        "pending" | "confirmed" | "preparing" | "ready" | "out_for_delivery" | "delivered"
        | "completed" | "refunded" => raw_status.trim().to_lowercase(),
        _ => "pending".to_string(),
    }
}

fn normalize_payment_status_for_sync(raw_status: Option<&str>) -> String {
    match raw_status
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_else(|| "pending".to_string())
        .as_str()
    {
        "completed" | "paid" => "paid".to_string(),
        "partially_paid" => "partially_paid".to_string(),
        "refunded" => "refunded".to_string(),
        "failed" => "failed".to_string(),
        _ => "pending".to_string(),
    }
}

fn normalize_order_type_for_sync(raw_type: Option<&str>) -> String {
    match raw_type
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_else(|| "pickup".to_string())
        .as_str()
    {
        "dine_in" | "dinein" | "dine-in" => "dine-in".to_string(),
        "delivery" => "delivery".to_string(),
        "drive_through" | "drive-through" => "drive-through".to_string(),
        "takeaway" => "takeaway".to_string(),
        "takeout" | "pickup" | "take-away" | "take_away" => "pickup".to_string(),
        _ => "pickup".to_string(),
    }
}

fn normalize_payment_method_for_sync(raw_method: Option<&str>) -> Option<String> {
    let normalized = match raw_method
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "" => return None,
        "cash" => "cash",
        "card" => "card",
        "digital_wallet" | "wallet" | "digital-wallet" => "digital_wallet",
        _ => "other",
    };
    Some(normalized.to_string())
}

/// Build a minimal order preview for error logging.
/// Returns a JSON summary with order ID, item count, total, and menu item IDs.
fn build_order_preview(db: &DbState, order_id: &str) -> Value {
    match get_order_by_id(db, order_id) {
        Ok(order) if !order.is_null() => {
            let items = order.get("items").cloned().unwrap_or(Value::Array(vec![]));
            let item_count = items.as_array().map(|arr| arr.len()).unwrap_or(0);
            let total = order
                .get("totalAmount")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);

            // Extract menu item IDs for debugging
            let menu_item_ids: Vec<String> = items
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|item| str_any(item, &["menu_item_id", "menuItemId"]))
                .collect();

            serde_json::json!({
                "order_id": order_id,
                "item_count": item_count,
                "total_amount": total,
                "menu_item_ids": menu_item_ids,
                "status": order.get("status")
            })
        }
        _ => serde_json::json!({
            "order_id": order_id,
            "error": "Order not found in local database"
        }),
    }
}

/// Validate that all menu item IDs in an order exist in the local menu cache.
/// Returns Ok(()) if all items are valid, or Err with list of invalid IDs.
fn validate_menu_items_against_cache(db: &DbState, items: &Value) -> Result<(), Vec<String>> {
    use crate::menu;

    // Collect valid IDs from all menu item sources: subcategories, ingredients, and combos
    let mut valid_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Add subcategories (main menu items)
    for item in menu::get_subcategories(db) {
        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
            valid_ids.insert(id.to_string());
        }
    }

    // Add ingredients (components/modifiers)
    for item in menu::get_ingredients(db) {
        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
            valid_ids.insert(id.to_string());
        }
    }

    // Add combos (combo meals)
    for item in menu::get_combos(db) {
        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
            valid_ids.insert(id.to_string());
        }
    }

    // If menu cache is completely empty, allow the order through
    // (menu hasn't been synced yet, so we can't validate)
    if valid_ids.is_empty() {
        warn!("Menu cache is empty, skipping validation");
        return Ok(());
    }

    let mut invalid_ids = Vec::new();

    for item in items.as_array().unwrap_or(&vec![]) {
        // Only check the primary menu_item_id fields, not "id" fallback
        let menu_item_id = str_any(item, &["menu_item_id", "menuItemId"]);
        if let Some(id) = menu_item_id {
            if !valid_ids.contains(&id) {
                invalid_ids.push(id);
            }
        }
    }

    if invalid_ids.is_empty() {
        Ok(())
    } else {
        Err(invalid_ids)
    }
}

fn normalize_order_items_for_sync(items: &Value) -> Vec<Value> {
    let mut normalized = Vec::new();
    for item in items.as_array().cloned().unwrap_or_default() {
        // Removed "id" fallback to prevent extracting wrong ID field.
        // Manual-priced items are allowed to sync without a menu_item_id as
        // long as they include their own line name/price.
        let raw_menu_item_id = str_any(&item, &["menu_item_id", "menuItemId"]);
        let menu_item_id = match raw_menu_item_id {
            Some(candidate) if Uuid::parse_str(&candidate).is_ok() => Some(candidate),
            Some(candidate) => {
                warn!(
                    menu_item_id = %candidate,
                    "Normalizing non-UUID menu_item_id to null for order sync"
                );
                None
            }
            None => None,
        };

        let name = str_any(&item, &["menu_item_name", "name"]);
        if menu_item_id.is_none() && name.as_deref().map(str::trim).unwrap_or("").is_empty() {
            warn!("Skipping order item without valid menu_item_id or name");
            continue;
        }

        let quantity = num_any(&item, &["quantity"])
            .unwrap_or(1.0)
            .max(1.0)
            .round() as i64;
        let raw_total = num_any(&item, &["total_price", "totalPrice"]).unwrap_or(0.0);
        let unit_price = num_any(&item, &["unit_price", "unitPrice", "price"])
            .or_else(|| {
                if raw_total > 0.0 && quantity > 0 {
                    Some(raw_total / quantity as f64)
                } else {
                    None
                }
            })
            .unwrap_or(0.0)
            .max(0.0);
        let total_price = if raw_total > 0.0 {
            raw_total.max(0.0)
        } else {
            (unit_price * quantity as f64).max(0.0)
        };
        let customizations = item
            .get("customizations")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or(Value::Null);

        let notes = str_any(&item, &["notes"]);

        normalized.push(serde_json::json!({
            "menu_item_id": menu_item_id,
            "menu_item_name": name,
            "name": name,
            "quantity": quantity,
            "unit_price": unit_price,
            "total_price": total_price,
            "customizations": customizations,
            "notes": notes
        }));
    }
    normalized
}

fn build_normalized_order_operation(
    db: &DbState,
    entity_id: &str,
    operation: &str,
    payload: &Value,
    fallback_branch_id: &str,
) -> Result<Value, String> {
    let op = operation.trim().to_lowercase();
    if op != "insert" && op != "update" {
        return Err(format!("Unsupported order operation: {operation}"));
    }

    let payload_data = payload
        .get("orderData")
        .cloned()
        .unwrap_or_else(|| payload.clone());
    let local_order = get_order_by_id(db, entity_id).unwrap_or_else(|e| {
        warn!(order_id = %entity_id, "get_order_by_id fallback: {e}");
        Value::Null
    });
    let source = if local_order.is_null() {
        &payload_data
    } else {
        &local_order
    };

    let raw_items = source
        .get("items")
        .cloned()
        .or_else(|| payload_data.get("items").cloned())
        .unwrap_or_else(|| Value::Array(vec![]));
    let items = normalize_order_items_for_sync(&raw_items);

    let items_subtotal = items
        .iter()
        .map(|item| {
            item.get("total_price")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        })
        .sum::<f64>();
    let subtotal = num_any(source, &["subtotal"])
        .or_else(|| num_any(&payload_data, &["subtotal"]))
        .unwrap_or(items_subtotal)
        .max(0.0);
    let tax_amount = num_any(source, &["taxAmount", "tax_amount"])
        .or_else(|| num_any(&payload_data, &["taxAmount", "tax_amount"]))
        .unwrap_or(0.0)
        .max(0.0);
    let discount_amount = num_any(source, &["discountAmount", "discount_amount"])
        .or_else(|| num_any(&payload_data, &["discountAmount", "discount_amount"]))
        .unwrap_or(0.0)
        .max(0.0);
    let discount_percentage = num_any(source, &["discountPercentage", "discount_percentage"])
        .or_else(|| {
            num_any(
                &payload_data,
                &["discountPercentage", "discount_percentage"],
            )
        })
        .unwrap_or(0.0)
        .max(0.0);
    let manual_discount_mode = str_any(source, &["manualDiscountMode", "manual_discount_mode"])
        .or_else(|| {
            str_any(
                &payload_data,
                &["manualDiscountMode", "manual_discount_mode"],
            )
        })
        .and_then(|mode| {
            if mode == "percentage" || mode == "fixed" {
                Some(mode)
            } else {
                None
            }
        });
    let manual_discount_value = num_any(source, &["manualDiscountValue", "manual_discount_value"])
        .or_else(|| {
            num_any(
                &payload_data,
                &["manualDiscountValue", "manual_discount_value"],
            )
        })
        .map(|value| value.max(0.0));
    let coupon_id = str_any(source, &["couponId", "coupon_id"])
        .or_else(|| str_any(&payload_data, &["couponId", "coupon_id"]))
        .filter(|id| Uuid::parse_str(id).is_ok());
    let coupon_code = str_any(source, &["couponCode", "coupon_code"])
        .or_else(|| str_any(&payload_data, &["couponCode", "coupon_code"]));
    let coupon_discount_amount =
        num_any(source, &["couponDiscountAmount", "coupon_discount_amount"])
            .or_else(|| {
                num_any(
                    &payload_data,
                    &["couponDiscountAmount", "coupon_discount_amount"],
                )
            })
            .unwrap_or(0.0)
            .max(0.0);
    let delivery_fee = num_any(source, &["deliveryFee", "delivery_fee"])
        .or_else(|| num_any(&payload_data, &["deliveryFee", "delivery_fee"]))
        .unwrap_or(0.0)
        .max(0.0);
    let total_amount = num_any(source, &["totalAmount", "total_amount"])
        .or_else(|| num_any(&payload_data, &["totalAmount", "total_amount"]))
        .unwrap_or((subtotal + tax_amount + delivery_fee - discount_amount).max(0.0))
        .max(0.0);

    let status = normalize_order_status_for_sync(
        &str_any(source, &["status"])
            .or_else(|| str_any(&payload_data, &["status"]))
            .unwrap_or_else(|| "pending".to_string()),
    );
    let payment_status = normalize_payment_status_for_sync(
        str_any(source, &["paymentStatus", "payment_status"])
            .or_else(|| str_any(&payload_data, &["paymentStatus", "payment_status"]))
            .as_deref(),
    );
    let payment_method = normalize_payment_method_for_sync(
        str_any(source, &["paymentMethod", "payment_method"])
            .or_else(|| str_any(&payload_data, &["paymentMethod", "payment_method"]))
            .as_deref(),
    );
    let order_type = normalize_order_type_for_sync(
        str_any(source, &["orderType", "order_type"])
            .or_else(|| str_any(&payload_data, &["orderType", "order_type"]))
            .as_deref(),
    );

    let customer_id = str_any(source, &["customerId", "customer_id"])
        .or_else(|| str_any(&payload_data, &["customerId", "customer_id"]))
        .filter(|id| Uuid::parse_str(id).is_ok());
    let branch_id = str_any(source, &["branchId", "branch_id"])
        .or_else(|| str_any(&payload_data, &["branchId", "branch_id"]))
        .or_else(|| {
            if fallback_branch_id.trim().is_empty() {
                None
            } else {
                Some(fallback_branch_id.to_string())
            }
        })
        .filter(|id| Uuid::parse_str(id).is_ok());
    let table_number = i64_any(source, &["tableNumber", "table_number"])
        .or_else(|| i64_any(&payload_data, &["tableNumber", "table_number"]))
        .or_else(|| {
            str_any(source, &["tableNumber", "table_number"]).and_then(|s| s.parse::<i64>().ok())
        })
        .or_else(|| {
            str_any(&payload_data, &["tableNumber", "table_number"])
                .and_then(|s| s.parse::<i64>().ok())
        });
    let estimated_ready_time = i64_any(source, &["estimatedTime", "estimated_time"])
        .or_else(|| i64_any(&payload_data, &["estimatedTime", "estimated_time"]));
    let driver_id = str_any(source, &["driverId", "driver_id"])
        .or_else(|| str_any(&payload_data, &["driverId", "driver_id"]))
        .filter(|id| Uuid::parse_str(id).is_ok());

    let notes = str_any(
        source,
        &["notes", "specialInstructions", "special_instructions"],
    )
    .or_else(|| {
        str_any(
            &payload_data,
            &["notes", "specialInstructions", "special_instructions"],
        )
    });
    let special_instructions = str_any(
        source,
        &["specialInstructions", "special_instructions", "notes"],
    )
    .or_else(|| {
        str_any(
            &payload_data,
            &["specialInstructions", "special_instructions", "notes"],
        )
    });
    let is_ghost = bool_any(source, &["is_ghost", "isGhost"])
        .or_else(|| bool_any(&payload_data, &["is_ghost", "isGhost"]))
        .unwrap_or(false);
    let ghost_source = str_any(source, &["ghost_source", "ghostSource"])
        .or_else(|| str_any(&payload_data, &["ghost_source", "ghostSource"]));
    let ghost_metadata = source
        .get("ghost_metadata")
        .or_else(|| source.get("ghostMetadata"))
        .or_else(|| payload_data.get("ghost_metadata"))
        .or_else(|| payload_data.get("ghostMetadata"))
        .and_then(|value| {
            if value.is_null() {
                return None;
            }
            if value.is_object() {
                return Some(value.clone());
            }
            if let Some(raw) = value.as_str() {
                return serde_json::from_str::<Value>(raw)
                    .ok()
                    .filter(|parsed| parsed.is_object());
            }
            None
        });

    let data = serde_json::json!({
        "order_number": str_any(source, &["orderNumber", "order_number"]).or_else(|| str_any(&payload_data, &["orderNumber", "order_number"])),
        "customer_id": customer_id,
        "customer_name": str_any(source, &["customerName", "customer_name"]).or_else(|| str_any(&payload_data, &["customerName", "customer_name"])),
        "customer_email": str_any(source, &["customerEmail", "customer_email"]).or_else(|| str_any(&payload_data, &["customerEmail", "customer_email"])),
        "customer_phone": str_any(source, &["customerPhone", "customer_phone"]).or_else(|| str_any(&payload_data, &["customerPhone", "customer_phone"])),
        "branch_id": branch_id,
        "order_type": order_type,
        "status": status,
        "payment_method": payment_method,
        "payment_status": payment_status,
        "total_amount": total_amount,
        "subtotal": subtotal,
        "tax_amount": tax_amount,
        "discount_percentage": discount_percentage,
        "discount_amount": discount_amount,
        "manual_discount_mode": manual_discount_mode,
        "manual_discount_value": manual_discount_value,
        "coupon_id": coupon_id,
        "coupon_code": coupon_code,
        "coupon_discount_amount": coupon_discount_amount,
        "delivery_fee": delivery_fee,
        "notes": notes,
        "special_instructions": special_instructions,
        "delivery_address": str_any(source, &["deliveryAddress", "delivery_address"]).or_else(|| str_any(&payload_data, &["deliveryAddress", "delivery_address"])),
        "delivery_city": str_any(source, &["deliveryCity", "delivery_city"]).or_else(|| str_any(&payload_data, &["deliveryCity", "delivery_city"])),
        "delivery_postal_code": str_any(source, &["deliveryPostalCode", "delivery_postal_code"]).or_else(|| str_any(&payload_data, &["deliveryPostalCode", "delivery_postal_code"])),
        "delivery_floor": str_any(source, &["deliveryFloor", "delivery_floor"]).or_else(|| str_any(&payload_data, &["deliveryFloor", "delivery_floor"])),
        "delivery_notes": str_any(source, &["deliveryNotes", "delivery_notes"]).or_else(|| str_any(&payload_data, &["deliveryNotes", "delivery_notes"])),
        "name_on_ringer": str_any(source, &["nameOnRinger", "name_on_ringer"]).or_else(|| str_any(&payload_data, &["nameOnRinger", "name_on_ringer"])),
        "table_number": table_number,
        "estimated_ready_time": estimated_ready_time,
        "driver_id": driver_id,
        "created_at": str_any(source, &["createdAt", "created_at"]).or_else(|| str_any(&payload_data, &["createdAt", "created_at"])),
        "updated_at": str_any(source, &["updatedAt", "updated_at"]).or_else(|| str_any(&payload_data, &["updatedAt", "updated_at"])),
        "is_ghost": is_ghost,
        "ghost_source": ghost_source,
        "ghost_metadata": ghost_metadata,
    });

    Ok(serde_json::json!({
        "operation": op,
        "client_order_id": entity_id,
        "data": data,
        "items": items,
    }))
}

fn mark_order_synced_via_direct_fallback(
    db: &DbState,
    queue_id: i64,
    entity_id: &str,
    remote_id: &str,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let _ = conn.execute(
        "UPDATE sync_queue
         SET status = 'synced',
             synced_at = ?1,
             remote_receipt_id = NULL,
             last_error = NULL,
             next_retry_at = NULL,
             updated_at = ?1
         WHERE id = ?2",
        params![now, queue_id],
    );
    let _ = conn.execute(
        "UPDATE orders
         SET sync_status = 'synced',
             last_synced_at = ?1,
             supabase_id = COALESCE(NULLIF(supabase_id, ''), ?2),
             updated_at = ?1
         WHERE id = ?3",
        params![now, remote_id, entity_id],
    );
    promote_payments_for_order(&conn, entity_id);
    Ok(())
}

async fn sync_order_batch_via_direct_api(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
    fallback_branch_id: &str,
    items: &[&SyncItem],
) -> Result<DirectOrderFallbackOutcome, String> {
    let mut outcome = DirectOrderFallbackOutcome::default();

    for item in items {
        let (queue_id, _etype, entity_id, operation, payload, _idem, _ret, _max, _, _, _) = item;
        if operation.trim().to_lowercase() != "insert" {
            continue;
        }

        let local_order = get_order_by_id(db, entity_id).unwrap_or_else(|e| {
            warn!(order_id = %entity_id, "get_order_by_id fallback: {e}");
            Value::Null
        });
        if local_order
            .get("supabaseId")
            .and_then(Value::as_str)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            let now = Utc::now().to_rfc3339();
            let _ = conn.execute(
                "UPDATE sync_queue
                 SET status = 'synced',
                     synced_at = ?1,
                     last_error = NULL,
                     updated_at = ?1
                 WHERE id = ?2",
                params![now, queue_id],
            );
            outcome.record_synced(*queue_id);
            continue;
        }

        let payload_value: Value =
            serde_json::from_str(payload).unwrap_or_else(|_| serde_json::json!({}));
        let normalized = match build_normalized_order_operation(
            db,
            entity_id,
            operation,
            &payload_value,
            fallback_branch_id,
        ) {
            Ok(v) => v,
            Err(e) => {
                let failure = format!("Permanent direct fallback failure: normalize payload: {e}");
                outcome.record_permanent_failure(*queue_id, failure.clone());
                warn!(
                    queue_id = *queue_id,
                    entity_id = %entity_id,
                    error = %e,
                    "Direct order fallback skipped: failed to normalize order payload"
                );
                continue;
            }
        };

        let data = normalized
            .get("data")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));

        let mut direct_items: Vec<Value> = Vec::new();
        for raw_item in normalized
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let raw_menu_item_id = raw_item
                .get("menu_item_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let menu_item_id = if raw_menu_item_id.is_empty() {
                None
            } else if Uuid::parse_str(&raw_menu_item_id).is_ok() {
                Some(raw_menu_item_id.clone())
            } else {
                warn!(
                    menu_item_id = %raw_menu_item_id,
                    "Direct order fallback normalizing non-UUID menu_item_id to null"
                );
                None
            };
            let item_name = raw_item.get("name").cloned().unwrap_or(Value::Null);
            let has_name = item_name
                .as_str()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
            if menu_item_id.is_none() && !has_name {
                warn!(
                    queue_id = *queue_id,
                    entity_id = %entity_id,
                    raw_menu_item_id = %raw_menu_item_id,
                    "Dropping order item: no valid menu_item_id and no name"
                );
                continue;
            }
            let quantity = raw_item
                .get("quantity")
                .and_then(Value::as_i64)
                .unwrap_or(1)
                .max(1);
            let unit_price = raw_item
                .get("unit_price")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.0);

            direct_items.push(serde_json::json!({
                "menu_item_id": menu_item_id,
                "quantity": quantity,
                "unit_price": unit_price,
                "name": item_name,
                "category_id": raw_item.get("category_id").cloned().unwrap_or(Value::Null),
                "category_name": raw_item.get("category_name").cloned().unwrap_or(Value::Null),
                "customizations": raw_item.get("customizations").cloned().unwrap_or(Value::Null),
                "notes": raw_item.get("notes").cloned().unwrap_or(Value::Null),
            }));
        }

        if direct_items.is_empty() {
            let failure =
                "Permanent direct fallback failure: no valid order items after normalization"
                    .to_string();
            outcome.record_permanent_failure(*queue_id, failure);
            warn!(
                queue_id = *queue_id,
                entity_id = %entity_id,
                "Direct order fallback skipped: no valid items"
            );
            continue;
        }

        let branch_id = str_any(&data, &["branch_id"])
            .or_else(|| {
                if fallback_branch_id.trim().is_empty() {
                    None
                } else {
                    Some(fallback_branch_id.to_string())
                }
            })
            .unwrap_or_default();
        if branch_id.is_empty() || Uuid::parse_str(&branch_id).is_err() {
            let failure = format!(
                "Permanent direct fallback failure: invalid branch_id '{}'",
                branch_id
            );
            outcome.record_permanent_failure(*queue_id, failure);
            warn!(
                queue_id = *queue_id,
                entity_id = %entity_id,
                branch_id = %branch_id,
                "Direct order fallback skipped: invalid branch_id"
            );
            continue;
        }

        // Normalize payment_method to match the Zod enum on the server:
        // cash, card, digital_wallet, other. "pending" is not a valid payment
        // method — map it to "cash" so the order can sync.
        let raw_payment_method =
            str_any(&data, &["payment_method"]).unwrap_or_else(|| "cash".to_string());
        let payment_method_normalized = match raw_payment_method.to_lowercase().as_str() {
            "cash" | "card" | "digital_wallet" | "other" => raw_payment_method,
            "pending" => "cash".to_string(),
            _ => "other".to_string(),
        };

        // Normalize order_type to match the Zod enum: dine-in, pickup, delivery,
        // drive-through, takeaway. Underscore variants are remapped.
        let raw_order_type =
            str_any(&data, &["order_type"]).unwrap_or_else(|| "pickup".to_string());
        let order_type_normalized = match raw_order_type.to_lowercase().as_str() {
            "dine-in" | "pickup" | "delivery" | "drive-through" | "takeaway" => raw_order_type,
            "dine_in" | "dinein" => "dine-in".to_string(),
            "take_away" | "take-away" => "takeaway".to_string(),
            "drive_through" | "drivethrough" => "drive-through".to_string(),
            _ => "pickup".to_string(),
        };

        let body = serde_json::json!({
            "client_order_id": entity_id,
            "branch_id": branch_id,
            "items": direct_items,
            "order_type": order_type_normalized,
            "payment_method": payment_method_normalized,
            "payment_status": str_any(&data, &["payment_status"]).unwrap_or_else(|| "pending".to_string()),
            "total_amount": num_any(&data, &["total_amount"]).unwrap_or(0.0),
            "subtotal": num_any(&data, &["subtotal"]),
            "tax_amount": num_any(&data, &["tax_amount"]),
            "discount_amount": num_any(&data, &["discount_amount"]),
            "discount_percentage": num_any(&data, &["discount_percentage"]),
            "manual_discount_mode": str_any(&data, &["manual_discount_mode", "manualDiscountMode"]),
            "manual_discount_value": num_any(&data, &["manual_discount_value", "manualDiscountValue"]),
            "coupon_id": str_any(&data, &["coupon_id"]),
            "coupon_code": str_any(&data, &["coupon_code"]),
            "coupon_discount_amount": num_any(&data, &["coupon_discount_amount"]),
            "delivery_fee": num_any(&data, &["delivery_fee"]),
            "notes": str_any(&data, &["notes"]),
            "customer_name": str_any(&data, &["customer_name"]),
            "customer_phone": str_any(&data, &["customer_phone"]),
            "delivery_address": str_any(&data, &["delivery_address"]),
            "is_ghost": bool_any(&data, &["is_ghost"]).unwrap_or(false),
            "ghost_source": str_any(&data, &["ghost_source"]),
            "ghost_metadata": data.get("ghost_metadata").or_else(|| data.pointer("/data/ghost_metadata")),
        });

        match api::fetch_from_admin(admin_url, api_key, "/api/pos/orders", "POST", Some(body)).await
        {
            Ok(resp) => {
                let remote_id = resp
                    .pointer("/data/id")
                    .and_then(Value::as_str)
                    .or_else(|| resp.get("id").and_then(Value::as_str))
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());

                let Some(remote_id) = remote_id else {
                    outcome.record_transient_failure(
                        *queue_id,
                        "Transient direct fallback failure: response missing order id".to_string(),
                    );
                    warn!(
                        queue_id = *queue_id,
                        entity_id = %entity_id,
                        "Direct order fallback response missing order id"
                    );
                    continue;
                };

                mark_order_synced_via_direct_fallback(db, *queue_id, entity_id, &remote_id)?;
                outcome.record_synced(*queue_id);

                info!(
                    queue_id = *queue_id,
                    entity_id = %entity_id,
                    remote_order_id = %remote_id,
                    "Order synced via direct API fallback"
                );
            }
            Err(error) => {
                let order_preview = build_order_preview(db, entity_id);
                if is_permanent_order_sync_error(&error) {
                    outcome.record_permanent_failure(
                        *queue_id,
                        format!("Permanent direct fallback failure: {error}"),
                    );
                    error!(
                        queue_id = *queue_id,
                        entity_id = %entity_id,
                        error = %error,
                        order_preview = ?order_preview,
                        items_sent = direct_items.len(),
                        order_type = %order_type_normalized,
                        payment_method = %payment_method_normalized,
                        "Direct order sync PERMANENT failure — order will not retry"
                    );
                } else if is_transient_order_sync_error(&error) {
                    outcome.record_transient_failure(
                        *queue_id,
                        format!("Transient direct fallback failure: {error}"),
                    );
                    warn!(
                        queue_id = *queue_id,
                        entity_id = %entity_id,
                        error = %error,
                        order_preview = ?order_preview,
                        items_sent = direct_items.len(),
                        order_type = %order_type_normalized,
                        payment_method = %payment_method_normalized,
                        "Direct order sync transient failure — will retry"
                    );
                } else {
                    outcome.record_transient_failure(
                        *queue_id,
                        format!("Transient direct fallback failure: {error}"),
                    );
                }
            }
        }
    }

    // Handle update operations via PATCH /api/pos/orders (status changes,
    // driver assignments, etc.). These were previously routed exclusively
    // through the queue endpoint, which has a broken/slow background worker.
    for item in items {
        let (queue_id, _etype, entity_id, operation, payload, _idem, _ret, _max, _, _, _) = item;
        if operation.trim().to_lowercase() != "update" {
            continue;
        }

        cleanup_order_update_queue_rows_for_order(db, Some(entity_id))?;
        {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            let queue_status: Option<String> = conn
                .query_row(
                    "SELECT status FROM sync_queue WHERE id = ?1",
                    params![queue_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("reload order update queue row: {e}"))?;
            if matches!(queue_status.as_deref(), Some("synced")) {
                outcome.record_synced(*queue_id);
                continue;
            }
        }

        // Check if this order has a supabase_id (remote ID) — needed for PATCH
        let remote_id: Option<String> = {
            let local_order = get_order_by_id(db, entity_id).unwrap_or(Value::Null);
            local_order
                .get("supabaseId")
                .or_else(|| local_order.get("supabase_id"))
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };

        // If no remote ID yet, the parent order hasn't synced — skip for now,
        // it will be picked up after the order sync completes.
        let Some(remote_id) = remote_id else {
            // Don't mark as handled — leave for next cycle when order has synced
            continue;
        };

        let payload_value: Value =
            serde_json::from_str(payload).unwrap_or_else(|_| serde_json::json!({}));

        let mut status = payload_value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();

        // If payload has no status (e.g. item or financial updates), read
        // the current order status from the local DB so the PATCH still works.
        if status.is_empty() {
            let local_order = get_order_by_id(db, entity_id).unwrap_or(Value::Null);
            status = local_order
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
        }

        if status.is_empty() {
            outcome.record_permanent_failure(
                *queue_id,
                "Permanent failure: update payload missing status field and order not found locally"
                    .to_string(),
            );
            continue;
        }

        let mut body = serde_json::json!({
            "id": remote_id,
            "status": status,
        });

        // Include optional fields if present
        if let Some(estimated_time) = payload_value.get("estimatedTime") {
            if !estimated_time.is_null() {
                body.as_object_mut()
                    .unwrap()
                    .insert("estimated_time".to_string(), estimated_time.clone());
            }
        }
        // NOTE: driver_id is NOT sent in status update PATCHes.
        // The driver was assigned during order creation. Sending it here
        // triggers server-side validateDriver() which fails if the driver's
        // shift has ended or role_type != 'driver'.
        if let Some(notes) = payload_value.get("notes") {
            if !notes.is_null() {
                body.as_object_mut()
                    .unwrap()
                    .insert("notes".to_string(), notes.clone());
            }
        }

        // Forward financial fields when present (from order_update_financials)
        for &(camel, snake) in &[
            ("totalAmount", "total_amount"),
            ("subtotal", "subtotal"),
            ("discountAmount", "discount_amount"),
            ("discountPercentage", "discount_percentage"),
            ("taxAmount", "tax_amount"),
            ("deliveryFee", "delivery_fee"),
            ("tipAmount", "tip_amount"),
            ("paymentStatus", "payment_status"),
            ("paymentMethod", "payment_method"),
        ] {
            if let Some(v) = payload_value.get(camel) {
                if !v.is_null() {
                    body.as_object_mut()
                        .unwrap()
                        .insert(snake.to_string(), v.clone());
                }
            }
        }

        // Forward item updates when present (from order_update_items)
        if let Some(items) = payload_value.get("items") {
            if !items.is_null() {
                body.as_object_mut()
                    .unwrap()
                    .insert("items".to_string(), items.clone());
            }
        }
        if let Some(order_notes) = payload_value.get("orderNotes") {
            if !order_notes.is_null() {
                body.as_object_mut()
                    .unwrap()
                    .insert("order_notes".to_string(), order_notes.clone());
            }
        }

        match api::fetch_from_admin(admin_url, api_key, "/api/pos/orders", "PATCH", Some(body))
            .await
        {
            Ok(_resp) => {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                let now = Utc::now().to_rfc3339();
                let _ = conn.execute(
                    "UPDATE sync_queue
                     SET status = 'synced',
                         synced_at = ?1,
                         last_error = NULL,
                         updated_at = ?1
                     WHERE id = ?2",
                    params![now, queue_id],
                );
                let mut affected_order_ids = HashSet::new();
                affected_order_ids.insert(entity_id.to_string());
                let _ =
                    refresh_order_sync_status_for_queue_cleanup(&conn, &affected_order_ids, &now);
                outcome.record_synced(*queue_id);
                info!(
                    queue_id = *queue_id,
                    entity_id = %entity_id,
                    remote_id = %remote_id,
                    new_status = %status,
                    "Order status update synced via direct PATCH API"
                );
            }
            Err(err) => {
                if is_permanent_order_sync_error(&err) {
                    outcome.record_permanent_failure(
                        *queue_id,
                        format!("Permanent status update failure: {err}"),
                    );
                    warn!(
                        queue_id = *queue_id,
                        entity_id = %entity_id,
                        error = %err,
                        "Order status update PATCH failed (permanent)"
                    );
                } else {
                    outcome.record_transient_failure(
                        *queue_id,
                        format!("Transient status update failure: {err}"),
                    );
                    warn!(
                        queue_id = *queue_id,
                        entity_id = %entity_id,
                        error = %err,
                        "Order status update PATCH failed (transient, will retry)"
                    );
                }
            }
        }
    }

    Ok(outcome)
}

/// POST a batch of normalized order sync items to `/api/pos/orders/sync`.
///
/// Returns the server response JSON so the caller can extract
/// `receipt_id` and any server-assigned IDs.
#[allow(dead_code)]
async fn sync_order_batch(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
    terminal_id: &str,
    branch_id: &str,
    items: &[&SyncItem],
) -> Result<Value, String> {
    let mut operations = Vec::new();
    for item in items {
        let (_id, _etype, entity_id, operation, payload, _idem, _ret, _max, _, _, _) = item;
        let payload: Value =
            serde_json::from_str(payload).unwrap_or_else(|_| serde_json::json!({}));
        let normalized =
            build_normalized_order_operation(db, entity_id, operation, &payload, branch_id)?;
        operations.push(normalized);
    }

    let body = serde_json::json!({
        "terminal_id": terminal_id,
        "operations": operations,
    });

    api::fetch_from_admin(
        admin_url,
        api_key,
        "/api/pos/orders/sync",
        "POST",
        Some(body),
    )
    .await
}

/// Result of a shift sync batch — tracks per-event outcomes.
#[derive(Debug, Default)]
struct ShiftBatchOutcome {
    /// Shift IDs (entity_id) that the server accepted (ok or skipped).
    synced_shift_ids: Vec<String>,
    /// Shift IDs that the server rejected with an error.
    failed_shift_ids: Vec<(String, String)>, // (entity_id, error_message)
}

/// POST a batch of shift sync items to `/api/pos/shifts/sync`.
///
/// Returns per-event results so the caller can mark individual items as synced
/// or failed. Previously this discarded the response body, causing server-side
/// rejections to be silently marked as synced locally.
async fn sync_shift_batch(
    admin_url: &str,
    api_key: &str,
    terminal_id: &str,
    branch_id: &str,
    items: &[&SyncItem],
) -> Result<ShiftBatchOutcome, String> {
    let mut events = Vec::new();
    let mut event_shift_ids: Vec<String> = Vec::new();
    for item in items {
        let (_id, etype, entity_id, operation, payload, idem_key, _ret, _max, _, _, _) = item;
        let data: Value = serde_json::from_str(payload).unwrap_or(serde_json::json!({}));
        let is_transfer_update = data.get("isTransferPending").is_some()
            || data.get("is_transfer_pending").is_some()
            || data.get("transferredToCashierShiftId").is_some()
            || data.get("transferred_to_cashier_shift_id").is_some();
        let event_type = match (etype.as_str(), operation.as_str()) {
            ("shift", "insert") => "shift_open",
            ("shift", "update") if is_transfer_update => "shift_transfer",
            ("shift", "update") => "shift_close",
            ("shift_expense", "insert") => "expense_record",
            other => {
                warn!("Unknown shift sync operation: {:?}, skipping", other);
                continue;
            }
        };
        events.push(serde_json::json!({
            "event_type": event_type,
            "shift_id": entity_id,
            "idempotency_key": idem_key,
            "data": data,
        }));
        event_shift_ids.push(entity_id.clone());
    }

    let body = serde_json::json!({
        "terminal_id": terminal_id,
        "branch_id": branch_id,
        "events": events,
    });

    let response = api::fetch_from_admin(
        admin_url,
        api_key,
        "/api/pos/shifts/sync",
        "POST",
        Some(body),
    )
    .await?;

    // Parse per-event results from the server response.
    // The endpoint returns { success, results: [{ shift_id, status, message? }] }.
    let mut outcome = ShiftBatchOutcome::default();
    let results = response
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if results.is_empty() {
        // Old server or unexpected response — treat all as synced (legacy behavior)
        outcome.synced_shift_ids = event_shift_ids;
        return Ok(outcome);
    }

    for result in &results {
        let shift_id = result
            .get("shift_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let status = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("error");

        match status {
            "ok" | "skipped" => {
                outcome.synced_shift_ids.push(shift_id);
            }
            _ => {
                let message = result
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown shift sync error")
                    .to_string();
                warn!(
                    shift_id = %shift_id,
                    error = %message,
                    "Shift sync event rejected by server"
                );
                outcome.failed_shift_ids.push((shift_id, message));
            }
        }
    }

    Ok(outcome)
}

fn extract_financial_result_message(result: &Value) -> Option<String> {
    result
        .get("message")
        .or_else(|| result.get("error"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn mark_financial_item_synced(
    db: &DbState,
    item: &SyncItem,
    server_id: Option<&str>,
) -> Result<(), String> {
    let (queue_id, entity_type, entity_id, _, _, _, _, _, _, _, _) = item;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let _ = conn.execute(
        "UPDATE sync_queue
         SET status = 'synced',
             synced_at = ?1,
             last_error = NULL,
             next_retry_at = NULL,
             updated_at = ?1
         WHERE id = ?2",
        params![now, queue_id],
    );

    match entity_type.as_str() {
        "shift_expense" => {
            let _ = conn.execute(
                "UPDATE shift_expenses
                 SET sync_status = 'synced',
                     updated_at = ?1
                 WHERE id = ?2",
                params![now, entity_id],
            );
        }
        "driver_earning" | "driver_earnings" => {
            if let Some(remote_id) = server_id
                .filter(|value| !value.trim().is_empty())
                .or(Some(entity_id.as_str()))
            {
                let _ = conn.execute(
                    "UPDATE driver_earnings
                     SET supabase_id = ?1,
                         updated_at = ?2
                     WHERE id = ?3",
                    params![remote_id, now, entity_id],
                );
            } else {
                let _ = conn.execute(
                    "UPDATE driver_earnings SET updated_at = ?1 WHERE id = ?2",
                    params![now, entity_id],
                );
            }
        }
        "staff_payment" => {}
        _ => {}
    }

    Ok(())
}

fn mark_financial_item_failed(db: &DbState, item: &SyncItem, error: &str) -> Result<(), String> {
    let (queue_id, entity_type, entity_id, _, _, _, _, max_retries, _, _, _) = item;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let _ = conn.execute(
        "UPDATE sync_queue
         SET status = 'failed',
             retry_count = ?1,
             next_retry_at = NULL,
             last_error = ?2,
             updated_at = ?3
         WHERE id = ?4",
        params![max_retries, error, now, queue_id],
    );

    if entity_type == "shift_expense" {
        let _ = conn.execute(
            "UPDATE shift_expenses
             SET sync_status = 'failed',
                 updated_at = ?1
             WHERE id = ?2",
            params![now, entity_id],
        );
    }

    Ok(())
}

/// Extract the parent shift ID from a financial sync payload.
///
/// Financial items reference their parent shift via various key names depending
/// on the entity type (staff_payment, shift_expense, driver_earning).
fn extract_shift_id_from_financial_payload(payload: &str) -> Option<String> {
    let data: Value = serde_json::from_str(payload).ok()?;
    for key in &[
        "cashierShiftId",
        "cashier_shift_id",
        "paidByCashierShiftId",
        "paid_by_cashier_shift_id",
        "shiftId",
        "shift_id",
        "staffShiftId",
        "staff_shift_id",
    ] {
        if let Some(val) = data.get(*key).and_then(Value::as_str) {
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn extract_order_id_from_financial_payload(payload: &str) -> Option<String> {
    let data: Value = serde_json::from_str(payload).ok()?;
    for key in &["orderId", "order_id"] {
        if let Some(val) = data.get(*key).and_then(Value::as_str) {
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn is_driver_earning_entity(entity_type: &str) -> bool {
    matches!(entity_type, "driver_earning" | "driver_earnings")
}

fn is_strict_shift_bound_financial_entity(entity_type: &str) -> bool {
    matches!(
        entity_type,
        "shift_expense" | "shift_expenses" | "staff_payment" | "staff_payments"
    )
}

const WAITING_FOR_CASHIER_SHIFT_SYNC_REASON: &str = "Waiting for cashier shift sync";
const CASHIER_SHIFT_SYNC_NEEDS_ATTENTION_REASON: &str = "Cashier shift sync needs attention";
const CASHIER_SHIFT_MISSING_LOCALLY_REASON: &str = "Cashier shift is missing locally";

#[derive(Debug, Clone)]
struct ShiftQueueDependencyRow {
    queue_id: i64,
    status: String,
    last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct FinancialParentShiftDependency {
    pub parent_shift_id: String,
    pub parent_shift_sync_status: Option<String>,
    pub parent_shift_queue_id: Option<i64>,
    pub parent_shift_queue_status: Option<String>,
    pub dependency_block_reason: Option<String>,
}

fn is_actionable_shift_queue_status(status: &str) -> bool {
    matches!(
        status,
        "pending" | "in_progress" | "deferred" | "queued_remote"
    )
}

fn local_order_has_remote_identity(conn: &rusqlite::Connection, order_ref: &str) -> Option<bool> {
    conn.query_row(
        "SELECT COALESCE(supabase_id, '')
         FROM orders
         WHERE id = ?1 OR supabase_id = ?1
         LIMIT 1",
        params![order_ref],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .map(|remote_id| !remote_id.trim().is_empty())
}

/// Check whether a parent shift has been synced locally.
/// Returns: Some("synced") | Some("pending") | Some("failed") | None (not found).
fn get_shift_sync_status(conn: &rusqlite::Connection, shift_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT sync_status FROM staff_shifts WHERE id = ?1",
        params![shift_id],
        |row| row.get(0),
    )
    .ok()
}

fn load_parent_shift_queue_row(
    conn: &rusqlite::Connection,
    shift_id: &str,
) -> Option<ShiftQueueDependencyRow> {
    conn.query_row(
        "SELECT id, status, last_error
         FROM sync_queue
         WHERE entity_type = 'shift'
           AND entity_id = ?1
         ORDER BY
           CASE status
             WHEN 'pending' THEN 0
             WHEN 'in_progress' THEN 1
             WHEN 'deferred' THEN 2
             WHEN 'queued_remote' THEN 3
             WHEN 'failed' THEN 4
             WHEN 'synced' THEN 5
             WHEN 'applied' THEN 6
             ELSE 9
           END,
           id DESC
         LIMIT 1",
        params![shift_id],
        |row| {
            Ok(ShiftQueueDependencyRow {
                queue_id: row.get(0)?,
                status: row.get(1)?,
                last_error: row.get(2)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

fn is_retryable_shift_sync_error(error: Option<&str>) -> bool {
    let Some(error) = error.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };

    let lower = error.to_lowercase();
    if is_backpressure_error(error)
        || lower.contains("network error")
        || lower.contains("cannot reach admin dashboard")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("server error")
        || lower.contains("http 5")
        || lower.contains("connection refused")
        || lower.contains("connection reset")
        || lower.contains("temporar")
        || lower.contains("backend yet")
        || lower.contains("not found on backend yet")
        || lower.contains("transferred_to_cashier_shift_id_fkey")
    {
        return true;
    }

    if lower.contains("validation")
        || lower.contains("invalid")
        || lower.contains("missing required")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("access denied")
        || lower.contains("same branch")
        || lower.contains("staff not found")
        || lower.contains("branch not found")
        || lower.contains("organization")
    {
        return false;
    }

    false
}

fn build_parent_shift_block_reason(
    shift_sync_status: Option<&str>,
    queue_row: Option<&ShiftQueueDependencyRow>,
) -> Option<String> {
    match shift_sync_status {
        Some("synced") => None,
        None => Some(CASHIER_SHIFT_MISSING_LOCALLY_REASON.to_string()),
        Some(_) => match queue_row {
            Some(row) if is_actionable_shift_queue_status(&row.status) => {
                Some(WAITING_FOR_CASHIER_SHIFT_SYNC_REASON.to_string())
            }
            Some(row) if row.status == "failed" => {
                Some(CASHIER_SHIFT_SYNC_NEEDS_ATTENTION_REASON.to_string())
            }
            _ => Some(WAITING_FOR_CASHIER_SHIFT_SYNC_REASON.to_string()),
        },
    }
}

fn build_shift_requeue_payload(
    conn: &rusqlite::Connection,
    shift_id: &str,
    operation: &str,
) -> Option<String> {
    if operation == "update" {
        conn.query_row(
            "SELECT json_object(
                'shiftId', ss.id,
                'staffId', ss.staff_id,
                'staffName', ss.staff_name,
                'branchId', ss.branch_id,
                'terminalId', ss.terminal_id,
                'roleType', ss.role_type,
                'openingCash', COALESCE(ss.opening_cash_amount, 0),
                'checkInTime', ss.check_in_time,
                'checkOutTime', ss.check_out_time,
                'reportDate', ss.report_date,
                'periodStartAt', ss.period_start_at,
                'calculationVersion', COALESCE(ss.calculation_version, 2),
                'totalOrdersCount', COALESCE(ss.total_orders_count, 0),
                'totalSalesAmount', COALESCE(ss.total_sales_amount, 0),
                'totalCashSales', COALESCE(ss.total_cash_sales, 0),
                'totalCardSales', COALESCE(ss.total_card_sales, 0),
                'closingCash', ss.closing_cash_amount,
                'expectedCash', ss.expected_cash_amount,
                'variance', ss.cash_variance,
                'closedBy', ss.closed_by,
                'paymentAmount', ss.payment_amount,
                'cashDrawer', CASE
                    WHEN cds.id IS NOT NULL THEN json_object(
                        'id', cds.id,
                        'cashierId', cds.cashier_id,
                        'openingAmount', COALESCE(cds.opening_amount, 0),
                        'closingAmount', cds.closing_amount,
                        'expectedAmount', cds.expected_amount,
                        'varianceAmount', cds.variance_amount,
                        'totalCashSales', COALESCE(cds.total_cash_sales, 0),
                        'totalCardSales', COALESCE(cds.total_card_sales, 0),
                        'totalRefunds', COALESCE(cds.total_refunds, 0),
                        'totalExpenses', COALESCE(cds.total_expenses, 0),
                        'cashDrops', COALESCE(cds.cash_drops, 0),
                        'driverCashGiven', COALESCE(cds.driver_cash_given, 0),
                        'driverCashReturned', COALESCE(cds.driver_cash_returned, 0),
                        'totalStaffPayments', COALESCE(cds.total_staff_payments, 0),
                        'openedAt', cds.opened_at,
                        'closedAt', cds.closed_at,
                        'reconciled', CASE WHEN COALESCE(cds.reconciled, 0) = 0 THEN json('false') ELSE json('true') END,
                        'reconciledAt', cds.reconciled_at,
                        'reconciledBy', cds.reconciled_by
                    )
                    ELSE NULL
                END,
                'returnedCashTargetCashierShiftId', CASE
                    WHEN ss.role_type IN ('driver', 'server') THEN ss.transferred_to_cashier_shift_id
                    ELSE NULL
                END,
                'returnedCashTargetDrawerId', CASE
                    WHEN ss.role_type IN ('driver', 'server') THEN (
                        SELECT id
                        FROM cash_drawer_sessions
                        WHERE staff_shift_id = ss.transferred_to_cashier_shift_id
                        LIMIT 1
                    )
                    ELSE NULL
                END,
                'returnedCashAmount', CASE
                    WHEN ss.role_type IN ('driver', 'server') THEN COALESCE(ss.closing_cash_amount, 0)
                    ELSE NULL
                END,
                'resolvedCashierShiftId', CASE
                    WHEN ss.role_type IN ('driver', 'server') THEN ss.transferred_to_cashier_shift_id
                    ELSE NULL
                END,
                'resolvedCashierDrawerId', CASE
                    WHEN ss.role_type IN ('driver', 'server') THEN (
                        SELECT id
                        FROM cash_drawer_sessions
                        WHERE staff_shift_id = ss.transferred_to_cashier_shift_id
                        LIMIT 1
                    )
                    ELSE NULL
                END
             )
             FROM staff_shifts ss
             LEFT JOIN cash_drawer_sessions cds ON cds.staff_shift_id = ss.id
             WHERE ss.id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .ok()
    } else {
        conn.query_row(
            "SELECT json_object(
                'shiftId', ss.id,
                'staffId', ss.staff_id,
                'staffName', ss.staff_name,
                'branchId', ss.branch_id,
                'terminalId', ss.terminal_id,
                'roleType', ss.role_type,
                'openingCash', COALESCE(ss.opening_cash_amount, 0),
                'checkInTime', ss.check_in_time,
                'reportDate', ss.report_date,
                'periodStartAt', ss.period_start_at,
                'calculationVersion', COALESCE(ss.calculation_version, 2),
                'responsibleCashierShiftId', ss.transferred_to_cashier_shift_id,
                'responsibleCashierDrawerId', (
                    SELECT id
                    FROM cash_drawer_sessions
                    WHERE staff_shift_id = ss.transferred_to_cashier_shift_id
                    LIMIT 1
                ),
                'startingAmountSourceCashierShiftId', ss.transferred_to_cashier_shift_id,
                'borrowedStartingAmount', CASE
                    WHEN ss.role_type IN ('driver', 'server') THEN COALESCE(ss.opening_cash_amount, 0)
                    ELSE NULL
                END
             )
             FROM staff_shifts ss
             WHERE ss.id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .ok()
    }
}

fn upsert_active_shift_insert_sync_row(
    conn: &rusqlite::Connection,
    shift_id: &str,
    payload: &str,
    now: &str,
) -> Result<(), String> {
    let existing_queue_id: Option<i64> = conn
        .query_row(
            "SELECT id
             FROM sync_queue
             WHERE entity_type = 'shift'
               AND entity_id = ?1
               AND operation = 'insert'
             ORDER BY CASE status
                 WHEN 'in_progress' THEN 0
                 WHEN 'pending' THEN 1
                 WHEN 'deferred' THEN 2
                 WHEN 'failed' THEN 3
                 ELSE 4
             END, id DESC
             LIMIT 1",
            params![shift_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("load active shift queue row: {e}"))?;

    if let Some(queue_id) = existing_queue_id {
        conn.execute(
            "UPDATE sync_queue
             SET payload = ?1,
                 status = 'pending',
                 retry_count = 0,
                 last_error = NULL,
                 next_retry_at = NULL,
                 updated_at = ?2
             WHERE id = ?3",
            params![payload, now, queue_id],
        )
        .map_err(|e| format!("update active shift queue row: {e}"))?;
    } else {
        let idem_key = format!("shift:business-day-repair:{}:{}", shift_id, Uuid::new_v4());
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('shift', ?1, 'insert', ?2, ?3, 'pending')",
            params![shift_id, payload, idem_key],
        )
        .map_err(|e| format!("insert active shift repair queue row: {e}"))?;
    }

    conn.execute(
        "UPDATE staff_shifts
         SET sync_status = 'pending',
             updated_at = ?1
         WHERE id = ?2",
        params![now, shift_id],
    )
    .map_err(|e| format!("mark active shift pending after business-day repair: {e}"))?;

    Ok(())
}

fn backfill_active_shift_business_day_context(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut stmt = conn
        .prepare(
            "SELECT id, COALESCE(branch_id, '')
             FROM staff_shifts
             WHERE status = 'active'
               AND (
                    report_date IS NULL OR trim(report_date) = ''
                    OR period_start_at IS NULL OR trim(period_start_at) = ''
               )",
        )
        .map_err(|e| format!("prepare active shift business-day repair selector: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query active shift business-day repair selector: {e}"))?;

    let shifts: Vec<(String, String)> = rows.filter_map(Result::ok).collect();
    drop(stmt);

    let mut repaired = 0usize;
    for (shift_id, branch_id) in shifts {
        let period_start_at =
            business_day::resolve_period_start(&conn, &branch_id, Some(now.as_str()));
        let report_date = business_day::report_date_for_business_window(&period_start_at, &now);

        conn.execute(
            "UPDATE staff_shifts
             SET report_date = ?1,
                 period_start_at = ?2,
                 updated_at = ?3
             WHERE id = ?4",
            params![report_date, period_start_at, now, shift_id],
        )
        .map_err(|e| format!("repair active shift business-day fields: {e}"))?;

        let Some(payload) = build_shift_requeue_payload(&conn, &shift_id, "insert") else {
            continue;
        };
        upsert_active_shift_insert_sync_row(&conn, &shift_id, &payload, &now)?;
        repaired += 1;
    }

    Ok(repaired)
}

fn enqueue_reconstructed_shift_sync_row(
    conn: &rusqlite::Connection,
    shift_id: &str,
    now: &str,
) -> Result<Option<i64>, String> {
    let status_str: Option<String> = conn
        .query_row(
            "SELECT status FROM staff_shifts WHERE id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("load parent shift status: {e}"))?;

    let Some(status_str) = status_str else {
        return Ok(None);
    };

    let operation = if status_str == "closed" {
        "update"
    } else {
        "insert"
    };
    let Some(payload) = build_shift_requeue_payload(conn, shift_id, operation) else {
        return Ok(None);
    };

    let idem_key = format!("shift:requeue:{}:{}", shift_id, Uuid::new_v4());
    conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
         VALUES ('shift', ?1, ?2, ?3, ?4, 'pending')",
        params![shift_id, operation, payload, idem_key],
    )
    .map_err(|e| format!("enqueue reconstructed shift sync row: {e}"))?;

    let _ = conn.execute(
        "UPDATE staff_shifts
         SET sync_status = 'pending',
             updated_at = ?1
         WHERE id = ?2
           AND COALESCE(sync_status, '') != 'synced'",
        params![now, shift_id],
    );

    Ok(Some(conn.last_insert_rowid()))
}

fn reset_shift_queue_row_to_pending(
    conn: &rusqlite::Connection,
    shift_id: &str,
    queue_id: i64,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE sync_queue
         SET status = 'pending',
             retry_count = 0,
             last_error = NULL,
             next_retry_at = NULL,
             updated_at = ?1
         WHERE id = ?2",
        params![now, queue_id],
    )
    .map_err(|e| format!("reset parent shift queue row: {e}"))?;

    let _ = conn.execute(
        "UPDATE staff_shifts
         SET sync_status = 'pending',
             updated_at = ?1
         WHERE id = ?2
           AND COALESCE(sync_status, '') != 'synced'",
        params![now, shift_id],
    );

    Ok(())
}

fn align_local_financial_sync_state(
    conn: &rusqlite::Connection,
    entity_type: &str,
    entity_id: &str,
    queue_status: &str,
    now: &str,
) {
    if entity_type != "shift_expense" {
        return;
    }

    let local_sync_status = match queue_status {
        "failed" => "failed",
        "synced" => "synced",
        _ => "pending",
    };

    let _ = conn.execute(
        "UPDATE shift_expenses
         SET sync_status = ?1,
             updated_at = ?2
         WHERE id = ?3",
        params![local_sync_status, now, entity_id],
    );
}

fn requeue_retryable_failed_shift_rows(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut repaired = 0usize;

    let mut failed_shift_stmt = conn
        .prepare(
            "SELECT DISTINCT entity_id
             FROM sync_queue
             WHERE entity_type = 'shift'
               AND status = 'failed'",
        )
        .map_err(|e| format!("prepare failed shift selector: {e}"))?;
    let failed_shift_ids: Vec<String> = failed_shift_stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| format!("query failed shift selector: {e}"))?
        .filter_map(Result::ok)
        .collect();
    drop(failed_shift_stmt);

    for shift_id in &failed_shift_ids {
        let Some(queue_row) = load_parent_shift_queue_row(&conn, shift_id) else {
            continue;
        };

        if queue_row.status != "failed" {
            continue;
        }

        if !is_retryable_shift_sync_error(queue_row.last_error.as_deref()) {
            continue;
        }

        reset_shift_queue_row_to_pending(&conn, shift_id, queue_row.queue_id, &now)?;
        repaired += 1;
    }

    let mut failed_shift_without_queue_stmt = conn
        .prepare(
            "SELECT ss.id
             FROM staff_shifts ss
             WHERE ss.sync_status = 'failed'
               AND NOT EXISTS (
                    SELECT 1
                    FROM sync_queue sq
                    WHERE sq.entity_type = 'shift'
                      AND sq.entity_id = ss.id
                      AND sq.status IN ('pending', 'in_progress', 'deferred', 'failed')
               )",
        )
        .map_err(|e| format!("prepare failed shift without queue selector: {e}"))?;
    let failed_shift_ids_without_queue: Vec<String> = failed_shift_without_queue_stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| format!("query failed shift without queue selector: {e}"))?
        .filter_map(Result::ok)
        .collect();
    drop(failed_shift_without_queue_stmt);

    for shift_id in &failed_shift_ids_without_queue {
        if enqueue_reconstructed_shift_sync_row(&conn, shift_id, &now)?.is_some() {
            repaired += 1;
        }
    }

    Ok(repaired)
}

pub(crate) fn resolve_financial_parent_shift_dependency(
    conn: &rusqlite::Connection,
    entity_type: &str,
    payload: &str,
) -> Option<FinancialParentShiftDependency> {
    if !is_strict_shift_bound_financial_entity(entity_type) {
        return None;
    }

    let parent_shift_id = extract_shift_id_from_financial_payload(payload)?;
    let parent_shift_sync_status = get_shift_sync_status(conn, &parent_shift_id);
    let queue_row = load_parent_shift_queue_row(conn, &parent_shift_id);

    Some(FinancialParentShiftDependency {
        parent_shift_id,
        parent_shift_sync_status: parent_shift_sync_status.clone(),
        parent_shift_queue_id: queue_row.as_ref().map(|row| row.queue_id),
        parent_shift_queue_status: queue_row.as_ref().map(|row| row.status.clone()),
        dependency_block_reason: build_parent_shift_block_reason(
            parent_shift_sync_status.as_deref(),
            queue_row.as_ref(),
        ),
    })
}

pub(crate) fn ensure_financial_parent_shift_dependency_recovery(
    conn: &rusqlite::Connection,
    entity_type: &str,
    payload: &str,
    now: &str,
) -> Result<Option<FinancialParentShiftDependency>, String> {
    if !is_strict_shift_bound_financial_entity(entity_type) {
        return Ok(None);
    }

    let Some(parent_shift_id) = extract_shift_id_from_financial_payload(payload) else {
        return Ok(None);
    };

    let mut dependency = resolve_financial_parent_shift_dependency(conn, entity_type, payload)
        .unwrap_or(FinancialParentShiftDependency {
            parent_shift_id: parent_shift_id.clone(),
            parent_shift_sync_status: None,
            parent_shift_queue_id: None,
            parent_shift_queue_status: None,
            dependency_block_reason: Some(CASHIER_SHIFT_MISSING_LOCALLY_REASON.to_string()),
        });

    if dependency.parent_shift_sync_status.as_deref() == Some("synced") {
        dependency.dependency_block_reason = None;
        return Ok(Some(dependency));
    }

    if dependency.parent_shift_sync_status.is_none() {
        dependency.dependency_block_reason = Some(CASHIER_SHIFT_MISSING_LOCALLY_REASON.to_string());
        return Ok(Some(dependency));
    }

    let queue_row = load_parent_shift_queue_row(conn, &parent_shift_id);
    match queue_row.as_ref().map(|row| row.status.as_str()) {
        Some(status) if is_actionable_shift_queue_status(status) => {
            dependency.dependency_block_reason =
                Some(WAITING_FOR_CASHIER_SHIFT_SYNC_REASON.to_string());
        }
        Some("failed") => {
            let queue_row = queue_row.expect("queue row just matched failed");
            if is_retryable_shift_sync_error(queue_row.last_error.as_deref()) {
                reset_shift_queue_row_to_pending(conn, &parent_shift_id, queue_row.queue_id, now)?;
                dependency = resolve_financial_parent_shift_dependency(conn, entity_type, payload)
                    .unwrap_or(FinancialParentShiftDependency {
                        parent_shift_id: parent_shift_id.clone(),
                        parent_shift_sync_status: get_shift_sync_status(conn, &parent_shift_id),
                        parent_shift_queue_id: Some(queue_row.queue_id),
                        parent_shift_queue_status: Some("pending".to_string()),
                        dependency_block_reason: Some(
                            WAITING_FOR_CASHIER_SHIFT_SYNC_REASON.to_string(),
                        ),
                    });
                dependency.dependency_block_reason =
                    Some(WAITING_FOR_CASHIER_SHIFT_SYNC_REASON.to_string());
            } else {
                dependency.dependency_block_reason =
                    Some(CASHIER_SHIFT_SYNC_NEEDS_ATTENTION_REASON.to_string());
            }
        }
        _ => {
            if enqueue_reconstructed_shift_sync_row(conn, &parent_shift_id, now)?.is_some() {
                dependency = resolve_financial_parent_shift_dependency(conn, entity_type, payload)
                    .unwrap_or(FinancialParentShiftDependency {
                        parent_shift_id: parent_shift_id.clone(),
                        parent_shift_sync_status: get_shift_sync_status(conn, &parent_shift_id),
                        parent_shift_queue_id: None,
                        parent_shift_queue_status: Some("pending".to_string()),
                        dependency_block_reason: Some(
                            WAITING_FOR_CASHIER_SHIFT_SYNC_REASON.to_string(),
                        ),
                    });
                dependency.dependency_block_reason =
                    Some(WAITING_FOR_CASHIER_SHIFT_SYNC_REASON.to_string());
            } else {
                dependency.dependency_block_reason =
                    Some(CASHIER_SHIFT_SYNC_NEEDS_ATTENTION_REASON.to_string());
            }
        }
    }

    Ok(Some(dependency))
}

pub(crate) fn retry_financial_queue_item(db: &DbState, queue_id: i64) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT entity_type, entity_id, payload
             FROM sync_queue
             WHERE id = ?1",
            params![queue_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("load financial queue row for retry: {e}"))?;

    let Some((entity_type, entity_id, payload)) = row else {
        return Err("Financial sync item not found".into());
    };

    let dependency =
        ensure_financial_parent_shift_dependency_recovery(&conn, &entity_type, &payload, &now)?;
    let (status, last_error) = match dependency {
        Some(ref dependency) if dependency.dependency_block_reason.is_some() => {
            ("deferred", dependency.dependency_block_reason.clone())
        }
        _ => ("pending", None),
    };

    conn.execute(
        "UPDATE sync_queue
         SET status = ?1,
             retry_count = 0,
             last_error = ?2,
             next_retry_at = NULL,
             updated_at = ?3
         WHERE id = ?4",
        params![status, last_error, now, queue_id],
    )
    .map_err(|e| format!("retry financial queue row: {e}"))?;
    align_local_financial_sync_state(&conn, &entity_type, &entity_id, status, &now);

    if entity_type == "payment_adjustment" {
        let _ = conn.execute(
            "UPDATE payment_adjustments
             SET sync_state = ?1,
                 sync_retry_count = 0,
                 sync_last_error = NULL,
                 sync_next_retry_at = NULL,
                 updated_at = ?2
             WHERE id = (
                 SELECT entity_id FROM sync_queue WHERE id = ?3
             )",
            params![status, now, queue_id],
        );
    }

    Ok(())
}

async fn sync_financial_batch(
    admin_url: &str,
    api_key: &str,
    terminal_id: &str,
    branch_id: &str,
    db: &DbState,
    items: &[&SyncItem],
) -> Result<FinancialBatchOutcome, String> {
    // Pre-check financial items:
    // - driver_earnings are gated by parent order sync readiness only
    // - staff payments / shift expenses remain strictly gated by shift sync
    let ready_items: Vec<&SyncItem> = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();
        let mut ready = Vec::with_capacity(items.len());

        for item in items {
            let (queue_id, entity_type, entity_id, _, payload, _, _, _, _, _, _) = item;

            if is_driver_earning_entity(entity_type) {
                let order_id = extract_order_id_from_financial_payload(payload);
                let order_has_remote_identity = order_id
                    .as_deref()
                    .and_then(|order_ref| local_order_has_remote_identity(&conn, order_ref));

                if matches!(order_has_remote_identity, Some(false)) {
                    let _ = conn.execute(
                        "UPDATE sync_queue
                         SET status = 'deferred',
                             last_error = 'Order not yet synced',
                             updated_at = ?1
                         WHERE id = ?2",
                        params![now, queue_id],
                    );
                    info!(
                        entity_type = %entity_type,
                        entity_id = %entity_id,
                        order_id = ?order_id,
                        "Driver earning deferred — order not yet synced"
                    );
                    continue;
                }

                ready.push(*item);
                continue;
            }

            if !is_strict_shift_bound_financial_entity(entity_type) {
                ready.push(*item);
                continue;
            }

            let shift_id = extract_shift_id_from_financial_payload(payload);

            if let Some(ref sid) = shift_id {
                let dependency = ensure_financial_parent_shift_dependency_recovery(
                    &conn,
                    entity_type,
                    payload,
                    &now,
                )?;

                if matches!(
                    dependency
                        .as_ref()
                        .and_then(|value| value.parent_shift_sync_status.as_deref()),
                    Some("synced")
                ) {
                    ready.push(*item);
                } else {
                    let block_reason = dependency
                        .as_ref()
                        .and_then(|value| value.dependency_block_reason.clone())
                        .unwrap_or_else(|| WAITING_FOR_CASHIER_SHIFT_SYNC_REASON.to_string());
                    let _ = conn.execute(
                        "UPDATE sync_queue
                         SET status = 'deferred',
                             last_error = ?1,
                             updated_at = ?2
                         WHERE id = ?3",
                        params![block_reason, now, queue_id],
                    );
                    info!(
                        entity_type = %entity_type,
                        entity_id = %entity_id,
                        shift_id = %sid,
                        parent_shift_sync_status = ?dependency
                            .as_ref()
                            .and_then(|value| value.parent_shift_sync_status.as_deref()),
                        parent_shift_queue_status = ?dependency
                            .as_ref()
                            .and_then(|value| value.parent_shift_queue_status.as_deref()),
                        "Financial item deferred — waiting on cashier shift dependency"
                    );
                }
            } else {
                // No shift reference found — send as-is (server will validate)
                ready.push(*item);
            }
        }

        ready
    };

    if ready_items.is_empty() {
        return Ok(FinancialBatchOutcome::default());
    }

    let items = &ready_items[..];
    let mut payload_items = Vec::with_capacity(items.len());
    for item in items {
        let (_, entity_type, entity_id, operation, payload, idem_key, _, _, _, _, _) = item;
        let payload_data: Value =
            serde_json::from_str(payload).unwrap_or_else(|_| serde_json::json!({}));
        payload_items.push(serde_json::json!({
            "entity_type": entity_type,
            "entity_id": entity_id,
            "operation": operation,
            "idempotency_key": idem_key,
            "payload": payload_data,
        }));
    }

    let body = serde_json::json!({
        "terminal_id": terminal_id,
        "branch_id": branch_id,
        "items": payload_items,
    });

    let response = api::fetch_from_admin(
        admin_url,
        api_key,
        "/api/pos/financial/sync",
        "POST",
        Some(body),
    )
    .await?;

    // Deserialize into typed struct; fall back to extracting from Value if
    // the shape doesn't match (backwards-compatible with older admin versions).
    let typed: Option<FinancialBatchSyncResponse> = serde_json::from_value(response.clone()).ok();
    let results = typed
        .as_ref()
        .map(|t| &t.results[..])
        .map(|_| {
            response
                .get("results")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .unwrap_or_else(|| {
            warn!("Financial sync response did not match FinancialBatchSyncResponse schema");
            response
                .get("results")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        });

    let mut outcome = FinancialBatchOutcome::default();

    for item in items {
        let (_, entity_type, entity_id, _, _, idem_key, _, _, _, _, _) = item;
        let matched = results.iter().find(|result| {
            result
                .get("idempotency_key")
                .and_then(Value::as_str)
                .map(|value| value == idem_key)
                .unwrap_or(false)
                || (result
                    .get("entity_type")
                    .and_then(Value::as_str)
                    .map(|value| value == entity_type)
                    .unwrap_or(false)
                    && result
                        .get("entity_id")
                        .and_then(Value::as_str)
                        .map(|value| value == entity_id)
                        .unwrap_or(false))
        });

        let Some(result) = matched else {
            let single = [*item];
            let failure = mark_batch_failed(
                db,
                &single,
                "Missing result in /api/pos/financial/sync response",
            )?;
            if !failure.backpressure_deferred {
                outcome.had_non_backpressure_failure = true;
            }
            continue;
        };

        let result_status = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("error");
        let result_success = result
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(matches!(
                result_status,
                "ok" | "skipped" | "synced" | "deleted"
            ));
        let retryable = result
            .get("retryable")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        if result_success || matches!(result_status, "ok" | "skipped" | "synced" | "deleted") {
            let server_id = result
                .get("server_id")
                .or_else(|| result.get("supabase_id"))
                .and_then(Value::as_str);
            mark_financial_item_synced(db, item, server_id)?;
            outcome.synced += 1;
        } else {
            let single = [*item];
            let error = extract_financial_result_message(result)
                .unwrap_or_else(|| "Financial sync failed".to_string());
            if retryable {
                let failure = mark_batch_failed(db, &single, &error)?;
                if !failure.backpressure_deferred {
                    outcome.had_non_backpressure_failure = true;
                }
            } else {
                mark_financial_item_failed(db, item, &error)?;
                outcome.had_non_backpressure_failure = true;
            }
        }
    }

    Ok(outcome)
}

/// Sync payment items individually to `/api/pos/payments`.
///
/// Each payment is POSTed individually because the endpoint expects a single
/// payment per request. Payments whose parent order has not yet synced
/// (no `supabase_id`) are left as pending without incrementing retry_count.
async fn sync_payment_items(
    admin_url: &str,
    api_key: &str,
    terminal_id: &str,
    db: &DbState,
    items: &[&SyncItem],
) -> usize {
    let mut synced = 0;

    for item in items {
        let (
            id,
            _etype,
            entity_id,
            _operation,
            payload,
            idem_key,
            retry_count,
            max_retries,
            _,
            _,
            _,
        ) = item;
        let data: Value = serde_json::from_str(payload).unwrap_or(serde_json::json!({}));

        // Extract the local order_id from the sync payload
        let local_order_id = data
            .get("orderId")
            .or_else(|| data.get("order_id"))
            .and_then(Value::as_str)
            .unwrap_or("");

        if local_order_id.is_empty() {
            warn!(payment_id = %entity_id, "Payment sync: missing orderId in payload");
            if let Ok(conn) = db.conn.lock() {
                let _ = conn.execute(
                    "UPDATE sync_queue SET status = 'failed', last_error = 'Missing orderId in payload', updated_at = datetime('now') WHERE id = ?1",
                    params![id],
                );
            }
            continue;
        }

        // Resolve the supabase_id for the order
        let supabase_order_id: Option<String> = match db.conn.lock() {
            Ok(conn) => conn
                .query_row(
                    "SELECT supabase_id FROM orders WHERE id = ?1",
                    params![local_order_id],
                    |row| row.get(0),
                )
                .ok()
                .flatten(),
            Err(_) => None,
        };

        // If order hasn't synced yet, move to deferred/waiting_parent
        if supabase_order_id.is_none() {
            info!(
                payment_id = %entity_id,
                order_id = %local_order_id,
                "Payment sync deferred: order not yet synced (no supabase_id)"
            );
            if let Ok(conn) = db.conn.lock() {
                let _ = conn.execute(
                    "UPDATE sync_queue SET status = 'deferred', last_error = 'Order not yet synced', updated_at = datetime('now') WHERE id = ?1",
                    params![id],
                );
                let _ = conn.execute(
                    "UPDATE order_payments SET sync_state = 'waiting_parent', updated_at = datetime('now') WHERE id = ?1",
                    params![entity_id],
                );
            }
            continue;
        }

        let supabase_order_id = supabase_order_id.unwrap();
        let amount = data.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
        let payment_method = data
            .get("method")
            .or_else(|| data.get("paymentMethod"))
            .and_then(Value::as_str)
            .unwrap_or("cash");
        let external_tx_id = data
            .get("transactionRef")
            .or_else(|| data.get("transaction_ref"))
            .and_then(Value::as_str);
        let tip_amount = data.get("tipAmount").and_then(Value::as_f64);
        let currency = data.get("currency").and_then(Value::as_str);
        let payment_origin = data
            .get("paymentOrigin")
            .or_else(|| data.get("payment_origin"))
            .and_then(Value::as_str);

        // Build the POST body for /api/pos/payments
        let mut body = serde_json::json!({
            "order_id": supabase_order_id,
            "amount": amount,
            "payment_method": payment_method,
            "idempotency_key": idem_key,
        });
        if let Some(ext_id) = external_tx_id {
            body["external_transaction_id"] = Value::String(ext_id.to_string());
        }
        if let Some(tip) = tip_amount {
            body["tip_amount"] = serde_json::json!(tip);
        }
        if let Some(currency) = currency {
            body["currency"] = Value::String(currency.to_string());
        }
        // Include terminal_id as metadata for traceability
        body["metadata"] = serde_json::json!({
            "terminal_id": terminal_id,
            "local_payment_id": entity_id,
            "payment_origin": payment_origin,
        });

        // Include payment_items if present in the sync payload (split-by-items)
        if let Some(items_arr) = data.get("items") {
            if items_arr.is_array() && !items_arr.as_array().unwrap_or(&vec![]).is_empty() {
                body["items"] = items_arr.clone();
            }
        }

        // Mark as syncing before the HTTP call
        if let Ok(conn) = db.conn.lock() {
            let _ = conn.execute(
                "UPDATE order_payments SET sync_state = 'syncing', updated_at = datetime('now') WHERE id = ?1",
                params![entity_id],
            );
        }

        match api::fetch_from_admin(admin_url, api_key, "/api/pos/payments", "POST", Some(body))
            .await
        {
            Ok(resp) => {
                let typed: Option<PaymentSyncResponse> = serde_json::from_value(resp.clone()).ok();
                let remote_payment_id = typed
                    .as_ref()
                    .and_then(|value| value.payment_id.clone())
                    .or_else(|| {
                        resp.get("payment_id")
                            .or_else(|| resp.get("id"))
                            .and_then(Value::as_str)
                            .map(|value| value.to_string())
                    });
                let now = Utc::now().to_rfc3339();
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = 'synced', synced_at = ?1, updated_at = ?1 WHERE id = ?2",
                        params![now, id],
                    );
                    let _ = conn.execute(
                        "UPDATE order_payments
                         SET sync_status = 'synced',
                             sync_state = 'applied',
                             remote_payment_id = COALESCE(?1, remote_payment_id),
                             sync_retry_count = 0,
                             sync_last_error = NULL,
                             updated_at = ?2
                         WHERE id = ?3",
                        params![remote_payment_id, now, entity_id],
                    );
                }
                synced += 1;
            }
            Err(e) => {
                if is_payment_total_conflict_error(&e) {
                    match reconcile_remote_payments_for_local_order(
                        db,
                        admin_url,
                        api_key,
                        local_order_id,
                    )
                    .await
                    {
                        Ok(recovered) if recovered > 0 => {
                            let recovered_state = db
                                .conn
                                .lock()
                                .ok()
                                .and_then(|conn| {
                                    conn.query_row(
                                        "SELECT COALESCE(sync_state, ''), COALESCE(remote_payment_id, '')
                                         FROM order_payments
                                         WHERE id = ?1",
                                        params![entity_id],
                                        |row| {
                                            Ok((
                                                row.get::<_, String>(0)?,
                                                row.get::<_, String>(1)?,
                                            ))
                                        },
                                    )
                                    .optional()
                                    .ok()
                                    .flatten()
                                });

                            if let Some((sync_state, remote_payment_id)) = recovered_state {
                                if sync_state == "applied" || !remote_payment_id.trim().is_empty() {
                                    info!(
                                        payment_id = %entity_id,
                                        order_id = %local_order_id,
                                        recovered,
                                        "Payment sync conflict resolved from canonical remote payment state"
                                    );
                                    synced += 1;
                                    continue;
                                }
                            }
                        }
                        Ok(_) => {}
                        Err(recovery_error) => {
                            warn!(
                                payment_id = %entity_id,
                                order_id = %local_order_id,
                                error = %recovery_error,
                                "Payment conflict recovery failed"
                            );
                        }
                    }

                    match resolve_duplicate_payment_total_conflict(db, entity_id) {
                        Ok(Some(canonical_payment_id)) => {
                            info!(
                                payment_id = %entity_id,
                                order_id = %local_order_id,
                                canonical_payment_id = %canonical_payment_id,
                                "Payment sync conflict resolved by voiding stale duplicate local payment"
                            );
                            synced += 1;
                            continue;
                        }
                        Ok(None) => {}
                        Err(resolve_error) => {
                            warn!(
                                payment_id = %entity_id,
                                order_id = %local_order_id,
                                error = %resolve_error,
                                "Failed to resolve stale duplicate local payment conflict"
                            );
                        }
                    }

                    match resolve_stale_local_payment_total_conflict(db, entity_id) {
                        Ok(Some(resolution)) => {
                            info!(
                                payment_id = %entity_id,
                                order_id = %resolution.order_id,
                                amount = resolution.amount,
                                outstanding_before = resolution.outstanding_before,
                                "Payment sync conflict resolved by voiding stale unsynced local overpay"
                            );
                            synced += 1;
                            continue;
                        }
                        Ok(None) => {}
                        Err(resolve_error) => {
                            warn!(
                                payment_id = %entity_id,
                                order_id = %local_order_id,
                                error = %resolve_error,
                                "Failed to resolve stale unsynced local overpay payment conflict"
                            );
                        }
                    }
                }

                warn!(payment_id = %entity_id, error = %e, "Payment sync failed");
                if let Ok(conn) = db.conn.lock() {
                    let new_retry = retry_count + 1;
                    let (queue_status, pay_state) = if new_retry >= *max_retries {
                        ("failed", "failed")
                    } else {
                        ("pending", "pending")
                    };
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = ?1, retry_count = ?2, last_error = ?3, updated_at = datetime('now') WHERE id = ?4",
                        params![queue_status, new_retry, e, id],
                    );
                    let _ = conn.execute(
                        "UPDATE order_payments SET sync_state = ?1, sync_retry_count = ?2, sync_last_error = ?3, updated_at = datetime('now') WHERE id = ?4",
                        params![pay_state, new_retry, e, entity_id],
                    );
                }
            }
        }
    }

    synced
}

/// Sync payment adjustment items to `/api/pos/payments/adjustments/sync`.
///
/// Each adjustment is POSTed individually. Adjustments whose parent payment
/// has not synced yet (sync_state != 'applied') are left as deferred.
async fn sync_adjustment_items(
    admin_url: &str,
    api_key: &str,
    terminal_id: &str,
    branch_id: &str,
    db: &DbState,
    items: &[&SyncItem],
) -> usize {
    let mut synced = 0;

    for item in items {
        let (
            id,
            _etype,
            entity_id,
            _operation,
            payload,
            idem_key,
            retry_count,
            max_retries,
            _,
            _,
            _,
        ) = item;
        let data: Value = serde_json::from_str(payload).unwrap_or(serde_json::json!({}));

        let payment_id = data
            .get("paymentId")
            .or_else(|| data.get("payment_id"))
            .and_then(Value::as_str)
            .unwrap_or("");

        if payment_id.is_empty() {
            warn!(adjustment_id = %entity_id, "Adjustment sync: missing paymentId in payload");
            if let Ok(conn) = db.conn.lock() {
                let _ = conn.execute(
                    "UPDATE sync_queue SET status = 'failed', last_error = 'Missing paymentId', updated_at = datetime('now') WHERE id = ?1",
                    params![id],
                );
            }
            continue;
        }

        // Check if the parent payment has synced and capture the canonical remote payment id.
        let (pay_synced, mut remote_payment_id, parent_order_id): (
            bool,
            Option<String>,
            Option<String>,
        ) = match db.conn.lock() {
            Ok(conn) => conn
                .query_row(
                    "SELECT sync_state, remote_payment_id, order_id
                     FROM order_payments
                     WHERE id = ?1",
                    params![payment_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)? == "applied",
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .unwrap_or((false, None, None)),
            Err(_) => (false, None, None),
        };

        if !pay_synced {
            info!(
                adjustment_id = %entity_id,
                payment_id = %payment_id,
                "Adjustment sync deferred: parent payment not yet synced"
            );
            if let Ok(conn) = db.conn.lock() {
                mark_adjustment_waiting_on_parent(
                    &conn,
                    *id,
                    entity_id,
                    ADJUSTMENT_QUEUE_ERROR_PARENT_PAYMENT_NOT_SYNCED,
                    ADJUSTMENT_BLOCKER_PARENT_PAYMENT_NOT_SYNCED,
                );
            }
            continue;
        }

        remote_payment_id = normalize_optional_uuid_str(remote_payment_id.as_deref());
        if remote_payment_id.is_none() {
            if let Some(parent_order_id) = parent_order_id.as_deref() {
                if let Err(recovery_error) = reconcile_remote_payments_for_local_order(
                    db,
                    admin_url,
                    api_key,
                    parent_order_id,
                )
                .await
                {
                    warn!(
                        adjustment_id = %entity_id,
                        payment_id = %payment_id,
                        order_id = %parent_order_id,
                        error = %recovery_error,
                        "Adjustment parent payment recovery failed"
                    );
                }
            }

            remote_payment_id = match db.conn.lock() {
                Ok(conn) => conn
                    .query_row(
                        "SELECT remote_payment_id
                         FROM order_payments
                         WHERE id = ?1",
                        params![payment_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                    .flatten()
                    .and_then(|value| normalize_optional_uuid_str(Some(value.as_str()))),
                Err(_) => None,
            };
        }

        let Some(canonical_payment_id) = remote_payment_id.clone() else {
            info!(
                adjustment_id = %entity_id,
                payment_id = %payment_id,
                "Adjustment sync deferred: parent payment missing canonical remote id"
            );
            if let Ok(conn) = db.conn.lock() {
                mark_adjustment_waiting_on_parent(
                    &conn,
                    *id,
                    entity_id,
                    ADJUSTMENT_QUEUE_ERROR_PARENT_PAYMENT_MISSING_CANONICAL_REMOTE_ID,
                    ADJUSTMENT_BLOCKER_PARENT_PAYMENT_MISSING_CANONICAL_REMOTE_ID,
                );
            }
            continue;
        };

        let (staff_id, staff_shift_id) = match db.conn.lock() {
            Ok(conn) => normalize_adjustment_staff_ids(&conn, &data),
            Err(_) => (None, None),
        };

        // Mark as syncing
        if let Ok(conn) = db.conn.lock() {
            let _ = conn.execute(
                "UPDATE payment_adjustments SET sync_state = 'syncing', updated_at = datetime('now') WHERE id = ?1",
                params![entity_id],
            );
        }

        // Build the POST body without serializing absent optional fields as null.
        let body = build_adjustment_sync_body(
            entity_id,
            payment_id,
            str_any(&data, &["orderId", "order_id"]).as_deref(),
            str_any(&data, &["adjustmentType", "adjustment_type"]).as_deref(),
            num_any(&data, &["amount"]),
            str_any(&data, &["reason"]).as_deref(),
            staff_id.as_deref(),
            staff_shift_id.as_deref(),
            terminal_id,
            branch_id,
            idem_key,
            str_any(&data, &["refundMethod", "refund_method"]).as_deref(),
            str_any(&data, &["cashHandler", "cash_handler"]).as_deref(),
            str_any(&data, &["adjustmentContext", "adjustment_context"]).as_deref(),
            Some(canonical_payment_id.as_str()),
            Some(canonical_payment_id.as_str()),
        );

        match api::fetch_from_admin(
            admin_url,
            api_key,
            "/api/pos/payments/adjustments/sync",
            "POST",
            Some(body),
        )
        .await
        {
            Ok(_resp) => {
                let now = Utc::now().to_rfc3339();
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = 'synced', synced_at = ?1, updated_at = ?1 WHERE id = ?2",
                        params![now, id],
                    );
                    let _ = conn.execute(
                        "UPDATE payment_adjustments SET sync_state = 'applied', sync_retry_count = 0, sync_last_error = NULL, updated_at = ?1 WHERE id = ?2",
                        params![now, entity_id],
                    );
                }
                synced += 1;
            }
            Err(e) => {
                warn!(adjustment_id = %entity_id, error = %e, "Adjustment sync failed");
                if let Ok(conn) = db.conn.lock() {
                    let new_retry = retry_count + 1;
                    let (queue_status, adj_state) = if new_retry >= *max_retries {
                        ("failed", "failed")
                    } else {
                        ("pending", "pending")
                    };
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = ?1, retry_count = ?2, last_error = ?3, updated_at = datetime('now') WHERE id = ?4",
                        params![queue_status, new_retry, e, id],
                    );
                    let _ = conn.execute(
                        "UPDATE payment_adjustments SET sync_state = ?1, sync_retry_count = ?2, sync_last_error = ?3, updated_at = datetime('now') WHERE id = ?4",
                        params![adj_state, new_retry, e, entity_id],
                    );
                }
            }
        }
    }

    synced
}

/// Sync z-report items individually to `/api/pos/z-report/submit`.
///
/// Each z-report is POSTed individually. The server upserts on
/// `(terminal_id, report_date)`, so duplicate submissions are idempotent.
async fn sync_z_report_items(
    admin_url: &str,
    api_key: &str,
    _terminal_id: &str,
    _branch_id: &str,
    db: &DbState,
    items: &[&SyncItem],
) -> usize {
    let mut synced = 0;

    for item in items {
        let (
            id,
            _etype,
            entity_id,
            _operation,
            payload,
            _idem_key,
            retry_count,
            max_retries,
            _,
            _,
            _,
        ) = item;
        let data: Value = serde_json::from_str(payload).unwrap_or(serde_json::json!({}));

        // Mark z_report as syncing
        if let Ok(conn) = db.conn.lock() {
            let _ = conn.execute(
                "UPDATE z_reports SET sync_state = 'syncing', updated_at = datetime('now') WHERE id = ?1",
                params![entity_id],
            );
        }

        // The payload already contains terminal_id, branch_id, report_date, report_data
        // as structured by generate_z_report().
        match api::fetch_from_admin(
            admin_url,
            api_key,
            "/api/pos/z-report/submit",
            "POST",
            Some(data),
        )
        .await
        {
            Ok(_resp) => {
                let now = Utc::now().to_rfc3339();
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = 'synced', synced_at = ?1, updated_at = ?1 WHERE id = ?2",
                        params![now, id],
                    );
                    let _ = conn.execute(
                        "UPDATE z_reports SET sync_state = 'applied', sync_retry_count = 0, sync_last_error = NULL, updated_at = ?1 WHERE id = ?2",
                        params![now, entity_id],
                    );
                }
                synced += 1;
                info!(z_report_id = %entity_id, "Z-report synced to admin");
            }
            Err(e) => {
                warn!(z_report_id = %entity_id, error = %e, "Z-report sync failed");
                if let Ok(conn) = db.conn.lock() {
                    let is_historical_conflict = is_historical_z_report_conflict_error(&e);
                    let parked_error = if is_historical_conflict {
                        park_historical_z_report_conflict_error(&e)
                    } else {
                        e.clone()
                    };
                    let new_retry = if is_historical_conflict {
                        *max_retries
                    } else {
                        retry_count + 1
                    };
                    let (queue_status, zr_state) = if is_historical_conflict {
                        ("failed", "failed")
                    } else if new_retry >= *max_retries {
                        ("failed", "failed")
                    } else {
                        ("pending", "pending")
                    };
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = ?1, retry_count = ?2, last_error = ?3, updated_at = datetime('now') WHERE id = ?4",
                        params![queue_status, new_retry, parked_error, id],
                    );
                    let _ = conn.execute(
                        "UPDATE z_reports SET sync_state = ?1, sync_retry_count = ?2, sync_last_error = ?3, updated_at = datetime('now') WHERE id = ?4",
                        params![zr_state, new_retry, parked_error, entity_id],
                    );
                }
            }
        }
    }

    synced
}

/// Sync loyalty transaction items to the admin dashboard.
///
/// Each loyalty transaction is POSTed individually to either
/// `/api/pos/loyalty/earn` or `/api/pos/loyalty/redeem` depending on the
/// `transaction_type` field in the sync payload. On success the local
/// `loyalty_transactions` row is marked `sync_state = 'applied'`.
async fn sync_loyalty_items(
    admin_url: &str,
    api_key: &str,
    db: &DbState,
    items: &[&SyncItem],
) -> usize {
    let mut synced = 0;

    for item in items {
        let (
            id,
            _etype,
            entity_id,
            _operation,
            payload,
            _idem_key,
            retry_count,
            max_retries,
            _,
            _,
            _,
        ) = item;

        match sync_loyalty_transaction(admin_url, api_key, entity_id, payload).await {
            Ok(_) => {
                let now = Utc::now().to_rfc3339();
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = 'synced', synced_at = ?1, updated_at = ?1 WHERE id = ?2",
                        params![now, id],
                    );
                    let _ = conn.execute(
                        "UPDATE loyalty_transactions SET sync_state = 'applied' WHERE id = ?1",
                        params![entity_id],
                    );
                }
                synced += 1;
                info!(loyalty_tx_id = %entity_id, "Loyalty transaction synced to admin");
            }
            Err(e) => {
                warn!(loyalty_tx_id = %entity_id, error = %e, "Loyalty sync failed");
                if let Ok(conn) = db.conn.lock() {
                    let new_retry = retry_count + 1;
                    let (queue_status, lt_state) = if new_retry >= *max_retries {
                        ("failed", "failed")
                    } else {
                        ("pending", "pending")
                    };
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = ?1, retry_count = ?2, last_error = ?3, updated_at = datetime('now') WHERE id = ?4",
                        params![queue_status, new_retry, e, id],
                    );
                    let _ = conn.execute(
                        "UPDATE loyalty_transactions SET sync_state = ?1 WHERE id = ?2",
                        params![lt_state, entity_id],
                    );
                }
            }
        }
    }

    synced
}

/// Sync a single loyalty transaction to the admin dashboard.
///
/// Routes the transaction to `/api/pos/loyalty/earn` or `/api/pos/loyalty/redeem`
/// based on the `transaction_type` field in the payload. Returns `Ok(())` on
/// success or an error string describing the failure.
async fn sync_loyalty_transaction(
    admin_url: &str,
    api_key: &str,
    entity_id: &str,
    raw_payload: &str,
) -> Result<(), String> {
    let payload: Value = serde_json::from_str(raw_payload)
        .map_err(|e| format!("Invalid loyalty sync payload: {e}"))?;

    let tx_type = payload
        .get("transaction_type")
        .and_then(|v| v.as_str())
        .unwrap_or("earn");

    let endpoint = match tx_type {
        "earn" => "/api/pos/loyalty/earn",
        "redeem" => "/api/pos/loyalty/redeem",
        _ => return Err(format!("Unknown loyalty transaction type: {tx_type}")),
    };

    let body = match tx_type {
        "earn" => {
            serde_json::json!({
                "customer_id": payload.get("customer_id").and_then(|v| v.as_str()).unwrap_or_default(),
                "order_id": payload.get("order_id").and_then(|v| v.as_str()),
                "amount": payload.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0),
                "description": payload.get("description").and_then(|v| v.as_str()),
            })
        }
        "redeem" => {
            // The local payload stores points as negative; the admin API expects a positive value
            let points = payload
                .get("points")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                .abs();
            serde_json::json!({
                "customer_id": payload.get("customer_id").and_then(|v| v.as_str()).unwrap_or_default(),
                "points": points,
                "order_id": payload.get("order_id").and_then(|v| v.as_str()),
                "description": payload.get("description").and_then(|v| v.as_str()),
            })
        }
        _ => unreachable!(),
    };

    let resp = api::fetch_from_admin(admin_url, api_key, endpoint, "POST", Some(body))
        .await
        .map_err(|e| format!("Loyalty sync HTTP error for {entity_id}: {e}"))?;

    let success = resp
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !success {
        let error_msg = resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error");
        return Err(format!("Loyalty sync rejected: {error_msg}"));
    }

    Ok(())
}

/// Mark a batch of items as failed/deferred.
///
/// For backpressure (`HTTP 429` / queue-backed-up), do not increment retries.
fn mark_order_batch_failures(
    db: &DbState,
    order_items: &[&SyncItem],
    original_error: &str,
    fallback_outcome: &DirectOrderFallbackOutcome,
) -> Result<bool, String> {
    let failed_items: Vec<&SyncItem> = if fallback_outcome.synced_queue_ids.is_empty() {
        order_items.to_vec()
    } else {
        order_items
            .iter()
            .copied()
            .filter(|item| !fallback_outcome.synced_queue_ids.contains(&item.0))
            .collect()
    };

    if failed_items.is_empty() {
        return Ok(false);
    }

    let mut had_non_backpressure_failure = false;
    let mut original_error_items: Vec<&SyncItem> = Vec::new();

    for &item in &failed_items {
        if let Some(error) = fallback_outcome.permanent_failures.get(&item.0) {
            let single = [item];
            let _ = mark_batch_failed(db, &single, error)?;
            had_non_backpressure_failure = true;
            continue;
        }

        if let Some(error) = fallback_outcome.transient_failures.get(&item.0) {
            let single = [item];
            let outcome = mark_batch_failed(db, &single, error)?;
            if !outcome.backpressure_deferred {
                had_non_backpressure_failure = true;
            }
            continue;
        }

        original_error_items.push(item);
    }

    if !original_error_items.is_empty() {
        let outcome = mark_batch_failed(db, &original_error_items, original_error)?;
        if !outcome.backpressure_deferred {
            had_non_backpressure_failure = true;
        }
    }

    Ok(had_non_backpressure_failure)
}

fn mark_batch_failed(
    db: &DbState,
    items: &[&SyncItem],
    error: &str,
) -> Result<BatchFailureResult, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let is_backpressure = is_backpressure_error(error);
    let retry_after_secs = extract_retry_after_seconds(error).unwrap_or(5).max(1);

    for item in items {
        let (id, _, _, _, _, _, retry_count, max_retries, _, retry_delay_ms, _) = item;
        if is_backpressure {
            let delay_ms = (retry_after_secs * 1000).clamp(1_000, MAX_RETRY_DELAY_MS);
            let next_retry_at = schedule_next_retry(delay_ms, *id);
            let _ = conn.execute(
                "UPDATE sync_queue
                 SET status = 'pending',
                     next_retry_at = ?1,
                     retry_delay_ms = ?2,
                     last_error = ?3,
                     updated_at = datetime('now')
                 WHERE id = ?4",
                params![next_retry_at, delay_ms, error, id],
            );
            continue;
        }

        let is_permanent = is_permanent_order_sync_error(error);
        let new_count = retry_count + 1;
        let exhausted = is_permanent || new_count >= *max_retries;
        let new_status = if exhausted { "failed" } else { "pending" };
        let next_delay =
            ((*retry_delay_ms).max(DEFAULT_RETRY_DELAY_MS) * 2).min(MAX_RETRY_DELAY_MS);
        let next_retry_at = if exhausted {
            None
        } else {
            Some(schedule_next_retry(next_delay, *id))
        };
        let _ = conn.execute(
            "UPDATE sync_queue
             SET status = ?1,
                 retry_count = ?2,
                 next_retry_at = ?3,
                 retry_delay_ms = ?4,
                 last_error = ?5,
                 updated_at = datetime('now')
             WHERE id = ?6",
            params![new_status, new_count, next_retry_at, next_delay, error, id],
        );

        // When an order is permanently failed, cascade to dependent payments
        // and adjustments so they don't sit in deferred/waiting_parent forever.
        if exhausted {
            let entity_id_str: &str = &item.2;
            let cascade_error = format!("Parent order sync failed: {error}");
            let cascaded = conn
                .execute(
                    "UPDATE sync_queue
                     SET status = 'failed',
                         last_error = ?1,
                         updated_at = datetime('now')
                     WHERE entity_type IN ('order_payment', 'payment_adjustment')
                       AND status IN ('deferred', 'waiting_parent')
                       AND payload LIKE '%' || ?2 || '%'",
                    params![cascade_error, entity_id_str],
                )
                .unwrap_or(0);
            if cascaded > 0 {
                warn!(
                    order_entity_id = %entity_id_str,
                    cascaded_items = cascaded,
                    "Cascaded order failure to dependent payments/adjustments"
                );
            }
        }
    }
    Ok(BatchFailureResult {
        backpressure_deferred: is_backpressure,
    })
}

/// Build sync status JSON for event emission (avoids needing SyncState ref).
fn get_sync_status_for_event(
    db: &DbState,
    last_sync: &std::sync::Mutex<Option<String>>,
    is_online: bool,
) -> Value {
    let (
        pending,
        queued_remote,
        errors,
        in_progress,
        backpressure_deferred,
        oldest_next_retry_at,
        financial_stats,
        last_queue_failure,
        historical_z_report_conflicts,
    ) = match db.conn.lock() {
        Ok(conn) => {
            let _ = cleanup_order_update_queue_rows(&conn, None);
            let historical_pattern = historical_z_report_conflict_pattern();
            let p: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sync_queue WHERE status IN ('pending', 'in_progress')",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let q: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sync_queue WHERE status = 'queued_remote'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let e: i64 = conn
                .query_row(
                    "SELECT COUNT(*)
                     FROM sync_queue
                     WHERE status = 'failed'
                       AND NOT (
                            entity_type = 'z_report'
                            AND last_error LIKE ?1
                       )",
                    params![historical_pattern.clone()],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let ip: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sync_queue WHERE status = 'in_progress'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let b: i64 = conn
                .query_row(
                    "SELECT COUNT(*)
                     FROM sync_queue
                     WHERE status IN ('pending', 'queued_remote')
                       AND next_retry_at IS NOT NULL
                       AND julianday(next_retry_at) > julianday('now')
                       AND last_error IS NOT NULL
                       AND (
                            lower(last_error) LIKE '%429%'
                            OR lower(last_error) LIKE '%queue is backed up%'
                            OR lower(last_error) LIKE '%retry later%'
                       )",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let oldest: Option<String> = conn
                .query_row(
                    "SELECT MIN(next_retry_at)
                     FROM sync_queue
                     WHERE status IN ('pending', 'queued_remote')
                       AND next_retry_at IS NOT NULL",
                    [],
                    |row| row.get(0),
                )
                .ok()
                .flatten();
            let financial = collect_financial_sync_stats(&conn);
            let last_failure = extract_last_queue_failure_snapshot(&conn).map(|s| s.to_json());
            let historical_conflicts = count_historical_z_report_conflicts(&conn);
            (
                p,
                q,
                e,
                ip,
                b,
                oldest,
                financial,
                last_failure,
                historical_conflicts,
            )
        }
        Err(_) => (0, 0, 0, 0, 0, None, FinancialSyncStats::default(), None, 0),
    };

    let last = last_sync.lock().ok().and_then(|g| g.clone());
    let pending_total = pending + queued_remote;

    serde_json::json!({
        "isOnline": is_online,
        "lastSync": last,
        "lastSyncAt": last,
        "pendingItems": pending_total,
        "pendingChanges": pending_total,
        "syncInProgress": in_progress > 0,
        "error": if errors > 0 {
            Value::String("sync_queue_failed_items".to_string())
        } else {
            Value::Null
        },
        "syncErrors": errors,
        "queuedRemote": queued_remote,
        "backpressureDeferred": backpressure_deferred,
        "oldestNextRetryAt": oldest_next_retry_at,
        "lastQueueFailure": last_queue_failure,
        "historicalZReportConflicts": historical_z_report_conflicts,
        "pendingPaymentItems": financial_stats.pending_payment_items(),
        "failedPaymentItems": financial_stats.failed_payment_items(),
        "financialStats": financial_stats.to_json(),
    })
}

// ---------------------------------------------------------------------------
// Payment reconciliation
// ---------------------------------------------------------------------------

/// Promote deferred payments whose parent order now has a supabase_id.
///
/// This runs once per sync tick. It finds `order_payments` with
/// `sync_state = 'waiting_parent'` where the parent order has a non-null
/// `supabase_id`, and transitions them to `sync_state = 'pending'` while
/// also promoting their `sync_queue` row from `deferred` to `pending`.
///
/// This handles the case where the app restarts between order sync and
/// payment sync — the periodic sweep picks them up.
fn reconcile_deferred_payments(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Find waiting_parent payments whose order now has supabase_id
    let mut stmt = conn
        .prepare(
            "SELECT op.id, op.order_id
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE op.sync_state = 'waiting_parent'
               AND o.supabase_id IS NOT NULL
               AND o.supabase_id != ''",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        return Ok(0);
    }

    let now = Utc::now().to_rfc3339();
    let mut promoted = 0;

    for (payment_id, order_id) in &rows {
        // Promote the payment record
        let _ = conn.execute(
            "UPDATE order_payments SET sync_state = 'pending', updated_at = ?1
             WHERE id = ?2 AND sync_state = 'waiting_parent'",
            params![now, payment_id],
        );

        // Promote the corresponding sync_queue entry
        let _ = conn.execute(
            "UPDATE sync_queue SET status = 'pending', updated_at = datetime('now')
             WHERE entity_type = 'payment'
               AND entity_id = ?1
               AND status = 'deferred'",
            params![payment_id],
        );

        info!(
            payment_id = %payment_id,
            order_id = %order_id,
            "Reconciled deferred payment -> pending (parent order synced)"
        );
        promoted += 1;
    }

    if promoted > 0 {
        info!("Payment reconciliation: promoted {promoted} deferred payments");
    }

    Ok(promoted)
}

/// Reconcile deferred financial items whose dependency is now ready.
///
/// Called once per sync loop iteration, before `run_sync_cycle`, mirroring the
/// pattern used by `reconcile_deferred_payments` for order→payment dependencies.
fn reconcile_failed_shift_bound_financials(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, entity_type, entity_id, payload, last_error
             FROM sync_queue
             WHERE entity_type IN ('shift_expense', 'staff_payment')
               AND status = 'failed'",
        )
        .map_err(|e| format!("prepare failed shift-bound financial selector: {e}"))?;

    let rows: Vec<(i64, String, String, String, Option<String>)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| format!("query failed shift-bound financial selector: {e}"))?
        .filter_map(Result::ok)
        .collect();
    drop(stmt);

    if rows.is_empty() {
        return Ok(0);
    }

    let now = Utc::now().to_rfc3339();
    let mut recovered = 0usize;

    for (queue_id, entity_type, entity_id, payload, last_error) in &rows {
        let dependency =
            ensure_financial_parent_shift_dependency_recovery(&conn, entity_type, payload, &now)?;

        let Some(dependency) = dependency else {
            continue;
        };

        let block_reason = dependency.dependency_block_reason.clone();
        let next_status = match block_reason.as_deref() {
            None => Some("pending"),
            Some(WAITING_FOR_CASHIER_SHIFT_SYNC_REASON) => Some("deferred"),
            Some(CASHIER_SHIFT_SYNC_NEEDS_ATTENTION_REASON)
            | Some(CASHIER_SHIFT_MISSING_LOCALLY_REASON) => None,
            Some(_) => Some("deferred"),
        };

        if let Some(status) = next_status {
            let last_error = if status == "deferred" {
                block_reason.clone()
            } else {
                None
            };
            conn.execute(
                "UPDATE sync_queue
                 SET status = ?1,
                     retry_count = 0,
                     last_error = ?2,
                     next_retry_at = NULL,
                     updated_at = ?3
                 WHERE id = ?4
                   AND status = 'failed'",
                params![status, last_error, now, queue_id],
            )
            .map_err(|e| format!("recover failed shift-bound financial row: {e}"))?;
            align_local_financial_sync_state(&conn, entity_type, entity_id, status, &now);
            recovered += 1;
            continue;
        }

        if last_error.as_deref() != block_reason.as_deref() {
            conn.execute(
                "UPDATE sync_queue
                 SET last_error = ?1,
                     updated_at = ?2
                 WHERE id = ?3
                   AND status = 'failed'",
                params![block_reason, now, queue_id],
            )
            .map_err(|e| format!("refresh failed shift-bound financial blocker reason: {e}"))?;
        }
    }

    Ok(recovered)
}

fn reconcile_deferred_financials(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, entity_type, entity_id, payload, last_error
             FROM sync_queue
             WHERE entity_type IN ('shift_expense', 'staff_payment', 'driver_earning', 'driver_earnings')
               AND status = 'deferred'",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(i64, String, String, String, Option<String>)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        return Ok(0);
    }

    let now = Utc::now().to_rfc3339();
    let mut promoted = 0;

    for (queue_id, entity_type, entity_id, payload, last_error) in &rows {
        if is_driver_earning_entity(entity_type) {
            let should_promote = extract_order_id_from_financial_payload(payload)
                .as_deref()
                .and_then(|order_ref| local_order_has_remote_identity(&conn, order_ref))
                .unwrap_or(true);

            if should_promote {
                let _ = conn.execute(
                    "UPDATE sync_queue SET status = 'pending', updated_at = ?1
                     WHERE id = ?2 AND status = 'deferred'",
                    params![now, queue_id],
                );
                info!(
                    entity_type = %entity_type,
                    entity_id = %entity_id,
                    "Reconciled deferred driver earning -> pending (order synced)"
                );
                promoted += 1;
            }

            continue;
        }

        let shift_id = match extract_shift_id_from_financial_payload(payload) {
            Some(sid) => sid,
            None => {
                // No shift reference — promote to let server validate
                let _ = conn.execute(
                    "UPDATE sync_queue SET status = 'pending', updated_at = ?1
                     WHERE id = ?2 AND status = 'deferred'",
                    params![now, queue_id],
                );
                promoted += 1;
                continue;
            }
        };

        let dependency =
            ensure_financial_parent_shift_dependency_recovery(&conn, entity_type, payload, &now)?;

        if matches!(
            dependency
                .as_ref()
                .and_then(|value| value.parent_shift_sync_status.as_deref()),
            Some("synced")
        ) {
            let _ = conn.execute(
                "UPDATE sync_queue SET status = 'pending', updated_at = ?1
                 WHERE id = ?2 AND status = 'deferred'",
                params![now, queue_id],
            );
            info!(
                entity_type = %entity_type,
                entity_id = %entity_id,
                shift_id = %shift_id,
                "Reconciled deferred financial -> pending (parent shift synced)"
            );
            promoted += 1;
        } else {
            let block_reason = dependency
                .and_then(|value| value.dependency_block_reason)
                .unwrap_or_else(|| WAITING_FOR_CASHIER_SHIFT_SYNC_REASON.to_string());
            if last_error.as_deref() != Some(block_reason.as_str()) {
                let _ = conn.execute(
                    "UPDATE sync_queue
                     SET last_error = ?1,
                         updated_at = ?2
                     WHERE id = ?3 AND status = 'deferred'",
                    params![block_reason, now, queue_id],
                );
            }
        }
    }

    if promoted > 0 {
        info!("Financial reconciliation: promoted {promoted} deferred financial items");
    }

    Ok(promoted)
}

/// Inline promotion: after a shift syncs successfully, immediately promote any
/// deferred strict shift-bound financial items that reference that shift.
fn promote_financials_for_shift(conn: &rusqlite::Connection, shift_id: &str) {
    let now = Utc::now().to_rfc3339();
    let updated = conn
        .execute(
            "UPDATE sync_queue
             SET status = 'pending', updated_at = ?1
             WHERE entity_type IN ('shift_expense', 'shift_expenses', 'staff_payment', 'staff_payments')
               AND status = 'deferred'
               AND payload LIKE '%' || ?2 || '%'",
            params![now, shift_id],
        )
        .unwrap_or(0);

    if updated > 0 {
        info!(
            shift_id = %shift_id,
            count = updated,
            "Inline-promoted deferred financial items after shift sync"
        );
    }
}

#[derive(Debug, Clone)]
struct LocalHistoricalZReportRow {
    id: String,
    branch_id: String,
    terminal_id: String,
    report_date: String,
    report_json: Value,
    sync_state: String,
    sort_key: String,
}

#[derive(Debug, Clone)]
struct RemoteHistoricalZReportRow {
    report_id: String,
    period_start_at: String,
    period_end_at: String,
}

fn json_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}

fn normalize_report_timestamp_for_compare(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value).ok().map(|parsed| {
        parsed
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}

fn report_timestamps_match(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            normalize_report_timestamp_for_compare(left)
                == normalize_report_timestamp_for_compare(right)
        }
        (None, None) => true,
        _ => false,
    }
}

fn local_z_report_period_bounds(
    row: &LocalHistoricalZReportRow,
) -> (Option<String>, Option<String>) {
    (
        row.report_json
            .get("period")
            .and_then(|period| json_string_field(period, &["start"]))
            .or_else(|| json_string_field(&row.report_json, &["periodStart", "period_start"])),
        row.report_json
            .get("period")
            .and_then(|period| json_string_field(period, &["end"]))
            .or_else(|| json_string_field(&row.report_json, &["periodEnd", "period_end"])),
    )
}

fn load_historical_local_z_report_rows(
    conn: &rusqlite::Connection,
) -> Result<HashMap<String, Vec<LocalHistoricalZReportRow>>, String> {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let mut stmt = conn
        .prepare(
            "SELECT id,
                    COALESCE(branch_id, ''),
                    COALESCE(terminal_id, ''),
                    report_date,
                    report_json,
                    sync_state,
                    COALESCE(updated_at, generated_at, created_at, '')
             FROM z_reports
             WHERE sync_state != 'applied'
               AND report_date < ?1
             ORDER BY report_date ASC,
                      COALESCE(updated_at, generated_at, created_at, '') DESC,
                      id DESC",
        )
        .map_err(|e| format!("prepare historical local z-report selector: {e}"))?;

    let rows = stmt
        .query_map(params![today], |row| {
            let report_json_str: String = row.get(4)?;
            Ok(LocalHistoricalZReportRow {
                id: row.get(0)?,
                branch_id: row.get(1)?,
                terminal_id: row.get(2)?,
                report_date: row.get(3)?,
                report_json: serde_json::from_str(&report_json_str).unwrap_or_default(),
                sync_state: row.get(5)?,
                sort_key: row.get(6)?,
            })
        })
        .map_err(|e| format!("query historical local z-report selector: {e}"))?;

    let mut grouped = HashMap::new();
    for row in rows {
        let row = row.map_err(|e| format!("collect historical local z-report selector: {e}"))?;
        grouped
            .entry(row.report_date.clone())
            .or_insert_with(Vec::new)
            .push(row);
    }
    Ok(grouped)
}

fn choose_canonical_local_z_report_row(
    rows: &[LocalHistoricalZReportRow],
) -> Option<LocalHistoricalZReportRow> {
    let mut sorted = rows.to_vec();
    sorted.sort_by(|left, right| {
        right
            .sort_key
            .cmp(&left.sort_key)
            .then_with(|| right.id.cmp(&left.id))
    });
    sorted.into_iter().next()
}

fn delete_z_report_queue_rows(
    conn: &rusqlite::Connection,
    ids: &[String],
) -> Result<usize, String> {
    let mut removed = 0usize;
    for id in ids {
        removed += conn
            .execute(
                "DELETE FROM sync_queue WHERE entity_type = 'z_report' AND entity_id = ?1",
                params![id],
            )
            .map_err(|e| format!("delete z-report sync queue rows: {e}"))?;
    }
    Ok(removed)
}

fn delete_local_z_report_rows(
    conn: &rusqlite::Connection,
    ids: &[String],
) -> Result<usize, String> {
    let mut removed = 0usize;
    for id in ids {
        removed += conn
            .execute("DELETE FROM z_reports WHERE id = ?1", params![id])
            .map_err(|e| format!("delete local z-report row: {e}"))?;
    }
    Ok(removed)
}

fn ensure_canonical_local_z_report_queue_row(
    conn: &rusqlite::Connection,
    row: &LocalHistoricalZReportRow,
    now: &str,
) -> Result<(), String> {
    let sync_payload = serde_json::json!({
        "terminal_id": row.terminal_id,
        "branch_id": row.branch_id,
        "report_date": row.report_date,
        "report_data": row.report_json,
    })
    .to_string();

    conn.execute(
        "DELETE FROM sync_queue
         WHERE entity_type = 'z_report'
           AND entity_id = ?1",
        params![row.id],
    )
    .map_err(|e| format!("clear canonical z-report queue row before requeue: {e}"))?;

    conn.execute(
        "INSERT INTO sync_queue (
            entity_type, entity_id, operation, payload, idempotency_key,
            status, retry_count, max_retries, last_error, next_retry_at,
            created_at, updated_at
         ) VALUES (
            'z_report', ?1, 'insert', ?2, ?3,
            'pending', 0, 5, NULL, NULL,
            ?4, ?4
         )",
        params![row.id, sync_payload, format!("zreport:{}", row.id), now],
    )
    .map_err(|e| format!("insert canonical z-report queue row: {e}"))?;

    conn.execute(
        "UPDATE z_reports
         SET sync_state = 'pending',
             sync_retry_count = 0,
             sync_last_error = NULL,
             sync_next_retry_at = NULL,
             updated_at = ?2
         WHERE id = ?1",
        params![row.id, now],
    )
    .map_err(|e| format!("reset canonical local z-report sync state: {e}"))?;

    Ok(())
}

fn apply_historical_z_report_repair(
    conn: &rusqlite::Connection,
    locals_by_date: &HashMap<String, Vec<LocalHistoricalZReportRow>>,
    remote_by_date: &HashMap<String, RemoteHistoricalZReportRow>,
) -> Result<usize, String> {
    let now = Utc::now().to_rfc3339();
    let mut repaired = 0usize;

    for (report_date, rows) in locals_by_date {
        if rows.is_empty() {
            continue;
        }

        if let Some(remote) = remote_by_date.get(report_date) {
            let canonical = rows.iter().find(|row| {
                let (local_start, local_end) = local_z_report_period_bounds(row);
                report_timestamps_match(
                    local_start.as_deref(),
                    Some(remote.period_start_at.as_str()),
                ) && report_timestamps_match(
                    local_end.as_deref(),
                    Some(remote.period_end_at.as_str()),
                )
            });

            if let Some(canonical) = canonical {
                conn.execute(
                    "UPDATE z_reports
                     SET sync_state = 'applied',
                         sync_retry_count = 0,
                         sync_last_error = NULL,
                         sync_next_retry_at = NULL,
                         updated_at = ?2
                     WHERE id = ?1",
                    params![canonical.id, now],
                )
                .map_err(|e| format!("mark canonical local z-report applied: {e}"))?;
                repaired += 1;

                let all_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
                repaired += delete_z_report_queue_rows(conn, &all_ids)?;

                let duplicate_ids = rows
                    .iter()
                    .filter(|row| row.id != canonical.id)
                    .map(|row| row.id.clone())
                    .collect::<Vec<_>>();
                repaired += delete_local_z_report_rows(conn, &duplicate_ids)?;

                info!(
                    report_date = %report_date,
                    server_report_id = %remote.report_id,
                    canonical_local_id = %canonical.id,
                    duplicates_removed = duplicate_ids.len(),
                    "Repaired historical local z-report backlog from finalized server row"
                );
            } else {
                let stale_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
                repaired += delete_z_report_queue_rows(conn, &stale_ids)?;
                repaired += delete_local_z_report_rows(conn, &stale_ids)?;
                warn!(
                    report_date = %report_date,
                    server_report_id = %remote.report_id,
                    stale_rows = stale_ids.len(),
                    "Removed stale local historical z-report rows because the finalized server row is authoritative"
                );
            }
            continue;
        }

        let Some(canonical) = choose_canonical_local_z_report_row(rows) else {
            continue;
        };
        let duplicate_ids = rows
            .iter()
            .filter(|row| row.id != canonical.id)
            .map(|row| row.id.clone())
            .collect::<Vec<_>>();
        repaired += delete_z_report_queue_rows(conn, &duplicate_ids)?;
        repaired += delete_local_z_report_rows(conn, &duplicate_ids)?;
        ensure_canonical_local_z_report_queue_row(conn, &canonical, &now)?;
        repaired += 1;
        info!(
            report_date = %report_date,
            canonical_local_id = %canonical.id,
            duplicates_removed = duplicate_ids.len(),
            previous_sync_state = %canonical.sync_state,
            "Collapsed duplicate local historical z-report rows to a single retryable canonical row"
        );
    }

    Ok(repaired)
}

async fn fetch_remote_historical_z_report_rows(
    admin_url: &str,
    api_key: &str,
    terminal_id: &str,
    branch_id: &str,
    date_from: &str,
    date_to: &str,
) -> Result<HashMap<String, RemoteHistoricalZReportRow>, String> {
    let path = format!(
        "/api/pos/z-report/history?terminal_id={terminal_id}&branch_id={branch_id}&date_from={date_from}&date_to={date_to}&limit=200&page=1"
    );
    let response = api::fetch_from_admin(admin_url, api_key, &path, "GET", None).await?;
    let reports = response
        .get("reports")
        .or_else(|| response.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut remote_by_date = HashMap::new();
    for report in reports {
        let Some(report_date) = json_string_field(&report, &["report_date", "reportDate"]) else {
            continue;
        };
        let Some(period_start_at) =
            json_string_field(&report, &["period_start_at", "periodStartAt"])
        else {
            continue;
        };
        let Some(period_end_at) = json_string_field(&report, &["period_end_at", "periodEndAt"])
        else {
            continue;
        };
        let report_id = json_string_field(&report, &["id"]).unwrap_or_default();

        remote_by_date.insert(
            report_date,
            RemoteHistoricalZReportRow {
                report_id,
                period_start_at,
                period_end_at,
            },
        );
    }

    Ok(remote_by_date)
}

async fn repair_historical_z_report_rows_after_cutoff(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
    terminal_id: &str,
    branch_id: &str,
) -> Result<usize, String> {
    let locals_by_date = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let active_shifts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM staff_shifts WHERE status = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if active_shifts > 0 {
            return Ok(0);
        }
        load_historical_local_z_report_rows(&conn)?
    };

    if locals_by_date.is_empty() {
        return Ok(0);
    }

    let mut dates = locals_by_date.keys().cloned().collect::<Vec<_>>();
    dates.sort();
    let date_from = dates.first().cloned().unwrap_or_default();
    let date_to = dates.last().cloned().unwrap_or_default();
    let remote_by_date = fetch_remote_historical_z_report_rows(
        admin_url,
        api_key,
        terminal_id,
        branch_id,
        date_from.as_str(),
        date_to.as_str(),
    )
    .await?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    apply_historical_z_report_repair(&conn, &locals_by_date, &remote_by_date)
}

/// One-time requeue: recover financial items that failed with "was not found on
/// the backend" due to the missing parent-shift deferral logic. These items will
/// now benefit from the new deferral pre-check.
fn requeue_failed_financial_shift_rows(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let requeued = conn
        .execute(
            "UPDATE sync_queue
             SET status = 'pending',
                 retry_count = 0,
                 last_error = NULL,
                 next_retry_at = NULL,
                 updated_at = ?1
             WHERE entity_type IN ('shift_expense', 'staff_payment', 'driver_earning', 'driver_earnings')
               AND status = 'failed'
               AND last_error LIKE '%was not found on the backend%'",
            params![now],
        )
        .map_err(|e| e.to_string())?;

    Ok(requeued)
}

fn requeue_deferred_driver_earning_parent_shift_rows(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let requeued = conn
        .execute(
            "UPDATE sync_queue
             SET status = 'pending',
                 retry_count = 0,
                 last_error = NULL,
                 next_retry_at = NULL,
                 updated_at = ?1
             WHERE entity_type IN ('driver_earning', 'driver_earnings')
               AND status = 'deferred'
               AND last_error = 'Parent shift not yet synced'",
            params![now],
        )
        .map_err(|e| e.to_string())?;

    Ok(requeued)
}

/// One-time recovery: re-enqueue shifts that were wrongly marked as synced
/// locally due to a bug where `sync_shift_batch` discarded per-event server
/// errors. These shifts have `sync_status = 'synced'` in `staff_shifts` but
/// no longer appear in `sync_queue` (their queue rows were also marked synced).
///
/// We reset their `sync_status` to 'pending' and re-insert a sync_queue row
/// so the (now fixed) sync_shift_batch can properly process them.
fn requeue_falsely_synced_shifts(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    // Find shifts marked synced locally that have no pending/synced queue entry.
    // These are shifts that were falsely marked synced because the server response
    // was not checked for per-event errors.
    let mut stmt = conn
        .prepare(
            "SELECT ss.id
             FROM staff_shifts ss
             WHERE ss.sync_status = 'synced'
               AND NOT EXISTS (
                   SELECT 1 FROM sync_queue sq
                   WHERE sq.entity_type = 'shift'
                     AND sq.entity_id = ss.id
                     AND sq.status IN ('pending', 'in_progress', 'deferred')
               )",
        )
        .map_err(|e| e.to_string())?;

    let shift_ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    if shift_ids.is_empty() {
        return Ok(0);
    }

    let mut requeued = 0;
    for shift_id in &shift_ids {
        // Reset the shift sync_status so the sync loop picks it up
        let _ = conn.execute(
            "UPDATE staff_shifts SET sync_status = 'pending', updated_at = ?1 WHERE id = ?2",
            params![now, shift_id],
        );

        // Re-insert a sync_queue row (skip if one already exists for this shift)
        let existing: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'shift' AND entity_id = ?1",
                params![shift_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if existing == 0 && enqueue_reconstructed_shift_sync_row(&conn, shift_id, &now)?.is_some() {
            requeued += 1;
        }
    }

    Ok(requeued)
}

fn requeue_failed_shift_cashier_reference_rows(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let requeued = conn
        .execute(
            "UPDATE sync_queue
             SET status = 'pending',
                 retry_count = 0,
                 last_error = NULL,
                 next_retry_at = NULL,
                 updated_at = ?1
             WHERE entity_type = 'shift'
               AND status = 'failed'
               AND (
                    lower(COALESCE(last_error, '')) LIKE '%transferred_to_cashier_shift_id_fkey%'
                    OR lower(COALESCE(last_error, '')) LIKE '%transfer target cashier shift not found on backend yet%'
               )",
            params![now],
        )
        .map_err(|e| e.to_string())?;

    if requeued > 0 {
        let _ = conn.execute(
            "UPDATE staff_shifts
             SET sync_status = 'pending',
                 updated_at = ?1
             WHERE id IN (
                 SELECT entity_id
                 FROM sync_queue
                 WHERE entity_type = 'shift'
                   AND status = 'pending'
                   AND updated_at = ?1
             )",
            params![now],
        );
    }

    Ok(requeued)
}

fn requeue_failed_adjustment_missing_endpoint_rows(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let requeued = conn
        .execute(
            "UPDATE sync_queue
             SET status = 'pending',
                 retry_count = 0,
                 last_error = NULL,
                 next_retry_at = NULL,
                 updated_at = ?1
             WHERE entity_type = 'payment_adjustment'
               AND status = 'failed'
               AND lower(COALESCE(last_error, '')) LIKE '%/api/pos/payments/adjustments/sync%'
               AND (
                    lower(COALESCE(last_error, '')) LIKE '%404%'
                    OR lower(COALESCE(last_error, '')) LIKE '%not found%'
                    OR lower(COALESCE(last_error, '')) LIKE '%endpoint%'
               )",
            params![now],
        )
        .map_err(|e| e.to_string())?;

    if requeued > 0 {
        let _ = conn.execute(
            "UPDATE payment_adjustments
             SET sync_state = 'pending',
                 sync_retry_count = 0,
                 sync_last_error = NULL,
                 sync_next_retry_at = NULL,
                 updated_at = ?1
             WHERE id IN (
                 SELECT entity_id
                 FROM sync_queue
                 WHERE entity_type = 'payment_adjustment'
                   AND status = 'pending'
                   AND updated_at = ?1
             )",
            params![now],
        );
    }

    Ok(requeued)
}

fn is_legacy_adjustment_validation_failure(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("validation failed")
        && normalized.contains("staff_id")
        && normalized.contains("invalid uuid")
        && normalized.contains("remote_payment_id")
        && normalized.contains("expected string, received null")
        && normalized.contains("canonical_payment_id")
}

fn requeue_failed_adjustment_legacy_validation_rows(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let mut stmt = conn
        .prepare(
            "SELECT id, entity_id, last_error
             FROM sync_queue
             WHERE entity_type = 'payment_adjustment'
               AND status = 'failed'",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(i64, String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|row| row.ok())
        .collect();
    drop(stmt);

    let target_adjustments: Vec<String> = rows
        .into_iter()
        .filter_map(|(_, entity_id, last_error)| {
            last_error
                .as_deref()
                .filter(|error| is_legacy_adjustment_validation_failure(error))
                .map(|_| entity_id)
        })
        .collect();

    if target_adjustments.is_empty() {
        return Ok(0);
    }

    let mut requeued = 0;
    for adjustment_id in &target_adjustments {
        requeued += conn
            .execute(
                "UPDATE sync_queue
                 SET status = 'pending',
                     retry_count = 0,
                     last_error = NULL,
                     next_retry_at = NULL,
                     updated_at = ?1
                 WHERE entity_type = 'payment_adjustment'
                   AND entity_id = ?2
                   AND status = 'failed'",
                params![now, adjustment_id],
            )
            .map_err(|e| e.to_string())?;
    }

    if requeued > 0 {
        let mut adjustment_stmt = conn
            .prepare(
                "UPDATE payment_adjustments
                 SET sync_state = 'pending',
                     sync_retry_count = 0,
                     sync_last_error = NULL,
                     sync_next_retry_at = NULL,
                     updated_at = ?1
                 WHERE id = ?2",
            )
            .map_err(|e| e.to_string())?;
        for adjustment_id in &target_adjustments {
            let _ = adjustment_stmt.execute(params![now, adjustment_id]);
        }
    }

    Ok(requeued)
}

/// Inline reconciliation: after successfully syncing an order that received
/// a supabase_id, immediately promote any waiting_parent payments for that
/// order. This provides low-latency sync for the common case (order + payment
/// in the same sync cycle).
fn promote_payments_for_order(conn: &rusqlite::Connection, order_id: &str) {
    let now = Utc::now().to_rfc3339();

    // Promote order_payments rows
    let updated = conn
        .execute(
            "UPDATE order_payments SET sync_state = 'pending', updated_at = ?1
             WHERE order_id = ?2 AND sync_state = 'waiting_parent'",
            params![now, order_id],
        )
        .unwrap_or(0);

    if updated > 0 {
        // Promote the corresponding sync_queue entries
        let _ = conn.execute(
            "UPDATE sync_queue SET status = 'pending', updated_at = datetime('now')
             WHERE entity_type = 'payment'
               AND status = 'deferred'
               AND entity_id IN (
                   SELECT id FROM order_payments WHERE order_id = ?1
               )",
            params![order_id],
        );

        info!(
            order_id = %order_id,
            count = updated,
            "Inline-promoted {updated} waiting_parent payments after order sync"
        );
    }
}

// ---------------------------------------------------------------------------
// Adjustment reconciliation
// ---------------------------------------------------------------------------

/// Promote deferred adjustments whose parent payment has synced.
///
/// Finds `payment_adjustments` with `sync_state = 'waiting_parent'` whose
/// parent `order_payments` has `sync_state = 'applied'` and a canonical
/// `remote_payment_id`, and transitions them to `sync_state = 'pending'`.
fn reconcile_deferred_adjustments(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT pa.id, pa.payment_id, op.remote_payment_id
             FROM payment_adjustments pa
             JOIN order_payments op ON op.id = pa.payment_id
             WHERE pa.sync_state = 'waiting_parent'
               AND op.sync_state = 'applied'",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(String, String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        return Ok(0);
    }

    let now = Utc::now().to_rfc3339();
    let mut promoted = 0;

    for (adj_id, payment_id, remote_payment_id) in &rows {
        if normalize_optional_uuid_str(remote_payment_id.as_deref()).is_none() {
            continue;
        }

        let _ = conn.execute(
            "UPDATE payment_adjustments
             SET sync_state = 'pending',
                 sync_last_error = NULL,
                 updated_at = ?1
             WHERE id = ?2 AND sync_state = 'waiting_parent'",
            params![now, adj_id],
        );

        let _ = conn.execute(
            "UPDATE sync_queue
             SET status = 'pending',
                 last_error = NULL,
                 updated_at = datetime('now')
             WHERE entity_type = 'payment_adjustment'
               AND entity_id = ?1
               AND status = 'deferred'",
            params![adj_id],
        );

        info!(
            adjustment_id = %adj_id,
            payment_id = %payment_id,
            "Reconciled deferred adjustment -> pending (parent payment synced)"
        );
        promoted += 1;
    }

    if promoted > 0 {
        info!("Adjustment reconciliation: promoted {promoted} deferred adjustments");
    }

    Ok(promoted)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

fn num_field(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::{params, Connection};

    fn test_db() -> DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    fn insert_order_sync_queue_row(db: &DbState, order_id: &str, max_retries: i64) -> i64 {
        let conn = db.conn.lock().unwrap();
        let idem = format!("order:{order_id}:insert");
        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key,
                 status, retry_count, max_retries, retry_delay_ms
             ) VALUES ('order', ?1, 'insert', '{}', ?2, 'pending', 0, ?3, 1000)",
            params![order_id, idem, max_retries],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn load_sync_item(db: &DbState, id: i64) -> SyncItem {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, entity_type, entity_id, operation, payload, idempotency_key,
                    retry_count, max_retries, next_retry_at,
                    COALESCE(retry_delay_ms, 5000), remote_receipt_id
             FROM sync_queue
             WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                ))
            },
        )
        .unwrap()
    }

    fn spawn_single_json_response_server<AssertFn>(
        body: String,
        assert_request: AssertFn,
    ) -> (String, std::thread::JoinHandle<()>)
    where
        AssertFn: FnOnce(&str) + Send + 'static,
    {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let addr = listener.local_addr().expect("mock server address");
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept mock request");
            let mut buffer = vec![0u8; 16 * 1024];
            let bytes_read = stream.read(&mut buffer).expect("read mock request");
            let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
            assert_request(&request);

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write mock response");
        });

        (format!("http://{}", addr), handle)
    }

    fn insert_minimal_order(db: &DbState, order_id: &str, sync_status: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES (?1, '[]', 10.0, 'pending', ?2, datetime('now'), datetime('now'))",
            params![order_id, sync_status],
        )
        .unwrap();
    }

    fn insert_queue_failure_row(
        db: &DbState,
        entity_id: &str,
        status: &str,
        last_error: &str,
        next_retry_at: Option<&str>,
    ) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key,
                 status, retry_count, max_retries, next_retry_at, retry_delay_ms,
                 last_error, updated_at
             ) VALUES (
                 'order', ?1, 'insert', '{}', ?2,
                 ?3, 1, 5, ?4, 1000,
                 ?5, datetime('now')
             )",
            params![
                entity_id,
                format!("order:{entity_id}:failure"),
                status,
                next_retry_at,
                last_error
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn insert_order_update_queue_row(
        db: &DbState,
        entity_id: &str,
        queue_status: &str,
        payload_status: Option<&str>,
        synced_at: Option<&str>,
        last_error: Option<&str>,
    ) -> i64 {
        let conn = db.conn.lock().unwrap();
        let payload = match payload_status {
            Some(status) => serde_json::json!({
                "orderId": entity_id,
                "status": status
            }),
            None => serde_json::json!({
                "orderId": entity_id
            }),
        };
        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key,
                 status, retry_count, max_retries, synced_at, last_error, updated_at
             ) VALUES (
                 'order', ?1, 'update', ?2, ?3,
                 ?4, 1, 5, ?5, ?6, datetime('now')
             )",
            params![
                entity_id,
                payload.to_string(),
                format!("order:{entity_id}:update:{}", Uuid::new_v4()),
                queue_status,
                synced_at,
                last_error,
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn update_order_status(db: &DbState, order_id: &str, status: &str, sync_status: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE orders
             SET status = ?1,
                 sync_status = ?2,
                 updated_at = datetime('now')
             WHERE id = ?3",
            params![status, sync_status, order_id],
        )
        .unwrap();
    }

    fn set_terminal_setting(db: &DbState, key: &str, value: &str) {
        let conn = db.conn.lock().unwrap();
        db::set_setting(&conn, "terminal", key, value).expect("set terminal setting");
    }

    fn insert_sync_queue_row(db: &DbState, entity_type: &str, status: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key,
                 status, retry_count, max_retries, retry_delay_ms
             ) VALUES (?1, ?2, 'insert', '{}', ?3, ?4, 0, 5, 1000)",
            params![
                entity_type,
                format!("{entity_type}-entity"),
                format!("{entity_type}:{}", Uuid::new_v4()),
                status,
            ],
        )
        .unwrap();
    }

    #[test]
    fn test_categorize_sync_item_routes_financial_rows_out_of_order_path() {
        assert_eq!(categorize_sync_item("order"), SyncItemCategory::Order);
        assert_eq!(categorize_sync_item("shift"), SyncItemCategory::Shift);
        assert_eq!(
            categorize_sync_item("shift_expense"),
            SyncItemCategory::Financial
        );
        assert_eq!(
            categorize_sync_item("staff_payment"),
            SyncItemCategory::Financial
        );
        assert_eq!(
            categorize_sync_item("driver_earning"),
            SyncItemCategory::Financial
        );
        assert_eq!(
            categorize_sync_item("driver_earnings"),
            SyncItemCategory::Financial
        );
    }

    #[test]
    fn test_create_order_enqueues_order_receipt_print_job() {
        let db = test_db();
        let payload = serde_json::json!({
            "items": [{ "name": "Coffee", "quantity": 1, "price": 2.5 }],
            "totalAmount": 2.5,
            "subtotal": 2.5,
            "status": "pending",
            "orderType": "pickup"
        });

        let created = create_order(&db, &payload).expect("create order");
        let order_id = created
            .get("orderId")
            .and_then(Value::as_str)
            .expect("order id");

        let conn = db.conn.lock().unwrap();
        let queued_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs
                 WHERE entity_type = 'order_receipt'
                   AND entity_id = ?1
                   AND status = 'pending'",
                params![order_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued_count, 1);
    }

    #[test]
    fn test_create_delivery_order_keeps_neutral_ownership_without_driver_assignment() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'driver-shift-create', 'driver-create', 'Driver Create', 'branch-create', 'terminal-create', 'driver',
                datetime('now'), 20.0, 'active', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        drop(conn);

        let payload = serde_json::json!({
            "items": [{ "name": "Coffee", "quantity": 1, "price": 2.5 }],
            "totalAmount": 2.5,
            "subtotal": 2.5,
            "status": "pending",
            "orderType": "delivery",
            "branchId": "branch-create",
            "terminalId": "terminal-create",
            "staffShiftId": "driver-shift-create",
            "staffId": "driver-create"
        });

        let created = create_order(&db, &payload).expect("create order");
        let order_id = created
            .get("orderId")
            .and_then(Value::as_str)
            .expect("order id")
            .to_string();

        let conn = db.conn.lock().unwrap();
        let (staff_shift_id, staff_id, driver_id): (
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT staff_shift_id, staff_id, driver_id FROM orders WHERE id = ?1",
                params![order_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(staff_shift_id, None);
        assert_eq!(staff_id, None);
        assert_eq!(driver_id, None);

        let receipt_jobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs
                 WHERE entity_type = 'order_receipt'
                   AND entity_id = ?1
                   AND status = 'pending'",
                params![order_id],
                |row| row.get(0),
            )
            .unwrap();
        let slip_jobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs
                 WHERE entity_type = 'delivery_slip'
                   AND entity_id = ?1
                   AND status = 'pending'",
                params![order_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(receipt_jobs, 0);
        assert_eq!(slip_jobs, 1);
    }

    #[test]
    fn test_materialize_remote_order_inserts_missing_local_row() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        let remote_order = serde_json::json!({
            "id": "remote-order-1",
            "order_number": "ORD-REMOTE-1",
            "items": [{ "name": "Toast", "quantity": 2, "price": 3.0 }],
            "total_amount": 6.0,
            "status": "pending",
            "payment_status": "pending",
            "updated_at": "2026-02-23T12:00:00Z"
        });

        let local_id = materialize_remote_order(&conn, &remote_order)
            .expect("materialize remote order")
            .expect("local id");

        let supabase_id: String = conn
            .query_row(
                "SELECT supabase_id FROM orders WHERE id = ?1",
                params![local_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(supabase_id, "remote-order-1");
    }

    #[test]
    fn build_terminal_heartbeat_payload_includes_identity_platform_and_sync_stats() {
        let db = test_db();
        let _ = storage::set_credential("terminal_id", "terminal-heartbeat-1");
        let _ = storage::set_credential("branch_id", "branch-heartbeat-1");
        set_terminal_setting(&db, "terminal_id", "terminal-heartbeat-1");
        set_terminal_setting(&db, "branch_id", "branch-heartbeat-1");
        set_terminal_setting(&db, "name", "Main Counter");
        set_terminal_setting(&db, "location", "Front Desk");

        insert_sync_queue_row(&db, "staff_payment", "pending");
        insert_sync_queue_row(&db, "driver_earning", "failed");

        let sync_state = SyncState::new();
        if let Ok(mut guard) = sync_state.last_sync.lock() {
            *guard = Some("2026-03-22T09:00:00Z".to_string());
        }

        let payload =
            build_terminal_heartbeat_payload(&db, &sync_state, true).expect("heartbeat payload");

        assert_eq!(
            payload.get("terminal_id").and_then(Value::as_str),
            Some("terminal-heartbeat-1")
        );
        assert_eq!(
            payload.get("branch_id").and_then(Value::as_str),
            Some("branch-heartbeat-1")
        );
        assert_eq!(
            payload.get("name").and_then(Value::as_str),
            Some("Main Counter")
        );
        assert_eq!(
            payload.get("location").and_then(Value::as_str),
            Some("Front Desk")
        );
        assert_eq!(
            payload.get("status").and_then(Value::as_str),
            Some("online")
        );
        assert_eq!(
            payload.get("sync_status").and_then(Value::as_str),
            Some("failed")
        );
        assert_eq!(
            payload
                .pointer("/sync_stats/staff_payments/pending")
                .and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            payload
                .pointer("/sync_stats/driver_earnings/failed")
                .and_then(Value::as_i64),
            Some(1)
        );
    }

    #[test]
    fn test_order_number_match_can_attach_remote_identity_and_hydrate_payment() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, status, order_type,
                payment_status, payment_method, sync_status, created_at, updated_at
             ) VALUES (
                'ord-repair-by-number', 'ORD-REPAIR-100', '[]', 12.0, 'completed', 'pickup',
                'partially_paid', 'split', 'failed', '2026-03-25T05:10:00Z', '2026-03-25T05:10:00Z'
             )",
            [],
        )
        .unwrap();

        let lookup = load_local_order_remote_lookup(&conn, "ord-repair-by-number")
            .expect("load lookup")
            .expect("local order should exist");
        let remote_order = serde_json::json!({
            "id": "remote-order-repair-100",
            "order_number": "ORD-REPAIR-100",
            "payment_status": "paid",
            "payment_method": "cash",
            "status": "completed",
            "total_amount": 6.0,
            "subtotal": 6.0,
            "discount_amount": 0.0,
            "delivery_fee": 0.0,
            "updated_at": "2026-03-25T05:12:00Z"
        });
        let remote_orders = vec![remote_order.clone()];
        assert_eq!(
            select_remote_order_match(&lookup, &remote_orders)
                .and_then(|matched| str_any(matched, &["id"])),
            Some("remote-order-repair-100".to_string())
        );

        let attached = attach_remote_order_identity_to_local_order(
            &conn,
            "ord-repair-by-number",
            &remote_order,
            "2026-03-25T05:12:30Z",
        )
        .expect("attach remote identity");
        assert_eq!(attached.as_deref(), Some("remote-order-repair-100"));

        let snapshot_changed = sync_remote_order_snapshot_into_local(
            &conn,
            "ord-repair-by-number",
            &remote_order,
            "2026-03-25T05:12:30Z",
        )
        .expect("sync remote order snapshot");
        assert_eq!(snapshot_changed, 1);

        let remote_payment = serde_json::json!({
            "id": "remote-payment-repair-100",
            "order_id": "remote-order-repair-100",
            "amount": 6.0,
            "payment_method": "cash",
            "currency": "EUR",
            "created_at": "2026-03-25T05:12:35Z",
            "updated_at": "2026-03-25T05:12:35Z"
        });
        let changed =
            sync_remote_payment_into_local(&conn, &remote_payment).expect("sync remote payment");
        assert_eq!(changed, 1);

        let (supabase_id, total_amount, payment_status, payment_method, payment_count): (
            Option<String>,
            f64,
            String,
            String,
            i64,
        ) = conn
            .query_row(
                "SELECT
                     supabase_id,
                     total_amount,
                     payment_status,
                     payment_method,
                     (SELECT COUNT(*) FROM order_payments WHERE order_id = 'ord-repair-by-number')
                 FROM orders
                 WHERE id = 'ord-repair-by-number'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(supabase_id.as_deref(), Some("remote-order-repair-100"));
        assert_eq!(total_amount, 6.0);
        assert_eq!(payment_status, "paid");
        assert_eq!(payment_method, "cash");
        assert_eq!(payment_count, 1);
    }

    #[test]
    fn test_build_remote_order_repair_since_cursor_uses_previous_day_of_updated_at() {
        let lookup = LocalOrderRemoteLookup {
            local_order_id: "ord-repair-window".to_string(),
            supabase_id: Some("remote-order-repair-window".to_string()),
            order_number: Some("ORD-REPAIR-WINDOW".to_string()),
            created_at: Some("2026-03-23T04:15:00Z".to_string()),
            updated_at: Some("2026-03-25T05:10:00Z".to_string()),
        };

        let since_cursor = build_remote_order_repair_since_cursor(&lookup);
        assert_eq!(since_cursor, "2026-03-24T05:10:00Z");
    }

    #[test]
    fn terminal_heartbeat_sender_skips_offline_and_does_not_mutate_sync_queue_on_failure() {
        let db = test_db();
        let _ = storage::set_credential("terminal_id", "terminal-heartbeat-2");
        let _ = storage::set_credential("branch_id", "branch-heartbeat-2");
        set_terminal_setting(&db, "terminal_id", "terminal-heartbeat-2");
        set_terminal_setting(&db, "branch_id", "branch-heartbeat-2");
        insert_sync_queue_row(&db, "payment", "pending");

        let sync_state = SyncState::new();
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        let call_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let offline_calls = call_count.clone();
        let offline_result = runtime.block_on(send_terminal_heartbeat_with_sender(
            &db,
            &sync_state,
            false,
            move |_| {
                let offline_calls = offline_calls.clone();
                async move {
                    offline_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(serde_json::json!({ "success": true }))
                }
            },
        ));
        assert_eq!(offline_result.expect("offline heartbeat result"), false);
        assert_eq!(call_count.load(Ordering::SeqCst), 0);

        let failure_calls = call_count.clone();
        let failed_result = runtime.block_on(send_terminal_heartbeat_with_sender(
            &db,
            &sync_state,
            true,
            move |_| {
                let failure_calls = failure_calls.clone();
                async move {
                    failure_calls.fetch_add(1, Ordering::SeqCst);
                    Err("heartbeat failed".to_string())
                }
            },
        ));
        assert_eq!(call_count.load(Ordering::SeqCst), 1);
        assert!(failed_result.is_err());

        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_type = 'payment' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");
    }

    #[test]
    fn test_paid_remote_order_hotfix_reconstructs_missing_local_payment() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        let remote_order = serde_json::json!({
            "id": "remote-paid-order-1",
            "order_number": "ORD-REMOTE-PAID-1",
            "items": [{ "name": "Espresso", "quantity": 1, "price": 4.5 }],
            "total_amount": 4.5,
            "status": "completed",
            "payment_status": "paid",
            "payment_method": "cash",
            "updated_at": "2026-03-20T09:15:00Z",
            "payment_transaction_id": "cash-slip-1"
        });

        let local_id = materialize_remote_order(&conn, &remote_order)
            .expect("materialize remote order")
            .expect("local id");
        let inserted = maybe_reconstruct_paid_remote_order_payment(&conn, &remote_order)
            .expect("reconstruct payment");
        assert_eq!(inserted, 1);

        let (payment_origin, sync_status, sync_state, amount, method, created_at): (
            String,
            String,
            String,
            f64,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT payment_origin, sync_status, sync_state, amount, method, created_at
                 FROM order_payments
                 WHERE order_id = ?1",
                params![local_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(payment_origin, "sync_reconstructed");
        assert_eq!(sync_status, "synced");
        assert_eq!(sync_state, "applied");
        assert_eq!(amount, 4.5);
        assert_eq!(method, "cash");
        assert_eq!(created_at, "2026-03-20T09:15:00Z");
    }

    #[test]
    fn test_remote_payment_sync_hydrates_reconstructed_placeholder_without_duplicate() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        let remote_order = serde_json::json!({
            "id": "remote-paid-order-2",
            "order_number": "ORD-REMOTE-PAID-2",
            "items": [{ "name": "Cappuccino", "quantity": 1, "price": 5.5 }],
            "total_amount": 5.5,
            "status": "completed",
            "payment_status": "paid",
            "payment_method": "card",
            "updated_at": "2026-03-20T10:00:00Z"
        });

        let local_id = materialize_remote_order(&conn, &remote_order)
            .expect("materialize remote order")
            .expect("local id");
        let inserted = maybe_reconstruct_paid_remote_order_payment(&conn, &remote_order)
            .expect("reconstruct payment");
        assert_eq!(inserted, 1);

        let remote_payment = serde_json::json!({
            "id": "payment-remote-2",
            "order_id": "remote-paid-order-2",
            "amount": 5.5,
            "payment_method": "card",
            "external_transaction_id": "txn-remote-2",
            "currency": "EUR",
            "created_at": "2026-03-20T10:00:05Z",
            "updated_at": "2026-03-20T10:00:05Z",
            "items": [
                {
                    "item_index": 0,
                    "item_name": "Cappuccino",
                    "item_quantity": 1,
                    "item_amount": 5.5
                }
            ]
        });

        let changed =
            sync_remote_payment_into_local(&conn, &remote_payment).expect("sync remote payment");
        assert_eq!(changed, 1);

        let payment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM order_payments WHERE order_id = ?1",
                params![local_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment_count, 1);

        let (remote_payment_id, transaction_ref): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT remote_payment_id, transaction_ref
                 FROM order_payments
                 WHERE order_id = ?1",
                params![local_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(remote_payment_id.as_deref(), Some("payment-remote-2"));
        assert_eq!(transaction_ref.as_deref(), Some("txn-remote-2"));

        let item_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM payment_items
                 WHERE order_id = ?1",
                params![local_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(item_count, 1);
    }

    #[test]
    fn test_remote_payment_sync_matches_metadata_local_payment_and_clears_queue_failure() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        let remote_order = serde_json::json!({
            "id": "remote-paid-order-meta",
            "client_order_id": "ord-paid-meta-local",
            "order_number": "ORD-REMOTE-META-1",
            "items": [{ "name": "Toast", "quantity": 1, "price": 6.7 }],
            "total_amount": 6.7,
            "status": "completed",
            "payment_status": "paid",
            "payment_method": "cash",
            "updated_at": "2026-03-20T11:00:00Z"
        });

        let local_order_id = materialize_remote_order(&conn, &remote_order)
            .expect("materialize remote order")
            .expect("local order id");

        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, currency, status,
                sync_status, sync_state, created_at, updated_at
            ) VALUES (
                'pay-meta-local', ?1, 'cash', 6.7, 'EUR', 'completed',
                'failed', 'failed', '2026-03-20T11:00:01Z', '2026-03-20T11:00:01Z'
            )",
            params![local_order_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error
            ) VALUES (
                'payment', 'pay-meta-local', 'insert', '{}', 'payment:pay-meta-local',
                'failed', 5, 5, 'Payment exceeds order total'
            )",
            [],
        )
        .unwrap();

        let remote_payment = serde_json::json!({
            "id": "payment-remote-meta",
            "order_id": "remote-paid-order-meta",
            "amount": 6.7,
            "payment_method": "cash",
            "currency": "EUR",
            "created_at": "2026-03-20T11:00:05Z",
            "updated_at": "2026-03-20T11:00:05Z",
            "metadata": {
                "local_payment_id": "pay-meta-local"
            }
        });

        let changed =
            sync_remote_payment_into_local(&conn, &remote_payment).expect("sync remote payment");
        assert_eq!(changed, 1);

        let (remote_payment_id, sync_state, sync_status): (Option<String>, String, String) = conn
            .query_row(
                "SELECT remote_payment_id, sync_state, sync_status
                 FROM order_payments
                 WHERE id = 'pay-meta-local'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(remote_payment_id.as_deref(), Some("payment-remote-meta"));
        assert_eq!(sync_state, "applied");
        assert_eq!(sync_status, "synced");

        let (queue_status, queue_error): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_error
                 FROM sync_queue
                 WHERE entity_type = 'payment' AND entity_id = 'pay-meta-local'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(queue_status, "synced");
        assert!(queue_error.is_none());
    }

    #[test]
    fn test_reconcile_applied_payment_queue_rows_clears_stale_failed_rows() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'ord-payment-reconcile', 'remote-payment-reconcile', '[]', 13.4, 'completed', 'synced',
                datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, currency, status,
                remote_payment_id, sync_status, sync_state, created_at, updated_at
            ) VALUES (
                'pay-applied-stale', 'ord-payment-reconcile', 'cash', 6.7, 'EUR', 'completed',
                'remote-pay-applied', 'synced', 'applied', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error
            ) VALUES (
                'payment', 'pay-applied-stale', 'insert', '{}', 'payment:pay-applied-stale',
                'failed', 5, 5, 'Payment exceeds order total'
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error
            ) VALUES (
                'order_payments', 'pay-applied-stale', 'insert', '{}', 'order_payments:pay-applied-stale',
                'failed', 5, 5, 'Payment exceeds order total'
            )",
            [],
        )
        .unwrap();
        drop(conn);

        let reconciled = reconcile_applied_payment_queue_rows(&db).expect("reconcile applied rows");
        assert_eq!(reconciled, 1);

        let conn = db.conn.lock().unwrap();
        let (queue_status, queue_error): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_error
                 FROM sync_queue
                 WHERE entity_type = 'payment' AND entity_id = 'pay-applied-stale'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(queue_status, "synced");
        assert!(queue_error.is_none());

        let (legacy_queue_status, legacy_queue_error): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_error
                 FROM sync_queue
                 WHERE entity_type = 'order_payments' AND entity_id = 'pay-applied-stale'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(legacy_queue_status, "synced");
        assert!(legacy_queue_error.is_none());
    }

    #[test]
    fn test_resolve_duplicate_payment_total_conflict_voids_stale_duplicate_and_clears_queue_rows() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, status, payment_status, payment_method,
                payment_transaction_id, sync_status, created_at, updated_at
            ) VALUES (
                'ord-payment-duplicate', 'remote-payment-duplicate', '[]', 6.0, 'completed',
                'partially_paid', 'split', 'pay-duplicate', 'synced', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, currency, status,
                remote_payment_id, sync_status, sync_state, created_at, updated_at
            ) VALUES (
                'pay-canonical', 'ord-payment-duplicate', 'cash', 6.0, 'EUR', 'completed',
                'remote-pay-canonical', 'synced', 'applied', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, currency, status,
                sync_status, sync_state, created_at, updated_at
            ) VALUES (
                'pay-duplicate', 'ord-payment-duplicate', 'cash', 6.0, 'EUR', 'completed',
                'failed', 'failed', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error
            ) VALUES (
                'payment', 'pay-duplicate', 'insert', '{}', 'payment:pay-duplicate',
                'failed', 5, 5, 'Payment exceeds order total'
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error
            ) VALUES (
                'order_payments', 'pay-duplicate', 'insert', '{}', 'order_payments:pay-duplicate',
                'failed', 5, 5, 'Payment exceeds order total'
            )",
            [],
        )
        .unwrap();
        drop(conn);

        let resolved_at = "2026-03-25T11:39:00Z";
        let canonical_payment_id = {
            let conn = db.conn.lock().unwrap();
            resolve_duplicate_payment_total_conflict_with_conn(&conn, "pay-duplicate", resolved_at)
                .expect("resolve duplicate conflict")
        };

        assert_eq!(canonical_payment_id.as_deref(), Some("pay-canonical"));

        let conn = db.conn.lock().unwrap();
        let (status, sync_status, sync_state, void_reason): (
            String,
            String,
            String,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT status, sync_status, sync_state, void_reason
                 FROM order_payments
                 WHERE id = 'pay-duplicate'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(status, "voided");
        assert_eq!(sync_status, "synced");
        assert_eq!(sync_state, "applied");
        assert!(void_reason
            .as_deref()
            .unwrap_or_default()
            .contains("pay-canonical"));

        let synced_queue_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM sync_queue
                 WHERE entity_id = 'pay-duplicate'
                   AND entity_type IN ('payment', 'order_payments')
                   AND status = 'synced'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(synced_queue_rows, 2);

        let (order_payment_status, order_payment_method, order_transaction_id): (
            String,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT payment_status, payment_method, payment_transaction_id
                 FROM orders
                 WHERE id = 'ord-payment-duplicate'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(order_payment_status, "paid");
        assert_eq!(order_payment_method.as_deref(), Some("split"));
        assert_eq!(order_transaction_id.as_deref(), Some("pay-canonical"));
    }

    #[test]
    fn test_resolve_stale_local_payment_total_conflict_voids_unsynced_overpay_and_preserves_other_payments(
    ) {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, status, payment_status, payment_method,
                payment_transaction_id, sync_status, created_at, updated_at
            ) VALUES (
                'ord-payment-stale', 'remote-payment-stale', '[]', 6.9, 'completed',
                'partially_paid', 'split', 'pay-stale', 'synced', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, currency, status,
                remote_payment_id, sync_status, sync_state, created_at, updated_at
            ) VALUES (
                'pay-valid', 'ord-payment-stale', 'cash', 2.0, 'EUR', 'completed',
                'remote-pay-valid', 'synced', 'applied', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, currency, status,
                sync_status, sync_state, created_at, updated_at
            ) VALUES (
                'pay-stale', 'ord-payment-stale', 'cash', 7.4, 'EUR', 'completed',
                'failed', 'failed', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error
            ) VALUES (
                'payment', 'pay-stale', 'insert', '{}', 'payment:pay-stale',
                'failed', 5, 5, 'Payment exceeds order total'
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error
            ) VALUES (
                'order_payments', 'pay-stale', 'insert', '{}', 'order_payments:pay-stale',
                'failed', 5, 5, 'Payment exceeds order total'
            )",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, status, payment_status, payment_method,
                sync_status, created_at, updated_at
            ) VALUES (
                'ord-payment-other', 'remote-payment-other', '[]', 9.5, 'completed',
                'paid', 'cash', 'synced', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, currency, status,
                remote_payment_id, sync_status, sync_state, created_at, updated_at
            ) VALUES (
                'pay-other', 'ord-payment-other', 'cash', 9.5, 'EUR', 'completed',
                'remote-pay-other', 'synced', 'applied', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        drop(conn);

        let resolved_at = "2026-03-28T11:15:00Z";
        let resolution = {
            let conn = db.conn.lock().unwrap();
            resolve_stale_local_payment_total_conflict_with_conn(&conn, "pay-stale", resolved_at)
                .expect("resolve stale local overpay")
        };

        let resolution = resolution.expect("stale local overpay should resolve");
        assert_eq!(resolution.order_id, "ord-payment-stale");
        assert!((resolution.amount - 7.4).abs() < 0.001);
        assert!((resolution.outstanding_before - 4.9).abs() < 0.001);

        let conn = db.conn.lock().unwrap();
        let (status, sync_status, sync_state, void_reason): (
            String,
            String,
            String,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT status, sync_status, sync_state, void_reason
                 FROM order_payments
                 WHERE id = 'pay-stale'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(status, "voided");
        assert_eq!(sync_status, "synced");
        assert_eq!(sync_state, "applied");
        assert!(void_reason
            .as_deref()
            .unwrap_or_default()
            .contains("no canonical remote payment found"));

        let synced_queue_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM sync_queue
                 WHERE entity_id = 'pay-stale'
                   AND entity_type IN ('payment', 'order_payments')
                   AND status = 'synced'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(synced_queue_rows, 2);

        let (order_payment_status, order_payment_method, order_transaction_id): (
            String,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT payment_status, payment_method, payment_transaction_id
                 FROM orders
                 WHERE id = 'ord-payment-stale'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(order_payment_status, "partially_paid");
        assert_eq!(order_payment_method.as_deref(), Some("split"));
        assert_eq!(order_transaction_id.as_deref(), Some("pay-valid"));

        let (other_status, other_remote_id): (String, Option<String>) = conn
            .query_row(
                "SELECT status, remote_payment_id
                 FROM order_payments
                 WHERE id = 'pay-other'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(other_status, "completed");
        assert_eq!(other_remote_id.as_deref(), Some("remote-pay-other"));
    }

    #[test]
    fn test_cleanup_guard_disables_repeated_delete_attempts() {
        STUCK_RECEIPT_CLEANUP_UNSUPPORTED.store(false, Ordering::SeqCst);

        assert!(should_attempt_stuck_receipt_cleanup());
        assert!(disable_stuck_receipt_cleanup_for_session());
        assert!(!should_attempt_stuck_receipt_cleanup());
        assert!(!disable_stuck_receipt_cleanup_for_session());

        STUCK_RECEIPT_CLEANUP_UNSUPPORTED.store(false, Ordering::SeqCst);
    }

    #[test]
    fn test_error_classification_helpers() {
        let backpressure =
            "Queue is backed up. Please retry later. (HTTP 429): {\"queue_age_seconds\": 7200}";
        let permanent = "Invalid menu items: c10e6bdd-3436-4138-b81f-5d0f18354627";
        let transient = "Admin dashboard server error (HTTP 503)";
        let payment_conflict =
            "Payment exceeds order total (HTTP 422): \"Order total: 13.4, tip: 0, existing completed: 13.4, payment: 6.7\"";

        assert!(is_backpressure_error(backpressure));
        assert!(should_use_direct_order_fallback(backpressure));

        assert!(is_permanent_order_sync_error(permanent));
        assert!(!is_transient_order_sync_error(permanent));

        assert!(!is_permanent_order_sync_error(transient));
        assert!(is_transient_order_sync_error(transient));
        assert!(is_payment_total_conflict_error(payment_conflict));
    }

    #[test]
    fn test_extract_last_queue_failure_snapshot_prioritizes_pending_over_failed() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO sync_queue
             (entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, max_retries, last_error)
             VALUES ('order', 'ord-failed', 'insert', '{}', 'idem-failed', 'failed', 3, 3, 'validation failed')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue
             (entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, max_retries, last_error)
             VALUES ('order', 'ord-pending', 'insert', '{}', 'idem-pending', 'pending', 1, 3, 'Admin dashboard server error (HTTP 503)')",
            [],
        )
        .unwrap();

        let snapshot = extract_last_queue_failure_snapshot(&conn).expect("snapshot");
        assert_eq!(snapshot.entity_id, "ord-pending");
        assert_eq!(snapshot.status, "pending");
        assert_eq!(snapshot.classification, "transient");
    }

    #[test]
    fn test_queue_failure_classification_variants() {
        assert_eq!(
            classify_queue_failure(
                "order",
                "Queue is backed up. Please retry later. (HTTP 429)"
            ),
            "backpressure"
        );
        assert_eq!(
            classify_queue_failure("order", "Invalid menu items: stale-item"),
            "permanent"
        );
        assert_eq!(
            classify_queue_failure("order", "Admin dashboard server error (HTTP 503)"),
            "transient"
        );
        assert_eq!(
            classify_queue_failure("payment", "Some unexpected validation branch"),
            "unknown"
        );
    }

    #[test]
    fn test_should_emit_deduped_warn_respects_fingerprint_and_cooldown() {
        if let Some(state) = SYNC_WARN_LOG_DEDUPE_STATE.get() {
            let mut guard = state.lock().unwrap();
            guard.last_fingerprint = None;
            guard.last_warned_at = None;
        }

        let now = Utc::now();
        assert!(should_emit_deduped_warn("order|a", now));
        assert!(!should_emit_deduped_warn(
            "order|a",
            now + ChronoDuration::seconds(10)
        ));
        assert!(should_emit_deduped_warn(
            "order|b",
            now + ChronoDuration::seconds(20)
        ));
        assert!(should_emit_deduped_warn(
            "order|b",
            now + ChronoDuration::seconds(SYNC_LOG_DEDUPE_COOLDOWN_SECS + 30)
        ));
    }

    #[test]
    fn test_ensure_sync_bootstrap_mode_initializes_empty_db_without_cursor() {
        let db = test_db();

        let mode = ensure_sync_bootstrap_mode(&db).expect("bootstrap mode");

        assert_eq!(mode, SYNC_BOOTSTRAP_MODE_EMPTY_DB);
        assert_eq!(get_sync_bootstrap_mode(&db), SYNC_BOOTSTRAP_MODE_EMPTY_DB);
    }

    #[test]
    fn test_ensure_sync_bootstrap_mode_keeps_live_for_empty_db_with_existing_cursor() {
        let db = test_db();
        local_setting_set(&db, "sync", "orders_since", "2026-03-27T10:48:42.000Z")
            .expect("seed orders_since cursor");

        let mode = ensure_sync_bootstrap_mode(&db).expect("bootstrap mode");

        assert_eq!(mode, SYNC_BOOTSTRAP_MODE_LIVE);
        assert_eq!(get_sync_bootstrap_mode(&db), SYNC_BOOTSTRAP_MODE_LIVE);
    }

    #[test]
    fn test_ensure_sync_bootstrap_mode_preserves_explicit_rebuild_mode() {
        let db = test_db();
        set_sync_bootstrap_mode(&db, SYNC_BOOTSTRAP_MODE_REMOTE_REBUILD)
            .expect("set explicit bootstrap mode");

        let mode = ensure_sync_bootstrap_mode(&db).expect("bootstrap mode");

        assert_eq!(mode, SYNC_BOOTSTRAP_MODE_REMOTE_REBUILD);
        assert_eq!(
            get_sync_bootstrap_mode(&db),
            SYNC_BOOTSTRAP_MODE_REMOTE_REBUILD
        );
    }

    #[test]
    fn test_finalize_sync_bootstrap_mode_after_remote_catchup_keeps_live_sticky() {
        let db = test_db();
        local_setting_set(&db, "sync", "orders_since", "2026-03-27T10:48:42.000Z")
            .expect("seed orders_since cursor");
        set_sync_bootstrap_mode(&db, SYNC_BOOTSTRAP_MODE_EMPTY_DB).expect("seed bootstrap mode");

        let outcome = RemoteOrderReconcileOutcome {
            reconciled: 0,
            history_complete: true,
            bootstrap_mode: SYNC_BOOTSTRAP_MODE_EMPTY_DB.to_string(),
        };

        finalize_sync_bootstrap_mode_after_remote_catchup(&db, &outcome)
            .expect("finalize bootstrap mode");

        assert_eq!(get_sync_bootstrap_mode(&db), SYNC_BOOTSTRAP_MODE_LIVE);
        assert_eq!(
            ensure_sync_bootstrap_mode(&db).expect("sticky live bootstrap mode"),
            SYNC_BOOTSTRAP_MODE_LIVE
        );
    }

    #[test]
    fn test_get_sync_status_includes_last_queue_failure() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_queue
             (entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, max_retries, last_error)
             VALUES ('order', 'ord-last-failure', 'insert', '{}', 'idem-last-failure', 'pending', 1, 3, 'Admin dashboard server error (HTTP 503)')",
            [],
        )
        .unwrap();
        drop(conn);

        let sync_state = SyncState::new();
        let status = get_sync_status(&db, &sync_state).expect("status");
        let failure = status
            .get("lastQueueFailure")
            .and_then(Value::as_object)
            .expect("lastQueueFailure object");
        assert_eq!(
            failure.get("entityId").and_then(Value::as_str),
            Some("ord-last-failure")
        );
        assert_eq!(
            failure.get("classification").and_then(Value::as_str),
            Some("transient")
        );
    }

    #[test]
    fn test_get_sync_status_parks_historical_z_report_conflicts_separately() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_queue
             (entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, max_retries, last_error)
             VALUES ('z_report', 'zr-historical', 'insert', '{}', 'idem-zr-historical', 'failed', 5, 5, ?1)",
            params![park_historical_z_report_conflict_error(
                "Finalized Z-report period bounds cannot be changed without a rebuild flow (HTTP 409)"
            )],
        )
        .unwrap();
        drop(conn);

        let sync_state = SyncState::new();
        let status = get_sync_status(&db, &sync_state).expect("status");
        assert_eq!(status["syncErrors"], 0);
        assert_eq!(status["error"], Value::Null);
        assert_eq!(status["historicalZReportConflicts"], 1);
        assert_eq!(status["lastQueueFailure"], Value::Null);
    }

    #[test]
    fn test_apply_historical_z_report_repair_marks_matching_local_row_applied() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, check_out_time, status, sync_status, created_at, updated_at
             ) VALUES (
                'shift-1', 'staff-1', 'Cashier One', 'branch-1', 'terminal-1', 'cashier',
                '2026-03-24T04:01:27Z', '2026-03-25T04:15:55Z', 'closed', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();

        for id in ["zr-a", "zr-b"] {
            conn.execute(
                "INSERT INTO z_reports (
                    id, shift_id, branch_id, terminal_id, report_date, generated_at,
                    gross_sales, net_sales, total_orders, cash_sales, card_sales,
                    refunds_total, voids_total, discounts_total, tips_total,
                    expenses_total, cash_variance, opening_cash, closing_cash, expected_cash,
                    payments_breakdown_json, report_json, sync_state, sync_last_error, sync_retry_count,
                    created_at, updated_at
                 ) VALUES (
                    ?1, 'shift-1', 'branch-1', 'terminal-1', '2026-03-24', '2026-03-25T04:17:02Z',
                    10, 10, 1, 10, 0,
                    0, 0, 0, 0,
                    0, 0, 0, 0, 0,
                    '{}', ?2, 'failed', ?3, 5,
                    '2026-03-25T04:17:02Z', '2026-03-25T04:17:02Z'
                 )",
                params![
                    id,
                    serde_json::json!({
                        "periodStart": "2026-03-24T04:01:27.396883800+00:00",
                        "periodEnd": "2026-03-25T04:15:55.044004500+00:00"
                    })
                    .to_string(),
                    park_historical_z_report_conflict_error(
                        "Finalized Z-report period bounds cannot be changed without a rebuild flow (HTTP 409)"
                    ),
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_queue
                 (entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, max_retries, last_error)
                 VALUES ('z_report', ?1, 'insert', '{}', ?2, 'failed', 5, 5, ?3)",
                params![
                    id,
                    format!("idem-{id}"),
                    park_historical_z_report_conflict_error(
                        "Finalized Z-report period bounds cannot be changed without a rebuild flow (HTTP 409)"
                    ),
                ],
            )
            .unwrap();
        }
        drop(conn);

        let conn = db.conn.lock().unwrap();
        let locals = load_historical_local_z_report_rows(&conn).expect("locals");
        drop(conn);

        let mut remote = HashMap::new();
        remote.insert(
            "2026-03-24".to_string(),
            RemoteHistoricalZReportRow {
                report_id: "server-zr-1".to_string(),
                period_start_at: "2026-03-24T04:01:27.396883800+00:00".to_string(),
                period_end_at: "2026-03-25T04:15:55.044004500+00:00".to_string(),
            },
        );

        let conn = db.conn.lock().unwrap();
        let repaired = apply_historical_z_report_repair(&conn, &locals, &remote).unwrap();
        assert!(repaired >= 2);

        let remaining_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        let applied_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM z_reports WHERE sync_state = 'applied'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let queue_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'z_report'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(remaining_rows, 1);
        assert_eq!(applied_rows, 1);
        assert_eq!(queue_rows, 0);
    }

    #[test]
    fn test_apply_historical_z_report_repair_requeues_one_canonical_local_row_when_server_missing()
    {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, check_out_time, status, sync_status, created_at, updated_at
             ) VALUES (
                'shift-1', 'staff-1', 'Cashier One', 'branch-1', 'terminal-1', 'cashier',
                '2026-03-24T04:01:27Z', '2026-03-25T04:15:55Z', 'closed', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();

        for (id, generated_at) in [
            ("zr-retry-a", "2026-03-25T04:17:02Z"),
            ("zr-retry-b", "2026-03-25T04:17:03Z"),
        ] {
            conn.execute(
                "INSERT INTO z_reports (
                    id, shift_id, branch_id, terminal_id, report_date, generated_at,
                    gross_sales, net_sales, total_orders, cash_sales, card_sales,
                    refunds_total, voids_total, discounts_total, tips_total,
                    expenses_total, cash_variance, opening_cash, closing_cash, expected_cash,
                    payments_breakdown_json, report_json, sync_state, sync_last_error, sync_retry_count,
                    created_at, updated_at
                 ) VALUES (
                    ?1, 'shift-1', 'branch-1', 'terminal-1', '2026-03-24', ?2,
                    10, 10, 1, 10, 0,
                    0, 0, 0, 0,
                    0, 0, 0, 0, 0,
                    '{}', ?3, 'failed', 'Admin dashboard server error (HTTP 500)', 5,
                    ?2, ?2
                 )",
                params![
                    id,
                    generated_at,
                    serde_json::json!({
                        "periodStart": "2026-03-24T04:01:27.396883800+00:00",
                        "periodEnd": "2026-03-25T04:15:55.044004500+00:00"
                    })
                    .to_string(),
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_queue
                 (entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, max_retries, last_error)
                 VALUES ('z_report', ?1, 'insert', '{}', ?2, 'failed', 5, 5, 'Admin dashboard server error (HTTP 500)')",
                params![id, format!("idem-{id}")],
            )
            .unwrap();
        }
        drop(conn);

        let conn = db.conn.lock().unwrap();
        let locals = load_historical_local_z_report_rows(&conn).expect("locals");
        drop(conn);

        let remote = HashMap::new();
        let conn = db.conn.lock().unwrap();
        let repaired = apply_historical_z_report_repair(&conn, &locals, &remote).unwrap();
        assert!(repaired >= 2);

        let remaining_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        let pending_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM z_reports WHERE sync_state = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let queue_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'z_report' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(remaining_rows, 1);
        assert_eq!(pending_rows, 1);
        assert_eq!(queue_rows, 1);
    }

    #[test]
    fn test_cleanup_restores_revived_synced_order_update_rows() {
        let db = test_db();
        insert_minimal_order(&db, "ord-history", "pending");
        let queue_id = insert_order_update_queue_row(
            &db,
            "ord-history",
            "failed",
            Some("confirmed"),
            Some("2026-03-19T00:53:28Z"),
            Some("Permanent status update failure: Invalid status transition"),
        );

        let cleaned = cleanup_order_update_queue_rows_for_order(&db, Some("ord-history"))
            .expect("cleanup should succeed");
        assert_eq!(cleaned, 1);

        let conn = db.conn.lock().unwrap();
        let (status, synced_at, last_error): (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT status, synced_at, last_error FROM sync_queue WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "synced");
        assert!(synced_at.is_some());
        assert_eq!(last_error, None);
    }

    #[test]
    fn test_cleanup_resolves_confirmed_row_when_local_order_is_delivered() {
        let db = test_db();
        insert_minimal_order(&db, "ord-delivered", "pending");
        update_order_status(&db, "ord-delivered", "delivered", "pending");
        let queue_id = insert_order_update_queue_row(
            &db,
            "ord-delivered",
            "failed",
            Some("confirmed"),
            None,
            Some("Permanent status update failure: Invalid status transition"),
        );

        let cleaned = cleanup_order_update_queue_rows_for_order(&db, Some("ord-delivered"))
            .expect("cleanup should succeed");
        assert_eq!(cleaned, 1);

        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "synced");
    }

    #[test]
    fn test_cleanup_resolves_ready_row_when_local_order_is_completed() {
        let db = test_db();
        insert_minimal_order(&db, "ord-completed", "pending");
        update_order_status(&db, "ord-completed", "completed", "pending");
        let queue_id = insert_order_update_queue_row(
            &db,
            "ord-completed",
            "failed",
            Some("ready"),
            None,
            Some("Permanent status update failure: Invalid status transition"),
        );

        let cleaned = cleanup_order_update_queue_rows_for_order(&db, Some("ord-completed"))
            .expect("cleanup should succeed");
        assert_eq!(cleaned, 1);

        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "synced");
    }

    #[test]
    fn test_cleanup_keeps_latest_invalid_cancelled_row_failed() {
        let db = test_db();
        insert_minimal_order(&db, "ord-invalid", "pending");
        update_order_status(&db, "ord-invalid", "cancelled", "pending");
        let queue_id = insert_order_update_queue_row(
            &db,
            "ord-invalid",
            "failed",
            Some("cancelled"),
            None,
            Some("Permanent status update failure: Invalid status transition"),
        );

        let cleaned = cleanup_order_update_queue_rows_for_order(&db, Some("ord-invalid"))
            .expect("cleanup should succeed");
        assert_eq!(cleaned, 0);

        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "failed");
    }

    #[test]
    fn test_cleanup_keeps_missing_status_payload_rows_unless_synced_at_exists() {
        let db = test_db();
        insert_minimal_order(&db, "ord-generic", "pending");
        update_order_status(&db, "ord-generic", "completed", "pending");
        let queue_id = insert_order_update_queue_row(
            &db,
            "ord-generic",
            "failed",
            None,
            None,
            Some("failure"),
        );

        let cleaned = cleanup_order_update_queue_rows_for_order(&db, Some("ord-generic"))
            .expect("cleanup should succeed");
        assert_eq!(cleaned, 0);

        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "failed");
    }

    #[test]
    fn test_sync_status_snapshot_ignores_obsolete_order_update_failure() {
        let db = test_db();
        insert_minimal_order(&db, "ord-obsolete", "pending");
        update_order_status(&db, "ord-obsolete", "delivered", "pending");
        insert_order_update_queue_row(
            &db,
            "ord-obsolete",
            "failed",
            Some("confirmed"),
            None,
            Some("Permanent status update failure: Invalid status transition"),
        );
        insert_queue_failure_row(
            &db,
            "ord-current",
            "pending",
            "Admin dashboard server error (HTTP 503)",
            None,
        );

        let sync_state = SyncState::new();
        let status = get_sync_status(&db, &sync_state).expect("status");
        let failure = status
            .get("lastQueueFailure")
            .and_then(Value::as_object)
            .expect("lastQueueFailure object");
        assert_eq!(
            failure.get("entityId").and_then(Value::as_str),
            Some("ord-current")
        );
    }

    #[test]
    fn test_mark_batch_failed_backpressure_defers_without_retry_increment() {
        let db = test_db();
        let queue_id = insert_order_sync_queue_row(&db, "ord-backpressure", 3);
        let item = load_sync_item(&db, queue_id);
        let item_ref = [&item];

        let backpressure =
            "Queue is backed up. Please retry later. (HTTP 429): {\"retry_after_seconds\":5}";
        let outcome = mark_batch_failed(&db, &item_ref, backpressure).unwrap();
        assert!(outcome.backpressure_deferred);

        let conn = db.conn.lock().unwrap();
        let (status, retry_count, next_retry_at): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, retry_count, next_retry_at FROM sync_queue WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "pending");
        assert_eq!(retry_count, 0);
        assert!(next_retry_at.is_some());
    }

    #[test]
    fn test_mark_order_batch_failures_uses_permanent_fallback_over_backpressure() {
        let db = test_db();
        let queue_id = insert_order_sync_queue_row(&db, "ord-permanent", 3);

        for attempt in 1..=3 {
            let item = load_sync_item(&db, queue_id);
            let item_refs = vec![&item];
            let mut fallback_outcome = DirectOrderFallbackOutcome::default();
            fallback_outcome.record_permanent_failure(
                queue_id,
                "Permanent direct fallback failure: Invalid menu items: stale-item".to_string(),
            );

            let had_non_backpressure = mark_order_batch_failures(
                &db,
                &item_refs,
                "Queue is backed up. Please retry later. (HTTP 429)",
                &fallback_outcome,
            )
            .unwrap();
            assert!(had_non_backpressure);

            let conn = db.conn.lock().unwrap();
            let (status, retry_count): (String, i64) = conn
                .query_row(
                    "SELECT status, retry_count FROM sync_queue WHERE id = ?1",
                    params![queue_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(retry_count, attempt as i64);
            if attempt < 3 {
                assert_eq!(status, "pending");
            } else {
                assert_eq!(status, "failed");
            }
        }
    }

    #[test]
    fn test_mark_order_synced_via_direct_fallback_updates_order_and_promotes_payments() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-direct', '[]', 42.0, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-direct', 'ord-direct', 'card', 42.0, 'pending', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment', 'pay-direct', 'insert', '{}', 'payment:ord-direct', 'deferred')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status, retry_delay_ms)
             VALUES ('order', 'ord-direct', 'insert', '{}', 'order:ord-direct', 'in_progress', 1000)",
            [],
        )
        .unwrap();
        let queue_id = conn.last_insert_rowid();
        drop(conn);

        mark_order_synced_via_direct_fallback(&db, queue_id, "ord-direct", "remote-123").unwrap();

        let conn = db.conn.lock().unwrap();
        let (queue_status, order_status, supabase_id): (String, String, String) = conn
            .query_row(
                "SELECT
                    (SELECT status FROM sync_queue WHERE id = ?1),
                    (SELECT sync_status FROM orders WHERE id = 'ord-direct'),
                    (SELECT COALESCE(supabase_id, '') FROM orders WHERE id = 'ord-direct')",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(queue_status, "synced");
        assert_eq!(order_status, "synced");
        assert_eq!(supabase_id, "remote-123");

        let payment_state: String = conn
            .query_row(
                "SELECT sync_state FROM order_payments WHERE id = 'pay-direct'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payment_queue_status: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_type = 'payment' AND entity_id = 'pay-direct'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment_state, "pending");
        assert_eq!(payment_queue_status, "pending");
    }

    #[test]
    fn test_reconcile_promotes_waiting_parent_payments() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Insert an order without supabase_id
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-a', '[]', 30.0, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        // Insert a payment in waiting_parent state
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-a', 'ord-a', 'cash', 30.0, 'pending', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        // Insert a deferred sync_queue entry
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment', 'pay-a', 'insert', '{}', 'payment:pay-a', 'deferred')",
            [],
        )
        .unwrap();

        drop(conn);

        // Before order has supabase_id, reconciliation should find 0
        let promoted = reconcile_deferred_payments(&db).unwrap();
        assert_eq!(promoted, 0, "no promotions when order has no supabase_id");

        // Simulate order sync by setting supabase_id
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE orders SET supabase_id = 'sup-123', sync_status = 'synced' WHERE id = 'ord-a'",
            [],
        )
        .unwrap();
        drop(conn);

        // Now reconciliation should promote the payment
        let promoted = reconcile_deferred_payments(&db).unwrap();
        assert_eq!(promoted, 1, "should promote 1 payment");

        // Verify payment state
        let conn = db.conn.lock().unwrap();
        let state: String = conn
            .query_row(
                "SELECT sync_state FROM order_payments WHERE id = 'pay-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "pending");

        // Verify sync_queue promoted
        let sq_status: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_id = 'pay-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_status, "pending");

        // Running reconciliation again should be a no-op
        drop(conn);
        let promoted = reconcile_deferred_payments(&db).unwrap();
        assert_eq!(promoted, 0, "no double-promotion");
    }

    #[test]
    fn test_reconcile_promotes_waiting_parent_adjustments() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Insert order + payment (payment synced)
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, supabase_id, created_at, updated_at)
             VALUES ('ord-adj', '[]', 50.0, 'completed', 'synced', 'sup-adj', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, remote_payment_id, created_at, updated_at)
             VALUES (
                'pay-adj',
                'ord-adj',
                'cash',
                50.0,
                'synced',
                'applied',
                '51d7c864-772e-40ea-a440-55dbce8108f0',
                datetime('now'),
                datetime('now')
             )",
            [],
        )
        .unwrap();

        // Insert an adjustment in waiting_parent state
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-1', 'pay-adj', 'ord-adj', 'refund', 10.0, 'Test', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment_adjustment', 'adj-1', 'insert', '{}', 'adjustment:adj-1', 'deferred')",
            [],
        )
        .unwrap();

        drop(conn);

        // Reconciliation should promote the adjustment
        let promoted = reconcile_deferred_adjustments(&db).unwrap();
        assert_eq!(promoted, 1);

        let conn = db.conn.lock().unwrap();
        let state: String = conn
            .query_row(
                "SELECT sync_state FROM payment_adjustments WHERE id = 'adj-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "pending");

        let sq_status: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_id = 'adj-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_status, "pending");

        // Running again should be a no-op
        drop(conn);
        let promoted2 = reconcile_deferred_adjustments(&db).unwrap();
        assert_eq!(promoted2, 0);
    }

    #[test]
    fn test_reconcile_does_not_promote_unsynced_payment_adjustments() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Insert order + payment (payment NOT synced)
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-uns', '[]', 30.0, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-uns', 'ord-uns', 'cash', 30.0, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        // Insert an adjustment in waiting_parent state
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-uns', 'pay-uns', 'ord-uns', 'refund', 5.0, 'Test', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment_adjustment', 'adj-uns', 'insert', '{}', 'adjustment:adj-uns', 'deferred')",
            [],
        )
        .unwrap();

        drop(conn);

        // Should NOT promote because payment is not synced
        let promoted = reconcile_deferred_adjustments(&db).unwrap();
        assert_eq!(promoted, 0);

        // Verify still waiting_parent
        let conn = db.conn.lock().unwrap();
        let state: String = conn
            .query_row(
                "SELECT sync_state FROM payment_adjustments WHERE id = 'adj-uns'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "waiting_parent");
    }

    #[test]
    fn test_auto_heal_waiting_adjustment_repairs_missing_canonical_remote_id_and_allows_sync() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let queue_payload = serde_json::json!({
            "paymentId": "pay-adj-missing-remote",
            "orderId": "ord-adj-missing-remote",
            "adjustmentType": "refund",
            "amount": 8.0,
            "reason": "Test"
        })
        .to_string();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, supabase_id, created_at, updated_at)
             VALUES ('ord-adj-missing-remote', '[]', 40.0, 'completed', 'synced', 'sup-adj-missing-remote', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-adj-missing-remote', 'ord-adj-missing-remote', 'cash', 40.0, 'synced', 'applied', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-missing-remote', 'pay-adj-missing-remote', 'ord-adj-missing-remote', 'refund', 8.0, 'Test', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment_adjustment', 'adj-missing-remote', 'insert', ?1, 'adjustment:adj-missing-remote', 'deferred')",
            params![queue_payload],
        )
        .unwrap();
        let queue_id = conn.last_insert_rowid();

        drop(conn);

        let canonical_payment_id = Uuid::new_v4().to_string();
        let heal_summary = tauri::async_runtime::block_on(
            auto_heal_waiting_adjustments_missing_canonical_remote_payment_ids_with(
                &db,
                |order_ids| {
                    assert_eq!(order_ids, vec!["ord-adj-missing-remote".to_string()]);
                    let canonical_payment_id = canonical_payment_id.clone();
                    let db = &db;
                    async move {
                        let conn = db.conn.lock().unwrap();
                        conn.execute(
                            "UPDATE order_payments
                             SET remote_payment_id = ?1,
                                 updated_at = datetime('now')
                             WHERE order_id = 'ord-adj-missing-remote'",
                            params![canonical_payment_id],
                        )
                        .map_err(|e| e.to_string())?;
                        Ok(1usize)
                    }
                },
            ),
        )
        .unwrap();

        assert_eq!(heal_summary.candidate_orders, 1);
        assert_eq!(heal_summary.repaired_payment_mirrors, 1);
        assert_eq!(heal_summary.promoted_adjustments, 1);

        let conn = db.conn.lock().unwrap();
        let adjustment_state: String = conn
            .query_row(
                "SELECT sync_state FROM payment_adjustments WHERE id = 'adj-missing-remote'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let queue_state: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_id = 'adj-missing-remote'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let adjustment_error: Option<String> = conn
            .query_row(
                "SELECT sync_last_error FROM payment_adjustments WHERE id = 'adj-missing-remote'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let queue_error: Option<String> = conn
            .query_row(
                "SELECT last_error FROM sync_queue WHERE entity_id = 'adj-missing-remote'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(conn);

        assert_eq!(adjustment_state, "pending");
        assert_eq!(queue_state, "pending");
        assert_eq!(adjustment_error, None);
        assert_eq!(queue_error, None);

        let (mock_url, server_handle) = spawn_single_json_response_server(
            "{\"success\":true}".to_string(),
            {
                let canonical_payment_id = canonical_payment_id.clone();
                move |request| {
                    assert!(request.starts_with("POST /api/pos/payments/adjustments/sync HTTP/1.1"));
                    assert!(request.contains("pay-adj-missing-remote"));
                    assert!(request.contains(&canonical_payment_id));
                }
            },
        );
        let item = load_sync_item(&db, queue_id);
        let items = vec![&item];
        let api_key = r#"{"key":"test-key","tid":"term-heal"}"#;
        let synced = tauri::async_runtime::block_on(sync_adjustment_items(
            &mock_url,
            api_key,
            "term-heal",
            "branch-1",
            &db,
            &items,
        ));
        assert_eq!(synced, 1);
        server_handle.join().expect("join mock server");

        let conn = db.conn.lock().unwrap();
        let final_adjustment_state: String = conn
            .query_row(
                "SELECT sync_state FROM payment_adjustments WHERE id = 'adj-missing-remote'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let final_queue_state: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_id = 'adj-missing-remote'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(conn);

        assert_eq!(final_adjustment_state, "applied");
        assert_eq!(final_queue_state, "synced");
        ensure_sync_queue_clear_for_z_report(&db, "pre-Z-report sync").unwrap();
    }

    #[test]
    fn test_auto_heal_rebinds_waiting_adjustment_from_duplicate_parent_to_canonical_payment() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let queue_payload = serde_json::json!({
            "paymentId": "pay-adj-stale-parent",
            "orderId": "ord-adj-duplicate-parent",
            "adjustmentType": "refund",
            "amount": 8.0,
            "reason": "Duplicate parent"
        })
        .to_string();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, supabase_id, created_at, updated_at)
             VALUES ('ord-adj-duplicate-parent', '[]', 40.0, 'completed', 'synced', 'sup-adj-duplicate-parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, currency, status, sync_status, sync_state, transaction_ref, created_at, updated_at)
             VALUES ('pay-adj-stale-parent', 'ord-adj-duplicate-parent', 'cash', 40.0, 'EUR', 'completed', 'failed', 'applied', 'txn-adj-dup', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, currency, status, sync_status, sync_state, transaction_ref, created_at, updated_at)
             VALUES ('pay-adj-canonical-parent', 'ord-adj-duplicate-parent', 'cash', 40.0, 'EUR', 'completed', 'synced', 'applied', 'txn-adj-dup', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, sync_last_error, created_at, updated_at)
             VALUES ('adj-duplicate-parent', 'pay-adj-stale-parent', 'ord-adj-duplicate-parent', 'refund', 8.0, 'Duplicate parent', 'waiting_parent', ?1, datetime('now'), datetime('now'))",
            params![ADJUSTMENT_BLOCKER_PARENT_PAYMENT_MISSING_CANONICAL_REMOTE_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status, last_error)
             VALUES ('payment_adjustment', 'adj-duplicate-parent', 'insert', ?1, 'adjustment:adj-duplicate-parent', 'deferred', ?2)",
            params![
                queue_payload,
                ADJUSTMENT_QUEUE_ERROR_PARENT_PAYMENT_MISSING_CANONICAL_REMOTE_ID
            ],
        )
        .unwrap();
        let adjustment_queue_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, max_retries, last_error)
             VALUES ('payment', 'pay-adj-stale-parent', 'insert', '{}', 'payment:pay-adj-stale-parent', 'failed', 5, 5, 'Payment exceeds order total')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, max_retries, last_error)
             VALUES ('order_payments', 'pay-adj-stale-parent', 'insert', '{}', 'order_payments:pay-adj-stale-parent', 'failed', 5, 5, 'Payment exceeds order total')",
            [],
        )
        .unwrap();
        drop(conn);

        let canonical_remote_payment_id = Uuid::new_v4().to_string();
        let heal_summary = tauri::async_runtime::block_on(
            auto_heal_waiting_adjustments_missing_canonical_remote_payment_ids_with(
                &db,
                |order_ids| {
                    assert_eq!(order_ids, vec!["ord-adj-duplicate-parent".to_string()]);
                    let canonical_remote_payment_id = canonical_remote_payment_id.clone();
                    let db = &db;
                    async move {
                        let conn = db.conn.lock().unwrap();
                        conn.execute(
                            "UPDATE order_payments
                             SET remote_payment_id = CASE id
                                 WHEN 'pay-adj-canonical-parent' THEN ?1
                                 ELSE remote_payment_id
                             END,
                             updated_at = datetime('now')
                             WHERE order_id = 'ord-adj-duplicate-parent'",
                            params![canonical_remote_payment_id],
                        )
                        .map_err(|e| e.to_string())?;
                        Ok(1usize)
                    }
                },
            ),
        )
        .unwrap();

        assert_eq!(heal_summary.candidate_orders, 1);
        assert_eq!(heal_summary.repaired_payment_mirrors, 1);
        assert_eq!(heal_summary.rebound_adjustments, 1);
        assert_eq!(heal_summary.promoted_adjustments, 1);

        let conn = db.conn.lock().unwrap();
        let (adjustment_payment_id, adjustment_state, adjustment_error): (
            String,
            String,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT payment_id, sync_state, sync_last_error
                 FROM payment_adjustments
                 WHERE id = 'adj-duplicate-parent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(adjustment_payment_id, "pay-adj-canonical-parent");
        assert_eq!(adjustment_state, "pending");
        assert!(adjustment_error.is_none());

        let (queue_state, queue_error, queue_payload_after): (String, Option<String>, String) = conn
            .query_row(
                "SELECT status, last_error, payload
                 FROM sync_queue
                 WHERE entity_type = 'payment_adjustment'
                   AND entity_id = 'adj-duplicate-parent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(queue_state, "pending");
        assert!(queue_error.is_none());
        let queue_payload_after: Value = serde_json::from_str(&queue_payload_after).unwrap();
        assert_eq!(
            str_any(&queue_payload_after, &["paymentId"]).as_deref(),
            Some("pay-adj-canonical-parent")
        );

        let (stale_status, stale_void_reason): (String, Option<String>) = conn
            .query_row(
                "SELECT status, void_reason
                 FROM order_payments
                 WHERE id = 'pay-adj-stale-parent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stale_status, "voided");
        assert!(stale_void_reason
            .as_deref()
            .unwrap_or_default()
            .contains("pay-adj-canonical-parent"));
        let stale_payment_queue_synced: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM sync_queue
                 WHERE entity_id = 'pay-adj-stale-parent'
                   AND entity_type IN ('payment', 'order_payments')
                   AND status = 'synced'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale_payment_queue_synced, 2);
        drop(conn);

        let (mock_url, server_handle) = spawn_single_json_response_server(
            "{\"success\":true}".to_string(),
            {
                let canonical_remote_payment_id = canonical_remote_payment_id.clone();
                move |request| {
                    assert!(request.starts_with("POST /api/pos/payments/adjustments/sync HTTP/1.1"));
                    assert!(request.contains("pay-adj-canonical-parent"));
                    assert!(request.contains(&canonical_remote_payment_id));
                    assert!(!request.contains("pay-adj-stale-parent"));
                }
            },
        );
        let item = load_sync_item(&db, adjustment_queue_id);
        let items = vec![&item];
        let api_key = r#"{"key":"test-key","tid":"term-heal"}"#;
        let synced = tauri::async_runtime::block_on(sync_adjustment_items(
            &mock_url,
            api_key,
            "term-heal",
            "branch-1",
            &db,
            &items,
        ));
        assert_eq!(synced, 1);
        server_handle.join().expect("join mock server");

        let conn = db.conn.lock().unwrap();
        let final_adjustment_state: String = conn
            .query_row(
                "SELECT sync_state FROM payment_adjustments WHERE id = 'adj-duplicate-parent'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let final_queue_state: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_id = 'adj-duplicate-parent'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(conn);

        assert_eq!(final_adjustment_state, "applied");
        assert_eq!(final_queue_state, "synced");
        ensure_sync_queue_clear_for_z_report(&db, "pre-Z-report sync").unwrap();
    }

    #[test]
    fn test_auto_heal_keeps_adjustment_waiting_when_parent_payment_missing_canonical_remote_id() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, supabase_id, created_at, updated_at)
             VALUES ('ord-adj-missing-remote', '[]', 40.0, 'completed', 'synced', 'sup-adj-missing-remote', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-adj-missing-remote', 'ord-adj-missing-remote', 'cash', 40.0, 'synced', 'applied', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-missing-remote', 'pay-adj-missing-remote', 'ord-adj-missing-remote', 'refund', 8.0, 'Test', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment_adjustment', 'adj-missing-remote', 'insert', '{}', 'adjustment:adj-missing-remote', 'deferred')",
            [],
        )
        .unwrap();
        drop(conn);

        let heal_summary = tauri::async_runtime::block_on(
            auto_heal_waiting_adjustments_missing_canonical_remote_payment_ids_with(
                &db,
                |order_ids| {
                    assert_eq!(order_ids, vec!["ord-adj-missing-remote".to_string()]);
                    async move { Ok(0usize) }
                },
            ),
        )
        .unwrap();

        assert_eq!(heal_summary.candidate_orders, 1);
        assert_eq!(heal_summary.repaired_payment_mirrors, 0);
        assert_eq!(heal_summary.promoted_adjustments, 0);

        let conn = db.conn.lock().unwrap();
        let adjustment_state: String = conn
            .query_row(
                "SELECT sync_state FROM payment_adjustments WHERE id = 'adj-missing-remote'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let queue_state: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_id = 'adj-missing-remote'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(conn);

        assert_eq!(adjustment_state, "waiting_parent");
        assert_eq!(queue_state, "deferred");

        let closeout_error = ensure_sync_queue_clear_for_z_report(&db, "pre-Z-report sync")
            .expect_err("closeout should stay blocked while the adjustment is still deferred");
        assert!(closeout_error.contains("payment_adjustment:deferred x1"));
        assert!(closeout_error.contains("Cannot close day during pre-Z-report sync"));
    }

    #[test]
    fn test_auto_heal_waiting_adjustments_repairs_each_order_once_and_promotes_all_children() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, supabase_id, created_at, updated_at)
             VALUES ('ord-adj-batch', '[]', 65.0, 'completed', 'synced', 'sup-adj-batch', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-adj-batch-1', 'ord-adj-batch', 'cash', 30.0, 'synced', 'applied', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-adj-batch-2', 'ord-adj-batch', 'card', 35.0, 'synced', 'applied', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-batch-1', 'pay-adj-batch-1', 'ord-adj-batch', 'refund', 10.0, 'One', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-batch-2', 'pay-adj-batch-2', 'ord-adj-batch', 'refund', 5.0, 'Two', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment_adjustment', 'adj-batch-1', 'insert', '{}', 'adjustment:adj-batch-1', 'deferred')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment_adjustment', 'adj-batch-2', 'insert', '{}', 'adjustment:adj-batch-2', 'deferred')",
            [],
        )
        .unwrap();
        drop(conn);

        let batch_payment_id_1 = Uuid::new_v4().to_string();
        let batch_payment_id_2 = Uuid::new_v4().to_string();
        let heal_summary = tauri::async_runtime::block_on(
            auto_heal_waiting_adjustments_missing_canonical_remote_payment_ids_with(
                &db,
                |order_ids| {
                    assert_eq!(order_ids, vec!["ord-adj-batch".to_string()]);
                    let db = &db;
                    let batch_payment_id_1 = batch_payment_id_1.clone();
                    let batch_payment_id_2 = batch_payment_id_2.clone();
                    async move {
                        let conn = db.conn.lock().unwrap();
                        conn.execute(
                            "UPDATE order_payments
                             SET remote_payment_id = CASE id
                                 WHEN 'pay-adj-batch-1' THEN ?1
                                 WHEN 'pay-adj-batch-2' THEN ?2
                                 ELSE remote_payment_id
                             END,
                             updated_at = datetime('now')
                             WHERE order_id = 'ord-adj-batch'",
                            params![batch_payment_id_1, batch_payment_id_2],
                        )
                        .map_err(|e| e.to_string())?;
                        Ok(1usize)
                    }
                },
            ),
        )
        .unwrap();

        assert_eq!(heal_summary.candidate_orders, 1);
        assert_eq!(heal_summary.repaired_payment_mirrors, 1);
        assert_eq!(heal_summary.promoted_adjustments, 2);

        let conn = db.conn.lock().unwrap();
        let pending_adjustments: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM payment_adjustments WHERE order_id = 'ord-adj-batch' AND sync_state = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let pending_queue_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue
                 WHERE entity_type = 'payment_adjustment'
                   AND entity_id IN ('adj-batch-1', 'adj-batch-2')
                   AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending_adjustments, 2);
        assert_eq!(pending_queue_rows, 2);
    }

    fn snapshot(count: i64, blockers_summary: &str) -> UnsyncedSyncQueueSnapshot {
        UnsyncedSyncQueueSnapshot {
            count,
            blockers_summary: blockers_summary.to_string(),
        }
    }

    #[test]
    fn test_closeout_sync_drain_runs_second_pass_for_newly_eligible_deferred_adjustment() {
        let mut pass_results = vec![Ok(1usize), Ok(1usize)];
        let mut snapshots = vec![
            Ok(snapshot(1, "payment_adjustment:deferred x1")),
            Ok(snapshot(0, "")),
        ];

        let state = tauri::async_runtime::block_on(drain_sync_until_closeout_stable(
            CLOSEOUT_SYNC_DRAIN_MAX_PASSES,
            || std::future::ready(pass_results.remove(0)),
            || snapshots.remove(0),
        ))
        .expect("closeout drain should succeed");

        assert_eq!(state.passes_executed, 2);
        assert!(state.any_progress);
        assert_eq!(state.remaining_unsynced_count, 0);
        assert!(state.remaining_blockers_summary.is_empty());
    }

    #[test]
    fn test_closeout_sync_drain_stops_after_two_stable_zero_progress_passes() {
        let mut pass_results = vec![Ok(0usize), Ok(0usize), Ok(1usize)];
        let mut snapshots = vec![
            Ok(snapshot(1, "payment_adjustment:deferred x1")),
            Ok(snapshot(1, "payment_adjustment:deferred x1")),
            Ok(snapshot(0, "")),
        ];

        let state = tauri::async_runtime::block_on(drain_sync_until_closeout_stable(
            CLOSEOUT_SYNC_DRAIN_MAX_PASSES,
            || std::future::ready(pass_results.remove(0)),
            || snapshots.remove(0),
        ))
        .expect("closeout drain should return the remaining blockers");

        assert_eq!(state.passes_executed, 2);
        assert!(!state.any_progress);
        assert_eq!(state.remaining_unsynced_count, 1);
        assert_eq!(
            state.remaining_blockers_summary,
            "payment_adjustment:deferred x1"
        );
    }

    #[test]
    fn test_closeout_sync_drain_keeps_single_pass_behavior_for_clean_queue() {
        let mut pass_results = vec![Ok(0usize)];
        let mut snapshots = vec![Ok(snapshot(0, ""))];

        let state = tauri::async_runtime::block_on(drain_sync_until_closeout_stable(
            CLOSEOUT_SYNC_DRAIN_MAX_PASSES,
            || std::future::ready(pass_results.remove(0)),
            || snapshots.remove(0),
        ))
        .expect("clean queue should complete in one pass");

        assert_eq!(state.passes_executed, 1);
        assert!(!state.any_progress);
        assert_eq!(state.remaining_unsynced_count, 0);
        assert!(state.remaining_blockers_summary.is_empty());
    }

    #[test]
    fn test_closeout_sync_drain_handles_post_submission_z_report_and_child_adjustment() {
        let mut pass_results = vec![Ok(1usize), Ok(1usize)];
        let mut snapshots = vec![
            Ok(snapshot(
                2,
                "payment_adjustment:deferred x1, z_report:pending x1",
            )),
            Ok(snapshot(0, "")),
        ];

        let state = tauri::async_runtime::block_on(drain_sync_until_closeout_stable(
            CLOSEOUT_SYNC_DRAIN_MAX_PASSES,
            || std::future::ready(pass_results.remove(0)),
            || snapshots.remove(0),
        ))
        .expect("post-submission drain should settle the queued z-report and child items");

        assert_eq!(state.passes_executed, 2);
        assert!(state.any_progress);
        assert_eq!(state.remaining_unsynced_count, 0);
        assert!(state.remaining_blockers_summary.is_empty());
    }

    #[test]
    fn test_build_adjustment_sync_body_omits_missing_optional_identifiers() {
        let body = build_adjustment_sync_body(
            "adj-1",
            "pay-1",
            Some("4c78393f-2fc0-4c35-ac85-f5f09917e3e6"),
            Some("refund"),
            Some(14.0),
            Some("Operator correction"),
            None,
            None,
            "terminal-1",
            "2279137a-1a9f-4ef9-85ec-6ebfc126e1dd",
            "adjustment:adj-1",
            Some("cash"),
            Some("cashier_drawer"),
            Some("manual"),
            None,
            None,
        );

        let object = body.as_object().expect("body should be an object");
        assert!(!object.contains_key("staff_id"));
        assert!(!object.contains_key("staff_shift_id"));
        assert!(!object.contains_key("remote_payment_id"));
        assert!(!object.contains_key("canonical_payment_id"));
    }

    #[test]
    fn test_normalize_adjustment_staff_ids_prefers_shift_resolved_database_staff_uuid() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let staff_shift_id = "8576c26a-c6bc-4d8c-bf6a-1f58f903081f";
        let database_staff_id = "159496f0-f218-4d08-bca8-1d8c8d28f7ef";

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 ?1, ?2, 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now')
             )",
            params![staff_shift_id, database_staff_id],
        )
        .unwrap();

        let payload = serde_json::json!({
            "staffId": "STF0008",
            "staffShiftId": staff_shift_id,
        });
        let (staff_id, normalized_staff_shift_id) = normalize_adjustment_staff_ids(&conn, &payload);

        assert_eq!(staff_id.as_deref(), Some(database_staff_id));
        assert_eq!(normalized_staff_shift_id.as_deref(), Some(staff_shift_id));
    }

    #[test]
    fn test_requeue_deferred_driver_earnings_blocked_by_legacy_shift_gating() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key,
                 status, retry_count, last_error
             ) VALUES (
                 'driver_earning', 'earning-stuck', 'create', '{}', 'driver:stuck',
                 'deferred', 2, 'Parent shift not yet synced'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let requeued = requeue_deferred_driver_earning_parent_shift_rows(&db).unwrap();
        assert_eq!(requeued, 1);

        let conn = db.conn.lock().unwrap();
        let (status, retry_count, last_error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, retry_count, last_error
                 FROM sync_queue
                 WHERE entity_id = 'earning-stuck'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "pending");
        assert_eq!(retry_count, 0);
        assert_eq!(last_error, None);
    }

    #[test]
    fn test_requeue_failed_shifts_blocked_by_cashier_reference_fk() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-fk', 'staff-driver', 'driver', datetime('now'), 'active', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key,
                 status, retry_count, last_error
             ) VALUES (
                 'shift', 'shift-fk', 'insert', '{}', 'shift:fk',
                 'failed', 5, 'Insert shift failed: insert or update on table \"staff_shifts\" violates foreign key constraint \"staff_shifts_transferred_to_cashier_shift_id_fkey\"'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let requeued = requeue_failed_shift_cashier_reference_rows(&db).unwrap();
        assert_eq!(requeued, 1);

        let conn = db.conn.lock().unwrap();
        let (queue_status, retry_count, last_error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, retry_count, last_error
                 FROM sync_queue
                 WHERE entity_type = 'shift' AND entity_id = 'shift-fk'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let shift_sync_status: String = conn
            .query_row(
                "SELECT sync_status FROM staff_shifts WHERE id = 'shift-fk'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(queue_status, "pending");
        assert_eq!(retry_count, 0);
        assert_eq!(last_error, None);
        assert_eq!(shift_sync_status, "pending");
    }

    #[test]
    fn test_backfill_active_shift_business_day_context_repairs_shift_and_requeues_insert() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, staff_name, branch_id, terminal_id, role_type,
                 check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-business-day-repair', 'staff-1', 'Cashier One', 'branch-1', 'term-1', 'cashier',
                 '2026-03-22T16:00:00Z', 'active', 'synced', '2026-03-22T16:00:00Z', '2026-03-22T16:00:00Z'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let repaired = backfill_active_shift_business_day_context(&db).unwrap();
        assert_eq!(repaired, 1);

        let conn = db.conn.lock().unwrap();
        let (report_date, period_start_at, sync_status): (Option<String>, Option<String>, String) =
            conn.query_row(
                "SELECT report_date, period_start_at, sync_status
                 FROM staff_shifts
                 WHERE id = 'shift-business-day-repair'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let queue_payload: String = conn
            .query_row(
                "SELECT payload
                 FROM sync_queue
                 WHERE entity_type = 'shift'
                   AND entity_id = 'shift-business-day-repair'
                   AND operation = 'insert'
                 ORDER BY id DESC
                 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(conn);

        let parsed_payload: Value = serde_json::from_str(&queue_payload).unwrap();
        let report_date = report_date.expect("report_date should be populated");
        let period_start_at = period_start_at.expect("period_start_at should be populated");

        assert!(!report_date.trim().is_empty());
        assert!(!period_start_at.trim().is_empty());
        assert_eq!(sync_status, "pending");
        assert_eq!(parsed_payload["reportDate"], report_date);
        assert_eq!(parsed_payload["periodStartAt"], period_start_at);
    }

    #[test]
    fn test_run_recurring_sync_recovery_repairs_active_shift_business_day_context() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, staff_name, branch_id, terminal_id, role_type,
                 check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-recurring-business-day', 'staff-1', 'Cashier One', 'branch-1', 'term-1', 'cashier',
                 '2026-03-22T16:00:00Z', 'active', 'synced', '2026-03-22T16:00:00Z', '2026-03-22T16:00:00Z'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let summary = run_recurring_sync_recovery(&db);
        assert_eq!(summary.business_day_repairs, 1);

        let conn = db.conn.lock().unwrap();
        let (report_date, period_start_at, sync_status): (Option<String>, Option<String>, String) =
            conn.query_row(
                "SELECT report_date, period_start_at, sync_status
                 FROM staff_shifts
                 WHERE id = 'shift-recurring-business-day'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let queue_status: String = conn
            .query_row(
                "SELECT status
                 FROM sync_queue
                 WHERE entity_type = 'shift'
                   AND entity_id = 'shift-recurring-business-day'
                   AND operation = 'insert'
                 ORDER BY id DESC
                 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert!(report_date.is_some());
        assert!(period_start_at.is_some());
        assert_eq!(sync_status, "pending");
        assert_eq!(queue_status, "pending");
    }

    #[test]
    fn test_requeue_retryable_failed_shift_rows_resets_retryable_shift() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-retryable-auto', 'cashier-1', 'cashier', datetime('now'), 'active', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key,
                 status, retry_count, max_retries, last_error
             ) VALUES (
                 'shift', 'shift-retryable-auto', 'insert', '{}', 'shift-retryable-auto:open',
                 'failed', 4, 5, 'Network error while syncing shift'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let requeued = requeue_retryable_failed_shift_rows(&db).unwrap();
        assert_eq!(requeued, 1);

        let conn = db.conn.lock().unwrap();
        let (queue_status, retry_count, last_error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, retry_count, last_error
                 FROM sync_queue
                 WHERE entity_type = 'shift' AND entity_id = 'shift-retryable-auto'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let shift_sync_status: String = conn
            .query_row(
                "SELECT sync_status
                 FROM staff_shifts
                 WHERE id = 'shift-retryable-auto'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(queue_status, "pending");
        assert_eq!(retry_count, 0);
        assert_eq!(last_error, None);
        assert_eq!(shift_sync_status, "pending");
    }

    #[test]
    fn test_requeue_retryable_failed_shift_rows_keeps_permanent_shift_failure() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-permanent-auto', 'cashier-1', 'cashier', datetime('now'), 'active', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key,
                 status, retry_count, max_retries, last_error
             ) VALUES (
                 'shift', 'shift-permanent-auto', 'insert', '{}', 'shift-permanent-auto:open',
                 'failed', 5, 5, 'Validation failed: branch access denied'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let requeued = requeue_retryable_failed_shift_rows(&db).unwrap();
        assert_eq!(requeued, 0);

        let conn = db.conn.lock().unwrap();
        let (queue_status, retry_count): (String, i64) = conn
            .query_row(
                "SELECT status, retry_count
                 FROM sync_queue
                 WHERE entity_type = 'shift' AND entity_id = 'shift-permanent-auto'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let shift_sync_status: String = conn
            .query_row(
                "SELECT sync_status
                 FROM staff_shifts
                 WHERE id = 'shift-permanent-auto'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(queue_status, "failed");
        assert_eq!(retry_count, 5);
        assert_eq!(shift_sync_status, "failed");
    }

    #[test]
    fn test_has_actionable_remote_sync_work_only_reports_ready_queue_rows() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key, status, next_retry_at
             ) VALUES (
                 'shift_expense', 'expense-blocked-only', 'insert', '{}', 'expense-blocked-only:insert',
                 'deferred', NULL
             )",
            [],
        )
        .unwrap();
        drop(conn);

        assert!(!has_actionable_remote_sync_work(&db).unwrap());

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key, status
             ) VALUES (
                 'shift', 'shift-pending-ready', 'insert', '{}', 'shift-pending-ready:insert',
                 'pending'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        assert!(has_actionable_remote_sync_work(&db).unwrap());
    }

    #[test]
    fn test_requeue_failed_payment_adjustments_blocked_by_missing_endpoint_404() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-adj-requeue', '[]', 12.0, 'completed', 'synced', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                'pay-adj-requeue', 'ord-adj-requeue', 'cash', 12.0, 'completed', 'synced', 'applied', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount, reason,
                sync_state, sync_retry_count, sync_last_error, sync_next_retry_at, created_at, updated_at
             ) VALUES (
                'adj-404', 'pay-adj-requeue', 'ord-adj-requeue', 'refund', 2.0, 'Missing endpoint',
                'failed', 5, 'HTTP 404 /api/pos/payments/adjustments/sync not found', datetime('now', '+10 minutes'), datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error, next_retry_at
             ) VALUES (
                'payment_adjustment', 'adj-404', 'insert', '{}', 'adjustment:adj-404',
                'failed', 5, 5, 'Sync failed: POST /api/pos/payments/adjustments/sync returned HTTP 404 endpoint not found', datetime('now', '+10 minutes')
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let requeued = requeue_failed_adjustment_missing_endpoint_rows(&db).unwrap();
        assert_eq!(requeued, 1);

        let conn = db.conn.lock().unwrap();
        let (queue_status, queue_retry_count, queue_error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, retry_count, last_error
                 FROM sync_queue
                 WHERE entity_type = 'payment_adjustment' AND entity_id = 'adj-404'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let (adjustment_state, adjustment_retry_count, adjustment_error): (
            String,
            i64,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT sync_state, sync_retry_count, sync_last_error
                 FROM payment_adjustments
                 WHERE id = 'adj-404'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(queue_status, "pending");
        assert_eq!(queue_retry_count, 0);
        assert_eq!(queue_error, None);
        assert_eq!(adjustment_state, "pending");
        assert_eq!(adjustment_retry_count, 0);
        assert_eq!(adjustment_error, None);
    }

    #[test]
    fn test_requeue_failed_payment_adjustments_blocked_by_legacy_validation_payload() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-adj-legacy', '[]', 12.0, 'completed', 'synced', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                'pay-adj-legacy', 'ord-adj-legacy', 'card', 12.0, 'completed', 'synced', 'applied', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount, reason,
                sync_state, sync_retry_count, sync_last_error, sync_next_retry_at, created_at, updated_at
             ) VALUES (
                'adj-legacy', 'pay-adj-legacy', 'ord-adj-legacy', 'refund', 10.9, 'Legacy payload',
                'failed', 5, 'Validation failed (HTTP 400): [{\"field\":\"staff_id\",\"message\":\"Invalid uuid\"},{\"field\":\"remote_payment_id\",\"message\":\"Expected string, received null\"},{\"field\":\"canonical_payment_id\",\"message\":\"Expected string, received null\"}]', datetime('now', '+10 minutes'), datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error, next_retry_at
             ) VALUES (
                'payment_adjustment', 'adj-legacy', 'insert',
                '{\"staffId\":\"admin-user\",\"staffShiftId\":\"a027f49e-ebe2-45f4-b444-eff5ecc10cce\"}',
                'adjustment:adj-legacy',
                'failed', 5, 5,
                'Validation failed (HTTP 400): [{\"field\":\"staff_id\",\"message\":\"Invalid uuid\"},{\"field\":\"remote_payment_id\",\"message\":\"Expected string, received null\"},{\"field\":\"canonical_payment_id\",\"message\":\"Expected string, received null\"}]',
                datetime('now', '+10 minutes')
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let requeued = requeue_failed_adjustment_legacy_validation_rows(&db).unwrap();
        assert_eq!(requeued, 1);

        let conn = db.conn.lock().unwrap();
        let (queue_status, queue_retry_count, queue_error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, retry_count, last_error
                 FROM sync_queue
                 WHERE entity_type = 'payment_adjustment' AND entity_id = 'adj-legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let (adjustment_state, adjustment_retry_count, adjustment_error): (
            String,
            i64,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT sync_state, sync_retry_count, sync_last_error
                 FROM payment_adjustments
                 WHERE id = 'adj-legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(queue_status, "pending");
        assert_eq!(queue_retry_count, 0);
        assert_eq!(queue_error, None);
        assert_eq!(adjustment_state, "pending");
        assert_eq!(adjustment_retry_count, 0);
        assert_eq!(adjustment_error, None);
    }

    #[test]
    fn test_retry_financial_queue_item_resets_adjustment_sync_state() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-adj-retry', '[]', 8.0, 'completed', 'synced', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                'pay-adj-retry', 'ord-adj-retry', 'cash', 8.0, 'completed', 'synced', 'applied', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount, reason,
                sync_state, sync_retry_count, sync_last_error, sync_next_retry_at, created_at, updated_at
             ) VALUES (
                'adj-retry', 'pay-adj-retry', 'ord-adj-retry', 'refund', 2.0, 'Retry me',
                'failed', 4, 'Validation failed', datetime('now', '+5 minutes'), datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error, next_retry_at
             ) VALUES (
                'payment_adjustment', 'adj-retry', 'insert', '{}', 'adjustment:adj-retry',
                'failed', 4, 5, 'Validation failed', datetime('now', '+5 minutes')
             )",
            [],
        )
        .unwrap();
        let queue_id: i64 = conn
            .query_row(
                "SELECT id FROM sync_queue
                 WHERE entity_type = 'payment_adjustment' AND entity_id = 'adj-retry'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(conn);

        retry_financial_queue_item(&db, queue_id).unwrap();

        let conn = db.conn.lock().unwrap();
        let (queue_status, queue_retry_count): (String, i64) = conn
            .query_row(
                "SELECT status, retry_count
                 FROM sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let (adjustment_state, adjustment_retry_count, adjustment_error): (
            String,
            i64,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT sync_state, sync_retry_count, sync_last_error
                 FROM payment_adjustments
                 WHERE id = 'adj-retry'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(queue_status, "pending");
        assert_eq!(queue_retry_count, 0);
        assert_eq!(adjustment_state, "pending");
        assert_eq!(adjustment_retry_count, 0);
        assert_eq!(adjustment_error, None);
    }

    #[test]
    fn test_reconcile_promotes_driver_earnings_when_order_syncs_even_if_shift_is_pending() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-driver', '[]', 6.4, 'delivered', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status, last_error)
             VALUES (
                 'driver_earning', 'earning-driver', 'create',
                 '{\"id\":\"earning-driver\",\"order_id\":\"ord-driver\",\"staff_shift_id\":\"shift-pending\"}',
                 'driver:earning-driver',
                 'deferred',
                 'Order not yet synced'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let promoted = reconcile_deferred_financials(&db).unwrap();
        assert_eq!(promoted, 0);

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE orders
             SET supabase_id = 'remote-order-driver',
                 sync_status = 'synced'
             WHERE id = 'ord-driver'",
            [],
        )
        .unwrap();
        drop(conn);

        let promoted = reconcile_deferred_financials(&db).unwrap();
        assert_eq!(promoted, 1);

        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_id = 'earning-driver'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");
    }

    #[test]
    fn test_reconcile_financials_keeps_shift_bound_items_waiting_for_shift_sync() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status, last_error)
             VALUES (
                 'shift_expense', 'expense-driver', 'create',
                 '{\"shiftId\":\"shift-waiting\",\"staffShiftId\":\"shift-waiting\"}',
                 'expense:shift-waiting',
                 'deferred',
                 'Parent shift not yet synced'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-waiting', 'staff-1', 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let promoted = reconcile_deferred_financials(&db).unwrap();
        assert_eq!(promoted, 0);

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE staff_shifts
             SET sync_status = 'synced'
             WHERE id = 'shift-waiting'",
            [],
        )
        .unwrap();
        drop(conn);

        let promoted = reconcile_deferred_financials(&db).unwrap();
        assert_eq!(promoted, 1);

        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_id = 'expense-driver'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");
    }

    #[test]
    fn test_reconcile_financials_promotes_shift_expense_delete_after_parent_shift_sync() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status, last_error
             ) VALUES (
                'shift_expense',
                'expense-delete-waiting',
                'delete',
                '{\"expenseId\":\"expense-delete-waiting\",\"shiftId\":\"shift-delete-waiting\",\"staffShiftId\":\"shift-delete-waiting\",\"branchId\":\"branch-1\",\"deletedAt\":\"2026-03-26T10:00:00Z\"}',
                'expense-delete-waiting:delete',
                'deferred',
                'Parent shift not yet synced'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-delete-waiting', 'staff-1', 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let promoted = reconcile_deferred_financials(&db).unwrap();
        assert_eq!(promoted, 0);

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE staff_shifts
             SET sync_status = 'synced'
             WHERE id = 'shift-delete-waiting'",
            [],
        )
        .unwrap();
        drop(conn);

        let promoted = reconcile_deferred_financials(&db).unwrap();
        assert_eq!(promoted, 1);

        let conn = db.conn.lock().unwrap();
        let (status, operation): (String, String) = conn
            .query_row(
                "SELECT status, operation
                 FROM sync_queue
                 WHERE entity_type = 'shift_expense' AND entity_id = 'expense-delete-waiting'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "pending");
        assert_eq!(operation, "delete");
    }

    #[test]
    fn test_reconcile_staff_payment_requeues_missing_parent_shift_queue_row() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-parent-payment', 'cashier-1', 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status, last_error
             ) VALUES (
                'staff_payment',
                'payment-parent-blocked',
                'insert',
                '{\"cashierShiftId\":\"shift-parent-payment\",\"amount\":20}',
                'payment-parent-blocked:insert',
                'deferred',
                'Waiting for cashier shift sync'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let promoted = reconcile_deferred_financials(&db).unwrap();
        assert_eq!(promoted, 0);

        let conn = db.conn.lock().unwrap();
        let shift_queue_status: String = conn
            .query_row(
                "SELECT status
                 FROM sync_queue
                 WHERE entity_type = 'shift' AND entity_id = 'shift-parent-payment'
                 ORDER BY id DESC
                 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let child_status: String = conn
            .query_row(
                "SELECT status
                 FROM sync_queue
                 WHERE entity_type = 'staff_payment' AND entity_id = 'payment-parent-blocked'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(shift_queue_status, "pending");
        assert_eq!(child_status, "deferred");
    }

    #[test]
    fn test_reconcile_shift_expense_requeues_missing_parent_shift_queue_row() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-parent-expense', 'cashier-1', 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status, last_error
             ) VALUES (
                'shift_expense',
                'expense-parent-blocked',
                'insert',
                '{\"shiftId\":\"shift-parent-expense\",\"amount\":10}',
                'expense-parent-blocked:insert',
                'deferred',
                'Waiting for cashier shift sync'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let promoted = reconcile_deferred_financials(&db).unwrap();
        assert_eq!(promoted, 0);

        let conn = db.conn.lock().unwrap();
        let shift_queue_status: String = conn
            .query_row(
                "SELECT status
                 FROM sync_queue
                 WHERE entity_type = 'shift' AND entity_id = 'shift-parent-expense'
                 ORDER BY id DESC
                 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let child_status: String = conn
            .query_row(
                "SELECT status
                 FROM sync_queue
                 WHERE entity_type = 'shift_expense' AND entity_id = 'expense-parent-blocked'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(shift_queue_status, "pending");
        assert_eq!(child_status, "deferred");
    }

    #[test]
    fn test_reconcile_failed_shift_bound_financials_recovers_retryable_parent_shift_blocker() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-parent-retryable-failed-child', 'cashier-1', 'cashier', datetime('now'), 'active', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key,
                 status, retry_count, max_retries, last_error
             ) VALUES (
                 'shift', 'shift-parent-retryable-failed-child', 'insert', '{}', 'shift-parent-retryable-failed-child:open',
                 'failed', 3, 5, 'Network error while syncing shift'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO shift_expenses (
                 id, staff_shift_id, staff_id, branch_id, expense_type, amount, description,
                 sync_status, created_at, updated_at
             ) VALUES (
                 'expense-failed-recovery', 'shift-parent-retryable-failed-child', 'cashier-1', 'branch-1', 'other', 10.0, 'Test expense',
                 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error
             ) VALUES (
                'shift_expense', 'expense-failed-recovery', 'insert',
                '{\"shiftId\":\"shift-parent-retryable-failed-child\",\"amount\":10}',
                'expense-failed-recovery:insert',
                'failed', 5, 5, 'Parent shift sync failed temporarily'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let recovered = reconcile_failed_shift_bound_financials(&db).unwrap();
        assert_eq!(recovered, 1);

        let conn = db.conn.lock().unwrap();
        let (shift_queue_status, shift_sync_status): (String, String) = conn
            .query_row(
                "SELECT
                    (SELECT status FROM sync_queue WHERE entity_type = 'shift' AND entity_id = 'shift-parent-retryable-failed-child' ORDER BY id DESC LIMIT 1),
                    (SELECT sync_status FROM staff_shifts WHERE id = 'shift-parent-retryable-failed-child')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let (child_status, child_error): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_error
                 FROM sync_queue
                 WHERE entity_type = 'shift_expense' AND entity_id = 'expense-failed-recovery'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let local_expense_sync_status: String = conn
            .query_row(
                "SELECT sync_status
                 FROM shift_expenses
                 WHERE id = 'expense-failed-recovery'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(shift_queue_status, "pending");
        assert_eq!(shift_sync_status, "pending");
        assert_eq!(child_status, "deferred");
        assert_eq!(
            child_error.as_deref(),
            Some("Waiting for cashier shift sync")
        );
        assert_eq!(local_expense_sync_status, "pending");
    }

    #[test]
    fn test_reconcile_financials_keeps_child_blocked_when_parent_shift_failure_is_permanent() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-parent-permanent', 'cashier-1', 'cashier', datetime('now'), 'active', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key,
                 status, retry_count, last_error
             ) VALUES (
                 'shift', 'shift-parent-permanent', 'insert', '{}', 'shift-parent-permanent:open',
                 'failed', 5, 'Validation failed: branch access denied'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status, last_error
             ) VALUES (
                'staff_payment',
                'payment-permanent-blocked',
                'insert',
                '{\"cashierShiftId\":\"shift-parent-permanent\",\"amount\":20}',
                'payment-permanent-blocked:insert',
                'deferred',
                'Waiting for cashier shift sync'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let promoted = reconcile_deferred_financials(&db).unwrap();
        assert_eq!(promoted, 0);

        let conn = db.conn.lock().unwrap();
        let (child_status, child_error): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_error
                 FROM sync_queue
                 WHERE entity_type = 'staff_payment' AND entity_id = 'payment-permanent-blocked'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let shift_queue_status: String = conn
            .query_row(
                "SELECT status
                 FROM sync_queue
                 WHERE entity_type = 'shift' AND entity_id = 'shift-parent-permanent'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(child_status, "deferred");
        assert_eq!(
            child_error.as_deref(),
            Some("Cashier shift sync needs attention")
        );
        assert_eq!(shift_queue_status, "failed");
    }

    #[test]
    fn test_reconcile_failed_shift_bound_financials_keeps_failed_child_blocked_for_permanent_parent(
    ) {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-parent-permanent-failed-child', 'cashier-1', 'cashier', datetime('now'), 'active', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                 entity_type, entity_id, operation, payload, idempotency_key,
                 status, retry_count, max_retries, last_error
             ) VALUES (
                 'shift', 'shift-parent-permanent-failed-child', 'insert', '{}', 'shift-parent-permanent-failed-child:open',
                 'failed', 5, 5, 'Validation failed: branch access denied'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, last_error
             ) VALUES (
                'staff_payment', 'payment-failed-permanent-parent', 'insert',
                '{\"cashierShiftId\":\"shift-parent-permanent-failed-child\",\"amount\":20}',
                'payment-failed-permanent-parent:insert',
                'failed', 5, 5, 'Parent shift sync failed'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let recovered = reconcile_failed_shift_bound_financials(&db).unwrap();
        assert_eq!(recovered, 0);

        let conn = db.conn.lock().unwrap();
        let (child_status, child_error): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_error
                 FROM sync_queue
                 WHERE entity_type = 'staff_payment' AND entity_id = 'payment-failed-permanent-parent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let shift_queue_status: String = conn
            .query_row(
                "SELECT status
                 FROM sync_queue
                 WHERE entity_type = 'shift' AND entity_id = 'shift-parent-permanent-failed-child'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(child_status, "failed");
        assert_eq!(
            child_error.as_deref(),
            Some("Cashier shift sync needs attention")
        );
        assert_eq!(shift_queue_status, "failed");
    }

    #[test]
    fn test_promote_payments_for_order_inline() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Insert an order
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, supabase_id, created_at, updated_at)
             VALUES ('ord-b', '[]', 25.0, 'completed', 'synced', 'sup-456', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        // Insert 2 payments in waiting_parent state
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-b1', 'ord-b', 'cash', 15.0, 'pending', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-b2', 'ord-b', 'card', 10.0, 'pending', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        // Insert deferred sync_queue entries
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment', 'pay-b1', 'insert', '{}', 'payment:pay-b1', 'deferred')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment', 'pay-b2', 'insert', '{}', 'payment:pay-b2', 'deferred')",
            [],
        )
        .unwrap();

        // Inline promote
        promote_payments_for_order(&conn, "ord-b");

        // Verify both promoted
        let s1: String = conn
            .query_row(
                "SELECT sync_state FROM order_payments WHERE id = 'pay-b1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let s2: String = conn
            .query_row(
                "SELECT sync_state FROM order_payments WHERE id = 'pay-b2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(s1, "pending");
        assert_eq!(s2, "pending");

        // Verify sync_queue promoted
        let sq1: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_id = 'pay-b1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let sq2: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_id = 'pay-b2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq1, "pending");
        assert_eq!(sq2, "pending");
    }

    #[test]
    fn test_has_outstanding_local_order_queue_treats_queued_remote_as_pending() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('order', 'ord-queued', 'update', '{}', 'order:queued', 'queued_remote')",
            [],
        )
        .unwrap();

        assert!(has_outstanding_local_order_queue(&conn, "ord-queued"));
        assert!(!has_outstanding_local_order_queue(&conn, "ord-missing"));
    }

    #[test]
    fn test_move_receipt_back_to_pending_releases_queued_remote_receipt() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-receipt', '[]', 11.1, 'out_for_delivery', 'queued', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, max_retries, remote_receipt_id
             ) VALUES (
                'order', 'ord-receipt', 'update', '{}', 'order:receipt', 'queued_remote', 0, 5, 'receipt-1'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let moved = move_receipt_back_to_pending(&db, "receipt-1", "remote failed", 5_000)
            .expect("move receipt back to pending");
        assert_eq!(moved, 1);

        let conn = db.conn.lock().unwrap();
        let (queue_status, retry_count, remote_receipt_id, last_error, order_sync_status): (
            String,
            i64,
            Option<String>,
            Option<String>,
            String,
        ) = conn
            .query_row(
                "SELECT
                    (SELECT status FROM sync_queue WHERE entity_id = 'ord-receipt'),
                    (SELECT retry_count FROM sync_queue WHERE entity_id = 'ord-receipt'),
                    (SELECT remote_receipt_id FROM sync_queue WHERE entity_id = 'ord-receipt'),
                    (SELECT last_error FROM sync_queue WHERE entity_id = 'ord-receipt'),
                    (SELECT sync_status FROM orders WHERE id = 'ord-receipt')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(queue_status, "pending");
        assert_eq!(retry_count, 1);
        assert_eq!(remote_receipt_id, None);
        assert_eq!(last_error.as_deref(), Some("remote failed"));
        assert_eq!(order_sync_status, "pending");
    }

    #[test]
    fn test_receipt_status_recovery_hint_prefers_structured_direct_fallback() {
        let response = serde_json::json!({
            "reason_code": "legacy_receipt_unclaimed_timeout",
            "recovery_hint": "direct_order_fallback"
        });

        assert_eq!(
            receipt_status_recovery_hint(&response, "some other error"),
            ReceiptStatusRecoveryHint::DirectOrderFallback
        );
    }

    #[test]
    fn test_receipt_status_recovery_hint_falls_back_to_legacy_timeout_message() {
        assert_eq!(
            receipt_status_recovery_hint(
                &serde_json::json!({}),
                "legacy pos_ingest_queue receipt was not claimed within 30s"
            ),
            ReceiptStatusRecoveryHint::DirectOrderFallback
        );

        assert_eq!(
            receipt_status_recovery_hint(
                &serde_json::json!({}),
                "remote receipt processing failed"
            ),
            ReceiptStatusRecoveryHint::RetryLocalQueue
        );
    }

    #[test]
    fn test_extract_last_queue_failure_snapshot_deprioritizes_future_retry_pending_rows() {
        let db = test_db();
        let future_retry_at = (Utc::now() + ChronoDuration::minutes(5)).to_rfc3339();
        insert_queue_failure_row(
            &db,
            "ord-retry-later",
            "pending",
            "Transient direct fallback failure: timed out",
            Some(future_retry_at.as_str()),
        );
        let failed_queue_id =
            insert_queue_failure_row(&db, "ord-hard-fail", "failed", "validation failed", None);

        let conn = db.conn.lock().unwrap();
        let snapshot = extract_last_queue_failure_snapshot(&conn).expect("queue failure snapshot");
        assert_eq!(snapshot.queue_id, failed_queue_id);
        assert_eq!(snapshot.status, "failed");
        assert_eq!(snapshot.classification, "permanent");
    }

    #[test]
    fn test_release_queued_remote_item_retryable_schedules_retry_and_clears_receipt_claim() {
        let db = test_db();
        insert_minimal_order(&db, "ord-release-retry", "queued");
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, remote_receipt_id, retry_delay_ms
             ) VALUES (
                'order', 'ord-release-retry', 'insert', '{}', 'order:ord-release-retry:insert',
                'queued_remote', 1, 5, 'receipt-retry', 1000
             )",
            [],
        )
        .unwrap();
        let queue_id = conn.last_insert_rowid();
        drop(conn);

        let item = load_sync_item(&db, queue_id);
        release_queued_remote_item(
            &db,
            &item,
            "Transient direct fallback failure: timed out",
            QueuedRemoteDisposition::Retryable,
        )
        .expect("release queued remote item");

        let conn = db.conn.lock().unwrap();
        let (status, retry_count, next_retry_at, remote_receipt_id, last_error, order_sync_status): (
            String,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
        ) = conn
            .query_row(
                "SELECT
                    (SELECT status FROM sync_queue WHERE id = ?1),
                    (SELECT retry_count FROM sync_queue WHERE id = ?1),
                    (SELECT next_retry_at FROM sync_queue WHERE id = ?1),
                    (SELECT remote_receipt_id FROM sync_queue WHERE id = ?1),
                    (SELECT last_error FROM sync_queue WHERE id = ?1),
                    (SELECT sync_status FROM orders WHERE id = 'ord-release-retry')",
                params![queue_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(status, "pending");
        assert_eq!(retry_count, 2);
        assert!(next_retry_at.is_some());
        assert_eq!(remote_receipt_id, None);
        assert_eq!(
            last_error.as_deref(),
            Some("Transient direct fallback failure: timed out")
        );
        assert_eq!(order_sync_status, "pending");
    }

    #[test]
    fn test_mark_order_synced_via_direct_fallback_clears_remote_receipt_and_last_error() {
        let db = test_db();
        insert_minimal_order(&db, "ord-direct-synced", "queued");
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, max_retries, remote_receipt_id, last_error
             ) VALUES (
                'order', 'ord-direct-synced', 'insert', '{}', 'order:ord-direct-synced:insert',
                'queued_remote', 1, 5, 'receipt-direct', 'legacy pos_ingest_queue receipt was not claimed within 30s'
             )",
            [],
        )
        .unwrap();
        let queue_id = conn.last_insert_rowid();
        drop(conn);

        mark_order_synced_via_direct_fallback(
            &db,
            queue_id,
            "ord-direct-synced",
            "remote-order-123",
        )
        .expect("mark order synced via direct fallback");

        let conn = db.conn.lock().unwrap();
        let (queue_status, remote_receipt_id, last_error, order_sync_status, supabase_id): (
            String,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT
                    (SELECT status FROM sync_queue WHERE id = ?1),
                    (SELECT remote_receipt_id FROM sync_queue WHERE id = ?1),
                    (SELECT last_error FROM sync_queue WHERE id = ?1),
                    (SELECT sync_status FROM orders WHERE id = 'ord-direct-synced'),
                    (SELECT supabase_id FROM orders WHERE id = 'ord-direct-synced')",
                params![queue_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(queue_status, "synced");
        assert_eq!(remote_receipt_id, None);
        assert_eq!(last_error, None);
        assert_eq!(order_sync_status, "synced");
        assert_eq!(supabase_id.as_deref(), Some("remote-order-123"));
    }

    #[test]
    fn test_remote_order_changed_at_falls_back_to_created_at() {
        let remote_order = serde_json::json!({
            "id": "remote-1",
            "created_at": "2026-03-05T10:00:00Z"
        });

        assert_eq!(
            remote_order_changed_at(&remote_order),
            "2026-03-05T10:00:00Z"
        );
        assert_eq!(
            remote_order_changed_at(&serde_json::json!({ "id": "remote-2" })),
            ""
        );
    }

    #[test]
    fn test_should_preserve_local_cancelled_blocks_non_cancelled_remote_status() {
        assert!(should_preserve_local_cancelled(
            Some("cancelled"),
            "completed"
        ));
        assert!(should_preserve_local_cancelled(
            Some("canceled"),
            "delivered"
        ));
        assert!(!should_preserve_local_cancelled(
            Some("cancelled"),
            "cancelled"
        ));
        assert!(!should_preserve_local_cancelled(
            Some("completed"),
            "cancelled"
        ));
    }

    #[test]
    fn test_on_complete_trigger_enqueues_when_enabled() {
        let db = test_db();

        // Insert a local order
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
                 VALUES ('ord-complete', '[]', 20.0, 'pending', 'synced', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
            // Enable the on_complete receipt action
            crate::db::set_setting(&conn, "receipt_actions", "on_complete", "true")
                .expect("set on_complete setting");
        }

        // Simulate what the reconciled_order_events loop does: enqueue when status is 'completed'
        let new_status = "completed".to_string();
        if matches!(new_status.as_str(), "completed" | "delivered")
            && crate::print::is_print_action_enabled(&db, "on_complete")
        {
            print::enqueue_print_job(&db, "order_completed_receipt", "ord-complete", None)
                .expect("enqueue order_completed_receipt");
        }

        // Verify a print job was created
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE entity_type = 'order_completed_receipt' AND entity_id = 'ord-complete'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "expected one order_completed_receipt print job");
    }

    #[test]
    fn test_on_cancel_trigger_suppressed_when_disabled() {
        let db = test_db();

        // Insert a local order with a cancellation reason
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, status, sync_status, cancellation_reason, created_at, updated_at)
                 VALUES ('ord-cancel', '[]', 15.0, 'cancelled', 'synced', 'Out of stock', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
            // Do NOT set on_cancel — it defaults to false (not in the always-enabled list)
        }

        // Simulate what the reconciled_order_events loop does: on_cancel is NOT enabled
        let new_status = "cancelled".to_string();
        if matches!(new_status.as_str(), "cancelled" | "canceled")
            && crate::print::is_print_action_enabled(&db, "on_cancel")
        {
            // This block should NOT run because on_cancel is disabled by default
            let payload = serde_json::json!({ "cancellationReason": "Out of stock" });
            print::enqueue_print_job_with_payload(
                &db,
                "order_canceled_receipt",
                "ord-cancel",
                None,
                Some(&payload),
            )
            .expect("enqueue order_canceled_receipt");
        }

        // Verify no print job was created
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE entity_type = 'order_canceled_receipt' AND entity_id = 'ord-cancel'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 0,
            "expected no order_canceled_receipt print job when on_cancel is disabled"
        );
    }

    #[test]
    fn test_on_cancel_trigger_enqueues_when_enabled() {
        let db = test_db();

        // Enable on_cancel and insert an order with a cancellation reason
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value) VALUES ('receipt_actions', 'on_cancel', 'true')",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, status, sync_status, cancellation_reason, created_at, updated_at)
                 VALUES ('ord-cancel2', '[]', 10.0, 'cancelled', 'synced', 'Customer request', datetime('now'), datetime('now'))",
                [],
            ).unwrap();
        }

        // Simulate the reconciled_order_events on_cancel path
        let new_status = "cancelled".to_string();
        if matches!(new_status.as_str(), "cancelled" | "canceled")
            && crate::print::is_print_action_enabled(&db, "on_cancel")
        {
            let reason: Option<String> = {
                let conn = db.conn.lock().unwrap();
                conn.query_row(
                    "SELECT cancellation_reason FROM orders WHERE id = ?1",
                    rusqlite::params!["ord-cancel2"],
                    |row| row.get(0),
                )
                .ok()
                .flatten()
            };
            let payload = serde_json::json!({ "cancellationReason": reason });
            print::enqueue_print_job_with_payload(
                &db,
                "order_canceled_receipt",
                "ord-cancel2",
                None,
                Some(&payload),
            )
            .expect("enqueue order_canceled_receipt");
        }

        // Verify the print job was created
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE entity_type = 'order_canceled_receipt' AND entity_id = 'ord-cancel2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 1,
            "expected one order_canceled_receipt print job when on_cancel is enabled"
        );
    }
}
