//! Payment management for The Small POS.
//!
//! Implements offline-first payment recording, voiding, querying, and
//! receipt preview generation. Payments are stored in `order_payments`
//! and enqueued for sync to the admin dashboard via `/api/pos/payments`.

use chrono::Utc;
use rusqlite::params;
use serde_json::Value;
use tracing::{info, warn};
use uuid::Uuid;

use crate::db::DbState;
use crate::{order_ownership, print, printers, receipt_renderer};

// ---------------------------------------------------------------------------
// Record payment
// ---------------------------------------------------------------------------

/// Record a payment for an order.
///
/// Inserts into `order_payments`, updates the order's `payment_status`
/// and `payment_method`, and enqueues a sync entry.
#[allow(clippy::type_complexity)]
pub fn record_payment(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let order_id = str_field(payload, "orderId")
        .or_else(|| str_field(payload, "order_id"))
        .ok_or("Missing orderId")?;
    let method = str_field(payload, "method").ok_or("Missing method")?;
    if method != "cash" && method != "card" && method != "other" {
        return Err(format!(
            "Invalid method: {method}. Must be cash, card, or other"
        ));
    }
    let amount = num_field(payload, "amount").ok_or("Missing amount")?;
    if amount <= 0.0 {
        return Err("Amount must be positive".into());
    }
    let cash_received =
        num_field(payload, "cashReceived").or_else(|| num_field(payload, "cash_received"));
    let change_given = num_field(payload, "changeGiven")
        .or_else(|| num_field(payload, "change_given"))
        .or_else(|| num_field(payload, "change"));
    let transaction_ref = str_field(payload, "transactionRef")
        .or_else(|| str_field(payload, "transaction_ref"))
        .or_else(|| str_field(payload, "transactionId"))
        .or_else(|| str_field(payload, "transaction_id"));
    let requested_staff_id =
        str_field(payload, "staffId").or_else(|| str_field(payload, "staff_id"));
    let requested_staff_shift_id =
        str_field(payload, "staffShiftId").or_else(|| str_field(payload, "staff_shift_id"));

    // Verify order exists and load ownership context
    let (
        supabase_id,
        order_type,
        branch_id,
        terminal_id,
        driver_id,
        order_staff_shift_id,
        order_staff_id,
    ): (
        Option<String>,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT
                supabase_id,
                COALESCE(order_type, 'dine-in'),
                COALESCE(branch_id, ''),
                COALESCE(terminal_id, ''),
                driver_id,
                staff_shift_id,
                staff_id
             FROM orders
             WHERE id = ?1",
            params![order_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(|_| format!("Order not found: {order_id}"))?;

    // If the order hasn't synced yet (no supabase_id), the payment starts
    // in waiting_parent; the reconciliation loop will promote it to pending
    // once the order syncs.
    let initial_sync_state = if supabase_id.as_deref().unwrap_or("").is_empty() {
        "waiting_parent"
    } else {
        "pending"
    };

    let payment_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        let keep_delivery_unassigned = order_type.eq_ignore_ascii_case("delivery")
            && driver_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none();

        let (resolved_shift_id, resolved_staff_id) = if keep_delivery_unassigned {
            (None, None)
        } else {
            order_ownership::resolve_order_owner(
                &conn,
                &order_type,
                &branch_id,
                &terminal_id,
                driver_id.as_deref(),
                requested_staff_shift_id
                    .as_deref()
                    .or(order_staff_shift_id.as_deref()),
                requested_staff_id.as_deref().or(order_staff_id.as_deref()),
            )?
        };

        if resolved_shift_id != order_staff_shift_id || resolved_staff_id != order_staff_id {
            conn.execute(
                "UPDATE orders
                 SET staff_shift_id = ?1,
                     staff_id = ?2,
                     sync_status = 'pending',
                     updated_at = ?3
                 WHERE id = ?4",
                params![resolved_shift_id, resolved_staff_id, now, order_id],
            )
            .map_err(|e| format!("update order ownership for payment: {e}"))?;
        }

        // Insert payment with sync_state
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, currency, status,
                cash_received, change_given, transaction_ref,
                staff_id, staff_shift_id, sync_status,
                sync_state, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, 'EUR', 'completed', ?5, ?6, ?7, ?8, ?9, 'pending',
                      ?10, ?11, ?11)",
            params![
                payment_id,
                order_id,
                method,
                amount,
                cash_received,
                change_given,
                transaction_ref,
                resolved_staff_id,
                resolved_shift_id,
                initial_sync_state,
                now,
            ],
        )
        .map_err(|e| format!("insert payment: {e}"))?;

        // Insert payment items if provided (split-by-items mode)
        if let Some(items_array) = payload.get("items").and_then(Value::as_array) {
            for item_val in items_array {
                let item_id = Uuid::new_v4().to_string();
                let item_index = item_val
                    .get("itemIndex")
                    .or_else(|| item_val.get("item_index"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0) as i32;
                let item_name = item_val
                    .get("itemName")
                    .or_else(|| item_val.get("item_name"))
                    .or_else(|| item_val.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("Item");
                let item_quantity = item_val
                    .get("itemQuantity")
                    .or_else(|| item_val.get("item_quantity"))
                    .or_else(|| item_val.get("quantity"))
                    .and_then(Value::as_i64)
                    .unwrap_or(1) as i32;
                let item_amount = item_val
                    .get("itemAmount")
                    .or_else(|| item_val.get("item_amount"))
                    .or_else(|| item_val.get("amount"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);

                conn.execute(
                    "INSERT INTO payment_items (id, payment_id, order_id, item_index, item_name, item_quantity, item_amount)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![item_id, payment_id, order_id, item_index, item_name, item_quantity, item_amount],
                )
                .map_err(|e| format!("insert payment item: {e}"))?;
            }
        }

        // Compute payment status based on total paid vs order total
        let total_paid: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(amount), 0) FROM order_payments
                 WHERE order_id = ?1 AND status = 'completed'",
                params![order_id],
                |row| row.get(0),
            )
            .unwrap_or(0.0);

        let order_total: f64 = conn
            .query_row(
                "SELECT COALESCE(total_amount, 0) FROM orders WHERE id = ?1",
                params![order_id],
                |row| row.get(0),
            )
            .unwrap_or(0.0);

        let completed_payment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM order_payments WHERE order_id = ?1 AND status = 'completed'",
                params![order_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let new_payment_status = if total_paid >= order_total - 0.01 {
            "paid"
        } else {
            "partially_paid"
        };

        let effective_method = if completed_payment_count > 1 {
            "split"
        } else {
            &method
        };

        conn.execute(
            "UPDATE orders SET
                payment_status = ?1,
                payment_method = ?2,
                payment_transaction_id = ?3,
                updated_at = ?4
             WHERE id = ?5",
            params![new_payment_status, effective_method, payment_id, now, order_id],
        )
        .map_err(|e| format!("update order payment: {e}"))?;

        // Update cash drawer running totals.
        if let Some(ref sid) = resolved_shift_id {
            if method == "cash" {
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                        total_cash_sales = COALESCE(total_cash_sales, 0) + ?1,
                        updated_at = ?2
                     WHERE staff_shift_id = ?3",
                    params![amount, now, sid],
                )
                .map_err(|e| format!("update drawer cash_sales: {e}"))?;
            } else if method == "card" {
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                        total_card_sales = COALESCE(total_card_sales, 0) + ?1,
                        updated_at = ?2
                     WHERE staff_shift_id = ?3",
                    params![amount, now, sid],
                )
                .map_err(|e| format!("update drawer card_sales: {e}"))?;
            }
            // No-op for "other" method, and no-op if no drawer session exists (driver shifts)
        }

        // Enqueue for sync — stable idempotency key based on payment_id
        // so retries reuse the same key and the server deduplicates.
        let idempotency_key = format!("payment:{payment_id}");
        let sync_payload = serde_json::json!({
            "paymentId": payment_id,
            "orderId": order_id,
            "method": method,
            "amount": amount,
            "cashReceived": cash_received,
            "changeGiven": change_given,
            "transactionRef": transaction_ref,
            "staffId": resolved_staff_id,
            "staffShiftId": resolved_shift_id,
            "items": payload.get("items"),
        })
        .to_string();

        // If waiting_parent, enqueue as deferred so the sync loop won't
        // pick it up until the reconciliation promotes it.
        let queue_status = if initial_sync_state == "waiting_parent" {
            "deferred"
        } else {
            "pending"
        };
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment', ?1, 'insert', ?2, ?3, ?4)",
            params![payment_id, sync_payload, idempotency_key, queue_status],
        )
        .map_err(|e| format!("enqueue payment sync: {e}"))?;

        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }

    info!(payment_id = %payment_id, order_id = %order_id, method = %method, amount = %amount, "Payment recorded");

    Ok(serde_json::json!({
        "success": true,
        "paymentId": payment_id,
        "message": format!("Payment of {:.2} recorded", amount),
    }))
}

// ---------------------------------------------------------------------------
// Void payment
// ---------------------------------------------------------------------------

/// Void a previously-recorded payment.
///
/// Delegates to `refunds::void_payment_with_adjustment` which marks the
/// payment as voided, reverts the order status, and creates a
/// `payment_adjustments` audit record in a single transaction.
pub fn void_payment(
    db: &DbState,
    payment_id: &str,
    reason: &str,
    voided_by: Option<&str>,
) -> Result<Value, String> {
    crate::refunds::void_payment_with_adjustment(db, payment_id, reason, voided_by)
}

// ---------------------------------------------------------------------------
// Query payments
// ---------------------------------------------------------------------------

/// Get all payments for an order.
pub fn get_order_payments(db: &DbState, order_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, order_id, method, amount, currency, status,
                    cash_received, change_given, transaction_ref,
                    staff_id, staff_shift_id, voided_at, voided_by,
                    void_reason, sync_status, created_at, updated_at
             FROM order_payments
             WHERE order_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![order_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "orderId": row.get::<_, String>(1)?,
                "method": row.get::<_, String>(2)?,
                "amount": row.get::<_, f64>(3)?,
                "currency": row.get::<_, String>(4)?,
                "status": row.get::<_, String>(5)?,
                "cashReceived": row.get::<_, Option<f64>>(6)?,
                "changeGiven": row.get::<_, Option<f64>>(7)?,
                "transactionRef": row.get::<_, Option<String>>(8)?,
                "staffId": row.get::<_, Option<String>>(9)?,
                "staffShiftId": row.get::<_, Option<String>>(10)?,
                "voidedAt": row.get::<_, Option<String>>(11)?,
                "voidedBy": row.get::<_, Option<String>>(12)?,
                "voidReason": row.get::<_, Option<String>>(13)?,
                "syncStatus": row.get::<_, String>(14)?,
                "createdAt": row.get::<_, String>(15)?,
                "updatedAt": row.get::<_, String>(16)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut payments = Vec::new();
    for row in rows {
        match row {
            Ok(p) => payments.push(p),
            Err(e) => warn!("skipping malformed payment row: {e}"),
        }
    }

    Ok(serde_json::json!(payments))
}

/// Get items already paid for in an order (used by split-by-items UI).
pub fn get_paid_items(db: &DbState, order_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT pi.id, pi.payment_id, pi.order_id, pi.item_index,
                    pi.item_name, pi.item_quantity, pi.item_amount, pi.created_at,
                    op.method AS payment_method, op.status AS payment_status
             FROM payment_items pi
             JOIN order_payments op ON op.id = pi.payment_id
             WHERE pi.order_id = ?1 AND op.status = 'completed'
             ORDER BY pi.item_index ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![order_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "paymentId": row.get::<_, String>(1)?,
                "orderId": row.get::<_, String>(2)?,
                "itemIndex": row.get::<_, i32>(3)?,
                "itemName": row.get::<_, String>(4)?,
                "itemQuantity": row.get::<_, i32>(5)?,
                "itemAmount": row.get::<_, f64>(6)?,
                "createdAt": row.get::<_, String>(7)?,
                "paymentMethod": row.get::<_, String>(8)?,
                "paymentStatus": row.get::<_, String>(9)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for row in rows {
        match row {
            Ok(item) => items.push(item),
            Err(e) => warn!("skipping malformed payment_item row: {e}"),
        }
    }

    Ok(serde_json::json!(items))
}

// ---------------------------------------------------------------------------
// Receipt preview
// ---------------------------------------------------------------------------

/// Build an HTML receipt preview from the order using the same renderer as the print pipeline.
///
/// This ensures the in-app preview matches the physical printed receipt exactly.
pub fn get_receipt_preview(db: &DbState, order_id: &str) -> Result<Value, String> {
    // Build the same document used by the print pipeline
    let doc = receipt_renderer::ReceiptDocument::OrderReceipt(print::build_order_receipt_doc(
        db, order_id,
    )?);

    // Resolve layout config (template, store info, currency, etc.)
    let profile = printers::resolve_printer_profile_for_role(db, None, Some("receipt"))?
        .unwrap_or_else(|| serde_json::json!({}));
    let layout = print::resolve_layout_config(db, &profile, "order_receipt")?;

    // Render using the canonical receipt renderer
    let html = receipt_renderer::render_html(&doc, &layout);

    Ok(serde_json::json!({
        "success": true,
        "html": html,
    }))
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

#[allow(dead_code)]
fn escape_html(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#x27;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

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

    #[test]
    fn test_record_payment_and_query() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Insert an order
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-1', '[{\"name\":\"Pizza\",\"quantity\":2,\"totalPrice\":20.0}]', 25.0, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert order");
        drop(conn);

        // Record payment
        let payload = serde_json::json!({
            "orderId": "ord-1",
            "method": "cash",
            "amount": 25.0,
            "cashReceived": 30.0,
            "changeGiven": 5.0,
            "transactionRef": "CASH-123",
        });
        let result = record_payment(&db, &payload).expect("record_payment");
        assert_eq!(result["success"], true);
        let payment_id = result["paymentId"].as_str().unwrap();

        // Verify order updated
        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT payment_status FROM orders WHERE id = 'ord-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "paid");

        // Verify sync_queue entry
        let sq_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'payment'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_count, 1);
        drop(conn);

        // Query payments
        let payments = get_order_payments(&db, "ord-1").expect("get_order_payments");
        let arr = payments.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["method"], "cash");
        assert_eq!(arr[0]["amount"], 25.0);
        assert_eq!(arr[0]["cashReceived"], 30.0);
        assert_eq!(arr[0]["changeGiven"], 5.0);
        assert_eq!(arr[0]["id"], payment_id);
    }

    #[test]
    fn test_void_payment() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-2', '[]', 10.0, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        drop(conn);

        let payload = serde_json::json!({
            "orderId": "ord-2",
            "method": "card",
            "amount": 10.0,
        });
        let result = record_payment(&db, &payload).unwrap();
        let payment_id = result["paymentId"].as_str().unwrap().to_string();

        // Void it
        let void_result =
            void_payment(&db, &payment_id, "Customer changed mind", Some("staff-1")).unwrap();
        assert_eq!(void_result["success"], true);

        // Check order reverted
        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT payment_status FROM orders WHERE id = 'ord-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");

        // Check payment is voided
        let pay_status: String = conn
            .query_row(
                "SELECT status FROM order_payments WHERE id = ?1",
                params![payment_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pay_status, "voided");

        // Check 2 sync entries (insert + void)
        let sq_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'payment'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_count, 2);
    }

    #[test]
    fn test_record_payment_updates_drawer_cash_sales() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Create shift + drawer + order
        conn.execute(
            "INSERT INTO staff_shifts (id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at)
             VALUES ('shift-cs', 'staff-1', 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id, opening_amount, opened_at, created_at, updated_at)
             VALUES ('cd-1', 'shift-cs', 'staff-1', 'b1', 't1', 100.0, datetime('now'), datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, staff_shift_id, created_at, updated_at)
             VALUES ('ord-cs1', '[]', 25.0, 'pending', 'pending', 'shift-cs', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        drop(conn);

        // Record cash payment
        let payload = serde_json::json!({
            "orderId": "ord-cs1",
            "method": "cash",
            "amount": 25.0,
            "staffShiftId": "shift-cs",
        });
        record_payment(&db, &payload).unwrap();

        // Verify drawer updated
        let conn = db.conn.lock().unwrap();
        let cash_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE staff_shift_id = 'shift-cs'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cash_sales, 25.0, "total_cash_sales should be 25.0");

        let card_sales: f64 = conn
            .query_row(
                "SELECT total_card_sales FROM cash_drawer_sessions WHERE staff_shift_id = 'shift-cs'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(card_sales, 0.0, "total_card_sales should remain 0.0");
    }

    #[test]
    fn test_record_payment_updates_drawer_card_sales() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Create shift + drawer + order
        conn.execute(
            "INSERT INTO staff_shifts (id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at)
             VALUES ('shift-cd', 'staff-2', 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id, opening_amount, opened_at, created_at, updated_at)
             VALUES ('cd-2', 'shift-cd', 'staff-2', 'b1', 't1', 100.0, datetime('now'), datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, staff_shift_id, created_at, updated_at)
             VALUES ('ord-cd1', '[]', 30.0, 'pending', 'pending', 'shift-cd', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        drop(conn);

        // Record card payment
        let payload = serde_json::json!({
            "orderId": "ord-cd1",
            "method": "card",
            "amount": 30.0,
            "staffShiftId": "shift-cd",
        });
        record_payment(&db, &payload).unwrap();

        // Verify drawer updated
        let conn = db.conn.lock().unwrap();
        let card_sales: f64 = conn
            .query_row(
                "SELECT total_card_sales FROM cash_drawer_sessions WHERE staff_shift_id = 'shift-cd'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(card_sales, 30.0, "total_card_sales should be 30.0");

        let cash_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE staff_shift_id = 'shift-cd'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cash_sales, 0.0, "total_cash_sales should remain 0.0");
    }

    #[test]
    fn test_receipt_preview() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (id, order_number, items, total_amount, subtotal, tax_amount, status, order_type, sync_status, created_at, updated_at)
             VALUES ('ord-3', 'ORD-001', '[{\"name\":\"Burger\",\"quantity\":1,\"totalPrice\":8.50},{\"name\":\"Fries\",\"quantity\":2,\"totalPrice\":6.00}]', 14.50, 14.50, 0.0, 'completed', 'dine-in', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, cash_received, change_given, sync_status, created_at, updated_at)
             VALUES ('pay-3', 'ord-3', 'cash', 14.50, 20.0, 5.50, 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        drop(conn);

        let result = get_receipt_preview(&db, "ord-3").expect("get_receipt_preview");
        assert_eq!(result["success"], true);
        let html = result["html"].as_str().unwrap();
        assert!(html.contains("ORD-001"));
        assert!(html.contains("Burger"));
        assert!(html.contains("Fries"));
        assert!(html.contains("14.50"));
        assert!(html.contains("Cash"));
        assert!(html.contains("20.00")); // received
        assert!(html.contains("5.50")); // change
    }

    #[test]
    fn test_receipt_preview_escapes_html_content() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (id, order_number, customer_name, items, total_amount, subtotal, tax_amount, status, order_type, sync_status, created_at, updated_at)
             VALUES ('ord-4', '<script>alert(1)</script>', '<img src=x onerror=alert(2)>', '[{\"name\":\"<b>Burger</b>\",\"quantity\":1,\"totalPrice\":8.50}]', 8.50, 8.50, 0.0, 'completed', 'dine-in', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        drop(conn);

        let result = get_receipt_preview(&db, "ord-4").expect("get_receipt_preview");
        let html = result["html"].as_str().unwrap();
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(html.contains("&lt;b&gt;Burger&lt;/b&gt;"));
        assert!(!html.contains("<script>alert(1)</script>"));
        assert!(!html.contains("<b>Burger</b>"));
    }

    #[test]
    fn test_record_pickup_payment_reassigns_to_active_cashier_from_driver_shift_context() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-shift', 'cashier-1', 'Cashier', 'branch-1', 'terminal-1', 'cashier',
                datetime('now'), 100.0, 'active', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-1', 'cash-shift', 'cashier-1', 'branch-1', 'terminal-1',
                100.0, datetime('now'), datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'driver-shift', 'driver-1', 'Driver', 'branch-1', 'terminal-1', 'driver',
                datetime('now'), 20.0, 'active', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, status, order_type, sync_status,
                branch_id, terminal_id, staff_shift_id, staff_id, driver_id,
                created_at, updated_at
            ) VALUES (
                'pickup-order', '[]', 18.0, 'pending', 'pickup', 'pending',
                '', '', 'driver-shift', 'driver-1', 'driver-1',
                datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        drop(conn);

        record_payment(
            &db,
            &serde_json::json!({
                "orderId": "pickup-order",
                "method": "cash",
                "amount": 18.0,
                "staffShiftId": "driver-shift",
                "staffId": "driver-1",
            }),
        )
        .unwrap();

        let conn = db.conn.lock().unwrap();
        let order_shift_id: String = conn
            .query_row(
                "SELECT staff_shift_id FROM orders WHERE id = 'pickup-order'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payment_shift_id: String = conn
            .query_row(
                "SELECT staff_shift_id FROM order_payments WHERE order_id = 'pickup-order'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let cashier_cash_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE staff_shift_id = 'cash-shift'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(order_shift_id, "cash-shift");
        assert_eq!(payment_shift_id, "cash-shift");
        assert_eq!(cashier_cash_sales, 18.0);
    }

    #[test]
    fn test_record_delivery_payment_stays_with_driver_shift() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-shift-2', 'cashier-2', 'Cashier', 'branch-2', 'terminal-2', 'cashier',
                datetime('now'), 100.0, 'active', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-2', 'cash-shift-2', 'cashier-2', 'branch-2', 'terminal-2',
                100.0, datetime('now'), datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'driver-shift-2', 'driver-2', 'Driver', 'branch-2', 'terminal-2', 'driver',
                datetime('now'), 20.0, 'active', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, status, order_type, sync_status,
                branch_id, terminal_id, staff_shift_id, staff_id, driver_id,
                created_at, updated_at
            ) VALUES (
                'delivery-order', '[]', 24.0, 'pending', 'delivery', 'pending',
                '', '', 'cash-shift-2', 'cashier-2', 'driver-2',
                datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        drop(conn);

        record_payment(
            &db,
            &serde_json::json!({
                "orderId": "delivery-order",
                "method": "cash",
                "amount": 24.0,
                "staffShiftId": "cash-shift-2",
                "staffId": "cashier-2",
            }),
        )
        .unwrap();

        let conn = db.conn.lock().unwrap();
        let order_shift_id: String = conn
            .query_row(
                "SELECT staff_shift_id FROM orders WHERE id = 'delivery-order'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payment_shift_id: String = conn
            .query_row(
                "SELECT staff_shift_id FROM order_payments WHERE order_id = 'delivery-order'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let cashier_cash_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE staff_shift_id = 'cash-shift-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(order_shift_id, "driver-shift-2");
        assert_eq!(payment_shift_id, "driver-shift-2");
        assert_eq!(cashier_cash_sales, 0.0);
    }

    #[test]
    fn test_record_unassigned_delivery_payment_stays_neutral_until_dispatch_choice() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-shift-neutral', 'cashier-neutral', 'Cashier Neutral', 'branch-neutral', 'terminal-neutral', 'cashier',
                datetime('now'), 100.0, 'active', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-neutral', 'cash-shift-neutral', 'cashier-neutral', 'branch-neutral', 'terminal-neutral',
                100.0, datetime('now'), datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, status, order_type, sync_status,
                branch_id, terminal_id, created_at, updated_at
            ) VALUES (
                'delivery-neutral-order', '[]', 19.0, 'pending', 'delivery', 'pending',
                'branch-neutral', 'terminal-neutral', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        drop(conn);

        record_payment(
            &db,
            &serde_json::json!({
                "orderId": "delivery-neutral-order",
                "method": "cash",
                "amount": 19.0,
                "staffShiftId": "cash-shift-neutral",
                "staffId": "cashier-neutral",
            }),
        )
        .unwrap();

        let conn = db.conn.lock().unwrap();
        let (order_shift_id, order_staff_id): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT staff_shift_id, staff_id FROM orders WHERE id = 'delivery-neutral-order'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let (payment_shift_id, payment_staff_id): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT staff_shift_id, staff_id FROM order_payments WHERE order_id = 'delivery-neutral-order'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let cashier_cash_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE staff_shift_id = 'cash-shift-neutral'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(order_shift_id, None);
        assert_eq!(order_staff_id, None);
        assert_eq!(payment_shift_id, None);
        assert_eq!(payment_staff_id, None);
        assert_eq!(cashier_cash_sales, 0.0);
    }
}
