//! Payment management for The Small POS.
//!
//! Implements offline-first payment recording, voiding, querying, and
//! receipt preview generation. Payments are stored in `order_payments`
//! and enqueued for sync to the admin dashboard via `/api/pos/payments`.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
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
    pub cash_received: Option<f64>,
    pub change_given: Option<f64>,
    pub transaction_ref: Option<String>,
    pub discount_amount: f64,
    pub payment_origin: String,
    pub terminal_device_id: Option<String>,
    pub requested_staff_id: Option<String>,
    pub requested_staff_shift_id: Option<String>,
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
        "other" | "online" | "digital_wallet" | "digital-wallet" | "wallet" | "split" | "mixed"
        | "pending" => Some("other".to_string()),
        _ => None,
    }
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
        _ => {
            return Err(format!(
                "Invalid method: {raw_method}. Must be cash, card, or other"
            ));
        }
    };
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
        cash_received,
        change_given,
        transaction_ref,
        discount_amount,
        payment_origin,
        terminal_device_id,
        requested_staff_id: str_field(payload, "staffId")
            .or_else(|| str_field(payload, "staff_id")),
        requested_staff_shift_id: str_field(payload, "staffShiftId")
            .or_else(|| str_field(payload, "staff_shift_id")),
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
    Ok(OrderPaymentBalanceSnapshot {
        order_total,
        net_paid,
        outstanding_amount: (order_total - net_paid).max(0.0),
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
    conn.execute(
        "INSERT INTO order_payments (
            id, order_id, method, amount, amount_cents, currency, status,
            cash_received, cash_received_cents, change_given, change_given_cents,
            transaction_ref, discount_amount, discount_amount_cents,
            payment_origin, terminal_device_id,
            remote_payment_id, staff_id, staff_shift_id, sync_status,
            sync_state, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'completed', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
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
            input.payment_origin,
            input.terminal_device_id,
            options.remote_payment_id,
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
#[allow(clippy::type_complexity)]
pub fn record_payment(db: &DbState, payload: &Value) -> Result<Value, String> {
    let input = build_payment_record_input(payload)?;
    if input.method != "cash" && input.method != "card" {
        return Err("Only cash and card payments can be recorded locally".to_string());
    }
    let mut options = PaymentInsertOptions::local();
    if matches!(input.collected_by.as_deref(), Some("cashier_drawer")) {
        options.sync_order_owner_with_payment = false;
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let recorded = match record_payment_in_connection(&conn, &input, &options) {
        Ok(recorded) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
            recorded
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    };
    info!(
        payment_id = %recorded.payment_id,
        order_id = %input.order_id,
        method = %input.method,
        amount = %input.amount,
        "Payment recorded"
    );

    Ok(serde_json::json!({
        "success": true,
        "paymentId": recorded.payment_id,
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
        terminal_device_id,
        staff_id,
        staff_shift_id,
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
                    COALESCE(payment_origin, 'manual'), terminal_device_id,
                    staff_id, staff_shift_id
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
                ))
            },
        )
        .map_err(|e| format!("load payment sync payload context: {e}"))?;

    let items = load_payment_items_for_payment(conn, payment_id)?;
    // W4d-i: additive cents emission alongside legacy float keys.
    // Admin-dashboard's Zod schema currently requires `amount` (float);
    // adding `amount_cents` (integer) lets a follow-up admin update
    // switch to cents preference. 4d-cleanup later removes the float keys.
    Ok(serde_json::json!({
        "paymentId": payment_id,
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
        "items": if items.is_empty() { Value::Null } else { Value::Array(items) },
    })
    .to_string())
}

fn refresh_payment_sync_queue_entry(conn: &Connection, payment_id: &str) -> Result<(), String> {
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

pub fn update_payment_method(
    db: &DbState,
    order_id_raw: &str,
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

    type CompletedPaymentRow = (String, String, i64);
    let completed_payments = {
        let mut stmt = conn
            .prepare(
                "SELECT op.id,
                        op.method,
                        COALESCE((
                            SELECT COUNT(*)
                            FROM payment_items pi
                            WHERE pi.payment_id = op.id
                        ), 0) AS item_assignment_count
                 FROM order_payments op
                 WHERE op.order_id = ?1
                   AND op.status = 'completed'
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

    if completed_payments.is_empty() {
        if normalized_payment_status != "paid" {
            return Err(
                "Payment method can only be edited for fully paid orders when no local payment record exists"
                    .into(),
            );
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

    if completed_payments.len() != 1 {
        return Err(
            "Payment method can only be edited for orders with exactly one completed payment"
                .into(),
        );
    }

    let (payment_id, current_method, _item_assignment_count): CompletedPaymentRow =
        completed_payments[0].clone();
    if current_method == next_method {
        if payment_sync_queue_needs_retry(&conn, &payment_id)? {
            let tx = conn
                .transaction()
                .map_err(|e| format!("begin payment sync retry transaction: {e}"))?;
            refresh_payment_sync_queue_entry(&tx, &payment_id)?;
            let payment_status: String = tx
                .query_row(
                    "SELECT COALESCE(payment_status, 'pending') FROM orders WHERE id = ?1",
                    params![order_id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("reload payment status after sync retry: {e}"))?;
            tx.commit()
                .map_err(|e| format!("commit payment sync retry: {e}"))?;

            info!(
                order_id = %order_id,
                payment_id = %payment_id,
                method = %current_method,
                "Payment sync requeued without changing payment method"
            );

            return Ok(serde_json::json!({
                "success": true,
                "data": {
                    "orderId": order_id,
                    "paymentId": payment_id,
                    "paymentMethod": current_method,
                    "paymentStatus": payment_status,
                    "retriedSync": true,
                }
            }));
        }

        return Ok(serde_json::json!({
            "success": true,
            "data": {
                "orderId": order_id,
                "paymentId": payment_id,
                "paymentMethod": current_method,
                "paymentStatus": current_payment_status,
                "retriedSync": false,
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
             updated_at = ?2
         WHERE id = ?3",
        params![next_method, now, payment_id],
    )
    .map_err(|e| format!("update local payment method: {e}"))?;
    recompute_order_payment_state(&tx, &order_id, &now, &payment_id)?;
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

/// Get all payments for an order.
pub fn get_order_payments(db: &DbState, order_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

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
        .map_err(|e| e.to_string())?;

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
        .map_err(|e| e.to_string())?
        .filter_map(|row| match row {
            Ok(payment) => Some(payment),
            Err(e) => {
                warn!("skipping malformed payment row: {e}");
                None
            }
        })
        .collect();
    drop(stmt);

    let mut payments = Vec::new();
    for row in rows {
        let items = load_payment_items_for_payment(&conn, &row.0)?;
        let remaining_refundable = ((row.3 - row.20).max(0.0) * 100.0).round() / 100.0;
        payments.push(serde_json::json!({
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
        }));
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
}
