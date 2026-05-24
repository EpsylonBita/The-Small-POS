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
use crate::money::Cents;
use crate::payments;
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
    idempotency_key: Option<&str>,
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
    // W4d-i: emit BOTH float `amount` (legacy, what admin-dashboard's Zod
    // schema currently requires) AND integer `amount_cents` (forward-compat
    // for the wire-format cutover). Admin-dashboard switches its preference
    // to `amount_cents` in a follow-up; this commit is purely additive on
    // pos-tauri's emit side.
    payload.insert("amount".to_string(), Value::from(amount));
    payload.insert(
        "amount_cents".to_string(),
        Value::from(Cents::round_half_even(amount).as_i64()),
    );
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
    if let Some(idempotency_key) = idempotency_key {
        payload.insert(
            "idempotencyKey".to_string(),
            Value::String(idempotency_key.to_string()),
        );
        payload.insert(
            "idempotency_key".to_string(),
            Value::String(idempotency_key.to_string()),
        );
    }

    Value::Object(payload).to_string()
}

// Wave 5 Session 7 PR 2: `build_adjustment_sync_payload_for_adjustment`
// deleted together with `upsert_payment_adjustment_sync_queue_row` and
// the reconcile bridge. The two underlying helpers
// (`load_adjustment_remote_order_id` at :150, `build_adjustment_queue_payload`
// at :170) stay — they have other live callers at :463, :569, :737, :883
// inside the refund-path entry points.

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
    let requested_idempotency_key = str_field(payload, "idempotencyKey")
        .or_else(|| str_field(payload, "idempotency_key"))
        .or_else(|| str_field(payload, "clientRequestId"))
        .or_else(|| str_field(payload, "client_request_id"));
    let client_idempotency_key = normalize_non_empty_text(requested_idempotency_key.as_deref());
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

    let (
        order_id,
        original_amount,
        pay_status,
        payment_method,
        payment_shift_id,
        remote_payment_id,
    ): (String, f64, String, String, Option<String>, Option<String>) = conn
        .query_row(
            // W4b: cents-with-real-fallback shim (removed in 4e).
            "SELECT order_id,
                    COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0),
                    status, method, staff_shift_id, remote_payment_id
             FROM order_payments
             WHERE id = ?1",
            params![payment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    // W4b: cents column -> f64 boundary conversion.
                    Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .map_err(|_| format!("Payment not found: {payment_id}"))?;

    if pay_status == "voided" {
        return Err("Cannot refund a voided payment".into());
    }
    if let Some(idempotency_key) = client_idempotency_key.as_deref() {
        let existing = conn
            .query_row(
                "SELECT id, payment_id, amount
                 FROM payment_adjustments
                 WHERE idempotency_key = ?1
                   AND adjustment_type = 'refund'
                 LIMIT 1",
                params![idempotency_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, f64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("lookup refund idempotency key: {e}"))?;
        if let Some((existing_id, existing_payment_id, existing_amount)) = existing {
            if existing_payment_id != payment_id {
                return Err("Refund idempotency key already belongs to another payment".into());
            }
            return Ok(serde_json::json!({
                "success": true,
                "duplicate": true,
                "adjustmentId": existing_id,
                "paymentId": existing_payment_id,
                "amount": existing_amount,
                "message": "Refund already recorded",
            }));
        }
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
            // W4b: cents-with-real-fallback shim (removed in 4e).
            "SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0)
             FROM payment_adjustments
             WHERE payment_id = ?1 AND adjustment_type = 'refund'",
            params![payment_id],
            // W4b: SUM returns INTEGER (cents); expose as f64 for the
            // existing f64-typed local var.
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .unwrap_or(0.0);

    let remaining = original_amount - prior_refunds;
    // W4e: integer-cent comparison. Half-cent epsilon no longer needed.
    if Cents::round_half_even(amount).as_i64() > Cents::round_half_even(remaining).as_i64() {
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
    // W4e: integer-cent equality replaces the float-distance epsilon.
    let is_fully_refunded = Cents::round_half_even(new_total_refunds).as_i64()
        == Cents::round_half_even(original_amount).as_i64();
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

    // W4c dual-write: populate `amount_cents` alongside REAL `amount`.
    let amount_cents = Cents::round_half_even(amount).as_i64();
    conn.execute(
        "INSERT INTO payment_adjustments (
            id, payment_id, order_id, adjustment_type, amount, amount_cents,
            reason, staff_id, staff_shift_id, sync_state, refund_method, cash_handler,
            adjustment_context, idempotency_key, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'refund', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
        params![
            adjustment_id,
            payment_id,
            order_id,
            amount,
            amount_cents,
            reason,
            resolved_staff_id,
            resolved_staff_shift_id,
            initial_sync_state,
            refund_method.as_str(),
            cash_handler.map(CashHandler::as_str),
            adjustment_context.as_str(),
            client_idempotency_key,
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
                // W4c dual-write: maintain `total_refunds_cents` alongside REAL.
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                        total_refunds = COALESCE(total_refunds, 0) + ?1,
                        total_refunds_cents = COALESCE(total_refunds_cents, 0) + ?2,
                        updated_at = ?3
                     WHERE staff_shift_id = ?4",
                    params![amount, amount_cents, now, sid],
                )
                .map_err(|e| format!("update drawer refunds: {e}"))?;
            }
        }
        Some(CashHandler::DriverShift) => {
            // W4c dual-write: mirror `cash_collected`/`cash_to_return` updates
            // onto their `_cents` siblings. The legacy REAL columns keep their
            // `payment_method` derivation read-source unchanged.
            let updated = conn
                .execute(
                    "UPDATE driver_earnings
                     SET cash_collected = CASE
                            WHEN COALESCE(cash_collected, 0) - ?1 < 0 THEN 0
                            ELSE COALESCE(cash_collected, 0) - ?1
                         END,
                         cash_collected_cents = CASE
                            WHEN COALESCE(cash_collected_cents, 0) - ?2 < 0 THEN 0
                            ELSE COALESCE(cash_collected_cents, 0) - ?2
                         END,
                         cash_to_return = CASE
                            WHEN COALESCE(cash_to_return, 0) - ?1 < 0 THEN 0
                            ELSE COALESCE(cash_to_return, 0) - ?1
                         END,
                         cash_to_return_cents = CASE
                            WHEN COALESCE(cash_to_return_cents, 0) - ?2 < 0 THEN 0
                            ELSE COALESCE(cash_to_return_cents, 0) - ?2
                         END,
                         payment_method = CASE
                            WHEN COALESCE(card_amount, 0) > 0 AND
                                 CASE WHEN COALESCE(cash_collected, 0) - ?1 < 0 THEN 0 ELSE COALESCE(cash_collected, 0) - ?1 END > 0
                                THEN 'mixed'
                            WHEN COALESCE(card_amount, 0) > 0 THEN 'card'
                            ELSE 'cash'
                         END,
                         updated_at = ?3
                     WHERE order_id = ?4
                       AND COALESCE(settled, 0) = 0
                       AND COALESCE(is_transferred, 0) = 0",
                    params![amount, amount_cents, now, order_id],
                )
                .map_err(|e| format!("update driver settlement refund: {e}"))?;
            if updated == 0 {
                return Err(
                    "Driver cash refund requires an active unsettled driver earning".into(),
                );
            }
        }
        None => {
            // W4c dual-write: mirror `card_amount` clamp onto `card_amount_cents`.
            let _ = conn.execute(
                "UPDATE driver_earnings
                 SET card_amount = CASE
                        WHEN COALESCE(card_amount, 0) - ?1 < 0 THEN 0
                        ELSE COALESCE(card_amount, 0) - ?1
                     END,
                     card_amount_cents = CASE
                        WHEN COALESCE(card_amount_cents, 0) - ?2 < 0 THEN 0
                        ELSE COALESCE(card_amount_cents, 0) - ?2
                     END,
                     payment_method = CASE
                        WHEN CASE WHEN COALESCE(card_amount, 0) - ?1 < 0 THEN 0 ELSE COALESCE(card_amount, 0) - ?1 END > 0
                             AND COALESCE(cash_collected, 0) > 0
                            THEN 'mixed'
                        WHEN COALESCE(cash_collected, 0) > 0 THEN 'cash'
                        ELSE 'card'
                     END,
                     updated_at = ?3
                 WHERE order_id = ?4
                   AND COALESCE(settled, 0) = 0
                   AND COALESCE(is_transferred, 0) = 0",
                params![amount, amount_cents, now, order_id],
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
        client_idempotency_key.as_deref(),
    );

    payments::recompute_order_payment_state(conn, &order_id, &now, &payment_id)?;

    let sync_payload_value = serde_json::from_str::<Value>(&sync_payload)
        .map_err(|e| format!("parse adjustment payload: {e}"))?;
    crate::sync_queue::enqueue_payload_item(
        conn,
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

    let parent_payment_missing_canonical_id = remote_payment_id
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty);
    if adjustment_context == AdjustmentContext::EditSettlement
        && (pay_sync_state != "applied" || parent_payment_missing_canonical_id)
    {
        payments::refresh_payment_sync_queue_entry(conn, &payment_id)
            .map_err(|e| format!("refresh parent payment settlement proof sync: {e}"))?;
    }

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

    // Fetch the payment in any state so we can return a precise, typed error
    // rather than a misleading "not found". A completed payment is the only
    // voidable state; other states each surface their own error message.
    let (order_id, amount, pay_method, pay_status): (String, f64, String, String) = conn
        .query_row(
            // W4b: cents-with-real-fallback shim (removed in 4e).
            "SELECT order_id,
                    COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0),
                    method, status
             FROM order_payments WHERE id = ?1",
            params![payment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    // W4b: cents column → f64 boundary conversion.
                    Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
                    row.get(2)?,
                    row.get(3)?,
                ))
            },
        )
        .map_err(|_| format!("Payment not found: {payment_id}"))?;

    match pay_status.as_str() {
        "completed" => {}
        "voided" => return Err(format!("Payment {payment_id} is already voided")),
        "refunded" => {
            return Err(format!(
                "Payment {payment_id} has been refunded and cannot be voided"
            ))
        }
        other => {
            return Err(format!(
                "Payment {payment_id} has status '{other}' and cannot be voided"
            ))
        }
    }

    // Reconciliation guard: a completed payment must have no prior refund
    // adjustments. If any exist, the payment is in a partially-materialized
    // state — voiding it now would compound monetary drift because the void
    // reverses the full amount while refunds have already been paid out.
    let prior_refunds: f64 = conn
        .query_row(
            // W4b: cents-with-real-fallback shim (removed in 4e).
            "SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0)
             FROM payment_adjustments
             WHERE payment_id = ?1 AND adjustment_type = 'refund'",
            params![payment_id],
            // W4b: SUM returns INTEGER (cents); expose as f64 for the
            // existing f64-typed local var.
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .unwrap_or(0.0);
    // W4e: integer-cent positive check.
    if Cents::round_half_even(prior_refunds).as_i64() > 0 {
        return Err(format!(
            "Payment {payment_id} has {prior_refunds:.2} in prior refunds; \
             complete the remaining balance as a refund instead of voiding"
        ));
    }

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

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        // Wave 6 H17: re-read `status` and recompute `prior_refunds` INSIDE
        // the transaction. The outer reads at lines ~670 and ~697 happened
        // before BEGIN IMMEDIATE, so a concurrent refund landing in the
        // gap could flip `status` to 'refunded' or bump `prior_refunds`
        // above zero between the guard check and the void INSERT. With
        // the re-check under the IMMEDIATE lock, the guards are truly
        // serialising — either this void observes a fresh `completed`
        // payment with zero refunds and proceeds, or it observes the
        // concurrent change and aborts without double-spending.
        let tx_pay_status: String = conn
            .query_row(
                "SELECT status FROM order_payments WHERE id = ?1",
                params![payment_id],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| pay_status.clone());
        match tx_pay_status.as_str() {
            "completed" => {}
            "voided" => return Err(format!("Payment {payment_id} is already voided")),
            "refunded" => {
                return Err(format!(
                    "Payment {payment_id} has been refunded and cannot be voided"
                ))
            }
            other => {
                return Err(format!(
                    "Payment {payment_id} has status '{other}' and cannot be voided"
                ))
            }
        }
        let tx_prior_refunds: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(amount_cents), 0) FROM payment_adjustments
                 WHERE payment_id = ?1 AND adjustment_type = 'refund'",
                params![payment_id],
                // W4b: SUM returns INTEGER cents; expose as f64.
                |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
            )
            .unwrap_or(0.0);
        // W4e: integer-cent positive check.
        if Cents::round_half_even(tx_prior_refunds).as_i64() > 0 {
            return Err(format!(
                "Payment {payment_id} has {tx_prior_refunds:.2} in prior refunds; \
                 complete the remaining balance as a refund instead of voiding"
            ));
        }

        // Read pay_sync_state INSIDE the transaction. Previously this ran
        // outside BEGIN IMMEDIATE, so a payment that transitioned from a
        // non-applied state to 'applied' in the gap would still cause the
        // void adjustment to be routed to `waiting_parent` and then stall
        // indefinitely waiting for a parent that had already synced.
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

        // Mark payment as voided
        conn.execute(
            "UPDATE order_payments SET
                status = 'voided', voided_at = ?1, voided_by = ?2,
                void_reason = ?3, sync_status = 'pending', updated_at = ?1
             WHERE id = ?4",
            params![now, resolved_staff_id, reason, payment_id],
        )
        .map_err(|e| format!("void payment: {e}"))?;

        payments::recompute_order_payment_state(&conn, &order_id, &now, payment_id)?;

        // Insert adjustment audit record (W4c dual-write).
        let void_amount_cents = Cents::round_half_even(amount).as_i64();
        conn.execute(
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount, amount_cents,
                reason, staff_id, staff_shift_id, sync_state, created_at, updated_at
            ) VALUES (?1, ?2, ?3, 'void', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                adjustment_id,
                payment_id,
                order_id,
                amount,
                void_amount_cents,
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
        //
        // Wave 6 H18: the subtraction is guarded with a `MAX(…, 0)` floor.
        // The driver-earnings refund path at lines ~502–511 already clamps
        // this way, but the void path here used to subtract unconditionally.
        // If concurrent voids or a pre-existing drawer-counter drift produced
        // `total_cash_sales < 0`, the cashier's expected-cash formula in
        // `shifts.rs:877` would emit a negative expected total and close-out
        // variance would be corrupted. Clamping at zero keeps the counter
        // non-negative at the cost of one arithmetic op per void.
        if let Some(ref sid) = order_shift_id {
            if pay_method == "cash" {
                // W4c dual-write: clamp the cents sibling alongside REAL.
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                        total_cash_sales = MAX(COALESCE(total_cash_sales, 0) - ?1, 0),
                        total_cash_sales_cents = MAX(COALESCE(total_cash_sales_cents, 0) - ?2, 0),
                        updated_at = ?3
                     WHERE staff_shift_id = ?4",
                    params![amount, void_amount_cents, now, sid],
                )
                .map_err(|e| format!("reverse drawer cash_sales: {e}"))?;
            } else if pay_method == "card" {
                // Wave 6 H18: same `MAX(…, 0)` floor for card sales as cash.
                // W4c dual-write: clamp the cents sibling alongside REAL.
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                        total_card_sales = MAX(COALESCE(total_card_sales, 0) - ?1, 0),
                        total_card_sales_cents = MAX(COALESCE(total_card_sales_cents, 0) - ?2, 0),
                        updated_at = ?3
                     WHERE staff_shift_id = ?4",
                    params![amount, void_amount_cents, now, sid],
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
            // W4b: cents-with-real-fallback shim (removed in 4e).
            "SELECT id, payment_id, order_id, adjustment_type,
                    COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0),
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
                // W4b: cents column → f64-dp2 for the existing JSON shape.
                // Renderer/admin still expect float `amount` until 4d
                // cuts the wire format over.
                "amount": Cents::new(row.get::<_, i64>(4)?).to_f64_dp2(),
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
            // W4b: cents-with-real-fallback shim (removed in 4e).
            "SELECT COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0), status
             FROM order_payments WHERE id = ?1",
            params![payment_id],
            |row| {
                Ok((
                    // W4b: cents column → f64 for existing local var.
                    Cents::new(row.get::<_, i64>(0)?).to_f64_dp2(),
                    row.get(1)?,
                ))
            },
        )
        .map_err(|_| format!("Payment not found: {payment_id}"))?;

    let total_refunds: f64 = conn
        .query_row(
            // W4b: cents-with-real-fallback shim (removed in 4e).
            "SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0)
             FROM payment_adjustments
             WHERE payment_id = ?1 AND adjustment_type = 'refund'",
            params![payment_id],
            // W4b: SUM returns INTEGER (cents); expose as f64 for the
            // existing f64-typed local var.
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .unwrap_or(0.0);

    if status == "voided" {
        // Wave 10 medium: surface the actual refund total even for voided
        // payments so callers can distinguish "voided" from "voided after
        // partial refund". `balance` is still forced to 0 — a voided
        // payment is not refundable further, regardless of prior refunds.
        return Ok(serde_json::json!({
            "success": true,
            "paymentId": payment_id,
            "originalAmount": original_amount,
            "totalRefunds": total_refunds,
            "balance": 0.0,
            "status": "voided",
        }));
    }

    // Wave 6: clamp to zero. If `total_refunds` accidentally exceeds
    // `original_amount` (DB inconsistency, historical corruption,
    // over-refund guard misconfiguration), a negative balance would
    // render as e.g. "-€0.01 refundable" in the UI and confuse the
    // cashier. The source-of-truth stays in the underlying rows; we
    // only prevent surfacing a meaningless negative to the operator.
    let balance = (original_amount - total_refunds).max(0.0);

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
    // Reject NaN and ±Infinity at the field-reading layer. `Value::as_f64`
    // returns `Some` for any JSON number that fits in f64, including
    // representations that parse to NaN or Infinity through edge encodings.
    // Downstream guards like `amount <= 0.0` are NOT NaN-safe (every NaN
    // comparison returns false), so a non-finite value would silently
    // bypass the positive-amount check.
    v.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
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
        // W4e Step 0: dual-populate REAL + cents columns. amount_cents is
        // computed via Cents::round_half_even at the bind site so the
        // fixture tracks the same rounding rule production code uses.
        let amount_cents = Cents::round_half_even(amount).as_i64();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, supabase_id, created_at, updated_at)
             VALUES (?1, '[]', ?2, ?3, 'completed', 'synced', '11111111-1111-4111-8111-111111111111', datetime('now'), datetime('now'))",
            params![order_id, amount, amount_cents],
        )
        .expect("insert order");

        let pay_id = format!("pay-{order_id}");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, sync_status, sync_state, created_at, updated_at)
             VALUES (?1, ?2, 'cash', ?3, ?4, 'synced', 'applied', datetime('now'), datetime('now'))",
            params![pay_id, order_id, amount, amount_cents],
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
    fn edit_settlement_refund_refreshes_parent_payment_payload_with_proof() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-edit-proof", 25.3);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE order_payments
                 SET sync_status = 'pending',
                     sync_state = 'pending',
                     remote_payment_id = NULL
                 WHERE id = ?1",
                params![pay_id],
            )
            .expect("mark parent payment pending");
        }

        let payload = serde_json::json!({
            "paymentId": pay_id,
            "amount": 1.0,
            "reason": "Edit settlement refund",
            "adjustmentContext": "edit_settlement",
            "refundMethod": "cash",
        });
        refund_payment(&db, &payload).expect("record edit settlement refund");

        let conn = db.conn.lock().unwrap();
        let payment_payload: String = conn
            .query_row(
                "SELECT data
                 FROM parity_sync_queue
                 WHERE table_name = 'payments'
                   AND record_id = ?1
                 LIMIT 1",
                params![pay_id],
                |row| row.get(0),
            )
            .expect("parent payment queue row");
        let parsed: Value =
            serde_json::from_str(&payment_payload).expect("parse parent payment payload");
        let settlement_adjustments = parsed
            .get("settlement_adjustments")
            .and_then(Value::as_array)
            .expect("settlement adjustment proof");

        assert_eq!(settlement_adjustments.len(), 1);
        assert_eq!(
            settlement_adjustments[0]
                .get("amount_cents")
                .and_then(Value::as_i64),
            Some(100)
        );
        assert_eq!(
            settlement_adjustments[0]
                .get("adjustment_context")
                .and_then(Value::as_str),
            Some("edit_settlement")
        );
    }

    #[test]
    fn test_refund_idempotency_client_request_id_returns_duplicate() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-idem", 50.0);

        let payload = serde_json::json!({
            "paymentId": pay_id,
            "amount": 15.0,
            "reason": "Item returned",
            "clientRequestId": "client-refund-1",
        });

        let first = refund_payment(&db, &payload).unwrap();
        let second = refund_payment(&db, &payload).unwrap();

        assert_eq!(second["success"], true);
        assert_eq!(second["duplicate"], true);
        assert_eq!(second["adjustmentId"], first["adjustmentId"]);

        let conn = db.conn.lock().unwrap();
        let adjustment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM payment_adjustments WHERE payment_id = ?1",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(adjustment_count, 1);
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

    /// Wave 10 medium: a voided payment may carry prior refund adjustments
    /// in the database (from data migrations, manual cleanup, or historical
    /// rows that pre-date the current `void_payment_with_adjustment` guard
    /// that refuses to void payments with any prior refund). The voided
    /// branch of `get_payment_balance` previously returned hardcoded
    /// `totalRefunds: 0.0` — callers could not distinguish "voided after
    /// prior refund" from "voided cleanly". `balance` must remain 0 (a
    /// voided payment is not refundable further regardless of prior
    /// refunds).
    ///
    /// We seed the (voided payment + refund adjustment) state directly in
    /// SQL because the production void path now refuses to construct
    /// this state (and we don't want to flip the guard off for the
    /// purpose of the test).
    #[test]
    fn test_get_payment_balance_voided_after_partial_refund() {
        let db = test_db();
        let pay_id = seed_order_and_payment(&db, "ord-gbvr", 50.0);

        let conn = db.conn.lock().unwrap();
        // Force the payment to voided status.
        conn.execute(
            "UPDATE order_payments SET status = 'voided' WHERE id = ?1",
            params![pay_id],
        )
        .expect("force voided status");
        // Seed a refund adjustment that pre-existed the void (the
        // historical state H32 cares about).
        conn.execute(
            // W4e Step 0: dual-populate amount + amount_cents (12.0 → 1200).
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount, amount_cents, reason,
                sync_state, created_at, updated_at
             ) VALUES ('adj-historic', ?1, 'ord-gbvr', 'refund', 12.0, 1200,
                'Historic partial refund', 'pending',
                datetime('now'), datetime('now'))",
            params![pay_id],
        )
        .expect("seed historic refund adjustment");
        drop(conn);

        let b = get_payment_balance(&db, &pay_id).unwrap();
        assert_eq!(b["status"], "voided", "payment must be marked voided");
        assert_eq!(
            b["totalRefunds"], 12.0,
            "voided branch must surface prior refund total, not hardcoded 0.0"
        );
        assert_eq!(
            b["balance"], 0.0,
            "voided payment is not refundable further regardless of prior refunds"
        );
        assert_eq!(b["originalAmount"], 50.0);
    }

    #[test]
    fn test_refund_waiting_parent_sync_state() {
        let db = test_db();

        // Create order + payment where payment hasn't synced yet
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (20.0 → 2000 cents).
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES ('ord-wp', '[]', 20.0, 2000, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-wp', 'ord-wp', 'cash', 20.0, 2000, 'pending', 'pending', datetime('now'), datetime('now'))",
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
        // W4e Step 0: dual-populate (100.0 → 10000, 40.0 → 4000).
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id,
                                                opening_amount, opening_amount_cents,
                                                total_cash_sales, total_cash_sales_cents,
                                                opened_at, created_at, updated_at)
             VALUES ('cd-vr', 'shift-vr', 'staff-vr', 'b1', 't1', 100.0, 10000, 40.0, 4000,
                     datetime('now'), datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, staff_shift_id, supabase_id, created_at, updated_at)
             VALUES ('ord-vr', '[]', 40.0, 4000, 'completed', 'synced', 'shift-vr', 'sup-vr', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-vr', 'ord-vr', 'cash', 40.0, 4000, 'completed', 'synced', 'applied', datetime('now'), datetime('now'))",
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
        // W4e Step 0: dual-populate (100.0 → 10000, 50.0 → 5000).
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id,
                                                opening_amount, opening_amount_cents,
                                                total_cash_sales, total_cash_sales_cents,
                                                opened_at, created_at, updated_at)
             VALUES ('cd-rdr', 'shift-rdr', 'staff-rdr', 'b1', 't1', 100.0, 10000, 50.0, 5000,
                     datetime('now'), datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, staff_shift_id, supabase_id, created_at, updated_at)
             VALUES ('ord-rdr', '[]', 50.0, 5000, 'completed', 'synced', 'shift-rdr', 'sup-rdr', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-rdr', 'ord-rdr', 'cash', 50.0, 5000, 'completed', 'synced', 'applied', datetime('now'), datetime('now'))",
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

        // Refund 20 — payment stays status='completed' (fully-refunded threshold
        // not yet reached) but now has a non-zero prior refund total.
        let p = serde_json::json!({ "paymentId": pay_id, "amount": 20.0, "reason": "Partial" });
        refund_payment(&db, &p).unwrap();

        // Void must now be rejected: the payment is partially materialized via
        // the prior refund, so voiding (which reverses the full sale) would
        // double-count the already-paid-out refund. The correct operator flow
        // is to process the remaining 30.0 as another refund, not a void.
        let err = void_payment_with_adjustment(&db, &pay_id, "Cancel rest", None, None)
            .expect_err("void of partially-refunded payment must be rejected");
        assert!(
            err.contains("prior refunds"),
            "error should mention prior refunds, got: {err}"
        );

        // Payment status must remain 'completed' — no void was applied.
        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM order_payments WHERE id = ?1",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "completed");

        // Only the one prior refund adjustment exists; no void row was inserted.
        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM payment_adjustments WHERE payment_id = ?1",
                params![pay_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
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
        // W4e Step 0: dual-populate (50.0 → 5000, 20.0 → 2000).
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                 id, staff_shift_id, cashier_id, branch_id, terminal_id,
                 opening_amount, opening_amount_cents,
                 total_cash_sales, total_cash_sales_cents,
                 opened_at, created_at, updated_at
             ) VALUES (
                 'cd-adjustment-staff', ?1, ?2, 'b1', 't1', 50.0, 5000, 20.0, 2000,
                 datetime('now'), datetime('now'), datetime('now')
             )",
            params![staff_shift_id, database_staff_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, staff_shift_id, supabase_id, created_at, updated_at)
             VALUES ('ord-adjustment-staff', '[]', 20.0, 2000, 'completed', 'synced', ?1, 'sup-adjustment-staff', datetime('now'), datetime('now'))",
            params![staff_shift_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-adjustment-staff', 'ord-adjustment-staff', 'cash', 20.0, 2000, 'completed', 'synced', 'applied', datetime('now'), datetime('now'))",
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
        // W4e Step 0: dual-populate amount + amount_cents (18.0 → 1800).
        conn.execute(
            "INSERT INTO orders (
                 id, items, total_amount, total_amount_cents, status, sync_status, staff_shift_id, created_at, updated_at
             ) VALUES (
                 'ord-void-adjustment-staff', '[]', 18.0, 1800, 'completed', 'synced', ?1, datetime('now'), datetime('now')
             )",
            params![staff_shift_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'pay-void-adjustment-staff', 'ord-void-adjustment-staff', 'cash', 18.0, 1800, 'completed', 'synced', 'applied', datetime('now'), datetime('now')
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
