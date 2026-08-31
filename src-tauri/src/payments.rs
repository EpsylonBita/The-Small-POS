//! Payment management for The Small POS.
//!
//! Implements offline-first payment recording, voiding, querying, and
//! receipt preview generation. Payments are stored in `order_payments`
//! and enqueued for sync to the admin dashboard via `/api/pos/payments`.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::{info, warn};
use uuid::Uuid;

use crate::db::DbState;
use crate::money::Cents;
use crate::{
    business_day, order_ownership, payment_integrity, print, printers, receipt_renderer,
    resolve_order_id, shifts,
};

fn load_payment_items_for_payment(
    conn: &rusqlite::Connection,
    payment_id: &str,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            // W4b: read item_amount_cents with COALESCE fallback to
            // CAST(ROUND(item_amount * 100)) for any pre-W4c row that
            // still has NULL cents. Shim removed in 4e.
            "SELECT item_index, item_name, item_quantity,
                    COALESCE(item_amount_cents, CAST(ROUND(item_amount * 100) AS INTEGER), 0),
                    created_at
             FROM payment_items
             WHERE payment_id = ?1
             ORDER BY item_index ASC, created_at ASC",
        )
        .map_err(|e| format!("prepare payment_items lookup: {e}"))?;

    let rows = stmt
        .query_map(params![payment_id], |row| {
            // W4d-i: emit BOTH `itemAmount` (legacy float, what
            // admin-dashboard reads) AND `item_amount_cents` (new
            // integer). 4d-cleanup removes the float key after admin
            // switches to cents.
            let item_amount_cents = row.get::<_, i64>(3)?;
            Ok(serde_json::json!({
                "itemIndex": row.get::<_, i32>(0)?,
                "itemName": row.get::<_, String>(1)?,
                "itemQuantity": row.get::<_, i32>(2)?,
                "itemAmount": Cents::new(item_amount_cents).to_f64_dp2(),
                "item_amount_cents": item_amount_cents,
                "createdAt": row.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| format!("query payment_items lookup: {e}"))?;

    let mut items = Vec::new();
    for row in rows {
        match row {
            Ok(item) => items.push(item),
            Err(e) => warn!("skipping malformed payment_items lookup row: {e}"),
        }
    }

    Ok(items)
}

fn load_edit_settlement_refund_proof_for_payment(
    conn: &rusqlite::Connection,
    payment_id: &str,
    order_id: &str,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, payment_id, order_id,
                    COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0),
                    refund_method, cash_handler, adjustment_context, idempotency_key
             FROM payment_adjustments
             WHERE payment_id = ?1
               AND order_id = ?2
               AND adjustment_type = 'refund'
               AND COALESCE(adjustment_context, '') = 'edit_settlement'
               AND COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0) > 0
               AND sync_state IN ('waiting_parent', 'pending', 'syncing', 'failed')
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| format!("prepare settlement refund proof lookup: {e}"))?;

    let rows = stmt
        .query_map(params![payment_id, order_id], |row| {
            let adjustment_id: String = row.get(0)?;
            let payment_id: String = row.get(1)?;
            let order_id: String = row.get(2)?;
            let amount_cents: i64 = row.get(3)?;
            let refund_method: Option<String> = row.get(4)?;
            let cash_handler: Option<String> = row.get(5)?;
            let adjustment_context: Option<String> = row.get(6)?;
            let idempotency_key: Option<String> = row.get(7)?;
            let stable_idempotency_key = idempotency_key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("adjustment:{adjustment_id}"));
            Ok(serde_json::json!({
                "adjustment_id": adjustment_id.clone(),
                "adjustmentId": adjustment_id,
                "payment_id": payment_id.clone(),
                "paymentId": payment_id.clone(),
                "local_payment_id": payment_id,
                "order_id": order_id.clone(),
                "orderId": order_id.clone(),
                "client_order_id": order_id.clone(),
                "clientOrderId": order_id.clone(),
                "local_order_id": order_id,
                "adjustment_type": "refund",
                "adjustmentType": "refund",
                "adjustment_context": adjustment_context.unwrap_or_else(|| "edit_settlement".to_string()),
                "adjustmentContext": "edit_settlement",
                "amount": Cents::new(amount_cents).to_f64_dp2(),
                "amount_cents": amount_cents,
                "idempotency_key": stable_idempotency_key.clone(),
                "idempotencyKey": stable_idempotency_key,
                "refund_method": refund_method.clone(),
                "refundMethod": refund_method,
                "cash_handler": cash_handler.clone(),
                "cashHandler": cash_handler,
            }))
        })
        .map_err(|e| format!("query settlement refund proof rows: {e}"))?;

    let mut adjustments = Vec::new();
    for row in rows {
        match row {
            Ok(adjustment) => adjustments.push(adjustment),
            Err(e) => warn!("skipping malformed settlement refund proof row: {e}"),
        }
    }

    Ok(adjustments)
}

#[derive(Clone, Debug)]
struct HistoricalPaymentRepairContext {
    shift_id: String,
    staff_id: String,
    shift_status: String,
    recorded_at: String,
}

fn load_shift_role_status_and_staff(
    conn: &Connection,
    shift_id: &str,
) -> Result<Option<(String, String, String)>, String> {
    conn.query_row(
        "SELECT role_type, staff_id, status
         FROM staff_shifts
         WHERE id = ?1
         LIMIT 1",
        params![shift_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    )
    .optional()
    .map_err(|e| format!("load shift role/status for payment repair: {e}"))
}

fn blocker_is_resolvable_from_z_report(
    blocker: &payment_integrity::UnsettledPaymentBlocker,
) -> bool {
    blocker.reason_code != "unsupported_payment_method"
}

fn build_payment_blocker_failure(
    error: impl Into<String>,
    blockers: &[payment_integrity::UnsettledPaymentBlocker],
) -> Value {
    let message = error.into();
    serde_json::json!({
        "success": false,
        "errorCode": payment_integrity::UNSETTLED_PAYMENT_BLOCKER_ERROR_CODE,
        "error": message,
        "message": message,
        "blockers": blockers,
    })
}

fn resolve_historical_cashier_repair_context(
    conn: &Connection,
    order_id: &str,
) -> Result<HistoricalPaymentRepairContext, String> {
    let (branch_id, order_type, order_staff_shift_id): (String, String, Option<String>) = conn
        .query_row(
            "SELECT COALESCE(branch_id, ''),
                    COALESCE(order_type, 'dine-in'),
                    staff_shift_id
             FROM orders
             WHERE id = ?1",
            params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| format!("load order context for payment repair: {e}"))?;

    let recorded_at = business_day::resolve_order_financial_effective_at(conn, order_id)?;

    let delivery_driver_owned = if order_type.eq_ignore_ascii_case("delivery") {
        order_staff_shift_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|driver_shift_id| {
                load_shift_role_status_and_staff(conn, driver_shift_id).map(|shift| {
                    shift
                        .map(|(role_type, _, _)| role_type == "driver")
                        .unwrap_or(false)
                })
            })
            .transpose()?
            .unwrap_or(false)
    } else {
        false
    };

    if let Some(shift_id) = order_staff_shift_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some((role_type, staff_id, shift_status)) =
            load_shift_role_status_and_staff(conn, shift_id)?
        {
            if matches!(role_type.as_str(), "cashier" | "manager")
                && business_day::shift_contains_timestamp(conn, shift_id, &recorded_at)?
            {
                return Ok(HistoricalPaymentRepairContext {
                    shift_id: shift_id.to_string(),
                    staff_id,
                    shift_status,
                    recorded_at,
                });
            }
        }
    }

    if branch_id.trim().is_empty() {
        return Err(
            "No historical cashier drawer was found for this blocked order. Reopen the order or ask support to repair it."
                .to_string(),
        );
    }

    let Some((shift_id, staff_id)) =
        business_day::find_cashier_owner_for_timestamp(conn, &branch_id, &recorded_at)?
    else {
        if delivery_driver_owned {
            return Err(
                "This blocked delivery order is attached to a driver shift, and no cashier drawer covered the original financial timestamp."
                    .to_string(),
            );
        }
        return Err(
            "No historical cashier drawer was found for this blocked order. Reopen the order or ask support to repair it."
                .to_string(),
        );
    };

    let Some((role_type, _, shift_status)) = load_shift_role_status_and_staff(conn, &shift_id)?
    else {
        return Err(format!(
            "Historical cashier shift {shift_id} is missing and cannot receive the repaired payment"
        ));
    };

    if role_type != "cashier" && role_type != "manager" {
        if delivery_driver_owned {
            return Err(
                "This blocked delivery order is attached to a driver shift, and the historical owner is not a cashier drawer."
                    .to_string(),
            );
        }
        return Err(
            "The original business-day owner is not a cashier drawer, so this blocker cannot be repaired automatically from Z-report."
                .to_string(),
        );
    }

    Ok(HistoricalPaymentRepairContext {
        shift_id,
        staff_id,
        shift_status,
        recorded_at,
    })
}

fn resolve_checkout_cashier_repair_context(
    conn: &Connection,
    order_id: &str,
    shift_id: &str,
    requested_staff_id: Option<String>,
) -> Result<HistoricalPaymentRepairContext, String> {
    let shift_id = shift_id.trim();
    if shift_id.is_empty() {
        return Err("Missing cashier shift for payment repair".to_string());
    }

    let financial_at = business_day::resolve_order_financial_effective_at(conn, order_id)?;
    let order_branch_id: String = conn
        .query_row(
            "SELECT COALESCE(branch_id, '')
             FROM orders
             WHERE id = ?1
             LIMIT 1",
            params![order_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("load order branch for payment repair: {e}"))?;

    let (role_type, shift_staff_id, shift_status, shift_branch_id): (
        String,
        String,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT role_type, staff_id, status, COALESCE(branch_id, '')
             FROM staff_shifts
             WHERE id = ?1
             LIMIT 1",
            params![shift_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| format!("load cashier shift for payment repair: {e}"))?
        .ok_or_else(|| format!("Cashier shift {shift_id} was not found"))?;

    if role_type != "cashier" && role_type != "manager" {
        return Err(
            "Payment repair from checkout requires a cashier or manager drawer".to_string(),
        );
    }
    if !order_branch_id.trim().is_empty()
        && !shift_branch_id.trim().is_empty()
        && order_branch_id != shift_branch_id
    {
        return Err("Payment repair shift belongs to a different branch".to_string());
    }

    let staff_id = requested_staff_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or(shift_staff_id);
    let recorded_at = if business_day::shift_contains_timestamp(conn, shift_id, &financial_at)? {
        financial_at
    } else {
        Utc::now().to_rfc3339()
    };

    Ok(HistoricalPaymentRepairContext {
        shift_id: shift_id.to_string(),
        staff_id,
        shift_status,
        recorded_at,
    })
}

#[derive(Clone, Debug)]
struct PaymentItemInput {
    item_index: i32,
    item_name: String,
    item_quantity: i32,
    item_amount: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct PaymentRecordInput {
    pub order_id: String,
    pub method: String,
    pub amount: f64,
    pub currency: String,
    pub tip_amount: f64,
    pub cash_received: Option<f64>,
    pub change_given: Option<f64>,
    pub transaction_ref: Option<String>,
    pub idempotency_key: Option<String>,
    pub discount_amount: f64,
    pub payment_origin: String,
    pub terminal_device_id: Option<String>,
    pub table_session_id: Option<String>,
    pub seat_number: Option<i64>,
    pub requested_staff_id: Option<String>,
    pub requested_staff_shift_id: Option<String>,
    pub requested_tip_recipient_role: Option<String>,
    pub requested_tip_recipient_staff_id: Option<String>,
    pub requested_tip_recipient_staff_shift_id: Option<String>,
    pub collected_by: Option<String>,
    items: Vec<PaymentItemInput>,
}

#[derive(Clone, Debug)]
pub(crate) struct PaymentInsertOptions {
    pub payment_id: Option<String>,
    pub remote_payment_id: Option<String>,
    pub sync_status: String,
    pub sync_state: Option<String>,
    pub enqueue_sync: bool,
    pub update_cash_drawer: bool,
    pub mark_order_sync_pending_on_owner_change: bool,
    pub sync_order_owner_with_payment: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

impl PaymentInsertOptions {
    pub(crate) fn local() -> Self {
        Self {
            payment_id: None,
            remote_payment_id: None,
            sync_status: "pending".to_string(),
            sync_state: None,
            enqueue_sync: true,
            update_cash_drawer: true,
            mark_order_sync_pending_on_owner_change: true,
            sync_order_owner_with_payment: true,
            created_at: None,
            updated_at: None,
        }
    }

    pub(crate) fn applied(remote_payment_id: Option<String>) -> Self {
        Self {
            payment_id: None,
            remote_payment_id,
            sync_status: "synced".to_string(),
            sync_state: Some("applied".to_string()),
            enqueue_sync: false,
            update_cash_drawer: false,
            mark_order_sync_pending_on_owner_change: false,
            sync_order_owner_with_payment: true,
            created_at: None,
            updated_at: None,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RecordedPayment {
    pub payment_id: String,
    pub payment_origin: String,
    pub sync_status: String,
    pub sync_state: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct OrderPaymentBalanceSnapshot {
    pub order_total: f64,
    pub net_paid: f64,
    pub outstanding_amount: f64,
    pub completed_payment_count: i64,
    pub ledger_generation: [u8; 32],
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OrderSettlementSnapshot {
    pub order_total: f64,
    pub net_paid: f64,
    pub outstanding_amount: f64,
    pub completed_payments: Vec<Value>,
    pub ledger_generation: [u8; 32],
}

fn parse_payment_items(payload: &Value) -> Vec<PaymentItemInput> {
    payload
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item_val| PaymentItemInput {
                    item_index: item_val
                        .get("itemIndex")
                        .or_else(|| item_val.get("item_index"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0) as i32,
                    item_name: item_val
                        .get("itemName")
                        .or_else(|| item_val.get("item_name"))
                        .or_else(|| item_val.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("Item")
                        .to_string(),
                    item_quantity: item_val
                        .get("itemQuantity")
                        .or_else(|| item_val.get("item_quantity"))
                        .or_else(|| item_val.get("quantity"))
                        .and_then(Value::as_i64)
                        .unwrap_or(1) as i32,
                    item_amount: item_val
                        .get("itemAmount")
                        .or_else(|| item_val.get("item_amount"))
                        .or_else(|| item_val.get("amount"))
                        .and_then(Value::as_f64)
                        .filter(|value| value.is_finite())
                        .unwrap_or(0.0),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn build_payment_items_json(items: &[PaymentItemInput]) -> Option<Value> {
    if items.is_empty() {
        return None;
    }

    Some(Value::Array(
        items
            .iter()
            .map(|item| {
                serde_json::json!({
                    "itemIndex": item.item_index,
                    "itemName": item.item_name,
                    "itemQuantity": item.item_quantity,
                    "itemAmount": item.item_amount,
                })
            })
            .collect(),
    ))
}

fn normalize_local_payment_origin(requested: &str, method: &str) -> String {
    match requested.trim().to_ascii_lowercase().as_str() {
        "terminal" if method == "card" => "terminal".to_string(),
        "manual_recovery" => "manual_recovery".to_string(),
        "sync_reconstructed" => "sync_reconstructed".to_string(),
        _ => "manual".to_string(),
    }
}

fn normalize_collected_by(value: Option<String>) -> Option<String> {
    match value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("cashier_drawer") => Some("cashier_drawer".to_string()),
        Some("driver_shift") => Some("driver_shift".to_string()),
        _ => None,
    }
}

pub(crate) fn normalize_external_payment_method(method: &str) -> Option<String> {
    match method.trim().to_ascii_lowercase().as_str() {
        "cash" => Some("cash".to_string()),
        "card" => Some("card".to_string()),
        "room_charge" | "room-charge" => Some("room_charge".to_string()),
        "other" | "online" | "digital_wallet" | "digital-wallet" | "wallet" | "split" | "mixed"
        | "pending" => Some("other".to_string()),
        _ => None,
    }
}

pub(crate) fn payload_collects_outstanding_balance(payload: &Value) -> bool {
    payload
        .get("collectOutstandingBalance")
        .or_else(|| payload.get("collect_outstanding_balance"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Replace renderer-supplied money with the current native balance before a
/// missing-payment collection enters fiscal checkout or local persistence.
/// Cash tender is still operator supplied, but its change is recalculated from
/// integer cents so stale renderer totals cannot leak into the ledger.
pub(crate) fn prepare_outstanding_collection_payload(
    payload: &mut Value,
    snapshot: OrderPaymentBalanceSnapshot,
) -> Result<(), String> {
    let method = str_field(payload, "method")
        .map(|value| value.trim().to_ascii_lowercase())
        .ok_or("Missing method")?;
    if !matches!(method.as_str(), "cash" | "card") {
        return Err("Outstanding balance collection requires cash or card".to_string());
    }

    let outstanding_cents = Cents::round_half_even(snapshot.outstanding_amount).as_i64();
    if outstanding_cents <= 0 {
        return Err("Order has no outstanding balance to collect".to_string());
    }
    let outstanding_amount = Cents::new(outstanding_cents).to_f64_dp2();
    let payment = payload.as_object_mut().ok_or("Invalid payment payload")?;
    payment.insert("amount".to_string(), serde_json::json!(outstanding_amount));

    if method == "cash" {
        let cash_received = payment
            .get("cashReceived")
            .or_else(|| payment.get("cash_received"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or("Missing cashReceived for outstanding cash collection")?;
        let cash_received_cents = Cents::round_half_even(cash_received).as_i64();
        if cash_received_cents < outstanding_cents {
            return Err(format!(
                "Cash received {:.2} is below outstanding balance {:.2}",
                Cents::new(cash_received_cents).to_f64_dp2(),
                outstanding_amount,
            ));
        }
        payment.insert(
            "cashReceived".to_string(),
            serde_json::json!(Cents::new(cash_received_cents).to_f64_dp2()),
        );
        payment.insert(
            "changeGiven".to_string(),
            serde_json::json!(Cents::new(cash_received_cents - outstanding_cents).to_f64_dp2()),
        );
    } else {
        payment.remove("cashReceived");
        payment.remove("cash_received");
        payment.remove("changeGiven");
        payment.remove("change_given");
        payment.remove("change");
    }

    Ok(())
}

pub(crate) fn build_payment_record_input(payload: &Value) -> Result<PaymentRecordInput, String> {
    let order_id = str_field(payload, "orderId")
        .or_else(|| str_field(payload, "order_id"))
        .ok_or("Missing orderId")?;
    let raw_method = str_field(payload, "method").ok_or("Missing method")?;
    let method = match raw_method.trim().to_ascii_lowercase().as_str() {
        "cash" => "cash".to_string(),
        "card" => "card".to_string(),
        "other" => "other".to_string(),
        "room_charge" | "room-charge" => "room_charge".to_string(),
        _ => {
            return Err(format!(
                "Invalid method: {raw_method}. Must be cash, card, room_charge, or other"
            ));
        }
    };
    let amount = num_field(payload, "amount").ok_or("Missing amount")?;
    if amount <= 0.0 {
        return Err("Amount must be positive".into());
    }
    let tip_amount = num_field(payload, "tipAmount")
        .or_else(|| num_field(payload, "tip_amount"))
        .unwrap_or(0.0)
        .max(0.0);
    let requested_tip_recipient_role = str_field(payload, "tipRecipientRole")
        .or_else(|| str_field(payload, "tip_recipient_role"))
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    if let Some(role) = requested_tip_recipient_role.as_deref() {
        if !matches!(role, "waiter" | "cashier" | "driver") {
            return Err(format!(
                "Invalid tip recipient role: {role}. Must be waiter, cashier, or driver"
            ));
        }
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
    let idempotency_key = str_field(payload, "idempotencyKey")
        .or_else(|| str_field(payload, "idempotency_key"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let discount_amount = num_field(payload, "discountAmount")
        .or_else(|| num_field(payload, "discount_amount"))
        .unwrap_or(0.0)
        .max(0.0);
    let terminal_approved = payload
        .get("terminalApproved")
        .or_else(|| payload.get("terminal_approved"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let requested_payment_origin = str_field(payload, "paymentOrigin")
        .or_else(|| str_field(payload, "payment_origin"))
        .unwrap_or_else(|| {
            if terminal_approved {
                "terminal".to_string()
            } else {
                "manual".to_string()
            }
        });
    let payment_origin = normalize_local_payment_origin(&requested_payment_origin, &method);
    let terminal_device_id = if payment_origin == "terminal" {
        str_field(payload, "terminalDeviceId")
            .or_else(|| str_field(payload, "terminal_device_id"))
            .or_else(|| str_field(payload, "deviceId"))
            .or_else(|| str_field(payload, "device_id"))
    } else {
        None
    };
    let collected_by = normalize_collected_by(
        str_field(payload, "collectedBy")
            .or_else(|| str_field(payload, "collected_by"))
            .or_else(|| str_field(payload, "cashHandler"))
            .or_else(|| str_field(payload, "cash_handler")),
    );

    Ok(PaymentRecordInput {
        order_id,
        method,
        amount,
        currency: str_field(payload, "currency").unwrap_or_else(|| "EUR".to_string()),
        tip_amount,
        cash_received,
        change_given,
        transaction_ref,
        idempotency_key,
        discount_amount,
        payment_origin,
        terminal_device_id,
        table_session_id: str_field(payload, "tableSessionId")
            .or_else(|| str_field(payload, "table_session_id")),
        seat_number: payload
            .get("seatNumber")
            .or_else(|| payload.get("seat_number"))
            .and_then(Value::as_i64)
            .filter(|value| *value > 0),
        requested_staff_id: str_field(payload, "staffId")
            .or_else(|| str_field(payload, "staff_id")),
        requested_staff_shift_id: str_field(payload, "staffShiftId")
            .or_else(|| str_field(payload, "staff_shift_id")),
        requested_tip_recipient_role,
        requested_tip_recipient_staff_id: str_field(payload, "tipRecipientStaffId")
            .or_else(|| str_field(payload, "tip_recipient_staff_id")),
        requested_tip_recipient_staff_shift_id: str_field(payload, "tipRecipientStaffShiftId")
            .or_else(|| str_field(payload, "tip_recipient_staff_shift_id")),
        collected_by,
        items: parse_payment_items(payload),
    })
}

pub(crate) fn load_net_paid_for_order(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<f64, String> {
    conn.query_row(
        // W4b: aggregate using cents-with-real-fallback shim. The shim
        // (`COALESCE(*_cents, CAST(ROUND(*_real * 100) AS INTEGER))`)
        // tolerates any row whose cents was never populated (pre-W4c
        // production rows or test fixtures). 4e removes the shim when
        // the REAL columns are dropped.
        "SELECT COALESCE(SUM(
            CASE
                WHEN COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0)
                     > COALESCE(refunds.refunded_cents, 0)
                    THEN COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0)
                         - COALESCE(refunds.refunded_cents, 0)
                ELSE 0
            END
        ), 0)
         FROM order_payments op
         LEFT JOIN (
             SELECT payment_id,
                    SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))) AS refunded_cents
             FROM payment_adjustments
             WHERE adjustment_type = 'refund'
             GROUP BY payment_id
         ) refunds ON refunds.payment_id = op.id
         WHERE op.order_id = ?1
           AND op.status = 'completed'",
        params![order_id],
        |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
    )
    .map_err(|e| format!("load net paid for order {order_id}: {e}"))
}

pub(crate) fn load_order_payment_balance_snapshot(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<OrderPaymentBalanceSnapshot, String> {
    let order_total: f64 = conn
        .query_row(
            // W4b: cents-with-real-fallback shim (removed in 4e).
            "SELECT COALESCE(total_amount_cents, CAST(ROUND(total_amount * 100) AS INTEGER), 0)
             FROM orders
             WHERE id = ?1",
            params![order_id],
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .map_err(|e| format!("load order total for payment balance snapshot {order_id}: {e}"))?;
    let net_paid = load_net_paid_for_order(conn, order_id)?;
    let completed_payment_count = conn
        .query_row(
            "SELECT COUNT(*) FROM order_payments WHERE order_id = ?1 AND status = 'completed'",
            params![order_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("load completed payment count for order {order_id}: {error}"))?;
    let order_total_cents = Cents::round_half_even(order_total).as_i64();
    let ledger_generation =
        load_completed_payment_ledger_generation(conn, order_id, order_total_cents)?;
    Ok(OrderPaymentBalanceSnapshot {
        order_total,
        net_paid,
        outstanding_amount: (order_total - net_paid).max(0.0),
        completed_payment_count,
        ledger_generation,
    })
}

fn load_completed_payment_ledger_generation(
    conn: &rusqlite::Connection,
    order_id: &str,
    order_total_cents: i64,
) -> Result<[u8; 32], String> {
    let mut statement = conn
        .prepare(
            "SELECT op.id, op.method,
                    COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0),
                    op.transaction_ref, COALESCE(op.payment_origin, 'manual'),
                    COALESCE((
                        SELECT SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER)))
                        FROM payment_adjustments pa
                        WHERE pa.payment_id = op.id
                          AND pa.adjustment_type = 'refund'
                    ), 0)
             FROM order_payments op
             WHERE op.order_id = ?1
               AND op.status = 'completed'
             ORDER BY op.id ASC",
        )
        .map_err(|error| format!("prepare payment-ledger generation for {order_id}: {error}"))?;
    let rows = statement
        .query_map(params![order_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|error| format!("query payment-ledger generation for {order_id}: {error}"))?;

    let mut digest = Sha256::new();
    digest.update(b"order-settlement-v1\0");
    digest.update((order_id.len() as u64).to_le_bytes());
    digest.update(order_id.as_bytes());
    digest.update(order_total_cents.to_le_bytes());
    for row in rows {
        let row = row.map_err(|error| {
            format!("read completed payment for ledger generation {order_id}: {error}")
        })?;
        let encoded = serde_json::to_vec(&row)
            .map_err(|error| format!("encode payment-ledger generation: {error}"))?;
        digest.update((encoded.len() as u64).to_le_bytes());
        digest.update(encoded);
    }
    let finalized = digest.finalize();
    let mut generation = [0_u8; 32];
    generation.copy_from_slice(&finalized);
    Ok(generation)
}

pub(crate) fn settlement_generation_token(generation: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut token = String::with_capacity(64);
    for byte in generation {
        token.push(HEX[(byte >> 4) as usize] as char);
        token.push(HEX[(byte & 0x0f) as usize] as char);
    }
    token
}

fn settlement_snapshot_json(snapshot: OrderSettlementSnapshot) -> Value {
    serde_json::json!({
        "orderTotal": snapshot.order_total,
        "netPaid": snapshot.net_paid,
        "outstandingAmount": snapshot.outstanding_amount,
        "completedPayments": snapshot.completed_payments,
        "generation": settlement_generation_token(&snapshot.ledger_generation),
    })
}

fn should_enforce_local_outstanding_guard(
    input: &PaymentRecordInput,
    options: &PaymentInsertOptions,
) -> bool {
    if input
        .payment_origin
        .eq_ignore_ascii_case("sync_reconstructed")
    {
        return false;
    }

    options
        .remote_payment_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
}

fn validate_payment_amount_against_outstanding(
    conn: &rusqlite::Connection,
    input: &PaymentRecordInput,
    options: &PaymentInsertOptions,
) -> Result<(), String> {
    if !should_enforce_local_outstanding_guard(input, options) {
        return Ok(());
    }

    let snapshot = load_order_payment_balance_snapshot(conn, &input.order_id)?;
    // W4e: integer-cent comparison. The half-cent epsilon that the float
    // path required (Wave 2a C3) goes away because integer comparison
    // is exact by construction. Both sides round half-even at the
    // f64-to-Cents boundary, then compare as i64.
    let input_amount_cents = Cents::round_half_even(input.amount).as_i64();
    let outstanding_cents = Cents::round_half_even(snapshot.outstanding_amount).as_i64();
    if input_amount_cents > outstanding_cents {
        return Err(format!(
            "Payment amount {:.2} exceeds outstanding balance {:.2} for order {} (total {:.2}, settled {:.2})",
            input.amount,
            snapshot.outstanding_amount,
            input.order_id,
            snapshot.order_total,
            snapshot.net_paid,
        ));
    }

    Ok(())
}

/// Derive the effective payment method for an order from its completed
/// `order_payments` rows.
///
/// Wave 6 C8 / H13 canonical reader: every consumer that used to read
/// `orders.payment_method` routes through this helper. Returns `None`
/// when no completed payments exist yet (pending order); returns
/// `"split"` for multi-method completions; otherwise returns the single
/// completed method's name (lowercased, trimmed), even when that method was
/// collected across multiple rows such as an edit top-up.
///
/// The stored `orders.payment_method` column was dropped in migration
/// v55 — no reader or writer touches it anymore.
pub(crate) fn derive_payment_method(
    conn: &Connection,
    order_id: &str,
) -> Result<Option<String>, String> {
    // Distinct completed methods for the order, lowercased so "Cash"/"CASH"
    // don't produce a false "split" classification.
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT LOWER(TRIM(COALESCE(method, '')))
             FROM order_payments
             WHERE order_id = ?1
               AND status = 'completed'
               AND TRIM(COALESCE(method, '')) != ''",
        )
        .map_err(|e| format!("prepare derive_payment_method: {e}"))?;
    let methods: Vec<String> = stmt
        .query_map(params![order_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("query derive_payment_method: {e}"))?
        .filter_map(Result::ok)
        .collect();

    Ok(match methods.as_slice() {
        [] => None,
        [single] => Some(single.clone()),
        _ => Some("split".to_string()),
    })
}

pub(crate) fn recompute_order_payment_state(
    conn: &Connection,
    order_id: &str,
    now: &str,
    payment_id: &str,
) -> Result<(), String> {
    let balance_snapshot = load_order_payment_balance_snapshot(conn, order_id)?;
    let total_paid = balance_snapshot.net_paid;
    let order_total = balance_snapshot.order_total;

    // W4e: integer-cent comparison. Wave 2a C3's symmetric MONEY_EPSILON
    // is no longer needed — the tolerance was a workaround for f64
    // aggregation drift, and integer cents have neither.
    let total_paid_cents = Cents::round_half_even(total_paid).as_i64();
    let order_total_cents = Cents::round_half_even(order_total).as_i64();
    let new_payment_status = if total_paid_cents <= 0 {
        "pending"
    } else if total_paid_cents >= order_total_cents {
        "paid"
    } else {
        "partially_paid"
    };

    // W6: `orders.payment_method` was dropped in migration v55. The
    // method classification is now derived on read via
    // `derive_payment_method(conn, order_id)` and never persisted.
    conn.execute(
        "UPDATE orders SET
            payment_status = ?1,
            payment_transaction_id = ?2,
            updated_at = ?3
         WHERE id = ?4",
        params![new_payment_status, payment_id, now, order_id],
    )
    .map_err(|e| format!("update order payment: {e}"))?;

    Ok(())
}

fn resolve_tip_recipient(
    conn: &Connection,
    input: &PaymentRecordInput,
    order_type: &str,
    branch_id: &str,
    terminal_id: &str,
    driver_id: Option<&str>,
    resolved_payment_shift_id: Option<&str>,
    resolved_payment_staff_id: Option<&str>,
) -> Result<(Option<String>, Option<String>, Option<String>), String> {
    if Cents::round_half_even(input.tip_amount).as_i64() <= 0 {
        return Ok((None, None, None));
    }

    let role = input
        .requested_tip_recipient_role
        .clone()
        .unwrap_or_else(|| {
            if order_type.eq_ignore_ascii_case("delivery") {
                "driver".to_string()
            } else {
                "cashier".to_string()
            }
        });

    match role.as_str() {
        "driver" => {
            if !order_type.eq_ignore_ascii_case("delivery") {
                return Err("Driver tips are only valid for delivery orders".to_string());
            }
            let Some(actual_driver_id) = driver_id.map(str::trim).filter(|value| !value.is_empty())
            else {
                // Delivery tips are intentionally durable before dispatch. The
                // driver-assignment command fills these two nullable fields.
                return Ok((Some(role), None, None));
            };
            let shift_id = order_ownership::resolve_driver_shift_id(
                conn,
                actual_driver_id,
                input.requested_tip_recipient_staff_shift_id.as_deref(),
            )?;
            Ok((Some(role), Some(actual_driver_id.to_string()), shift_id))
        }
        "waiter" => {
            let waiter_id = input
                .requested_tip_recipient_staff_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);

            let waiter_shift_id = if let Some(requested_shift_id) = input
                .requested_tip_recipient_staff_shift_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let Some((shift_role, shift_staff_id, shift_status)) =
                    load_shift_role_status_and_staff(conn, requested_shift_id)?
                else {
                    return Err(format!(
                        "Requested waiter shift {requested_shift_id} does not exist"
                    ));
                };
                if shift_role != "server" || shift_status != "active" {
                    return Err(format!(
                        "Requested waiter shift {requested_shift_id} is not an active waiter shift"
                    ));
                }
                if waiter_id.as_deref().is_some_and(|id| id != shift_staff_id) {
                    return Err(
                        "Requested waiter tip staff does not match the waiter shift".to_string()
                    );
                }
                Some(requested_shift_id.to_string())
            } else if let Some(waiter_id_value) = waiter_id.as_deref() {
                conn.query_row(
                    "SELECT id
                     FROM staff_shifts
                     WHERE staff_id = ?1
                       AND role_type = 'server'
                       AND status = 'active'
                     ORDER BY check_in_time DESC
                     LIMIT 1",
                    params![waiter_id_value],
                    |row| row.get::<_, String>(0),
                )
                .ok()
            } else {
                None
            };

            Ok((Some(role), waiter_id, waiter_shift_id))
        }
        "cashier" => {
            if let Some(requested_shift_id) = input
                .requested_tip_recipient_staff_shift_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let Some((shift_role, shift_staff_id, shift_status)) =
                    load_shift_role_status_and_staff(conn, requested_shift_id)?
                else {
                    return Err(format!(
                        "Requested cashier tip shift {requested_shift_id} does not exist"
                    ));
                };
                if !matches!(shift_role.as_str(), "cashier" | "manager") || shift_status != "active"
                {
                    return Err(format!(
                        "Requested cashier tip shift {requested_shift_id} is not an active cashier shift"
                    ));
                }
                return Ok((
                    Some(role),
                    Some(
                        input
                            .requested_tip_recipient_staff_id
                            .clone()
                            .unwrap_or(shift_staff_id),
                    ),
                    Some(requested_shift_id.to_string()),
                ));
            }

            let cashier_assignment =
                order_ownership::resolve_active_cashier_assignment(conn, branch_id, terminal_id)?
                    .or(
                        order_ownership::resolve_active_cashier_assignment_for_branch(
                            conn, branch_id,
                        )?,
                    )
                    .or_else(|| {
                        resolved_payment_shift_id
                            .zip(resolved_payment_staff_id)
                            .map(|(shift_id, staff_id)| {
                                (shift_id.to_string(), staff_id.to_string())
                            })
                    });

            let (shift_id, staff_id) =
                cashier_assignment.ok_or("No active cashier is available to receive this tip")?;
            Ok((Some(role), Some(staff_id), Some(shift_id)))
        }
        _ => Err(format!("Unsupported tip recipient role: {role}")),
    }
}

pub(crate) fn record_payment_in_connection(
    conn: &Connection,
    input: &PaymentRecordInput,
    options: &PaymentInsertOptions,
) -> Result<RecordedPayment, String> {
    let (
        supabase_id,
        order_type,
        branch_id,
        terminal_id,
        driver_id,
        order_staff_shift_id,
        order_staff_id,
        is_ghost,
    ): (
        Option<String>,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        bool,
    ) = conn
        .query_row(
            "SELECT
                supabase_id,
                COALESCE(order_type, 'dine-in'),
                COALESCE(branch_id, ''),
                COALESCE(terminal_id, ''),
                driver_id,
                staff_shift_id,
                staff_id,
                COALESCE(is_ghost, 0)
             FROM orders
             WHERE id = ?1",
            params![input.order_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get::<_, i64>(7)? != 0,
                ))
            },
        )
        .map_err(|_| format!("Order not found: {}", input.order_id))?;

    if is_ghost {
        return Err(format!(
            "Cannot record payment for ghost order: {}",
            input.order_id
        ));
    }

    let sync_state = options.sync_state.clone().unwrap_or_else(|| {
        if supabase_id.as_deref().unwrap_or("").trim().is_empty() {
            "waiting_parent".to_string()
        } else {
            "pending".to_string()
        }
    });
    let payment_id = options
        .payment_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let created_at = options
        .created_at
        .clone()
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let updated_at = options
        .updated_at
        .clone()
        .unwrap_or_else(|| created_at.clone());

    let keep_delivery_unassigned = order_type.eq_ignore_ascii_case("delivery")
        && driver_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none();

    let cashier_collected_delivery_cash = order_type.eq_ignore_ascii_case("delivery")
        && input.method == "cash"
        && matches!(input.collected_by.as_deref(), Some("cashier_drawer"));
    let explicit_cashier_drawer_shift =
        matches!(input.collected_by.as_deref(), Some("cashier_drawer"))
            && input
                .requested_staff_shift_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_some();

    // Mirrored/reconstructed payments ('sync_reconstructed' origin) describe
    // money that changed hands on ANOTHER terminal — e.g. a waiter phone that
    // collected cash at the table. They must keep the ORDER's own shift
    // attribution: routing them through resolve_order_owner stamped THIS
    // register's active cashier onto satellite money, pulling it into the
    // local drawer's expected cash before any handover (field 30/08, geminix
    // org — the +53€ that was never in the drawer). Every at-the-till flow
    // ('terminal' AND 'manual' origins) keeps today's ownership resolution.
    let mirrored_with_order_shift = input.payment_origin == "sync_reconstructed"
        && order_staff_shift_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();

    let (resolved_shift_id, resolved_staff_id) = if explicit_cashier_drawer_shift {
        let shift_id = input
            .requested_staff_shift_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .ok_or("Cashier-collected payments require a cashier shift context")?;
        let Some((role_type, shift_staff_id, _)) =
            load_shift_role_status_and_staff(conn, &shift_id)?
        else {
            return Err(format!(
                "Requested cashier shift {shift_id} does not exist for this payment"
            ));
        };
        if role_type != "cashier" && role_type != "manager" {
            return Err(format!(
                "Requested shift {shift_id} is not a cashier or manager drawer"
            ));
        }
        let staff_id = input
            .requested_staff_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .or(Some(shift_staff_id));
        (Some(shift_id), staff_id)
    } else if mirrored_with_order_shift {
        (order_staff_shift_id.clone(), order_staff_id.clone())
    } else if keep_delivery_unassigned {
        (None, None)
    } else if cashier_collected_delivery_cash {
        return Err(
            "Cashier-collected delivery payments require a cashier shift context".to_string(),
        );
    } else {
        order_ownership::resolve_order_owner(
            conn,
            &order_type,
            &branch_id,
            &terminal_id,
            driver_id.as_deref(),
            input
                .requested_staff_shift_id
                .as_deref()
                .or(order_staff_shift_id.as_deref()),
            input
                .requested_staff_id
                .as_deref()
                .or(order_staff_id.as_deref()),
        )?
    };
    let (tip_recipient_role, tip_recipient_staff_id, tip_recipient_staff_shift_id) =
        resolve_tip_recipient(
            conn,
            input,
            &order_type,
            &branch_id,
            &terminal_id,
            driver_id.as_deref(),
            resolved_shift_id.as_deref(),
            resolved_staff_id.as_deref(),
        )?;

    validate_payment_amount_against_outstanding(conn, input, options)?;

    if options.sync_order_owner_with_payment
        && (resolved_shift_id != order_staff_shift_id || resolved_staff_id != order_staff_id)
    {
        let update_sql = if options.mark_order_sync_pending_on_owner_change {
            "UPDATE orders
             SET staff_shift_id = ?1,
                 staff_id = ?2,
                 sync_status = 'pending',
                 updated_at = ?3
             WHERE id = ?4"
        } else {
            "UPDATE orders
             SET staff_shift_id = ?1,
                 staff_id = ?2,
                 updated_at = ?3
             WHERE id = ?4"
        };
        conn.execute(
            update_sql,
            params![
                resolved_shift_id,
                resolved_staff_id,
                updated_at,
                input.order_id
            ],
        )
        .map_err(|e| format!("update order ownership for payment: {e}"))?;
    }

    // W4c dual-write: every monetary REAL column gets its `_cents` sibling
    // populated from the same input value via `Cents::round_half_even`.
    let amount_cents = Cents::round_half_even(input.amount).as_i64();
    let cash_received_cents = input
        .cash_received
        .map(|v| Cents::round_half_even(v).as_i64());
    let change_given_cents = input
        .change_given
        .map(|v| Cents::round_half_even(v).as_i64());
    let discount_amount_cents = Cents::round_half_even(input.discount_amount).as_i64();
    let tip_amount_cents = Cents::round_half_even(input.tip_amount).as_i64();
    conn.execute(
        "INSERT INTO order_payments (
            id, order_id, method, amount, amount_cents, currency, status,
            cash_received, cash_received_cents, change_given, change_given_cents,
            transaction_ref, discount_amount, discount_amount_cents,
            tip_amount, tip_amount_cents, tip_recipient_role,
            tip_recipient_staff_id, tip_recipient_staff_shift_id,
            payment_origin, terminal_device_id,
            remote_payment_id, idempotency_key, staff_id, staff_shift_id, sync_status,
            sync_state, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, 'completed', ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21,
            ?22, ?23, ?24, ?25, ?26, ?27, ?28
        )",
        params![
            payment_id,
            input.order_id,
            input.method,
            input.amount,
            amount_cents,
            input.currency,
            input.cash_received,
            cash_received_cents,
            input.change_given,
            change_given_cents,
            input.transaction_ref,
            input.discount_amount,
            discount_amount_cents,
            input.tip_amount,
            tip_amount_cents,
            tip_recipient_role,
            tip_recipient_staff_id,
            tip_recipient_staff_shift_id,
            input.payment_origin,
            input.terminal_device_id,
            options.remote_payment_id,
            input.idempotency_key,
            resolved_staff_id,
            resolved_shift_id,
            options.sync_status,
            sync_state,
            created_at,
            updated_at,
        ],
    )
    .map_err(|e| format!("insert payment: {e}"))?;

    for item in &input.items {
        let item_id = Uuid::new_v4().to_string();
        // W4c dual-write: populate `item_amount_cents` alongside REAL.
        let item_amount_cents = Cents::round_half_even(item.item_amount).as_i64();
        conn.execute(
            "INSERT INTO payment_items (id, payment_id, order_id, item_index, item_name, item_quantity, item_amount, item_amount_cents)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                item_id,
                payment_id,
                input.order_id,
                item.item_index,
                item.item_name,
                item.item_quantity,
                item.item_amount,
                item_amount_cents,
            ],
        )
        .map_err(|e| format!("insert payment item: {e}"))?;
    }

    recompute_order_payment_state(conn, &input.order_id, &updated_at, &payment_id)?;

    if order_type.eq_ignore_ascii_case("delivery")
        && matches!(input.collected_by.as_deref(), Some("driver_shift"))
    {
        match input.method.as_str() {
            "cash" => {
                // W4c dual-write: mirror cash_collected / cash_to_return onto cents.
                let updated = conn
                    .execute(
                        "UPDATE driver_earnings
                     SET cash_collected = COALESCE(cash_collected, 0) + ?1,
                         cash_collected_cents = COALESCE(cash_collected_cents, 0) + ?2,
                         cash_to_return = COALESCE(cash_to_return, 0) + ?1,
                         cash_to_return_cents = COALESCE(cash_to_return_cents, 0) + ?2,
                         payment_method = CASE
                            WHEN COALESCE(card_amount, 0) > 0 THEN 'mixed'
                            ELSE 'cash'
                         END,
                         updated_at = ?3
                     WHERE order_id = ?4
                       AND COALESCE(settled, 0) = 0
                       AND COALESCE(is_transferred, 0) = 0",
                        params![input.amount, amount_cents, updated_at, input.order_id],
                    )
                    .map_err(|e| format!("update driver cash earnings: {e}"))?;
                if updated == 0 {
                    return Err(
                        "Driver cash payment requires an active unsettled driver earning".into(),
                    );
                }
            }
            "card" => {
                // W4c dual-write: mirror card_amount onto cents.
                let updated = conn
                    .execute(
                        "UPDATE driver_earnings
                     SET card_amount = COALESCE(card_amount, 0) + ?1,
                         card_amount_cents = COALESCE(card_amount_cents, 0) + ?2,
                         payment_method = CASE
                            WHEN COALESCE(cash_collected, 0) > 0 THEN 'mixed'
                            ELSE 'card'
                         END,
                         updated_at = ?3
                     WHERE order_id = ?4
                       AND COALESCE(settled, 0) = 0
                       AND COALESCE(is_transferred, 0) = 0",
                        params![input.amount, amount_cents, updated_at, input.order_id],
                    )
                    .map_err(|e| format!("update driver card earnings: {e}"))?;
                if updated == 0 {
                    return Err(
                        "Driver card payment requires an active unsettled driver earning".into(),
                    );
                }
            }
            _ => {}
        }
    }

    if options.update_cash_drawer {
        if let Some(ref sid) = resolved_shift_id {
            if input.method == "cash" {
                // W4c dual-write: mirror total_cash_sales onto cents.
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                        total_cash_sales = COALESCE(total_cash_sales, 0) + ?1,
                        total_cash_sales_cents = COALESCE(total_cash_sales_cents, 0) + ?2,
                        updated_at = ?3
                     WHERE staff_shift_id = ?4",
                    params![input.amount, amount_cents, updated_at, sid],
                )
                .map_err(|e| format!("update drawer cash_sales: {e}"))?;
            } else if input.method == "card" {
                // W4c dual-write: mirror total_card_sales onto cents.
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                        total_card_sales = COALESCE(total_card_sales, 0) + ?1,
                        total_card_sales_cents = COALESCE(total_card_sales_cents, 0) + ?2,
                        updated_at = ?3
                     WHERE staff_shift_id = ?4",
                    params![input.amount, amount_cents, updated_at, sid],
                )
                .map_err(|e| format!("update drawer card_sales: {e}"))?;
            }
        }
    }

    if options.enqueue_sync {
        let queue_status = if sync_state == "waiting_parent" {
            "deferred"
        } else {
            "pending"
        };
        // W4d-i: additive cents emission alongside legacy float keys.
        // Admin-dashboard still reads the float keys; cents keys are
        // forward-compat for the wire-format cutover follow-up.
        let sync_payload = serde_json::json!({
            "paymentId": payment_id,
            "orderId": input.order_id,
            "method": input.method,
            "amount": input.amount,
            "amount_cents": Cents::round_half_even(input.amount).as_i64(),
            "tipAmount": input.tip_amount,
            "tip_amount": input.tip_amount,
            "tip_amount_cents": Cents::round_half_even(input.tip_amount).as_i64(),
            "tipRecipientRole": tip_recipient_role,
            "tip_recipient_role": tip_recipient_role,
            "tipRecipientStaffId": tip_recipient_staff_id,
            "tip_recipient_staff_id": tip_recipient_staff_id,
            "tipRecipientStaffShiftId": tip_recipient_staff_shift_id,
            "tip_recipient_staff_shift_id": tip_recipient_staff_shift_id,
            "currency": input.currency,
            "cashReceived": input.cash_received,
            "cash_received_cents": input.cash_received
                .map(|v| Cents::round_half_even(v).as_i64()),
            "changeGiven": input.change_given,
            "change_given_cents": input.change_given
                .map(|v| Cents::round_half_even(v).as_i64()),
            "transactionRef": input.transaction_ref,
            "discountAmount": input.discount_amount,
            "discount_amount_cents": Cents::round_half_even(input.discount_amount).as_i64(),
            "paymentOrigin": input.payment_origin,
            "terminalDeviceId": input.terminal_device_id,
            "tableSessionId": input.table_session_id,
            "table_session_id": input.table_session_id,
            "seatNumber": input.seat_number,
            "seat_number": input.seat_number,
            "collectedBy": input.collected_by,
            "staffId": resolved_staff_id,
            "staffShiftId": resolved_shift_id,
            "items": build_payment_items_json(&input.items),
        });
        crate::sync::upsert_payment_sync_queue_row(
            conn,
            &payment_id,
            &sync_payload.to_string(),
            queue_status,
            0,
            None,
            None,
            None,
            &updated_at,
        )
        .map_err(|e| format!("enqueue canonical payment sync: {e}"))?;
        // Wave 5 Session 7 PR 0: removed the defensive
        // `DELETE FROM parity_sync_queue WHERE table_name = 'payments'`
        // that used to sit here — with the producer cutover it would
        // delete the very row `upsert_payment_sync_queue_row` just
        // enqueued (`table_name='payments'` is now the canonical key,
        // not a legacy-shape marker). `sync_queue::clear_unsynced_items`
        // inside the producer already clears stale pending rows
        // atomically with the enqueue.
    }

    Ok(RecordedPayment {
        payment_id,
        payment_origin: input.payment_origin.clone(),
        sync_status: options.sync_status.clone(),
        sync_state,
    })
}

// ---------------------------------------------------------------------------
// Record payment
// ---------------------------------------------------------------------------

/// Record a payment for an order.
///
/// Inserts into `order_payments`, updates the order's `payment_status`
/// and `payment_method`, and enqueues a sync entry.
/// THE-437: how a food-delivery platform order settles from the store's side.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum PlatformSettlementKind {
    /// The customer paid the platform online — the money arrives by bank
    /// settlement, never through this till.
    PrepaidOnline,
    /// Cash on delivery collected by the PLATFORM's own rider — same as
    /// prepaid from the store's point of view: the platform banks it.
    /// COD carried by the STORE's driver is deliberately NOT here; that cash
    /// really does enter the drawer through the normal collection flow.
    PlatformCollectedCod,
}

impl PlatformSettlementKind {
    /// Order-specific reference: sync forwards transaction_ref as the server's
    /// org-wide `external_transaction_id`, so a constant here would 409 every
    /// settlement after the first. The Z-report classifier matches on the
    /// `platform_settlement:{kind}` prefix.
    fn transaction_ref(self, order_id: &str) -> String {
        match self {
            PlatformSettlementKind::PrepaidOnline => {
                format!("platform_settlement:online:{order_id}")
            }
            PlatformSettlementKind::PlatformCollectedCod => {
                format!("platform_settlement:cod:{order_id}")
            }
        }
    }
}

/// Reads the order's platform payment disposition from
/// `ghost_metadata.food_delivery` (written by the aggregator ingest, PR #155).
/// Returns None for non-platform orders and for platform COD carried by the
/// store's own driver — those must go through real payment collection.
pub(crate) fn platform_settlement_kind(
    conn: &Connection,
    order_id: &str,
) -> Option<PlatformSettlementKind> {
    let (plugin, external_order_id, ghost_metadata): (String, String, String) = conn
        .query_row(
            "SELECT COALESCE(plugin, ''), COALESCE(external_plugin_order_id, ''),
                    COALESCE(ghost_metadata, '')
             FROM orders WHERE id = ?1",
            params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok()?;

    let food_delivery = serde_json::from_str::<Value>(&ghost_metadata)
        .ok()
        .and_then(|value| value.get("food_delivery").cloned());
    // A platform order announces itself through any of: a recognized plugin
    // id, a provider-side order id, or the aggregator metadata the ingest
    // writes. Legacy local rows can miss the first two — the realtime ingest
    // read the broadcast's `plugin` field while the server column is
    // `platform`, and databases predating migrate_v75 had no
    // external_plugin_order_id column at all — so the metadata alone must be
    // sufficient (live diagnosis, Το Μικρό Παρίσι 31/08/2026: every efood
    // order classified as non-platform and THE-437 never settled).
    let is_platform_order = crate::print::is_food_delivery_plugin(&plugin)
        || !external_order_id.trim().is_empty()
        || food_delivery.is_some();
    if !is_platform_order {
        return None;
    }

    let food_delivery = food_delivery?;
    let prepaid = food_delivery.get("prepaid").and_then(Value::as_bool) == Some(true);
    let method = food_delivery
        .get("payment_method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let provider = food_delivery
        .get("delivery_provider")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    if prepaid || method == "online" {
        return Some(PlatformSettlementKind::PrepaidOnline);
    }
    if method == "cash" && provider == "platform_delivery" {
        return Some(PlatformSettlementKind::PlatformCollectedCod);
    }
    None
}

/// THE-437: settle a platform-settled order automatically when it is marked
/// delivered/completed. The operator must never be asked to "collect" money
/// the platform is holding — prepaid orders and COD carried by the platform's
/// rider both arrive by bank settlement. Records the outstanding balance as
/// `method='other'`, which by construction never credits
/// `cash_drawer_sessions.total_cash_sales`, so the drawer expectation stays
/// untouched. Returns Ok(true) when a payment row was written.
pub(crate) fn auto_settle_platform_order(
    conn: &Connection,
    order_id: &str,
) -> Result<bool, String> {
    let Some(kind) = platform_settlement_kind(conn, order_id) else {
        return Ok(false);
    };
    let snapshot = load_order_payment_balance_snapshot(conn, order_id)?;
    if Cents::round_half_even(snapshot.outstanding_amount).as_i64() <= 0 {
        return Ok(false);
    }

    let input = PaymentRecordInput {
        order_id: order_id.to_string(),
        method: "other".to_string(),
        amount: snapshot.outstanding_amount,
        currency: "EUR".to_string(),
        tip_amount: 0.0,
        cash_received: None,
        change_given: None,
        transaction_ref: Some(kind.transaction_ref(order_id)),
        idempotency_key: Some(format!("platform-settle-{order_id}")),
        discount_amount: 0.0,
        payment_origin: "manual".to_string(),
        terminal_device_id: None,
        table_session_id: None,
        seat_number: None,
        requested_staff_id: None,
        requested_staff_shift_id: None,
        requested_tip_recipient_role: None,
        requested_tip_recipient_staff_id: None,
        requested_tip_recipient_staff_shift_id: None,
        collected_by: None,
        items: Vec::new(),
    };

    // The sync path can call this from inside an open transaction; only manage
    // one of our own when the connection is in autocommit mode.
    let own_transaction = conn.is_autocommit();
    if own_transaction {
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| format!("begin platform settlement: {e}"))?;
    }
    let outcome = record_payment_in_connection(conn, &input, &PaymentInsertOptions::local());
    match outcome {
        Ok(_) => {
            if own_transaction {
                conn.execute_batch("COMMIT")
                    .map_err(|e| format!("commit platform settlement: {e}"))?;
            }
            Ok(true)
        }
        Err(error) => {
            if own_transaction {
                let _ = conn.execute_batch("ROLLBACK");
            }
            Err(error)
        }
    }
}

#[allow(clippy::type_complexity)]
pub fn record_payment(db: &DbState, payload: &Value) -> Result<Value, String> {
    record_payment_with_expected_balance(db, payload, None)
}

/// Persist a payment and return a settlement snapshot captured before the same
/// write transaction commits. `expected_balance` is supplied by the
/// command layer after fiscal checkout; if another mutation changed the
/// balance while hardware was processing, persistence fails closed instead of
/// attaching the approval reference to a different amount.
pub(crate) fn record_payment_with_expected_balance(
    db: &DbState,
    payload: &Value,
    expected_balance: Option<OrderPaymentBalanceSnapshot>,
) -> Result<Value, String> {
    let mut prepared_payload = payload.clone();
    let mut input = build_payment_record_input(&prepared_payload)?;
    if input.method != "cash" && input.method != "card" && input.method != "room_charge" {
        return Err(
            "Only cash, card, and room_charge payments can be recorded locally".to_string(),
        );
    }
    let mut options = PaymentInsertOptions::local();
    if matches!(input.collected_by.as_deref(), Some("cashier_drawer")) {
        options.sync_order_owner_with_payment = false;
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    input.order_id = resolve_order_id(&conn, &input.order_id)
        .ok_or_else(|| format!("Order not found: {}", input.order_id))?;
    let collect_outstanding = payload_collects_outstanding_balance(&prepared_payload);
    let mut persist_transaction =
        || -> Result<(RecordedPayment, OrderSettlementSnapshot), String> {
            conn.execute_batch("BEGIN IMMEDIATE")
                .map_err(|e| format!("begin transaction: {e}"))?;
            let outcome = (|| -> Result<(RecordedPayment, OrderSettlementSnapshot), String> {
                if collect_outstanding {
                    let current = load_order_payment_balance_snapshot(&conn, &input.order_id)?;
                    if let Some(expected) = expected_balance {
                        let expected_generation = (
                            Cents::round_half_even(expected.order_total).as_i64(),
                            Cents::round_half_even(expected.net_paid).as_i64(),
                            Cents::round_half_even(expected.outstanding_amount).as_i64(),
                            expected.completed_payment_count,
                            expected.ledger_generation,
                        );
                        let current_generation = (
                            Cents::round_half_even(current.order_total).as_i64(),
                            Cents::round_half_even(current.net_paid).as_i64(),
                            Cents::round_half_even(current.outstanding_amount).as_i64(),
                            current.completed_payment_count,
                            current.ledger_generation,
                        );
                        if expected_generation != current_generation {
                            return Err(format!(
                        "Outstanding balance changed during payment collection (expected {:.2}, current {:.2})",
                        expected.outstanding_amount,
                        current.outstanding_amount,
                    ));
                        }
                    }
                    prepare_outstanding_collection_payload(&mut prepared_payload, current)?;
                    input = build_payment_record_input(&prepared_payload)?;
                    input.order_id = resolve_order_id(&conn, &input.order_id)
                        .ok_or_else(|| "Order not found".to_string())?;
                }

                let outstanding_attempt_id = if collect_outstanding {
                    match (
                        input.transaction_ref.as_deref(),
                        input.idempotency_key.as_deref(),
                    ) {
                        (Some(transaction_ref), Some(idempotency_key))
                            if transaction_ref.starts_with("fiscal-outstanding-")
                                && transaction_ref == idempotency_key =>
                        {
                            Some(transaction_ref.to_string())
                        }
                        (Some(transaction_ref), _)
                            if transaction_ref.starts_with("fiscal-outstanding-") =>
                        {
                            return Err(
                        "Outstanding fiscal payment identity does not match its durable attempt"
                            .to_string(),
                    );
                        }
                        _ => None,
                    }
                } else {
                    None
                };
                if let Some(attempt_id) = outstanding_attempt_id.as_deref() {
                    crate::db::ecr_begin_outstanding_payment_persist(
                        &conn,
                        attempt_id,
                        &input.order_id,
                    )?;
                }
                let recorded = record_payment_in_connection(&conn, &input, &options)?;
                if let Some(attempt_id) = outstanding_attempt_id.as_deref() {
                    crate::db::ecr_finish_outstanding_payment_persist(
                        &conn,
                        attempt_id,
                        &input.order_id,
                    )?;
                }
                let settlement = load_order_settlement_snapshot(&conn, &input.order_id)?;
                Ok((recorded, settlement))
            })();

            match outcome {
                Ok(outcome) => match conn.execute_batch("COMMIT") {
                    Ok(()) => Ok(outcome),
                    Err(error) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        Err(format!("commit: {error}"))
                    }
                },
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        };
    let (recorded, settlement) = if collect_outstanding {
        // Both the exact payment representation and the attempt finalization
        // must survive power loss together. The rest of the POS stays on the
        // normal WAL policy; only this high-value commit opts into FULL sync.
        crate::db::with_full_sync(&conn, |_| persist_transaction())?
    } else {
        persist_transaction()?
    };
    info!(
        payment_id = %recorded.payment_id,
        order_id = %input.order_id,
        method = %input.method,
        amount = %input.amount,
        "Payment recorded"
    );
    let settlement_json = settlement_snapshot_json(settlement);

    Ok(serde_json::json!({
        "success": true,
        "orderId": input.order_id,
        "paymentId": recorded.payment_id,
        "method": input.method,
        "amount": input.amount,
        "settlement": settlement_json,
        "paymentOrigin": recorded.payment_origin,
        "syncStatus": recorded.sync_status,
        "syncState": recorded.sync_state,
        "message": format!("Payment of {:.2} recorded", input.amount),
    }))
}

pub fn resolve_unsettled_payment_blocker_payment(
    db: &DbState,
    payload: &Value,
) -> Result<Value, String> {
    let order_id_raw = str_field(payload, "orderId")
        .or_else(|| str_field(payload, "order_id"))
        .ok_or("Missing orderId")?;
    let method = match str_field(payload, "method")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "cash" => "cash",
        "card" => "card",
        _ => return Err("Invalid method. Must be cash or card".to_string()),
    };

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let actual_order_id =
        resolve_order_id(&conn, &order_id_raw).ok_or_else(|| "Order not found".to_string())?;
    let blockers = payment_integrity::load_order_payment_blockers(&conn, &actual_order_id)?;
    let Some(blocker) = blockers.first() else {
        return Ok(build_payment_blocker_failure(
            "This order no longer has a payment blocker. Refresh the payment blockers and try again.",
            &[],
        ));
    };

    if !blocker_is_resolvable_from_z_report(blocker) {
        return Ok(build_payment_blocker_failure(
            "This blocker needs manual review and cannot be repaired automatically from this screen.",
            &blockers,
        ));
    }

    let balance_snapshot = load_order_payment_balance_snapshot(&conn, &actual_order_id)?;
    let outstanding_amount = balance_snapshot.outstanding_amount;
    // W4e: integer-cent zero check. The bare-literal regression (Wave 2a C3
    // commentary) is now structurally impossible because `Cents` doesn't
    // permit arbitrary literals — every comparison goes through
    // `round_half_even`.
    if Cents::round_half_even(outstanding_amount).as_i64() <= 0 {
        return Ok(build_payment_blocker_failure(
            "This order no longer has a collectible outstanding balance. Refresh the payment blockers and try again.",
            &blockers,
        ));
    }
    let requested_shift_id = str_field(payload, "staffShiftId")
        .or_else(|| str_field(payload, "staff_shift_id").or_else(|| str_field(payload, "shiftId")));
    let requested_staff_id =
        str_field(payload, "staffId").or_else(|| str_field(payload, "staff_id"));
    let repair_context = match requested_shift_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(shift_id) => match resolve_checkout_cashier_repair_context(
            &conn,
            &actual_order_id,
            shift_id,
            requested_staff_id,
        ) {
            Ok(context) => context,
            Err(error) => return Ok(build_payment_blocker_failure(error, &blockers)),
        },
        None => match resolve_historical_cashier_repair_context(&conn, &actual_order_id) {
            Ok(context) => context,
            Err(error) => return Ok(build_payment_blocker_failure(error, &blockers)),
        },
    };

    let now = repair_context.recorded_at.clone();
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<Value, String> {
        let record_payload = serde_json::json!({
            "orderId": actual_order_id.clone(),
            "method": method,
            "amount": outstanding_amount,
            "cashReceived": if method == "cash" { Some(outstanding_amount) } else { None::<f64> },
            "changeGiven": if method == "cash" { Some(0.0) } else { None::<f64> },
            "paymentOrigin": "manual",
            "staffId": repair_context.staff_id.clone(),
            "staffShiftId": repair_context.shift_id.clone(),
            "collectedBy": "cashier_drawer",
        });
        let input = build_payment_record_input(&record_payload)?;
        let mut options = PaymentInsertOptions::local();
        options.sync_order_owner_with_payment = false;
        options.mark_order_sync_pending_on_owner_change = false;
        options.created_at = Some(now.clone());
        options.updated_at = Some(now.clone());

        let recorded = record_payment_in_connection(&conn, &input, &options)?;

        if repair_context.shift_status == "closed" {
            shifts::recompute_closed_cashier_shift_financial_snapshot(
                &conn,
                &repair_context.shift_id,
                &now,
            )?;
            shifts::replace_unfinished_shift_sync_rows_with_current_snapshot(
                &conn,
                &repair_context.shift_id,
                &now,
            )?;
        }

        let remaining_blockers =
            payment_integrity::load_order_payment_blockers(&conn, &actual_order_id)?;

        Ok(serde_json::json!({
            "success": true,
            "orderId": actual_order_id.clone(),
            "paymentId": recorded.payment_id,
            "method": method,
            "amount": outstanding_amount,
            "recordedAt": now,
            "cashierShiftId": repair_context.shift_id.clone(),
            "remainingBlockers": remaining_blockers,
        }))
    })();

    match result {
        Ok(value) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub(crate) fn build_payment_sync_payload_for_payment(
    conn: &Connection,
    payment_id: &str,
) -> Result<String, String> {
    type PaymentSyncRow = (
        String,
        String,
        f64,
        String,
        Option<f64>,
        Option<f64>,
        Option<String>,
        f64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        f64,
        Option<String>,
        Option<String>,
        Option<String>,
    );

    let (
        order_id,
        method,
        amount,
        currency,
        cash_received,
        change_given,
        transaction_ref,
        discount_amount,
        payment_origin,
        remote_payment_id,
        idempotency_key,
        terminal_device_id,
        staff_id,
        staff_shift_id,
        tip_amount,
        tip_recipient_role,
        tip_recipient_staff_id,
        tip_recipient_staff_shift_id,
    ): PaymentSyncRow = conn
        .query_row(
            // W4b: cols 2 (amount), 4 (cash_received), 5 (change_given),
            // and 7 (discount_amount) read cents-with-real-fallback shim
            // so legacy fixtures keep working until 4e. Each is exposed
            // as f64 to keep PaymentSyncRow's existing types.
            "SELECT order_id, method,
                    COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0),
                    currency,
                    COALESCE(cash_received_cents, CAST(ROUND(cash_received * 100) AS INTEGER)),
                    COALESCE(change_given_cents, CAST(ROUND(change_given * 100) AS INTEGER)),
                    transaction_ref,
                    COALESCE(discount_amount_cents, CAST(ROUND(discount_amount * 100) AS INTEGER), 0),
                    COALESCE(payment_origin, 'manual'), remote_payment_id, idempotency_key, terminal_device_id,
                    staff_id, staff_shift_id,
                    COALESCE(tip_amount_cents, CAST(ROUND(tip_amount * 100) AS INTEGER), 0),
                    tip_recipient_role, tip_recipient_staff_id, tip_recipient_staff_shift_id
             FROM order_payments
             WHERE id = ?1",
            params![payment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
                    row.get(3)?,
                    row.get::<_, Option<i64>>(4)?
                        .map(|c| Cents::new(c).to_f64_dp2()),
                    row.get::<_, Option<i64>>(5)?
                        .map(|c| Cents::new(c).to_f64_dp2()),
                    row.get(6)?,
                    Cents::new(row.get::<_, i64>(7)?).to_f64_dp2(),
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    Cents::new(row.get::<_, i64>(14)?).to_f64_dp2(),
                    row.get(15)?,
                    row.get(16)?,
                    row.get(17)?,
                ))
            },
        )
        .map_err(|e| format!("load payment sync payload context: {e}"))?;

    let items = load_payment_items_for_payment(conn, payment_id)?;
    let settlement_adjustments =
        load_edit_settlement_refund_proof_for_payment(conn, payment_id, order_id.as_str())?;
    // W4d-i: additive cents emission alongside legacy float keys.
    // Admin-dashboard's Zod schema currently requires `amount` (float);
    // adding `amount_cents` (integer) lets a follow-up admin update
    // switch to cents preference. 4d-cleanup later removes the float keys.
    Ok(serde_json::json!({
        "paymentId": payment_id,
        "payment_id": payment_id,
        "local_payment_id": payment_id,
        "remote_payment_id": remote_payment_id,
        "canonical_payment_id": remote_payment_id,
        "idempotency_key": idempotency_key,
        "orderId": order_id,
        "method": method,
        "amount": amount,
        "amount_cents": Cents::round_half_even(amount).as_i64(),
        "currency": currency,
        "cashReceived": cash_received,
        "cash_received_cents": cash_received.map(|v| Cents::round_half_even(v).as_i64()),
        "changeGiven": change_given,
        "change_given_cents": change_given.map(|v| Cents::round_half_even(v).as_i64()),
        "transactionRef": transaction_ref,
        "discountAmount": discount_amount,
        "discount_amount_cents": Cents::round_half_even(discount_amount).as_i64(),
        "paymentOrigin": payment_origin,
        "terminalDeviceId": terminal_device_id,
        "staffId": staff_id,
        "staffShiftId": staff_shift_id,
        "tipAmount": tip_amount,
        "tip_amount": tip_amount,
        "tip_amount_cents": Cents::round_half_even(tip_amount).as_i64(),
        "tipRecipientRole": tip_recipient_role,
        "tip_recipient_role": tip_recipient_role,
        "tipRecipientStaffId": tip_recipient_staff_id,
        "tip_recipient_staff_id": tip_recipient_staff_id,
        "tipRecipientStaffShiftId": tip_recipient_staff_shift_id,
        "tip_recipient_staff_shift_id": tip_recipient_staff_shift_id,
        "items": if items.is_empty() { Value::Null } else { Value::Array(items) },
        "settlement_adjustments": if settlement_adjustments.is_empty() {
            Value::Null
        } else {
            Value::Array(settlement_adjustments)
        },
    })
    .to_string())
}

pub(crate) fn refresh_payment_sync_queue_entry(
    conn: &Connection,
    payment_id: &str,
) -> Result<(), String> {
    let (order_id, has_supabase_id): (String, i64) = conn
        .query_row(
            "SELECT op.order_id,
                    CASE WHEN COALESCE(o.supabase_id, '') != '' THEN 1 ELSE 0 END
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE op.id = ?1",
            params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("load payment queue context: {e}"))?;
    let now = Utc::now().to_rfc3339();
    let sync_state = if has_supabase_id == 1 {
        "pending"
    } else {
        "waiting_parent"
    };
    let sync_payload =
        serde_json::from_str::<Value>(&build_payment_sync_payload_for_payment(conn, payment_id)?)
            .map_err(|e| format!("parse refreshed payment sync payload: {e}"))?;

    let queue_status = if sync_state == "waiting_parent" {
        "deferred"
    } else {
        "pending"
    };
    crate::sync::upsert_payment_sync_queue_row(
        conn,
        payment_id,
        &sync_payload.to_string(),
        queue_status,
        0,
        None,
        None,
        None,
        &now,
    )
    .map_err(|e| format!("refresh canonical payment queue row: {e}"))?;
    // Wave 5 Session 7 PR 0: removed the defensive
    // `DELETE FROM parity_sync_queue WHERE table_name = 'payments'`
    // that used to sit here. Same reasoning as in `record_payment`:
    // with the producer cutover the row has become canonical and
    // deleting it right after enqueue would reproduce the 2026-04-22
    // dual-queue regression. The producer's own `clear_unsynced_items`
    // call handles stale-row cleanup.

    conn.execute(
        "UPDATE order_payments
         SET sync_status = 'pending',
             sync_state = ?1,
             sync_retry_count = 0,
             sync_last_error = NULL,
             sync_next_retry_at = NULL,
             updated_at = ?2
         WHERE id = ?3",
        params![sync_state, now, payment_id],
    )
    .map_err(|e| format!("mark payment pending sync: {e}"))?;

    conn.execute(
        "UPDATE orders
         SET sync_status = 'pending',
             updated_at = ?1
         WHERE id = ?2",
        params![now, order_id],
    )
    .map_err(|e| format!("mark order pending sync after payment method edit: {e}"))?;

    Ok(())
}

fn payment_sync_queue_needs_retry(conn: &Connection, payment_id: &str) -> Result<bool, String> {
    // Wave 5 Session 7 PR 0: canonical payment queue rows live on
    // `parity_sync_queue` under `(table_name='payments', record_id=payment_id)`.
    // Column names differ from the legacy `sync_queue` schema:
    //   - `attempts` replaces `retry_count`
    //   - `error_message` replaces `last_error`
    // Status precedence in the ORDER BY mirrors the legacy intent —
    // inspect `failed`/`conflict` rows first if multiple history rows
    // sit in the same `(table_name, record_id)` bucket. Parity's
    // `processing` replaces legacy `in_progress`; `queued_remote` has
    // no direct parity analogue and falls to the `_ => 9` tail.
    let queue_row: Option<(String, i64, Option<String>, Option<String>)> = match conn.query_row(
        "SELECT status,
                COALESCE(attempts, 0),
                next_retry_at,
                error_message
         FROM parity_sync_queue
         WHERE table_name = 'payments'
           AND record_id = ?1
         ORDER BY
           CASE status
             WHEN 'failed' THEN 0
             WHEN 'conflict' THEN 1
             WHEN 'deferred' THEN 2
             WHEN 'pending' THEN 3
             WHEN 'processing' THEN 4
             ELSE 9
           END,
           datetime(created_at) DESC,
           id DESC
         LIMIT 1",
        params![payment_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ) {
        Ok(row) => Some(row),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(format!("load payment queue retry state: {e}")),
    };

    let Some((status, attempts, next_retry_at, error_message)) = queue_row else {
        return Ok(false);
    };

    let normalized_status = status.trim().to_ascii_lowercase();
    if normalized_status == "failed" || normalized_status == "conflict" {
        return Ok(true);
    }

    if normalized_status == "pending" {
        let has_error_message = error_message
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        return Ok(attempts > 0 || next_retry_at.is_some() || has_error_message);
    }

    Ok(false)
}

fn enqueue_order_payment_snapshot_sync(
    conn: &Connection,
    order_id: &str,
    payment_status: &str,
    payment_method: &str,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "orderId": order_id,
        "paymentStatus": payment_status,
        "paymentMethod": payment_method,
    });
    crate::sync_queue::enqueue_payload_item(
        conn,
        "orders",
        order_id,
        "UPDATE",
        &payload,
        Some(0),
        Some("orders"),
        Some("server-wins"),
        Some(1),
    )
    .map_err(|e| format!("enqueue order payment snapshot parity sync: {e}"))?;

    Ok(())
}

fn refresh_driver_earning_for_payment_method_edit(
    conn: &Connection,
    order_id: &str,
    now: &str,
) -> Result<(), String> {
    let Some(earning_id) =
        crate::order_ownership::refresh_existing_driver_earning_payment_snapshot(
            conn, order_id, now,
        )?
    else {
        return Ok(());
    };
    let payload = crate::order_ownership::build_driver_earning_sync_payload(conn, &earning_id)?;
    crate::order_ownership::enqueue_or_refresh_driver_earning_sync_row(conn, &earning_id, &payload)
}

fn order_has_adjustment_or_finalized_payment(
    conn: &Connection,
    order_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT CASE WHEN
            EXISTS(
                SELECT 1 FROM payment_adjustments
                WHERE order_id = ?1
            ) OR EXISTS(
                SELECT 1 FROM order_payments
                WHERE order_id = ?1
                  AND LOWER(TRIM(COALESCE(status, ''))) IN ('refunded', 'voided')
            )
            THEN 1 ELSE 0 END",
        params![order_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|e| format!("check payment adjustments before method edit: {e}"))
}

fn order_has_driver_earning(conn: &Connection, order_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM driver_earnings WHERE order_id = ?1)",
        params![order_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|e| format!("check courier earning before payment snapshot fallback: {e}"))
}

fn ensure_driver_earning_sync_is_not_processing(
    conn: &Connection,
    order_id: &str,
) -> Result<(), String> {
    let is_processing = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM driver_earnings de
                JOIN parity_sync_queue q
                  ON q.table_name = 'driver_earnings'
                 AND q.record_id = de.id
                WHERE de.order_id = ?1
                  AND LOWER(TRIM(q.status)) = 'processing'
            )",
            params![order_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("check courier earning sync barrier: {e}"))?
        != 0;

    if is_processing {
        return Err("DRIVER_EARNING_SYNC_IN_PROGRESS".into());
    }
    Ok(())
}

#[cfg(test)]
pub fn update_payment_method(
    db: &DbState,
    order_id_raw: &str,
    next_method: &str,
) -> Result<Value, String> {
    update_payment_method_for_payment(db, order_id_raw, None, next_method)
}

pub fn update_payment_method_for_payment(
    db: &DbState,
    order_id_raw: &str,
    target_payment_id: Option<&str>,
    next_method: &str,
) -> Result<Value, String> {
    let next_method = match next_method.trim().to_ascii_lowercase().as_str() {
        "cash" => "cash".to_string(),
        "card" => "card".to_string(),
        _ => return Err("Payment method edits only support cash or card".into()),
    };

    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, order_id_raw).ok_or("Order not found")?;
    let (order_status, current_payment_status): (String, String) = conn
        .query_row(
            "SELECT COALESCE(status, 'pending'),
                    COALESCE(payment_status, 'pending')
             FROM orders
             WHERE id = ?1",
            params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("load order payment context for method edit: {e}"))?;
    let normalized_status = order_status.trim().to_ascii_lowercase();
    if normalized_status == "cancelled" || normalized_status == "canceled" {
        return Err("Cannot edit payment method for cancelled orders".into());
    }
    let normalized_payment_status = current_payment_status.trim().to_ascii_lowercase();

    ensure_driver_earning_sync_is_not_processing(&conn, &order_id)?;

    type CompletedPaymentRow = (String, String, i64);
    let completed_payments = {
        let mut stmt = conn
            .prepare(
                "SELECT op.id,
                        LOWER(TRIM(op.method)),
                        COALESCE((
                            SELECT COUNT(*)
                            FROM payment_items pi
                            WHERE pi.payment_id = op.id
                        ), 0) AS item_assignment_count
                 FROM order_payments op
                 WHERE op.order_id = ?1
                   AND LOWER(TRIM(op.status)) = 'completed'
                 ORDER BY op.created_at ASC",
            )
            .map_err(|e| format!("prepare payment edit lookup: {e}"))?;
        let rows = stmt
            .query_map(params![order_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| format!("query payment edit lookup: {e}"))?;

        let mut payments = Vec::new();
        for row in rows {
            payments.push(row.map_err(|e| format!("read payment edit lookup row: {e}"))?);
        }
        payments
    };

    let target_payment_id = target_payment_id
        .map(str::trim)
        .filter(|payment_id| !payment_id.is_empty());

    if order_has_adjustment_or_finalized_payment(&conn, &order_id)? {
        return Err("PAYMENT_METHOD_EDIT_ADJUSTED_ORDER_NOT_EDITABLE".into());
    }

    if completed_payments.is_empty() {
        if target_payment_id.is_some() {
            return Err("PAYMENT_METHOD_EDIT_TARGET_NOT_FOUND".into());
        }
        if normalized_payment_status != "paid" {
            return Err(
                "Payment method can only be edited for fully paid orders when no local payment record exists"
                    .into(),
            );
        }
        if order_has_driver_earning(&conn, &order_id)? {
            return Err("DRIVER_REQUIRES_LOCAL_PAYMENT".into());
        }

        // W6: the stored `orders.payment_method` column was dropped in
        // migration v55. The snapshot fallback no longer has anything to
        // persist locally — the admin-side sync payload is the sole
        // carrier of the edit intent. The local derived value stays at
        // `None` (→ "pending") until a remote payment row lands.
        let now = Utc::now().to_rfc3339();
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin payment snapshot fallback transaction: {e}"))?;
        tx.execute(
            "UPDATE orders
             SET sync_status = 'pending',
                 updated_at = ?1
             WHERE id = ?2",
            params![now, order_id],
        )
        .map_err(|e| format!("update order payment snapshot fallback: {e}"))?;
        enqueue_order_payment_snapshot_sync(&tx, &order_id, &current_payment_status, &next_method)?;
        tx.commit()
            .map_err(|e| format!("commit payment snapshot fallback: {e}"))?;

        info!(
            order_id = %order_id,
            method = %next_method,
            "Payment method updated via order snapshot fallback"
        );

        return Ok(serde_json::json!({
            "success": true,
            "data": {
                "orderId": order_id,
                "paymentId": Value::Null,
                "paymentMethod": next_method,
                "paymentStatus": current_payment_status,
                "retriedSync": false,
                "usedOrderSnapshotFallback": true,
            }
        }));
    }

    let (payment_id, current_method, _item_assignment_count): CompletedPaymentRow =
        if let Some(target_payment_id) = target_payment_id {
            completed_payments
                .iter()
                .find(|(payment_id, _, _)| payment_id == target_payment_id)
                .cloned()
                .ok_or("PAYMENT_METHOD_EDIT_TARGET_NOT_FOUND")?
        } else {
            if completed_payments.len() != 1 {
                return Err("PAYMENT_METHOD_EDIT_REQUIRES_SINGLE_COMPLETED_PAYMENT".into());
            }
            completed_payments[0].clone()
        };

    if current_method == next_method {
        let now = Utc::now().to_rfc3339();
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin same-method payment edit transaction: {e}"))?;
        refresh_driver_earning_for_payment_method_edit(&tx, &order_id, &now)?;
        let retried_sync = if payment_sync_queue_needs_retry(&tx, &payment_id)? {
            refresh_payment_sync_queue_entry(&tx, &payment_id)?;
            true
        } else {
            false
        };
        let payment_status: String = tx
            .query_row(
                "SELECT COALESCE(payment_status, 'pending') FROM orders WHERE id = ?1",
                params![order_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("reload payment status after same-method edit: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit same-method payment edit: {e}"))?;

        return Ok(serde_json::json!({
            "success": true,
            "data": {
                "orderId": order_id,
                "paymentId": payment_id,
                "paymentMethod": current_method,
                "paymentStatus": payment_status,
                "retriedSync": retried_sync,
            }
        }));
    }

    let now = Utc::now().to_rfc3339();
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin payment method update transaction: {e}"))?;
    tx.execute(
        "UPDATE order_payments
         SET method = ?1,
             cash_received = CASE
                WHEN ?1 = 'cash' THEN CAST(
                    COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER)) AS REAL
                ) / 100.0
                ELSE NULL
             END,
             cash_received_cents = CASE
                WHEN ?1 = 'cash' THEN COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))
                ELSE NULL
             END,
             change_given = CASE WHEN ?1 = 'cash' THEN 0 ELSE NULL END,
             change_given_cents = CASE WHEN ?1 = 'cash' THEN 0 ELSE NULL END,
             updated_at = ?2
         WHERE id = ?3",
        params![next_method, now, payment_id],
    )
    .map_err(|e| format!("update local payment method: {e}"))?;
    recompute_order_payment_state(&tx, &order_id, &now, &payment_id)?;
    refresh_driver_earning_for_payment_method_edit(&tx, &order_id, &now)?;
    refresh_payment_sync_queue_entry(&tx, &payment_id)?;
    let payment_status: String = tx
        .query_row(
            "SELECT COALESCE(payment_status, 'pending') FROM orders WHERE id = ?1",
            params![order_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("reload payment status after method edit: {e}"))?;
    tx.commit()
        .map_err(|e| format!("commit payment method update: {e}"))?;

    info!(
        order_id = %order_id,
        payment_id = %payment_id,
        method = %next_method,
        "Payment method updated"
    );

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "orderId": order_id,
            "paymentId": payment_id,
            "paymentMethod": next_method,
            "paymentStatus": payment_status,
            "retriedSync": false,
        }
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
    voided_by_shift_id: Option<&str>,
) -> Result<Value, String> {
    crate::refunds::void_payment_with_adjustment(
        db,
        payment_id,
        reason,
        voided_by,
        voided_by_shift_id,
    )
}

// ---------------------------------------------------------------------------
// Query payments
// ---------------------------------------------------------------------------

type PaymentRow = (
    String,
    String,
    String,
    f64,
    String,
    String,
    Option<f64>,
    Option<f64>,
    Option<String>,
    f64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    f64,
);

fn load_order_payment_rows(conn: &Connection, order_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            // W4b: cols 3 (amount), 6 (cash_received), 7 (change_given),
            // 9 (discount_amount), and 20 (refunds aggregate) read from
            // cents-with-real-fallback shim (removed in 4e).
            "SELECT op.id, op.order_id, op.method,
                    COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0),
                    op.currency, op.status,
                    COALESCE(op.cash_received_cents, CAST(ROUND(op.cash_received * 100) AS INTEGER)),
                    COALESCE(op.change_given_cents, CAST(ROUND(op.change_given * 100) AS INTEGER)),
                    op.transaction_ref,
                    COALESCE(op.discount_amount_cents, CAST(ROUND(op.discount_amount * 100) AS INTEGER), 0),
                    COALESCE(op.payment_origin, 'manual'),
                    op.terminal_device_id,
                    op.staff_id, op.staff_shift_id, op.voided_at, op.voided_by,
                    op.void_reason, op.sync_status, op.created_at, op.updated_at,
                    COALESCE((
                        SELECT SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER)))
                        FROM payment_adjustments pa
                        WHERE pa.payment_id = op.id
                          AND pa.adjustment_type = 'refund'
                    ), 0)
             FROM order_payments op
             WHERE op.order_id = ?1
             ORDER BY op.created_at DESC",
        )
        .map_err(|error| error.to_string())?;

    let rows: Vec<PaymentRow> = stmt
        .query_map(params![order_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<i64>>(6)?
                    .map(|c| Cents::new(c).to_f64_dp2()),
                row.get::<_, Option<i64>>(7)?
                    .map(|c| Cents::new(c).to_f64_dp2()),
                row.get::<_, Option<String>>(8)?,
                Cents::new(row.get::<_, i64>(9)?).to_f64_dp2(),
                row.get::<_, String>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<String>>(16)?,
                row.get::<_, String>(17)?,
                row.get::<_, String>(18)?,
                row.get::<_, String>(19)?,
                Cents::new(row.get::<_, i64>(20)?).to_f64_dp2(),
            ))
        })
        .map_err(|error| error.to_string())?
        .filter_map(|row| match row {
            Ok(payment) => Some(payment),
            Err(error) => {
                warn!("skipping malformed payment row: {error}");
                None
            }
        })
        .collect();
    drop(stmt);

    rows.into_iter()
        .map(|row| {
            let items = load_payment_items_for_payment(conn, &row.0)?;
            let remaining_refundable = ((row.3 - row.20).max(0.0) * 100.0).round() / 100.0;
            Ok(serde_json::json!({
                "id": row.0,
                "orderId": row.1,
                "method": row.2,
                "amount": row.3,
                "currency": row.4,
                "status": row.5,
                "cashReceived": row.6,
                "changeGiven": row.7,
                "transactionRef": row.8,
                "discountAmount": row.9,
                "paymentOrigin": row.10,
                "terminalApproved": row.10 == "terminal",
                "terminalDeviceId": row.11,
                "staffId": row.12,
                "staffShiftId": row.13,
                "voidedAt": row.14,
                "voidedBy": row.15,
                "voidReason": row.16,
                "syncStatus": row.17,
                "createdAt": row.18,
                "updatedAt": row.19,
                "refundedAmount": row.20,
                "remainingRefundable": remaining_refundable,
                "items": items,
            }))
        })
        .collect()
}

pub(crate) fn load_order_settlement_snapshot(
    conn: &Connection,
    order_id: &str,
) -> Result<OrderSettlementSnapshot, String> {
    let balance = load_order_payment_balance_snapshot(conn, order_id)?;
    let completed_payments = load_order_payment_rows(conn, order_id)?
        .into_iter()
        .filter(|payment| payment.get("status").and_then(Value::as_str) == Some("completed"))
        .collect();
    Ok(OrderSettlementSnapshot {
        order_total: balance.order_total,
        net_paid: balance.net_paid,
        outstanding_amount: balance.outstanding_amount,
        completed_payments,
        ledger_generation: balance.ledger_generation,
    })
}

/// Return one read-transaction view of the order total, completed payment rows,
/// refunds, and remaining balance. The distinct API avoids changing the legacy
/// `get_order_payments` array contract used by existing renderer screens.
pub fn get_order_settlement_snapshot(db: &DbState, order_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    conn.execute_batch("BEGIN DEFERRED")
        .map_err(|error| format!("begin settlement snapshot transaction: {error}"))?;
    let result = (|| -> Result<(String, OrderSettlementSnapshot), String> {
        let actual_order_id =
            resolve_order_id(&conn, order_id).ok_or_else(|| "Order not found".to_string())?;
        let snapshot = load_order_settlement_snapshot(&conn, &actual_order_id)?;
        Ok((actual_order_id, snapshot))
    })();

    match result {
        Ok((actual_order_id, snapshot)) => {
            conn.execute_batch("COMMIT")
                .map_err(|error| format!("commit settlement snapshot transaction: {error}"))?;
            let values = settlement_snapshot_json(snapshot);
            Ok(serde_json::json!({
                "success": true,
                "orderId": actual_order_id,
                "orderTotal": values["orderTotal"],
                "netPaid": values["netPaid"],
                "outstandingAmount": values["outstandingAmount"],
                "completedPayments": values["completedPayments"],
                "generation": values["generation"],
            }))
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Get all payments for an order.
pub fn get_order_payments(db: &DbState, order_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!(load_order_payment_rows(&conn, order_id)?))
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
    // Reject NaN and ±Infinity at the field-reading layer so downstream
    // comparisons like `amount <= 0.0` (which are NaN-unsafe) stay sound.
    v.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
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

    fn seed_driver_delivery_with_completed_payments(
        db: &DbState,
        order_id: &str,
        payments: &[(&str, i64)],
        shift_status: &str,
        settled: i64,
        is_transferred: i64,
    ) -> Vec<String> {
        let total_cents: i64 = payments.iter().map(|(_, cents)| cents).sum();
        let total_amount = Cents::new(total_cents).to_f64_dp2();
        let shift_id = format!("shift-{order_id}");
        let now = "2026-08-12T00:00:00Z";
        let conn = db.conn.lock().expect("lock delivery seed database");

        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, branch_id, terminal_id, role_type, check_in_time,
                 status, sync_status, created_at, updated_at
             ) VALUES (?1, 'driver-1', 'branch-1', 'terminal-1', 'driver', ?2, ?3, 'pending', ?2, ?2)",
            params![shift_id, now, shift_status],
        )
        .expect("insert driver shift");
        conn.execute(
            "INSERT INTO orders (
                 id, items, total_amount, total_amount_cents, status, order_type,
                 driver_id, staff_shift_id, branch_id, terminal_id, payment_status,
                 sync_status, supabase_id, delivery_fee, delivery_fee_cents,
                 tip_amount, tip_amount_cents, created_at, updated_at
             ) VALUES (
                 ?1, '[]', ?2, ?3, 'completed', 'delivery',
                 'driver-1', ?4, 'branch-1', 'terminal-1', 'paid',
                 'synced', ?5, 2.0, 200, 0.0, 0, ?6, ?6
             )",
            params![
                order_id,
                total_amount,
                total_cents,
                shift_id,
                format!("remote-{order_id}"),
                now,
            ],
        )
        .expect("insert completed delivery order");

        let payment_ids: Vec<String> = payments
            .iter()
            .enumerate()
            .map(|(index, (method, cents))| {
                let payment_id = format!("payment-{order_id}-{index}");
                conn.execute(
                    "INSERT INTO order_payments (
                         id, order_id, method, amount, amount_cents, currency, status,
                         payment_origin, sync_status, sync_state, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 'EUR', 'completed',
                               'manual', 'synced', 'applied', ?6, ?6)",
                    params![
                        payment_id,
                        order_id,
                        method,
                        Cents::new(*cents).to_f64_dp2(),
                        cents,
                        now,
                    ],
                )
                .expect("insert completed delivery payment");
                payment_id
            })
            .collect();

        let cash_cents: i64 = payments
            .iter()
            .filter(|(method, _)| *method == "cash")
            .map(|(_, cents)| cents)
            .sum();
        let card_cents: i64 = payments
            .iter()
            .filter(|(method, _)| *method == "card")
            .map(|(_, cents)| cents)
            .sum();
        let method = if cash_cents > 0 && card_cents > 0 {
            "mixed"
        } else if card_cents > 0 {
            "card"
        } else {
            "cash"
        };
        conn.execute(
            "INSERT INTO driver_earnings (
                 id, driver_id, staff_shift_id, order_id, branch_id,
                 delivery_fee, delivery_fee_cents, tip_amount, tip_amount_cents,
                 total_earning, total_earning_cents, payment_method,
                 cash_collected, cash_collected_cents, card_amount, card_amount_cents,
                 cash_to_return, cash_to_return_cents, settled, is_transferred,
                 created_at, updated_at
             ) VALUES (
                 ?1, 'driver-1', ?2, ?3, 'branch-1',
                 2.0, 200, 0.0, 0, 2.0, 200, ?4,
                 ?5, ?6, ?7, ?8, ?5, ?6, ?9, ?10,
                 '2026-08-11T00:00:00Z', ?11
             )",
            params![
                format!("earning-{order_id}"),
                shift_id,
                order_id,
                method,
                Cents::new(cash_cents).to_f64_dp2(),
                cash_cents,
                Cents::new(card_cents).to_f64_dp2(),
                card_cents,
                settled,
                is_transferred,
                now,
            ],
        )
        .expect("insert courier settlement projection");

        payment_ids
    }

    fn driver_earning_payment_snapshot(
        db: &DbState,
        order_id: &str,
    ) -> (String, f64, i64, f64, i64, f64, i64, String, String) {
        let conn = db.conn.lock().expect("lock snapshot database");
        conn.query_row(
            "SELECT payment_method,
                    cash_collected, cash_collected_cents,
                    card_amount, card_amount_cents,
                    cash_to_return, cash_to_return_cents,
                    created_at, updated_at
             FROM driver_earnings WHERE order_id = ?1",
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
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .expect("read courier settlement snapshot")
    }

    #[derive(Debug, PartialEq)]
    struct DeliveryEarningEditState {
        id: String,
        driver_id: String,
        staff_shift_id: Option<String>,
        branch_id: String,
        settled: i64,
        is_transferred: i64,
        payment_method: String,
        cash_collected: f64,
        cash_collected_cents: i64,
        card_amount: f64,
        card_amount_cents: i64,
        cash_to_return: f64,
        cash_to_return_cents: i64,
        updated_at: String,
    }

    #[derive(Debug, PartialEq)]
    struct DeliveryPaymentEditState {
        payment: (
            String,
            f64,
            Option<i64>,
            Option<f64>,
            Option<i64>,
            Option<f64>,
            Option<i64>,
            String,
            String,
            String,
        ),
        order: (String, String, String, Option<String>, Option<String>),
        earning: DeliveryEarningEditState,
        outboxes: Vec<(
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
            Option<String>,
            Option<String>,
        )>,
    }

    fn delivery_payment_edit_state(
        db: &DbState,
        order_id: &str,
        payment_id: &str,
    ) -> DeliveryPaymentEditState {
        let conn = db.conn.lock().expect("lock payment edit snapshot database");
        let payment = conn
            .query_row(
                "SELECT method, amount, amount_cents,
                        cash_received, cash_received_cents,
                        change_given, change_given_cents,
                        sync_status, sync_state, updated_at
                 FROM order_payments WHERE id = ?1",
                params![payment_id],
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
                    ))
                },
            )
            .expect("read payment edit snapshot");
        let order = conn
            .query_row(
                "SELECT status, payment_status, sync_status, driver_id, staff_shift_id
                 FROM orders WHERE id = ?1",
                params![order_id],
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
            .expect("read order edit snapshot");
        let earning = conn
            .query_row(
                "SELECT id, driver_id, staff_shift_id, branch_id,
                        settled, is_transferred, payment_method,
                        cash_collected, cash_collected_cents,
                        card_amount, card_amount_cents,
                        cash_to_return, cash_to_return_cents, updated_at
                 FROM driver_earnings WHERE order_id = ?1",
                params![order_id],
                |row| {
                    Ok(DeliveryEarningEditState {
                        id: row.get(0)?,
                        driver_id: row.get(1)?,
                        staff_shift_id: row.get(2)?,
                        branch_id: row.get(3)?,
                        settled: row.get(4)?,
                        is_transferred: row.get(5)?,
                        payment_method: row.get(6)?,
                        cash_collected: row.get(7)?,
                        cash_collected_cents: row.get(8)?,
                        card_amount: row.get(9)?,
                        card_amount_cents: row.get(10)?,
                        cash_to_return: row.get(11)?,
                        cash_to_return_cents: row.get(12)?,
                        updated_at: row.get(13)?,
                    })
                },
            )
            .expect("read courier earning edit snapshot");
        let mut stmt = conn
            .prepare(
                "SELECT id, table_name, record_id, operation, status, data,
                        attempts, next_retry_at, error_message
                 FROM parity_sync_queue
                 WHERE table_name IN ('orders', 'payments', 'driver_earnings')
                 ORDER BY id",
            )
            .expect("prepare outbox edit snapshot");
        let outboxes = stmt
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
                ))
            })
            .expect("query outbox edit snapshot")
            .collect::<Result<Vec<_>, _>>()
            .expect("read outbox edit snapshot");

        DeliveryPaymentEditState {
            payment,
            order,
            earning,
            outboxes,
        }
    }

    #[test]
    fn payment_method_edit_rebuilds_active_delivery_courier_cash_snapshot_and_checkout() {
        let db = test_db();
        let payment_id = seed_driver_delivery_with_completed_payments(
            &db,
            "delivery-cash-to-card",
            &[("cash", 2400)],
            "active",
            0,
            0,
        )[0]
        .clone();

        update_payment_method_for_payment(
            &db,
            "delivery-cash-to-card",
            Some(payment_id.as_str()),
            "card",
        )
        .expect("change completed delivery payment from cash to card");

        let earning = driver_earning_payment_snapshot(&db, "delivery-cash-to-card");
        assert_eq!(earning.0, "card");
        assert_eq!(
            (earning.1, earning.2, earning.3, earning.4, earning.5, earning.6),
            (0.0, 0, 24.0, 2400, 0.0, 0),
            "all real/cents driver settlement fields must match the complete payment snapshot"
        );
        assert_eq!(earning.7, "2026-08-11T00:00:00Z");
        assert_ne!(
            earning.8, earning.7,
            "payment refresh must update the earning timestamp"
        );

        let checkout = crate::shifts::get_shift_summary(&db, "shift-delivery-cash-to-card")
            .expect("build courier checkout from materialized earnings");
        assert_eq!(checkout["amountToReturn"], 0.0);

        let conn = db.conn.lock().expect("lock outbox database");
        let (queue_count, queue_status, operation, payload): (i64, String, String, String) = conn
            .query_row(
                "SELECT COUNT(*), MAX(status), MAX(operation), MAX(data)
                 FROM parity_sync_queue
                 WHERE table_name = 'driver_earnings'
                   AND record_id = 'earning-delivery-cash-to-card'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("load refreshed courier earning outbox row");
        assert_eq!(queue_count, 1);
        assert_eq!(queue_status, "pending");
        assert_eq!(operation, "INSERT");
        let payload: Value = serde_json::from_str(&payload).expect("parse earning outbox payload");
        assert_eq!(payload["payment_method"], "card");
        assert_eq!(payload["cash_collected_cents"], 0);
        assert_eq!(payload["card_amount_cents"], 2400);
        assert_eq!(payload["cash_to_return_cents"], 0);
        assert_eq!(payload["createdAt"], "2026-08-11T00:00:00Z");
        assert_eq!(payload["updatedAt"], earning.8);
    }

    #[test]
    fn payment_method_edit_rebuilds_full_split_snapshot_and_same_method_repair_is_idempotent() {
        let db = test_db();
        let payment_ids = seed_driver_delivery_with_completed_payments(
            &db,
            "delivery-split-repair",
            &[("card", 400), ("cash", 600)],
            "active",
            0,
            0,
        );
        {
            let conn = db.conn.lock().expect("lock stale projection database");
            conn.execute(
                "UPDATE driver_earnings
                 SET payment_method = 'cash', cash_collected = 99.0,
                     cash_collected_cents = 9900, card_amount = 0.0,
                     card_amount_cents = 0, cash_to_return = 99.0,
                     cash_to_return_cents = 9900
                 WHERE order_id = 'delivery-split-repair'",
                [],
            )
            .expect("make courier projection stale");
        }

        update_payment_method_for_payment(
            &db,
            "delivery-split-repair",
            Some(payment_ids[0].as_str()),
            "card",
        )
        .expect("same-method edit repairs stale courier projection");
        let repaired = driver_earning_payment_snapshot(&db, "delivery-split-repair");
        assert_eq!(repaired.0, "mixed");
        assert_eq!(
            (repaired.1, repaired.2, repaired.3, repaired.4, repaired.5, repaired.6),
            (6.0, 600, 4.0, 400, 6.0, 600)
        );

        update_payment_method_for_payment(
            &db,
            "delivery-split-repair",
            Some(payment_ids[0].as_str()),
            "card",
        )
        .expect("repeating same-method repair remains idempotent");
        let repeated = driver_earning_payment_snapshot(&db, "delivery-split-repair");
        assert_eq!(
            (repeated.1, repeated.2, repeated.3, repeated.4, repeated.5, repeated.6),
            (6.0, 600, 4.0, 400, 6.0, 600)
        );

        let conn = db.conn.lock().expect("lock split outbox database");
        let outbox_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE table_name = 'driver_earnings'
                   AND record_id = 'earning-delivery-split-repair'",
                [],
                |row| row.get(0),
            )
            .expect("count idempotent courier earning outbox rows");
        assert_eq!(
            outbox_count, 1,
            "same-method replay must replace, not duplicate, the courier earning outbox row"
        );
    }

    #[test]
    fn payment_method_edit_rebuilds_active_delivery_card_to_cash_snapshot_exactly_once() {
        let db = test_db();
        let payment_id = seed_driver_delivery_with_completed_payments(
            &db,
            "delivery-card-to-cash",
            &[("card", 2400)],
            "active",
            0,
            0,
        )[0]
        .clone();

        update_payment_method_for_payment(
            &db,
            "delivery-card-to-cash",
            Some(payment_id.as_str()),
            "cash",
        )
        .expect("change completed delivery payment from card to cash");
        let earning = driver_earning_payment_snapshot(&db, "delivery-card-to-cash");
        assert_eq!(earning.0, "cash");
        assert_eq!(
            (earning.1, earning.2, earning.3, earning.4, earning.5, earning.6),
            (24.0, 2400, 0.0, 0, 24.0, 2400)
        );
        let checkout = crate::shifts::get_shift_summary(&db, "shift-delivery-card-to-cash")
            .expect("build courier checkout after card to cash edit");
        assert_eq!(checkout["amountToReturn"], 24.0);
        let conn = db.conn.lock().expect("lock card to cash outbox database");
        let outbox_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE table_name = 'driver_earnings'
                   AND record_id = 'earning-delivery-card-to-cash'",
                [],
                |row| row.get(0),
            )
            .expect("count card to cash courier outboxes");
        assert_eq!(outbox_count, 1);
    }

    #[test]
    fn targeted_split_payment_edit_rebuilds_complete_delivery_snapshot_as_mixed() {
        let db = test_db();
        let payment_ids = seed_driver_delivery_with_completed_payments(
            &db,
            "delivery-targeted-split",
            &[("cash", 400), ("cash", 600)],
            "active",
            0,
            0,
        );

        update_payment_method_for_payment(
            &db,
            "delivery-targeted-split",
            Some(payment_ids[0].as_str()),
            "card",
        )
        .expect("retarget one split payment to card");
        let earning = driver_earning_payment_snapshot(&db, "delivery-targeted-split");
        assert_eq!(earning.0, "mixed");
        assert_eq!(
            (earning.1, earning.2, earning.3, earning.4, earning.5, earning.6),
            (6.0, 600, 4.0, 400, 6.0, 600)
        );
    }

    #[test]
    fn same_method_edit_repairs_stale_delivery_projection_and_retries_existing_payment_sync() {
        let db = test_db();
        let payment_id = seed_driver_delivery_with_completed_payments(
            &db,
            "delivery-same-method-retry",
            &[("card", 2400)],
            "active",
            0,
            0,
        )[0]
        .clone();
        {
            let conn = db.conn.lock().expect("lock same-method retry database");
            conn.execute(
                "UPDATE driver_earnings
                 SET payment_method = 'cash', cash_collected = 24.0,
                     cash_collected_cents = 2400, card_amount = 0.0,
                     card_amount_cents = 0, cash_to_return = 24.0,
                     cash_to_return_cents = 2400
                 WHERE order_id = 'delivery-same-method-retry'",
                [],
            )
            .expect("make card earning projection stale");
            crate::sync_queue::enqueue_payload_item(
                &conn,
                "payments",
                payment_id.as_str(),
                "INSERT",
                &serde_json::json!({ "id": payment_id, "orderId": "delivery-same-method-retry" }),
                Some(1),
                Some("payment"),
                Some("manual"),
                Some(1),
            )
            .expect("seed failed payment outbox");
            conn.execute(
                "UPDATE parity_sync_queue
                 SET status = 'failed', attempts = 2, error_message = 'temporary failure'
                 WHERE table_name = 'payments' AND record_id = ?1",
                params![payment_id],
            )
            .expect("mark payment outbox failed");
        }

        let result = update_payment_method_for_payment(
            &db,
            "delivery-same-method-retry",
            Some(payment_id.as_str()),
            "card",
        )
        .expect("same method retries payment sync and repairs courier projection");
        assert_eq!(result["data"]["retriedSync"], true);
        let earning = driver_earning_payment_snapshot(&db, "delivery-same-method-retry");
        assert_eq!(earning.0, "card");
        assert_eq!(
            (earning.1, earning.2, earning.3, earning.4, earning.5, earning.6),
            (0.0, 0, 24.0, 2400, 0.0, 0)
        );
        let conn = db
            .conn
            .lock()
            .expect("lock payment retry assertions database");
        let payment_queue_status: String = conn
            .query_row(
                "SELECT status FROM parity_sync_queue
                 WHERE table_name = 'payments' AND record_id = ?1",
                params![payment_id],
                |row| row.get(0),
            )
            .expect("read retried payment outbox status");
        assert_eq!(payment_queue_status, "pending");
    }

    #[test]
    fn same_method_edit_rejects_closed_settled_and_transferred_courier_settlements() {
        for (suffix, shift_status, settled, is_transferred) in [
            ("closed", "closed", 0, 0),
            ("settled", "active", 1, 0),
            ("transferred", "active", 0, 1),
        ] {
            let db = test_db();
            let order_id = format!("delivery-same-method-{suffix}");
            let payment_id = seed_driver_delivery_with_completed_payments(
                &db,
                order_id.as_str(),
                &[("cash", 2400)],
                shift_status,
                settled,
                is_transferred,
            )[0]
            .clone();
            let before = delivery_payment_edit_state(&db, &order_id, &payment_id);

            let error = update_payment_method_for_payment(
                &db,
                order_id.as_str(),
                Some(payment_id.as_str()),
                "cash",
            )
            .expect_err("same method must not bypass finalized courier settlement boundary");
            assert_eq!(error, "DRIVER_SETTLEMENT_NOT_EDITABLE");
            assert_eq!(
                delivery_payment_edit_state(&db, &order_id, &payment_id),
                before,
                "same-method rejection must leave every local financial and outbox field unchanged"
            );
        }
    }

    #[test]
    fn payment_method_edit_rejects_adjusted_delivery_without_resurrecting_refunded_cash() {
        let db = test_db();
        let payment_id = seed_driver_delivery_with_completed_payments(
            &db,
            "delivery-adjusted-payment",
            &[("cash", 2400)],
            "active",
            0,
            0,
        )[0]
        .clone();
        {
            let conn = db.conn.lock().expect("lock adjusted delivery database");
            conn.execute(
                "INSERT INTO payment_adjustments (
                     id, payment_id, order_id, adjustment_type, amount, amount_cents,
                     reason, refund_method, cash_handler, adjustment_context,
                     sync_state, created_at, updated_at
                 ) VALUES (
                     'adjustment-delivery-refund', ?1, 'delivery-adjusted-payment',
                     'refund', 5.0, 500, 'partial cash refund', 'cash', 'driver_shift',
                     'manual', 'pending', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'
                 )",
                params![payment_id],
            )
            .expect("seed driver-handled partial refund");
            conn.execute(
                "UPDATE driver_earnings
                 SET cash_collected = 19.0, cash_collected_cents = 1900,
                     cash_to_return = 19.0, cash_to_return_cents = 1900
                 WHERE order_id = 'delivery-adjusted-payment'",
                [],
            )
            .expect("mirror settled partial refund onto courier projection");
        }

        let error = update_payment_method_for_payment(
            &db,
            "delivery-adjusted-payment",
            Some(payment_id.as_str()),
            "card",
        )
        .expect_err(
            "adjusted delivery payment edit must fail closed until tender accounting is explicit",
        );
        assert_eq!(error, "PAYMENT_METHOD_EDIT_ADJUSTED_ORDER_NOT_EDITABLE");
        let earning = driver_earning_payment_snapshot(&db, "delivery-adjusted-payment");
        assert_eq!(
            (earning.0, earning.2, earning.4, earning.6),
            ("cash".to_string(), 1900, 0, 1900)
        );
    }

    #[test]
    fn payment_method_edit_rejects_refunded_and_voided_status_only_siblings() {
        for sibling_status in ["refunded", "voided"] {
            let db = test_db();
            let order_id = format!("delivery-status-only-{sibling_status}");
            let payment_id = seed_driver_delivery_with_completed_payments(
                &db,
                order_id.as_str(),
                &[("cash", 2400)],
                "active",
                0,
                0,
            )[0]
            .clone();
            {
                let conn = db
                    .conn
                    .lock()
                    .expect("lock status-only adjustment database");
                conn.execute(
                    "INSERT INTO order_payments (
                         id, order_id, method, amount, amount_cents, currency, status,
                         payment_origin, sync_status, sync_state, created_at, updated_at
                     ) VALUES (?1, ?2, 'cash', 1.0, 100, 'EUR', ?3, 'manual', 'synced',
                               'applied', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')",
                    params![
                        format!("payment-status-only-{sibling_status}"),
                        order_id,
                        sibling_status,
                    ],
                )
                .expect("insert status-only finalized sibling");
            }
            let before = delivery_payment_edit_state(&db, &order_id, &payment_id);

            let error = update_payment_method_for_payment(
                &db,
                order_id.as_str(),
                Some(payment_id.as_str()),
                "cash",
            )
            .expect_err("same-method edit must reject finalized sibling before returning");
            assert_eq!(error, "PAYMENT_METHOD_EDIT_ADJUSTED_ORDER_NOT_EDITABLE");
            assert_eq!(
                delivery_payment_edit_state(&db, &order_id, &payment_id),
                before,
                "status-only rejection must preserve order, payment, earning, and outboxes"
            );
        }
    }

    #[test]
    fn payment_method_snapshot_fallback_rejects_delivery_earning_without_local_payment() {
        let db = test_db();
        seed_driver_delivery_with_completed_payments(
            &db,
            "delivery-fallback-earning",
            &[("cash", 2400)],
            "active",
            0,
            0,
        );
        {
            let conn = db.conn.lock().expect("lock fallback earning database");
            conn.execute(
                "DELETE FROM order_payments WHERE order_id = 'delivery-fallback-earning'",
                [],
            )
            .expect("remove local completed payment to emulate remote-only snapshot");
        }

        let error =
            update_payment_method_for_payment(&db, "delivery-fallback-earning", None, "card")
                .expect_err(
                    "fallback must not diverge a driver earning from a missing local payment",
                );
        assert_eq!(error, "DRIVER_REQUIRES_LOCAL_PAYMENT");
        let conn = db.conn.lock().expect("lock fallback assertions database");
        let (sync_status, outbox_count): (String, i64) = conn
            .query_row(
                "SELECT o.sync_status,
                        (SELECT COUNT(*) FROM parity_sync_queue
                         WHERE table_name IN ('orders', 'payments', 'driver_earnings'))
                 FROM orders o WHERE o.id = 'delivery-fallback-earning'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read unchanged fallback state");
        assert_eq!(sync_status, "synced");
        assert_eq!(outbox_count, 0);
    }

    #[test]
    fn payment_method_edit_propagates_courier_lookup_error_and_rolls_back_payment() {
        let db = test_db();
        let payment_id = seed_driver_delivery_with_completed_payments(
            &db,
            "delivery-lookup-error",
            &[("cash", 2400)],
            "active",
            0,
            0,
        )[0]
        .clone();
        {
            let conn = db.conn.lock().expect("lock lookup-error database");
            conn.execute_batch("PRAGMA foreign_keys = OFF; DROP TABLE staff_shifts;")
                .expect("remove courier shift table to inject lookup error");
        }

        let error = update_payment_method_for_payment(
            &db,
            "delivery-lookup-error",
            Some(payment_id.as_str()),
            "card",
        )
        .expect_err("lookup failure must not be treated as a missing courier earning");
        assert!(error.contains("load courier settlement context"));
        let conn = db
            .conn
            .lock()
            .expect("lock lookup-error assertions database");
        let (method, outbox_count): (String, i64) = conn
            .query_row(
                "SELECT op.method,
                        (SELECT COUNT(*) FROM parity_sync_queue
                         WHERE table_name IN ('payments', 'driver_earnings'))
                 FROM order_payments op WHERE op.id = ?1",
                params![payment_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read rolled-back lookup-error payment");
        assert_eq!(method, "cash");
        assert_eq!(outbox_count, 0);
    }

    #[test]
    fn payment_method_edit_rejects_mismatched_courier_settlement_identity() {
        for (suffix, sql) in [
            (
                "shift-role",
                "UPDATE staff_shifts SET role_type = 'cashier' WHERE id = 'shift-delivery-mismatch-shift-role'",
            ),
            (
                "shift-staff",
                "UPDATE staff_shifts SET staff_id = 'another-driver' WHERE id = 'shift-delivery-mismatch-shift-staff'",
            ),
            (
                "earning-branch",
                "UPDATE driver_earnings SET branch_id = 'another-branch' WHERE order_id = 'delivery-mismatch-earning-branch'",
            ),
            (
                "order-branch",
                "UPDATE orders SET branch_id = 'another-branch' WHERE id = 'delivery-mismatch-order-branch'",
            ),
            (
                "order-driver",
                "UPDATE orders SET driver_id = 'another-driver' WHERE id = 'delivery-mismatch-order-driver'",
            ),
            (
                "order-shift",
                "UPDATE orders SET staff_shift_id = 'another-shift' WHERE id = 'delivery-mismatch-order-shift'",
            ),
            (
                "order-unassigned",
                "UPDATE orders SET driver_id = NULL, staff_shift_id = NULL WHERE id = 'delivery-mismatch-order-unassigned'",
            ),
        ] {
            let db = test_db();
            let order_id = format!("delivery-mismatch-{suffix}");
            let payment_id = seed_driver_delivery_with_completed_payments(
                &db,
                order_id.as_str(),
                &[("cash", 2400)],
                "active",
                0,
                0,
            )[0]
            .clone();
            {
                let conn = db.conn.lock().expect("lock mismatch seed database");
                conn.execute(sql, [])
                    .expect("inject courier settlement identity mismatch");
            }
            let before = delivery_payment_edit_state(&db, &order_id, &payment_id);

            let error = update_payment_method_for_payment(
                &db,
                order_id.as_str(),
                Some(payment_id.as_str()),
                "card",
            )
            .expect_err("courier settlement identity mismatch must reject payment edit");
            assert_eq!(error, "DRIVER_SETTLEMENT_NOT_EDITABLE");
            assert_eq!(
                delivery_payment_edit_state(&db, &order_id, &payment_id),
                before,
                "identity mismatch must roll back order, tender, earning, and every outbox"
            );
        }
    }

    #[test]
    fn payment_method_edit_reclassifies_cash_tender_metadata_without_losing_transaction_reference()
    {
        let db = test_db();
        let cash_payment_id = seed_driver_delivery_with_completed_payments(
            &db,
            "delivery-tender-cash-to-card",
            &[("cash", 2400)],
            "active",
            0,
            0,
        )[0]
        .clone();
        let card_db = test_db();
        let card_payment_id = seed_driver_delivery_with_completed_payments(
            &card_db,
            "delivery-tender-card-to-cash",
            &[("card", 2400)],
            "active",
            0,
            0,
        )[0]
        .clone();
        {
            let conn = db.conn.lock().expect("lock tender metadata database");
            conn.execute(
                "UPDATE order_payments
                 SET cash_received = 30.0, cash_received_cents = 3000,
                     change_given = 6.0, change_given_cents = 600,
                     transaction_ref = 'ORIGINAL-CASH-REF'
                 WHERE id = ?1",
                params![cash_payment_id],
            )
            .expect("seed cash tender metadata");
        }
        {
            let conn = card_db
                .conn
                .lock()
                .expect("lock card tender metadata database");
            conn.execute(
                "UPDATE order_payments
                 SET amount = 99.99, amount_cents = 2400,
                     transaction_ref = 'ORIGINAL-CARD-REF'
                 WHERE id = ?1",
                params![card_payment_id],
            )
            .expect("seed divergent legacy REAL amount and card transaction reference");
        }

        update_payment_method_for_payment(
            &db,
            "delivery-tender-cash-to-card",
            Some(cash_payment_id.as_str()),
            "card",
        )
        .expect("reclassify cash payment as card");
        update_payment_method_for_payment(
            &card_db,
            "delivery-tender-card-to-cash",
            Some(card_payment_id.as_str()),
            "cash",
        )
        .expect("reclassify card payment as exact cash tender");

        let conn = db
            .conn
            .lock()
            .expect("lock card reclassification result database");
        let cash_to_card: (Option<i64>, Option<i64>, String) = conn
            .query_row(
                "SELECT cash_received_cents, change_given_cents, transaction_ref
                 FROM order_payments WHERE id = ?1",
                params![cash_payment_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read card reclassification metadata");
        drop(conn);
        let conn = card_db
            .conn
            .lock()
            .expect("lock cash reclassification result database");
        let card_to_cash: (Option<f64>, Option<i64>, Option<f64>, Option<i64>, String) = conn
            .query_row(
                "SELECT cash_received, cash_received_cents,
                        change_given, change_given_cents, transaction_ref
                 FROM order_payments WHERE id = ?1",
                params![card_payment_id],
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
            .expect("read cash reclassification metadata");
        assert_eq!(cash_to_card, (None, None, "ORIGINAL-CASH-REF".to_string()));
        assert_eq!(
            card_to_cash,
            (
                Some(24.0),
                Some(2400),
                Some(0.0),
                Some(0),
                "ORIGINAL-CARD-REF".to_string()
            ),
            "authoritative cents must drive both REAL and cents cash tender fields"
        );
    }

    #[test]
    fn payment_method_edit_waits_for_processing_driver_earning_sync_then_retries_safely() {
        for (suffix, next_method) in [("different", "card"), ("same", "cash")] {
            let db = test_db();
            let order_id = format!("delivery-processing-{suffix}");
            let payment_id = seed_driver_delivery_with_completed_payments(
                &db,
                order_id.as_str(),
                &[("cash", 2400)],
                "active",
                0,
                0,
            )[0]
            .clone();
            let earning_id = format!("earning-{order_id}");
            {
                let conn = db
                    .conn
                    .lock()
                    .expect("lock processing outbox seed database");
                let payload =
                    crate::order_ownership::build_driver_earning_sync_payload(&conn, &earning_id)
                        .expect("build processing courier earning payload");
                crate::sync_queue::enqueue_payload_item(
                    &conn,
                    "driver_earnings",
                    &earning_id,
                    "INSERT",
                    &payload,
                    Some(1),
                    Some("financial"),
                    Some("manual"),
                    Some(1),
                )
                .expect("seed courier earning outbox");
                conn.execute(
                    "UPDATE parity_sync_queue
                     SET status = 'processing'
                     WHERE table_name = 'driver_earnings' AND record_id = ?1",
                    params![earning_id],
                )
                .expect("mark courier earning outbox processing");
            }
            let before = delivery_payment_edit_state(&db, &order_id, &payment_id);

            let error = update_payment_method_for_payment(
                &db,
                order_id.as_str(),
                Some(payment_id.as_str()),
                next_method,
            )
            .expect_err("payment edit must wait while the courier earning payload is in flight");
            assert_eq!(error, "DRIVER_EARNING_SYNC_IN_PROGRESS");
            assert_eq!(
                delivery_payment_edit_state(&db, &order_id, &payment_id),
                before,
                "processing barrier must preserve payment, tender, order, earning, and exact outbox"
            );

            {
                let conn = db.conn.lock().expect("lock completed outbox database");
                conn.execute(
                    "DELETE FROM parity_sync_queue
                     WHERE table_name = 'driver_earnings'
                       AND record_id = ?1
                       AND status = 'processing'",
                    params![earning_id],
                )
                .expect("simulate completed courier earning sync removal");
            }
            update_payment_method_for_payment(
                &db,
                order_id.as_str(),
                Some(payment_id.as_str()),
                next_method,
            )
            .expect("edit retries once no courier earning payload is processing");
        }
    }

    #[test]
    fn payment_method_edit_rejects_finalized_courier_settlements_without_partial_writes() {
        for (suffix, shift_status, settled, is_transferred) in [
            ("closed", "closed", 0, 0),
            ("settled", "active", 1, 0),
            ("transferred", "active", 0, 1),
        ] {
            let db = test_db();
            let order_id = format!("delivery-final-{suffix}");
            let payment_id = seed_driver_delivery_with_completed_payments(
                &db,
                order_id.as_str(),
                &[("cash", 2400)],
                shift_status,
                settled,
                is_transferred,
            )[0]
            .clone();

            let error = update_payment_method_for_payment(
                &db,
                order_id.as_str(),
                Some(payment_id.as_str()),
                "card",
            )
            .expect_err("finalized courier settlement must reject payment method edit");
            assert_eq!(error, "DRIVER_SETTLEMENT_NOT_EDITABLE");

            let conn = db.conn.lock().expect("lock finalized settlement database");
            let payment_method: String = conn
                .query_row(
                    "SELECT method FROM order_payments WHERE id = ?1",
                    params![payment_id],
                    |row| row.get(0),
                )
                .expect("read unchanged payment method");
            let outbox_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue
                     WHERE table_name IN ('payments', 'driver_earnings')",
                    [],
                    |row| row.get(0),
                )
                .expect("count rolled back outbox rows");
            assert_eq!(payment_method, "cash");
            assert_eq!(
                outbox_count, 0,
                "rejected finalized settlement must roll back every outbox mutation"
            );
        }
    }

    #[test]
    fn payment_method_edit_leaves_non_delivery_without_courier_earning_and_rolls_back_outbox_failure(
    ) {
        let db = test_db();
        {
            let conn = db.conn.lock().expect("lock non-delivery database");
            conn.execute(
                "INSERT INTO orders (
                     id, items, total_amount, total_amount_cents, status, order_type,
                     payment_status, sync_status, supabase_id, created_at, updated_at
                 ) VALUES ('non-delivery-payment-edit', '[]', 12.0, 1200, 'completed', 'takeaway',
                           'paid', 'synced', 'remote-non-delivery', ?1, ?1)",
                params!["2026-08-12T00:00:00Z"],
            )
            .expect("insert non-delivery order");
            conn.execute(
                "INSERT INTO order_payments (
                     id, order_id, method, amount, amount_cents, currency, status,
                     payment_origin, sync_status, sync_state, created_at, updated_at
                 ) VALUES ('payment-non-delivery', 'non-delivery-payment-edit', 'cash', 12.0, 1200,
                           'EUR', 'completed', 'manual', 'synced', 'applied', ?1, ?1)",
                params!["2026-08-12T00:00:00Z"],
            )
            .expect("insert non-delivery payment");
        }
        update_payment_method_for_payment(
            &db,
            "non-delivery-payment-edit",
            Some("payment-non-delivery"),
            "card",
        )
        .expect("non-delivery payment edit remains supported");
        {
            let conn = db.conn.lock().expect("lock non-delivery result database");
            let driver_earning_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM driver_earnings WHERE order_id = 'non-delivery-payment-edit'",
                    [],
                    |row| row.get(0),
                )
                .expect("count non-delivery courier earnings");
            assert_eq!(
                driver_earning_count, 0,
                "payment edit must not invent courier earnings"
            );
        }

        let rollback_db = test_db();
        let payment_id = seed_driver_delivery_with_completed_payments(
            &rollback_db,
            "delivery-outbox-rollback",
            &[("cash", 2400)],
            "active",
            0,
            0,
        )[0]
        .clone();
        {
            let conn = rollback_db
                .conn
                .lock()
                .expect("lock rollback trigger database");
            conn.execute_batch(
                "CREATE TRIGGER abort_driver_earning_outbox
                 BEFORE INSERT ON parity_sync_queue
                 WHEN NEW.table_name = 'driver_earnings'
                 BEGIN
                    SELECT RAISE(ABORT, 'forced driver earning outbox failure');
                 END;",
            )
            .expect("install outbox rollback trigger");
        }
        let error = update_payment_method_for_payment(
            &rollback_db,
            "delivery-outbox-rollback",
            Some(payment_id.as_str()),
            "card",
        )
        .expect_err("driver earning outbox failure must abort the complete payment edit");
        assert!(error.contains("forced driver earning outbox failure"));
        let conn = rollback_db
            .conn
            .lock()
            .expect("lock rollback assertions database");
        let (payment_method, cash_cents, card_cents): (String, i64, i64) = conn
            .query_row(
                "SELECT op.method, de.cash_collected_cents, de.card_amount_cents
                 FROM order_payments op
                 JOIN driver_earnings de ON de.order_id = op.order_id
                 WHERE op.id = ?1",
                params![payment_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read rolled back payment and courier state");
        let outbox_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE table_name IN ('payments', 'driver_earnings')",
                [],
                |row| row.get(0),
            )
            .expect("count rolled back payment and courier outboxes");
        assert_eq!(
            (payment_method, cash_cents, card_cents),
            ("cash".to_string(), 2400, 0)
        );
        assert_eq!(
            outbox_count, 0,
            "failed courier enqueue must roll back payment and all canonical outboxes"
        );
    }

    #[test]
    fn build_payment_sync_payload_includes_edit_settlement_refund_proof() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (
                 id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-settlement-proof', '[]', 4.89, 489, 'completed', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents,
                 tip_amount, tip_amount_cents, tip_recipient_role,
                 tip_recipient_staff_id, tip_recipient_staff_shift_id,
                 status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'pay-settlement-proof', 'order-settlement-proof', 'card', 15.19, 1519,
                 1.25, 125, 'waiter', 'staff-waiter-1', 'shift-waiter-1',
                 'completed', 'pending', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed payment");
        conn.execute(
            "INSERT INTO payment_adjustments (
                 id, payment_id, order_id, adjustment_type, amount, amount_cents, reason,
                 refund_method, adjustment_context, idempotency_key, sync_state, created_at, updated_at
             ) VALUES (
                 'adj-settlement-proof', 'pay-settlement-proof', 'order-settlement-proof',
                 'refund', 10.30, 1030, 'Order edit settlement', 'card',
                 'edit_settlement', 'adjustment:adj-settlement-proof',
                 'waiting_parent', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed adjustment");

        let payload = serde_json::from_str::<Value>(
            &build_payment_sync_payload_for_payment(&conn, "pay-settlement-proof")
                .expect("build payload"),
        )
        .expect("parse payload");
        let adjustments = payload
            .get("settlement_adjustments")
            .and_then(Value::as_array)
            .expect("settlement adjustments");

        assert_eq!(adjustments.len(), 1);
        assert_eq!(
            adjustments[0]
                .get("adjustment_type")
                .and_then(Value::as_str),
            Some("refund")
        );
        assert_eq!(
            adjustments[0]
                .get("adjustment_context")
                .and_then(Value::as_str),
            Some("edit_settlement")
        );
        assert_eq!(
            adjustments[0].get("amount_cents").and_then(Value::as_i64),
            Some(1030)
        );
        assert_eq!(
            adjustments[0]
                .get("idempotency_key")
                .and_then(Value::as_str),
            Some("adjustment:adj-settlement-proof")
        );
        assert_eq!(
            payload.get("tip_amount_cents").and_then(Value::as_i64),
            Some(125)
        );
        assert_eq!(
            payload.get("tipRecipientRole").and_then(Value::as_str),
            Some("waiter")
        );
        assert_eq!(
            payload.get("tipRecipientStaffId").and_then(Value::as_str),
            Some("staff-waiter-1")
        );
        assert_eq!(
            payload
                .get("tipRecipientStaffShiftId")
                .and_then(Value::as_str),
            Some("shift-waiter-1")
        );
    }

    #[test]
    fn test_record_payment_and_query() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Insert an order — W4e Step 0: dual-populate (25.0 → 2500).
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES ('ord-1', '[{\"name\":\"Pizza\",\"quantity\":2,\"totalPrice\":20.0}]', 25.0, 2500, 'pending', 'pending', datetime('now'), datetime('now'))",
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

        // Wave 5 Session 7 PR 0: canonical payment rows now live on
        // `parity_sync_queue` under `(table_name='payments', record_id=...)`;
        // the legacy `sync_queue` is drain-only until the v56 drop.
        let canonical_queue_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE table_name = 'payments'
                   AND record_id = ?1",
                params![payment_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(canonical_queue_count, 1);

        let legacy_queue_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue
                 WHERE entity_type = 'payment'
                   AND entity_id = ?1",
                params![payment_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_queue_count, 0);
        drop(conn);

        // Query payments
        let payments = get_order_payments(&db, "ord-1").expect("get_order_payments");
        let arr = payments.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["method"], "cash");
        assert_eq!(arr[0]["amount"], 25.0);
        assert_eq!(arr[0]["refundedAmount"], 0.0);
        assert_eq!(arr[0]["remainingRefundable"], 25.0);
        assert_eq!(arr[0]["cashReceived"], 30.0);
        assert_eq!(arr[0]["changeGiven"], 5.0);
        assert_eq!(arr[0]["id"], payment_id);
    }

    #[test]
    fn test_record_delivery_tip_stays_pending_until_driver_assignment() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (
                 id, items, order_type, total_amount, total_amount_cents,
                 tip_amount, tip_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'ord-delivery-tip', '[]', 'delivery', 12.0, 1200,
                 2.0, 200, 'pending', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("insert delivery tip order");
        drop(conn);

        let recorded = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-delivery-tip",
                "method": "cash",
                "amount": 12.0,
                "cashReceived": 12.0,
                "changeGiven": 0.0,
                "tipAmount": 2.0,
                "tipRecipientRole": "driver",
            }),
        )
        .expect("record delivery payment with pending driver tip");
        let payment_id = recorded["paymentId"].as_str().expect("payment id");

        let conn = db.conn.lock().unwrap();
        let (tip_cents, role, staff_id, shift_id): (
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT tip_amount_cents, tip_recipient_role,
                        tip_recipient_staff_id, tip_recipient_staff_shift_id
                 FROM order_payments
                 WHERE id = ?1",
                params![payment_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("load durable tip allocation");

        assert_eq!(tip_cents, 200);
        assert_eq!(role.as_deref(), Some("driver"));
        assert_eq!(staff_id, None);
        assert_eq!(shift_id, None);
    }

    #[test]
    fn test_record_payment_accepts_supabase_order_id() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (
                id, supabase_id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                'local-table-order', 'remote-table-order', '[]', 22.0, 2200, 'pending', 'synced',
                datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("insert synced table order");
        drop(conn);

        let result = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "remote-table-order",
                "method": "card",
                "amount": 22.0,
                "transactionRef": "CARD-TABLE-REMOTE-ID",
            }),
        )
        .expect("record payment using remote order id");

        assert_eq!(result["success"], true);
        let conn = db.conn.lock().unwrap();
        let payment_order_id: String = conn
            .query_row(
                "SELECT order_id FROM order_payments WHERE transaction_ref = 'CARD-TABLE-REMOTE-ID'",
                [],
                |row| row.get(0),
            )
            .expect("load recorded payment order id");
        assert_eq!(payment_order_id, "local-table-order");
    }

    #[test]
    fn test_get_order_payments_includes_refund_balances() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // W4e Step 0: dual-populate (12.8 → 1280).
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES ('ord-refund-balance', '[]', 12.8, 1280, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert refund balance order");
        drop(conn);

        let payment = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-refund-balance",
                "method": "card",
                "amount": 12.8,
                "transactionRef": "CARD-REFUND-BALANCE",
            }),
        )
        .expect("record refund balance payment");
        let payment_id = payment["paymentId"]
            .as_str()
            .expect("payment id")
            .to_string();

        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate amount + amount_cents (10.9 → 1090).
        conn.execute(
            "INSERT INTO payment_adjustments (
                 id, payment_id, order_id, adjustment_type, amount, amount_cents,
                 reason, staff_id, sync_state, created_at, updated_at
             ) VALUES (
                 'adj-refund-balance', ?1, 'ord-refund-balance', 'refund', 10.9, 1090,
                 'test refund', NULL, 'pending', datetime('now'), datetime('now')
             )",
            params![payment_id],
        )
        .expect("insert refund adjustment");
        drop(conn);

        let payments =
            get_order_payments(&db, "ord-refund-balance").expect("get refund balance payments");
        let arr = payments.as_array().expect("payments array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["amount"], 12.8);
        assert_eq!(arr[0]["refundedAmount"], 10.9);
        assert_eq!(arr[0]["remainingRefundable"], 1.9);
    }

    #[test]
    fn test_record_split_payment_items_and_status_transitions() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // W4e Step 0: dual-populate (16.0 → 1600).
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES (
                'ord-split',
                '[{\"name\":\"Burger\",\"quantity\":1,\"totalPrice\":6.0},{\"name\":\"Fries\",\"quantity\":1,\"totalPrice\":4.0},{\"name\":\"Drink\",\"quantity\":1,\"totalPrice\":6.0}]',
                16.0,
                1600,
                'pending',
                'pending',
                datetime('now'),
                datetime('now')
             )",
            [],
        )
        .expect("insert split order");
        drop(conn);

        let first_payment = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-split",
                "method": "cash",
                "amount": 10.0,
                "cashReceived": 10.0,
                "changeGiven": 0.0,
                "transactionRef": "SPLIT-CASH-1",
                "items": [
                    {
                        "itemIndex": 0,
                        "itemName": "Burger",
                        "itemQuantity": 1,
                        "itemAmount": 6.0
                    },
                    {
                        "itemIndex": 1,
                        "itemName": "Fries",
                        "itemQuantity": 1,
                        "itemAmount": 4.0
                    }
                ]
            }),
        )
        .expect("record first split payment");
        let first_payment_id = first_payment["paymentId"]
            .as_str()
            .expect("first payment id")
            .to_string();

        let conn = db.conn.lock().unwrap();
        let first_status: String = conn
            .query_row(
                "SELECT payment_status FROM orders WHERE id = 'ord-split'",
                [],
                |row| row.get(0),
            )
            .expect("query partial payment state");
        assert_eq!(first_status, "partially_paid");
        // W6: a partially-paid order with a single completed cash row
        // now classifies as "cash" via derive_payment_method (no stored
        // column to read). The pre-W6 stored column wrote "split" because
        // of the `partially_paid` stickiness logic in recompute; post-drop
        // we rely on derive semantics — one row, one method, single label.
        let first_method =
            derive_payment_method(&conn, "ord-split").expect("derive partial payment method");
        assert_eq!(first_method.as_deref(), Some("cash"));
        drop(conn);

        let paid_items_after_first =
            get_paid_items(&db, "ord-split").expect("get first paid items");
        let first_items = paid_items_after_first
            .as_array()
            .expect("first paid items array");
        assert_eq!(first_items.len(), 2);
        assert_eq!(first_items[0]["paymentId"], first_payment_id);
        assert_eq!(first_items[0]["itemIndex"], 0);
        assert_eq!(first_items[1]["itemIndex"], 1);

        let second_payment = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-split",
                "method": "card",
                "amount": 6.0,
                "transactionRef": "SPLIT-CARD-2",
                "discountAmount": 1.5,
                "paymentOrigin": "terminal",
                "terminalDeviceId": "device-1",
                "items": [
                    {
                        "itemIndex": 2,
                        "itemName": "Drink",
                        "itemQuantity": 1,
                        "itemAmount": 6.0
                    }
                ]
            }),
        )
        .expect("record second split payment");
        let second_payment_id = second_payment["paymentId"]
            .as_str()
            .expect("second payment id")
            .to_string();

        let conn = db.conn.lock().unwrap();
        let final_status: String = conn
            .query_row(
                "SELECT payment_status FROM orders WHERE id = 'ord-split'",
                [],
                |row| row.get(0),
            )
            .expect("query final payment state");
        assert_eq!(final_status, "paid");
        let final_method =
            derive_payment_method(&conn, "ord-split").expect("derive final payment method");
        assert_eq!(final_method.as_deref(), Some("split"));
        drop(conn);

        let paid_items_after_second =
            get_paid_items(&db, "ord-split").expect("get second paid items");
        let second_items = paid_items_after_second
            .as_array()
            .expect("second paid items array");
        assert_eq!(second_items.len(), 3);
        assert_eq!(second_items[2]["paymentId"], second_payment_id);
        assert_eq!(second_items[2]["itemIndex"], 2);

        let payments = get_order_payments(&db, "ord-split").expect("get split order payments");
        let payment_rows = payments.as_array().expect("split payments array");
        assert_eq!(payment_rows.len(), 2);
        let card_payment = payment_rows
            .iter()
            .find(|payment| payment["id"] == second_payment_id)
            .expect("card payment row");
        assert_eq!(card_payment["discountAmount"], 1.5);
        assert_eq!(card_payment["paymentOrigin"], "terminal");
        assert_eq!(card_payment["terminalApproved"], true);
        assert_eq!(card_payment["terminalDeviceId"], "device-1");
        assert_eq!(
            card_payment["items"]
                .as_array()
                .expect("nested payment items")
                .len(),
            1
        );
    }

    #[test]
    fn test_record_payment_rejects_amount_above_outstanding_balance() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (9.7 → 970).
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, payment_status, sync_status, created_at, updated_at
             ) VALUES (
                'ord-fully-paid', '[]', 9.7, 970, 'completed', 'pending', 'pending',
                datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("insert fully paid order");
        drop(conn);

        record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-fully-paid",
                "method": "cash",
                "amount": 9.7,
                "cashReceived": 10.0,
                "changeGiven": 0.3,
                "transactionRef": "CASH-FULLY-PAID-1",
            }),
        )
        .expect("record initial payment");

        let error = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-fully-paid",
                "method": "card",
                "amount": 0.25,
                "transactionRef": "CARD-OVERPAY-1",
            }),
        )
        .expect_err("second payment should be rejected locally");
        assert!(error.contains("exceeds outstanding balance"));

        let conn = db.conn.lock().unwrap();
        let payment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM order_payments WHERE order_id = 'ord-fully-paid'",
                [],
                |row| row.get(0),
            )
            .expect("count payments after rejected overpay");
        assert_eq!(payment_count, 1);
    }

    #[test]
    fn test_sync_reconstructed_payment_bypasses_local_outstanding_guard() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (5.0 → 500).
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, payment_status, sync_status, created_at, updated_at
             ) VALUES (
                'ord-sync-reconstructed', '[]', 5.0, 500, 'completed', 'paid', 'synced',
                datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("insert reconstructed order");
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, remote_payment_id,
                sync_status, sync_state, created_at, updated_at
             ) VALUES (
                'payment-sync-existing', 'ord-sync-reconstructed', 'cash', 5.0, 500, 'completed',
                'remote-payment-existing', 'synced', 'applied', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("insert canonical existing payment");

        let payload = serde_json::json!({
            "orderId": "ord-sync-reconstructed",
            "method": "cash",
            "amount": 5.0,
            "transactionRef": "REMOTE-MIRROR-1",
            "paymentOrigin": "sync_reconstructed",
        });
        let input = build_payment_record_input(&payload).expect("prepare reconstructed payment");
        let mut options =
            PaymentInsertOptions::applied(Some("remote-payment-reconstructed".into()));
        options.created_at = Some("2026-04-16T09:39:05Z".to_string());
        options.updated_at = Some("2026-04-16T09:39:05Z".to_string());

        let recorded =
            record_payment_in_connection(&conn, &input, &options).expect("insert remote mirror");

        let (payment_origin, remote_payment_id, sync_state): (String, Option<String>, String) =
            conn.query_row(
                "SELECT payment_origin, remote_payment_id, sync_state
                 FROM order_payments
                 WHERE id = ?1",
                params![recorded.payment_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("query mirrored payment");
        assert_eq!(payment_origin, "sync_reconstructed");
        assert_eq!(
            remote_payment_id.as_deref(),
            Some("remote-payment-reconstructed")
        );
        assert_eq!(sync_state, "applied");
    }

    #[test]
    fn test_build_payment_record_input_preserves_table_service_metadata() {
        let payload = serde_json::json!({
            "orderId": "ord-table-payment",
            "method": "cash",
            "amount": 11.0,
            "tipAmount": 1.5,
            "tipRecipientRole": "waiter",
            "tipRecipientStaffId": "staff-waiter-1",
            "tipRecipientStaffShiftId": "shift-waiter-1",
            "tableSessionId": "local-table-session:ord-table-payment",
            "seatNumber": 2,
            "idempotencyKey": "table-payment-idempotency-1",
            "items": [{
                "order_item_id": "order-item-1",
                "itemIndex": 0,
                "itemName": "Pasta",
                "itemQuantity": 1,
                "itemAmount": 11.0
            }]
        });

        let input = build_payment_record_input(&payload).expect("prepare table payment");

        assert_eq!(input.order_id, "ord-table-payment");
        assert_eq!(input.method, "cash");
        assert_eq!(input.tip_amount, 1.5);
        assert_eq!(
            input.requested_tip_recipient_role.as_deref(),
            Some("waiter")
        );
        assert_eq!(
            input.requested_tip_recipient_staff_id.as_deref(),
            Some("staff-waiter-1")
        );
        assert_eq!(
            input.requested_tip_recipient_staff_shift_id.as_deref(),
            Some("shift-waiter-1")
        );
        assert_eq!(
            input.table_session_id.as_deref(),
            Some("local-table-session:ord-table-payment")
        );
        assert_eq!(input.seat_number, Some(2));
        assert_eq!(input.items.len(), 1);
        assert_eq!(input.items[0].item_index, 0);
        assert_eq!(input.items[0].item_quantity, 1);
        assert_eq!(input.items[0].item_amount, 11.0);
    }

    #[test]
    fn test_update_payment_method_requeues_payment_sync_and_updates_snapshot() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (12.0 → 1200).
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, sync_status, payment_status,
                supabase_id, created_at, updated_at
             ) VALUES (
                'ord-method-edit',
                '[]',
                12.0,
                1200,
                'completed',
                'synced',
                'pending',
                'remote-order-1',
                datetime('now'),
                datetime('now')
             )",
            [],
        )
        .expect("insert order for payment method edit");
        drop(conn);

        let recorded = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-method-edit",
                "method": "cash",
                "amount": 12.0,
                "cashReceived": 12.0,
                "changeGiven": 0.0,
                "transactionRef": "CASH-METHOD-EDIT-1",
            }),
        )
        .expect("record initial payment");
        let payment_id = recorded["paymentId"]
            .as_str()
            .expect("payment id")
            .to_string();

        let conn = db.conn.lock().unwrap();
        // Wave 5 Session 7 PR 0: clear the canonical parity row left by
        // `record_payment` so the assertion below directly reflects what
        // `refresh_payment_sync_queue_entry` re-enqueues post-update.
        conn.execute(
            "DELETE FROM parity_sync_queue
             WHERE table_name = 'payments'
               AND record_id = ?1",
            params![payment_id.clone()],
        )
        .expect("clear healthy canonical payment parity row");
        conn.execute(
            "UPDATE order_payments
             SET sync_status = 'synced',
                 sync_state = 'applied',
                 remote_payment_id = 'remote-payment-1'
             WHERE id = ?1",
            params![payment_id.clone()],
        )
        .expect("mark local payment as mirrored");
        drop(conn);

        update_payment_method(&db, "ord-method-edit", "card").expect("update payment method");

        let conn = db.conn.lock().unwrap();
        let (order_status, order_sync_status): (String, String) = conn
            .query_row(
                "SELECT payment_status, sync_status
                 FROM orders
                 WHERE id = 'ord-method-edit'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query updated order snapshot");
        let order_method =
            derive_payment_method(&conn, "ord-method-edit").expect("derive method after edit");
        assert_eq!(order_method.as_deref(), Some("card"));
        assert_eq!(order_status, "paid");
        assert_eq!(order_sync_status, "pending");

        let (payment_method, payment_sync_status, payment_sync_state, remote_payment_id): (
            String,
            String,
            String,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT method, sync_status, sync_state, remote_payment_id
                 FROM order_payments
                 WHERE id = ?1",
                params![payment_id.clone()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("query updated payment row");
        assert_eq!(payment_method, "card");
        assert_eq!(payment_sync_status, "pending");
        assert_eq!(payment_sync_state, "pending");
        assert_eq!(remote_payment_id.as_deref(), Some("remote-payment-1"));

        // Wave 5 Session 7 PR 0: canonical payment rows now live on
        // `parity_sync_queue`. `data` is the parity column name for what
        // the legacy schema called `payload`.
        let (queue_status, payload): (String, String) = conn
            .query_row(
                "SELECT status, data
                 FROM parity_sync_queue
                 WHERE table_name = 'payments'
                   AND record_id = ?1
                 ORDER BY created_at DESC
                 LIMIT 1",
                params![payment_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query refreshed canonical payment parity row");
        assert_eq!(queue_status, "pending");
        assert!(payload.contains("\"method\":\"card\""));
        let payload_json: Value = serde_json::from_str(&payload).expect("payment payload json");
        assert_eq!(
            payload_json
                .get("remote_payment_id")
                .and_then(Value::as_str),
            Some("remote-payment-1")
        );
        assert_eq!(
            payload_json
                .get("canonical_payment_id")
                .and_then(Value::as_str),
            Some("remote-payment-1")
        );
        assert_eq!(
            payload_json.get("payment_id").and_then(Value::as_str),
            Some(payment_id.as_str())
        );
        assert!(
            payload_json
                .get("idempotency_key")
                .and_then(Value::as_str)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
            "payment payload should include persisted local idempotency identity"
        );
    }

    #[test]
    fn test_update_payment_method_rejects_multiple_completed_payments_with_stable_code() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, sync_status, payment_status,
                created_at, updated_at
             ) VALUES (
                'ord-method-split',
                '[]',
                10.0,
                1000,
                'completed',
                'pending',
                'pending',
                datetime('now'),
                datetime('now')
             )",
            [],
        )
        .expect("insert split order for payment method edit");
        drop(conn);

        record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-method-split",
                "method": "cash",
                "amount": 4.0,
                "cashReceived": 4.0,
                "changeGiven": 0.0,
                "transactionRef": "SPLIT-METHOD-CASH-1",
            }),
        )
        .expect("record first split payment");
        record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-method-split",
                "method": "card",
                "amount": 6.0,
                "transactionRef": "SPLIT-METHOD-CARD-2",
            }),
        )
        .expect("record second split payment");

        let error = update_payment_method(&db, "ord-method-split", "card")
            .expect_err("split payments must not be rewritten as one payment");
        assert_eq!(
            error,
            "PAYMENT_METHOD_EDIT_REQUIRES_SINGLE_COMPLETED_PAYMENT"
        );

        let conn = db.conn.lock().unwrap();
        let methods: Vec<String> = conn
            .prepare(
                "SELECT method
                 FROM order_payments
                 WHERE order_id = 'ord-method-split'
                   AND status = 'completed'
                 ORDER BY created_at ASC",
            )
            .expect("prepare split payment method query")
            .query_map([], |row| row.get(0))
            .expect("query split payment methods")
            .collect::<Result<Vec<_>, _>>()
            .expect("read split payment methods");
        assert_eq!(methods, vec!["cash".to_string(), "card".to_string()]);
    }

    #[test]
    fn test_update_payment_method_targets_one_completed_split_payment() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, sync_status, payment_status,
                created_at, updated_at
             ) VALUES (
                'ord-method-targeted-split',
                '[]',
                10.0,
                1000,
                'completed',
                'pending',
                'pending',
                datetime('now'),
                datetime('now')
             )",
            [],
        )
        .expect("insert split order for targeted payment method edit");
        drop(conn);

        let first = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-method-targeted-split",
                "method": "cash",
                "amount": 4.0,
                "cashReceived": 4.0,
                "changeGiven": 0.0,
                "transactionRef": "TARGETED-SPLIT-CASH-1",
            }),
        )
        .expect("record first targeted split payment");
        let first_payment_id = first["paymentId"]
            .as_str()
            .expect("first payment id")
            .to_string();
        let second = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-method-targeted-split",
                "method": "cash",
                "amount": 6.0,
                "cashReceived": 6.0,
                "changeGiven": 0.0,
                "transactionRef": "TARGETED-SPLIT-CASH-2",
            }),
        )
        .expect("record second targeted split payment");
        let second_payment_id = second["paymentId"]
            .as_str()
            .expect("second payment id")
            .to_string();

        let result = update_payment_method_for_payment(
            &db,
            "ord-method-targeted-split",
            Some(first_payment_id.as_str()),
            "card",
        )
        .expect("targeted split payment method edit");
        assert_eq!(result["data"]["paymentId"], first_payment_id);
        assert_eq!(result["data"]["paymentMethod"], "card");

        let conn = db.conn.lock().unwrap();
        let first_method: String = conn
            .query_row(
                "SELECT method FROM order_payments WHERE id = ?1",
                params![first_payment_id],
                |row| row.get(0),
            )
            .expect("read targeted payment method");
        let second_method: String = conn
            .query_row(
                "SELECT method FROM order_payments WHERE id = ?1",
                params![second_payment_id],
                |row| row.get(0),
            )
            .expect("read untouched payment method");
        assert_eq!(first_method, "card");
        assert_eq!(second_method, "cash");
    }

    #[test]
    fn test_update_payment_method_falls_back_to_order_snapshot_when_payment_row_missing() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (18.5 → 1850).
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, sync_status, payment_status,
                supabase_id, created_at, updated_at
             ) VALUES (
                'ord-method-fallback',
                '[]',
                18.5,
                1850,
                'completed',
                'synced',
                'paid',
                'remote-order-fallback',
                datetime('now'),
                datetime('now')
             )",
            [],
        )
        .expect("insert order for payment snapshot fallback");
        drop(conn);

        let result = update_payment_method(&db, "ord-method-fallback", "card")
            .expect("update payment method via order snapshot fallback");
        assert_eq!(result["data"]["paymentMethod"], "card");
        assert_eq!(result["data"]["paymentStatus"], "paid");
        assert_eq!(result["data"]["paymentId"], Value::Null);
        assert_eq!(result["data"]["usedOrderSnapshotFallback"], true);

        let conn = db.conn.lock().unwrap();
        let (order_status, order_sync_status): (String, String) = conn
            .query_row(
                "SELECT payment_status, sync_status
                 FROM orders
                 WHERE id = 'ord-method-fallback'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query fallback-updated order snapshot");
        // W6: the snapshot fallback no longer persists `payment_method`
        // locally — the column is gone. With zero completed payment rows
        // `derive_payment_method` returns None. The edit intent lives in
        // the sync payload only (asserted below).
        let order_method = derive_payment_method(&conn, "ord-method-fallback")
            .expect("derive method after fallback edit");
        assert_eq!(order_method, None);
        assert_eq!(order_status, "paid");
        assert_eq!(order_sync_status, "pending");

        let payment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM order_payments WHERE order_id = 'ord-method-fallback'",
                [],
                |row| row.get(0),
            )
            .expect("query payment count for fallback order");
        assert_eq!(payment_count, 0);

        let (queue_status, payload): (String, String) = conn
            .query_row(
                "SELECT status, data
                 FROM parity_sync_queue
                 WHERE table_name = 'orders'
                   AND record_id = 'ord-method-fallback'
                 LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query fallback order sync row");
        assert_eq!(queue_status, "pending");
        assert!(payload.contains("\"paymentMethod\":\"card\""));
        assert!(payload.contains("\"paymentStatus\":\"paid\""));
    }

    #[test]
    fn test_update_payment_method_same_method_requeues_failed_payment_sync() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (9.5 → 950).
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, sync_status, payment_status,
                supabase_id, created_at, updated_at
             ) VALUES (
                'ord-method-retry',
                '[]',
                9.5,
                950,
                'completed',
                'synced',
                'paid',
                'remote-order-retry',
                datetime('now'),
                datetime('now')
             )",
            [],
        )
        .expect("insert order for same-method retry");
        drop(conn);

        let recorded = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-method-retry",
                "method": "cash",
                "amount": 9.5,
                "cashReceived": 10.0,
                "changeGiven": 0.5,
                "transactionRef": "CASH-RETRY-1",
            }),
        )
        .expect("record payment for same-method retry");
        let payment_id = recorded["paymentId"]
            .as_str()
            .expect("payment id")
            .to_string();

        let conn = db.conn.lock().unwrap();
        // Wave 5 Session 7 PR 0: simulate a failed sync attempt on the
        // canonical parity row (not legacy `sync_queue`). Parity column
        // names differ: `attempts` for retry count, `error_message` for
        // last error.
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 5,
                 error_message = 'Internal server error',
                 next_retry_at = datetime('now', '+10 minutes')
             WHERE table_name = 'payments'
               AND record_id = ?1",
            params![payment_id.clone()],
        )
        .expect("mark canonical parity row failed");
        conn.execute(
            "UPDATE order_payments
             SET sync_status = 'failed',
                 sync_state = 'failed',
                 sync_retry_count = 5,
                 sync_last_error = 'Internal server error',
                 sync_next_retry_at = datetime('now', '+10 minutes')
             WHERE id = ?1",
            params![payment_id.clone()],
        )
        .expect("mark payment sync metadata failed");
        drop(conn);

        let result = update_payment_method(&db, "ord-method-retry", "cash")
            .expect("retry failed payment sync with same method");
        assert_eq!(result["data"]["retriedSync"], true);
        assert_eq!(result["data"]["paymentMethod"], "cash");

        let conn = db.conn.lock().unwrap();
        // Wave 5 Session 7 PR 0: `clear_unsynced_items` drops the failed
        // row and `enqueue_payload_item` inserts a fresh pending row
        // with `attempts=0`, `error_message=NULL`. `ORDER BY created_at
        // DESC LIMIT 1` picks the freshly-enqueued row rather than any
        // historical synced row in the same (table_name, record_id)
        // bucket (there shouldn't be one here, but belt and braces).
        let (queue_status, attempts, error_message): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, error_message
                 FROM parity_sync_queue
                 WHERE table_name = 'payments'
                   AND record_id = ?1
                 ORDER BY created_at DESC
                 LIMIT 1",
                params![payment_id.clone()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("query refreshed canonical parity row");
        assert_eq!(queue_status, "pending");
        assert_eq!(attempts, 0);
        assert_eq!(error_message, None);

        let (payment_sync_status, payment_sync_state): (String, String) = conn
            .query_row(
                "SELECT sync_status, sync_state
                 FROM order_payments
                 WHERE id = ?1",
                params![payment_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query refreshed payment sync metadata");
        assert_eq!(payment_sync_status, "pending");
        assert_eq!(payment_sync_state, "pending");
    }

    #[test]
    fn test_update_payment_method_same_method_noop_when_sync_is_healthy() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (6.25 → 625).
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, sync_status, payment_status,
                supabase_id, created_at, updated_at
             ) VALUES (
                'ord-method-noop',
                '[]',
                6.25,
                625,
                'completed',
                'synced',
                'paid',
                'remote-order-noop',
                datetime('now'),
                datetime('now')
             )",
            [],
        )
        .expect("insert order for same-method noop");
        drop(conn);

        let recorded = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-method-noop",
                "method": "cash",
                "amount": 6.25,
                "cashReceived": 6.5,
                "changeGiven": 0.25,
                "transactionRef": "CASH-NOOP-1",
            }),
        )
        .expect("record payment for same-method noop");
        let payment_id = recorded["paymentId"]
            .as_str()
            .expect("payment id")
            .to_string();

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM sync_queue
             WHERE entity_type = 'payment'
               AND entity_id = ?1",
            params![payment_id.clone()],
        )
        .expect("clear healthy canonical payment row");
        conn.execute(
            "UPDATE order_payments
             SET sync_status = 'synced',
                 sync_state = 'applied',
                 sync_retry_count = 0,
                 sync_last_error = NULL,
                 sync_next_retry_at = NULL
             WHERE id = ?1",
            params![payment_id.clone()],
        )
        .expect("mark payment sync metadata synced");
        drop(conn);

        let result =
            update_payment_method(&db, "ord-method-noop", "cash").expect("same-method no-op");
        assert_eq!(result["data"]["retriedSync"], false);
        assert_eq!(result["data"]["paymentMethod"], "cash");

        let conn = db.conn.lock().unwrap();
        let queue_count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM sync_queue
                 WHERE entity_type = 'payment'
                   AND entity_id = ?1",
                params![payment_id],
                |row| row.get(0),
            )
            .expect("query unchanged canonical payment queue rows");
        assert_eq!(queue_count, 0);
    }

    #[test]
    fn test_void_payment() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (10.0 → 1000).
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES ('ord-2', '[]', 10.0, 1000, 'pending', 'pending', datetime('now'), datetime('now'))",
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
        let void_result = void_payment(
            &db,
            &payment_id,
            "Customer changed mind",
            Some("staff-1"),
            None,
        )
        .unwrap();
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

        // Wave 5 Session 7 PR 0: the original payment canonical queue row
        // now lives on parity (not legacy `sync_queue`). The void adds a
        // `payment_adjustments` row on parity — both rows are on parity.
        let payment_queue_count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM parity_sync_queue
                 WHERE table_name = 'payments'
                   AND record_id = ?1",
                params![payment_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment_queue_count, 1);

        let adjustment_queue_count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM parity_sync_queue
                 WHERE table_name = 'payment_adjustments'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(adjustment_queue_count, 1);
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
        // W4e Step 0: dual-populate (100.0 → 10000, 25.0 → 2500).
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id, opening_amount, opening_amount_cents, opened_at, created_at, updated_at)
             VALUES ('cd-1', 'shift-cs', 'staff-1', 'b1', 't1', 100.0, 10000, datetime('now'), datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, staff_shift_id, created_at, updated_at)
             VALUES ('ord-cs1', '[]', 25.0, 2500, 'pending', 'pending', 'shift-cs', datetime('now'), datetime('now'))",
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
        // W4e Step 0: dual-populate (100.0 → 10000, 30.0 → 3000).
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id, opening_amount, opening_amount_cents, opened_at, created_at, updated_at)
             VALUES ('cd-2', 'shift-cd', 'staff-2', 'b1', 't1', 100.0, 10000, datetime('now'), datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, staff_shift_id, created_at, updated_at)
             VALUES ('ord-cd1', '[]', 30.0, 3000, 'pending', 'pending', 'shift-cd', datetime('now'), datetime('now'))",
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
    fn test_resolve_unsettled_payment_blocker_backfills_historical_cashier_payment() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let check_in = "2026-03-26T08:00:00Z";
        let historical_at = "2026-03-26T21:15:00Z";
        let check_out = "2026-03-26T23:30:00Z";

        // W4e Step 0: dual-populate every monetary column (100.0/113.7/13.7 → 10000/11370/1370).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time, check_out_time,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'shift-z-block', 'cashier-z', 'cashier', 'branch-z', 'terminal-z', ?1, ?2,
                100.0, 10000, 113.7, 11370, 100.0, 10000, 13.7, 1370,
                'closed', 2, 'synced', ?1, ?2
            )",
            params![check_in, check_out],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                closing_amount, closing_amount_cents,
                expected_amount, expected_amount_cents,
                variance_amount, variance_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                total_card_sales, total_card_sales_cents,
                opened_at, closed_at, reconciled, created_at, updated_at
            ) VALUES (
                'drawer-z-block', 'shift-z-block', 'cashier-z', 'branch-z', 'terminal-z',
                100.0, 10000, 113.7, 11370, 100.0, 10000, 13.7, 1370,
                0.0, 0, 0.0, 0, ?1, ?2, 1, ?1, ?2
            )",
            params![check_in, check_out],
        )
        .unwrap();
        conn.execute(
            // W4e Step 0: dual-populate (13.7 → 1370).
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, payment_status,
                sync_status, branch_id, terminal_id, staff_shift_id, created_at, updated_at
            ) VALUES (
                'ord-z-block', 'ORD-20260326-0049', '[]', 13.7, 1370, 'completed', 'pending',
                'synced', 'branch-z', 'terminal-z', 'shift-z-block', ?1, ?1
            )",
            params![historical_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status
            ) VALUES (
                'shift', 'shift-z-block', 'update', '{}', 'shift:z-block:stale', 'pending'
            )",
            [],
        )
        .unwrap();
        drop(conn);

        let result = resolve_unsettled_payment_blocker_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-z-block",
                "method": "cash",
            }),
        )
        .expect("repair blocked payment from z-report");
        assert_eq!(result["success"], true);
        assert_eq!(result["amount"], 13.7);

        let conn = db.conn.lock().unwrap();
        let (payment_method, payment_amount, payment_created_at, payment_shift_id): (
            String,
            f64,
            String,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT method, amount, created_at, staff_shift_id
                 FROM order_payments
                 WHERE order_id = 'ord-z-block'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(payment_method, "cash");
        assert_eq!(payment_amount, 13.7);
        assert_eq!(payment_created_at, historical_at);
        assert_eq!(payment_shift_id.as_deref(), Some("shift-z-block"));

        let order_payment_status: String = conn
            .query_row(
                "SELECT payment_status FROM orders WHERE id = 'ord-z-block'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(order_payment_status, "paid");
        let order_payment_method =
            derive_payment_method(&conn, "ord-z-block").expect("derive method for z-block order");
        assert_eq!(order_payment_method.as_deref(), Some("cash"));

        let effective_at =
            crate::business_day::resolve_order_financial_effective_at(&conn, "ord-z-block")
                .expect("resolve repaired financial timestamp");
        assert_eq!(effective_at, historical_at);

        let (
            drawer_cash_sales,
            drawer_expected,
            drawer_variance,
            shift_total_orders,
            shift_total_sales,
            shift_cash_sales,
        ): (f64, f64, f64, i64, f64, f64) = conn
            .query_row(
                "SELECT cds.total_cash_sales, cds.expected_amount, cds.variance_amount,
                        ss.total_orders_count, ss.total_sales_amount, ss.total_cash_sales
                 FROM cash_drawer_sessions cds
                 JOIN staff_shifts ss ON ss.id = cds.staff_shift_id
                 WHERE cds.staff_shift_id = 'shift-z-block'",
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
            .unwrap();
        assert_eq!(drawer_cash_sales, 13.7);
        assert_eq!(drawer_expected, 113.7);
        assert_eq!(drawer_variance, 0.0);
        assert_eq!(shift_total_orders, 1);
        assert_eq!(shift_total_sales, 13.7);
        assert_eq!(shift_cash_sales, 13.7);

        // Wave 5 Session 6: replace_unfinished_shift_sync_rows_with_current_snapshot
        // now writes the fresh snapshot to parity_sync_queue and clears the
        // stale legacy row through clear_unfinished_sync_queue_rows (which
        // scrubs BOTH tables). Assert both halves: legacy empty, parity
        // carries the single canonical UPDATE.
        let legacy_shift_sync_count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM sync_queue
                 WHERE entity_type = 'shift'
                   AND entity_id = 'shift-z-block'
                   AND status IN ('pending', 'in_progress', 'failed', 'deferred')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let parity_shift_sync_count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM parity_sync_queue
                 WHERE table_name = 'staff_shifts'
                   AND record_id = 'shift-z-block'
                   AND status IN ('pending', 'processing', 'failed', 'conflict')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            legacy_shift_sync_count, 0,
            "closed shift repair should clear the stale legacy-queue row"
        );
        assert_eq!(
            parity_shift_sync_count, 1,
            "closed shift repair should land a single fresh snapshot on parity_sync_queue"
        );

        let blockers = payment_integrity::load_order_payment_blockers(&conn, "ord-z-block")
            .expect("load blockers after repair");
        assert!(blockers.is_empty(), "repair should clear payment blockers");
    }

    #[test]
    fn test_resolve_unsettled_payment_blocker_uses_checkout_cashier_shift_for_delivery_delta() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let check_in = "2026-04-27T17:00:00Z";
        let order_at = "2026-04-27T20:00:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'shift-checkout-repair', 'cashier-repair', 'cashier', 'branch-repair', 'terminal-repair', ?1,
                100.0, 10000, 'active', 2, 'synced', ?1, ?1
            )",
            params![check_in],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                total_card_sales, total_card_sales_cents,
                opened_at, reconciled, created_at, updated_at
            ) VALUES (
                'drawer-checkout-repair', 'shift-checkout-repair', 'cashier-repair', 'branch-repair', 'terminal-repair',
                100.0, 10000, 0.0, 0, 0.0, 0, ?1, 0, ?1, ?1
            )",
            params![check_in],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, payment_status,
                order_type, sync_status, branch_id, terminal_id, created_at, updated_at
            ) VALUES (
                'ord-delivery-delta', 'ORD-DELTA', '[]', 6.40, 640, 'completed', 'partially_paid',
                'delivery', 'synced', 'branch-repair', 'terminal-repair', ?1, ?1
            )",
            params![order_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, currency, status,
                cash_received, cash_received_cents, change_given, change_given_cents,
                sync_status, sync_state, created_at, updated_at
            ) VALUES (
                'pay-delivery-existing', 'ord-delivery-delta', 'cash', 6.0, 600, 'EUR', 'completed',
                6.0, 600, 0.0, 0, 'synced', 'applied', ?1, ?1
            )",
            params![order_at],
        )
        .unwrap();
        drop(conn);

        let result = resolve_unsettled_payment_blocker_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-delivery-delta",
                "method": "cash",
                "staffShiftId": "shift-checkout-repair",
                "staffId": "cashier-repair",
            }),
        )
        .expect("repair delivery delta from cashier checkout");
        assert_eq!(result["success"], true);
        let repaired_amount = result["amount"].as_f64().expect("repair amount");
        assert!(
            (repaired_amount - 0.4).abs() < 0.001,
            "expected 0.40 repair amount, got {repaired_amount}"
        );

        let conn = db.conn.lock().unwrap();
        let (payment_shift_id, payment_staff_id, amount_cents): (
            Option<String>,
            Option<String>,
            i64,
        ) = conn
            .query_row(
                "SELECT staff_shift_id, staff_id, amount_cents
                 FROM order_payments
                 WHERE order_id = 'ord-delivery-delta'
                   AND id != 'pay-delivery-existing'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(payment_shift_id.as_deref(), Some("shift-checkout-repair"));
        assert_eq!(payment_staff_id.as_deref(), Some("cashier-repair"));
        assert_eq!(amount_cents, 40);

        let drawer_cash_sales_cents: i64 = conn
            .query_row(
                "SELECT total_cash_sales_cents
                 FROM cash_drawer_sessions
                 WHERE staff_shift_id = 'shift-checkout-repair'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(drawer_cash_sales_cents, 40);

        let blockers = payment_integrity::load_order_payment_blockers(&conn, "ord-delivery-delta")
            .expect("load blockers after delivery repair");
        assert!(blockers.is_empty(), "repair should clear payment blockers");
    }

    #[test]
    fn test_resolve_unsettled_payment_blocker_checkout_shift_repairs_driver_delivery_delta() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let check_in = "2026-04-27T17:00:00Z";
        let order_at = "2026-04-27T20:00:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'shift-driver-owner', 'driver-owner', 'driver', 'branch-repair', 'terminal-repair', ?1,
                20.0, 2000, 'active', 2, 'synced', ?1, ?1
            )",
            params![check_in],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'shift-cashier-owner', 'cashier-owner', 'cashier', 'branch-repair', 'terminal-repair', ?1,
                100.0, 10000, 'active', 2, 'synced', ?1, ?1
            )",
            params![check_in],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                total_card_sales, total_card_sales_cents,
                opened_at, reconciled, created_at, updated_at
            ) VALUES (
                'drawer-cashier-owner', 'shift-cashier-owner', 'cashier-owner', 'branch-repair', 'terminal-repair',
                100.0, 10000, 0.0, 0, 0.0, 0, ?1, 0, ?1, ?1
            )",
            params![check_in],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, payment_status,
                order_type, driver_id, sync_status, branch_id, terminal_id, staff_shift_id,
                created_at, updated_at
            ) VALUES (
                'ord-driver-delta', 'ORD-DRIVER-DELTA', '[]', 6.40, 640, 'completed', 'partially_paid',
                'delivery', 'driver-owner', 'synced', 'branch-repair', 'terminal-repair', 'shift-driver-owner',
                ?1, ?1
            )",
            params![order_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, currency, status,
                cash_received, cash_received_cents, change_given, change_given_cents,
                staff_shift_id, staff_id, sync_status, sync_state, created_at, updated_at
            ) VALUES (
                'pay-driver-existing', 'ord-driver-delta', 'cash', 6.0, 600, 'EUR', 'completed',
                6.0, 600, 0.0, 0, 'shift-driver-owner', 'driver-owner', 'synced', 'applied', ?1, ?1
            )",
            params![order_at],
        )
        .unwrap();
        drop(conn);

        let result = resolve_unsettled_payment_blocker_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-driver-delta",
                "method": "cash",
                "staffShiftId": "shift-cashier-owner",
                "staffId": "cashier-owner",
            }),
        )
        .expect("repair driver delivery delta from cashier checkout");
        assert_eq!(result["success"], true);

        let conn = db.conn.lock().unwrap();
        let (payment_shift_id, amount_cents): (Option<String>, i64) = conn
            .query_row(
                "SELECT staff_shift_id, amount_cents
                 FROM order_payments
                 WHERE order_id = 'ord-driver-delta'
                   AND id != 'pay-driver-existing'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(payment_shift_id.as_deref(), Some("shift-cashier-owner"));
        assert_eq!(amount_cents, 40);

        let blockers = payment_integrity::load_order_payment_blockers(&conn, "ord-driver-delta")
            .expect("load blockers after driver delivery repair");
        assert!(
            blockers.is_empty(),
            "repair should clear driver delivery blockers"
        );
    }

    #[test]
    fn test_resolve_unsettled_payment_blocker_z_report_uses_cashier_drawer_for_driver_delivery_delta(
    ) {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let check_in = "2026-04-22T20:00:00Z";
        let driver_check_in = "2026-04-27T16:00:00Z";
        let order_at = "2026-04-27T19:08:38Z";
        let checkout_at = "2026-04-28T20:08:01Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time,
                check_out_time, opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'shift-z-cashier-delivery', 'cashier-z-delivery', 'cashier', 'branch-z-delivery', 'terminal-z-delivery', ?1,
                ?2, 100.0, 10000, 'closed', 2, 'synced', ?1, ?2
            )",
            params![check_in, checkout_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time,
                check_out_time, opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'shift-z-driver-delivery', 'driver-z-delivery', 'driver', 'branch-z-delivery', 'terminal-z-delivery', ?1,
                ?2, 20.0, 2000, 'closed', 2, 'synced', ?1, ?2
            )",
            params![driver_check_in, checkout_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                total_card_sales, total_card_sales_cents,
                opened_at, closed_at, reconciled, created_at, updated_at
            ) VALUES (
                'drawer-z-cashier-delivery', 'shift-z-cashier-delivery', 'cashier-z-delivery', 'branch-z-delivery', 'terminal-z-delivery',
                100.0, 10000, 0.0, 0, 0.0, 0, ?1, ?2, 1, ?1, ?2
            )",
            params![check_in, checkout_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, payment_status,
                order_type, driver_id, sync_status, branch_id, terminal_id, staff_shift_id,
                created_at, updated_at
            ) VALUES (
                'ord-z-driver-delivery', 'ORD-Z-DRIVER-DELIVERY', '[]', 6.40, 640, 'delivered', 'partially_paid',
                'delivery', 'driver-z-delivery', 'synced', 'branch-z-delivery', 'terminal-z-delivery', 'shift-z-driver-delivery',
                ?1, ?1
            )",
            params![order_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, currency, status,
                cash_received, cash_received_cents, change_given, change_given_cents,
                staff_shift_id, staff_id, sync_status, sync_state, created_at, updated_at
            ) VALUES (
                'pay-z-driver-base', 'ord-z-driver-delivery', 'cash', 6.0, 600, 'EUR', 'completed',
                6.0, 600, 0.0, 0, 'shift-z-driver-delivery', 'driver-z-delivery', 'synced', 'applied', ?1, ?1
            )",
            params![order_at],
        )
        .unwrap();
        drop(conn);

        let result = resolve_unsettled_payment_blocker_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-z-driver-delivery",
                "method": "cash",
            }),
        )
        .expect("repair driver delivery delta from z-report");
        assert_eq!(result["success"], true);

        let conn = db.conn.lock().unwrap();
        let (payment_shift_id, payment_staff_id, amount_cents): (
            Option<String>,
            Option<String>,
            i64,
        ) = conn
            .query_row(
                "SELECT staff_shift_id, staff_id, amount_cents
                 FROM order_payments
                 WHERE order_id = 'ord-z-driver-delivery'
                   AND id != 'pay-z-driver-base'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            payment_shift_id.as_deref(),
            Some("shift-z-cashier-delivery")
        );
        assert_eq!(payment_staff_id.as_deref(), Some("cashier-z-delivery"));
        assert_eq!(amount_cents, 40);

        let drawer_cash_sales_cents: i64 = conn
            .query_row(
                "SELECT total_cash_sales_cents
                 FROM cash_drawer_sessions
                 WHERE staff_shift_id = 'shift-z-cashier-delivery'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(drawer_cash_sales_cents, 40);

        let blockers =
            payment_integrity::load_order_payment_blockers(&conn, "ord-z-driver-delivery")
                .expect("load blockers after z-report delivery repair");
        assert!(
            blockers.is_empty(),
            "z-report repair should clear driver delivery blockers when a cashier drawer covered the timestamp"
        );
    }

    #[test]
    fn test_receipt_preview() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (14.50/14.50/0.0 → 1450/1450/0; 14.50/20.0/5.50 → 1450/2000/550).
        conn.execute(
            "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, subtotal, subtotal_cents, tax_amount, tax_amount_cents, status, order_type, sync_status, created_at, updated_at)
             VALUES ('ord-3', 'ORD-001', '[{\"name\":\"Burger\",\"quantity\":1,\"totalPrice\":8.50},{\"name\":\"Fries\",\"quantity\":2,\"totalPrice\":6.00}]', 14.50, 1450, 14.50, 1450, 0.0, 0, 'completed', 'dine-in', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, cash_received, cash_received_cents, change_given, change_given_cents, sync_status, created_at, updated_at)
             VALUES ('pay-3', 'ord-3', 'cash', 14.50, 1450, 20.0, 2000, 5.50, 550, 'pending', datetime('now'), datetime('now'))",
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
        // W4e Step 0: dual-populate (8.50/8.50/0.0 → 850/850/0).
        conn.execute(
            "INSERT INTO orders (id, order_number, customer_name, items, total_amount, total_amount_cents, subtotal, subtotal_cents, tax_amount, tax_amount_cents, status, order_type, sync_status, created_at, updated_at)
             VALUES ('ord-4', '<script>alert(1)</script>', '<img src=x onerror=alert(2)>', '[{\"name\":\"<b>Burger</b>\",\"quantity\":1,\"totalPrice\":8.50}]', 8.50, 850, 8.50, 850, 0.0, 0, 'completed', 'dine-in', 'pending', datetime('now'), datetime('now'))",
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

        // W4e Step 0: dual-populate (100.0 → 10000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, opening_cash_amount_cents, status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-shift', 'cashier-1', 'Cashier', 'branch-1', 'terminal-1', 'cashier',
                datetime('now'), 100.0, 10000, 'active', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-1', 'cash-shift', 'cashier-1', 'branch-1', 'terminal-1',
                100.0, 10000, datetime('now'), datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        // W4e Step 0: dual-populate (20.0/18.0 → 2000/1800).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, opening_cash_amount_cents, status, sync_status, created_at, updated_at
            ) VALUES (
                'driver-shift', 'driver-1', 'Driver', 'branch-1', 'terminal-1', 'driver',
                datetime('now'), 20.0, 2000, 'active', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, order_type, sync_status,
                branch_id, terminal_id, staff_shift_id, staff_id, driver_id,
                created_at, updated_at
            ) VALUES (
                'pickup-order', '[]', 18.0, 1800, 'pending', 'pickup', 'pending',
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

        // W4e Step 0: dual-populate (100.0/20.0/24.0 → 10000/2000/2400).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, opening_cash_amount_cents, status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-shift-2', 'cashier-2', 'Cashier', 'branch-2', 'terminal-2', 'cashier',
                datetime('now'), 100.0, 10000, 'active', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-2', 'cash-shift-2', 'cashier-2', 'branch-2', 'terminal-2',
                100.0, 10000, datetime('now'), datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, opening_cash_amount_cents, status, sync_status, created_at, updated_at
            ) VALUES (
                'driver-shift-2', 'driver-2', 'Driver', 'branch-2', 'terminal-2', 'driver',
                datetime('now'), 20.0, 2000, 'active', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, order_type, sync_status,
                branch_id, terminal_id, staff_shift_id, staff_id, driver_id,
                created_at, updated_at
            ) VALUES (
                'delivery-order', '[]', 24.0, 2400, 'pending', 'delivery', 'pending',
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

        // W4e Step 0: dual-populate (100.0/19.0 → 10000/1900).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, opening_cash_amount_cents, status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-shift-neutral', 'cashier-neutral', 'Cashier Neutral', 'branch-neutral', 'terminal-neutral', 'cashier',
                datetime('now'), 100.0, 10000, 'active', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-neutral', 'cash-shift-neutral', 'cashier-neutral', 'branch-neutral', 'terminal-neutral',
                100.0, 10000, datetime('now'), datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, order_type, sync_status,
                branch_id, terminal_id, created_at, updated_at
            ) VALUES (
                'delivery-neutral-order', '[]', 19.0, 1900, 'pending', 'delivery', 'pending',
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

    // =======================================================================
    // Wave 0 regression tests for Critical C3 (asymmetric money epsilon).
    //
    // The original C3 finding identified asymmetric float thresholds
    // (`+ 0.01` vs `- 0.01` and `0.009`) that left a one-cent dead-band.
    // Wave 2a fixed that with a shared `MONEY_EPSILON = 0.005`. W4e then
    // removed the epsilon entirely — comparisons now go through integer
    // cents (`Cents::round_half_even(value).as_i64()`), so the asymmetry
    // and the dead-band are both structurally impossible.
    // =======================================================================

    #[test]
    fn paying_exactly_one_cent_short_is_not_marked_paid() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            let now = chrono::Utc::now().to_rfc3339();
            // W4e Step 0: dual-populate (10.00 → 1000).
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
                 VALUES ('ord-1c-short', '[]', 10.00, 1000, 'pending', 'pending', ?1, ?1)",
                params![now],
            )
            .expect("insert 10.00 order");
        }

        // Pay 9.99 — strictly one cent short of 10.00.
        let payload = serde_json::json!({
            "orderId": "ord-1c-short",
            "method": "cash",
            "amount": 9.99_f64,
        });
        let result = record_payment(&db, &payload).expect("record 9.99 payment");
        assert_eq!(result["success"], true);

        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT payment_status FROM orders WHERE id = 'ord-1c-short'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            status, "partially_paid",
            "Paying 9.99 against a 10.00 order must NOT be marked 'paid' — asymmetric epsilon bug (Wave 2a C3)."
        );
    }

    #[test]
    fn total_paid_exactly_equals_total_is_paid() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            let now = chrono::Utc::now().to_rfc3339();
            // W4e Step 0: dual-populate (10.00 → 1000).
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
                 VALUES ('ord-exact', '[]', 10.00, 1000, 'pending', 'pending', ?1, ?1)",
                params![now],
            )
            .expect("insert exact-total order");
        }

        let payload = serde_json::json!({
            "orderId": "ord-exact",
            "method": "cash",
            "amount": 10.00_f64,
        });
        record_payment(&db, &payload).expect("record exact payment");

        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT payment_status FROM orders WHERE id = 'ord-exact'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            status, "paid",
            "Exact payment (total_paid == order_total) must be marked 'paid' under both current and symmetric-epsilon regimes."
        );
    }

    #[test]
    fn overpaying_by_sub_half_cent_rounds_to_outstanding_and_is_accepted() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            let now = chrono::Utc::now().to_rfc3339();
            // W4e Step 0: dual-populate (10.00 → 1000).
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
                 VALUES ('ord-half-cent-over', '[]', 10.00, 1000, 'pending', 'pending', ?1, ?1)",
                params![now],
            )
            .expect("insert overpay order");
        }

        // W4e: under the previous f64 + MONEY_EPSILON regime this test
        // used `10.005` (exactly half a cent over) as the boundary.
        // Integer cents is exact: `Cents::round_half_even(10.005)` is
        // sensitive to IEEE-754 representation drift (10.005 is stored
        // slightly above 10.005, so it rounds up to 1001, NOT down to
        // 1000 as the abstract "ties to even" rule would suggest).
        // Use 10.004 instead — unambiguously below 1000.5 cents,
        // rounds to 1000, comparison `1000 > 1000` is false, accepted.
        // Semantic preserved: sub-half-cent overpayments are absorbed
        // by the rounding boundary.
        let payload = serde_json::json!({
            "orderId": "ord-half-cent-over",
            "method": "cash",
            "amount": 10.004_f64,
        });
        let result = record_payment(&db, &payload);
        assert!(
            result.is_ok(),
            "Sub-half-cent overpayment (rounds to outstanding) must be accepted. Got: {:?}",
            result
        );
    }

    // ----------------------------------------------------------------------
    // Wave 6 C8/H13 — derive_payment_method
    // ----------------------------------------------------------------------

    fn seed_order_with_payments(
        conn: &Connection,
        order_id: &str,
        payments: &[(&str, &str, f64, &str)], // (payment_id, method, amount, status)
    ) {
        // W4e Step 0: dual-populate (10.00 → 1000; payment amount → cents via helper).
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES (?1, '[]', 10.00, 1000, 'pending', 'pending', datetime('now'), datetime('now'))",
            params![order_id],
        )
        .expect("seed order");
        for (pid, method, amount, status) in payments {
            let amount_cents = Cents::round_half_even(*amount).as_i64();
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, sync_status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', datetime('now'), datetime('now'))",
                params![pid, order_id, method, amount, amount_cents, status],
            )
            .expect("seed payment");
        }
    }

    #[test]
    fn derive_payment_method_none_when_no_payments() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order_with_payments(&conn, "ord-dpm-empty", &[]);
        let result = derive_payment_method(&conn, "ord-dpm-empty").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn derive_payment_method_single_completed_returns_that_method() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order_with_payments(
            &conn,
            "ord-dpm-single",
            &[("p1", "cash", 10.00, "completed")],
        );
        let result = derive_payment_method(&conn, "ord-dpm-single").unwrap();
        assert_eq!(result.as_deref(), Some("cash"));
    }

    #[test]
    fn derive_payment_method_ignores_voided_rows() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order_with_payments(
            &conn,
            "ord-dpm-voided",
            &[
                ("p1", "cash", 10.00, "voided"),
                ("p2", "card", 10.00, "completed"),
            ],
        );
        let result = derive_payment_method(&conn, "ord-dpm-voided").unwrap();
        assert_eq!(
            result.as_deref(),
            Some("card"),
            "voided rows must be ignored; only the single completed row counts"
        );
    }

    #[test]
    fn derive_payment_method_multi_method_returns_split() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order_with_payments(
            &conn,
            "ord-dpm-multi",
            &[
                ("p1", "cash", 5.00, "completed"),
                ("p2", "card", 5.00, "completed"),
            ],
        );
        let result = derive_payment_method(&conn, "ord-dpm-multi").unwrap();
        assert_eq!(result.as_deref(), Some("split"));
    }

    #[test]
    fn derive_payment_method_multi_row_same_method_returns_single_method() {
        // Edit top-ups can produce multiple completed rows using the same
        // method. They should still present as that method, not as a split
        // payment, because no mixed tender was used.
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order_with_payments(
            &conn,
            "ord-dpm-double-cash",
            &[
                ("p1", "cash", 5.00, "completed"),
                ("p2", "cash", 5.00, "completed"),
            ],
        );
        let result = derive_payment_method(&conn, "ord-dpm-double-cash").unwrap();
        assert_eq!(result.as_deref(), Some("cash"));
    }

    #[test]
    fn collect_outstanding_cash_uses_authoritative_balance_and_returns_post_insert_snapshot() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, items, total_amount, total_amount_cents, status, sync_status,
                    payment_status, created_at, updated_at
                 ) VALUES (
                    'ord-collect-outstanding', '[]', 42.50, 4250, 'pending', 'pending',
                    'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .expect("seed unpaid order");
        }

        let result = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-collect-outstanding",
                "method": "cash",
                "amount": 1.00,
                "cashReceived": 50.00,
                "changeGiven": 49.00,
                "collectOutstandingBalance": true,
            }),
        )
        .expect("collect the current outstanding balance");

        assert_eq!(result["success"], true);
        assert_eq!(result["orderId"], "ord-collect-outstanding");
        assert_eq!(result["method"], "cash");
        assert_eq!(result["amount"], 42.50);
        assert_eq!(result["settlement"]["orderTotal"], 42.50);
        assert_eq!(result["settlement"]["netPaid"], 42.50);
        assert_eq!(result["settlement"]["outstandingAmount"], 0.0);
        assert_eq!(
            result["settlement"]["completedPayments"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );

        let conn = db.conn.lock().unwrap();
        let (amount, cash_received, change_given): (f64, f64, f64) = conn
            .query_row(
                "SELECT amount, cash_received, change_given
                 FROM order_payments
                 WHERE order_id = 'ord-collect-outstanding'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("load recorded tender values");
        assert_eq!((amount, cash_received, change_given), (42.50, 50.00, 7.50));
    }

    #[test]
    fn collect_outstanding_cash_rejects_tender_below_authoritative_balance() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, items, total_amount, total_amount_cents, status, sync_status,
                    payment_status, created_at, updated_at
                 ) VALUES (
                    'ord-collect-insufficient', '[]', 42.50, 4250, 'pending', 'pending',
                    'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .expect("seed unpaid order");
        }

        let error = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-collect-insufficient",
                "method": "cash",
                "amount": 1.00,
                "cashReceived": 40.00,
                "collectOutstandingBalance": true,
            }),
        )
        .expect_err("cash tender below the live balance must fail");

        assert_eq!(
            error,
            "Cash received 40.00 is below outstanding balance 42.50"
        );
        let conn = db.conn.lock().unwrap();
        let payment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM order_payments WHERE order_id = 'ord-collect-insufficient'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment_count, 0);
    }

    #[test]
    fn collect_outstanding_card_uses_the_authoritative_remaining_partial_balance() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            seed_order_with_payments(
                &conn,
                "ord-collect-partial-card",
                &[("existing-partial", "cash", 4.00, "completed")],
            );
        }

        let result = record_payment(
            &db,
            &serde_json::json!({
                "orderId": "ord-collect-partial-card",
                "method": "card",
                "amount": 6.00,
                "collectOutstandingBalance": true,
            }),
        )
        .expect("collect the remaining partial balance");

        assert_eq!(result["success"], true);
        assert_eq!(result["amount"], 6.00);
        assert_eq!(result["method"], "card");
        assert_eq!(result["settlement"]["netPaid"], 10.00);
        assert_eq!(result["settlement"]["outstandingAmount"], 0.00);
        assert_eq!(
            result["settlement"]["completedPayments"]
                .as_array()
                .map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn authoritative_collection_rolls_back_when_ledger_generation_changed() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, items, total_amount, total_amount_cents, status, sync_status,
                    payment_status, created_at, updated_at
                 ) VALUES (
                    'ord-collect-generation-change', '[]', 42.50, 4250, 'pending', 'pending',
                    'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .expect("seed changed-generation order");
        }

        let error = record_payment_with_expected_balance(
            &db,
            &serde_json::json!({
                "orderId": "ord-collect-generation-change",
                "method": "cash",
                "amount": 40.00,
                "cashReceived": 50.00,
                "collectOutstandingBalance": true,
            }),
            Some(OrderPaymentBalanceSnapshot {
                order_total: 40.00,
                net_paid: 0.00,
                outstanding_amount: 40.00,
                completed_payment_count: 0,
                ledger_generation: [0; 32],
            }),
        )
        .expect_err("changed native ledger generation must fail closed");

        assert!(error.contains("Outstanding balance changed during payment collection"));
        let conn = db.conn.lock().unwrap();
        let payment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM order_payments WHERE order_id = 'ord-collect-generation-change'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment_count, 0);
    }

    #[test]
    fn balance_snapshot_generation_changes_for_equal_value_ledger_replacement() {
        let db = test_db();
        let first = {
            let conn = db.conn.lock().unwrap();
            seed_order_with_payments(
                &conn,
                "ord-ledger-fingerprint",
                &[("payment-original", "cash", 4.00, "completed")],
            );
            load_order_payment_balance_snapshot(&conn, "ord-ledger-fingerprint")
                .expect("load first ledger generation")
        };
        let second = {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE order_payments
                 SET id = 'payment-replacement', updated_at = '2026-08-13T12:00:00Z'
                 WHERE id = 'payment-original'",
                [],
            )
            .expect("replace payment identity without changing balance");
            load_order_payment_balance_snapshot(&conn, "ord-ledger-fingerprint")
                .expect("load replacement ledger generation")
        };

        assert_eq!(first.order_total, second.order_total);
        assert_eq!(first.net_paid, second.net_paid);
        assert_eq!(first.outstanding_amount, second.outstanding_amount);
        assert_eq!(
            first.completed_payment_count,
            second.completed_payment_count
        );
        assert_ne!(first.ledger_generation, second.ledger_generation);
    }

    #[test]
    fn settlement_generation_ignores_sync_only_timestamp_updates() {
        let db = test_db();
        let first = {
            let conn = db.conn.lock().unwrap();
            seed_order_with_payments(
                &conn,
                "ord-ledger-sync-only",
                &[("payment-sync-only", "cash", 4.00, "completed")],
            );
            load_order_payment_balance_snapshot(&conn, "ord-ledger-sync-only")
                .expect("load initial settlement generation")
        };
        let second = {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE order_payments
                 SET sync_status = 'synced', updated_at = '2026-08-13T12:00:00Z'
                 WHERE id = 'payment-sync-only'",
                [],
            )
            .expect("apply sync-only metadata update");
            load_order_payment_balance_snapshot(&conn, "ord-ledger-sync-only")
                .expect("load generation after sync-only update")
        };

        assert_eq!(first.ledger_generation, second.ledger_generation);
    }

    #[test]
    fn settlement_snapshot_reports_completed_rows_and_net_refunds_together() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, items, total_amount, total_amount_cents, status, sync_status,
                    payment_status, created_at, updated_at
                 ) VALUES (
                    'ord-settlement-snapshot', '[]', 20.00, 2000, 'pending', 'pending',
                    'partially_paid', datetime('now'), datetime('now')
                 )",
                [],
            )
            .expect("seed snapshot order");
            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, amount_cents, status, sync_status,
                    created_at, updated_at
                 ) VALUES (
                    'pay-settlement-snapshot', 'ord-settlement-snapshot', 'cash',
                    12.00, 1200, 'completed', 'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .expect("seed completed payment");
            conn.execute(
                "INSERT INTO payment_adjustments (
                    id, payment_id, order_id, adjustment_type, amount, amount_cents,
                    reason, created_at, updated_at
                 ) VALUES (
                    'refund-settlement-snapshot', 'pay-settlement-snapshot',
                    'ord-settlement-snapshot', 'refund', 2.00, 200,
                    'test refund', datetime('now'), datetime('now')
                 )",
                [],
            )
            .expect("seed refund adjustment");
        }

        let snapshot = get_order_settlement_snapshot(&db, "ord-settlement-snapshot")
            .expect("load atomic settlement snapshot");

        assert_eq!(snapshot["success"], true);
        assert_eq!(snapshot["orderId"], "ord-settlement-snapshot");
        assert_eq!(snapshot["orderTotal"], 20.00);
        assert_eq!(snapshot["netPaid"], 10.00);
        assert_eq!(snapshot["outstandingAmount"], 10.00);
        assert_eq!(
            snapshot["generation"].as_str().map(str::len),
            Some(64),
            "settlement generation is an opaque full SHA-256 token"
        );
        let completed = snapshot["completedPayments"]
            .as_array()
            .expect("completed payment rows");
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0]["id"], "pay-settlement-snapshot");
        assert_eq!(completed[0]["method"], "cash");
        assert_eq!(completed[0]["amount"], 12.00);
        assert_eq!(completed[0]["refundedAmount"], 2.00);
        assert_eq!(completed[0]["remainingRefundable"], 10.00);
    }

    #[test]
    fn test_platform_settlement_kind_reads_the_order_disposition() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        let insert = |id: &str, plugin: &str, metadata: &str| {
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, plugin, external_plugin_order_id, ghost_metadata, created_at, updated_at)
                 VALUES (?1, '[]', 5.9, 590, 'in_transit', 'pending', ?2, 'ext-1', ?3, datetime('now'), datetime('now'))",
                params![id, plugin, metadata],
            )
            .unwrap();
        };

        // COD carried by the platform's own rider: the platform banks it.
        insert(
            "ord-plat-cod",
            "efood",
            r#"{"food_delivery":{"payment_method":"cash","prepaid":false,"delivery_provider":"platform_delivery","short_code":"42"}}"#,
        );
        assert_eq!(
            platform_settlement_kind(&conn, "ord-plat-cod"),
            Some(PlatformSettlementKind::PlatformCollectedCod)
        );

        // Prepaid online platform order.
        insert(
            "ord-plat-online",
            "efood",
            r#"{"food_delivery":{"payment_method":"online","prepaid":true}}"#,
        );
        assert_eq!(
            platform_settlement_kind(&conn, "ord-plat-online"),
            Some(PlatformSettlementKind::PrepaidOnline)
        );

        // COD carried by the STORE's driver: real cash enters the drawer, the
        // operator must collect it — no auto settlement.
        insert(
            "ord-store-cod",
            "efood",
            r#"{"food_delivery":{"payment_method":"cash","prepaid":false,"delivery_provider":"restaurant_delivery"}}"#,
        );
        assert_eq!(platform_settlement_kind(&conn, "ord-store-cod"), None);

        // Non-platform order: metadata never consulted.
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES ('ord-local', '[]', 5.9, 590, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        assert_eq!(platform_settlement_kind(&conn, "ord-local"), None);
    }

    #[test]
    fn test_platform_settlement_kind_classifies_metadata_only_legacy_rows() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Legacy terminals: the realtime ingest read the broadcast's `plugin`
        // field (the server sends `platform`) and pre-v75 databases had no
        // external_plugin_order_id column — platform orders arrived with BOTH
        // identity columns empty. The aggregator metadata alone must classify
        // them, or THE-437 never settles (Το Μικρό Παρίσι, 31/08/2026).
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, ghost_metadata, created_at, updated_at)
             VALUES ('ord-anon-platform', '[]', 12.1, 1210, 'ready', 'pending',
                     '{\"food_delivery\":{\"payment_method\":\"online\",\"prepaid\":true,\"delivery_provider\":\"platform_delivery\"}}',
                     datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        assert_eq!(
            platform_settlement_kind(&conn, "ord-anon-platform"),
            Some(PlatformSettlementKind::PrepaidOnline)
        );

        // Same anonymity, platform-rider COD.
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, ghost_metadata, created_at, updated_at)
             VALUES ('ord-anon-cod', '[]', 8.7, 870, 'ready', 'pending',
                     '{\"food_delivery\":{\"payment_method\":\"cash\",\"prepaid\":false,\"delivery_provider\":\"platform_delivery\"}}',
                     datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        assert_eq!(
            platform_settlement_kind(&conn, "ord-anon-cod"),
            Some(PlatformSettlementKind::PlatformCollectedCod)
        );
    }

    #[test]
    fn test_platform_auto_settlement_books_bank_money_not_drawer_cash() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at)
             VALUES ('shift-ps', 'staff-1', 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id, opening_amount, opening_amount_cents, opened_at, created_at, updated_at)
             VALUES ('cd-ps', 'shift-ps', 'staff-1', 'b1', 't1', 100.0, 10000, datetime('now'), datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, staff_shift_id, plugin, external_plugin_order_id, ghost_metadata, created_at, updated_at)
             VALUES ('ord-ps1', '[]', 25.0, 2500, 'in_transit', 'pending', 'shift-ps', 'efood', 'ext-ps1',
                     '{\"food_delivery\":{\"payment_method\":\"cash\",\"prepaid\":false,\"delivery_provider\":\"platform_delivery\"}}',
                     datetime('now'), datetime('now'))",
            [],
        ).unwrap();

        assert!(auto_settle_platform_order(&conn, "ord-ps1").unwrap());

        // The settlement row: method 'other', tagged as platform COD.
        let (method, tx_ref, amount): (String, String, f64) = conn
            .query_row(
                "SELECT method, COALESCE(transaction_ref, ''), amount FROM order_payments WHERE order_id = 'ord-ps1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(method, "other");
        assert_eq!(tx_ref, "platform_settlement:cod:ord-ps1");
        assert!((amount - 25.0).abs() < 0.001);

        // The order is settled.
        let payment_status: String = conn
            .query_row(
                "SELECT payment_status FROM orders WHERE id = 'ord-ps1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment_status, "paid");

        // The drawer never expects this money.
        let cash_sales: f64 = conn
            .query_row(
                "SELECT COALESCE(total_cash_sales, 0) FROM cash_drawer_sessions WHERE id = 'cd-ps'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cash_sales, 0.0);

        // Fully settled: a second delivered/completed transition is a no-op.
        assert!(!auto_settle_platform_order(&conn, "ord-ps1").unwrap());
    }
}
