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
struct PaymentRecordReservation(String);

impl Drop for PaymentRecordReservation {
    fn drop(&mut self) {
        if let Ok(mut active) = active_payment_records().lock() {
            active.remove(&self.0);
        }
    }
}

fn reserve_payment_record(order_id: &str) -> Result<PaymentRecordReservation, String> {
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

fn payment_payload_has_terminal_approval(payload: &serde_json::Value) -> bool {
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

    // Wave 6 H15: the SELECT of `current_payment_status` +
    // `completed_payment_rows` followed by the UPDATE used to run on the
    // same connection but without an explicit `BEGIN IMMEDIATE`. A
    // concurrent `void_payment` between the SELECT and the UPDATE could
    // remove the last completed payment row, and we would still stamp
    // the order `paid` with 0 completed payments. Wrapping both in a
    // single IMMEDIATE transaction closes that window.
    //
    // Wave 6 C8: the UPDATE no longer writes `payment_method` — the
    // derived value is reconstructed on read via
    // `payments::derive_payment_method`. Removing the stored column
    // write is the first step toward dropping the column entirely in
    // a later migration.
    //
    // Wave 6 M3: the sync-queue idempotency key is anchored on
    // `(order_id, payment_status)` so a double-submission of the same
    // status change produces the same key. Previously the
    // `Uuid::new_v4()` suffix rotated the key on every invocation.
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
        if completed_payment_rows == 0
            && current_payment_status != payment_status
            && matches!(
                payment_status.as_str(),
                "paid" | "partially_paid" | "refunded"
            )
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
            .map_err(|e| format!("commit payment-status transaction: {e}"))?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }

    let event_payload = serde_json::json!({
        "orderId": order_id,
        "paymentStatus": payment_status,
        "paymentMethod": payment_method
    });
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
    let order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        resolve_order_id(&conn, &requested_input.order_id).ok_or("Order not found")?
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
    payments::get_order_settlement_snapshot(&db, &order_id)
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
}
