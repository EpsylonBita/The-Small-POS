use chrono::Utc;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

use crate::{db, payload_arg0_as_string, payments, refunds, resolve_order_id};

static ACTIVE_PAYMENT_RECORDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn active_payment_records() -> &'static Mutex<HashSet<String>> {
    ACTIVE_PAYMENT_RECORDS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Debug)]
pub(crate) struct PaymentRecordReservation(String);

impl Drop for PaymentRecordReservation {
    fn drop(&mut self) {
        if let Ok(mut active) = active_payment_records().lock() {
            active.remove(&self.0);
        }
    }
}

pub(crate) fn reserve_payment_record(order_id: &str) -> Result<PaymentRecordReservation, String> {
    let mut active = active_payment_records()
        .lock()
        .map_err(|error| format!("lock active payment collections: {error}"))?;
    if !active.insert(order_id.to_string()) {
        return Err("A payment collection is already in progress for this order".to_string());
    }
    Ok(PaymentRecordReservation(order_id.to_string()))
}

#[derive(Debug)]
struct PaymentUpdateStatusPayload {
    order_id: String,
    payment_status: String,
    payment_method: Option<String>,
}

#[derive(Debug)]
struct PaymentMethodUpdatePayload {
    order_id: String,
    payment_id: Option<String>,
    payment_method: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaymentVoidPayload {
    #[serde(alias = "payment_id")]
    payment_id: String,
    reason: String,
    #[serde(default, alias = "voided_by")]
    voided_by: Option<String>,
    #[serde(default, alias = "staff_shift_id")]
    staff_shift_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefundVoidPayload {
    #[serde(alias = "payment_id")]
    payment_id: String,
    reason: String,
    #[serde(default, alias = "staff_id")]
    staff_id: Option<String>,
    #[serde(default, alias = "staff_shift_id")]
    staff_shift_id: Option<String>,
}

fn parse_payment_update_status_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    arg2: Option<String>,
) -> Result<PaymentUpdateStatusPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(order_id)) => serde_json::json!({
            "orderId": order_id,
            "paymentStatus": arg1,
            "paymentMethod": arg2
        }),
        Some(v) => v,
        None => serde_json::json!({
            "paymentStatus": arg1,
            "paymentMethod": arg2
        }),
    };

    let order_id = payload_arg0_as_string(
        Some(payload.clone()),
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .ok_or("Missing orderId")?;
    let payment_status = payload
        .get("paymentStatus")
        .or_else(|| payload.get("payment_status"))
        .or_else(|| payload.get("status"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| arg1.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .ok_or("Missing payment status")?;
    let payment_status = match payment_status.to_ascii_lowercase().as_str() {
        "pending" => "pending".to_string(),
        "paid" => "paid".to_string(),
        "partially_paid" => "partially_paid".to_string(),
        "refunded" => "refunded".to_string(),
        "failed" => "failed".to_string(),
        _ => {
            return Err(
                "payment_update_payment_status only supports reconciliation states; use payment_record to capture funds"
                    .into(),
            )
        }
    };
    let payment_method = payload
        .get("paymentMethod")
        .or_else(|| payload.get("payment_method"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| arg2.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));

    Ok(PaymentUpdateStatusPayload {
        order_id: order_id.trim().to_string(),
        payment_status,
        payment_method,
    })
}

fn parse_payment_method_update_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
) -> Result<PaymentMethodUpdatePayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(order_id)) => serde_json::json!({
            "orderId": order_id,
            "paymentMethod": arg1,
        }),
        Some(v) => v,
        None => serde_json::json!({
            "paymentMethod": arg1,
        }),
    };

    let order_id = payload_arg0_as_string(
        Some(payload.clone()),
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .ok_or("Missing orderId")?;
    let payment_method = payload
        .get("paymentMethod")
        .or_else(|| payload.get("payment_method"))
        .or_else(|| payload.get("method"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            arg1.as_ref()
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| !value.is_empty())
        })
        .ok_or("Missing payment method")?;

    let payment_method = match payment_method.as_str() {
        "cash" => "cash".to_string(),
        "card" => "card".to_string(),
        _ => return Err("Payment method edits only support cash or card".into()),
    };
    let payment_id = payload
        .get("paymentId")
        .or_else(|| payload.get("payment_id"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    Ok(PaymentMethodUpdatePayload {
        order_id: order_id.trim().to_string(),
        payment_id,
        payment_method,
    })
}

fn parse_payment_void_payload(
    payload: Option<serde_json::Value>,
) -> Result<PaymentVoidPayload, String> {
    let mut parsed: PaymentVoidPayload =
        serde_json::from_value(payload.ok_or("Missing void payment payload")?)
            .map_err(|e| format!("Invalid void payment payload: {e}"))?;

    parsed.payment_id = parsed.payment_id.trim().to_string();
    parsed.reason = parsed.reason.trim().to_string();
    if parsed.payment_id.is_empty() {
        return Err("Missing paymentId".into());
    }
    if parsed.reason.is_empty() {
        return Err("Missing reason".into());
    }
    Ok(parsed)
}

fn parse_refund_void_payload(
    payload: Option<serde_json::Value>,
) -> Result<RefundVoidPayload, String> {
    let mut parsed: RefundVoidPayload =
        serde_json::from_value(payload.ok_or("Missing void payment payload")?)
            .map_err(|e| format!("Invalid refund void payload: {e}"))?;

    parsed.payment_id = parsed.payment_id.trim().to_string();
    parsed.reason = parsed.reason.trim().to_string();
    if parsed.payment_id.is_empty() {
        return Err("Missing paymentId".into());
    }
    if parsed.reason.is_empty() {
        return Err("Missing reason".into());
    }
    Ok(parsed)
}

fn parse_order_id_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .ok_or("Missing orderId".into())
}

fn parse_payment_id_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(arg0, &["paymentId", "payment_id", "id"])
        .ok_or("Missing paymentId".into())
}

pub(crate) fn payment_payload_has_terminal_approval(payload: &serde_json::Value) -> bool {
    payload
        .get("terminalApproved")
        .or_else(|| payload.get("terminal_approved"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn sanitize_outstanding_collection_trust_fields(
    payload: &mut serde_json::Value,
) -> Result<(), String> {
    let payment = payload.as_object_mut().ok_or("Invalid payment payload")?;
    for field in [
        "terminalApproved",
        "terminal_approved",
        "paymentOrigin",
        "payment_origin",
        "terminalDeviceId",
        "terminal_device_id",
        "deviceId",
        "device_id",
        "transactionRef",
        "transaction_ref",
        "transactionId",
        "transaction_id",
    ] {
        payment.remove(field);
    }
    Ok(())
}

fn should_fiscalize_full_balance_before_record(
    input: &payments::PaymentRecordInput,
    terminal_approved: bool,
    collect_outstanding: bool,
    balance: payments::OrderPaymentBalanceSnapshot,
) -> bool {
    (!terminal_approved || collect_outstanding)
        && matches!(input.method.as_str(), "cash" | "card")
        && (collect_outstanding || balance.net_paid <= 0.01)
        && (input.amount - balance.outstanding_amount).abs() <= 0.01
}

fn fiscal_checkout_not_approved_response(checkout: serde_json::Value) -> serde_json::Value {
    let error = checkout
        .get("error")
        .cloned()
        .unwrap_or_else(|| serde_json::json!("Fiscal checkout was not approved"));
    let requires_reconciliation = checkout
        .get("requiresReconciliation")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    serde_json::json!({
        "success": false,
        "errorCode": "FISCAL_CHECKOUT_NOT_APPROVED",
        "paymentApproved": false,
        "paymentPersisted": false,
        "requiresReconciliation": requires_reconciliation,
        "error": error,
        "fiscalCheckout": checkout,
    })
}

fn post_fiscal_persistence_failure_response(
    _internal_error: &str,
    checkout: &serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "success": false,
        "errorCode": "PAYMENT_PERSISTENCE_RECONCILIATION_REQUIRED",
        "paymentApproved": true,
        "paymentPersisted": false,
        "requiresReconciliation": true,
        "error": "The fiscal payment was approved, but local persistence could not be completed. Reconcile this payment before retrying.",
        "fiscalCheckout": checkout,
    })
}

fn outstanding_collection_fiscal_reference(
    order_id: &str,
    balance: payments::OrderPaymentBalanceSnapshot,
    idempotency_key: &str,
) -> String {
    let mut reference_digest = Sha256::new();
    reference_digest.update(b"outstanding-collection-reference-v1\0");
    reference_digest.update(
        crate::money::Cents::round_half_even(balance.order_total)
            .as_i64()
            .to_le_bytes(),
    );
    reference_digest.update(
        crate::money::Cents::round_half_even(balance.net_paid)
            .as_i64()
            .to_le_bytes(),
    );
    reference_digest.update(
        crate::money::Cents::round_half_even(balance.outstanding_amount)
            .as_i64()
            .to_le_bytes(),
    );
    reference_digest.update(balance.ledger_generation);
    reference_digest.update(idempotency_key.as_bytes());
    let reference_generation: [u8; 32] = reference_digest.finalize().into();
    let reference_token = payments::settlement_generation_token(&reference_generation);
    format!("{order_id}:collect-outstanding:{}", &reference_token[..32])
}

fn validate_outstanding_idempotency_key(payload: &serde_json::Value) -> Result<&str, &'static str> {
    let Some(key) = payload
        .get("idempotencyKey")
        .or_else(|| payload.get("idempotency_key"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
    else {
        return Err("IDEMPOTENCY_KEY_REQUIRED");
    };
    if key.is_empty() {
        return Err("IDEMPOTENCY_KEY_REQUIRED");
    }
    if key.len() > 128
        || !key.is_ascii()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err("IDEMPOTENCY_KEY_INVALID");
    }
    Ok(key)
}

fn outstanding_idempotency_error_response(error_code: &str) -> serde_json::Value {
    serde_json::json!({
        "success": false,
        "errorCode": error_code,
        "paymentApproved": false,
        "paymentPersisted": false,
        "requiresReconciliation": false,
        "error": "A valid payment attempt identifier is required before collecting the outstanding balance.",
    })
}

fn collect_outstanding_error_response(
    error_code: &str,
    error: &str,
    settlement: &payments::OrderSettlementSnapshot,
) -> serde_json::Value {
    serde_json::json!({
        "success": false,
        "errorCode": error_code,
        "paymentApproved": false,
        "paymentPersisted": false,
        "error": error,
        "settlement": {
            "orderTotal": settlement.order_total,
            "netPaid": settlement.net_paid,
            "outstandingAmount": settlement.outstanding_amount,
            "completedPayments": settlement.completed_payments,
            "generation": payments::settlement_generation_token(&settlement.ledger_generation),
        },
    })
}

fn validate_collect_outstanding_generation(
    payload: &serde_json::Value,
    settlement: &payments::OrderSettlementSnapshot,
) -> Result<(), serde_json::Value> {
    let expected = payload
        .get("expectedSettlementGeneration")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let current = payments::settlement_generation_token(&settlement.ledger_generation);
    match expected {
        Some(expected) if expected == current => Ok(()),
        Some(_) => Err(collect_outstanding_error_response(
            "BALANCE_CHANGED",
            "The order balance changed. Refresh the payment details before collecting it.",
            settlement,
        )),
        None => Err(collect_outstanding_error_response(
            "EXPECTED_SETTLEMENT_REQUIRED",
            "An atomic settlement snapshot is required before collecting the outstanding balance.",
            settlement,
        )),
    }
}

fn load_order_settlement_read_transaction(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<payments::OrderSettlementSnapshot, String> {
    conn.execute_batch("BEGIN DEFERRED")
        .map_err(|error| format!("begin payment settlement read: {error}"))?;
    let loaded = payments::load_order_settlement_snapshot(conn, order_id);
    match loaded {
        Ok(snapshot) => {
            conn.execute_batch("COMMIT")
                .map_err(|error| format!("commit payment settlement read: {error}"))?;
            Ok(snapshot)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Persist a reconciliation payment label on one order.
///
/// Founder's rule (30/09/2026): a payment record is never missing, and no
/// order is registered as paid without one. `paid` and `partially_paid` are
/// written only when the order's completed payment rows back the claim
/// (`paid`: the whole total; `partially_paid`: some money; a zero total, a
/// comp, needs none). The check used to be "at least one completed row", so
/// 5.00 in the ledger was enough to mark a 20.00 order `paid` and push that.
/// Money itself is only ever recorded through `payment_record`.
///
/// Wave 6 H15: the reads and the UPDATE run in one IMMEDIATE transaction,
/// so a concurrent void cannot remove the covering rows in between.
/// Wave 6 C8: `payment_method` is never written; it is derived on read via
/// `payments::derive_payment_method`.
fn set_order_payment_status_in_connection(
    conn: &rusqlite::Connection,
    order_id: &str,
    payment_status: &str,
    now: &str,
) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin payment-status transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        let (current_payment_status, completed_payment_rows): (String, i64) = conn
            .query_row(
                "SELECT COALESCE(payment_status, 'pending'),
                        COALESCE((
                            SELECT COUNT(*)
                            FROM order_payments
                            WHERE order_id = orders.id
                              AND status = 'completed'
                        ), 0)
                 FROM orders
                 WHERE id = ?1",
                rusqlite::params![order_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("load payment reconciliation context: {e}"))?;
        if matches!(payment_status, "paid" | "partially_paid")
            && !payments::ledger_backs_claimed_status(conn, order_id, payment_status)?
        {
            return Err(format!(
                "Cannot mark this order {payment_status}: its completed payments do not cover it; use payment_record instead"
            ));
        }
        if completed_payment_rows == 0
            && current_payment_status != payment_status
            && payment_status == "refunded"
        {
            return Err(
                "Cannot promote payment status without completed payment rows; use payment_record instead"
                    .into(),
            );
        }
        conn.execute(
            "UPDATE orders
             SET payment_status = ?1,
                 sync_status = 'pending',
                 updated_at = ?2
             WHERE id = ?3",
            rusqlite::params![payment_status, now, order_id],
        )
        .map_err(|e| format!("update payment status: {e}"))?;
        Ok(())
    })();

    match result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("commit payment-status transaction: {e}")),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn payment_update_payment_status(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    arg2: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_payment_update_status_payload(arg0, arg1, arg2)?;
    let order_id_raw = payload.order_id;
    let payment_status = payload.payment_status;
    let payment_method = payload.payment_method;
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;

    set_order_payment_status_in_connection(&conn, &order_id, &payment_status, &now)?;

    let event_payload = serde_json::json!({
        "orderId": order_id,
        "paymentStatus": payment_status,
        "paymentMethod": payment_method
    });
    // Wave 6 M3: the sync-queue idempotency key is anchored on
    // `(order_id, payment_status)`, so a double submission of the same
    // status change produces the same key.
    let idem = format!("order:status:{}:{}", order_id, payment_status);
    let _ = conn.execute(
        "INSERT OR IGNORE INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('order', ?1, 'update', ?2, ?3)",
        rusqlite::params![order_id, event_payload.to_string(), idem],
    );
    drop(conn);
    let _ = app.emit("order_payment_updated", event_payload.clone());
    Ok(serde_json::json!({ "success": true, "data": event_payload }))
}

#[tauri::command]
pub async fn payment_update_payment_method(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_payment_method_update_payload(arg0, arg1)?;
    let result = payments::update_payment_method_for_payment(
        &db,
        &payload.order_id,
        payload.payment_id.as_deref(),
        &payload.payment_method,
    )?;
    if let Some(event_payload) = result.get("data").cloned() {
        let _ = app.emit("order_payment_updated", event_payload);
    }
    Ok(result)
}

#[tauri::command]
pub async fn payment_record(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, crate::ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let mut payload = arg0.ok_or("Missing payment payload")?;
    let collect_outstanding = payments::payload_collects_outstanding_balance(&payload);
    if collect_outstanding {
        sanitize_outstanding_collection_trust_fields(&mut payload)?;
        if let Err(error_code) = validate_outstanding_idempotency_key(&payload) {
            return Ok(outstanding_idempotency_error_response(error_code));
        }
    }
    let requested_input = payments::build_payment_record_input(&payload)?;
    let terminal_approved = payment_payload_has_terminal_approval(&payload);
    if requested_input.method == "twint" {
        let order_id = {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            resolve_order_id(&conn, &requested_input.order_id).ok_or("Order not found")?
        };
        let _reservation = reserve_payment_record(&order_id)?;
        return save_manual_twint_existing_receipt(
            &db,
            &order_id,
            &payload,
            &crate::unsaved_payments::MOVED_MONEY_SAVE_DELAYS_MS,
        )
        .await;
    }
    let order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let order_id =
            resolve_order_id(&conn, &requested_input.order_id).ok_or("Order not found")?;
        if let Some(refusal) = refuse_new_tender_while_unsaved(&conn, &order_id, terminal_approved)?
        {
            return Ok(refusal);
        }
        order_id
    };
    // Keep two renderer invocations for the same order from reaching fiscal
    // hardware concurrently. The reservation is process-local and releases on
    // every return path, including fiscal rejection and persistence errors.
    let _reservation = reserve_payment_record(&order_id)?;
    let (balance, initial_settlement) = if collect_outstanding {
        let settlement = {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            load_order_settlement_read_transaction(&conn, &order_id)?
        };
        let balance = payments::OrderPaymentBalanceSnapshot {
            order_total: settlement.order_total,
            net_paid: settlement.net_paid,
            outstanding_amount: settlement.outstanding_amount,
            completed_payment_count: settlement.completed_payments.len() as i64,
            ledger_generation: settlement.ledger_generation,
        };
        (balance, Some(settlement))
    } else {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        (
            payments::load_order_payment_balance_snapshot(&conn, &order_id)?,
            None,
        )
    };
    if collect_outstanding {
        let settlement = initial_settlement
            .as_ref()
            .expect("collect-outstanding settlement was loaded");
        if let Err(response) = validate_collect_outstanding_generation(&payload, settlement) {
            return Ok(response);
        }
        payments::prepare_outstanding_collection_payload(&mut payload, balance)?;
    }
    let input = payments::build_payment_record_input(&payload)?;
    let direct_sale_refusal = {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        crate::commands::ecr::direct_sale_admission(
            &conn,
            &order_id,
            if terminal_approved {
                Some(&input)
            } else {
                None
            },
        )
        .err()
    };
    if let Some(error) = direct_sale_refusal {
        // A card the terminal already approved is money that moved: never
        // refused and never lost (founder rule, 30/09/2026). While an earlier
        // direct SALE of the order is unresolved it cannot be booked, so it is
        // held as a charged payment not saved: a durable record that holds
        // the Z, saved again (the same write, no new charge) once the SALE is
        // reconciled, or given back by a manager. Anything else moved nothing
        // and is refused before any fiscal dispatch or write.
        if terminal_approved && input.method == "card" {
            if let Some(entry) = crate::unsaved_payments::UnsavedChargedPayment::for_payment(
                &order_id,
                &payload,
                None,
                &Utc::now().to_rfc3339(),
            ) {
                return Ok(crate::unsaved_payments::save_charged_payment(
                    &db,
                    entry,
                    &crate::unsaved_payments::MOVED_MONEY_SAVE_DELAYS_MS,
                    Some(serde_json::json!({ "directSaleReconciliationRequired": true })),
                    crate::unsaved_payments::write_recorded_payment,
                )
                .await);
            }
        }
        return Ok(serde_json::json!({
            "success": false,
            "errorCode": "DIRECT_SALE_RECONCILIATION_REQUIRED",
            "paymentApproved": false,
            "paymentPersisted": false,
            "requiresReconciliation": true,
            "error": error,
        }));
    }
    let mut committed_fiscal_checkout = None;

    // A normal pay-later order with one full-balance cash/card collection must
    // use the same cashier-first flow as initial checkout. Split payments and
    // a card payment already approved by a directly integrated EFT terminal
    // retain their existing collection paths.
    if should_fiscalize_full_balance_before_record(
        &input,
        terminal_approved,
        collect_outstanding,
        balance,
    ) {
        let order = crate::sync::get_order_by_id(&db, &order_id)?;
        let payment_idempotency_key = if collect_outstanding {
            Some(
                validate_outstanding_idempotency_key(&payload)
                    .expect("collect-outstanding idempotency was validated"),
            )
        } else {
            None
        };
        let prior_settlement = if collect_outstanding {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            Some(load_order_settlement_read_transaction(&conn, &order_id)?)
        } else {
            None
        };
        if let Some(snapshot) = prior_settlement.as_ref() {
            let same_generation = (snapshot.order_total - balance.order_total).abs() <= 0.001
                && (snapshot.net_paid - balance.net_paid).abs() <= 0.001
                && (snapshot.outstanding_amount - balance.outstanding_amount).abs() <= 0.001
                && snapshot.completed_payments.len() as i64 == balance.completed_payment_count
                && snapshot.ledger_generation == balance.ledger_generation;
            if !same_generation {
                return Ok(collect_outstanding_error_response(
                    "BALANCE_CHANGED",
                    "The order balance changed before fiscal checkout. Refresh the payment details before collecting it.",
                    snapshot,
                ));
            }
        }
        let fiscal_reference = if collect_outstanding {
            outstanding_collection_fiscal_reference(
                &order_id,
                balance,
                payment_idempotency_key.expect("outstanding collection requires idempotency"),
            )
        } else {
            order_id.clone()
        };
        let checkout = match crate::commands::ecr::fiscal_checkout_for_order_payload(
            &db,
            &mgr,
            &fiscal_reference,
            &order,
            &payload,
            prior_settlement
                .as_ref()
                .map(|snapshot| snapshot.completed_payments.as_slice()),
        )
        .await
        {
            Ok(checkout) => checkout,
            Err(error) => {
                return Ok(serde_json::json!({
                    "success": false,
                    "errorCode": "FISCAL_CHECKOUT_NOT_APPROVED",
                    "paymentApproved": false,
                    "paymentPersisted": false,
                    "error": error,
                }));
            }
        };

        if checkout.get("success").and_then(|value| value.as_bool()) != Some(true)
            || checkout.get("approved").and_then(|value| value.as_bool()) != Some(true)
        {
            return Ok(fiscal_checkout_not_approved_response(checkout));
        }

        if checkout.get("skipped").and_then(|value| value.as_bool()) != Some(true) {
            committed_fiscal_checkout = Some(checkout.clone());
            let transaction = checkout
                .get("transaction")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            if let Some(payment) = payload.as_object_mut() {
                if let Some(transaction_id) = transaction
                    .get("transactionId")
                    .and_then(|value| value.as_str())
                {
                    payment.insert(
                        "transactionRef".to_string(),
                        serde_json::Value::String(transaction_id.to_string()),
                    );
                    if collect_outstanding {
                        payment.insert(
                            "idempotencyKey".to_string(),
                            serde_json::Value::String(transaction_id.to_string()),
                        );
                    }
                }
                payment.insert(
                    "fiscalReceiptNumber".to_string(),
                    transaction
                        .get("fiscalReceiptNumber")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
                if input.method == "card" {
                    payment.insert("terminalApproved".to_string(), serde_json::json!(true));
                    payment.insert("paymentOrigin".to_string(), serde_json::json!("terminal"));
                    if let Some(device_id) =
                        transaction.get("deviceId").and_then(|value| value.as_str())
                    {
                        payment.insert(
                            "terminalDeviceId".to_string(),
                            serde_json::Value::String(device_id.to_string()),
                        );
                    }
                }
            }
        }
    }

    // Card money that already moved (the terminal or the fiscal device
    // approved it) is saved with its durable record and bounded retries, and
    // is never answered with a generic failure that invites a second charge
    // (fix review 30/09/2026, Android 1.0.13 parity). Cash is unchanged.
    let card_money_moved = input.method == "card"
        && (payment_payload_has_terminal_approval(&payload) || committed_fiscal_checkout.is_some());
    if card_money_moved {
        let captured_at = Utc::now().to_rfc3339();
        if let Some(entry) = crate::unsaved_payments::UnsavedChargedPayment::for_payment(
            &order_id,
            &payload,
            collect_outstanding.then_some(&balance),
            &captured_at,
        ) {
            let extra = committed_fiscal_checkout
                .as_ref()
                .map(|checkout| serde_json::json!({ "fiscalCheckout": checkout }));
            return Ok(crate::unsaved_payments::save_charged_payment(
                &db,
                entry,
                &crate::unsaved_payments::MOVED_MONEY_SAVE_DELAYS_MS,
                extra,
                crate::unsaved_payments::write_recorded_payment,
            )
            .await);
        }
    }

    if collect_outstanding {
        match payments::record_payment_with_expected_balance(&db, &payload, Some(balance)) {
            Ok(result) => Ok(result),
            Err(error) => match committed_fiscal_checkout.as_ref() {
                Some(checkout) => {
                    tracing::error!(
                        target: "payments.outstanding_reconciliation",
                        order_id = %order_id,
                        transaction_id = ?checkout
                            .get("transaction")
                            .and_then(|transaction| transaction.get("transactionId")),
                        error = %error,
                        "Fiscal payment approved but local payment persistence failed"
                    );
                    Ok(post_fiscal_persistence_failure_response(&error, checkout))
                }
                None => Err(error),
            },
        }
    } else {
        payments::record_payment(&db, &payload)
    }
}

pub(crate) async fn save_manual_twint_existing_receipt(
    db: &db::DbState,
    order_id: &str,
    payload: &serde_json::Value,
    delays: &[u64],
) -> Result<serde_json::Value, String> {
    let entry = crate::unsaved_payments::UnsavedChargedPayment::for_manual_twint_payment(
        db,
        order_id,
        payload,
        &Utc::now().to_rfc3339(),
    )?;
    Ok(crate::unsaved_payments::save_charged_payment(
        db,
        entry,
        delays,
        None,
        crate::unsaved_payments::write_recorded_payment,
    )
    .await)
}

pub(crate) fn validate_manual_twint_outstanding_context(
    conn: &rusqlite::Connection,
    order_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let settlement = load_order_settlement_read_transaction(conn, order_id)?;
    validate_collect_outstanding_generation(payload, &settlement).map_err(|answer| {
        answer
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("TWINT_RECEIPT_OUTSTANDING_CONTEXT_CHANGED")
            .to_string()
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveSetAsidePaymentPayload {
    #[serde(alias = "payment_id")]
    payment_id: String,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default, alias = "resolved_by")]
    resolved_by: Option<String>,
}

/// "Money given back to the customer" for a payment set aside as a possible
/// duplicate (`payments_need_review`). A money decision, so it needs the
/// desktop's manager approval for money actions: an active cashier or
/// manager shift on this terminal and a fresh PIN confirmation
/// (`CashDrawerControl`). Local only: the server never recorded the payment,
/// so nothing is queued. Idempotent. Answers with the remaining unresolved
/// set-aside payments, read fresh after the write.
pub(crate) fn resolve_set_aside_payment_guarded(
    db: &db::DbState,
    auth_state: &crate::auth::AuthState,
    arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, crate::auth::GuardedCommandError> {
    let payload: ResolveSetAsidePaymentPayload =
        serde_json::from_value(arg0.ok_or("Missing set-aside payment payload")?)
            .map_err(|error| format!("Invalid set-aside payment payload: {error}"))?;
    let payment_id = payload.payment_id.trim().to_string();
    if payment_id.is_empty() {
        return Err("Missing paymentId".into());
    }
    if let Some(outcome) = payload.outcome.as_deref().map(str::trim) {
        if !outcome.is_empty() && outcome != crate::payment_review::RETURNED_TO_CUSTOMER_OUTCOME {
            return Err(format!("Unsupported set-aside payment outcome: {outcome}").into());
        }
    }

    // With nobody on shift at this terminal (the Z needs everyone checked
    // out), a manager approves with their own PIN and is the one named
    // (fix review 30/09/2026).
    let approver = crate::auth::authorize_money_action(
        crate::auth::MoneyApproval::VoidPayments,
        db,
        auth_state,
    )?;

    let session = crate::auth::get_session_json(auth_state);
    let resolved_by = approver.manager_staff_id.clone().or_else(|| {
        payload
            .resolved_by
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .or_else(|| {
                ["databaseStaffId", "staffId"].iter().find_map(|key| {
                    session
                        .get(*key)
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string)
                })
            })
    });

    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let outcome = crate::payment_review::resolve_set_aside_payment_in_connection(
        &conn,
        &payment_id,
        resolved_by.as_deref(),
        &now,
    )?;
    let (order_id, already_resolved) = match &outcome {
        crate::payment_review::ResolveOutcome::Resolved { order_id, .. } => {
            (order_id.clone(), false)
        }
        crate::payment_review::ResolveOutcome::AlreadyResolved { order_id } => {
            (order_id.clone(), true)
        }
    };
    let branch_id = crate::storage::get_credential("branch_id").unwrap_or_default();
    let remaining =
        crate::payment_review::load_unresolved_set_aside_payments(&conn, &branch_id, None)?.len();
    Ok(serde_json::json!({
        "success": true,
        "paymentId": payment_id,
        "orderId": order_id,
        "outcome": crate::payment_review::RETURNED_TO_CUSTOMER_OUTCOME,
        "alreadyResolved": already_resolved,
        "resolvedAt": now,
        "remainingSetAsidePayments": remaining,
    }))
}

#[tauri::command]
pub async fn payment_resolve_set_aside(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, crate::auth::AuthState>,
) -> Result<serde_json::Value, crate::auth::GuardedCommandError> {
    resolve_set_aside_payment_guarded(&db, &auth_state, arg0)
}

/// A charged payment of this order is not saved yet (fix review 30/09/2026):
/// no new tender starts, so nothing is charged and nothing is written (cash,
/// a manual card, a room charge, a fiscal-device checkout). A card the
/// terminal already approved is money that moved: it is never refused here,
/// it is saved like any other.
pub(crate) fn refuse_new_tender_while_unsaved(
    conn: &rusqlite::Connection,
    order_id: &str,
    terminal_approved: bool,
) -> Result<Option<serde_json::Value>, String> {
    if terminal_approved {
        return Ok(None);
    }
    let pending = crate::unsaved_payments::list(conn, Some(order_id))?;
    Ok((!pending.is_empty())
        .then(|| crate::unsaved_payments::pending_refusal_response(order_id, &pending)))
}

/// The order and/or record a "charged, not saved" call names.
fn parse_unsaved_payment_target(
    arg0: Option<serde_json::Value>,
) -> (Option<String>, Option<String>) {
    let text = |value: Option<&serde_json::Value>| {
        value
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    };
    match arg0 {
        Some(serde_json::Value::String(order_id)) => (
            Some(order_id.trim().to_string()).filter(|value| !value.is_empty()),
            None,
        ),
        Some(payload) => (
            text(payload.get("orderId").or_else(|| payload.get("order_id"))),
            text(
                payload
                    .get("idempotencyKey")
                    .or_else(|| payload.get("idempotency_key")),
            ),
        ),
        None => (None, None),
    }
}

/// Charged payments this till could not save yet (for one order, or all):
/// the payment surfaces' banner and their check before any new charge.
pub(crate) fn list_unsaved_payments(
    db: &db::DbState,
    arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let (order_id, idempotency_key) = parse_unsaved_payment_target(arg0);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = order_id.map(|id| resolve_order_id(&conn, &id).unwrap_or(id));
    let payments = crate::unsaved_payments::list(&conn, order_id.as_deref())?
        .iter()
        .filter(|entry| {
            idempotency_key
                .as_deref()
                .map_or(true, |key| entry.idempotency_key == key)
        })
        .map(crate::unsaved_payments::summary_json)
        .collect::<Vec<_>>();
    Ok(serde_json::json!({ "success": true, "payments": payments }))
}

#[tauri::command]
pub async fn payment_list_unsaved(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    list_unsaved_payments(&db, arg0)
}

/// "Save payment again": replays the same writes with the same keys (no new
/// charge) for one order, or for the one record named. Held under the same
/// per-order reservation as a collection.
pub(crate) async fn save_unsaved_payments_with_delays(
    db: &db::DbState,
    arg0: Option<serde_json::Value>,
    delays_ms: &[u64],
    invalidator: &dyn crate::print::PrintQueueInvalidator,
) -> Result<serde_json::Value, String> {
    let (order_id, idempotency_key) = parse_unsaved_payment_target(arg0);
    let order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        match (order_id, idempotency_key.as_deref()) {
            (Some(order_id), _) => resolve_order_id(&conn, &order_id).unwrap_or(order_id),
            (None, Some(key)) => crate::unsaved_payments::load(&conn, key)?
                .map(|entry| entry.order_id)
                .ok_or("No charged payment waits to be saved under that key")?,
            (None, None) => return Err("Missing orderId or idempotencyKey".to_string()),
        }
    };
    let _reservation = reserve_payment_record(&order_id)?;
    crate::unsaved_payments::save_unsaved_payments(
        db,
        Some(&order_id),
        idempotency_key.as_deref(),
        delays_ms,
        invalidator,
    )
    .await
}

#[tauri::command]
pub async fn payment_save_unsaved(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    save_unsaved_payments_with_delays(
        &db,
        arg0,
        &crate::unsaved_payments::MOVED_MONEY_SAVE_DELAYS_MS,
        &app,
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveUnsavedPaymentPayload {
    #[serde(alias = "idempotency_key")]
    idempotency_key: String,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default, alias = "resolved_by")]
    resolved_by: Option<String>,
}

/// "Money given back to the customer" for a charged payment this till could
/// not save (`payments_not_saved`). Authorized like the set-aside decision:
/// the desktop's approval for money actions (a cashier or manager shift on
/// this terminal and a fresh PIN, `CashDrawerControl`). Local only: the audit
/// entry is written before the record goes; the order is left as it is.
/// Idempotent. Answers with the records left, read after the write.
pub(crate) fn resolve_unsaved_payment_guarded(
    db: &db::DbState,
    auth_state: &crate::auth::AuthState,
    arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, crate::auth::GuardedCommandError> {
    let payload: ResolveUnsavedPaymentPayload =
        serde_json::from_value(arg0.ok_or("Missing charged payment payload")?)
            .map_err(|error| format!("Invalid charged payment payload: {error}"))?;
    let idempotency_key = payload.idempotency_key.trim().to_string();
    if idempotency_key.is_empty() {
        return Err("Missing idempotencyKey".into());
    }
    if let Some(outcome) = payload.outcome.as_deref().map(str::trim) {
        if !outcome.is_empty() && outcome != crate::unsaved_payments::RETURNED_TO_CUSTOMER_OUTCOME {
            return Err(format!("Unsupported charged payment outcome: {outcome}").into());
        }
    }

    // With nobody on shift at this terminal (the Z needs everyone checked
    // out), a manager approves with their own PIN and is the one named
    // (fix review 30/09/2026).
    let approver = crate::auth::authorize_money_action(
        crate::auth::MoneyApproval::VoidPayments,
        db,
        auth_state,
    )?;

    let session = crate::auth::get_session_json(auth_state);
    let resolved_by = approver.manager_staff_id.clone().or_else(|| {
        payload
            .resolved_by
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .or_else(|| {
                ["databaseStaffId", "staffId"].iter().find_map(|key| {
                    session
                        .get(*key)
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string)
                })
            })
    });

    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let outcome = crate::unsaved_payments::resolve_in_connection(
        &conn,
        &idempotency_key,
        resolved_by.as_deref(),
        &now,
    )?;
    let order_id = match &outcome {
        crate::unsaved_payments::ResolveOutcome::Resolved { order_id, .. } => {
            Some(order_id.clone())
        }
        _ => None,
    };
    let remaining = crate::unsaved_payments::count(&conn)?;
    Ok(serde_json::json!({
        "success": !matches!(outcome, crate::unsaved_payments::ResolveOutcome::NotFound),
        "idempotencyKey": idempotency_key,
        "orderId": order_id,
        "outcome": crate::unsaved_payments::RETURNED_TO_CUSTOMER_OUTCOME,
        "result": outcome.as_str(),
        "resolvedAt": now,
        "remainingUnsavedPayments": remaining,
    }))
}

#[tauri::command]
pub async fn payment_resolve_unsaved(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, crate::auth::AuthState>,
) -> Result<serde_json::Value, crate::auth::GuardedCommandError> {
    resolve_unsaved_payment_guarded(&db, &auth_state, arg0)
}

#[tauri::command]
pub async fn payment_void(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_payment_void_payload(arg0)?;
    payments::void_payment(
        &db,
        &payload.payment_id,
        &payload.reason,
        payload.voided_by.as_deref(),
        payload.staff_shift_id.as_deref(),
    )
}

#[tauri::command]
pub async fn payment_get_order_payments(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_order_id_payload(arg0)?;
    payments::get_order_payments(&db, &order_id)
}

#[tauri::command]
pub async fn payment_get_settlement_snapshot(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_order_id_payload(arg0)?;
    let mut snapshot = payments::get_order_settlement_snapshot(&db, &order_id)?;
    let actual_order_id = snapshot
        .get("orderId")
        .and_then(serde_json::Value::as_str)
        .ok_or("Settlement snapshot has no order identity")?
        .to_string();
    let actual_order_id = actual_order_id.as_str();
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    let sale = crate::commands::ecr::direct_sale_projection(&conn, actual_order_id)?;
    snapshot["unresolvedDirectSale"] = sale;
    // Why a cancel of this order would be refused (founder rule 30/09 and
    // 01/10/2026), so the cashier is told before any reason or PIN; the
    // cancel itself refuses again. Null when it may be cancelled (a
    // platform order's settlement row included, which `netPaid` still
    // counts); absent when the ledger could not be read (the cancel then
    // decides, and the renderer falls back to `netPaid`).
    match crate::commands::orders::cancel_refusal_code(&conn, actual_order_id) {
        Ok(code) => {
            snapshot["cancelRefusal"] = code
                .map(|code| serde_json::Value::String(code.to_string()))
                .unwrap_or(serde_json::Value::Null);
        }
        Err(error) => {
            tracing::warn!(
                order_id = %actual_order_id,
                error = %error,
                "Cancel refusal could not be read for the settlement snapshot"
            );
        }
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn payment_get_receipt_preview(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_order_id_payload(arg0)?;
    payments::get_receipt_preview(&db, &order_id)
}

#[tauri::command]
pub async fn payment_get_paid_items(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_order_id_payload(arg0)?;
    payments::get_paid_items(&db, &order_id)
}

#[tauri::command]
pub async fn payment_print_split_receipt(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payment_id = parse_payment_id_payload(arg0)?;
    if !crate::print::is_print_action_enabled(&db, "split_receipt") {
        return Ok(serde_json::json!({ "success": true, "skipped": true }));
    }
    // Use split_receipt entity type for the print pipeline
    let enqueue_result =
        crate::print::enqueue_print_job(&db, "split_receipt", &payment_id, None, &app)?;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    crate::print::spawn_pending_job_processing(
        app.clone(),
        data_dir,
        format!("split receipt for payment {payment_id}"),
    );

    Ok(enqueue_result)
}

#[tauri::command]
pub async fn refund_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing refund payload")?;
    refunds::refund_payment(&db, &payload)
}

#[tauri::command]
pub async fn refund_void_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_refund_void_payload(arg0)?;
    refunds::void_payment_with_adjustment(
        &db,
        &payload.payment_id,
        &payload.reason,
        payload.staff_id.as_deref(),
        payload.staff_shift_id.as_deref(),
    )
}

#[tauri::command]
pub async fn refund_list_order_adjustments(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_order_id_payload(arg0)?;
    refunds::list_order_adjustments(&db, &order_id)
}

#[tauri::command]
pub async fn refund_get_payment_balance(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payment_id = parse_payment_id_payload(arg0)?;
    refunds::get_payment_balance(&db, &payment_id)
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    fn manual_existing_fixture(action: &str) -> (crate::tests::harness::TestDb, serde_json::Value) {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        for (key, value) in [
            ("organization_id", "manual-org"),
            ("branch_id", "manual-branch"),
            ("terminal_id", "manual-terminal"),
        ] {
            db::set_setting(&conn, "terminal", key, value).unwrap();
        }
        db::set_setting(&conn, "organization", "currency", "CHF").unwrap();
        conn.execute("INSERT INTO staff_shifts(id,staff_id,staff_name,branch_id,terminal_id,role_type,check_in_time,opening_cash_amount,status,sync_status,created_at,updated_at) VALUES ('manual-shift','manual-cashier','Cashier','manual-branch','manual-terminal','cashier','now',0,'active','pending','now','now')",[]).unwrap();
        conn.execute("INSERT INTO orders(id,branch_id,items,total_amount,total_amount_cents,status,order_type,payment_status,sync_status,created_at,updated_at) VALUES ('manual-order','manual-branch','[]',12,1200,'completed','takeaway','pending','pending','now','now')",[]).unwrap();
        let generation = payments::settlement_generation_token(
            &payments::load_order_settlement_snapshot(&conn, "manual-order")
                .unwrap()
                .ledger_generation,
        );
        drop(conn);
        let payload = serde_json::json!({"orderId":"manual-order","method":"twint","amount":12,"currency":"CHF","idempotencyKey":"manual-existing-key","paymentOrigin":"manual","staffId":"manual-cashier","staffShiftId":"manual-shift","collectedBy":"cashier_drawer","collectOutstandingBalance":true,"expectedSettlementGeneration":generation,"metadata":{"provider":"twint","confirmation":"cashier","confirmation_action":action,"qr_mode":"static_qr_manual"}});
        (db, payload)
    }

    fn fail_manual_write(db: &db::DbState) {
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_manual_write BEFORE INSERT ON order_payments WHEN NEW.method='twint' BEGIN SELECT RAISE(ABORT,'injected ledger failure'); END;").unwrap();
    }

    #[tokio::test]
    async fn twint_existing_partial_receipt_is_durable_without_expanding_to_outstanding_total() {
        let (db, mut payload) = manual_existing_fixture("skip");
        payload["amount"] = serde_json::json!(5);
        payload
            .as_object_mut()
            .unwrap()
            .remove("collectOutstandingBalance");
        payload
            .as_object_mut()
            .unwrap()
            .remove("expectedSettlementGeneration");
        db.state.conn.lock().unwrap().execute_batch("CREATE TRIGGER require_twint_fullsync BEFORE INSERT ON order_payments WHEN NEW.method='twint' AND (SELECT synchronous FROM pragma_synchronous)<>2 BEGIN SELECT RAISE(ABORT,'manual receipt requires FULL synchronous'); END;").unwrap();
        let saved = save_manual_twint_existing_receipt(&db.state, "manual-order", &payload, &[])
            .await
            .unwrap();
        assert_eq!(saved["success"], true, "{saved}");
        let db = db.restart();
        let conn = db.state.conn.lock().unwrap();
        let balance = payments::load_order_payment_balance_snapshot(&conn, "manual-order").unwrap();
        assert_eq!(balance.net_paid, 5.0);
        assert_eq!(balance.outstanding_amount, 7.0);
        assert_eq!(conn.query_row("SELECT amount_cents FROM order_payments WHERE idempotency_key='manual-existing-key'",[],|r|r.get::<_,i64>(0)).unwrap(),500);
        assert!(crate::unsaved_payments::list(&conn, Some("manual-order"))
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn twint_existing_receipt_failure_restart_saves_original_exactly_once() {
        for action in ["confirm", "skip"] {
            let (db, payload) = manual_existing_fixture(action);
            fail_manual_write(&db.state);
            let first =
                save_manual_twint_existing_receipt(&db.state, "manual-order", &payload, &[])
                    .await
                    .unwrap();
            assert_eq!(first["paymentNotSaved"], true);
            assert_eq!(first["manualReceiptConfirmed"], true);
            assert!(first["paymentApproved"].is_null());
            let db = db.restart();
            let original = {
                let conn = db.state.conn.lock().unwrap();
                let held = crate::unsaved_payments::list(&conn, Some("manual-order")).unwrap();
                assert_eq!(held.len(), 1);
                let original = held[0].clone();
                assert_eq!(original.kind, "manual_twint_payment");
                assert_eq!(original.amount_cents, 1200);
                assert_eq!(original.idempotency_key, "manual-existing-key");
                assert_eq!(
                    original.manual_scope.as_deref(),
                    Some("manual-org|manual-branch|manual-terminal")
                );
                assert_eq!(original.request["metadata"], payload["metadata"]);
                assert_eq!(original.request["staffShiftId"], "manual-shift");
                assert_eq!(original.request["staffId"], "manual-cashier");
                assert_eq!(
                    original.request["expectedSettlementGeneration"],
                    payload["expectedSettlementGeneration"]
                );
                assert!(original.expected_balance.is_some());
                assert!(original.transaction_ref.is_none());
                let blockers = crate::payment_integrity::load_payments_not_saved_blockers(
                    &conn,
                    "manual-branch",
                )
                .unwrap();
                assert_eq!(blockers.len(), 1);
                assert_eq!(blockers[0].payment_method, "twint");
                assert!(blockers[0].reason_text.contains("cashier confirmed"));
                assert_eq!(
                    conn.query_row("SELECT count(*) FROM order_payments", [], |r| r
                        .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
                conn.execute_batch("DROP TRIGGER fail_manual_write;")
                    .unwrap();
                original
            };
            let saved = crate::unsaved_payments::save_unsaved_payments(
                &db.state,
                Some("manual-order"),
                Some(&original.idempotency_key),
                &[],
                &crate::print::NoopPrintQueueInvalidator,
            )
            .await
            .unwrap();
            assert_eq!(saved["success"], true, "{saved}");
            assert_eq!(saved["saved"], 1);
            let again =
                save_manual_twint_existing_receipt(&db.state, "manual-order", &payload, &[])
                    .await
                    .unwrap();
            assert_eq!(again["success"], true, "{again}");
            let conn = db.state.conn.lock().unwrap();
            assert!(crate::unsaved_payments::list(&conn, Some("manual-order"))
                .unwrap()
                .is_empty());
            assert_eq!(
                conn.query_row("SELECT count(*) FROM order_payments", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM orders", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            let (amount,key,metadata,reference,staff):(i64,String,String,Option<String>,String)=conn.query_row("SELECT amount_cents,idempotency_key,metadata,transaction_ref,staff_id FROM order_payments",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
            assert_eq!(amount, 1200);
            assert_eq!(key, original.idempotency_key);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&metadata).unwrap(),
                payload["metadata"]
            );
            assert!(reference.is_none());
            assert_eq!(staff, "manual-cashier");
            let snapshot = payments::load_order_settlement_snapshot(&conn, "manual-order").unwrap();
            assert_eq!(
                snapshot.completed_payments[0]["idempotencyKey"],
                original.idempotency_key
            );
        }
    }

    #[tokio::test]
    async fn twint_existing_receipt_refuses_changed_scope_order_action_and_balance_without_replacing_original(
    ) {
        for changed in ["scope", "total", "action", "balance"] {
            let (db, payload) = manual_existing_fixture("skip");
            fail_manual_write(&db.state);
            save_manual_twint_existing_receipt(&db.state, "manual-order", &payload, &[])
                .await
                .unwrap();
            let db = db.restart();
            let mut replay = payload.clone();
            {
                let conn = db.state.conn.lock().unwrap();
                conn.execute_batch("DROP TRIGGER fail_manual_write;")
                    .unwrap();
                match changed {
                    "scope" => {
                        db::set_setting(&conn, "terminal", "organization_id", "other-org").unwrap()
                    }
                    "total" => {
                        conn.execute("UPDATE orders SET total_amount=15,total_amount_cents=1500 WHERE id='manual-order'",[]).unwrap();
                    }
                    "balance" => {
                        conn.execute("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,payment_origin,idempotency_key,created_at,updated_at) VALUES ('other-cash','manual-order','cash',2,200,'CHF','completed','manual','other-key','now','now')",[]).unwrap();
                    }
                    _ => {
                        replay["metadata"]["confirmation_action"] = serde_json::json!("confirm");
                    }
                }
            }
            if changed == "action" {
                assert!(save_manual_twint_existing_receipt(
                    &db.state,
                    "manual-order",
                    &replay,
                    &[]
                )
                .await
                .unwrap_err()
                .contains("ORIGINAL_CONFLICT"));
            } else {
                let saved = crate::unsaved_payments::save_unsaved_payments(
                    &db.state,
                    Some("manual-order"),
                    Some("manual-existing-key"),
                    &[],
                    &crate::print::NoopPrintQueueInvalidator,
                )
                .await
                .unwrap();
                assert_eq!(saved["success"], false);
                assert_eq!(saved["saved"], 0);
            }
            let conn = db.state.conn.lock().unwrap();
            let held = crate::unsaved_payments::list(&conn, Some("manual-order")).unwrap();
            assert_eq!(held.len(), 1);
            assert_eq!(held[0].amount_cents, 1200);
            assert_eq!(held[0].request["metadata"]["confirmation_action"], "skip");
            assert_eq!(
                held[0].manual_scope.as_deref(),
                Some("manual-org|manual-branch|manual-terminal")
            );
            assert_eq!(
                conn.query_row(
                    "SELECT count(*) FROM order_payments WHERE method='twint'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        }
    }

    #[tokio::test]
    async fn twint_existing_receipt_does_not_adopt_a_conflicting_saved_row() {
        let (db, payload) = manual_existing_fixture("skip");
        fail_manual_write(&db.state);
        save_manual_twint_existing_receipt(&db.state, "manual-order", &payload, &[])
            .await
            .unwrap();
        {
            let conn = db.state.conn.lock().unwrap();
            conn.execute_batch("DROP TRIGGER fail_manual_write;")
                .unwrap();
            let mut wrong = payload["metadata"].clone();
            wrong["confirmation_action"] = serde_json::json!("confirm");
            conn.execute("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,payment_origin,idempotency_key,metadata,created_at,updated_at) VALUES ('conflict','manual-order','twint',12,1200,'CHF','completed','manual','manual-existing-key',?1,'now','now')",[wrong.to_string()]).unwrap();
            assert_eq!(
                crate::unsaved_payments::list(&conn, Some("manual-order"))
                    .unwrap()
                    .len(),
                1
            );
        }
        let db = db.restart();
        let saved = crate::unsaved_payments::save_unsaved_payments(
            &db.state,
            Some("manual-order"),
            Some("manual-existing-key"),
            &[],
            &crate::print::NoopPrintQueueInvalidator,
        )
        .await
        .unwrap();
        assert_eq!(saved["success"], false);
        assert_eq!(saved["saved"], 0);
        assert_eq!(
            crate::unsaved_payments::list(&db.state.conn.lock().unwrap(), Some("manual-order"))
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn twint_existing_receipt_keeps_card_unknown_sale_and_platform_guards() {
        for prior in ["card", "sale", "platform", "gift"] {
            let (db, payload) = manual_existing_fixture("confirm");
            {
                let conn = db.state.conn.lock().unwrap();
                if prior == "card" {
                    let entry=crate::unsaved_payments::UnsavedChargedPayment::for_payment("manual-order",&serde_json::json!({"orderId":"manual-order","method":"card","amount":12,"transactionRef":"charged-card","terminalApproved":true}),None,"now").unwrap();
                    crate::unsaved_payments::record(&conn, &entry).unwrap();
                } else if prior == "sale" {
                    conn.execute("INSERT INTO ecr_devices(id,name,device_type,brand,protocol,connection_type,connection_details) VALUES ('device','Reader','payment_terminal','test','test','network','{}')",[]).unwrap();
                    conn.execute("INSERT INTO ecr_transactions(id,device_id,order_id,transaction_type,amount,currency,status,started_at) VALUES ('prior','device','manual-order','sale',1200,'CHF','timeout','now')",[]).unwrap();
                } else if prior == "gift" {
                    conn.execute("INSERT INTO gift_card_redemption_attempts(idempotency_key,organization_id,branch_id,terminal_id,local_order_id,remote_order_id,amount_cents,currency,card_fingerprint,request_fingerprint,status,created_at,updated_at) VALUES ('gift-original','manual-org','manual-branch','manual-terminal','manual-order','remote',1200,'CHF','fingerprint','request','pending','now','now')",[]).unwrap();
                } else {
                    conn.execute("UPDATE orders SET plugin='efood',ghost_metadata=?1 WHERE id='manual-order'",[r#"{"food_delivery":{"payment_method":"card","prepaid":true,"delivery_provider":"platform_delivery"}}"#]).unwrap();
                }
            }
            let answer =
                save_manual_twint_existing_receipt(&db.state, "manual-order", &payload, &[])
                    .await
                    .unwrap();
            assert_eq!(answer["success"], false, "{prior}: {answer}");
            assert!(answer["paymentApproved"].is_null());
            let db = db.restart();
            let conn = db.state.conn.lock().unwrap();
            assert_eq!(
                conn.query_row("SELECT count(*) FROM order_payments", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert!(crate::unsaved_payments::list(&conn, Some("manual-order"))
                .unwrap()
                .iter()
                .any(|e| e.kind == "manual_twint_payment"));
            if prior == "card" {
                assert_eq!(
                    crate::unsaved_payments::list(&conn, Some("manual-order"))
                        .unwrap()
                        .len(),
                    2
                );
            }
        }
    }

    #[tokio::test]
    async fn twint_existing_receipt_storage_failure_refuses_without_claiming_a_durable_holder() {
        let (db, payload) = manual_existing_fixture("confirm");
        db.state.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_manual_holder BEFORE INSERT ON local_settings WHEN NEW.setting_category='unsaved_charged_payment' BEGIN SELECT RAISE(ABORT,'injected journal failure'); END;").unwrap();
        let answer = save_manual_twint_existing_receipt(&db.state, "manual-order", &payload, &[])
            .await
            .unwrap();
        assert_eq!(answer["success"], false);
        assert_eq!(answer["manualReceiptRetained"], false);
        assert_eq!(answer["paymentPersisted"], false);
        assert!(answer["message"]
            .as_str()
            .unwrap()
            .contains("could not retain"));
        let db = db.restart();
        let conn = db.state.conn.lock().unwrap();
        assert!(crate::unsaved_payments::list(&conn, None)
            .unwrap()
            .is_empty());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM order_payments", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn parse_payment_update_status_supports_legacy_args() {
        let parsed = parse_payment_update_status_payload(
            Some(serde_json::json!("order-1")),
            Some("paid".to_string()),
            Some("card".to_string()),
        )
        .expect("legacy args should parse");
        assert_eq!(parsed.order_id, "order-1");
        assert_eq!(parsed.payment_status, "paid");
        assert_eq!(parsed.payment_method.as_deref(), Some("card"));
    }

    #[test]
    fn parse_payment_method_update_supports_legacy_args() {
        let parsed = parse_payment_method_update_payload(
            Some(serde_json::json!("order-2")),
            Some("cash".to_string()),
        )
        .expect("legacy method edit args should parse");
        assert_eq!(parsed.order_id, "order-2");
        assert_eq!(parsed.payment_method, "cash");
    }

    #[test]
    fn parse_payment_method_update_supports_explicit_payment_target() {
        let parsed = parse_payment_method_update_payload(
            Some(serde_json::json!({
                "orderId": "order-split-1",
                "paymentId": "payment-split-2",
                "paymentMethod": "card"
            })),
            None,
        )
        .expect("targeted payment method edit payload should parse");
        assert_eq!(parsed.order_id, "order-split-1");
        assert_eq!(parsed.payment_id.as_deref(), Some("payment-split-2"));
        assert_eq!(parsed.payment_method, "card");
    }

    #[test]
    fn parse_payment_update_status_supports_object_payload() {
        let parsed = parse_payment_update_status_payload(
            Some(serde_json::json!({
                "orderId": "order-2",
                "paymentStatus": "pending",
                "paymentMethod": "cash"
            })),
            None,
            None,
        )
        .expect("object payload should parse");
        assert_eq!(parsed.order_id, "order-2");
        assert_eq!(parsed.payment_status, "pending");
        assert_eq!(parsed.payment_method.as_deref(), Some("cash"));
    }

    #[test]
    fn parse_payment_void_payload_requires_reason() {
        let err = parse_payment_void_payload(Some(serde_json::json!({
            "paymentId": "pay-1"
        })))
        .expect_err("missing reason should fail");
        assert!(err.contains("Invalid void payment payload") || err.contains("Missing reason"));
    }

    #[test]
    fn parse_refund_void_payload_supports_aliases() {
        let parsed = parse_refund_void_payload(Some(serde_json::json!({
            "payment_id": "pay-2",
            "reason": "operator correction",
            "staff_id": "staff-1",
            "staff_shift_id": "shift-1"
        })))
        .expect("alias payload should parse");
        assert_eq!(parsed.payment_id, "pay-2");
        assert_eq!(parsed.reason, "operator correction");
        assert_eq!(parsed.staff_id.as_deref(), Some("staff-1"));
        assert_eq!(parsed.staff_shift_id.as_deref(), Some("shift-1"));
    }

    #[test]
    fn parse_order_id_payload_supports_object_and_string() {
        let from_obj = parse_order_id_payload(Some(serde_json::json!({
            "orderId": "order-3"
        })))
        .expect("object order id should parse");
        let from_str = parse_order_id_payload(Some(serde_json::json!("order-4")))
            .expect("string order id should parse");
        assert_eq!(from_obj, "order-3");
        assert_eq!(from_str, "order-4");
    }

    #[test]
    fn full_unpaid_card_balance_requires_cashier_fiscal_checkout() {
        let input = payments::build_payment_record_input(&serde_json::json!({
            "orderId": "order-5",
            "method": "card",
            "amount": 42.50
        }))
        .expect("payment should parse");
        let balance = payments::OrderPaymentBalanceSnapshot {
            order_total: 42.50,
            net_paid: 0.0,
            outstanding_amount: 42.50,
            completed_payment_count: 0,
            ledger_generation: [0; 32],
        };

        assert!(should_fiscalize_full_balance_before_record(
            &input, false, false, balance
        ));
        assert!(!should_fiscalize_full_balance_before_record(
            &input, true, false, balance
        ));
    }

    #[test]
    fn split_or_partially_paid_collection_does_not_issue_full_receipt_early() {
        let split_input = payments::build_payment_record_input(&serde_json::json!({
            "orderId": "order-6",
            "method": "cash",
            "amount": 20.00
        }))
        .expect("payment should parse");
        assert!(!should_fiscalize_full_balance_before_record(
            &split_input,
            false,
            false,
            payments::OrderPaymentBalanceSnapshot {
                order_total: 40.00,
                net_paid: 0.0,
                outstanding_amount: 40.00,
                completed_payment_count: 0,
                ledger_generation: [0; 32],
            }
        ));
        assert!(!should_fiscalize_full_balance_before_record(
            &split_input,
            false,
            false,
            payments::OrderPaymentBalanceSnapshot {
                order_total: 40.00,
                net_paid: 20.00,
                outstanding_amount: 20.00,
                completed_payment_count: 1,
                ledger_generation: [0; 32],
            }
        ));
    }

    #[test]
    fn authoritative_card_collection_is_promoted_to_the_full_fiscal_checkout_path() {
        let balance = payments::OrderPaymentBalanceSnapshot {
            order_total: 42.50,
            net_paid: 0.0,
            outstanding_amount: 42.50,
            completed_payment_count: 0,
            ledger_generation: [0; 32],
        };
        let mut payload = serde_json::json!({
            "orderId": "order-authoritative-card",
            "method": "card",
            "amount": 1.00,
            "collectOutstandingBalance": true,
        });

        payments::prepare_outstanding_collection_payload(&mut payload, balance)
            .expect("prepare authoritative card collection");
        let input = payments::build_payment_record_input(&payload)
            .expect("prepared card payment should parse");

        assert_eq!(input.amount, 42.50);
        assert!(should_fiscalize_full_balance_before_record(
            &input, false, true, balance
        ));
    }

    #[test]
    fn authoritative_collection_discards_renderer_claimed_terminal_approval() {
        let mut payload = serde_json::json!({
            "orderId": "order-untrusted-terminal",
            "method": "card",
            "amount": 42.50,
            "terminalApproved": true,
            "paymentOrigin": "terminal",
            "terminalDeviceId": "renderer-device",
            "transactionRef": "renderer-transaction",
        });

        sanitize_outstanding_collection_trust_fields(&mut payload)
            .expect("sanitize renderer terminal claims");

        assert_eq!(payment_payload_has_terminal_approval(&payload), false);
        assert!(payload.get("paymentOrigin").is_none());
        assert!(payload.get("terminalDeviceId").is_none());
        assert!(payload.get("transactionRef").is_none());
    }

    #[test]
    fn authoritative_partial_card_collection_uses_final_fiscal_checkout() {
        let balance = payments::OrderPaymentBalanceSnapshot {
            order_total: 50.00,
            net_paid: 20.00,
            outstanding_amount: 30.00,
            completed_payment_count: 1,
            ledger_generation: [0; 32],
        };
        let mut payload = serde_json::json!({
            "orderId": "order-authoritative-partial-card",
            "method": "card",
            "amount": 1.00,
            "collectOutstandingBalance": true,
        });

        payments::prepare_outstanding_collection_payload(&mut payload, balance)
            .expect("prepare authoritative remaining balance");
        let input = payments::build_payment_record_input(&payload)
            .expect("prepared remaining card payment should parse");

        assert_eq!(input.amount, 30.00);
        assert!(should_fiscalize_full_balance_before_record(
            &input, false, true, balance
        ));
        assert!(
            should_fiscalize_full_balance_before_record(&input, true, true, balance),
            "renderer terminalApproved must not bypass native recovery fiscalization"
        );
    }

    #[test]
    fn payment_record_reservation_serializes_the_same_order_only() {
        let first = reserve_payment_record("reservation-order-a").expect("reserve first order");
        let duplicate = reserve_payment_record("reservation-order-a")
            .expect_err("same order must be serialized");
        let other = reserve_payment_record("reservation-order-b")
            .expect("a different order can collect concurrently");

        assert_eq!(
            duplicate,
            "A payment collection is already in progress for this order"
        );
        drop(other);
        drop(first);
        reserve_payment_record("reservation-order-a")
            .expect("reservation must release when the command exits");
    }

    #[test]
    fn outstanding_collection_fiscal_reference_is_stable_but_not_the_order_reference() {
        let first = outstanding_collection_fiscal_reference(
            "order-1",
            payments::OrderPaymentBalanceSnapshot {
                order_total: 50.0,
                net_paid: 20.0,
                outstanding_amount: 30.0,
                completed_payment_count: 1,
                ledger_generation: [0; 32],
            },
            "attempt-1",
        );
        let retry = outstanding_collection_fiscal_reference(
            "order-1",
            payments::OrderPaymentBalanceSnapshot {
                order_total: 50.0,
                net_paid: 20.0,
                outstanding_amount: 30.0,
                completed_payment_count: 1,
                ledger_generation: [0; 32],
            },
            "attempt-1",
        );
        let later_generation = outstanding_collection_fiscal_reference(
            "order-1",
            payments::OrderPaymentBalanceSnapshot {
                order_total: 50.0,
                net_paid: 25.0,
                outstanding_amount: 25.0,
                completed_payment_count: 2,
                ledger_generation: [1; 32],
            },
            "attempt-2",
        );

        assert_eq!(first, retry, "same collection retry must deduplicate");
        assert_ne!(first, "order-1");
        assert_ne!(first, later_generation);
        assert!(
            !first.contains("attempt-1"),
            "renderer idempotency keys stay opaque"
        );
        assert!(first.starts_with("order-1:collect-outstanding:"));
        assert_eq!(first.rsplit(':').next().map(str::len), Some(32));
    }

    #[test]
    fn outstanding_collection_fiscal_reference_separates_changed_tender_attempts() {
        let balance = payments::OrderPaymentBalanceSnapshot {
            order_total: 42.0,
            net_paid: 0.0,
            outstanding_amount: 42.0,
            completed_payment_count: 0,
            ledger_generation: [0; 32],
        };

        let card = outstanding_collection_fiscal_reference("order-2", balance, "card-attempt");
        let cash = outstanding_collection_fiscal_reference("order-2", balance, "cash-attempt");

        assert_ne!(card, cash);
    }

    #[test]
    fn outstanding_collection_attempt_key_is_required_bounded_and_opaque() {
        assert_eq!(
            validate_outstanding_idempotency_key(&serde_json::json!({})),
            Err("IDEMPOTENCY_KEY_REQUIRED")
        );
        assert_eq!(
            validate_outstanding_idempotency_key(&serde_json::json!({
                "idempotencyKey": "x".repeat(129)
            })),
            Err("IDEMPOTENCY_KEY_INVALID")
        );
        assert_eq!(
            validate_outstanding_idempotency_key(&serde_json::json!({
                "idempotencyKey": "attempt with spaces"
            })),
            Err("IDEMPOTENCY_KEY_INVALID")
        );
        assert_eq!(
            validate_outstanding_idempotency_key(&serde_json::json!({
                "idempotencyKey": "selection-123:retry_1"
            })),
            Ok("selection-123:retry_1")
        );

        let response = outstanding_idempotency_error_response("IDEMPOTENCY_KEY_INVALID");
        assert_eq!(response["errorCode"], "IDEMPOTENCY_KEY_INVALID");
        assert_eq!(response["paymentApproved"], false);
        assert_eq!(response["paymentPersisted"], false);
        assert!(!response.to_string().contains("attempt with spaces"));
    }

    #[test]
    fn same_attempt_key_reuses_identity_and_fresh_post_decline_key_can_reserve() {
        let balance = payments::OrderPaymentBalanceSnapshot {
            order_total: 42.0,
            net_paid: 0.0,
            outstanding_amount: 42.0,
            completed_payment_count: 0,
            ledger_generation: [0x42; 32],
        };
        let first = outstanding_collection_fiscal_reference("order-retry", balance, "click-1");
        let retry = outstanding_collection_fiscal_reference("order-retry", balance, "click-1");
        let fresh = outstanding_collection_fiscal_reference("order-retry", balance, "click-2");

        assert_eq!(first, retry, "same request retry must reuse its identity");
        assert_ne!(
            first, fresh,
            "a fresh click after definite failure must be able to reserve a new attempt"
        );
    }

    #[test]
    fn fiscal_reconciliation_requirement_is_exposed_at_the_payment_boundary() {
        let response = fiscal_checkout_not_approved_response(serde_json::json!({
            "success": false,
            "approved": false,
            "requiresReconciliation": true,
            "error": "Prior card tender requires reconciliation"
        }));

        assert_eq!(response["success"], false);
        assert_eq!(response["paymentApproved"], false);
        assert_eq!(response["paymentPersisted"], false);
        assert_eq!(response["requiresReconciliation"], true);
        assert_eq!(response["fiscalCheckout"]["requiresReconciliation"], true);
    }

    #[test]
    fn collect_outstanding_requires_the_renderers_atomic_settlement_generation() {
        let settlement = payments::OrderSettlementSnapshot {
            order_total: 42.50,
            net_paid: 10.00,
            outstanding_amount: 32.50,
            completed_payments: vec![serde_json::json!({
                "id": "payment-1",
                "status": "completed",
                "method": "cash",
                "amount": 10.00,
            })],
            ledger_generation: [0xab; 32],
        };
        let expected = payments::settlement_generation_token(&settlement.ledger_generation);

        assert!(validate_collect_outstanding_generation(
            &serde_json::json!({ "expectedSettlementGeneration": expected }),
            &settlement,
        )
        .is_ok());

        let stale = validate_collect_outstanding_generation(
            &serde_json::json!({ "expectedSettlementGeneration": "stale" }),
            &settlement,
        )
        .expect_err("stale renderer generation must fail before fiscal checkout");
        assert_eq!(stale["errorCode"], "BALANCE_CHANGED");
        assert_eq!(stale["paymentApproved"], false);
        assert_eq!(stale["paymentPersisted"], false);
        assert_eq!(stale["settlement"]["generation"], expected);
        assert_eq!(
            stale["settlement"]["completedPayments"][0]["id"],
            "payment-1"
        );

        let missing = validate_collect_outstanding_generation(&serde_json::json!({}), &settlement)
            .expect_err("recovery collection must require an atomic snapshot token");
        assert_eq!(missing["errorCode"], "EXPECTED_SETTLEMENT_REQUIRED");
    }

    #[test]
    fn post_approval_persistence_failure_requires_reconciliation_instead_of_retry() {
        let approval = serde_json::json!({
            "success": true,
            "approved": true,
            "transaction": {
                "transactionId": "fiscal-approved-before-db-failure",
                "deviceId": "cashier-1",
            }
        });

        let response = post_fiscal_persistence_failure_response(
            "Outstanding balance changed during payment collection",
            &approval,
        );

        assert_eq!(response["success"], false);
        assert_eq!(response["paymentApproved"], true);
        assert_eq!(response["paymentPersisted"], false);
        assert_eq!(response["requiresReconciliation"], true);
        assert!(!response
            .to_string()
            .contains("Outstanding balance changed during payment collection"));
        assert_eq!(
            response["fiscalCheckout"]["transaction"]["transactionId"],
            "fiscal-approved-before-db-failure"
        );
    }

    const STATUS_NOW: &str = "2026-09-30T12:00:00Z";

    fn payment_status_test_conn(total_cents: i64, payment_status: &str) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("pragmas");
        db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, status,
                payment_status, sync_status, branch_id, created_at, updated_at)
             VALUES ('ord-ps', 'A-0100', '[]', ?1, ?2, 'completed', ?3, 'synced',
                     'branch-ps', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
            rusqlite::params![total_cents as f64 / 100.0, total_cents, payment_status],
        )
        .unwrap();
        conn
    }

    fn add_payment_row(conn: &rusqlite::Connection, id: &str, cents: i64, status: &str) {
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                sync_status, sync_state, created_at, updated_at)
             VALUES (?1, 'ord-ps', 'cash', ?2, ?3, ?4, 'synced', 'applied',
                     '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
            rusqlite::params![id, cents as f64 / 100.0, cents, status],
        )
        .unwrap();
    }

    fn stored_payment_status(conn: &rusqlite::Connection) -> String {
        conn.query_row(
            "SELECT payment_status FROM orders WHERE id = 'ord-ps'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// Founder's rule, 30/09/2026: no order is registered as paid without the
    /// payment rows that cover it. The reconciliation label used to need only
    /// one completed row, so 5.00 in the ledger marked a 20.00 order paid.
    #[test]
    fn a_reconciliation_label_never_marks_an_order_paid_beyond_its_payment_rows() {
        let conn = payment_status_test_conn(2000, "partially_paid");
        add_payment_row(&conn, "pay-ps-cash", 500, "completed");
        // A payment set aside for review is not money this order holds.
        add_payment_row(&conn, "pay-ps-dup", 1500, "duplicate_review");

        let refused = set_order_payment_status_in_connection(&conn, "ord-ps", "paid", STATUS_NOW)
            .expect_err("5.00 of 20.00 is not paid");
        assert!(refused.contains("do not cover"), "{refused}");
        assert_eq!(stored_payment_status(&conn), "partially_paid");

        set_order_payment_status_in_connection(&conn, "ord-ps", "partially_paid", STATUS_NOW)
            .expect("5.00 does back partially paid");

        add_payment_row(&conn, "pay-ps-card", 1500, "completed");
        set_order_payment_status_in_connection(&conn, "ord-ps", "paid", STATUS_NOW)
            .expect("the rows now cover the order");
        assert_eq!(stored_payment_status(&conn), "paid");
    }

    #[test]
    fn a_paid_label_without_payment_rows_is_never_written_even_when_already_there() {
        // An order that already reads `paid` with no rows (a mirror waiting
        // for its rows): writing `paid` again would queue that claim for the
        // server.
        let conn = payment_status_test_conn(1300, "paid");
        for status in ["paid", "partially_paid"] {
            let refused =
                set_order_payment_status_in_connection(&conn, "ord-ps", status, STATUS_NOW)
                    .expect_err("no rows back the claim");
            assert!(refused.contains("do not cover"), "{status}: {refused}");
        }
        let queued_status_writes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM orders WHERE id = 'ord-ps' AND sync_status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued_status_writes, 0, "nothing was marked for a push");

        // A comp (zero total) has no money to record.
        let comp = payment_status_test_conn(0, "pending");
        set_order_payment_status_in_connection(&comp, "ord-ps", "paid", STATUS_NOW)
            .expect("a zero total is settled without rows");
        assert_eq!(stored_payment_status(&comp), "paid");
    }

    fn set_aside_test_db() -> db::DbState {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("pragmas");
        db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, status,
                payment_status, sync_status, branch_id, created_at, updated_at)
             VALUES ('ord-sa', 'A-0042', '[]', 13.0, 1300, 'completed', 'paid', 'synced',
                     'branch-sa', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-sa', 'ord-sa', 'cash', 13.0, 1300, 'completed', 'pending', 'syncing',
                     '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
            [],
        )
        .unwrap();
        crate::payment_review::set_aside_already_paid_payment(
            &conn,
            "pay-sa",
            Some("srv-card"),
            "2026-09-30T10:06:00Z",
        )
        .unwrap();
        db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    fn set_aside_status(db: &db::DbState) -> String {
        db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT status FROM order_payments WHERE id = 'pay-sa'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// "Money given back to the customer" is a money decision: it needs the
    /// desktop's approval for money actions (a cashier or manager shift on
    /// this terminal and a fresh PIN), and nothing changes without it.
    #[test]
    fn resolving_a_set_aside_payment_needs_the_money_action_approval() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "term-sa"),
            ("branch_id", "branch-sa"),
        ]);
        let db = set_aside_test_db();
        let auth = crate::auth::AuthState::new();

        let refused = resolve_set_aside_payment_guarded(
            &db,
            &auth,
            Some(serde_json::json!({ "paymentId": "pay-sa" })),
        )
        .expect_err("no session, no decision");
        assert!(matches!(
            refused,
            crate::auth::GuardedCommandError::Structured(ref error) if error.code == "UNAUTHORIZED"
        ));
        assert_eq!(set_aside_status(&db), "duplicate_review");

        {
            let conn = db.conn.lock().unwrap();
            let hash = bcrypt::hash("4321", 4).unwrap();
            db::set_setting(&conn, "staff", "staff_pin_hash", &hash).unwrap();
            db::set_setting(&conn, "terminal", "terminal_id", "term-sa").unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, staff_name, branch_id, terminal_id,
                    role_type, check_in_time, status, created_at, updated_at)
                 VALUES ('shift-sa', 'staff-cashier', 'Cashier', 'branch-sa', 'term-sa',
                         'cashier', '2026-09-30T09:00:00Z', 'active',
                         '2026-09-30T09:00:00Z', '2026-09-30T09:00:00Z')",
                [],
            )
            .unwrap();
        }
        crate::auth::login(Some(serde_json::json!({ "pin": "4321" })), &db, &auth)
            .expect("staff login");
        let stale = resolve_set_aside_payment_guarded(
            &db,
            &auth,
            Some(serde_json::json!({ "paymentId": "pay-sa" })),
        )
        .expect_err("a session alone is not the approval");
        assert!(matches!(
            stale,
            crate::auth::GuardedCommandError::Structured(ref error) if error.code == "REAUTH_REQUIRED"
        ));
        assert_eq!(set_aside_status(&db), "duplicate_review");

        crate::auth::confirm_privileged_action(
            Some(serde_json::json!({ "pin": "4321", "scope": "cash_drawer_control" })),
            &db,
            &auth,
        )
        .expect("PIN confirmation");
        let resolved = resolve_set_aside_payment_guarded(
            &db,
            &auth,
            Some(serde_json::json!({
                "paymentId": "pay-sa",
                "outcome": "returned_to_customer",
                "resolvedBy": "staff-cashier",
            })),
        )
        .expect("resolved");
        assert_eq!(resolved["success"], true);
        assert_eq!(resolved["alreadyResolved"], false);
        assert_eq!(resolved["remainingSetAsidePayments"], 0);
        assert_eq!(set_aside_status(&db), "voided");
        let resolved_by: String = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT json_extract(metadata, '$.duplicate_review.resolution.resolved_by')
                 FROM order_payments WHERE id = 'pay-sa'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(resolved_by, "staff-cashier");

        let again = resolve_set_aside_payment_guarded(
            &db,
            &auth,
            Some(serde_json::json!({ "paymentId": "pay-sa" })),
        )
        .expect("a second tap changes nothing");
        assert_eq!(again["alreadyResolved"], true);

        let unsupported = resolve_set_aside_payment_guarded(
            &db,
            &auth,
            Some(serde_json::json!({ "paymentId": "pay-sa", "outcome": "kept" })),
        )
        .expect_err("only one outcome exists");
        assert!(unsupported.to_string().contains("Unsupported"));
    }

    /// "Money given back to the customer" for a card charged but not saved is
    /// a money decision like the set-aside one: nothing changes without the
    /// desktop's approval for money actions, the audit comes first, a second
    /// tap changes nothing, and the Z is released.
    #[test]
    fn resolving_a_charged_payment_not_saved_needs_the_money_action_approval() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "term-sa"),
            ("branch_id", "branch-sa"),
        ]);
        let db = set_aside_test_db();
        let key = "terminal-card:txn-not-saved";
        {
            let conn = db.conn.lock().unwrap();
            let entry = crate::unsaved_payments::UnsavedChargedPayment::for_payment(
                "ord-sa",
                &serde_json::json!({
                    "orderId": "ord-sa",
                    "method": "card",
                    "amount": 13.0,
                    "transactionRef": "txn-not-saved",
                    "terminalApproved": true,
                }),
                None,
                "2026-09-30T10:07:00Z",
            )
            .unwrap();
            crate::unsaved_payments::record(&conn, &entry).unwrap();
        }
        let remaining =
            |db: &db::DbState| crate::unsaved_payments::count(&db.conn.lock().unwrap()).unwrap();
        let auth = crate::auth::AuthState::new();

        let refused = resolve_unsaved_payment_guarded(
            &db,
            &auth,
            Some(serde_json::json!({ "idempotencyKey": key })),
        )
        .expect_err("no session, no decision");
        assert!(matches!(
            refused,
            crate::auth::GuardedCommandError::Structured(ref error) if error.code == "UNAUTHORIZED"
        ));
        assert_eq!(remaining(&db), 1);

        {
            let conn = db.conn.lock().unwrap();
            let hash = bcrypt::hash("4321", 4).unwrap();
            db::set_setting(&conn, "staff", "staff_pin_hash", &hash).unwrap();
            db::set_setting(&conn, "terminal", "terminal_id", "term-sa").unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, staff_name, branch_id, terminal_id,
                    role_type, check_in_time, status, created_at, updated_at)
                 VALUES ('shift-sa', 'staff-cashier', 'Cashier', 'branch-sa', 'term-sa',
                         'cashier', '2026-09-30T09:00:00Z', 'active',
                         '2026-09-30T09:00:00Z', '2026-09-30T09:00:00Z')",
                [],
            )
            .unwrap();
        }
        crate::auth::login(Some(serde_json::json!({ "pin": "4321" })), &db, &auth)
            .expect("staff login");
        let stale = resolve_unsaved_payment_guarded(
            &db,
            &auth,
            Some(serde_json::json!({ "idempotencyKey": key })),
        )
        .expect_err("a session alone is not the approval");
        assert!(matches!(
            stale,
            crate::auth::GuardedCommandError::Structured(ref error) if error.code == "REAUTH_REQUIRED"
        ));
        assert_eq!(remaining(&db), 1);

        crate::auth::confirm_privileged_action(
            Some(serde_json::json!({ "pin": "4321", "scope": "cash_drawer_control" })),
            &db,
            &auth,
        )
        .expect("PIN confirmation");
        let resolved = resolve_unsaved_payment_guarded(
            &db,
            &auth,
            Some(serde_json::json!({
                "idempotencyKey": key,
                "outcome": "returned_to_customer",
            })),
        )
        .expect("resolved");
        assert_eq!(resolved["result"], "resolved");
        assert_eq!(resolved["orderId"], "ord-sa");
        assert_eq!(resolved["remainingUnsavedPayments"], 0, "the Z is released");
        let resolved_by: String = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT actor_staff_id FROM recovery_action_log
                 WHERE action_id = 'payment_not_saved_resolved'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let session = crate::auth::get_session_json(&auth);
        let session_staff = ["databaseStaffId", "staffId"]
            .iter()
            .find_map(|key| session.get(*key).and_then(serde_json::Value::as_str))
            .expect("the session names its staff member")
            .to_string();
        assert_eq!(
            resolved_by, session_staff,
            "who confirmed it, from the session"
        );

        let again = resolve_unsaved_payment_guarded(
            &db,
            &auth,
            Some(serde_json::json!({ "idempotencyKey": key })),
        )
        .expect("a second tap changes nothing");
        assert_eq!(again["result"], "already_resolved");
    }
}
