//! Background sync engine for The Small POS.
//!
//! Manages order creation (local insert + sync queue entry) and a background
//! loop that batches pending sync operations and POSTs them to the admin
//! dashboard. Orders go to `/api/pos/orders/sync`; shift and expense events
//! go to `/api/pos/shifts/sync`. Each entity type is synced independently
//! so a failure in one category does not block the other.

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::api;
use crate::db::DbState;
use crate::print;
use crate::storage;

// ---------------------------------------------------------------------------
// Auth failure detection
// ---------------------------------------------------------------------------

fn is_terminal_auth_failure(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("invalid api key for terminal")
        || lower.contains("terminal identity mismatch")
        || lower.contains("api key is invalid or expired")
        || lower.contains("terminal not authorized")
}

/// Perform a full factory reset triggered by terminal deletion detection.
/// Clears all operational data, local settings, menu cache, and credentials,
/// then emits events so the frontend redirects to onboarding.
fn factory_reset_from_sync(db: &DbState, app: &AppHandle) {
    warn!("Terminal deleted or deactivated — performing automatic factory reset");

    if let Ok(conn) = db.conn.lock() {
        let _ = conn.execute_batch(
            "BEGIN IMMEDIATE;
             DELETE FROM payment_adjustments;
             DELETE FROM order_payments;
             DELETE FROM shift_expenses;
             DELETE FROM cash_drawer_sessions;
             DELETE FROM staff_shifts;
             DELETE FROM print_jobs;
             DELETE FROM z_reports;
             DELETE FROM sync_queue;
             DELETE FROM orders;
             DELETE FROM local_settings;
             DELETE FROM menu_cache;
             COMMIT;",
        );
    }

    let _ = storage::factory_reset();
    let _ = app.emit(
        "app_reset",
        serde_json::json!({ "reason": "terminal_deleted" }),
    );
    let _ = app.emit(
        "terminal_disabled",
        serde_json::json!({ "reason": "terminal_deleted" }),
    );
}

// ---------------------------------------------------------------------------
// Sync engine state (managed by Tauri)
// ---------------------------------------------------------------------------

/// Managed state for the background sync engine.
pub struct SyncState {
    pub is_running: Arc<AtomicBool>,
    pub last_sync: Arc<std::sync::Mutex<Option<String>>>,
}

/// Ensure failed-order validation requeue runs once per process start.
static FAILED_ORDER_REQUEUE_DONE: AtomicBool = AtomicBool::new(false);
/// Disable stuck-receipt cleanup DELETE calls for this process when backend does not support it.
#[allow(dead_code)]
static STUCK_RECEIPT_CLEANUP_UNSUPPORTED: AtomicBool = AtomicBool::new(false);
const DEFAULT_RETRY_DELAY_MS: i64 = 5_000;
const MAX_RETRY_DELAY_MS: i64 = 300_000;
const ORDER_SYNC_SINCE_FALLBACK: &str = "1970-01-01T00:00:00.000Z";
#[allow(dead_code)]
const ORDER_DIRECT_FALLBACK_QUEUE_AGE_SEC: i64 = 600;

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

    let terminal_id = storage::get_credential("terminal_id").unwrap_or_default();
    let branch_id = storage::get_credential("branch_id").unwrap_or_default();

    // Extract fields from payload with defaults
    let order_number = Some(next_order_number(&conn));
    let customer_name =
        str_field(payload, "customerName").or_else(|| str_field(payload, "customer_name"));
    let customer_phone =
        str_field(payload, "customerPhone").or_else(|| str_field(payload, "customer_phone"));
    let customer_email =
        str_field(payload, "customerEmail").or_else(|| str_field(payload, "customer_email"));
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
    let delivery_notes =
        str_field(payload, "deliveryNotes").or_else(|| str_field(payload, "delivery_notes"));
    let name_on_ringer =
        str_field(payload, "nameOnRinger").or_else(|| str_field(payload, "name_on_ringer"));
    let special_instructions = str_field(payload, "specialInstructions")
        .or_else(|| str_field(payload, "special_instructions"));
    let estimated_time = payload
        .get("estimatedTime")
        .or_else(|| payload.get("estimated_time"))
        .and_then(Value::as_i64);
    let payment_status = str_field(payload, "paymentStatus")
        .or_else(|| str_field(payload, "payment_status"))
        .unwrap_or_else(|| "pending".to_string());
    let payment_method =
        str_field(payload, "paymentMethod").or_else(|| str_field(payload, "payment_method"));
    let staff_id = str_field(payload, "staffId").or_else(|| str_field(payload, "staff_id"));
    let staff_shift_id =
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

    conn.execute(
        "INSERT INTO orders (
            id, order_number, customer_name, customer_phone, customer_email,
            items, total_amount, tax_amount, subtotal, status,
            order_type, table_number, delivery_address, delivery_notes,
            name_on_ringer, special_instructions, created_at, updated_at,
            estimated_time, sync_status, payment_status, payment_method,
            staff_shift_id, staff_id, discount_percentage, discount_amount,
            tip_amount, version, terminal_id, branch_id, plugin, tax_rate, delivery_fee,
            client_request_id, is_ghost, ghost_source, ghost_metadata
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18,
            ?19, 'pending', ?20, ?21,
            ?22, ?23, ?24, ?25,
            ?26, 1, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35
        )",
        params![
            &order_id,
            &order_number,
            &customer_name,
            &customer_phone,
            &customer_email,
            &items,
            &total_amount,
            &tax_amount,
            &subtotal,
            &status,
            &order_type,
            &table_number,
            &delivery_address,
            &delivery_notes,
            &name_on_ringer,
            &special_instructions,
            &now,
            &now,
            &estimated_time,
            &payment_status,
            &payment_method,
            &staff_shift_id,
            &staff_id,
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
    .map_err(|e| format!("insert order: {e}"))?;

    // Enqueue for sync
    let idempotency_key = format!("{terminal_id}:{order_id}:{}", Utc::now().timestamp_millis());
    let mut sync_data = payload.clone();
    if let Value::Object(obj) = &mut sync_data {
        obj.entry("orderId".to_string())
            .or_insert_with(|| Value::String(order_id.clone()));
        // Ensure the Rust-generated order number is synced to admin
        if let Some(ref num) = order_number {
            obj.insert("orderNumber".to_string(), Value::String(num.clone()));
            obj.insert("order_number".to_string(), Value::String(num.clone()));
        }
        if let Some(req_id) = client_request_id.as_ref() {
            obj.entry("clientRequestId".to_string())
                .or_insert_with(|| Value::String(req_id.clone()));
        }
    }
    let sync_payload = serde_json::to_string(&sync_data).unwrap_or_else(|_| "{}".to_string());

    conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('order', ?1, 'insert', ?2, ?3)",
        params![&order_id, sync_payload, idempotency_key],
    )
    .map_err(|e| format!("enqueue sync: {e}"))?;

    drop(conn);

    if let Err(error) = print::enqueue_print_job(db, "order_receipt", &order_id, None) {
        warn!(
            order_id = %order_id,
            error = %error,
            "Failed to enqueue order receipt print job after local create"
        );
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
            "SELECT id, order_number, customer_name, customer_phone, customer_email,
                    items, total_amount, tax_amount, subtotal, status,
                    cancellation_reason, order_type, table_number, delivery_address,
                    delivery_notes, name_on_ringer, special_instructions,
                    created_at, updated_at, estimated_time, supabase_id,
                    sync_status, payment_status, payment_method,
                    payment_transaction_id, staff_shift_id, staff_id,
                    discount_percentage, discount_amount, tip_amount,
                    version, updated_by, last_synced_at, remote_version,
                    terminal_id, branch_id, plugin, external_plugin_order_id,
                    tax_rate, delivery_fee, is_ghost, ghost_source, ghost_metadata
             FROM orders
             WHERE COALESCE(is_ghost, 0) = 0
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            // Parse items JSON
            let items_str: String = row.get(5)?;
            let items: Value = serde_json::from_str(&items_str).unwrap_or(Value::Array(vec![]));
            let ghost_metadata_str: Option<String> = row.get(42)?;
            let ghost_metadata = ghost_metadata_str
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .unwrap_or(Value::Null);
            let is_ghost = row.get::<_, Option<i64>>(40)?.unwrap_or(0) != 0;

            Ok(serde_json::json!({
                "id": row.get::<_, Option<String>>(0)?,
                "orderNumber": row.get::<_, Option<String>>(1)?,
                "customerName": row.get::<_, Option<String>>(2)?,
                "customerPhone": row.get::<_, Option<String>>(3)?,
                "customerEmail": row.get::<_, Option<String>>(4)?,
                "items": items,
                "totalAmount": row.get::<_, f64>(6)?,
                "taxAmount": row.get::<_, Option<f64>>(7)?,
                "subtotal": row.get::<_, Option<f64>>(8)?,
                "status": row.get::<_, String>(9)?,
                "cancellationReason": row.get::<_, Option<String>>(10)?,
                "orderType": row.get::<_, Option<String>>(11)?,
                "tableNumber": row.get::<_, Option<String>>(12)?,
                "deliveryAddress": row.get::<_, Option<String>>(13)?,
                "deliveryNotes": row.get::<_, Option<String>>(14)?,
                "nameOnRinger": row.get::<_, Option<String>>(15)?,
                "specialInstructions": row.get::<_, Option<String>>(16)?,
                "createdAt": row.get::<_, Option<String>>(17)?,
                "updatedAt": row.get::<_, Option<String>>(18)?,
                "estimatedTime": row.get::<_, Option<i64>>(19)?,
                "supabaseId": row.get::<_, Option<String>>(20)?,
                "syncStatus": row.get::<_, String>(21)?,
                "paymentStatus": row.get::<_, Option<String>>(22)?,
                "paymentMethod": row.get::<_, Option<String>>(23)?,
                "paymentTransactionId": row.get::<_, Option<String>>(24)?,
                "staffShiftId": row.get::<_, Option<String>>(25)?,
                "staffId": row.get::<_, Option<String>>(26)?,
                "discountPercentage": row.get::<_, Option<f64>>(27)?,
                "discountAmount": row.get::<_, Option<f64>>(28)?,
                "tipAmount": row.get::<_, Option<f64>>(29)?,
                "version": row.get::<_, Option<i64>>(30)?,
                "updatedBy": row.get::<_, Option<String>>(31)?,
                "lastSyncedAt": row.get::<_, Option<String>>(32)?,
                "remoteVersion": row.get::<_, Option<i64>>(33)?,
                "terminalId": row.get::<_, Option<String>>(34)?,
                "branchId": row.get::<_, Option<String>>(35)?,
                "plugin": row.get::<_, Option<String>>(36)?,
                "externalPluginOrderId": row.get::<_, Option<String>>(37)?,
                "taxRate": row.get::<_, Option<f64>>(38)?,
                "deliveryFee": row.get::<_, Option<f64>>(39)?,
                "is_ghost": is_ghost,
                "isGhost": is_ghost,
                "ghost_source": row.get::<_, Option<String>>(41)?,
                "ghostSource": row.get::<_, Option<String>>(41)?,
                "ghost_metadata": ghost_metadata,
                "ghostMetadata": ghost_metadata,
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
        "SELECT id, order_number, customer_name, customer_phone, customer_email,
                items, total_amount, tax_amount, subtotal, status,
                cancellation_reason, order_type, table_number, delivery_address,
                delivery_notes, name_on_ringer, special_instructions,
                created_at, updated_at, estimated_time, supabase_id,
                sync_status, payment_status, payment_method,
                payment_transaction_id, staff_shift_id, staff_id,
                discount_percentage, discount_amount, tip_amount,
                version, updated_by, last_synced_at, remote_version,
                terminal_id, branch_id, plugin, external_plugin_order_id,
                tax_rate, delivery_fee, is_ghost, ghost_source, ghost_metadata
         FROM orders WHERE id = ?1",
        params![id],
        |row| {
            let items_str: String = row.get(5)?;
            let items: Value = serde_json::from_str(&items_str).unwrap_or(Value::Array(vec![]));
            let ghost_metadata_str: Option<String> = row.get(42)?;
            let ghost_metadata = ghost_metadata_str
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .unwrap_or(Value::Null);
            let is_ghost = row.get::<_, Option<i64>>(40)?.unwrap_or(0) != 0;
            let ghost_source: Option<String> = row.get(41)?;

            Ok(serde_json::json!({
                "id": row.get::<_, Option<String>>(0)?,
                "orderNumber": row.get::<_, Option<String>>(1)?,
                "customerName": row.get::<_, Option<String>>(2)?,
                "customerPhone": row.get::<_, Option<String>>(3)?,
                "customerEmail": row.get::<_, Option<String>>(4)?,
                "items": items,
                "totalAmount": row.get::<_, f64>(6)?,
                "taxAmount": row.get::<_, Option<f64>>(7)?,
                "subtotal": row.get::<_, Option<f64>>(8)?,
                "status": row.get::<_, String>(9)?,
                "cancellationReason": row.get::<_, Option<String>>(10)?,
                "orderType": row.get::<_, Option<String>>(11)?,
                "tableNumber": row.get::<_, Option<String>>(12)?,
                "deliveryAddress": row.get::<_, Option<String>>(13)?,
                "deliveryNotes": row.get::<_, Option<String>>(14)?,
                "nameOnRinger": row.get::<_, Option<String>>(15)?,
                "specialInstructions": row.get::<_, Option<String>>(16)?,
                "createdAt": row.get::<_, Option<String>>(17)?,
                "updatedAt": row.get::<_, Option<String>>(18)?,
                "estimatedTime": row.get::<_, Option<i64>>(19)?,
                "supabaseId": row.get::<_, Option<String>>(20)?,
                "syncStatus": row.get::<_, String>(21)?,
                "paymentStatus": row.get::<_, Option<String>>(22)?,
                "paymentMethod": row.get::<_, Option<String>>(23)?,
                "paymentTransactionId": row.get::<_, Option<String>>(24)?,
                "staffShiftId": row.get::<_, Option<String>>(25)?,
                "staffId": row.get::<_, Option<String>>(26)?,
                "discountPercentage": row.get::<_, Option<f64>>(27)?,
                "discountAmount": row.get::<_, Option<f64>>(28)?,
                "tipAmount": row.get::<_, Option<f64>>(29)?,
                "version": row.get::<_, Option<i64>>(30)?,
                "updatedBy": row.get::<_, Option<String>>(31)?,
                "lastSyncedAt": row.get::<_, Option<String>>(32)?,
                "remoteVersion": row.get::<_, Option<i64>>(33)?,
                "terminalId": row.get::<_, Option<String>>(34)?,
                "branchId": row.get::<_, Option<String>>(35)?,
                "plugin": row.get::<_, Option<String>>(36)?,
                "externalPluginOrderId": row.get::<_, Option<String>>(37)?,
                "taxRate": row.get::<_, Option<f64>>(38)?,
                "deliveryFee": row.get::<_, Option<f64>>(39)?,
                "is_ghost": is_ghost,
                "isGhost": is_ghost,
                "ghost_source": ghost_source,
                "ghostSource": ghost_source,
                "ghost_metadata": ghost_metadata,
                "ghostMetadata": ghost_metadata,
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
        let order = get_order_by_id(db, &entity_id).unwrap_or(Value::Null);

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

/// Get sync queue statistics.
pub fn get_sync_status(db: &DbState, sync_state: &SyncState) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

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
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'failed'",
            [],
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
    let api_key = match storage::get_credential("pos_api_key") {
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
        .header("X-POS-API-Key", &api_key)
        .send()
        .await
    {
        Ok(resp) => serde_json::json!({ "isOnline": resp.status().is_success() }),
        Err(_) => serde_json::json!({ "isOnline": false }),
    }
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
) {
    let is_running = sync_state.is_running.clone();
    let last_sync = sync_state.last_sync.clone();

    // Mark as running
    is_running.store(true, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        info!("Sync loop started (interval: {interval_secs}s)");
        let mut previous_network_online: Option<bool> = None;

        loop {
            if !is_running.load(Ordering::SeqCst) {
                info!("Sync loop stopped");
                break;
            }

            tokio::time::sleep(Duration::from_secs(interval_secs)).await;

            if !is_running.load(Ordering::SeqCst) {
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

            if !network_is_online {
                if previous_network_online != Some(false) {
                    info!("Network offline; deferring remote sync and keeping queue pending");
                }
                previous_network_online = Some(false);

                let status = get_sync_status_for_event(&db, &last_sync, false);
                let _ = app.emit("sync_status", &status);
                let _ = app.emit("sync-status-changed", &status);
                continue;
            }

            if previous_network_online == Some(false) {
                info!("Network restored; resuming queued sync");
            }
            previous_network_online = Some(true);

            // Run payment reconciliation before the main sync cycle
            // so that deferred payments get promoted to pending.
            if let Err(e) = reconcile_deferred_payments(&db) {
                warn!("Payment reconciliation failed: {e}");
            }

            // Run adjustment reconciliation: promote waiting_parent adjustments
            // whose parent payment has synced (sync_state = 'applied').
            if let Err(e) = reconcile_deferred_adjustments(&db) {
                warn!("Adjustment reconciliation failed: {e}");
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
                        factory_reset_from_sync(&db, &app);
                        is_running.store(false, Ordering::SeqCst);
                        info!("Sync loop stopped — terminal deleted");
                        break;
                    }
                    warn!("Sync cycle failed: {e}");
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
pub async fn force_sync(
    db: &DbState,
    sync_state: &SyncState,
    app: &AppHandle,
) -> Result<(), String> {
    if !storage::is_configured() {
        return Err("Terminal not configured".into());
    }

    let synced = run_sync_cycle(db, app).await?;
    info!("Force sync complete: {synced} items synced");

    if let Ok(mut guard) = sync_state.last_sync.lock() {
        *guard = Some(Utc::now().to_rfc3339());
    }

    Ok(())
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
        || lower.contains("invalid customer")
        || lower.contains("invalid driver")
        || lower.contains("missing required parameter")
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

async fn poll_order_receipt_statuses(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
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
                    "pending" | "processing" | "failed" => {
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
            id, order_number, customer_name, customer_phone, customer_email,
            items, total_amount, tax_amount, subtotal, status,
            order_type, table_number, delivery_address, delivery_notes,
            name_on_ringer, special_instructions, created_at, updated_at,
            estimated_time, supabase_id, sync_status, payment_status, payment_method,
            payment_transaction_id, staff_shift_id, staff_id, discount_percentage,
            discount_amount, tip_amount, version, terminal_id, branch_id,
            plugin, external_plugin_order_id, tax_rate, delivery_fee,
            is_ghost, ghost_source, ghost_metadata
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18,
            ?19, ?20, 'synced', ?21, ?22,
            ?23, ?24, ?25, ?26,
            ?27, ?28, ?29, ?30, ?31,
            ?32, ?33, ?34, ?35,
            ?36, ?37, ?38
        )",
        params![
            local_id,
            order_number,
            customer_name,
            customer_phone,
            customer_email,
            items_json,
            total_amount,
            tax_amount,
            subtotal,
            status,
            order_type,
            table_number,
            delivery_address,
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

async fn reconcile_remote_orders(
    db: &DbState,
    admin_url: &str,
    api_key: &str,
    app: &AppHandle,
) -> Result<usize, String> {
    let mut since_cursor =
        sanitize_orders_since_cursor(local_setting_get(db, "sync", "orders_since"));
    let _ = local_setting_set(db, "sync", "orders_since", &since_cursor);
    let mut reconciled = 0usize;

    for _page in 0..4 {
        let mut path = "/api/pos/orders/sync?limit=200&include_deleted=true&since=".to_string();
        path.push_str(&percent_encode(&since_cursor));

        let resp = match api::fetch_from_admin(admin_url, api_key, &path, "GET", None).await {
            Ok(v) => v,
            Err(e) => {
                if is_backpressure_error(&e) {
                    warn!(error = %e, "Remote order reconciliation deferred due to backpressure");
                    return Ok(reconciled);
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

        {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            for remote_order in orders {
                let remote_id = match remote_order.get("id").and_then(Value::as_str) {
                    Some(v) if !v.trim().is_empty() => v.to_string(),
                    _ => continue,
                };
                let local_id = match resolve_local_order_id(&conn, &remote_order) {
                    Some(v) => v,
                    None => match materialize_remote_order(&conn, &remote_order) {
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
                    },
                };

                let updated_at = remote_order
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| Utc::now().to_rfc3339());
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

                // Check if order has genuinely unsynced queue entries rather than
                // relying on orders.sync_status which can be reset by concurrent edits.
                let has_pending_queue: bool = conn
                    .query_row(
                        "SELECT COUNT(*) > 0 FROM sync_queue
                         WHERE entity_type = 'order'
                           AND entity_id = ?1
                           AND status IN ('pending', 'in_progress')",
                        params![local_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(false);

                if has_pending_queue {
                    // Still set supabase_id (needed for resolution)
                    let _ = conn.execute(
                        "UPDATE orders SET supabase_id = ?1 WHERE id = ?2 AND supabase_id IS NULL",
                        params![remote_id, local_id],
                    );
                    debug!(
                        local_id = %local_id,
                        "Skipped reconcile — order has pending sync queue entries"
                    );
                } else {
                    // Only apply remote changes if they're at least as new as local
                    let local_updated_at: Option<String> = conn
                        .query_row(
                            "SELECT updated_at FROM orders WHERE id = ?1",
                            params![local_id],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten();

                    let should_update = local_updated_at
                        .as_ref()
                        .map(|local| updated_at >= *local)
                        .unwrap_or(true);

                    if should_update {
                        let updated = conn
                            .execute(
                                "UPDATE orders
                                 SET supabase_id = ?1,
                                     status = ?2,
                                     payment_status = ?3,
                                     sync_status = 'synced',
                                     last_synced_at = datetime('now'),
                                     updated_at = ?4
                                 WHERE id = ?5",
                                params![remote_id, status, payment_status, updated_at, local_id],
                            )
                            .unwrap_or(0);
                        if updated > 0 {
                            reconciled += 1;
                        }
                    } else {
                        // Remote is stale, just ensure supabase_id is set
                        let _ = conn.execute(
                            "UPDATE orders SET supabase_id = ?1 WHERE id = ?2 AND supabase_id IS NULL",
                            params![remote_id, local_id],
                        );
                    }
                }

                // Always promote payments regardless of reconciliation outcome
                promote_payments_for_order(&conn, &local_id);
            }
        }

        for local_id in newly_materialized_order_ids {
            if let Ok(order_json) = get_order_by_id(db, &local_id) {
                let _ = app.emit("order_created", order_json.clone());
                let _ = app.emit("order_realtime_update", order_json);
            } else {
                let _ = app.emit(
                    "order_created",
                    serde_json::json!({ "orderId": local_id.clone() }),
                );
            }

            if let Err(error) = print::enqueue_print_job(db, "order_receipt", &local_id, None) {
                warn!(
                    order_id = %local_id,
                    error = %error,
                    "Failed to enqueue print job for newly materialized remote order"
                );
            }
        }

        let next_cursor = sanitize_orders_since_cursor(newest_updated_at.or(Some(sync_timestamp)));
        if next_cursor != since_cursor {
            since_cursor = next_cursor.clone();
            local_setting_set(db, "sync", "orders_since", &next_cursor)?;
        }

        if !has_more {
            break;
        }
    }

    Ok(reconciled)
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
    let api_key = match storage::get_credential("pos_api_key") {
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

    // Poll queued remote receipts first and reconcile remote-assigned IDs
    // before sending new batches.
    let mut total_progress: usize = 0;
    let receipt_updates = poll_order_receipt_statuses(db, &admin_url, &api_key).await?;
    total_progress += receipt_updates;

    let reconciled_orders = reconcile_remote_orders(db, &admin_url, &api_key, app).await?;
    total_progress += reconciled_orders;

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
                 LIMIT 10",
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
    let mut payment_items: Vec<&SyncItem> = Vec::new();
    let mut adjustment_items: Vec<&SyncItem> = Vec::new();
    let mut zreport_items: Vec<&SyncItem> = Vec::new();
    for item in &pending_items {
        match item.1.as_str() {
            "shift" | "shift_expense" => shift_items.push(item),
            "payment" => payment_items.push(item),
            "payment_adjustment" => adjustment_items.push(item),
            "z_report" => zreport_items.push(item),
            _ => order_items.push(item),
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

                // Route non-insert items (not handled by direct API) through
                // the queue endpoint as secondary path.
                let handled = direct_outcome.all_handled_ids();
                let remaining: Vec<&SyncItem> = order_items
                    .iter()
                    .filter(|item| !handled.contains(&item.0))
                    .copied()
                    .collect();

                if !remaining.is_empty() {
                    match sync_order_batch(
                        db,
                        &admin_url,
                        &api_key,
                        &terminal_id,
                        &branch_id,
                        &remaining,
                    )
                    .await
                    {
                        Ok(resp) => {
                            let receipt_id = resp
                                .get("receipt_id")
                                .and_then(Value::as_str)
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty());

                            if let Some(receipt_id) = receipt_id {
                                let queued =
                                    mark_order_queue_as_queued_remote(db, &remaining, &receipt_id)?;
                                info!(
                                    receipt_id = %receipt_id,
                                    queued_rows = queued,
                                    "Non-insert order ops queued remotely"
                                );
                                total_progress += queued;
                            } else {
                                let outcome = mark_batch_failed(
                                    db,
                                    &remaining,
                                    "Missing receipt_id in /api/pos/orders/sync response",
                                )?;
                                if !outcome.backpressure_deferred {
                                    had_non_backpressure_failure = true;
                                }
                            }
                        }
                        Err(e) => {
                            let empty = DirectOrderFallbackOutcome::default();
                            if mark_order_batch_failures(db, &remaining, &e, &empty)? {
                                had_non_backpressure_failure = true;
                            }
                        }
                    }
                }
            }
            Err(e) => {
                // Direct API completely failed — fall back to queue for all items
                warn!(error = %e, "Direct order API failed, falling back to queue endpoint");
                match sync_order_batch(
                    db,
                    &admin_url,
                    &api_key,
                    &terminal_id,
                    &branch_id,
                    &order_items,
                )
                .await
                {
                    Ok(resp) => {
                        let receipt_id = resp
                            .get("receipt_id")
                            .and_then(Value::as_str)
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty());

                        if let Some(receipt_id) = receipt_id {
                            let queued =
                                mark_order_queue_as_queued_remote(db, &order_items, &receipt_id)?;
                            info!(
                                receipt_id = %receipt_id,
                                queued_rows = queued,
                                "Order batch accepted by admin and queued remotely (fallback)"
                            );
                            total_progress += queued;
                        } else {
                            let outcome = mark_batch_failed(
                                db,
                                &order_items,
                                "Missing receipt_id in /api/pos/orders/sync response",
                            )?;
                            if !outcome.backpressure_deferred {
                                had_non_backpressure_failure = true;
                            }
                            warn!("Order sync response missing receipt_id");
                        }
                    }
                    Err(queue_err) => {
                        let empty = DirectOrderFallbackOutcome::default();
                        if mark_order_batch_failures(db, &order_items, &queue_err, &empty)? {
                            had_non_backpressure_failure = true;
                        }
                    }
                }
            }
        }
    }

    // Sync shifts
    if !shift_items.is_empty() {
        match sync_shift_batch(&admin_url, &api_key, &terminal_id, &branch_id, &shift_items).await {
            Ok(()) => {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                let now = Utc::now().to_rfc3339();
                for item in &shift_items {
                    let (id, _, entity_id, _, _, _, _, _, _, _, _) = item;
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = 'synced', synced_at = ?1, updated_at = ?1 WHERE id = ?2",
                        params![now, id],
                    );
                    let _ = conn.execute(
                        "UPDATE staff_shifts SET sync_status = 'synced', updated_at = ?1 WHERE id = ?2",
                        params![now, entity_id],
                    );
                }
                total_progress += shift_items.len();
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
        // Removed "id" fallback to prevent extracting wrong ID field
        let menu_item_id = str_any(&item, &["menu_item_id", "menuItemId"]);
        let Some(menu_item_id) = menu_item_id else {
            warn!("Skipping order item without menu_item_id");
            continue;
        };

        if Uuid::parse_str(&menu_item_id).is_err() {
            warn!(
                menu_item_id = %menu_item_id,
                "Skipping order item with non-UUID menu_item_id"
            );
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

        let name = str_any(&item, &["menu_item_name", "name"]);
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
    let local_order = get_order_by_id(db, entity_id).unwrap_or(Value::Null);
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
    let driver_id = str_any(source, &["driverId", "driver_id", "staffId", "staff_id"])
        .or_else(|| {
            str_any(
                &payload_data,
                &["driverId", "driver_id", "staffId", "staff_id"],
            )
        })
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

        let local_order = get_order_by_id(db, entity_id).unwrap_or(Value::Null);
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
            let menu_item_id = raw_item
                .get("menu_item_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if menu_item_id.is_empty() || Uuid::parse_str(&menu_item_id).is_err() {
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
                "name": raw_item.get("name").cloned().unwrap_or(Value::Null),
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

        let body = serde_json::json!({
            "client_order_id": entity_id,
            "branch_id": branch_id,
            "items": direct_items,
            "order_type": str_any(&data, &["order_type"]).unwrap_or_else(|| "pickup".to_string()),
            "payment_method": str_any(&data, &["payment_method"]).unwrap_or_else(|| "cash".to_string()),
            "payment_status": str_any(&data, &["payment_status"]).unwrap_or_else(|| "pending".to_string()),
            "total_amount": num_any(&data, &["total_amount"]).unwrap_or(0.0),
            "subtotal": num_any(&data, &["subtotal"]),
            "tax_amount": num_any(&data, &["tax_amount"]),
            "discount_amount": num_any(&data, &["discount_amount"]),
            "delivery_fee": num_any(&data, &["delivery_fee"]),
            "notes": str_any(&data, &["notes"]),
            "customer_name": str_any(&data, &["customer_name"]),
            "customer_phone": str_any(&data, &["customer_phone"]),
            "delivery_address": str_any(&data, &["delivery_address"]),
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
                    warn!(
                        queue_id = *queue_id,
                        entity_id = %entity_id,
                        error = %error,
                        order_preview = ?order_preview,
                        "Direct order fallback failed (permanent)"
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
                        "Direct order fallback failed (transient)"
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

    Ok(outcome)
}

/// POST a batch of normalized order sync items to `/api/pos/orders/sync`.
///
/// Returns the server response JSON so the caller can extract
/// `receipt_id` and any server-assigned IDs.
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

/// POST a batch of shift sync items to `/api/pos/shifts/sync`.
async fn sync_shift_batch(
    admin_url: &str,
    api_key: &str,
    terminal_id: &str,
    branch_id: &str,
    items: &[&SyncItem],
) -> Result<(), String> {
    let mut events = Vec::new();
    for item in items {
        let (_id, etype, entity_id, operation, payload, idem_key, _ret, _max, _, _, _) = item;
        let data: Value = serde_json::from_str(payload).unwrap_or(serde_json::json!({}));
        let event_type = match (etype.as_str(), operation.as_str()) {
            ("shift", "insert") => "shift_open",
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
    }

    let body = serde_json::json!({
        "terminal_id": terminal_id,
        "branch_id": branch_id,
        "events": events,
    });

    api::fetch_from_admin(
        admin_url,
        api_key,
        "/api/pos/shifts/sync",
        "POST",
        Some(body),
    )
    .await
    .map(|_| ())
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
        // Include terminal_id as metadata for traceability
        body["metadata"] = serde_json::json!({ "terminal_id": terminal_id });

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
            Ok(_resp) => {
                let now = Utc::now().to_rfc3339();
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = 'synced', synced_at = ?1, updated_at = ?1 WHERE id = ?2",
                        params![now, id],
                    );
                    let _ = conn.execute(
                        "UPDATE order_payments SET sync_status = 'synced', sync_state = 'applied', sync_retry_count = 0, sync_last_error = NULL, updated_at = ?1 WHERE id = ?2",
                        params![now, entity_id],
                    );
                }
                synced += 1;
            }
            Err(e) => {
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

        // Check if the parent payment has synced
        let pay_synced: bool = match db.conn.lock() {
            Ok(conn) => conn
                .query_row(
                    "SELECT sync_state FROM order_payments WHERE id = ?1",
                    params![payment_id],
                    |row| row.get::<_, String>(0),
                )
                .map(|s| s == "applied")
                .unwrap_or(false),
            Err(_) => false,
        };

        if !pay_synced {
            info!(
                adjustment_id = %entity_id,
                payment_id = %payment_id,
                "Adjustment sync deferred: parent payment not yet synced"
            );
            if let Ok(conn) = db.conn.lock() {
                let _ = conn.execute(
                    "UPDATE sync_queue SET status = 'deferred', last_error = 'Payment not yet synced', updated_at = datetime('now') WHERE id = ?1",
                    params![id],
                );
                let _ = conn.execute(
                    "UPDATE payment_adjustments SET sync_state = 'waiting_parent', updated_at = datetime('now') WHERE id = ?1",
                    params![entity_id],
                );
            }
            continue;
        }

        // Mark as syncing
        if let Ok(conn) = db.conn.lock() {
            let _ = conn.execute(
                "UPDATE payment_adjustments SET sync_state = 'syncing', updated_at = datetime('now') WHERE id = ?1",
                params![entity_id],
            );
        }

        // Build the POST body
        let body = serde_json::json!({
            "adjustment_id": entity_id,
            "payment_id": payment_id,
            "order_id": data.get("orderId").or_else(|| data.get("order_id")).and_then(Value::as_str),
            "adjustment_type": data.get("adjustmentType").or_else(|| data.get("adjustment_type")).and_then(Value::as_str),
            "amount": data.get("amount").and_then(Value::as_f64),
            "reason": data.get("reason").and_then(Value::as_str),
            "staff_id": data.get("staffId").or_else(|| data.get("staff_id")).and_then(Value::as_str),
            "terminal_id": terminal_id,
            "branch_id": branch_id,
            "idempotency_key": idem_key,
        });

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
                    let new_retry = retry_count + 1;
                    let (queue_status, zr_state) = if new_retry >= *max_retries {
                        ("failed", "failed")
                    } else {
                        ("pending", "pending")
                    };
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = ?1, retry_count = ?2, last_error = ?3, updated_at = datetime('now') WHERE id = ?4",
                        params![queue_status, new_retry, e, id],
                    );
                    let _ = conn.execute(
                        "UPDATE z_reports SET sync_state = ?1, sync_retry_count = ?2, sync_last_error = ?3, updated_at = datetime('now') WHERE id = ?4",
                        params![zr_state, new_retry, e, entity_id],
                    );
                }
            }
        }
    }

    synced
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

        let new_count = retry_count + 1;
        let exhausted = new_count >= *max_retries;
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
    ) = match db.conn.lock() {
        Ok(conn) => {
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
                    "SELECT COUNT(*) FROM sync_queue WHERE status = 'failed'",
                    [],
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
            (p, q, e, ip, b, oldest, financial)
        }
        Err(_) => (0, 0, 0, 0, 0, None, FinancialSyncStats::default()),
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
/// parent `order_payments` has `sync_state = 'applied'`, and transitions
/// them to `sync_state = 'pending'`.
fn reconcile_deferred_adjustments(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT pa.id, pa.payment_id
             FROM payment_adjustments pa
             JOIN order_payments op ON op.id = pa.payment_id
             WHERE pa.sync_state = 'waiting_parent'
               AND op.sync_state = 'applied'",
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

    for (adj_id, payment_id) in &rows {
        let _ = conn.execute(
            "UPDATE payment_adjustments SET sync_state = 'pending', updated_at = ?1
             WHERE id = ?2 AND sync_state = 'waiting_parent'",
            params![now, adj_id],
        );

        let _ = conn.execute(
            "UPDATE sync_queue SET status = 'pending', updated_at = datetime('now')
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

        assert!(is_backpressure_error(backpressure));
        assert!(should_use_direct_order_fallback(backpressure));

        assert!(is_permanent_order_sync_error(permanent));
        assert!(!is_transient_order_sync_error(permanent));

        assert!(!is_permanent_order_sync_error(transient));
        assert!(is_transient_order_sync_error(transient));
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
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-adj', 'ord-adj', 'cash', 50.0, 'synced', 'applied', datetime('now'), datetime('now'))",
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
}
