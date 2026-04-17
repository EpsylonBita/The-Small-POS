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
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};
use tracing::{info, warn};
use uuid::Uuid;

use crate::db::DbState;
use crate::storage;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RefundMethod {
    Cash,
    Card,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CashHandler {
    CashierDrawer,
    DriverShift,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AdjustmentContext {
    Manual,
    EditSettlement,
}

impl RefundMethod {
    fn as_str(self) -> &'static str {
        match self {
            RefundMethod::Cash => "cash",
            RefundMethod::Card => "card",
        }
    }
}

impl CashHandler {
    fn as_str(self) -> &'static str {
        match self {
            CashHandler::CashierDrawer => "cashier_drawer",
            CashHandler::DriverShift => "driver_shift",
        }
    }
}

impl AdjustmentContext {
    fn as_str(self) -> &'static str {
        match self {
            AdjustmentContext::Manual => "manual",
            AdjustmentContext::EditSettlement => "edit_settlement",
        }
    }
}

fn normalize_refund_method(value: Option<&str>) -> Option<RefundMethod> {
    match value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("cash") => Some(RefundMethod::Cash),
        Some("card") => Some(RefundMethod::Card),
        _ => None,
    }
}

fn normalize_cash_handler(value: Option<&str>) -> Option<CashHandler> {
    match value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("cashier_drawer") => Some(CashHandler::CashierDrawer),
        Some("driver_shift") => Some(CashHandler::DriverShift),
        _ => None,
    }
}

fn normalize_adjustment_context(value: Option<&str>) -> AdjustmentContext {
    match value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("edit_settlement") => AdjustmentContext::EditSettlement,
        _ => AdjustmentContext::Manual,
    }
}

fn normalize_non_empty_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn normalize_uuid_text(value: Option<&str>) -> Option<String> {
    normalize_non_empty_text(value).and_then(|candidate| {
        if Uuid::parse_str(&candidate).is_ok() {
            Some(candidate)
        } else {
            None
        }
    })
}

fn resolve_staff_id_from_shift(conn: &Connection, staff_shift_id: Option<&str>) -> Option<String> {
    let normalized_shift_id = normalize_uuid_text(staff_shift_id)?;
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
    .and_then(|candidate| normalize_uuid_text(Some(candidate.as_str())))
}

fn resolve_adjustment_staff_context(
    conn: &Connection,
    requested_staff_id: Option<&str>,
    requested_staff_shift_id: Option<&str>,
) -> (Option<String>, Option<String>) {
    let staff_shift_id = normalize_uuid_text(requested_staff_shift_id);
    let staff_id = normalize_uuid_text(requested_staff_id)
        .or_else(|| resolve_staff_id_from_shift(conn, staff_shift_id.as_deref()));
    (staff_id, staff_shift_id)
}

fn load_adjustment_remote_order_id(conn: &Connection, local_order_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT supabase_id FROM orders WHERE id = ?1",
        params![local_order_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
    .and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn build_adjustment_queue_payload(
    adjustment_id: &str,
    payment_id: &str,
    local_order_id: &str,
    remote_order_id: Option<&str>,
    adjustment_type: &str,
    amount: f64,
    reason: &str,
    staff_id: Option<&str>,
    staff_shift_id: Option<&str>,
    terminal_id: &str,
    branch_id: &str,
    refund_method: Option<&str>,
    cash_handler: Option<&str>,
    adjustment_context: Option<&str>,
) -> String {
    let mut payload = Map::new();
    payload.insert(
        "adjustmentId".to_string(),
        Value::String(adjustment_id.to_string()),
    );
    payload.insert(
        "paymentId".to_string(),
        Value::String(payment_id.to_string()),
    );
    payload.insert(
        "orderId".to_string(),
        Value::String(remote_order_id.unwrap_or(local_order_id).trim().to_string()),
    );
    payload.insert(
        "clientOrderId".to_string(),
        Value::String(local_order_id.to_string()),
    );
    payload.insert(
        "adjustmentType".to_string(),
        Value::String(adjustment_type.to_string()),
    );
    payload.insert("amount".to_string(), Value::from(amount));
    payload.insert("reason".to_string(), Value::String(reason.to_string()));
    payload.insert(
        "terminalId".to_string(),
        Value::String(terminal_id.to_string()),
    );
    payload.insert("branchId".to_string(), Value::String(branch_id.to_string()));

    if let Some(staff_id) = staff_id {
        payload.insert("staffId".to_string(), Value::String(staff_id.to_string()));
    }
    if let Some(staff_shift_id) = staff_shift_id {
        payload.insert(
            "staffShiftId".to_string(),
            Value::String(staff_shift_id.to_string()),
        );
    }
    if let Some(refund_method) = refund_method {
        payload.insert(
            "refundMethod".to_string(),
            Value::String(refund_method.to_string()),
        );
    }
    if let Some(cash_handler) = cash_handler {
        payload.insert(
            "cashHandler".to_string(),
            Value::String(cash_handler.to_string()),
        );
    }
    if let Some(adjustment_context) = adjustment_context {
        payload.insert(
            "adjustmentContext".to_string(),
            Value::String(adjustment_context.to_string()),
        );
    }

    Value::Object(payload).to_string()
}

pub(crate) fn refund_payment_in_connection(
    conn: &Connection,
    payload: &Value,
) -> Result<Value, String> {
    let payment_id = str_field(payload, "paymentId")
        .or_else(|| str_field(payload, "payment_id"))
        .ok_or("Missing paymentId")?;
    let amount = num_field(payload, "amount").ok_or("Missing amount")?;
    if amount <= 0.0 {
        return Err("Refund amount must be positive".into());
    }
    let reason = str_field(payload, "reason").ok_or("Missing reason")?;
    let requested_staff_id =
        str_field(payload, "staffId").or_else(|| str_field(payload, "staff_id"));
    let requested_staff_shift_id =
        str_field(payload, "staffShiftId").or_else(|| str_field(payload, "staff_shift_id"));
    let requested_refund_method = normalize_refund_method(
        str_field(payload, "refundMethod")
            .or_else(|| str_field(payload, "refund_method"))
            .as_deref(),
    );
    let requested_cash_handler = normalize_cash_handler(
        str_field(payload, "cashHandler")
            .or_else(|| str_field(payload, "cash_handler"))
            .as_deref(),
    );
    let adjustment_context = normalize_adjustment_context(
        str_field(payload, "adjustmentContext")
            .or_else(|| str_field(payload, "adjustment_context"))
            .as_deref(),
    );

    let (order_id, original_amount, pay_status, payment_method, payment_shift_id): (
        String,
        f64,
        String,
        String,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT order_id, amount, status, method, staff_shift_id
             FROM order_payments
             WHERE id = ?1",
            params![payment_id],
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
        .map_err(|_| format!("Payment not found: {payment_id}"))?;

    if pay_status == "voided" {
        return Err("Cannot refund a voided payment".into());
    }

    let refund_method = requested_refund_method.unwrap_or_else(|| {
        match payment_method.to_ascii_lowercase().as_str() {
            "card" => RefundMethod::Card,
            _ => RefundMethod::Cash,
        }
    });
    let cash_handler = match refund_method {
        RefundMethod::Cash => Some(requested_cash_handler.unwrap_or(CashHandler::CashierDrawer)),
        RefundMethod::Card => None,
    };

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
        return Err(format!(
            "Refund amount {amount:.2} exceeds remaining balance {remaining:.2}"
        ));
    }

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
    let order_shift_id: Option<String> = conn
        .query_row(
            "SELECT staff_shift_id FROM orders WHERE id = ?1",
            params![order_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    let (resolved_staff_id, resolved_staff_shift_id) = resolve_adjustment_staff_context(
        conn,
        requested_staff_id.as_deref(),
        requested_staff_shift_id
            .as_deref()
            .or(payment_shift_id.as_deref())
            .or(order_shift_id.as_deref()),
    );
    let remote_order_id = load_adjustment_remote_order_id(conn, &order_id);

    conn.execute(
        "INSERT INTO payment_adjustments (
            id, payment_id, order_id, adjustment_type, amount,
            reason, staff_id, staff_shift_id, sync_state, refund_method, cash_handler,
            adjustment_context, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'refund', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        params![
            adjustment_id,
            payment_id,
            order_id,
            amount,
            reason,
            resolved_staff_id,
            resolved_staff_shift_id,
            initial_sync_state,
            refund_method.as_str(),
            cash_handler.map(CashHandler::as_str),
            adjustment_context.as_str(),
            now,
        ],
    )
    .map_err(|e| format!("insert adjustment: {e}"))?;

    if is_fully_refunded {
        conn.execute(
            "UPDATE order_payments SET status = 'refunded', updated_at = ?1 WHERE id = ?2",
            params![now, payment_id],
        )
        .map_err(|e| format!("update payment status: {e}"))?;
    }

    match cash_handler {
        Some(CashHandler::CashierDrawer) => {
            let target_shift_id = normalize_non_empty_text(requested_staff_shift_id.as_deref())
                .or(payment_shift_id.clone())
                .or(order_shift_id.clone());
            if let Some(ref sid) = target_shift_id {
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                        total_refunds = COALESCE(total_refunds, 0) + ?1,
                        updated_at = ?2
                     WHERE staff_shift_id = ?3",
                    params![amount, now, sid],
                )
                .map_err(|e| format!("update drawer refunds: {e}"))?;
            }
        }
        Some(CashHandler::DriverShift) => {
            let updated = conn
                .execute(
                    "UPDATE driver_earnings
                     SET cash_collected = CASE
                            WHEN COALESCE(cash_collected, 0) - ?1 < 0 THEN 0
                            ELSE COALESCE(cash_collected, 0) - ?1
                         END,
                         cash_to_return = CASE
                            WHEN COALESCE(cash_to_return, 0) - ?1 < 0 THEN 0
                            ELSE COALESCE(cash_to_return, 0) - ?1
                         END,
                         payment_method = CASE
                            WHEN COALESCE(card_amount, 0) > 0 AND
                                 CASE WHEN COALESCE(cash_collected, 0) - ?1 < 0 THEN 0 ELSE COALESCE(cash_collected, 0) - ?1 END > 0
                                THEN 'mixed'
                            WHEN COALESCE(card_amount, 0) > 0 THEN 'card'
                            ELSE 'cash'
                         END,
                         updated_at = ?2
                     WHERE order_id = ?3
                       AND COALESCE(settled, 0) = 0
                       AND COALESCE(is_transferred, 0) = 0",
                    params![amount, now, order_id],
                )
                .map_err(|e| format!("update driver settlement refund: {e}"))?;
            if updated == 0 {
                return Err(
                    "Driver cash refund requires an active unsettled driver earning".into(),
                );
            }
        }
        None => {
            let _ = conn.execute(
                "UPDATE driver_earnings
                 SET card_amount = CASE
                        WHEN COALESCE(card_amount, 0) - ?1 < 0 THEN 0
                        ELSE COALESCE(card_amount, 0) - ?1
                     END,
                     payment_method = CASE
                        WHEN CASE WHEN COALESCE(card_amount, 0) - ?1 < 0 THEN 0 ELSE COALESCE(card_amount, 0) - ?1 END > 0
                             AND COALESCE(cash_collected, 0) > 0
                            THEN 'mixed'
                        WHEN COALESCE(cash_collected, 0) > 0 THEN 'cash'
                        ELSE 'card'
                     END,
                     updated_at = ?2
                 WHERE order_id = ?3
                   AND COALESCE(settled, 0) = 0
                   AND COALESCE(is_transferred, 0) = 0",
                params![amount, now, order_id],
            );
        }
    }

    let terminal_id = storage::get_credential("terminal_id").unwrap_or_default();
    let branch_id = storage::get_credential("branch_id").unwrap_or_default();
    let sync_payload = build_adjustment_queue_payload(
        &adjustment_id,
        &payment_id,
        &order_id,
        remote_order_id.as_deref(),
        "refund",
        amount,
        &reason,
        resolved_staff_id.as_deref(),
        resolved_staff_shift_id.as_deref(),
        &terminal_id,
        &branch_id,
        Some(refund_method.as_str()),
        cash_handler.map(CashHandler::as_str),
        Some(adjustment_context.as_str()),
    );

    let sync_payload_value = serde_json::from_str::<Value>(&sync_payload)
        .map_err(|e| format!("parse adjustment payload: {e}"))?;
    crate::sync_queue::enqueue_payload_item(
        &conn,
        "payment_adjustments",
        &adjustment_id,
        "INSERT",
        &sync_payload_value,
        Some(1),
        Some("financial"),
        Some("manual"),
        Some(1),
    )
    .map_err(|e| format!("enqueue adjustment parity sync: {e}"))?;

    Ok(serde_json::json!({
        "success": true,
        "adjustmentId": adjustment_id,
        "paymentId": payment_id,
        "amount": amount,
        "remainingBalance": original_amount - new_total_refunds,
        "fullyRefunded": is_fully_refunded,
        "refundMethod": refund_method.as_str(),
        "cashHandler": cash_handler.map(CashHandler::as_str),
        "adjustmentContext": adjustment_context.as_str(),
        "message": format!("Refund of {amount:.2} recorded"),
    }))
}

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

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = refund_payment_in_connection(&conn, payload);

    match result {
        Ok(value) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
            let payment_id = value
                .get("paymentId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let adjustment_id = value
                .get("adjustmentId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let amount = value.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
            info!(
                adjustment_id = %adjustment_id,
                payment_id = %payment_id,
                amount = %amount,
                "Refund recorded"
            );
            Ok(value)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
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
    staff_shift_id: Option<&str>,
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
    let order_shift_id: Option<String> = conn
        .query_row(
            "SELECT staff_shift_id FROM orders WHERE id = ?1",
            params![order_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    let (resolved_staff_id, resolved_staff_shift_id) = resolve_adjustment_staff_context(
        &conn,
        staff_id,
        staff_shift_id.or(order_shift_id.as_deref()),
    );
    let remote_order_id = load_adjustment_remote_order_id(&conn, &order_id);

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
            params![now, resolved_staff_id, reason, payment_id],
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
                reason, staff_id, staff_shift_id, sync_state, created_at, updated_at
            ) VALUES (?1, ?2, ?3, 'void', ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                adjustment_id,
                payment_id,
                order_id,
                amount,
                reason,
                resolved_staff_id,
                resolved_staff_shift_id,
                initial_sync_state,
                now,
            ],
        )
        .map_err(|e| format!("insert void adjustment: {e}"))?;

        // Reverse the original payment's drawer entry.
        // Voids reverse the sale (not add to refunds).
        if let Some(ref sid) = order_shift_id {
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

        // Enqueue adjustment sync
        let terminal_id = storage::get_credential("terminal_id").unwrap_or_default();
        let branch_id = storage::get_credential("branch_id").unwrap_or_default();
        let adj_payload = build_adjustment_queue_payload(
            &adjustment_id,
            payment_id,
            &order_id,
            remote_order_id.as_deref(),
            "void",
            amount,
            reason,
            resolved_staff_id.as_deref(),
            resolved_staff_shift_id.as_deref(),
            &terminal_id,
            &branch_id,
            None,
            None,
            None,
        );

        let adj_payload_value = serde_json::from_str::<Value>(&adj_payload)
            .map_err(|e| format!("parse void adjustment payload: {e}"))?;
        crate::sync_queue::enqueue_payload_item(
            &conn,
            "payment_adjustments",
            &adjustment_id,
            "INSERT",
            &adj_payload_value,
            Some(1),
            Some("financial"),
            Some("manual"),
            Some(1),
        )
        .map_err(|e| format!("enqueue void adjustment parity sync: {e}"))?;

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
                    reason, staff_id, staff_shift_id, sync_state, sync_last_error,
                    refund_method, cash_handler, adjustment_context,
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
                "staffShiftId": row.get::<_, Option<String>>(7)?,
                "syncState": row.get::<_, String>(8)?,
                "syncLastError": row.get::<_, Option<String>>(9)?,
                "refundMethod": row.get::<_, Option<String>>(10)?,
                "cashHandler": row.get::<_, Option<String>>(11)?,
                "adjustmentContext": row.get::<_, Option<String>>(12)?,
                "createdAt": row.get::<_, String>(13)?,
                "updatedAt": row.get::<_, String>(14)?,
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
             VALUES (?1, '[]', ?2, 'completed', 'synced', '11111111-1111-4111-8111-111111111111', datetime('now'), datetime('now'))",
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

        // parity_sync_queue should have an adjustment entry
        let sq_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE table_name = 'payment_adjustments'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_count, 1);
    }

    #[test]
    fn test_refund_adjustment_queue_payload_prefers_remote_order_id_and_keeps_client_order_id() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-r1-queue", 50.0);

        let payload = serde_json::json!({
            "paymentId": pay_id,
            "amount": 5.0,
            "reason": "Queue payload check",
        });
        refund_payment(&db, &payload).unwrap();

        let conn = db.conn.lock().unwrap();
        let payload: String = conn
            .query_row(
                "SELECT data
                 FROM parity_sync_queue
                 WHERE table_name = 'payment_adjustments'
                 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payload_json: Value = serde_json::from_str(&payload).unwrap();

        assert_eq!(
            payload_json.get("orderId").and_then(Value::as_str),
            Some("11111111-1111-4111-8111-111111111111")
        );
        assert_eq!(
            payload_json.get("clientOrderId").and_then(Value::as_str),
            Some("ord-r1-queue")
        );
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
        void_payment_with_adjustment(&db, &pay_id, "Wrong order", None, None).unwrap();

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
            void_payment_with_adjustment(&db, &pay_id, "Customer complaint", Some("staff-1"), None)
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

        // This fixture seeds the payment directly, so the void only adds the
        // adjustment parity row.
        let sq_payment: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE table_name = 'payments'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_payment, 0);

        let sq_adj: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE table_name = 'payment_adjustments'",
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

        void_payment_with_adjustment(&db, &pay_id, "Cancelled", None, None).unwrap();

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

        // parity queue rows still enter as pending; the adjustment itself stays
        // marked waiting_parent until the parent payment syncs.
        let sq_status: String = conn
            .query_row(
                "SELECT status FROM parity_sync_queue WHERE table_name = 'payment_adjustments'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_status, "pending");
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
        void_payment_with_adjustment(&db, "pay-vr", "Wrong order", None, None).unwrap();

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
        let result = void_payment_with_adjustment(&db, &pay_id, "Cancel rest", None, None).unwrap();
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

    #[test]
    fn test_refund_resolves_staff_uuid_from_valid_shift_id() {
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
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                 id, staff_shift_id, cashier_id, branch_id, terminal_id, opening_amount, total_cash_sales, opened_at, created_at, updated_at
             ) VALUES (
                 'cd-adjustment-staff', ?1, ?2, 'b1', 't1', 50.0, 20.0, datetime('now'), datetime('now'), datetime('now')
             )",
            params![staff_shift_id, database_staff_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, staff_shift_id, supabase_id, created_at, updated_at)
             VALUES ('ord-adjustment-staff', '[]', 20.0, 'completed', 'synced', ?1, 'sup-adjustment-staff', datetime('now'), datetime('now'))",
            params![staff_shift_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-adjustment-staff', 'ord-adjustment-staff', 'cash', 20.0, 'completed', 'synced', 'applied', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        drop(conn);

        let payload = serde_json::json!({
            "paymentId": "pay-adjustment-staff",
            "amount": 5.0,
            "reason": "Operator correction",
            "staffId": "STF0008",
            "staffShiftId": staff_shift_id,
        });
        refund_payment(&db, &payload).unwrap();

        let conn = db.conn.lock().unwrap();
        let stored_staff_id: Option<String> = conn
            .query_row(
                "SELECT staff_id FROM payment_adjustments WHERE payment_id = 'pay-adjustment-staff'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let stored_staff_shift_id: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM payment_adjustments WHERE payment_id = 'pay-adjustment-staff'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_staff_id.as_deref(), Some(database_staff_id));
        assert_eq!(stored_staff_shift_id.as_deref(), Some(staff_shift_id));

        let queued_payload: String = conn
            .query_row(
                "SELECT data
                 FROM parity_sync_queue
                 WHERE table_name = 'payment_adjustments'
                   AND record_id IN (
                     SELECT id FROM payment_adjustments WHERE payment_id = 'pay-adjustment-staff'
                   )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let parsed_payload: Value = serde_json::from_str(&queued_payload).unwrap();
        assert_eq!(parsed_payload["staffId"], database_staff_id);
        assert_eq!(parsed_payload["staffShiftId"], staff_shift_id);
    }

    #[test]
    fn test_void_persists_resolved_staff_shift_id() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let staff_shift_id = "343000e2-3d0d-4140-b8db-dd7b9e437f34";
        let database_staff_id = "6ecb4b36-9e70-41ad-b8f2-fb393e10a043";

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                 ?1, ?2, 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now')
             )",
            params![staff_shift_id, database_staff_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                 id, items, total_amount, status, sync_status, staff_shift_id, created_at, updated_at
             ) VALUES (
                 'ord-void-adjustment-staff', '[]', 18.0, 'completed', 'synced', ?1, datetime('now'), datetime('now')
             )",
            params![staff_shift_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'pay-void-adjustment-staff', 'ord-void-adjustment-staff', 'cash', 18.0, 'completed', 'synced', 'applied', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        drop(conn);

        void_payment_with_adjustment(
            &db,
            "pay-void-adjustment-staff",
            "Operator correction",
            Some("STF0008"),
            Some(staff_shift_id),
        )
        .unwrap();

        let conn = db.conn.lock().unwrap();
        let (stored_staff_id, stored_staff_shift_id): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT staff_id, staff_shift_id
                 FROM payment_adjustments
                 WHERE payment_id = 'pay-void-adjustment-staff'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored_staff_id.as_deref(), Some(database_staff_id));
        assert_eq!(stored_staff_shift_id.as_deref(), Some(staff_shift_id));

        let queued_payload: String = conn
            .query_row(
                "SELECT data
                 FROM parity_sync_queue
                 WHERE table_name = 'payment_adjustments'
                   AND record_id IN (
                     SELECT id FROM payment_adjustments WHERE payment_id = 'pay-void-adjustment-staff'
                   )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let parsed_payload: Value = serde_json::from_str(&queued_payload).unwrap();
        assert_eq!(parsed_payload["staffId"], database_staff_id);
        assert_eq!(parsed_payload["staffShiftId"], staff_shift_id);
    }

    #[test]
    fn test_refund_omits_invalid_staff_identifiers_from_sync_payload() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-invalid-adjustment-staff", 30.0);

        let payload = serde_json::json!({
            "paymentId": pay_id,
            "amount": 10.0,
            "reason": "Operator correction",
            "staffId": "STF0008",
            "staffShiftId": "shift-not-a-uuid",
        });
        refund_payment(&db, &payload).unwrap();

        let conn = db.conn.lock().unwrap();
        let stored_staff_id: Option<String> = conn
            .query_row(
                "SELECT staff_id FROM payment_adjustments WHERE payment_id = ?1",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_staff_id, None);

        let queued_payload: String = conn
            .query_row(
                "SELECT data
                 FROM parity_sync_queue
                 WHERE table_name = 'payment_adjustments'
                   AND record_id IN (
                     SELECT id FROM payment_adjustments WHERE payment_id = ?1
                   )",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        let parsed_payload: Value = serde_json::from_str(&queued_payload).unwrap();
        assert!(parsed_payload.get("staffId").is_none());
        assert!(parsed_payload.get("staffShiftId").is_none());
    }
}
