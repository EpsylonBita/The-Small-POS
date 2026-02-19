//! Void and refund management for The Small POS.
//!
//! Implements offline-first payment adjustments (voids and partial refunds).
//! Adjustments are stored in `payment_adjustments` and enqueued for sync to
//! the admin dashboard via `/api/pos/payments/adjustments/sync`.
//!
//! **Rules:**
//! - Cannot refund more than the remaining balance (paid − prior refunds)
//! - Void only if payment status is still `completed`
//! - Works fully offline; syncs when connectivity returns

use chrono::Utc;
use rusqlite::params;
use serde_json::Value;
use tracing::{info, warn};
use uuid::Uuid;

use crate::db::DbState;
use crate::storage;

// ---------------------------------------------------------------------------
// Refund payment
// ---------------------------------------------------------------------------

/// Record a partial (or full) refund against a payment.
///
/// Inserts a `payment_adjustments` row with `adjustment_type = 'refund'`,
/// validates the refund does not exceed the remaining balance, and enqueues
/// a sync entry.  If the total refunds equal the original payment amount,
/// the payment status is set to `'refunded'`.
pub fn refund_payment(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let payment_id = str_field(payload, "paymentId")
        .or_else(|| str_field(payload, "payment_id"))
        .ok_or("Missing paymentId")?;
    let amount = num_field(payload, "amount").ok_or("Missing amount")?;
    if amount <= 0.0 {
        return Err("Refund amount must be positive".into());
    }
    let reason = str_field(payload, "reason").ok_or("Missing reason")?;
    let staff_id = str_field(payload, "staffId").or_else(|| str_field(payload, "staff_id"));

    // Fetch the payment — must be completed (not voided/refunded)
    let (order_id, original_amount, pay_status): (String, f64, String) = conn
        .query_row(
            "SELECT order_id, amount, status FROM order_payments WHERE id = ?1",
            params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| format!("Payment not found: {payment_id}"))?;

    if pay_status == "voided" {
        return Err("Cannot refund a voided payment".into());
    }

    // Sum prior refunds for this payment
    let prior_refunds: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0.0) FROM payment_adjustments
             WHERE payment_id = ?1 AND adjustment_type = 'refund'",
            params![payment_id],
            |row| row.get(0),
        )
        .unwrap_or(0.0);

    let remaining = original_amount - prior_refunds;
    if amount > remaining + 0.001 {
        // 0.001 tolerance for floating point
        return Err(format!(
            "Refund amount {amount:.2} exceeds remaining balance {remaining:.2}"
        ));
    }

    // Determine sync_state based on whether the parent payment has synced
    let pay_sync_state: String = conn
        .query_row(
            "SELECT sync_state FROM order_payments WHERE id = ?1",
            params![payment_id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "pending".to_string());

    let initial_sync_state = if pay_sync_state == "applied" {
        "pending"
    } else {
        "waiting_parent"
    };

    let adjustment_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let new_total_refunds = prior_refunds + amount;
    let is_fully_refunded = (new_total_refunds - original_amount).abs() < 0.01;

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        // Insert adjustment
        conn.execute(
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount,
                reason, staff_id, sync_state, created_at, updated_at
            ) VALUES (?1, ?2, ?3, 'refund', ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                adjustment_id,
                payment_id,
                order_id,
                amount,
                reason,
                staff_id,
                initial_sync_state,
                now,
            ],
        )
        .map_err(|e| format!("insert adjustment: {e}"))?;

        // If fully refunded, update payment status
        if is_fully_refunded {
            conn.execute(
                "UPDATE order_payments SET status = 'refunded', updated_at = ?1 WHERE id = ?2",
                params![now, payment_id],
            )
            .map_err(|e| format!("update payment status: {e}"))?;
        }

        // Update cash drawer total_refunds.
        // Resolve shift_id from the order's staff_shift_id.
        let shift_id: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM orders WHERE id = ?1",
                params![order_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        if let Some(ref sid) = shift_id {
            conn.execute(
                "UPDATE cash_drawer_sessions SET
                    total_refunds = COALESCE(total_refunds, 0) + ?1,
                    updated_at = ?2
                 WHERE staff_shift_id = ?3",
                params![amount, now, sid],
            )
            .map_err(|e| format!("update drawer refunds: {e}"))?;
        }

        // Enqueue for sync
        let idempotency_key = format!("adjustment:{adjustment_id}");
        let terminal_id = storage::get_credential("terminal_id").unwrap_or_default();
        let branch_id = storage::get_credential("branch_id").unwrap_or_default();
        let sync_payload = serde_json::json!({
            "adjustmentId": adjustment_id,
            "paymentId": payment_id,
            "orderId": order_id,
            "adjustmentType": "refund",
            "amount": amount,
            "reason": reason,
            "staffId": staff_id,
            "terminalId": terminal_id,
            "branchId": branch_id,
        })
        .to_string();

        let queue_status = if initial_sync_state == "waiting_parent" {
            "deferred"
        } else {
            "pending"
        };
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment_adjustment', ?1, 'insert', ?2, ?3, ?4)",
            params![adjustment_id, sync_payload, idempotency_key, queue_status],
        )
        .map_err(|e| format!("enqueue adjustment sync: {e}"))?;

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

    info!(
        adjustment_id = %adjustment_id,
        payment_id = %payment_id,
        amount = %amount,
        "Refund recorded"
    );

    Ok(serde_json::json!({
        "success": true,
        "adjustmentId": adjustment_id,
        "paymentId": payment_id,
        "amount": amount,
        "remainingBalance": original_amount - new_total_refunds,
        "fullyRefunded": is_fully_refunded,
        "message": format!("Refund of {amount:.2} recorded"),
    }))
}

// ---------------------------------------------------------------------------
// Void payment (with adjustment audit trail)
// ---------------------------------------------------------------------------

/// Void a payment, recording the adjustment in `payment_adjustments`.
///
/// This extends the existing `payments::void_payment` flow by also writing
/// an adjustment record for the full amount, providing a unified audit trail
/// for both voids and refunds.
pub fn void_payment_with_adjustment(
    db: &DbState,
    payment_id: &str,
    reason: &str,
    staff_id: Option<&str>,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Verify payment exists and is completed
    let (order_id, amount, pay_method): (String, f64, String) = conn
        .query_row(
            "SELECT order_id, amount, method FROM order_payments WHERE id = ?1 AND status = 'completed'",
            params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| format!("No completed payment found with id {payment_id}"))?;

    let now = Utc::now().to_rfc3339();
    let adjustment_id = Uuid::new_v4().to_string();

    // Determine sync_state for the adjustment
    let pay_sync_state: String = conn
        .query_row(
            "SELECT sync_state FROM order_payments WHERE id = ?1",
            params![payment_id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "pending".to_string());

    let initial_sync_state = if pay_sync_state == "applied" {
        "pending"
    } else {
        "waiting_parent"
    };

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        // Mark payment as voided
        conn.execute(
            "UPDATE order_payments SET
                status = 'voided', voided_at = ?1, voided_by = ?2,
                void_reason = ?3, sync_status = 'pending', updated_at = ?1
             WHERE id = ?4",
            params![now, staff_id, reason, payment_id],
        )
        .map_err(|e| format!("void payment: {e}"))?;

        // Revert order payment status
        conn.execute(
            "UPDATE orders SET payment_status = 'pending', updated_at = ?1 WHERE id = ?2",
            params![now, order_id],
        )
        .map_err(|e| format!("revert order payment: {e}"))?;

        // Insert adjustment audit record
        conn.execute(
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount,
                reason, staff_id, sync_state, created_at, updated_at
            ) VALUES (?1, ?2, ?3, 'void', ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                adjustment_id,
                payment_id,
                order_id,
                amount,
                reason,
                staff_id,
                initial_sync_state,
                now,
            ],
        )
        .map_err(|e| format!("insert void adjustment: {e}"))?;

        // Reverse the original payment's drawer entry.
        // Voids reverse the sale (not add to refunds).
        let void_shift_id: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM orders WHERE id = ?1",
                params![order_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        if let Some(ref sid) = void_shift_id {
            if pay_method == "cash" {
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                        total_cash_sales = COALESCE(total_cash_sales, 0) - ?1,
                        updated_at = ?2
                     WHERE staff_shift_id = ?3",
                    params![amount, now, sid],
                )
                .map_err(|e| format!("reverse drawer cash_sales: {e}"))?;
            } else if pay_method == "card" {
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                        total_card_sales = COALESCE(total_card_sales, 0) - ?1,
                        updated_at = ?2
                     WHERE staff_shift_id = ?3",
                    params![amount, now, sid],
                )
                .map_err(|e| format!("reverse drawer card_sales: {e}"))?;
            }
        }

        // Enqueue void sync for the payment (existing flow)
        let void_idem_key = format!("payment:void:{payment_id}");
        let void_payload = serde_json::json!({
            "paymentId": payment_id,
            "orderId": order_id,
            "voidReason": reason,
            "voidedBy": staff_id,
        })
        .to_string();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('payment', ?1, 'void', ?2, ?3)",
            params![payment_id, void_payload, void_idem_key],
        )
        .map_err(|e| format!("enqueue void sync: {e}"))?;

        // Enqueue adjustment sync
        let adj_idem_key = format!("adjustment:{adjustment_id}");
        let terminal_id = storage::get_credential("terminal_id").unwrap_or_default();
        let branch_id = storage::get_credential("branch_id").unwrap_or_default();
        let adj_payload = serde_json::json!({
            "adjustmentId": adjustment_id,
            "paymentId": payment_id,
            "orderId": order_id,
            "adjustmentType": "void",
            "amount": amount,
            "reason": reason,
            "staffId": staff_id,
            "terminalId": terminal_id,
            "branchId": branch_id,
        })
        .to_string();

        let queue_status = if initial_sync_state == "waiting_parent" {
            "deferred"
        } else {
            "pending"
        };
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('payment_adjustment', ?1, 'insert', ?2, ?3, ?4)",
            params![adjustment_id, adj_payload, adj_idem_key, queue_status],
        )
        .map_err(|e| format!("enqueue adjustment sync: {e}"))?;

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

    info!(
        payment_id = %payment_id,
        adjustment_id = %adjustment_id,
        reason = %reason,
        "Payment voided with adjustment"
    );

    Ok(serde_json::json!({
        "success": true,
        "paymentId": payment_id,
        "adjustmentId": adjustment_id,
        "message": "Payment voided",
    }))
}

// ---------------------------------------------------------------------------
// Query adjustments
// ---------------------------------------------------------------------------

/// List all adjustments (voids and refunds) for an order.
pub fn list_order_adjustments(db: &DbState, order_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, payment_id, order_id, adjustment_type, amount,
                    reason, staff_id, sync_state, sync_last_error,
                    created_at, updated_at
             FROM payment_adjustments
             WHERE order_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![order_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "paymentId": row.get::<_, String>(1)?,
                "orderId": row.get::<_, String>(2)?,
                "adjustmentType": row.get::<_, String>(3)?,
                "amount": row.get::<_, f64>(4)?,
                "reason": row.get::<_, String>(5)?,
                "staffId": row.get::<_, Option<String>>(6)?,
                "syncState": row.get::<_, String>(7)?,
                "syncLastError": row.get::<_, Option<String>>(8)?,
                "createdAt": row.get::<_, String>(9)?,
                "updatedAt": row.get::<_, String>(10)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut adjustments = Vec::new();
    for row in rows {
        match row {
            Ok(a) => adjustments.push(a),
            Err(e) => warn!("skipping malformed adjustment row: {e}"),
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "adjustments": adjustments,
    }))
}

/// Get the effective balance for a payment: original amount minus refunds.
///
/// Voided payments return a balance of 0.
pub fn get_payment_balance(db: &DbState, payment_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let (original_amount, status): (f64, String) = conn
        .query_row(
            "SELECT amount, status FROM order_payments WHERE id = ?1",
            params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| format!("Payment not found: {payment_id}"))?;

    if status == "voided" {
        return Ok(serde_json::json!({
            "success": true,
            "paymentId": payment_id,
            "originalAmount": original_amount,
            "totalRefunds": 0.0,
            "balance": 0.0,
            "status": "voided",
        }));
    }

    let total_refunds: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0.0) FROM payment_adjustments
             WHERE payment_id = ?1 AND adjustment_type = 'refund'",
            params![payment_id],
            |row| row.get(0),
        )
        .unwrap_or(0.0);

    let balance = original_amount - total_refunds;

    Ok(serde_json::json!({
        "success": true,
        "paymentId": payment_id,
        "originalAmount": original_amount,
        "totalRefunds": total_refunds,
        "balance": balance,
        "status": status,
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

    /// Insert a test order + payment and return (order_id, payment_id).
    fn seed_order_and_payment(db: &DbState, order_id: &str, amount: f64) -> String {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, supabase_id, created_at, updated_at)
             VALUES (?1, '[]', ?2, 'completed', 'synced', 'sup-123', datetime('now'), datetime('now'))",
            params![order_id, amount],
        )
        .expect("insert order");

        let pay_id = format!("pay-{order_id}");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES (?1, ?2, 'cash', ?3, 'synced', 'applied', datetime('now'), datetime('now'))",
            params![pay_id, order_id, amount],
        )
        .expect("insert payment");

        pay_id
    }

    #[test]
    fn test_refund_partial() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-r1", 50.0);

        let payload = serde_json::json!({
            "paymentId": pay_id,
            "amount": 15.0,
            "reason": "Item returned",
        });
        let result = refund_payment(&db, &payload).unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["amount"], 15.0);
        assert_eq!(result["remainingBalance"], 35.0);
        assert_eq!(result["fullyRefunded"], false);

        // Payment should still be completed
        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM order_payments WHERE id = ?1",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "completed");

        // sync_queue should have an adjustment entry
        let sq_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'payment_adjustment'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_count, 1);
    }

    #[test]
    fn test_refund_full_marks_refunded() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-r2", 30.0);

        let payload = serde_json::json!({
            "paymentId": pay_id,
            "amount": 30.0,
            "reason": "Full refund",
        });
        let result = refund_payment(&db, &payload).unwrap();
        assert_eq!(result["fullyRefunded"], true);
        assert_eq!(result["remainingBalance"], 0.0);

        // Payment status should be refunded
        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM order_payments WHERE id = ?1",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "refunded");
    }

    #[test]
    fn test_refund_exceeds_balance_rejected() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-r3", 20.0);

        // First refund: 15
        let p1 = serde_json::json!({ "paymentId": pay_id, "amount": 15.0, "reason": "Partial" });
        refund_payment(&db, &p1).unwrap();

        // Second refund: 10 — exceeds remaining 5
        let p2 = serde_json::json!({ "paymentId": pay_id, "amount": 10.0, "reason": "Too much" });
        let err = refund_payment(&db, &p2).unwrap_err();
        assert!(err.contains("exceeds remaining balance"));
    }

    #[test]
    fn test_refund_voided_payment_rejected() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-r4", 25.0);

        // Void the payment first
        void_payment_with_adjustment(&db, &pay_id, "Wrong order", None).unwrap();

        // Try to refund — should fail
        let payload = serde_json::json!({ "paymentId": pay_id, "amount": 10.0, "reason": "test" });
        let err = refund_payment(&db, &payload).unwrap_err();
        assert!(err.contains("voided"));
    }

    #[test]
    fn test_void_creates_adjustment() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-v1", 40.0);

        let result =
            void_payment_with_adjustment(&db, &pay_id, "Customer complaint", Some("staff-1"))
                .unwrap();
        assert_eq!(result["success"], true);
        assert!(result["adjustmentId"].as_str().is_some());

        // Verify adjustment record
        let conn = db.conn.lock().unwrap();
        let adj_type: String = conn
            .query_row(
                "SELECT adjustment_type FROM payment_adjustments WHERE payment_id = ?1",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(adj_type, "void");

        let adj_amount: f64 = conn
            .query_row(
                "SELECT amount FROM payment_adjustments WHERE payment_id = ?1",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(adj_amount, 40.0);

        // Payment should be voided
        let status: String = conn
            .query_row(
                "SELECT status FROM order_payments WHERE id = ?1",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "voided");

        // sync_queue should have both payment void + adjustment entries
        let sq_payment: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'payment' AND operation = 'void'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_payment, 1);

        let sq_adj: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'payment_adjustment'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_adj, 1);
    }

    #[test]
    fn test_list_order_adjustments() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-la", 100.0);

        // Two refunds
        let p1 = serde_json::json!({ "paymentId": pay_id, "amount": 20.0, "reason": "Item 1" });
        refund_payment(&db, &p1).unwrap();
        let p2 = serde_json::json!({ "paymentId": pay_id, "amount": 30.0, "reason": "Item 2" });
        refund_payment(&db, &p2).unwrap();

        let result = list_order_adjustments(&db, "ord-la").unwrap();
        let adjustments = result["adjustments"].as_array().unwrap();
        assert_eq!(adjustments.len(), 2);
        // Most recent first
        assert_eq!(adjustments[0]["amount"], 30.0);
        assert_eq!(adjustments[1]["amount"], 20.0);
    }

    #[test]
    fn test_get_payment_balance() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-gb", 60.0);

        // No refunds yet
        let b1 = get_payment_balance(&db, &pay_id).unwrap();
        assert_eq!(b1["originalAmount"], 60.0);
        assert_eq!(b1["totalRefunds"], 0.0);
        assert_eq!(b1["balance"], 60.0);

        // Refund 25
        let p = serde_json::json!({ "paymentId": pay_id, "amount": 25.0, "reason": "Partial" });
        refund_payment(&db, &p).unwrap();

        let b2 = get_payment_balance(&db, &pay_id).unwrap();
        assert_eq!(b2["originalAmount"], 60.0);
        assert_eq!(b2["totalRefunds"], 25.0);
        assert_eq!(b2["balance"], 35.0);
    }

    #[test]
    fn test_get_payment_balance_voided() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-gbv", 45.0);

        void_payment_with_adjustment(&db, &pay_id, "Cancelled", None).unwrap();

        let b = get_payment_balance(&db, &pay_id).unwrap();
        assert_eq!(b["balance"], 0.0);
        assert_eq!(b["status"], "voided");
    }

    #[test]
    fn test_refund_waiting_parent_sync_state() {
        let db = test_db();

        // Create order + payment where payment hasn't synced yet
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-wp', '[]', 20.0, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-wp', 'ord-wp', 'cash', 20.0, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        drop(conn);

        let payload = serde_json::json!({
            "paymentId": "pay-wp",
            "amount": 5.0,
            "reason": "Partial refund before sync",
        });
        let result = refund_payment(&db, &payload).unwrap();
        assert_eq!(result["success"], true);

        // Adjustment should have sync_state = waiting_parent
        let conn = db.conn.lock().unwrap();
        let sync_state: String = conn
            .query_row(
                "SELECT sync_state FROM payment_adjustments WHERE payment_id = 'pay-wp'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sync_state, "waiting_parent");

        // sync_queue should have deferred status
        let sq_status: String = conn
            .query_row(
                "SELECT status FROM sync_queue WHERE entity_type = 'payment_adjustment'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_status, "deferred");
    }

    #[test]
    fn test_void_reverses_drawer_totals() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Create shift + drawer + order
        conn.execute(
            "INSERT INTO staff_shifts (id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at)
             VALUES ('shift-vr', 'staff-vr', 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id, opening_amount, total_cash_sales, opened_at, created_at, updated_at)
             VALUES ('cd-vr', 'shift-vr', 'staff-vr', 'b1', 't1', 100.0, 40.0, datetime('now'), datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, staff_shift_id, supabase_id, created_at, updated_at)
             VALUES ('ord-vr', '[]', 40.0, 'completed', 'synced', 'shift-vr', 'sup-vr', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-vr', 'ord-vr', 'cash', 40.0, 'completed', 'synced', 'applied', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        drop(conn);

        // Void the payment
        void_payment_with_adjustment(&db, "pay-vr", "Wrong order", None).unwrap();

        // Verify drawer cash_sales was reversed
        let conn = db.conn.lock().unwrap();
        let cash_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE staff_shift_id = 'shift-vr'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            cash_sales, 0.0,
            "total_cash_sales should be reversed to 0.0"
        );

        // total_refunds should NOT be affected by a void
        let refunds: f64 = conn
            .query_row(
                "SELECT total_refunds FROM cash_drawer_sessions WHERE staff_shift_id = 'shift-vr'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(refunds, 0.0, "total_refunds should remain 0.0 for voids");
    }

    #[test]
    fn test_refund_updates_drawer_refunds() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Create shift + drawer + order
        conn.execute(
            "INSERT INTO staff_shifts (id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at)
             VALUES ('shift-rdr', 'staff-rdr', 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id, opening_amount, total_cash_sales, opened_at, created_at, updated_at)
             VALUES ('cd-rdr', 'shift-rdr', 'staff-rdr', 'b1', 't1', 100.0, 50.0, datetime('now'), datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, staff_shift_id, supabase_id, created_at, updated_at)
             VALUES ('ord-rdr', '[]', 50.0, 'completed', 'synced', 'shift-rdr', 'sup-rdr', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-rdr', 'ord-rdr', 'cash', 50.0, 'completed', 'synced', 'applied', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        drop(conn);

        // Refund 15.0
        let payload = serde_json::json!({
            "paymentId": "pay-rdr",
            "amount": 15.0,
            "reason": "Item returned",
        });
        refund_payment(&db, &payload).unwrap();

        // Verify drawer total_refunds was updated
        let conn = db.conn.lock().unwrap();
        let refunds: f64 = conn
            .query_row(
                "SELECT total_refunds FROM cash_drawer_sessions WHERE staff_shift_id = 'shift-rdr'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(refunds, 15.0, "total_refunds should be 15.0");

        // total_cash_sales should NOT be affected by a refund
        let cash_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE staff_shift_id = 'shift-rdr'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cash_sales, 50.0, "total_cash_sales should remain 50.0");
    }

    #[test]
    fn test_multiple_refunds_then_void_rejected() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-mrv", 50.0);

        // Refund 20
        let p = serde_json::json!({ "paymentId": pay_id, "amount": 20.0, "reason": "Partial" });
        refund_payment(&db, &p).unwrap();

        // Now void — should fail because payment has refunds and is not purely "completed"
        // Actually, the payment is still "completed" (only "refunded" when fully refunded)
        // So void should work
        let result = void_payment_with_adjustment(&db, &pay_id, "Cancel rest", None).unwrap();
        assert_eq!(result["success"], true);

        // Payment should be voided
        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM order_payments WHERE id = ?1",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "voided");

        // Should have 2 adjustments: 1 refund + 1 void
        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM payment_adjustments WHERE payment_id = ?1",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }
}
