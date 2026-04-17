use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::Value;
use tauri::Emitter;

use crate::{
    can_transition_locally, db, fetch_supabase_rows, normalize_status_for_storage, order_ownership,
    payload_arg0_as_string, payment_integrity, payments, print, read_local_json_array, refunds,
    resolve_order_id, storage, sync, value_f64, value_i64, value_str, write_local_json,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderUpdateStatusPayload {
    #[serde(alias = "order_id")]
    #[serde(alias = "id")]
    #[serde(alias = "supabaseId")]
    #[serde(alias = "supabase_id")]
    order_id: String,
    status: String,
    #[serde(default, alias = "estimated_time")]
    estimated_time: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderUpdateItemsRawPayload {
    #[serde(alias = "order_id")]
    #[serde(alias = "id")]
    #[serde(alias = "supabaseId")]
    #[serde(alias = "supabase_id")]
    order_id: String,
    #[serde(default)]
    items: Vec<serde_json::Value>,
    #[serde(
        default,
        alias = "order_notes",
        alias = "notes",
        alias = "special_instructions"
    )]
    order_notes: Option<serde_json::Value>,
}

#[derive(Debug)]
struct OrderUpdateItemsPayload {
    order_id: String,
    items: Vec<serde_json::Value>,
    order_notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderUpdateFinancialsPayload {
    #[serde(alias = "order_id")]
    #[serde(alias = "id")]
    #[serde(alias = "supabaseId")]
    #[serde(alias = "supabase_id")]
    order_id: String,
    #[serde(alias = "total_amount")]
    total_amount: f64,
    #[serde(default)]
    subtotal: Option<f64>,
    #[serde(default, alias = "discount_amount")]
    discount_amount: Option<f64>,
    #[serde(default, alias = "discount_percentage")]
    discount_percentage: Option<f64>,
    #[serde(default, alias = "tax_amount")]
    tax_amount: Option<f64>,
    #[serde(default, alias = "delivery_fee")]
    delivery_fee: Option<f64>,
    #[serde(default, alias = "tip_amount")]
    tip_amount: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderUpdateCustomerInfoPayload {
    #[serde(alias = "order_id")]
    #[serde(alias = "id")]
    #[serde(alias = "supabaseId")]
    #[serde(alias = "supabase_id")]
    order_id: String,
    #[serde(alias = "customer_name")]
    customer_name: String,
    #[serde(default, alias = "customer_email")]
    customer_email: Option<String>,
    #[serde(alias = "customer_phone")]
    customer_phone: String,
    #[serde(alias = "delivery_address")]
    #[serde(alias = "address")]
    delivery_address: String,
    #[serde(default, alias = "delivery_postal_code")]
    #[serde(alias = "postal_code")]
    #[serde(alias = "postalCode")]
    delivery_postal_code: Option<String>,
    #[serde(default, alias = "delivery_notes")]
    #[serde(alias = "notes")]
    delivery_notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickupToDeliveryConversionPayload {
    #[serde(alias = "order_id")]
    #[serde(alias = "id")]
    #[serde(alias = "supabaseId")]
    #[serde(alias = "supabase_id")]
    order_id: String,
    #[serde(default, alias = "customer_id")]
    customer_id: Option<String>,
    #[serde(alias = "customer_name")]
    customer_name: String,
    #[serde(alias = "customer_phone")]
    customer_phone: String,
    #[serde(default, alias = "customer_email")]
    customer_email: Option<String>,
    #[serde(alias = "delivery_address")]
    delivery_address: String,
    #[serde(default, alias = "delivery_city")]
    delivery_city: Option<String>,
    #[serde(default, alias = "delivery_postal_code")]
    #[serde(alias = "postal_code")]
    #[serde(alias = "postalCode")]
    delivery_postal_code: Option<String>,
    #[serde(default, alias = "delivery_floor")]
    delivery_floor: Option<String>,
    #[serde(default, alias = "delivery_notes")]
    #[serde(alias = "notes")]
    delivery_notes: Option<String>,
    #[serde(default, alias = "name_on_ringer")]
    name_on_ringer: Option<String>,
    #[serde(alias = "delivery_fee")]
    delivery_fee: f64,
    #[serde(alias = "total_amount")]
    total_amount: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderDeletePayload {
    #[serde(alias = "order_id")]
    #[serde(alias = "id")]
    #[serde(alias = "supabaseId")]
    #[serde(alias = "supabase_id")]
    order_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderEditSettlementRawPayload {
    #[serde(alias = "order_id")]
    #[serde(alias = "id")]
    #[serde(alias = "supabaseId")]
    #[serde(alias = "supabase_id")]
    order_id: String,
    #[serde(default)]
    items: Vec<serde_json::Value>,
    #[serde(
        default,
        alias = "order_notes",
        alias = "notes",
        alias = "special_instructions"
    )]
    order_notes: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditSettlementPaymentPayload {
    method: String,
    amount: f64,
    #[serde(default, alias = "discount_amount")]
    discount_amount: Option<f64>,
    #[serde(default, alias = "cash_received")]
    cash_received: Option<f64>,
    #[serde(default, alias = "change_given")]
    change_given: Option<f64>,
    #[serde(default, alias = "transaction_ref")]
    transaction_ref: Option<String>,
    #[serde(default, alias = "payment_origin")]
    payment_origin: Option<String>,
    #[serde(default, alias = "terminal_device_id")]
    terminal_device_id: Option<String>,
    #[serde(default, alias = "terminal_approved")]
    terminal_approved: Option<bool>,
    #[serde(default, alias = "staff_id")]
    staff_id: Option<String>,
    #[serde(default, alias = "staff_shift_id")]
    staff_shift_id: Option<String>,
    #[serde(default, alias = "collected_by")]
    collected_by: Option<String>,
    #[serde(default)]
    items: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditSettlementRefundPayload {
    #[serde(alias = "payment_id")]
    payment_id: String,
    amount: f64,
    reason: String,
    #[serde(default, alias = "refund_method")]
    refund_method: Option<String>,
    #[serde(default, alias = "cash_handler")]
    cash_handler: Option<String>,
    #[serde(default, alias = "staff_id")]
    staff_id: Option<String>,
    #[serde(default, alias = "staff_shift_id")]
    staff_shift_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum EditSettlementActionPayload {
    None,
    MarkPartial,
    Collect {
        #[serde(default)]
        payments: Vec<EditSettlementPaymentPayload>,
    },
    Refund {
        #[serde(default)]
        refunds: Vec<EditSettlementRefundPayload>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderEditSettlementApplyRawPayload {
    #[serde(flatten)]
    _order: OrderEditSettlementRawPayload,
    action: EditSettlementActionPayload,
}

#[derive(Debug)]
struct OrderEditSettlementPayload {
    order_id: String,
    items: Vec<serde_json::Value>,
    order_notes: Option<String>,
}

fn parse_order_update_status_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
) -> Result<OrderUpdateStatusPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Object(mut obj)) => {
            if obj.get("status").is_none() {
                if let Some(status) = arg1 {
                    obj.insert("status".to_string(), serde_json::Value::String(status));
                }
            }
            serde_json::Value::Object(obj)
        }
        Some(serde_json::Value::String(order_id)) => {
            serde_json::json!({ "orderId": order_id, "status": arg1 })
        }
        Some(v) => v,
        None => serde_json::json!({ "status": arg1 }),
    };
    let mut parsed: OrderUpdateStatusPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid order status payload: {e}"))?;
    parsed.order_id = parsed.order_id.trim().to_string();
    parsed.status = parsed.status.trim().to_string();
    if parsed.order_id.is_empty() {
        return Err("Missing orderId".into());
    }
    if parsed.status.is_empty() {
        return Err("Missing status".into());
    }
    Ok(parsed)
}

fn load_canonical_order_status(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<String, String> {
    conn.query_row(
        "SELECT COALESCE(status, 'pending') FROM orders WHERE id = ?1",
        rusqlite::params![order_id],
        |row| row.get::<_, String>(0),
    )
    .map(|status| normalize_status_for_storage(&status))
    .map_err(|e| format!("load order status: {e}"))
}

fn ensure_order_status_transition_allowed(
    conn: &rusqlite::Connection,
    order_id: &str,
    next_status: &str,
) -> Result<String, String> {
    let previous_status = load_canonical_order_status(conn, order_id)?;
    let next_status = normalize_status_for_storage(next_status);

    if can_transition_locally(&previous_status, &next_status) {
        Ok(previous_status)
    } else {
        Err(format!(
            "Invalid status transition: {previous_status} -> {next_status}"
        ))
    }
}

fn status_requires_payment_integrity_guard(next_status: &str) -> bool {
    matches!(
        normalize_status_for_storage(next_status).as_str(),
        "completed" | "delivered"
    )
}

#[cfg(test)]
fn is_invalid_status_transition_failure_message(message: &str) -> bool {
    message
        .to_ascii_lowercase()
        .contains("invalid status transition")
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ForceOrderSyncRetryResult {
    updated: usize,
    inserted_fallback: bool,
    blocked_by_invalid_transition: bool,
}

fn force_order_sync_retry_inner(
    db: &db::DbState,
    order_id: &str,
) -> Result<ForceOrderSyncRetryResult, String> {
    sync::cleanup_order_update_queue_rows_for_order(db, Some(order_id))?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, status, lower(COALESCE(error_message, ''))
             FROM parity_sync_queue
             WHERE table_name = 'orders'
               AND record_id = ?1
               AND operation = 'UPDATE'",
        )
        .map_err(|e| format!("prepare parity order retry query: {e}"))?;
    let queue_rows = stmt
        .query_map(rusqlite::params![order_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("query parity order retry rows: {e}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    drop(stmt);

    let blocked_by_invalid_transition = queue_rows.iter().any(|(_, status, error_message)| {
        status == "failed" && error_message.contains("invalid status transition")
    });

    let mut updated = 0usize;
    for (item_id, status, error_message) in &queue_rows {
        if !matches!(
            status.as_str(),
            "pending" | "processing" | "failed" | "conflict"
        ) {
            continue;
        }
        if status == "failed" && error_message.contains("invalid status transition") {
            continue;
        }
        crate::sync_queue::retry_item(&conn, item_id)?;
        updated += 1;
    }

    let mut inserted_fallback = false;
    if updated == 0 && !blocked_by_invalid_transition {
        let current_status = load_canonical_order_status(&conn, order_id)?;
        if !can_transition_locally(&current_status, &current_status) {
            return Err(format!(
                "Current order status is not eligible for retry: {current_status}"
            ));
        }

        let fallback_payload = serde_json::json!({
            "orderId": order_id,
            "status": current_status
        });
        enqueue_order_sync_payload(&conn, order_id, &fallback_payload)
            .map_err(|e| format!("insert fallback parity order retry: {e}"))?;
        inserted_fallback = true;
    }

    Ok(ForceOrderSyncRetryResult {
        updated,
        inserted_fallback,
        blocked_by_invalid_transition,
    })
}

fn enqueue_or_refresh_driver_earning_sync_row(
    conn: &rusqlite::Connection,
    earning_id: &str,
    payload: &Value,
    now: &str,
) -> Result<(), String> {
    crate::sync_queue::clear_unsynced_items(conn, "driver_earnings", earning_id)?;
    crate::sync_queue::enqueue_payload_item(
        conn,
        "driver_earnings",
        earning_id,
        "INSERT",
        payload,
        Some(1),
        Some("financial"),
        Some("manual"),
        Some(1),
    )
    .map_err(|e| format!("enqueue driver earning parity row: {e}"))?;

    let _ = now;

    Ok(())
}

fn enqueue_order_sync_payload(
    conn: &rusqlite::Connection,
    order_id: &str,
    payload: &Value,
) -> Result<(), String> {
    crate::sync_queue::enqueue_payload_item(
        conn,
        "orders",
        order_id,
        "UPDATE",
        payload,
        Some(0),
        Some("orders"),
        Some("server-wins"),
        Some(1),
    )
    .map(|_| ())
}

fn merge_order_update_items_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> serde_json::Value {
    match (arg0, arg1) {
        // Common invoke shape from typed bridge: (orderId, items[])
        (Some(serde_json::Value::String(order_id)), Some(serde_json::Value::Array(items))) => {
            serde_json::json!({
                "orderId": order_id,
                "items": items
            })
        }
        // Alternate invoke shape: (orderId, { items, orderNotes? })
        (Some(serde_json::Value::String(order_id)), Some(serde_json::Value::Object(mut extra))) => {
            extra.insert("orderId".to_string(), serde_json::Value::String(order_id));
            serde_json::Value::Object(extra)
        }
        // If arg0 is object and arg1 is array, treat arg1 as items override
        (Some(serde_json::Value::Object(mut base)), Some(serde_json::Value::Array(items))) => {
            base.insert("items".to_string(), serde_json::Value::Array(items));
            serde_json::Value::Object(base)
        }
        // Generic object/object merge
        (Some(serde_json::Value::Object(mut base)), Some(serde_json::Value::Object(extra))) => {
            for (k, v) in extra {
                base.insert(k, v);
            }
            serde_json::Value::Object(base)
        }
        (Some(v), None) => v,
        (None, Some(v)) => v,
        _ => serde_json::json!({}),
    }
}

fn parse_order_update_items_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<OrderUpdateItemsPayload, String> {
    let payload = merge_order_update_items_payload(arg0, arg1);
    if let Some(items) = payload.get("items") {
        if !items.is_array() {
            return Err("items must be an array".into());
        }
    }
    let raw: OrderUpdateItemsRawPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid order update payload: {e}"))?;
    let order_id = raw.order_id.trim().to_string();
    if order_id.is_empty() {
        return Err("Missing orderId".into());
    }
    let order_notes = raw
        .order_notes
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(OrderUpdateItemsPayload {
        order_id,
        items: raw.items,
        order_notes,
    })
}

fn parse_order_edit_settlement_payload_value(
    payload: serde_json::Value,
) -> Result<OrderEditSettlementPayload, String> {
    if let Some(items) = payload.get("items") {
        if !items.is_array() {
            return Err("items must be an array".into());
        }
    }
    let raw: OrderEditSettlementRawPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid edit settlement payload: {e}"))?;
    let order_id = raw.order_id.trim().to_string();
    if order_id.is_empty() {
        return Err("Missing orderId".into());
    }
    let order_notes = raw
        .order_notes
        .and_then(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|value| !value.is_empty());
    Ok(OrderEditSettlementPayload {
        order_id,
        items: raw.items,
        order_notes,
    })
}

fn parse_order_edit_settlement_preview_payload(
    arg0: Option<serde_json::Value>,
) -> Result<OrderEditSettlementPayload, String> {
    parse_order_edit_settlement_payload_value(arg0.unwrap_or_else(|| serde_json::json!({})))
}

fn parse_order_edit_settlement_apply_payload(
    arg0: Option<serde_json::Value>,
) -> Result<(OrderEditSettlementPayload, EditSettlementActionPayload), String> {
    let payload = arg0.unwrap_or_else(|| serde_json::json!({}));
    let raw: OrderEditSettlementApplyRawPayload = serde_json::from_value(payload.clone())
        .map_err(|e| format!("Invalid edit settlement apply payload: {e}"))?;
    let parsed = parse_order_edit_settlement_payload_value(payload)?;
    Ok((parsed, raw.action))
}

fn parse_order_delete_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
) -> Result<OrderDeletePayload, String> {
    let order_id = payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .or(arg1)
    .ok_or("Missing orderId")?;
    let mut payload: OrderDeletePayload = serde_json::from_value(serde_json::json!({
        "orderId": order_id
    }))
    .map_err(|e| format!("Invalid order delete payload: {e}"))?;
    payload.order_id = payload.order_id.trim().to_string();
    if payload.order_id.is_empty() {
        return Err("Missing orderId".into());
    }
    Ok(payload)
}

fn parse_order_update_financials_payload(
    arg0: Option<serde_json::Value>,
) -> Result<OrderUpdateFinancialsPayload, String> {
    let payload = arg0.unwrap_or_else(|| serde_json::json!({}));
    let mut parsed: OrderUpdateFinancialsPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid order financials payload: {e}"))?;
    parsed.order_id = parsed.order_id.trim().to_string();
    if parsed.order_id.is_empty() {
        return Err("Missing orderId".into());
    }
    if !parsed.total_amount.is_finite() || parsed.total_amount < 0.0 {
        return Err("totalAmount must be a non-negative number".into());
    }
    Ok(parsed)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}

fn compute_order_items_total(items: &[serde_json::Value]) -> f64 {
    items
        .iter()
        .map(|item| {
            let qty = value_f64(item, &["quantity"]).unwrap_or(1.0);
            if let Some(tp) = value_f64(item, &["total_price", "totalPrice"]) {
                tp
            } else {
                value_f64(item, &["unit_price", "unitPrice", "price"]).unwrap_or(0.0) * qty
            }
        })
        .sum::<f64>()
}

fn derive_next_order_totals(
    conn: &rusqlite::Connection,
    order_id: &str,
    next_items: &[serde_json::Value],
) -> Result<(f64, f64), String> {
    let (current_total, current_subtotal, current_items_json): (f64, f64, String) = conn
        .query_row(
            "SELECT
                COALESCE(total_amount, 0),
                COALESCE(subtotal, COALESCE(total_amount, 0)),
                COALESCE(items, '[]')
             FROM orders
             WHERE id = ?1",
            rusqlite::params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| format!("load order edit totals: {e}"))?;

    let current_items: Vec<serde_json::Value> =
        serde_json::from_str(&current_items_json).unwrap_or_default();
    let current_items_total = compute_order_items_total(&current_items);
    let next_items_total = compute_order_items_total(next_items);

    let total_offset = current_total - current_items_total;
    let subtotal_offset = current_subtotal - current_items_total;

    Ok((
        (next_items_total + total_offset).max(0.0),
        (next_items_total + subtotal_offset).max(0.0),
    ))
}

fn update_order_items_in_connection(
    conn: &rusqlite::Connection,
    order_id: &str,
    items: &[serde_json::Value],
    order_notes: Option<&str>,
    total_amount: f64,
    subtotal_amount: f64,
    now: &str,
) -> Result<(), String> {
    let items_json = serde_json::to_string(items).map_err(|e| format!("serialize items: {e}"))?;
    if let Some(notes) = order_notes {
        conn.execute(
            "UPDATE orders
             SET items = ?1,
                 total_amount = ?2,
                 subtotal = ?3,
                 special_instructions = ?4,
                 sync_status = 'pending',
                 updated_at = ?5
             WHERE id = ?6",
            rusqlite::params![
                items_json,
                total_amount,
                subtotal_amount,
                notes,
                now,
                order_id
            ],
        )
        .map_err(|e| format!("update order items: {e}"))?;
    } else {
        conn.execute(
            "UPDATE orders
             SET items = ?1,
                 total_amount = ?2,
                 subtotal = ?3,
                 sync_status = 'pending',
                 updated_at = ?4
             WHERE id = ?5",
            rusqlite::params![items_json, total_amount, subtotal_amount, now, order_id],
        )
        .map_err(|e| format!("update order items: {e}"))?;
    }

    Ok(())
}

fn net_paid_amount_from_edit_payment(payment: &serde_json::Value) -> f64 {
    payment
        .get("remainingRefundable")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or_else(|| {
            let gross = payment
                .get("amount")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let refunded = payment
                .get("refundedAmount")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            (gross - refunded).max(0.0)
        })
}

fn load_net_paid_for_order(conn: &rusqlite::Connection, order_id: &str) -> Result<f64, String> {
    payments::load_net_paid_for_order(conn, order_id)
}

fn determine_edit_settlement_required_action(paid_total: f64, next_total: f64) -> &'static str {
    if paid_total + 0.01 < next_total {
        "collect"
    } else if paid_total > next_total + 0.01 {
        "refund"
    } else {
        "none"
    }
}

fn resolve_stale_unsynced_overpay_payments_for_order(
    conn: &rusqlite::Connection,
    order_id: &str,
    resolved_at: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT op.id
             FROM order_payments op
             WHERE op.order_id = ?1
               AND op.status = 'completed'
               AND NULLIF(TRIM(COALESCE(op.remote_payment_id, '')), '') IS NULL
               AND (
                    COALESCE(op.sync_status, '') != 'synced'
                    OR COALESCE(op.sync_state, '') != 'applied'
               )
             ORDER BY COALESCE(op.updated_at, op.created_at, '') DESC, op.id DESC",
        )
        .map_err(|e| format!("prepare stale payment cleanup query: {e}"))?;

    let payment_ids: Vec<String> = stmt
        .query_map(rusqlite::params![order_id], |row| row.get(0))
        .map_err(|e| format!("query stale payment cleanup candidates: {e}"))?
        .filter_map(|row| row.ok())
        .collect();
    drop(stmt);

    let mut resolved_ids = Vec::new();
    for payment_id in payment_ids {
        if sync::resolve_stale_local_payment_total_conflict_with_conn(
            conn,
            &payment_id,
            resolved_at,
        )?
        .is_some()
        {
            resolved_ids.push(payment_id);
        }
    }

    Ok(resolved_ids)
}

fn refresh_order_payment_snapshot(
    conn: &rusqlite::Connection,
    order_id: &str,
    now: &str,
) -> Result<(String, String, f64), String> {
    let (order_total, current_payment_method): (f64, String) = conn
        .query_row(
            "SELECT COALESCE(total_amount, 0), COALESCE(payment_method, 'pending')
             FROM orders
             WHERE id = ?1",
            rusqlite::params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("load order payment snapshot: {e}"))?;

    let total_paid = load_net_paid_for_order(conn, order_id)?;

    let completed_payment_count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM order_payments
             WHERE order_id = ?1
               AND status = 'completed'",
            rusqlite::params![order_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let has_item_assignments = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM payment_items pi
                INNER JOIN order_payments op ON op.id = pi.payment_id
                WHERE op.order_id = ?1
                  AND op.status = 'completed'
            )",
            rusqlite::params![order_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        == 1;

    let last_completed_method = conn
        .query_row(
            "SELECT method
             FROM order_payments
             WHERE order_id = ?1
               AND status = 'completed'
             ORDER BY created_at DESC, updated_at DESC
             LIMIT 1",
            rusqlite::params![order_id],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .unwrap_or_else(|| current_payment_method.clone());

    let next_payment_status = if total_paid >= order_total - 0.01 {
        if total_paid > 0.009 {
            "paid".to_string()
        } else {
            "pending".to_string()
        }
    } else if total_paid > 0.009 {
        "partially_paid".to_string()
    } else {
        "pending".to_string()
    };

    let normalized_current_method = current_payment_method.trim().to_ascii_lowercase();
    let next_payment_method = if total_paid <= 0.009 {
        "pending".to_string()
    } else if next_payment_status == "partially_paid"
        || has_item_assignments
        || completed_payment_count > 1
        || matches!(
            normalized_current_method.as_str(),
            "pending" | "split" | "mixed"
        )
    {
        "split".to_string()
    } else {
        last_completed_method
    };

    conn.execute(
        "UPDATE orders
         SET payment_status = ?1,
             payment_method = ?2,
             updated_at = ?3
         WHERE id = ?4",
        rusqlite::params![next_payment_status, next_payment_method, now, order_id],
    )
    .map_err(|e| format!("refresh order payment snapshot: {e}"))?;

    Ok((next_payment_status, next_payment_method, total_paid))
}

fn enqueue_order_edit_sync(
    conn: &rusqlite::Connection,
    order_id: &str,
    items: &[serde_json::Value],
    order_notes: Option<&str>,
    total_amount: f64,
    payment_status: &str,
    payment_method: &str,
) -> Result<(), String> {
    let sync_payload = serde_json::json!({
        "orderId": order_id,
        "items": items,
        "orderNotes": order_notes,
        "totalAmount": total_amount,
        "paymentStatus": payment_status,
        "paymentMethod": payment_method,
    });
    enqueue_order_sync_payload(conn, order_id, &sync_payload)
        .map_err(|e| format!("enqueue order edit parity sync: {e}"))?;
    Ok(())
}

fn list_completed_payments_for_edit(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT
                op.id,
                op.method,
                op.amount,
                op.created_at,
                op.transaction_ref,
                op.staff_shift_id,
                COALESCE((
                    SELECT SUM(pa.amount)
                    FROM payment_adjustments pa
                    WHERE pa.payment_id = op.id
                      AND pa.adjustment_type = 'refund'
                ), 0)
             FROM order_payments op
             WHERE op.order_id = ?1
               AND op.status = 'completed'
             ORDER BY op.created_at ASC, op.updated_at ASC",
        )
        .map_err(|e| format!("prepare edit settlement payments: {e}"))?;

    let rows = stmt
        .query_map(rusqlite::params![order_id], |row| {
            let amount = row.get::<_, f64>(2)?;
            let refunded = row.get::<_, f64>(6)?;
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "method": row.get::<_, String>(1)?,
                "amount": amount,
                "createdAt": row.get::<_, String>(3)?,
                "transactionRef": row.get::<_, Option<String>>(4)?,
                "staffShiftId": row.get::<_, Option<String>>(5)?,
                "refundedAmount": refunded,
                "remainingRefundable": (amount - refunded).max(0.0),
            }))
        })
        .map_err(|e| format!("query edit settlement payments: {e}"))?;

    Ok(rows.filter_map(Result::ok).collect())
}

fn load_active_driver_settlement(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    conn.query_row(
        "SELECT id, driver_id, staff_shift_id, cash_collected, card_amount, cash_to_return
         FROM driver_earnings
         WHERE order_id = ?1
           AND COALESCE(settled, 0) = 0
           AND COALESCE(is_transferred, 0) = 0
         LIMIT 1",
        rusqlite::params![order_id],
        |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "driverId": row.get::<_, String>(1)?,
                "staffShiftId": row.get::<_, Option<String>>(2)?,
                "cashCollected": row.get::<_, f64>(3)?,
                "cardAmount": row.get::<_, f64>(4)?,
                "cashToReturn": row.get::<_, f64>(5)?,
            }))
        },
    )
    .optional()
    .map_err(|e| format!("load active driver settlement: {e}"))
}

fn parse_order_update_customer_info_payload(
    arg0: Option<serde_json::Value>,
) -> Result<OrderUpdateCustomerInfoPayload, String> {
    let payload = arg0.unwrap_or_else(|| serde_json::json!({}));
    let mut parsed: OrderUpdateCustomerInfoPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid order customer info payload: {e}"))?;

    parsed.order_id = parsed.order_id.trim().to_string();
    parsed.customer_name = parsed.customer_name.trim().to_string();
    parsed.customer_phone = parsed.customer_phone.trim().to_string();
    parsed.delivery_address = parsed.delivery_address.trim().to_string();
    parsed.customer_email = normalize_optional_text(parsed.customer_email);
    parsed.delivery_postal_code = normalize_optional_text(parsed.delivery_postal_code);
    parsed.delivery_notes = normalize_optional_text(parsed.delivery_notes);

    if parsed.order_id.is_empty() {
        return Err("Missing orderId".into());
    }
    if parsed.customer_name.is_empty() {
        return Err("Missing customerName".into());
    }
    if parsed.customer_phone.is_empty() {
        return Err("Missing customerPhone".into());
    }
    if parsed.delivery_address.is_empty() {
        return Err("Missing deliveryAddress".into());
    }

    Ok(parsed)
}

fn parse_pickup_to_delivery_conversion_payload(
    arg0: Option<serde_json::Value>,
) -> Result<PickupToDeliveryConversionPayload, String> {
    let payload = arg0.unwrap_or_else(|| serde_json::json!({}));
    let mut parsed: PickupToDeliveryConversionPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid pickup to delivery payload: {e}"))?;

    parsed.order_id = parsed.order_id.trim().to_string();
    parsed.customer_id = normalize_optional_text(parsed.customer_id);
    parsed.customer_name = parsed.customer_name.trim().to_string();
    parsed.customer_phone = parsed.customer_phone.trim().to_string();
    parsed.customer_email = normalize_optional_text(parsed.customer_email);
    parsed.delivery_address = parsed.delivery_address.trim().to_string();
    parsed.delivery_city = normalize_optional_text(parsed.delivery_city);
    parsed.delivery_postal_code = normalize_optional_text(parsed.delivery_postal_code);
    parsed.delivery_floor = normalize_optional_text(parsed.delivery_floor);
    parsed.delivery_notes = normalize_optional_text(parsed.delivery_notes);
    parsed.name_on_ringer = normalize_optional_text(parsed.name_on_ringer);

    if parsed.order_id.is_empty() {
        return Err("Missing orderId".into());
    }
    if parsed.customer_name.is_empty() {
        return Err("Missing customerName".into());
    }
    if parsed.customer_phone.is_empty() {
        return Err("Missing customerPhone".into());
    }
    if parsed.delivery_address.is_empty() {
        return Err("Missing deliveryAddress".into());
    }
    if !parsed.delivery_fee.is_finite() || parsed.delivery_fee < 0.0 {
        return Err("Invalid deliveryFee".into());
    }
    if !parsed.total_amount.is_finite() || parsed.total_amount < 0.0 {
        return Err("Invalid totalAmount".into());
    }

    Ok(parsed)
}

fn resolve_driver_display_name(conn: &rusqlite::Connection, driver_id: &str) -> Option<String> {
    let driver_id = driver_id.trim();
    if driver_id.is_empty() {
        return None;
    }

    conn.query_row(
        "SELECT staff_name
         FROM staff_shifts
         WHERE staff_id = ?1
           AND TRIM(COALESCE(staff_name, '')) <> ''
         ORDER BY COALESCE(check_in_time, created_at, updated_at) DESC, updated_at DESC
         LIMIT 1",
        rusqlite::params![driver_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .map(|name| name.trim().to_string())
    .filter(|name| !name.is_empty())
}

#[tauri::command]
pub async fn order_get_all(
    db: tauri::State<'_, db::DbState>,
) -> Result<Vec<serde_json::Value>, String> {
    sync::get_all_orders(&db)
}

#[tauri::command]
pub async fn order_get_by_id(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let id = payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .or(arg1)
    .ok_or("Missing order ID")?;
    let resolved_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let by_local: Option<String> = conn
            .query_row(
                "SELECT id FROM orders WHERE id = ?1 LIMIT 1",
                rusqlite::params![id.clone()],
                |row| row.get(0),
            )
            .ok();
        if let Some(v) = by_local {
            v
        } else {
            conn.query_row(
                "SELECT id FROM orders WHERE supabase_id = ?1 LIMIT 1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .map_err(|_| "Order not found")?
        }
    };
    sync::get_order_by_id(&db, &resolved_id)
}

#[tauri::command]
pub async fn order_get_by_customer_phone(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let customer_phone =
        payload_arg0_as_string(arg0, &["customerPhone", "customer_phone", "phone"])
            .or(arg1)
            .ok_or("Missing customer phone")?;
    let normalized = customer_phone
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '(' | ')'))
        .collect::<String>();
    let all_orders = sync::get_all_orders(&db)?;
    let filtered: Vec<serde_json::Value> = all_orders
        .into_iter()
        .filter(|o| {
            let phone = o
                .get("customerPhone")
                .and_then(|v| v.as_str())
                .or_else(|| o.get("customer_phone").and_then(|v| v.as_str()))
                .unwrap_or("")
                .chars()
                .filter(|c| !matches!(c, ' ' | '-' | '(' | ')'))
                .collect::<String>();
            !phone.is_empty() && (phone.contains(&normalized) || normalized.contains(&phone))
        })
        .collect();

    Ok(serde_json::json!({
        "success": true,
        "orders": filtered
    }))
}

#[tauri::command]
pub async fn order_update_status(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_order_update_status_payload(arg0, arg1)?;
    let order_id_raw = payload.order_id;
    let status = normalize_status_for_storage(&payload.status);
    let estimated_time = payload.estimated_time;
    let now = Utc::now().to_rfc3339();

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id_raw],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "Order not found")?
    };

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let previous_status =
            ensure_order_status_transition_allowed(&conn, &actual_order_id, &status)?;
        if status_requires_payment_integrity_guard(&status) {
            let blockers = payment_integrity::load_order_payment_blockers(&conn, &actual_order_id)?;
            if !blockers.is_empty() {
                let action_label = if status == "delivered" {
                    "Cannot mark order as delivered"
                } else {
                    "Cannot mark order as completed"
                };
                return Ok(payment_integrity::build_unsettled_payment_blocker_response(
                    action_label,
                    &blockers,
                ));
            }
        }
        let was_cancelled = previous_status == "cancelled";
        let next_is_cancelled = status == "cancelled";

        if !was_cancelled && next_is_cancelled {
            order_ownership::reverse_order_drawer_attribution(&conn, &actual_order_id, &now)?;
        }

        conn.execute(
            "UPDATE orders
             SET status = ?1, sync_status = 'pending', updated_at = ?2
             WHERE id = ?3",
            rusqlite::params![status, now, actual_order_id],
        )
        .map_err(|e| format!("update order status: {e}"))?;
        if let Some(eta) = estimated_time {
            let _ = conn.execute(
                "UPDATE orders SET estimated_time = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![eta, now, actual_order_id],
            );
        }
        let sync_payload = serde_json::json!({
            "orderId": actual_order_id,
            "status": status,
            "estimatedTime": estimated_time
        });
        let _ = enqueue_order_sync_payload(&conn, &actual_order_id, &sync_payload);
    }

    let event_payload = serde_json::json!({
        "orderId": actual_order_id,
        "status": status,
        "estimatedTime": estimated_time
    });
    let _ = app.emit("order_status_updated", event_payload.clone());
    let _ = app.emit("order_realtime_update", event_payload);

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id
    }))
}

fn convert_pickup_order_to_delivery_inner(
    db: &db::DbState,
    payload: PickupToDeliveryConversionPayload,
) -> Result<(String, serde_json::Value), String> {
    let PickupToDeliveryConversionPayload {
        order_id,
        customer_id,
        customer_name,
        customer_phone,
        customer_email,
        delivery_address,
        delivery_city,
        delivery_postal_code,
        delivery_floor,
        delivery_notes,
        name_on_ringer,
        delivery_fee,
        total_amount,
    } = payload;

    let now = chrono::Utc::now().to_rfc3339();
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let actual_order_id = resolve_order_id(&conn, &order_id).ok_or("Order not found")?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin pickup to delivery transaction: {e}"))?;

    tx.execute(
        "UPDATE orders
         SET customer_id = ?1,
             customer_name = ?2,
             customer_phone = ?3,
             customer_email = ?4,
             order_type = 'delivery',
             delivery_address = ?5,
             delivery_city = ?6,
             delivery_postal_code = ?7,
             delivery_floor = ?8,
             delivery_notes = ?9,
             name_on_ringer = ?10,
             delivery_fee = ?11,
             total_amount = ?12,
             driver_id = NULL,
             driver_name = NULL,
             sync_status = 'pending',
             updated_at = ?13
         WHERE id = ?14",
        rusqlite::params![
            customer_id.as_deref(),
            &customer_name,
            &customer_phone,
            customer_email.as_deref(),
            &delivery_address,
            delivery_city.as_deref(),
            delivery_postal_code.as_deref(),
            delivery_floor.as_deref(),
            delivery_notes.as_deref(),
            name_on_ringer.as_deref(),
            delivery_fee,
            total_amount,
            &now,
            &actual_order_id,
        ],
    )
    .map_err(|e| format!("convert pickup order to delivery: {e}"))?;

    let sync_payload = serde_json::json!({
        "orderId": actual_order_id.clone(),
        "customerId": customer_id,
        "customer_id": customer_id,
        "customerName": customer_name,
        "customerEmail": customer_email,
        "customerPhone": customer_phone,
        "orderType": "delivery",
        "deliveryAddress": delivery_address,
        "deliveryCity": delivery_city,
        "deliveryPostalCode": delivery_postal_code,
        "deliveryFloor": delivery_floor,
        "deliveryNotes": delivery_notes,
        "nameOnRinger": name_on_ringer,
        "deliveryFee": delivery_fee,
        "totalAmount": total_amount,
        "driverId": serde_json::Value::Null,
        "driverName": serde_json::Value::Null
    });
    enqueue_order_sync_payload(&tx, &actual_order_id, &sync_payload)
        .map_err(|e| format!("enqueue pickup to delivery parity row: {e}"))?;

    tx.commit()
        .map_err(|e| format!("commit pickup to delivery transaction: {e}"))?;

    drop(conn);
    let order_json = sync::get_order_by_id(db, &actual_order_id)?;
    Ok((actual_order_id, order_json))
}

#[tauri::command]
pub async fn order_update_customer_info(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_order_update_customer_info_payload(arg0)?;
    let now = Utc::now().to_rfc3339();

    let OrderUpdateCustomerInfoPayload {
        order_id,
        customer_name,
        customer_email,
        customer_phone,
        delivery_address,
        delivery_postal_code,
        delivery_notes,
    } = payload;

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        resolve_order_id(&conn, &order_id).ok_or("Order not found")?
    };

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE orders
             SET customer_name = ?1,
                 customer_phone = ?2,
                 customer_email = COALESCE(?3, customer_email),
                 delivery_address = ?4,
                 delivery_postal_code = ?5,
                 delivery_notes = ?6,
                 sync_status = 'pending',
                 updated_at = ?7
             WHERE id = ?8",
            rusqlite::params![
                &customer_name,
                &customer_phone,
                customer_email.as_deref(),
                &delivery_address,
                delivery_postal_code.as_deref(),
                delivery_notes.as_deref(),
                &now,
                &actual_order_id,
            ],
        )
        .map_err(|e| format!("update order customer info: {e}"))?;

        let sync_payload = serde_json::json!({
            "orderId": actual_order_id,
            "customerName": customer_name,
            "customerEmail": customer_email,
            "customerPhone": customer_phone,
            "deliveryAddress": delivery_address,
            "deliveryPostalCode": delivery_postal_code,
            "deliveryNotes": delivery_notes,
        });
        let _ = enqueue_order_sync_payload(&conn, &actual_order_id, &sync_payload);
    }

    if let Ok(order_json) = sync::get_order_by_id(&db, &actual_order_id) {
        let _ = app.emit("order_realtime_update", order_json);
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id
    }))
}

#[tauri::command]
pub async fn order_convert_pickup_to_delivery(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_pickup_to_delivery_conversion_payload(arg0)?;
    let (actual_order_id, order_json) = convert_pickup_order_to_delivery_inner(&db, payload)?;

    let _ = app.emit("order_realtime_update", order_json.clone());

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id,
        "data": order_json
    }))
}

#[tauri::command]
pub async fn order_update_items(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_order_update_items_payload(arg0, arg1)?;
    let order_id_raw = payload.order_id;
    let items = payload.items;
    let notes = payload.order_notes;
    let total = items
        .iter()
        .map(|item| {
            let qty = value_f64(item, &["quantity"]).unwrap_or(1.0);
            if let Some(tp) = value_f64(item, &["total_price", "totalPrice"]) {
                tp
            } else {
                value_f64(item, &["unit_price", "unitPrice", "price"]).unwrap_or(0.0) * qty
            }
        })
        .sum::<f64>();
    let now = Utc::now().to_rfc3339();

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id_raw],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "Order not found")?
    };

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let items_json =
            serde_json::to_string(&items).map_err(|e| format!("serialize items: {e}"))?;
        if let Some(order_notes) = notes.clone() {
            conn.execute(
                "UPDATE orders
                 SET items = ?1, total_amount = ?2, special_instructions = ?3, sync_status = 'pending', updated_at = ?4
                 WHERE id = ?5",
                rusqlite::params![items_json, total, order_notes, now, actual_order_id],
            )
            .map_err(|e| format!("update order items: {e}"))?;
        } else {
            conn.execute(
                "UPDATE orders
                 SET items = ?1, total_amount = ?2, sync_status = 'pending', updated_at = ?3
                 WHERE id = ?4",
                rusqlite::params![items_json, total, now, actual_order_id],
            )
            .map_err(|e| format!("update order items: {e}"))?;
        }
        let sync_payload = serde_json::json!({
            "orderId": actual_order_id,
            "items": items,
            "orderNotes": notes
        });
        let _ = enqueue_order_sync_payload(&conn, &actual_order_id, &sync_payload);
    }

    if let Ok(order_json) = sync::get_order_by_id(&db, &actual_order_id) {
        let _ = app.emit("order_realtime_update", order_json);
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id
    }))
}

#[tauri::command]
pub async fn orders_preview_edit_settlement(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_order_edit_settlement_preview_payload(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let actual_order_id = resolve_order_id(&conn, &payload.order_id).ok_or("Order not found")?;
    let (next_total, _) = derive_next_order_totals(&conn, &actual_order_id, &payload.items)?;

    let (
        current_total,
        payment_status,
        payment_method,
        order_type,
        is_ghost,
        branch_id,
        terminal_id,
        driver_id,
    ): (
        f64,
        String,
        String,
        String,
        bool,
        String,
        String,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT
                COALESCE(total_amount, 0),
                COALESCE(payment_status, 'pending'),
                COALESCE(payment_method, 'pending'),
                COALESCE(order_type, 'dine-in'),
                COALESCE(is_ghost, 0),
                COALESCE(branch_id, ''),
                COALESCE(terminal_id, ''),
                driver_id
             FROM orders
             WHERE id = ?1",
            rusqlite::params![actual_order_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get::<_, i64>(4)? != 0,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .map_err(|e| format!("load edit settlement order context: {e}"))?;

    let completed_payments = list_completed_payments_for_edit(&conn, &actual_order_id)?;
    let paid_total = completed_payments
        .iter()
        .map(net_paid_amount_from_edit_payment)
        .sum::<f64>();
    let delta = next_total - current_total;
    let required_action = determine_edit_settlement_required_action(paid_total, next_total);
    let driver_settlement = load_active_driver_settlement(&conn, &actual_order_id)?;
    let driver_cash_owned =
        order_type.eq_ignore_ascii_case("delivery") && driver_settlement.is_some();

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id,
        "branchId": branch_id,
        "terminalId": terminal_id,
        "orderType": order_type,
        "driverId": driver_id,
        "isGhostOrder": is_ghost,
        "originalTotal": current_total,
        "nextTotal": next_total,
        "paidTotal": paid_total,
        "delta": delta,
        "paymentStatus": payment_status,
        "paymentMethod": payment_method,
        "requiredAction": required_action,
        "completedPayments": completed_payments,
        "deliverySettlement": {
            "driverCashOwned": driver_cash_owned,
            "driverEarning": driver_settlement,
        },
    }))
}

#[tauri::command]
pub async fn orders_apply_edit_settlement(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let (payload, action) = parse_order_edit_settlement_apply_payload(arg0)?;
    let now = Utc::now().to_rfc3339();

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        resolve_order_id(&conn, &payload.order_id).ok_or("Order not found")?
    };

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (next_total, next_subtotal) =
        derive_next_order_totals(&conn, &actual_order_id, &payload.items)?;
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<serde_json::Value, String> {
        update_order_items_in_connection(
            &conn,
            &actual_order_id,
            &payload.items,
            payload.order_notes.as_deref(),
            next_total,
            next_subtotal,
            &now,
        )?;

        let stale_payment_ids =
            resolve_stale_unsynced_overpay_payments_for_order(&conn, &actual_order_id, &now)?;
        let paid_total_before = load_net_paid_for_order(&conn, &actual_order_id)?;

        match action {
            EditSettlementActionPayload::None | EditSettlementActionPayload::MarkPartial => {}
            EditSettlementActionPayload::Collect {
                payments: payment_rows,
            } => {
                if payment_rows.is_empty() {
                    return Err("Collect action requires at least one payment".into());
                }
                let recorded_total: f64 = payment_rows.iter().map(|payment| payment.amount).sum();
                let outstanding = (next_total - paid_total_before).max(0.0);
                if recorded_total > outstanding + 0.01 {
                    return Err(format!(
                        "Collected amount {recorded_total:.2} exceeds outstanding balance {outstanding:.2}"
                    ));
                }

                for payment in payment_rows {
                    let record_payload = serde_json::json!({
                        "orderId": actual_order_id.clone(),
                        "method": payment.method,
                        "amount": payment.amount,
                        "discountAmount": payment.discount_amount.unwrap_or(0.0),
                        "cashReceived": payment.cash_received,
                        "changeGiven": payment.change_given,
                        "transactionRef": payment.transaction_ref,
                        "paymentOrigin": payment.payment_origin.unwrap_or_else(|| "manual".to_string()),
                        "terminalDeviceId": payment.terminal_device_id,
                        "terminalApproved": payment.terminal_approved.unwrap_or(false),
                        "staffId": payment.staff_id,
                        "staffShiftId": payment.staff_shift_id,
                        "collectedBy": payment.collected_by,
                        "items": payment.items,
                    });
                    let input = payments::build_payment_record_input(&record_payload)?;
                    let mut options = payments::PaymentInsertOptions::local();
                    if matches!(input.collected_by.as_deref(), Some("cashier_drawer")) {
                        options.sync_order_owner_with_payment = false;
                    }
                    options.mark_order_sync_pending_on_owner_change = false;
                    payments::record_payment_in_connection(&conn, &input, &options)?;
                }
            }
            EditSettlementActionPayload::Refund {
                refunds: refund_rows,
            } => {
                if refund_rows.is_empty() {
                    return Err("Refund action requires at least one payment allocation".into());
                }
                let refund_total: f64 = refund_rows.iter().map(|refund| refund.amount).sum();
                let required_refund = (paid_total_before - next_total).max(0.0);
                if (refund_total - required_refund).abs() > 0.01 {
                    return Err(format!(
                        "Refund allocation {refund_total:.2} must match the overpaid amount {required_refund:.2}"
                    ));
                }

                for refund in refund_rows {
                    let refund_payload = serde_json::json!({
                        "paymentId": refund.payment_id,
                        "amount": refund.amount,
                        "reason": refund.reason,
                        "refundMethod": refund.refund_method,
                        "cashHandler": refund.cash_handler,
                        "staffId": refund.staff_id,
                        "staffShiftId": refund.staff_shift_id,
                        "adjustmentContext": "edit_settlement",
                    });
                    refunds::refund_payment_in_connection(&conn, &refund_payload)?;
                }
            }
        }

        let (payment_status, payment_method, paid_total_after) =
            refresh_order_payment_snapshot(&conn, &actual_order_id, &now)?;
        let required_action =
            determine_edit_settlement_required_action(paid_total_after, next_total);
        enqueue_order_edit_sync(
            &conn,
            &actual_order_id,
            &payload.items,
            payload.order_notes.as_deref(),
            next_total,
            &payment_status,
            &payment_method,
        )?;

        Ok(serde_json::json!({
            "success": true,
            "orderId": actual_order_id.clone(),
            "nextTotal": next_total,
            "paidTotal": paid_total_after,
            "paymentStatus": payment_status,
            "paymentMethod": payment_method,
            "requiredAction": required_action,
            "stalePaymentIdsVoided": stale_payment_ids,
        }))
    })();

    let response = match result {
        Ok(value) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }?;

    drop(conn);

    if let Ok(order_json) = sync::get_order_by_id(&db, &actual_order_id) {
        let _ = app.emit("order_realtime_update", order_json);
    }

    Ok(response)
}

#[tauri::command]
pub async fn order_update_financials(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_order_update_financials_payload(arg0)?;
    let now = Utc::now().to_rfc3339();

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        resolve_order_id(&conn, &payload.order_id).ok_or("Order not found")?
    };

    let discount_amount = payload.discount_amount.unwrap_or(0.0).max(0.0);
    let discount_percentage = payload.discount_percentage.unwrap_or(0.0).max(0.0);
    let tax_amount = payload.tax_amount.unwrap_or(0.0).max(0.0);
    let delivery_fee = payload.delivery_fee.unwrap_or(0.0).max(0.0);
    let tip_amount = payload.tip_amount.unwrap_or(0.0).max(0.0);
    let subtotal = payload
        .subtotal
        .unwrap_or_else(|| {
            (payload.total_amount + discount_amount - tax_amount - delivery_fee - tip_amount)
                .max(0.0)
        })
        .max(0.0);

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<serde_json::Value, String> {
        conn.execute(
            "UPDATE orders
             SET total_amount = ?1,
                 subtotal = ?2,
                 discount_amount = ?3,
                 discount_percentage = ?4,
                 tax_amount = ?5,
                 delivery_fee = ?6,
                 tip_amount = ?7,
                 sync_status = 'pending',
                 updated_at = ?8
             WHERE id = ?9",
            rusqlite::params![
                payload.total_amount,
                subtotal,
                discount_amount,
                discount_percentage,
                tax_amount,
                delivery_fee,
                tip_amount,
                now,
                actual_order_id,
            ],
        )
        .map_err(|e| format!("update order financials: {e}"))?;

        let stale_payment_ids =
            resolve_stale_unsynced_overpay_payments_for_order(&conn, &actual_order_id, &now)?;
        let (payment_status, payment_method, paid_total) =
            refresh_order_payment_snapshot(&conn, &actual_order_id, &now)?;

        let sync_payload = serde_json::json!({
            "orderId": actual_order_id,
            "totalAmount": payload.total_amount,
            "subtotal": subtotal,
            "discountAmount": discount_amount,
            "discountPercentage": discount_percentage,
            "taxAmount": tax_amount,
            "deliveryFee": delivery_fee,
            "tipAmount": tip_amount,
            "paymentStatus": payment_status,
            "paymentMethod": payment_method,
        });
        enqueue_order_sync_payload(&conn, &actual_order_id, &sync_payload)
            .map_err(|e| format!("enqueue order financial sync: {e}"))?;

        Ok(serde_json::json!({
            "success": true,
            "orderId": actual_order_id.clone(),
            "paymentStatus": payment_status,
            "paymentMethod": payment_method,
            "paidTotal": paid_total,
            "stalePaymentIdsVoided": stale_payment_ids,
        }))
    })();

    let response = match result {
        Ok(value) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }?;

    drop(conn);

    if let Ok(order_json) = sync::get_order_by_id(&db, &actual_order_id) {
        let _ = app.emit("order_realtime_update", order_json);
    }

    Ok(response)
}

#[tauri::command]
pub async fn order_delete(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_order_delete_payload(arg0, arg1)?;
    let order_id_raw = payload.order_id;

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id_raw],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };

    if let Some(actual_id) = actual_order_id.clone() {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM orders WHERE id = ?1",
            rusqlite::params![actual_id.clone()],
        )
        .map_err(|e| format!("delete order: {e}"))?;
        // Electron parity: order delete remains local-only.
        // Also purge stale queued order delete operations so they cannot poison
        // /api/pos/orders/sync (which only accepts insert/update).
        let _ = conn.execute(
            "DELETE FROM parity_sync_queue
             WHERE table_name = 'orders'
               AND operation = 'DELETE'
               AND (record_id = ?1 OR status IN ('pending', 'processing', 'failed', 'conflict'))",
            rusqlite::params![actual_id.clone()],
        );
        // Compatibility cleanup for historical pre-parity order delete rows.
        let _ = conn.execute(
            "DELETE FROM sync_queue
             WHERE entity_type = 'order'
               AND operation = 'delete'
               AND (entity_id = ?1 OR status IN ('pending', 'in_progress', 'failed', 'deferred'))",
            rusqlite::params![actual_id],
        );
        let _ = app.emit("order_deleted", serde_json::json!({ "orderId": actual_id }));
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id
    }))
}

#[tauri::command]
pub async fn order_save_from_remote(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    let order_data = payload.get("orderData").cloned().unwrap_or(payload);
    let remote_id = value_str(&order_data, &["id", "supabase_id", "supabaseId"])
        .ok_or("Missing remote order id")?;

    let existing_local_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE supabase_id = ?1 OR id = ?1 LIMIT 1",
            rusqlite::params![remote_id.clone()],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };
    if let Some(local_id) = existing_local_id {
        return Ok(serde_json::json!({
            "success": true,
            "orderId": local_id,
            "alreadyExists": true
        }));
    }

    let local_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let items = order_data
        .get("items")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let items_json = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());

    let order_number = value_str(&order_data, &["order_number", "orderNumber"]);
    let customer_name = value_str(&order_data, &["customer_name", "customerName"]);
    let customer_phone = value_str(&order_data, &["customer_phone", "customerPhone"]);
    let customer_email = value_str(&order_data, &["customer_email", "customerEmail"]);
    let total_amount = value_f64(&order_data, &["total_amount", "totalAmount"]).unwrap_or(0.0);
    let tax_amount = value_f64(&order_data, &["tax_amount", "taxAmount"]).unwrap_or(0.0);
    let subtotal = value_f64(&order_data, &["subtotal"]).unwrap_or(0.0);
    let status = normalize_status_for_storage(
        &value_str(&order_data, &["status"]).unwrap_or_else(|| "pending".to_string()),
    );
    let order_type =
        value_str(&order_data, &["order_type", "orderType"]).unwrap_or_else(|| "pickup".into());
    let table_number = value_str(&order_data, &["table_number", "tableNumber"]);
    let delivery_address = value_str(
        &order_data,
        &["delivery_address", "deliveryAddress", "address"],
    );
    let delivery_city = value_str(&order_data, &["delivery_city", "deliveryCity"]);
    let delivery_postal_code =
        value_str(&order_data, &["delivery_postal_code", "deliveryPostalCode"]);
    let delivery_floor = value_str(&order_data, &["delivery_floor", "deliveryFloor"]);
    let delivery_notes = value_str(&order_data, &["delivery_notes", "deliveryNotes"]);
    let name_on_ringer = value_str(&order_data, &["name_on_ringer", "nameOnRinger"]);
    let special_instructions = value_str(&order_data, &["special_instructions", "notes"]);
    let estimated_time = value_i64(&order_data, &["estimated_time", "estimatedTime"]);
    let payment_status = value_str(&order_data, &["payment_status", "paymentStatus"])
        .unwrap_or_else(|| "pending".into());
    let payment_method = value_str(&order_data, &["payment_method", "paymentMethod"]);
    let payment_tx_id = value_str(
        &order_data,
        &["payment_transaction_id", "paymentTransactionId"],
    );
    let staff_shift_id = value_str(&order_data, &["staff_shift_id", "staffShiftId"]);
    let staff_id = value_str(&order_data, &["staff_id", "staffId"]);
    let driver_id = value_str(&order_data, &["driver_id", "driverId"]);
    let driver_name = value_str(&order_data, &["driver_name", "driverName"]);
    let discount_pct =
        value_f64(&order_data, &["discount_percentage", "discountPercentage"]).unwrap_or(0.0);
    let discount_amount =
        value_f64(&order_data, &["discount_amount", "discountAmount"]).unwrap_or(0.0);
    let tip_amount = value_f64(&order_data, &["tip_amount", "tipAmount"]).unwrap_or(0.0);
    let tax_rate = value_f64(&order_data, &["tax_rate", "taxRate"]);
    let delivery_fee = value_f64(&order_data, &["delivery_fee", "deliveryFee"]).unwrap_or(0.0);
    let branch_id = value_str(&order_data, &["branch_id", "branchId"])
        .or_else(|| storage::get_credential("branch_id"));
    let terminal_id = value_str(&order_data, &["terminal_id", "terminalId"])
        .or_else(|| storage::get_credential("terminal_id"));
    let plugin = value_str(
        &order_data,
        &["plugin", "platform", "order_plugin", "orderPlatform"],
    );
    let external_plugin_order_id = value_str(
        &order_data,
        &[
            "external_plugin_order_id",
            "externalPluginOrderId",
            "external_platform_order_id",
            "externalPlatformOrderId",
        ],
    );
    let is_ghost = order_data
        .get("is_ghost")
        .or_else(|| order_data.get("isGhost"))
        .and_then(|value| {
            if let Some(flag) = value.as_bool() {
                return Some(flag);
            }
            if let Some(flag) = value.as_i64() {
                return Some(flag == 1);
            }
            value.as_str().and_then(|flag| {
                let normalized = flag.trim().to_ascii_lowercase();
                if matches!(normalized.as_str(), "true" | "1" | "yes" | "on") {
                    Some(true)
                } else if matches!(normalized.as_str(), "false" | "0" | "no" | "off") {
                    Some(false)
                } else {
                    None
                }
            })
        })
        .unwrap_or(false);
    let ghost_source = value_str(&order_data, &["ghost_source", "ghostSource"]);
    let ghost_metadata = order_data
        .get("ghost_metadata")
        .or_else(|| order_data.get("ghostMetadata"))
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
    let created_at = value_str(&order_data, &["created_at", "createdAt"]).unwrap_or(now.clone());
    let updated_at = value_str(&order_data, &["updated_at", "updatedAt"]).unwrap_or(now.clone());

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO orders (
                id, order_number, customer_name, customer_phone, customer_email,
                items, total_amount, tax_amount, subtotal, status,
                order_type, table_number, delivery_address, delivery_city, delivery_postal_code,
                delivery_floor, delivery_notes, name_on_ringer, special_instructions,
                created_at, updated_at, estimated_time, supabase_id, sync_status,
                payment_status, payment_method, payment_transaction_id, staff_shift_id,
                staff_id, driver_id, driver_name, discount_percentage, discount_amount,
                tip_amount, version, terminal_id, branch_id, plugin, external_plugin_order_id,
                tax_rate, delivery_fee, is_ghost, ghost_source, ghost_metadata
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15,
                ?16, ?17, ?18, ?19,
                ?20, ?21, ?22, ?23, 'synced',
                ?24, ?25, ?26, ?27,
                ?28, ?29, ?30, ?31, ?32,
                ?33, ?34, ?35, ?36, ?37,
                ?38, ?39, ?40, ?41,
                ?42, ?43
            )",
            rusqlite::params![
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
                delivery_city,
                delivery_postal_code,
                delivery_floor,
                delivery_notes,
                name_on_ringer,
                special_instructions,
                created_at,
                updated_at,
                estimated_time,
                remote_id,
                payment_status,
                payment_method,
                payment_tx_id,
                staff_shift_id,
                staff_id,
                driver_id,
                driver_name,
                discount_pct,
                discount_amount,
                tip_amount,
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
        .map_err(|e| format!("save remote order: {e}"))?;
    }

    if let Ok(order_json) = sync::get_order_by_id(&db, &local_id) {
        let _ = app.emit("order_created", order_json);
    }

    // Skip auto-print for ghost orders and pending/split payment orders (receipt
    // will be printed after split payments are individually recorded).
    let skip_auto_print = is_ghost || payment_method.as_deref() == Some("pending");
    if !skip_auto_print && crate::print::is_print_action_enabled(&db, "after_order") {
        for entity_type in print::auto_print_entity_types_for_order_type(&order_type) {
            if let Err(error) = print::enqueue_print_job(&db, entity_type, &local_id, None) {
                tracing::warn!(
                    order_id = %local_id,
                    entity_type = %entity_type,
                    error = %error,
                    "Failed to enqueue remote order auto-print job"
                );
            }
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": local_id
    }))
}

#[tauri::command]
pub async fn order_fetch_items_from_supabase(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .or(arg1)
    .ok_or("Missing orderId")?;

    if let Ok(items_json) = fetch_supabase_rows(
        "order_items",
        &[
            (
                "select",
                "id,menu_item_id,menu_item_name,quantity,unit_price,total_price,notes,customizations".to_string(),
            ),
            ("order_id", format!("eq.{}", order_id)),
        ],
    )
    .await
    {
        let rows = items_json.as_array().cloned().unwrap_or_default();
        if !rows.is_empty() {
            let ids: Vec<String> = rows
                .iter()
                .filter_map(|r| {
                    r.get("menu_item_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .collect();

            let mut names: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            if !ids.is_empty() {
                if let Ok(subcats) = fetch_supabase_rows(
                    "subcategories",
                    &[
                        ("select", "id,name,name_en,name_el".to_string()),
                        ("id", format!("in.({})", ids.join(","))),
                    ],
                )
                .await
                {
                    if let Some(arr) = subcats.as_array() {
                        for row in arr {
                            if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
                                let name = value_str(row, &["name", "name_en", "name_el"])
                                    .unwrap_or_else(|| "Item".to_string());
                                names.insert(id.to_string(), name);
                            }
                        }
                    }
                }
            }

            let transformed: Vec<serde_json::Value> = rows
                .into_iter()
                .enumerate()
                .map(|(i, row)| {
                    let menu_item_id = row.get("menu_item_id").and_then(|v| v.as_str()).unwrap_or("");
                    let quantity = row.get("quantity").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    let unit_price = row.get("unit_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let total_price = row
                        .get("total_price")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(unit_price * quantity);
                    let default_name = format!("Item {}", i + 1);
                    let item_name = row
                        .get("menu_item_name")
                        .and_then(|v| v.as_str())
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .or_else(|| names.get(menu_item_id).cloned())
                        .unwrap_or(default_name);
                    serde_json::json!({
                        "id": row.get("id").cloned().unwrap_or(serde_json::Value::Null),
                        "menu_item_id": menu_item_id,
                        "name": item_name,
                        "quantity": quantity,
                        "price": unit_price,
                        "unit_price": unit_price,
                        "total_price": total_price,
                        "notes": row.get("notes").cloned().unwrap_or(serde_json::Value::Null),
                        "customizations": row.get("customizations").cloned().unwrap_or(serde_json::Value::Null),
                    })
                })
                .collect();
            return Ok(serde_json::json!(transformed));
        }
    }

    // Fallback: use local order cache (by local ID or Supabase ID).
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let items_str: Option<String> = conn
        .query_row(
            "SELECT items FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id],
            |row| row.get(0),
        )
        .ok();
    if let Some(s) = items_str {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if v.is_array() {
                return Ok(v);
            }
        }
    }
    Ok(serde_json::json!([]))
}

#[tauri::command]
pub async fn order_create(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    _app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    let normalized = payload.get("orderData").cloned().unwrap_or(payload);
    let mut resp = sync::create_order(&db, &normalized)?;
    let order_id = resp
        .get("orderId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            resp.get("order")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    if let Some(order_id) = order_id.clone() {
        if let Some(obj) = resp.as_object_mut() {
            obj.entry("orderId".to_string())
                .or_insert_with(|| serde_json::Value::String(order_id.clone()));
            obj.entry("data".to_string())
                .or_insert_with(|| serde_json::json!({ "orderId": order_id.clone() }));
        }
    }

    // NOTE: We intentionally do NOT emit order_created/order_realtime_update here.
    // Self-created orders are added to state directly in the frontend store.
    // Only order_save_from_remote() emits these events (for orders from other terminals).
    Ok(resp)
}

#[tauri::command]
pub async fn order_create_with_initial_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    _app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    let normalized = payload.get("orderData").cloned().unwrap_or(payload);
    let mut resp = sync::create_order(&db, &normalized)?;
    let order_id = resp
        .get("orderId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            resp.get("order")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    if let Some(order_id) = order_id.clone() {
        if let Some(obj) = resp.as_object_mut() {
            obj.entry("orderId".to_string())
                .or_insert_with(|| serde_json::Value::String(order_id.clone()));
            obj.entry("data".to_string())
                .or_insert_with(|| serde_json::json!({ "orderId": order_id.clone() }));
        }
    }

    Ok(resp)
}

#[tauri::command]
pub async fn orders_clear_all(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let count = conn
        .execute("DELETE FROM orders", [])
        .map_err(|e| e.to_string())?;
    let _ = app.emit("orders_cleared", serde_json::json!({ "count": count }));
    Ok(serde_json::json!({
        "success": true,
        "cleared": count
    }))
}

#[tauri::command]
pub async fn orders_get_conflicts() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!([]))
}

#[tauri::command]
pub async fn orders_resolve_conflict(
    arg0: Option<String>,
    arg1: Option<String>,
    _arg2: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conflict_id = arg0.unwrap_or_default();
    let strategy = arg1.unwrap_or_else(|| "server_wins".to_string());
    let _ = app.emit(
        "order_conflict_resolved",
        serde_json::json!({
            "conflictId": conflict_id,
            "strategy": strategy
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "conflictId": conflict_id,
        "strategy": strategy
    }))
}

#[tauri::command]
pub async fn order_approve(
    arg0: Option<String>,
    arg1: Option<i64>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let estimated_time = arg1;
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    ensure_order_status_transition_allowed(&conn, &order_id, "confirmed")?;
    conn.execute(
        "UPDATE orders
         SET status = 'confirmed',
             estimated_time = COALESCE(?1, estimated_time),
             sync_status = 'pending',
             updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![estimated_time, now, order_id],
    )
    .map_err(|e| format!("approve order: {e}"))?;

    let payload = serde_json::json!({
        "orderId": order_id,
        "status": "confirmed",
        "estimatedTime": estimated_time
    });
    let _ = enqueue_order_sync_payload(&conn, &order_id, &payload);
    drop(conn);

    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload.clone());
    Ok(
        serde_json::json!({ "success": true, "orderId": order_id_raw, "estimatedTime": estimated_time }),
    )
}

#[tauri::command]
pub async fn order_decline(
    arg0: Option<String>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let reason = arg1.unwrap_or_else(|| "Declined".to_string());
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    let previous_status = ensure_order_status_transition_allowed(&conn, &order_id, "cancelled")?;
    if previous_status != "cancelled" {
        order_ownership::reverse_order_drawer_attribution(&conn, &order_id, &now)?;
    }
    conn.execute(
        "UPDATE orders
         SET status = 'cancelled',
             cancellation_reason = ?1,
             sync_status = 'pending',
             updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![reason, now, order_id],
    )
    .map_err(|e| format!("decline order: {e}"))?;

    let payload = serde_json::json!({
        "orderId": order_id,
        "status": "cancelled",
        "reason": reason
    });
    let _ = enqueue_order_sync_payload(&conn, &order_id, &payload);
    drop(conn);

    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload);
    Ok(serde_json::json!({ "success": true, "orderId": order_id_raw }))
}

#[tauri::command]
pub async fn order_assign_driver(
    arg0: Option<String>,
    arg1: Option<String>,
    arg2: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let driver_id = arg1.ok_or("Missing driverId")?;
    let notes = arg2;
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    let driver_name = resolve_driver_display_name(&conn, &driver_id);
    let current_status: String = conn
        .query_row(
            "SELECT COALESCE(status, 'pending') FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("load order status: {e}"))?;

    if matches!(current_status.as_str(), "cancelled" | "canceled") {
        return Err("Cannot assign a driver to a cancelled order".into());
    }

    // Only create driver_earnings for delivery orders
    let is_delivery: bool = conn
        .query_row(
            "SELECT COALESCE(order_type, '') = 'delivery' FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !is_delivery {
        return Err("Driver assignment is only supported for delivery orders".into());
    }

    let driver_shift_id = if is_delivery {
        order_ownership::resolve_driver_shift_id(&conn, &driver_id, None)?
    } else {
        None
    };

    let shift_id = driver_shift_id
        .as_deref()
        .ok_or_else(|| "Driver must have an active shift before assignment".to_string())?;

    let assignment = order_ownership::assign_order_to_driver_shift(
        &conn,
        &order_id,
        &driver_id,
        driver_name.as_deref(),
        shift_id,
        &now,
    )?;

    let earning_id =
        order_ownership::upsert_driver_earning(&conn, &order_id, &driver_id, &assignment, &now)?;
    let earning_created = true;

    let assigned_status: String = conn
        .query_row(
            "SELECT COALESCE(status, 'pending') FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| current_status.clone());

    let _ = conn.execute(
        "UPDATE orders
         SET delivery_notes = COALESCE(?1, delivery_notes),
             sync_status = 'pending',
             updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![notes, now, order_id],
    );

    let driver_earning_sync_payload = serde_json::json!({
        "id": earning_id,
        "driver_id": driver_id,
        "staff_shift_id": shift_id,
        "order_id": order_id,
        "branch_id": assignment.branch_id,
        "delivery_fee": assignment.delivery_fee,
        "tip_amount": assignment.tip_amount,
        "total_earning": assignment.delivery_fee + assignment.tip_amount,
        "payment_method": assignment.payment_method,
        "cash_collected": assignment.cash_collected,
        "card_amount": assignment.card_amount,
        "cash_to_return": assignment.cash_collected,
        "createdAt": now,
        "updatedAt": now,
    });
    enqueue_or_refresh_driver_earning_sync_row(
        &conn,
        &earning_id,
        &driver_earning_sync_payload,
        &now,
    )?;

    let order_sync_payload = serde_json::json!({
        "orderId": order_id,
        "orderType": "delivery",
        "status": assigned_status,
        "driverId": driver_id,
        "driverName": driver_name,
        "deliveryNotes": notes,
    });
    let _ = enqueue_order_sync_payload(&conn, &order_id, &order_sync_payload);

    drop(conn);

    // Use is_print_action_enabled (not setting_bool) so the default-true behaviour
    // is preserved on fresh installs where the key is absent from local_settings.
    let driver_assigned_print_enabled =
        crate::print::is_print_action_enabled(&db, "driver_assigned");

    let assign_slip_payload = serde_json::json!({
        "slip_mode": "assign_driver",
        "driverId": driver_id,
        "driverName": driver_name,
    });
    if driver_assigned_print_enabled {
        if let Err(error) = print::enqueue_print_job_with_payload(
            &db,
            "delivery_slip",
            &order_id,
            None,
            Some(&assign_slip_payload),
        ) {
            tracing::warn!(
                order_id = %order_id,
                error = %error,
                "Failed to enqueue delivery slip print job"
            );
        }
    }

    let payload = serde_json::json!({
        "orderId": order_id_raw,
        "driverId": driver_id,
        "driverName": driver_name,
        "status": assigned_status,
        "notes": notes,
        "earningCreated": earning_created
    });
    let _ = app.emit(
        "order_status_updated",
        serde_json::json!({
            "orderId": order_id_raw,
            "status": assigned_status,
        }),
    );
    let _ = app.emit("order_realtime_update", payload.clone());
    Ok(serde_json::json!({ "success": true, "data": payload }))
}

#[tauri::command]
pub async fn order_notify_platform_ready(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    let now = Utc::now().to_rfc3339();
    ensure_order_status_transition_allowed(&conn, &order_id, "ready")?;
    conn.execute(
        "UPDATE orders SET status = 'ready', sync_status = 'pending', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, order_id],
    )
    .map_err(|e| format!("set ready status: {e}"))?;
    let sync_payload = serde_json::json!({
        "orderId": order_id,
        "status": "ready"
    });
    let _ = enqueue_order_sync_payload(&conn, &order_id, &sync_payload);
    drop(conn);
    let payload = serde_json::json!({ "orderId": order_id_raw, "status": "ready" });
    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn order_update_preparation(
    arg0: Option<String>,
    arg1: Option<String>,
    arg2: Option<f64>,
    arg3: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id = arg0.ok_or("Missing orderId")?;
    let stage = arg1.unwrap_or_else(|| "preparing".to_string());
    let progress = arg2.unwrap_or(0.0).clamp(0.0, 100.0);
    let message = arg3;
    let mut all = read_local_json_array(&db, "order_preparation_states")?;
    all.retain(|item| {
        item.get("orderId")
            .and_then(|v| v.as_str())
            .map(|v| v != order_id)
            .unwrap_or(true)
    });
    all.push(serde_json::json!({
        "orderId": order_id,
        "stage": stage,
        "progress": progress,
        "message": message,
        "updatedAt": Utc::now().to_rfc3339()
    }));
    write_local_json(
        &db,
        "order_preparation_states",
        &serde_json::Value::Array(all),
    )?;

    let payload = serde_json::json!({
        "orderId": order_id,
        "preparationStage": stage,
        "preparationProgress": progress,
        "message": message
    });
    let _ = app.emit("order_realtime_update", payload.clone());
    Ok(serde_json::json!({ "success": true, "data": payload }))
}

#[tauri::command]
pub async fn order_update_type(
    arg0: Option<String>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let order_type = arg1.ok_or("Missing orderType")?.trim().to_ascii_lowercase();
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    let mut emitted_status: Option<String> = None;
    if order_type == "pickup" {
        // Keyring-first; plaintext `local_settings` is backward-compat fallback.
        let acting_terminal_id = storage::get_credential("terminal_id")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                db::get_setting(&conn, "terminal", "terminal_id")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            });
        let current_status: String = conn
            .query_row(
                "SELECT COALESCE(status, 'pending')
                 FROM orders
                 WHERE id = ?1",
                rusqlite::params![order_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("load pickup conversion context: {e}"))?;
        order_ownership::assign_order_to_cashier_pickup(
            &conn,
            &order_id,
            acting_terminal_id.as_deref(),
            &now,
        )?;

        if let Some(removed_earning) =
            order_ownership::remove_driver_earning_for_order(&conn, &order_id)?
        {
            let _ = crate::sync_queue::clear_unsynced_items(
                &conn,
                "driver_earnings",
                removed_earning.id.as_str(),
            );

            if removed_earning.supabase_id.is_some() {
                let driver_sync_payload = serde_json::json!({
                    "id": removed_earning.id,
                    "supabase_id": removed_earning.supabase_id,
                    "order_id": order_id,
                    "deleted_at": now,
                });
                let _ = crate::sync_queue::enqueue_payload_item(
                    &conn,
                    "driver_earnings",
                    &removed_earning.id,
                    "DELETE",
                    &driver_sync_payload,
                    Some(1),
                    Some("financial"),
                    Some("manual"),
                    Some(1),
                );
            }
        }

        emitted_status = Some(if order_ownership::is_final_order_status(&current_status) {
            current_status
        } else if current_status.eq_ignore_ascii_case("out_for_delivery") {
            "ready".to_string()
        } else {
            current_status
        });
    } else {
        conn.execute(
            "UPDATE orders SET order_type = ?1, sync_status = 'pending', updated_at = ?2 WHERE id = ?3",
            rusqlite::params![order_type, now, order_id],
        )
        .map_err(|e| format!("update order type: {e}"))?;
    }
    let payload = serde_json::json!({
        "orderId": order_id,
        "orderType": order_type,
        "status": emitted_status,
        "driverId": serde_json::Value::Null,
        "driverName": serde_json::Value::Null
    });
    let _ = enqueue_order_sync_payload(&conn, &order_id, &payload);
    drop(conn);
    if let Some(ref status) = emitted_status {
        let _ = app.emit(
            "order_status_updated",
            serde_json::json!({
                "orderId": order_id_raw,
                "status": status,
            }),
        );
    }
    let _ = app.emit("order_realtime_update", payload);
    Ok(serde_json::json!({
        "success": true,
        "orderId": order_id_raw,
        "data": {
            "orderId": order_id_raw,
            "orderType": order_type,
            "status": emitted_status,
            "driverId": serde_json::Value::Null,
            "driverName": serde_json::Value::Null
        }
    }))
}

#[tauri::command]
pub async fn order_save_for_retry(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let mut payload = arg0.ok_or("Missing order payload")?;
    let order_id = payload
        .get("id")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if let Some(object) = payload.as_object_mut() {
        object.insert("id".to_string(), Value::String(order_id.clone()));
    }

    let queue_length = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        crate::sync_queue::enqueue_payload_item(
            &conn,
            "orders",
            &order_id,
            "INSERT",
            &payload,
            Some(0),
            Some("orders"),
            Some("server-wins"),
            Some(1),
        )?;
        crate::sync_queue::get_length(&conn)?
    };
    let _ = app.emit(
        "order_sync_conflict",
        serde_json::json!({ "queueLength": queue_length }),
    );
    Ok(serde_json::json!({ "success": true, "queueLength": queue_length }))
}

#[tauri::command]
pub async fn order_get_retry_queue(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let queue = crate::sync_queue::list_actionable_items(
        &conn,
        &crate::sync_queue::QueueListQuery {
            limit: Some(200),
            module_type: Some("orders".to_string()),
        },
    )?
    .into_iter()
    .filter(|item| item.table_name == "orders" && item.operation == "INSERT")
    .filter_map(|item| serde_json::from_str::<Value>(&item.data).ok())
    .collect::<Vec<_>>();
    Ok(serde_json::json!(queue))
}

#[tauri::command]
pub async fn order_process_retry_queue(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let (admin_url, api_key) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        // Keyring-first; plaintext `local_settings` entries are backward-compat
        // fallback for installs that haven't yet been hydrated to the keyring.
        let admin_url = storage::get_credential("admin_dashboard_url")
            .or_else(|| storage::get_credential("admin_url"))
            .or_else(|| db::get_setting(&conn, "terminal", "admin_dashboard_url"))
            .or_else(|| db::get_setting(&conn, "terminal", "admin_url"))
            .ok_or("Missing admin dashboard URL for retry processing")?;
        let api_key = storage::get_credential("pos_api_key")
            .or_else(|| storage::get_credential("api_key"))
            .or_else(|| db::get_setting(&conn, "terminal", "pos_api_key"))
            .or_else(|| db::get_setting(&conn, "terminal", "api_key"))
            .ok_or("Missing POS API key for retry processing")?;
        (admin_url, api_key)
    };

    let result = crate::sync_queue::process_queue(&db.conn, &admin_url, &api_key).await?;
    let queue_status = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        crate::sync_queue::get_status(&conn)?
    };
    let _ = app.emit(
        "sync_retry_scheduled",
        serde_json::json!({
            "processed": result.processed,
            "remaining": queue_status.total
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "processed": result.processed,
        "remaining": queue_status.total
    }))
}

#[tauri::command]
pub async fn orders_force_sync_retry(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?
    };
    let retry_result = force_order_sync_retry_inner(&db, &order_id)?;
    Ok(serde_json::json!({
        "success": true,
        "orderId": order_id_raw,
        "updated": retry_result.updated
    }))
}

#[tauri::command]
pub async fn orders_get_retry_info(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).unwrap_or(order_id_raw.clone());
    let mut stmt = conn
        .prepare(
            "SELECT id, status, attempts, error_message, created_at, last_attempt, next_retry_at
             FROM parity_sync_queue
             WHERE table_name = 'orders'
               AND record_id = ?1
               AND operation = 'UPDATE'
             ORDER BY created_at DESC
             LIMIT 5",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![order_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "status": row.get::<_, String>(1)?,
                "retryCount": row.get::<_, i64>(2)?,
                "maxRetries": crate::sync_queue::MAX_RETRY_ATTEMPTS,
                "lastError": row.get::<_, Option<String>>(3)?,
                "createdAt": row.get::<_, String>(4)?,
                "updatedAt": row.get::<_, Option<String>>(5)?.unwrap_or_else(|| row.get::<_, String>(4).unwrap_or_default()),
                "nextRetryAt": row.get::<_, Option<String>>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let entries: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!({
        "success": true,
        "orderId": order_id_raw,
        "entries": entries,
        "hasRetries": !entries.is_empty()
    }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_status_payload_supports_legacy_shape() {
        let parsed = parse_order_update_status_payload(
            Some(serde_json::json!("order-1")),
            Some("approved".to_string()),
        )
        .expect("legacy status payload should parse");
        assert_eq!(parsed.order_id, "order-1");
        assert_eq!(parsed.status, "approved");
        assert_eq!(parsed.estimated_time, None);
    }

    #[test]
    fn parse_status_payload_supports_object_with_fallback_status_arg() {
        let parsed = parse_order_update_status_payload(
            Some(serde_json::json!({
                "orderId": "order-2",
                "estimatedTime": 18
            })),
            Some("confirmed".to_string()),
        )
        .expect("object status payload should parse");
        assert_eq!(parsed.order_id, "order-2");
        assert_eq!(parsed.status, "confirmed");
        assert_eq!(parsed.estimated_time, Some(18));
    }

    #[test]
    fn parse_items_payload_supports_legacy_tuple_shape() {
        let parsed = parse_order_update_items_payload(
            Some(serde_json::json!("order-3")),
            Some(serde_json::json!([
                { "name": "Item", "quantity": 2, "price": 3.5 }
            ])),
        )
        .expect("legacy items payload should parse");
        assert_eq!(parsed.order_id, "order-3");
        assert_eq!(parsed.items.len(), 1);
        assert_eq!(parsed.order_notes, None);
    }

    #[test]
    fn parse_items_payload_rejects_non_array_items() {
        let err = parse_order_update_items_payload(
            Some(serde_json::json!({
                "orderId": "order-4",
                "items": "invalid"
            })),
            None,
        )
        .expect_err("non-array items should be rejected");
        assert!(err.contains("items must be an array"));
    }

    #[test]
    fn parse_delete_payload_supports_arg1_fallback() {
        let parsed =
            parse_order_delete_payload(Some(serde_json::json!({})), Some("order-5".into()))
                .expect("delete payload should parse");
        assert_eq!(parsed.order_id, "order-5");
    }

    #[test]
    fn parse_customer_info_payload_trims_and_normalizes_optional_fields() {
        let parsed = parse_order_update_customer_info_payload(Some(serde_json::json!({
            "orderId": " order-6 ",
            "customerName": "  Test Customer  ",
            "customerPhone": "  12345  ",
            "customerEmail": "   ",
            "deliveryAddress": "  Main St 42  ",
            "deliveryPostalCode": "  10558  ",
            "deliveryNotes": "  Ring once  ",
        })))
        .expect("customer info payload should parse");

        assert_eq!(parsed.order_id, "order-6");
        assert_eq!(parsed.customer_name, "Test Customer");
        assert_eq!(parsed.customer_phone, "12345");
        assert_eq!(parsed.customer_email, None);
        assert_eq!(parsed.delivery_address, "Main St 42");
        assert_eq!(parsed.delivery_postal_code.as_deref(), Some("10558"));
        assert_eq!(parsed.delivery_notes.as_deref(), Some("Ring once"));
    }

    #[test]
    fn parse_pickup_to_delivery_payload_trims_and_normalizes_fields() {
        let parsed = parse_pickup_to_delivery_conversion_payload(Some(serde_json::json!({
            "orderId": " order-7 ",
            "customerId": " customer-1 ",
            "customerName": "  Test Customer  ",
            "customerPhone": "  12345  ",
            "customerEmail": "  test@example.com  ",
            "deliveryAddress": "  Main St 42  ",
            "deliveryCity": "  Athens  ",
            "deliveryPostalCode": "  10558  ",
            "deliveryFloor": "  3  ",
            "deliveryNotes": "  Ring once  ",
            "nameOnRinger": "  Doorbell  ",
            "deliveryFee": 4.5,
            "totalAmount": 19.5
        })))
        .expect("pickup to delivery payload should parse");

        assert_eq!(parsed.order_id, "order-7");
        assert_eq!(parsed.customer_id.as_deref(), Some("customer-1"));
        assert_eq!(parsed.customer_name, "Test Customer");
        assert_eq!(parsed.customer_phone, "12345");
        assert_eq!(parsed.customer_email.as_deref(), Some("test@example.com"));
        assert_eq!(parsed.delivery_address, "Main St 42");
        assert_eq!(parsed.delivery_city.as_deref(), Some("Athens"));
        assert_eq!(parsed.delivery_postal_code.as_deref(), Some("10558"));
        assert_eq!(parsed.delivery_floor.as_deref(), Some("3"));
        assert_eq!(parsed.delivery_notes.as_deref(), Some("Ring once"));
        assert_eq!(parsed.name_on_ringer.as_deref(), Some("Doorbell"));
        assert!((parsed.delivery_fee - 4.5).abs() < 0.001);
        assert!((parsed.total_amount - 19.5).abs() < 0.001);
    }
}

#[cfg(test)]
mod transition_tests {
    use super::*;
    use crate::db;
    use rusqlite::{params, Connection};

    fn test_db() -> db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    fn insert_order(db: &db::DbState, order_id: &str, status: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES (?1, '[]', 10.0, ?2, 'pending', datetime('now'), datetime('now'))",
            params![order_id, status],
        )
        .unwrap();
    }

    fn insert_order_with_financials(
        db: &db::DbState,
        order_id: &str,
        items_json: &str,
        subtotal: f64,
        total_amount: f64,
        payment_method: &str,
        payment_status: &str,
    ) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                 id, items, subtotal, total_amount, status, payment_method, payment_status,
                 sync_status, created_at, updated_at
             ) VALUES (
                 ?1, ?2, ?3, ?4, 'completed', ?5, ?6, 'pending', datetime('now'), datetime('now')
             )",
            params![
                order_id,
                items_json,
                subtotal,
                total_amount,
                payment_method,
                payment_status
            ],
        )
        .unwrap();
    }

    fn insert_payment_adjustment_refund(
        conn: &Connection,
        adjustment_id: &str,
        payment_id: &str,
        order_id: &str,
        amount: f64,
    ) {
        conn.execute(
            "INSERT INTO payment_adjustments (
                 id, payment_id, order_id, adjustment_type, amount,
                 reason, staff_id, sync_state, created_at, updated_at
             ) VALUES (
                 ?1, ?2, ?3, 'refund', ?4,
                 'edit settlement test', NULL, 'pending', datetime('now'), datetime('now')
             )",
            params![adjustment_id, payment_id, order_id, amount],
        )
        .unwrap();
    }

    fn insert_pickup_order_for_conversion(db: &db::DbState, order_id: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                 id, order_number, items, subtotal, total_amount, status, order_type,
                 sync_status, created_at, updated_at
             ) VALUES (
                 ?1, '00001', '[]', 15.0, 15.0, 'pending', 'pickup',
                 'synced', datetime('now'), datetime('now')
             )",
            params![order_id],
        )
        .unwrap();
    }

    #[test]
    fn local_transition_validation_rejects_completed_to_cancelled() {
        let db = test_db();
        insert_order(&db, "order-completed", "completed");
        let conn = db.conn.lock().unwrap();

        let err = ensure_order_status_transition_allowed(&conn, "order-completed", "cancelled")
            .expect_err("completed -> cancelled should fail");
        assert!(is_invalid_status_transition_failure_message(&err));
    }

    #[test]
    fn local_transition_validation_rejects_delivered_to_cancelled() {
        let db = test_db();
        insert_order(&db, "order-delivered", "delivered");
        let conn = db.conn.lock().unwrap();

        let err = ensure_order_status_transition_allowed(&conn, "order-delivered", "cancelled")
            .expect_err("delivered -> cancelled should fail");
        assert!(is_invalid_status_transition_failure_message(&err));
    }

    #[test]
    fn local_transition_validation_allows_same_status_and_aliases() {
        let db = test_db();
        insert_order(&db, "order-same", "confirmed");
        insert_order(&db, "order-alias", "canceled");
        let conn = db.conn.lock().unwrap();

        let same = ensure_order_status_transition_allowed(&conn, "order-same", "confirmed")
            .expect("same status should be idempotent");
        assert_eq!(same, "confirmed");

        let alias = ensure_order_status_transition_allowed(&conn, "order-alias", "pending")
            .expect("cancelled alias should normalize");
        assert_eq!(alias, "cancelled");
        assert!(can_transition_locally("approved", "ready"));
    }

    #[test]
    fn completion_guard_detects_order_without_persisted_payment() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                     id, order_number, items, total_amount, status, payment_status, payment_method,
                     sync_status, created_at, updated_at
                 ) VALUES (
                     'order-unpaid-final', 'ORD-guard-1', '[]', 13.7, 'pending', 'pending', 'other',
                     'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }

        let conn = db.conn.lock().unwrap();
        let blockers =
            crate::payment_integrity::load_order_payment_blockers(&conn, "order-unpaid-final")
                .expect("blockers should load");

        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].order_number, "ORD-guard-1");
        assert_eq!(blockers[0].reason_code, "no_persisted_payment");

        let response = crate::payment_integrity::build_unsettled_payment_blocker_response(
            "Cannot mark order as completed",
            &blockers,
        );
        assert_eq!(response["success"], false);
        assert_eq!(response["errorCode"], "UNSETTLED_PAYMENT_BLOCKER");
    }

    #[test]
    fn force_retry_inserts_parity_fallback_when_no_actionable_rows_exist() {
        let db = test_db();
        insert_order(&db, "order-history", "completed");

        let result = force_order_sync_retry_inner(&db, "order-history").expect("force retry");
        assert_eq!(
            result,
            ForceOrderSyncRetryResult {
                updated: 0,
                inserted_fallback: true,
                blocked_by_invalid_transition: false,
            }
        );

        let conn = db.conn.lock().unwrap();
        let rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT status, data
                 FROM parity_sync_queue
                 WHERE table_name = 'orders' AND record_id = 'order-history'
                 ORDER BY created_at DESC",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .filter_map(|row| row.ok())
            .collect();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "pending");
        assert!(rows[0].1.contains("\"orderId\":\"order-history\""));
    }

    #[test]
    fn force_retry_does_not_insert_fallback_for_invalid_transition_blocker() {
        let db = test_db();
        insert_order(&db, "order-blocked", "cancelled");
        {
            let conn = db.conn.lock().unwrap();
            crate::sync_queue::enqueue_payload_item(
                &conn,
                "orders",
                "order-blocked",
                "UPDATE",
                &serde_json::json!({
                    "orderId": "order-blocked",
                    "status": "cancelled",
                }),
                Some(0),
                Some("orders"),
                Some("server-wins"),
                Some(1),
            )
            .unwrap();
            conn.execute(
                "UPDATE parity_sync_queue
                 SET status = 'failed',
                     attempts = 3,
                     error_message = 'Permanent status update failure: Invalid status transition'
                 WHERE table_name = 'orders'
                   AND record_id = 'order-blocked'",
                [],
            )
            .unwrap();
        }

        let result = force_order_sync_retry_inner(&db, "order-blocked").expect("force retry");
        assert_eq!(
            result,
            ForceOrderSyncRetryResult {
                updated: 0,
                inserted_fallback: false,
                blocked_by_invalid_transition: true,
            }
        );

        let conn = db.conn.lock().unwrap();
        let queue_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE table_name = 'orders' AND record_id = 'order-blocked'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let failed_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE table_name = 'orders'
                   AND record_id = 'order-blocked'
                   AND status = 'failed'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(queue_count, 1);
        assert_eq!(failed_count, 1);
    }

    #[test]
    fn enqueue_or_refresh_driver_earning_sync_row_replaces_stale_unsynced_rows() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        crate::sync_queue::enqueue_payload_item(
            &conn,
            "driver_earnings",
            "earning-1",
            "INSERT",
            &serde_json::json!({ "order_id": "order-old" }),
            Some(1),
            Some("financial"),
            Some("manual"),
            Some(1),
        )
        .unwrap();
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 3,
                 error_message = 'Parent shift not yet synced'
             WHERE table_name = 'driver_earnings'
               AND record_id = 'earning-1'",
            [],
        )
        .unwrap();

        let payload = serde_json::json!({
            "id": "earning-1",
            "driver_id": "driver-1",
            "staff_shift_id": "shift-new",
            "order_id": "order-new"
        });

        enqueue_or_refresh_driver_earning_sync_row(
            &conn,
            "earning-1",
            &payload,
            "2026-03-20T18:00:00Z",
        )
        .expect("refresh driver earning queue row");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE table_name = 'driver_earnings'
                   AND record_id = 'earning-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let (status, retry_count, last_error, payload_text): (String, i64, Option<String>, String) =
            conn.query_row(
                "SELECT status, attempts, error_message, data
                 FROM parity_sync_queue
                 WHERE table_name = 'driver_earnings'
                   AND record_id = 'earning-1'
                 LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(status, "pending");
        assert_eq!(retry_count, 0);
        assert_eq!(last_error, None);
        assert!(payload_text.contains("\"order_id\":\"order-new\""));
        assert!(payload_text.contains("\"staff_shift_id\":\"shift-new\""));
    }

    #[test]
    fn derive_next_order_totals_preserves_non_item_offsets() {
        let db = test_db();
        insert_order_with_financials(
            &db,
            "order-edit-offsets",
            r#"[{"name":"Crepe","quantity":1,"unit_price":10.0,"total_price":10.0}]"#,
            10.0,
            12.5,
            "cash",
            "paid",
        );

        let conn = db.conn.lock().unwrap();
        let (next_total, next_subtotal) = derive_next_order_totals(
            &conn,
            "order-edit-offsets",
            &[serde_json::json!({
                "name": "Crepe",
                "quantity": 1,
                "unit_price": 8.0,
                "total_price": 8.0
            })],
        )
        .expect("next totals");

        assert!((next_total - 10.5).abs() < 0.001);
        assert!((next_subtotal - 8.0).abs() < 0.001);
    }

    #[test]
    fn refresh_order_payment_snapshot_marks_edit_increase_as_partial() {
        let db = test_db();
        insert_order_with_financials(
            &db,
            "order-edit-partial",
            r#"[{"name":"Toast","quantity":1,"unit_price":10.0,"total_price":10.0}]"#,
            10.0,
            10.0,
            "cash",
            "paid",
        );

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, status, created_at, updated_at
             ) VALUES (
                 'payment-edit-partial', 'order-edit-partial', 'cash', 10.0, 'completed',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE orders
             SET total_amount = 12.0,
                 subtotal = 12.0,
                 updated_at = datetime('now')
             WHERE id = 'order-edit-partial'",
            [],
        )
        .unwrap();

        let (payment_status, payment_method, total_paid) =
            refresh_order_payment_snapshot(&conn, "order-edit-partial", "2026-03-20T12:00:00Z")
                .expect("refresh payment snapshot");

        assert_eq!(payment_status, "partially_paid");
        assert_eq!(payment_method, "split");
        assert!((total_paid - 10.0).abs() < 0.001);
    }

    #[test]
    fn determine_edit_settlement_required_action_selects_collect_refund_and_none() {
        assert_eq!(
            determine_edit_settlement_required_action(5.0, 6.9),
            "collect"
        );
        assert_eq!(
            determine_edit_settlement_required_action(7.4, 6.9),
            "refund"
        );
        assert_eq!(determine_edit_settlement_required_action(6.9, 6.9), "none");
    }

    #[test]
    fn resolve_stale_unsynced_overpay_payments_for_order_voids_unsynced_payment_after_total_drop() {
        let db = test_db();
        insert_order_with_financials(
            &db,
            "order-edit-stale",
            r#"[{"name":"Toast","quantity":1,"unit_price":10.0,"total_price":10.0}]"#,
            10.0,
            10.0,
            "split",
            "partially_paid",
        );

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'payment-edit-stale', 'order-edit-stale', 'cash', 7.4, 'completed',
                 'failed', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status, error_message
             ) VALUES (
                 'queue-payment-edit-stale', 'payments', 'payment-edit-stale', 'INSERT', '{}', 'org-test',
                 datetime('now'), 5, 1000, 1, 'financial',
                 'manual', 1, 'failed', 'Payment exceeds order total'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status, error_message
             ) VALUES (
                 'queue-payment-edit-stale-compat', 'order_payments', 'payment-edit-stale', 'INSERT', '{}', 'org-test',
                 datetime('now'), 5, 1000, 1, 'financial',
                 'manual', 1, 'failed', 'Payment exceeds order total'
             )",
            [],
        )
        .unwrap();

        update_order_items_in_connection(
            &conn,
            "order-edit-stale",
            &[serde_json::json!({
                "name": "Toast",
                "quantity": 1,
                "unit_price": 6.9,
                "total_price": 6.9
            })],
            None,
            6.9,
            6.9,
            "2026-03-28T10:00:00Z",
        )
        .unwrap();

        let resolved_ids = resolve_stale_unsynced_overpay_payments_for_order(
            &conn,
            "order-edit-stale",
            "2026-03-28T10:00:00Z",
        )
        .expect("resolve stale payment rows");
        assert_eq!(resolved_ids, vec!["payment-edit-stale".to_string()]);

        let (status, sync_status, sync_state): (String, String, String) = conn
            .query_row(
                "SELECT status, sync_status, sync_state
                 FROM order_payments
                 WHERE id = 'payment-edit-stale'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "voided");
        assert_eq!(sync_status, "synced");
        assert_eq!(sync_state, "applied");

        let remaining_queue_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM parity_sync_queue
                 WHERE record_id = 'payment-edit-stale'
                   AND table_name IN ('payments', 'order_payments')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_queue_rows, 0);

        let (payment_status, payment_method, total_paid) =
            refresh_order_payment_snapshot(&conn, "order-edit-stale", "2026-03-28T10:00:00Z")
                .expect("refresh payment snapshot after stale cleanup");
        assert_eq!(payment_status, "pending");
        assert_eq!(payment_method, "pending");
        assert!(total_paid.abs() < 0.001);
    }

    #[test]
    fn load_net_paid_for_order_subtracts_prior_refunds() {
        let db = test_db();
        insert_order_with_financials(
            &db,
            "order-net-paid",
            r#"[{"name":"Crepe","quantity":1,"unit_price":12.8,"total_price":12.8}]"#,
            12.8,
            12.8,
            "card",
            "paid",
        );

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, status, created_at, updated_at
             ) VALUES (
                 'payment-net-paid', 'order-net-paid', 'card', 12.8, 'completed',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        insert_payment_adjustment_refund(
            &conn,
            "adjustment-net-paid",
            "payment-net-paid",
            "order-net-paid",
            10.9,
        );

        let completed_payments =
            list_completed_payments_for_edit(&conn, "order-net-paid").expect("completed payments");
        assert_eq!(completed_payments.len(), 1);
        let remaining_refundable = completed_payments[0]
            .get("remainingRefundable")
            .and_then(serde_json::Value::as_f64)
            .expect("remaining refundable");
        assert!((remaining_refundable - 1.9).abs() < 0.001);

        let net_paid = load_net_paid_for_order(&conn, "order-net-paid").expect("net paid");
        assert!((net_paid - 1.9).abs() < 0.001);
    }

    #[test]
    fn refresh_order_payment_snapshot_uses_net_paid_after_prior_refunds() {
        let db = test_db();
        insert_order_with_financials(
            &db,
            "order-edit-refunded",
            r#"[{"name":"Crepe","quantity":1,"unit_price":4.7,"total_price":4.7}]"#,
            4.7,
            4.7,
            "card",
            "paid",
        );

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, status, created_at, updated_at
             ) VALUES (
                 'payment-edit-refunded', 'order-edit-refunded', 'card', 12.8, 'completed',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        insert_payment_adjustment_refund(
            &conn,
            "adjustment-edit-refunded",
            "payment-edit-refunded",
            "order-edit-refunded",
            10.9,
        );

        let (payment_status, payment_method, total_paid) =
            refresh_order_payment_snapshot(&conn, "order-edit-refunded", "2026-03-24T16:55:00Z")
                .expect("refresh payment snapshot");

        assert_eq!(payment_status, "partially_paid");
        assert_eq!(payment_method, "split");
        assert!((total_paid - 1.9).abs() < 0.001);
    }

    #[test]
    fn order_update_financials_flow_voids_stale_unsynced_payment_after_total_drop() {
        let db = test_db();
        insert_order_with_financials(
            &db,
            "order-financial-drop",
            r#"[{"name":"Toast","quantity":1,"unit_price":10.0,"total_price":10.0}]"#,
            10.0,
            10.0,
            "split",
            "partially_paid",
        );

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'payment-financial-drop', 'order-financial-drop', 'cash', 7.4, 'completed',
                 'failed', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status, error_message
             ) VALUES (
                 'queue-payment-financial-drop', 'payments', 'payment-financial-drop', 'INSERT', '{}', 'org-test',
                 datetime('now'), 5, 1000, 1, 'financial',
                 'manual', 1, 'failed', 'Payment exceeds order total'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status, error_message
             ) VALUES (
                 'queue-payment-financial-drop-compat', 'order_payments', 'payment-financial-drop', 'INSERT', '{}', 'org-test',
                 datetime('now'), 5, 1000, 1, 'financial',
                 'manual', 1, 'failed', 'Payment exceeds order total'
             )",
            [],
        )
        .unwrap();

        let now = "2026-04-16T09:39:05Z";
        conn.execute(
            "UPDATE orders
             SET total_amount = 6.9,
                 subtotal = 6.9,
                 discount_amount = 0,
                 discount_percentage = 0,
                 tax_amount = 0,
                 delivery_fee = 0,
                 tip_amount = 0,
                 sync_status = 'pending',
                 updated_at = ?2
             WHERE id = ?1",
            rusqlite::params!["order-financial-drop", now],
        )
        .unwrap();

        let stale_payment_ids =
            resolve_stale_unsynced_overpay_payments_for_order(&conn, "order-financial-drop", now)
                .expect("void stale payment during financial update");
        let (payment_status, payment_method, paid_total) =
            refresh_order_payment_snapshot(&conn, "order-financial-drop", now)
                .expect("refresh payment snapshot");
        enqueue_order_sync_payload(
            &conn,
            "order-financial-drop",
            &serde_json::json!({
                "orderId": "order-financial-drop",
                "totalAmount": 6.9,
                "subtotal": 6.9,
                "discountAmount": 0.0,
                "discountPercentage": 0.0,
                "taxAmount": 0.0,
                "deliveryFee": 0.0,
                "tipAmount": 0.0,
                "paymentStatus": payment_status,
                "paymentMethod": payment_method,
            }),
        )
        .expect("enqueue order financial sync");

        assert_eq!(
            stale_payment_ids,
            vec!["payment-financial-drop".to_string()]
        );
        assert_eq!(payment_status, "pending");
        assert_eq!(payment_method, "pending");
        assert!(paid_total.abs() < 0.001);

        let (payment_row_status, payment_row_sync_status, payment_row_sync_state): (
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT status, sync_status, sync_state
                 FROM order_payments
                 WHERE id = 'payment-financial-drop'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(payment_row_status, "voided");
        assert_eq!(payment_row_sync_status, "synced");
        assert_eq!(payment_row_sync_state, "applied");
    }

    #[test]
    fn convert_pickup_order_to_delivery_updates_order_and_enqueues_single_sync_row() {
        let db = test_db();
        insert_pickup_order_for_conversion(&db, "order-convert");

        let (order_id, order_json) = convert_pickup_order_to_delivery_inner(
            &db,
            PickupToDeliveryConversionPayload {
                order_id: "order-convert".into(),
                customer_id: Some("customer-1".into()),
                customer_name: "Alice".into(),
                customer_phone: "123456".into(),
                customer_email: Some("alice@example.com".into()),
                delivery_address: "Main St 42".into(),
                delivery_city: Some("Athens".into()),
                delivery_postal_code: Some("10558".into()),
                delivery_floor: Some("3".into()),
                delivery_notes: Some("Side door".into()),
                name_on_ringer: Some("Alice".into()),
                delivery_fee: 4.0,
                total_amount: 19.0,
            },
        )
        .expect("convert pickup order to delivery");

        assert_eq!(order_id, "order-convert");
        assert_eq!(
            order_json.get("orderType").and_then(|value| value.as_str()),
            Some("delivery")
        );
        assert_eq!(
            order_json
                .get("customerId")
                .and_then(|value| value.as_str()),
            Some("customer-1")
        );
        assert_eq!(
            order_json
                .get("deliveryAddress")
                .and_then(|value| value.as_str()),
            Some("Main St 42")
        );
        assert_eq!(
            order_json
                .get("deliveryCity")
                .and_then(|value| value.as_str()),
            Some("Athens")
        );
        assert_eq!(
            order_json
                .get("deliveryFloor")
                .and_then(|value| value.as_str()),
            Some("3")
        );

        let conn = db.conn.lock().unwrap();
        let (
            order_type,
            customer_id,
            delivery_address,
            delivery_city,
            delivery_floor,
            delivery_fee,
            total_amount,
            sync_status,
        ): (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            f64,
            f64,
            String,
        ) = conn
            .query_row(
                "SELECT
                     order_type,
                     customer_id,
                     delivery_address,
                     delivery_city,
                     delivery_floor,
                     delivery_fee,
                     total_amount,
                     sync_status
                 FROM orders
                 WHERE id = 'order-convert'",
                [],
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
                    ))
                },
            )
            .unwrap();

        assert_eq!(order_type, "delivery");
        assert_eq!(customer_id.as_deref(), Some("customer-1"));
        assert_eq!(delivery_address.as_deref(), Some("Main St 42"));
        assert_eq!(delivery_city.as_deref(), Some("Athens"));
        assert_eq!(delivery_floor.as_deref(), Some("3"));
        assert!((delivery_fee - 4.0).abs() < 0.001);
        assert!((total_amount - 19.0).abs() < 0.001);
        assert_eq!(sync_status, "pending");

        let (queue_count, payload_text): (i64, Option<String>) = conn
            .query_row(
                "SELECT COUNT(*), MIN(data)
                 FROM parity_sync_queue
                 WHERE table_name = 'orders'
                   AND record_id = 'order-convert'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(queue_count, 1);
        let payload_text = payload_text.expect("queued parity payload");
        assert!(payload_text.contains("\"customerId\":\"customer-1\""));
        assert!(payload_text.contains("\"orderType\":\"delivery\""));
    }

    #[test]
    fn invalid_pickup_to_delivery_payload_does_not_mutate_order() {
        let db = test_db();
        insert_pickup_order_for_conversion(&db, "order-unchanged");

        let err = parse_pickup_to_delivery_conversion_payload(Some(serde_json::json!({
            "orderId": "order-unchanged",
            "customerName": "Alice",
            "customerPhone": "123456",
            "deliveryAddress": "Main St 42",
            "deliveryFee": -1,
            "totalAmount": 19.0
        })))
        .expect_err("negative delivery fee should be rejected");
        assert!(err.contains("Invalid deliveryFee"));

        let conn = db.conn.lock().unwrap();
        let (order_type, total_amount, queue_count): (String, f64, i64) = conn
            .query_row(
                "SELECT
                     order_type,
                     total_amount,
                     (SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'order' AND entity_id = 'order-unchanged')
                 FROM orders
                 WHERE id = 'order-unchanged'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(order_type, "pickup");
        assert!((total_amount - 15.0).abs() < 0.001);
        assert_eq!(queue_count, 0);
    }
}
