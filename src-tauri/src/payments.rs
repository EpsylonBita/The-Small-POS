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

use crate::db::{self, DbState};

// ---------------------------------------------------------------------------
// Record payment
// ---------------------------------------------------------------------------

/// Record a payment for an order.
///
/// Inserts into `order_payments`, updates the order's `payment_status`
/// and `payment_method`, and enqueues a sync entry.
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
    let staff_id = str_field(payload, "staffId").or_else(|| str_field(payload, "staff_id"));
    let staff_shift_id =
        str_field(payload, "staffShiftId").or_else(|| str_field(payload, "staff_shift_id"));

    // Verify order exists and check if it has a supabase_id (for sync_state)
    let supabase_id: Option<String> = conn
        .query_row(
            "SELECT supabase_id FROM orders WHERE id = ?1",
            params![order_id],
            |row| row.get(0),
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
                staff_id,
                staff_shift_id,
                initial_sync_state,
                now,
            ],
        )
        .map_err(|e| format!("insert payment: {e}"))?;

        // Update order payment status
        conn.execute(
            "UPDATE orders SET
                payment_status = 'paid',
                payment_method = ?1,
                payment_transaction_id = ?2,
                updated_at = ?3
             WHERE id = ?4",
            params![method, payment_id, now, order_id],
        )
        .map_err(|e| format!("update order payment: {e}"))?;

        // Update cash drawer running totals.
        // Resolve the shift_id: use payload value, or fall back to the order's staff_shift_id.
        let resolved_shift_id = staff_shift_id.clone().or_else(|| {
            conn.query_row(
                "SELECT staff_shift_id FROM orders WHERE id = ?1",
                params![order_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
        });
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
            "staffId": staff_id,
            "staffShiftId": staff_shift_id,
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

// ---------------------------------------------------------------------------
// Receipt preview
// ---------------------------------------------------------------------------

/// Build an HTML receipt preview from the order, its payments, and store settings.
pub fn get_receipt_preview(db: &DbState, order_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Fetch order
    let order = conn
        .query_row(
            "SELECT order_number, customer_name, items, total_amount, tax_amount,
                    subtotal, status, order_type, table_number, special_instructions,
                    discount_percentage, discount_amount, tip_amount, delivery_fee,
                    staff_id, created_at, terminal_id
             FROM orders WHERE id = ?1",
            params![order_id],
            |row| {
                Ok(serde_json::json!({
                    "orderNumber": row.get::<_, Option<String>>(0)?,
                    "customerName": row.get::<_, Option<String>>(1)?,
                    "items": row.get::<_, String>(2)?,
                    "totalAmount": row.get::<_, f64>(3)?,
                    "taxAmount": row.get::<_, Option<f64>>(4)?,
                    "subtotal": row.get::<_, Option<f64>>(5)?,
                    "status": row.get::<_, String>(6)?,
                    "orderType": row.get::<_, Option<String>>(7)?,
                    "tableNumber": row.get::<_, Option<String>>(8)?,
                    "specialInstructions": row.get::<_, Option<String>>(9)?,
                    "discountPercentage": row.get::<_, Option<f64>>(10)?,
                    "discountAmount": row.get::<_, Option<f64>>(11)?,
                    "tipAmount": row.get::<_, Option<f64>>(12)?,
                    "deliveryFee": row.get::<_, Option<f64>>(13)?,
                    "staffId": row.get::<_, Option<String>>(14)?,
                    "createdAt": row.get::<_, Option<String>>(15)?,
                    "terminalId": row.get::<_, Option<String>>(16)?,
                }))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("Order not found: {order_id}"),
            _ => format!("query order: {e}"),
        })?;

    // Fetch completed payments
    let mut pay_stmt = conn
        .prepare(
            "SELECT method, amount, cash_received, change_given, created_at
             FROM order_payments
             WHERE order_id = ?1 AND status = 'completed'
             ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    type PaymentRow = (String, f64, Option<f64>, Option<f64>, String);
    let payments: Vec<PaymentRow> = pay_stmt
        .query_map(params![order_id], |row| {
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

    // Fetch adjustments (voids + refunds) for this order
    let mut adj_stmt = conn
        .prepare(
            "SELECT adjustment_type, amount, reason, created_at
             FROM payment_adjustments
             WHERE order_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    type AdjRow = (String, f64, String, String);
    let adjustments: Vec<AdjRow> = adj_stmt
        .query_map(params![order_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // Store name from local_settings
    let store_name =
        db::get_setting(&conn, "terminal", "store_name").unwrap_or_else(|| "The Small".to_string());
    let store_address = db::get_setting(&conn, "terminal", "store_address").unwrap_or_default();
    let store_phone = db::get_setting(&conn, "terminal", "store_phone").unwrap_or_default();

    // Parse items JSON
    let items_str = order["items"].as_str().unwrap_or("[]");
    let items: Vec<Value> = serde_json::from_str(items_str).unwrap_or_default();

    // Build items HTML
    let mut items_html = String::new();
    for item in &items {
        let name = item
            .get("name")
            .or_else(|| item.get("itemName"))
            .and_then(Value::as_str)
            .unwrap_or("Item");
        let qty = item.get("quantity").and_then(Value::as_i64).unwrap_or(1);
        let price = item
            .get("totalPrice")
            .or_else(|| item.get("price"))
            .or_else(|| item.get("unitPrice"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        items_html.push_str(&format!(
            "<div style=\"display:flex;justify-content:space-between;\"><span>{qty}x {name}</span><span>{price:.2}</span></div>\n",
        ));
    }
    if items_html.is_empty() {
        items_html = "<div style=\"text-align:center;color:#888;\">No items</div>".to_string();
    }

    // Extract totals
    let total = order["totalAmount"].as_f64().unwrap_or(0.0);
    let subtotal = order["subtotal"].as_f64().unwrap_or(total);
    let tax = order["taxAmount"].as_f64().unwrap_or(0.0);
    let discount = order["discountAmount"].as_f64().unwrap_or(0.0);
    let delivery_fee = order["deliveryFee"].as_f64().unwrap_or(0.0);
    let tip = order["tipAmount"].as_f64().unwrap_or(0.0);
    let order_number = order["orderNumber"].as_str().unwrap_or("N/A");
    let order_type = order["orderType"].as_str().unwrap_or("dine-in");
    let date = order["createdAt"].as_str().unwrap_or("N/A");
    let terminal_id = order["terminalId"].as_str().unwrap_or("");

    // Build totals rows
    let mut totals_html = String::new();
    totals_html.push_str(&format!(
        "<tr><td>Subtotal</td><td style=\"text-align:right;\">{subtotal:.2}</td></tr>\n"
    ));
    if discount > 0.0 {
        totals_html.push_str(&format!(
            "<tr><td>Discount</td><td style=\"text-align:right;\">-{discount:.2}</td></tr>\n"
        ));
    }
    if tax > 0.0 {
        totals_html.push_str(&format!(
            "<tr><td>Tax</td><td style=\"text-align:right;\">{tax:.2}</td></tr>\n"
        ));
    }
    if delivery_fee > 0.0 {
        totals_html.push_str(&format!(
            "<tr><td>Delivery Fee</td><td style=\"text-align:right;\">{delivery_fee:.2}</td></tr>\n"
        ));
    }
    if tip > 0.0 {
        totals_html.push_str(&format!(
            "<tr><td>Tip</td><td style=\"text-align:right;\">{tip:.2}</td></tr>\n"
        ));
    }
    totals_html.push_str(&format!(
        "<tr><td><strong>TOTAL</strong></td><td style=\"text-align:right;\"><strong>{total:.2}</strong></td></tr>\n"
    ));

    // Build payment lines
    let mut payment_html = String::new();
    for (pm_method, pm_amount, pm_cash, pm_change, _) in &payments {
        let method_label = match pm_method.as_str() {
            "cash" => "Cash",
            "card" => "Card",
            _ => "Other",
        };
        payment_html.push_str(&format!(
            "<div style=\"display:flex;justify-content:space-between;\"><span>{method_label}</span><span>{pm_amount:.2}</span></div>\n"
        ));
        if let Some(received) = pm_cash {
            if *received > 0.0 {
                payment_html.push_str(&format!(
                    "<div style=\"display:flex;justify-content:space-between;color:#666;\"><span>Received</span><span>{received:.2}</span></div>\n"
                ));
            }
        }
        if let Some(change) = pm_change {
            if *change > 0.0 {
                payment_html.push_str(&format!(
                    "<div style=\"display:flex;justify-content:space-between;color:#666;\"><span>Change</span><span>{change:.2}</span></div>\n"
                ));
            }
        }
    }
    if payment_html.is_empty() {
        payment_html =
            "<div style=\"text-align:center;color:#888;\">No payment recorded</div>".to_string();
    }

    // Build adjustment lines (voids + refunds)
    let mut adjustment_html = String::new();
    for (adj_type, adj_amount, adj_reason, _adj_date) in &adjustments {
        let label = match adj_type.as_str() {
            "void" => "VOID",
            "refund" => "REFUND",
            _ => "ADJ",
        };
        adjustment_html.push_str(&format!(
            "<div style=\"display:flex;justify-content:space-between;color:#c00;\"><span>{label}</span><span>-{adj_amount:.2}</span></div>\n"
        ));
        if !adj_reason.is_empty() {
            adjustment_html.push_str(&format!(
                "<div style=\"color:#888;font-size:9px;\">Reason: {adj_reason}</div>\n"
            ));
        }
    }

    // Build header lines
    let address_line = if store_address.is_empty() {
        String::new()
    } else {
        format!("{store_address}<br/>")
    };
    let phone_line = if store_phone.is_empty() {
        String::new()
    } else {
        format!("Tel: {store_phone}<br/>")
    };

    // Build adjustment section (only if there are adjustments)
    let adj_section = if adjustment_html.is_empty() {
        String::new()
    } else {
        format!(
            "<hr style=\"border:none;border-top:1px dashed #000;\"/>\n<div style=\"margin:4px 0;\"><strong>Adjustments</strong></div>\n{adjustment_html}"
        )
    };

    // Assemble receipt
    let html = format!(
        r#"<div style="font-family:monospace;font-size:10px;line-height:1.4;width:100%;">
<div style="text-align:center;margin-bottom:8px;">
<strong style="font-size:14px;">{store_name}</strong><br/>
{address_line}{phone_line}</div>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;">
<strong>Order #{order_number}</strong><br/>
Type: {order_type}<br/>
Date: {date}
</div>
<hr style="border:none;border-top:1px dashed #000;"/>
{items_html}
<hr style="border:none;border-top:1px dashed #000;"/>
<table style="width:100%;font-family:monospace;font-size:10px;">
{totals_html}</table>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;"><strong>Payment</strong></div>
{payment_html}
{adj_section}
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="text-align:center;margin-top:8px;font-size:9px;">
Thank you for your order!<br/>
{terminal_id}
</div>
</div>"#,
    );

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
}
