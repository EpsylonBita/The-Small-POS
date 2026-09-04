//! Offline sync queue backed by local SQLite.
//!
//! Provides a durable, priority-aware FIFO queue for offline POS operations.
//! Items are persisted to SQLite so they survive renderer crashes and app
//! restarts. Processing uses exponential backoff for transient failures.
//!
//! # Tables
//!
//! - `parity_sync_queue` -- queued operations awaiting sync to the admin API.
//! - `conflict_audit_log` -- audit trail for conflicts detected during sync.
//!
//! # Queue Semantics
//!
//! - FIFO within priority bands (higher priority processed first).
//! - Max replayable queue size: 5000 `pending`/`processing` rows
//!   (`MAX_QUEUE_SIZE`); `conflict` rows are bounded separately by
//!   `MAX_CONFLICT_ROWS` because they drain via operator resolution,
//!   not replay.
//! - Capacity early warning at 80% of either ceiling (`capacity_warning`),
//!   emitted to the renderer as `sync:queue-capacity-warning`.
//! - Exponential backoff: initial 1s, doubles per attempt, capped at 60s.
//! - Max retries: 10 (item marked `failed` after exhaustion).
//! - Age warning threshold: 24 hours (logged, not blocking).

use chrono::{Duration as ChronoDuration, Utc};
use reqwest::Method;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::time::Duration;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::money::Cents;
use crate::repair_transport::{
    classify_repair_http_response, prepare_repair_attachment_request,
    prepare_repair_command_request, read_bounded_repair_response, send_repair_raw_attachment,
    ParityTerminalAuthCode, ParityTerminalAuthFailure, RepairAttachmentDisposition,
    RepairHookError, RepairHookErrorKind, RepairQueueHooks, RepairSyncDisposition,
    UnavailableRepairQueueHooks,
};
use crate::{can_transition_locally, normalize_status_for_storage};
use crate::{db, storage, sync};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum number of replayable rows (status `pending` or `processing`)
/// allowed in the queue before `enqueue` rejects new entries.
///
/// Sizing (founder decision 2026-06-10): this cap fail-closes domain writes
/// (order/payment/refund/shift transactions roll back when enqueue rejects),
/// so it must absorb a full busy day fully offline with fiscalization
/// active. Fiscal-active branches enqueue ~2-3 parity rows per order
/// (order + payment + fiscal/adjustment follow-ups), and a high-volume
/// store does ~600-800 orders/day, so a worst-case offline day is
/// ~800 x 3 = 2,400 rows. 5,000 keeps roughly two such days of headroom
/// before checkout stops. The previous value of 500 dated from the file's
/// creation and was never sized against volume; it walled out at ~170-250
/// offline orders mid-day.
///
/// Depth-sensitive queries stay in the same cost class at this size: the
/// capacity COUNT rides the `idx_parity_sync_queue_active` partial index
/// (migrate_v50), and `dequeue`/`peek` are `LIMIT 1` scans ordered by
/// `idx_parity_sq_priority_created`.
///
/// `conflict` rows do NOT count against this cap -- they never drain
/// offline and have their own operator-resolution path -- they are bounded
/// separately by `MAX_CONFLICT_ROWS`.
pub const MAX_QUEUE_SIZE: i64 = 5000;

/// Separate fail-closed ceiling for `conflict` rows.
///
/// Conflicts wait for operator resolution rather than replay, so counting
/// them against the replayable cap above squeezed checkout capacity with
/// rows that no amount of network recovery could drain. They still need a
/// backstop: at this ceiling `enqueue` rejects with the same fail-closed
/// semantics, because a four-digit unresolved-conflict backlog means a
/// systemic bug (e.g. a version-stamping loop) and continuing to accept
/// writes that will also conflict is unsafe. Normal operation produces a
/// handful of conflicts a day, so 1,000 is purely a runaway-pathology bound.
pub const MAX_CONFLICT_ROWS: i64 = 1000;

/// Percentage of either capacity ceiling at which `capacity_warning`
/// starts returning a payload so the operator UI can surface "sync backlog
/// growing" long before `enqueue` fail-closes checkout.
pub const CAPACITY_WARNING_PERCENT: i64 = 80;

/// Default initial retry delay in milliseconds.
const DEFAULT_INITIAL_RETRY_DELAY_MS: i64 = 1000;

/// Maximum retry delay in milliseconds for non-monetary items.
/// Monetary items use a larger cap so the retry train does not hammer a
/// failing endpoint multiple times per minute across many dead payments.
/// See `monetary_retry_cap_ms` for the monetary-class variant.
const MAX_RETRY_DELAY_MS: i64 = 60_000;

/// Maximum retry delay in milliseconds for monetary items. Five minutes.
const MAX_MONETARY_RETRY_DELAY_MS: i64 = 300_000;

/// Upper bound on added jitter in milliseconds. Every scheduled retry gets
/// `[0, JITTER_CAP_MS)` added to its exponentially-scaled base delay so a
/// fleet of terminals recovering from the same outage do not stampede in
/// perfect lockstep.
const JITTER_CAP_MS: i64 = 1000;

/// Entity/module types treated as monetary for the purpose of retry caps.
fn is_monetary_module(module_type: &str) -> bool {
    monetary_dead_letter_category(module_type).is_some()
}

fn bounded_module_category(module_type: &str) -> &'static str {
    match module_type.trim().to_ascii_lowercase().as_str() {
        "orders" => "orders",
        "customers" => "customers",
        "shifts" => "shifts",
        "financial" => "financial",
        "z_report" => "z_report",
        "loyalty" => "loyalty",
        "fiscal" => "fiscal",
        "payment" => "payment",
        "payment_adjustment" => "payment_adjustment",
        "staff_shift" => "staff_shift",
        "shift_expense" => "shift_expense",
        "staff_payment" => "staff_payment",
        "driver_earning" | "driver_earnings" => "driver_earning",
        "operations" => "operations",
        "catalog" => "catalog",
        "settings" => "settings",
        "table_service" => "table_service",
        "repairs" => "repairs",
        _ => "other",
    }
}

fn monetary_dead_letter_category(module_type: &str) -> Option<MonetaryDeadLetterCategory> {
    match module_type {
        "payment" => Some(MonetaryDeadLetterCategory::Payment),
        "payment_adjustment" => Some(MonetaryDeadLetterCategory::PaymentAdjustment),
        "z_report" => Some(MonetaryDeadLetterCategory::ZReport),
        "staff_shift" => Some(MonetaryDeadLetterCategory::StaffShift),
        "shift_expense" => Some(MonetaryDeadLetterCategory::ShiftExpense),
        "staff_payment" => Some(MonetaryDeadLetterCategory::StaffPayment),
        "driver_earning" | "driver_earnings" => Some(MonetaryDeadLetterCategory::DriverEarning),
        _ => None,
    }
}

/// Compute the next retry delay given the current `retry_delay_ms` base
/// and the item's module type. Doubles the base, adds jitter in
/// `[0, JITTER_CAP_MS)`, and clamps by the per-class cap.
fn compute_next_retry_delay_ms(retry_delay_ms: i64, module_type: &str) -> i64 {
    let cap = if is_monetary_module(module_type) {
        MAX_MONETARY_RETRY_DELAY_MS
    } else {
        MAX_RETRY_DELAY_MS
    };
    // Wave 10 medium: the previous `timestamp_subsec_nanos / 1_000_000 %
    // JITTER_CAP_MS` jitter bottoms out at the nearest millisecond — two
    // consecutive calls within the same millisecond produced identical
    // jitter values, defeating the anti-stampede purpose when many rows
    // retry together. Mixing the nanosecond value with Knuth's
    // multiplicative constant spreads even same-millisecond calls across
    // the `[0, JITTER_CAP_MS)` range. Rather than introduce a `rand`
    // crate dependency just for this helper, we re-use the deterministic
    // mix — the entropy is still per-call because the nanosecond source
    // rotates at every invocation.
    let nanos = Utc::now().timestamp_subsec_nanos() as u64;
    let mixed = nanos.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let jitter = (mixed % (JITTER_CAP_MS as u64)) as i64;
    (retry_delay_ms.saturating_mul(2).saturating_add(jitter)).min(cap)
}

/// Maximum number of retry attempts before marking an item as permanently failed.
pub const MAX_RETRY_ATTEMPTS: i64 = 10;

/// Wave 4: maximum number of times an item may be returned to `pending`
/// via `mark_deferred` (e.g. "waiting for parent order sync") before we
/// escalate to `conflict` status. Without a cap, a genuinely-stuck
/// parent (missing terminal_id, corrupted payload on the parent) lets
/// the child loop pending→processing→deferred→pending forever with no
/// operator-visible alarm. 50 cycles at the default 5s delay is ~4
/// minutes of retries before the item surfaces for review.
pub const MAX_DEFERRAL_CYCLES: i64 = 50;

/// Retry spacing for items parked by `mark_module_required` (THE-306 gating
/// sweep item 3). Module acquisition is an operator/billing action on a human
/// timescale, so probe every 30 minutes instead of hot-retrying — one cheap
/// MODULE_REQUIRED round-trip per item per half hour until the org buys the
/// module back (or the item is handled in the Recovery Center).
pub const MODULE_REQUIRED_RETRY_SECS: i64 = 30 * 60;

/// Age threshold in milliseconds for old-item warnings (24 hours).
const AGE_WARNING_THRESHOLD_MS: i64 = 24 * 60 * 60 * 1000;

/// Cap automatic failed-row recovery per cycle so backlog repair does not flood admin.
const MAX_AUTO_REQUEUE_ITEMS_PER_CYCLE: usize = 3;

/// Recovery lease for parity rows claimed as `processing`.
const PROCESSING_LEASE_SECS: i64 = 120;

/// Hard timeout for parity HTTP calls so abandoned requests do not pin rows.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// Default cooldown when the admin API responds with rate limiting.
const DEFAULT_RATE_LIMIT_RETRY_SECS: i64 = 60;

// ---------------------------------------------------------------------------
// Data structures (mirror shared/pos/sync-queue-types.ts)
// ---------------------------------------------------------------------------

/// A single queued sync operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncQueueItem {
    pub id: String,
    pub table_name: String,
    pub record_id: String,
    pub operation: String,
    pub data: String,
    pub organization_id: String,
    pub created_at: String,
    pub attempts: i64,
    pub last_attempt: Option<String>,
    pub error_message: Option<String>,
    pub next_retry_at: Option<String>,
    pub retry_delay_ms: i64,
    pub priority: i64,
    pub module_type: String,
    pub conflict_strategy: String,
    pub version: i64,
    /// Wave 10 H8: per-claim generation counter. The caller MUST pass
    /// this value back to `mark_success` — a mismatch means the row was
    /// reclaimed (lease expired) and the success ack is silently dropped.
    pub claim_generation: i64,
    pub status: String,
}

/// Input for enqueueing a new item (fields auto-populated by the queue).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueInput {
    pub table_name: String,
    pub record_id: String,
    pub operation: String,
    pub data: String,
    pub organization_id: String,
    pub priority: Option<i64>,
    pub module_type: Option<String>,
    pub conflict_strategy: Option<String>,
    pub version: Option<i64>,
}

/// Result of a queue processing batch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub success: bool,
    pub processed: i64,
    pub failed: i64,
    pub conflicts: i64,
    /// Rows newly quarantined during this processing batch.
    pub quarantined: i64,
    /// Rows that newly crossed into terminal failure during this batch.
    pub dead_lettered: i64,
    pub errors: Vec<SyncError>,
    /// Wave 4 H: items that exhausted `MAX_RETRY_ATTEMPTS` during this
    /// batch for entity types classified as monetary. The Tauri
    /// command layer emits a `sync:dead-letter:monetary` event for
    /// each, so the operator UI can surface a persistent alarm. Empty
    /// when no monetary items dead-lettered this cycle.
    #[serde(default)]
    pub monetary_dead_letters: Vec<MonetaryDeadLetter>,
    #[serde(default)]
    pub(crate) auth_outcome: Option<ParityAuthOutcome>,
    #[serde(default)]
    pub(crate) batch_block: Option<ParityClaimGateBlock>,
    /// Aggregate-only telemetry for the just-finished replay batch. This is
    /// safe to persist in diagnostics because it never includes queued payload
    /// JSON, response bodies, API keys, or customer data.
    pub telemetry: SyncTelemetrySnapshot,
}

/// A monetary sync item that crossed the max-retry threshold and was
/// flagged `failed`. The operator UI surfaces these so silent
/// dead-letters cannot happen.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MonetaryDeadLetterCategory {
    Payment,
    PaymentAdjustment,
    ZReport,
    StaffShift,
    ShiftExpense,
    StaffPayment,
    DriverEarning,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonetaryDeadLetter {
    pub(crate) category: MonetaryDeadLetterCategory,
}

/// Authoritative outcome of one generation-fenced failure acknowledgement.
///
/// Callers must derive batch counters and operator events from this result,
/// never from the stale `attempts` snapshot carried by a dequeued item.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarkFailureOutcome {
    pub(crate) applied: bool,
    pub(crate) transitioned_to_dead_letter: bool,
    pub(crate) monetary_notice: Option<MonetaryDeadLetter>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ParityAuthOutcome {
    StaffSessionRequired,
    SoftTerminalAuth {
        code: ParityTerminalAuthCode,
        terminal_active: Option<bool>,
    },
    HardTerminalAuth {
        code: ParityTerminalAuthCode,
        terminal_active: Option<bool>,
    },
}

impl ParityAuthOutcome {
    fn terminal(failure: ParityTerminalAuthFailure) -> Self {
        if failure.code.is_hard() {
            Self::HardTerminalAuth {
                code: failure.code,
                terminal_active: failure.terminal_active,
            }
        } else {
            Self::SoftTerminalAuth {
                code: failure.code,
                terminal_active: failure.terminal_active,
            }
        }
    }

    fn precedence(self) -> u8 {
        match self {
            Self::StaffSessionRequired => 1,
            Self::SoftTerminalAuth { .. } => 2,
            Self::HardTerminalAuth { .. } => 3,
        }
    }
}

fn merge_auth_outcome(current: &mut Option<ParityAuthOutcome>, candidate: ParityAuthOutcome) {
    if current.as_ref().map_or(true, |existing| {
        candidate.precedence() > existing.precedence()
    }) {
        *current = Some(candidate);
    }
}

fn parse_parity_terminal_auth_failure(
    status: u16,
    response_body: &str,
) -> Option<ParityTerminalAuthFailure> {
    if !matches!(status, 401 | 403) || response_body.len() > 16 * 1024 {
        return None;
    }
    let payload = serde_json::from_str::<Value>(response_body).ok()?;
    let code = payload.get("code")?.as_str()?.trim().to_ascii_lowercase();
    let code = ParityTerminalAuthCode::from_wire(&code)?;
    let terminal_active = payload
        .get("terminalActive")
        .or_else(|| payload.get("terminal_active"))
        .and_then(Value::as_bool);
    Some(ParityTerminalAuthFailure {
        code,
        terminal_active,
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ParityClaimGateBlock {
    RemoteAuthPaused,
    Cancelled,
    RebindPending,
    ResetPending,
}

/// Individual error from queue processing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncError {
    pub item_id: String,
    pub table_name: String,
    pub record_id: String,
    pub error: String,
    pub http_status: Option<u16>,
}

fn bounded_sync_error_code(error: &str, http_status: Option<u16>) -> String {
    if error == "Parity sync request is missing terminal_id context" {
        return error.to_string();
    }
    if error.contains("requiring review") {
        return "Conflict requiring review".to_string();
    }
    if error.len() <= 96
        && !error.is_empty()
        && error
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return error.to_string();
    }
    match http_status {
        Some(429) => "HTTP_429_RATE_LIMITED".to_string(),
        Some(status) if (400..500).contains(&status) => "PARITY_CLIENT_ERROR".to_string(),
        Some(status) if status >= 500 => "PARITY_SERVER_ERROR".to_string(),
        _ => "PARITY_PROCESSING_ERROR".to_string(),
    }
}

fn safe_sync_error(item: &SyncQueueItem, error_code: &str, http_status: Option<u16>) -> SyncError {
    let table_name = match item.table_name.as_str() {
        "repairs" => "repairs",
        "repair_attachments" => "repair_attachments",
        _ => "parity",
    };
    SyncError {
        item_id: String::new(),
        table_name: table_name.to_string(),
        record_id: String::new(),
        error: bounded_sync_error_code(error_code, http_status),
        http_status,
    }
}

/// Summary status of the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatus {
    pub total: i64,
    pub pending: i64,
    #[serde(default)]
    pub in_progress: i64,
    pub failed: i64,
    pub conflicts: i64,
    #[serde(default)]
    pub quarantined: i64,
    #[serde(default)]
    pub dead_lettered: i64,
    pub oldest_item_age: Option<i64>,
}

/// Active-row usage split by how rows leave the queue: `replayable` rows
/// (`pending` + `processing`) drain through `process_queue`, while
/// `conflict` rows wait for operator resolution. Each side has its own
/// ceiling (`MAX_QUEUE_SIZE` / `MAX_CONFLICT_ROWS`).
#[derive(Debug, Clone, Copy)]
pub struct QueueCapacityUsage {
    pub replayable: i64,
    pub conflicts: i64,
}

/// Early-warning payload for a queue approaching a capacity ceiling.
///
/// Mirrors the `MonetaryDeadLetter` pattern: this module builds the
/// payload, and the Tauri layer (the sync loop in `sync.rs`) emits it to
/// the renderer as `sync:queue-capacity-warning` so staff see "sync
/// backlog growing" long before `enqueue` fail-closes domain writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCapacityWarning {
    pub replayable: i64,
    pub max_replayable: i64,
    pub conflicts: i64,
    pub max_conflicts: i64,
    /// Replayable usage as an integer percentage of `MAX_QUEUE_SIZE`.
    pub replayable_percent: i64,
    /// Conflict usage as an integer percentage of `MAX_CONFLICT_ROWS`.
    pub conflict_percent: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTelemetrySnapshot {
    pub started_at: String,
    pub finished_at: String,
    pub queue_depth_before: i64,
    pub queue_depth_after: i64,
    pub replay_attempts: i64,
    pub deferred: i64,
    pub processed: i64,
    pub failed: i64,
    pub conflicts: i64,
    pub terminal_auth_failures: i64,
    pub scope: SyncTelemetryScope,
    pub queue_status: QueueStatus,
    pub outcomes: Vec<SyncTelemetryOutcome>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncTelemetryScope {
    pub organization_id: Option<String>,
    pub terminal_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTelemetryOutcome {
    pub module_type: String,
    pub status: String,
    pub error_class: String,
    pub count: i64,
}

#[derive(Debug)]
struct SyncTelemetryBuilder {
    started_at: String,
    queue_depth_before: i64,
    replay_attempts: i64,
    deferred: i64,
    terminal_auth_failures: i64,
    outcomes: BTreeMap<(String, String, String), i64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum QueueProcessVisibility {
    InternalAll,
    RendererNonRepair,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum QueueProcessSelection<'a> {
    All,
    ExactRendererItem(&'a str),
}

const REPAIR_NATIVE_PRODUCER_REQUIRED: &str = "REPAIR_NATIVE_PRODUCER_REQUIRED";
const REPAIR_RESERVED_OWNER_QUARANTINED: &str = "REPAIR_RESERVED_OWNER_QUARANTINED";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RepairQueueOwnership {
    Generic,
    TrustedCanonical,
    ReservedLookalike,
}

fn is_semantic_repair_module(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("repairs")
}

fn is_semantic_repair_table(value: &str) -> bool {
    let value = value.trim();
    value.eq_ignore_ascii_case("repairs") || value.eq_ignore_ascii_case("repair_attachments")
}

fn classify_repair_queue_ownership(
    module_type: Option<&str>,
    table_name: &str,
) -> RepairQueueOwnership {
    let semantic_reserved =
        module_type.is_some_and(is_semantic_repair_module) || is_semantic_repair_table(table_name);
    if !semantic_reserved {
        return RepairQueueOwnership::Generic;
    }
    if module_type == Some("repairs") && matches!(table_name, "repairs" | "repair_attachments") {
        RepairQueueOwnership::TrustedCanonical
    } else {
        RepairQueueOwnership::ReservedLookalike
    }
}

// SQLite's one-argument trim() only strips U+0020. This character set mirrors
// Rust `str::trim()`/`char::is_whitespace`, so renderer SQL and the native
// classifier cannot disagree on ASCII or Unicode edge whitespace.
const SQLITE_RUST_WHITESPACE_CODEPOINTS: &str =
    "9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288";

fn semantic_sql_value(expression: &str) -> String {
    format!("lower(trim(COALESCE({expression}, ''), char({SQLITE_RUST_WHITESPACE_CODEPOINTS})))")
}

fn semantic_reserved_repair_owner_predicate(alias: &str) -> String {
    let module = semantic_sql_value(&format!("{alias}.module_type"));
    let table = semantic_sql_value(&format!("{alias}.table_name"));
    format!("({module} = 'repairs' OR {table} IN ('repairs', 'repair_attachments'))")
}

fn canonical_repair_owner_predicate(alias: &str) -> String {
    format!(
        "(COALESCE({alias}.module_type, '') = 'repairs' AND {alias}.table_name IN ('repairs', 'repair_attachments'))"
    )
}

fn reserved_repair_lookalike_predicate(alias: &str) -> String {
    let semantic = semantic_reserved_repair_owner_predicate(alias);
    let canonical = canonical_repair_owner_predicate(alias);
    format!("({semantic} AND NOT {canonical})")
}

fn renderer_generic_owner_predicate(alias: &str) -> String {
    format!("NOT ({})", semantic_reserved_repair_owner_predicate(alias))
}

fn semantic_repair_financial_queue_owner_predicate(alias: &str) -> String {
    let order_context = semantic_sql_value("repair_owner.order_context");
    let table = semantic_sql_value(&format!("{alias}.table_name"));
    format!(
        "EXISTS (
             SELECT 1
             FROM orders repair_owner
             WHERE {order_context} = 'repair_settlement'
               AND (
                    ({table} = 'orders'
                     AND (repair_owner.id = {alias}.record_id
                          OR repair_owner.supabase_id = {alias}.record_id))
                    OR ({table} IN ('payments', 'order_payments')
                        AND EXISTS (
                            SELECT 1 FROM order_payments repair_payment
                            WHERE repair_payment.id = {alias}.record_id
                              AND repair_payment.order_id = repair_owner.id
                        ))
                    OR ({table} = 'payment_adjustments'
                        AND EXISTS (
                            SELECT 1
                            FROM payment_adjustments repair_adjustment
                            LEFT JOIN order_payments repair_adjustment_payment
                              ON repair_adjustment_payment.id = repair_adjustment.payment_id
                            WHERE repair_adjustment.id = {alias}.record_id
                              AND COALESCE(
                                    NULLIF(repair_adjustment.order_id, ''),
                                    repair_adjustment_payment.order_id
                                  ) = repair_owner.id
                        ))
               )
         )"
    )
}

fn semantic_generic_nonfinancial_owner_predicate(alias: &str) -> String {
    let generic = renderer_generic_owner_predicate(alias);
    let financial = semantic_repair_financial_queue_owner_predicate(alias);
    format!("({generic} AND NOT ({financial}))")
}

fn semantic_repair_audit_owner_predicate(alias: &str) -> String {
    let entity_type = semantic_sql_value(&format!("{alias}.entity_type"));
    format!("{entity_type} IN ('repairs', 'repair_attachments')")
}

fn semantic_repair_financial_audit_owner_predicate(alias: &str) -> String {
    let order_context = semantic_sql_value("repair_owner.order_context");
    let entity_type = semantic_sql_value(&format!("{alias}.entity_type"));
    format!(
        "EXISTS (
             SELECT 1
             FROM orders repair_owner
             WHERE {order_context} = 'repair_settlement'
               AND (
                    ({entity_type} IN ('order', 'orders')
                     AND (repair_owner.id = {alias}.entity_id
                          OR repair_owner.supabase_id = {alias}.entity_id))
                    OR ({entity_type} IN ('payment', 'payments', 'order_payments')
                        AND EXISTS (
                            SELECT 1
                            FROM order_payments repair_payment
                            WHERE repair_payment.id = {alias}.entity_id
                              AND repair_payment.order_id = repair_owner.id
                        ))
                    OR ({entity_type} IN ('payment_adjustment', 'payment_adjustments')
                        AND EXISTS (
                            SELECT 1
                            FROM payment_adjustments repair_adjustment
                            LEFT JOIN order_payments repair_adjustment_payment
                              ON repair_adjustment_payment.id = repair_adjustment.payment_id
                            WHERE repair_adjustment.id = {alias}.entity_id
                              AND COALESCE(
                                    NULLIF(repair_adjustment.order_id, ''),
                                    repair_adjustment_payment.order_id
                                  ) = repair_owner.id
                        ))
               )
         )"
    )
}

/// Deletes repair-owned queue/audit rows and, for an operational identity
/// purge, the linked local settlement ledger. The caller owns the surrounding
/// transaction so identity publication and every SQLite purge effect can be
/// committed or rolled back together.
pub(crate) fn purge_repair_owned_sync_state(
    connection: &Connection,
    include_financial: bool,
) -> Result<(), String> {
    let direct_queue = semantic_reserved_repair_owner_predicate("parity_sync_queue");
    let financial_queue = semantic_repair_financial_queue_owner_predicate("parity_sync_queue");
    let direct_audit = semantic_repair_audit_owner_predicate("conflict_audit_log");
    let financial_audit = semantic_repair_financial_audit_owner_predicate("conflict_audit_log");
    let order_context = semantic_sql_value("order_context");

    let queue_predicate = if include_financial {
        format!("({direct_queue}) OR ({financial_queue})")
    } else {
        direct_queue
    };
    connection
        .execute(
            &format!("DELETE FROM parity_sync_queue WHERE {queue_predicate}"),
            [],
        )
        .map_err(|_| "REPAIR_SCOPE_PURGE_FAILED".to_string())?;

    if include_financial {
        connection
            .execute(
                &format!(
                    "DELETE FROM conflict_audit_log
                      WHERE ({direct_audit}) OR ({financial_audit})"
                ),
                [],
            )
            .map_err(|_| "REPAIR_OPERATIONAL_PURGE_FAILED".to_string())?;
        connection
            .execute(
                &format!(
                    "DELETE FROM payment_adjustments
                      WHERE order_id IN (
                          SELECT id FROM orders WHERE {order_context} = 'repair_settlement'
                      )
                         OR payment_id IN (
                          SELECT payment.id
                            FROM order_payments payment
                            JOIN orders repair_order ON repair_order.id = payment.order_id
                           WHERE {} = 'repair_settlement'
                      )",
                    semantic_sql_value("repair_order.order_context")
                ),
                [],
            )
            .map_err(|_| "REPAIR_OPERATIONAL_PURGE_FAILED".to_string())?;
        connection
            .execute(
                &format!(
                    "DELETE FROM order_payments
                      WHERE order_id IN (
                          SELECT id FROM orders WHERE {order_context} = 'repair_settlement'
                      )"
                ),
                [],
            )
            .map_err(|_| "REPAIR_OPERATIONAL_PURGE_FAILED".to_string())?;
        connection
            .execute(
                &format!("DELETE FROM orders WHERE {order_context} = 'repair_settlement'"),
                [],
            )
            .map_err(|_| "REPAIR_OPERATIONAL_PURGE_FAILED".to_string())?;
    }
    Ok(())
}

/// Terminally parks non-canonical semantic repair owners without inspecting
/// their renderer-supplied payload. The single UPDATE is atomic and the final
/// guard makes repeated startup/runtime passes byte-for-byte idempotent.
pub(crate) fn quarantine_reserved_repair_lookalikes(conn: &Connection) -> Result<i64, String> {
    let poison = reserved_repair_lookalike_predicate("parity_sync_queue");
    let sql = format!(
        "UPDATE parity_sync_queue
            SET status = 'failed',
                error_message = '{REPAIR_RESERVED_OWNER_QUARANTINED}',
                next_retry_at = NULL,
                claim_generation = claim_generation
                    + CASE WHEN status = 'processing' THEN 1 ELSE 0 END
          WHERE status IN ('pending', 'processing', 'failed', 'conflict')
            AND {poison}
            AND NOT (
                status = 'failed'
                AND error_message = '{REPAIR_RESERVED_OWNER_QUARANTINED}'
                AND next_retry_at IS NULL
            )"
    );
    conn.execute(&sql, [])
        .map(|affected| affected as i64)
        .map_err(|error| format!("sync_queue reserved-owner quarantine: {error}"))
}

fn renderer_non_repair_owned_predicate(alias: &str) -> String {
    format!(
        "NOT ({})",
        semantic_repair_financial_queue_owner_predicate(alias)
    )
}

fn renderer_non_repair_conflict_owner_predicate(alias: &str) -> String {
    let direct = semantic_repair_audit_owner_predicate(alias);
    let financial = semantic_repair_financial_audit_owner_predicate(alias);
    format!("NOT ({direct}) AND NOT ({financial})")
}

const REPAIR_AUDIT_PAYLOAD_REDACTED: &str = "REPAIR_AUDIT_PAYLOAD_REDACTED";
const MAX_REPAIR_AUDIT_REDACTIONS_PER_PASS: i64 = 500;

/// Payload-blind forward maintenance for legacy audit rows that can be
/// positively attributed to the native repair domain. Unclassifiable history
/// is retained unchanged; renderer filtering remains the fail-closed boundary.
pub(crate) fn redact_identifiable_legacy_repair_audit_payloads(
    conn: &Connection,
) -> Result<i64, String> {
    let direct = semantic_repair_audit_owner_predicate("candidate");
    let financial = semantic_repair_financial_audit_owner_predicate("candidate");
    let sql = format!(
        "UPDATE conflict_audit_log
            SET discarded_payload = ?1
          WHERE id IN (
                SELECT candidate.id
                  FROM conflict_audit_log candidate
                 WHERE candidate.discarded_payload <> ?1
                   AND ({direct} OR {financial})
                 ORDER BY candidate.timestamp ASC, candidate.id ASC
                 LIMIT ?2
          )
            AND discarded_payload <> ?1"
    );
    conn.execute(
        &sql,
        params![
            REPAIR_AUDIT_PAYLOAD_REDACTED,
            MAX_REPAIR_AUDIT_REDACTIONS_PER_PASS
        ],
    )
    .map(|affected| affected as i64)
    .map_err(|error| format!("sync_queue repair audit redaction: {error}"))
}

impl SyncTelemetryBuilder {
    fn new(started_at: String, queue_depth_before: i64) -> Self {
        Self {
            started_at,
            queue_depth_before,
            replay_attempts: 0,
            deferred: 0,
            terminal_auth_failures: 0,
            outcomes: BTreeMap::new(),
        }
    }

    fn record_attempt(&mut self) {
        self.replay_attempts += 1;
    }

    fn record_deferred(&mut self, item: &SyncQueueItem, reason: &str) {
        self.deferred += 1;
        self.record_outcome(item, "pending", classify_sync_error(Some(reason), None));
    }

    fn record_error(
        &mut self,
        item: &SyncQueueItem,
        status: &str,
        error: &str,
        http_status: Option<u16>,
    ) {
        let error_class = classify_sync_error(Some(error), http_status);
        if error_class == "terminal_auth" {
            self.terminal_auth_failures += 1;
        }
        self.record_outcome(item, status, error_class);
    }

    fn record_success(&mut self, item: &SyncQueueItem) {
        self.record_outcome(item, "processed", "none");
    }

    fn record_outcome(&mut self, item: &SyncQueueItem, status: &str, error_class: &str) {
        let key = (
            bounded_module_category(&item.module_type).to_string(),
            status.to_string(),
            error_class.to_string(),
        );
        *self.outcomes.entry(key).or_insert(0) += 1;
    }

    fn finish(
        self,
        conn: &Connection,
        processed: i64,
        failed: i64,
        conflicts: i64,
        visibility: QueueProcessVisibility,
    ) -> Result<SyncTelemetrySnapshot, String> {
        let queue_status = match visibility {
            QueueProcessVisibility::InternalAll => get_status(conn)?,
            QueueProcessVisibility::RendererNonRepair => renderer_get_status(conn)?,
        };
        let queue_depth_after = queue_status.total;
        Ok(SyncTelemetrySnapshot {
            started_at: self.started_at,
            finished_at: Utc::now().to_rfc3339(),
            queue_depth_before: self.queue_depth_before,
            queue_depth_after,
            replay_attempts: self.replay_attempts,
            deferred: self.deferred,
            processed,
            failed,
            conflicts,
            terminal_auth_failures: self.terminal_auth_failures,
            scope: sync_telemetry_scope(conn),
            queue_status,
            outcomes: self
                .outcomes
                .into_iter()
                .map(
                    |((module_type, status, error_class), count)| SyncTelemetryOutcome {
                        module_type,
                        status,
                        error_class,
                        count,
                    },
                )
                .collect(),
        })
    }
}

/// Query options for listing actionable parity queue items.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueueListQuery {
    pub limit: Option<i64>,
    pub module_type: Option<String>,
}

/// Result of retrying parity queue items.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryItemsResult {
    pub retried: i64,
}

/// Conflict audit entry returned to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAuditEntry {
    pub id: String,
    pub operation_type: String,
    pub entity_id: String,
    pub entity_type: String,
    pub local_version: i64,
    pub server_version: i64,
    pub timestamp: String,
    pub discarded_payload: String,
    pub resolution: String,
    pub is_monetary: bool,
    pub reviewed_by_operator: bool,
}

#[derive(Debug)]
enum RequestPreparation {
    Ready(RequestSpec),
    Consumed { reason: String },
    Deferred { reason: String },
    Failed { reason: String },
    ManualResolution { reason_code: String },
}

#[derive(Debug, Clone)]
struct RequestSpec {
    endpoint: String,
    method: Method,
    body: Option<String>,
    terminal_id: String,
}

const STALE_ORDER_UPDATE_PARENT_WAIT_REASON: &str =
    "Stale order update replay: local parent order missing";
const SUPERSEDED_ORDER_UPDATE_REASON: &str =
    "Order status update superseded by a locally synced newer status";
const SUPERSEDED_ORDER_STATUS_REBASE_REASON: &str = "superseded_status_rebase";

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

/// Create the `parity_sync_queue` and `conflict_audit_log` tables if they do
/// not already exist. Called during database migration.
pub fn create_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS parity_sync_queue (
            id              TEXT PRIMARY KEY,
            table_name      TEXT NOT NULL,
            record_id       TEXT NOT NULL,
            operation       TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
            data            TEXT NOT NULL,
            organization_id TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            attempts        INTEGER NOT NULL DEFAULT 0,
            last_attempt    TEXT,
            error_message   TEXT,
            next_retry_at   TEXT,
            retry_delay_ms  INTEGER NOT NULL DEFAULT 1000,
            priority        INTEGER NOT NULL DEFAULT 0,
            module_type     TEXT NOT NULL DEFAULT 'orders',
            conflict_strategy TEXT NOT NULL DEFAULT 'server-wins',
            version         INTEGER NOT NULL DEFAULT 1,
            -- Task 9C: native repair commands and attachments share one
            -- ordered aggregate stream. Generic parity rows remain NULL.
            repair_aggregate_id TEXT,
            -- Wave 10 H8: per-claim generation counter. Incremented on
            -- every claim (`dequeue`) and on every stale-reclaim
            -- (`recover_stale_processing_items`). `mark_success` only
            -- accepts a caller's success-mark when the generation matches
            -- the row's current generation — preventing a late ack from a
            -- worker whose lease expired from polluting a fresh in-flight
            -- claim. See `project_w10_h8_claim_generation_deferred.md`.
            claim_generation INTEGER NOT NULL DEFAULT 0,
            status          TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'failed', 'conflict'))
        );

        CREATE INDEX IF NOT EXISTS idx_parity_sq_priority_created
            ON parity_sync_queue (priority DESC, created_at ASC);

        CREATE INDEX IF NOT EXISTS idx_parity_sq_next_retry
            ON parity_sync_queue (next_retry_at ASC)
            WHERE next_retry_at IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_parity_sq_org
            ON parity_sync_queue (organization_id);

        CREATE TABLE IF NOT EXISTS conflict_audit_log (
            id                    TEXT PRIMARY KEY,
            operation_type        TEXT NOT NULL,
            entity_id             TEXT NOT NULL,
            entity_type           TEXT NOT NULL,
            local_version         INTEGER NOT NULL,
            server_version        INTEGER NOT NULL,
            timestamp             TEXT NOT NULL DEFAULT (datetime('now')),
            discarded_payload     TEXT NOT NULL,
            resolution            TEXT NOT NULL,
            is_monetary           INTEGER NOT NULL DEFAULT 0,
            reviewed_by_operator  INTEGER NOT NULL DEFAULT 0
        );
        ",
    )
    .map_err(|e| format!("sync_queue create_tables: {e}"))?;

    info!("Parity sync queue tables initialized");
    Ok(())
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/// Count active rows split into replayable (`pending`/`processing`) and
/// `conflict` buckets.
///
/// Single pass whose WHERE clause matches the `idx_parity_sync_queue_active`
/// partial-index predicate (migrate_v50) exactly, keeping this O(active
/// rows). SQLite's partial-index implication check is syntactic, so a
/// narrower `IN ('pending', 'processing')` filter would NOT use the index
/// and would fall back to a full-table scan.
pub fn capacity_usage(conn: &Connection) -> Result<QueueCapacityUsage, String> {
    let mut stmt = conn
        .prepare(
            "SELECT status, COUNT(*)
             FROM parity_sync_queue
             WHERE status IN ('pending', 'processing', 'conflict')
             GROUP BY status",
        )
        .map_err(|e| format!("sync_queue capacity prepare: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("sync_queue capacity query: {e}"))?;

    let mut usage = QueueCapacityUsage {
        replayable: 0,
        conflicts: 0,
    };
    for row in rows {
        let (status, count) = row.map_err(|e| format!("sync_queue capacity row: {e}"))?;
        if status == "conflict" {
            usage.conflicts += count;
        } else {
            usage.replayable += count;
        }
    }

    Ok(usage)
}

/// Read-only wake predicate for the existing native background scheduler.
/// Pending work observes per-row backoff; abandoned processing work becomes
/// actionable only after the same lease used by stale-claim recovery.
pub(crate) fn has_actionable_internal_work(conn: &Connection) -> Result<bool, String> {
    let lease_modifier = format!("-{} seconds", PROCESSING_LEASE_SECS);
    let generic = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let reserved = semantic_reserved_repair_owner_predicate("parity_sync_queue");
    let actionable_owner = format!("({generic} OR {reserved})");
    let sql = format!(
        "SELECT EXISTS(
             SELECT 1
             FROM parity_sync_queue
             WHERE {actionable_owner}
               AND (
                    status = 'pending'
                    AND (
                        next_retry_at IS NULL
                        OR julianday(next_retry_at) <= julianday('now')
                    )
                OR (
                    status = 'processing'
                    AND julianday(COALESCE(last_attempt, created_at))
                        <= julianday('now', ?1)
                )
              )
         )"
    );
    conn.query_row(&sql, params![lease_modifier], |row| row.get(0))
        .map_err(|error| format!("sync_queue inspect actionable parity work: {error}"))
}

/// Returns a warning payload when either capacity dimension sits at or
/// above `CAPACITY_WARNING_PERCENT` of its ceiling, `None` while
/// comfortably below.
///
/// Called from the sync loop on every tick -- including offline ticks,
/// which is exactly when the backlog grows -- so the renderer hears about
/// backlog pressure well before `enqueue` starts rejecting.
pub fn capacity_warning(conn: &Connection) -> Result<Option<QueueCapacityWarning>, String> {
    let usage = capacity_usage(conn)?;
    let replayable_threshold = MAX_QUEUE_SIZE * CAPACITY_WARNING_PERCENT / 100;
    let conflict_threshold = MAX_CONFLICT_ROWS * CAPACITY_WARNING_PERCENT / 100;

    if usage.replayable < replayable_threshold && usage.conflicts < conflict_threshold {
        return Ok(None);
    }

    Ok(Some(QueueCapacityWarning {
        replayable: usage.replayable,
        max_replayable: MAX_QUEUE_SIZE,
        conflicts: usage.conflicts,
        max_conflicts: MAX_CONFLICT_ROWS,
        replayable_percent: usage.replayable * 100 / MAX_QUEUE_SIZE,
        conflict_percent: usage.conflicts * 100 / MAX_CONFLICT_ROWS,
    }))
}

/// Enqueue a new sync item. Returns the generated UUID.
///
/// Rejects (fail-closed) if replayable rows have reached `MAX_QUEUE_SIZE`
/// or conflict rows have reached `MAX_CONFLICT_ROWS`.
pub fn enqueue(conn: &Connection, input: &EnqueueInput) -> Result<String, String> {
    if classify_repair_queue_ownership(input.module_type.as_deref(), &input.table_name)
        != RepairQueueOwnership::Generic
    {
        return Err(REPAIR_NATIVE_PRODUCER_REQUIRED.to_string());
    }

    // A rejected reserved input returns above without touching SQLite. For a
    // genuinely generic producer, recover historical poison before capacity
    // accounting so it cannot permanently consume replayable headroom.
    quarantine_reserved_repair_lookalikes(conn)?;

    // Wave 6 narrowed the capacity COUNT from a full-table COUNT(*) to
    // ACTIVE rows only, so permanently-failed dead-letters stopped
    // tripping the guard. Founder decision 2026-06-10 narrows it again:
    // only REPLAYABLE rows (pending/processing) consume `MAX_QUEUE_SIZE`,
    // because `conflict` rows never drain offline -- they wait for
    // operator resolution -- and were squeezing checkout capacity.
    // Conflicts keep their own fail-closed ceiling below so unbounded
    // conflict growth still surfaces. `capacity_usage` rides the
    // `idx_parity_sync_queue_active` partial index, so both gates stay
    // O(active rows).
    let QueueCapacityUsage {
        replayable,
        conflicts,
    } = capacity_usage(conn)?;

    if conflicts >= MAX_CONFLICT_ROWS {
        return Err(format!(
            "Sync queue conflict backlog is full ({conflicts}/{MAX_CONFLICT_ROWS}). \
             Resolve conflicted items before enqueuing more."
        ));
    }

    if replayable >= MAX_QUEUE_SIZE {
        return Err(format!(
            "Sync queue is full ({replayable}/{MAX_QUEUE_SIZE}). \
             Clear or process pending items before enqueuing more."
        ));
    }

    // Validate operation
    let op = input.operation.to_uppercase();
    if op != "INSERT" && op != "UPDATE" && op != "DELETE" {
        return Err(format!(
            "Invalid sync operation '{}'. Expected INSERT, UPDATE, or DELETE.",
            input.operation
        ));
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let priority = input.priority.unwrap_or(0);
    let module_type = input.module_type.as_deref().unwrap_or("orders");
    let conflict_strategy = input.conflict_strategy.as_deref().unwrap_or("server-wins");
    let version = input.version.unwrap_or(1);

    conn.execute(
        "INSERT INTO parity_sync_queue
            (id, table_name, record_id, operation, data, organization_id,
             created_at, attempts, retry_delay_ms, priority, module_type,
             conflict_strategy, version, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11, ?12, 'pending')",
        params![
            id,
            input.table_name,
            input.record_id,
            op,
            input.data,
            input.organization_id,
            now,
            DEFAULT_INITIAL_RETRY_DELAY_MS,
            priority,
            module_type,
            conflict_strategy,
            version,
        ],
    )
    .map_err(|e| format!("sync_queue enqueue: {e}"))?;

    info!(
        id = %id,
        table = %input.table_name,
        record = %input.record_id,
        op = %op,
        org = %input.organization_id,
        "Enqueued sync item"
    );

    Ok(id)
}

/// Native-only repair producer seam. The queue primary key is the command's
/// canonical operation id so retries cannot mint a second server operation.
/// Callers are expected to invoke this inside the same SQLite transaction as
/// the optimistic repair cache/alias mutation; any INSERT failure therefore
/// rolls the whole producer transaction back.
pub(crate) fn enqueue_repair_with_fixed_id(
    conn: &Connection,
    operation_id: &str,
    repair_aggregate_id: &str,
    input: &EnqueueInput,
) -> Result<String, String> {
    let canonical_id = Uuid::parse_str(operation_id)
        .map_err(|_| "REPAIR_OPERATION_ID_INVALID".to_string())?
        .to_string();
    if canonical_id != operation_id {
        return Err("REPAIR_OPERATION_ID_INVALID".to_string());
    }
    let canonical_org = Uuid::parse_str(input.organization_id.as_str())
        .map_err(|_| "REPAIR_QUEUE_ENVELOPE_INVALID".to_string())?
        .to_string();
    let canonical_record = Uuid::parse_str(input.record_id.as_str())
        .map_err(|_| "REPAIR_QUEUE_ENVELOPE_INVALID".to_string())?
        .to_string();
    let canonical_aggregate = Uuid::parse_str(repair_aggregate_id)
        .map_err(|_| "REPAIR_QUEUE_AGGREGATE_BINDING_INVALID".to_string())?
        .to_string();
    if canonical_aggregate != repair_aggregate_id
        || (input.table_name == "repairs" && input.record_id != repair_aggregate_id)
    {
        return Err("REPAIR_QUEUE_AGGREGATE_BINDING_INVALID".to_string());
    }
    if classify_repair_queue_ownership(input.module_type.as_deref(), &input.table_name)
        != RepairQueueOwnership::TrustedCanonical
        || input.conflict_strategy.as_deref() != Some("manual")
        || input.operation != "INSERT"
        || canonical_org != input.organization_id
        || canonical_record != input.record_id
    {
        return Err("REPAIR_QUEUE_ENVELOPE_INVALID".to_string());
    }
    if input.table_name == "repair_attachments" {
        let (candidate_count, binding_count) = conn
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN repair_id = ?5 THEN 1 ELSE 0 END), 0)
                   FROM repair_attachment_staging
                  WHERE organization_id = ?1
                    AND attachment_id = ?2
                    AND operation_id = ?3
                    AND queue_id = ?3
                    AND expected_version = ?4",
                params![
                    input.organization_id,
                    input.record_id,
                    operation_id,
                    input.version.unwrap_or(0),
                    repair_aggregate_id,
                ],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(|_| "REPAIR_QUEUE_AGGREGATE_BINDING_INVALID".to_string())?;
        if candidate_count != 1 || binding_count != 1 {
            return Err("REPAIR_QUEUE_AGGREGATE_BINDING_INVALID".to_string());
        }
    }

    quarantine_reserved_repair_lookalikes(conn)?;

    let QueueCapacityUsage {
        replayable,
        conflicts,
    } = capacity_usage(conn)?;
    if conflicts >= MAX_CONFLICT_ROWS || replayable >= MAX_QUEUE_SIZE {
        return Err("REPAIR_QUEUE_CAPACITY_EXHAUSTED".to_string());
    }

    let version = input.version.unwrap_or(0);
    if !(0..=9_007_199_254_740_991).contains(&version) {
        return Err("REPAIR_QUEUE_VERSION_INVALID".to_string());
    }
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO parity_sync_queue
            (id, table_name, record_id, operation, data, organization_id,
             created_at, attempts, retry_delay_ms, priority, module_type,
             conflict_strategy, version, repair_aggregate_id, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, 'repairs',
                 'manual', ?10, ?11, 'pending')",
        params![
            operation_id,
            input.table_name,
            input.record_id,
            "INSERT",
            input.data,
            input.organization_id,
            now,
            DEFAULT_INITIAL_RETRY_DELAY_MS,
            input.priority.unwrap_or(0),
            version,
            repair_aggregate_id,
        ],
    )
    .map_err(|_| "REPAIR_QUEUE_INSERT_FAILED".to_string())?;

    Ok(operation_id.to_string())
}

fn string_field(payload: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

fn infer_organization_id(conn: &Connection, payload: &Value) -> String {
    string_field(payload, &["organizationId", "organization_id"])
        .or_else(|| db::get_setting(conn, "terminal", "organization_id"))
        .or_else(|| storage::get_credential("organization_id"))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "pending-org".to_string())
}

fn resolve_runtime_context(conn: &Connection, payload: &Value) -> (String, String, String) {
    // Keyring-first after the inline payload: OS credential store is
    // authoritative; plaintext `local_settings` is backward-compat fallback.
    let terminal_id = string_field(payload, &["terminalId", "terminal_id"])
        .or_else(|| runtime_credential(conn, "terminal_id"))
        .unwrap_or_default();
    let branch_id = string_field(payload, &["branchId", "branch_id"])
        .or_else(|| runtime_credential(conn, "branch_id"))
        .unwrap_or_default();
    let organization_id = infer_organization_id(conn, payload);

    (terminal_id, branch_id, organization_id)
}

fn runtime_credential(conn: &Connection, key: &str) -> Option<String> {
    #[cfg(test)]
    if db::get_setting(conn, "terminal", "__ignore_keyring").as_deref() == Some("1") {
        return db::get_setting(conn, "terminal", key);
    }

    storage::get_credential(key).or_else(|| db::get_setting(conn, "terminal", key))
}

fn resolve_request_terminal_id(conn: &Connection, payload: &Value) -> Option<String> {
    let (terminal_id, _, _) = resolve_runtime_context(conn, payload);
    let trimmed = terminal_id.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn is_local_placeholder_id(record_id: &str) -> bool {
    let normalized = record_id.trim().to_ascii_lowercase();
    normalized == "local-new"
        || normalized.starts_with("local-")
        || normalized.starts_with("legacy:")
}

fn read_local_json_array_setting(conn: &Connection, key: &str) -> Vec<Value> {
    db::get_setting(conn, "local", key)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|parsed| parsed.as_array().cloned())
        .unwrap_or_default()
}

fn write_local_json_array_setting(
    conn: &Connection,
    key: &str,
    values: &[Value],
) -> Result<(), String> {
    db::set_setting(
        conn,
        "local",
        key,
        &Value::Array(values.to_vec()).to_string(),
    )
}

fn customer_address_coordinates(value: &Value) -> Option<(f64, f64)> {
    let lat = nested_value(value, &["coordinates", "lat"])
        .and_then(number_from_value)
        .or_else(|| value.get("latitude").and_then(number_from_value));
    let lng = nested_value(value, &["coordinates", "lng"])
        .and_then(number_from_value)
        .or_else(|| value.get("longitude").and_then(number_from_value));

    match (lat, lng) {
        (Some(lat), Some(lng)) => Some((lat, lng)),
        _ => None,
    }
}

fn same_customer_address_coordinates(left: &Value, right: &Value) -> bool {
    match (
        customer_address_coordinates(left),
        customer_address_coordinates(right),
    ) {
        (Some((left_lat, left_lng)), Some((right_lat, right_lng))) => {
            (left_lat - right_lat).abs() < 0.000_001 && (left_lng - right_lng).abs() < 0.000_001
        }
        _ => false,
    }
}

fn customer_address_cache_matches_payload(candidate: &Value, payload: &Value) -> bool {
    if same_customer_address_coordinates(candidate, payload) {
        return true;
    }

    let candidate_street = string_field(candidate, &["street_address", "street", "address"])
        .map(|value| value.to_ascii_lowercase());
    let payload_street = string_field(payload, &["street_address", "street", "address"])
        .map(|value| value.to_ascii_lowercase());

    if let (Some(candidate_street), Some(payload_street)) = (candidate_street, payload_street) {
        if candidate_street == payload_street {
            return true;
        }
    }

    let candidate_formatted =
        string_field(candidate, &["formatted_address"]).map(|value| value.to_ascii_lowercase());
    let payload_formatted =
        string_field(payload, &["formatted_address"]).map(|value| value.to_ascii_lowercase());

    matches!(
        (candidate_formatted, payload_formatted),
        (Some(candidate_formatted), Some(payload_formatted)) if candidate_formatted == payload_formatted
    )
}

fn find_cached_customer_address(
    conn: &Connection,
    customer_id: &str,
    address_id: &str,
    payload: &Value,
) -> Option<Value> {
    let cache = read_local_json_array_setting(conn, "customer_cache_v1");

    cache
        .into_iter()
        .find(|customer| {
            string_field(customer, &["id", "customerId"])
                .is_some_and(|candidate| candidate == customer_id)
        })
        .and_then(|customer| customer.get("addresses").and_then(Value::as_array).cloned())
        .and_then(|addresses| {
            addresses
                .iter()
                .find(|address| {
                    string_field(address, &["id", "addressId"])
                        .is_some_and(|candidate| candidate == address_id)
                })
                .cloned()
                .or_else(|| {
                    if is_local_placeholder_id(address_id) {
                        addresses
                            .iter()
                            .find(|address| {
                                customer_address_cache_matches_payload(address, payload)
                            })
                            .cloned()
                    } else {
                        None
                    }
                })
        })
}

fn merge_customer_address_payload_from_cache(
    conn: &Connection,
    customer_id: &str,
    address_id: &str,
    payload: &Value,
) -> Value {
    let Some(cached_address) = find_cached_customer_address(conn, customer_id, address_id, payload)
    else {
        return payload.clone();
    };

    let mut merged = cached_address.as_object().cloned().unwrap_or_default();
    if let Some(payload_object) = payload.as_object() {
        for (key, value) in payload_object {
            if !value.is_null() {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    merged.insert(
        "customer_id".to_string(),
        Value::String(customer_id.to_string()),
    );

    Value::Object(merged)
}

fn load_recent_order_address_fallback(conn: &Connection, customer_id: &str) -> Option<Value> {
    conn.query_row(
        "SELECT
             delivery_address,
             delivery_city,
             delivery_postal_code,
             delivery_floor,
             delivery_notes,
             name_on_ringer
         FROM orders
         WHERE customer_id = ?1
           AND COALESCE(TRIM(delivery_address), '') != ''
         ORDER BY COALESCE(updated_at, created_at, '') DESC
         LIMIT 1",
        params![customer_id],
        |row| {
            let street_address: Option<String> = row.get(0)?;
            let city: Option<String> = row.get(1)?;
            let postal_code: Option<String> = row.get(2)?;
            let floor_number: Option<String> = row.get(3)?;
            let notes: Option<String> = row.get(4)?;
            let name_on_ringer: Option<String> = row.get(5)?;

            Ok(serde_json::json!({
                "street_address": street_address.clone(),
                "street": street_address,
                "city": city,
                "postal_code": postal_code,
                "floor_number": floor_number,
                "notes": notes,
                "delivery_notes": notes,
                "name_on_ringer": name_on_ringer,
            }))
        },
    )
    .optional()
    .ok()
    .flatten()
}

fn merge_customer_address_payload_for_recreate(
    conn: &Connection,
    customer_id: &str,
    address_id: &str,
    payload: &Value,
) -> Value {
    let merged = merge_customer_address_payload_from_cache(conn, customer_id, address_id, payload);
    if has_customer_address_street(&merged) {
        return merged;
    }

    let Some(order_fallback) = load_recent_order_address_fallback(conn, customer_id) else {
        return merged;
    };

    let mut hydrated = order_fallback.as_object().cloned().unwrap_or_default();
    if let Some(merged_object) = merged.as_object() {
        for (key, value) in merged_object {
            if !value.is_null() {
                hydrated.insert(key.clone(), value.clone());
            }
        }
    }
    hydrated.insert(
        "customer_id".to_string(),
        Value::String(customer_id.to_string()),
    );

    Value::Object(hydrated)
}

fn has_customer_address_street(payload: &Value) -> bool {
    string_field(payload, &["street_address", "street", "address"]).is_some()
}

fn normalize_customer_address_for_cache(mut address: Value) -> Value {
    let now = Utc::now().to_rfc3339();
    let street = string_field(&address, &["street_address", "street", "address"]);
    let notes = address
        .get("notes")
        .cloned()
        .or_else(|| address.get("delivery_notes").cloned())
        .unwrap_or(Value::Null);
    let coordinates = customer_address_coordinates(&address);

    if let Some(obj) = address.as_object_mut() {
        if let Some(street) = street.clone() {
            obj.entry("street_address".to_string())
                .or_insert_with(|| Value::String(street.clone()));
            obj.entry("street".to_string())
                .or_insert_with(|| Value::String(street));
        }

        obj.insert("notes".to_string(), notes.clone());
        obj.insert("delivery_notes".to_string(), notes);

        if !obj.contains_key("createdAt") {
            let created_at = obj
                .get("created_at")
                .cloned()
                .unwrap_or_else(|| Value::String(now.clone()));
            obj.insert("createdAt".to_string(), created_at);
        }
        if !obj.contains_key("updatedAt") {
            let updated_at = obj
                .get("updated_at")
                .cloned()
                .unwrap_or_else(|| Value::String(now.clone()));
            obj.insert("updatedAt".to_string(), updated_at);
        }
        if !obj.contains_key("version") {
            obj.insert("version".to_string(), Value::from(1));
        }
        if let Some((lat, lng)) = coordinates {
            obj.entry("latitude".to_string())
                .or_insert(Value::from(lat));
            obj.entry("longitude".to_string())
                .or_insert(Value::from(lng));
            obj.entry("coordinates".to_string())
                .or_insert_with(|| serde_json::json!({ "lat": lat, "lng": lng }));
        }
    }

    address
}

fn find_cached_customer_address_index(
    addresses: &[Value],
    item_record_id: &str,
    remote_id: Option<&str>,
    payload: &Value,
) -> Option<usize> {
    if let Some(remote_id) = remote_id {
        if let Some(index) = addresses.iter().position(|address| {
            string_field(address, &["id", "addressId"])
                .is_some_and(|candidate| candidate == remote_id)
        }) {
            return Some(index);
        }
    }

    if let Some(index) = addresses.iter().position(|address| {
        string_field(address, &["id", "addressId"])
            .is_some_and(|candidate| candidate == item_record_id)
    }) {
        return Some(index);
    }

    if is_local_placeholder_id(item_record_id) {
        return addresses
            .iter()
            .position(|address| customer_address_cache_matches_payload(address, payload));
    }

    None
}

fn update_customer_address_cache_after_sync(
    conn: &Connection,
    item: &SyncQueueItem,
    response: Option<&Value>,
) -> Result<(), String> {
    let payload = serde_json::from_str::<Value>(&item.data).unwrap_or(Value::Null);
    let response_address = response.and_then(|value| {
        value
            .get("address")
            .cloned()
            .or_else(|| value.get("data").cloned())
    });
    let customer_id = response_address
        .as_ref()
        .and_then(|address| string_field(address, &["customer_id", "customerId"]))
        .or_else(|| extract_customer_id_from_sync_payload(item));

    let Some(customer_id) = customer_id else {
        return Ok(());
    };

    let mut customers = read_local_json_array_setting(conn, "customer_cache_v1");
    let Some(customer) = customers.iter_mut().find(|entry| {
        string_field(entry, &["id", "customerId"]).is_some_and(|candidate| candidate == customer_id)
    }) else {
        return Ok(());
    };

    let Some(customer_object) = customer.as_object_mut() else {
        return Ok(());
    };

    let addresses_value = customer_object
        .entry("addresses".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(addresses) = addresses_value.as_array_mut() else {
        return Ok(());
    };

    if item.operation == "DELETE" {
        addresses.retain(|address| {
            find_cached_customer_address_index(
                std::slice::from_ref(address),
                item.record_id.as_str(),
                None,
                &payload,
            )
            .is_none()
        });
    } else if let Some(response_address) = response_address {
        let normalized_address = normalize_customer_address_for_cache(response_address);
        let remote_id = string_field(&normalized_address, &["id", "addressId"]);
        if let Some(index) = find_cached_customer_address_index(
            addresses,
            item.record_id.as_str(),
            remote_id.as_deref(),
            &payload,
        ) {
            addresses[index] = normalized_address;
        } else {
            addresses.push(normalized_address);
        }
    }

    customer_object.insert(
        "updatedAt".to_string(),
        Value::String(Utc::now().to_rfc3339()),
    );

    write_local_json_array_setting(conn, "customer_cache_v1", &customers)
}

fn nested_value<'a>(payload: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = payload;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn string_from_value(value: &Value) -> Option<String> {
    match value {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn number_from_value(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|candidate| candidate as f64))
        .or_else(|| value.as_u64().map(|candidate| candidate as f64))
        .or_else(|| {
            value
                .as_str()
                .and_then(|candidate| candidate.trim().parse::<f64>().ok())
        })
}

fn integer_from_value(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| {
            value
                .as_u64()
                .and_then(|candidate| i64::try_from(candidate).ok())
        })
        .or_else(|| {
            value
                .as_str()
                .and_then(|candidate| candidate.trim().parse::<i64>().ok())
        })
        .or_else(|| number_from_value(value).map(|candidate| candidate.round() as i64))
}

fn bool_from_value(value: &Value) -> Option<bool> {
    value
        .as_bool()
        .or_else(|| {
            value.as_i64().and_then(|candidate| match candidate {
                0 => Some(false),
                1 => Some(true),
                _ => None,
            })
        })
        .or_else(|| {
            value.as_str().and_then(|candidate| {
                let normalized = candidate.trim().to_ascii_lowercase();
                match normalized.as_str() {
                    "true" | "1" | "yes" | "on" => Some(true),
                    "false" | "0" | "no" | "off" => Some(false),
                    _ => None,
                }
            })
        })
}

fn jsonish_value(value: &Value) -> Value {
    if let Some(raw) = value.as_str() {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            return parsed;
        }
    }
    value.clone()
}

fn string_field_from_sources(sources: &[&Value], keys: &[&str]) -> Option<String> {
    for source in sources {
        for key in keys {
            if let Some(value) = source.get(*key).and_then(string_from_value) {
                return Some(value);
            }
        }
    }
    None
}

fn nested_string_field_from_sources(sources: &[&Value], paths: &[&[&str]]) -> Option<String> {
    for source in sources {
        for path in paths {
            if let Some(value) = nested_value(source, path).and_then(string_from_value) {
                return Some(value);
            }
        }
    }
    None
}

fn number_field_from_sources(sources: &[&Value], keys: &[&str]) -> Option<f64> {
    for source in sources {
        for key in keys {
            if let Some(value) = source.get(*key).and_then(number_from_value) {
                return Some(value);
            }
        }
    }
    None
}

fn integer_field_from_sources(sources: &[&Value], keys: &[&str]) -> Option<i64> {
    for source in sources {
        for key in keys {
            if let Some(value) = source.get(*key).and_then(integer_from_value) {
                return Some(value);
            }
        }
    }
    None
}

fn bool_field_from_sources(sources: &[&Value], keys: &[&str]) -> Option<bool> {
    for source in sources {
        for key in keys {
            if let Some(value) = source.get(*key).and_then(bool_from_value) {
                return Some(value);
            }
        }
    }
    None
}

fn json_field_from_sources(sources: &[&Value], keys: &[&str]) -> Option<Value> {
    for source in sources {
        for key in keys {
            if let Some(value) = source.get(*key) {
                if !value.is_null() {
                    return Some(jsonish_value(value));
                }
            }
        }
    }
    None
}

fn parse_json_array(value: &Value) -> Vec<Value> {
    match jsonish_value(value) {
        Value::Array(values) => values,
        _ => Vec::new(),
    }
}

fn normalize_order_type_for_insert(raw_type: Option<&str>) -> String {
    match raw_type
        .map(|candidate| candidate.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "pickup".to_string())
        .as_str()
    {
        "dine-in" | "dine_in" | "dinein" => "dine-in".to_string(),
        "delivery" => "delivery".to_string(),
        "drive-through" | "drive_through" | "drivethrough" => "drive-through".to_string(),
        "takeaway" => "takeaway".to_string(),
        "take-away" | "take_away" | "takeout" | "pickup" => "pickup".to_string(),
        _ => "pickup".to_string(),
    }
}

fn normalize_payment_status_for_insert(raw_status: Option<&str>) -> String {
    match raw_status
        .map(|candidate| candidate.trim().to_ascii_lowercase())
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

fn normalize_payment_method_for_insert(raw_method: Option<&str>) -> String {
    match raw_method
        .map(|candidate| candidate.trim().to_ascii_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "" | "pending" => "cash".to_string(),
        "cash" => "cash".to_string(),
        "card" => "card".to_string(),
        "digital_wallet" | "digital-wallet" | "wallet" => "digital_wallet".to_string(),
        _ => "other".to_string(),
    }
}

fn normalize_payment_method_for_update(raw_method: Option<&str>) -> Option<String> {
    match raw_method
        .map(|candidate| candidate.trim().to_ascii_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "" | "pending" => None,
        "cash" => Some("cash".to_string()),
        "card" => Some("card".to_string()),
        "digital_wallet" | "digital-wallet" | "wallet" => Some("digital_wallet".to_string()),
        "gift_card" | "gift-card" => Some("gift_card".to_string()),
        "other" => Some("other".to_string()),
        _ => Some("other".to_string()),
    }
}

fn customization_key(value: &Value, index: usize) -> String {
    string_from_value(&value["customizationId"])
        .or_else(|| string_from_value(&value["optionId"]))
        .or_else(|| string_from_value(&value["name"]))
        .or_else(|| nested_value(value, &["ingredient", "id"]).and_then(string_from_value))
        .or_else(|| nested_value(value, &["ingredient", "name"]).and_then(string_from_value))
        .unwrap_or_else(|| format!("item-{index}"))
}

fn normalize_customizations_for_insert(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };

    match jsonish_value(value) {
        Value::Null => Value::Null,
        Value::Object(object) => Value::Object(object),
        Value::Array(items) => {
            let mut normalized = Map::new();
            for (index, item) in items.into_iter().enumerate() {
                normalized.insert(customization_key(&item, index), item);
            }
            Value::Object(normalized)
        }
        _ => Value::Null,
    }
}

fn normalize_order_update_items_for_request(
    items: &Value,
    order_discount_amount: Option<f64>,
    order_subtotal: Option<f64>,
) -> Option<Value> {
    let normalized = normalize_order_insert_items(items);
    if normalized.is_empty() {
        return None;
    }

    let has_manual_or_stale_item = normalized.iter().any(|item| {
        item.get("menu_item_id")
            .and_then(Value::as_str)
            .filter(|candidate| Uuid::parse_str(candidate).is_ok())
            .is_none()
    });

    if has_manual_or_stale_item {
        // Older admin deployments still have a NOT NULL/FK-constrained
        // order_items.menu_item_id on the PATCH replacement path. Keep the
        // replay moving by syncing the status and financial snapshot; the
        // local table check remains the source for manual line details.
        return None;
    }

    let discount_amount = order_discount_amount.unwrap_or_default().max(0.0);
    if discount_amount <= 0.0 {
        return Some(Value::Array(normalized));
    }

    let mut pre_discount_subtotal = 0.0;
    let mut has_original_override = false;
    for item in &normalized {
        let quantity = number_field_from_sources(&[item], &["quantity"])
            .unwrap_or(1.0)
            .max(1.0);
        let unit_price = number_field_from_sources(&[item], &["unit_price", "unitPrice", "price"])
            .unwrap_or_default()
            .max(0.0);
        let original_unit_price =
            number_field_from_sources(&[item], &["original_unit_price", "originalUnitPrice"])
                .unwrap_or_default()
                .max(0.0);
        let uses_original = original_unit_price > 0.0 && original_unit_price > unit_price;
        if uses_original {
            has_original_override = true;
        }
        pre_discount_subtotal += if uses_original {
            original_unit_price
        } else {
            unit_price
        } * quantity;
    }

    if let Some(expected_subtotal) = order_subtotal.filter(|value| *value > 0.0) {
        let tolerance = (normalized.len() as f64 * 0.01).max(0.02);
        if (pre_discount_subtotal - expected_subtotal).abs() > tolerance {
            return None;
        }
    } else if !has_original_override {
        return None;
    }

    let mut adjusted = normalized;
    for item in &mut adjusted {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        let quantity = object
            .get("quantity")
            .and_then(number_from_value)
            .unwrap_or(1.0)
            .max(1.0);
        let unit_price = object
            .get("unit_price")
            .and_then(number_from_value)
            .unwrap_or_default()
            .max(0.0);
        let original_unit_price = object
            .get("original_unit_price")
            .and_then(number_from_value)
            .unwrap_or_default()
            .max(0.0);
        if original_unit_price > 0.0 && original_unit_price > unit_price {
            object.insert(
                "unit_price".to_string(),
                serde_json::json!(original_unit_price),
            );
            object.insert(
                "total_price".to_string(),
                serde_json::json!((original_unit_price * quantity * 100.0).round() / 100.0),
            );
        }
    }

    Some(Value::Array(adjusted))
}

fn normalize_order_insert_items(raw_items: &Value) -> Vec<Value> {
    let mut normalized = Vec::new();

    for item in parse_json_array(raw_items) {
        let menu_item_id = string_field(&item, &["menu_item_id", "menuItemId"])
            .filter(|candidate| Uuid::parse_str(candidate).is_ok());
        let name = string_field(&item, &["name", "menu_item_name", "menuItemName"]);
        let quantity = number_field_from_sources(&[&item], &["quantity"])
            .unwrap_or(1.0)
            .max(1.0)
            .round() as i64;
        let raw_total = number_field_from_sources(&[&item], &["total_price", "totalPrice"])
            .unwrap_or_default()
            .max(0.0);
        let unit_price = number_field_from_sources(&[&item], &["unit_price", "unitPrice", "price"])
            .or_else(|| {
                if raw_total > 0.0 && quantity > 0 {
                    Some(raw_total / quantity as f64)
                } else {
                    None
                }
            })
            .unwrap_or_default()
            .max(0.0);
        let total_price = if raw_total > 0.0 {
            raw_total
        } else {
            (unit_price * quantity as f64).max(0.0)
        };

        let original_unit_price =
            number_field_from_sources(&[&item], &["original_unit_price", "originalUnitPrice"])
                .filter(|value| *value > 0.0);
        let explicit_price_override =
            bool_field_from_sources(&[&item], &["is_price_overridden", "isPriceOverridden"]);
        let derived_price_override = original_unit_price
            .map(|original| (original - unit_price).abs() > 0.005)
            .unwrap_or(false);

        let mut normalized_item = serde_json::json!({
            "menu_item_id": menu_item_id,
            "quantity": quantity,
            "unit_price": unit_price,
            "total_price": total_price,
            "name": name,
            "notes": string_field(&item, &["notes", "specialInstructions", "special_instructions"]),
            "customizations": normalize_customizations_for_insert(item.get("customizations")),
        });
        if let Some(object) = normalized_item.as_object_mut() {
            if let Some(original_unit_price) = original_unit_price {
                object.insert(
                    "original_unit_price".to_string(),
                    serde_json::json!(original_unit_price),
                );
            }
            if let Some(is_price_overridden) = explicit_price_override {
                object.insert(
                    "is_price_overridden".to_string(),
                    serde_json::json!(is_price_overridden),
                );
            } else if derived_price_override {
                object.insert("is_price_overridden".to_string(), serde_json::json!(true));
            }
        }

        normalized.push(normalized_item);
    }

    normalized
}

fn load_local_order_insert_fallback(
    conn: &Connection,
    order_id: &str,
) -> Result<Option<Value>, String> {
    // W6: `orders.payment_method` was dropped in v55; the sync-payload
    // `payment_method` field is derived below via
    // `payments::derive_payment_method` so the admin-dashboard row still
    // receives a value that matches on-the-wire semantics.
    let derived_method = crate::payments::derive_payment_method(conn, order_id)?;
    conn.query_row(
        "SELECT
            order_number,
            customer_name,
            customer_phone,
            customer_email,
            customer_id,
            items,
            total_amount,
            total_amount_cents,
            tax_amount,
            tax_amount_cents,
            subtotal,
            subtotal_cents,
            status,
            order_type,
            table_number,
            delivery_address,
            delivery_address_id,
            delivery_city,
            delivery_postal_code,
            delivery_floor,
            delivery_notes,
            delivery_latitude,
            delivery_longitude,
            delivery_address_fingerprint,
            delivery_zone_id,
            name_on_ringer,
            special_instructions,
            estimated_time,
            payment_status,
            driver_id,
            driver_name,
            discount_percentage,
            discount_amount,
            discount_amount_cents,
            tip_amount,
            tip_amount_cents,
            terminal_id,
            branch_id,
            tax_rate,
            delivery_fee,
            delivery_fee_cents,
            client_request_id,
            is_ghost,
            ghost_source,
            ghost_metadata,
            table_id,
            table_session_id,
            guest_count
         FROM orders
         WHERE id = ?1
         LIMIT 1",
        params![order_id],
        |row| {
            let mut object = Map::new();

            let insert_string =
                |object: &mut Map<String, Value>, key: &str, value: Option<String>| {
                    if let Some(value) = value {
                        object.insert(key.to_string(), Value::String(value));
                    }
                };
            let insert_number = |object: &mut Map<String, Value>, key: &str, value: Option<f64>| {
                if let Some(value) = value {
                    object.insert(key.to_string(), serde_json::json!(value));
                }
            };
            let insert_integer =
                |object: &mut Map<String, Value>, key: &str, value: Option<i64>| {
                    if let Some(value) = value {
                        object.insert(key.to_string(), Value::from(value));
                    }
                };

            insert_string(
                &mut object,
                "order_number",
                row.get::<_, Option<String>>("order_number")?,
            );
            insert_string(
                &mut object,
                "customer_name",
                row.get::<_, Option<String>>("customer_name")?,
            );
            insert_string(
                &mut object,
                "customer_phone",
                row.get::<_, Option<String>>("customer_phone")?,
            );
            insert_string(
                &mut object,
                "customer_email",
                row.get::<_, Option<String>>("customer_email")?,
            );
            insert_string(
                &mut object,
                "customer_id",
                row.get::<_, Option<String>>("customer_id")?,
            );
            insert_number(
                &mut object,
                "total_amount",
                row.get::<_, Option<f64>>("total_amount")?,
            );
            insert_integer(
                &mut object,
                "total_amount_cents",
                row.get::<_, Option<i64>>("total_amount_cents")?,
            );
            insert_number(
                &mut object,
                "tax_amount",
                row.get::<_, Option<f64>>("tax_amount")?,
            );
            insert_integer(
                &mut object,
                "tax_amount_cents",
                row.get::<_, Option<i64>>("tax_amount_cents")?,
            );
            insert_number(
                &mut object,
                "subtotal",
                row.get::<_, Option<f64>>("subtotal")?,
            );
            insert_integer(
                &mut object,
                "subtotal_cents",
                row.get::<_, Option<i64>>("subtotal_cents")?,
            );
            insert_string(
                &mut object,
                "status",
                row.get::<_, Option<String>>("status")?,
            );
            insert_string(
                &mut object,
                "order_type",
                row.get::<_, Option<String>>("order_type")?,
            );
            insert_string(
                &mut object,
                "table_number",
                row.get::<_, Option<String>>("table_number")?,
            );
            insert_string(
                &mut object,
                "table_id",
                row.get::<_, Option<String>>("table_id")?,
            );
            insert_string(
                &mut object,
                "table_session_id",
                row.get::<_, Option<String>>("table_session_id")?,
            );
            insert_integer(
                &mut object,
                "guest_count",
                row.get::<_, Option<i64>>("guest_count")?,
            );
            insert_string(
                &mut object,
                "delivery_address",
                row.get::<_, Option<String>>("delivery_address")?,
            );
            insert_string(
                &mut object,
                "delivery_address_id",
                row.get::<_, Option<String>>("delivery_address_id")?,
            );
            insert_string(
                &mut object,
                "delivery_city",
                row.get::<_, Option<String>>("delivery_city")?,
            );
            insert_string(
                &mut object,
                "delivery_postal_code",
                row.get::<_, Option<String>>("delivery_postal_code")?,
            );
            insert_string(
                &mut object,
                "delivery_floor",
                row.get::<_, Option<String>>("delivery_floor")?,
            );
            insert_string(
                &mut object,
                "delivery_notes",
                row.get::<_, Option<String>>("delivery_notes")?,
            );
            insert_number(
                &mut object,
                "delivery_latitude",
                row.get::<_, Option<f64>>("delivery_latitude")?,
            );
            insert_number(
                &mut object,
                "delivery_longitude",
                row.get::<_, Option<f64>>("delivery_longitude")?,
            );
            insert_string(
                &mut object,
                "delivery_address_fingerprint",
                row.get::<_, Option<String>>("delivery_address_fingerprint")?,
            );
            insert_string(
                &mut object,
                "delivery_zone_id",
                row.get::<_, Option<String>>("delivery_zone_id")?,
            );
            insert_string(
                &mut object,
                "name_on_ringer",
                row.get::<_, Option<String>>("name_on_ringer")?,
            );
            insert_string(
                &mut object,
                "special_instructions",
                row.get::<_, Option<String>>("special_instructions")?,
            );
            insert_integer(
                &mut object,
                "estimated_time",
                row.get::<_, Option<i64>>("estimated_time")?,
            );
            insert_string(
                &mut object,
                "payment_status",
                row.get::<_, Option<String>>("payment_status")?,
            );
            insert_string(&mut object, "payment_method", derived_method.clone());
            insert_string(
                &mut object,
                "driver_id",
                row.get::<_, Option<String>>("driver_id")?,
            );
            insert_string(
                &mut object,
                "driver_name",
                row.get::<_, Option<String>>("driver_name")?,
            );
            insert_number(
                &mut object,
                "discount_percentage",
                row.get::<_, Option<f64>>("discount_percentage")?,
            );
            insert_number(
                &mut object,
                "discount_amount",
                row.get::<_, Option<f64>>("discount_amount")?,
            );
            insert_integer(
                &mut object,
                "discount_amount_cents",
                row.get::<_, Option<i64>>("discount_amount_cents")?,
            );
            insert_number(
                &mut object,
                "tip_amount",
                row.get::<_, Option<f64>>("tip_amount")?,
            );
            insert_integer(
                &mut object,
                "tip_amount_cents",
                row.get::<_, Option<i64>>("tip_amount_cents")?,
            );
            insert_string(
                &mut object,
                "terminal_id",
                row.get::<_, Option<String>>("terminal_id")?,
            );
            insert_string(
                &mut object,
                "branch_id",
                row.get::<_, Option<String>>("branch_id")?,
            );
            insert_number(
                &mut object,
                "tax_rate",
                row.get::<_, Option<f64>>("tax_rate")?,
            );
            insert_number(
                &mut object,
                "delivery_fee",
                row.get::<_, Option<f64>>("delivery_fee")?,
            );
            insert_integer(
                &mut object,
                "delivery_fee_cents",
                row.get::<_, Option<i64>>("delivery_fee_cents")?,
            );
            insert_string(
                &mut object,
                "client_request_id",
                row.get::<_, Option<String>>("client_request_id")?,
            );
            insert_string(
                &mut object,
                "ghost_source",
                row.get::<_, Option<String>>("ghost_source")?,
            );

            if let Some(items_json) = row.get::<_, Option<String>>("items")? {
                if let Ok(items) = serde_json::from_str::<Value>(&items_json) {
                    object.insert("items".to_string(), items);
                }
            }

            if let Some(is_ghost) = row.get::<_, Option<i64>>("is_ghost")? {
                object.insert("is_ghost".to_string(), Value::Bool(is_ghost != 0));
            }

            if let Some(ghost_metadata) = row.get::<_, Option<String>>("ghost_metadata")? {
                if let Ok(parsed) = serde_json::from_str::<Value>(&ghost_metadata) {
                    object.insert("ghost_metadata".to_string(), parsed);
                }
            }

            Ok(Value::Object(object))
        },
    )
    .optional()
    .map_err(|e| format!("sync_queue load_local_order_insert_fallback: {e}"))
}

fn build_order_insert_body(
    conn: &Connection,
    record_id: &str,
    payload: &Value,
) -> Result<Value, String> {
    let local_order = load_local_order_insert_fallback(conn, record_id)?;
    let payload_root = payload.get("orderData").unwrap_or(payload);
    let mut sources = vec![payload_root, payload];
    if let Some(local_order) = local_order.as_ref() {
        sources.push(local_order);
    }

    let (_, runtime_branch_id, _) = resolve_runtime_context(conn, payload);
    let items_raw =
        json_field_from_sources(&sources, &["items"]).unwrap_or_else(|| Value::Array(vec![]));
    let items = normalize_order_insert_items(&items_raw);
    if items.is_empty() {
        return Err("Order insert payload is missing items".to_string());
    }

    let items_subtotal = items
        .iter()
        .map(|item| {
            item.get("total_price")
                .and_then(Value::as_f64)
                .unwrap_or_default()
        })
        .sum::<f64>();
    let subtotal = number_field_from_sources(&sources, &["subtotal"])
        .unwrap_or(items_subtotal)
        .max(0.0);
    let tax_amount = number_field_from_sources(&sources, &["tax_amount", "taxAmount"])
        .unwrap_or_default()
        .max(0.0);
    let delivery_fee = number_field_from_sources(&sources, &["delivery_fee", "deliveryFee"])
        .unwrap_or_default()
        .max(0.0);
    let manual_discount_mode =
        string_field_from_sources(&sources, &["manual_discount_mode", "manualDiscountMode"])
            .filter(|mode| matches!(mode.as_str(), "percentage" | "fixed"));
    let manual_discount_value =
        number_field_from_sources(&sources, &["manual_discount_value", "manualDiscountValue"])
            .map(|value| value.max(0.0));
    let discount_percentage =
        number_field_from_sources(&sources, &["discount_percentage", "discountPercentage"])
            .or_else(|| {
                if manual_discount_mode.as_deref() == Some("percentage") {
                    manual_discount_value
                } else {
                    None
                }
            })
            .unwrap_or_default()
            .max(0.0);
    let discount_amount =
        number_field_from_sources(&sources, &["discount_amount", "discountAmount"])
            .or_else(|| {
                if manual_discount_mode.as_deref() == Some("fixed") {
                    manual_discount_value
                } else if discount_percentage > 0.0 {
                    Some((subtotal * (discount_percentage / 100.0)).max(0.0))
                } else {
                    None
                }
            })
            .unwrap_or_default()
            .max(0.0);
    let coupon_discount_amount = number_field_from_sources(
        &sources,
        &["coupon_discount_amount", "couponDiscountAmount"],
    )
    .unwrap_or_default()
    .max(0.0);

    let total_amount =
        number_field_from_sources(&sources, &["total_amount", "totalAmount", "total"])
            .unwrap_or_else(|| {
                (subtotal + tax_amount + delivery_fee - discount_amount - coupon_discount_amount)
                    .max(0.0)
            })
            .max(0.0);

    let branch_id = string_field_from_sources(&sources, &["branch_id", "branchId"])
        .or_else(|| {
            let trimmed = runtime_branch_id.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .filter(|candidate| Uuid::parse_str(candidate).is_ok())
        .ok_or_else(|| "Order insert payload is missing valid branch_id".to_string())?;

    let payment_method_raw =
        string_field_from_sources(&sources, &["payment_method", "paymentMethod"])
            .or_else(|| nested_string_field_from_sources(&sources, &[&["paymentData", "method"]]));
    let payment_method = normalize_payment_method_for_insert(payment_method_raw.as_deref());
    let payment_status = normalize_payment_status_for_insert(
        string_field_from_sources(&sources, &["payment_status", "paymentStatus"]).as_deref(),
    );
    let order_type = normalize_order_type_for_insert(
        string_field_from_sources(&sources, &["order_type", "orderType"]).as_deref(),
    );
    // Some admin deployments still require `payment_method` on create even for
    // unpaid table checks. Keep `payment_status = pending` and omit
    // `initial_payment`; this compatibility value does not create a payment.
    let payment_method_json = Value::String(payment_method.clone());

    let customer_id = string_field_from_sources(&sources, &["customer_id", "customerId"])
        .or_else(|| nested_string_field_from_sources(&sources, &[&["customer", "id"]]))
        .filter(|candidate| Uuid::parse_str(candidate).is_ok());
    let customer_name = string_field_from_sources(&sources, &["customer_name", "customerName"])
        .or_else(|| {
            nested_string_field_from_sources(
                &sources,
                &[&["customer", "name"], &["customer", "full_name"]],
            )
        });
    let customer_phone = string_field_from_sources(&sources, &["customer_phone", "customerPhone"])
        .or_else(|| {
            nested_string_field_from_sources(
                &sources,
                &[&["customer", "phone_number"], &["customer", "phone"]],
            )
        });
    let customer_email = string_field_from_sources(&sources, &["customer_email", "customerEmail"])
        .or_else(|| nested_string_field_from_sources(&sources, &[&["customer", "email"]]));
    let delivery_address =
        string_field_from_sources(&sources, &["delivery_address", "deliveryAddress"]).or_else(
            || {
                nested_string_field_from_sources(
                    &sources,
                    &[
                        &["address", "street_address"],
                        &["address", "street"],
                        &["address", "address"],
                    ],
                )
            },
        );
    let delivery_address_id =
        string_field_from_sources(&sources, &["delivery_address_id", "deliveryAddressId"])
            .filter(|candidate| Uuid::parse_str(candidate).is_ok());
    let delivery_city = string_field_from_sources(&sources, &["delivery_city", "deliveryCity"])
        .or_else(|| nested_string_field_from_sources(&sources, &[&["address", "city"]]));
    let delivery_postal_code =
        string_field_from_sources(&sources, &["delivery_postal_code", "deliveryPostalCode"])
            .or_else(|| {
                nested_string_field_from_sources(
                    &sources,
                    &[
                        &["address", "postal_code"],
                        &["address", "postalCode"],
                        &["address", "zip"],
                    ],
                )
            });
    let delivery_floor = string_field_from_sources(&sources, &["delivery_floor", "deliveryFloor"])
        .or_else(|| {
            nested_string_field_from_sources(
                &sources,
                &[&["address", "floor_number"], &["address", "floor"]],
            )
        });
    let delivery_notes = string_field_from_sources(&sources, &["delivery_notes", "deliveryNotes"])
        .or_else(|| {
            nested_string_field_from_sources(
                &sources,
                &[&["address", "delivery_notes"], &["address", "notes"]],
            )
        });
    let name_on_ringer = string_field_from_sources(&sources, &["name_on_ringer", "nameOnRinger"])
        .or_else(|| {
            nested_string_field_from_sources(
                &sources,
                &[&["address", "name_on_ringer"], &["address", "nameOnRinger"]],
            )
        });
    let delivery_latitude = number_field_from_sources(
        &sources,
        &["delivery_latitude", "deliveryLatitude", "latitude"],
    )
    .filter(|value| value.is_finite() && (-90.0..=90.0).contains(value));
    let delivery_longitude = number_field_from_sources(
        &sources,
        &["delivery_longitude", "deliveryLongitude", "longitude"],
    )
    .filter(|value| value.is_finite() && (-180.0..=180.0).contains(value));
    let delivery_address_fingerprint = string_field_from_sources(
        &sources,
        &[
            "delivery_address_fingerprint",
            "deliveryAddressFingerprint",
            "address_fingerprint",
        ],
    );
    let delivery_zone_id =
        string_field_from_sources(&sources, &["delivery_zone_id", "deliveryZoneId"])
            .filter(|candidate| Uuid::parse_str(candidate).is_ok());
    let table_id = string_field_from_sources(&sources, &["table_id", "tableId"])
        .filter(|candidate| Uuid::parse_str(candidate).is_ok());
    let table_session_id =
        string_field_from_sources(&sources, &["table_session_id", "tableSessionId"])
            .filter(|candidate| Uuid::parse_str(candidate).is_ok());
    let guest_count = integer_field_from_sources(&sources, &["guest_count", "guestCount"])
        .map(|value| value.clamp(1, 99));
    let ghost_metadata = json_field_from_sources(&sources, &["ghost_metadata", "ghostMetadata"])
        .and_then(|value| match value {
            Value::Object(_) => Some(value),
            _ => None,
        });

    // W4d-iv additive emission: every monetary float key gets a `_cents`
    // sibling so admin-dashboard can read either shape during the bake
    // window. coupon_discount_amount and manual_discount_value are
    // included; manual_discount_mode is a string so no cents needed.
    let explicit_tip_amount =
        number_field_from_sources(&sources, &["tip_amount", "tipAmount"]).unwrap_or(0.0);
    let expected_pre_tip_total =
        (subtotal + tax_amount + delivery_fee - discount_amount - coupon_discount_amount).max(0.0);
    let tip_amount = if explicit_tip_amount > 0.0 {
        explicit_tip_amount
    } else {
        let expected_tip_cents = Cents::round_half_even(total_amount).as_i64()
            - Cents::round_half_even(expected_pre_tip_total).as_i64();
        if expected_tip_cents > 0 {
            let completed_payment_tip_cents: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(
                         COALESCE(
                           tip_amount_cents,
                           CAST(ROUND(COALESCE(tip_amount, 0) * 100) AS INTEGER),
                           0
                         )
                       ), 0)
                     FROM order_payments
                     WHERE order_id = ?1
                       AND lower(COALESCE(status, '')) = 'completed'",
                    params![record_id],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    format!("sync_queue recover missing order tip from payment: {error}")
                })?;
            if completed_payment_tip_cents == expected_tip_cents {
                conn.execute(
                    "UPDATE orders
                     SET tip_amount = ?1,
                         tip_amount_cents = ?2
                     WHERE id = ?3
                       AND COALESCE(
                         tip_amount_cents,
                         CAST(ROUND(COALESCE(tip_amount, 0) * 100) AS INTEGER),
                         0
                       ) = 0",
                    params![
                        Cents::new(completed_payment_tip_cents).to_f64_dp2(),
                        completed_payment_tip_cents,
                        record_id
                    ],
                )
                .map_err(|error| {
                    format!("sync_queue persist recovered missing order tip: {error}")
                })?;
                Cents::new(completed_payment_tip_cents).to_f64_dp2()
            } else {
                0.0
            }
        } else {
            0.0
        }
    };
    let mut body = serde_json::json!({
        "client_order_id": string_field_from_sources(&sources, &["client_order_id", "clientOrderId"])
            .unwrap_or_else(|| record_id.to_string()),
        "branch_id": branch_id,
        "items": items,
        "order_type": order_type,
        "payment_status": payment_status,
        "payment_method": payment_method_json,
        "total_amount": total_amount,
        "total_amount_cents": Cents::round_half_even(total_amount).as_i64(),
        "subtotal": subtotal,
        "subtotal_cents": Cents::round_half_even(subtotal).as_i64(),
        "tax_amount": tax_amount,
        "tax_amount_cents": Cents::round_half_even(tax_amount).as_i64(),
        "tax_rate": number_field_from_sources(&sources, &["tax_rate", "taxRate"]),
        "delivery_fee": delivery_fee,
        "delivery_fee_cents": Cents::round_half_even(delivery_fee).as_i64(),
        "discount_percentage": discount_percentage,
        "discount_amount": discount_amount,
        "discount_amount_cents": Cents::round_half_even(discount_amount).as_i64(),
        "manual_discount_mode": manual_discount_mode,
        "manual_discount_value": manual_discount_value,
        "coupon_id": string_field_from_sources(&sources, &["coupon_id", "couponId"]),
        "coupon_code": string_field_from_sources(&sources, &["coupon_code", "couponCode"]),
        "coupon_discount_amount": coupon_discount_amount,
        "coupon_discount_amount_cents": Cents::round_half_even(coupon_discount_amount).as_i64(),
        "tip_amount": tip_amount,
        "tip_amount_cents": Cents::round_half_even(tip_amount).as_i64(),
        "country_code": string_field_from_sources(&sources, &["country_code", "countryCode"])
            .map(|value| value.trim().to_ascii_uppercase()),
        "pricing_mode": string_field_from_sources(&sources, &["pricing_mode", "pricingMode"]),
        "customer_id": customer_id,
        "customer_name": customer_name,
        "customer_phone": customer_phone,
        "customer_email": customer_email,
        "order_number": string_field_from_sources(&sources, &["order_number", "orderNumber"]),
        "status": string_field_from_sources(&sources, &["status"])
            .unwrap_or_else(|| "pending".to_string()),
        "table_number": string_field_from_sources(&sources, &["table_number", "tableNumber"]),
        "table_id": table_id,
        "table_session_id": table_session_id,
        "guest_count": guest_count,
        "delivery_address": delivery_address,
        "delivery_address_id": delivery_address_id,
        "delivery_city": delivery_city,
        "delivery_postal_code": delivery_postal_code,
        "delivery_floor": delivery_floor,
        "delivery_notes": delivery_notes,
        "delivery_latitude": delivery_latitude,
        "delivery_longitude": delivery_longitude,
        "delivery_address_fingerprint": delivery_address_fingerprint,
        "delivery_zone_id": delivery_zone_id,
        "name_on_ringer": name_on_ringer,
        "fiscal_receipt_number": string_field_from_sources(
            &sources,
            &["fiscal_receipt_number", "fiscalReceiptNumber"],
        ),
        "notes": string_field_from_sources(&sources, &["notes", "orderNotes", "order_notes"])
            .or_else(|| string_field_from_sources(&sources, &["special_instructions", "specialInstructions"])),
        "is_ghost": bool_field_from_sources(&sources, &["is_ghost", "isGhost"]).unwrap_or(false),
        "ghost_source": string_field_from_sources(&sources, &["ghost_source", "ghostSource"]),
        "ghost_metadata": ghost_metadata,
    });

    if let Value::Object(object) = &mut body {
        if object
            .get("fiscal_receipt_number")
            .is_some_and(Value::is_null)
        {
            object.remove("fiscal_receipt_number");
        }
    }

    Ok(body)
}

fn is_order_customizations_schema_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("validation failed")
        && lower.contains("expected object, received array")
        && lower.contains("customizations")
}

fn is_retryable_legacy_order_insert_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    let customizations_shape_error = is_order_customizations_schema_error(error);
    let missing_tip_error = lower.contains("validation failed")
        && lower.contains("tip_amount")
        && lower.contains("expected number, received null");
    let null_payment_method_error = lower.contains("validation failed")
        && lower.contains("payment_method")
        && lower.contains("received null");
    let missing_payment_method_error = lower.contains("validation failed")
        && lower.contains("payment_method")
        && lower.contains("required");
    let invalid_payment_method_error = lower.contains("validation failed")
        && lower.contains("payment_method")
        && lower.contains("invalid input");
    let stale_schema_cache_error = lower.contains("schema cache")
        && lower.contains("orders")
        && lower.contains("could not find the '");
    let duplicate_canonical_number_error = lower
        .contains("duplicate key value violates unique constraint")
        && lower.contains("uq_orders_order_number");
    let recoverable_parent_customer_error = lower.contains("customer not found in organization")
        && lower.contains("failed to create order");
    let table_number_type_error = lower.contains("load_local_order_insert_fallback")
        && lower.contains("invalid column type")
        && lower.contains("table_number");

    customizations_shape_error
        || missing_tip_error
        || null_payment_method_error
        || missing_payment_method_error
        || invalid_payment_method_error
        || stale_schema_cache_error
        || duplicate_canonical_number_error
        || recoverable_parent_customer_error
        || table_number_type_error
}

fn is_rate_limit_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("http 429") || lower.contains("rate limit exceeded")
}

fn is_payment_total_conflict_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("payment exceeds order total")
        || (lower.contains("http 422") && lower.contains("existing completed"))
}

#[derive(Debug, Clone, Copy)]
struct PaymentTotalConflictServerHint {
    order_total: f64,
    existing_completed: f64,
    payment_amount: f64,
}

fn extract_payment_total_conflict_metric(error: &str, metric: &str) -> Option<f64> {
    let error_lower = error.to_ascii_lowercase();
    let metric_lower = metric.to_ascii_lowercase();
    let start = error_lower.find(&metric_lower)? + metric_lower.len();
    let suffix = error.get(start..)?.trim_start();
    let numeric: String = suffix
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || matches!(ch, '.' | '-'))
        .collect();

    if numeric.is_empty() {
        return None;
    }

    numeric.parse::<f64>().ok()
}

fn parse_payment_total_conflict_server_hint(error: &str) -> Option<PaymentTotalConflictServerHint> {
    Some(PaymentTotalConflictServerHint {
        order_total: extract_payment_total_conflict_metric(error, "order total:")?,
        existing_completed: extract_payment_total_conflict_metric(error, "existing completed:")?,
        payment_amount: extract_payment_total_conflict_metric(error, "payment:")?,
    })
}

fn extract_payment_payload_amount(payload: &Value) -> Option<f64> {
    payload
        .get("amount")
        .or_else(|| payload.get("paymentAmount"))
        .and_then(Value::as_f64)
}

fn extract_payment_payload_order_id(payload: &Value) -> Option<String> {
    payload
        .get("orderId")
        .or_else(|| payload.get("order_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn resolve_payment_total_conflict_parity_row_with_conn(
    conn: &Connection,
    queue_id: &str,
    payment_id: &str,
    payload_raw: &str,
    error_message: &str,
    resolved_at: &str,
) -> Result<bool, String> {
    retry_transaction(conn, |conn| {
        resolve_payment_total_conflict_parity_row_in_transaction(
            conn,
            queue_id,
            payment_id,
            payload_raw,
            error_message,
            resolved_at,
        )
    })
}

fn resolve_payment_total_conflict_parity_row_in_transaction(
    conn: &Connection,
    queue_id: &str,
    payment_id: &str,
    payload_raw: &str,
    error_message: &str,
    resolved_at: &str,
) -> Result<bool, String> {
    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let ownership_sql = format!(
        "SELECT EXISTS(
             SELECT 1 FROM parity_sync_queue
             WHERE id = ?1
               AND table_name = 'payments'
               AND operation = 'INSERT'
               AND status = 'failed'
               AND {generic_owner}
         )"
    );
    let generic_payment_row = conn
        .query_row(&ownership_sql, params![queue_id], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| format!("sync_queue verify generic payment conflict ownership: {e}"))?;
    if generic_payment_row != 1 {
        return Ok(false);
    }

    if !is_payment_total_conflict_error(error_message) {
        return Ok(false);
    }

    if sync::resolve_payment_total_conflict_with_server_hint_with_conn(
        conn,
        payment_id,
        error_message,
        resolved_at,
    )?
    .is_some()
    {
        // Wave 10 H8: this conflict-resolution path is the
        // authoritative actor (not a worker ack), so read the row's
        // current generation and pass it to mark_success. The generation
        // check then trivially passes — we are claiming the row's
        // current state regardless of any concurrent recover_stale.
        let current_generation: i64 = conn
            .query_row(
                "SELECT claim_generation FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        mark_success(conn, queue_id, current_generation)?;
        return Ok(true);
    }

    let Some(server_hint) = parse_payment_total_conflict_server_hint(error_message) else {
        return Ok(false);
    };

    if server_hint.existing_completed + 0.01 < server_hint.order_total {
        return Ok(false);
    }

    let payload =
        serde_json::from_str::<Value>(payload_raw).unwrap_or_else(|_| Value::Object(Map::new()));
    let Some(payload_amount) = extract_payment_payload_amount(&payload) else {
        return Ok(false);
    };

    if (payload_amount - server_hint.payment_amount).abs() > 0.02 {
        return Ok(false);
    }

    let order_id = extract_payment_payload_order_id(&payload);
    // Wave 10 H8: same authoritative-actor pattern as the branch above.
    let current_generation: i64 = conn
        .query_row(
            "SELECT claim_generation FROM parity_sync_queue WHERE id = ?1",
            params![queue_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    mark_success(conn, queue_id, current_generation)?;
    info!(
        queue_id = %queue_id,
        payment_id = %payment_id,
        order_id = order_id.as_deref().unwrap_or(""),
        payload_amount = payload_amount,
        order_total = server_hint.order_total,
        existing_completed = server_hint.existing_completed,
        "Resolved stale parity payment conflict from admin-confirmed fully paid order state"
    );
    Ok(true)
}

/// Live-worker variant of payment-total recovery. Unlike the historical
/// failed-row prepass above, this path never reads/adopts a newer generation:
/// its caller holds `with_live_generic_claim`, and success is acknowledged
/// only with the generation captured by the original dequeue.
fn resolve_live_payment_total_conflict_with_conn(
    conn: &Connection,
    item: &SyncQueueItem,
    error_message: &str,
    resolved_at: &str,
) -> Result<bool, String> {
    if item.table_name != "payments" || !is_payment_total_conflict_error(error_message) {
        return Ok(false);
    }

    if sync::resolve_payment_total_conflict_with_server_hint_with_conn(
        conn,
        item.record_id.as_str(),
        error_message,
        resolved_at,
    )?
    .is_some()
    {
        mark_success(conn, &item.id, item.claim_generation)?;
        return Ok(true);
    }

    let Some(server_hint) = parse_payment_total_conflict_server_hint(error_message) else {
        return Ok(false);
    };
    if server_hint.existing_completed + 0.01 < server_hint.order_total {
        return Ok(false);
    }
    let payload =
        serde_json::from_str::<Value>(&item.data).unwrap_or_else(|_| Value::Object(Map::new()));
    let Some(payload_amount) = extract_payment_payload_amount(&payload) else {
        return Ok(false);
    };
    if (payload_amount - server_hint.payment_amount).abs() > 0.02 {
        return Ok(false);
    }

    mark_success(conn, &item.id, item.claim_generation)?;
    info!("Resolved live parity payment conflict from bounded server totals");
    Ok(true)
}

fn is_customer_address_not_found_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("http 404") && lower.contains("address not found")
}

fn is_customer_address_missing_street_error(error: &str) -> bool {
    error
        .to_ascii_lowercase()
        .contains("customer address recreate is missing street_address details")
}

fn requeue_failed_items(
    conn: &Connection,
    queue_ids: &[String],
    log_message: &str,
) -> Result<RetryItemsResult, String> {
    let mut retried = 0_i64;
    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let update_sql = format!(
        "UPDATE parity_sync_queue
         SET status = 'pending',
             attempts = 0,
             error_message = NULL,
             next_retry_at = NULL,
             last_attempt = NULL,
             retry_delay_ms = ?1
         WHERE id = ?2
           AND status = 'failed'
           AND {generic_owner}"
    );

    for queue_id in queue_ids {
        retried += conn
            .execute(
                &update_sql,
                params![DEFAULT_INITIAL_RETRY_DELAY_MS, queue_id],
            )
            .map_err(|e| format!("sync_queue requeue_failed_items update: {e}"))?
            as i64;
    }

    if retried > 0 {
        info!(retried = retried, "{log_message}");
    }

    Ok(RetryItemsResult { retried })
}

fn retry_failed_terminal_context_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    if resolve_request_terminal_id(conn, &Value::Object(Map::new())).is_none() {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let select_sql = format!(
        "SELECT id
             FROM parity_sync_queue
             WHERE status = 'failed'
               AND {generic_owner}
               AND error_message IS NOT NULL
               AND (
                   lower(error_message) LIKE '%missing terminal_id%'
                   OR lower(error_message) LIKE '%missing terminal id%'
                   OR lower(error_message) LIKE '%missing_terminal_id%'
                   OR lower(error_message) LIKE '%terminal_id context%'
               )
             ORDER BY created_at ASC
             LIMIT ?1"
    );
    let mut stmt = conn
        .prepare(&select_sql)
        .map_err(|e| format!("sync_queue retry_failed_terminal_context_items prepare: {e}"))?;

    let queue_ids: Vec<String> = stmt
        .query_map(params![limit as i64], |row| row.get(0))
        .map_err(|e| format!("sync_queue retry_failed_terminal_context_items query: {e}"))?
        .filter_map(|row| row.ok())
        .collect();

    requeue_failed_items(
        conn,
        &queue_ids,
        "Requeued historical parity items that failed due to missing terminal identity context",
    )
}

fn retry_failed_rate_limited_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    if resolve_request_terminal_id(conn, &Value::Object(Map::new())).is_none() {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let select_sql = format!(
        "SELECT id, error_message
             FROM parity_sync_queue
             WHERE status = 'failed'
               AND {generic_owner}
               AND error_message IS NOT NULL
             ORDER BY created_at ASC"
    );
    let mut stmt = conn
        .prepare(&select_sql)
        .map_err(|e| format!("sync_queue retry_failed_rate_limited_items prepare: {e}"))?;

    let queue_ids: Vec<String> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("sync_queue retry_failed_rate_limited_items query: {e}"))?
        .filter_map(|row| row.ok())
        .filter(|(_, error_message)| is_rate_limit_error(error_message))
        .take(limit)
        .map(|(queue_id, _)| queue_id)
        .collect();

    requeue_failed_items(
        conn,
        &queue_ids,
        "Requeued parity items that previously failed due to admin rate limiting",
    )
}

fn retry_failed_legacy_order_insert_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    if resolve_request_terminal_id(conn, &Value::Object(Map::new())).is_none() {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let select_sql = format!(
        "SELECT id, record_id, operation, data, error_message
             FROM parity_sync_queue
             WHERE table_name = 'orders'
               AND {generic_owner}
               AND status = 'failed'
               AND error_message IS NOT NULL"
    );
    let mut stmt = conn
        .prepare(&select_sql)
        .map_err(|e| format!("sync_queue retry_failed_legacy_order_insert_items prepare: {e}"))?;
    let candidates: Vec<(String, String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| format!("sync_queue retry_failed_legacy_order_insert_items query: {e}"))?
        .filter_map(|row| row.ok())
        .collect();

    let mut queue_ids = Vec::new();
    for (queue_id, record_id, operation, payload_raw, error_message) in candidates {
        if queue_ids.len() >= limit {
            break;
        }
        if !is_retryable_legacy_order_insert_error(&error_message) {
            continue;
        }

        let payload = serde_json::from_str::<Value>(&payload_raw)
            .unwrap_or_else(|_| Value::Object(Map::new()));
        if operation.eq_ignore_ascii_case("INSERT")
            && build_order_insert_body(conn, record_id.as_str(), &payload).is_err()
        {
            continue;
        }
        if !operation.eq_ignore_ascii_case("INSERT") && !operation.eq_ignore_ascii_case("UPDATE") {
            continue;
        }

        queue_ids.push(queue_id);
    }

    requeue_failed_items(
        conn,
        &queue_ids,
        "Requeued order parity rows after canonical request auto-heal",
    )
}

fn resolve_failed_payment_total_conflict_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let select_sql = format!(
        "SELECT id, record_id, data, error_message
             FROM parity_sync_queue
             WHERE table_name = 'payments'
               AND {generic_owner}
               AND operation = 'INSERT'
               AND status = 'failed'
               AND error_message IS NOT NULL
             ORDER BY created_at ASC"
    );
    let mut stmt = conn.prepare(&select_sql).map_err(|e| {
        format!("sync_queue resolve_failed_payment_total_conflict_items prepare: {e}")
    })?;

    let candidates: Vec<(String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| format!("sync_queue resolve_failed_payment_total_conflict_items query: {e}"))?
        .filter_map(|row| row.ok())
        .collect();

    let mut resolved = 0_i64;
    let resolved_at = Utc::now().to_rfc3339();

    for (queue_id, payment_id, payload_raw, error_message) in candidates {
        if resolved as usize >= limit {
            break;
        }
        if resolve_payment_total_conflict_parity_row_with_conn(
            conn,
            queue_id.as_str(),
            payment_id.as_str(),
            payload_raw.as_str(),
            error_message.as_str(),
            resolved_at.as_str(),
        )? {
            resolved += 1;
        }
    }

    if resolved > 0 {
        info!(
            retried = resolved,
            "Resolved stale parity payment rows blocked by payment total conflicts"
        );
    }

    Ok(RetryItemsResult { retried: resolved })
}

fn retry_failed_customer_address_not_found_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    if resolve_request_terminal_id(conn, &Value::Object(Map::new())).is_none() {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let select_sql = format!(
        "SELECT id, record_id, data, error_message
             FROM parity_sync_queue
             WHERE table_name = 'customer_addresses'
               AND {generic_owner}
               AND operation = 'UPDATE'
               AND status = 'failed'
               AND error_message IS NOT NULL
             ORDER BY created_at ASC"
    );
    let mut stmt = conn.prepare(&select_sql).map_err(|e| {
        format!("sync_queue retry_failed_customer_address_not_found_items prepare: {e}")
    })?;

    let candidates: Vec<(String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| {
            format!("sync_queue retry_failed_customer_address_not_found_items query: {e}")
        })?
        .filter_map(|row| row.ok())
        .collect();

    let mut queue_ids = Vec::new();
    for (queue_id, record_id, payload_raw, error_message) in candidates {
        if queue_ids.len() >= limit {
            break;
        }
        if !(is_customer_address_not_found_error(&error_message)
            || is_customer_address_missing_street_error(&error_message))
            || !is_local_placeholder_id(record_id.as_str())
        {
            continue;
        }

        let payload = serde_json::from_str::<Value>(&payload_raw)
            .unwrap_or_else(|_| Value::Object(Map::new()));
        let Some(customer_id) = payload
            .get("customer_id")
            .or_else(|| payload.get("customerId"))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };

        let hydrated_payload = merge_customer_address_payload_for_recreate(
            conn,
            customer_id.as_str(),
            record_id.as_str(),
            &payload,
        );
        if !has_customer_address_street(&hydrated_payload) {
            continue;
        }

        let update_sql = format!(
            "UPDATE parity_sync_queue
             SET data = ?1
             WHERE id = ?2
               AND status = 'failed'
               AND table_name = 'customer_addresses'
               AND {generic_owner}"
        );
        conn.execute(
            &update_sql,
            params![hydrated_payload.to_string(), queue_id.as_str()],
        )
        .map_err(|e| {
            format!("sync_queue retry_failed_customer_address_not_found_items hydrate: {e}")
        })?;
        queue_ids.push(queue_id);
    }

    requeue_failed_items(
        conn,
        &queue_ids,
        "Requeued stale customer address parity rows after cache-backed recreate auto-heal",
    )
}

/// True when an admin replay failed because a `restaurant_table_sessions`
/// UPDATE/DELETE was routed through an obsolete local-placeholder path.
///
/// These rows predate `prepare_table_session_request` learning to either defer
/// until the remote session UUID is known or consume paid/completed orphan
/// closes locally. Requeuing them lets the new path take over instead of
/// leaving a permanently `failed` row that keeps tripping queue-age warnings.
fn is_table_session_local_placeholder_uuid_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    (normalized.contains("invalid input syntax for type uuid")
        && normalized.contains(LOCAL_TABLE_SESSION_PREFIX))
        || normalized.contains("http 405")
        || normalized.contains("method not allowed")
}

fn retry_failed_table_session_local_placeholder_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    if resolve_request_terminal_id(conn, &Value::Object(Map::new())).is_none() {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let select_sql = format!(
        "SELECT id, record_id, operation, error_message
             FROM parity_sync_queue
             WHERE table_name = 'restaurant_table_sessions'
               AND {generic_owner}
               AND status = 'failed'
               AND error_message IS NOT NULL
             ORDER BY created_at ASC"
    );
    let mut stmt = conn.prepare(&select_sql).map_err(|e| {
        format!("sync_queue retry_failed_table_session_local_placeholder_items prepare: {e}")
    })?;

    let candidates: Vec<(String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| {
            format!("sync_queue retry_failed_table_session_local_placeholder_items query: {e}")
        })?
        .filter_map(|row| row.ok())
        .collect();

    let mut queue_ids = Vec::new();
    for (queue_id, record_id, operation, error_message) in candidates {
        if queue_ids.len() >= limit {
            break;
        }
        // Only UPDATE/DELETE rows can carry the renderer's session-id key; INSERT
        // rows post to the collection endpoint and never hit the uuid path.
        if !(operation.eq_ignore_ascii_case("UPDATE") || operation.eq_ignore_ascii_case("DELETE")) {
            continue;
        }
        if local_table_session_order_id(record_id.as_str()).is_none() {
            continue;
        }
        if !is_table_session_local_placeholder_uuid_error(error_message.as_str()) {
            continue;
        }
        queue_ids.push(queue_id);
    }

    requeue_failed_items(
        conn,
        &queue_ids,
        "Requeued table session rows after local placeholder id routing fix",
    )
}

fn is_invalid_fiscal_issued_at_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    let compact: String = normalized
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect();
    compact.contains("invalidfiscalreceiptinput")
        && normalized.contains("issuedat")
        && normalized.contains("datetime")
}

fn normalize_fiscal_request_payload(payload: &Value) -> Value {
    let mut normalized = payload.clone();
    let Some(object) = normalized.as_object_mut() else {
        return normalized;
    };

    let issued_at = object
        .get("issuedAt")
        .or_else(|| object.get("issued_at"))
        .and_then(Value::as_str)
        .map(crate::fiscal::payload_builder::normalize_issued_at);

    if let Some(issued_at) = issued_at {
        object.insert("issuedAt".to_string(), Value::String(issued_at));
    }

    normalized
}

fn retry_failed_invalid_fiscal_issued_at_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    if resolve_request_terminal_id(conn, &Value::Object(Map::new())).is_none() {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let select_sql = format!(
        "SELECT id, data, error_message
             FROM parity_sync_queue
             WHERE module_type = 'fiscal'
               AND {generic_owner}
               AND status = 'failed'
               AND error_message IS NOT NULL
             ORDER BY created_at ASC"
    );
    let mut stmt = conn.prepare(&select_sql).map_err(|e| {
        format!("sync_queue retry_failed_invalid_fiscal_issued_at_items prepare: {e}")
    })?;

    let candidates: Vec<(String, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| format!("sync_queue retry_failed_invalid_fiscal_issued_at_items query: {e}"))?
        .filter_map(|row| row.ok())
        .collect();

    let mut queue_ids = Vec::new();
    for (queue_id, payload_raw, error_message) in candidates {
        if queue_ids.len() >= limit {
            break;
        }
        if !is_invalid_fiscal_issued_at_error(&error_message) {
            continue;
        }

        let Ok(payload) = serde_json::from_str::<Value>(&payload_raw) else {
            continue;
        };
        let normalized_payload = normalize_fiscal_request_payload(&payload);
        let update_sql = format!(
            "UPDATE parity_sync_queue
             SET data = ?1
             WHERE id = ?2
               AND status = 'failed'
               AND module_type = 'fiscal'
               AND {generic_owner}"
        );
        conn.execute(
            &update_sql,
            params![normalized_payload.to_string(), queue_id.as_str()],
        )
        .map_err(|e| {
            format!("sync_queue retry_failed_invalid_fiscal_issued_at_items normalize: {e}")
        })?;
        queue_ids.push(queue_id);
    }

    requeue_failed_items(
        conn,
        &queue_ids,
        "Requeued fiscal parity rows after issuedAt datetime normalization",
    )
}

pub fn enqueue_payload_item(
    conn: &Connection,
    table_name: &str,
    record_id: &str,
    operation: &str,
    payload: &Value,
    priority: Option<i64>,
    module_type: Option<&str>,
    conflict_strategy: Option<&str>,
    version: Option<i64>,
) -> Result<String, String> {
    let organization_id = infer_organization_id(conn, payload);

    enqueue(
        conn,
        &EnqueueInput {
            table_name: table_name.to_string(),
            record_id: record_id.to_string(),
            operation: operation.to_string(),
            data: payload.to_string(),
            organization_id,
            priority,
            module_type: module_type.map(ToString::to_string),
            conflict_strategy: conflict_strategy.map(ToString::to_string),
            version,
        },
    )
}

pub fn clear_unsynced_items(
    conn: &Connection,
    table_name: &str,
    record_id: &str,
) -> Result<usize, String> {
    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let sql = format!(
        "DELETE FROM parity_sync_queue
         WHERE table_name = ?1
           AND record_id = ?2
           AND {generic_owner}
           AND status IN ('pending', 'failed', 'conflict')"
    );
    conn.execute(&sql, params![table_name, record_id])
        .map_err(|e| format!("sync_queue clear_unsynced_items: {e}"))
}

/// Dequeue the next item to process (highest priority first, then oldest).
///
/// Returns `None` if the queue is empty or all items are scheduled for later.
/// Only considers items with status `pending` whose `next_retry_at` has passed.
fn map_internal_queue_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncQueueItem> {
    Ok(SyncQueueItem {
        id: row.get(0)?,
        table_name: row.get(1)?,
        record_id: row.get(2)?,
        operation: row.get(3)?,
        data: row.get(4)?,
        organization_id: row.get(5)?,
        created_at: row.get(6)?,
        attempts: row.get(7)?,
        last_attempt: row.get(8)?,
        error_message: row.get(9)?,
        next_retry_at: row.get(10)?,
        retry_delay_ms: row.get(11)?,
        priority: row.get(12)?,
        module_type: row.get(13)?,
        conflict_strategy: row.get(14)?,
        version: row.get(15)?,
        claim_generation: row.get(16)?,
        status: row.get(17)?,
    })
}

pub fn dequeue(conn: &Connection) -> Result<Option<SyncQueueItem>, String> {
    dequeue_with_quarantine_count(conn).map(|(item, _)| item)
}

/// Atomically quarantine semantic repair-owner lookalikes and claim the next
/// safe item. `BEGIN IMMEDIATE` closes the former two-statement insertion gap:
/// another SQLite writer can insert only before this transaction starts or
/// after its claim commits. The affected-row count is returned so the batch
/// result cannot report success after silently parking newly discovered work.
fn dequeue_with_quarantine_count(
    conn: &Connection,
) -> Result<(Option<SyncQueueItem>, i64), String> {
    retry_transaction(conn, |conn| {
        let quarantined = quarantine_reserved_repair_lookalikes(conn)?;
        claim_next_internal_item(conn).map(|item| (item, quarantined))
    })
}

fn claim_next_internal_item(conn: &Connection) -> Result<Option<SyncQueueItem>, String> {
    let now = Utc::now().to_rfc3339();
    let candidate_generic = semantic_generic_nonfinancial_owner_predicate("candidate");
    let claim_generic = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let claim_canonical = canonical_repair_owner_predicate("parity_sync_queue");
    let unsafe_reserved = semantic_reserved_repair_owner_predicate("unsafe_repair");
    let unsafe_canonical = canonical_repair_owner_predicate("unsafe_repair");
    let sql = format!(
        "UPDATE parity_sync_queue
            SET status = 'processing',
                last_attempt = ?1,
                claim_generation = claim_generation + 1
          WHERE id = (
                SELECT candidate.id
                 FROM parity_sync_queue AS candidate
                 WHERE candidate.status = 'pending'
                   AND (
                        candidate.next_retry_at IS NULL
                        OR julianday(candidate.next_retry_at) <= julianday('now')
                   )
                   AND (
                        {candidate_generic}
                        OR (
                            COALESCE(candidate.module_type, '') = 'repairs'
                            AND candidate.table_name IN ('repairs', 'repair_attachments')
                            AND
                            candidate.repair_aggregate_id IS NOT NULL
                            AND length(candidate.repair_aggregate_id) = 36
                            AND substr(candidate.repair_aggregate_id, 9, 1) = '-'
                            AND substr(candidate.repair_aggregate_id, 14, 1) = '-'
                            AND substr(candidate.repair_aggregate_id, 19, 1) = '-'
                            AND substr(candidate.repair_aggregate_id, 24, 1) = '-'
                            AND length(replace(candidate.repair_aggregate_id, '-', '')) = 32
                            AND replace(candidate.repair_aggregate_id, '-', '')
                                NOT GLOB '*[^0-9a-f]*'
                            AND lower(candidate.repair_aggregate_id)
                                = candidate.repair_aggregate_id
                            AND candidate.operation = 'INSERT'
                            AND candidate.conflict_strategy = 'manual'
                            AND candidate.version BETWEEN 0 AND 9007199254740991
                            AND length(candidate.organization_id) = 36
                            AND substr(candidate.organization_id, 9, 1) = '-'
                            AND substr(candidate.organization_id, 14, 1) = '-'
                            AND substr(candidate.organization_id, 19, 1) = '-'
                            AND substr(candidate.organization_id, 24, 1) = '-'
                            AND length(replace(candidate.organization_id, '-', '')) = 32
                            AND replace(candidate.organization_id, '-', '')
                                NOT GLOB '*[^0-9a-f]*'
                            AND lower(candidate.organization_id) = candidate.organization_id
                            AND length(candidate.record_id) = 36
                            AND substr(candidate.record_id, 9, 1) = '-'
                            AND substr(candidate.record_id, 14, 1) = '-'
                            AND substr(candidate.record_id, 19, 1) = '-'
                            AND substr(candidate.record_id, 24, 1) = '-'
                            AND length(replace(candidate.record_id, '-', '')) = 32
                            AND replace(candidate.record_id, '-', '')
                                NOT GLOB '*[^0-9a-f]*'
                            AND lower(candidate.record_id) = candidate.record_id
                            AND (
                                (candidate.table_name = 'repairs'
                                 AND candidate.record_id = candidate.repair_aggregate_id)
                                OR (
                                    candidate.table_name = 'repair_attachments'
                                    AND (
                                        SELECT COUNT(*)
                                          FROM repair_attachment_staging AS staging
                                         WHERE staging.organization_id = candidate.organization_id
                                           AND staging.attachment_id = candidate.record_id
                                           AND staging.operation_id = candidate.id
                                           AND staging.queue_id = candidate.id
                                           AND staging.expected_version = candidate.version
                                           AND staging.repair_id = candidate.repair_aggregate_id
                                           AND staging.state = 'queued'
                                    ) = 1
                                )
                            )
                            AND NOT EXISTS (
                                SELECT 1
                                  FROM parity_sync_queue AS unsafe_repair
                                 WHERE unsafe_repair.organization_id = candidate.organization_id
                                   AND unsafe_repair.id <> candidate.id
                                   AND unsafe_repair.status IN (
                                        'pending', 'processing', 'failed', 'conflict'
                                   )
                                   AND {unsafe_reserved}
                                   AND NOT (
                                        {unsafe_canonical}
                                        AND unsafe_repair.repair_aggregate_id IS NOT NULL
                                        AND length(unsafe_repair.repair_aggregate_id) = 36
                                        AND substr(unsafe_repair.repair_aggregate_id, 9, 1) = '-'
                                        AND substr(unsafe_repair.repair_aggregate_id, 14, 1) = '-'
                                        AND substr(unsafe_repair.repair_aggregate_id, 19, 1) = '-'
                                        AND substr(unsafe_repair.repair_aggregate_id, 24, 1) = '-'
                                        AND length(replace(
                                            unsafe_repair.repair_aggregate_id, '-', ''
                                        )) = 32
                                        AND replace(
                                            unsafe_repair.repair_aggregate_id, '-', ''
                                        ) NOT GLOB '*[^0-9a-f]*'
                                        AND lower(unsafe_repair.repair_aggregate_id)
                                            = unsafe_repair.repair_aggregate_id
                                   )
                            )
                            AND NOT EXISTS (
                                SELECT 1
                                  FROM parity_sync_queue AS blocker
                                 WHERE blocker.organization_id = candidate.organization_id
                                   AND blocker.repair_aggregate_id = candidate.repair_aggregate_id
                                   AND blocker.id <> candidate.id
                                   AND COALESCE(blocker.module_type, '') = 'repairs'
                                   AND blocker.table_name IN ('repairs', 'repair_attachments')
                                   AND (
                                        blocker.status IN ('processing', 'conflict')
                                        OR (
                                            blocker.status IN ('pending', 'failed')
                                            AND (
                                                blocker.version < candidate.version
                                                OR (blocker.version = candidate.version
                                                    AND blocker.created_at < candidate.created_at)
                                                OR (blocker.version = candidate.version
                                                    AND blocker.created_at = candidate.created_at
                                                    AND blocker.id < candidate.id)
                                            )
                                        )
                                   )
                            )
                        )
                   )
                 ORDER BY candidate.priority DESC, candidate.created_at ASC, candidate.id ASC
                 LIMIT 1
          )
            AND status = 'pending'
            AND ({claim_generic} OR {claim_canonical})
            AND (
                next_retry_at IS NULL
                OR julianday(next_retry_at) <= julianday('now')
            )
        RETURNING id, table_name, record_id, operation, data, organization_id,
                  created_at, attempts, last_attempt, error_message, next_retry_at,
                  retry_delay_ms, priority, COALESCE(module_type, 'orders'),
                  conflict_strategy, version, claim_generation, status"
    );
    conn.query_row(&sql, params![now], map_internal_queue_item)
        .optional()
        .map_err(|e| format!("sync_queue dequeue: {e}"))
}

/// Renderer-facing dequeue. Repair payloads are native-only and must never be
/// returned across the generic IPC boundary, even when they have the highest
/// queue priority.
pub(crate) fn renderer_dequeue(conn: &Connection) -> Result<Option<SyncQueueItem>, String> {
    let now = Utc::now().to_rfc3339();
    let candidate_generic = renderer_generic_owner_predicate("candidate");
    let claim_generic = renderer_generic_owner_predicate("parity_sync_queue");
    let candidate_exclusion = renderer_non_repair_owned_predicate("candidate");
    let claim_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
    let sql = format!(
        "UPDATE parity_sync_queue
         SET status = 'processing', last_attempt = ?1,
             claim_generation = claim_generation + 1
         WHERE id = (
             SELECT candidate.id
             FROM parity_sync_queue candidate
             WHERE candidate.status = 'pending'
               AND {candidate_generic}
               AND (
                    candidate.next_retry_at IS NULL
                    OR julianday(candidate.next_retry_at) <= julianday('now')
               )
               AND {candidate_exclusion}
             ORDER BY candidate.priority DESC, candidate.created_at ASC, candidate.id ASC
             LIMIT 1
         )
           AND status = 'pending'
           AND {claim_generic}
           AND (
                next_retry_at IS NULL
                OR julianday(next_retry_at) <= julianday('now')
           )
           AND {claim_exclusion}
         RETURNING id, table_name, record_id, operation, data, organization_id,
                   created_at, attempts, last_attempt, error_message, next_retry_at,
                   retry_delay_ms, priority, COALESCE(module_type, 'orders'),
                   conflict_strategy, version, claim_generation, status"
    );
    conn.query_row(&sql, params![now], |row| {
        Ok(SyncQueueItem {
            id: row.get(0)?,
            table_name: row.get(1)?,
            record_id: row.get(2)?,
            operation: row.get(3)?,
            data: row.get(4)?,
            organization_id: row.get(5)?,
            created_at: row.get(6)?,
            attempts: row.get(7)?,
            last_attempt: row.get(8)?,
            error_message: row.get(9)?,
            next_retry_at: row.get(10)?,
            retry_delay_ms: row.get(11)?,
            priority: row.get(12)?,
            module_type: row.get(13)?,
            conflict_strategy: row.get(14)?,
            version: row.get(15)?,
            claim_generation: row.get(16)?,
            status: row.get(17)?,
        })
    })
    .optional()
    .map_err(|e| format!("sync_queue renderer_dequeue: {e}"))
}

/// Atomically resets and claims one renderer-safe row for a manual retry.
///
/// This deliberately does not fall back to the next FIFO row. The caller must
/// hold its terminal-binding gate for the entire transaction, remote request,
/// and acknowledgement window.
fn renderer_retry_and_dequeue_exact(
    conn: &Connection,
    item_id: &str,
) -> Result<Option<SyncQueueItem>, String> {
    if item_id.trim().is_empty() {
        return Err("PARITY_ITEM_ID_INVALID".to_string());
    }
    retry_transaction(conn, |conn| {
        let semantic_reserved = semantic_reserved_repair_owner_predicate("parity_sync_queue");
        let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
        let ownership_sql = format!(
            "SELECT ({semantic_reserved}), NOT ({ownership_exclusion})
               FROM parity_sync_queue
              WHERE id = ?1"
        );
        let ownership = conn
            .query_row(&ownership_sql, [item_id], |row| {
                Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?))
            })
            .optional()
            .map_err(|error| format!("sync_queue exact renderer retry guard: {error}"))?;
        match ownership {
            Some((true, _)) => return Err("REPAIR_TYPED_CONFLICT_REQUIRED".to_string()),
            Some((false, true)) => return Err("REPAIR_SETTLEMENT_ROUTE_REQUIRED".to_string()),
            _ => {}
        }

        let now = Utc::now().to_rfc3339();
        let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
        let sql = format!(
            "UPDATE parity_sync_queue
                SET status = 'processing', attempts = 0, error_message = NULL,
                    next_retry_at = NULL, last_attempt = ?1,
                    retry_delay_ms = ?2, claim_generation = claim_generation + 1
              WHERE id = ?3
                AND status IN ('pending', 'failed', 'conflict')
                AND {generic_owner}
                AND {ownership_exclusion}
             RETURNING id, table_name, record_id, operation, data, organization_id,
                       created_at, attempts, last_attempt, error_message, next_retry_at,
                       retry_delay_ms, priority, COALESCE(module_type, 'orders'),
                       conflict_strategy, version, claim_generation, status"
        );
        conn.query_row(
            &sql,
            params![now, DEFAULT_INITIAL_RETRY_DELAY_MS, item_id],
            map_internal_queue_item,
        )
        .optional()
        .map_err(|error| format!("sync_queue exact renderer retry claim: {error}"))
    })
}

fn recover_stale_processing_items(conn: &Connection) -> Result<i64, String> {
    let generic_recovered = recover_stale_non_repair_processing_items(conn)?;
    let lease_modifier = format!("-{} seconds", PROCESSING_LEASE_SECS);
    // Native recovery is deliberately exact-shape only. Semantic lookalikes are
    // excluded here and remain available for the caller's counted quarantine;
    // malformed exact native envelopes stay parked for typed repair recovery.
    let native_recovered = conn
        .execute(
            "UPDATE parity_sync_queue
             SET status = 'pending', next_retry_at = NULL,
                 claim_generation = claim_generation + 1
             WHERE status = 'processing'
               AND COALESCE(module_type, '') = 'repairs'
               AND table_name IN ('repairs', 'repair_attachments')
               AND operation = 'INSERT'
               AND conflict_strategy = 'manual'
               AND version BETWEEN 0 AND 9007199254740991
               AND length(id) = 36
               AND substr(id, 9, 1) = '-'
               AND substr(id, 14, 1) = '-'
               AND substr(id, 19, 1) = '-'
               AND substr(id, 24, 1) = '-'
               AND length(replace(id, '-', '')) = 32
               AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
               AND lower(id) = id
               AND length(organization_id) = 36
               AND substr(organization_id, 9, 1) = '-'
               AND substr(organization_id, 14, 1) = '-'
               AND substr(organization_id, 19, 1) = '-'
               AND substr(organization_id, 24, 1) = '-'
               AND length(replace(organization_id, '-', '')) = 32
               AND replace(organization_id, '-', '') NOT GLOB '*[^0-9a-f]*'
               AND lower(organization_id) = organization_id
               AND length(record_id) = 36
               AND substr(record_id, 9, 1) = '-'
               AND substr(record_id, 14, 1) = '-'
               AND substr(record_id, 19, 1) = '-'
               AND substr(record_id, 24, 1) = '-'
               AND length(replace(record_id, '-', '')) = 32
               AND replace(record_id, '-', '') NOT GLOB '*[^0-9a-f]*'
               AND lower(record_id) = record_id
               AND repair_aggregate_id IS NOT NULL
               AND length(repair_aggregate_id) = 36
               AND substr(repair_aggregate_id, 9, 1) = '-'
               AND substr(repair_aggregate_id, 14, 1) = '-'
               AND substr(repair_aggregate_id, 19, 1) = '-'
               AND substr(repair_aggregate_id, 24, 1) = '-'
               AND length(replace(repair_aggregate_id, '-', '')) = 32
               AND replace(repair_aggregate_id, '-', '') NOT GLOB '*[^0-9a-f]*'
               AND lower(repair_aggregate_id) = repair_aggregate_id
               AND (
                    (table_name = 'repairs' AND record_id = repair_aggregate_id)
                    OR (
                        table_name = 'repair_attachments'
                        AND (
                            SELECT COUNT(*)
                              FROM repair_attachment_staging AS staging
                             WHERE staging.organization_id = parity_sync_queue.organization_id
                               AND staging.attachment_id = parity_sync_queue.record_id
                               AND staging.operation_id = parity_sync_queue.id
                               AND staging.queue_id = parity_sync_queue.id
                               AND staging.expected_version = parity_sync_queue.version
                               AND staging.repair_id = parity_sync_queue.repair_aggregate_id
                               AND staging.state = 'queued'
                        ) = 1
                    )
               )
               AND julianday(COALESCE(last_attempt, created_at))
                   <= julianday('now', ?1)",
            params![lease_modifier.as_str()],
        )
        .map_err(|e| format!("sync_queue recover native stale processing items: {e}"))?
        as i64;

    if generic_recovered > 0 {
        warn!(
            recovered = generic_recovered,
            lease_secs = PROCESSING_LEASE_SECS,
            "Recovered stale generic parity processing rows"
        );
    }
    if native_recovered > 0 {
        warn!(
            recovered = native_recovered,
            lease_secs = PROCESSING_LEASE_SECS,
            "Recovered stale native repair processing rows"
        );
    }

    Ok(generic_recovered + native_recovered)
}

fn recover_stale_non_repair_processing_items(conn: &Connection) -> Result<i64, String> {
    let lease_modifier = format!("-{} seconds", PROCESSING_LEASE_SECS);
    let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
    let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
    let sql = format!(
        "UPDATE parity_sync_queue
         SET status = 'pending', next_retry_at = NULL,
             claim_generation = claim_generation + 1
         WHERE status = 'processing'
           AND {generic_owner}
           AND {ownership_exclusion}
           AND julianday(COALESCE(last_attempt, created_at))
               <= julianday('now', ?1)"
    );
    let recovered = conn
        .execute(&sql, params![lease_modifier])
        .map_err(|e| format!("sync_queue generic stale recovery: {e}"))?;
    Ok(recovered as i64)
}

fn recover_stale_processing_items_renderer_safe(conn: &Connection) -> Result<i64, String> {
    recover_stale_non_repair_processing_items(conn)
}

fn cleanup_superseded_synced_order_status_updates(conn: &Connection) -> Result<usize, String> {
    retry_transaction(
        conn,
        cleanup_superseded_synced_order_status_updates_in_transaction,
    )
}

fn cleanup_superseded_synced_order_status_updates_in_transaction(
    conn: &Connection,
) -> Result<usize, String> {
    let rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        String,
    )> = {
        let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
        let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
        let sql = format!(
            "SELECT id, record_id, operation, data, status, error_message, conflict_strategy
                 FROM parity_sync_queue
                 WHERE table_name = 'orders'
                   AND operation = 'UPDATE'
                   AND status IN ('pending', 'processing', 'failed', 'conflict')
                   AND {generic_owner}
                   AND {ownership_exclusion}
                ORDER BY created_at ASC, id ASC"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("sync_queue superseded order cleanup prepare: {e}"))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(|e| format!("sync_queue superseded order cleanup query: {e}"))?;
        mapped.filter_map(|row| row.ok()).collect()
    };

    let mut handled = 0usize;
    for (queue_id, record_id, operation, data, queue_status, error_message, conflict_strategy) in
        rows
    {
        let Ok(mut payload) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if let Some(reason) = superseded_synced_order_status_update_reason(
            conn,
            record_id.as_str(),
            operation.as_str(),
            &payload,
        )? {
            let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
            let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
            let delete_sql = format!(
                "DELETE FROM parity_sync_queue
                     WHERE id = ?1
                       AND table_name = 'orders'
                       AND operation = 'UPDATE'
                       AND {generic_owner}
                       AND {ownership_exclusion}"
            );
            let affected = conn
                .execute(&delete_sql, params![queue_id.as_str()])
                .map_err(|e| format!("sync_queue superseded order cleanup delete: {e}"))?;

            if affected > 0 {
                handled += affected;
                info!(
                    item_id = %queue_id,
                    record_id = %record_id,
                    reason = %reason,
                    "Removed superseded order status parity row"
                );
            }
            continue;
        }

        let is_failed_invalid_transition = queue_status == "failed"
            && conflict_strategy == "server-wins"
            && error_message.as_deref().is_some_and(|message| {
                message
                    .to_ascii_lowercase()
                    .contains("invalid status transition")
            })
            && payload.get("syncRecoveryReason").and_then(Value::as_str)
                != Some(SUPERSEDED_ORDER_STATUS_REBASE_REASON);
        if !is_failed_invalid_transition || is_status_only_order_update_payload(&payload) {
            continue;
        }

        let Some((queued_status, local_status)) = superseding_synced_local_order_statuses(
            conn,
            record_id.as_str(),
            operation.as_str(),
            &payload,
        )?
        else {
            continue;
        };
        if local_status != "cancelled" {
            continue;
        }
        let Some(object) = payload.as_object_mut() else {
            continue;
        };
        object.insert("status".to_string(), Value::String(local_status.clone()));
        object.insert(
            "syncRecoveryReason".to_string(),
            Value::String(SUPERSEDED_ORDER_STATUS_REBASE_REASON.to_string()),
        );

        // Requeue this recovery only once. If the rebased request is rejected
        // too, the marker above leaves it failed for operator review.
        let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
        let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
        let update_sql = format!(
            "UPDATE parity_sync_queue
                 SET data = ?1,
                     status = 'pending',
                     attempts = 0,
                     last_attempt = NULL,
                     error_message = NULL,
                     next_retry_at = NULL,
                     retry_delay_ms = 1000
                 WHERE id = ?2
                   AND status = 'failed'
                   AND conflict_strategy = 'server-wins'
                   AND {generic_owner}
                   AND {ownership_exclusion}"
        );
        let affected = conn
            .execute(&update_sql, params![payload.to_string(), queue_id.as_str()])
            .map_err(|e| format!("sync_queue superseded order metadata rebase: {e}"))?;

        if affected > 0 {
            handled += affected;
            info!(
                item_id = %queue_id,
                record_id = %record_id,
                queued_status = %queued_status,
                local_status = %local_status,
                "Rebased failed order metadata parity row to synced local status"
            );
        }
    }

    Ok(handled)
}

/// Peek at the next item without removing or marking it.
pub fn peek(conn: &Connection) -> Result<Option<SyncQueueItem>, String> {
    quarantine_reserved_repair_lookalikes(conn)?;
    let candidate_generic = semantic_generic_nonfinancial_owner_predicate("candidate");
    let unsafe_reserved = semantic_reserved_repair_owner_predicate("unsafe_repair");
    let unsafe_canonical = canonical_repair_owner_predicate("unsafe_repair");
    let sql = format!(
        "SELECT candidate.id, candidate.table_name, candidate.record_id,
                candidate.operation, candidate.data, candidate.organization_id,
                candidate.created_at, candidate.attempts, candidate.last_attempt,
                candidate.error_message, candidate.next_retry_at,
                candidate.retry_delay_ms, candidate.priority,
                COALESCE(candidate.module_type, 'orders'), candidate.conflict_strategy,
                candidate.version, candidate.claim_generation, candidate.status
           FROM parity_sync_queue AS candidate
          WHERE candidate.status = 'pending'
            AND (
                candidate.next_retry_at IS NULL
                OR julianday(candidate.next_retry_at) <= julianday('now')
            )
            AND (
                 {candidate_generic}
                 OR (
                    COALESCE(candidate.module_type, '') = 'repairs'
                    AND candidate.table_name IN ('repairs', 'repair_attachments')
                    AND
                    candidate.repair_aggregate_id IS NOT NULL
                    AND length(candidate.repair_aggregate_id) = 36
                    AND substr(candidate.repair_aggregate_id, 9, 1) = '-'
                    AND substr(candidate.repair_aggregate_id, 14, 1) = '-'
                    AND substr(candidate.repair_aggregate_id, 19, 1) = '-'
                    AND substr(candidate.repair_aggregate_id, 24, 1) = '-'
                    AND length(replace(candidate.repair_aggregate_id, '-', '')) = 32
                    AND replace(candidate.repair_aggregate_id, '-', '')
                        NOT GLOB '*[^0-9a-f]*'
                    AND lower(candidate.repair_aggregate_id) = candidate.repair_aggregate_id
                    AND candidate.operation = 'INSERT'
                    AND candidate.conflict_strategy = 'manual'
                    AND candidate.version BETWEEN 0 AND 9007199254740991
                    AND length(candidate.organization_id) = 36
                    AND substr(candidate.organization_id, 9, 1) = '-'
                    AND substr(candidate.organization_id, 14, 1) = '-'
                    AND substr(candidate.organization_id, 19, 1) = '-'
                    AND substr(candidate.organization_id, 24, 1) = '-'
                    AND length(replace(candidate.organization_id, '-', '')) = 32
                    AND replace(candidate.organization_id, '-', '')
                        NOT GLOB '*[^0-9a-f]*'
                    AND lower(candidate.organization_id) = candidate.organization_id
                    AND length(candidate.record_id) = 36
                    AND substr(candidate.record_id, 9, 1) = '-'
                    AND substr(candidate.record_id, 14, 1) = '-'
                    AND substr(candidate.record_id, 19, 1) = '-'
                    AND substr(candidate.record_id, 24, 1) = '-'
                    AND length(replace(candidate.record_id, '-', '')) = 32
                    AND replace(candidate.record_id, '-', '')
                        NOT GLOB '*[^0-9a-f]*'
                    AND lower(candidate.record_id) = candidate.record_id
                    AND (
                        (candidate.table_name = 'repairs'
                         AND candidate.record_id = candidate.repair_aggregate_id)
                        OR (
                            candidate.table_name = 'repair_attachments'
                            AND (
                                SELECT COUNT(*)
                                  FROM repair_attachment_staging AS staging
                                 WHERE staging.organization_id = candidate.organization_id
                                   AND staging.attachment_id = candidate.record_id
                                   AND staging.operation_id = candidate.id
                                   AND staging.queue_id = candidate.id
                                   AND staging.expected_version = candidate.version
                                   AND staging.repair_id = candidate.repair_aggregate_id
                                   AND staging.state = 'queued'
                            ) = 1
                        )
                    )
                    AND NOT EXISTS (
                        SELECT 1
                          FROM parity_sync_queue AS unsafe_repair
                         WHERE unsafe_repair.organization_id = candidate.organization_id
                           AND unsafe_repair.id <> candidate.id
                           AND unsafe_repair.status IN (
                                'pending', 'processing', 'failed', 'conflict'
                           )
                           AND {unsafe_reserved}
                           AND NOT (
                                {unsafe_canonical}
                                AND unsafe_repair.repair_aggregate_id IS NOT NULL
                                AND length(unsafe_repair.repair_aggregate_id) = 36
                                AND substr(unsafe_repair.repair_aggregate_id, 9, 1) = '-'
                                AND substr(unsafe_repair.repair_aggregate_id, 14, 1) = '-'
                                AND substr(unsafe_repair.repair_aggregate_id, 19, 1) = '-'
                                AND substr(unsafe_repair.repair_aggregate_id, 24, 1) = '-'
                                AND length(replace(
                                    unsafe_repair.repair_aggregate_id, '-', ''
                                )) = 32
                                AND replace(
                                    unsafe_repair.repair_aggregate_id, '-', ''
                                ) NOT GLOB '*[^0-9a-f]*'
                                AND lower(unsafe_repair.repair_aggregate_id)
                                    = unsafe_repair.repair_aggregate_id
                           )
                    )
                    AND NOT EXISTS (
                        SELECT 1
                          FROM parity_sync_queue AS blocker
                         WHERE blocker.organization_id = candidate.organization_id
                           AND blocker.repair_aggregate_id = candidate.repair_aggregate_id
                           AND blocker.id <> candidate.id
                           AND COALESCE(blocker.module_type, '') = 'repairs'
                           AND blocker.table_name IN ('repairs', 'repair_attachments')
                           AND (
                                blocker.status IN ('processing', 'conflict')
                                OR (
                                    blocker.status IN ('pending', 'failed')
                                    AND (
                                        blocker.version < candidate.version
                                        OR (blocker.version = candidate.version
                                            AND blocker.created_at < candidate.created_at)
                                        OR (blocker.version = candidate.version
                                            AND blocker.created_at = candidate.created_at
                                            AND blocker.id < candidate.id)
                                    )
                                )
                           )
                    )
                 )
            )
          ORDER BY candidate.priority DESC, candidate.created_at ASC, candidate.id ASC
         LIMIT 1"
    );
    conn.query_row(&sql, [], map_internal_queue_item)
        .optional()
        .map_err(|e| format!("sync_queue peek: {e}"))
}

pub(crate) fn renderer_peek(conn: &Connection) -> Result<Option<SyncQueueItem>, String> {
    let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
    let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
    let sql = format!(
        "SELECT id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, next_retry_at,
                retry_delay_ms, priority, COALESCE(module_type, 'orders'), conflict_strategy, version,
                claim_generation, status
         FROM parity_sync_queue
         WHERE status = 'pending'
           AND {generic_owner}
           AND {ownership_exclusion}
           AND (
                next_retry_at IS NULL
                OR julianday(next_retry_at) <= julianday('now')
           )
         ORDER BY priority DESC, created_at ASC
         LIMIT 1"
    );
    conn.query_row(&sql, [], |row| {
        Ok(SyncQueueItem {
            id: row.get(0)?,
            table_name: row.get(1)?,
            record_id: row.get(2)?,
            operation: row.get(3)?,
            data: row.get(4)?,
            organization_id: row.get(5)?,
            created_at: row.get(6)?,
            attempts: row.get(7)?,
            last_attempt: row.get(8)?,
            error_message: row.get(9)?,
            next_retry_at: row.get(10)?,
            retry_delay_ms: row.get(11)?,
            priority: row.get(12)?,
            module_type: row.get(13)?,
            conflict_strategy: row.get(14)?,
            version: row.get(15)?,
            claim_generation: row.get(16)?,
            status: row.get(17)?,
        })
    })
    .optional()
    .map_err(|e| format!("sync_queue renderer_peek: {e}"))
}

/// Clear all items from the queue.
pub fn clear(conn: &Connection) -> Result<(), String> {
    let deleted: usize = conn
        .execute("DELETE FROM parity_sync_queue", [])
        .map_err(|e| format!("sync_queue clear: {e}"))?;

    info!(deleted = deleted, "Cleared parity sync queue");
    Ok(())
}

pub(crate) fn renderer_clear(conn: &Connection) -> Result<(), String> {
    let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
    let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
    let sql = format!(
        "DELETE FROM parity_sync_queue
         WHERE {generic_owner}
           AND {ownership_exclusion}"
    );
    conn.execute(&sql, [])
        .map_err(|e| format!("sync_queue renderer_clear: {e}"))?;
    Ok(())
}

/// Get the current number of items in the queue.
pub fn get_length(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
        row.get(0)
    })
    .map_err(|e| format!("sync_queue length: {e}"))
}

pub(crate) fn renderer_get_length(conn: &Connection) -> Result<i64, String> {
    let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
    let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
    let sql = format!(
        "SELECT COUNT(*) FROM parity_sync_queue
         WHERE {generic_owner}
           AND {ownership_exclusion}"
    );
    conn.query_row(&sql, [], |row| row.get(0))
        .map_err(|e| format!("sync_queue renderer length: {e}"))
}

fn oldest_queue_item_age_ms(
    conn: &Connection,
    predicate: Option<&str>,
) -> Result<Option<i64>, String> {
    let where_clause = predicate
        .map(|value| format!(" WHERE {value}"))
        .unwrap_or_default();
    let sql = format!(
        "SELECT CASE
             WHEN MIN(julianday(created_at)) IS NULL THEN NULL
             ELSE CAST(MAX(
                 0,
                 (julianday('now') - MIN(julianday(created_at))) * 86400000
             ) AS INTEGER)
         END
         FROM parity_sync_queue{where_clause}"
    );
    conn.query_row(&sql, [], |row| row.get(0))
        .map_err(|e| format!("sync_queue status oldest: {e}"))
}

/// Get detailed queue status including counts by status and oldest item age.
pub fn get_status(conn: &Connection) -> Result<QueueStatus, String> {
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("sync_queue status total: {e}"))?;

    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status pending: {e}"))?;

    let in_progress: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'processing'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status in_progress: {e}"))?;

    let failed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'failed'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status failed: {e}"))?;

    let conflicts: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'conflict'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status conflicts: {e}"))?;

    let quarantined: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue
             WHERE status = 'failed' AND error_message = ?1",
            [REPAIR_RESERVED_OWNER_QUARANTINED],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status quarantined: {e}"))?;

    let dead_lettered: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue
             WHERE status = 'failed'
               AND attempts >= ?1
               AND COALESCE(error_message, '') <> ?2",
            params![MAX_RETRY_ATTEMPTS, REPAIR_RESERVED_OWNER_QUARANTINED],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status dead_lettered: {e}"))?;

    let oldest_item_age = oldest_queue_item_age_ms(conn, None)?;

    Ok(QueueStatus {
        total,
        pending,
        in_progress,
        failed,
        conflicts,
        quarantined,
        dead_lettered,
        oldest_item_age,
    })
}

pub(crate) fn renderer_get_status(conn: &Connection) -> Result<QueueStatus, String> {
    let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
    let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
    let predicate = format!(
        "{generic_owner}
         AND {ownership_exclusion}"
    );
    let count = |status: Option<&str>| -> Result<i64, String> {
        let sql = match status {
            Some(_) => {
                format!("SELECT COUNT(*) FROM parity_sync_queue WHERE {predicate} AND status = ?1")
            }
            None => format!("SELECT COUNT(*) FROM parity_sync_queue WHERE {predicate}"),
        };
        if let Some(status) = status {
            conn.query_row(&sql, [status], |row| row.get(0))
        } else {
            conn.query_row(&sql, [], |row| row.get(0))
        }
        .map_err(|e| format!("sync_queue renderer status count: {e}"))
    };
    let oldest_item_age = oldest_queue_item_age_ms(conn, Some(&predicate))?;
    Ok(QueueStatus {
        total: count(None)?,
        pending: count(Some("pending"))?,
        in_progress: count(Some("processing"))?,
        failed: count(Some("failed"))?,
        conflicts: count(Some("conflict"))?,
        quarantined: {
            let sql = format!(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE {predicate}
                   AND status = 'failed'
                   AND error_message = ?1"
            );
            conn.query_row(&sql, [REPAIR_RESERVED_OWNER_QUARANTINED], |row| row.get(0))
                .map_err(|e| format!("sync_queue renderer status quarantined: {e}"))?
        },
        dead_lettered: {
            let sql = format!(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE {predicate}
                   AND status = 'failed'
                   AND attempts >= ?1
                   AND COALESCE(error_message, '') <> ?2"
            );
            conn.query_row(
                &sql,
                params![MAX_RETRY_ATTEMPTS, REPAIR_RESERVED_OWNER_QUARANTINED],
                |row| row.get(0),
            )
            .map_err(|e| format!("sync_queue renderer status dead_lettered: {e}"))?
        },
        oldest_item_age,
    })
}

fn sync_telemetry_scope(conn: &Connection) -> SyncTelemetryScope {
    SyncTelemetryScope {
        organization_id: runtime_credential(conn, "organization_id")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        terminal_id: runtime_credential(conn, "terminal_id")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    }
}

fn classify_sync_error(error: Option<&str>, http_status: Option<u16>) -> &'static str {
    let normalized = error.unwrap_or_default().to_ascii_lowercase();
    if normalized.contains("missing terminal_id")
        || normalized.contains("terminal_id context")
        || normalized.contains("missing_terminal_id")
        || normalized.contains("missing api key")
        || normalized.contains("terminal not configured")
        || normalized.contains("invalid terminal")
        || normalized.contains("revoked terminal")
        || normalized.contains("terminal auth")
    {
        return "terminal_auth";
    }

    if http_status == Some(429) || normalized.contains("rate limit") {
        return "rate_limited";
    }

    if matches!(http_status, Some(409 | 412))
        || normalized.contains("version conflict")
        || normalized.contains("version mismatch")
        || normalized.contains("stale version")
        || normalized.contains("conflict detected")
    {
        return "conflict";
    }

    if normalized.contains("network error") {
        return "network";
    }

    if normalized.contains("deferred") || normalized.contains("waiting for") {
        return "deferred";
    }

    if let Some(status) = http_status {
        if (400..500).contains(&status) {
            return "client_error";
        }
        if status >= 500 {
            return "server_error";
        }
    }

    "unknown"
}

pub fn list_actionable_items(
    conn: &Connection,
    query: &QueueListQuery,
) -> Result<Vec<SyncQueueItem>, String> {
    let limit = query.limit.unwrap_or(200).clamp(1, 500);

    let sql = if query
        .module_type
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        "SELECT id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, next_retry_at,
                retry_delay_ms, priority, module_type, conflict_strategy, version,
                claim_generation, status
         FROM parity_sync_queue
         WHERE status IN ('pending', 'processing', 'failed', 'conflict')
           AND module_type = ?1
         ORDER BY
            CASE status
                WHEN 'conflict' THEN 0
                WHEN 'failed' THEN 1
                WHEN 'pending' THEN 2
                ELSE 3
            END,
            priority DESC,
            created_at ASC
         LIMIT ?2"
    } else {
        "SELECT id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, next_retry_at,
                retry_delay_ms, priority, module_type, conflict_strategy, version,
                claim_generation, status
         FROM parity_sync_queue
         WHERE status IN ('pending', 'processing', 'failed', 'conflict')
         ORDER BY
            CASE status
                WHEN 'conflict' THEN 0
                WHEN 'failed' THEN 1
                WHEN 'pending' THEN 2
                ELSE 3
            END,
            priority DESC,
            created_at ASC
         LIMIT ?1"
    };

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("sync_queue list_actionable_items prepare: {e}"))?;

    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<SyncQueueItem> {
        Ok(SyncQueueItem {
            id: row.get(0)?,
            table_name: row.get(1)?,
            record_id: row.get(2)?,
            operation: row.get(3)?,
            data: row.get(4)?,
            organization_id: row.get(5)?,
            created_at: row.get(6)?,
            attempts: row.get(7)?,
            last_attempt: row.get(8)?,
            error_message: row.get(9)?,
            next_retry_at: row.get(10)?,
            retry_delay_ms: row.get(11)?,
            priority: row.get(12)?,
            module_type: row.get(13)?,
            conflict_strategy: row.get(14)?,
            version: row.get(15)?,
            claim_generation: row.get(16)?,
            status: row.get(17)?,
        })
    };

    let rows = if let Some(module_type) = query
        .module_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        stmt.query_map(params![module_type, limit], map_row)
            .map_err(|e| format!("sync_queue list_actionable_items query: {e}"))?
    } else {
        stmt.query_map(params![limit], map_row)
            .map_err(|e| format!("sync_queue list_actionable_items query: {e}"))?
    };

    Ok(rows.filter_map(Result::ok).collect())
}

pub(crate) fn renderer_list_actionable_items(
    conn: &Connection,
    query: &QueueListQuery,
) -> Result<Vec<SyncQueueItem>, String> {
    let limit = query.limit.unwrap_or(200).clamp(1, 500);
    let has_module = query
        .module_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if has_module.is_some_and(|module_type| module_type.eq_ignore_ascii_case("repairs")) {
        return Ok(Vec::new());
    }
    let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
    let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
    let sql = if has_module.is_some() {
        format!(
            "SELECT id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, next_retry_at,
                retry_delay_ms, priority, COALESCE(module_type, 'orders'), conflict_strategy, version,
                claim_generation, status
         FROM parity_sync_queue
         WHERE status IN ('pending', 'processing', 'failed', 'conflict')
           AND {generic_owner}
           AND {ownership_exclusion}
           AND module_type = ?1
         ORDER BY CASE status WHEN 'conflict' THEN 0 WHEN 'failed' THEN 1
                              WHEN 'pending' THEN 2 ELSE 3 END,
                  priority DESC, created_at ASC
         LIMIT ?2"
        )
    } else {
        format!(
            "SELECT id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, next_retry_at,
                retry_delay_ms, priority, COALESCE(module_type, 'orders'), conflict_strategy, version,
                claim_generation, status
         FROM parity_sync_queue
         WHERE status IN ('pending', 'processing', 'failed', 'conflict')
           AND {generic_owner}
           AND {ownership_exclusion}
         ORDER BY CASE status WHEN 'conflict' THEN 0 WHEN 'failed' THEN 1
                              WHEN 'pending' THEN 2 ELSE 3 END,
                  priority DESC, created_at ASC
         LIMIT ?1"
        )
    };
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("sync_queue renderer list prepare: {e}"))?;
    let map = |row: &rusqlite::Row<'_>| -> rusqlite::Result<SyncQueueItem> {
        Ok(SyncQueueItem {
            id: row.get(0)?,
            table_name: row.get(1)?,
            record_id: row.get(2)?,
            operation: row.get(3)?,
            data: row.get(4)?,
            organization_id: row.get(5)?,
            created_at: row.get(6)?,
            attempts: row.get(7)?,
            last_attempt: row.get(8)?,
            error_message: row.get(9)?,
            next_retry_at: row.get(10)?,
            retry_delay_ms: row.get(11)?,
            priority: row.get(12)?,
            module_type: row.get(13)?,
            conflict_strategy: row.get(14)?,
            version: row.get(15)?,
            claim_generation: row.get(16)?,
            status: row.get(17)?,
        })
    };
    let rows = if let Some(module_type) = has_module {
        stmt.query_map(params![module_type, limit], map)
            .map_err(|e| format!("sync_queue renderer list query: {e}"))?
    } else {
        stmt.query_map(params![limit], map)
            .map_err(|e| format!("sync_queue renderer list query: {e}"))?
    };
    Ok(rows.filter_map(Result::ok).collect())
}

fn retry_transaction<T>(
    conn: &Connection,
    operation: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| format!("sync_queue retry begin: {error}"))?;
    match operation(conn) {
        Ok(value) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(value),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(format!("sync_queue retry commit: {error}"))
            }
        },
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn live_generic_claim_predicate(alias: &str) -> String {
    let generic_owner = semantic_generic_nonfinancial_owner_predicate(alias);
    format!(
        "{alias}.id = ?1
         AND {alias}.status = 'processing'
         AND {alias}.claim_generation = ?2
         AND {generic_owner}"
    )
}

fn is_live_generic_claim(conn: &Connection, item: &SyncQueueItem) -> Result<bool, String> {
    let live_claim = live_generic_claim_predicate("parity_sync_queue");
    let sql = format!(
        "SELECT EXISTS(
             SELECT 1
               FROM parity_sync_queue
              WHERE {live_claim}
         )"
    );
    conn.query_row(&sql, params![item.id, item.claim_generation], |row| {
        row.get::<_, bool>(0)
    })
    .map_err(|error| format!("sync_queue inspect live generic claim: {error}"))
}

/// Execute a local post-response effect only while the original generic
/// claimant still owns the exact semantic row/generation. `BEGIN IMMEDIATE`
/// makes the ownership recheck and mutation one atomic SQLite writer action.
fn with_live_generic_claim<T>(
    conn: &Connection,
    item: &SyncQueueItem,
    operation: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<Option<T>, String> {
    retry_transaction(conn, |conn| {
        if !is_live_generic_claim(conn, item)? {
            return Ok(None);
        }
        operation(conn).map(Some)
    })
}

pub fn retry_item(conn: &Connection, item_id: &str) -> Result<(), String> {
    retry_transaction(conn, |conn| {
        let semantic_reserved = semantic_reserved_repair_owner_predicate("parity_sync_queue");
        let financial = semantic_repair_financial_queue_owner_predicate("parity_sync_queue");
        let ownership = conn
            .query_row(
                &format!(
                    "SELECT ({semantic_reserved}), ({financial})
                       FROM parity_sync_queue
                      WHERE id = ?1"
                ),
                [item_id],
                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()
            .map_err(|error| format!("sync_queue retry repair guard: {error}"))?;
        match ownership {
            Some((true, _)) => return Err("REPAIR_TYPED_CONFLICT_REQUIRED".to_string()),
            Some((false, true)) => return Err("REPAIR_SETTLEMENT_ROUTE_REQUIRED".to_string()),
            _ => {}
        }
        let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
        let update_sql = format!(
            "UPDATE parity_sync_queue
             SET status = 'pending',
                 attempts = 0,
                 error_message = NULL,
                 next_retry_at = NULL,
                 last_attempt = NULL,
                 retry_delay_ms = ?1
             WHERE id = ?2
               AND {generic_owner}"
        );
        conn.execute(
            &update_sql,
            params![DEFAULT_INITIAL_RETRY_DELAY_MS, item_id],
        )
        .map_err(|e| format!("sync_queue retry_item: {e}"))?;
        Ok(())
    })
}

pub(crate) fn renderer_retry_item(conn: &Connection, item_id: &str) -> Result<(), String> {
    retry_transaction(conn, |conn| {
        let semantic_reserved = semantic_reserved_repair_owner_predicate("parity_sync_queue");
        let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
        let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
        let ownership_sql = format!(
            "SELECT
                 ({semantic_reserved}),
                 NOT ({ownership_exclusion})
             FROM parity_sync_queue
             WHERE id = ?1"
        );
        let ownership = conn
            .query_row(&ownership_sql, [item_id], |row| {
                Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?))
            })
            .optional()
            .map_err(|e| format!("sync_queue renderer retry guard: {e}"))?;
        match ownership {
            Some((true, _)) => return Err("REPAIR_TYPED_CONFLICT_REQUIRED".to_string()),
            Some((false, true)) => return Err("REPAIR_SETTLEMENT_ROUTE_REQUIRED".to_string()),
            _ => {}
        }
        let update_sql = format!(
            "UPDATE parity_sync_queue
             SET status = 'pending', attempts = 0, error_message = NULL,
                 next_retry_at = NULL, last_attempt = NULL, retry_delay_ms = ?1
             WHERE id = ?2
               AND {generic_owner}
               AND {ownership_exclusion}"
        );
        conn.execute(
            &update_sql,
            params![DEFAULT_INITIAL_RETRY_DELAY_MS, item_id],
        )
        .map_err(|e| format!("sync_queue renderer retry_item: {e}"))?;
        Ok(())
    })
}

pub fn retry_items_by_module(
    conn: &Connection,
    module_type: &str,
) -> Result<RetryItemsResult, String> {
    retry_transaction(conn, |conn| {
        let semantic_reserved = semantic_reserved_repair_owner_predicate("parity_sync_queue");
        let financial = semantic_repair_financial_queue_owner_predicate("parity_sync_queue");
        let includes_repair = if module_type.trim().eq_ignore_ascii_case("repairs") {
            true
        } else {
            conn.query_row(
                &format!(
                    "SELECT EXISTS(
                     SELECT 1 FROM parity_sync_queue
                      WHERE module_type = ?1
                        AND {semantic_reserved}
                 )"
                ),
                [module_type],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("sync_queue retry module repair guard: {error}"))?
        };
        if includes_repair {
            return Err("REPAIR_TYPED_CONFLICT_REQUIRED".to_string());
        }
        let includes_repair_financial = conn
            .query_row(
                &format!(
                    "SELECT EXISTS(
                         SELECT 1 FROM parity_sync_queue
                          WHERE module_type = ?1
                            AND {financial}
                     )"
                ),
                [module_type],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("sync_queue retry module financial guard: {error}"))?;
        if includes_repair_financial {
            return Err("REPAIR_SETTLEMENT_ROUTE_REQUIRED".to_string());
        }
        let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
        let update_sql = format!(
            "UPDATE parity_sync_queue
             SET status = 'pending',
                 attempts = 0,
                 error_message = NULL,
                 next_retry_at = NULL,
                 last_attempt = NULL,
                 retry_delay_ms = ?1
             WHERE module_type = ?2
               AND status IN ('pending', 'failed', 'conflict')
               AND {generic_owner}"
        );
        let retried = conn
            .execute(
                &update_sql,
                params![DEFAULT_INITIAL_RETRY_DELAY_MS, module_type],
            )
            .map_err(|e| format!("sync_queue retry_items_by_module: {e}"))?;

        Ok(RetryItemsResult {
            retried: retried as i64,
        })
    })
}

pub(crate) fn renderer_retry_items_by_module(
    conn: &Connection,
    module_type: &str,
) -> Result<RetryItemsResult, String> {
    if module_type.trim().eq_ignore_ascii_case("repairs") {
        return Err("REPAIR_TYPED_CONFLICT_REQUIRED".to_string());
    }
    let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
    let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
    let sql = format!(
        "UPDATE parity_sync_queue
         SET status = 'pending', attempts = 0, error_message = NULL,
             next_retry_at = NULL, last_attempt = NULL, retry_delay_ms = ?1
         WHERE module_type = ?2
           AND {generic_owner}
           AND {ownership_exclusion}
           AND status IN ('pending', 'failed', 'conflict')"
    );
    let retried = conn
        .execute(&sql, params![DEFAULT_INITIAL_RETRY_DELAY_MS, module_type])
        .map_err(|e| format!("sync_queue renderer retry module: {e}"))?;
    Ok(RetryItemsResult {
        retried: retried as i64,
    })
}

pub(crate) fn renderer_retryable_item_ids_by_module(
    conn: &Connection,
    module_type: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let module_type = module_type.trim();
    if module_type.is_empty() {
        return Err("PARITY_MODULE_REQUIRED".to_string());
    }
    if module_type.eq_ignore_ascii_case("repairs") {
        return Err("REPAIR_TYPED_CONFLICT_REQUIRED".to_string());
    }
    let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
    let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
    let sql = format!(
        "SELECT id
           FROM parity_sync_queue
          WHERE module_type = ?1
            AND status IN ('pending', 'failed', 'conflict')
            AND {generic_owner}
            AND {ownership_exclusion}
          ORDER BY priority DESC, created_at ASC, id ASC
          LIMIT ?2"
    );
    let bounded_limit = limit.clamp(1, 500) as i64;
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("sync_queue renderer module list prepare: {error}"))?;
    let rows = statement
        .query_map(params![module_type, bounded_limit], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| format!("sync_queue renderer module list query: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("sync_queue renderer module list row: {error}"))
}

pub fn list_conflict_audit_entries(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<ConflictAuditEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, operation_type, entity_id, entity_type, local_version,
                    server_version, timestamp, discarded_payload, resolution,
                    is_monetary, reviewed_by_operator
             FROM conflict_audit_log
             ORDER BY timestamp DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("sync_queue list_conflict_audit_entries prepare: {e}"))?;

    let rows = stmt
        .query_map(params![limit.clamp(1, 500)], |row| {
            Ok(ConflictAuditEntry {
                id: row.get(0)?,
                operation_type: row.get(1)?,
                entity_id: row.get(2)?,
                entity_type: row.get(3)?,
                local_version: row.get(4)?,
                server_version: row.get(5)?,
                timestamp: row.get(6)?,
                discarded_payload: row.get(7)?,
                resolution: row.get(8)?,
                is_monetary: row.get::<_, i64>(9)? != 0,
                reviewed_by_operator: row.get::<_, i64>(10)? != 0,
            })
        })
        .map_err(|e| format!("sync_queue list_conflict_audit_entries query: {e}"))?;

    Ok(rows.filter_map(Result::ok).collect())
}

pub(crate) fn renderer_list_conflict_audit_entries(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<ConflictAuditEntry>, String> {
    let direct_exclusion = format!(
        "NOT ({})",
        semantic_repair_audit_owner_predicate("conflict_audit_log")
    );
    let ownership_exclusion = renderer_non_repair_conflict_owner_predicate("conflict_audit_log");
    let sql = format!(
        "SELECT id, operation_type, entity_id, entity_type, local_version,
                server_version, timestamp, discarded_payload, resolution,
                is_monetary, reviewed_by_operator
         FROM conflict_audit_log
         WHERE {direct_exclusion}
           AND {ownership_exclusion}
         ORDER BY timestamp DESC
         LIMIT ?1"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("sync_queue renderer conflict list prepare: {e}"))?;
    let rows = stmt
        .query_map(params![limit.clamp(1, 500)], |row| {
            Ok(ConflictAuditEntry {
                id: row.get(0)?,
                operation_type: row.get(1)?,
                entity_id: row.get(2)?,
                entity_type: row.get(3)?,
                local_version: row.get(4)?,
                server_version: row.get(5)?,
                timestamp: row.get(6)?,
                discarded_payload: row.get(7)?,
                resolution: row.get(8)?,
                is_monetary: row.get::<_, i64>(9)? != 0,
                reviewed_by_operator: row.get::<_, i64>(10)? != 0,
            })
        })
        .map_err(|e| format!("sync_queue renderer conflict list query: {e}"))?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Mark an item as successfully processed and remove it from the queue.
///
/// Wave 10 H8: takes the caller's `expected_generation` (the
/// `claim_generation` from the `SyncQueueItem` returned by `dequeue`)
/// and only deletes the row when the caller's generation matches the
/// row's current generation. A late ack from a worker whose lease
/// expired (and whose generation was bumped by
/// `recover_stale_processing_items`) is silently dropped — the row
/// stays in its current state (already reclaimed by another worker,
/// or already success-deleted by the worker that owned the new
/// generation).
///
/// Returns `Ok(())` in BOTH cases (deleted and no-op). Callers do not
/// need to distinguish — the only relevant invariant is "this caller's
/// success ack will not corrupt a fresh in-flight claim". A debug log
/// records the no-op for observability.
pub fn mark_success(
    conn: &Connection,
    item_id: &str,
    expected_generation: i64,
) -> Result<(), String> {
    let rows_affected = conn
        .execute(
            "DELETE FROM parity_sync_queue
             WHERE id = ?1 AND claim_generation = ?2",
            params![item_id, expected_generation],
        )
        .map_err(|e| format!("sync_queue mark_success: {e}"))?;

    if rows_affected == 0 {
        debug!(
            item_id = %item_id,
            expected_generation,
            "Wave 10 H8: mark_success no-op — claim_generation mismatch (row reclaimed by another worker or already deleted)"
        );
    }

    Ok(())
}

/// Mark an item as failed with exponential backoff for retry.
///
/// If max retries are exhausted, the item status changes to `failed`.
///
/// Returns an authoritative, generation-fenced mutation outcome. The
/// transition bit is true exactly when this call changed a live processing
/// row into a max-attempt terminal failure; the optional monetary notice is
/// produced by that same transition and is therefore exactly-once.
pub fn mark_failure(
    conn: &Connection,
    item_id: &str,
    error_message: &str,
    expected_generation: i64,
) -> Result<MarkFailureOutcome, String> {
    retry_transaction(conn, |conn| {
        mark_failure_in_transaction(conn, item_id, error_message, expected_generation)
    })
}

fn mark_failure_in_transaction(
    conn: &Connection,
    item_id: &str,
    error_message: &str,
    expected_generation: i64,
) -> Result<MarkFailureOutcome, String> {
    let now = Utc::now().to_rfc3339();
    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let canonical_repair = canonical_repair_owner_predicate("parity_sync_queue");
    let live_owner = format!("({generic_owner} OR {canonical_repair})");

    // Get current attempts, retry delay, and module type. The module
    // type drives the per-class retry cap below (Wave 2a).
    let read_sql = format!(
        "SELECT attempts, retry_delay_ms, module_type
           FROM parity_sync_queue
          WHERE id = ?1
            AND status = 'processing'
            AND claim_generation = ?2
            AND {live_owner}"
    );
    let Some((attempts, retry_delay_ms, module_type)): Option<(i64, i64, String)> = conn
        .query_row(&read_sql, params![item_id, expected_generation], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()
        .map_err(|e| format!("sync_queue mark_failure read: {e}"))?
    else {
        return Ok(MarkFailureOutcome::default());
    };

    let new_attempts = attempts + 1;

    if new_attempts >= MAX_RETRY_ATTEMPTS {
        // Max retries exhausted -- mark as permanently failed.
        // Wave 10 H8 sub-follow-up: the guard predicate
        // `claim_generation = ?N` mirrors the `mark_success` shape.
        // If the row was reclaimed (generation bumped beneath us)
        // the UPDATE affects 0 rows, we skip the dead-letter path
        // entirely, and return Ok(None) — the fresh claimer's own
        // ack determines the row's terminal state.
        let terminal_sql = format!(
            "UPDATE parity_sync_queue
                 SET status = 'failed', attempts = ?1, last_attempt = ?2,
                     error_message = ?3
                 WHERE id = ?4
                   AND status = 'processing'
                   AND claim_generation = ?5
                   AND {live_owner}"
        );
        let rows_affected = conn
            .execute(
                &terminal_sql,
                params![
                    new_attempts,
                    now,
                    error_message,
                    item_id,
                    expected_generation
                ],
            )
            .map_err(|e| format!("sync_queue mark_failed: {e}"))?;
        if rows_affected == 0 {
            debug!(
                expected_generation,
                "Wave 10 H8: mark_failure (terminal) no-op — claim_generation mismatch"
            );
            return Ok(MarkFailureOutcome::default());
        }

        // Wave 4 H: log at ERROR for monetary items so the audit log
        // has a specific searchable marker. Non-monetary items stay at
        // WARN.
        let monetary_category = monetary_dead_letter_category(&module_type);
        if let Some(category) = monetary_category {
            tracing::error!(
                category = ?category,
                attempts = new_attempts,
                "MONETARY sync_queue item dead-lettered (operator intervention required)"
            );
        } else {
            warn!(
                attempts = new_attempts,
                "Sync queue item exhausted max retries, marked as failed"
            );
        }
        return Ok(MarkFailureOutcome {
            applied: true,
            transitioned_to_dead_letter: true,
            monetary_notice: monetary_category.map(|category| MonetaryDeadLetter { category }),
        });
    } else {
        // Wave 2a: jittered exponential backoff with per-class caps.
        // Without jitter, a whole fleet of terminals recovering from
        // the same outage retries in perfect lockstep and re-DoSes the
        // server. Monetary items use a longer cap (5 min) so the
        // same bucket of failing payments does not hammer the server
        // at 60 s intervals indefinitely.
        let new_delay = compute_next_retry_delay_ms(retry_delay_ms, &module_type);
        let next_retry = Utc::now() + ChronoDuration::milliseconds(new_delay);

        // Wave 10 H8 sub-follow-up: same `claim_generation` guard
        // as the terminal-failed branch above. If a stale claimer's
        // failure ack lands after recover_stale bumped the
        // generation, the UPDATE affects 0 rows and we drop the
        // attempts bump silently — the fresh claimer's `attempts`
        // counter is preserved.
        let retry_sql = format!(
            "UPDATE parity_sync_queue
                 SET status = 'pending', attempts = ?1, last_attempt = ?2,
                     error_message = ?3, retry_delay_ms = ?4,
                     next_retry_at = ?5
                 WHERE id = ?6
                   AND status = 'processing'
                   AND claim_generation = ?7
                   AND {live_owner}"
        );
        let rows_affected = conn
            .execute(
                &retry_sql,
                params![
                    new_attempts,
                    now,
                    error_message,
                    new_delay,
                    next_retry.to_rfc3339(),
                    item_id,
                    expected_generation,
                ],
            )
            .map_err(|e| format!("sync_queue schedule_retry: {e}"))?;
        if rows_affected == 0 {
            debug!(
                expected_generation,
                "Wave 10 H8: mark_failure (schedule-retry) no-op — claim_generation mismatch"
            );
            return Ok(MarkFailureOutcome::default());
        }
    }

    Ok(MarkFailureOutcome {
        applied: true,
        transitioned_to_dead_letter: false,
        monetary_notice: None,
    })
}

pub fn mark_rate_limited(
    conn: &Connection,
    item_id: &str,
    error_message: &str,
    retry_after_secs: i64,
    expected_generation: i64,
) -> Result<(), String> {
    let now = Utc::now();
    let retry_after_secs = retry_after_secs.max(1);
    let retry_delay_ms =
        (retry_after_secs * 1000).clamp(DEFAULT_INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
    let next_retry = now + ChronoDuration::seconds(retry_after_secs);

    // Wave 10 H8 sub-follow-up: claim_generation guard mirrors the
    // mark_success / mark_failure shape. A stale claimer's
    // rate-limit ack must NOT clobber the fresh claimer's row state.
    let rows_affected = conn
        .execute(
            "UPDATE parity_sync_queue
             SET status = 'pending',
                 last_attempt = ?1,
                 error_message = ?2,
                 retry_delay_ms = ?3,
                 next_retry_at = ?4
             WHERE id = ?5 AND claim_generation = ?6",
            params![
                now.to_rfc3339(),
                error_message,
                retry_delay_ms,
                next_retry.to_rfc3339(),
                item_id,
                expected_generation,
            ],
        )
        .map_err(|e| format!("sync_queue mark_rate_limited: {e}"))?;
    if rows_affected == 0 {
        debug!(
            item_id = %item_id,
            expected_generation,
            "Wave 10 H8: mark_rate_limited no-op — claim_generation mismatch"
        );
    }

    Ok(())
}

pub fn mark_deferred(
    conn: &Connection,
    item_id: &str,
    reason: &str,
    expected_generation: i64,
) -> Result<(), String> {
    // Wave 4: increment `attempts` so deferral cannot loop forever.
    // Before this fix a row deferred with e.g. "Waiting for parent
    // order sync" would re-enter `pending` with a 5s retry and no
    // counter bump — if the parent never synced, the child deferred
    // indefinitely with no operator-visible alarm. We now cap at
    // `MAX_DEFERRAL_CYCLES` and escalate to `conflict` status when
    // exceeded so it surfaces in the actionable-items list.
    let current_attempts: i64 = conn
        .query_row(
            "SELECT attempts FROM parity_sync_queue WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let new_attempts = current_attempts + 1;

    if new_attempts >= MAX_DEFERRAL_CYCLES {
        // Wave 10 H8 sub-follow-up: claim_generation guard. A stale
        // claimer must not escalate the row to 'conflict' if the
        // fresh claimer has already taken over.
        let rows_affected = conn
            .execute(
                "UPDATE parity_sync_queue
                 SET status = 'conflict',
                     attempts = ?1,
                     error_message = ?2
                 WHERE id = ?3 AND claim_generation = ?4",
                params![
                    new_attempts,
                    format!(
                        "Deferred too many times ({new_attempts}× \"{reason}\"); escalated to conflict"
                    ),
                    item_id,
                    expected_generation,
                ],
            )
            .map_err(|e| format!("sync_queue mark_deferred escalate: {e}"))?;
        if rows_affected == 0 {
            debug!(
                item_id = %item_id,
                expected_generation,
                "Wave 10 H8: mark_deferred (escalate-to-conflict) no-op — claim_generation mismatch"
            );
            return Ok(());
        }
        warn!(
            id = %item_id,
            attempts = new_attempts,
            reason,
            "parity_sync_queue deferral cap reached; item escalated to conflict"
        );
        return Ok(());
    }

    let next_retry = Utc::now() + ChronoDuration::seconds(5);
    // Wave 10 H8 sub-follow-up: same guard for the reschedule branch.
    let rows_affected = conn
        .execute(
            "UPDATE parity_sync_queue
             SET status = 'pending',
                 attempts = ?1,
                 error_message = ?2,
                 next_retry_at = ?3
             WHERE id = ?4 AND claim_generation = ?5",
            params![
                new_attempts,
                reason,
                next_retry.to_rfc3339(),
                item_id,
                expected_generation,
            ],
        )
        .map_err(|e| format!("sync_queue mark_deferred: {e}"))?;
    if rows_affected == 0 {
        debug!(
            item_id = %item_id,
            expected_generation,
            "Wave 10 H8: mark_deferred (reschedule) no-op — claim_generation mismatch"
        );
    }

    Ok(())
}

/// Park a module-denied item (THE-306 gating sweep item 3).
///
/// The admin API answered `403 {"error":"MODULE_REQUIRED",...}`: the
/// organization has not acquired the vertical module this item belongs to.
/// That is an operator/billing state, not a data problem — the row must stay
/// queued so re-acquiring the module drains it (fail closed, queue
/// retained). Unlike `mark_deferred` this therefore does NOT consume
/// `attempts` (50 deferral cycles at 5s would escalate to `conflict` within
/// minutes) and reschedules on the slow `MODULE_REQUIRED_RETRY_SECS`
/// cadence instead.
pub fn mark_module_required(
    conn: &Connection,
    item_id: &str,
    reason: &str,
    expected_generation: i64,
) -> Result<(), String> {
    let next_retry = Utc::now() + ChronoDuration::seconds(MODULE_REQUIRED_RETRY_SECS);
    let rows_affected = conn
        .execute(
            "UPDATE parity_sync_queue
             SET status = 'pending',
                 error_message = ?1,
                 next_retry_at = ?2
             WHERE id = ?3 AND claim_generation = ?4",
            params![
                reason,
                next_retry.to_rfc3339(),
                item_id,
                expected_generation,
            ],
        )
        .map_err(|e| format!("sync_queue mark_module_required: {e}"))?;
    if rows_affected == 0 {
        debug!(
            item_id = %item_id,
            expected_generation,
            "mark_module_required no-op — claim_generation mismatch"
        );
    }
    Ok(())
}

/// Park a repair row that needs a fresh staff sign-in or a later cache hook.
/// This is an environmental prerequisite rather than a bad command, so it
/// intentionally leaves `attempts` unchanged and avoids a hot same-batch loop.
fn mark_repair_prerequisite(
    conn: &Connection,
    item_id: &str,
    reason_code: &str,
    expected_generation: i64,
) -> Result<(), String> {
    let next_retry = Utc::now() + ChronoDuration::seconds(MODULE_REQUIRED_RETRY_SECS);
    conn.execute(
        "UPDATE parity_sync_queue
         SET status = 'pending',
             error_message = ?1,
             next_retry_at = ?2
         WHERE id = ?3 AND claim_generation = ?4",
        params![
            reason_code,
            next_retry.to_rfc3339(),
            item_id,
            expected_generation,
        ],
    )
    .map_err(|error| format!("sync_queue mark_repair_prerequisite: {error}"))?;
    Ok(())
}

fn mark_terminal_auth_pending(
    conn: &Connection,
    item: &SyncQueueItem,
    failure: ParityTerminalAuthFailure,
) -> Result<(), String> {
    let next_retry = Utc::now() + ChronoDuration::seconds(MODULE_REQUIRED_RETRY_SECS);
    let bounded_code = failure.code.as_str();
    let rows_affected = conn
        .execute(
            "UPDATE parity_sync_queue
             SET status = 'pending',
                 error_message = ?1,
                 next_retry_at = ?2
             WHERE id = ?3
               AND status = 'processing'
               AND claim_generation = ?4",
            params![
                bounded_code,
                next_retry.to_rfc3339(),
                item.id,
                item.claim_generation,
            ],
        )
        .map_err(|error| format!("sync_queue park bounded terminal auth: {error}"))?;
    if rows_affected != 1 {
        return Err("sync_queue terminal-auth claim no longer live".to_string());
    }
    Ok(())
}

/// Mark an item as having a conflict.
pub fn mark_conflict(
    conn: &Connection,
    item_id: &str,
    expected_generation: i64,
) -> Result<(), String> {
    // Wave 10 H8 sub-follow-up: claim_generation guard. A stale
    // claimer's HTTP-409 ack must not flip a row already reclaimed
    // by a fresh worker into 'conflict'.
    let rows_affected = conn
        .execute(
            "UPDATE parity_sync_queue
             SET status = 'conflict'
             WHERE id = ?1 AND claim_generation = ?2",
            params![item_id, expected_generation],
        )
        .map_err(|e| format!("sync_queue mark_conflict: {e}"))?;
    if rows_affected == 0 {
        debug!(
            item_id = %item_id,
            expected_generation,
            "Wave 10 H8: mark_conflict no-op — claim_generation mismatch"
        );
    }

    Ok(())
}

/// Park a legacy customer replay that cannot be interpreted without an ISO
/// country context. The reason is a stable non-PII code, attempts are not
/// consumed, and `conflict` keeps the row out of future dequeue passes after
/// process restart.
fn park_customer_phone_country_resolution(
    conn: &Connection,
    item_id: &str,
    expected_generation: i64,
    reason_code: &str,
) -> Result<(), String> {
    let rows_affected = conn
        .execute(
            "UPDATE parity_sync_queue
             SET status = 'conflict', error_message = ?1, next_retry_at = NULL
             WHERE id = ?2 AND claim_generation = ?3",
            params![reason_code, item_id, expected_generation],
        )
        .map_err(|e| format!("sync_queue park customer country resolution: {e}"))?;
    if rows_affected == 0 {
        debug!(
            item_id = %item_id,
            expected_generation,
            "Customer country manual-resolution park ignored for stale claim"
        );
    }
    Ok(())
}

/// Log a conflict to the audit trail.
pub fn log_conflict(
    conn: &Connection,
    operation_type: &str,
    entity_id: &str,
    entity_type: &str,
    local_version: i64,
    server_version: i64,
    discarded_payload: &str,
    resolution: &str,
    is_monetary: bool,
    reviewed: bool,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO conflict_audit_log
            (id, operation_type, entity_id, entity_type, local_version,
             server_version, timestamp, discarded_payload, resolution,
             is_monetary, reviewed_by_operator)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            operation_type,
            entity_id,
            entity_type,
            local_version,
            server_version,
            now,
            discarded_payload,
            resolution,
            is_monetary as i32,
            reviewed as i32,
        ],
    )
    .map_err(|e| format!("sync_queue log_conflict: {e}"))?;

    info!(
        id = %id,
        entity = %entity_id,
        entity_type = %entity_type,
        resolution = %resolution,
        is_monetary = is_monetary,
        "Logged conflict to audit trail"
    );

    Ok(id)
}

/// Check for items older than the age warning threshold and log warnings.
pub fn check_age_warnings(conn: &Connection) -> Result<Vec<String>, String> {
    let threshold = Utc::now() - ChronoDuration::milliseconds(AGE_WARNING_THRESHOLD_MS);
    let threshold_str = threshold.to_rfc3339();

    let mut stmt = conn
        .prepare(
            "SELECT id, table_name, record_id, created_at
             FROM parity_sync_queue
             WHERE created_at <= ?1",
        )
        .map_err(|e| format!("sync_queue age_warnings prepare: {e}"))?;

    let warnings: Vec<String> = stmt
        .query_map(params![threshold_str], |row| {
            let id: String = row.get(0)?;
            let table: String = row.get(1)?;
            let record: String = row.get(2)?;
            let created: String = row.get(3)?;
            Ok(format!(
                "Item {id} ({table}/{record}) enqueued at {created} exceeds age threshold"
            ))
        })
        .map_err(|e| format!("sync_queue age_warnings query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // Cap per-item logging: with the raised queue cap, a multi-day offline
    // backlog can put thousands of rows past the age threshold, and this
    // runs at the top of every processing cycle. A summary line keeps the
    // signal without flooding the log. The returned Vec is intentionally
    // complete -- only the logging is capped.
    if !warnings.is_empty() {
        warn!(
            total = warnings.len(),
            "Sync queue items exceed the age threshold"
        );
    }

    Ok(warnings)
}

fn prepare_request(conn: &Connection, item: &SyncQueueItem) -> Result<RequestPreparation, String> {
    let payload =
        serde_json::from_str::<Value>(&item.data).unwrap_or_else(|_| Value::Object(Map::new()));
    let terminal_id = match resolve_request_terminal_id(conn, &payload) {
        Some(value) => value,
        None => {
            return Ok(RequestPreparation::Failed {
                reason: "Parity sync request is missing terminal_id context".to_string(),
            })
        }
    };

    if item.module_type == "fiscal" {
        return Ok(RequestPreparation::Ready(RequestSpec {
            endpoint: resolve_endpoint(item),
            method: Method::POST,
            body: Some(normalize_fiscal_request_payload(&payload).to_string()),
            terminal_id,
        }));
    }

    match item.table_name.as_str() {
        "orders" => prepare_order_request(conn, item, &payload, terminal_id.as_str()),
        "payments" => prepare_payment_request(conn, item, &payload, terminal_id.as_str()),
        "payment_adjustments" => {
            prepare_adjustment_request(conn, item, &payload, terminal_id.as_str())
        }
        "staff_shifts" => prepare_shift_request(conn, item, &payload, terminal_id.as_str()),
        "driver_earnings" | "driver_earning" | "shift_expenses" | "staff_payments" => {
            prepare_financial_request(conn, item, &payload, terminal_id.as_str())
        }
        "loyalty_transactions" => {
            prepare_loyalty_request(conn, item, &payload, terminal_id.as_str())
        }
        "housekeeping_tasks" => prepare_housekeeping_request(item, &payload, terminal_id.as_str()),
        "restaurant_table_sessions" => {
            prepare_table_session_request(conn, item, &payload, terminal_id.as_str())
        }
        "room_checkins" => prepare_room_checkin_request(item, &payload, terminal_id.as_str()),
        "po_receipts" => prepare_po_receipt_request(item, &payload, terminal_id.as_str()),
        "supplier_import_commits" => {
            prepare_supplier_import_commit_request(item, &payload, terminal_id.as_str())
        }
        "customer_addresses" => {
            prepare_customer_address_request(conn, item, &payload, terminal_id.as_str())
        }
        "customers" => prepare_customer_request(item, &payload, terminal_id.as_str()),
        _ => Ok(RequestPreparation::Ready(RequestSpec {
            endpoint: resolve_endpoint(item),
            method: resolve_http_method(item),
            body: if resolve_http_method(item) == Method::DELETE {
                None
            } else {
                Some(item.data.clone())
            },
            terminal_id,
        })),
    }
}

const CUSTOMER_PHONE_COUNTRY_CONTEXT_REQUIRED: &str = "CUSTOMER_PHONE_COUNTRY_CONTEXT_REQUIRED";
const CUSTOMER_PHONE_COUNTRY_CONTEXT_INVALID: &str = "CUSTOMER_PHONE_COUNTRY_CONTEXT_INVALID";
// Kept in parity with libphonenumber-js' supported calling-code metadata used
// by the renderer and Android customer flows.  ISO-looking placeholders such
// as ZZ must never be sent to the strict server parser.
const SUPPORTED_CUSTOMER_PHONE_COUNTRIES: &str =
    "AC AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TA TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW";

fn normalize_supported_customer_phone_country(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_uppercase();
    if normalized.len() != 2 || !normalized.chars().all(|ch| ch.is_ascii_alphabetic()) {
        return None;
    }
    SUPPORTED_CUSTOMER_PHONE_COUNTRIES
        .split_ascii_whitespace()
        .any(|supported| supported == normalized)
        .then_some(normalized)
}

fn prepare_customer_request(
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let mut body = payload.clone();
    let Some(object) = body.as_object_mut() else {
        return Ok(RequestPreparation::Failed {
            reason: "Customer replay payload must be a JSON object".to_string(),
        });
    };

    let submitted_phone = object.get("phone").and_then(Value::as_str);
    if let Some(phone) = submitted_phone {
        let trimmed_phone = phone.trim();
        let country_value = object
            .get("phone_country_code")
            .or_else(|| object.get("phoneCountryCode"));
        let submitted_country = country_value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let normalized_country =
            submitted_country.and_then(normalize_supported_customer_phone_country);

        if submitted_country.is_some() && normalized_country.is_none() {
            return Ok(RequestPreparation::ManualResolution {
                reason_code: CUSTOMER_PHONE_COUNTRY_CONTEXT_INVALID.to_string(),
            });
        }

        let international = trimmed_phone.starts_with('+') || trimmed_phone.starts_with("00");
        if !trimmed_phone.is_empty() && !international && normalized_country.is_none() {
            return Ok(RequestPreparation::ManualResolution {
                reason_code: CUSTOMER_PHONE_COUNTRY_CONTEXT_REQUIRED.to_string(),
            });
        }

        if let Some(country) = normalized_country {
            object.insert("phone_country_code".to_string(), Value::String(country));
            object.remove("phoneCountryCode");
        } else if international {
            // Upgrade pre-country-context rows into the current explicit
            // payload contract. The international prefix is self-contained,
            // so no country guess is needed or permitted.
            object.insert("phone_country_code".to_string(), Value::Null);
            object.remove("phoneCountryCode");
        }
    } else if object.get("phone").is_some_and(Value::is_null) {
        object.insert("phone_country_code".to_string(), Value::Null);
        object.remove("phoneCountryCode");
    }

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: resolve_customers_endpoint(item),
        method: resolve_http_method(item),
        body: if resolve_http_method(item) == Method::DELETE {
            None
        } else {
            Some(body.to_string())
        },
        terminal_id: terminal_id.to_string(),
    }))
}

fn shift_event_type(item: &SyncQueueItem, payload: &Value) -> &'static str {
    if item.operation == "INSERT" {
        return "shift_open";
    }

    let is_transfer_update = payload.get("isTransferPending").is_some()
        || payload.get("is_transfer_pending").is_some()
        || payload.get("transferredToCashierShiftId").is_some()
        || payload.get("transferred_to_cashier_shift_id").is_some();
    if is_transfer_update {
        return "shift_transfer";
    }

    "shift_close"
}

fn prepare_shift_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let (_, runtime_branch_id, _) = resolve_runtime_context(conn, payload);
    let branch_id = string_field(payload, &["branchId", "branch_id"])
        .or_else(|| {
            let trimmed = runtime_branch_id.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .unwrap_or_default();
    if branch_id.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Shift sync request is missing branch_id context".to_string(),
        });
    }

    let shift_id = string_field(payload, &["shiftId", "shift_id"])
        .unwrap_or_else(|| item.record_id.trim().to_string());
    if shift_id.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Shift sync request is missing shift_id".to_string(),
        });
    }

    let idempotency_key = string_field(payload, &["idempotencyKey", "idempotency_key"])
        .unwrap_or_else(|| {
            format!(
                "{}:{}",
                crate::idempotency::make_entity_key(
                    conn,
                    item.table_name.as_str(),
                    &item.record_id
                ),
                item.operation.to_ascii_lowercase()
            )
        });

    let body = serde_json::json!({
        "terminal_id": terminal_id,
        "branch_id": branch_id,
        "events": [{
            "event_type": shift_event_type(item, payload),
            "shift_id": shift_id,
            "idempotency_key": idempotency_key,
            "data": payload,
        }],
    });

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/shifts/sync".to_string(),
        method: Method::POST,
        body: Some(body.to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

/// Resolves the order reference a loyalty request should carry. The admin
/// server re-keys orders on sync ingest (server `orders.id` != POS-local id)
/// and resolves client-sent ids via `orders.id` then `orders.client_order_id`.
/// The order sync sends the local row's `client_request_id` as
/// `client_order_id` when present and the local id otherwise (see
/// `prepare_order_request`), so mirroring that pick is what keeps loyalty
/// ledger rows linked to their order. Lookup failures degrade to the payload
/// id unchanged — the admin route then stores an unlinked ledger row rather
/// than rejecting the award.
fn resolve_loyalty_order_reference(conn: &Connection, payload: &Value) -> Option<String> {
    let local_order_id = payload
        .get("order_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?;

    let client_request_id = conn
        .query_row(
            "SELECT client_request_id FROM orders WHERE id = ?1 LIMIT 1",
            params![local_order_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .unwrap_or_else(|error| {
            warn!(
                order_id = %local_order_id,
                "Loyalty order reference lookup failed; sending local order id: {error}"
            );
            None
        })
        .flatten();

    Some(
        client_request_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| local_order_id.to_string()),
    )
}

/// Wave 5 Session 6: loyalty dispatcher. The admin loyalty API exposes two
/// distinct endpoints (`/api/pos/loyalty/earn` and `/api/pos/loyalty/redeem`)
/// with narrow payload shapes — a raw pass-through of the producer payload
/// would hit neither. This function mirrors the legacy `sync_loyalty_transaction`
/// at `sync.rs:13015`: inspects `transaction_type`, selects the
/// endpoint, and reshapes the body (extracts the fields admin expects;
/// flips `points` sign for redeem because the local row stores the redemption
/// as a negative delta). On top of the legacy shape it swaps the POS-local
/// `order_id` for the server-resolvable reference via
/// `resolve_loyalty_order_reference`.
fn prepare_loyalty_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let order_id = resolve_loyalty_order_reference(conn, payload);
    let tx_type = payload
        .get("transaction_type")
        .and_then(Value::as_str)
        .unwrap_or("earn");

    let endpoint = match tx_type {
        "earn" => "/api/pos/loyalty/earn",
        "redeem" => "/api/pos/loyalty/redeem",
        other => {
            return Ok(RequestPreparation::Failed {
                reason: format!("Unknown loyalty transaction type: {other}"),
            });
        }
    };

    let body = match tx_type {
        "earn" => {
            // Wave 4d: prefer integer `amount_cents`; fall back to legacy
            // float `amount` for any pre-cutover payload still in-flight.
            let amount_cents = payload
                .get("amount_cents")
                .and_then(Value::as_i64)
                .or_else(|| {
                    payload
                        .get("amount")
                        .and_then(Value::as_f64)
                        .map(|v| Cents::round_half_even(v).as_i64())
                })
                .unwrap_or(0);
            serde_json::json!({
                "customer_id": payload.get("customer_id").and_then(Value::as_str).unwrap_or_default(),
                "order_id": order_id,
                "amount_cents": amount_cents,
                "description": payload.get("description").and_then(Value::as_str),
                // Replay-safe fallback for order-less awards. The admin route
                // prefers its per-order key when order_id is present, so this
                // only anchors the rare order-less case to the local row.
                "idempotency_key": format!("loyalty:{}", item.record_id),
            })
        }
        "redeem" => {
            // Local row stores redemption as negative points; admin expects
            // positive. Take absolute value so server-side validation holds.
            let points = payload
                .get("points")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .abs();
            serde_json::json!({
                "customer_id": payload.get("customer_id").and_then(Value::as_str).unwrap_or_default(),
                "points": points,
                "order_id": order_id,
                "description": payload.get("description").and_then(Value::as_str),
                // Replay-safe fallback for order-less redemptions (see earn).
                "idempotency_key": format!("loyalty:{}", item.record_id),
            })
        }
        _ => unreachable!("tx_type validated above"),
    };

    // record_id is in scope if the admin ever needs to log which local
    // loyalty_transactions row this came from; the body itself does not
    // carry it because the admin dedup is on (customer_id, order_id).
    let _ = item.record_id.as_str();

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: endpoint.to_string(),
        method: Method::POST,
        body: Some(body.to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn prepare_customer_address_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let Some(customer_id) = extract_customer_id_from_sync_payload(item) else {
        return Ok(RequestPreparation::Failed {
            reason: "Customer address sync payload is missing customer_id".to_string(),
        });
    };

    let should_create = item.operation == "INSERT"
        || (item.operation == "UPDATE" && is_local_placeholder_id(item.record_id.as_str()));
    let method = if item.operation == "DELETE" && !should_create {
        Method::DELETE
    } else if should_create {
        Method::POST
    } else {
        Method::PATCH
    };
    let endpoint = if should_create {
        format!("/api/pos/customers/{customer_id}/addresses")
    } else {
        format!(
            "/api/pos/customers/{customer_id}/addresses/{}",
            item.record_id
        )
    };

    let body = if method == Method::DELETE {
        None
    } else {
        let mut request_payload = if should_create {
            merge_customer_address_payload_for_recreate(
                conn,
                customer_id.as_str(),
                item.record_id.as_str(),
                payload,
            )
        } else {
            merge_customer_address_payload_from_cache(
                conn,
                customer_id.as_str(),
                item.record_id.as_str(),
                payload,
            )
        };

        if should_create && !has_customer_address_street(&request_payload) {
            return Ok(RequestPreparation::Failed {
                reason: "Customer address recreate is missing street_address details".to_string(),
            });
        }

        if let Some(object) = request_payload.as_object_mut() {
            object.insert(
                "customer_id".to_string(),
                Value::String(customer_id.clone()),
            );
            if should_create {
                object.remove("id");
                object.remove("addressId");
                object.remove("version");
                object.remove("expected_version");
            }
        }

        Some(request_payload.to_string())
    };

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint,
        method,
        body,
        terminal_id: terminal_id.to_string(),
    }))
}

fn is_status_only_order_update_payload(payload: &Value) -> bool {
    let Some(object) = payload.as_object() else {
        return false;
    };

    if object.is_empty() {
        return false;
    }

    object.keys().all(|key| {
        matches!(
            key.as_str(),
            "orderId"
                | "order_id"
                | "id"
                | "status"
                | "estimatedTime"
                | "estimated_time"
                | "cancellationReason"
                | "cancellation_reason"
                | "cancelledAt"
                | "cancelled_at"
                | "remoteOrderId"
                | "remote_order_id"
                | "canonicalOrderId"
                | "canonical_order_id"
                | "supabase_id"
                | "syncRecoveryReason"
        )
    })
}

fn superseded_synced_order_status_update_reason(
    conn: &Connection,
    record_id: &str,
    operation: &str,
    payload: &Value,
) -> Result<Option<String>, String> {
    if operation != "UPDATE" || !is_status_only_order_update_payload(payload) {
        return Ok(None);
    }

    let Some((queued_status, local_status)) =
        superseding_synced_local_order_statuses(conn, record_id, operation, payload)?
    else {
        return Ok(None);
    };

    Ok(Some(format!(
        "{SUPERSEDED_ORDER_UPDATE_REASON}: queued {queued_status}, local {local_status}"
    )))
}

fn superseding_synced_local_order_statuses(
    conn: &Connection,
    record_id: &str,
    operation: &str,
    payload: &Value,
) -> Result<Option<(String, String)>, String> {
    if operation != "UPDATE" {
        return Ok(None);
    }

    let Some(queued_status) = string_field(payload, &["status"])
        .map(|status| normalize_status_for_storage(&status))
        .filter(|status| !status.is_empty())
    else {
        return Ok(None);
    };

    let local_row: Option<(String, String)> = conn
        .query_row(
            "SELECT COALESCE(status, ''), COALESCE(sync_status, '')
             FROM orders
             WHERE id = ?1",
            params![record_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("sync_queue superseded order update lookup: {e}"))?;

    let Some((local_status_raw, local_sync_status_raw)) = local_row else {
        return Ok(None);
    };

    let local_status = normalize_status_for_storage(&local_status_raw);
    if local_status.is_empty() || local_status == queued_status {
        return Ok(None);
    }

    let local_sync_status = local_sync_status_raw.trim().to_ascii_lowercase();
    if !matches!(local_sync_status.as_str(), "synced" | "applied") {
        return Ok(None);
    }

    if !can_transition_locally(&queued_status, &local_status) {
        return Ok(None);
    }

    Ok(Some((queued_status, local_status)))
}

fn next_queued_cancellation_status(
    conn: &Connection,
    item: &SyncQueueItem,
    queued_status: &str,
) -> Result<Option<String>, String> {
    let generic_owner = semantic_generic_nonfinancial_owner_predicate("parity_sync_queue");
    let sql = format!(
        "SELECT data
         FROM parity_sync_queue
         WHERE table_name = 'orders'
           AND record_id = ?1
           AND operation = 'UPDATE'
           AND status IN ('pending', 'processing')
           AND {generic_owner}
           AND (
                created_at > ?2
                OR (created_at = ?2 AND id > ?3)
           )
         ORDER BY created_at ASC, id ASC"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("sync_queue newer order cancellation prepare: {e}"))?;
    let rows = stmt
        .query_map(
            params![
                item.record_id.as_str(),
                item.created_at.as_str(),
                item.id.as_str()
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("sync_queue newer order cancellation query: {e}"))?;

    for row in rows {
        let data = row.map_err(|e| format!("sync_queue newer order cancellation row: {e}"))?;
        let Ok(payload) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        let Some(status) = string_field(&payload, &["status"])
            .map(|status| normalize_status_for_storage(&status))
            .filter(|status| status == "cancelled" && status != queued_status)
        else {
            continue;
        };
        // Cancellation is forward-reachable from every active status accepted
        // here. Do not collapse reactivation/reset-to-pending rows: those carry
        // distinct remote side effects and must replay in FIFO order.
        if can_transition_locally(queued_status, &status) {
            return Ok(Some(status));
        }
    }

    Ok(None)
}

fn prepare_order_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    if item.operation == "INSERT" {
        let body = match build_order_insert_body(conn, item.record_id.as_str(), payload) {
            Ok(body) => body,
            Err(reason) => return Ok(RequestPreparation::Failed { reason }),
        };

        return Ok(RequestPreparation::Ready(RequestSpec {
            endpoint: "/api/pos/orders".to_string(),
            method: Method::POST,
            body: Some(body.to_string()),
            terminal_id: terminal_id.to_string(),
        }));
    }

    let local_order_remote_id: Option<Option<String>> = conn
        .query_row(
            "SELECT NULLIF(TRIM(COALESCE(supabase_id, '')), '')
             FROM orders
             WHERE id = ?1",
            params![item.record_id.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("sync_queue prepare_order_request remote id: {e}"))?;
    let local_order_missing = local_order_remote_id.is_none();
    let local_remote_id = local_order_remote_id.flatten();
    let remote_id = local_remote_id.or_else(|| {
        string_field(
            payload,
            &[
                "remote_order_id",
                "remoteOrderId",
                "canonical_order_id",
                "canonicalOrderId",
                "supabase_id",
            ],
        )
    });

    let Some(remote_id) = remote_id else {
        if local_order_missing {
            return Ok(RequestPreparation::Failed {
                reason: STALE_ORDER_UPDATE_PARENT_WAIT_REASON.to_string(),
            });
        }
        return Ok(RequestPreparation::Deferred {
            reason: "Waiting for parent order sync".to_string(),
        });
    };

    if let Some(reason) = superseded_synced_order_status_update_reason(
        conn,
        item.record_id.as_str(),
        &item.operation,
        payload,
    )? {
        return Ok(RequestPreparation::Consumed { reason });
    }

    fn payload_has_any(payload: &Value, keys: &[&str]) -> bool {
        keys.iter().any(|key| payload.get(*key).is_some())
    }

    let payload_requests_order_hydration = payload_has_any(
        payload,
        &[
            "items",
            "totalAmount",
            "total_amount",
            "totalAmountCents",
            "total_amount_cents",
            "subtotal",
            "subtotalCents",
            "subtotal_cents",
            "discountAmount",
            "discount_amount",
            "discountAmountCents",
            "discount_amount_cents",
            "discountPercentage",
            "discount_percentage",
            "taxAmount",
            "tax_amount",
            "taxAmountCents",
            "tax_amount_cents",
            "deliveryFee",
            "delivery_fee",
            "deliveryFeeCents",
            "delivery_fee_cents",
            "tipAmount",
            "tip_amount",
            "tipAmountCents",
            "tip_amount_cents",
            "paymentStatus",
            "payment_status",
            "paymentMethod",
            "payment_method",
            "customerId",
            "customer_id",
            "customerName",
            "customer_name",
            "customerPhone",
            "customer_phone",
            "customerEmail",
            "customer_email",
            "deliveryAddress",
            "delivery_address",
            "deliveryAddressId",
            "delivery_address_id",
            "deliveryCity",
            "delivery_city",
            "deliveryPostalCode",
            "delivery_postal_code",
            "deliveryFloor",
            "delivery_floor",
            "deliveryLatitude",
            "delivery_latitude",
            "deliveryLongitude",
            "delivery_longitude",
            "deliveryAddressFingerprint",
            "delivery_address_fingerprint",
            "deliveryZoneId",
            "delivery_zone_id",
            "nameOnRinger",
            "name_on_ringer",
            "tableNumber",
            "table_number",
            "tableId",
            "table_id",
            "tableSessionId",
            "table_session_id",
            "guestCount",
            "guest_count",
        ],
    );

    let local_order_fallback = if payload_requests_order_hydration {
        load_local_order_insert_fallback(conn, item.record_id.as_str())?
    } else {
        None
    };
    let mut sources = Vec::new();
    if let Some(local_order_fallback) = local_order_fallback.as_ref() {
        sources.push(local_order_fallback);
    }
    sources.push(payload);

    let mut status = string_field(payload, &["status"]).unwrap_or_default();
    if status.is_empty() {
        status = sources
            .iter()
            .find_map(|source| string_field(source, &["status"]))
            .unwrap_or_default();
    }
    if status.is_empty() {
        status = conn
            .query_row(
                "SELECT COALESCE(status, '') FROM orders WHERE id = ?1",
                params![item.record_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("sync_queue prepare_order_request status: {e}"))?
            .unwrap_or_default();
    }
    let normalized_status = normalize_status_for_storage(&status);
    if let Some(newer_status) = next_queued_cancellation_status(conn, item, &normalized_status)? {
        status = newer_status;
    }
    if status.trim().is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Order update payload is missing status".to_string(),
        });
    }

    let mut body = Map::new();
    body.insert("id".to_string(), Value::String(remote_id));
    body.insert("status".to_string(), Value::String(status));

    fn copy_payload_field(
        body: &mut Map<String, Value>,
        payload: &Value,
        sources: &[&str],
        target: &str,
        include_null: bool,
    ) {
        for source_key in sources {
            if let Some(value) = payload.get(*source_key) {
                if include_null || !value.is_null() {
                    body.insert(target.to_string(), value.clone());
                }
                return;
            }
        }
    }

    fn copy_source_field(
        body: &mut Map<String, Value>,
        sources: &[&Value],
        source_keys: &[&str],
        target: &str,
        include_null: bool,
    ) {
        for source in sources {
            for source_key in source_keys {
                if let Some(value) = source.get(*source_key) {
                    if include_null || !value.is_null() {
                        body.insert(target.to_string(), value.clone());
                    }
                    return;
                }
            }
        }
    }

    fn copy_financial_source_field(
        body: &mut Map<String, Value>,
        sources: &[&Value],
        source_keys: &[&str],
        target: &str,
    ) {
        let mut zero_value: Option<Value> = None;
        for source in sources {
            for source_key in source_keys {
                let Some(value) = source.get(*source_key) else {
                    continue;
                };
                if value.is_null() {
                    continue;
                }
                let is_zero = value.as_f64().map(|number| number == 0.0).unwrap_or(false);
                if is_zero {
                    zero_value.get_or_insert_with(|| value.clone());
                    continue;
                }
                body.insert(target.to_string(), value.clone());
                return;
            }
        }
        if let Some(value) = zero_value {
            body.insert(target.to_string(), value);
        }
    }

    copy_source_field(
        &mut body,
        &sources,
        &["estimatedTime", "estimated_time"],
        "estimated_time",
        false,
    );
    copy_source_field(
        &mut body,
        &sources,
        &[
            "notes",
            "reason",
            "orderNotes",
            "order_notes",
            "special_instructions",
        ],
        "notes",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["orderType", "order_type"],
        "order_type",
        false,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["customerId", "customer_id"],
        "customer_id",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["customerName", "customer_name"],
        "customer_name",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["customerPhone", "customer_phone"],
        "customer_phone",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["customerEmail", "customer_email"],
        "customer_email",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["deliveryAddress", "delivery_address"],
        "delivery_address",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["deliveryAddressId", "delivery_address_id"],
        "delivery_address_id",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["deliveryCity", "delivery_city"],
        "delivery_city",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["deliveryPostalCode", "delivery_postal_code"],
        "delivery_postal_code",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["deliveryFloor", "delivery_floor"],
        "delivery_floor",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["deliveryNotes", "delivery_notes"],
        "delivery_notes",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["deliveryLatitude", "delivery_latitude"],
        "delivery_latitude",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["deliveryLongitude", "delivery_longitude"],
        "delivery_longitude",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["deliveryAddressFingerprint", "delivery_address_fingerprint"],
        "delivery_address_fingerprint",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["deliveryZoneId", "delivery_zone_id"],
        "delivery_zone_id",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["nameOnRinger", "name_on_ringer"],
        "name_on_ringer",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["tableNumber", "table_number"],
        "table_number",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["tableId", "table_id"],
        "table_id",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["tableSessionId", "table_session_id"],
        "table_session_id",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["guestCount", "guest_count"],
        "guest_count",
        true,
    );
    copy_source_field(
        &mut body,
        &sources,
        &["fiscalReceiptNumber", "fiscal_receipt_number"],
        "fiscal_receipt_number",
        false,
    );
    // Driver ids stored in local delivery rows are staff ids bound to the
    // driver's local shift lifecycle. Replaying a non-null id on a status
    // PATCH after checkout can make admin reject the whole order update as
    // "Invalid driver". RESET is different: explicit nulls are safe and
    // required so the remote order is unassigned too.
    let is_reset_to_active = payload
        .get("resetToActive")
        .or_else(|| payload.get("reset_to_active"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_reset_to_active {
        body.insert("driver_id".to_string(), Value::Null);
        body.insert("driver_name".to_string(), Value::Null);
    } else {
        copy_payload_field(
            &mut body,
            payload,
            &["driverName", "driver_name"],
            "driver_name",
            false,
        );
    }
    for (camel, snake) in [
        ("totalAmount", "total_amount"),
        ("subtotal", "subtotal"),
        ("discountAmount", "discount_amount"),
        ("discountPercentage", "discount_percentage"),
        ("taxAmount", "tax_amount"),
        ("deliveryFee", "delivery_fee"),
        ("tipAmount", "tip_amount"),
    ] {
        copy_financial_source_field(&mut body, &sources, &[camel, snake], snake);
    }
    copy_payload_field(
        &mut body,
        payload,
        &["paymentStatus", "payment_status"],
        "payment_status",
        false,
    );
    if !body.contains_key("payment_status") {
        copy_source_field(
            &mut body,
            &sources,
            &["paymentStatus", "payment_status"],
            "payment_status",
            false,
        );
    }
    for source in &sources {
        if let Some(value) = source
            .get("paymentMethod")
            .or_else(|| source.get("payment_method"))
        {
            if let Some(payment_method) =
                normalize_payment_method_for_update(string_from_value(value).as_deref())
            {
                body.insert("payment_method".to_string(), Value::String(payment_method));
            }
            break;
        }
    }
    for (camel, snake) in [
        ("totalAmountCents", "total_amount_cents"),
        ("subtotalCents", "subtotal_cents"),
        ("discountAmountCents", "discount_amount_cents"),
        ("taxAmountCents", "tax_amount_cents"),
        ("deliveryFeeCents", "delivery_fee_cents"),
        ("tipAmountCents", "tip_amount_cents"),
        ("couponDiscountAmountCents", "coupon_discount_amount_cents"),
        ("manualDiscountValueCents", "manual_discount_value_cents"),
    ] {
        copy_financial_source_field(&mut body, &sources, &[camel, snake], snake);
    }
    if let Some(items) = payload.get("items") {
        if !items.is_null() {
            let order_discount_amount = body
                .get("discount_amount")
                .and_then(number_from_value)
                .or_else(|| {
                    body.get("discount_amount_cents")
                        .and_then(number_from_value)
                        .map(|cents| cents / 100.0)
                });
            let order_subtotal = body
                .get("subtotal")
                .and_then(number_from_value)
                .or_else(|| {
                    body.get("subtotal_cents")
                        .and_then(number_from_value)
                        .map(|cents| cents / 100.0)
                });
            if let Some(normalized_items) = normalize_order_update_items_for_request(
                items,
                order_discount_amount,
                order_subtotal,
            ) {
                body.insert("items".to_string(), normalized_items);
            }
        }
    }
    copy_source_field(
        &mut body,
        &sources,
        &["orderNotes", "order_notes", "special_instructions"],
        "order_notes",
        true,
    );

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/orders".to_string(),
        method: Method::PATCH,
        body: Some(Value::Object(body).to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn prepare_payment_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let local_order_id = string_field(payload, &["orderId", "order_id"]).unwrap_or_default();
    if local_order_id.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Payment sync payload is missing orderId".to_string(),
        });
    }

    let remote_order_id: Option<String> = conn
        .query_row(
            "SELECT NULLIF(TRIM(COALESCE(supabase_id, '')), '')
             FROM orders
             WHERE id = ?1 OR supabase_id = ?1
             LIMIT 1",
            params![local_order_id.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("sync_queue prepare_payment_request remote order: {e}"))?
        .flatten();

    let Some(remote_order_id) = remote_order_id else {
        let _ = conn.execute(
            "UPDATE order_payments
             SET sync_state = 'waiting_parent',
                 sync_status = 'pending',
                 updated_at = datetime('now')
             WHERE id = ?1",
            params![item.record_id.as_str()],
        );
        return Ok(RequestPreparation::Deferred {
            reason: "Waiting for parent order sync".to_string(),
        });
    };

    if sync::has_outstanding_local_order_queue(conn, local_order_id.as_str()) {
        let _ = conn.execute(
            "UPDATE order_payments
             SET sync_state = 'waiting_parent',
                 sync_status = 'pending',
                 sync_last_error = 'Order update not yet synced',
                 updated_at = datetime('now')
             WHERE id = ?1",
            params![item.record_id.as_str()],
        );
        return Ok(RequestPreparation::Deferred {
            reason: "Waiting for parent order update sync".to_string(),
        });
    }

    let amount = payload
        .get("amount")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    if amount <= 0.0 {
        return Ok(RequestPreparation::Failed {
            reason: "Payment sync payload has invalid amount".to_string(),
        });
    }
    let payment_method = string_field(payload, &["method", "paymentMethod", "payment_method"])
        .unwrap_or_else(|| "other".to_string());
    let canonical_idempotency_key = format!("payment:{}", item.record_id);

    // W4d-iv additive emission: payment-sync POST body now ships `amount_cents`
    // alongside the legacy `amount` float. tip_amount gets the same treatment
    // when present.
    let mut body = serde_json::json!({
        "order_id": remote_order_id,
        "paymentId": item.record_id,
        "payment_id": item.record_id,
        "amount": amount,
        "amount_cents": Cents::round_half_even(amount).as_i64(),
        "payment_method": payment_method,
        "idempotency_key": canonical_idempotency_key.clone(),
        "metadata": {
            "terminal_id": terminal_id,
            "local_order_id": local_order_id,
            "local_payment_id": item.record_id,
            "canonical_idempotency_key": canonical_idempotency_key.clone(),
            "payment_origin": string_field(payload, &["paymentOrigin", "payment_origin"]),
        }
    });
    if let Some(value) = string_field(
        payload,
        &[
            "remote_payment_id",
            "remotePaymentId",
            "canonical_payment_id",
            "canonicalPaymentId",
        ],
    ) {
        body["remote_payment_id"] = Value::String(value.clone());
        body["canonical_payment_id"] = Value::String(value.clone());
        body["metadata"]["remote_payment_id"] = Value::String(value.clone());
        body["metadata"]["canonical_payment_id"] = Value::String(value);
    }
    if let Some(value) = string_field(payload, &["idempotency_key", "idempotencyKey"]) {
        if value != canonical_idempotency_key {
            body["metadata"]["legacy_idempotency_key"] = Value::String(value);
        }
    }
    if let Some(value) = string_field(payload, &["transactionRef", "transaction_ref"]) {
        body["external_transaction_id"] = Value::String(value);
        body["metadata"]["transaction_ref"] = body["external_transaction_id"].clone();
    }
    if let Some(value) = payload
        .get("tipAmount")
        .or_else(|| payload.get("tip_amount"))
        .and_then(Value::as_f64)
    {
        body["tip_amount"] = Value::from(value);
        body["tip_amount_cents"] = Value::from(Cents::round_half_even(value).as_i64());
    }
    if let Some(value) = string_field(payload, &["table_session_id", "tableSessionId"]) {
        if Uuid::parse_str(value.as_str()).is_ok() {
            body["table_session_id"] = Value::String(value);
        } else {
            body["metadata"]["local_table_session_id"] = Value::String(value);
        }
    }
    if let Some(value) = payload
        .get("seat_number")
        .or_else(|| payload.get("seatNumber"))
        .and_then(Value::as_i64)
    {
        body["seat_number"] = Value::from(value);
    }
    if let Some(value) = string_field(payload, &["currency"]) {
        body["currency"] = Value::String(value);
    }
    if let Some(items) = payload.get("items") {
        if items
            .as_array()
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
        {
            body["items"] = items.clone();
        }
    }
    if let Some(settlement_adjustments) = payload
        .get("settlement_adjustments")
        .and_then(Value::as_array)
        .filter(|rows| !rows.is_empty())
    {
        let settlement_refund_total = settlement_adjustments
            .iter()
            .filter_map(|row| {
                row.get("amount_cents")
                    .and_then(Value::as_i64)
                    .map(|cents| Cents::new(cents).to_f64_dp2())
                    .or_else(|| row.get("amount").and_then(Value::as_f64))
            })
            .sum::<f64>();
        body["settlement_adjustments"] = Value::Array(settlement_adjustments.clone());
        body["metadata"]["settlement_adjustments"] = Value::Array(settlement_adjustments.clone());
        body["metadata"]["settlement_refund_total"] =
            Value::from(Cents::round_half_even(settlement_refund_total).to_f64_dp2());
        body["metadata"]["settlement_net_payment_amount"] =
            Value::from(Cents::round_half_even(amount - settlement_refund_total).to_f64_dp2());
    }

    let _ = conn.execute(
        "UPDATE order_payments
         SET sync_state = 'syncing',
             updated_at = datetime('now')
         WHERE id = ?1",
        params![item.record_id.as_str()],
    );

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/payments".to_string(),
        method: Method::POST,
        body: Some(body.to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn prepare_adjustment_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let payment_id = string_field(payload, &["paymentId", "payment_id"]).unwrap_or_default();
    if payment_id.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Adjustment sync payload is missing paymentId".to_string(),
        });
    }

    let payment_context: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT COALESCE(sync_state, ''), remote_payment_id, order_id
             FROM order_payments
             WHERE id = ?1",
            params![payment_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("sync_queue prepare_adjustment_request payment context: {e}"))?;

    let Some((payment_sync_state, remote_payment_id, order_id)) = payment_context else {
        return Ok(RequestPreparation::Failed {
            reason: "Adjustment parent payment was not found locally".to_string(),
        });
    };

    let canonical_payment_id = remote_payment_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    if payment_sync_state != "applied" || canonical_payment_id.is_none() {
        let _ = conn.execute(
            "UPDATE payment_adjustments
             SET sync_state = 'waiting_parent',
                 sync_last_error = NULL,
                 updated_at = datetime('now')
             WHERE id = ?1",
            params![item.record_id.as_str()],
        );
        return Ok(RequestPreparation::Deferred {
            reason: "Waiting for parent payment sync".to_string(),
        });
    }

    let (_, branch_id, _) = resolve_runtime_context(conn, payload);
    let adjustment_type =
        string_field(payload, &["adjustmentType", "adjustment_type"]).unwrap_or_default();
    let order_id_for_sync =
        string_field(payload, &["orderId", "order_id"]).or_else(|| order_id.clone());
    let client_order_id_for_sync =
        string_field(payload, &["clientOrderId", "client_order_id"]).or_else(|| order_id.clone());
    let idempotency_key = format!("adjustment:{}", item.record_id);
    let body = sync::build_adjustment_sync_body(
        item.record_id.as_str(),
        payment_id.as_str(),
        order_id_for_sync.as_deref(),
        client_order_id_for_sync.as_deref(),
        if adjustment_type.is_empty() {
            None
        } else {
            Some(adjustment_type.as_str())
        },
        payload.get("amount").and_then(Value::as_f64),
        string_field(payload, &["reason"]).as_deref(),
        string_field(payload, &["staffId", "staff_id"]).as_deref(),
        string_field(payload, &["staffShiftId", "staff_shift_id"]).as_deref(),
        terminal_id,
        branch_id.as_str(),
        idempotency_key.as_str(),
        string_field(payload, &["refundMethod", "refund_method"]).as_deref(),
        string_field(payload, &["cashHandler", "cash_handler"]).as_deref(),
        string_field(payload, &["adjustmentContext", "adjustment_context"]).as_deref(),
        canonical_payment_id.as_deref(),
        canonical_payment_id.as_deref(),
    );

    let _ = conn.execute(
        "UPDATE payment_adjustments
         SET sync_state = 'syncing',
             updated_at = datetime('now')
         WHERE id = ?1",
        params![item.record_id.as_str()],
    );

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/payments/adjustments/sync".to_string(),
        method: Method::POST,
        body: Some(body.to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn financial_entity_type(table_name: &str) -> &str {
    match table_name {
        "driver_earnings" => "driver_earning",
        "shift_expenses" => "shift_expense",
        "staff_payments" => "staff_payment",
        other => other,
    }
}

fn financial_operation(operation: &str) -> &str {
    match operation {
        "DELETE" => "delete",
        _ => "create",
    }
}

fn prepare_financial_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let (_, branch_id, _) = resolve_runtime_context(conn, payload);
    // Wave 5 C17: the idempotency key is anchored on the entity row's own
    // `idempotency_key` column (populated by migration v47+ / trigger v49)
    // instead of the volatile `parity_sync_queue.id`. That way, a re-enqueue
    // after a failed retry produces the SAME key the server already saw,
    // and its dedup can recognise the two submissions as one logical op.
    // The previous key — `parity:{item.id}` — was stamped from the queue
    // row's UUID which rotates on every re-enqueue, defeating exactly-once.
    let idempotency_key =
        crate::idempotency::make_entity_key(conn, item.table_name.as_str(), &item.record_id);
    let body = serde_json::json!({
        "terminal_id": terminal_id,
        "branch_id": branch_id,
        "items": [{
            "entity_type": financial_entity_type(item.table_name.as_str()),
            "entity_id": item.record_id,
            "operation": financial_operation(item.operation.as_str()),
            "idempotency_key": idempotency_key,
            "payload": payload,
        }],
    });

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/financial/sync".to_string(),
        method: Method::POST,
        body: Some(body.to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn prepare_housekeeping_request(
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let endpoint = if payload.get("status").is_some() {
        "/api/pos/housekeeping".to_string()
    } else {
        format!("/api/pos/housekeeping/{}", item.record_id)
    };

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint,
        method: Method::PATCH,
        body: Some(item.data.clone()),
        terminal_id: terminal_id.to_string(),
    }))
}

/// Build the replay request for an offline room check-in
/// (hotel-rooms-full-pass task 10.2).
///
/// Queue rows come from `offline_room_checkin` (entity `room_checkins`,
/// `record_id` = `client_request_id`, snake_case capture payload). The
/// server contract is `POST /api/pos/rooms/{roomId}/checkin` with a
/// camelCase Zod body; `clientRequestId` is the exactly-once replay key,
/// so a lost-ack repeat comes back as `200 idempotentReplay` and both 2xx
/// shapes complete the item. A `403 MODULE_REQUIRED` parks the row via
/// `mark_module_required` (Req 12.2) and a genuine 409 (e.g.
/// `ROOM_HAS_ACTIVE_FOLIO`) flows to the existing conflict-review
/// machinery for staff review — all downstream of this preparation.
fn prepare_room_checkin_request(
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let Some(room_id) = string_field(payload, &["room_id", "roomId"]) else {
        return Ok(RequestPreparation::Failed {
            reason: "Room check-in sync request is missing room_id".to_string(),
        });
    };
    let Some(guest_name) = string_field(payload, &["guest_name", "guestName"]) else {
        return Ok(RequestPreparation::Failed {
            reason: "Room check-in sync request is missing guest_name".to_string(),
        });
    };
    let Some(check_in_date) = string_field(payload, &["check_in_date", "checkInDate"]) else {
        return Ok(RequestPreparation::Failed {
            reason: "Room check-in sync request is missing check_in_date".to_string(),
        });
    };
    let Some(check_out_date) = string_field(payload, &["check_out_date", "checkOutDate"]) else {
        return Ok(RequestPreparation::Failed {
            reason: "Room check-in sync request is missing check_out_date".to_string(),
        });
    };
    // The replay key is persisted inside the queued payload at capture time;
    // the queue row's record_id mirrors it, so a legacy row without the
    // payload copy still replays exactly-once.
    let client_request_id = string_field(payload, &["client_request_id", "clientRequestId"])
        .unwrap_or_else(|| item.record_id.trim().to_string());
    if client_request_id.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Room check-in sync request is missing client_request_id".to_string(),
        });
    }

    let mut body = Map::new();
    body.insert("guestName".to_string(), Value::String(guest_name));
    body.insert("checkInDate".to_string(), Value::String(check_in_date));
    body.insert("checkOutDate".to_string(), Value::String(check_out_date));
    body.insert(
        "clientRequestId".to_string(),
        Value::String(client_request_id),
    );
    // Optional capture fields are queued as explicit nulls; the server
    // schema accepts nullable+optional, so only concrete values are sent.
    if let Some(guest_email) = string_field(payload, &["guest_email", "guestEmail"]) {
        body.insert("guestEmail".to_string(), Value::String(guest_email));
    }
    if let Some(guest_phone) = string_field(payload, &["guest_phone", "guestPhone"]) {
        body.insert("guestPhone".to_string(), Value::String(guest_phone));
    }
    if let Some(party_size) = payload
        .get("party_size")
        .or_else(|| payload.get("partySize"))
        .and_then(Value::as_i64)
    {
        body.insert("partySize".to_string(), Value::from(party_size));
    }
    if let Some(notes) = string_field(payload, &["notes"]) {
        body.insert("notes".to_string(), Value::String(notes));
    }

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: format!("/api/pos/rooms/{room_id}/checkin"),
        method: Method::POST,
        body: Some(Value::Object(body).to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

/// Build the replay request for an offline goods receipt
/// (procurement-loop Task 10.3).
///
/// Queue rows come from `offline_po_receipt` (entity `po_receipts`,
/// `record_id` = the capture-time `idempotency_key`, snake_case envelope
/// with the receipt lines kept in the shared camelCase
/// `ReceiptCommitRequest` line shape). The server contract is
/// `POST /api/pos/purchase-orders/{purchaseOrderId}/receipts` with a
/// camelCase Zod body; the capture-time key is the exactly-once replay
/// key and is sent BOTH as the mandatory `Idempotency-Key` header (via
/// `replay_idempotency_header`) and as the body `idempotencyKey`
/// fallback, so a lost-ack repeat comes back as `200 wasReplay` and
/// completes the item [R11.4]. A `403 MODULE_REQUIRED` parks the row via
/// `mark_module_required` (queue retained) [R11.6] and a genuine
/// `409 PO_STATE_CONFLICT` flows to the manual-strategy conflict-review
/// machinery so staff resolve it — never a silent drop [R11.7].
fn prepare_po_receipt_request(
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let Some(purchase_order_id) = string_field(payload, &["purchase_order_id", "purchaseOrderId"])
    else {
        return Ok(RequestPreparation::Failed {
            reason: "PO receipt sync request is missing purchase_order_id".to_string(),
        });
    };
    // The PO id is interpolated into an admin API path; capture stores the
    // server-issued UUID, so anything else is a corrupted row.
    if !is_uuid(&purchase_order_id) {
        return Ok(RequestPreparation::Failed {
            reason: "PO receipt sync request has a non-UUID purchase_order_id".to_string(),
        });
    }
    let Some(staff_id) = string_field(payload, &["staff_id", "staffId"]) else {
        return Ok(RequestPreparation::Failed {
            reason: "PO receipt sync request is missing staff_id".to_string(),
        });
    };
    // Original capture time must survive replay [R11.3]; a row without it
    // cannot honor the contract and dead-letters with a clear reason.
    let Some(recorded_at) = string_field(payload, &["recorded_at", "recordedAt"]) else {
        return Ok(RequestPreparation::Failed {
            reason: "PO receipt sync request is missing recorded_at".to_string(),
        });
    };
    let lines = payload
        .get("lines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if lines.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "PO receipt sync request has no receipt lines".to_string(),
        });
    }
    // The replay key is persisted inside the queued payload at capture time;
    // the queue row's record_id mirrors it, so either source replays
    // exactly-once with the SAME capture-time key (never a fresh one).
    let idempotency_key = string_field(payload, &["idempotency_key", "idempotencyKey"])
        .unwrap_or_else(|| item.record_id.trim().to_string());
    if idempotency_key.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "PO receipt sync request is missing idempotency_key".to_string(),
        });
    }

    let mut body = Map::new();
    body.insert("idempotencyKey".to_string(), Value::String(idempotency_key));
    body.insert("staffId".to_string(), Value::String(staff_id));
    body.insert(
        "source".to_string(),
        Value::String(
            string_field(payload, &["source"]).unwrap_or_else(|| "pos_desktop".to_string()),
        ),
    );
    body.insert("recordedAt".to_string(), Value::String(recorded_at));
    body.insert(
        "kind".to_string(),
        Value::String(string_field(payload, &["kind"]).unwrap_or_else(|| "delivery".to_string())),
    );
    if let Some(notes) = string_field(payload, &["notes"]) {
        body.insert("notes".to_string(), Value::String(notes));
    }
    // Lines are stored at capture in the shared camelCase line shape
    // (purchaseOrderItemId / unplanned / quantityReceived / unitCost /
    // confirmOverReceipt / confirmUnplanned) — pass through untouched.
    body.insert("lines".to_string(), Value::Array(lines));

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: format!("/api/pos/purchase-orders/{purchase_order_id}/receipts"),
        method: Method::POST,
        body: Some(Value::Object(body).to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

/// Capture source kinds the commit route's zod enum accepts. A row carrying
/// anything else was not written by this client and cannot be repaired here.
const CAPTURE_SOURCE_KINDS: [&str; 5] = [
    "connected_scanner",
    "watched_folder",
    "camera",
    "usb_scanner",
    "file_pick",
];

/// Build the replay request for an offline supplier-invoice import commit
/// (invoice-scan-capture Task 11.3, design surface D-Rust5).
///
/// Queue rows come from `offline_supplier_import_commit` (entity
/// `supplier_import_commits`, `record_id` = the capture id, which IS the
/// capture-time idempotency key). The envelope is snake_case, exactly like
/// `po_receipts`, while the three blocks the server reads (`draft`,
/// `capture`, `poLinkage`) are stored in their camelCase wire shape and
/// passed through untouched — the renderer already built them for
/// `POST /api/pos/suppliers/import/commit`, so re-deriving them here could
/// only introduce drift.
///
/// The capture id travels BOTH as the `Idempotency-Key` header (via
/// [`replay_idempotency_header`]) and as `capture.captureId`; the route
/// rejects a request where the two disagree, so this function forces them
/// equal rather than trusting the stored blocks. A lost-ack repeat therefore
/// comes back `200 alreadyCommitted` and completes the item, and the server's
/// commit claim plus the `(organization_id, capture_id)` index guarantee one
/// invoice and one stock effect [R9.5]. `403 MODULE_REQUIRED` parks the row
/// via `mark_module_required` (queue retained) [R11.7].
fn prepare_supplier_import_commit_request(
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    // The draft is the invoice itself. Without it there is nothing to commit
    // and no way to reconstruct one — dead-letter with a reason a person can
    // act on rather than replaying an empty commit.
    let Some(draft) = payload
        .get("draft")
        .filter(|value| value.is_object())
        .cloned()
    else {
        return Ok(RequestPreparation::Failed {
            reason: "Supplier import commit sync request is missing draft".to_string(),
        });
    };

    let Some(capture) = payload.get("capture").and_then(Value::as_object).cloned() else {
        return Ok(RequestPreparation::Failed {
            reason: "Supplier import commit sync request is missing capture".to_string(),
        });
    };
    let mut capture = capture;

    // The replay key is persisted inside the queued payload at capture time;
    // the queue row's record_id mirrors it, so either source replays
    // exactly-once with the SAME capture-time key (never a fresh one).
    let capture_id = string_field(payload, &["capture_id", "captureId"])
        .or_else(|| string_field(payload, &["idempotency_key", "idempotencyKey"]))
        .unwrap_or_else(|| item.record_id.trim().to_string());
    if capture_id.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Supplier import commit sync request is missing capture_id".to_string(),
        });
    }

    // Original capture time must survive replay [R13.1]; a row without it
    // cannot honor the provenance contract.
    let Some(captured_at) = string_field(
        &Value::Object(capture.clone()),
        &["capturedAt", "captured_at"],
    )
    .or_else(|| string_field(payload, &["recorded_at", "recordedAt"])) else {
        return Ok(RequestPreparation::Failed {
            reason: "Supplier import commit sync request is missing captured_at".to_string(),
        });
    };

    let source_kind = string_field(
        &Value::Object(capture.clone()),
        &["sourceKind", "source_kind"],
    )
    .unwrap_or_default();
    if !CAPTURE_SOURCE_KINDS.contains(&source_kind.as_str()) {
        return Ok(RequestPreparation::Failed {
            reason: "Supplier import commit sync request has an unknown source_kind".to_string(),
        });
    }

    // Header and body can never disagree about which capture is being
    // committed — the route 400s on a mismatch, which would dead-letter a
    // perfectly good invoice.
    capture.insert("captureId".to_string(), Value::String(capture_id.clone()));
    capture.insert("capturedAt".to_string(), Value::String(captured_at));
    capture.insert("sourceKind".to_string(), Value::String(source_kind));
    if !capture.contains_key("committedByStaffId") {
        if let Some(staff_id) = string_field(payload, &["staff_id", "staffId"]) {
            capture.insert("committedByStaffId".to_string(), Value::String(staff_id));
        }
    }

    let mut body = Map::new();
    body.insert("draft".to_string(), draft);
    body.insert("capture".to_string(), Value::Object(capture));

    if let Some(linkage) = payload
        .get("po_linkage")
        .or_else(|| payload.get("poLinkage"))
        .and_then(Value::as_object)
    {
        let purchase_order_id = string_field(
            &Value::Object(linkage.clone()),
            &["purchaseOrderId", "purchase_order_id"],
        )
        .unwrap_or_default();
        // The id reaches a `uuid()` zod field and a procurement RPC; anything
        // else is a corrupted row, not a request worth sending.
        if !is_uuid(&purchase_order_id) {
            return Ok(RequestPreparation::Failed {
                reason: "Supplier import commit sync request has a non-UUID purchase_order_id"
                    .to_string(),
            });
        }
        let mode = string_field(&Value::Object(linkage.clone()), &["mode"]).unwrap_or_default();
        if mode != "confirm_existing" && mode != "record_delivery" {
            return Ok(RequestPreparation::Failed {
                reason: "Supplier import commit sync request has an unknown poLinkage mode"
                    .to_string(),
            });
        }
        body.insert("poLinkage".to_string(), Value::Object(linkage.clone()));
    }

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/suppliers/import/commit".to_string(),
        method: Method::POST,
        body: Some(Value::Object(body).to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

/// Entity-keyed replay headers (procurement-loop Task 10.3; extended by
/// invoice-scan-capture Task 11.3).
///
/// `POST /api/pos/purchase-orders/:id/receipts` requires the capture-time
/// idempotency key as the `Idempotency-Key` header (body `idempotencyKey`
/// is the documented fallback, and the prepared body carries it too).
/// `POST /api/pos/suppliers/import/commit` takes the same header, where the
/// key IS the capture id — the route refuses a header that disagrees with
/// `capture.captureId`, and honours a match as transport-level dedupe.
/// The key is read from the queued payload with the queue row's
/// `record_id` as the fallback — the SAME stored key on every retry, so
/// crash-retry duplicates collapse server-side to one effect [R11.4, R9.5].
/// Returns `None` for every other entity, leaving their requests
/// byte-identical to before.
fn replay_idempotency_header(item: &SyncQueueItem) -> Option<(&'static str, String)> {
    if !matches!(
        item.table_name.as_str(),
        "po_receipts" | "supplier_import_commits"
    ) {
        return None;
    }
    let payload = serde_json::from_str::<Value>(&item.data).unwrap_or(Value::Null);
    let key = string_field(
        &payload,
        // `capture_id` is the supplier-import commit's spelling of the same
        // capture-time key; both entities fall back to the record_id mirror.
        &[
            "idempotency_key",
            "idempotencyKey",
            "capture_id",
            "captureId",
        ],
    )
    .unwrap_or_else(|| item.record_id.trim().to_string());
    if key.is_empty() {
        return None;
    }
    Some(("Idempotency-Key", key))
}

/// Renderer-side prefix for table-session ids that have not been assigned a
/// remote Supabase UUID yet. The renderer builds these as
/// `local-table-session:{localOrderId}` (see
/// `TableCheckManagerModal.buildLocalSessionFromOrder`) so the cart can show a
/// table check before the open INSERT has round-tripped.
const LOCAL_TABLE_SESSION_PREFIX: &str = "local-table-session:";

/// Deferral reason used when a table-session UPDATE/DELETE still only carries a
/// local placeholder id and the remote UUID is not yet known locally.
const TABLE_SESSION_REMOTE_ID_WAIT_REASON: &str = "Waiting for remote table session id";

fn is_uuid(value: &str) -> bool {
    Uuid::parse_str(value.trim()).is_ok()
}

/// If `record_id` is a `local-table-session:{localOrderId}` placeholder, return
/// the embedded local order id. Returns `None` for real remote UUIDs (and any
/// other id shape), which are passed through unchanged.
fn local_table_session_order_id(record_id: &str) -> Option<&str> {
    record_id
        .strip_prefix(LOCAL_TABLE_SESSION_PREFIX)
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

/// Read the remote table-session UUID that a prior INSERT-success persisted onto
/// the local order row (see `apply_success` for `restaurant_table_sessions`).
fn lookup_order_table_session_uuid(conn: &Connection, local_order_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT NULLIF(TRIM(COALESCE(table_session_id, '')), '')
         FROM orders
         WHERE id = ?1",
        params![local_order_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
    .filter(|candidate| is_uuid(candidate))
}

/// Resolve the remote Supabase UUID for a local table-session placeholder.
///
/// Preference order (mirrors the suggested fix): the durable
/// `orders.table_session_id` mapping captured at INSERT-success time, then a
/// UUID carried directly in the replay payload as a fallback. Returns `None`
/// when no remote id is known yet so the caller can defer instead of sending an
/// invalid `/api/pos/table-sessions/local-table-session:...` path that admin
/// rejects with HTTP 500 (`invalid input syntax for type uuid`).
fn resolve_remote_table_session_id(
    conn: &Connection,
    local_order_id: &str,
    payload: &Value,
) -> Option<String> {
    if let Some(remote) = lookup_order_table_session_uuid(conn, local_order_id) {
        return Some(remote);
    }

    string_field(
        payload,
        &[
            "remote_session_id",
            "remoteSessionId",
            "table_session_id",
            "tableSessionId",
            "session_id",
            "sessionId",
        ],
    )
    .map(|value| value.trim().to_string())
    .filter(|candidate| is_uuid(candidate))
}

struct ObsoleteTableSessionClose {
    reason: String,
}

fn is_table_session_close_payload(payload: &Value) -> bool {
    string_field(payload, &["action"])
        .map(|action| action.eq_ignore_ascii_case("close"))
        .unwrap_or(false)
}

fn local_order_payment_is_settled(payment_status: &str) -> bool {
    matches!(
        payment_status.trim().to_ascii_lowercase().as_str(),
        "paid" | "completed"
    )
}

fn local_order_lifecycle_is_complete(status: &str) -> bool {
    status.trim().eq_ignore_ascii_case("completed")
}

fn completed_local_payments_cover_order(
    conn: &Connection,
    local_order_id: &str,
) -> Result<bool, String> {
    let order_total: f64 = conn
        .query_row(
            "SELECT COALESCE(total_amount, 0)
             FROM orders
             WHERE id = ?1",
            params![local_order_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("sync_queue completed_local_payments_cover_order total: {e}"))?
        .unwrap_or(0.0);

    if order_total <= 0.0 {
        return Ok(true);
    }

    let paid_total: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0)
             FROM order_payments
             WHERE order_id = ?1
               AND status = 'completed'
               AND (voided_at IS NULL OR TRIM(COALESCE(voided_at, '')) = '')",
            params![local_order_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("sync_queue completed_local_payments_cover_order paid: {e}"))?
        .unwrap_or(0.0);

    Ok(paid_total + 0.005 >= order_total)
}

fn classify_obsolete_table_session_close(
    conn: &Connection,
    local_order_id: &str,
    payload: &Value,
) -> Result<Option<ObsoleteTableSessionClose>, String> {
    if !is_table_session_close_payload(payload) {
        return Ok(None);
    }

    let order = conn
        .query_row(
            "SELECT
                 NULLIF(TRIM(COALESCE(supabase_id, '')), ''),
                 COALESCE(status, ''),
                 COALESCE(payment_status, ''),
                 NULLIF(TRIM(COALESCE(table_id, '')), ''),
                 NULLIF(TRIM(COALESCE(table_number, '')), ''),
                 guest_count,
                 NULLIF(TRIM(COALESCE(branch_id, '')), ''),
                 NULLIF(TRIM(COALESCE(client_request_id, '')), '')
             FROM orders
             WHERE id = ?1",
            params![local_order_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("sync_queue table-session close reconciliation order: {e}"))?;

    let Some((
        Some(remote_order_id),
        status,
        payment_status,
        _table_id,
        _table_number,
        _guest_count,
        _branch_id,
        _client_request_id,
    )) = order
    else {
        return Ok(None);
    };

    if !is_uuid(&remote_order_id)
        || !local_order_lifecycle_is_complete(&status)
        || !local_order_payment_is_settled(&payment_status)
        || !completed_local_payments_cover_order(conn, local_order_id)?
    {
        return Ok(None);
    }

    Ok(Some(ObsoleteTableSessionClose {
        reason: format!(
            "Obsolete local table-session close consumed; order {local_order_id} is completed, paid, and synced as {remote_order_id}"
        ),
    }))
}

/// Build the request for a `restaurant_table_sessions` row.
///
/// INSERT rows POST to the collection endpoint unchanged. UPDATE/DELETE rows are
/// keyed by the renderer's session id, which is the remote UUID once the open
/// INSERT has synced but a `local-table-session:{localOrderId}` placeholder
/// while it is still pending. For the placeholder we resolve the remote UUID
/// from the INSERT-success mapping; if it is not available yet we defer rather
/// than send the invalid local path to admin. Real UUID (and any non-local)
/// ids pass through with the existing behavior.
fn prepare_table_session_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    if item.operation == "INSERT" {
        return Ok(RequestPreparation::Ready(RequestSpec {
            endpoint: "/api/pos/table-sessions".to_string(),
            method: Method::POST,
            body: Some(item.data.clone()),
            terminal_id: terminal_id.to_string(),
        }));
    }

    let session_id = match local_table_session_order_id(&item.record_id) {
        Some(local_order_id) => {
            match resolve_remote_table_session_id(conn, local_order_id, payload) {
                Some(remote_id) => remote_id,
                None => {
                    if item.operation == "UPDATE" {
                        if let Some(obsolete_close) =
                            classify_obsolete_table_session_close(conn, local_order_id, payload)?
                        {
                            return Ok(RequestPreparation::Consumed {
                                reason: obsolete_close.reason,
                            });
                        }
                    }
                    return Ok(RequestPreparation::Deferred {
                        reason: TABLE_SESSION_REMOTE_ID_WAIT_REASON.to_string(),
                    });
                }
            }
        }
        None => item.record_id.clone(),
    };

    let method = resolve_http_method(item);
    let body = if method == Method::DELETE {
        None
    } else {
        Some(item.data.clone())
    };
    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: format!("/api/pos/table-sessions/{session_id}"),
        method,
        body,
        terminal_id: terminal_id.to_string(),
    }))
}

fn extract_response_string(response: Option<&Value>, paths: &[&str]) -> Option<String> {
    for path in paths {
        let mut current = response?;
        let mut found = true;
        for segment in path.split('.') {
            current = match current.get(segment) {
                Some(value) => value,
                None => {
                    found = false;
                    break;
                }
            };
        }

        if found {
            if let Some(value) = current.as_str() {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    None
}

fn extract_response_number(response: Option<&Value>, paths: &[&str]) -> Option<f64> {
    for path in paths {
        let mut current = response?;
        let mut found = true;
        for segment in path.split('.') {
            current = match current.get(segment) {
                Some(value) => value,
                None => {
                    found = false;
                    break;
                }
            };
        }

        if found {
            if let Some(value) = current.as_f64() {
                if value.is_finite() {
                    return Some(value);
                }
            }
        }
    }

    None
}

fn apply_success(
    conn: &Connection,
    item: &SyncQueueItem,
    response: Option<&Value>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();

    match item.table_name.as_str() {
        "orders" => {
            let response_customer_id = extract_response_string(
                response,
                &[
                    "data.customer_id",
                    "data.customerId",
                    "data.customer.id",
                    "customer_id",
                    "customerId",
                    "customer.id",
                ],
            );
            let response_delivery_address_id = extract_response_string(
                response,
                &[
                    "data.delivery_address_id",
                    "data.deliveryAddressId",
                    "delivery_address_id",
                    "deliveryAddressId",
                ],
            );
            let response_delivery_latitude = extract_response_number(
                response,
                &[
                    "data.delivery_latitude",
                    "data.deliveryLatitude",
                    "delivery_latitude",
                    "deliveryLatitude",
                ],
            );
            let response_delivery_longitude = extract_response_number(
                response,
                &[
                    "data.delivery_longitude",
                    "data.deliveryLongitude",
                    "delivery_longitude",
                    "deliveryLongitude",
                ],
            );
            let response_delivery_address_fingerprint = extract_response_string(
                response,
                &[
                    "data.delivery_address_fingerprint",
                    "data.deliveryAddressFingerprint",
                    "delivery_address_fingerprint",
                    "deliveryAddressFingerprint",
                ],
            );
            let response_delivery_zone_id = extract_response_string(
                response,
                &[
                    "data.delivery_zone_id",
                    "data.deliveryZoneId",
                    "delivery_zone_id",
                    "deliveryZoneId",
                ],
            );

            if item.operation == "INSERT" {
                let remote_id = extract_response_string(
                    response,
                    &["data.id", "data.order_id", "order_id", "id"],
                );
                conn.execute(
                    "UPDATE orders
                     SET sync_status = 'synced',
                         last_synced_at = ?1,
                         supabase_id = COALESCE(NULLIF(supabase_id, ''), ?2),
                         customer_id = COALESCE(?3, customer_id),
                         delivery_address_id = COALESCE(?4, delivery_address_id),
                         delivery_latitude = COALESCE(?5, delivery_latitude),
                         delivery_longitude = COALESCE(?6, delivery_longitude),
                         delivery_address_fingerprint = COALESCE(?7, delivery_address_fingerprint),
                         delivery_zone_id = COALESCE(?8, delivery_zone_id),
                         updated_at = ?1
                     WHERE id = ?9",
                    params![
                        now,
                        remote_id,
                        response_customer_id,
                        response_delivery_address_id,
                        response_delivery_latitude,
                        response_delivery_longitude,
                        response_delivery_address_fingerprint,
                        response_delivery_zone_id,
                        item.record_id.as_str()
                    ],
                )
                .map_err(|e| format!("sync_queue apply_success order insert: {e}"))?;
                sync::promote_payments_for_order(conn, item.record_id.as_str());
            } else {
                conn.execute(
                    "UPDATE orders
                     SET sync_status = 'synced',
                         last_synced_at = ?1,
                         customer_id = COALESCE(?2, customer_id),
                         delivery_address_id = COALESCE(?3, delivery_address_id),
                         delivery_latitude = COALESCE(?4, delivery_latitude),
                         delivery_longitude = COALESCE(?5, delivery_longitude),
                         delivery_address_fingerprint = COALESCE(?6, delivery_address_fingerprint),
                         delivery_zone_id = COALESCE(?7, delivery_zone_id)
                     WHERE id = ?8",
                    params![
                        now,
                        response_customer_id,
                        response_delivery_address_id,
                        response_delivery_latitude,
                        response_delivery_longitude,
                        response_delivery_address_fingerprint,
                        response_delivery_zone_id,
                        item.record_id.as_str()
                    ],
                )
                .map_err(|e| format!("sync_queue apply_success order update: {e}"))?;
            }
        }
        "payments" => {
            let remote_payment_id =
                extract_response_string(response, &["payment_id", "id", "data.id"]);
            sync::mark_local_payment_applied(
                conn,
                item.record_id.as_str(),
                now.as_str(),
                remote_payment_id.as_deref(),
            )?;
        }
        "payment_adjustments" => {
            conn.execute(
                "UPDATE payment_adjustments
                 SET sync_state = 'applied',
                     sync_retry_count = 0,
                     sync_last_error = NULL,
                     sync_next_retry_at = NULL,
                     updated_at = ?1
                 WHERE id = ?2",
                params![now, item.record_id.as_str()],
            )
            .map_err(|e| format!("sync_queue apply_success adjustment: {e}"))?;

            let payload = serde_json::from_str::<Value>(&item.data)
                .unwrap_or_else(|_| Value::Object(Map::new()));
            let adjustment_type =
                string_field(&payload, &["adjustmentType", "adjustment_type"]).unwrap_or_default();
            if adjustment_type.eq_ignore_ascii_case("void") {
                if let Some(payment_id) = string_field(&payload, &["paymentId", "payment_id"]) {
                    let _ = conn.execute(
                        "UPDATE order_payments
                         SET sync_status = 'synced',
                             sync_retry_count = 0,
                             sync_last_error = NULL,
                             sync_next_retry_at = NULL,
                             updated_at = ?1
                         WHERE id = ?2",
                        params![now, payment_id],
                    );
                }
            }
        }
        "z_reports" => {
            conn.execute(
                "UPDATE z_reports
                 SET sync_state = 'applied',
                     sync_retry_count = 0,
                     sync_last_error = NULL,
                     sync_next_retry_at = NULL,
                     updated_at = ?1
                 WHERE id = ?2",
                params![now, item.record_id.as_str()],
            )
            .map_err(|e| format!("sync_queue apply_success z_report: {e}"))?;
        }
        "customer_addresses" => {
            update_customer_address_cache_after_sync(conn, item, response)?;
        }
        "driver_earnings" | "driver_earning" => {
            if item.operation != "DELETE" {
                let remote_id = response
                    .and_then(|value| value.get("results"))
                    .and_then(Value::as_array)
                    .and_then(|rows| rows.first())
                    .and_then(|result| {
                        result
                            .get("server_id")
                            .or_else(|| result.get("supabase_id"))
                            .and_then(Value::as_str)
                    })
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| item.record_id.clone());
                let _ = conn.execute(
                    "UPDATE driver_earnings
                     SET supabase_id = ?1,
                         updated_at = ?2
                     WHERE id = ?3",
                    params![remote_id, now, item.record_id.as_str()],
                );
            }
        }
        "restaurant_table_sessions" => {
            // Capture the remote (Supabase) session UUID minted by the open
            // INSERT and persist it onto the related local order so a later
            // close/update row keyed by `local-table-session:{localOrderId}`
            // can resolve the real UUID instead of replaying the local
            // placeholder (which admin rejects with HTTP 500). Only the INSERT
            // mints a new id; UPDATE/DELETE responses carry no new mapping.
            if item.operation == "INSERT" {
                let remote_session_id = extract_response_string(
                    response,
                    &[
                        "session.id",
                        "data.session.id",
                        "data.id",
                        "session_id",
                        "sessionId",
                        "id",
                    ],
                )
                .filter(|candidate| is_uuid(candidate));

                if let Some(remote_session_id) = remote_session_id {
                    let payload = serde_json::from_str::<Value>(&item.data)
                        .unwrap_or_else(|_| Value::Object(Map::new()));
                    let local_order_id = string_field(
                        &payload,
                        &[
                            "active_order_client_id",
                            "activeOrderClientId",
                            "client_order_id",
                            "clientOrderId",
                            "order_id",
                            "orderId",
                            "active_order_id",
                            "activeOrderId",
                        ],
                    );

                    if let Some(local_order_id) = local_order_id {
                        // Conservative: only fill an empty mapping or replace a
                        // local placeholder; never clobber an existing UUID.
                        conn.execute(
                            "UPDATE orders
                             SET table_session_id = ?1,
                                 updated_at = ?2
                             WHERE id = ?3
                               AND (
                                 table_session_id IS NULL
                                 OR TRIM(table_session_id) = ''
                                 OR table_session_id LIKE 'local-table-session:%'
                               )",
                            params![remote_session_id, now, local_order_id],
                        )
                        .map_err(|e| {
                            format!("sync_queue apply_success table_session insert: {e}")
                        })?;
                    }
                }
            }
        }
        "loyalty_transactions" => {
            // Wave 5 Session 6: mirror legacy `sync_loyalty_items`
            // (sync.rs:12875) which flipped `sync_state='applied'` on
            // success. Without this case, successfully-synced loyalty
            // rows would silently remain `sync_state='pending'` and
            // parity gates would keep surfacing them as unsynced.
            conn.execute(
                "UPDATE loyalty_transactions
                 SET sync_state = 'applied'
                 WHERE id = ?1",
                params![item.record_id.as_str()],
            )
            .map_err(|e| format!("sync_queue apply_success loyalty_transaction: {e}"))?;
        }
        _ => {}
    }

    Ok(())
}

fn is_replay_conflict_response(status: u16, response_body: &str, item: &SyncQueueItem) -> bool {
    if status == 409 {
        return true;
    }
    if status == 429 || !(400..500).contains(&status) {
        return false;
    }
    if matches!(item.table_name.as_str(), "payments" | "payment_adjustments")
        && is_payment_total_conflict_error(response_body)
    {
        return false;
    }

    let lower = response_body.to_ascii_lowercase();
    let conflict_language = status == 412
        || lower.contains("version conflict")
        || lower.contains("version mismatch")
        || lower.contains("stale version")
        || lower.contains("expected_version")
        || lower.contains("expected version")
        || lower.contains("optimistic lock")
        || lower.contains("updated by another terminal")
        || lower.contains("already changed");
    if !conflict_language {
        return false;
    }

    matches!(
        item.table_name.as_str(),
        "orders"
            | "menu_categories"
            | "menu_subcategories"
            | "menu_ingredients"
            | "menu_combos"
            | "products"
            | "rooms"
            | "branch_settings"
            | "terminal_settings"
            | "local_settings"
    ) || matches!(
        item.module_type.as_str(),
        "orders" | "catalog" | "settings" | "operations"
    )
}

fn is_parent_order_wait_response(status: u16, response_body: &str) -> bool {
    if status != 409 {
        return false;
    }

    let lower = response_body.to_ascii_lowercase();
    lower.contains("waiting for parent order sync")
        || lower.contains("parent order sync")
        || lower.contains("parent_order_sync")
}

fn is_table_session_close_waiting_payment_response(
    status: u16,
    response_body: &str,
    item: &SyncQueueItem,
) -> bool {
    if status != 409 || item.table_name != "restaurant_table_sessions" || item.operation != "UPDATE"
    {
        return false;
    }

    let payload = serde_json::from_str::<Value>(&item.data).unwrap_or(Value::Null);
    let action = string_field(&payload, &["action"]).unwrap_or_default();
    if !action.eq_ignore_ascii_case("close") {
        return false;
    }

    let lower = response_body.to_ascii_lowercase();
    lower.contains("cannot close a table session with an outstanding balance")
        || (lower.contains("outstanding_balance") && lower.contains("paid_total"))
}

/// Returns the missing-module list when the response is the admin API's
/// uniform module-acquisition denial (THE-306 gating sweep):
/// `403 {"success":false,"error":"MODULE_REQUIRED","missingModules":[...]}`.
/// `Some("")` means the denial matched but carried no module list.
///
/// `pub(crate)` so the invoice-capture worker classifies the very same 403 with
/// the very same rule instead of growing a second, drift-prone opinion about
/// what a module denial looks like (invoice-scan-capture D-Rust4, R11.7).
pub(crate) fn parse_module_required_response(status: u16, response_body: &str) -> Option<String> {
    if status != 403 {
        return None;
    }
    let json = serde_json::from_str::<Value>(response_body).ok()?;
    if json.get("error").and_then(Value::as_str) != Some("MODULE_REQUIRED") {
        return None;
    }
    let missing = json
        .get("missingModules")
        .and_then(Value::as_array)
        .map(|modules| {
            modules
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    Some(missing)
}

#[derive(Debug)]
enum RepairQueueProcessOutcome {
    Processed,
    Conflict,
    Deferred(String),
    StaffSessionRequired(String),
    TerminalAuth(ParityTerminalAuthFailure),
    Failed { code: String, dead_lettered: bool },
    RateLimited(String),
    Stale,
}

fn repair_claim_generation_matches(conn: &Connection, item: &SyncQueueItem) -> bool {
    conn.query_row(
        "SELECT claim_generation = ?2
         FROM parity_sync_queue
         WHERE id = ?1",
        params![item.id.as_str(), item.claim_generation],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or(false)
}

fn force_repair_permanent_failure(
    conn: &Connection,
    item: &SyncQueueItem,
    reason_code: &str,
) -> Result<MarkFailureOutcome, String> {
    retry_transaction(conn, |conn| {
        let outcome =
            mark_failure_in_transaction(conn, &item.id, reason_code, item.claim_generation)?;
        if !outcome.applied {
            return Ok(outcome);
        }
        let canonical = canonical_repair_owner_predicate("parity_sync_queue");
        let sql = format!(
            "UPDATE parity_sync_queue
                SET status = 'failed'
              WHERE id = ?1
                AND claim_generation = ?2
                AND {canonical}"
        );
        let affected = conn
            .execute(&sql, params![item.id, item.claim_generation])
            .map_err(|error| format!("mark repair item permanently failed: {error}"))?;
        if affected != 1 {
            return Err("mark repair item permanently failed: live owner changed".to_string());
        }
        Ok(outcome)
    })
}

fn apply_repair_hook_failure(
    conn: &Connection,
    item: &SyncQueueItem,
    error: RepairHookError,
) -> Result<RepairQueueProcessOutcome, String> {
    if !repair_claim_generation_matches(conn, item) {
        return Ok(RepairQueueProcessOutcome::Stale);
    }
    let code = error.code().to_string();
    match error.kind() {
        RepairHookErrorKind::SignInRequired | RepairHookErrorKind::Unavailable => {
            mark_repair_prerequisite(conn, &item.id, &code, item.claim_generation)?;
            Ok(RepairQueueProcessOutcome::Deferred(code))
        }
        RepairHookErrorKind::Retryable => {
            let outcome = mark_failure(conn, &item.id, &code, item.claim_generation)?;
            if !outcome.applied {
                return Ok(RepairQueueProcessOutcome::Stale);
            }
            Ok(RepairQueueProcessOutcome::Failed {
                code,
                dead_lettered: outcome.transitioned_to_dead_letter,
            })
        }
        RepairHookErrorKind::Permanent => {
            let outcome = force_repair_permanent_failure(conn, item, &code)?;
            if !outcome.applied {
                return Ok(RepairQueueProcessOutcome::Stale);
            }
            Ok(RepairQueueProcessOutcome::Failed {
                code,
                dead_lettered: outcome.transitioned_to_dead_letter,
            })
        }
    }
}

async fn process_repair_command_item(
    conn: &std::sync::Mutex<Connection>,
    client: &reqwest::Client,
    api_base_url: &str,
    api_key: &str,
    item: &SyncQueueItem,
    hooks: &dyn RepairQueueHooks,
) -> Result<RepairQueueProcessOutcome, String> {
    let _lifecycle_lease = match crate::repairs::acquire_transport_lease() {
        Ok(lease) => lease,
        Err(error) => {
            let db = conn
                .lock()
                .map_err(|lock_error| format!("lock: {lock_error}"))?;
            return apply_repair_hook_failure(&db, item, error);
        }
    };
    let safe_base = match crate::api::resolve_admin_base(api_base_url) {
        Ok(base) => base,
        Err(_) => {
            let db = conn.lock().map_err(|error| format!("lock: {error}"))?;
            return apply_repair_hook_failure(
                &db,
                item,
                RepairHookError::unavailable("REPAIR_API_ORIGIN_INVALID"),
            );
        }
    };
    let mut prepared = {
        let db = conn.lock().map_err(|error| format!("lock: {error}"))?;
        match prepare_repair_command_request(&db, item, hooks) {
            Ok(prepared) => prepared,
            Err(error) => return apply_repair_hook_failure(&db, item, error),
        }
    };

    let url = format!("{}/api/pos/repairs/sync", safe_base.trim_end_matches('/'));
    let request_body = std::mem::take(&mut *prepared.body);
    let response = client
        .post(url)
        .header("x-pos-api-key", api_key)
        .header("x-terminal-id", &prepared.terminal_id)
        .header("x-staff-session-id", &prepared.staff_session_id)
        .header("x-pos-client-version", env!("CARGO_PKG_VERSION"))
        .header("content-type", "application/json")
        .body(request_body)
        .send()
        .await;

    let response = match response {
        Ok(response) => match read_bounded_repair_response(response).await {
            Ok(response) => response,
            Err(error) => {
                let db = conn
                    .lock()
                    .map_err(|lock_error| format!("lock: {lock_error}"))?;
                return apply_repair_hook_failure(&db, item, error);
            }
        },
        Err(_) => {
            let db = conn.lock().map_err(|error| format!("lock: {error}"))?;
            if !repair_claim_generation_matches(&db, item) {
                return Ok(RepairQueueProcessOutcome::Stale);
            }
            let outcome =
                mark_failure(&db, &item.id, "REPAIR_NETWORK_ERROR", item.claim_generation)?;
            if !outcome.applied {
                return Ok(RepairQueueProcessOutcome::Stale);
            }
            return Ok(RepairQueueProcessOutcome::Failed {
                code: "REPAIR_NETWORK_ERROR".to_string(),
                dead_lettered: outcome.transitioned_to_dead_letter,
            });
        }
    };

    let disposition = if response.exceeded_limit {
        RepairSyncDisposition::MalformedResponse
    } else {
        classify_repair_http_response(
            response.status,
            &response.body,
            response.retry_after.as_deref(),
            &prepared.expected_identity,
        )
    };

    let db = conn.lock().map_err(|error| format!("lock: {error}"))?;
    if !repair_claim_generation_matches(&db, item) {
        return Ok(RepairQueueProcessOutcome::Stale);
    }
    match disposition {
        RepairSyncDisposition::Success(signal) => {
            if let Err(error) = hooks.reconcile_success(&db, &prepared.context, &signal) {
                return apply_repair_hook_failure(&db, item, error);
            }
            mark_success(&db, &item.id, item.claim_generation)?;
            Ok(RepairQueueProcessOutcome::Processed)
        }
        RepairSyncDisposition::Conflict(conflict) => {
            if let Err(error) = hooks.park_conflict(&db, &prepared.context, &conflict) {
                return apply_repair_hook_failure(&db, item, error);
            }
            if log_conflict(
                &db,
                &item.operation,
                &item.record_id,
                &item.table_name,
                item.version,
                i64::try_from(conflict.current_version).unwrap_or(i64::MAX),
                "[repair local envelope retained by encrypted conflict store]",
                "manual",
                false,
                false,
            )
            .is_err()
            {
                warn!("repair conflict audit telemetry write failed after durable native park");
            }
            mark_conflict(&db, &item.id, item.claim_generation)?;
            Ok(RepairQueueProcessOutcome::Conflict)
        }
        RepairSyncDisposition::SessionRequired(error) => {
            mark_repair_prerequisite(&db, &item.id, &error.code, item.claim_generation)?;
            Ok(RepairQueueProcessOutcome::StaffSessionRequired(error.code))
        }
        RepairSyncDisposition::TerminalAuth(failure) => {
            mark_terminal_auth_pending(&db, item, failure)?;
            Ok(RepairQueueProcessOutcome::TerminalAuth(failure))
        }
        RepairSyncDisposition::ModuleRequired(error) => {
            mark_module_required(&db, &item.id, &error.code, item.claim_generation)?;
            Ok(RepairQueueProcessOutcome::Deferred(error.code))
        }
        RepairSyncDisposition::RateLimited {
            retry_after_seconds,
        } => {
            let code = "REPAIR_RATE_LIMITED";
            mark_rate_limited(
                &db,
                &item.id,
                code,
                retry_after_seconds,
                item.claim_generation,
            )?;
            Ok(RepairQueueProcessOutcome::RateLimited(code.to_string()))
        }
        RepairSyncDisposition::PermanentFailure(error) => {
            let outcome = force_repair_permanent_failure(&db, item, &error.code)?;
            if !outcome.applied {
                return Ok(RepairQueueProcessOutcome::Stale);
            }
            Ok(RepairQueueProcessOutcome::Failed {
                code: error.code,
                dead_lettered: outcome.transitioned_to_dead_letter,
            })
        }
        RepairSyncDisposition::RetryableFailure(error) => {
            let outcome = mark_failure(&db, &item.id, &error.code, item.claim_generation)?;
            if !outcome.applied {
                return Ok(RepairQueueProcessOutcome::Stale);
            }
            Ok(RepairQueueProcessOutcome::Failed {
                code: error.code,
                dead_lettered: outcome.transitioned_to_dead_letter,
            })
        }
        RepairSyncDisposition::MalformedResponse => {
            let code = "REPAIR_RESPONSE_MALFORMED";
            let outcome = mark_failure(&db, &item.id, code, item.claim_generation)?;
            if !outcome.applied {
                return Ok(RepairQueueProcessOutcome::Stale);
            }
            Ok(RepairQueueProcessOutcome::Failed {
                code: code.to_string(),
                dead_lettered: outcome.transitioned_to_dead_letter,
            })
        }
    }
}

async fn process_repair_attachment_item(
    conn: &std::sync::Mutex<Connection>,
    api_base_url: &str,
    api_key: &str,
    item: &SyncQueueItem,
    hooks: &dyn RepairQueueHooks,
) -> Result<RepairQueueProcessOutcome, String> {
    let _lifecycle_lease = match crate::repairs::acquire_transport_lease() {
        Ok(lease) => lease,
        Err(error) => {
            let db = conn
                .lock()
                .map_err(|lock_error| format!("lock: {lock_error}"))?;
            return apply_repair_hook_failure(&db, item, error);
        }
    };
    if crate::api::resolve_admin_base(api_base_url).is_err() {
        let db = conn.lock().map_err(|error| format!("lock: {error}"))?;
        return apply_repair_hook_failure(
            &db,
            item,
            RepairHookError::unavailable("REPAIR_API_ORIGIN_INVALID"),
        );
    }
    let prepared = {
        let db = conn.lock().map_err(|error| format!("lock: {error}"))?;
        match prepare_repair_attachment_request(&db, item, hooks) {
            Ok(prepared) => prepared,
            Err(error) => return apply_repair_hook_failure(&db, item, error),
        }
    };

    let crate::repair_transport::PreparedRepairAttachmentRequest {
        context,
        session,
        upload,
    } = prepared;
    let disposition =
        match send_repair_raw_attachment(api_base_url, api_key, &session, upload).await {
            Ok(disposition) => disposition,
            Err(error) => {
                let db = conn
                    .lock()
                    .map_err(|lock_error| format!("lock: {lock_error}"))?;
                return apply_repair_hook_failure(&db, item, error);
            }
        };

    let db = conn.lock().map_err(|error| format!("lock: {error}"))?;
    if !repair_claim_generation_matches(&db, item) {
        return Ok(RepairQueueProcessOutcome::Stale);
    }
    match disposition {
        RepairAttachmentDisposition::Uploaded(result) => {
            if let Err(error) = hooks.reconcile_attachment_success(&db, &context, &result) {
                return apply_repair_hook_failure(&db, item, error);
            }
            mark_success(&db, &item.id, item.claim_generation)?;
            Ok(RepairQueueProcessOutcome::Processed)
        }
        RepairAttachmentDisposition::Conflict(conflict) => {
            if let Err(error) = hooks.park_conflict(&db, &context, &conflict) {
                return apply_repair_hook_failure(&db, item, error);
            }
            if log_conflict(
                &db,
                &item.operation,
                &item.record_id,
                &item.table_name,
                item.version,
                i64::try_from(conflict.current_version).unwrap_or(i64::MAX),
                "[repair attachment ciphertext retained by encrypted conflict store]",
                "manual",
                false,
                false,
            )
            .is_err()
            {
                warn!("repair attachment conflict audit telemetry write failed after durable native park");
            }
            mark_conflict(&db, &item.id, item.claim_generation)?;
            Ok(RepairQueueProcessOutcome::Conflict)
        }
        RepairAttachmentDisposition::SessionRequired(error) => {
            mark_repair_prerequisite(&db, &item.id, &error.code, item.claim_generation)?;
            Ok(RepairQueueProcessOutcome::StaffSessionRequired(error.code))
        }
        RepairAttachmentDisposition::TerminalAuth(failure) => {
            mark_terminal_auth_pending(&db, item, failure)?;
            Ok(RepairQueueProcessOutcome::TerminalAuth(failure))
        }
        RepairAttachmentDisposition::ModuleRequired(error) => {
            mark_module_required(&db, &item.id, &error.code, item.claim_generation)?;
            Ok(RepairQueueProcessOutcome::Deferred(error.code))
        }
        RepairAttachmentDisposition::RateLimited {
            retry_after_seconds,
        } => {
            let code = "REPAIR_RATE_LIMITED";
            mark_rate_limited(
                &db,
                &item.id,
                code,
                retry_after_seconds,
                item.claim_generation,
            )?;
            Ok(RepairQueueProcessOutcome::RateLimited(code.to_string()))
        }
        RepairAttachmentDisposition::PermanentFailure(error) => {
            let outcome = force_repair_permanent_failure(&db, item, &error.code)?;
            if !outcome.applied {
                return Ok(RepairQueueProcessOutcome::Stale);
            }
            Ok(RepairQueueProcessOutcome::Failed {
                code: error.code,
                dead_lettered: outcome.transitioned_to_dead_letter,
            })
        }
        RepairAttachmentDisposition::RetryableFailure(error) => {
            let outcome = mark_failure(&db, &item.id, &error.code, item.claim_generation)?;
            if !outcome.applied {
                return Ok(RepairQueueProcessOutcome::Stale);
            }
            Ok(RepairQueueProcessOutcome::Failed {
                code: error.code,
                dead_lettered: outcome.transitioned_to_dead_letter,
            })
        }
        RepairAttachmentDisposition::MalformedResponse => {
            let code = "REPAIR_RESPONSE_MALFORMED";
            let outcome = mark_failure(&db, &item.id, code, item.claim_generation)?;
            if !outcome.applied {
                return Ok(RepairQueueProcessOutcome::Stale);
            }
            Ok(RepairQueueProcessOutcome::Failed {
                code: code.to_string(),
                dead_lettered: outcome.transitioned_to_dead_letter,
            })
        }
    }
}

/// Process all pending items in the queue by sending them to the admin API.
///
/// Items are processed FIFO within priority bands. On success, items are
/// removed. On transient failure (5xx / network), items are rescheduled
/// with exponential backoff. On replay conflicts (409, 412, or explicit
/// version-conflict responses), items are marked as `conflict`. On other
/// client errors, items are marked as `failed`.
pub async fn process_queue(
    conn: &std::sync::Mutex<Connection>,
    api_base_url: &str,
    api_key: &str,
) -> Result<SyncResult, String> {
    process_queue_with_claim_gate(conn, api_base_url, api_key, || Ok(())).await
}

pub(crate) async fn process_queue_with_claim_gate<Acquire, Lease>(
    conn: &std::sync::Mutex<Connection>,
    api_base_url: &str,
    api_key: &str,
    acquire_claim_gate: Acquire,
) -> Result<SyncResult, String>
where
    Acquire: FnMut() -> Result<Lease, ParityClaimGateBlock> + Send,
    Lease: Send,
{
    process_queue_with_visibility(
        conn,
        api_base_url,
        api_key,
        &crate::repairs::NATIVE_REPAIR_QUEUE_HOOKS,
        QueueProcessVisibility::InternalAll,
        QueueProcessSelection::All,
        acquire_claim_gate,
    )
    .await
}

/// Generic renderer trigger. It can process legacy parity work but cannot
/// claim, recover, count, return or otherwise mutate native repair rows.
#[cfg(test)]
pub(crate) async fn process_queue_renderer_safe(
    conn: &std::sync::Mutex<Connection>,
    api_base_url: &str,
    api_key: &str,
) -> Result<SyncResult, String> {
    process_queue_renderer_safe_with_claim_gate(conn, api_base_url, api_key, || Ok(())).await
}

/// Renderer-visible generic replay with the same lifecycle fence as the
/// background native processor. Production callers must supply the live
/// terminal-binding gate; the no-op wrapper above exists only for isolated
/// queue tests.
pub(crate) async fn process_queue_renderer_safe_with_claim_gate<Acquire, Lease>(
    conn: &std::sync::Mutex<Connection>,
    api_base_url: &str,
    api_key: &str,
    acquire_claim_gate: Acquire,
) -> Result<SyncResult, String>
where
    Acquire: FnMut() -> Result<Lease, ParityClaimGateBlock> + Send,
    Lease: Send,
{
    process_queue_with_visibility(
        conn,
        api_base_url,
        api_key,
        &UnavailableRepairQueueHooks,
        QueueProcessVisibility::RendererNonRepair,
        QueueProcessSelection::All,
        acquire_claim_gate,
    )
    .await
}

pub(crate) async fn process_queue_renderer_safe_item_with_claim_gate<Acquire, Lease>(
    conn: &std::sync::Mutex<Connection>,
    api_base_url: &str,
    api_key: &str,
    item_id: &str,
    acquire_claim_gate: Acquire,
) -> Result<SyncResult, String>
where
    Acquire: FnMut() -> Result<Lease, ParityClaimGateBlock> + Send,
    Lease: Send,
{
    process_queue_with_visibility(
        conn,
        api_base_url,
        api_key,
        &UnavailableRepairQueueHooks,
        QueueProcessVisibility::RendererNonRepair,
        QueueProcessSelection::ExactRendererItem(item_id),
        acquire_claim_gate,
    )
    .await
}

#[cfg(test)]
pub(crate) async fn process_queue_with_repair_hooks(
    conn: &std::sync::Mutex<Connection>,
    api_base_url: &str,
    api_key: &str,
    repair_hooks: &dyn RepairQueueHooks,
) -> Result<SyncResult, String> {
    process_queue_with_visibility(
        conn,
        api_base_url,
        api_key,
        repair_hooks,
        QueueProcessVisibility::InternalAll,
        QueueProcessSelection::All,
        || Ok(()),
    )
    .await
}

async fn process_queue_with_visibility<Acquire, Lease>(
    conn: &std::sync::Mutex<Connection>,
    api_base_url: &str,
    api_key: &str,
    repair_hooks: &dyn RepairQueueHooks,
    visibility: QueueProcessVisibility,
    selection: QueueProcessSelection<'_>,
    mut acquire_claim_gate: Acquire,
) -> Result<SyncResult, String>
where
    Acquire: FnMut() -> Result<Lease, ParityClaimGateBlock> + Send,
    Lease: Send,
{
    let started_at = Utc::now().to_rfc3339();
    let exact_renderer_item = matches!(selection, QueueProcessSelection::ExactRendererItem(_));
    let queue_depth_before: i64;
    let mut quarantined = 0_i64;
    let mut exact_item = None;
    // Exact manual retry uses one lease from before its atomic retry+claim
    // through the sole HTTP request and acknowledgement. It intentionally
    // skips every queue-wide maintenance prepass.
    let _exact_gate_lease = if let QueueProcessSelection::ExactRendererItem(item_id) = selection {
        let lease = match acquire_claim_gate() {
            Ok(lease) => lease,
            Err(block) => {
                let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                let queue_depth = renderer_get_length(&db)?;
                let telemetry = SyncTelemetryBuilder::new(started_at, queue_depth)
                    .finish(&db, 0, 0, 0, visibility)?;
                return Ok(SyncResult {
                    success: false,
                    processed: 0,
                    failed: 0,
                    conflicts: 0,
                    quarantined: 0,
                    dead_lettered: 0,
                    errors: Vec::new(),
                    monetary_dead_letters: Vec::new(),
                    auth_outcome: None,
                    batch_block: Some(block),
                    telemetry,
                });
            }
        };
        {
            let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
            exact_item = renderer_retry_and_dequeue_exact(&db, item_id)?;
            queue_depth_before = renderer_get_length(&db)?;
        }
        Some(lease)
    } else {
        // Lifecycle fencing covers every mutation-heavy prepass, not only the
        // later per-item claim. A reset/rebind/pause that began after credential
        // resolution must leave queue and local domain rows byte-for-byte intact.
        let prepass_gate_lease = match acquire_claim_gate() {
            Ok(lease) => lease,
            Err(block) => {
                let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                let queue_depth = match visibility {
                    QueueProcessVisibility::InternalAll => get_length(&db)?,
                    QueueProcessVisibility::RendererNonRepair => renderer_get_length(&db)?,
                };
                let telemetry = SyncTelemetryBuilder::new(started_at, queue_depth)
                    .finish(&db, 0, 0, 0, visibility)?;
                return Ok(SyncResult {
                    success: false,
                    processed: 0,
                    failed: 0,
                    conflicts: 0,
                    quarantined: 0,
                    dead_lettered: 0,
                    errors: Vec::new(),
                    monetary_dead_letters: Vec::new(),
                    auth_outcome: None,
                    batch_block: Some(block),
                    telemetry,
                });
            }
        };
        // Check for age warnings and perform bounded maintenance before processing.
        {
            let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
            if visibility == QueueProcessVisibility::InternalAll {
                quarantined += quarantine_reserved_repair_lookalikes(&db)?;
                let _ = redact_identifiable_legacy_repair_audit_payloads(&db)?;
                let _ = check_age_warnings(&db);
            }
            match visibility {
                QueueProcessVisibility::InternalAll => {
                    let _ = recover_stale_processing_items(&db)?;
                }
                QueueProcessVisibility::RendererNonRepair => {
                    let _ = recover_stale_processing_items_renderer_safe(&db)?;
                }
            }
            let _ = cleanup_superseded_synced_order_status_updates(&db)?;
            if visibility == QueueProcessVisibility::InternalAll {
                let mut remaining_requeue_budget = MAX_AUTO_REQUEUE_ITEMS_PER_CYCLE;

                let terminal_context_retries =
                    retry_failed_terminal_context_items_limited(&db, remaining_requeue_budget)?;
                remaining_requeue_budget = remaining_requeue_budget
                    .saturating_sub(terminal_context_retries.retried as usize);

                let rate_limited_retries =
                    retry_failed_rate_limited_items_limited(&db, remaining_requeue_budget)?;
                remaining_requeue_budget =
                    remaining_requeue_budget.saturating_sub(rate_limited_retries.retried as usize);

                let fiscal_issued_at_retries = retry_failed_invalid_fiscal_issued_at_items_limited(
                    &db,
                    remaining_requeue_budget,
                )?;
                remaining_requeue_budget = remaining_requeue_budget
                    .saturating_sub(fiscal_issued_at_retries.retried as usize);

                let legacy_order_retries =
                    retry_failed_legacy_order_insert_items_limited(&db, remaining_requeue_budget)?;
                remaining_requeue_budget =
                    remaining_requeue_budget.saturating_sub(legacy_order_retries.retried as usize);

                let payment_conflict_resolutions =
                    resolve_failed_payment_total_conflict_items_limited(
                        &db,
                        remaining_requeue_budget,
                    )?;
                remaining_requeue_budget = remaining_requeue_budget
                    .saturating_sub(payment_conflict_resolutions.retried as usize);

                let customer_address_retries =
                    retry_failed_customer_address_not_found_items_limited(
                        &db,
                        remaining_requeue_budget,
                    )?;
                remaining_requeue_budget = remaining_requeue_budget
                    .saturating_sub(customer_address_retries.retried as usize);

                let _ = retry_failed_table_session_local_placeholder_items_limited(
                    &db,
                    remaining_requeue_budget,
                )?;
            }

            queue_depth_before = match visibility {
                QueueProcessVisibility::InternalAll => get_length(&db)?,
                QueueProcessVisibility::RendererNonRepair => renderer_get_length(&db)?,
            };
        }
        drop(prepass_gate_lease);
        None
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("sync_queue client build: {e}"))?;
    // Repair requests carry a live staff-session claim in addition to the
    // terminal API key. Never follow redirects: even reqwest's same-client
    // redirect handling could forward those native credentials to another
    // origin before the response classifier sees the 3xx status.
    let repair_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("repair sync client build: {e}"))?;
    let mut processed: i64 = 0;
    let mut failed: i64 = 0;
    let mut conflicts: i64 = 0;
    let mut dead_lettered: i64 = 0;
    let mut auth_outcome: Option<ParityAuthOutcome> = None;
    let mut batch_block: Option<ParityClaimGateBlock> = None;
    let mut errors: Vec<SyncError> = Vec::new();
    // Wave 4 H: collect monetary dead-letters so the caller can emit
    // `sync:dead-letter:monetary` events in the Tauri command layer.
    let mut monetary_dead_letters: Vec<MonetaryDeadLetter> = Vec::new();
    let mut telemetry = SyncTelemetryBuilder::new(started_at, queue_depth_before);
    let mut exact_claim_consumed = false;

    loop {
        if selection != QueueProcessSelection::All && exact_claim_consumed {
            break;
        }
        // The lifecycle gate is acquired before any queue candidate is read or
        // claimed and remains alive through HTTP plus authoritative local ack.
        let _claim_gate_lease = match selection {
            QueueProcessSelection::All => match acquire_claim_gate() {
                Ok(lease) => Some(lease),
                Err(block) => {
                    batch_block = Some(block);
                    break;
                }
            },
            QueueProcessSelection::ExactRendererItem(_) => None,
        };
        // Dequeue next item under lock, then release lock before HTTP call
        let item = match selection {
            QueueProcessSelection::ExactRendererItem(_) => {
                exact_claim_consumed = true;
                exact_item.take()
            }
            QueueProcessSelection::All => {
                let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                match visibility {
                    QueueProcessVisibility::InternalAll => {
                        let (item, newly_quarantined) = dequeue_with_quarantine_count(&db)?;
                        quarantined += newly_quarantined;
                        item
                    }
                    QueueProcessVisibility::RendererNonRepair => renderer_dequeue(&db)?,
                }
            }
        };

        let item = match item {
            Some(i) => i,
            None => break,
        };
        telemetry.record_attempt();

        if item.table_name == "repairs" {
            let outcome = process_repair_command_item(
                conn,
                &repair_client,
                api_base_url,
                api_key,
                &item,
                repair_hooks,
            )
            .await?;
            match outcome {
                RepairQueueProcessOutcome::Processed => {
                    processed += 1;
                    telemetry.record_success(&item);
                }
                RepairQueueProcessOutcome::Conflict => {
                    conflicts += 1;
                    telemetry.record_error(&item, "conflict", "REPAIR_VERSION_CONFLICT", Some(409));
                    errors.push(safe_sync_error(&item, "REPAIR_VERSION_CONFLICT", Some(409)));
                }
                RepairQueueProcessOutcome::Deferred(code) => {
                    telemetry.record_deferred(&item, &code);
                }
                RepairQueueProcessOutcome::StaffSessionRequired(code) => {
                    merge_auth_outcome(&mut auth_outcome, ParityAuthOutcome::StaffSessionRequired);
                    telemetry.record_deferred(&item, &code);
                }
                RepairQueueProcessOutcome::TerminalAuth(failure) => {
                    merge_auth_outcome(&mut auth_outcome, ParityAuthOutcome::terminal(failure));
                    telemetry.record_error(&item, "pending", "terminal_auth", None);
                    break;
                }
                RepairQueueProcessOutcome::Failed {
                    code,
                    dead_lettered: transitioned_to_dead_letter,
                } => {
                    if transitioned_to_dead_letter {
                        dead_lettered += 1;
                    }
                    failed += 1;
                    telemetry.record_error(&item, "failed", &code, None);
                    errors.push(safe_sync_error(&item, &code, None));
                }
                RepairQueueProcessOutcome::RateLimited(code) => {
                    failed += 1;
                    telemetry.record_error(&item, "pending", &code, Some(429));
                    errors.push(safe_sync_error(&item, &code, Some(429)));
                    break;
                }
                RepairQueueProcessOutcome::Stale => {}
            }
            continue;
        }

        if item.table_name == "repair_attachments" {
            let outcome =
                process_repair_attachment_item(conn, api_base_url, api_key, &item, repair_hooks)
                    .await?;
            match outcome {
                RepairQueueProcessOutcome::Processed => {
                    processed += 1;
                    telemetry.record_success(&item);
                }
                RepairQueueProcessOutcome::Conflict => {
                    conflicts += 1;
                    telemetry.record_error(&item, "conflict", "REPAIR_VERSION_CONFLICT", Some(409));
                    errors.push(safe_sync_error(&item, "REPAIR_VERSION_CONFLICT", Some(409)));
                }
                RepairQueueProcessOutcome::Deferred(code) => {
                    telemetry.record_deferred(&item, &code);
                }
                RepairQueueProcessOutcome::StaffSessionRequired(code) => {
                    merge_auth_outcome(&mut auth_outcome, ParityAuthOutcome::StaffSessionRequired);
                    telemetry.record_deferred(&item, &code);
                }
                RepairQueueProcessOutcome::TerminalAuth(failure) => {
                    merge_auth_outcome(&mut auth_outcome, ParityAuthOutcome::terminal(failure));
                    telemetry.record_error(&item, "pending", "terminal_auth", None);
                    break;
                }
                RepairQueueProcessOutcome::Failed {
                    code,
                    dead_lettered: transitioned_to_dead_letter,
                } => {
                    if transitioned_to_dead_letter {
                        dead_lettered += 1;
                    }
                    failed += 1;
                    telemetry.record_error(&item, "failed", &code, None);
                    errors.push(safe_sync_error(&item, &code, None));
                }
                RepairQueueProcessOutcome::RateLimited(code) => {
                    failed += 1;
                    telemetry.record_error(&item, "pending", &code, Some(429));
                    errors.push(safe_sync_error(&item, &code, Some(429)));
                    break;
                }
                RepairQueueProcessOutcome::Stale => {}
            }
            continue;
        }

        let request_spec = {
            let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
            with_live_generic_claim(&db, &item, |db| prepare_request(db, &item))?
        };
        let Some(request_spec) = request_spec else {
            continue;
        };

        let request_spec = match request_spec {
            RequestPreparation::Ready(spec) => spec,
            RequestPreparation::Consumed { reason } => {
                let applied = {
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    with_live_generic_claim(&db, &item, |db| {
                        mark_success(db, &item.id, item.claim_generation)
                    })?
                };
                if applied.is_some() {
                    processed += 1;
                    telemetry.record_success(&item);
                    info!(reason = %reason, "Parity item consumed locally");
                }
                continue;
            }
            RequestPreparation::Deferred { reason } => {
                let applied = {
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    with_live_generic_claim(&db, &item, |db| {
                        mark_deferred(db, &item.id, &reason, item.claim_generation)
                    })?
                };
                if applied.is_some() {
                    telemetry.record_deferred(&item, &reason);
                }
                continue;
            }
            RequestPreparation::ManualResolution { reason_code } => {
                let applied = {
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    with_live_generic_claim(&db, &item, |db| {
                        park_customer_phone_country_resolution(
                            db,
                            &item.id,
                            item.claim_generation,
                            &reason_code,
                        )
                    })?
                };
                if applied.is_some() {
                    conflicts += 1;
                    telemetry.record_error(&item, "conflict", &reason_code, None);
                    errors.push(safe_sync_error(&item, &reason_code, None));
                }
                continue;
            }
            RequestPreparation::Failed { reason } => {
                let applied = {
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    with_live_generic_claim(&db, &item, |db| {
                        let outcome = mark_failure_in_transaction(
                            db,
                            &item.id,
                            &reason,
                            item.claim_generation,
                        )?;
                        if !outcome.applied {
                            return Ok(outcome);
                        }
                        db.execute(
                            "UPDATE parity_sync_queue
                             SET status = 'failed'
                             WHERE id = ?1 AND claim_generation = ?2",
                            params![item.id, item.claim_generation],
                        )
                        .map_err(|e| format!("mark parity item permanently failed: {e}"))?;
                        Ok(outcome)
                    })?
                };
                if let Some(outcome) = applied {
                    if !outcome.applied {
                        continue;
                    }
                    if let Some(dl) = outcome.monetary_notice {
                        monetary_dead_letters.push(dl);
                    }
                    if outcome.transitioned_to_dead_letter {
                        dead_lettered += 1;
                    }
                    failed += 1;
                    telemetry.record_error(&item, "failed", &reason, None);
                    errors.push(safe_sync_error(&item, &reason, None));
                }
                continue;
            }
        };

        let url = format!(
            "{}{}",
            api_base_url.trim_end_matches('/'),
            request_spec.endpoint
        );

        let mut request = client
            .request(request_spec.method.clone(), &url)
            .header("x-pos-api-key", api_key)
            .header("x-terminal-id", request_spec.terminal_id.as_str())
            .header("Content-Type", "application/json");

        // Entity-keyed replay headers: po_receipts sends its stored
        // capture-time key as `Idempotency-Key` so retries are exactly-once
        // server-side (procurement-loop Task 10.3, R11.4).
        if let Some((name, value)) = replay_idempotency_header(&item) {
            request = request.header(name, value);
        }

        if let Some(body) = request_spec.body.as_ref() {
            request = request.body(body.clone());
        }

        let response = request.send().await;

        match response {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let is_success = resp.status().is_success();
                let retry_after_secs = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.trim().parse::<i64>().ok())
                    .filter(|value| *value > 0)
                    .unwrap_or(DEFAULT_RATE_LIMIT_RETRY_SECS);
                let response_body = resp.text().await.unwrap_or_default();
                let response_json = serde_json::from_str::<Value>(&response_body).ok();
                {
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    if !is_live_generic_claim(&db, &item)? {
                        continue;
                    }
                }

                if let Some(failure) = parse_parity_terminal_auth_failure(status, &response_body) {
                    let parked = {
                        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                        with_live_generic_claim(&db, &item, |db| {
                            mark_terminal_auth_pending(db, &item, failure)
                        })?
                    };
                    if parked.is_some() {
                        merge_auth_outcome(&mut auth_outcome, ParityAuthOutcome::terminal(failure));
                        telemetry.record_error(&item, "pending", "terminal_auth", Some(status));
                        break;
                    }
                    continue;
                }
                if is_success {
                    // Success -- remove from queue
                    let applied = {
                        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                        with_live_generic_claim(&db, &item, |db| {
                            apply_success(db, &item, response_json.as_ref())?;
                            mark_success(db, &item.id, item.claim_generation)
                        })?
                    };
                    if applied.is_some() {
                        processed += 1;
                        telemetry.record_success(&item);
                    }
                } else if is_parent_order_wait_response(status, &response_body) {
                    let reason = "Waiting for parent order sync";
                    let marked = {
                        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                        with_live_generic_claim(&db, &item, |db| {
                            mark_deferred(db, &item.id, reason, item.claim_generation)
                        })?
                    };
                    if marked.is_some() {
                        telemetry.record_deferred(&item, reason);
                    }
                } else if is_table_session_close_waiting_payment_response(
                    status,
                    &response_body,
                    &item,
                ) {
                    let reason = "Waiting for table payment sync";
                    let marked = {
                        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                        with_live_generic_claim(&db, &item, |db| {
                            mark_deferred(db, &item.id, reason, item.claim_generation)
                        })?
                    };
                    if marked.is_some() {
                        telemetry.record_deferred(&item, reason);
                    }
                } else if let Some(missing_modules) =
                    parse_module_required_response(status, &response_body)
                {
                    // THE-306 gating sweep item 3: fail closed, queue
                    // retained. Without this branch a MODULE_REQUIRED 403
                    // fell into the generic 4xx arm and dead-lettered the
                    // row permanently — re-acquiring the module could never
                    // drain it.
                    let reason = if missing_modules.is_empty() {
                        "MODULE_REQUIRED: organization has not acquired this item's module"
                            .to_string()
                    } else {
                        format!(
                            "MODULE_REQUIRED: organization is missing module(s): {missing_modules}"
                        )
                    };
                    let marked = {
                        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                        with_live_generic_claim(&db, &item, |db| {
                            mark_module_required(db, &item.id, &reason, item.claim_generation)
                        })?
                    };
                    if marked.is_some() {
                        telemetry.record_deferred(&item, "module_required");
                        warn!(
                            module_count = missing_modules
                                .split(',')
                                .filter(|part| !part.trim().is_empty())
                                .count(),
                            "Parity item parked pending module acquisition"
                        );
                    }
                } else if is_replay_conflict_response(status, &response_body, &item) {
                    {
                        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                        if !is_live_generic_claim(&db, &item)? {
                            continue;
                        }
                    }
                    // A renderer exact-item retry is a single-request
                    // operation. Its authoritative conflict response is
                    // sufficient to park/classify the selected row; a lookup
                    // would violate the one-item/one-request recovery fence.
                    let server_record = if exact_renderer_item {
                        None
                    } else {
                        fetch_server_record(
                            &client,
                            api_base_url,
                            api_key,
                            request_spec.terminal_id.as_str(),
                            &item,
                        )
                        .await
                    };
                    let server_version =
                        derive_server_version(server_record.as_ref(), &response_body, item.version);
                    let is_monetary = is_monetary_item(&item);
                    let resolution = match item.conflict_strategy.as_str() {
                        "manual" => "manual",
                        "client-wins" => "client-wins",
                        _ if is_monetary => "server-wins",
                        _ => "auto-server-wins",
                    };
                    let requires_operator_review =
                        resolution == "manual" || resolution == "client-wins" || is_monetary;

                    let applied = {
                        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                        with_live_generic_claim(&db, &item, |db| {
                            log_conflict(
                                db,
                                &item.operation,
                                &item.record_id,
                                &item.table_name,
                                item.version,
                                server_version,
                                &item.data,
                                resolution,
                                is_monetary,
                                false,
                            )?;
                            if requires_operator_review {
                                mark_conflict(db, &item.id, item.claim_generation)
                            } else {
                                mark_success(db, &item.id, item.claim_generation)
                            }
                        })?
                    };
                    if applied.is_none() {
                        continue;
                    }

                    if requires_operator_review {
                        conflicts += 1;
                        let error_message = format!(
                            "Conflict detected (HTTP {status}) requiring review: {}",
                            resolution
                        );
                        telemetry.record_error(&item, "conflict", &error_message, Some(status));
                        errors.push(safe_sync_error(&item, &error_message, Some(status)));
                    } else {
                        processed += 1;
                        telemetry.record_outcome(&item, "processed", "conflict_auto_resolved");
                    }
                } else if status == 429 {
                    let error_message = "HTTP_429_RATE_LIMITED".to_string();
                    let marked = {
                        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                        with_live_generic_claim(&db, &item, |db| {
                            mark_rate_limited(
                                db,
                                &item.id,
                                &error_message,
                                retry_after_secs,
                                item.claim_generation,
                            )
                        })?
                    };
                    if marked.is_some() {
                        failed += 1;
                        telemetry.record_error(&item, "pending", &error_message, Some(status));
                        errors.push(safe_sync_error(&item, &error_message, Some(status)));
                        warn!(
                            retry_after_secs = retry_after_secs,
                            "Parity sync hit admin rate limiting; pausing the batch"
                        );
                        break;
                    }
                } else if (400..500).contains(&status) {
                    // Client error (not retriable)
                    let detailed_error = format!("HTTP {status}: {response_body}");
                    let error_code = format!("HTTP_{status}_CLIENT_ERROR");
                    let resolved_at = Utc::now().to_rfc3339();
                    let outcome = {
                        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                        with_live_generic_claim(&db, &item, |db| {
                            if resolve_live_payment_total_conflict_with_conn(
                                db,
                                &item,
                                detailed_error.as_str(),
                                resolved_at.as_str(),
                            )? {
                                return Ok((true, None));
                            }
                            let failure = mark_failure_in_transaction(
                                db,
                                &item.id,
                                &error_code,
                                item.claim_generation,
                            )?;
                            if !failure.applied {
                                return Ok((false, Some(failure)));
                            }
                            db.execute(
                                "UPDATE parity_sync_queue
                                 SET status = 'failed'
                                 WHERE id = ?1 AND claim_generation = ?2",
                                params![item.id, item.claim_generation],
                            )
                            .map_err(|e| format!("mark client error failed: {e}"))?;
                            Ok((false, Some(failure)))
                        })?
                    };
                    let Some((resolved, failure)) = outcome else {
                        continue;
                    };
                    if resolved {
                        processed += 1;
                        telemetry.record_outcome(&item, "processed", "payment_total_auto_repaired");
                        continue;
                    }
                    let Some(failure) = failure else {
                        continue;
                    };
                    if !failure.applied {
                        continue;
                    }
                    if let Some(dl) = failure.monetary_notice {
                        monetary_dead_letters.push(dl);
                    }
                    if failure.transitioned_to_dead_letter {
                        dead_lettered += 1;
                    }
                    failed += 1;
                    telemetry.record_error(&item, "failed", &error_code, Some(status));
                    errors.push(safe_sync_error(&item, &error_code, Some(status)));
                } else {
                    // Server error (retriable)
                    // Legacy fallbacks intentionally remain available to the
                    // full/background drain, but an exact renderer retry may
                    // issue only its one selected request.
                    let fallback_specs = if exact_renderer_item {
                        Vec::new()
                    } else {
                        legacy_order_update_retry_specs(
                            &item,
                            &request_spec,
                            status,
                            &response_body,
                        )
                    };
                    let mut fallback_processed = false;
                    let mut stale_fallback_claim = false;
                    for (fallback_outcome, fallback_spec) in fallback_specs {
                        {
                            let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                            if !is_live_generic_claim(&db, &item)? {
                                stale_fallback_claim = true;
                                break;
                            }
                        }
                        let fallback_url = format!(
                            "{}{}",
                            api_base_url.trim_end_matches('/'),
                            fallback_spec.endpoint
                        );
                        let mut fallback_request = client
                            .request(fallback_spec.method.clone(), &fallback_url)
                            .header("x-pos-api-key", api_key)
                            .header("x-terminal-id", fallback_spec.terminal_id.as_str())
                            .header("Content-Type", "application/json");

                        if let Some(body) = fallback_spec.body.as_ref() {
                            fallback_request = fallback_request.body(body.clone());
                        }

                        match fallback_request.send().await {
                            Ok(fallback_resp) => {
                                let fallback_status = fallback_resp.status().as_u16();
                                let fallback_is_success = fallback_resp.status().is_success();
                                let fallback_body = fallback_resp.text().await.unwrap_or_default();
                                let fallback_json =
                                    serde_json::from_str::<Value>(&fallback_body).ok();

                                if fallback_is_success {
                                    let applied = {
                                        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                                        with_live_generic_claim(&db, &item, |db| {
                                            apply_success(db, &item, fallback_json.as_ref())?;
                                            mark_success(db, &item.id, item.claim_generation)
                                        })?
                                    };
                                    if applied.is_some() {
                                        processed += 1;
                                        telemetry.record_outcome(
                                            &item,
                                            "processed",
                                            fallback_outcome,
                                        );
                                        fallback_processed = true;
                                    } else {
                                        stale_fallback_claim = true;
                                    }
                                    break;
                                }

                                warn!(
                                    first_status = status,
                                    fallback_status = fallback_status,
                                    fallback_outcome = fallback_outcome,
                                    "Legacy order update fallback did not succeed"
                                );
                            }
                            Err(_) => {
                                warn!(
                                    error_class = "network",
                                    fallback_outcome = fallback_outcome,
                                    "Legacy order update fallback hit a network error"
                                );
                            }
                        }
                    }
                    if fallback_processed {
                        continue;
                    }
                    if stale_fallback_claim {
                        continue;
                    }

                    let error_code = format!("HTTP_{status}_SERVER_ERROR");
                    let failure = {
                        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                        with_live_generic_claim(&db, &item, |db| {
                            mark_failure_in_transaction(
                                db,
                                &item.id,
                                &error_code,
                                item.claim_generation,
                            )
                        })?
                    };
                    let Some(failure) = failure else {
                        continue;
                    };
                    if !failure.applied {
                        continue;
                    }
                    if let Some(dl) = failure.monetary_notice {
                        monetary_dead_letters.push(dl);
                    }
                    if failure.transitioned_to_dead_letter {
                        dead_lettered += 1;
                    }
                    failed += 1;
                    telemetry.record_error(&item, "failed", &error_code, Some(status));
                    errors.push(safe_sync_error(&item, &error_code, Some(status)));
                }
            }
            Err(_) => {
                // Network error (retriable)
                let error_code = "NETWORK_ERROR".to_string();
                let failure = {
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    with_live_generic_claim(&db, &item, |db| {
                        mark_failure_in_transaction(
                            db,
                            &item.id,
                            &error_code,
                            item.claim_generation,
                        )
                    })?
                };
                let Some(failure) = failure else {
                    continue;
                };
                if !failure.applied {
                    continue;
                }
                if let Some(dl) = failure.monetary_notice {
                    monetary_dead_letters.push(dl);
                }
                if failure.transitioned_to_dead_letter {
                    dead_lettered += 1;
                }
                failed += 1;
                telemetry.record_error(&item, "failed", &error_code, None);
                errors.push(safe_sync_error(&item, &error_code, None));
            }
        }
    }

    let success = failed == 0
        && conflicts == 0
        && quarantined == 0
        && dead_lettered == 0
        && auth_outcome.is_none()
        && batch_block.is_none();
    let telemetry = {
        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
        telemetry.finish(&db, processed, failed, conflicts, visibility)?
    };

    Ok(SyncResult {
        success,
        processed,
        failed,
        conflicts,
        quarantined,
        dead_lettered,
        errors,
        monetary_dead_letters,
        auth_outcome,
        batch_block,
        telemetry,
    })
}

/// Map a queue item's module type to the appropriate admin API endpoint.
fn resolve_endpoint(item: &SyncQueueItem) -> String {
    if matches!(item.table_name.as_str(), "payments" | "payment_adjustments") {
        return resolve_financial_endpoint(item);
    }

    if let Some(endpoint) = resolve_special_entity_endpoint(item) {
        return endpoint;
    }

    match item.module_type.as_str() {
        "orders" => resolve_orders_endpoint(item),
        "customers" => resolve_customers_endpoint(item),
        "shifts" => "/api/pos/shifts/sync".to_string(),
        "financial" => "/api/pos/financial/sync".to_string(),
        "z_report" => "/api/pos/z-report/submit".to_string(),
        "loyalty" => "/api/pos/loyalty/sync".to_string(),
        // T21 (fiscalization-core THE-194): rows enqueued by
        // `fiscal::dispatcher::enqueue_for_order` go to the generic admin
        // submit endpoint, where the server-side FiscalReceiptDispatcher
        // (Req 12 — fiscalization is optional) returns HTTP 200 +
        // status='skipped' when no plugin is configured for the branch,
        // so an unset deployment cannot block the queue.
        "fiscal" => "/api/plugins/fiscal/submit".to_string(),
        _ => resolve_generic_endpoint(item),
    }
}

fn resolve_special_entity_endpoint(item: &SyncQueueItem) -> Option<String> {
    match item.table_name.as_str() {
        "inventory_adjustments" => Some("/api/pos/inventory".to_string()),
        "coupons" => Some(match item.operation.as_str() {
            "INSERT" => "/api/pos/coupons".to_string(),
            _ => format!("/api/pos/coupons/{}", item.record_id),
        }),
        "menu_categories" => Some(format!("/api/pos/sync/menu_categories/{}", item.record_id)),
        "menu_subcategories" => Some(format!("/api/pos/sync/subcategories/{}", item.record_id)),
        "menu_ingredients" => Some(format!("/api/pos/sync/ingredients/{}", item.record_id)),
        "menu_combos" => Some(format!("/api/menu/combos/{}", item.record_id)),
        "reservations" => Some(match item.operation.as_str() {
            "INSERT" => "/api/pos/reservations".to_string(),
            _ => format!("/api/pos/reservations/{}", item.record_id),
        }),
        "appointments" => Some(match item.operation.as_str() {
            "INSERT" => "/api/pos/appointments".to_string(),
            _ => format!("/api/pos/appointments/{}/status", item.record_id),
        }),
        "restaurant_table_sessions" => Some(match item.operation.as_str() {
            "INSERT" => "/api/pos/table-sessions".to_string(),
            _ => format!("/api/pos/table-sessions/{}", item.record_id),
        }),
        "restaurant_table_session_item_transfers" => {
            let payload = serde_json::from_str::<Value>(&item.data).unwrap_or(Value::Null);
            let session_id = string_field(
                &payload,
                &[
                    "source_session_id",
                    "table_session_id",
                    "tableSessionId",
                    "session_id",
                ],
            )
            .unwrap_or_else(|| item.record_id.clone());
            Some(format!(
                "/api/pos/table-sessions/{}/items/transfer",
                session_id
            ))
        }
        "restaurant_tables" => Some(format!("/api/pos/tables/{}", item.record_id)),
        "salon_staff_shifts" => Some("/api/pos/staff-schedule".to_string()),
        "drive_thru_orders" => Some("/api/pos/drive-through".to_string()),
        "rooms" => Some(format!("/api/pos/rooms/{}", item.record_id)),
        "room_checkins" => {
            // record_id is the client_request_id replay key, not the room —
            // the target room travels inside the queued capture payload.
            let payload = serde_json::from_str::<Value>(&item.data).unwrap_or(Value::Null);
            let room_id = string_field(&payload, &["room_id", "roomId"])
                .unwrap_or_else(|| item.record_id.clone());
            Some(format!("/api/pos/rooms/{room_id}/checkin"))
        }
        "po_receipts" => {
            // record_id is the capture-time idempotency key, not the PO —
            // the target purchase order travels inside the queued payload.
            let payload = serde_json::from_str::<Value>(&item.data).unwrap_or(Value::Null);
            let po_id = string_field(&payload, &["purchase_order_id", "purchaseOrderId"])
                .unwrap_or_else(|| item.record_id.clone());
            Some(format!("/api/pos/purchase-orders/{po_id}/receipts"))
        }
        // record_id is the capture id (also the replay key); the invoice
        // itself travels inside the queued payload.
        "supplier_import_commits" => Some("/api/pos/suppliers/import/commit".to_string()),
        "products" => Some(format!("/api/pos/products/{}", item.record_id)),
        _ => None,
    }
}

fn resolve_http_method(item: &SyncQueueItem) -> Method {
    match item.operation.as_str() {
        "UPDATE" => Method::PATCH,
        "DELETE" => Method::DELETE,
        _ => Method::POST,
    }
}

fn is_legacy_order_update_generic_failure(
    item: &SyncQueueItem,
    request_spec: &RequestSpec,
    status: u16,
    response_body: &str,
) -> bool {
    if status != 500
        || item.table_name != "orders"
        || item.operation != "UPDATE"
        || request_spec.method != Method::PATCH
        || request_spec.endpoint != "/api/pos/orders"
    {
        return false;
    }

    let lower_body = response_body.to_lowercase();
    lower_body.contains("failed to update order") && !lower_body.contains("\"details\"")
}

fn legacy_order_update_without_items_retry_spec(request_spec: &RequestSpec) -> Option<RequestSpec> {
    let body_raw = request_spec.body.as_ref()?;
    let mut body = serde_json::from_str::<Value>(body_raw).ok()?;
    let body_obj = body.as_object_mut()?;
    body_obj.remove("items")?;

    Some(RequestSpec {
        body: Some(Value::Object(body_obj.clone()).to_string()),
        ..request_spec.clone()
    })
}

fn legacy_order_update_minimal_retry_spec(
    request_spec: &RequestSpec,
    include_payment_status: bool,
) -> Option<RequestSpec> {
    let body_raw = request_spec.body.as_ref()?;
    let body = serde_json::from_str::<Value>(body_raw).ok()?;
    let body_obj = body.as_object()?;
    let id = body_obj.get("id")?.clone();
    let status = body_obj.get("status")?.clone();

    let mut minimal = Map::new();
    minimal.insert("id".to_string(), id);
    minimal.insert("status".to_string(), status);
    if include_payment_status {
        let payment_status = body_obj.get("payment_status")?.clone();
        if !payment_status.is_null() {
            minimal.insert("payment_status".to_string(), payment_status);
        }
    }

    Some(RequestSpec {
        body: Some(Value::Object(minimal).to_string()),
        ..request_spec.clone()
    })
}

fn legacy_order_update_retry_specs(
    item: &SyncQueueItem,
    request_spec: &RequestSpec,
    status: u16,
    response_body: &str,
) -> Vec<(&'static str, RequestSpec)> {
    if !is_legacy_order_update_generic_failure(item, request_spec, status, response_body) {
        return Vec::new();
    }

    let mut specs = Vec::new();
    if let Some(spec) = legacy_order_update_without_items_retry_spec(request_spec) {
        specs.push(("legacy_order_update_without_items_retry", spec));
    }
    if let Some(spec) = legacy_order_update_minimal_retry_spec(request_spec, true) {
        specs.push(("legacy_order_update_minimal_retry", spec));
    }
    if let Some(spec) = legacy_order_update_minimal_retry_spec(request_spec, false) {
        specs.push(("legacy_order_update_status_only_retry", spec));
    }

    specs
}

fn resolve_orders_endpoint(item: &SyncQueueItem) -> String {
    match item.operation.as_str() {
        "INSERT" => "/api/pos/orders".to_string(),
        _ => "/api/pos/orders".to_string(),
    }
}

fn resolve_financial_endpoint(item: &SyncQueueItem) -> String {
    match item.table_name.as_str() {
        "payments" => "/api/pos/payments".to_string(),
        "payment_adjustments" => "/api/pos/payments/adjustments/sync".to_string(),
        "driver_earnings" | "driver_earning" | "shift_expenses" | "staff_payments" => {
            "/api/pos/financial/sync".to_string()
        }
        _ => "/api/pos/financial/sync".to_string(),
    }
}

fn extract_customer_id_from_sync_payload(item: &SyncQueueItem) -> Option<String> {
    serde_json::from_str::<Value>(&item.data)
        .ok()
        .and_then(|payload| {
            payload
                .get("customer_id")
                .or_else(|| payload.get("customerId"))
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
}

fn resolve_customers_endpoint(item: &SyncQueueItem) -> String {
    match item.table_name.as_str() {
        "customers" => match item.operation.as_str() {
            "INSERT" => "/api/pos/customers".to_string(),
            _ => format!("/api/pos/customers/{}", item.record_id),
        },
        "customer_addresses" => {
            if let Some(customer_id) = extract_customer_id_from_sync_payload(item) {
                match item.operation.as_str() {
                    "INSERT" => format!("/api/pos/customers/{customer_id}/addresses"),
                    _ => format!(
                        "/api/pos/customers/{customer_id}/addresses/{}",
                        item.record_id
                    ),
                }
            } else {
                resolve_generic_endpoint(item)
            }
        }
        _ => resolve_generic_endpoint(item),
    }
}

fn resolve_generic_endpoint(item: &SyncQueueItem) -> String {
    match item.operation.as_str() {
        "UPDATE" | "DELETE" => format!("/api/pos/sync/{}/{}", item.table_name, item.record_id),
        _ => format!("/api/pos/sync/{}", item.table_name),
    }
}

fn is_monetary_item(item: &SyncQueueItem) -> bool {
    let monetary_tables = [
        "payments",
        "payment_adjustments",
        "payment_transactions",
        "refund_transactions",
        "driver_earnings",
        "driver_earning",
    ];
    if monetary_tables.contains(&item.table_name.as_str()) {
        return true;
    }

    let monetary_fields = [
        "total",
        "subtotal",
        "tax",
        "discount_amount",
        "payment_amount",
        "refund_amount",
        "amount",
        "price",
        "unit_price",
        "order_total",
        "grand_total",
        "tip",
        "tip_amount",
    ];

    serde_json::from_str::<Value>(&item.data)
        .ok()
        .and_then(|payload| payload.as_object().cloned())
        .map(|payload| {
            payload
                .keys()
                .any(|key| monetary_fields.contains(&key.as_str()))
        })
        .unwrap_or(false)
}

async fn fetch_server_record(
    client: &reqwest::Client,
    api_base_url: &str,
    api_key: &str,
    terminal_id: &str,
    item: &SyncQueueItem,
) -> Option<Value> {
    let endpoint = format!(
        "{}/api/pos/sync/{}/{}",
        api_base_url.trim_end_matches('/'),
        item.table_name,
        item.record_id
    );

    let response = client
        .get(&endpoint)
        .header("x-pos-api-key", api_key)
        .header("x-terminal-id", terminal_id)
        .header("Content-Type", "application/json")
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let body = response.json::<Value>().await.ok()?;
    body.get("data").cloned().or(Some(body))
}

fn derive_server_version(
    server_record: Option<&Value>,
    conflict_body: &str,
    local_version: i64,
) -> i64 {
    let read_version = |value: &Value| -> Option<i64> {
        value
            .get("version")
            .and_then(|candidate| candidate.as_i64())
            .or_else(|| {
                value
                    .get("server_version")
                    .and_then(|candidate| candidate.as_i64())
            })
            .or_else(|| {
                value
                    .get("row_version")
                    .and_then(|candidate| candidate.as_i64())
            })
    };

    if let Some(record) = server_record {
        if let Some(version) = read_version(record) {
            return version;
        }
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(conflict_body) {
        if let Some(version) = read_version(&parsed) {
            return version;
        }
    }

    local_version + 1
}

// ---------------------------------------------------------------------------
// Use rusqlite::OptionalExtension for query_row returning Option
// ---------------------------------------------------------------------------
use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;
    use std::collections::HashMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    fn clear_terminal_identity() {
        // Tests must not mutate the shared OS keyring used by the live POS app.
    }

    const TEST_TERMINAL_ID: &str = "terminal-test";
    const TEST_BRANCH_ID: &str = "11111111-1111-1111-1111-111111111111";
    const TEST_MENU_ITEM_ID: &str = "22222222-2222-2222-2222-222222222222";

    fn seed_terminal_context(conn: &Connection) {
        crate::db::set_setting(conn, "terminal", "terminal_id", TEST_TERMINAL_ID)
            .expect("store terminal id");
        crate::db::set_setting(conn, "terminal", "branch_id", TEST_BRANCH_ID)
            .expect("store branch id");
    }

    fn seed_customer_cache(conn: &Connection, customer_id: &str, address: Value) {
        crate::db::set_setting(
            conn,
            "local",
            "customer_cache_v1",
            &json!([
                {
                    "id": customer_id,
                    "name": "Test Customer",
                    "addresses": [address]
                }
            ])
            .to_string(),
        )
        .expect("seed customer cache");
    }

    fn queue_item(
        table_name: &str,
        operation: &str,
        record_id: &str,
        data: Value,
    ) -> SyncQueueItem {
        SyncQueueItem {
            id: "queue-1".to_string(),
            table_name: table_name.to_string(),
            record_id: record_id.to_string(),
            operation: operation.to_string(),
            data: data.to_string(),
            organization_id: "org-1".to_string(),
            created_at: Utc::now().to_rfc3339(),
            attempts: 0,
            last_attempt: None,
            error_message: None,
            next_retry_at: None,
            retry_delay_ms: 1000,
            priority: 0,
            module_type: "customers".to_string(),
            conflict_strategy: "manual".to_string(),
            version: 1,
            claim_generation: 0,
            status: "pending".to_string(),
        }
    }

    #[derive(Debug, Clone)]
    struct CapturedRequest {
        request_line: String,
        headers: HashMap<String, String>,
        body: String,
    }

    #[derive(Debug, Clone)]
    struct MockResponse {
        status_code: u16,
        body: String,
    }

    impl MockResponse {
        fn json(status_code: u16, body: impl Into<String>) -> Self {
            Self {
                status_code,
                body: body.into(),
            }
        }
    }

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        create_tables(&conn).expect("create sync queue tables");
        crate::db::set_setting(&conn, "terminal", "__ignore_keyring", "1")
            .expect("disable keyring reads for sync_queue tests");
        conn
    }

    static RENDERER_RACE_WAITING_ON_WRITE: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);

    fn renderer_race_busy_handler(_attempt: i32) -> bool {
        RENDERER_RACE_WAITING_ON_WRITE.store(true, std::sync::atomic::Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(1));
        true
    }

    struct FileBackedTestDb {
        path: std::path::PathBuf,
    }

    #[derive(Clone, Default)]
    struct CapturedLogWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    struct CapturedLogGuard(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for CapturedLogGuard {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("lock captured log buffer")
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for CapturedLogWriter {
        type Writer = CapturedLogGuard;

        fn make_writer(&'writer self) -> Self::Writer {
            CapturedLogGuard(self.0.clone())
        }
    }

    impl CapturedLogWriter {
        fn contents(&self) -> String {
            String::from_utf8(self.0.lock().expect("lock captured log contents").clone())
                .expect("captured logs are UTF-8")
        }
    }

    impl FileBackedTestDb {
        fn new(label: &str) -> (Self, Connection) {
            let path = std::env::temp_dir().join(format!(
                "the-small-sync-queue-{label}-{}.sqlite",
                Uuid::new_v4()
            ));
            let conn = Connection::open(&path).expect("open file-backed test db");
            crate::db::run_migrations_for_test(&conn);
            create_tables(&conn).expect("create sync queue tables");
            conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
                .expect("enable WAL for deterministic writer race");
            (Self { path }, conn)
        }

        fn open_race_connection(&self) -> Connection {
            let conn = Connection::open(&self.path).expect("open race connection");
            conn.busy_handler(Some(renderer_race_busy_handler))
                .expect("install race busy handler");
            conn
        }
    }

    impl Drop for FileBackedTestDb {
        fn drop(&mut self) {
            for path in [
                self.path.clone(),
                std::path::PathBuf::from(format!("{}-wal", self.path.display())),
                std::path::PathBuf::from(format!("{}-shm", self.path.display())),
            ] {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    fn wait_until_renderer_write_is_blocked() {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !RENDERER_RACE_WAITING_ON_WRITE.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "renderer queue operation never reached its write boundary"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    fn full_queue_row_fingerprint(conn: &Connection, item_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT json_object(
                 'id', id,
                 'table_name', table_name,
                 'record_id', record_id,
                 'operation', operation,
                 'data', data,
                 'organization_id', organization_id,
                 'created_at', created_at,
                 'attempts', attempts,
                 'last_attempt', last_attempt,
                 'error_message', error_message,
                 'next_retry_at', next_retry_at,
                 'retry_delay_ms', retry_delay_ms,
                 'priority', priority,
                 'module_type', module_type,
                 'conflict_strategy', conflict_strategy,
                 'version', version,
                 'repair_aggregate_id', repair_aggregate_id,
                 'claim_generation', claim_generation,
                 'status', status
             )
             FROM parity_sync_queue
             WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .optional()
        .expect("fingerprint queue row")
    }

    fn full_order_payment_row_fingerprint(conn: &Connection, payment_id: &str) -> Option<String> {
        let columns = {
            let mut stmt = conn
                .prepare("PRAGMA table_info(order_payments)")
                .expect("prepare order_payments columns");
            stmt.query_map([], |row| row.get::<_, String>(1))
                .expect("query order_payments columns")
                .map(|row| row.expect("read order_payments column"))
                .collect::<Vec<_>>()
        };
        let quoted_columns = columns
            .iter()
            .map(|column| format!("\"{}\"", column.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        conn.query_row(
            &format!("SELECT {quoted_columns} FROM order_payments WHERE id = ?1"),
            params![payment_id],
            |row| {
                let mut fingerprint = Vec::with_capacity(columns.len());
                for (index, column) in columns.iter().enumerate() {
                    let value = match row.get_ref(index)? {
                        rusqlite::types::ValueRef::Null => "null".to_string(),
                        rusqlite::types::ValueRef::Integer(value) => format!("i:{value}"),
                        rusqlite::types::ValueRef::Real(value) => {
                            format!("r:{:016x}", value.to_bits())
                        }
                        rusqlite::types::ValueRef::Text(value) => {
                            format!("t:{}", String::from_utf8_lossy(value))
                        }
                        rusqlite::types::ValueRef::Blob(value) => format!(
                            "b:{}",
                            value
                                .iter()
                                .map(|byte| format!("{byte:02x}"))
                                .collect::<String>()
                        ),
                    };
                    fingerprint.push(format!("{column}={value}"));
                }
                Ok(fingerprint.join("|"))
            },
        )
        .optional()
        .expect("fingerprint order payment row")
    }

    fn full_table_rows_fingerprint(
        conn: &Connection,
        table_name: &str,
        id_prefix: &str,
    ) -> Vec<String> {
        assert!(
            matches!(
                table_name,
                "orders" | "order_payments" | "payment_adjustments" | "conflict_audit_log"
            ),
            "test helper table must be allowlisted"
        );
        let columns = {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info(\"{table_name}\")"))
                .expect("prepare table fingerprint columns");
            stmt.query_map([], |row| row.get::<_, String>(1))
                .expect("query table fingerprint columns")
                .map(|row| row.expect("read table fingerprint column"))
                .collect::<Vec<_>>()
        };
        let quoted_columns = columns
            .iter()
            .map(|column| format!("\"{}\"", column.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {quoted_columns} FROM \"{table_name}\"
                 WHERE id LIKE ?1 ORDER BY id"
            ))
            .expect("prepare full table fingerprint");
        stmt.query_map([format!("{id_prefix}%")], |row| {
            let mut fingerprint = Vec::with_capacity(columns.len());
            for (index, column) in columns.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    rusqlite::types::ValueRef::Null => "null".to_string(),
                    rusqlite::types::ValueRef::Integer(value) => format!("i:{value}"),
                    rusqlite::types::ValueRef::Real(value) => {
                        format!("r:{:016x}", value.to_bits())
                    }
                    rusqlite::types::ValueRef::Text(value) => {
                        format!("t:{}", String::from_utf8_lossy(value))
                    }
                    rusqlite::types::ValueRef::Blob(value) => format!(
                        "b:{}",
                        value
                            .iter()
                            .map(|byte| format!("{byte:02x}"))
                            .collect::<String>()
                    ),
                };
                fingerprint.push(format!("{column}={value}"));
            }
            Ok(fingerprint.join("|"))
        })
        .expect("query full table fingerprint")
        .map(|row| row.expect("read full table fingerprint row"))
        .collect()
    }

    #[derive(Debug)]
    struct SemanticMatrixGraph {
        order_remote_id: String,
        payment_id: String,
        adjustment_id: String,
    }

    fn seed_semantic_matrix_graph(
        conn: &Connection,
        prefix: &str,
        order_context: &str,
    ) -> SemanticMatrixGraph {
        let order_id = format!("{prefix}-order");
        let order_remote_id = format!("{prefix}-order-remote");
        let payment_id = format!("{prefix}-payment");
        let adjustment_id = format!("{prefix}-adjustment");
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, status, sync_status,
                 order_context, created_at, updated_at
             ) VALUES (?1, ?2, '[]', 9.50, 'ready', 'synced', ?3,
                       '2026-08-26T07:00:00Z', '2026-08-26T07:00:00Z')",
            params![order_id, order_remote_id, order_context],
        )
        .expect("seed semantic matrix order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, currency, status,
                 sync_status, sync_state, created_at, updated_at
             ) VALUES (?1, ?2, 'cash', 9.50, 950, 'EUR', 'completed',
                       'failed', 'failed', '2026-08-26T07:00:00Z',
                       '2026-08-26T07:00:00Z')",
            params![payment_id, order_id],
        )
        .expect("seed semantic matrix payment");
        conn.execute(
            "INSERT INTO payment_adjustments (
                 id, payment_id, order_id, adjustment_type, amount, reason,
                 sync_state, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'refund', 1.00,
                       'semantic matrix private adjustment', 'failed',
                       '2026-08-26T07:00:00Z', '2026-08-26T07:00:00Z')",
            params![adjustment_id, payment_id, order_id],
        )
        .expect("seed semantic matrix adjustment");
        SemanticMatrixGraph {
            order_remote_id,
            payment_id,
            adjustment_id,
        }
    }

    fn semantic_matrix_record_id<'a>(family: &str, graph: &'a SemanticMatrixGraph) -> &'a str {
        match family {
            "orders" => graph.order_remote_id.as_str(),
            "payments" | "order_payments" => graph.payment_id.as_str(),
            "payment_adjustments" => graph.adjustment_id.as_str(),
            _ => panic!("unsupported semantic matrix family: {family}"),
        }
    }

    fn seed_semantic_matrix_queue_row(
        conn: &Connection,
        queue_id: &str,
        table_name: &str,
        record_id: &str,
    ) {
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, last_attempt, error_message, retry_delay_ms,
                 priority, module_type, conflict_strategy, version,
                 claim_generation, status
             ) VALUES (?1, ?2, ?3, 'INSERT', ?4, 'semantic-matrix-org',
                       '2000-01-01T00:00:00Z', 3, '2000-01-01T00:00:00Z',
                       'semantic matrix private error', 64000, 100,
                       'semantic-matrix', 'manual', 7, 4, 'failed')",
            params![
                queue_id,
                table_name,
                record_id,
                format!("semantic-matrix-private-payload-{queue_id}")
            ],
        )
        .expect("seed semantic matrix queue row");
    }

    fn semantic_matrix_variants(value: &str) -> Vec<(&'static str, String)> {
        vec![
            ("exact", value.to_string()),
            ("uppercase", value.to_ascii_uppercase()),
            ("ascii-space", format!(" {value} ")),
            ("tab", format!("\t{value}\t")),
            ("nbsp", format!("\u{00a0}{value}\u{00a0}")),
            ("em-space", format!("\u{2003}{value}\u{2003}")),
        ]
    }

    fn enqueue_test_item(
        conn: &Connection,
        table_name: &str,
        operation: &str,
        record_id: &str,
        data: Value,
    ) -> String {
        enqueue(
            conn,
            &EnqueueInput {
                table_name: table_name.to_string(),
                record_id: record_id.to_string(),
                operation: operation.to_string(),
                data: data.to_string(),
                organization_id: "org-1".to_string(),
                priority: None,
                module_type: Some("customers".to_string()),
                conflict_strategy: Some("manual".to_string()),
                version: Some(1),
            },
        )
        .expect("enqueue test item")
    }

    fn capacity_enqueue_input(record_id: &str) -> EnqueueInput {
        EnqueueInput {
            table_name: "orders".to_string(),
            record_id: record_id.to_string(),
            operation: "INSERT".to_string(),
            data: "{}".to_string(),
            organization_id: "org-1".to_string(),
            priority: None,
            module_type: Some("orders".to_string()),
            conflict_strategy: Some("server-wins".to_string()),
            version: Some(1),
        }
    }

    /// Bulk-insert rows directly so capacity tests do not pay the
    /// per-`enqueue` capacity COUNT + info! log 5,000 times.
    fn insert_raw_queue_rows(conn: &Connection, count: i64, status: &str) {
        let now = Utc::now().to_rfc3339();
        let mut stmt = conn
            .prepare(
                "INSERT INTO parity_sync_queue
                    (id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, retry_delay_ms, priority, module_type,
                     conflict_strategy, version, status)
                 VALUES (?1, 'orders', ?2, 'INSERT', '{}', 'org-1', ?3, 0, 1000, 0,
                         'orders', 'server-wins', 1, ?4)",
            )
            .expect("prepare bulk queue insert");
        for index in 0..count {
            stmt.execute(params![
                Uuid::new_v4().to_string(),
                format!("rec-{status}-{index}"),
                now,
                status
            ])
            .expect("insert raw queue row");
        }
    }

    #[test]
    fn enqueue_rejects_when_replayable_rows_reach_raised_cap() {
        let conn = test_connection();
        insert_raw_queue_rows(&conn, MAX_QUEUE_SIZE - 1, "pending");

        // One slot left: the MAX_QUEUE_SIZE-th replayable row is accepted...
        enqueue_test_item(&conn, "orders", "INSERT", "last-slot", json!({}));

        // ...and the next is rejected fail-closed with the same queue-full
        // error contract callers roll transactions back on.
        let error = enqueue(&conn, &capacity_enqueue_input("over-cap"))
            .expect_err("enqueue past the replayable cap must fail closed");
        assert!(
            error.contains("Sync queue is full"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains(&format!("({MAX_QUEUE_SIZE}/{MAX_QUEUE_SIZE})")),
            "error should report usage against the raised cap: {error}"
        );
    }

    #[test]
    fn conflict_and_failed_rows_do_not_consume_replayable_capacity() {
        let conn = test_connection();
        // Replayable usage of MAX_QUEUE_SIZE - 1, split across both
        // replayable statuses to prove `processing` still counts.
        insert_raw_queue_rows(&conn, MAX_QUEUE_SIZE - 100, "pending");
        insert_raw_queue_rows(&conn, 99, "processing");
        // A pile of conflicts and dead-letters that previously squeezed
        // checkout capacity must no longer consume the final slot.
        insert_raw_queue_rows(&conn, 300, "conflict");
        insert_raw_queue_rows(&conn, 200, "failed");

        enqueue_test_item(&conn, "orders", "INSERT", "final-slot", json!({}));

        let error = enqueue(&conn, &capacity_enqueue_input("over-cap"))
            .expect_err("replayable rows alone must still enforce the cap");
        assert!(
            error.contains("Sync queue is full"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn enqueue_fails_closed_when_conflict_ceiling_is_reached() {
        let conn = test_connection();
        insert_raw_queue_rows(&conn, MAX_CONFLICT_ROWS - 1, "conflict");

        // Below the ceiling, conflicts never block domain writes.
        enqueue_test_item(&conn, "orders", "INSERT", "ok-below-ceiling", json!({}));

        insert_raw_queue_rows(&conn, 1, "conflict");
        let error = enqueue(&conn, &capacity_enqueue_input("conflict-wall"))
            .expect_err("enqueue at the conflict ceiling must fail closed");
        assert!(
            error.contains("conflict backlog is full"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains(&format!("({MAX_CONFLICT_ROWS}/{MAX_CONFLICT_ROWS})")),
            "error should report usage against the conflict ceiling: {error}"
        );
    }

    #[test]
    fn capacity_warning_fires_at_eighty_percent_of_replayable_cap() {
        let conn = test_connection();
        let threshold = MAX_QUEUE_SIZE * CAPACITY_WARNING_PERCENT / 100;
        insert_raw_queue_rows(&conn, threshold - 1, "pending");

        assert!(
            capacity_warning(&conn)
                .expect("inspect capacity below threshold")
                .is_none(),
            "no warning expected below the threshold"
        );

        insert_raw_queue_rows(&conn, 1, "pending");
        let warning = capacity_warning(&conn)
            .expect("inspect capacity at threshold")
            .expect("warning must fire at 80% of the replayable cap");
        assert_eq!(warning.replayable, threshold);
        assert_eq!(warning.max_replayable, MAX_QUEUE_SIZE);
        assert_eq!(warning.replayable_percent, CAPACITY_WARNING_PERCENT);
        assert_eq!(warning.conflicts, 0);
        assert_eq!(warning.max_conflicts, MAX_CONFLICT_ROWS);
    }

    #[test]
    fn capacity_warning_fires_at_eighty_percent_of_conflict_ceiling() {
        let conn = test_connection();
        let threshold = MAX_CONFLICT_ROWS * CAPACITY_WARNING_PERCENT / 100;
        insert_raw_queue_rows(&conn, threshold, "conflict");

        let warning = capacity_warning(&conn)
            .expect("inspect conflict capacity")
            .expect("warning must fire at 80% of the conflict ceiling");
        assert_eq!(warning.conflicts, threshold);
        assert_eq!(warning.conflict_percent, CAPACITY_WARNING_PERCENT);
        // A conflict-driven warning must not fabricate replayable pressure.
        assert_eq!(warning.replayable, 0);
    }

    #[test]
    fn generic_enqueue_rejects_every_semantic_reserved_repair_owner_without_mutation() {
        let conn = test_connection();
        let before_usage = capacity_usage(&conn).expect("read empty queue capacity");
        let variants = [
            (Some("REPAIRS"), "orders"),
            (Some(" repairs "), "orders"),
            (Some("\trepairs\r\n"), "orders"),
            (Some("\u{2003}repairs\u{2003}"), "orders"),
            (Some("orders"), "REPAIRS"),
            (Some("orders"), " repairs "),
            (Some("orders"), "\trepair_attachments\n"),
            (Some("orders"), "\u{2003}repair_attachments\u{2003}"),
        ];

        for (index, (module_type, table_name)) in variants.into_iter().enumerate() {
            let sentinel = format!("private-repair-like-payload-{index}");
            let error = enqueue(
                &conn,
                &EnqueueInput {
                    table_name: table_name.to_string(),
                    record_id: format!("reserved-owner-{index}"),
                    operation: "INSERT".to_string(),
                    data: sentinel.clone(),
                    organization_id: "reserved-owner-org".to_string(),
                    priority: Some(1),
                    module_type: module_type.map(str::to_string),
                    conflict_strategy: Some("server-wins".to_string()),
                    version: Some(1),
                },
            )
            .expect_err("semantic repair owner must require the native producer");
            assert_eq!(error, "REPAIR_NATIVE_PRODUCER_REQUIRED");
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue WHERE data = ?1",
                    [sentinel],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count rejected payload rows"),
                0,
                "rejected variant {index} mutated SQLite"
            );
            let after_usage = capacity_usage(&conn).expect("read capacity after rejection");
            assert_eq!(
                (after_usage.replayable, after_usage.conflicts),
                (before_usage.replayable, before_usage.conflicts),
                "rejected variant {index} consumed queue capacity"
            );
        }

        let generic_id = enqueue(
            &conn,
            &EnqueueInput {
                table_name: " CuStOmErS ".to_string(),
                record_id: "mixed-case-generic-control".to_string(),
                operation: "INSERT".to_string(),
                data: "{\"control\":true}".to_string(),
                organization_id: "mixed-case-generic-org".to_string(),
                priority: Some(1),
                module_type: Some(" OrDeRs ".to_string()),
                conflict_strategy: Some("server-wins".to_string()),
                version: Some(1),
            },
        )
        .expect("unrelated mixed-case identifiers preserve generic behavior");
        assert_eq!(
            conn.query_row(
                "SELECT table_name, module_type FROM parity_sync_queue WHERE id = ?1",
                [generic_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("read generic control row"),
            (" CuStOmErS ".to_string(), " OrDeRs ".to_string())
        );
    }

    async fn spawn_mock_http_server(
        responses: Vec<MockResponse>,
    ) -> (
        String,
        mpsc::UnboundedReceiver<CapturedRequest>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.expect("accept request");
                let captured = read_http_request(&mut stream).await;
                tx.send(captured).expect("send captured request");
                write_http_response(&mut stream, &response)
                    .await
                    .expect("write mock response");
            }
        });

        (format!("http://{}", address), rx, handle)
    }

    async fn spawn_blocked_first_response_server(
        first_response: MockResponse,
    ) -> (
        String,
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Sender<()>,
        tokio::task::JoinHandle<Vec<CapturedRequest>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind blocked-response server");
        let address = listener
            .local_addr()
            .expect("blocked-response server address");
        let (observed_tx, observed_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let (mut first_stream, _) = listener.accept().await.expect("accept first request");
            let first = read_http_request(&mut first_stream).await;
            observed_tx
                .send(())
                .expect("signal blocked first response observed");
            release_rx.await.expect("release blocked first response");
            write_http_response(&mut first_stream, &first_response)
                .await
                .expect("write blocked first response");

            let mut requests = vec![first];
            if let Ok(Ok((mut extra_stream, _))) =
                tokio::time::timeout(Duration::from_millis(500), listener.accept()).await
            {
                let extra = read_http_request(&mut extra_stream).await;
                write_http_response(
                    &mut extra_stream,
                    &MockResponse::json(
                        200,
                        r#"{"success":true,"data":{"id":"unexpected-follow-up"},"version":2}"#,
                    ),
                )
                .await
                .expect("write unexpected follow-up response");
                requests.push(extra);
            }
            requests
        });

        (format!("http://{address}"), observed_rx, release_tx, handle)
    }

    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> CapturedRequest {
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 4096];
        let mut header_end = None;
        let mut content_length = 0_usize;

        loop {
            let read = stream.read(&mut chunk).await.expect("read request");
            assert!(read > 0, "request closed before mock server read completed");
            buffer.extend_from_slice(&chunk[..read]);

            if header_end.is_none() {
                header_end = find_bytes(&buffer, b"\r\n\r\n");
                if let Some(index) = header_end {
                    let headers_text = String::from_utf8_lossy(&buffer[..index + 4]).to_string();
                    content_length = parse_content_length(&headers_text);
                }
            }

            if let Some(index) = header_end {
                let total_length = index + 4 + content_length;
                if buffer.len() >= total_length {
                    let request_text =
                        String::from_utf8(buffer[..total_length].to_vec()).expect("utf8 request");
                    return parse_request_text(&request_text);
                }
            }
        }
    }

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn parse_content_length(headers_text: &str) -> usize {
        headers_text
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0)
    }

    fn parse_request_text(request_text: &str) -> CapturedRequest {
        let mut sections = request_text.splitn(2, "\r\n\r\n");
        let header_block = sections.next().unwrap_or_default();
        let body = sections.next().unwrap_or_default().to_string();
        let mut header_lines = header_block.lines();
        let request_line = header_lines.next().unwrap_or_default().to_string();
        let headers = header_lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
            })
            .collect::<HashMap<_, _>>();

        CapturedRequest {
            request_line,
            headers,
            body,
        }
    }

    async fn write_http_response(
        stream: &mut tokio::net::TcpStream,
        response: &MockResponse,
    ) -> Result<(), std::io::Error> {
        let reason = match response.status_code {
            200 => "OK",
            401 => "Unauthorized",
            409 => "Conflict",
            _ => "OK",
        };
        let response_text = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response.status_code,
            reason,
            response.body.len(),
            response.body
        );
        stream.write_all(response_text.as_bytes()).await?;
        stream.flush().await
    }

    #[test]
    fn resolve_customers_endpoint_uses_customer_routes() {
        let insert_customer = queue_item(
            "customers",
            "INSERT",
            "cust-1",
            serde_json::json!({ "name": "Ada", "phone": "1234" }),
        );
        let update_customer = queue_item(
            "customers",
            "UPDATE",
            "cust-1",
            serde_json::json!({ "name": "Ada Lovelace" }),
        );
        let insert_address = queue_item(
            "customer_addresses",
            "INSERT",
            "addr-1",
            serde_json::json!({
                "customer_id": "cust-1",
                "street_address": "Main St 42"
            }),
        );
        let update_address = queue_item(
            "customer_addresses",
            "UPDATE",
            "addr-1",
            serde_json::json!({
                "customer_id": "cust-1",
                "notes": "Ring once"
            }),
        );

        assert_eq!(resolve_endpoint(&insert_customer), "/api/pos/customers");
        assert_eq!(
            resolve_endpoint(&update_customer),
            "/api/pos/customers/cust-1"
        );
        assert_eq!(
            resolve_endpoint(&insert_address),
            "/api/pos/customers/cust-1/addresses"
        );
        assert_eq!(
            resolve_endpoint(&update_address),
            "/api/pos/customers/cust-1/addresses/addr-1"
        );
    }

    #[test]
    fn resolve_customers_endpoint_falls_back_when_customer_id_missing() {
        let address_item = queue_item(
            "customer_addresses",
            "UPDATE",
            "addr-1",
            serde_json::json!({ "notes": "Ring once" }),
        );

        assert_eq!(
            resolve_endpoint(&address_item),
            "/api/pos/sync/customer_addresses/addr-1"
        );
    }

    #[test]
    fn prepare_customer_replay_preserves_explicit_non_greek_country_context() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let item = queue_item(
            "customers",
            "INSERT",
            "customer-de",
            json!({
                "name": "Berlin",
                "phone": "030 901820",
                "phone_country_code": "DE"
            }),
        );

        let RequestPreparation::Ready(spec) =
            prepare_request(&conn, &item).expect("prepare explicit country replay")
        else {
            panic!("explicit country replay must be ready")
        };
        let body: Value =
            serde_json::from_str(spec.body.as_deref().expect("body")).expect("parse body");
        assert_eq!(body["phone"], "030 901820");
        assert_eq!(body["phone_country_code"], "DE");
    }

    #[test]
    fn prepare_customer_replay_upgrades_legacy_international_without_country_guess() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let item = queue_item(
            "customers",
            "INSERT",
            "customer-intl",
            json!({ "name": "Berlin", "phone": "+49 30 901820" }),
        );

        let RequestPreparation::Ready(spec) =
            prepare_request(&conn, &item).expect("prepare legacy international replay")
        else {
            panic!("international replay must be ready")
        };
        let body: Value =
            serde_json::from_str(spec.body.as_deref().expect("body")).expect("parse body");
        assert_eq!(body["phone"], "+49 30 901820");
        assert_eq!(body.get("phone_country_code"), Some(&Value::Null));
    }

    #[test]
    fn prepare_customer_replay_parks_legacy_national_without_country() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let item = queue_item(
            "customers",
            "UPDATE",
            "customer-gb",
            json!({ "phone": "020 7946 0018", "version": 4 }),
        );

        match prepare_request(&conn, &item).expect("classify legacy national replay") {
            RequestPreparation::ManualResolution { reason_code } => {
                assert_eq!(reason_code, "CUSTOMER_PHONE_COUNTRY_CONTEXT_REQUIRED")
            }
            other => panic!("expected manual resolution, got {other:?}"),
        }
    }

    #[test]
    fn prepare_customer_replay_parks_unsupported_country_for_insert_and_update() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        for operation in ["INSERT", "UPDATE"] {
            let item = queue_item(
                "customers",
                operation,
                &format!("customer-zz-{operation}"),
                json!({
                    "name": "Unsupported context",
                    "phone": "020 7946 0018",
                    "phone_country_code": "ZZ"
                }),
            );

            match prepare_request(&conn, &item).expect("classify unsupported country replay") {
                RequestPreparation::ManualResolution { reason_code } => {
                    assert_eq!(reason_code, "CUSTOMER_PHONE_COUNTRY_CONTEXT_INVALID")
                }
                other => panic!("expected manual resolution, got {other:?}"),
            }
        }
    }

    #[test]
    fn customer_manual_resolution_parking_survives_reopen_and_is_not_requeued() {
        let path = std::env::temp_dir().join(format!(
            "the-small-customer-country-{}.sqlite",
            Uuid::new_v4()
        ));
        let item_id = {
            let conn = Connection::open(&path).expect("open queue database");
            crate::db::run_migrations_for_test(&conn);
            create_tables(&conn).expect("create queue tables");
            let id = enqueue_test_item(
                &conn,
                "customers",
                "INSERT",
                "legacy-national",
                json!({ "name": "Legacy", "phone": "020 7946 0018" }),
            );
            let claimed = dequeue(&conn).expect("dequeue").expect("claimed row");
            park_customer_phone_country_resolution(
                &conn,
                &claimed.id,
                claimed.claim_generation,
                "CUSTOMER_PHONE_COUNTRY_CONTEXT_REQUIRED",
            )
            .expect("park manual resolution");
            id
        };

        {
            let reopened = Connection::open(&path).expect("reopen queue database");
            assert!(dequeue(&reopened).expect("dequeue after restart").is_none());
            let (status, attempts, error): (String, i64, String) = reopened
                .query_row(
                    "SELECT status, attempts, error_message FROM parity_sync_queue WHERE id = ?1",
                    params![item_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("read parked row");
            assert_eq!(status, "conflict");
            assert_eq!(attempts, 0);
            assert_eq!(error, "CUSTOMER_PHONE_COUNTRY_CONTEXT_REQUIRED");
            assert!(!error.contains("020"));
        }

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unsupported_customer_country_parking_survives_reopen_without_pii() {
        let path = std::env::temp_dir().join(format!(
            "the-small-customer-unsupported-country-{}.sqlite",
            Uuid::new_v4()
        ));
        let item_id = {
            let conn = Connection::open(&path).expect("open queue database");
            crate::db::run_migrations_for_test(&conn);
            create_tables(&conn).expect("create queue tables");
            let id = enqueue_test_item(
                &conn,
                "customers",
                "UPDATE",
                "legacy-unsupported",
                json!({
                    "phone": "020 7946 0018",
                    "phone_country_code": "ZZ",
                    "version": 4
                }),
            );
            let claimed = dequeue(&conn).expect("dequeue").expect("claimed row");
            let RequestPreparation::ManualResolution { reason_code } =
                prepare_request(&conn, &claimed).expect("classify unsupported context")
            else {
                panic!("unsupported country must require manual resolution")
            };
            park_customer_phone_country_resolution(
                &conn,
                &claimed.id,
                claimed.claim_generation,
                &reason_code,
            )
            .expect("park manual resolution");
            id
        };

        {
            let reopened = Connection::open(&path).expect("reopen queue database");
            assert!(dequeue(&reopened).expect("dequeue after restart").is_none());
            let (status, attempts, error): (String, i64, String) = reopened
                .query_row(
                    "SELECT status, attempts, error_message FROM parity_sync_queue WHERE id = ?1",
                    params![item_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("read parked row");
            assert_eq!(status, "conflict");
            assert_eq!(attempts, 0);
            assert_eq!(error, "CUSTOMER_PHONE_COUNTRY_CONTEXT_INVALID");
            assert!(!error.contains("020"));
            assert!(!error.contains("ZZ"));
        }

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn customer_address_placeholder_ids_include_legacy_fallbacks() {
        assert!(is_local_placeholder_id(
            "legacy:08eaf112-25c4-4ae0-93c4-b8acd74d3e67"
        ));
        assert!(is_local_placeholder_id("LEGACY:customer-1"));
        assert!(!is_local_placeholder_id(
            "2ba6e969-99c7-42c8-a185-19b58e1e4531"
        ));
    }

    #[test]
    fn prepare_customer_address_request_recreates_placeholder_updates_from_cache() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        seed_customer_cache(
            &conn,
            "cust-1",
            json!({
                "id": "local-new",
                "street_address": "Main St 42",
                "city": "Athens",
                "coordinates": { "lat": 40.61, "lng": 22.95 }
            }),
        );

        let item = queue_item(
            "customer_addresses",
            "UPDATE",
            "local-new",
            json!({
                "customer_id": "cust-1",
                "coordinates": { "lat": 40.61, "lng": 22.95 },
                "latitude": 40.61,
                "longitude": 22.95
            }),
        );

        let request = match prepare_request(&conn, &item).expect("prepare request") {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        assert_eq!(request.endpoint, "/api/pos/customers/cust-1/addresses");
        assert_eq!(request.method, Method::POST);

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("street_address").and_then(Value::as_str),
            Some("Main St 42")
        );
        assert_eq!(body.get("id"), None);
        assert_eq!(
            body.get("customer_id").and_then(Value::as_str),
            Some("cust-1")
        );
    }

    #[test]
    fn prepare_customer_address_request_recreates_legacy_fallback_updates() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        seed_customer_cache(
            &conn,
            "cust-legacy",
            json!({
                "id": "legacy:cust-legacy",
                "street_address": "I. Kondylaki 10",
                "city": "Thessaloniki",
                "postal_code": "542 48",
                "floor_number": "3"
            }),
        );

        let item = queue_item(
            "customer_addresses",
            "UPDATE",
            "legacy:cust-legacy",
            json!({
                "customer_id": "cust-legacy",
                "street_address": "I. Kondylaki 10",
                "city": "Thessaloniki",
                "postal_code": "542 48",
                "floor_number": "3"
            }),
        );

        let request = match prepare_request(&conn, &item).expect("prepare request") {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        assert_eq!(request.endpoint, "/api/pos/customers/cust-legacy/addresses");
        assert_eq!(request.method, Method::POST);

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("street_address").and_then(Value::as_str),
            Some("I. Kondylaki 10")
        );
        assert_eq!(body.get("id"), None);
        assert_eq!(
            body.get("customer_id").and_then(Value::as_str),
            Some("cust-legacy")
        );
    }

    #[test]
    fn retry_failed_customer_address_not_found_items_requeues_placeholder_updates() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        seed_customer_cache(
            &conn,
            "cust-1",
            json!({
                "id": "local-new",
                "street_address": "Main St 42",
                "city": "Athens",
                "coordinates": { "lat": 40.61, "lng": 22.95 }
            }),
        );

        let queue_id = enqueue_test_item(
            &conn,
            "customer_addresses",
            "UPDATE",
            "local-new",
            json!({
                "customer_id": "cust-1",
                "coordinates": { "lat": 40.61, "lng": 22.95 }
            }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 error_message = ?1
             WHERE id = ?2",
            params![
                "HTTP 404: {\"success\":false,\"error\":\"Address not found\"}",
                queue_id.as_str()
            ],
        )
        .expect("seed failed customer address parity row");

        let result = retry_failed_customer_address_not_found_items_limited(&conn, 1)
            .expect("retry failed customer address rows");

        assert_eq!(result.retried, 1);

        let (status, payload): (String, String) = conn
            .query_row(
                "SELECT status, data FROM parity_sync_queue WHERE id = ?1",
                params![queue_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load updated queue row");
        assert_eq!(status, "pending");

        let payload = serde_json::from_str::<Value>(&payload).expect("parse updated payload");
        assert_eq!(
            payload.get("street_address").and_then(Value::as_str),
            Some("Main St 42")
        );
    }

    #[test]
    fn retry_failed_customer_address_not_found_items_requeues_legacy_fallback_updates() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        seed_customer_cache(
            &conn,
            "cust-legacy",
            json!({
                "id": "legacy:cust-legacy",
                "street_address": "I. Kondylaki 10",
                "city": "Thessaloniki"
            }),
        );

        let queue_id = enqueue_test_item(
            &conn,
            "customer_addresses",
            "UPDATE",
            "legacy:cust-legacy",
            json!({
                "customer_id": "cust-legacy",
                "street_address": "I. Kondylaki 10",
                "city": "Thessaloniki"
            }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 error_message = ?1
             WHERE id = ?2",
            params![
                "HTTP 404: {\"success\":false,\"error\":\"Address not found\"}",
                queue_id.as_str()
            ],
        )
        .expect("seed failed legacy customer address row");

        let result = retry_failed_customer_address_not_found_items_limited(&conn, 1)
            .expect("retry failed legacy customer address row");

        assert_eq!(result.retried, 1);

        let (status, payload): (String, String) = conn
            .query_row(
                "SELECT status, data FROM parity_sync_queue WHERE id = ?1",
                params![queue_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load repaired queue row");
        assert_eq!(status, "pending");

        let payload = serde_json::from_str::<Value>(&payload).expect("parse repaired payload");
        assert_eq!(
            payload.get("street_address").and_then(Value::as_str),
            Some("I. Kondylaki 10")
        );
    }

    #[test]
    fn prepare_customer_address_request_recreates_placeholder_updates_from_recent_order_fallback() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        seed_customer_cache(
            &conn,
            "cust-order-fallback",
            json!({
                "id": "local-new",
                "city": "Athens"
            }),
        );
        // W4e Step 0: dual-populate (12.5 → 1250).
        conn.execute(
            "INSERT INTO orders (
                id, customer_id, items, total_amount, total_amount_cents, status, sync_status,
                delivery_address, delivery_city, delivery_postal_code, delivery_floor,
                delivery_notes, name_on_ringer, created_at, updated_at
             ) VALUES (
                'ord-address-fallback', 'cust-order-fallback', '[]', 12.5, 1250, 'completed', 'synced',
                'Order Street 9', 'Athens', '11742', '2', 'Use side door', 'Papadopoulos',
                datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed recent order address fallback");

        let item = queue_item(
            "customer_addresses",
            "UPDATE",
            "local-new",
            json!({
                "customer_id": "cust-order-fallback",
                "city": "Athens"
            }),
        );

        let request = match prepare_request(&conn, &item).expect("prepare request") {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        assert_eq!(
            request.endpoint,
            "/api/pos/customers/cust-order-fallback/addresses"
        );
        assert_eq!(request.method, Method::POST);

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("street_address").and_then(Value::as_str),
            Some("Order Street 9")
        );
        assert_eq!(body.get("city").and_then(Value::as_str), Some("Athens"));
        assert_eq!(
            body.get("postal_code").and_then(Value::as_str),
            Some("11742")
        );
        assert_eq!(
            body.get("name_on_ringer").and_then(Value::as_str),
            Some("Papadopoulos")
        );
    }

    #[test]
    fn retry_failed_customer_address_missing_street_items_requeues_from_recent_order_fallback() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        seed_customer_cache(
            &conn,
            "cust-order-fallback",
            json!({
                "id": "local-new",
                "city": "Athens"
            }),
        );
        // W4e Step 0: dual-populate (8.4 → 840).
        conn.execute(
            "INSERT INTO orders (
                id, customer_id, items, total_amount, total_amount_cents, status, sync_status,
                delivery_address, delivery_city, delivery_postal_code, created_at, updated_at
             ) VALUES (
                'ord-address-fallback-2', 'cust-order-fallback', '[]', 8.4, 840, 'completed', 'synced',
                'Retry Street 5', 'Athens', '11743', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed order fallback");

        let queue_id = enqueue_test_item(
            &conn,
            "customer_addresses",
            "UPDATE",
            "local-new",
            json!({
                "customer_id": "cust-order-fallback",
                "city": "Athens"
            }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 error_message = ?1
             WHERE id = ?2",
            params![
                "Customer address recreate is missing street_address details",
                queue_id.as_str()
            ],
        )
        .expect("seed failed customer address recreate row");

        let result = retry_failed_customer_address_not_found_items_limited(&conn, 1)
            .expect("retry failed customer address rows");

        assert_eq!(result.retried, 1);

        let (status, payload): (String, String) = conn
            .query_row(
                "SELECT status, data FROM parity_sync_queue WHERE id = ?1",
                params![queue_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load updated queue row");
        assert_eq!(status, "pending");

        let payload = serde_json::from_str::<Value>(&payload).expect("parse updated payload");
        assert_eq!(
            payload.get("street_address").and_then(Value::as_str),
            Some("Retry Street 5")
        );
    }

    #[test]
    fn apply_success_updates_customer_address_cache_with_remote_id() {
        let conn = test_connection();
        seed_customer_cache(
            &conn,
            "cust-1",
            json!({
                "id": "local-new",
                "street_address": "Main St 42",
                "city": "Athens",
                "coordinates": { "lat": 40.61, "lng": 22.95 }
            }),
        );

        let item = queue_item(
            "customer_addresses",
            "UPDATE",
            "local-new",
            json!({
                "customer_id": "cust-1",
                "coordinates": { "lat": 40.61, "lng": 22.95 }
            }),
        );

        apply_success(
            &conn,
            &item,
            Some(&json!({
                "address": {
                    "id": "addr-remote-1",
                    "customer_id": "cust-1",
                    "street_address": "Main St 42",
                    "city": "Athens",
                    "coordinates": { "lat": 40.61, "lng": 22.95 },
                    "version": 2
                }
            })),
        )
        .expect("apply customer address success");

        let cache = crate::db::get_setting(&conn, "local", "customer_cache_v1")
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .expect("customer cache");
        let address_id = cache
            .get(0)
            .and_then(|customer| customer.get("addresses"))
            .and_then(Value::as_array)
            .and_then(|addresses| addresses.first())
            .and_then(|address| address.get("id"))
            .and_then(Value::as_str);

        assert_eq!(address_id, Some("addr-remote-1"));
    }

    #[test]
    fn apply_success_marks_z_report_applied() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, status, created_at, updated_at
             )
             VALUES ('shift-z', 'staff-z', 'Staff Z', 'cashier', 'branch-1', 'term-1',
                datetime('now'), 'closed', datetime('now'), datetime('now'))",
            [],
        )
        .expect("seed shift");
        conn.execute(
            "INSERT INTO z_reports (
                id, shift_id, branch_id, terminal_id, report_date, generated_at,
                sync_state, sync_retry_count, created_at, updated_at
             )
             VALUES ('z-local-1', 'shift-z', 'branch-1', 'term-1', '2026-04-27',
                datetime('now'), 'syncing', 2, datetime('now'), datetime('now'))",
            [],
        )
        .expect("seed z report");

        let item = queue_item(
            "z_reports",
            "INSERT",
            "z-local-1",
            json!({ "id": "z-local-1" }),
        );
        apply_success(&conn, &item, Some(&json!({ "success": true })))
            .expect("apply z-report success");

        let (sync_state, retry_count, last_error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT sync_state, sync_retry_count, sync_last_error
                 FROM z_reports
                 WHERE id = 'z-local-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("load z report");

        assert_eq!(sync_state, "applied");
        assert_eq!(retry_count, 0);
        assert!(last_error.is_none());
    }

    #[test]
    fn resolve_financial_endpoints_use_live_pos_routes() {
        let mut payment_item = queue_item(
            "payments",
            "INSERT",
            "payment-1",
            serde_json::json!({ "paymentId": "payment-1" }),
        );
        payment_item.module_type = "financial".to_string();

        let mut adjustment_item = queue_item(
            "payment_adjustments",
            "INSERT",
            "adj-1",
            serde_json::json!({ "adjustmentId": "adj-1" }),
        );
        adjustment_item.module_type = "financial".to_string();

        let mut driver_item = queue_item(
            "driver_earnings",
            "INSERT",
            "earning-1",
            serde_json::json!({ "id": "earning-1" }),
        );
        driver_item.module_type = "financial".to_string();

        assert_eq!(resolve_endpoint(&payment_item), "/api/pos/payments");
        assert_eq!(
            resolve_endpoint(&adjustment_item),
            "/api/pos/payments/adjustments/sync"
        );
        assert_eq!(resolve_endpoint(&driver_item), "/api/pos/financial/sync");
    }

    #[test]
    fn prepare_shift_request_wraps_staff_shift_payload_for_admin_sync_endpoint() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let mut item = queue_item(
            "staff_shifts",
            "INSERT",
            "shift-1",
            json!({
                "shiftId": "shift-1",
                "staffId": "staff-1",
                "branchId": TEST_BRANCH_ID,
                "terminalId": TEST_TERMINAL_ID,
                "roleType": "driver",
                "openingCash": 100.0,
                "checkInTime": "2026-04-27T16:01:35Z"
            }),
        );
        item.module_type = "shifts".to_string();

        let prepared = prepare_request(&conn, &item).expect("prepare shift request");
        let RequestPreparation::Ready(spec) = prepared else {
            panic!("shift request should be ready");
        };
        assert_eq!(spec.endpoint, "/api/pos/shifts/sync");
        assert_eq!(spec.method, Method::POST);

        let body: Value =
            serde_json::from_str(spec.body.as_deref().expect("body")).expect("json body");
        assert_eq!(body["terminal_id"], TEST_TERMINAL_ID);
        assert_eq!(body["branch_id"], TEST_BRANCH_ID);
        assert_eq!(body["events"][0]["event_type"], "shift_open");
        assert_eq!(body["events"][0]["shift_id"], "shift-1");
        assert_eq!(body["events"][0]["data"]["roleType"], "driver");
        assert!(
            body["events"][0]["idempotency_key"]
                .as_str()
                .unwrap_or_default()
                .ends_with(":insert"),
            "idempotency key should be operation-specific: {body}"
        );
    }

    #[test]
    fn prepare_shift_request_classifies_close_and_transfer_updates() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let mut close_item = queue_item(
            "staff_shifts",
            "UPDATE",
            "shift-close",
            json!({
                "shiftId": "shift-close",
                "branchId": TEST_BRANCH_ID,
                "terminalId": TEST_TERMINAL_ID,
                "checkOutTime": "2026-04-27T18:01:35Z"
            }),
        );
        close_item.module_type = "shifts".to_string();
        let close_body: Value = match prepare_request(&conn, &close_item).expect("prepare close") {
            RequestPreparation::Ready(spec) => {
                serde_json::from_str(spec.body.as_deref().expect("close body")).unwrap()
            }
            other => panic!("unexpected close prep: {other:?}"),
        };
        assert_eq!(close_body["events"][0]["event_type"], "shift_close");

        let mut transfer_item = queue_item(
            "staff_shifts",
            "UPDATE",
            "shift-transfer",
            json!({
                "shiftId": "shift-transfer",
                "branchId": TEST_BRANCH_ID,
                "terminalId": TEST_TERMINAL_ID,
                "isTransferPending": true
            }),
        );
        transfer_item.module_type = "shifts".to_string();
        let transfer_body: Value =
            match prepare_request(&conn, &transfer_item).expect("prepare transfer") {
                RequestPreparation::Ready(spec) => {
                    serde_json::from_str(spec.body.as_deref().expect("transfer body")).unwrap()
                }
                other => panic!("unexpected transfer prep: {other:?}"),
            };
        assert_eq!(transfer_body["events"][0]["event_type"], "shift_transfer");
    }

    #[test]
    fn resolve_special_entity_endpoints_use_live_routes() {
        let inventory_item = queue_item(
            "inventory_adjustments",
            "INSERT",
            "prod-1",
            serde_json::json!({ "product_id": "prod-1", "adjustment": 5 }),
        );
        let coupon_insert = queue_item(
            "coupons",
            "INSERT",
            "coupon-1",
            serde_json::json!({ "id": "coupon-1", "code": "SAVE10" }),
        );
        let coupon_update = queue_item(
            "coupons",
            "UPDATE",
            "coupon-1",
            serde_json::json!({ "id": "coupon-1", "is_active": false }),
        );
        let reservation_item = queue_item(
            "reservations",
            "UPDATE",
            "reservation-1",
            serde_json::json!({ "status": "confirmed" }),
        );
        let appointment_item = queue_item(
            "appointments",
            "UPDATE",
            "appointment-1",
            serde_json::json!({ "status": "completed" }),
        );
        let staff_shift_item = queue_item(
            "salon_staff_shifts",
            "INSERT",
            "shift-1",
            serde_json::json!({ "staff_id": "staff-1" }),
        );
        let drive_thru_item = queue_item(
            "drive_thru_orders",
            "UPDATE",
            "dto-1",
            serde_json::json!({ "status": "serving" }),
        );
        let room_item = queue_item(
            "rooms",
            "UPDATE",
            "room-101",
            serde_json::json!({ "status": "occupied" }),
        );
        let room_checkin_item = queue_item(
            "room_checkins",
            "INSERT",
            "5e0e7c6a-9f1d-4d5c-8a3b-2f4f6f8d9a1b",
            serde_json::json!({
                "room_id": "room-101",
                "guest_name": "Maria Papadopoulou",
                "client_request_id": "5e0e7c6a-9f1d-4d5c-8a3b-2f4f6f8d9a1b"
            }),
        );
        let product_item = queue_item(
            "products",
            "UPDATE",
            "product-1",
            serde_json::json!({ "quantity": 9 }),
        );
        let restaurant_table_item = queue_item(
            "restaurant_tables",
            "UPDATE",
            "table-1",
            serde_json::json!({ "status": "occupied" }),
        );

        assert_eq!(resolve_endpoint(&inventory_item), "/api/pos/inventory");
        assert_eq!(resolve_endpoint(&coupon_insert), "/api/pos/coupons");
        assert_eq!(
            resolve_endpoint(&coupon_update),
            "/api/pos/coupons/coupon-1"
        );
        assert_eq!(
            resolve_endpoint(&reservation_item),
            "/api/pos/reservations/reservation-1"
        );
        assert_eq!(
            resolve_endpoint(&appointment_item),
            "/api/pos/appointments/appointment-1/status"
        );
        assert_eq!(
            resolve_endpoint(&staff_shift_item),
            "/api/pos/staff-schedule"
        );
        assert_eq!(resolve_endpoint(&drive_thru_item), "/api/pos/drive-through");
        assert_eq!(resolve_endpoint(&room_item), "/api/pos/rooms/room-101");
        assert_eq!(
            resolve_endpoint(&room_checkin_item),
            "/api/pos/rooms/room-101/checkin",
            "room check-ins must target the payload's room, not the record_id replay key"
        );
        assert_eq!(
            resolve_endpoint(&product_item),
            "/api/pos/products/product-1"
        );
        assert_eq!(
            resolve_endpoint(&restaurant_table_item),
            "/api/pos/tables/table-1"
        );
    }

    #[test]
    fn prepare_order_request_normalizes_legacy_insert_payloads() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "INSERT",
            "order-legacy-1",
            json!({
                "clientOrderId": "client-order-1",
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentData": {
                    "method": "wallet"
                },
                "paymentStatus": "paid",
                "total": 15.75,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 2,
                    "price": 7.5,
                    "name": "Club Sandwich",
                    "notes": "No onions",
                    "customizations": [
                        {
                            "customizationId": "extra-cheese",
                            "name": "Extra Cheese"
                        }
                    ]
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        assert_eq!(request.endpoint, "/api/pos/orders");
        assert_eq!(request.method, Method::POST);
        assert_eq!(request.terminal_id, TEST_TERMINAL_ID);

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("client_order_id").and_then(Value::as_str),
            Some("client-order-1")
        );
        assert_eq!(
            body.get("branch_id").and_then(Value::as_str),
            Some(TEST_BRANCH_ID)
        );
        assert_eq!(
            body.get("order_type").and_then(Value::as_str),
            Some("pickup")
        );
        assert_eq!(
            body.get("payment_method").and_then(Value::as_str),
            Some("digital_wallet")
        );
        assert_eq!(
            body.get("payment_status").and_then(Value::as_str),
            Some("paid")
        );
        assert_eq!(
            body.get("total_amount").and_then(Value::as_f64),
            Some(15.75)
        );

        let items = body
            .get("items")
            .and_then(Value::as_array)
            .expect("items array");
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].get("menu_item_id").and_then(Value::as_str),
            Some(TEST_MENU_ITEM_ID)
        );
        assert_eq!(items[0].get("quantity").and_then(Value::as_i64), Some(2));
        assert_eq!(
            items[0].get("unit_price").and_then(Value::as_f64),
            Some(7.5)
        );
        assert_eq!(
            items[0].get("total_price").and_then(Value::as_f64),
            Some(15.0)
        );
        let customizations = items[0]
            .get("customizations")
            .and_then(Value::as_object)
            .expect("customizations object");
        assert_eq!(
            customizations.get("extra-cheese"),
            Some(&json!({
                "customizationId": "extra-cheese",
                "name": "Extra Cheese"
            }))
        );
    }

    #[test]
    fn prepare_order_request_recovers_missing_order_tip_from_completed_payment() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, subtotal, subtotal_cents,
                tip_amount, tip_amount_cents, status, order_type, payment_status,
                sync_status, branch_id, created_at, updated_at
             ) VALUES (
                'order-missing-tip',
                '[{\"menu_item_id\":\"00000000-0000-0000-0000-000000000001\",\"name\":\"Crepe\",\"quantity\":1,\"unit_price\":11.5,\"total_price\":11.5}]',
                12.0, 1200, 11.5, 1150,
                0.0, 0, 'pending', 'delivery', 'paid',
                'pending', ?1, datetime('now'), datetime('now')
             )",
            params![TEST_BRANCH_ID],
        )
        .expect("seed tipped order whose order payload lost the tip");
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, currency, status,
                tip_amount, tip_amount_cents, sync_status, sync_state,
                created_at, updated_at
             ) VALUES (
                'payment-missing-order-tip', 'order-missing-tip', 'card',
                12.0, 1200, 'EUR', 'completed',
                0.5, 50, 'pending', 'waiting_parent',
                datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed completed payment with durable tip");

        let item = queue_item(
            "orders",
            "INSERT",
            "order-missing-tip",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "delivery",
                "paymentMethod": "card",
                "paymentStatus": "paid",
                "totalAmount": 12.0,
                "subtotal": 11.5,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 11.5,
                    "name": "Crepe"
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare repaired tipped order request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");

        assert_eq!(body.get("tip_amount").and_then(Value::as_f64), Some(0.5));
        assert_eq!(
            body.get("tip_amount_cents").and_then(Value::as_i64),
            Some(50)
        );
        assert_eq!(
            body.get("total_amount_cents").and_then(Value::as_i64),
            Some(1200)
        );
        let repaired_tip_cents: i64 = conn
            .query_row(
                "SELECT tip_amount_cents FROM orders WHERE id = 'order-missing-tip'",
                [],
                |row| row.get(0),
            )
            .expect("read repaired local order tip");
        assert_eq!(repaired_tip_cents, 50);
    }

    #[test]
    fn prepare_order_request_preserves_string_table_numbers() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "INSERT",
            "order-table-t1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "dine-in",
                "paymentMethod": Value::Null,
                "paymentStatus": "pending",
                "tableNumber": "T1",
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 11.0,
                    "name": "Water"
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(body.get("table_number").and_then(Value::as_str), Some("T1"));
        assert_eq!(
            body.get("payment_method").and_then(Value::as_str),
            Some("cash"),
            "pending dine-in table saves keep payment_status pending but send a method for old admin validators"
        );
    }

    #[test]
    fn prepare_order_request_omits_empty_fiscal_receipt_number_on_insert() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "INSERT",
            "order-no-fiscal-receipt",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "paymentStatus": "pending",
                "fiscalReceiptNumber": Value::Null,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 8.5,
                    "name": "Toast"
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(body.get("fiscal_receipt_number"), None);
    }

    #[test]
    fn failed_table_number_type_rows_are_auto_retryable() {
        assert!(is_retryable_legacy_order_insert_error(
            "sync_queue load_local_order_insert_fallback: Invalid column type Text at index: 14, name: table_number"
        ));
    }

    #[test]
    fn failed_null_payment_method_order_rows_are_auto_retryable() {
        assert!(is_retryable_legacy_order_insert_error(
            "HTTP 400: {\"success\":false,\"error\":\"Validation failed\",\"details\":[{\"field\":\"payment_method\",\"message\":\"Expected 'cash' | 'card', received null\"}]}"
        ));
    }

    #[test]
    fn failed_missing_payment_method_order_rows_are_auto_retryable() {
        assert!(is_retryable_legacy_order_insert_error(
            "HTTP 400: {\"success\":false,\"error\":\"Validation failed\",\"details\":[{\"field\":\"payment_method\",\"message\":\"Required\"}]}"
        ));
    }

    #[test]
    fn failed_invalid_payment_method_order_rows_are_auto_retryable() {
        assert!(is_retryable_legacy_order_insert_error(
            "HTTP 400: {\"success\":false,\"error\":\"Validation failed\",\"details\":[{\"field\":\"payment_method\",\"message\":\"Invalid input\"}]}"
        ));
    }

    #[test]
    fn prepare_order_update_omits_pending_payment_method() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-table-update-pending-payment', 'remote-order-table-update-pending-payment',
                 '[]', 22.0, 2200, 'pending', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced table order");
        let item = queue_item(
            "orders",
            "UPDATE",
            "order-table-update-pending-payment",
            json!({
                "orderId": "order-table-update-pending-payment",
                "status": "pending",
                "orderType": "dine-in",
                "paymentMethod": "pending",
                "paymentStatus": "pending",
                "totalAmount": 22.0,
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("payment_status").and_then(Value::as_str),
            Some("pending")
        );
        assert_eq!(body.get("payment_method"), None);
    }

    #[test]
    fn prepare_order_request_forwards_fiscal_receipt_number_updates() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-fiscal-receipt', 'remote-order-fiscal-receipt',
                 '[]', 22.0, 2200, 'completed', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced fiscal order");
        let item = queue_item(
            "orders",
            "UPDATE",
            "order-fiscal-receipt",
            json!({
                "orderId": "order-fiscal-receipt",
                "status": "completed",
                "fiscalReceiptNumber": "FISC-000123",
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("fiscal_receipt_number").and_then(Value::as_str),
            Some("FISC-000123")
        );
    }

    #[test]
    fn prepare_order_update_omits_manual_items_for_legacy_admin_patch() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents,
                 subtotal, subtotal_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-table-manual-update', 'remote-order-table-manual-update',
                 '[]', 22.0, 2200, 22.0, 2200, 'pending', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced table order");
        let item = queue_item(
            "orders",
            "UPDATE",
            "order-table-manual-update",
            json!({
                "orderId": "order-table-manual-update",
                "status": "pending",
                "orderType": "dine-in",
                "paymentStatus": "pending",
                "subtotal": 22.0,
                "subtotal_cents": 2200,
                "totalAmount": 22.0,
                "total_amount_cents": 2200,
                "items": [{
                    "menuItemId": Value::Null,
                    "menu_item_id": Value::Null,
                    "quantity": 2,
                    "unit_price": 11.0,
                    "total_price": 22.0,
                    "name": "Manual item",
                    "customizations": []
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(body.get("items"), None);
        assert_eq!(body.get("total_amount").and_then(Value::as_f64), Some(22.0));
        assert_eq!(
            body.get("total_amount_cents").and_then(Value::as_i64),
            Some(2200)
        );
        assert_eq!(body.get("subtotal").and_then(Value::as_f64), Some(22.0));
        assert_eq!(
            body.get("subtotal_cents").and_then(Value::as_i64),
            Some(2200)
        );
        assert_eq!(
            body.get("payment_status").and_then(Value::as_str),
            Some("pending")
        );
        assert_eq!(body.get("status").and_then(Value::as_str), Some("pending"));
    }

    #[test]
    fn prepare_order_update_sends_discounted_menu_items_as_pre_discount_lines() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents,
                 subtotal, subtotal_cents, status, payment_status, sync_status,
                 created_at, updated_at
             ) VALUES (
                 'order-discounted-menu-update', 'remote-order-discounted-menu-update',
                 '[]', 29.4, 2940, 31.5, 3150, 'pending', 'paid', 'synced',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced discounted menu order");
        let item = queue_item(
            "orders",
            "UPDATE",
            "order-discounted-menu-update",
            json!({
                "orderId": "order-discounted-menu-update",
                "status": "pending",
                "paymentStatus": "paid",
                "discountAmount": 2.1,
                "discountAmountCents": 210,
                "subtotal": 31.5,
                "subtotalCents": 3150,
                "totalAmount": 29.4,
                "totalAmountCents": 2940,
                "items": [
                    {
                        "menu_item_id": TEST_MENU_ITEM_ID,
                        "quantity": 1,
                        "unit_price": 18.9,
                        "total_price": 18.9,
                        "original_unit_price": 21.0,
                        "is_price_overridden": true,
                        "name": "Prosciutto Pizza"
                    },
                    {
                        "menu_item_id": "33333333-3333-3333-3333-333333333333",
                        "quantity": 1,
                        "unit_price": 10.5,
                        "total_price": 10.5,
                        "name": "Chocolate Fondant"
                    }
                ]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(body.get("subtotal").and_then(Value::as_f64), Some(31.5));
        assert_eq!(body.get("total_amount").and_then(Value::as_f64), Some(29.4));
        assert_eq!(
            body.get("discount_amount").and_then(Value::as_f64),
            Some(2.1)
        );

        let items = body
            .get("items")
            .and_then(Value::as_array)
            .expect("items should be forwarded");
        assert_eq!(
            items[0].get("unit_price").and_then(Value::as_f64),
            Some(21.0)
        );
        assert_eq!(
            items[0].get("total_price").and_then(Value::as_f64),
            Some(21.0)
        );
        assert_eq!(
            items[0].get("original_unit_price").and_then(Value::as_f64),
            Some(21.0)
        );
        assert_eq!(
            items[0].get("is_price_overridden").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            items[1].get("unit_price").and_then(Value::as_f64),
            Some(10.5)
        );
    }

    #[test]
    fn prepare_order_update_uses_repaired_payload_when_local_subtotal_defaults_to_zero() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents,
                 subtotal, subtotal_cents, status, payment_status, sync_status,
                 created_at, updated_at
             ) VALUES (
                 'order-repaired-payment-update', 'remote-order-repaired-payment-update',
                 '[]', 29.4, 2940, 0.0, 0, 'pending', 'paid', 'synced',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced table order with legacy zero subtotal");
        let item = queue_item(
            "orders",
            "UPDATE",
            "order-repaired-payment-update",
            json!({
                "orderId": "order-repaired-payment-update",
                "status": "pending",
                "paymentStatus": "paid",
                "discountAmount": 2.1,
                "discountAmountCents": 210,
                "subtotal": 31.5,
                "subtotalCents": 3150,
                "totalAmount": 29.4,
                "totalAmountCents": 2940
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(body.get("subtotal").and_then(Value::as_f64), Some(31.5));
        assert_eq!(
            body.get("subtotal_cents").and_then(Value::as_i64),
            Some(3150)
        );
        assert_eq!(body.get("total_amount").and_then(Value::as_f64), Some(29.4));
        assert_eq!(
            body.get("total_amount_cents").and_then(Value::as_i64),
            Some(2940)
        );
        assert_eq!(
            body.get("discount_amount").and_then(Value::as_f64),
            Some(2.1)
        );
        assert_eq!(
            body.get("discount_amount_cents").and_then(Value::as_i64),
            Some(210)
        );
        assert_eq!(
            body.get("payment_status").and_then(Value::as_str),
            Some("paid")
        );
    }

    #[test]
    fn prepare_order_request_defaults_payment_method_and_recomputes_total_amount() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "INSERT",
            "order-legacy-2",
            json!({
                "branchId": TEST_BRANCH_ID,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 2,
                    "price": 6.5,
                    "name": "Fries"
                }],
                "taxAmount": 1.2,
                "deliveryFee": 0.5,
                "discountAmount": 0.7
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("payment_method").and_then(Value::as_str),
            Some("cash")
        );
        assert_eq!(body.get("subtotal").and_then(Value::as_f64), Some(13.0));
        assert_eq!(body.get("tax_amount").and_then(Value::as_f64), Some(1.2));
        assert_eq!(body.get("delivery_fee").and_then(Value::as_f64), Some(0.5));
        assert_eq!(
            body.get("discount_amount").and_then(Value::as_f64),
            Some(0.7)
        );
        assert_eq!(body.get("total_amount").and_then(Value::as_f64), Some(14.0));
        assert_eq!(
            body.get("client_order_id").and_then(Value::as_str),
            Some("order-legacy-2")
        );

        let items = body
            .get("items")
            .and_then(Value::as_array)
            .expect("items array");
        assert_eq!(items[0].get("customizations"), Some(&Value::Null));
    }

    #[test]
    fn prepare_order_request_defaults_tip_amount_to_zero() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "INSERT",
            "order-legacy-tip-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "tipAmount": Value::Null,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 5.0,
                    "name": "Coffee"
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(body.get("tip_amount").and_then(Value::as_f64), Some(0.0));
    }

    #[test]
    fn prepare_order_request_uses_record_id_when_client_order_id_missing() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "INSERT",
            "order-legacy-3",
            json!({
                "branchId": TEST_BRANCH_ID,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 8.0,
                    "name": "Soup"
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");

        assert_eq!(
            body.get("client_order_id").and_then(Value::as_str),
            Some("order-legacy-3")
        );
    }

    #[test]
    fn prepare_order_request_forwards_delivery_conversion_update_fields() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, total_amount_cents,
                customer_name, customer_phone, delivery_address, order_type,
                delivery_fee, delivery_fee_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                'order-convert-1', 'remote-order-convert-1',
                '[{\"menu_item_id\":\"00000000-0000-0000-0000-000000000001\",\"quantity\":1,\"unit_price\":12.0,\"total_price\":12.0,\"name\":\"Crepe\",\"customizations\":[{\"optionId\":\"extra-honey\",\"name\":\"Extra Honey\"}]}]',
                12.80, 1280,
                'Anon', '6974011314', 'Xenofontos 36', 'delivery',
                0.80, 80, 'pending', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced order");

        let item = queue_item(
            "orders",
            "UPDATE",
            "order-convert-1",
            json!({
                "orderId": "order-convert-1",
                "orderType": "delivery",
                "customerId": "33333333-3333-3333-3333-333333333333",
                "customerName": "Anon",
                "customerPhone": "6974011314",
                "customerEmail": Value::Null,
                "deliveryAddress": "Xenofontos 36",
                "deliveryCity": "Athens",
                "deliveryPostalCode": "10557",
                "deliveryFloor": "1",
                "deliveryNotes": "Ring",
                "nameOnRinger": "Anon",
                "deliveryFee": 0.8,
                "delivery_fee_cents": 80,
                "totalAmount": 12.8,
                "total_amount_cents": 1280,
                "driverId": Value::Null,
                "driverName": Value::Null,
                "items": [{
                    "menu_item_id": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "unit_price": 12.0,
                    "name": "Crepe",
                    "customizations": [{
                        "optionId": "extra-honey",
                        "name": "Extra Honey"
                    }]
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        assert_eq!(request.endpoint, "/api/pos/orders");
        assert_eq!(request.method, Method::PATCH);

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("id").and_then(Value::as_str),
            Some("remote-order-convert-1")
        );
        assert_eq!(body.get("status").and_then(Value::as_str), Some("pending"));
        assert_eq!(
            body.get("order_type").and_then(Value::as_str),
            Some("delivery")
        );
        assert_eq!(
            body.get("customer_id").and_then(Value::as_str),
            Some("33333333-3333-3333-3333-333333333333")
        );
        assert_eq!(
            body.get("delivery_address").and_then(Value::as_str),
            Some("Xenofontos 36")
        );
        assert_eq!(body.get("delivery_fee").and_then(Value::as_f64), Some(0.8));
        assert_eq!(
            body.get("delivery_fee_cents").and_then(Value::as_i64),
            Some(80)
        );
        assert_eq!(body.get("total_amount").and_then(Value::as_f64), Some(12.8));
        assert_eq!(
            body.get("total_amount_cents").and_then(Value::as_i64),
            Some(1280)
        );
        assert!(body.get("driver_id").is_none());
        assert!(body.get("driver_name").is_none());
        assert_eq!(
            body.get("items").and_then(Value::as_array).map(Vec::len),
            Some(1)
        );
        let customizations = body
            .get("items")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|item| item.get("customizations"))
            .and_then(Value::as_object)
            .expect("update item customizations should be object");
        assert_eq!(
            customizations.get("extra-honey"),
            Some(&json!({
                "optionId": "extra-honey",
                "name": "Extra Honey"
            }))
        );
    }

    #[test]
    fn prepare_order_request_omits_driver_id_on_delivery_status_replay() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, total_amount_cents,
                order_type, status, sync_status, created_at, updated_at
             ) VALUES (
                'order-driver-replay', 'remote-order-driver-replay',
                '[]', 9.20, 920, 'delivery', 'delivered', 'pending',
                datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced delivery order");

        let item = queue_item(
            "orders",
            "UPDATE",
            "order-driver-replay",
            json!({
                "orderId": "order-driver-replay",
                "orderType": "delivery",
                "status": "delivered",
                "driverId": "b96b6236-8164-4881-b45f-b75c1c79859c",
                "driverName": "Driver Name",
                "deliveryNotes": Value::Null,
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(request.method, Method::PATCH);
        assert_eq!(
            body.get("id").and_then(Value::as_str),
            Some("remote-order-driver-replay")
        );
        assert_eq!(
            body.get("status").and_then(Value::as_str),
            Some("delivered")
        );
        assert!(
            body.get("driver_id").is_none(),
            "stale local driver ids must not be replayed to admin status PATCH"
        );
        assert_eq!(
            body.get("driver_name").and_then(Value::as_str),
            Some("Driver Name")
        );
    }

    #[test]
    fn prepare_order_reset_request_explicitly_clears_remote_driver() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, total_amount_cents,
                order_type, status, sync_status, created_at, updated_at
             ) VALUES (
                'order-reset-driver', 'remote-order-reset-driver',
                '[]', 9.20, 920, 'delivery', 'pending', 'pending',
                datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed reset delivery order");

        let item = queue_item(
            "orders",
            "UPDATE",
            "order-reset-driver",
            json!({
                "orderId": "order-reset-driver",
                "orderType": "delivery",
                "status": "pending",
                "driverId": Value::Null,
                "driverName": Value::Null,
                "resetToActive": true,
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare reset request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready reset request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse reset request body");

        assert_eq!(body.get("status").and_then(Value::as_str), Some("pending"));
        assert_eq!(body.get("driver_id"), Some(&Value::Null));
        assert_eq!(body.get("driver_name"), Some(&Value::Null));
        assert!(
            body.get("resetToActive").is_none(),
            "local reset marker must not leak into the API schema"
        );
    }

    #[test]
    fn order_update_replay_status_only_does_not_hydrate_local_order_payload() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, total_amount_cents,
                subtotal, subtotal_cents, delivery_fee, delivery_fee_cents,
                customer_name, customer_phone, delivery_address, order_type,
                status, payment_status, sync_status, created_at, updated_at
             ) VALUES (
                'order-sparse-update', 'remote-order-sparse-update',
                '[{\"menu_item_id\":\"00000000-0000-0000-0000-000000000001\",\"quantity\":1,\"unit_price\":7.0,\"total_price\":7.0,\"name\":\"Crepe\"}]',
                7.40, 740, 7.00, 700, 0.40, 40,
                'Anon', '6974011314', 'Xenofontos 36', 'delivery',
                'pending', 'partially_paid', 'pending', datetime('now'), '2026-04-27T19:10:02Z'
             )",
            [],
        )
        .expect("seed local delivery order");

        let item = queue_item(
            "orders",
            "UPDATE",
            "order-sparse-update",
            json!({
                "orderId": "order-sparse-update",
                "status": "pending"
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");

        assert_eq!(
            body.get("id").and_then(Value::as_str),
            Some("remote-order-sparse-update")
        );
        assert_eq!(body.get("status").and_then(Value::as_str), Some("pending"));
        assert!(
            body.get("order_type").is_none(),
            "status-only replay must not hydrate fallback order type"
        );
        assert!(
            body.get("total_amount").is_none(),
            "status-only replay must not hydrate fallback totals"
        );
        assert!(
            body.get("total_amount_cents").is_none(),
            "status-only replay must not hydrate fallback cents totals"
        );
        assert!(
            body.get("delivery_fee").is_none(),
            "status-only replay must not hydrate fallback delivery fee"
        );
        assert!(
            body.get("delivery_address").is_none(),
            "status-only replay must not hydrate fallback address"
        );
        assert!(
            body.get("items").is_none(),
            "status-only replay must not hydrate fallback order_items"
        );
    }

    #[test]
    fn prepare_order_request_uses_repaired_remote_order_id_when_local_order_rolled_over() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "UPDATE",
            "order-rolled-over",
            json!({
                "orderId": "order-rolled-over",
                "remoteOrderId": "remote-order-rolled-over",
                "status": "completed",
                "paymentStatus": "paid",
                "totalAmount": 7.7,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "name": "Water",
                    "quantity": 1,
                    "unit_price": 1.0,
                    "total_price": 1.0
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");

        assert_eq!(request.method, Method::PATCH);
        assert_eq!(
            body.get("id").and_then(Value::as_str),
            Some("remote-order-rolled-over")
        );
        assert_eq!(
            body.get("status").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(body.get("total_amount").and_then(Value::as_f64), Some(7.7));
        assert_eq!(
            body.get("items").and_then(Value::as_array).map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn prepare_order_request_marks_missing_parent_update_as_stale() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "UPDATE",
            "order-missing-parent",
            json!({
                "orderId": "order-missing-parent",
                "status": "completed",
                "totalAmount": 7.7,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "name": "Water",
                    "quantity": 1,
                    "unit_price": 1.0,
                    "total_price": 1.0
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request");

        match request {
            RequestPreparation::Failed { reason } => {
                assert_eq!(reason, STALE_ORDER_UPDATE_PARENT_WAIT_REASON);
            }
            other => panic!("expected stale missing-parent failure, got {other:?}"),
        }
    }

    #[test]
    fn prepare_order_request_prefers_current_local_order_over_stale_payload() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, total_amount_cents,
                subtotal, subtotal_cents, delivery_fee, delivery_fee_cents,
                customer_name, customer_phone, delivery_address, order_type,
                status, payment_status, sync_status, created_at, updated_at
             ) VALUES (
                'order-stale-payload', 'remote-order-stale-payload',
                '[{\"menu_item_id\":\"00000000-0000-0000-0000-000000000001\",\"quantity\":1,\"unit_price\":6.0,\"total_price\":6.0,\"name\":\"Chicken\"}]',
                7.56, 756, 6.00, 600, 1.56, 156,
                'Mparoutas', '2310840576', 'Asklipiou 10', 'delivery',
                'pending', 'partially_paid', 'pending', datetime('now'), '2026-04-27T20:04:22Z'
             )",
            [],
        )
        .expect("seed local delivery order");

        let item = queue_item(
            "orders",
            "UPDATE",
            "order-stale-payload",
            json!({
                "orderId": "order-stale-payload",
                "status": "pending",
                "orderType": "pickup",
                "totalAmount": 6.0,
                "total_amount_cents": 600,
                "deliveryFee": 0.0,
                "delivery_fee_cents": 0
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");

        assert_eq!(
            body.get("order_type").and_then(Value::as_str),
            Some("delivery")
        );
        assert_eq!(
            body.get("total_amount_cents").and_then(Value::as_i64),
            Some(756)
        );
        assert_eq!(
            body.get("delivery_fee_cents").and_then(Value::as_i64),
            Some(156)
        );
        assert_eq!(
            body.get("delivery_address").and_then(Value::as_str),
            Some("Asklipiou 10")
        );
    }

    #[test]
    fn prepare_order_request_rebases_stale_metadata_update_to_newer_queued_cancellation() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, status, sync_status,
                created_at, updated_at
             ) VALUES (
                'order-cancel-race', 'remote-order-cancel-race', '[]',
                27.0, 'cancelled', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed locally cancelled order");

        conn.execute(
            "INSERT INTO parity_sync_queue (
                id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, retry_delay_ms, priority, module_type,
                conflict_strategy, version, status
             ) VALUES (
                'queue-stale-assignment', 'orders', 'order-cancel-race', 'UPDATE',
                ?1, 'org-1', '2026-07-30T08:12:13.961442600+00:00',
                0, 1000, 0, 'orders', 'server-wins', 1, 'pending'
             ), (
                'queue-newer-cancellation', 'orders', 'order-cancel-race', 'UPDATE',
                ?2, 'org-1', '2026-07-30T08:12:22.574601000+00:00',
                0, 1000, 0, 'orders', 'server-wins', 1, 'pending'
             )",
            params![
                json!({
                    "orderId": "order-cancel-race",
                    "orderType": "delivery",
                    "status": "delivered",
                    "driverId": "driver-wolt",
                    "driverName": "WOLT WOLT",
                    "deliveryNotes": null
                })
                .to_string(),
                json!({
                    "orderId": "order-cancel-race",
                    "status": "cancelled",
                    "cancellationReason": "Operator cancelled",
                    "cancelled_at": "2026-07-30T08:12:22.574601000+00:00"
                })
                .to_string()
            ],
        )
        .expect("seed ordered status updates");

        let item = dequeue(&conn)
            .expect("dequeue stale assignment")
            .expect("stale assignment row");
        assert_eq!(item.id, "queue-stale-assignment");
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse assignment payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare stale assignment replay")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");

        assert_eq!(
            body.get("status").and_then(Value::as_str),
            Some("cancelled")
        );
        assert_eq!(
            body.get("driver_name").and_then(Value::as_str),
            Some("WOLT WOLT")
        );
    }

    #[test]
    fn prepare_order_request_keeps_cancellation_before_queued_reactivation() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, status, sync_status,
                created_at, updated_at
             ) VALUES (
                'order-reactivation-race', 'remote-order-reactivation-race', '[]',
                27.0, 'pending', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed locally reactivated order");

        conn.execute(
            "INSERT INTO parity_sync_queue (
                id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, retry_delay_ms, priority, module_type,
                conflict_strategy, version, status
             ) VALUES (
                'queue-cancellation', 'orders', 'order-reactivation-race', 'UPDATE',
                ?1, 'org-1', '2026-07-30T08:12:13.961442600+00:00',
                0, 1000, 0, 'orders', 'server-wins', 1, 'pending'
             ), (
                'queue-reactivation', 'orders', 'order-reactivation-race', 'UPDATE',
                ?2, 'org-1', '2026-07-30T08:12:22.574601000+00:00',
                0, 1000, 0, 'orders', 'server-wins', 1, 'pending'
             )",
            params![
                json!({
                    "orderId": "order-reactivation-race",
                    "status": "cancelled",
                    "cancellationReason": "Operator cancelled"
                })
                .to_string(),
                json!({
                    "orderId": "order-reactivation-race",
                    "status": "pending",
                    "cancellationReason": null,
                    "cancelled_at": null
                })
                .to_string()
            ],
        )
        .expect("seed cancellation and reactivation");

        let item = dequeue(&conn)
            .expect("dequeue cancellation")
            .expect("cancellation row");
        assert_eq!(item.id, "queue-cancellation");
        let payload =
            serde_json::from_str::<Value>(&item.data).expect("parse cancellation payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare cancellation replay")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");

        assert_eq!(
            body.get("status").and_then(Value::as_str),
            Some("cancelled")
        );
    }

    #[test]
    fn cleanup_superseded_synced_order_status_updates_rebases_failed_metadata_row() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, status, sync_status,
                created_at, updated_at
             ) VALUES (
                'order-failed-cancel-race', 'remote-order-failed-cancel-race', '[]',
                27.0, 'cancelled', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced cancelled order");

        conn.execute(
            "INSERT INTO parity_sync_queue (
                id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, retry_delay_ms,
                priority, module_type, conflict_strategy, version, status
             ) VALUES (
                'queue-failed-assignment', 'orders', 'order-failed-cancel-race', 'UPDATE',
                ?1, 'org-1', '2026-07-30T08:12:13.961442600+00:00',
                1, '2026-07-30T08:12:57.962983400+00:00',
                'HTTP 400: Invalid status transition: Cannot transition from cancelled to delivered',
                2248, 0, 'orders', 'server-wins', 1, 'failed'
             )",
            params![json!({
                "orderId": "order-failed-cancel-race",
                "orderType": "delivery",
                "status": "delivered",
                "driverId": "driver-wolt",
                "driverName": "WOLT WOLT",
                "deliveryNotes": null
            })
            .to_string()],
        )
        .expect("seed failed stale assignment");

        let handled = cleanup_superseded_synced_order_status_updates(&conn)
            .expect("repair failed stale assignment");
        assert_eq!(handled, 1);

        let (status, data, attempts, error_message): (String, String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, data, attempts, error_message
                 FROM parity_sync_queue
                 WHERE id = 'queue-failed-assignment'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read repaired assignment row");
        let payload = serde_json::from_str::<Value>(&data).expect("parse repaired payload");

        assert_eq!(status, "pending");
        assert_eq!(attempts, 0);
        assert_eq!(error_message, None);
        assert_eq!(
            payload.get("status").and_then(Value::as_str),
            Some("cancelled")
        );
        assert_eq!(
            payload.get("driverName").and_then(Value::as_str),
            Some("WOLT WOLT")
        );
        assert_eq!(
            payload.get("syncRecoveryReason").and_then(Value::as_str),
            Some(SUPERSEDED_ORDER_STATUS_REBASE_REASON)
        );
    }

    #[test]
    #[serial_test::serial]
    fn renderer_claim_atomically_rechecks_repair_settlement_ownership_after_writer_commit() {
        let (fixture, setup) = FileBackedTestDb::new("renderer-claim-owner-race");
        setup
            .execute_batch(
                "INSERT INTO orders (
                     id, supabase_id, items, total_amount, status, sync_status,
                     order_context, created_at, updated_at
                 ) VALUES (
                     'race-repair-order', 'race-repair-remote', '[]', 9.50,
                     'pending', 'pending', NULL, datetime('now'), datetime('now')
                 ), (
                     'race-normal-order', 'race-normal-remote', '[]', 4.79,
                     'pending', 'pending', NULL, datetime('now'), datetime('now')
                 );

                 INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, retry_delay_ms, priority, module_type,
                     conflict_strategy, version, claim_generation, status
                 ) VALUES (
                     'race-repair-queue', ' Orders ', 'race-repair-remote', 'UPDATE',
                     '{\"status\":\"ready\"}', 'org-race', '2026-08-26T07:00:00Z',
                     0, 1000, 100, ' Orders ', 'server-wins', 1, 0, 'pending'
                 ), (
                     'race-normal-queue', 'orders', 'race-normal-order', 'UPDATE',
                     '{\"status\":\"ready\"}', 'org-race', '2026-08-26T07:00:01Z',
                     0, 1000, 1, 'orders', 'server-wins', 1, 0, 'pending'
                 );",
            )
            .expect("seed claim race");
        let repair_before = full_queue_row_fingerprint(&setup, "race-repair-queue");

        let mut writer = fixture.open_race_connection();
        let worker = fixture.open_race_connection();
        let transaction = writer
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .expect("begin competing owner update");
        transaction
            .execute(
                "UPDATE orders
                 SET order_context = '  RePaIr_SeTtLeMeNt  '
                 WHERE id = 'race-repair-order'",
                [],
            )
            .expect("stage repair settlement ownership");

        RENDERER_RACE_WAITING_ON_WRITE.store(false, std::sync::atomic::Ordering::SeqCst);
        let claim = std::thread::spawn(move || renderer_dequeue(&worker));
        wait_until_renderer_write_is_blocked();
        transaction
            .commit()
            .expect("commit repair settlement owner");

        let claimed = claim
            .join()
            .expect("join renderer claimant")
            .expect("claim queue row")
            .expect("normal row remains claimable");
        assert_eq!(claimed.id, "race-normal-queue");
        assert_eq!(claimed.status, "processing");
        assert_eq!(claimed.claim_generation, 1);
        assert_eq!(
            full_queue_row_fingerprint(&setup, "race-repair-queue"),
            repair_before,
            "claim-time ownership change must leave the settlement queue row byte-for-byte unchanged"
        );
    }

    #[test]
    #[serial_test::serial]
    fn superseded_cleanup_rechecks_repair_settlement_ownership_at_delete_boundary() {
        let (fixture, setup) = FileBackedTestDb::new("renderer-cleanup-owner-race");
        setup
            .execute_batch(
                "INSERT INTO orders (
                     id, supabase_id, items, total_amount, status, sync_status,
                     order_context, created_at, updated_at
                 ) VALUES (
                     'cleanup-race-order', 'cleanup-race-remote', '[]', 9.50,
                     'completed', 'synced', NULL, datetime('now'), datetime('now')
                 );

                 INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, last_attempt, error_message, retry_delay_ms,
                     priority, module_type, conflict_strategy, version, claim_generation, status
                 ) VALUES (
                     'cleanup-race-queue', 'orders', 'cleanup-race-order', 'UPDATE',
                     '{\"orderId\":\"cleanup-race-order\",\"status\":\"pending\"}',
                     'org-race', '2026-08-26T07:00:00Z', 1,
                     '2026-08-26T07:01:00Z', 'HTTP 400: Invalid status transition',
                     1000, 1, 'orders', 'server-wins', 1, 0, 'failed'
                 );",
            )
            .expect("seed cleanup race");
        let queue_before = full_queue_row_fingerprint(&setup, "cleanup-race-queue");

        let mut writer = fixture.open_race_connection();
        let worker = fixture.open_race_connection();
        let transaction = writer
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .expect("begin competing cleanup owner update");
        transaction
            .execute(
                "UPDATE orders
                 SET order_context = '  REPAIR_SETTLEMENT  '
                 WHERE id = 'cleanup-race-order'",
                [],
            )
            .expect("stage cleanup repair ownership");

        RENDERER_RACE_WAITING_ON_WRITE.store(false, std::sync::atomic::Ordering::SeqCst);
        let cleanup =
            std::thread::spawn(move || cleanup_superseded_synced_order_status_updates(&worker));
        wait_until_renderer_write_is_blocked();
        transaction.commit().expect("commit cleanup repair owner");

        assert_eq!(
            cleanup
                .join()
                .expect("join cleanup worker")
                .expect("run superseded cleanup"),
            0
        );
        assert_eq!(
            full_queue_row_fingerprint(&setup, "cleanup-race-queue"),
            queue_before,
            "cleanup mutation must revalidate ownership after waiting for the writer"
        );
    }

    #[test]
    fn renderer_surfaces_and_mutators_exclude_normalized_repair_financial_owners() {
        let conn = test_connection();
        conn.execute_batch(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, status, sync_status,
                 order_context, created_at, updated_at
             ) VALUES (
                 'renderer-owner-repair', 'renderer-owner-repair-remote', '[]', 9.50,
                 'ready', 'synced', '  RePaIr_SeTtLeMeNt  ', datetime('now'), datetime('now')
             ), (
                 'renderer-owner-normal', 'renderer-owner-normal-remote', '[]', 4.79,
                 'pending', 'pending', NULL, datetime('now'), datetime('now')
             );

             INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, currency, status,
                 sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'renderer-owner-repair-payment', 'renderer-owner-repair', 'cash',
                 9.50, 950, 'EUR', 'completed', 'failed', 'failed',
                 datetime('now'), datetime('now')
             ), (
                 'renderer-owner-normal-payment', 'renderer-owner-normal', 'cash',
                 4.79, 479, 'EUR', 'completed', 'failed', 'failed',
                 datetime('now'), datetime('now')
             );

             INSERT INTO payment_adjustments (
                 id, payment_id, order_id, adjustment_type, amount, reason,
                 sync_state, created_at, updated_at
             ) VALUES (
                 'renderer-owner-repair-adjustment', 'renderer-owner-repair-payment',
                 'renderer-owner-repair', 'refund', 1.00, 'repair adjustment sentinel',
                 'failed', datetime('now'), datetime('now')
             );",
        )
        .expect("seed renderer ownership graph");

        for (id, table_name, record_id, status, priority, module_type) in [
            (
                "renderer-case-module-repair",
                " Orders ",
                "renderer-owner-repair-remote",
                "pending",
                100,
                " Repairs ",
            ),
            (
                "renderer-owned-order",
                " Orders ",
                "renderer-owner-repair-remote",
                "pending",
                90,
                " Orders ",
            ),
            (
                "renderer-owned-payment",
                " Payments ",
                "renderer-owner-repair-payment",
                "failed",
                80,
                "payments",
            ),
            (
                "renderer-owned-order-payment",
                " order_payments ",
                "renderer-owner-repair-payment",
                "conflict",
                70,
                "payments",
            ),
            (
                "renderer-owned-adjustment",
                " Payment_Adjustments ",
                "renderer-owner-repair-adjustment",
                "failed",
                60,
                "payments",
            ),
            (
                "renderer-normal-order",
                "orders",
                "renderer-owner-normal",
                "pending",
                2,
                "orders",
            ),
            (
                "renderer-normal-payment",
                "payments",
                "renderer-owner-normal-payment",
                "failed",
                1,
                "payments",
            ),
        ] {
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, last_attempt, error_message, next_retry_at,
                     retry_delay_ms, priority, module_type, conflict_strategy, version,
                     claim_generation, status
                 ) VALUES (
                     ?1, ?2, ?3, 'UPDATE', '{\"sentinel\":true}', 'renderer-owner-org',
                     '2026-08-26T07:00:00Z', 5, '2026-08-26T07:01:00Z',
                     'renderer owner error sentinel', NULL,
                     64000, ?5, ?6, 'manual', 7, 4, ?4
                 )",
                params![id, table_name, record_id, status, priority, module_type],
            )
            .expect("seed renderer queue ownership row");
        }

        let repair_queue_ids = [
            "renderer-case-module-repair",
            "renderer-owned-order",
            "renderer-owned-payment",
            "renderer-owned-order-payment",
            "renderer-owned-adjustment",
        ];
        let repair_queue_before = repair_queue_ids
            .iter()
            .map(|id| full_queue_row_fingerprint(&conn, id))
            .collect::<Vec<_>>();
        let payment_before =
            full_order_payment_row_fingerprint(&conn, "renderer-owner-repair-payment");
        let adjustment_before: (String, String, String, String, f64, String) = conn
            .query_row(
                "SELECT id, payment_id, order_id, adjustment_type, amount, reason
                 FROM payment_adjustments
                 WHERE id = 'renderer-owner-repair-adjustment'",
                [],
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
            .expect("fingerprint repair adjustment");

        assert_eq!(
            renderer_peek(&conn)
                .expect("peek renderer queue")
                .map(|item| item.id),
            Some("renderer-normal-order".to_string())
        );
        assert_eq!(
            renderer_get_length(&conn).expect("renderer queue length"),
            2
        );
        let status = renderer_get_status(&conn).expect("renderer queue status");
        assert_eq!(
            (
                status.total,
                status.pending,
                status.failed,
                status.conflicts
            ),
            (2, 1, 1, 0)
        );
        let actionable = renderer_list_actionable_items(
            &conn,
            &QueueListQuery {
                module_type: None,
                limit: Some(50),
            },
        )
        .expect("list renderer queue")
        .into_iter()
        .map(|item| item.id)
        .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            actionable,
            [
                "renderer-normal-order".to_string(),
                "renderer-normal-payment".to_string()
            ]
            .into_iter()
            .collect()
        );

        assert_eq!(
            renderer_retry_item(&conn, "renderer-case-module-repair").unwrap_err(),
            "REPAIR_TYPED_CONFLICT_REQUIRED"
        );
        for item_id in [
            "renderer-owned-order",
            "renderer-owned-payment",
            "renderer-owned-order-payment",
            "renderer-owned-adjustment",
        ] {
            assert_eq!(
                renderer_retry_item(&conn, item_id).unwrap_err(),
                "REPAIR_SETTLEMENT_ROUTE_REQUIRED"
            );
        }
        assert_eq!(
            renderer_retry_items_by_module(&conn, "payments")
                .expect("retry normal payment module")
                .retried,
            1
        );

        for (entity_type, entity_id) in [
            ("orders", "renderer-owner-repair-remote"),
            ("payments", "renderer-owner-repair-payment"),
            ("payment_adjustments", "renderer-owner-repair-adjustment"),
            ("orders", "renderer-owner-normal"),
        ] {
            log_conflict(
                &conn,
                "UPDATE",
                entity_id,
                entity_type,
                1,
                2,
                "conflict payload sentinel",
                "manual",
                true,
                false,
            )
            .expect("seed conflict audit entry");
        }
        let renderer_conflicts =
            renderer_list_conflict_audit_entries(&conn, 50).expect("list renderer conflict audit");
        assert_eq!(renderer_conflicts.len(), 1);
        assert_eq!(renderer_conflicts[0].entity_id, "renderer-owner-normal");

        renderer_clear(&conn).expect("clear renderer-owned generic rows");
        let repair_queue_after = repair_queue_ids
            .iter()
            .map(|id| full_queue_row_fingerprint(&conn, id))
            .collect::<Vec<_>>();
        assert_eq!(repair_queue_after, repair_queue_before);
        assert_eq!(
            renderer_get_length(&conn).expect("renderer length after clear"),
            0
        );
        assert_eq!(
            full_order_payment_row_fingerprint(&conn, "renderer-owner-repair-payment"),
            payment_before
        );
        let adjustment_after: (String, String, String, String, f64, String) = conn
            .query_row(
                "SELECT id, payment_id, order_id, adjustment_type, amount, reason
                 FROM payment_adjustments
                 WHERE id = 'renderer-owner-repair-adjustment'",
                [],
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
            .expect("read repair adjustment after renderer operations");
        assert_eq!(adjustment_after, adjustment_before);
    }

    #[test]
    fn poison_inserted_after_outer_quarantine_is_counted_only_at_atomic_claim() {
        let conn = test_connection();
        let mut quarantined =
            quarantine_reserved_repair_lookalikes(&conn).expect("empty outer quarantine");
        assert_eq!(quarantined, 0);
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, last_attempt, retry_delay_ms, priority,
                 module_type, conflict_strategy, version, claim_generation, status
             ) VALUES (
                 'outer-recovery-gap-poison', '\u{2003}repairs\u{2003}',
                 'outer-recovery-gap-private-record', 'UPDATE',
                 'outer-recovery-gap-private-payload', 'outer-recovery-gap-org',
                 '2000-01-01T00:00:00Z', 2, '2000-01-01T00:00:00Z', 1000,
                 100, '\u{2003}orders\u{2003}', 'manual', 1, 6, 'processing'
             )",
            [],
        )
        .expect("insert poison between outer quarantine and recovery");
        let before_recovery = full_queue_row_fingerprint(&conn, "outer-recovery-gap-poison");
        assert_eq!(
            recover_stale_processing_items(&conn).expect("run semantically fenced recovery"),
            0
        );
        assert_eq!(
            full_queue_row_fingerprint(&conn, "outer-recovery-gap-poison"),
            before_recovery,
            "recovery must not hide an uncounted quarantine transition"
        );
        let (item, claim_quarantined) =
            dequeue_with_quarantine_count(&conn).expect("run counted atomic claim");
        quarantined += claim_quarantined;
        assert!(item.is_none());
        assert_eq!(quarantined, 1);
        assert_eq!(
            conn.query_row(
                "SELECT status, claim_generation FROM parity_sync_queue
                 WHERE id = 'outer-recovery-gap-poison'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("read recovery-gap quarantine"),
            ("failed".to_string(), 7)
        );
    }

    #[test]
    fn terminal_auth_classifier_accepts_only_bounded_canonical_codes() {
        assert!(parse_parity_terminal_auth_failure(
            401,
            r#"{"success":false,"code":"terminal_inactive","terminalActive":false}"#,
        )
        .is_some());
        for (status, body) in [
            (
                401,
                r#"{"success":false,"error":"private auth sentinel"}"#.to_string(),
            ),
            (
                403,
                r#"{"success":false,"code":"private_provider_code"}"#.to_string(),
            ),
            (
                500,
                r#"{"success":false,"code":"terminal_inactive"}"#.to_string(),
            ),
            (
                401,
                format!(
                    r#"{{"success":false,"code":"terminal_inactive","padding":"{}"}}"#,
                    "x".repeat(17 * 1024)
                ),
            ),
        ] {
            assert!(
                parse_parity_terminal_auth_failure(status, &body).is_none(),
                "unbounded/noncanonical auth payload was classified"
            );
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn renderer_safe_preserves_repair_rows_while_internal_prepass_quarantines_lookalikes() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, status, sync_status,
                 created_at, updated_at
             ) VALUES (
                 'order-renderer-repair-cleanup', 'remote-renderer-repair-cleanup',
                 '[]', 27.0, 'cancelled', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced order that activates superseded cleanup");

        for (id, table_name, record_id, module_type, data) in [
            (
                "repair-module-half-cleanup",
                "orders",
                "order-renderer-repair-cleanup",
                "repairs",
                json!({
                    "orderId": "order-renderer-repair-cleanup",
                    "orderType": "delivery",
                    "status": "delivered",
                    "driverName": "repair-module-half-driver-sentinel",
                    "ciphertext": "repair-module-half-ciphertext-sentinel"
                })
                .to_string(),
            ),
            (
                "repair-exact-cleanup-control",
                "repairs",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "repairs",
                json!({"ciphertext": "repair-exact-ciphertext-sentinel"}).to_string(),
            ),
            (
                "repair-table-half-cleanup-control",
                "repair_attachments",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "orders",
                json!({"ciphertext": "repair-table-half-ciphertext-sentinel"}).to_string(),
            ),
        ] {
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, last_attempt, error_message, next_retry_at,
                     retry_delay_ms, priority, module_type, conflict_strategy, version,
                     repair_aggregate_id, claim_generation, status
                 ) VALUES (
                     ?1, ?2, ?3, 'UPDATE', ?4, 'repair-renderer-private-org',
                     '2026-08-26T07:00:00Z', 7, '2026-08-26T07:01:00Z',
                     'HTTP 400: Invalid status transition: repair-renderer-private-error',
                     '2026-08-27T07:00:00Z',
                     64000, 9, ?5, 'server-wins', 11,
                     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 'failed'
                 )",
                params![id, table_name, record_id, data, module_type],
            )
            .expect("seed repair-shaped queue row");
        }

        let item_ids = [
            "repair-module-half-cleanup",
            "repair-exact-cleanup-control",
            "repair-table-half-cleanup-control",
        ];
        let before = item_ids
            .iter()
            .map(|item_id| full_queue_row_fingerprint(&conn, item_id))
            .collect::<Vec<_>>();
        let db = std::sync::Mutex::new(conn);

        let result = process_queue_renderer_safe(&db, "http://127.0.0.1:9", "test-api-key")
            .await
            .expect("renderer-safe process must not require repair transport");
        assert_eq!(result.processed, 0);

        let conn = db.lock().expect("lock queue after renderer-safe process");
        let after = item_ids
            .iter()
            .map(|item_id| full_queue_row_fingerprint(&conn, item_id))
            .collect::<Vec<_>>();
        assert_eq!(
            after, before,
            "renderer-safe pre-dequeue path mutated repair data"
        );
        drop(conn);

        let result = process_queue(&db, "http://127.0.0.1:9", "test-api-key")
            .await
            .expect("internal process must quarantine rather than rewrite malformed repair rows");
        assert_eq!(result.processed, 0);
        let conn = db.lock().expect("lock queue after internal process");
        assert_eq!(
            full_queue_row_fingerprint(&conn, "repair-exact-cleanup-control"),
            before[1],
            "internal prepass must preserve canonical native repair state"
        );
        for (id, expected_payload) in [
            (
                "repair-module-half-cleanup",
                json!({
                    "orderId": "order-renderer-repair-cleanup",
                    "orderType": "delivery",
                    "status": "delivered",
                    "driverName": "repair-module-half-driver-sentinel",
                    "ciphertext": "repair-module-half-ciphertext-sentinel"
                })
                .to_string(),
            ),
            (
                "repair-table-half-cleanup-control",
                json!({"ciphertext": "repair-table-half-ciphertext-sentinel"}).to_string(),
            ),
        ] {
            let (status, error, next_retry_at, payload, generation): (
                String,
                Option<String>,
                Option<String>,
                String,
                i64,
            ) = conn
                .query_row(
                    "SELECT status, error_message, next_retry_at, data, claim_generation
                       FROM parity_sync_queue WHERE id = ?1",
                    [id],
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
                .expect("read internally quarantined lookalike");
            assert_eq!(status, "failed");
            assert_eq!(error.as_deref(), Some(REPAIR_RESERVED_OWNER_QUARANTINED));
            assert!(next_retry_at.is_none());
            assert_eq!(
                payload, expected_payload,
                "quarantine rewrote private payload"
            );
            assert_eq!(generation, 5, "an inactive failed row needs no claim fence");
        }
    }

    #[test]
    fn clear_unsynced_items_deletes_only_generic_owned_rows() {
        let conn = test_connection();
        const REPAIR_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        for (id, table_name, module_type) in [
            ("clear-generic", "payments", "orders"),
            ("clear-module-half", "payments", "repairs"),
            ("clear-exact-repair", "repairs", "repairs"),
            ("clear-table-half", "repair_attachments", "orders"),
        ] {
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, retry_delay_ms, priority, module_type,
                     conflict_strategy, version, repair_aggregate_id, status
                 ) VALUES (
                     ?1, ?2, 'co-keyed-payment', 'INSERT', '{\"sentinel\":true}',
                     'repair-clear-org', '2026-08-26T07:00:00Z', 3, 1000, 1,
                     ?3, 'manual', 4, ?4, 'failed'
                 )",
                params![id, table_name, module_type, REPAIR_ID],
            )
            .expect("seed clear ownership row");
        }
        let module_half_before =
            full_queue_row_fingerprint(&conn, "clear-module-half").expect("module-half row");
        let exact_before =
            full_queue_row_fingerprint(&conn, "clear-exact-repair").expect("exact row");
        let table_half_before =
            full_queue_row_fingerprint(&conn, "clear-table-half").expect("table-half row");

        assert_eq!(
            clear_unsynced_items(&conn, "payments", "co-keyed-payment")
                .expect("clear generic payment rows"),
            1
        );
        assert!(full_queue_row_fingerprint(&conn, "clear-generic").is_none());
        assert_eq!(
            full_queue_row_fingerprint(&conn, "clear-module-half").as_deref(),
            Some(module_half_before.as_str())
        );

        assert_eq!(
            clear_unsynced_items(&conn, "repairs", "co-keyed-payment")
                .expect("attempt exact repair clear"),
            0
        );
        assert_eq!(
            clear_unsynced_items(&conn, "repair_attachments", "co-keyed-payment")
                .expect("attempt table-half clear"),
            0
        );
        assert_eq!(
            full_queue_row_fingerprint(&conn, "clear-exact-repair").as_deref(),
            Some(exact_before.as_str())
        );
        assert_eq!(
            full_queue_row_fingerprint(&conn, "clear-table-half").as_deref(),
            Some(table_half_before.as_str())
        );
    }

    #[test]
    fn generic_failed_requeue_preserves_all_repair_owned_shapes() {
        let conn = test_connection();
        const REPAIR_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        for (id, table_name, module_type) in [
            ("requeue-generic", "orders", "orders"),
            ("requeue-module-half", "payments", "repairs"),
            ("requeue-exact", "repairs", "repairs"),
            ("requeue-table-half", "repair_attachments", "orders"),
        ] {
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, last_attempt, error_message, next_retry_at,
                     retry_delay_ms, priority, module_type, conflict_strategy, version,
                     repair_aggregate_id, claim_generation, status
                 ) VALUES (
                     ?1, ?2, ?1, 'UPDATE', '{\"ciphertext\":\"private\"}',
                     'repair-requeue-org', '2026-08-26T07:00:00Z', 8,
                     '2026-08-26T07:01:00Z', 'HTTP 429 rate limit exceeded',
                     '2026-08-27T07:00:00Z', 64000, 5, ?3, 'manual', 9,
                     ?4, 6, 'failed'
                 )",
                params![id, table_name, module_type, REPAIR_ID],
            )
            .expect("seed failed ownership row");
        }
        let repair_ids = ["requeue-module-half", "requeue-exact", "requeue-table-half"];
        let repair_before = repair_ids
            .iter()
            .map(|id| full_queue_row_fingerprint(&conn, id))
            .collect::<Vec<_>>();
        let queue_ids = [
            "requeue-generic".to_string(),
            "requeue-module-half".to_string(),
            "requeue-exact".to_string(),
            "requeue-table-half".to_string(),
        ];

        let result = requeue_failed_items(&conn, &queue_ids, "test generic recovery")
            .expect("requeue generic rows");
        assert_eq!(result.retried, 1);
        let generic_status: String = conn
            .query_row(
                "SELECT status FROM parity_sync_queue WHERE id = 'requeue-generic'",
                [],
                |row| row.get(0),
            )
            .expect("generic status");
        assert_eq!(generic_status, "pending");
        let repair_after = repair_ids
            .iter()
            .map(|id| full_queue_row_fingerprint(&conn, id))
            .collect::<Vec<_>>();
        assert_eq!(repair_after, repair_before);
    }

    #[test]
    fn stale_recovery_splits_generic_and_exact_native_from_unsafe_repair_shapes() {
        let conn = test_connection();
        const ORG_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const REPAIR_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        const EXACT_ID: &str = "11111111-1111-4111-8111-111111111111";
        const MALFORMED_ID: &str = "22222222-2222-4222-8222-222222222222";
        for (id, table_name, module_type, record_id, operation, organization_id) in [
            (
                "stale-generic",
                "orders",
                "orders",
                "stale-generic",
                "UPDATE",
                "generic-stale-org",
            ),
            (EXACT_ID, "repairs", "repairs", REPAIR_ID, "INSERT", ORG_ID),
            (
                MALFORMED_ID,
                "repairs",
                "repairs",
                REPAIR_ID,
                "UPDATE",
                ORG_ID,
            ),
            (
                "stale-module-half",
                "payments",
                "repairs",
                "stale-module-half",
                "UPDATE",
                "repair-stale-org",
            ),
            (
                "stale-table-half",
                "repair_attachments",
                "orders",
                "stale-table-half",
                "UPDATE",
                "repair-stale-org",
            ),
        ] {
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, last_attempt, retry_delay_ms, priority,
                     module_type, conflict_strategy, version, repair_aggregate_id,
                     claim_generation, status
                 ) VALUES (
                     ?1, ?2, ?4, ?5, '{\"ciphertext\":\"stale-private\"}',
                     ?6, '2026-08-20T07:00:00Z', 2,
                     '2026-08-20T07:01:00Z', 1000, 1, ?3, 'manual', 3,
                     ?7, 7, 'processing'
                 )",
                params![
                    id,
                    table_name,
                    module_type,
                    record_id,
                    operation,
                    organization_id,
                    REPAIR_ID
                ],
            )
            .expect("seed stale ownership row");
        }
        let malformed_before = full_queue_row_fingerprint(&conn, MALFORMED_ID);
        assert_eq!(
            quarantine_reserved_repair_lookalikes(&conn).expect("quarantine stale semantic owners"),
            2
        );
        assert_eq!(
            recover_stale_processing_items(&conn).expect("recover stale rows"),
            2
        );
        for id in ["stale-generic", EXACT_ID] {
            let (status, generation): (String, i64) = conn
                .query_row(
                    "SELECT status, claim_generation FROM parity_sync_queue WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read recovered row");
            assert_eq!(status, "pending");
            assert_eq!(generation, 8);
        }
        assert_eq!(
            full_queue_row_fingerprint(&conn, MALFORMED_ID),
            malformed_before
        );
        for id in ["stale-module-half", "stale-table-half"] {
            let (status, generation, error, payload): (String, i64, Option<String>, String) = conn
                .query_row(
                    "SELECT status, claim_generation, error_message, data
                       FROM parity_sync_queue WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("read quarantined stale lookalike");
            assert_eq!(status, "failed");
            assert_eq!(generation, 8, "stale processing claimant was not fenced");
            assert_eq!(error.as_deref(), Some(REPAIR_RESERVED_OWNER_QUARANTINED));
            assert_eq!(payload, "{\"ciphertext\":\"stale-private\"}");
        }
    }

    #[test]
    fn internal_claim_quarantines_semantic_repair_lookalikes_and_fences_old_claims() {
        let conn = test_connection();
        let poison_rows = [
            (
                "poison-pending",
                "orders",
                " Repairs ",
                "pending",
                0_i64,
                100_i64,
            ),
            (
                "poison-processing",
                " REPAIRS ",
                "orders",
                "processing",
                7,
                90,
            ),
            (
                "poison-failed",
                "orders",
                "\u{2003}repairs\u{2003}",
                "failed",
                2,
                80,
            ),
            (
                "poison-conflict",
                "\trepair_attachments\n",
                "orders",
                "conflict",
                4,
                70,
            ),
        ];
        for (id, table_name, module_type, status, generation, priority) in poison_rows {
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, last_attempt, error_message, next_retry_at,
                     retry_delay_ms, priority, module_type, conflict_strategy, version,
                     repair_aggregate_id, claim_generation, status
                 ) VALUES (
                     ?1, ?2, ?1, 'INSERT', 'PRIVATE_REPAIR_LOOKALIKE_SENTINEL',
                     'poison-org', '2000-01-01T00:00:00Z', 3,
                     '2000-01-01T00:01:00Z', 'legacy error', NULL,
                     1000, ?6, ?3, 'server-wins', 1, NULL, ?5, ?4
                 )",
                params![id, table_name, module_type, status, generation, priority],
            )
            .expect("seed semantic repair lookalike");
        }
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status
             ) VALUES (
                 'generic-control', ' CuStOmErS ', 'generic-control', 'INSERT',
                 '{\"terminal_id\":\"terminal-test\"}', 'generic-org',
                 '2026-08-27T00:00:00Z', 0, 1000, 1, ' OrDeRs ',
                 'server-wins', 1, 'pending'
             )",
            [],
        )
        .expect("seed unrelated generic control");

        let usage_before = capacity_usage(&conn).expect("capacity before quarantine");
        assert_eq!((usage_before.replayable, usage_before.conflicts), (3, 1));
        let claimed = dequeue(&conn)
            .expect("internal claim with quarantine preflight")
            .expect("generic control remains claimable");
        assert_eq!(claimed.id, "generic-control");

        for (id, _, _, _, old_generation, _) in poison_rows {
            let (status, generation, error): (String, i64, Option<String>) = conn
                .query_row(
                    "SELECT status, claim_generation, error_message
                       FROM parity_sync_queue WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("read quarantined lookalike");
            assert_eq!(status, "failed", "{id} was not terminally quarantined");
            assert_eq!(
                generation,
                old_generation + if id == "poison-processing" { 1 } else { 0 },
                "only an active old claim needs generation fencing for {id}"
            );
            assert_eq!(error.as_deref(), Some("REPAIR_RESERVED_OWNER_QUARANTINED"));
            assert!(
                !error
                    .as_deref()
                    .unwrap_or_default()
                    .contains("PRIVATE_REPAIR_LOOKALIKE_SENTINEL"),
                "quarantine error copied private payload for {id}"
            );
        }
        mark_success(&conn, "poison-processing", 7).expect("late old claimant is fenced");
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = 'poison-processing'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("old claimant must not delete quarantine"),
            1
        );
        let usage_after = capacity_usage(&conn).expect("capacity after quarantine");
        assert_eq!((usage_after.replayable, usage_after.conflicts), (1, 0));

        let poison_before_retry = poison_rows
            .iter()
            .map(|(id, ..)| full_queue_row_fingerprint(&conn, id))
            .collect::<Vec<_>>();
        let renderer_items = renderer_list_actionable_items(
            &conn,
            &QueueListQuery {
                module_type: None,
                limit: Some(50),
            },
        )
        .expect("renderer list after quarantine");
        assert_eq!(
            renderer_items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["generic-control"]
        );
        assert_eq!(
            renderer_get_status(&conn).expect("renderer status").total,
            1
        );
        for (id, ..) in poison_rows {
            assert_eq!(
                renderer_retry_item(&conn, id)
                    .expect_err("renderer cannot retry reserved-owner quarantine"),
                "REPAIR_TYPED_CONFLICT_REQUIRED"
            );
        }
        assert!(
            dequeue(&conn)
                .expect("idempotent quarantine pass")
                .is_none(),
            "quarantined poison became claimable on a second pass"
        );
        assert_eq!(
            poison_rows
                .iter()
                .map(|(id, ..)| full_queue_row_fingerprint(&conn, id))
                .collect::<Vec<_>>(),
            poison_before_retry,
            "quarantine/retry preflights must be idempotent"
        );
        renderer_clear(&conn).expect("clear renderer-owned generic row");
        assert_eq!(get_length(&conn).expect("internal queue length"), 4);
    }

    #[tokio::test]
    async fn renderer_safe_processor_preserves_unicode_whitespace_repair_lookalike_without_http() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status
             ) VALUES (
                 'unicode-renderer-poison', '\u{2003}repairs\u{2003}',
                 'unicode-renderer-poison', 'INSERT',
                 '{\"terminal_id\":\"terminal-test\",\"private\":\"sentinel\"}',
                 'unicode-renderer-org', '2026-08-27T00:00:00Z', 0, 1000, 50,
                 'orders', 'server-wins', 1, 'pending'
             )",
            [],
        )
        .expect("seed Unicode-whitespace repair lookalike");
        let before = full_queue_row_fingerprint(&conn, "unicode-renderer-poison");
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind no-request server");
        let address = listener.local_addr().expect("no-request server address");
        let request_probe = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_millis(250), listener.accept())
                .await
                .is_ok()
        });
        let db = std::sync::Mutex::new(conn);

        let result =
            process_queue_renderer_safe(&db, &format!("http://{address}"), "renderer-api-key")
                .await
                .expect("renderer-safe processor must ignore reserved owner");
        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert!(
            !request_probe.await.expect("join request probe"),
            "renderer-safe processing dispatched a repair lookalike"
        );
        let conn = db.lock().expect("lock queue after renderer-safe process");
        assert_eq!(
            full_queue_row_fingerprint(&conn, "unicode-renderer-poison"),
            before,
            "renderer-safe processing changed a reserved-owner row"
        );
    }

    #[tokio::test]
    async fn internal_processor_quarantines_reserved_lookalike_before_http_dispatch() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, claim_generation, status
             ) VALUES (
                 'internal-dispatch-poison', '\trepairs\n',
                 'internal-dispatch-poison', 'INSERT',
                 '{\"terminal_id\":\"terminal-test\",\"private\":\"dispatch-sentinel\"}',
                 'internal-dispatch-org', '2026-08-27T00:00:00Z', 0, 1000, 50,
                 'orders', 'server-wins', 1, 0, 'pending'
             )",
            [],
        )
        .expect("seed reserved lookalike for internal processor");
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind no-request server");
        let address = listener.local_addr().expect("no-request server address");
        let request_probe = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_millis(250), listener.accept())
                .await
                .is_ok()
        });
        let db = std::sync::Mutex::new(conn);

        let result = process_queue(&db, &format!("http://{address}"), "native-api-key")
            .await
            .expect("internal processor quarantines poison without transport");
        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert!(
            !request_probe.await.expect("join request probe"),
            "internal processing dispatched an untrusted repair lookalike"
        );
        let conn = db.lock().expect("lock queue after internal process");
        let (status, error): (String, Option<String>) = conn
            .query_row(
                "SELECT status, error_message FROM parity_sync_queue
                  WHERE id = 'internal-dispatch-poison'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read quarantined internal poison");
        assert_eq!(status, "failed");
        assert_eq!(error.as_deref(), Some("REPAIR_RESERVED_OWNER_QUARANTINED"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn internal_prepass_preserves_module_half_payment_and_local_financial_row() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        conn.execute(
            "INSERT INTO orders (
                 id, items, total_amount, total_amount_cents, status, payment_status,
                 payment_transaction_id, sync_status, created_at, updated_at
             ) VALUES (
                 'repair-prepass-order', '[]', 9.50, 950, 'completed', 'paid',
                 'repair-prepass-valid', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed prepass order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, currency, status,
                 sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'repair-prepass-stale', 'repair-prepass-order', 'cash', 0.55, 55,
                 'EUR', 'completed', 'failed', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed repair-owned payment");
        let queue_id = enqueue_test_item(
            &conn,
            "payments",
            "INSERT",
            "repair-prepass-stale",
            json!({
                "paymentId": "repair-prepass-stale",
                "orderId": "repair-prepass-order",
                "amount": 0.55
            }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed', module_type = 'repairs',
                 repair_aggregate_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                 attempts = 6,
                 error_message = ?1
             WHERE id = ?2",
            params![
                "HTTP 422: {\"success\":false,\"error\":\"Payment exceeds order total\",\"details\":\"Order total: 4.79, tip: 0, existing completed: 4.79, payment: 0.55\"}",
                queue_id.as_str()
            ],
        )
        .expect("mark module-half payment conflict");
        let payment_before = full_order_payment_row_fingerprint(&conn, "repair-prepass-stale");
        let db = std::sync::Mutex::new(conn);

        let result = process_queue(&db, "http://127.0.0.1:9", "test-api-key")
            .await
            .expect("run internal prepass");
        assert_eq!(result.processed, 0);
        let conn = db.lock().expect("lock after internal prepass");
        let (status, error, payload): (String, Option<String>, String) = conn
            .query_row(
                "SELECT status, error_message, data FROM parity_sync_queue WHERE id = ?1",
                [queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read quarantined module-half payment row");
        assert_eq!(status, "failed");
        assert_eq!(error.as_deref(), Some(REPAIR_RESERVED_OWNER_QUARANTINED));
        assert_eq!(
            payload,
            json!({
                "paymentId": "repair-prepass-stale",
                "orderId": "repair-prepass-order",
                "amount": 0.55
            })
            .to_string(),
            "quarantine rewrote a private payment payload"
        );
        assert_eq!(
            full_order_payment_row_fingerprint(&conn, "repair-prepass-stale"),
            payment_before
        );
    }

    #[test]
    fn prepare_order_request_consumes_superseded_synced_status_only_update() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, status, sync_status,
                created_at, updated_at
             ) VALUES (
                'order-stale-restore', 'remote-order-stale-restore', '[]',
                27.0, 'completed', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced completed order");

        let item = queue_item(
            "orders",
            "UPDATE",
            "order-stale-restore",
            json!({
                "orderId": "order-stale-restore",
                "status": "pending",
                "cancellationReason": null,
                "cancellation_reason": null,
                "cancelledAt": null,
                "cancelled_at": null
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare order update")
        {
            RequestPreparation::Consumed { reason } => {
                assert!(reason.contains(SUPERSEDED_ORDER_UPDATE_REASON));
                assert!(reason.contains("queued pending"));
                assert!(reason.contains("local completed"));
            }
            other => panic!("expected consumed stale restore row, got {other:?}"),
        }
    }

    #[test]
    fn cleanup_superseded_synced_order_status_updates_removes_failed_restore_row() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, status, sync_status,
                created_at, updated_at
             ) VALUES (
                'order-clean-stale-restore', 'remote-order-clean-stale-restore',
                '[]', 27.0, 'completed', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced completed order");
        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "UPDATE",
            "order-clean-stale-restore",
            json!({
                "orderId": "order-clean-stale-restore",
                "status": "pending",
                "cancellationReason": null,
                "cancellation_reason": null,
                "cancelledAt": null,
                "cancelled_at": null
            }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 error_message = 'HTTP 400: Invalid status transition'
             WHERE id = ?1",
            params![queue_id.as_str()],
        )
        .expect("mark parity row failed");

        let removed = cleanup_superseded_synced_order_status_updates(&conn)
            .expect("cleanup stale restore rows");
        assert_eq!(removed, 1);

        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id.as_str()],
                |row| row.get(0),
            )
            .expect("count remaining row");
        assert_eq!(remaining, 0);
    }

    #[test]
    fn cleanup_superseded_synced_order_status_updates_keeps_unsynced_local_rows() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, status, sync_status,
                created_at, updated_at
             ) VALUES (
                'order-unsynced-current-status', 'remote-order-unsynced-current-status',
                '[]', 27.0, 'completed', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed unsynced completed order");
        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "UPDATE",
            "order-unsynced-current-status",
            json!({
                "orderId": "order-unsynced-current-status",
                "status": "pending"
            }),
        );

        let removed = cleanup_superseded_synced_order_status_updates(&conn)
            .expect("cleanup stale restore rows");
        assert_eq!(removed, 0);

        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id.as_str()],
                |row| row.get(0),
            )
            .expect("count remaining row");
        assert_eq!(remaining, 1);
    }

    #[test]
    fn prepare_loyalty_earn_sends_order_client_request_id_when_present() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (id, client_request_id, items, total_amount, status, sync_status)
             VALUES ('order-loyalty-earn-1', 'client-req-loyalty-earn-1', '[]', 12.5, 'completed', 'synced')",
            [],
        )
        .expect("seed local order");

        let item = queue_item(
            "loyalty_transactions",
            "INSERT",
            "loyalty-row-earn-1",
            json!({
                "transaction_type": "earn",
                "customer_id": "customer-loyalty-1",
                "order_id": "order-loyalty-earn-1",
                "amount_cents": 1250,
                "description": "Visit award"
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_loyalty_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        assert_eq!(request.endpoint, "/api/pos/loyalty/earn");
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        // The admin re-keys orders on sync ingest, so the POS-local order id
        // is unresolvable there. client_request_id is the value the order
        // sync sent as client_order_id, which the loyalty routes resolve.
        assert_eq!(
            body.get("order_id").and_then(Value::as_str),
            Some("client-req-loyalty-earn-1")
        );
        assert_eq!(
            body.get("idempotency_key").and_then(Value::as_str),
            Some("loyalty:loyalty-row-earn-1")
        );
    }

    #[test]
    fn prepare_loyalty_redeem_sends_order_client_request_id_when_present() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (id, client_request_id, items, total_amount, status, sync_status)
             VALUES ('order-loyalty-redeem-1', 'client-req-loyalty-redeem-1', '[]', 30.0, 'completed', 'synced')",
            [],
        )
        .expect("seed local order");

        let item = queue_item(
            "loyalty_transactions",
            "INSERT",
            "loyalty-row-redeem-1",
            json!({
                "transaction_type": "redeem",
                "customer_id": "customer-loyalty-2",
                "order_id": "order-loyalty-redeem-1",
                "points": -50,
                "description": "Redeem at checkout"
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_loyalty_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        assert_eq!(request.endpoint, "/api/pos/loyalty/redeem");
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("order_id").and_then(Value::as_str),
            Some("client-req-loyalty-redeem-1")
        );
        // The redeem sign flip is pre-existing behavior that must survive
        // the order-reference change.
        assert_eq!(body.get("points").and_then(Value::as_i64), Some(50));
        assert_eq!(
            body.get("idempotency_key").and_then(Value::as_str),
            Some("loyalty:loyalty-row-redeem-1")
        );
    }

    #[test]
    fn prepare_loyalty_request_falls_back_to_local_order_id_without_client_request_id() {
        let conn = test_connection();
        // Pre-v12 rows have no client_request_id; the order sync sent the
        // local id as client_order_id for them, so the local id is the value
        // the server can still resolve.
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status)
             VALUES ('order-loyalty-legacy-1', '[]', 8.0, 'completed', 'synced')",
            [],
        )
        .expect("seed local order");

        let item = queue_item(
            "loyalty_transactions",
            "INSERT",
            "loyalty-row-legacy-1",
            json!({
                "transaction_type": "earn",
                "customer_id": "customer-loyalty-3",
                "order_id": "order-loyalty-legacy-1",
                "amount_cents": 800
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_loyalty_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("order_id").and_then(Value::as_str),
            Some("order-loyalty-legacy-1")
        );
    }

    #[test]
    fn prepare_loyalty_request_ignores_blank_client_request_id() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO orders (id, client_request_id, items, total_amount, status, sync_status)
             VALUES ('order-loyalty-blank-1', '  ', '[]', 8.0, 'completed', 'synced')",
            [],
        )
        .expect("seed local order");

        let item = queue_item(
            "loyalty_transactions",
            "INSERT",
            "loyalty-row-blank-1",
            json!({
                "transaction_type": "earn",
                "customer_id": "customer-loyalty-4",
                "order_id": "order-loyalty-blank-1",
                "amount_cents": 400
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_loyalty_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("order_id").and_then(Value::as_str),
            Some("order-loyalty-blank-1")
        );
    }

    #[test]
    fn prepare_loyalty_request_keeps_payload_order_id_when_order_row_is_missing() {
        let conn = test_connection();
        // No local order row (e.g. replay after the order was pruned): send
        // the payload id unchanged; the admin route degrades to an unlinked
        // ledger row when it cannot resolve the id.
        let item = queue_item(
            "loyalty_transactions",
            "INSERT",
            "loyalty-row-orphan-1",
            json!({
                "transaction_type": "earn",
                "customer_id": "customer-loyalty-5",
                "order_id": "order-loyalty-gone-1",
                "amount_cents": 600
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_loyalty_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("order_id").and_then(Value::as_str),
            Some("order-loyalty-gone-1")
        );
    }

    #[test]
    fn prepare_loyalty_request_sends_null_order_id_for_orderless_transactions() {
        let conn = test_connection();
        let item = queue_item(
            "loyalty_transactions",
            "INSERT",
            "loyalty-row-orderless-1",
            json!({
                "transaction_type": "earn",
                "customer_id": "customer-loyalty-6",
                "amount_cents": 200,
                "description": "Birthday award"
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_loyalty_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(body.get("order_id"), Some(&Value::Null));
        // The order-less idempotency anchor is the local row id.
        assert_eq!(
            body.get("idempotency_key").and_then(Value::as_str),
            Some("loyalty:loyalty-row-orderless-1")
        );
    }

    #[test]
    fn prepare_payment_request_defers_while_parent_order_update_is_pending() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-payment-waits', 'remote-order-payment-waits', '[]', 7.5, 750, 'pending', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'pay-waits-for-order-update', 'order-payment-waits', 'cash', 0.5, 50, 'completed', 'pending', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed payment");
        enqueue_test_item(
            &conn,
            "orders",
            "UPDATE",
            "order-payment-waits",
            json!({
                "orderId": "order-payment-waits",
                "orderType": "delivery",
                "totalAmount": 7.5,
            }),
        );

        let payload = json!({
            "orderId": "order-payment-waits",
            "amount": 0.5,
            "method": "cash",
        });
        let item = queue_item(
            "payments",
            "INSERT",
            "pay-waits-for-order-update",
            payload.clone(),
        );
        let request = prepare_payment_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare payment request");

        match request {
            RequestPreparation::Deferred { reason } => {
                assert_eq!(reason, "Waiting for parent order update sync");
            }
            other => panic!("expected deferred payment request, got {other:?}"),
        }

        let (sync_state, sync_error): (String, Option<String>) = conn
            .query_row(
                "SELECT sync_state, sync_last_error
                 FROM order_payments
                 WHERE id = 'pay-waits-for-order-update'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read payment state");
        assert_eq!(sync_state, "waiting_parent");
        assert_eq!(sync_error.as_deref(), Some("Order update not yet synced"));
    }

    #[test]
    fn prepare_payment_request_includes_remote_and_local_payment_identity() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-payment-identity', 'remote-order-payment-identity', '[]', 10.4, 1040, 'completed', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, sync_status, sync_state, remote_payment_id, idempotency_key, created_at, updated_at
             ) VALUES (
                 'pay-identity', 'order-payment-identity', 'card', 10.4, 1040, 'completed', 'pending', 'pending', 'remote-payment-identity', 'legacy-payment-key', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed payment");

        let payload = json!({
            "paymentId": "pay-identity",
            "orderId": "order-payment-identity",
            "amount": 10.4,
            "method": "card",
            "remote_payment_id": "remote-payment-identity",
            "canonical_payment_id": "remote-payment-identity",
            "idempotency_key": "legacy-payment-key",
            "transactionRef": "CARD-IDENTITY-1",
        });
        let item = queue_item("payments", "INSERT", "pay-identity", payload.clone());
        let request = match prepare_payment_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare payment request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready payment request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");

        assert_eq!(
            body.get("remote_payment_id").and_then(Value::as_str),
            Some("remote-payment-identity")
        );
        assert_eq!(
            body.get("canonical_payment_id").and_then(Value::as_str),
            Some("remote-payment-identity")
        );
        assert_eq!(
            body.get("paymentId").and_then(Value::as_str),
            Some("pay-identity")
        );
        assert_eq!(
            body.pointer("/metadata/local_payment_id")
                .and_then(Value::as_str),
            Some("pay-identity")
        );
        assert_eq!(
            body.pointer("/metadata/local_order_id")
                .and_then(Value::as_str),
            Some("order-payment-identity")
        );
        assert_eq!(
            body.pointer("/metadata/legacy_idempotency_key")
                .and_then(Value::as_str),
            Some("legacy-payment-key")
        );
        assert_eq!(
            body.pointer("/metadata/canonical_idempotency_key")
                .and_then(Value::as_str),
            Some("payment:pay-identity")
        );
        assert_eq!(
            body.pointer("/metadata/transaction_ref")
                .and_then(Value::as_str),
            Some("CARD-IDENTITY-1")
        );
    }

    #[test]
    fn prepare_payment_request_keeps_local_table_session_in_metadata() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-table-payment-local-session', 'remote-order-table-payment-local-session',
                 '[]', 22.0, 2200, 'completed', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed table order");

        let payload = json!({
            "paymentId": "pay-table-local-session",
            "orderId": "order-table-payment-local-session",
            "amount": 11.0,
            "method": "cash",
            "tipAmount": 1.5,
            "tableSessionId": "local-table-session:order-table-payment-local-session",
            "seatNumber": 2,
        });
        let item = queue_item(
            "payments",
            "INSERT",
            "pay-table-local-session",
            payload.clone(),
        );
        let request = match prepare_payment_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare table payment request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready payment request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse payment request body");

        assert_eq!(body.get("table_session_id"), None);
        assert_eq!(
            body.pointer("/metadata/local_table_session_id")
                .and_then(Value::as_str),
            Some("local-table-session:order-table-payment-local-session")
        );
        assert_eq!(body.get("tip_amount").and_then(Value::as_f64), Some(1.5));
        assert_eq!(body.get("seat_number").and_then(Value::as_i64), Some(2));
    }

    #[test]
    fn prepare_table_session_update_defers_local_placeholder_without_remote_mapping() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        // A close UPDATE keyed by the renderer's local placeholder, with no
        // prior INSERT-success mapping on the (also-missing) local order.
        let item = queue_item(
            "restaurant_table_sessions",
            "UPDATE",
            "local-table-session:34ccc66a-ab4d-4b1d-bef2-0869f42088c7",
            json!({
                "action": "close",
                "status": "closed",
                "release_status": "cleaning",
                "force": true,
                "branch_id": TEST_BRANCH_ID
            }),
        );

        match prepare_request(&conn, &item).expect("prepare table-session update") {
            RequestPreparation::Deferred { reason } => {
                assert_eq!(reason, "Waiting for remote table session id");
            }
            other => panic!(
                "expected local placeholder close to defer, not send the invalid \
                 /api/pos/table-sessions/local-table-session:... path; got {other:?}"
            ),
        }
    }

    #[test]
    fn classifies_table_session_local_placeholder_uuid_error() {
        // The exact admin HTTP 500 observed in production for a close UPDATE that
        // was routed to /api/pos/table-sessions/local-table-session:... before the
        // deferral fix landed.
        let observed = r#"HTTP 500: {"success":false,"error":"invalid input syntax for type uuid: \"local-table-session:34ccc66a-ab4d-4b1d-bef2-0869f42088c7\""}"#;
        assert!(is_table_session_local_placeholder_uuid_error(observed));
        assert!(is_table_session_local_placeholder_uuid_error(
            "HTTP 405: Method Not Allowed"
        ));

        // A real-uuid syntax error that is NOT the local-placeholder path must not
        // be swept by this recovery.
        assert!(!is_table_session_local_placeholder_uuid_error(
            r#"HTTP 500: {"error":"invalid input syntax for type uuid: \"not-a-uuid\""}"#
        ));

        // Outstanding-balance / waiting-payment close failures belong to a
        // different recovery path and must stay out of scope here.
        assert!(!is_table_session_local_placeholder_uuid_error(
            r#"HTTP 409: {"error":"Table session has an outstanding balance"}"#
        ));
    }

    fn seed_failed_table_session_row(
        conn: &Connection,
        table_name: &str,
        operation: &str,
        record_id: &str,
        error_message: &str,
    ) -> String {
        let id = enqueue_test_item(
            conn,
            table_name,
            operation,
            record_id,
            json!({ "action": "close", "status": "closed" }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed', attempts = 10, error_message = ?2
             WHERE id = ?1",
            params![id, error_message],
        )
        .expect("seed failed parity row");
        id
    }

    #[test]
    fn requeues_failed_local_placeholder_table_session_rows() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        // Matching row: close UPDATE keyed by the local placeholder, failed after
        // 10 attempts with the admin invalid-uuid error.
        let matching = seed_failed_table_session_row(
            &conn,
            "restaurant_table_sessions",
            "UPDATE",
            "local-table-session:34ccc66a-ab4d-4b1d-bef2-0869f42088c7",
            r#"HTTP 500: {"success":false,"error":"invalid input syntax for type uuid: \"local-table-session:34ccc66a-ab4d-4b1d-bef2-0869f42088c7\""}"#,
        );

        // A real-uuid session id failing for an unrelated reason: out of scope.
        let unrelated = seed_failed_table_session_row(
            &conn,
            "restaurant_table_sessions",
            "UPDATE",
            "11111111-1111-4111-8111-111111111111",
            r#"HTTP 409: {"error":"Table session has an outstanding balance"}"#,
        );

        // A payments row carrying a look-alike error must never be touched.
        let payment = seed_failed_table_session_row(
            &conn,
            "payments",
            "INSERT",
            "local-table-session:34ccc66a-ab4d-4b1d-bef2-0869f42088c7",
            r#"HTTP 500: {"error":"invalid input syntax for type uuid: \"local-table-session:34ccc66a-ab4d-4b1d-bef2-0869f42088c7\""}"#,
        );

        let result = retry_failed_table_session_local_placeholder_items_limited(
            &conn,
            MAX_AUTO_REQUEUE_ITEMS_PER_CYCLE,
        )
        .expect("requeue local placeholder table session rows");
        assert_eq!(result.retried, 1);

        let (status, attempts, error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, error_message FROM parity_sync_queue WHERE id = ?1",
                params![matching],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read requeued row");
        assert_eq!(status, "pending");
        assert_eq!(attempts, 0);
        assert!(
            error.is_none(),
            "requeue must clear the stale error message"
        );

        // The unrelated table-session row and the payment row stay failed.
        for id in [unrelated, payment] {
            let status: String = conn
                .query_row(
                    "SELECT status FROM parity_sync_queue WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .expect("read untouched row");
            assert_eq!(status, "failed", "row {id} must not be requeued");
        }
    }

    #[test]
    fn requeue_local_placeholder_table_session_rows_respects_budget() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        for n in 0..3 {
            seed_failed_table_session_row(
                &conn,
                "restaurant_table_sessions",
                "UPDATE",
                &format!("local-table-session:order-{n}"),
                r#"HTTP 500: {"error":"invalid input syntax for type uuid: \"local-table-session:order\""}"#,
            );
        }

        // Zero budget is a no-op.
        let none = retry_failed_table_session_local_placeholder_items_limited(&conn, 0)
            .expect("zero-budget requeue");
        assert_eq!(none.retried, 0);

        // A budget below the candidate count caps how many rows are requeued.
        let capped = retry_failed_table_session_local_placeholder_items_limited(&conn, 2)
            .expect("capped requeue");
        assert_eq!(capped.retried, 2);

        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("count pending rows");
        assert_eq!(
            pending, 2,
            "budget must cap requeues to the remaining cycle budget"
        );
    }

    #[test]
    fn table_session_insert_success_maps_remote_id_and_close_update_uses_it() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        // Local order created before the open INSERT round-tripped; its
        // table_session_id is still the local placeholder.
        conn.execute(
            "INSERT INTO orders (
                 id, items, total_amount, status, sync_status,
                 table_session_id, created_at, updated_at
             ) VALUES (
                 'local-table-order-9', '[]', 24.5, 'completed', 'synced',
                 'local-table-session:local-table-order-9', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed local table order");

        // Open INSERT succeeds and returns the remote session UUID.
        let remote_session_id = "11111111-1111-4111-8111-111111111111";
        let insert_item = queue_item(
            "restaurant_table_sessions",
            "INSERT",
            "table-session-open-event-9",
            json!({
                "client_event_id": "table-session-open-event-9",
                "branch_id": TEST_BRANCH_ID,
                "primary_table_id": "table-9",
                "active_order_client_id": "local-table-order-9"
            }),
        );
        let response = json!({
            "success": true,
            "session": { "id": remote_session_id }
        });
        apply_success(&conn, &insert_item, Some(&response)).expect("apply table-session insert");

        let mapped: String = conn
            .query_row(
                "SELECT table_session_id FROM orders WHERE id = 'local-table-order-9'",
                [],
                |row| row.get(0),
            )
            .expect("read mapped table_session_id");
        assert_eq!(mapped, remote_session_id);

        // A later close UPDATE keyed by the local placeholder now resolves to
        // the remote UUID path.
        let close_item = queue_item(
            "restaurant_table_sessions",
            "UPDATE",
            "local-table-session:local-table-order-9",
            json!({
                "action": "close",
                "status": "closed",
                "release_status": "cleaning",
                "force": true,
                "branch_id": TEST_BRANCH_ID
            }),
        );
        match prepare_request(&conn, &close_item).expect("prepare table-session close") {
            RequestPreparation::Ready(spec) => {
                assert_eq!(
                    spec.endpoint,
                    format!("/api/pos/table-sessions/{remote_session_id}")
                );
                assert_eq!(spec.method, Method::PATCH);
            }
            other => panic!("expected resolved close request, got {other:?}"),
        }
    }

    #[test]
    fn unresolved_paid_table_session_close_is_consumed_locally() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let local_order_id = "34ccc66a-ab4d-4b1d-bef2-0869f42088c7";
        let remote_order_id = "19b13a49-dc22-4dcf-b9c8-054afdf2a0e9";

        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, status, sync_status,
                 payment_status, table_id, table_number, guest_count,
                 branch_id, client_request_id, created_at, updated_at
             ) VALUES (
                 ?1, ?2, '[]', 10.5, 'completed', 'synced',
                 'paid', '81193c14-1334-4fc6-b474-db14b7a0a53f', 'B01', 1,
                 ?3, '44a7bacf-d9e7-4e53-b3a2-e08928f964c4',
                 datetime('now'), datetime('now')
             )",
            params![local_order_id, remote_order_id, TEST_BRANCH_ID],
        )
        .expect("seed paid local table order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status,
                 sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 '846dca19-bcda-4937-9eac-0d3d5201506a', ?1, 'cash',
                 10.5, 1050, 'completed', 'synced', 'applied',
                 datetime('now'), datetime('now')
             )",
            params![local_order_id],
        )
        .expect("seed completed local payment");

        let close_item = queue_item(
            "restaurant_table_sessions",
            "UPDATE",
            &format!("local-table-session:{local_order_id}"),
            json!({
                "action": "close",
                "status": "closed",
                "release_status": "cleaning",
                "force": true,
                "client_event_id": "pos-tauri-table-close-local-table-session",
                "branch_id": TEST_BRANCH_ID
            }),
        );

        match prepare_request(&conn, &close_item).expect("prepare orphan close") {
            RequestPreparation::Consumed { reason } => {
                assert!(reason.contains(local_order_id));
                assert!(reason.contains(remote_order_id));
            }
            other => panic!("expected local consume outcome, got {other:?}"),
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_drains_obsolete_paid_table_session_close_without_http() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);
        let local_order_id = "34ccc66a-ab4d-4b1d-bef2-0869f42088c7";
        let remote_order_id = "19b13a49-dc22-4dcf-b9c8-054afdf2a0e9";

        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, status, sync_status,
                 payment_status, table_id, table_number, guest_count,
                 branch_id, created_at, updated_at
             ) VALUES (
                 ?1, ?2, '[]', 10.5, 'completed', 'synced',
                 'paid', '81193c14-1334-4fc6-b474-db14b7a0a53f', 'B01', 1,
                 ?3, datetime('now'), datetime('now')
             )",
            params![local_order_id, remote_order_id, TEST_BRANCH_ID],
        )
        .expect("seed paid local table order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status,
                 sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'pay-reconciled-close', ?1, 'cash', 10.5, 1050,
                 'completed', 'synced', 'applied', datetime('now'), datetime('now')
             )",
            params![local_order_id],
        )
        .expect("seed completed local payment");

        let queue_id = enqueue(
            &conn,
            &EnqueueInput {
                table_name: "restaurant_table_sessions".to_string(),
                record_id: format!("local-table-session:{local_order_id}"),
                operation: "UPDATE".to_string(),
                data: json!({
                    "action": "close",
                    "status": "closed",
                    "release_status": "cleaning",
                    "force": true,
                    "branch_id": TEST_BRANCH_ID
                })
                .to_string(),
                organization_id: "org-1".to_string(),
                priority: Some(0),
                module_type: Some("table_service".to_string()),
                conflict_strategy: Some("server-wins".to_string()),
                version: Some(1),
            },
        )
        .expect("enqueue orphan close");

        let conn = std::sync::Mutex::new(conn);
        let result = process_queue(&conn, "http://127.0.0.1:9", "api-key")
            .await
            .expect("process queue");
        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(remaining, 0);

        clear_terminal_identity();
    }

    #[test]
    fn prepare_request_keeps_non_uuid_table_session_in_payment_metadata() {
        // Guard: the new table-session resolution path must not alter how the
        // payments path stows a non-UUID table session id into metadata.
        let conn = test_connection();
        seed_terminal_context(&conn);

        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status,
                 created_at, updated_at
             ) VALUES (
                 'order-metadata-guard', 'remote-order-metadata-guard',
                 '[]', 18.0, 1800, 'completed', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed payment order");

        let item = queue_item(
            "payments",
            "INSERT",
            "pay-metadata-guard",
            json!({
                "paymentId": "pay-metadata-guard",
                "orderId": "order-metadata-guard",
                "amount": 18.0,
                "method": "cash",
                "tableSessionId": "local-table-session:order-metadata-guard"
            }),
        );

        let spec = match prepare_request(&conn, &item).expect("prepare payment via dispatcher") {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready payment request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(spec.body.as_deref().expect("payment body"))
            .expect("parse payment body");

        assert_eq!(body.get("table_session_id"), None);
        assert_eq!(
            body.pointer("/metadata/local_table_session_id")
                .and_then(Value::as_str),
            Some("local-table-session:order-metadata-guard")
        );
    }

    #[test]
    fn prepare_payment_request_includes_settlement_adjustments() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-payment-settlement', 'remote-order-payment-settlement', '[]', 4.89, 489, 'completed', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'pay-settlement', 'order-payment-settlement', 'card', 15.19, 1519, 'completed', 'pending', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed payment");

        let settlement_adjustment = json!({
            "adjustment_id": "adj-settlement",
            "payment_id": "pay-settlement",
            "order_id": "order-payment-settlement",
            "adjustment_type": "refund",
            "adjustment_context": "edit_settlement",
            "amount": 10.30,
            "amount_cents": 1030,
            "idempotency_key": "adjustment:adj-settlement",
        });
        let payload = json!({
            "paymentId": "pay-settlement",
            "orderId": "order-payment-settlement",
            "amount": 15.19,
            "method": "card",
            "settlement_adjustments": [settlement_adjustment],
        });
        let item = queue_item("payments", "INSERT", "pay-settlement", payload.clone());
        let request = match prepare_payment_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare payment request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready payment request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        let proof_rows = body
            .get("settlement_adjustments")
            .and_then(Value::as_array)
            .expect("settlement proof rows");

        assert_eq!(proof_rows.len(), 1);
        assert_eq!(
            proof_rows[0].get("amount_cents").and_then(Value::as_i64),
            Some(1030)
        );
        assert_eq!(
            body.pointer("/metadata/settlement_refund_total")
                .and_then(Value::as_f64),
            Some(10.3)
        );
        assert_eq!(
            body.pointer("/metadata/settlement_net_payment_amount")
                .and_then(Value::as_f64),
            Some(4.89)
        );
    }

    #[test]
    fn retry_failed_legacy_order_insert_items_requeues_known_validation_failures() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-legacy-4",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentData": {
                    "method": "cash"
                },
                "total": 9.5,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 9.5,
                    "name": "Burger",
                    "customizations": [{
                        "optionId": "well-done",
                        "name": "Well Done"
                    }]
                }]
            }),
        );
        let unrelated_queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-legacy-5",
            json!({
                "branchId": TEST_BRANCH_ID,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 4.0,
                    "name": "Tea"
                }]
            }),
        );

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 3,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id,
                r#"HTTP 400: {"success":false,"error":"Validation failed","details":[{"field":"items.0.customizations","message":"Expected object, received array"},{"field":"order_type","message":"Required"},{"field":"payment_method","message":"Required"},{"field":"total_amount","message":"Required"}]}"#
            ],
        )
        .expect("seed failed legacy validation error");
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 2,
                 error_message = ?2
             WHERE id = ?1",
            params![
                unrelated_queue_id,
                "HTTP 400: some other validation failure"
            ],
        )
        .expect("seed unrelated failure");

        let result = retry_failed_legacy_order_insert_items_limited(&conn, 1)
            .expect("retry failed legacy order rows");
        assert_eq!(result.retried, 1);

        let retried_row: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, error_message
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retried queue row");
        assert_eq!(retried_row.0, "pending");
        assert_eq!(retried_row.1, 0);
        assert_eq!(retried_row.2, None);

        let unrelated_status: String = conn
            .query_row(
                "SELECT status FROM parity_sync_queue WHERE id = ?1",
                params![unrelated_queue_id],
                |row| row.get(0),
            )
            .expect("read unrelated queue row");
        assert_eq!(unrelated_status, "failed");
    }

    #[test]
    fn retry_failed_order_update_requeues_customizations_shape_failures() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "UPDATE",
            "order-update-customizations",
            json!({
                "orderId": "order-update-customizations",
                "status": "pending",
                "items": [{
                    "menu_item_id": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "unit_price": 6.4,
                    "name": "Crepe",
                    "customizations": []
                }]
            }),
        );

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 1,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id,
                r#"HTTP 400: {"success":false,"error":"Validation failed","details":[{"field":"items.0.customizations","message":"Expected object, received array"}]}"#
            ],
        )
        .expect("seed failed update validation error");

        let result = retry_failed_legacy_order_insert_items_limited(&conn, 1)
            .expect("retry failed order update row");
        assert_eq!(result.retried, 1);

        let retried_row: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, error_message
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retried queue row");
        assert_eq!(retried_row.0, "pending");
        assert_eq!(retried_row.1, 0);
        assert_eq!(retried_row.2, None);
    }

    #[test]
    fn retry_failed_legacy_order_insert_items_requeues_tip_amount_validation_failures() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-legacy-tip-2",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "tipAmount": Value::Null,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 3.5,
                    "name": "Tea"
                }]
            }),
        );

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 2,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id,
                r#"HTTP 400: {"success":false,"error":"Validation failed","details":[{"field":"tip_amount","message":"Expected number, received null"}]}"#
            ],
        )
        .expect("seed tip amount validation failure");

        let result = retry_failed_legacy_order_insert_items_limited(&conn, 1)
            .expect("retry failed legacy order rows");
        assert_eq!(result.retried, 1);

        let retried_row: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, error_message
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retried queue row");
        assert_eq!(retried_row.0, "pending");
        assert_eq!(retried_row.1, 0);
        assert_eq!(retried_row.2, None);
    }

    #[test]
    fn retry_failed_legacy_order_insert_items_requeues_schema_cache_failures() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-schema-cache-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "delivery",
                "paymentMethod": "cash",
                "countryCode": "gr",
                "pricingMode": "gross",
                "totalAmount": 4.79,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 4.79,
                    "name": "Crepe"
                }]
            }),
        );

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 4,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id,
                "HTTP 500: {\"success\":false,\"error\":\"Failed to create order\",\"details\":\"Failed to create order: Could not find the 'country_code' column of 'orders' in the schema cache\"}"
            ],
        )
        .expect("seed schema cache validation failure");

        let result = retry_failed_legacy_order_insert_items_limited(&conn, 1)
            .expect("retry failed legacy order rows");
        assert_eq!(result.retried, 1);

        let retried_row: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, error_message
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retried queue row");
        assert_eq!(retried_row.0, "pending");
        assert_eq!(retried_row.1, 0);
        assert_eq!(retried_row.2, None);
    }

    #[test]
    fn retry_failed_legacy_order_insert_items_requeues_duplicate_order_number_failures() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-duplicate-number-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "totalAmount": 6.5,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 6.5,
                    "name": "Toast"
                }]
            }),
        );

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 3,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id,
                "HTTP 500: {\"success\":false,\"error\":\"Failed to create order\",\"details\":\"Failed to create order: duplicate key value violates unique constraint \\\"uq_orders_order_number\\\"\"}"
            ],
        )
        .expect("seed duplicate order number failure");

        let result = retry_failed_legacy_order_insert_items_limited(&conn, 1)
            .expect("retry failed legacy order rows");
        assert_eq!(result.retried, 1);

        let retried_row: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, error_message
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retried queue row");
        assert_eq!(retried_row.0, "pending");
        assert_eq!(retried_row.1, 0);
        assert_eq!(retried_row.2, None);
    }

    #[test]
    fn retry_failed_legacy_order_insert_items_requeues_parent_customer_repair_failures() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-customer-parent-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "delivery",
                "paymentMethod": "card",
                "customerId": "dac7359e-6f88-44df-bca9-2dee9898d0cf",
                "customerName": "WOLT",
                "customerPhone": "111",
                "totalAmount": 7.95,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 7.95,
                    "name": "Manual item",
                    "customizations": {}
                }]
            }),
        );

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 50,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id,
                "HTTP 500: {\"success\":false,\"error\":\"Failed to create order\",\"details\":\"Customer not found in organization\"}"
            ],
        )
        .expect("seed customer parent validation failure");

        let result = retry_failed_legacy_order_insert_items_limited(&conn, 1)
            .expect("retry failed order parent customer row");
        assert_eq!(result.retried, 1);

        let retried_row: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, error_message
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retried queue row");
        assert_eq!(retried_row.0, "pending");
        assert_eq!(retried_row.1, 0);
        assert_eq!(retried_row.2, None);
    }

    #[test]
    fn retry_failed_rate_limited_items_requeues_a_bounded_batch() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_ids: Vec<String> = (0..4)
            .map(|index| {
                enqueue_test_item(
                    &conn,
                    "orders",
                    "INSERT",
                    &format!("order-rate-limit-{index}"),
                    json!({
                        "branchId": TEST_BRANCH_ID,
                        "orderType": "pickup",
                        "paymentMethod": "cash",
                        "totalAmount": 5.0 + index as f64,
                        "items": [{
                            "menuItemId": TEST_MENU_ITEM_ID,
                            "quantity": 1,
                            "price": 5.0 + index as f64,
                            "name": format!("Item {index}"),
                            "customizations": {}
                        }]
                    }),
                )
            })
            .collect();

        for queue_id in &queue_ids {
            conn.execute(
                "UPDATE parity_sync_queue
                 SET status = 'failed',
                     error_message = ?2
                 WHERE id = ?1",
                params![
                    queue_id,
                    r#"HTTP 429: {"success":false,"error":"Rate limit exceeded. Maximum 20 requests per 60 seconds."}"#
                ],
            )
            .expect("seed rate-limited failure");
        }

        let result =
            retry_failed_rate_limited_items_limited(&conn, 2).expect("requeue rate-limited rows");
        assert_eq!(result.retried, 2);

        let pending_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("count pending rows");
        let failed_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'failed'",
                [],
                |row| row.get(0),
            )
            .expect("count failed rows");

        assert_eq!(pending_count, 2);
        assert_eq!(failed_count, 2);
    }

    #[test]
    fn invalid_fiscal_issued_at_error_accepts_server_error_name_variants() {
        for error_name in [
            "InvalidFiscalReceiptInput",
            "Invalid FiscalReceiptInput",
            "Invalid Fiscal Receipt Input",
            "invalid_fiscal_receipt_input",
        ] {
            let error = format!(
                r#"HTTP 400: {{"error":"{error_name}","issues":[{{"validation":"datetime","message":"Invalid datetime","path":["issuedAt"]}}]}}"#
            );
            assert!(
                is_invalid_fiscal_issued_at_error(&error),
                "should match fiscal issuedAt datetime error variant: {error_name}"
            );
        }
    }

    #[test]
    fn retry_failed_invalid_fiscal_issued_at_items_rewrites_payload_and_requeues() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let queue_id = enqueue(
            &conn,
            &EnqueueInput {
                table_name: "fiscal_submission".to_string(),
                record_id: "ord-fiscal-retry-date".to_string(),
                operation: "INSERT".to_string(),
                data: json!({
                    "organizationId": "org-1",
                    "branchId": TEST_BRANCH_ID,
                    "orderId": "ord-fiscal-retry-date",
                    "receiptNumber": "R-FISCAL-RETRY-DATE",
                    "issuedAt": "2026-06-19 11:35:00",
                    "totals": {
                        "netCents": 2540,
                        "vatCents": 610,
                        "grossCents": 3150,
                        "currency": "EUR"
                    },
                    "vatBreakdown": [],
                    "lines": [],
                    "payments": [],
                    "metadata": {}
                })
                .to_string(),
                organization_id: "org-1".to_string(),
                priority: Some(100),
                module_type: Some("fiscal".to_string()),
                conflict_strategy: Some("last-write-wins".to_string()),
                version: Some(1),
            },
        )
        .expect("enqueue fiscal row");
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 10,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id.as_str(),
                r#"HTTP 400: {"error":"InvalidFiscalReceiptInput","issues":[{"code":"invalid_string","validation":"datetime","message":"Invalid datetime","path":["issuedAt"]}]}"#
            ],
        )
        .expect("seed invalid fiscal failure");

        let result = retry_failed_invalid_fiscal_issued_at_items_limited(&conn, 1)
            .expect("retry failed fiscal issuedAt rows");
        assert_eq!(result.retried, 1);

        let (status, attempts, error_message, data): (String, i64, Option<String>, String) = conn
            .query_row(
                "SELECT status, attempts, error_message, data
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read fiscal row");
        let payload = serde_json::from_str::<Value>(&data).expect("parse fiscal data");

        assert_eq!(status, "pending");
        assert_eq!(attempts, 0);
        assert_eq!(error_message, None);
        assert_eq!(
            payload.get("issuedAt").and_then(Value::as_str),
            Some("2026-06-19T11:35:00.000Z")
        );
    }

    #[test]
    fn resolve_failed_payment_total_conflict_items_limited_voids_stale_overpay_rows_using_server_hint(
    ) {
        let conn = test_connection();
        seed_terminal_context(&conn);

        // W4e Step 0: dual-populate (9.50 → 950, 4.79 → 479, 0.55 → 55).
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, payment_status,
                payment_transaction_id, sync_status, created_at, updated_at
             ) VALUES (
                'ord-payment-stale', '[]', 9.50, 950, 'completed', 'paid',
                'pay-valid', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed order");
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, currency, status,
                remote_payment_id, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                'pay-valid', 'ord-payment-stale', 'cash', 4.79, 479, 'EUR', 'completed',
                'remote-pay-valid', 'synced', 'applied', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed canonical payment");
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, currency, status,
                sync_status, sync_state, created_at, updated_at
             ) VALUES (
                'pay-stale', 'ord-payment-stale', 'cash', 0.55, 55, 'EUR', 'completed',
                'failed', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed stale overpay");

        let queue_id = enqueue_test_item(
            &conn,
            "payments",
            "INSERT",
            "pay-stale",
            json!({
                "paymentId": "pay-stale",
                "orderId": "ord-payment-stale",
                "amount": 0.55
            }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 error_message = ?1
             WHERE id = ?2",
            params![
                "HTTP 422: {\"success\":false,\"error\":\"Payment exceeds order total\",\"details\":\"Order total: 4.79, tip: 0, existing completed: 4.79, payment: 0.55\"}",
                queue_id.as_str()
            ],
        )
        .expect("seed failed payment total conflict");

        let result = resolve_failed_payment_total_conflict_items_limited(&conn, 1)
            .expect("resolve payment total conflicts");
        assert_eq!(result.retried, 1);

        let (status, sync_status, sync_state): (String, String, String) = conn
            .query_row(
                "SELECT status, sync_status, sync_state
                 FROM order_payments
                 WHERE id = 'pay-stale'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read stale payment row");
        assert_eq!(status, "voided");
        assert_eq!(sync_status, "synced");
        assert_eq!(sync_state, "applied");

        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id.as_str()],
                |row| row.get(0),
            )
            .expect("count payment parity rows");
        assert_eq!(remaining, 0);
    }

    #[allow(clippy::too_many_arguments)]
    fn seed_repair_aggregate_queue_row(
        conn: &Connection,
        id: &str,
        organization_id: &str,
        repair_id: &str,
        record_id: &str,
        version: i64,
        created_at: &str,
        priority: i64,
        status: &str,
        next_retry_at: Option<&str>,
        last_attempt: Option<&str>,
        claim_generation: i64,
    ) {
        let table_name = if record_id == repair_id {
            "repairs"
        } else {
            "repair_attachments"
        };
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, last_attempt, error_message, next_retry_at,
                 retry_delay_ms, priority, module_type, conflict_strategy, version,
                 repair_aggregate_id, claim_generation, status
             ) VALUES (?1, ?2, ?3, 'INSERT', 'opaque', ?4, ?5, 0, ?6, NULL, ?7,
                       1000, ?8, 'repairs', 'manual', ?9, ?10, ?11, ?12)",
            params![
                id,
                table_name,
                record_id,
                organization_id,
                created_at,
                last_attempt,
                next_retry_at,
                priority,
                version,
                repair_id,
                claim_generation,
                status,
            ],
        )
        .expect("seed repair aggregate queue row");
        if table_name == "repair_attachments" {
            conn.execute(
                "INSERT INTO repair_attachment_staging (
                     organization_id, branch_id, terminal_id, attachment_id, repair_id,
                     operation_id, queue_id, expected_version, scope_generation, file_key,
                     metadata_nonce, metadata_ciphertext, sha256_hex, mime_type, size_bytes,
                     state, created_at, updated_at
                 ) VALUES (
                     ?1, 'branch-test', 'terminal-test', ?2, ?3, ?4, ?4, ?5, 1,
                     'test-cipher.part', zeroblob(12), zeroblob(16),
                     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                     'image/jpeg', 1, 'queued', ?6, ?6
                 )",
                params![
                    organization_id,
                    record_id,
                    repair_id,
                    id,
                    version,
                    created_at
                ],
            )
            .expect("seed repair attachment staging binding");
        }
    }

    fn seed_generic_ordering_row(
        conn: &Connection,
        id: &str,
        organization_id: &str,
        created_at: &str,
        priority: i64,
    ) {
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, repair_aggregate_id, status
             ) VALUES (?1, 'orders', ?2, 'UPDATE', '{}', ?3, ?4, 1000, ?5,
                       'orders', 'server-wins', 1, NULL, 'pending')",
            params![
                id,
                format!("record-{id}"),
                organization_id,
                created_at,
                priority
            ],
        )
        .expect("seed generic ordering row");
    }

    #[test]
    fn repair_aggregate_peek_and_dequeue_use_lexicographic_head_before_priority() {
        const ORG: &str = "11111111-1111-4111-8111-111111111111";
        const REPAIR: &str = "22222222-2222-4222-8222-222222222222";
        const ATTACHMENT: &str = "33333333-3333-4333-8333-333333333333";
        const ATTACHMENT_OP: &str = "44444444-4444-4444-8444-444444444444";
        const COMMAND_OP: &str = "55555555-5555-4555-8555-555555555555";
        let conn = test_connection();
        seed_repair_aggregate_queue_row(
            &conn,
            ATTACHMENT_OP,
            ORG,
            REPAIR,
            ATTACHMENT,
            1,
            "2026-08-26T10:01:00Z",
            90,
            "pending",
            None,
            None,
            0,
        );
        seed_repair_aggregate_queue_row(
            &conn,
            COMMAND_OP,
            ORG,
            REPAIR,
            REPAIR,
            2,
            "2026-08-26T09:00:00Z",
            100,
            "pending",
            None,
            None,
            0,
        );

        assert_eq!(
            peek(&conn).unwrap().expect("aggregate head").id,
            ATTACHMENT_OP,
            "lower expected version must win within an aggregate despite global priority/time"
        );
        let first = dequeue(&conn).unwrap().expect("claim aggregate head");
        assert_eq!(first.id, ATTACHMENT_OP);
        assert!(
            peek(&conn).unwrap().is_none(),
            "an in-flight row must freeze every successor in the same aggregate"
        );
        mark_success(&conn, ATTACHMENT_OP, first.claim_generation).unwrap();
        assert_eq!(
            peek(&conn).unwrap().expect("successor unlocked").id,
            COMMAND_OP
        );
    }

    #[test]
    fn repair_aggregate_equal_version_orders_by_created_at_then_id() {
        const ORG: &str = "11111111-1111-4111-8111-111111111111";
        const REPAIR: &str = "22222222-2222-4222-8222-222222222222";
        const EARLY_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        const TIE_LOW_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const TIE_HIGH_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let conn = test_connection();
        for (id, created_at, priority) in [
            (EARLY_ID, "2026-08-26T09:59:00Z", 1),
            (TIE_HIGH_ID, "2026-08-26T10:00:00Z", 200),
            (TIE_LOW_ID, "2026-08-26T10:00:00Z", 100),
        ] {
            seed_repair_aggregate_queue_row(
                &conn, id, ORG, REPAIR, REPAIR, 7, created_at, priority, "pending", None, None, 0,
            );
        }
        assert_eq!(
            peek(&conn).unwrap().expect("earliest equal-version row").id,
            EARLY_ID,
            "created_at precedes id and global priority inside an aggregate"
        );
        conn.execute("DELETE FROM parity_sync_queue WHERE id = ?1", [EARLY_ID])
            .unwrap();
        assert_eq!(
            peek(&conn).unwrap().expect("id tie-break row").id,
            TIE_LOW_ID,
            "id is the deterministic final predecessor key when version/time tie"
        );
    }

    #[test]
    fn repair_aggregate_unresolved_rows_and_later_conflict_block_only_their_stream() {
        const ORG: &str = "11111111-1111-4111-8111-111111111111";
        const BLOCKED_REPAIR: &str = "22222222-2222-4222-8222-222222222222";
        const OTHER_REPAIR: &str = "33333333-3333-4333-8333-333333333333";
        for (case, blocker_status, blocker_version, candidate_version, next_retry, last_attempt) in [
            (
                "pending_future_predecessor",
                "pending",
                1,
                2,
                Some("2099-01-01T00:00:00Z"),
                None,
            ),
            ("failed_predecessor", "failed", 1, 2, None, None),
            (
                "processing_later",
                "processing",
                2,
                1,
                None,
                Some("2026-08-26T10:00:00Z"),
            ),
            ("conflict_later", "conflict", 2, 1, None, None),
        ] {
            let conn = test_connection();
            let blocker_id = format!("{case}-blocker");
            let candidate_id = format!("{case}-candidate");
            let other_id = format!("{case}-other");
            seed_repair_aggregate_queue_row(
                &conn,
                &blocker_id,
                ORG,
                BLOCKED_REPAIR,
                BLOCKED_REPAIR,
                blocker_version,
                "2026-08-26T10:00:00Z",
                1,
                blocker_status,
                next_retry,
                last_attempt,
                3,
            );
            seed_repair_aggregate_queue_row(
                &conn,
                &candidate_id,
                ORG,
                BLOCKED_REPAIR,
                BLOCKED_REPAIR,
                candidate_version,
                "2026-08-26T10:01:00Z",
                100,
                "pending",
                None,
                None,
                0,
            );
            seed_repair_aggregate_queue_row(
                &conn,
                &other_id,
                ORG,
                OTHER_REPAIR,
                OTHER_REPAIR,
                0,
                "2026-08-26T10:02:00Z",
                1,
                "pending",
                None,
                None,
                0,
            );
            assert_eq!(
                peek(&conn).unwrap().expect("unblocked repair").id,
                other_id,
                "{case} must freeze only its own aggregate"
            );
        }
    }

    #[test]
    fn repair_aggregate_ordering_is_org_scoped_and_preserves_generic_global_priority() {
        const ORG_A: &str = "11111111-1111-4111-8111-111111111111";
        const ORG_B: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const REPAIR_A: &str = "22222222-2222-4222-8222-222222222222";
        const REPAIR_B: &str = "33333333-3333-4333-8333-333333333333";
        let conn = test_connection();
        seed_repair_aggregate_queue_row(
            &conn,
            "org-b-conflict",
            ORG_B,
            REPAIR_A,
            REPAIR_A,
            9,
            "2026-08-26T09:00:00Z",
            1,
            "conflict",
            None,
            None,
            0,
        );
        seed_repair_aggregate_queue_row(
            &conn,
            "org-a-repair-a",
            ORG_A,
            REPAIR_A,
            REPAIR_A,
            0,
            "2026-08-26T10:00:00Z",
            50,
            "pending",
            None,
            None,
            0,
        );
        seed_repair_aggregate_queue_row(
            &conn,
            "org-a-repair-b",
            ORG_A,
            REPAIR_B,
            REPAIR_B,
            0,
            "2026-08-26T10:01:00Z",
            60,
            "pending",
            None,
            None,
            0,
        );
        seed_generic_ordering_row(
            &conn,
            "generic-high-priority",
            ORG_A,
            "2026-08-26T10:02:00Z",
            200,
        );

        assert_eq!(dequeue(&conn).unwrap().unwrap().id, "generic-high-priority");
        assert_eq!(
            peek(&conn).unwrap().unwrap().id,
            "org-a-repair-b",
            "priority remains global across unrelated eligible aggregates"
        );
        conn.execute(
            "DELETE FROM parity_sync_queue WHERE id = 'org-a-repair-b'",
            [],
        )
        .unwrap();
        assert_eq!(
            peek(&conn).unwrap().unwrap().id,
            "org-a-repair-a",
            "same aggregate id in another organization must not freeze this tenant"
        );
    }

    #[test]
    fn repair_aggregate_reserved_owner_lookalikes_are_quarantined_before_claim() {
        const ORG: &str = "11111111-1111-4111-8111-111111111111";
        const REPAIR_A: &str = "22222222-2222-4222-8222-222222222222";
        const REPAIR_B: &str = "33333333-3333-4333-8333-333333333333";
        let conn = test_connection();
        seed_repair_aggregate_queue_row(
            &conn,
            "malformed-repair-module",
            ORG,
            REPAIR_A,
            REPAIR_A,
            0,
            "2026-08-26T10:00:00Z",
            200,
            "pending",
            None,
            None,
            0,
        );
        conn.execute(
            "UPDATE parity_sync_queue SET table_name = 'orders'
              WHERE id = 'malformed-repair-module'",
            [],
        )
        .unwrap();
        seed_repair_aggregate_queue_row(
            &conn,
            "malformed-repair-table",
            ORG,
            REPAIR_B,
            REPAIR_B,
            0,
            "2026-08-26T10:01:00Z",
            190,
            "pending",
            None,
            None,
            0,
        );
        conn.execute(
            "UPDATE parity_sync_queue SET module_type = 'orders'
              WHERE id = 'malformed-repair-table'",
            [],
        )
        .unwrap();
        seed_generic_ordering_row(
            &conn,
            "valid-generic-after-malformed",
            ORG,
            "2026-08-26T10:02:00Z",
            1,
        );

        assert_eq!(
            peek(&conn).unwrap().expect("valid generic candidate").id,
            "valid-generic-after-malformed"
        );
        assert_eq!(
            dequeue(&conn)
                .unwrap()
                .expect("claim valid generic only")
                .id,
            "valid-generic-after-malformed"
        );
        for id in ["malformed-repair-module", "malformed-repair-table"] {
            let (status, error): (String, Option<String>) = conn
                .query_row(
                    "SELECT status, error_message FROM parity_sync_queue WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(status, "failed");
            assert_eq!(error.as_deref(), Some(REPAIR_RESERVED_OWNER_QUARANTINED));
        }
    }

    #[test]
    fn repair_aggregate_semantically_malformed_native_rows_are_never_claimable() {
        const ORG: &str = "11111111-1111-4111-8111-111111111111";
        const REPAIR: &str = "22222222-2222-4222-8222-222222222222";
        const ATTACHMENT: &str = "33333333-3333-4333-8333-333333333333";
        const INVALID_COMMAND: &str = "44444444-4444-4444-8444-444444444444";
        const UNBOUND_ATTACHMENT: &str = "55555555-5555-4555-8555-555555555555";
        let conn = test_connection();
        seed_repair_aggregate_queue_row(
            &conn,
            INVALID_COMMAND,
            ORG,
            REPAIR,
            REPAIR,
            0,
            "2026-08-26T10:00:00Z",
            200,
            "pending",
            None,
            None,
            0,
        );
        conn.execute(
            "UPDATE parity_sync_queue SET operation = 'UPDATE' WHERE id = ?1",
            [INVALID_COMMAND],
        )
        .expect("malform repair command operation");
        seed_repair_aggregate_queue_row(
            &conn,
            UNBOUND_ATTACHMENT,
            ORG,
            REPAIR,
            ATTACHMENT,
            1,
            "2026-08-26T10:01:00Z",
            190,
            "pending",
            None,
            None,
            0,
        );
        conn.execute(
            "DELETE FROM repair_attachment_staging WHERE operation_id = ?1",
            [UNBOUND_ATTACHMENT],
        )
        .expect("remove attachment binding");
        seed_generic_ordering_row(
            &conn,
            "valid-generic-after-semantic-malformation",
            ORG,
            "2026-08-26T10:02:00Z",
            1,
        );

        assert_eq!(
            dequeue(&conn).unwrap().expect("claim generic row only").id,
            "valid-generic-after-semantic-malformation"
        );
        assert!(peek(&conn).unwrap().is_none());
        for id in [INVALID_COMMAND, UNBOUND_ATTACHMENT] {
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM parity_sync_queue WHERE id = ?1",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
                "pending"
            );
        }
    }

    #[test]
    fn unbound_repair_quarantine_freezes_only_repairs_in_its_organization() {
        const ORG_A: &str = "11111111-1111-4111-8111-111111111111";
        const ORG_B: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const REPAIR_A: &str = "22222222-2222-4222-8222-222222222222";
        const REPAIR_B: &str = "33333333-3333-4333-8333-333333333333";
        let conn = test_connection();
        seed_repair_aggregate_queue_row(
            &conn,
            "org-a-unknown-aggregate",
            ORG_A,
            REPAIR_A,
            REPAIR_A,
            0,
            "2026-08-26T09:00:00Z",
            1,
            "conflict",
            None,
            None,
            0,
        );
        conn.execute(
            "UPDATE parity_sync_queue
                SET repair_aggregate_id = NULL,
                    error_message = 'REPAIR_AGGREGATE_ID_MISSING'
              WHERE id = 'org-a-unknown-aggregate'",
            [],
        )
        .unwrap();
        seed_repair_aggregate_queue_row(
            &conn,
            "org-a-valid-repair",
            ORG_A,
            REPAIR_A,
            REPAIR_A,
            1,
            "2026-08-26T10:00:00Z",
            200,
            "pending",
            None,
            None,
            0,
        );
        seed_repair_aggregate_queue_row(
            &conn,
            "org-b-valid-repair",
            ORG_B,
            REPAIR_B,
            REPAIR_B,
            0,
            "2026-08-26T10:01:00Z",
            50,
            "pending",
            None,
            None,
            0,
        );
        seed_generic_ordering_row(
            &conn,
            "org-a-valid-generic",
            ORG_A,
            "2026-08-26T10:02:00Z",
            100,
        );

        assert_eq!(dequeue(&conn).unwrap().unwrap().id, "org-a-valid-generic");
        assert_eq!(
            peek(&conn)
                .unwrap()
                .expect("other organization remains eligible")
                .id,
            "org-b-valid-repair"
        );
        conn.execute(
            "UPDATE parity_sync_queue
                SET repair_aggregate_id = 'not-a-canonical-uuid'
              WHERE id = 'org-a-unknown-aggregate'",
            [],
        )
        .unwrap();
        assert_eq!(
            peek(&conn)
                .unwrap()
                .expect("noncanonical binding still freezes org-A")
                .id,
            "org-b-valid-repair"
        );
        conn.execute(
            "DELETE FROM parity_sync_queue WHERE id = 'org-a-unknown-aggregate'",
            [],
        )
        .unwrap();
        assert_eq!(
            peek(&conn).unwrap().expect("org-A repair unlocked").id,
            "org-a-valid-repair"
        );
    }

    #[test]
    fn repair_aggregate_stale_reclaim_restores_head_and_fences_late_ack() {
        const ORG: &str = "11111111-1111-4111-8111-111111111111";
        const REPAIR: &str = "22222222-2222-4222-8222-222222222222";
        const STALE_HEAD: &str = "66666666-6666-4666-8666-666666666666";
        const STALE_SUCCESSOR: &str = "77777777-7777-4777-8777-777777777777";
        let conn = test_connection();
        seed_repair_aggregate_queue_row(
            &conn,
            STALE_HEAD,
            ORG,
            REPAIR,
            REPAIR,
            1,
            "2000-01-01T00:00:00Z",
            1,
            "processing",
            None,
            Some("2000-01-01T00:00:00Z"),
            3,
        );
        seed_repair_aggregate_queue_row(
            &conn,
            STALE_SUCCESSOR,
            ORG,
            REPAIR,
            REPAIR,
            2,
            "2026-08-26T10:01:00Z",
            100,
            "pending",
            None,
            None,
            0,
        );

        assert_eq!(recover_stale_processing_items(&conn).unwrap(), 1);
        mark_success(&conn, STALE_HEAD, 3).expect("late ack is a fenced no-op");
        assert_eq!(
            peek(&conn).unwrap().expect("reclaimed aggregate head").id,
            STALE_HEAD
        );
        let claimed = dequeue(&conn).unwrap().expect("claim reclaimed head");
        assert_eq!(claimed.id, STALE_HEAD);
        assert_eq!(claimed.claim_generation, 5);
        assert_eq!(
            conn.query_row(
                "SELECT status FROM parity_sync_queue WHERE id = ?1",
                [STALE_SUCCESSOR],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "pending"
        );
    }

    static SEMANTIC_GAP_CLAIM_TRACE_ENABLED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    static SEMANTIC_GAP_CLAIM_BARRIERS: std::sync::OnceLock<(
        std::sync::Barrier,
        std::sync::Barrier,
    )> = std::sync::OnceLock::new();
    static SEMANTIC_GAP_PEEK_TRACE_ENABLED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    static SEMANTIC_GAP_PEEK_BARRIERS: std::sync::OnceLock<(
        std::sync::Barrier,
        std::sync::Barrier,
    )> = std::sync::OnceLock::new();

    fn pause_internal_claim_after_quarantine(sql: &str) {
        if SEMANTIC_GAP_CLAIM_TRACE_ENABLED.load(std::sync::atomic::Ordering::SeqCst)
            && sql.contains("UPDATE parity_sync_queue")
            && sql.contains("SET status = 'processing'")
        {
            let barriers = SEMANTIC_GAP_CLAIM_BARRIERS
                .get_or_init(|| (std::sync::Barrier::new(2), std::sync::Barrier::new(2)));
            barriers.0.wait();
            barriers.1.wait();
        }
    }

    fn pause_internal_peek_after_quarantine(sql: &str) {
        if SEMANTIC_GAP_PEEK_TRACE_ENABLED.load(std::sync::atomic::Ordering::SeqCst)
            && sql.contains("SELECT candidate.id")
            && sql.contains("ORDER BY candidate.priority DESC")
            && !sql.contains("UPDATE parity_sync_queue")
        {
            let barriers = SEMANTIC_GAP_PEEK_BARRIERS
                .get_or_init(|| (std::sync::Barrier::new(2), std::sync::Barrier::new(2)));
            barriers.0.wait();
            barriers.1.wait();
        }
    }

    fn seed_gap_generic_control(conn: &Connection, item_id: &str) {
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, claim_generation, status
             ) VALUES (?1, 'customers', ?2, 'UPDATE', '{\"safe\":true}',
                       'semantic-gap-org', '2026-08-26T07:00:01Z', 0, 1000, 1,
                       'customers', 'manual', 1, 0, 'pending')",
            params![item_id, format!("{item_id}-record")],
        )
        .expect("seed semantic-gap generic control");
    }

    fn insert_gap_semantic_poison(conn: &Connection, prefix: &str) {
        for (suffix, status, generation) in [
            ("pending", "pending", 0_i64),
            ("processing", "processing", 7_i64),
        ] {
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, retry_delay_ms, priority, module_type,
                     conflict_strategy, version, claim_generation, status
                 ) VALUES (?1, ?2, ?3, 'UPDATE', ?4, 'semantic-gap-org',
                           '2026-08-26T07:00:00Z', 0, 1000, 100, ?5,
                           'manual', 1, ?6, ?7)",
                params![
                    format!("{prefix}-{suffix}"),
                    "\u{2003}repairs\u{2003}",
                    format!("{prefix}-{suffix}-record"),
                    format!("private-gap-payload-{prefix}-{suffix}"),
                    "\u{2003}orders\u{2003}",
                    generation,
                    status
                ],
            )
            .expect("insert semantic-gap poison");
        }
    }

    #[test]
    #[serial_test::serial]
    fn internal_claim_and_peek_fence_unicode_poison_inserted_after_quarantine() {
        let (claim_fixture, claim_setup) = FileBackedTestDb::new("semantic-gap-claim");
        seed_gap_generic_control(&claim_setup, "semantic-gap-claim-control");
        let mut claim_worker = claim_fixture.open_race_connection();
        claim_worker.trace(Some(pause_internal_claim_after_quarantine));
        SEMANTIC_GAP_CLAIM_TRACE_ENABLED.store(true, std::sync::atomic::Ordering::SeqCst);
        let claim_thread = std::thread::spawn(move || dequeue(&claim_worker));
        let claim_barriers = SEMANTIC_GAP_CLAIM_BARRIERS
            .get_or_init(|| (std::sync::Barrier::new(2), std::sync::Barrier::new(2)));
        claim_barriers.0.wait();
        let blocked_insert = claim_setup.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, claim_generation, status
             ) VALUES (
                 'semantic-gap-claim-blocked', '\u{2003}repairs\u{2003}',
                 'semantic-gap-claim-blocked-record', 'UPDATE',
                 'private-gap-payload-blocked', 'semantic-gap-org',
                 '2026-08-26T07:00:00Z', 0, 1000, 100,
                 '\u{2003}orders\u{2003}', 'manual', 1, 0, 'pending'
             )",
            [],
        );
        assert!(
            matches!(
                &blocked_insert,
                Err(rusqlite::Error::SqliteFailure(code, _))
                    if code.code == rusqlite::ErrorCode::DatabaseBusy
                        || code.code == rusqlite::ErrorCode::DatabaseLocked
            ),
            "BEGIN IMMEDIATE must fence insertion between quarantine and claim: {blocked_insert:?}"
        );
        claim_barriers.1.wait();
        let claimed = claim_thread
            .join()
            .expect("join semantic-gap claimant")
            .expect("semantic-gap dequeue")
            .expect("generic control remains claimable");
        SEMANTIC_GAP_CLAIM_TRACE_ENABLED.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(claimed.id, "semantic-gap-claim-control");
        insert_gap_semantic_poison(&claim_setup, "semantic-gap-claim-poison");
        let (next_item, newly_quarantined) =
            dequeue_with_quarantine_count(&claim_setup).expect("next atomic quarantine/claim pass");
        assert!(next_item.is_none());
        assert_eq!(
            newly_quarantined, 2,
            "the next atomic pass must authoritatively report both parked rows"
        );
        assert_eq!(
            claim_setup
                .query_row(
                    "SELECT status, claim_generation FROM parity_sync_queue
                     WHERE id = 'semantic-gap-claim-poison-processing'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .expect("read quarantined processing poison"),
            ("failed".to_string(), 8)
        );

        let (peek_fixture, peek_setup) = FileBackedTestDb::new("semantic-gap-peek");
        seed_gap_generic_control(&peek_setup, "semantic-gap-peek-control");
        let mut peek_worker = peek_fixture.open_race_connection();
        peek_worker.trace(Some(pause_internal_peek_after_quarantine));
        SEMANTIC_GAP_PEEK_TRACE_ENABLED.store(true, std::sync::atomic::Ordering::SeqCst);
        let peek_thread = std::thread::spawn(move || peek(&peek_worker));
        let peek_barriers = SEMANTIC_GAP_PEEK_BARRIERS
            .get_or_init(|| (std::sync::Barrier::new(2), std::sync::Barrier::new(2)));
        peek_barriers.0.wait();
        insert_gap_semantic_poison(&peek_setup, "semantic-gap-peek-poison");
        let peek_pending_before =
            full_queue_row_fingerprint(&peek_setup, "semantic-gap-peek-poison-pending");
        let peek_processing_before =
            full_queue_row_fingerprint(&peek_setup, "semantic-gap-peek-poison-processing");
        peek_barriers.1.wait();
        let peeked = peek_thread
            .join()
            .expect("join semantic-gap peeker")
            .expect("semantic-gap peek")
            .expect("generic control remains visible internally");
        SEMANTIC_GAP_PEEK_TRACE_ENABLED.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(peeked.id, "semantic-gap-peek-control");
        assert_eq!(
            full_queue_row_fingerprint(&peek_setup, "semantic-gap-peek-poison-pending"),
            peek_pending_before,
            "the statement-local peek predicate must not deserialize the gap poison"
        );
        assert_eq!(
            full_queue_row_fingerprint(&peek_setup, "semantic-gap-peek-poison-processing"),
            peek_processing_before
        );
        assert_eq!(
            quarantine_reserved_repair_lookalikes(&peek_setup).expect("quarantine peek-gap poison"),
            2
        );
        assert_eq!(
            peek_setup
                .query_row(
                    "SELECT status, claim_generation FROM parity_sync_queue
                     WHERE id = 'semantic-gap-peek-poison-processing'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .expect("read quarantined peek processing poison"),
            ("failed".to_string(), 8)
        );
    }

    #[test]
    #[serial_test::serial]
    fn repair_dequeue_claim_is_atomic_across_two_connections() {
        const ORG: &str = "11111111-1111-4111-8111-111111111111";
        const REPAIR: &str = "22222222-2222-4222-8222-222222222222";
        let directory = crate::tests::harness::TempDir::new();
        let state = crate::db::init(directory.path()).expect("create file-backed queue database");
        {
            let connection = state.conn.lock().expect("lock seed connection");
            seed_repair_aggregate_queue_row(
                &connection,
                "atomic-repair-head",
                ORG,
                REPAIR,
                REPAIR,
                0,
                "2026-08-26T10:00:00Z",
                100,
                "pending",
                None,
                None,
                0,
            );
        }
        let database_path = state.db_path.clone();
        drop(state);
        let start = std::sync::Arc::new(std::sync::Barrier::new(3));
        let workers = (0..2)
            .map(|_| {
                let path = database_path.clone();
                let start = start.clone();
                std::thread::spawn(move || {
                    let connection = Connection::open(path).expect("open worker connection");
                    connection
                        .execute_batch("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")
                        .expect("configure worker connection");
                    start.wait();
                    dequeue(&connection)
                })
            })
            .collect::<Vec<_>>();
        start.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().expect("join claim worker"))
            .collect::<Vec<_>>();
        let claimed = results
            .iter()
            .filter_map(|result| result.as_ref().ok().and_then(Option::as_ref))
            .collect::<Vec<_>>();
        assert!(
            results.iter().all(Result::is_ok),
            "both concurrent dequeue calls must complete: {results:?}"
        );
        assert_eq!(
            claimed.len(),
            1,
            "only one worker may claim the aggregate head"
        );
        assert_eq!(claimed[0].id, "atomic-repair-head");
        let verification = Connection::open(database_path).expect("open verification connection");
        assert_eq!(
            verification
                .query_row(
                    "SELECT status, claim_generation FROM parity_sync_queue
                      WHERE id = 'atomic-repair-head'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap(),
            ("processing".to_string(), 1)
        );
    }

    #[test]
    fn dequeue_marks_item_processing_and_records_last_attempt() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let item_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-processing-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "totalAmount": 5,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 5,
                    "name": "Espresso"
                }]
            }),
        );

        let dequeued = dequeue(&conn).expect("dequeue item");
        let item = dequeued.expect("expected queued item");
        assert_eq!(item.id, item_id);

        let (status, last_attempt): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_attempt
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query dequeued item");

        assert_eq!(status, "processing");
        assert!(last_attempt.is_some());
    }

    #[test]
    fn recover_stale_processing_items_requeues_abandoned_rows() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let item_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-stale-processing-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "totalAmount": 5,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 5,
                    "name": "Espresso"
                }]
            }),
        );

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'processing',
                 created_at = '2000-01-01T00:00:00Z',
                 last_attempt = NULL
             WHERE id = ?1",
            params![item_id],
        )
        .expect("mark stale processing row");

        let recovered =
            recover_stale_processing_items(&conn).expect("recover stale processing rows");
        assert_eq!(recovered, 1);

        let (status, last_attempt): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_attempt
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query recovered row");

        assert_eq!(status, "pending");
        assert!(last_attempt.is_none());
    }

    async fn spawn_strict_order_insert_server() -> (
        String,
        mpsc::UnboundedReceiver<CapturedRequest>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind strict mock server");
        let address = listener.local_addr().expect("strict mock server address");
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept request");
            let captured = read_http_request(&mut stream).await;
            tx.send(CapturedRequest {
                request_line: captured.request_line.clone(),
                headers: captured.headers.clone(),
                body: captured.body.clone(),
            })
            .expect("send captured request");

            let response = match serde_json::from_str::<Value>(&captured.body) {
                Ok(body)
                    if captured.request_line == "POST /api/pos/orders HTTP/1.1"
                        && body.get("branch_id").and_then(Value::as_str)
                            == Some(TEST_BRANCH_ID)
                        && body.get("order_type").and_then(Value::as_str).is_some()
                        && body.get("payment_method").and_then(Value::as_str).is_some()
                        && body.get("total_amount").and_then(Value::as_f64).is_some()
                        && body
                            .get("items")
                            .and_then(Value::as_array)
                            .and_then(|items| items.first())
                            .and_then(|item| item.get("customizations"))
                            .and_then(Value::as_object)
                            .is_some() =>
                {
                    MockResponse::json(200, r#"{"success":true,"data":{"id":"remote-order-1"}}"#)
                }
                _ => MockResponse::json(
                    400,
                    r#"{"success":false,"error":"Validation failed","details":[{"field":"items.0.customizations","message":"Expected object, received array"},{"field":"order_type","message":"Required"},{"field":"payment_method","message":"Required"},{"field":"total_amount","message":"Required"}]}"#,
                ),
            };

            write_http_response(&mut stream, &response)
                .await
                .expect("write strict mock response");
        });

        (format!("http://{}", address), rx, handle)
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn renderer_exact_retry_processes_only_the_selected_row_under_one_gate() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);
        let earlier_id = enqueue_test_item(
            &conn,
            "customers",
            "INSERT",
            "cust-earlier",
            json!({ "name": "Earlier Customer" }),
        );
        let target_id = enqueue_test_item(
            &conn,
            "customers",
            "INSERT",
            "cust-target",
            json!({ "name": "Target Customer" }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
                SET priority = CASE id WHEN ?1 THEN 100 ELSE 1 END,
                    status = CASE id WHEN ?2 THEN 'failed' ELSE status END,
                    attempts = CASE id WHEN ?2 THEN 7 ELSE attempts END,
                    error_message = CASE id WHEN ?2 THEN 'manual retry sentinel' ELSE error_message END
              WHERE id IN (?1, ?2)",
            params![earlier_id, target_id],
        )
        .expect("arrange exact renderer retry order");
        let earlier_before = full_queue_row_fingerprint(&conn, &earlier_id);
        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) =
            spawn_mock_http_server(vec![MockResponse::json(200, r#"{"success":true}"#)]).await;
        let gate_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let gate_counter = gate_calls.clone();

        let result = process_queue_renderer_safe_item_with_claim_gate(
            &conn,
            &base_url,
            "api-key",
            &target_id,
            move || {
                gate_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .expect("process exact renderer item");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(gate_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let request = requests.recv().await.expect("selected request");
        assert!(request.body.contains("Target Customer"));
        let connection = conn.lock().expect("inspect exact renderer retry");
        assert_eq!(
            full_queue_row_fingerprint(&connection, &earlier_id),
            earlier_before,
            "the higher-priority FIFO row was changed by an exact-ID retry"
        );
        assert!(full_queue_row_fingerprint(&connection, &target_id).is_none());
        drop(connection);
        server.await.expect("mock exact renderer server");
    }

    #[tokio::test]
    async fn renderer_exact_retry_blocked_gate_is_byte_for_byte_zero_mutation() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let item_id = enqueue_test_item(
            &conn,
            "customers",
            "INSERT",
            "cust-blocked",
            json!({ "name": "Blocked Customer" }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
                SET status = 'failed', attempts = 5, error_message = 'blocked sentinel'
              WHERE id = ?1",
            [&item_id],
        )
        .expect("arrange blocked exact retry");
        let before = full_queue_row_fingerprint(&conn, &item_id);
        let conn = std::sync::Mutex::new(conn);

        let result = process_queue_renderer_safe_item_with_claim_gate(
            &conn,
            "http://127.0.0.1:9",
            "unused-api-key",
            &item_id,
            || Err::<(), _>(ParityClaimGateBlock::Cancelled),
        )
        .await
        .expect("blocked exact retry returns bounded result");

        assert_eq!(result.batch_block, Some(ParityClaimGateBlock::Cancelled));
        assert_eq!(result.processed + result.failed + result.conflicts, 0);
        let connection = conn.lock().expect("inspect blocked exact retry");
        assert_eq!(full_queue_row_fingerprint(&connection, &item_id), before);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn renderer_exact_generic_409_is_one_request_conflict_and_preserves_unrelated_row() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);
        let target_id = enqueue_test_item(
            &conn,
            "customers",
            "UPDATE",
            "customer-exact-409",
            json!({ "name": "PRIVATE TARGET 409 PAYLOAD" }),
        );
        let unrelated_id = enqueue_test_item(
            &conn,
            "customers",
            "UPDATE",
            "customer-unrelated-409",
            json!({ "name": "PRIVATE UNRELATED 409 PAYLOAD" }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
                SET status = 'failed', attempts = 2,
                    conflict_strategy = 'manual', error_message = 'retry sentinel'
              WHERE id IN (?1, ?2)",
            params![target_id, unrelated_id],
        )
        .expect("arrange exact 409 retry rows");
        let unrelated_before = full_queue_row_fingerprint(&conn, &unrelated_id);
        let conn = std::sync::Mutex::new(conn);
        let (base_url, observed, release, server) =
            spawn_blocked_first_response_server(MockResponse::json(
                409,
                r#"{"success":false,"error":"version conflict","private":"PRIVATE 409 RESPONSE"}"#,
            ))
            .await;

        let processor = process_queue_renderer_safe_item_with_claim_gate(
            &conn,
            &base_url,
            "api-key",
            &target_id,
            || Ok(()),
        );
        tokio::pin!(processor);
        tokio::select! {
            _ = observed => release.send(()).expect("release exact 409 response"),
            _ = &mut processor => panic!("exact 409 processor finished before sending its request"),
        }
        let result = processor.await.expect("classify exact generic 409");
        let requests = server.await.expect("join exact 409 server");

        assert_eq!(requests.len(), 1, "exact 409 retry made follow-up HTTP");
        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 1);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].http_status, Some(409));
        let exposed = serde_json::to_string(&result).expect("serialize bounded exact 409 result");
        assert!(!exposed.contains("PRIVATE TARGET 409 PAYLOAD"));
        assert!(!exposed.contains("PRIVATE UNRELATED 409 PAYLOAD"));
        assert!(!exposed.contains("PRIVATE 409 RESPONSE"));
        let connection = conn.lock().expect("inspect exact 409 rows");
        assert_eq!(
            full_queue_row_fingerprint(&connection, &unrelated_id),
            unrelated_before,
            "exact 409 retry changed an unrelated actionable row"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn renderer_exact_generic_500_is_one_request_bounded_retry_and_preserves_unrelated_row() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status,
                 payment_status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-exact-500', 'remote-order-exact-500', '[]', 29.4, 2940,
                 'pending', 'paid', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed fallback-prone exact order update");
        let target_id = enqueue_test_item(
            &conn,
            "orders",
            "UPDATE",
            "order-exact-500",
            json!({
                "orderId": "order-exact-500",
                "status": "pending",
                "paymentStatus": "paid",
                "totalAmount": 29.4,
                "items": [{
                    "menu_item_id": TEST_MENU_ITEM_ID,
                    "name": "PRIVATE TARGET 500 PAYLOAD",
                    "quantity": 1,
                    "unit_price": 29.4
                }]
            }),
        );
        let unrelated_id = enqueue_test_item(
            &conn,
            "customers",
            "UPDATE",
            "customer-unrelated-500",
            json!({ "name": "PRIVATE UNRELATED 500 PAYLOAD" }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
                SET status = 'failed', attempts = 2, error_message = 'retry sentinel'
              WHERE id IN (?1, ?2)",
            params![target_id, unrelated_id],
        )
        .expect("arrange exact 500 retry rows");
        let unrelated_before = full_queue_row_fingerprint(&conn, &unrelated_id);
        let conn = std::sync::Mutex::new(conn);
        let (base_url, observed, release, server) =
            spawn_blocked_first_response_server(MockResponse::json(
                500,
                r#"{"success":false,"error":"Failed to update order","private":"PRIVATE 500 RESPONSE"}"#,
            ))
            .await;

        let processor = process_queue_renderer_safe_item_with_claim_gate(
            &conn,
            &base_url,
            "api-key",
            &target_id,
            || Ok(()),
        );
        tokio::pin!(processor);
        tokio::select! {
            _ = observed => release.send(()).expect("release exact 500 response"),
            _ = &mut processor => panic!("exact 500 processor finished before sending its request"),
        }
        let result = processor.await.expect("classify exact generic 500");
        let requests = server.await.expect("join exact 500 server");

        assert_eq!(requests.len(), 1, "exact 500 retry made follow-up HTTP");
        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 1);
        assert_eq!(result.conflicts, 0);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].http_status, Some(500));
        assert_eq!(result.errors[0].error, "HTTP_500_SERVER_ERROR");
        let exposed = serde_json::to_string(&result).expect("serialize bounded exact 500 result");
        assert!(!exposed.contains("PRIVATE TARGET 500 PAYLOAD"));
        assert!(!exposed.contains("PRIVATE UNRELATED 500 PAYLOAD"));
        assert!(!exposed.contains("PRIVATE 500 RESPONSE"));
        let connection = conn.lock().expect("inspect exact 500 rows");
        assert_eq!(
            full_queue_row_fingerprint(&connection, &unrelated_id),
            unrelated_before,
            "exact 500 retry changed an unrelated actionable row"
        );
        let target_after = full_queue_row_fingerprint(&connection, &target_id)
            .expect("500 target remains retryable");
        assert!(target_after.contains("HTTP_500_SERVER_ERROR"));
        assert!(!target_after.contains("PRIVATE 500 RESPONSE"));
    }

    #[test]
    fn renderer_module_retry_inventory_is_read_only_bounded_and_deterministic() {
        let conn = test_connection();
        let first = enqueue_test_item(&conn, "customers", "INSERT", "module-first", json!({}));
        let second = enqueue_test_item(&conn, "customers", "INSERT", "module-second", json!({}));
        let third = enqueue_test_item(&conn, "customers", "INSERT", "module-third", json!({}));
        conn.execute(
            "UPDATE parity_sync_queue
                SET priority = CASE id WHEN ?1 THEN 30 WHEN ?2 THEN 20 ELSE 10 END,
                    status = CASE id WHEN ?2 THEN 'failed' WHEN ?3 THEN 'conflict' ELSE status END
              WHERE id IN (?1, ?2, ?3)",
            params![first, second, third],
        )
        .expect("arrange module inventory ordering");
        let before = [
            full_queue_row_fingerprint(&conn, &first),
            full_queue_row_fingerprint(&conn, &second),
            full_queue_row_fingerprint(&conn, &third),
        ];

        assert_eq!(
            renderer_retryable_item_ids_by_module(&conn, "customers", 2)
                .expect("list bounded renderer module IDs"),
            vec![first.clone(), second.clone()]
        );
        assert_eq!(
            renderer_retryable_item_ids_by_module(&conn, "repairs", 10),
            Err("REPAIR_TYPED_CONFLICT_REQUIRED".to_string())
        );
        assert_eq!(
            [
                full_queue_row_fingerprint(&conn, &first),
                full_queue_row_fingerprint(&conn, &second),
                full_queue_row_fingerprint(&conn, &third),
            ],
            before,
            "read-only module enumeration changed queue rows"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_sends_terminal_id_header_on_parity_requests() {
        clear_terminal_identity();
        let conn = test_connection();
        crate::db::set_setting(&conn, "terminal", "terminal_id", "terminal-test")
            .expect("store terminal id");
        let queue_id = enqueue_test_item(
            &conn,
            "customers",
            "INSERT",
            "cust-1",
            json!({ "name": "Ada Lovelace" }),
        );
        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) =
            spawn_mock_http_server(vec![MockResponse::json(200, r#"{"success":true}"#)]).await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);

        let request = requests.recv().await.expect("captured parity request");
        assert_eq!(request.request_line, "POST /api/pos/customers HTTP/1.1");
        assert_eq!(
            request.headers.get("x-terminal-id").map(String::as_str),
            Some("terminal-test")
        );
        assert_eq!(
            request.headers.get("x-pos-api-key").map(String::as_str),
            Some("api-key")
        );
        assert!(
            request.body.contains("\"name\":\"Ada Lovelace\""),
            "request body should preserve the queued payload"
        );

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(remaining, 0);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_reports_reconnect_telemetry_without_payload_or_api_key() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);
        crate::db::set_setting(&conn, "terminal", "organization_id", "org-telemetry")
            .expect("seed organization id");
        enqueue(
            &conn,
            &EnqueueInput {
                table_name: "orders".to_string(),
                record_id: "order-telemetry".to_string(),
                operation: "INSERT".to_string(),
                data: json!({
                    "branchId": TEST_BRANCH_ID,
                    "customerName": "Ada Lovelace",
                    "customerPhone": "+15555550123",
                    "orderType": "pickup",
                    "paymentMethod": "cash",
                    "totalAmount": 7.5,
                    "items": [{
                        "menuItemId": TEST_MENU_ITEM_ID,
                        "quantity": 1,
                        "price": 7.5,
                        "name": "Americano",
                        "customizations": {}
                    }]
                })
                .to_string(),
                organization_id: "org-telemetry".to_string(),
                priority: Some(0),
                module_type: Some("orders".to_string()),
                conflict_strategy: Some("server-wins".to_string()),
                version: Some(1),
            },
        )
        .expect("enqueue offline order");

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            200,
            r#"{"data":{"id":"remote-order"}}"#,
        )])
        .await;

        let result = process_queue(&conn, &base_url, "secret-api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.telemetry.queue_depth_before, 1);
        assert_eq!(result.telemetry.queue_depth_after, 0);
        assert_eq!(result.telemetry.replay_attempts, 1);
        assert_eq!(result.telemetry.terminal_auth_failures, 0);
        assert_eq!(
            result.telemetry.scope.organization_id.as_deref(),
            Some("org-telemetry")
        );
        assert_eq!(
            result.telemetry.scope.terminal_id.as_deref(),
            Some(TEST_TERMINAL_ID)
        );
        assert!(
            result.telemetry.outcomes.iter().any(|outcome| {
                outcome.module_type == "orders"
                    && outcome.status == "processed"
                    && outcome.count == 1
            }),
            "processed order outcome should be grouped for diagnostics"
        );

        let telemetry_json =
            serde_json::to_string(&result.telemetry).expect("serialize telemetry snapshot");
        assert!(
            !telemetry_json.contains("Ada Lovelace"),
            "telemetry must not serialize queued payload PII"
        );
        assert!(
            !telemetry_json.contains("+15555550123"),
            "telemetry must not serialize queued payload phone numbers"
        );
        assert!(
            !telemetry_json.contains("secret-api-key"),
            "telemetry must not serialize POS API keys"
        );

        let request = requests.recv().await.expect("captured replay request");
        assert_eq!(request.request_line, "POST /api/pos/orders HTTP/1.1");

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    async fn fetch_server_record_sends_terminal_id_header() {
        let item = queue_item(
            "customers",
            "UPDATE",
            "cust-1",
            json!({ "name": "Ada Lovelace" }),
        );
        let client = reqwest::Client::new();
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            200,
            r#"{"data":{"id":"cust-remote-1"}}"#,
        )])
        .await;

        let server_record =
            fetch_server_record(&client, &base_url, "api-key", "terminal-test", &item).await;

        assert_eq!(
            server_record
                .as_ref()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str),
            Some("cust-remote-1")
        );

        let request = requests.recv().await.expect("captured fetch request");
        assert_eq!(
            request.request_line,
            "GET /api/pos/sync/customers/cust-1 HTTP/1.1"
        );
        assert_eq!(
            request.headers.get("x-terminal-id").map(String::as_str),
            Some("terminal-test")
        );
        assert_eq!(
            request.headers.get("x-pos-api-key").map(String::as_str),
            Some("api-key")
        );

        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_marks_items_failed_when_terminal_context_is_missing() {
        clear_terminal_identity();
        let conn = test_connection();
        let queue_id = enqueue_test_item(
            &conn,
            "customers",
            "INSERT",
            "cust-1",
            json!({ "name": "Ada Lovelace" }),
        );
        let conn = std::sync::Mutex::new(conn);

        let result = process_queue(&conn, "http://127.0.0.1:9", "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 1);
        assert_eq!(result.telemetry.replay_attempts, 1);
        assert_eq!(result.telemetry.terminal_auth_failures, 1);
        assert!(
            result.telemetry.outcomes.iter().any(|outcome| {
                outcome.module_type == "customers"
                    && outcome.status == "failed"
                    && outcome.error_class == "terminal_auth"
                    && outcome.count == 1
            }),
            "missing terminal identity should be grouped as a terminal-auth failure"
        );
        assert!(result.errors.iter().any(|error| {
            error
                .error
                .contains("Parity sync request is missing terminal_id context")
        }));

        let (status, error_message): (String, Option<String>) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, error_message FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read failed queue item");
        assert_eq!(status, "failed");
        assert_eq!(
            error_message.as_deref(),
            Some("Parity sync request is missing terminal_id context")
        );

        clear_terminal_identity();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_retries_failed_missing_terminal_context_items_after_fix() {
        clear_terminal_identity();
        let conn = test_connection();
        crate::db::set_setting(&conn, "terminal", "terminal_id", "terminal-test")
            .expect("store terminal id");
        let queue_id = enqueue_test_item(
            &conn,
            "customers",
            "INSERT",
            "cust-1",
            json!({ "name": "Ada Lovelace" }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 3,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id,
                r#"HTTP 401: {"success":false,"error":"Missing terminal_id","code":"missing_terminal_id"}"#
            ],
        )
        .expect("seed failed terminal context error");

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) =
            spawn_mock_http_server(vec![MockResponse::json(200, r#"{"success":true}"#)]).await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);

        let request = requests.recv().await.expect("captured parity request");
        assert_eq!(
            request.headers.get("x-terminal-id").map(String::as_str),
            Some("terminal-test")
        );

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(remaining, 0);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_normalizes_legacy_order_insert_payloads_for_pos_orders() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);
        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-legacy-6",
            json!({
                "orderType": "pickup",
                "paymentData": {
                    "method": "wallet"
                },
                "total": 18.0,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 2,
                    "price": 9.0,
                    "name": "Pasta",
                    "customizations": [{
                        "ingredient": {
                            "name": "Parmesan"
                        },
                        "amount": "extra"
                    }]
                }]
            }),
        );
        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_strict_order_insert_server().await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);

        let request = requests
            .recv()
            .await
            .expect("captured order insert request");
        assert_eq!(request.request_line, "POST /api/pos/orders HTTP/1.1");
        assert_eq!(
            request.headers.get("x-terminal-id").map(String::as_str),
            Some(TEST_TERMINAL_ID)
        );
        let body = serde_json::from_str::<Value>(&request.body).expect("parse request body");
        assert_eq!(
            body.get("branch_id").and_then(Value::as_str),
            Some(TEST_BRANCH_ID)
        );
        assert_eq!(
            body.get("order_type").and_then(Value::as_str),
            Some("pickup")
        );
        assert_eq!(
            body.get("payment_method").and_then(Value::as_str),
            Some("digital_wallet")
        );
        assert_eq!(body.get("total_amount").and_then(Value::as_f64), Some(18.0));
        assert_eq!(body.get("tip_amount").and_then(Value::as_f64), Some(0.0));
        assert!(
            body.get("items")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("customizations"))
                .and_then(Value::as_object)
                .is_some(),
            "strict server should receive object customizations"
        );

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(remaining, 0);

        clear_terminal_identity();
        server.await.expect("strict mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_normalizes_fiscal_issued_at_before_submit() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);
        let queue_id = enqueue(
            &conn,
            &EnqueueInput {
                table_name: "fiscal_submission".to_string(),
                record_id: "ord-fiscal-date".to_string(),
                operation: "INSERT".to_string(),
                data: json!({
                    "organizationId": "org-1",
                    "branchId": TEST_BRANCH_ID,
                    "orderId": "ord-fiscal-date",
                    "receiptNumber": "R-FISCAL-DATE",
                    "issuedAt": "2026-06-19 11:35:00",
                    "totals": {
                        "netCents": 2540,
                        "vatCents": 610,
                        "grossCents": 3150,
                        "currency": "EUR"
                    },
                    "vatBreakdown": [],
                    "lines": [],
                    "payments": [],
                    "metadata": {}
                })
                .to_string(),
                organization_id: "org-1".to_string(),
                priority: Some(100),
                module_type: Some("fiscal".to_string()),
                conflict_strategy: Some("last-write-wins".to_string()),
                version: Some(1),
            },
        )
        .expect("enqueue fiscal row");
        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) =
            spawn_mock_http_server(vec![MockResponse::json(200, r#"{"success":true}"#)]).await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);

        let request = requests.recv().await.expect("captured fiscal request");
        assert_eq!(
            request.request_line,
            "POST /api/plugins/fiscal/submit HTTP/1.1"
        );
        let body = serde_json::from_str::<Value>(&request.body).expect("parse fiscal body");
        assert_eq!(
            body.get("issuedAt").and_then(Value::as_str),
            Some("2026-06-19T11:35:00.000Z")
        );

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(remaining, 0);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_keeps_429_rows_pending_and_stops_the_batch() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let first_queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-rate-limited-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "totalAmount": 7.5,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 7.5,
                    "name": "Americano",
                    "customizations": {}
                }]
            }),
        );
        let second_queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-rate-limited-2",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "totalAmount": 8.0,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 8.0,
                    "name": "Latte",
                    "customizations": {}
                }]
            }),
        );

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            429,
            r#"{"success":false,"error":"Rate limit exceeded. Maximum 20 requests per 60 seconds."}"#,
        )])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 1);

        let request = requests
            .recv()
            .await
            .expect("captured rate-limited request");
        assert_eq!(request.request_line, "POST /api/pos/orders HTTP/1.1");

        let first_row: (String, i64, Option<String>, Option<String>) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, attempts, error_message, next_retry_at
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![first_queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read first row");
        assert_eq!(first_row.0, "pending");
        assert_eq!(first_row.1, 0);
        assert_eq!(
            first_row.2.as_deref(),
            Some("HTTP_429_RATE_LIMITED"),
            "first row should preserve only the bounded rate-limit code"
        );
        assert!(
            first_row.3.is_some(),
            "first row should have a retry schedule"
        );

        let second_status: String = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status FROM parity_sync_queue WHERE id = ?1",
                params![second_queue_id],
                |row| row.get(0),
            )
            .expect("read second row");
        assert_eq!(second_status, "pending");

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_defers_table_session_open_when_parent_order_is_not_synced() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "restaurant_table_sessions",
            "INSERT",
            "table-session-event-1",
            json!({
                "client_event_id": "table-session-event-1",
                "branch_id": TEST_BRANCH_ID,
                "primary_table_id": "table-1",
                "table_id": "table-1",
                "table_number": "T1",
                "guest_count": 2,
                "active_order_client_id": "local-table-order-1"
            }),
        );

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            409,
            r#"{"success":false,"error":"Waiting for parent order sync before opening table session"}"#,
        )])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);

        let request = requests
            .recv()
            .await
            .expect("captured table-session request");
        assert_eq!(
            request.request_line,
            "POST /api/pos/table-sessions HTTP/1.1"
        );

        let row: (String, i64, Option<String>, Option<String>) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, attempts, error_message, next_retry_at
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read deferred table-session row");
        assert_eq!(row.0, "pending");
        assert_eq!(row.1, 1);
        assert_eq!(row.2.as_deref(), Some("Waiting for parent order sync"));
        assert!(row.3.is_some(), "deferred row should have a retry time");

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_retries_legacy_order_update_without_items_after_generic_admin_500() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status,
                 created_at, updated_at
             )
             VALUES (
                 'local-discounted-order', 'remote-discounted-order',
                 '[]', 29.4, 2940, 'pending', 'pending',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed discounted order");

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "UPDATE",
            "local-discounted-order",
            json!({
                "orderId": "local-discounted-order",
                "status": "pending",
                "totalAmount": 29.4,
                "subtotal": 31.5,
                "discountAmount": 2.1,
                "paymentStatus": "paid",
                "items": [
                    {
                        "menu_item_id": TEST_MENU_ITEM_ID,
                        "name": "Prosciutto Pizza",
                        "quantity": 1,
                        "unit_price": 18.9,
                        "original_unit_price": 21,
                        "is_price_overridden": true
                    },
                    {
                        "menu_item_id": "33333333-3333-4333-9333-333333333333",
                        "name": "Chocolate Fondant",
                        "quantity": 1,
                        "unit_price": 10.5,
                        "total_price": 10.5
                    }
                ]
            }),
        );

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![
            MockResponse::json(500, r#"{"success":false,"error":"Failed to update order"}"#),
            MockResponse::json(
                200,
                r#"{"success":true,"data":{"id":"remote-discounted-order"}}"#,
            ),
        ])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);

        let first_request = requests.recv().await.expect("captured first request");
        assert_eq!(first_request.request_line, "PATCH /api/pos/orders HTTP/1.1");
        let first_body: Value =
            serde_json::from_str(&first_request.body).expect("parse first body");
        assert!(
            first_body.get("items").is_some(),
            "first request should preserve item replacement payload"
        );

        let second_request = requests.recv().await.expect("captured fallback request");
        assert_eq!(
            second_request.request_line,
            "PATCH /api/pos/orders HTTP/1.1"
        );
        let second_body: Value =
            serde_json::from_str(&second_request.body).expect("parse fallback body");
        assert_eq!(second_body["id"], json!("remote-discounted-order"));
        assert_eq!(second_body["total_amount"], json!(29.4));
        assert_eq!(second_body["discount_amount"], json!(2.1));
        assert!(
            second_body.get("items").is_none(),
            "fallback request must omit item replacement for legacy admin"
        );

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*)
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read fallback row count");
        assert_eq!(remaining, 0);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_retries_legacy_order_update_with_minimal_body_after_itemless_retry_fails(
    ) {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status,
                 created_at, updated_at
             )
             VALUES (
                 'local-discounted-order-minimal', 'remote-discounted-order-minimal',
                 '[]', 29.4, 2940, 'pending', 'pending',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed discounted order");

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "UPDATE",
            "local-discounted-order-minimal",
            json!({
                "orderId": "local-discounted-order-minimal",
                "status": "pending",
                "totalAmount": 29.4,
                "subtotal": 31.5,
                "discountAmount": 2.1,
                "paymentStatus": "paid",
                "items": [
                    {
                        "menu_item_id": TEST_MENU_ITEM_ID,
                        "name": "Prosciutto Pizza",
                        "quantity": 1,
                        "unit_price": 18.9,
                        "original_unit_price": 21,
                        "is_price_overridden": true
                    },
                    {
                        "menu_item_id": "33333333-3333-4333-9333-333333333333",
                        "name": "Chocolate Fondant",
                        "quantity": 1,
                        "unit_price": 10.5,
                        "total_price": 10.5
                    }
                ]
            }),
        );

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![
            MockResponse::json(500, r#"{"success":false,"error":"Failed to update order"}"#),
            MockResponse::json(500, r#"{"success":false,"error":"Failed to update order"}"#),
            MockResponse::json(
                200,
                r#"{"success":true,"data":{"id":"remote-discounted-order-minimal"}}"#,
            ),
        ])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);

        let first_request = requests.recv().await.expect("captured first request");
        let first_body: Value =
            serde_json::from_str(&first_request.body).expect("parse first body");
        assert!(
            first_body.get("items").is_some(),
            "first request should preserve item replacement payload"
        );

        let second_request = requests.recv().await.expect("captured itemless request");
        let second_body: Value =
            serde_json::from_str(&second_request.body).expect("parse itemless body");
        assert!(second_body.get("items").is_none());
        assert_eq!(second_body["discount_amount"], json!(2.1));

        let third_request = requests.recv().await.expect("captured minimal request");
        assert_eq!(third_request.request_line, "PATCH /api/pos/orders HTTP/1.1");
        let third_body: Value =
            serde_json::from_str(&third_request.body).expect("parse minimal body");
        assert_eq!(third_body["id"], json!("remote-discounted-order-minimal"));
        assert_eq!(third_body["status"], json!("pending"));
        assert_eq!(third_body["payment_status"], json!("paid"));
        assert!(
            third_body.get("items").is_none(),
            "minimal fallback must omit item replacement"
        );
        assert!(
            third_body.get("total_amount").is_none(),
            "minimal fallback must omit financial fields rejected by legacy admin"
        );
        assert!(
            third_body.get("discount_amount").is_none(),
            "minimal fallback must omit discount fields rejected by legacy admin"
        );

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*)
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read minimal fallback row count");
        assert_eq!(remaining, 0);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_defers_table_session_close_when_payment_totals_are_stale() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "restaurant_table_sessions",
            "UPDATE",
            "session-paid-local",
            json!({
                "action": "close",
                "status": "closed",
                "release_status": "cleaning",
                "client_event_id": "table-close-session-paid-local",
                "branch_id": TEST_BRANCH_ID
            }),
        );

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            409,
            r#"{"order_total":24.5,"outstanding_balance":24.5,"paid_total":0,"payment_status":"pending","tip_total":0}"#,
        )])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);

        let request = requests
            .recv()
            .await
            .expect("captured table-session close request");
        assert_eq!(
            request.request_line,
            "PATCH /api/pos/table-sessions/session-paid-local HTTP/1.1"
        );

        let row: (String, i64, Option<String>, Option<String>) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, attempts, error_message, next_retry_at
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read deferred table-session close row");
        assert_eq!(row.0, "pending");
        assert_eq!(row.1, 1);
        assert_eq!(row.2.as_deref(), Some("Waiting for table payment sync"));
        assert!(row.3.is_some(), "deferred row should have a retry time");

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_marks_non_409_version_conflicts_for_operator_review() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-version-conflict",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "totalAmount": 7.5,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 7.5,
                    "name": "Americano",
                    "customizations": {}
                }]
            }),
        );

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![
            MockResponse::json(
                412,
                r#"{"success":false,"error":"Version conflict","server_version":4}"#,
            ),
            MockResponse::json(200, r#"{"data":{"id":"remote-order","version":4}}"#),
        ])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 1);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].http_status, Some(412));

        let replay_request = requests.recv().await.expect("captured replay request");
        assert_eq!(replay_request.request_line, "POST /api/pos/orders HTTP/1.1");

        let fetch_request = requests.recv().await.expect("captured fetch request");
        assert_eq!(
            fetch_request.request_line,
            "GET /api/pos/sync/orders/order-version-conflict HTTP/1.1"
        );

        let (status, attempts): (String, i64) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, attempts
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read conflicted queue row");
        assert_eq!(status, "conflict");
        assert_eq!(attempts, 0);

        let audit_count: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*)
                 FROM conflict_audit_log
                 WHERE entity_id = 'order-version-conflict'
                   AND entity_type = 'orders'
                   AND server_version = 4",
                [],
                |row| row.get(0),
            )
            .expect("read conflict audit row");
        assert_eq!(audit_count, 1);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[test]
    fn resolve_payment_total_conflict_parity_row_with_conn_marks_success_when_local_payment_row_is_missing(
    ) {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, retry_delay_ms, priority, module_type,
                conflict_strategy, version, status, error_message
             ) VALUES (
                'queue-payment-missing-local', 'payments', 'pay-missing-local', 'INSERT',
                ?1, 'org-1', datetime('now'), 1, 1000, 0, 'financial', 'manual', 1, 'failed', ?2
             )",
            params![
                json!({
                    "amount": 0.55,
                    "method": "cash",
                    "orderId": "ord-paid-remote"
                })
                .to_string(),
                "HTTP 422: {\"success\":false,\"error\":\"Payment exceeds order total\",\"details\":\"Order total: 4.79, tip: 0, existing completed: 4.79, payment: 0.55\"}"
            ],
        )
        .expect("insert failed parity payment row");

        let resolved = resolve_payment_total_conflict_parity_row_with_conn(
            &conn,
            "queue-payment-missing-local",
            "pay-missing-local",
            &json!({
                "amount": 0.55,
                "method": "cash",
                "orderId": "ord-paid-remote"
            })
            .to_string(),
            "HTTP 422: {\"success\":false,\"error\":\"Payment exceeds order total\",\"details\":\"Order total: 4.79, tip: 0, existing completed: 4.79, payment: 0.55\"}",
            "2026-04-18T09:00:00Z",
        )
        .expect("resolve missing-local parity payment row");

        assert!(
            resolved,
            "server-confirmed stale parity payment should resolve"
        );

        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = 'queue-payment-missing-local'",
                [],
                |row| row.get(0),
            )
            .expect("count parity rows");
        assert_eq!(
            remaining, 0,
            "resolved row should be deleted from parity queue"
        );
    }

    // ----------------------------------------------------------------------
    // Wave 5 C17 — prepare_financial_request uses entity-stable idempotency
    // ----------------------------------------------------------------------

    #[test]
    fn prepare_financial_request_uses_entity_idempotency_key_not_queue_row_id() {
        let conn = test_connection();

        // Parent order to satisfy the FK constraint on order_payments.order_id.
        // W4e Step 0: dual-populate (12.34 → 1234).
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES ('ord-1', '[]', 12.34, 1234, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("seed parent order");

        // Seed an order_payments row with a known idempotency_key (the
        // v49 trigger populates this on INSERT in production; we assert
        // the value directly so the test is self-contained).
        conn.execute(
            "INSERT INTO order_payments
                (id, order_id, method, amount, amount_cents, status, idempotency_key, sync_status, created_at, updated_at)
             VALUES
                ('pay-w5-c17', 'ord-1', 'cash', 12.34, 1234, 'completed',
                 'rnd-stable-key-abc123',
                 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("seed order_payments row");

        let item = queue_item(
            "order_payments",
            "INSERT",
            "pay-w5-c17",
            serde_json::json!({"amount": 12.34}),
        );

        let prep = prepare_financial_request(
            &conn,
            &item,
            &serde_json::json!({"amount": 12.34}),
            "terminal-test",
        )
        .expect("prepare_financial_request succeeds");

        let RequestPreparation::Ready(spec) = prep else {
            panic!("expected RequestPreparation::Ready");
        };
        let body: serde_json::Value = serde_json::from_str(
            spec.body
                .as_deref()
                .expect("financial request must have a body"),
        )
        .expect("body is JSON");
        let idem = body
            .pointer("/items/0/idempotency_key")
            .and_then(serde_json::Value::as_str)
            .expect("idempotency_key is a JSON string");
        assert_eq!(
            idem, "rnd-stable-key-abc123",
            "W5 C17: idempotency_key MUST come from the entity row's persisted column, \
             not from the transient queue-row id. Got: {idem}"
        );
    }

    #[test]
    fn prepare_financial_request_falls_back_to_synthetic_when_entity_missing() {
        let conn = test_connection();

        // No order_payments row exists for `pay-w5-c17-missing`; the
        // fallback must produce the deterministic synthetic key so the
        // server still has SOME stable token rather than a rotating
        // queue-row UUID.
        let item = queue_item(
            "order_payments",
            "INSERT",
            "pay-w5-c17-missing",
            serde_json::json!({"amount": 5.00}),
        );

        let prep = prepare_financial_request(
            &conn,
            &item,
            &serde_json::json!({"amount": 5.00}),
            "terminal-test",
        )
        .expect("prepare_financial_request succeeds");

        let RequestPreparation::Ready(spec) = prep else {
            panic!("expected RequestPreparation::Ready");
        };
        let body: serde_json::Value = serde_json::from_str(spec.body.as_deref().unwrap()).unwrap();
        let idem = body
            .pointer("/items/0/idempotency_key")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        assert_eq!(idem, "entity:order_payments:pay-w5-c17-missing");
    }

    /// Helper for the H8 tests: insert one parity_sync_queue row with
    /// the supplied id and a defaulted (zero) claim_generation. Returns
    /// the row id so callers can re-use it.
    fn seed_h8_test_row(conn: &Connection, id: &str) {
        // The schema's CHECK constraint requires `operation IN ('INSERT',
        // 'UPDATE', 'DELETE')` and the `data` column is NOT NULL — supply
        // both. attempts defaults to 0; claim_generation defaults to 0.
        conn.execute(
            "INSERT INTO parity_sync_queue (
                id, table_name, record_id, operation, data, organization_id,
                created_at, status
             ) VALUES (
                ?1, 'orders', 'order-h8', 'INSERT', '{}', 'org-h8',
                datetime('now', '-10 minutes'), 'pending'
             )",
            params![id],
        )
        .expect("seed parity_sync_queue row");
    }

    /// Wave 10 H8 regression #1: a stale claim that gets recovered does
    /// NOT consume an attempt slot. The deferred memo's spec lists this
    /// as the first required test.
    ///
    /// Sequence:
    ///   1. Seed a row, status='pending', attempts=0, claim_generation=0.
    ///   2. Manually mark it 'processing' with a stale `last_attempt`
    ///      (older than the lease).
    ///   3. Call `recover_stale_processing_items`.
    ///   4. Assert the row is back to 'pending' with attempts STILL 0
    ///      (the recovery does not bump retry slots) and
    ///      claim_generation incremented to 1.
    #[test]
    fn h8_recover_stale_does_not_burn_attempt_slot() {
        let conn = test_connection();
        seed_h8_test_row(&conn, "h8-recover");

        // Force the row into 'processing' with a last_attempt older
        // than the lease window. Use raw SQL so we don't depend on
        // dequeue's own generation bump for this fixture.
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'processing',
                 last_attempt = datetime('now', '-1 hour')
             WHERE id = 'h8-recover'",
            [],
        )
        .unwrap();

        let recovered = recover_stale_processing_items(&conn).unwrap();
        assert_eq!(recovered, 1, "exactly one stale row should be recovered");

        let (status, attempts, generation): (String, i64, i64) = conn
            .query_row(
                "SELECT status, attempts, claim_generation
                 FROM parity_sync_queue WHERE id = 'h8-recover'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "pending", "row must return to pending");
        assert_eq!(
            attempts, 0,
            "stale-reclaim must NOT bump attempts (a stale claim is not a worker failure)"
        );
        assert_eq!(
            generation, 1,
            "stale-reclaim must bump claim_generation so any late ack from the prior worker is rejected"
        );
    }

    /// Wave 10 H8 regression #2: a late `mark_success` from a worker
    /// whose claim was reclaimed (generation bumped beneath them) is
    /// silently dropped. The row is NOT deleted; the next dequeue can
    /// still claim it.
    ///
    /// Sequence:
    ///   1. Seed row, claim_generation=0.
    ///   2. Bump generation directly (simulating recover_stale).
    ///   3. Call `mark_success(conn, id, expected_generation=0)` —
    ///      passing the STALE generation the original worker had.
    ///   4. Assert mark_success returns Ok(()) (no-op, not error).
    ///   5. Assert the row STILL exists in parity_sync_queue.
    #[test]
    fn h8_mark_success_with_stale_generation_is_a_noop() {
        let conn = test_connection();
        seed_h8_test_row(&conn, "h8-stale-ack");

        // Simulate recover_stale's generation bump after the original
        // worker's lease expired.
        conn.execute(
            "UPDATE parity_sync_queue
             SET claim_generation = 7
             WHERE id = 'h8-stale-ack'",
            [],
        )
        .unwrap();

        // Original worker thinks it claimed at generation 0; calls
        // mark_success with that stale value.
        let result = mark_success(&conn, "h8-stale-ack", 0);
        assert!(
            result.is_ok(),
            "mark_success with a stale generation must return Ok(()) — silent no-op, not an error"
        );

        let still_present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = 'h8-stale-ack'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            still_present, 1,
            "row must NOT be deleted by a stale-generation success ack"
        );
        let unchanged_generation: i64 = conn
            .query_row(
                "SELECT claim_generation FROM parity_sync_queue WHERE id = 'h8-stale-ack'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            unchanged_generation, 7,
            "claim_generation must remain at the post-recovery value"
        );

        // Sanity: the matching-generation success-mark DOES delete.
        let result_ok = mark_success(&conn, "h8-stale-ack", 7);
        assert!(result_ok.is_ok());
        let after_correct: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = 'h8-stale-ack'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            after_correct, 0,
            "matching-generation mark_success must delete the row as before"
        );
    }

    // -------------------------------------------------------------------
    // W10 H8 sub-follow-up: mirror the mark_success guard regression
    // tests for the four sibling terminal-state functions
    // (mark_failure / mark_rate_limited / mark_deferred / mark_conflict).
    //
    // Each test seeds a row with claim_generation = 0, bumps the row's
    // generation to 7 (simulating recover_stale running between the
    // original worker's claim and its terminal-state ack), and then
    // calls the mark_* function with the STALE expected_generation = 0.
    // Assertions:
    //   1. The function returns Ok (silent no-op — matches the
    //      mark_success canonical pattern; no error variant exists).
    //   2. The row's status is unchanged from its post-bump state.
    //   3. attempts is unchanged (a stale claim must not consume a
    //      retry slot — same invariant as recover_stale's
    //      "no attempts bump" rule).
    //   4. claim_generation is unchanged (no stale-side write).
    // -------------------------------------------------------------------

    /// Seed a parity_sync_queue row with the supplied id, status, and
    /// attempts. Sets module_type to 'orders' (non-monetary, so
    /// MonetaryDeadLetter side-effects are off the test path).
    fn seed_h8_sibling_test_row(conn: &Connection, id: &str, status: &str, attempts: i64) {
        conn.execute(
            "INSERT INTO parity_sync_queue (
                id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, status
             ) VALUES (
                ?1, 'orders', 'order-h8-sib', 'INSERT', '{}', 'org-h8',
                datetime('now', '-10 minutes'), ?2, ?3
             )",
            params![id, attempts, status],
        )
        .expect("seed parity_sync_queue row");
    }

    /// Set the row's claim_generation directly. Simulates
    /// recover_stale_processing_items bumping the generation between
    /// the original worker's claim and its terminal-state ack.
    fn bump_h8_generation(conn: &Connection, id: &str, generation: i64) {
        conn.execute(
            "UPDATE parity_sync_queue
             SET claim_generation = ?1
             WHERE id = ?2",
            params![generation, id],
        )
        .expect("bump claim_generation");
    }

    /// Read the post-call state for assertions.
    fn read_h8_state(conn: &Connection, id: &str) -> (String, i64, i64) {
        conn.query_row(
            "SELECT status, attempts, claim_generation
             FROM parity_sync_queue WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read row state")
    }

    #[test]
    fn h8_mark_failure_with_stale_generation_is_a_noop() {
        let conn = test_connection();
        seed_h8_sibling_test_row(&conn, "h8-mf", "processing", 0);
        bump_h8_generation(&conn, "h8-mf", 7);

        // Stale claimer (generation 0) calls mark_failure after the
        // row was reclaimed (generation 7).
        let result = mark_failure(&conn, "h8-mf", "stale fail", 0);
        assert!(
            result.is_ok(),
            "mark_failure with stale generation must be a silent no-op (matches mark_success pattern); got {result:?}"
        );
        let outcome = result.unwrap();
        assert!(!outcome.applied);
        assert!(!outcome.transitioned_to_dead_letter);
        assert!(outcome.monetary_notice.is_none());

        let (status, attempts, generation) = read_h8_state(&conn, "h8-mf");
        assert_eq!(
            status, "processing",
            "row status must remain 'processing' (stale fail must not flip it to 'failed' or 'pending')"
        );
        assert_eq!(
            attempts, 0,
            "attempts must NOT bump on a stale-generation failure ack"
        );
        assert_eq!(
            generation, 7,
            "claim_generation must remain at the post-recovery value"
        );
    }

    #[test]
    fn h8_mark_rate_limited_with_stale_generation_is_a_noop() {
        let conn = test_connection();
        seed_h8_sibling_test_row(&conn, "h8-mrl", "processing", 0);
        bump_h8_generation(&conn, "h8-mrl", 7);

        let result = mark_rate_limited(&conn, "h8-mrl", "stale 429", 30, 0);
        assert!(result.is_ok(), "mark_rate_limited stale must be Ok no-op");

        let (status, attempts, generation) = read_h8_state(&conn, "h8-mrl");
        assert_eq!(
            status, "processing",
            "row status must remain 'processing' (stale rate-limit must not flip to 'pending')"
        );
        assert_eq!(attempts, 0, "attempts must NOT bump");
        assert_eq!(generation, 7, "claim_generation must remain at 7");
    }

    #[test]
    fn h8_mark_deferred_with_stale_generation_is_a_noop() {
        let conn = test_connection();
        seed_h8_sibling_test_row(&conn, "h8-md", "processing", 0);
        bump_h8_generation(&conn, "h8-md", 7);

        let result = mark_deferred(&conn, "h8-md", "waiting on parent", 0);
        assert!(result.is_ok(), "mark_deferred stale must be Ok no-op");

        let (status, attempts, generation) = read_h8_state(&conn, "h8-md");
        assert_eq!(
            status, "processing",
            "row status must remain 'processing' (stale defer must not flip to 'pending' or 'conflict')"
        );
        assert_eq!(attempts, 0, "attempts must NOT bump");
        assert_eq!(generation, 7, "claim_generation must remain at 7");
    }

    #[test]
    fn h8_mark_conflict_with_stale_generation_is_a_noop() {
        let conn = test_connection();
        seed_h8_sibling_test_row(&conn, "h8-mc", "processing", 0);
        bump_h8_generation(&conn, "h8-mc", 7);

        let result = mark_conflict(&conn, "h8-mc", 0);
        assert!(result.is_ok(), "mark_conflict stale must be Ok no-op");

        let (status, attempts, generation) = read_h8_state(&conn, "h8-mc");
        assert_eq!(
            status, "processing",
            "row status must remain 'processing' (stale 409 must not flip to 'conflict')"
        );
        assert_eq!(attempts, 0, "attempts must NOT bump");
        assert_eq!(generation, 7, "claim_generation must remain at 7");
    }

    // -------------------------------------------------------------------
    // THE-306 gating sweep item 3: MODULE_REQUIRED retry hygiene.
    // The admin API's module-acquisition denial must park the row pending
    // (queue retained) without consuming attempts, instead of falling into
    // the generic 4xx arm and dead-lettering it.
    // -------------------------------------------------------------------

    #[test]
    fn parse_module_required_response_matches_only_the_uniform_contract() {
        assert_eq!(
            parse_module_required_response(
                403,
                r#"{"success":false,"error":"MODULE_REQUIRED","missingModules":["coupons","delivery"]}"#,
            ),
            Some("coupons, delivery".to_string()),
            "uniform denial must match and surface the missing modules"
        );
        assert_eq!(
            parse_module_required_response(403, r#"{"error":"MODULE_REQUIRED"}"#),
            Some(String::new()),
            "denial without a module list still matches"
        );
        assert_eq!(
            parse_module_required_response(403, r#"{"error":"Forbidden"}"#),
            None,
            "other 403 bodies must not match"
        );
        assert_eq!(
            parse_module_required_response(
                400,
                r#"{"error":"MODULE_REQUIRED","missingModules":["coupons"]}"#,
            ),
            None,
            "the error code only counts on a 403"
        );
        assert_eq!(
            parse_module_required_response(403, "MODULE_REQUIRED but not json"),
            None,
            "non-JSON bodies must not match"
        );
    }

    #[test]
    fn mark_module_required_parks_pending_without_burning_attempts() {
        let conn = test_connection();
        seed_h8_sibling_test_row(&conn, "mr-park", "processing", 7);

        let result = mark_module_required(
            &conn,
            "mr-park",
            "MODULE_REQUIRED: organization is missing module(s): coupons",
            0,
        );
        assert!(
            result.is_ok(),
            "mark_module_required must succeed: {result:?}"
        );

        let (status, attempts, generation) = read_h8_state(&conn, "mr-park");
        assert_eq!(status, "pending", "row must return to the pending pool");
        assert_eq!(
            attempts, 7,
            "attempts must NOT change — module denial is not a failed replay"
        );
        assert_eq!(generation, 0, "claim_generation untouched");

        let (error_message, next_retry_at): (String, String) = conn
            .query_row(
                "SELECT error_message, next_retry_at FROM parity_sync_queue WHERE id = 'mr-park'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read parked row");
        assert!(
            error_message.contains("MODULE_REQUIRED"),
            "reason must be visible to the Recovery Center: {error_message}"
        );
        let next_retry = chrono::DateTime::parse_from_rfc3339(&next_retry_at)
            .expect("next_retry_at must be RFC3339")
            .with_timezone(&Utc);
        let seconds_out = (next_retry - Utc::now()).num_seconds();
        assert!(
            (MODULE_REQUIRED_RETRY_SECS - 60..=MODULE_REQUIRED_RETRY_SECS + 60)
                .contains(&seconds_out),
            "probe must be on the slow module cadence (~{MODULE_REQUIRED_RETRY_SECS}s), got {seconds_out}s"
        );
    }

    #[test]
    fn mark_module_required_with_stale_generation_is_a_noop() {
        let conn = test_connection();
        seed_h8_sibling_test_row(&conn, "mr-stale", "processing", 0);
        bump_h8_generation(&conn, "mr-stale", 7);

        let result = mark_module_required(&conn, "mr-stale", "MODULE_REQUIRED: coupons", 0);
        assert!(
            result.is_ok(),
            "stale mark_module_required must be Ok no-op"
        );

        let (status, attempts, generation) = read_h8_state(&conn, "mr-stale");
        assert_eq!(
            status, "processing",
            "row status must remain 'processing' (stale module denial must not flip to 'pending')"
        );
        assert_eq!(attempts, 0, "attempts must NOT bump");
        assert_eq!(generation, 7, "claim_generation must remain at 7");
    }

    // -------------------------------------------------------------------
    // hotel-rooms-full-pass task 10.2: `room_checkins` replay mapping.
    // Rows are captured offline by `offline_room_checkin` (record_id =
    // client_request_id replay key, snake_case payload) and must replay as
    // `POST /api/pos/rooms/{room_id}/checkin` with the server's camelCase
    // contract. 2xx (incl. 200 idempotentReplay) completes the item, 403
    // MODULE_REQUIRED parks it, and a genuine 409 surfaces for staff review.
    // -------------------------------------------------------------------

    const ROOM_CHECKIN_REPLAY_KEY: &str = "5e0e7c6a-9f1d-4d5c-8a3b-2f4f6f8d9a1b";

    /// The exact queue payload shape `capture_room_checkin` persists —
    /// optional capture fields present as explicit nulls.
    fn room_checkin_capture_payload() -> Value {
        json!({
            "room_id": "room-1",
            "guest_name": "Maria Papadopoulou",
            "guest_phone": Value::Null,
            "guest_email": Value::Null,
            "check_in_date": "2026-06-12",
            "check_out_date": "2026-06-14",
            "party_size": Value::Null,
            "notes": Value::Null,
            "client_request_id": ROOM_CHECKIN_REPLAY_KEY,
            "organization_id": "org-room-checkin",
            "branch_id": TEST_BRANCH_ID,
        })
    }

    /// Enqueue with the same arguments `offline_mutations::enqueue_parity_item`
    /// uses in production for this entity (priority 0, module `hospitality`,
    /// conflict strategy `manual`, version 1).
    fn enqueue_room_checkin_test_item(conn: &Connection) -> String {
        enqueue_payload_item(
            conn,
            "room_checkins",
            ROOM_CHECKIN_REPLAY_KEY,
            "INSERT",
            &room_checkin_capture_payload(),
            Some(0),
            Some("hospitality"),
            Some("manual"),
            Some(1),
        )
        .expect("enqueue room check-in item")
    }

    #[test]
    fn prepare_room_checkin_request_maps_capture_payload_to_server_contract() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let mut item = queue_item(
            "room_checkins",
            "INSERT",
            ROOM_CHECKIN_REPLAY_KEY,
            json!({
                "room_id": "room-1",
                "guest_name": "Maria Papadopoulou",
                "guest_phone": "+30 694 000 0000",
                "guest_email": "maria@example.com",
                "check_in_date": "2026-06-12",
                "check_out_date": "2026-06-14",
                "party_size": 3,
                "notes": "Late arrival",
                "client_request_id": ROOM_CHECKIN_REPLAY_KEY,
                "organization_id": "org-room-checkin",
                "branch_id": TEST_BRANCH_ID,
            }),
        );
        item.module_type = "hospitality".to_string();

        let prepared = prepare_request(&conn, &item).expect("prepare room check-in request");
        let RequestPreparation::Ready(spec) = prepared else {
            panic!("room check-in request should be ready");
        };
        assert_eq!(spec.endpoint, "/api/pos/rooms/room-1/checkin");
        assert_eq!(spec.method, Method::POST);
        assert_eq!(spec.terminal_id, TEST_TERMINAL_ID);

        let body: Value =
            serde_json::from_str(spec.body.as_deref().expect("body")).expect("json body");
        assert_eq!(body["guestName"], "Maria Papadopoulou");
        assert_eq!(body["checkInDate"], "2026-06-12");
        assert_eq!(body["checkOutDate"], "2026-06-14");
        assert_eq!(body["clientRequestId"], ROOM_CHECKIN_REPLAY_KEY);
        assert_eq!(body["guestEmail"], "maria@example.com");
        assert_eq!(body["guestPhone"], "+30 694 000 0000");
        assert_eq!(body["partySize"], 3);
        assert_eq!(body["notes"], "Late arrival");
        // Snake_case capture keys must not leak into the server body.
        assert!(body.get("room_id").is_none());
        assert!(body.get("guest_name").is_none());
        assert!(body.get("client_request_id").is_none());
    }

    #[test]
    fn prepare_room_checkin_request_omits_null_optionals_and_preflights_room_id() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let mut item = queue_item(
            "room_checkins",
            "INSERT",
            ROOM_CHECKIN_REPLAY_KEY,
            room_checkin_capture_payload(),
        );
        item.module_type = "hospitality".to_string();

        let prepared = prepare_request(&conn, &item).expect("prepare room check-in request");
        let RequestPreparation::Ready(spec) = prepared else {
            panic!("room check-in request should be ready");
        };
        let body: Value =
            serde_json::from_str(spec.body.as_deref().expect("body")).expect("json body");
        // Null capture optionals are omitted, not forwarded as nulls.
        assert!(body.get("guestEmail").is_none());
        assert!(body.get("guestPhone").is_none());
        assert!(body.get("partySize").is_none());
        assert!(body.get("notes").is_none());

        // A corrupted row without a target room dead-letters locally with a
        // clear reason instead of producing a malformed endpoint.
        let mut broken_payload = room_checkin_capture_payload();
        broken_payload
            .as_object_mut()
            .expect("payload object")
            .remove("room_id");
        let mut broken = queue_item(
            "room_checkins",
            "INSERT",
            ROOM_CHECKIN_REPLAY_KEY,
            broken_payload,
        );
        broken.module_type = "hospitality".to_string();
        match prepare_request(&conn, &broken).expect("prepare broken room check-in") {
            RequestPreparation::Failed { reason } => assert!(
                reason.contains("room_id"),
                "failure reason must name the missing field: {reason}"
            ),
            other => panic!("expected failed preparation, got {other:?}"),
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_parks_room_checkin_pending_when_module_is_required() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_room_checkin_test_item(&conn);

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            403,
            r#"{"success":false,"error":"MODULE_REQUIRED","missingModules":["rooms","guest_billing"]}"#,
        )])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);

        let request = requests.recv().await.expect("captured check-in request");
        assert_eq!(
            request.request_line,
            "POST /api/pos/rooms/room-1/checkin HTTP/1.1"
        );

        let (status, attempts, error_message, next_retry_at): (String, i64, String, String) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, attempts, error_message, next_retry_at
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read parked row");
        assert_eq!(
            status, "pending",
            "module denial parks the row — queue retained for re-acquisition"
        );
        assert_eq!(attempts, 0, "module denial must NOT burn attempts");
        assert!(
            error_message.contains("MODULE_REQUIRED"),
            "reason must be visible to the Recovery Center: {error_message}"
        );
        assert!(
            error_message.contains("rooms, guest_billing"),
            "reason must surface the missing modules: {error_message}"
        );
        let next_retry = chrono::DateTime::parse_from_rfc3339(&next_retry_at)
            .expect("next_retry_at must be RFC3339")
            .with_timezone(&Utc);
        let seconds_out = (next_retry - Utc::now()).num_seconds();
        assert!(
            (MODULE_REQUIRED_RETRY_SECS - 60..=MODULE_REQUIRED_RETRY_SECS + 60)
                .contains(&seconds_out),
            "probe must be on the slow module cadence (~{MODULE_REQUIRED_RETRY_SECS}s), got {seconds_out}s"
        );

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_completes_room_checkin_on_idempotent_replay_response() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_room_checkin_test_item(&conn);

        let conn = std::sync::Mutex::new(conn);
        // 200 idempotentReplay is what the server answers when this
        // clientRequestId was already consumed by an earlier lost-ack
        // attempt — like a fresh 201, it must complete the queue item.
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            200,
            r#"{"success":true,"folio":{"id":"folio-1"},"room":{"id":"room-1","status":"occupied"},"idempotentReplay":true}"#,
        )])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);

        let request = requests.recv().await.expect("captured check-in request");
        assert_eq!(
            request.request_line,
            "POST /api/pos/rooms/room-1/checkin HTTP/1.1"
        );
        let body: Value = serde_json::from_str(&request.body).expect("request body json");
        assert_eq!(body["guestName"], "Maria Papadopoulou");
        assert_eq!(body["checkInDate"], "2026-06-12");
        assert_eq!(body["checkOutDate"], "2026-06-14");
        assert_eq!(body["clientRequestId"], ROOM_CHECKIN_REPLAY_KEY);

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(
            remaining, 0,
            "2xx (incl. 200 idempotentReplay) must complete and remove the item"
        );

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_marks_room_checkin_active_folio_409_for_staff_review() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_room_checkin_test_item(&conn);

        let conn = std::sync::Mutex::new(conn);
        // First response: a genuine conflict — another guest's folio is
        // active, NOT an idempotent replay of this clientRequestId. Second
        // response serves the conflict arm's fetch_server_record GET probe
        // (no GET /api/pos/sync/room_checkins/{id} route exists → 404).
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![
            MockResponse::json(
                409,
                r#"{"success":false,"error":"Room already has an active guest folio","code":"ROOM_HAS_ACTIVE_FOLIO"}"#,
            ),
            MockResponse::json(404, r#"{"success":false,"error":"Not found"}"#),
        ])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(
            result.conflicts, 1,
            "a genuine 409 must surface as a staff-review item"
        );
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].http_status, Some(409));
        assert!(
            result.errors[0].error.contains("requiring review"),
            "error must carry the review reason: {}",
            result.errors[0].error
        );

        let replay_request = requests.recv().await.expect("captured check-in request");
        assert_eq!(
            replay_request.request_line,
            "POST /api/pos/rooms/room-1/checkin HTTP/1.1"
        );
        let fetch_request = requests.recv().await.expect("captured fetch probe");
        assert_eq!(
            fetch_request.request_line,
            format!("GET /api/pos/sync/room_checkins/{ROOM_CHECKIN_REPLAY_KEY} HTTP/1.1")
        );

        // Manual conflict strategy: the row leaves the retry pool for
        // operator review instead of replaying forever, with the discarded
        // payload preserved in the audit log for staff.
        let (status, attempts): (String, i64) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, attempts FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read conflicted row");
        assert_eq!(status, "conflict");
        assert_eq!(attempts, 0);

        let audit_count: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*)
                 FROM conflict_audit_log
                 WHERE entity_id = ?1 AND entity_type = 'room_checkins'",
                params![ROOM_CHECKIN_REPLAY_KEY],
                |row| row.get(0),
            )
            .expect("read conflict audit row");
        assert_eq!(audit_count, 1);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    // -------------------------------------------------------------------
    // procurement-loop Task 10.3/10.4: `po_receipts` replay mapping.
    // Rows are captured offline by `offline_po_receipt` (record_id = the
    // capture-time idempotency key, snake_case envelope with camelCase
    // ReceiptCommitRequest lines) and must replay as
    // `POST /api/pos/purchase-orders/{id}/receipts` carrying the STORED
    // key as the `Idempotency-Key` header. 2xx (incl. 200 wasReplay)
    // completes the item, 403 MODULE_REQUIRED parks it retained, and a
    // 409 PO_STATE_CONFLICT surfaces for staff review — never dropped.
    // -------------------------------------------------------------------

    const PO_RECEIPT_REPLAY_KEY: &str = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const PO_RECEIPT_PO_ID: &str = "33333333-3333-4333-8333-333333333333";

    /// The exact queue payload shape `capture_po_receipt` persists.
    fn po_receipt_capture_payload() -> Value {
        json!({
            "purchase_order_id": PO_RECEIPT_PO_ID,
            "idempotency_key": PO_RECEIPT_REPLAY_KEY,
            "recorded_at": "2026-08-05T10:15:00+00:00",
            "staff_id": "44444444-4444-4444-8444-444444444444",
            "source": "pos_desktop",
            "kind": "delivery",
            "notes": "Back-door delivery",
            "lines": [
                {
                    "purchaseOrderItemId": "55555555-5555-4555-8555-555555555555",
                    "quantityReceived": 6,
                    "unitCost": 2.4,
                    "confirmOverReceipt": false,
                    "confirmUnplanned": false,
                }
            ],
            "organization_id": "org-po-receipt",
            "branch_id": TEST_BRANCH_ID,
        })
    }

    /// Enqueue with the same arguments `offline_mutations::enqueue_parity_item`
    /// uses in production for this entity (priority 0, module `suppliers`,
    /// conflict strategy `manual`, version 1).
    fn enqueue_po_receipt_test_item(conn: &Connection) -> String {
        enqueue_payload_item(
            conn,
            "po_receipts",
            PO_RECEIPT_REPLAY_KEY,
            "INSERT",
            &po_receipt_capture_payload(),
            Some(0),
            Some("suppliers"),
            Some("manual"),
            Some(1),
        )
        .expect("enqueue po receipt item")
    }

    #[test]
    fn prepare_po_receipt_request_maps_capture_payload_to_server_contract() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let mut item = queue_item(
            "po_receipts",
            "INSERT",
            PO_RECEIPT_REPLAY_KEY,
            po_receipt_capture_payload(),
        );
        item.module_type = "suppliers".to_string();

        let prepared = prepare_request(&conn, &item).expect("prepare po receipt request");
        let RequestPreparation::Ready(spec) = prepared else {
            panic!("po receipt request should be ready");
        };
        assert_eq!(
            spec.endpoint,
            format!("/api/pos/purchase-orders/{PO_RECEIPT_PO_ID}/receipts")
        );
        assert_eq!(spec.method, Method::POST);
        assert_eq!(spec.terminal_id, TEST_TERMINAL_ID);

        let body: Value =
            serde_json::from_str(spec.body.as_deref().expect("body")).expect("json body");
        // The STORED capture-time key — never a fresh one — keeps replays
        // exactly-once server-side [R11.4].
        assert_eq!(body["idempotencyKey"], PO_RECEIPT_REPLAY_KEY);
        assert_eq!(body["staffId"], "44444444-4444-4444-8444-444444444444");
        assert_eq!(body["source"], "pos_desktop");
        // Original capture time preserved on replay [R11.3].
        assert_eq!(body["recordedAt"], "2026-08-05T10:15:00+00:00");
        assert_eq!(body["kind"], "delivery");
        assert_eq!(body["notes"], "Back-door delivery");
        assert_eq!(
            body["lines"][0]["purchaseOrderItemId"],
            "55555555-5555-4555-8555-555555555555"
        );
        assert_eq!(body["lines"][0]["quantityReceived"], 6);
        assert_eq!(body["lines"][0]["unitCost"], 2.4);
        // Snake_case envelope keys must not leak into the server body.
        assert!(body.get("purchase_order_id").is_none());
        assert!(body.get("idempotency_key").is_none());
        assert!(body.get("staff_id").is_none());

        // The replay header carries the same stored key.
        let (header_name, header_value) =
            replay_idempotency_header(&item).expect("po receipt replay header");
        assert_eq!(header_name, "Idempotency-Key");
        assert_eq!(header_value, PO_RECEIPT_REPLAY_KEY);
    }

    #[test]
    fn prepare_po_receipt_request_dead_letters_corrupted_rows_with_clear_reasons() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let cases: [(&str, &str); 3] = [
            ("purchase_order_id", "purchase_order_id"),
            ("staff_id", "staff_id"),
            ("recorded_at", "recorded_at"),
        ];
        for (field, expected_fragment) in cases {
            let mut payload = po_receipt_capture_payload();
            payload
                .as_object_mut()
                .expect("payload object")
                .remove(field);
            let mut item = queue_item("po_receipts", "INSERT", PO_RECEIPT_REPLAY_KEY, payload);
            item.module_type = "suppliers".to_string();
            match prepare_request(&conn, &item).expect("prepare broken po receipt") {
                RequestPreparation::Failed { reason } => assert!(
                    reason.contains(expected_fragment),
                    "failure reason must name the missing field {expected_fragment}: {reason}"
                ),
                other => panic!("expected failed preparation for missing {field}, got {other:?}"),
            }
        }

        // Empty line sets and non-UUID PO ids also dead-letter locally
        // instead of producing a malformed or dangerous request.
        let mut empty_lines = po_receipt_capture_payload();
        empty_lines["lines"] = json!([]);
        let mut item = queue_item("po_receipts", "INSERT", PO_RECEIPT_REPLAY_KEY, empty_lines);
        item.module_type = "suppliers".to_string();
        match prepare_request(&conn, &item).expect("prepare empty-lines po receipt") {
            RequestPreparation::Failed { reason } => assert!(
                reason.contains("lines"),
                "failure reason must name the empty line set: {reason}"
            ),
            other => panic!("expected failed preparation, got {other:?}"),
        }

        let mut bad_po = po_receipt_capture_payload();
        bad_po["purchase_order_id"] = json!("../escape");
        let mut item = queue_item("po_receipts", "INSERT", PO_RECEIPT_REPLAY_KEY, bad_po);
        item.module_type = "suppliers".to_string();
        match prepare_request(&conn, &item).expect("prepare bad-po-id po receipt") {
            RequestPreparation::Failed { reason } => assert!(
                reason.contains("non-UUID"),
                "failure reason must flag the malformed PO id: {reason}"
            ),
            other => panic!("expected failed preparation, got {other:?}"),
        }
    }

    #[test]
    fn po_receipt_replay_key_falls_back_to_record_id_for_legacy_rows() {
        // A row whose payload lost the key copy still replays exactly-once
        // via the record_id mirror — same rule as room_checkins.
        let mut payload = po_receipt_capture_payload();
        payload
            .as_object_mut()
            .expect("payload object")
            .remove("idempotency_key");
        let mut item = queue_item("po_receipts", "INSERT", PO_RECEIPT_REPLAY_KEY, payload);
        item.module_type = "suppliers".to_string();

        let (_, header_value) = replay_idempotency_header(&item).expect("fallback replay header");
        assert_eq!(header_value, PO_RECEIPT_REPLAY_KEY);

        // Other entities get no replay header — their requests stay
        // byte-identical to before this feature.
        let other = queue_item("orders", "INSERT", "order-1", json!({}));
        assert!(replay_idempotency_header(&other).is_none());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_sends_po_receipt_with_stored_idempotency_key_header() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_po_receipt_test_item(&conn);

        let conn = std::sync::Mutex::new(conn);
        // 200 wasReplay is what the server answers when this key was
        // already consumed by an earlier lost-ack attempt — like a fresh
        // 201, it must complete the queue item [R11.4].
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            200,
            r#"{"success":true,"receiptId":"receipt-1","wasReplay":true,"purchaseOrderStatus":"partially_received","lineResults":[]}"#,
        )])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);

        let request = requests.recv().await.expect("captured receipt request");
        assert_eq!(
            request.request_line,
            format!("POST /api/pos/purchase-orders/{PO_RECEIPT_PO_ID}/receipts HTTP/1.1")
        );
        // The stored capture-time key travels as the Idempotency-Key
        // header — the known offline idempotency-key gap is closed for
        // this mutation type (Task 10.3).
        assert_eq!(
            request.headers.get("idempotency-key").map(String::as_str),
            Some(PO_RECEIPT_REPLAY_KEY)
        );
        let body: Value = serde_json::from_str(&request.body).expect("request body json");
        assert_eq!(body["idempotencyKey"], PO_RECEIPT_REPLAY_KEY);
        assert_eq!(body["recordedAt"], "2026-08-05T10:15:00+00:00");

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(
            remaining, 0,
            "2xx (incl. 200 wasReplay) must complete and remove the item"
        );

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_parks_po_receipt_pending_when_module_is_required() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_po_receipt_test_item(&conn);

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            403,
            r#"{"success":false,"error":"MODULE_REQUIRED","missingModules":["suppliers"]}"#,
        )])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);

        let request = requests.recv().await.expect("captured receipt request");
        assert_eq!(
            request.request_line,
            format!("POST /api/pos/purchase-orders/{PO_RECEIPT_PO_ID}/receipts HTTP/1.1")
        );

        let (status, attempts, error_message): (String, i64, String) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, attempts, error_message
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read parked row");
        assert_eq!(
            status, "pending",
            "module denial parks the row — receipt retained until the module returns [R11.6]"
        );
        assert_eq!(attempts, 0, "module denial must NOT burn attempts");
        assert!(
            error_message.contains("MODULE_REQUIRED"),
            "park reason must be visible to the procurement UI: {error_message}"
        );
        assert!(
            error_message.contains("suppliers"),
            "park reason must surface the missing module: {error_message}"
        );

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_marks_po_receipt_state_conflict_for_staff_review() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_po_receipt_test_item(&conn);

        let conn = std::sync::Mutex::new(conn);
        // First response: the PO was cancelled while this terminal was
        // offline — a genuine 409 PO_STATE_CONFLICT, not a replay. Second
        // response serves the conflict arm's fetch_server_record GET probe
        // (no GET /api/pos/sync/po_receipts/{id} route exists → 404).
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![
            MockResponse::json(
                409,
                r#"{"success":false,"error":"PO_STATE_CONFLICT","poStatus":"cancelled"}"#,
            ),
            MockResponse::json(404, r#"{"success":false,"error":"Not found"}"#),
        ])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(
            result.conflicts, 1,
            "a PO state conflict must surface as a staff-review item [R11.7]"
        );
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].http_status, Some(409));

        let replay_request = requests.recv().await.expect("captured receipt request");
        assert_eq!(
            replay_request.request_line,
            format!("POST /api/pos/purchase-orders/{PO_RECEIPT_PO_ID}/receipts HTTP/1.1")
        );

        // Manual conflict strategy: the row leaves the retry pool for
        // staff review with the recorded quantities preserved in the
        // queue payload — never silently dropped [R11.7].
        let (status, data): (String, String) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, data FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read conflicted row");
        assert_eq!(status, "conflict");
        let preserved: Value = serde_json::from_str(&data).expect("preserved payload parses");
        assert_eq!(preserved["lines"][0]["quantityReceived"], 6);

        let audit_count: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*)
                 FROM conflict_audit_log
                 WHERE entity_id = ?1 AND entity_type = 'po_receipts'",
                params![PO_RECEIPT_REPLAY_KEY],
                |row| row.get(0),
            )
            .expect("read conflict audit row");
        assert_eq!(audit_count, 1);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    // -------------------------------------------------------------------
    // invoice-scan-capture Task 11.3/11.4: `supplier_import_commits`
    // replay mapping. Rows are captured offline by
    // `offline_supplier_import_commit` (record_id = the capture id, which
    // IS the capture-time replay key) and must replay as
    // `POST /api/pos/suppliers/import/commit` carrying that capture id as
    // the `Idempotency-Key` header. 2xx (incl. `200 alreadyCommitted`)
    // completes the item, 403 MODULE_REQUIRED parks it retained, and a
    // corrupted row dead-letters with a reason a person can act on.
    // -------------------------------------------------------------------

    const CAPTURE_ID: &str = "8b2c1d4e-5f60-4a7b-9c8d-0e1f2a3b4c5d";
    const CAPTURE_PO_ID: &str = "66666666-6666-4666-8666-666666666666";
    const CAPTURE_STAFF_ID: &str = "77777777-7777-4777-8777-777777777777";

    /// The exact queue payload shape `capture_supplier_import_commit`
    /// persists: snake_case envelope, camelCase server blocks.
    fn supplier_import_commit_payload() -> Value {
        json!({
            "capture_id": CAPTURE_ID,
            "idempotency_key": CAPTURE_ID,
            "recorded_at": "2026-08-05T18:20:00+00:00",
            "staff_id": CAPTURE_STAFF_ID,
            "source": "pos_desktop",
            "draft": {
                "supplierName": "Fresh Produce Ltd",
                "invoiceNumber": "INV-2026-118",
                "rows": [
                    { "rowNumber": 1, "name": "Tomatoes", "quantity": 6, "unitCost": 1.25 }
                ],
            },
            "capture": {
                "captureId": CAPTURE_ID,
                "sourceKind": "watched_folder",
                "sourceName": "Back office scans",
                "capturedAt": "2026-08-05T18:02:00+00:00",
                "capturedByStaffId": CAPTURE_STAFF_ID,
                "storageKeys": [
                    "org-capture/11111111-1111-1111-1111-111111111111/captures/8b2c1d4e-5f60-4a7b-9c8d-0e1f2a3b4c5d/page-000.png"
                ],
            },
            "po_linkage": {
                "purchaseOrderId": CAPTURE_PO_ID,
                "mode": "confirm_existing",
            },
            "organization_id": "org-capture",
            "branch_id": TEST_BRANCH_ID,
        })
    }

    /// Enqueue with the same arguments `offline_mutations::enqueue_parity_item`
    /// uses in production for this entity (priority 0, module `suppliers`,
    /// conflict strategy `manual`, version 1).
    fn enqueue_supplier_import_commit_test_item(conn: &Connection) -> String {
        enqueue_payload_item(
            conn,
            "supplier_import_commits",
            CAPTURE_ID,
            "INSERT",
            &supplier_import_commit_payload(),
            Some(0),
            Some("suppliers"),
            Some("manual"),
            Some(1),
        )
        .expect("enqueue supplier import commit item")
    }

    #[test]
    fn prepare_supplier_import_commit_request_maps_capture_payload_to_server_contract() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let mut item = queue_item(
            "supplier_import_commits",
            "INSERT",
            CAPTURE_ID,
            supplier_import_commit_payload(),
        );
        item.module_type = "suppliers".to_string();

        let prepared = prepare_request(&conn, &item).expect("prepare supplier import commit");
        let RequestPreparation::Ready(spec) = prepared else {
            panic!("supplier import commit request should be ready");
        };
        assert_eq!(spec.endpoint, "/api/pos/suppliers/import/commit");
        assert_eq!(spec.method, Method::POST);
        assert_eq!(spec.terminal_id, TEST_TERMINAL_ID);

        let body: Value =
            serde_json::from_str(spec.body.as_deref().expect("body")).expect("json body");
        // The three blocks the route reads, in their camelCase wire shape.
        assert_eq!(body["draft"]["invoiceNumber"], "INV-2026-118");
        assert_eq!(body["draft"]["rows"][0]["name"], "Tomatoes");
        assert_eq!(body["capture"]["captureId"], CAPTURE_ID);
        assert_eq!(body["capture"]["sourceKind"], "watched_folder");
        // Original capture time preserved on replay [R13.1].
        assert_eq!(body["capture"]["capturedAt"], "2026-08-05T18:02:00+00:00");
        // The saver is recorded even though the renderer only sent the
        // scanner [R13.2].
        assert_eq!(body["capture"]["committedByStaffId"], CAPTURE_STAFF_ID);
        assert_eq!(body["poLinkage"]["purchaseOrderId"], CAPTURE_PO_ID);
        assert_eq!(body["poLinkage"]["mode"], "confirm_existing");
        // Snake_case envelope keys must not leak into the server body.
        assert!(body.get("capture_id").is_none());
        assert!(body.get("po_linkage").is_none());
        assert!(body.get("staff_id").is_none());
        assert!(body.get("organization_id").is_none());

        // Header and body agree about which capture is being committed —
        // the route 400s when they do not.
        let (header_name, header_value) =
            replay_idempotency_header(&item).expect("supplier import replay header");
        assert_eq!(header_name, "Idempotency-Key");
        assert_eq!(header_value, CAPTURE_ID);
        assert_eq!(body["capture"]["captureId"], header_value.as_str());
    }

    #[test]
    fn prepare_supplier_import_commit_request_forces_the_body_key_to_match_the_header() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        // A row whose stored capture block disagrees with its replay key
        // (hand-edited database, a partially-migrated row) must NOT be sent
        // as-is: the route rejects the mismatch and a good invoice would
        // dead-letter for a reason nobody could act on.
        let mut payload = supplier_import_commit_payload();
        payload["capture"]["captureId"] = json!("some-other-capture");
        let mut item = queue_item("supplier_import_commits", "INSERT", CAPTURE_ID, payload);
        item.module_type = "suppliers".to_string();

        let RequestPreparation::Ready(spec) =
            prepare_request(&conn, &item).expect("prepare mismatched row")
        else {
            panic!("request should be ready");
        };
        let body: Value =
            serde_json::from_str(spec.body.as_deref().expect("body")).expect("json body");
        let (_, header_value) = replay_idempotency_header(&item).expect("replay header");
        assert_eq!(body["capture"]["captureId"], CAPTURE_ID);
        assert_eq!(header_value, CAPTURE_ID);
    }

    #[test]
    fn prepare_supplier_import_commit_request_dead_letters_corrupted_rows_with_clear_reasons() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let prepare = |payload: Value| {
            let mut item = queue_item("supplier_import_commits", "INSERT", CAPTURE_ID, payload);
            item.module_type = "suppliers".to_string();
            prepare_request(&conn, &item).expect("prepare broken commit")
        };
        let expect_failure = |prepared: RequestPreparation, fragment: &str| match prepared {
            RequestPreparation::Failed { reason } => assert!(
                reason.contains(fragment),
                "failure reason must name {fragment}: {reason}"
            ),
            other => panic!("expected failed preparation, got {other:?}"),
        };

        // The invoice itself is gone.
        let mut without_draft = supplier_import_commit_payload();
        without_draft
            .as_object_mut()
            .expect("payload object")
            .remove("draft");
        expect_failure(prepare(without_draft), "draft");

        // The provenance block is gone.
        let mut without_capture = supplier_import_commit_payload();
        without_capture
            .as_object_mut()
            .expect("payload object")
            .remove("capture");
        expect_failure(prepare(without_capture), "capture");

        // Capture time is gone from both the block and the envelope.
        let mut without_captured_at = supplier_import_commit_payload();
        without_captured_at["capture"]
            .as_object_mut()
            .expect("capture object")
            .remove("capturedAt");
        without_captured_at
            .as_object_mut()
            .expect("payload object")
            .remove("recorded_at");
        expect_failure(prepare(without_captured_at), "captured_at");

        // A source kind the route's enum does not accept.
        let mut bad_source = supplier_import_commit_payload();
        bad_source["capture"]["sourceKind"] = json!("fax");
        expect_failure(prepare(bad_source), "source_kind");

        // A PO id that would be interpolated into a procurement RPC.
        let mut bad_po = supplier_import_commit_payload();
        bad_po["po_linkage"]["purchaseOrderId"] = json!("../escape");
        expect_failure(prepare(bad_po), "non-UUID");

        // A linkage mode the route's enum does not accept.
        let mut bad_mode = supplier_import_commit_payload();
        bad_mode["po_linkage"]["mode"] = json!("just_link_it");
        expect_failure(prepare(bad_mode), "mode");
    }

    #[test]
    fn supplier_import_commit_replay_key_falls_back_to_record_id_for_legacy_rows() {
        // A row whose payload lost both key copies still replays
        // exactly-once via the record_id mirror — same rule as po_receipts.
        let mut payload = supplier_import_commit_payload();
        let object = payload.as_object_mut().expect("payload object");
        object.remove("capture_id");
        object.remove("idempotency_key");
        object
            .get_mut("capture")
            .and_then(Value::as_object_mut)
            .expect("capture object")
            .remove("captureId");

        let mut item = queue_item("supplier_import_commits", "INSERT", CAPTURE_ID, payload);
        item.module_type = "suppliers".to_string();

        let (_, header_value) = replay_idempotency_header(&item).expect("fallback replay header");
        assert_eq!(header_value, CAPTURE_ID);

        let conn = test_connection();
        seed_terminal_context(&conn);
        let RequestPreparation::Ready(spec) =
            prepare_request(&conn, &item).expect("prepare legacy row")
        else {
            panic!("request should be ready");
        };
        let body: Value =
            serde_json::from_str(spec.body.as_deref().expect("body")).expect("json body");
        assert_eq!(body["capture"]["captureId"], CAPTURE_ID);

        // Other entities get no replay header — their requests stay
        // byte-identical to before this feature.
        let other = queue_item("orders", "INSERT", "order-1", json!({}));
        assert!(replay_idempotency_header(&other).is_none());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_sends_supplier_import_commit_with_the_capture_id_as_idempotency_key() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_supplier_import_commit_test_item(&conn);

        let conn = std::sync::Mutex::new(conn);
        // `200 alreadyCommitted` is what the server replays when this
        // capture id was already committed by an earlier lost-ack attempt —
        // like a fresh 200, it must complete the queue item [R9.5].
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            200,
            r#"{"success":true,"alreadyCommitted":true,"result":{"success":true,"supplierInvoiceId":"invoice-1","alreadyCommitted":true}}"#,
        )])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);

        let request = requests.recv().await.expect("captured commit request");
        assert_eq!(
            request.request_line,
            "POST /api/pos/suppliers/import/commit HTTP/1.1"
        );
        assert_eq!(
            request.headers.get("idempotency-key").map(String::as_str),
            Some(CAPTURE_ID),
        );
        let body: Value = serde_json::from_str(&request.body).expect("request body json");
        assert_eq!(body["capture"]["captureId"], CAPTURE_ID);
        assert_eq!(body["draft"]["invoiceNumber"], "INV-2026-118");

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(
            remaining, 0,
            "2xx (incl. 200 alreadyCommitted) must complete and remove the item"
        );

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_collapses_supplier_import_crash_retries_to_one_server_effect() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        enqueue_supplier_import_commit_test_item(&conn);

        let conn = std::sync::Mutex::new(conn);
        // First attempt: the server wrote the invoice but the terminal lost
        // the acknowledgement (500 on the way back). Second attempt: the
        // claim replays the stored result verbatim.
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![
            MockResponse::json(500, r#"{"success":false,"error":"Upstream timeout"}"#),
            MockResponse::json(
                200,
                r#"{"success":true,"alreadyCommitted":true,"result":{"success":true,"supplierInvoiceId":"invoice-1","alreadyCommitted":true}}"#,
            ),
        ])
        .await;

        process_queue(&conn, &base_url, "api-key")
            .await
            .expect("first drain");
        // Clear the backoff the 500 scheduled so the retry runs in-test.
        conn.lock()
            .expect("lock db")
            .execute(
                "UPDATE parity_sync_queue SET next_retry_at = NULL, status = 'pending'",
                [],
            )
            .expect("release backoff");
        let second = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("second drain");

        let first_request = requests.recv().await.expect("first commit request");
        let second_request = requests.recv().await.expect("retry commit request");

        // The SAME capture-time key on both attempts is what makes the
        // duplicate collapse server-side into one invoice [R9.5].
        assert_eq!(
            first_request.headers.get("idempotency-key"),
            second_request.headers.get("idempotency-key"),
        );
        assert_eq!(
            first_request
                .headers
                .get("idempotency-key")
                .map(String::as_str),
            Some(CAPTURE_ID),
        );
        let first_body: Value = serde_json::from_str(&first_request.body).expect("first body json");
        let second_body: Value =
            serde_json::from_str(&second_request.body).expect("second body json");
        assert_eq!(
            first_body["capture"]["captureId"], second_body["capture"]["captureId"],
            "a retry must never mint a fresh capture id",
        );

        assert_eq!(second.processed, 1);
        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
                row.get(0)
            })
            .expect("read queue state");
        assert_eq!(remaining, 0, "the replayed result completes the item");

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_parks_supplier_import_commit_pending_when_module_is_required() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_supplier_import_commit_test_item(&conn);

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            403,
            r#"{"success":false,"error":"MODULE_REQUIRED","missingModules":["suppliers"]}"#,
        )])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);

        let request = requests.recv().await.expect("captured commit request");
        assert_eq!(
            request.request_line,
            "POST /api/pos/suppliers/import/commit HTTP/1.1"
        );

        let (status, attempts, error_message, data): (String, i64, String, String) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, attempts, error_message, data
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read parked row");
        assert_eq!(
            status, "pending",
            "module denial parks the row — the invoice is retained until the module returns [R11.7]"
        );
        assert_eq!(attempts, 0, "module denial must NOT burn attempts");
        assert!(
            error_message.contains("MODULE_REQUIRED") && error_message.contains("suppliers"),
            "park reason must name the missing module: {error_message}"
        );
        // The reviewed invoice — every edit the user made — is still on the row.
        let preserved: Value = serde_json::from_str(&data).expect("preserved payload parses");
        assert_eq!(preserved["draft"]["rows"][0]["name"], "Tomatoes");
        assert_eq!(preserved["capture"]["captureId"], CAPTURE_ID);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn claim_time_quarantine_is_counted_and_cannot_report_batch_success() {
        let (fixture, setup) = FileBackedTestDb::new("claim-time-quarantine-count");
        let process_db = std::sync::Mutex::new(setup);
        let database_path = fixture.path.clone();
        let mut gate_calls = 0_usize;

        let result = process_queue_with_claim_gate(
            &process_db,
            "http://127.0.0.1:9",
            "unused-api-key",
            move || {
                gate_calls += 1;
                if gate_calls == 2 {
                    let writer = Connection::open(&database_path).expect("open claim-gap writer");
                    writer
                        .execute(
                            "INSERT INTO parity_sync_queue (
                                 id, table_name, record_id, operation, data, organization_id,
                                 created_at, attempts, retry_delay_ms, priority, module_type,
                                 conflict_strategy, version, claim_generation, status
                             ) VALUES (
                                 'claim-time-poison', '\u{2003}repairs\u{2003}',
                                 'claim-time-private-record', 'UPDATE',
                                 'claim-time-private-payload', 'claim-time-org',
                                 '2026-08-26T07:00:00Z', 0, 1000, 100,
                                 '\u{2003}orders\u{2003}', 'manual', 1, 0, 'pending'
                             )",
                            [],
                        )
                        .expect("insert poison after prepass and before atomic claim");
                }
                Ok(())
            },
        )
        .await
        .expect("process claim-time poison");

        assert!(!result.success);
        assert_eq!(result.quarantined, 1);
        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.dead_lettered, 0);
        let db = process_db.lock().expect("lock claim-time db");
        assert_eq!(
            db.query_row(
                "SELECT status, error_message, data FROM parity_sync_queue
                 WHERE id = 'claim-time-poison'",
                [],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?
                )),
            )
            .expect("read claim-time quarantine"),
            (
                "failed".to_string(),
                REPAIR_RESERVED_OWNER_QUARANTINED.to_string(),
                "claim-time-private-payload".to_string(),
            )
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn blocked_prepass_gate_preserves_actionable_rows_byte_for_byte() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, claim_generation, status
             ) VALUES (
                 'blocked-prepass-poison', '\u{00a0}repair_attachments\u{00a0}',
                 'blocked-prepass-private-record', 'UPDATE',
                 'blocked-prepass-private-payload', 'blocked-prepass-org',
                 '2000-01-01T00:00:00Z', 3, 1000, 100,
                 '\u{00a0}repairs\u{00a0}', 'manual', 1, 4, 'processing'
             )",
            [],
        )
        .expect("seed prepass-actionable semantic poison");
        let before = full_queue_row_fingerprint(&conn, "blocked-prepass-poison");
        let process_db = std::sync::Mutex::new(conn);

        let result = process_queue_with_claim_gate(
            &process_db,
            "http://127.0.0.1:9",
            "unused-api-key",
            || Err::<(), _>(ParityClaimGateBlock::ResetPending),
        )
        .await
        .expect("return bounded prepass block");

        assert!(!result.success);
        assert_eq!(result.batch_block, Some(ParityClaimGateBlock::ResetPending));
        assert_eq!(result.quarantined, 0);
        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);
        assert_eq!(
            full_queue_row_fingerprint(
                &process_db.lock().expect("lock blocked prepass db"),
                "blocked-prepass-poison",
            ),
            before,
            "a denied lifecycle gate must precede quarantine/recovery/requeue mutations"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn renderer_claim_gate_blocks_before_generic_recovery_prepass() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, last_attempt, retry_delay_ms, priority,
                 module_type, conflict_strategy, version, claim_generation, status
             ) VALUES (
                 'renderer-blocked-prepass', 'customers',
                 'renderer-blocked-private-record', 'UPDATE',
                 'renderer-blocked-private-payload', 'renderer-blocked-org',
                 '2000-01-01T00:00:00Z', 2, '2000-01-01T00:00:00Z', 1000, 100,
                 'customers', 'manual', 1, 8, 'processing'
             )",
            [],
        )
        .expect("seed renderer stale-processing row");
        let before = full_queue_row_fingerprint(&conn, "renderer-blocked-prepass");
        let process_db = std::sync::Mutex::new(conn);

        let result = process_queue_renderer_safe_with_claim_gate(
            &process_db,
            "http://127.0.0.1:9",
            "unused-api-key",
            || Err::<(), _>(ParityClaimGateBlock::RebindPending),
        )
        .await
        .expect("return bounded renderer prepass block");

        assert_eq!(
            result.batch_block,
            Some(ParityClaimGateBlock::RebindPending)
        );
        assert!(!result.success);
        assert_eq!(
            full_queue_row_fingerprint(
                &process_db.lock().expect("lock renderer blocked db"),
                "renderer-blocked-prepass",
            ),
            before,
            "renderer lifecycle block must precede stale-processing recovery"
        );
    }

    #[test]
    fn renderer_semantic_owner_boundary_excludes_unicode_financial_and_audit_variants() {
        let conn = test_connection();
        let variants = [
            ("exact", "repair_settlement", "orders"),
            ("uppercase", "REPAIR_SETTLEMENT", "ORDERS"),
            ("ascii-space", " repair_settlement ", " orders "),
            ("tab", "\trepair_settlement\t", "\torders\t"),
            (
                "nbsp",
                "\u{00a0}repair_settlement\u{00a0}",
                "\u{00a0}orders\u{00a0}",
            ),
            (
                "em-space",
                "\u{2003}repair_settlement\u{2003}",
                "\u{2003}orders\u{2003}",
            ),
        ];

        for (index, (label, order_context, queue_table)) in variants.into_iter().enumerate() {
            let order_id = format!("semantic-owner-order-{index}");
            let remote_id = format!("semantic-owner-remote-{index}");
            conn.execute(
                "INSERT INTO orders (
                     id, supabase_id, items, total_amount, status, sync_status,
                     order_context, created_at, updated_at
                 ) VALUES (?1, ?2, '[]', 9.50, 'ready', 'synced', ?3,
                           datetime('now'), datetime('now'))",
                params![order_id, remote_id, order_context],
            )
            .expect("seed semantic repair settlement order");

            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, retry_delay_ms, priority, module_type,
                     conflict_strategy, version, claim_generation, status
                 ) VALUES (?1, ?2, ?3, 'UPDATE', ?4, 'semantic-owner-org',
                           '2026-08-26T07:00:00Z', 0, 1000, 100, 'orders',
                           'manual', 1, 0, 'pending')",
                params![
                    format!("semantic-owner-queue-{index}"),
                    queue_table,
                    remote_id,
                    format!("private-queue-payload-{label}")
                ],
            )
            .expect("seed semantic repair settlement queue row");

            log_conflict(
                &conn,
                "UPDATE",
                &format!("semantic-owner-remote-{index}"),
                queue_table,
                1,
                2,
                &format!("private-audit-payload-{label}"),
                "manual",
                true,
                false,
            )
            .expect("seed semantic repair settlement audit row");
        }

        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, claim_generation, status
             ) VALUES (
                 'semantic-owner-generic-control', '\u{2003}customers\u{2003}',
                 'generic-control', 'UPDATE', '{\"safe\":true}',
                 'semantic-owner-org', '2026-08-26T07:00:01Z', 0, 1000, 1,
                 'customers', 'manual', 1, 0, 'pending'
             )",
            [],
        )
        .expect("seed unrelated generic control");
        log_conflict(
            &conn,
            "UPDATE",
            "generic-control",
            "\u{2003}customers\u{2003}",
            1,
            2,
            "safe generic audit payload",
            "manual",
            false,
            false,
        )
        .expect("seed unrelated generic audit control");

        assert_eq!(
            renderer_get_length(&conn).expect("renderer-safe length"),
            1,
            "only the unrelated generic control may count on the renderer surface"
        );
        assert_eq!(
            renderer_peek(&conn)
                .expect("renderer-safe peek")
                .map(|item| item.id),
            Some("semantic-owner-generic-control".to_string())
        );
        let listed = renderer_list_actionable_items(
            &conn,
            &QueueListQuery {
                module_type: None,
                limit: Some(50),
            },
        )
        .expect("renderer-safe list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "semantic-owner-generic-control");

        let audit =
            renderer_list_conflict_audit_entries(&conn, 50).expect("renderer-safe conflict audit");
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].entity_id, "generic-control");
        assert_eq!(audit[0].discarded_payload, "safe generic audit payload");
        assert!(
            !format!("{audit:?}").contains("private-audit-payload"),
            "renderer audit surface exposed a repair-settlement payload"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn renderer_owner_matrix_fences_every_unicode_axis_and_financial_family() {
        let conn = test_connection();
        let families = [
            "orders",
            "payments",
            "order_payments",
            "payment_adjustments",
        ];
        let mut protected_queue_ids = Vec::new();
        let mut direct_queue_ids = Vec::new();
        let mut financial_queue_ids = Vec::new();

        for family in families {
            for (index, (label, context_variant)) in semantic_matrix_variants("repair_settlement")
                .into_iter()
                .enumerate()
            {
                let prefix = format!("semantic-matrix-context-{family}-{label}-{index}");
                let graph = seed_semantic_matrix_graph(&conn, &prefix, &context_variant);
                let record_id = semantic_matrix_record_id(family, &graph);
                let queue_id = format!("{prefix}-queue");
                seed_semantic_matrix_queue_row(&conn, &queue_id, family, record_id);
                log_conflict(
                    &conn,
                    "INSERT",
                    record_id,
                    family,
                    1,
                    2,
                    &format!("semantic-matrix-private-audit-context-{family}-{label}"),
                    "manual",
                    true,
                    false,
                )
                .expect("seed context-axis audit row");
                protected_queue_ids.push(queue_id.clone());
                financial_queue_ids.push(queue_id);
            }

            for (index, (label, family_variant)) in
                semantic_matrix_variants(family).into_iter().enumerate()
            {
                let prefix = format!("semantic-matrix-shape-{family}-{label}-{index}");
                let graph = seed_semantic_matrix_graph(&conn, &prefix, "repair_settlement");
                let record_id = semantic_matrix_record_id(family, &graph);
                let queue_id = format!("{prefix}-queue");
                seed_semantic_matrix_queue_row(&conn, &queue_id, &family_variant, record_id);
                log_conflict(
                    &conn,
                    "INSERT",
                    record_id,
                    &family_variant,
                    1,
                    2,
                    &format!("semantic-matrix-private-audit-shape-{family}-{label}"),
                    "manual",
                    true,
                    false,
                )
                .expect("seed entity-type-axis audit row");
                protected_queue_ids.push(queue_id.clone());
                financial_queue_ids.push(queue_id);
            }
        }

        for direct_family in ["repairs", "repair_attachments"] {
            for (index, (label, table_variant)) in semantic_matrix_variants(direct_family)
                .into_iter()
                .enumerate()
            {
                let queue_id =
                    format!("semantic-matrix-direct-{direct_family}-{label}-{index}-queue");
                let record_id =
                    format!("semantic-matrix-direct-{direct_family}-{label}-{index}-record");
                seed_semantic_matrix_queue_row(&conn, &queue_id, &table_variant, &record_id);
                log_conflict(
                    &conn,
                    "INSERT",
                    &record_id,
                    &table_variant,
                    1,
                    2,
                    &format!("semantic-matrix-private-audit-direct-{direct_family}-{label}"),
                    "manual",
                    false,
                    false,
                )
                .expect("seed direct semantic audit row");
                protected_queue_ids.push(queue_id.clone());
                direct_queue_ids.push(queue_id);
            }
        }

        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, claim_generation, status
             ) VALUES (
                 'semantic-matrix-generic-control', '\u{2003}customers\u{2003}',
                 'semantic-matrix-generic-control-record', 'UPDATE',
                 '{\"safe\":true}', 'semantic-matrix-org',
                 '2026-08-26T07:00:01Z', 0, 1000, 1, 'customers',
                 'manual', 1, 0, 'pending'
             )",
            [],
        )
        .expect("seed semantic matrix generic control");
        log_conflict(
            &conn,
            "UPDATE",
            "semantic-matrix-generic-control-record",
            "\u{2003}customers\u{2003}",
            1,
            2,
            "safe semantic matrix generic audit",
            "manual",
            false,
            false,
        )
        .expect("seed semantic matrix generic audit control");

        let queue_fingerprints = |connection: &Connection| {
            protected_queue_ids
                .iter()
                .map(|item_id| full_queue_row_fingerprint(connection, item_id))
                .collect::<Vec<_>>()
        };
        let local_before = (
            full_table_rows_fingerprint(&conn, "orders", "semantic-matrix-"),
            full_table_rows_fingerprint(&conn, "order_payments", "semantic-matrix-"),
            full_table_rows_fingerprint(&conn, "payment_adjustments", "semantic-matrix-"),
        );
        let audit_before = full_table_rows_fingerprint(&conn, "conflict_audit_log", "");

        for item_id in &protected_queue_ids {
            conn.execute(
                "UPDATE parity_sync_queue
                    SET status = 'processing',
                        last_attempt = '2000-01-01T00:00:00Z'
                  WHERE id = ?1",
                [item_id],
            )
            .expect("make semantic matrix row recovery-actionable");
        }
        let recovery_before = queue_fingerprints(&conn);
        assert_eq!(
            recover_stale_processing_items_renderer_safe(&conn)
                .expect("run renderer-safe recovery matrix"),
            0
        );
        assert_eq!(queue_fingerprints(&conn), recovery_before);

        for item_id in &protected_queue_ids {
            conn.execute(
                "UPDATE parity_sync_queue
                    SET status = 'pending', last_attempt = NULL,
                        next_retry_at = NULL
                  WHERE id = ?1",
                [item_id],
            )
            .expect("make semantic matrix row renderer-actionable");
        }
        let read_before = queue_fingerprints(&conn);
        assert_eq!(renderer_get_length(&conn).expect("matrix length"), 1);
        let status = renderer_get_status(&conn).expect("matrix status");
        assert_eq!(
            (
                status.total,
                status.pending,
                status.in_progress,
                status.failed,
                status.conflicts,
            ),
            (1, 1, 0, 0, 0)
        );
        assert_eq!(
            renderer_peek(&conn)
                .expect("matrix peek")
                .map(|item| item.id),
            Some("semantic-matrix-generic-control".to_string())
        );
        let actionable = renderer_list_actionable_items(
            &conn,
            &QueueListQuery {
                module_type: None,
                limit: Some(500),
            },
        )
        .expect("matrix actionable list");
        assert_eq!(actionable.len(), 1);
        assert_eq!(actionable[0].id, "semantic-matrix-generic-control");
        let renderer_audit =
            renderer_list_conflict_audit_entries(&conn, 500).expect("matrix audit list");
        assert_eq!(renderer_audit.len(), 1);
        assert_eq!(
            renderer_audit[0].entity_id,
            "semantic-matrix-generic-control-record"
        );
        assert_eq!(
            renderer_audit[0].discarded_payload,
            "safe semantic matrix generic audit"
        );
        assert!(!format!("{renderer_audit:?}").contains("semantic-matrix-private-audit"));
        let claimed_control = renderer_dequeue(&conn)
            .expect("matrix dequeue")
            .expect("generic control must remain claimable");
        assert_eq!(claimed_control.id, "semantic-matrix-generic-control");
        mark_success(&conn, &claimed_control.id, claimed_control.claim_generation)
            .expect("remove claimed generic control");
        assert_eq!(queue_fingerprints(&conn), read_before);

        for item_id in &protected_queue_ids {
            conn.execute(
                "UPDATE parity_sync_queue
                    SET status = 'failed', attempts = 3,
                        error_message = 'semantic matrix private error',
                        last_attempt = '2000-01-01T00:00:00Z'
                  WHERE id = ?1",
                [item_id],
            )
            .expect("make semantic matrix row retry-actionable");
        }
        let mutation_before = queue_fingerprints(&conn);
        for item_id in &direct_queue_ids {
            assert_eq!(
                renderer_retry_item(&conn, item_id).expect_err("direct owner retry must route"),
                "REPAIR_TYPED_CONFLICT_REQUIRED"
            );
        }
        for item_id in &financial_queue_ids {
            assert_eq!(
                renderer_retry_item(&conn, item_id).expect_err("repair financial retry must route"),
                "REPAIR_SETTLEMENT_ROUTE_REQUIRED"
            );
        }
        assert_eq!(
            renderer_retry_items_by_module(&conn, "semantic-matrix")
                .expect("matrix module retry")
                .retried,
            0
        );
        renderer_clear(&conn).expect("matrix renderer clear");
        assert_eq!(queue_fingerprints(&conn), mutation_before);

        let process_db = std::sync::Mutex::new(conn);
        let result =
            process_queue_renderer_safe(&process_db, "http://127.0.0.1:9", "unused-api-key")
                .await
                .expect("matrix renderer-safe no-HTTP pass");
        assert!(result.success);
        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);
        assert_eq!(result.quarantined, 0);
        let conn = process_db.lock().expect("lock semantic matrix db");
        assert_eq!(queue_fingerprints(&conn), mutation_before);
        assert_eq!(
            (
                full_table_rows_fingerprint(&conn, "orders", "semantic-matrix-"),
                full_table_rows_fingerprint(&conn, "order_payments", "semantic-matrix-"),
                full_table_rows_fingerprint(&conn, "payment_adjustments", "semantic-matrix-"),
            ),
            local_before,
            "renderer operations mutated a linked repair financial row"
        );
        assert_eq!(
            full_table_rows_fingerprint(&conn, "conflict_audit_log", ""),
            audit_before,
            "renderer operations mutated semantic repair audit history"
        );
    }

    fn seed_timestamp_format_backoff_rows(conn: &Connection, prefix: &str) -> String {
        seed_terminal_context(conn);
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, next_retry_at, retry_delay_ms, priority,
                 module_type, conflict_strategy, version, claim_generation, status
             ) VALUES (
                 ?1, 'customers', ?2, 'UPDATE', '{\"due\":true}', 'backoff-org',
                 '2026-08-26T07:00:01Z', 1, datetime('now', '-1 minute'), 1000,
                 1, 'customers', 'manual', 1, 0, 'pending'
             ), (
                 ?3, 'customers', ?4, 'UPDATE', '{\"privateFuture\":true}',
                 'backoff-org', '2026-08-26T07:00:00Z', 1,
                 strftime('%Y-%m-%d 24:00:00-14:00', 'now'), 1000,
                 100, 'customers', 'manual', 1, 0, 'pending'
             )",
            params![
                format!("{prefix}-due"),
                format!("{prefix}-due-record"),
                format!("{prefix}-future"),
                format!("{prefix}-future-record")
            ],
        )
        .expect("seed timestamp-format backoff rows");
        assert!(
            conn.query_row(
                "SELECT julianday(next_retry_at) > julianday('now')
                 FROM parity_sync_queue WHERE id = ?1",
                [format!("{prefix}-future")],
                |row| row.get::<_, bool>(0),
            )
            .expect("prove SQLite-format row is in the future"),
            "test fixture must be chronologically future even though it sorts before RFC3339 now"
        );
        format!("{prefix}-future")
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn queue_backoff_uses_timestamp_value_not_lexical_format_on_every_path() {
        let internal_peek = test_connection();
        let future_id = seed_timestamp_format_backoff_rows(&internal_peek, "internal-peek");
        let future_before = full_queue_row_fingerprint(&internal_peek, &future_id);
        assert_eq!(
            peek(&internal_peek)
                .expect("internal peek")
                .expect("due internal item")
                .id,
            "internal-peek-due"
        );
        assert_eq!(
            full_queue_row_fingerprint(&internal_peek, &future_id),
            future_before
        );

        let renderer_peek_conn = test_connection();
        let future_id = seed_timestamp_format_backoff_rows(&renderer_peek_conn, "renderer-peek");
        let future_before = full_queue_row_fingerprint(&renderer_peek_conn, &future_id);
        assert_eq!(
            renderer_peek(&renderer_peek_conn)
                .expect("renderer peek")
                .expect("due renderer item")
                .id,
            "renderer-peek-due"
        );
        assert_eq!(
            full_queue_row_fingerprint(&renderer_peek_conn, &future_id),
            future_before
        );

        let internal_dequeue = test_connection();
        let future_id = seed_timestamp_format_backoff_rows(&internal_dequeue, "internal-dequeue");
        let future_before = full_queue_row_fingerprint(&internal_dequeue, &future_id);
        assert_eq!(
            dequeue(&internal_dequeue)
                .expect("internal dequeue")
                .expect("due internal claim")
                .id,
            "internal-dequeue-due"
        );
        assert_eq!(
            full_queue_row_fingerprint(&internal_dequeue, &future_id),
            future_before
        );

        let renderer_dequeue_conn = test_connection();
        let future_id =
            seed_timestamp_format_backoff_rows(&renderer_dequeue_conn, "renderer-dequeue");
        let future_before = full_queue_row_fingerprint(&renderer_dequeue_conn, &future_id);
        assert_eq!(
            renderer_dequeue(&renderer_dequeue_conn)
                .expect("renderer dequeue")
                .expect("due renderer claim")
                .id,
            "renderer-dequeue-due"
        );
        assert_eq!(
            full_queue_row_fingerprint(&renderer_dequeue_conn, &future_id),
            future_before
        );

        let process_conn = test_connection();
        let future_id = seed_timestamp_format_backoff_rows(&process_conn, "process");
        let future_before = full_queue_row_fingerprint(&process_conn, &future_id);
        let process_conn = std::sync::Arc::new(std::sync::Mutex::new(process_conn));
        let (base_url, observed, release, server) = spawn_blocked_first_response_server(
            MockResponse::json(200, r#"{"success":true,"data":{}}"#),
        )
        .await;
        let process_task = {
            let process_conn = process_conn.clone();
            tokio::spawn(async move { process_queue(&process_conn, &base_url, "api-key").await })
        };
        observed.await.expect("observe first due request");
        release.send(()).expect("release due response");
        let result = process_task
            .await
            .expect("join backoff processor")
            .expect("process due row");
        let requests = server.await.expect("join backoff server");
        assert_eq!(
            requests.len(),
            1,
            "future row must not be sent in this batch"
        );
        assert!(requests[0].request_line.contains("process-due-record"));
        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(result.conflicts, 0);
        assert_eq!(
            full_queue_row_fingerprint(
                &process_conn.lock().expect("lock backoff process db"),
                &future_id
            ),
            future_before,
            "chronologically future row must stay byte-for-byte unchanged"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn stale_409_response_cannot_follow_up_a_semantically_reowned_claim() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let queue_id = enqueue_test_item(
            &conn,
            "customers",
            "UPDATE",
            "stale-409-customer",
            json!({
                "name": "private-stale-409-payload",
                "version": 1
            }),
        );
        let conn = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let (base_url, observed, release, server) =
            spawn_blocked_first_response_server(MockResponse::json(
                409,
                r#"{"success":false,"error":"version conflict","private":"response-409-sentinel"}"#,
            ))
            .await;
        let process_task = {
            let conn = conn.clone();
            tokio::spawn(async move { process_queue(&conn, &base_url, "api-key").await })
        };

        observed.await.expect("observe blocked 409 request");
        let quarantined_fingerprint = {
            let db = conn.lock().expect("lock blocked 409 db");
            db.execute(
                "UPDATE parity_sync_queue
                 SET module_type = ?2
                 WHERE id = ?1 AND status = 'processing'",
                params![queue_id.as_str(), "\u{2003}repairs\u{2003}"],
            )
            .expect("semantically re-own blocked 409 row");
            assert_eq!(
                quarantine_reserved_repair_lookalikes(&db).expect("quarantine blocked 409 owner"),
                1
            );
            full_queue_row_fingerprint(&db, &queue_id).expect("fingerprint quarantined 409 row")
        };
        release.send(()).expect("release blocked 409 response");
        let result = process_task
            .await
            .expect("join blocked 409 processor")
            .expect("process blocked 409 response");
        let requests = server.await.expect("join blocked 409 server");

        assert_eq!(requests.len(), 1, "stale claim must not issue conflict GET");
        assert_eq!(
            (result.processed, result.failed, result.conflicts),
            (0, 0, 0)
        );
        assert!(
            result.errors.is_empty(),
            "stale claim produced a public error"
        );
        let db = conn.lock().expect("lock final 409 db");
        assert_eq!(
            full_queue_row_fingerprint(&db, &queue_id),
            Some(quarantined_fingerprint),
            "stale response changed the quarantined row"
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM conflict_audit_log
                 WHERE entity_id = 'stale-409-customer'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("count stale 409 audit rows"),
            0,
            "stale claimant copied private payload into conflict audit"
        );
        let exposed = format!("{result:?}");
        assert!(!exposed.contains("private-stale-409-payload"));
        assert!(!exposed.contains("response-409-sentinel"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn stale_payment_422_cannot_adopt_quarantine_generation_or_mutate_payment() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        conn.execute_batch(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, payment_status,
                 payment_transaction_id, sync_status, created_at, updated_at
             ) VALUES (
                 'stale-422-order', 'remote-stale-422-order', '[]', 4.79, 479, 'completed', 'paid',
                 'stale-422-valid', 'synced', datetime('now'), datetime('now')
             );
             INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, currency, status,
                 remote_payment_id, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'stale-422-valid', 'stale-422-order', 'cash', 4.79, 479, 'EUR',
                 'completed', 'remote-stale-422-valid', 'synced', 'applied',
                 datetime('now'), datetime('now')
             ), (
                 'stale-422-payment', 'stale-422-order', 'cash', 0.55, 55, 'EUR',
                 'completed', NULL, 'pending', 'pending', datetime('now'), datetime('now')
             );",
        )
        .expect("seed stale payment conflict graph");
        let queue_id = enqueue(
            &conn,
            &EnqueueInput {
                table_name: "payments".to_string(),
                record_id: "stale-422-payment".to_string(),
                operation: "INSERT".to_string(),
                data: json!({
                    "paymentId": "stale-422-payment",
                    "orderId": "stale-422-order",
                    "amount": 0.55,
                    "private": "payment-422-payload-sentinel"
                })
                .to_string(),
                organization_id: "stale-422-org".to_string(),
                priority: Some(100),
                module_type: Some("payment".to_string()),
                conflict_strategy: Some("server-wins".to_string()),
                version: Some(1),
            },
        )
        .expect("enqueue stale payment conflict");
        let conn = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let (base_url, observed, release, server) = spawn_blocked_first_response_server(
            MockResponse::json(
                422,
                r#"{"success":false,"error":"Payment exceeds order total","details":"Order total: 4.79, tip: 0, existing completed: 4.79, payment: 0.55","private":"response-422-sentinel"}"#,
            ),
        )
        .await;
        let process_task = {
            let conn = conn.clone();
            tokio::spawn(async move { process_queue(&conn, &base_url, "api-key").await })
        };

        match tokio::time::timeout(Duration::from_secs(5), observed).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => panic!("blocked payment server closed before observing request"),
            Err(_) if process_task.is_finished() => {
                let outcome = process_task.await;
                panic!("payment processor finished before reaching HTTP: {outcome:?}");
            }
            Err(_) => {
                process_task.abort();
                panic!("payment processor did not reach HTTP within five seconds");
            }
        }
        let (queue_fingerprint, payment_fingerprint) = {
            let db = conn.lock().expect("lock blocked payment db");
            db.execute(
                "UPDATE parity_sync_queue SET module_type = ?2
                 WHERE id = ?1 AND status = 'processing'",
                params![queue_id.as_str(), "\u{2003}repairs\u{2003}"],
            )
            .expect("semantically re-own blocked payment row");
            assert_eq!(
                quarantine_reserved_repair_lookalikes(&db)
                    .expect("quarantine blocked payment owner"),
                1
            );
            (
                full_queue_row_fingerprint(&db, &queue_id)
                    .expect("fingerprint quarantined payment row"),
                full_order_payment_row_fingerprint(&db, "stale-422-payment")
                    .expect("fingerprint payment at response boundary"),
            )
        };
        release.send(()).expect("release blocked payment response");
        let result = process_task
            .await
            .expect("join blocked payment processor")
            .expect("process blocked payment response");
        let requests = server.await.expect("join blocked payment server");

        assert_eq!(requests.len(), 1);
        assert_eq!(
            (result.processed, result.failed, result.conflicts),
            (0, 0, 0)
        );
        assert!(result.errors.is_empty());
        let db = conn.lock().expect("lock final payment db");
        assert_eq!(
            full_queue_row_fingerprint(&db, &queue_id),
            Some(queue_fingerprint),
            "stale payment response adopted the quarantine generation"
        );
        assert_eq!(
            full_order_payment_row_fingerprint(&db, "stale-422-payment"),
            Some(payment_fingerprint),
            "stale payment response mutated the canonical local payment"
        );
        let exposed = format!("{result:?}");
        assert!(!exposed.contains("payment-422-payload-sentinel"));
        assert!(!exposed.contains("response-422-sentinel"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn stale_order_500_cannot_issue_legacy_fallback_after_semantic_reownership() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status,
                 payment_status, sync_status, created_at, updated_at
             ) VALUES (
                 'stale-500-order', 'stale-500-order-remote', '[]', 29.4, 2940,
                 'pending', 'paid', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed stale fallback order");
        let queue_id = enqueue(
            &conn,
            &EnqueueInput {
                table_name: "orders".to_string(),
                record_id: "stale-500-order".to_string(),
                operation: "UPDATE".to_string(),
                data: json!({
                    "orderId": "stale-500-order",
                    "status": "pending",
                    "paymentStatus": "paid",
                    "totalAmount": 29.4,
                    "items": [{
                        "menu_item_id": TEST_MENU_ITEM_ID,
                        "name": "private-fallback-item-sentinel",
                        "quantity": 1,
                        "unit_price": 29.4
                    }]
                })
                .to_string(),
                organization_id: "stale-500-org".to_string(),
                priority: Some(100),
                module_type: Some("orders".to_string()),
                conflict_strategy: Some("server-wins".to_string()),
                version: Some(1),
            },
        )
        .expect("enqueue stale fallback order");
        let conn = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let (base_url, observed, release, server) = spawn_blocked_first_response_server(
            MockResponse::json(
                500,
                r#"{"success":false,"error":"Failed to update order","private":"response-500-sentinel"}"#,
            ),
        )
        .await;
        let process_task = {
            let conn = conn.clone();
            tokio::spawn(async move { process_queue(&conn, &base_url, "api-key").await })
        };

        observed
            .await
            .expect("observe blocked legacy order request");
        let quarantined_fingerprint = {
            let db = conn.lock().expect("lock blocked legacy order db");
            db.execute(
                "UPDATE parity_sync_queue SET module_type = ?2
                 WHERE id = ?1 AND status = 'processing'",
                params![queue_id.as_str(), "\u{2003}repairs\u{2003}"],
            )
            .expect("semantically re-own blocked legacy order row");
            assert_eq!(
                quarantine_reserved_repair_lookalikes(&db)
                    .expect("quarantine blocked legacy order owner"),
                1
            );
            full_queue_row_fingerprint(&db, &queue_id)
                .expect("fingerprint quarantined legacy order row")
        };
        release
            .send(())
            .expect("release blocked legacy order response");
        let result = process_task
            .await
            .expect("join blocked legacy order processor")
            .expect("process blocked legacy order response");
        let requests = server.await.expect("join blocked legacy order server");

        assert_eq!(
            requests.len(),
            1,
            "stale claim issued a legacy fallback HTTP request"
        );
        assert_eq!(
            (result.processed, result.failed, result.conflicts),
            (0, 0, 0)
        );
        assert!(result.errors.is_empty());
        let db = conn.lock().expect("lock final legacy order db");
        assert_eq!(
            full_queue_row_fingerprint(&db, &queue_id),
            Some(quarantined_fingerprint)
        );
        let exposed = format!("{result:?}");
        assert!(!exposed.contains("private-fallback-item-sentinel"));
        assert!(!exposed.contains("response-500-sentinel"));
    }

    #[test]
    fn legacy_prepasses_never_select_semantic_or_linked_repair_financial_rows() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        seed_customer_cache(
            &conn,
            "prepass-customer",
            json!({
                "id": "local-prepass-address",
                "street_address": "Private Prepass Street",
                "city": "Athens"
            }),
        );
        let seed_failed = |id: &str,
                           table_name: &str,
                           record_id: &str,
                           operation: &str,
                           module_type: &str,
                           data: &str,
                           error_message: &str| {
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, last_attempt, error_message, retry_delay_ms,
                     priority, module_type, conflict_strategy, version, claim_generation, status
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'prepass-org',
                           '2026-08-26T07:00:00Z', 10, '2026-08-26T07:01:00Z',
                           ?7, 64000, 100, ?6, 'manual', 1, 4, 'failed')",
                params![
                    id,
                    table_name,
                    record_id,
                    operation,
                    data,
                    module_type,
                    error_message
                ],
            )
            .expect("seed protected prepass row");
        };

        let semantic_module = "\u{2003}repairs\u{2003}";
        seed_failed(
            "prepass-terminal",
            "customers",
            "prepass-terminal-record",
            "UPDATE",
            semantic_module,
            r#"{"private":"terminal-prepass-sentinel"}"#,
            "Parity sync request is missing terminal_id context",
        );
        seed_failed(
            "prepass-rate-limit",
            "customers",
            "prepass-rate-record",
            "UPDATE",
            semantic_module,
            r#"{"private":"rate-prepass-sentinel"}"#,
            "HTTP 429: rate limit exceeded",
        );
        seed_failed(
            "prepass-fiscal",
            "\u{00a0}repair_attachments\u{00a0}",
            "prepass-fiscal-record",
            "INSERT",
            "fiscal",
            r#"{"issuedAt":"2026-06-19 11:35:00","private":"fiscal-prepass-sentinel"}"#,
            r#"HTTP 400: {"error":"InvalidFiscalReceiptInput","issues":[{"path":["issuedAt"],"message":"Invalid datetime"}]}"#,
        );
        seed_failed(
            "prepass-order",
            "orders",
            "prepass-order-record",
            "UPDATE",
            semantic_module,
            r#"{"status":"pending","private":"order-prepass-sentinel"}"#,
            r#"HTTP 400: {"error":"Validation failed","details":[{"field":"payment_method","message":"Required"}]}"#,
        );
        seed_failed(
            "prepass-address",
            "customer_addresses",
            "local-prepass-address",
            "UPDATE",
            semantic_module,
            r#"{"customer_id":"prepass-customer","private":"address-prepass-sentinel"}"#,
            r#"HTTP 404: {"error":"Address not found"}"#,
        );
        seed_failed(
            "prepass-session",
            "restaurant_table_sessions",
            "local-table-session:prepass-order",
            "UPDATE",
            semantic_module,
            r#"{"private":"session-prepass-sentinel"}"#,
            r#"HTTP 500: {"error":"invalid input syntax for type uuid: \"local-table-session:prepass-order\""}"#,
        );

        conn.execute_batch(
            "INSERT INTO orders (
                 id, items, total_amount, total_amount_cents, status, payment_status,
                 payment_transaction_id, sync_status, order_context, created_at, updated_at
             ) VALUES (
                 'prepass-repair-order', '[]', 4.79, 479, 'completed', 'paid',
                 'prepass-valid-payment', 'synced',
                 '\u{2003}repair_settlement\u{2003}', datetime('now'), datetime('now')
             );
             INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, currency, status,
                 remote_payment_id, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'prepass-valid-payment', 'prepass-repair-order', 'cash', 4.79, 479,
                 'EUR', 'completed', 'remote-prepass-valid', 'synced', 'applied',
                 datetime('now'), datetime('now')
             ), (
                 'prepass-repair-payment', 'prepass-repair-order', 'cash', 0.55, 55,
                 'EUR', 'completed', NULL, 'failed', 'failed', datetime('now'), datetime('now')
             );",
        )
        .expect("seed linked repair financial graph");
        seed_failed(
            "prepass-linked-payment",
            "payments",
            "prepass-repair-payment",
            "INSERT",
            "payment",
            r#"{"orderId":"prepass-repair-order","amount":0.55,"private":"linked-payment-prepass-sentinel"}"#,
            r#"HTTP 422: {"error":"Payment exceeds order total","details":"Order total: 4.79, tip: 0, existing completed: 4.79, payment: 0.55"}"#,
        );

        let protected_ids = [
            "prepass-terminal",
            "prepass-rate-limit",
            "prepass-fiscal",
            "prepass-order",
            "prepass-address",
            "prepass-session",
            "prepass-linked-payment",
        ];
        let before = protected_ids
            .iter()
            .map(|id| full_queue_row_fingerprint(&conn, id))
            .collect::<Vec<_>>();
        let payment_before = full_order_payment_row_fingerprint(&conn, "prepass-repair-payment");

        let _ = retry_failed_terminal_context_items_limited(&conn, 10)
            .expect("run terminal-context prepass");
        let _ = retry_failed_rate_limited_items_limited(&conn, 10).expect("run rate-limit prepass");
        let _ = retry_failed_invalid_fiscal_issued_at_items_limited(&conn, 10)
            .expect("run fiscal prepass");
        let _ = retry_failed_legacy_order_insert_items_limited(&conn, 10)
            .expect("run legacy-order prepass");
        let _ = resolve_failed_payment_total_conflict_items_limited(&conn, 10)
            .expect("run payment-conflict prepass");
        let _ = retry_failed_customer_address_not_found_items_limited(&conn, 10)
            .expect("run customer-address prepass");
        let _ = retry_failed_table_session_local_placeholder_items_limited(&conn, 10)
            .expect("run table-session prepass");

        let after = protected_ids
            .iter()
            .map(|id| full_queue_row_fingerprint(&conn, id))
            .collect::<Vec<_>>();
        assert_eq!(
            after, before,
            "legacy prepasses selected or mutated a semantically protected row"
        );
        assert_eq!(
            full_order_payment_row_fingerprint(&conn, "prepass-repair-payment"),
            payment_before,
            "linked repair-settlement payment was mutated by generic recovery"
        );
    }

    #[test]
    #[serial_test::serial]
    fn real_database_restart_quarantines_unicode_poison_once_without_payload_logging() {
        let directory = crate::tests::harness::TempDir::new();
        let initial = crate::db::init(directory.path()).expect("initialize startup quarantine db");
        {
            let conn = initial
                .conn
                .lock()
                .expect("lock startup quarantine seed db");
            for (index, (status, generation)) in [
                ("pending", 0_i64),
                ("processing", 7_i64),
                ("failed", 3_i64),
                ("conflict", 4_i64),
            ]
            .into_iter()
            .enumerate()
            {
                conn.execute(
                    "INSERT INTO parity_sync_queue (
                         id, table_name, record_id, operation, data, organization_id,
                         created_at, attempts, last_attempt, error_message, next_retry_at,
                         retry_delay_ms, priority, module_type, conflict_strategy, version,
                         claim_generation, status
                     ) VALUES (?1, ?2, ?3, 'UPDATE', ?4, 'startup-poison-org',
                               '2026-08-26T07:00:00Z', 5, '2026-08-26T07:01:00Z',
                               'old startup error', '2099-01-01 00:00:00', 64000, 100,
                               ?5, 'manual', 1, ?6, ?7)",
                    params![
                        format!("startup-poison-{status}"),
                        if index % 2 == 0 {
                            "\u{2003}repairs\u{2003}"
                        } else {
                            "\u{00a0}repair_attachments\u{00a0}"
                        },
                        format!("startup-poison-record-{status}"),
                        format!("private-startup-payload-{status}"),
                        "\trepairs\t",
                        generation,
                        status
                    ],
                )
                .expect("seed startup Unicode poison");
            }
        }
        drop(initial);

        let logs = CapturedLogWriter::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_writer(logs.clone())
            .finish();
        let reopened =
            tracing::subscriber::with_default(subscriber, || crate::db::init(directory.path()))
                .expect("reopen through real database init");
        let first_fingerprints = {
            let conn = reopened.conn.lock().expect("lock first reopened db");
            for (status, expected_generation) in [
                ("pending", 0_i64),
                ("processing", 8_i64),
                ("failed", 3_i64),
                ("conflict", 4_i64),
            ] {
                let row = conn
                    .query_row(
                        "SELECT status, claim_generation, error_message, next_retry_at, data
                         FROM parity_sync_queue WHERE id = ?1",
                        [format!("startup-poison-{status}")],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, Option<String>>(3)?,
                                row.get::<_, String>(4)?,
                            ))
                        },
                    )
                    .expect("read startup-quarantined row");
                assert_eq!(row.0, "failed");
                assert_eq!(row.1, expected_generation);
                assert_eq!(row.2, REPAIR_RESERVED_OWNER_QUARANTINED);
                assert_eq!(row.3, None);
                assert_eq!(row.4, format!("private-startup-payload-{status}"));
            }
            let usage = capacity_usage(&conn).expect("startup capacity after quarantine");
            assert_eq!((usage.replayable, usage.conflicts), (0, 0));
            ["pending", "processing", "failed", "conflict"]
                .into_iter()
                .map(|status| {
                    full_queue_row_fingerprint(&conn, &format!("startup-poison-{status}"))
                })
                .collect::<Vec<_>>()
        };
        let captured_logs = logs.contents();
        for status in ["pending", "processing", "failed", "conflict"] {
            assert!(
                !captured_logs.contains(&format!("private-startup-payload-{status}")),
                "startup quarantine copied a private payload into logs"
            );
        }
        drop(reopened);

        let reopened_again =
            crate::db::init(directory.path()).expect("reopen startup quarantine db again");
        let second_fingerprints = {
            let conn = reopened_again.conn.lock().expect("lock second reopened db");
            ["pending", "processing", "failed", "conflict"]
                .into_iter()
                .map(|status| {
                    full_queue_row_fingerprint(&conn, &format!("startup-poison-{status}"))
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            second_fingerprints, first_fingerprints,
            "second startup must be byte-for-byte idempotent"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn batch_dead_letter_count_uses_the_live_transition_not_dequeued_attempts() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let item_id = enqueue_test_item(
            &conn,
            "customers",
            "UPDATE",
            "authoritative-dead-letter-record",
            json!({ "safe": true }),
        );
        let conn = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let (base_url, observed, release, server) = spawn_blocked_first_response_server(
            MockResponse::json(500, r#"{"error":"temporary"}"#),
        )
        .await;
        let process_task = {
            let conn = conn.clone();
            tokio::spawn(async move { process_queue(&conn, &base_url, "api-key").await })
        };
        observed.await.expect("observe dead-letter request");
        conn.lock()
            .expect("lock live attempts row")
            .execute(
                "UPDATE parity_sync_queue SET attempts = ?1 WHERE id = ?2",
                params![MAX_RETRY_ATTEMPTS - 1, item_id.as_str()],
            )
            .expect("advance live attempts after dequeue snapshot");
        release.send(()).expect("release dead-letter response");

        let result = process_task
            .await
            .expect("join authoritative dead-letter processor")
            .expect("process authoritative dead-letter row");
        assert_eq!(server.await.expect("join dead-letter server").len(), 1);
        assert_eq!(result.failed, 1);
        assert_eq!(result.dead_lettered, 1);
        assert!(result.monetary_dead_letters.is_empty());
        assert!(!result.success);
        assert_eq!(
            conn.lock()
                .expect("lock terminal dead-letter row")
                .query_row(
                    "SELECT status, attempts FROM parity_sync_queue WHERE id = ?1",
                    [item_id.as_str()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .expect("read terminal dead-letter row"),
            ("failed".to_string(), MAX_RETRY_ATTEMPTS)
        );
    }

    #[test]
    fn monetary_dead_letter_notice_is_bounded_and_emitted_only_on_transition() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, claim_generation, status
             ) VALUES (
                 'bounded-dead-letter', 'payments', 'private-payment-record-id',
                 'INSERT', '{\"phone\":\"+301234567890\",\"private\":true}',
                 'bounded-dead-letter-org', '2026-08-26T07:00:00Z', ?1, 1000,
                 100, 'payment', 'server-wins', 1, 7, 'processing'
             )",
            [MAX_RETRY_ATTEMPTS - 1],
        )
        .expect("seed bounded dead-letter row");

        let first = mark_failure(
            &conn,
            "bounded-dead-letter",
            "HTTP 500: private-provider-response +301234567890",
            7,
        )
        .expect("transition monetary dead-letter");
        assert!(first.applied);
        assert!(first.transitioned_to_dead_letter);
        let serialized = serde_json::to_value(
            first
                .monetary_notice
                .expect("new monetary terminal transition emits one notice"),
        )
        .expect("serialize bounded notice");
        assert_eq!(serialized, json!({ "category": "payment" }));
        let exposed = serialized.to_string();
        assert!(!exposed.contains("private-payment-record-id"));
        assert!(!exposed.contains("private-provider-response"));
        assert!(!exposed.contains("+301234567890"));

        let repeated = mark_failure(
            &conn,
            "bounded-dead-letter",
            "HTTP 500: second private response",
            7,
        )
        .expect("repeat dead-letter acknowledgement");
        assert!(!repeated.applied);
        assert!(!repeated.transitioned_to_dead_letter);
        assert!(repeated.monetary_notice.is_none());
    }

    #[test]
    fn telemetry_module_category_never_echoes_queue_controlled_text() {
        let mut item = queue_item(
            "customers",
            "UPDATE",
            "telemetry-private-record",
            json!({ "safe": true }),
        );
        item.module_type = "private-module-sentinel/+301234567890".to_string();
        let mut telemetry = SyncTelemetryBuilder::new(Utc::now().to_rfc3339(), 1);
        telemetry.record_success(&item);

        let categories = telemetry
            .outcomes
            .keys()
            .map(|(module, _, _)| module.as_str())
            .collect::<Vec<_>>();
        assert_eq!(categories, vec!["other"]);
        assert!(!format!("{:?}", telemetry.outcomes).contains("private-module-sentinel"));
        assert!(!format!("{:?}", telemetry.outcomes).contains("+301234567890"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn terminal_auth_result_is_bounded_and_stops_before_the_second_generic_row() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let first_id = enqueue_test_item(
            &conn,
            "customers",
            "UPDATE",
            "terminal-auth-first",
            json!({ "private": "terminal-auth-request-sentinel" }),
        );
        let second_id = enqueue_test_item(
            &conn,
            "customers",
            "UPDATE",
            "terminal-auth-second",
            json!({ "safe": true }),
        );
        conn.execute(
            "UPDATE parity_sync_queue SET priority = 100 WHERE id = ?1",
            [first_id.as_str()],
        )
        .expect("prioritize first terminal-auth row");
        let second_before = full_queue_row_fingerprint(&conn, &second_id);
        let conn = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let (base_url, observed, release, server) = spawn_blocked_first_response_server(
            MockResponse::json(
                401,
                r#"{"success":false,"code":"terminal_inactive","terminalActive":false,"private":"terminal-auth-response-sentinel"}"#,
            ),
        )
        .await;
        let process_task = {
            let conn = conn.clone();
            tokio::spawn(async move { process_queue(&conn, &base_url, "api-key").await })
        };
        observed.await.expect("observe terminal auth request");
        release.send(()).expect("release terminal auth response");
        let result = process_task
            .await
            .expect("join terminal auth processor")
            .expect("return bounded terminal auth result");
        let requests = server.await.expect("join terminal auth server");
        assert_eq!(requests.len(), 1, "terminal auth must stop the batch");
        assert_eq!(
            full_queue_row_fingerprint(&conn.lock().expect("lock terminal auth db"), &second_id),
            second_before,
            "second row changed after terminal-auth stop"
        );

        let serialized = serde_json::to_value(&result).expect("serialize terminal auth result");
        assert_eq!(
            serialized.pointer("/authOutcome/kind"),
            Some(&json!("hard_terminal_auth"))
        );
        assert_eq!(
            serialized.pointer("/authOutcome/code"),
            Some(&json!("terminal_inactive"))
        );
        assert_eq!(
            serialized.pointer("/authOutcome/terminalActive"),
            Some(&json!(false))
        );
        assert_eq!(serialized.get("batchBlock"), Some(&Value::Null));
        let exposed = serialized.to_string();
        assert!(!exposed.contains("terminal-auth-request-sentinel"));
        assert!(!exposed.contains("terminal-auth-response-sentinel"));
    }

    #[test]
    fn aggregate_queue_status_exposes_only_safe_complete_counts() {
        let conn = test_connection();
        for (id, status, attempts, error) in [
            ("status-pending", "pending", 0_i64, None),
            ("status-processing", "processing", 1_i64, None),
            (
                "status-failed",
                "failed",
                2_i64,
                Some("private ordinary failure"),
            ),
            (
                "status-quarantined",
                "failed",
                0_i64,
                Some(REPAIR_RESERVED_OWNER_QUARANTINED),
            ),
            (
                "status-dead-letter",
                "failed",
                MAX_RETRY_ATTEMPTS,
                Some("private terminal provider body"),
            ),
            (
                "status-conflict",
                "conflict",
                1_i64,
                Some("private conflict body"),
            ),
        ] {
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, error_message, retry_delay_ms, priority,
                     module_type, conflict_strategy, version, claim_generation, status
                 ) VALUES (?1, 'customers', ?1, 'UPDATE', '{\"safe\":true}', 'safe-status-org',
                           '2026-08-26T07:00:00Z', ?3, ?4, 1000, 1,
                           'customers', 'manual', 1, 0, ?2)",
                params![id, status, attempts, error],
            )
            .expect("seed aggregate queue status row");
        }

        let serialized = serde_json::to_value(get_status(&conn).expect("read safe queue status"))
            .expect("serialize safe queue status");
        assert_eq!(serialized.get("total"), Some(&json!(6)));
        assert_eq!(serialized.get("pending"), Some(&json!(1)));
        assert_eq!(serialized.get("inProgress"), Some(&json!(1)));
        assert_eq!(serialized.get("failed"), Some(&json!(3)));
        assert_eq!(serialized.get("conflicts"), Some(&json!(1)));
        assert_eq!(serialized.get("quarantined"), Some(&json!(1)));
        assert_eq!(serialized.get("deadLettered"), Some(&json!(1)));
        let exposed = serialized.to_string();
        assert!(!exposed.contains("private"));
        assert!(!exposed.contains("status-dead-letter"));
    }

    #[test]
    fn queue_status_oldest_age_accepts_rfc3339_and_sqlite_datetime_formats() {
        let age_source = Utc::now() - ChronoDuration::minutes(2);
        for (label, created_at) in [
            ("rfc3339", age_source.to_rfc3339()),
            ("sqlite", age_source.format("%Y-%m-%d %H:%M:%S").to_string()),
        ] {
            let conn = test_connection();
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, retry_delay_ms, priority, module_type,
                     conflict_strategy, version, claim_generation, status
                 ) VALUES (?1, 'customers', ?2, 'UPDATE', '{\"safe\":true}',
                           'status-age-org', ?3, 0, 1000, 1, 'customers',
                           'manual', 1, 0, 'pending')",
                params![
                    format!("status-age-{label}"),
                    format!("status-age-record-{label}"),
                    created_at
                ],
            )
            .expect("seed oldest-age format row");

            for (surface, age) in [
                (
                    "internal",
                    get_status(&conn)
                        .expect("internal age status")
                        .oldest_item_age,
                ),
                (
                    "renderer",
                    renderer_get_status(&conn)
                        .expect("renderer age status")
                        .oldest_item_age,
                ),
            ] {
                let age = age.unwrap_or_else(|| {
                    panic!("{surface} status dropped the {label} timestamp format")
                });
                assert!(
                    (90_000..=180_000).contains(&age),
                    "unexpected {surface}/{label} age: {age}ms"
                );
            }
        }
    }

    #[test]
    #[serial_test::serial]
    fn startup_redacts_identifiable_legacy_repair_audit_payloads_without_guessing_generic_rows() {
        const REDACTED: &str = "REPAIR_AUDIT_PAYLOAD_REDACTED";
        let directory = crate::tests::harness::TempDir::new();
        let initial = crate::db::init(directory.path()).expect("initialize audit-redaction db");
        {
            let conn = initial.conn.lock().expect("lock audit-redaction seed db");
            conn.execute(
                "INSERT INTO orders (
                     id, supabase_id, items, total_amount, status, sync_status,
                     order_context, created_at, updated_at
                 ) VALUES (
                     'audit-redaction-order', 'audit-redaction-order-remote', '[]',
                     9.50, 'ready', 'synced', ?1, datetime('now'), datetime('now')
                 )",
                ["\u{2003}repair_settlement\u{2003}"],
            )
            .expect("seed audit-redaction repair order");
            log_conflict(
                &conn,
                "UPDATE",
                "audit-direct-repair",
                "\u{00a0}repairs\u{00a0}",
                1,
                2,
                "private-direct-audit-payload",
                "manual",
                false,
                false,
            )
            .expect("seed direct repair audit payload");
            log_conflict(
                &conn,
                "UPDATE",
                "audit-redaction-order-remote",
                "\torders\t",
                1,
                2,
                "private-financial-audit-payload",
                "manual",
                true,
                false,
            )
            .expect("seed linked financial audit payload");
            log_conflict(
                &conn,
                "UPDATE",
                "audit-generic-control",
                "\u{2003}customers\u{2003}",
                1,
                2,
                "safe-generic-audit-payload",
                "manual",
                false,
                false,
            )
            .expect("seed generic audit payload");
        }
        drop(initial);

        let reopened = crate::db::init(directory.path()).expect("reopen audit-redaction db");
        let first_state = {
            let conn = reopened.conn.lock().expect("lock audit-redaction db");
            let mut stmt = conn
                .prepare(
                    "SELECT entity_id, discarded_payload, operation_type, local_version,
                            server_version, resolution, is_monetary
                     FROM conflict_audit_log
                     ORDER BY entity_id",
                )
                .expect("prepare redacted audit read");
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                })
                .expect("query redacted audit rows")
                .map(|row| row.expect("read redacted audit row"))
                .collect::<Vec<_>>();
            assert_eq!(rows[0].0, "audit-direct-repair");
            assert_eq!(rows[0].1, REDACTED);
            assert_eq!(rows[1].0, "audit-generic-control");
            assert_eq!(rows[1].1, "safe-generic-audit-payload");
            assert_eq!(rows[2].0, "audit-redaction-order-remote");
            assert_eq!(rows[2].1, REDACTED);

            let renderer = renderer_list_conflict_audit_entries(&conn, 50)
                .expect("read renderer audit after redaction");
            assert_eq!(renderer.len(), 1);
            assert_eq!(renderer[0].entity_id, "audit-generic-control");
            assert_eq!(renderer[0].discarded_payload, "safe-generic-audit-payload");
            rows
        };
        drop(reopened);

        let reopened_again =
            crate::db::init(directory.path()).expect("reopen audit-redaction db twice");
        let second_state = {
            let conn = reopened_again
                .conn
                .lock()
                .expect("lock audit-redaction db twice");
            let mut stmt = conn
                .prepare(
                    "SELECT entity_id, discarded_payload, operation_type, local_version,
                            server_version, resolution, is_monetary
                     FROM conflict_audit_log
                     ORDER BY entity_id",
                )
                .expect("prepare second redacted audit read");
            stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .expect("query second redacted audit rows")
            .map(|row| row.expect("read second redacted audit row"))
            .collect::<Vec<_>>()
        };
        assert_eq!(
            second_state, first_state,
            "audit redaction must be idempotent"
        );
    }
}
