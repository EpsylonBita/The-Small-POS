use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::money::Cents;
use crate::{
    can_transition_locally, db, fetch_supabase_rows, normalize_status_for_storage, order_ownership,
    payload_arg0_as_string, payment_integrity, payments, print, read_local_json_array, refunds,
    resolve_order_id, storage, sync, value_f64, value_i64, value_str, write_local_json,
};

/// Apply authoritative table/check identity and persist its scoped server ledger.
#[tauri::command]
pub fn orders_apply_table_session_snapshot(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = arg0.ok_or("Missing table session snapshot")?;
    let result = {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        let result = crate::sync_queue::apply_table_session_snapshot(&conn, &payload)?;
        if let Some(session) = payload.get("session") {
            // Missing proof prevents offline use; it must not discard an online
            // response or replace it with a reconstructed parent-order check.
            if let Err(error) = crate::table_session_cache::save(&conn, session) {
                tracing::warn!(error = %error, "Scoped table check could not be cached");
            }
        }
        result
    };
    if result.get("applied").and_then(Value::as_bool) == Some(true) {
        let _ = app.emit("order_realtime_update", &result);
    }
    Ok(result)
}

#[tauri::command]
pub fn orders_get_table_session_snapshot(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let request = arg0.ok_or("Missing table cache request")?;
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    crate::table_session_cache::load(&conn, &request)
}

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
    /// Reason text supplied when the operator cancels the order. Persisted on
    /// the local row and included in the outbound sync payload so the admin
    /// dashboard can store and display it. Ignored for non-cancellation status
    /// transitions.
    #[serde(
        default,
        alias = "cancellation_reason",
        alias = "cancelReason",
        alias = "cancel_reason",
        alias = "reason"
    )]
    cancellation_reason: Option<String>,
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
    #[serde(default, alias = "expected_version")]
    expected_version: Option<i64>,
    #[serde(default, alias = "table_session_id")]
    table_session_id: Option<String>,
    #[serde(default, alias = "client_event_id")]
    client_event_id: Option<String>,
}

#[derive(Debug)]
struct OrderUpdateItemsPayload {
    order_id: String,
    items: Vec<serde_json::Value>,
    order_notes: Option<String>,
    expected_version: Option<i64>,
    table_session_id: Option<String>,
    client_event_id: Option<String>,
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
    #[serde(default, alias = "customer_id")]
    customer_id: Option<String>,
    #[serde(alias = "customer_name")]
    customer_name: String,
    #[serde(default, alias = "customer_email")]
    customer_email: Option<String>,
    #[serde(alias = "customer_phone")]
    customer_phone: String,
    #[serde(alias = "delivery_address")]
    #[serde(alias = "address")]
    delivery_address: String,
    #[serde(default, alias = "delivery_address_id")]
    delivery_address_id: Option<String>,
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
    #[serde(default, alias = "delivery_latitude")]
    delivery_latitude: Option<f64>,
    #[serde(default, alias = "delivery_longitude")]
    delivery_longitude: Option<f64>,
    #[serde(default, alias = "delivery_address_fingerprint")]
    delivery_address_fingerprint: Option<String>,
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
    #[serde(default, alias = "delivery_address_id")]
    delivery_address_id: Option<String>,
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
    #[serde(default, alias = "delivery_latitude")]
    delivery_latitude: Option<f64>,
    #[serde(default, alias = "delivery_longitude")]
    delivery_longitude: Option<f64>,
    #[serde(default, alias = "delivery_address_fingerprint")]
    delivery_address_fingerprint: Option<String>,
    #[serde(default, alias = "delivery_zone_id")]
    delivery_zone_id: Option<String>,
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

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct EditSettlementOrderUpdatesPayload {
    #[serde(default)]
    order_type: Option<String>,
    #[serde(default)]
    customer_id: Option<serde_json::Value>,
    #[serde(default)]
    customer_name: Option<serde_json::Value>,
    #[serde(default)]
    customer_phone: Option<serde_json::Value>,
    #[serde(default)]
    customer_email: Option<serde_json::Value>,
    #[serde(default)]
    delivery_address: Option<serde_json::Value>,
    #[serde(default)]
    delivery_city: Option<serde_json::Value>,
    #[serde(default)]
    delivery_postal_code: Option<serde_json::Value>,
    #[serde(default)]
    delivery_floor: Option<serde_json::Value>,
    #[serde(default)]
    delivery_notes: Option<serde_json::Value>,
    #[serde(default)]
    name_on_ringer: Option<serde_json::Value>,
    #[serde(default)]
    delivery_fee: Option<f64>,
    #[serde(default)]
    table_number: Option<serde_json::Value>,
    #[serde(default)]
    waiter_id: Option<serde_json::Value>,
    #[serde(default)]
    driver_id: Option<serde_json::Value>,
    #[serde(default)]
    driver_name: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct EditSettlementFinancialsPayload {
    #[serde(default, alias = "total_amount")]
    total_amount: Option<f64>,
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
    #[serde(default, alias = "order_updates")]
    order_updates: Option<EditSettlementOrderUpdatesPayload>,
    #[serde(default)]
    financials: Option<EditSettlementFinancialsPayload>,
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
    order_updates: Option<EditSettlementOrderUpdatesPayload>,
    financials: Option<EditSettlementFinancialsPayload>,
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

fn attach_kiosk_payment_method_to_metadata(
    raw_metadata: Option<&Value>,
    payment_method: Option<&str>,
) -> Option<String> {
    let mut metadata = match raw_metadata? {
        Value::Null => return None,
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(parsed) => parsed,
                Err(_) => return Some(trimmed.to_string()),
            }
        }
        value => value.clone(),
    };

    if let Some(method) = payment_method
        .map(str::trim)
        .filter(|method| matches!(*method, "cash" | "card" | "room_charge"))
    {
        if let Some(kiosk) = metadata.get_mut("kiosk").and_then(Value::as_object_mut) {
            kiosk.insert(
                "paymentMethod".to_string(),
                Value::String(method.to_string()),
            );
            kiosk.insert(
                "payment_method".to_string(),
                Value::String(method.to_string()),
            );
        }
    }

    Some(metadata.to_string())
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
    ensure_order_status_transition_with_room_confirmation(conn, order_id, next_status, false)
}

fn ensure_order_status_transition_with_room_confirmation(
    conn: &rusqlite::Connection,
    order_id: &str,
    next_status: &str,
    room_charge_confirmed: bool,
) -> Result<String, String> {
    let previous_status = load_canonical_order_status(conn, order_id)?;
    let next_status = normalize_status_for_storage(next_status);

    if previous_status == "pending"
        && !room_charge_confirmed
        && matches!(
            next_status.as_str(),
            "confirmed" | "preparing" | "ready" | "out_for_delivery" | "delivered" | "completed"
        )
    {
        if order_requests_room_charge(conn, order_id)? {
            return Err(
                "ROOM_CHARGE_UNAVAILABLE: use online approval to confirm the room bill first"
                    .into(),
            );
        }
    }

    if can_transition_locally(&previous_status, &next_status) {
        Ok(previous_status)
    } else {
        Err(format!(
            "Invalid status transition: {previous_status} -> {next_status}"
        ))
    }
}

#[derive(Clone, Copy)]
enum BoxOrderMutation<'a> {
    Generic,
    Accept(Option<i64>),
    Reject(Option<&'a str>),
    NotifyReady,
}

/// Runs before status, drawer, earnings or network side effects. The canonical
/// plugin wins; older platform rows can carry it in ghost metadata instead.
fn is_box_order(conn: &rusqlite::Connection, order_id: &str) -> Result<bool, String> {
    let (plugin, metadata): (String, String) = conn
        .query_row(
            "SELECT COALESCE(plugin, ''), COALESCE(ghost_metadata, '') FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("load BOX order context: {e}"))?;
    let metadata: Value = serde_json::from_str(&metadata).unwrap_or(Value::Null);
    let platform = if plugin.trim().is_empty() {
        metadata
            .pointer("/food_delivery/platform")
            .and_then(Value::as_str)
            .unwrap_or("")
    } else {
        plugin.as_str()
    };
    Ok(matches!(
        platform.trim().to_ascii_lowercase().as_str(),
        "box" | "box_gr" | "boxgr"
    ))
}

fn ensure_box_order_mutation_allowed(
    conn: &rusqlite::Connection,
    order_id: &str,
    next_status: &str,
    mutation: BoxOrderMutation<'_>,
) -> Result<(), String> {
    if !is_box_order(conn, order_id)? {
        return Ok(());
    }

    let current = load_canonical_order_status(conn, order_id)?;
    let next = normalize_status_for_storage(next_status);
    let allowed = match mutation {
        BoxOrderMutation::Accept(estimate) => {
            current == "pending"
                && next == "confirmed"
                && estimate.is_some_and(|minutes| minutes > 0)
        }
        BoxOrderMutation::Reject(reason) => {
            static REASONS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
            let reasons = REASONS.get_or_init(|| {
                serde_json::from_str(include_str!(
                    "../../../../shared/box-rejection-reasons.json"
                ))
                .expect("shared BOX rejection reasons must be a valid JSON string array")
            });
            current == "pending"
                && next == "cancelled"
                && reason.is_some_and(|value| reasons.iter().any(|official| official == value))
        }
        BoxOrderMutation::NotifyReady => false,
        BoxOrderMutation::Generic => {
            if matches!(current.as_str(), "cancelled" | "rejected") {
                false
            } else if current == "pending" {
                next == "pending"
            } else {
                !matches!(next.as_str(), "cancelled" | "rejected" | "pending")
            }
        }
    };
    if allowed {
        Ok(())
    } else {
        Err("BOX requires a pending accept with estimate or an exact rejection reason; decisions are final and platform-ready notification is unsupported".into())
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

const REPAIR_SETTLEMENT_ROUTE_REQUIRED: &str = "REPAIR_SETTLEMENT_ROUTE_REQUIRED";

fn ensure_renderer_order_payload_is_not_repair_settlement(payload: &Value) -> Result<(), String> {
    let is_repair_settlement = value_str(payload, &["order_context", "orderContext"])
        .is_some_and(|context| context.trim().eq_ignore_ascii_case("repair_settlement"));
    if is_repair_settlement {
        return Err(REPAIR_SETTLEMENT_ROUTE_REQUIRED.to_string());
    }
    if let Some(order_data) = payload.get("orderData") {
        ensure_renderer_order_payload_is_not_repair_settlement(order_data)?;
    }
    Ok(())
}

fn ensure_renderer_order_is_not_repair_settlement(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<(), String> {
    let is_repair_settlement = conn
        .query_row(
            "SELECT lower(trim(COALESCE(order_context, ''))) = 'repair_settlement'
             FROM orders
             WHERE id = ?1 OR supabase_id = ?1
             LIMIT 1",
            [order_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map_err(|error| format!("read renderer order context: {error}"))?
        .unwrap_or(false);
    if is_repair_settlement {
        return Err(REPAIR_SETTLEMENT_ROUTE_REQUIRED.to_string());
    }
    Ok(())
}

fn order_has_current_table_binding(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<bool, String> {
    conn.query_row("SELECT NULLIF(TRIM(COALESCE(table_id,'')),'') IS NOT NULL OR NULLIF(TRIM(COALESCE(table_session_id,'')),'') IS NOT NULL OR (order_type IN ('dine-in','dine_in') AND NULLIF(TRIM(COALESCE(table_number,'')),'') IS NOT NULL) FROM orders WHERE id=?1",
        [order_id],|row|row.get(0)).map_err(|error|format!("Read canonical table binding before mutation: {error}"))
}

fn ensure_generic_table_cancellation_allowed(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<(), String> {
    if order_has_current_table_binding(conn, order_id)? {
        return Err("TABLE_ORDER_CANONICAL_CANCEL_REQUIRED: Open Tables and cancel the bound check with staff approval. The order and table were not changed.".into());
    }
    Ok(())
}

fn ensure_table_history_delete_allowed(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<(), String> {
    let refusal="TABLE_ORDER_HISTORY_DELETE_REFUSED: Table order history must be retained. Open Tables to cancel or settle the check; the order was not deleted.";
    if order_has_current_table_binding(conn, order_id)? {
        return Err(refusal.into());
    }
    let (remote,organization,branch,owner):(Option<String>,Option<String>,Option<String>,Option<String>)=conn.query_row("SELECT supabase_id,organization_id,branch_id,owner_terminal_id FROM orders WHERE id=?1",[order_id],
        |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(|error|error.to_string())?;
    if crate::table_session_cache::has_order_history(
        conn,
        order_id,
        remote.as_deref(),
        organization.as_deref(),
        branch.as_deref(),
        owner.as_deref(),
    )? {
        return Err(refusal.into());
    }
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='table_session_snapshots_v1')",[],|row|row.get(0)).map_err(|error|error.to_string())?;
    if !exists {
        return Ok(());
    }
    let mut statement=conn.prepare("SELECT snapshot_json FROM table_session_snapshots_v1 WHERE (?1 IS NULL OR organization_id=?1) AND (?2 IS NULL OR branch_id=?2)").map_err(|error|error.to_string())?;
    let snapshots = statement
        .query_map(rusqlite::params![organization, branch], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?;
    let matches =
        |id: Option<&str>| id.is_some_and(|id| id == order_id || remote.as_deref() == Some(id));
    for raw in snapshots {
        let snapshot: Value = serde_json::from_str(&raw.map_err(|error| error.to_string())?)
            .map_err(|_| {
                "Table history is unreadable; reconnect and restore it before deleting an order"
            })?;
        if matches(snapshot.get("active_order_id").and_then(Value::as_str))
            || matches(snapshot.pointer("/order/id").and_then(Value::as_str))
            || snapshot
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| matches(item.get("order_id").and_then(Value::as_str)))
                })
        {
            return Err(refusal.into());
        }
    }
    Ok(())
}

fn resolve_renderer_deletable_order_id(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<Option<String>, String> {
    let row = conn
        .query_row(
            "SELECT id, lower(trim(COALESCE(order_context, '')))
             FROM orders
             WHERE id = ?1 OR supabase_id = ?1
             LIMIT 1",
            [order_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("resolve renderer deletable order: {error}"))?;
    match row {
        Some((_, context)) if context == "repair_settlement" => {
            Err(REPAIR_SETTLEMENT_ROUTE_REQUIRED.to_string())
        }
        Some((id, _)) => {
            ensure_table_history_delete_allowed(conn, &id)?;
            Ok(Some(id))
        }
        None => Ok(None),
    }
}

fn resolve_renderer_order_id(
    conn: &rusqlite::Connection,
    order_id_raw: &str,
) -> Result<String, String> {
    let row = conn
        .query_row(
            "SELECT id, lower(trim(COALESCE(order_context, '')))
             FROM orders
             WHERE id = ?1 OR supabase_id = ?1
             LIMIT 1",
            [order_id_raw],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("resolve renderer order: {error}"))?;
    match row {
        Some((_, context)) if context == "repair_settlement" => {
            Err(REPAIR_SETTLEMENT_ROUTE_REQUIRED.to_string())
        }
        Some((id, _)) => Ok(id),
        None => Err("Order not found".to_string()),
    }
}

fn ensure_renderer_payload_does_not_target_existing_repair_settlement(
    conn: &rusqlite::Connection,
    payload: &Value,
) -> Result<(), String> {
    ensure_renderer_order_payload_is_not_repair_settlement(payload)?;

    let mut identities = Vec::new();
    for keys in [
        &["id", "orderId", "order_id", "supabaseId", "supabase_id"][..],
        &[
            "clientRequestId",
            "client_request_id",
            "clientOrderId",
            "client_order_id",
        ][..],
        &[
            "orderNumber",
            "order_number",
            "displayOrderNumber",
            "display_order_number",
        ][..],
    ] {
        push_unique_identity(&mut identities, value_str(payload, keys));
    }

    for identity in identities {
        let targets_repair = conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1
                     FROM orders
                     WHERE (id = ?1
                            OR supabase_id = ?1
                            OR client_request_id = ?1
                            OR order_number = ?1
                            OR display_order_number = ?1)
                       AND lower(trim(COALESCE(order_context, ''))) = 'repair_settlement'
                 )",
                [identity],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("check renderer order payload identity: {error}"))?;
        if targets_repair {
            return Err(REPAIR_SETTLEMENT_ROUTE_REQUIRED.to_string());
        }
    }

    Ok(())
}

fn force_order_sync_retry_inner(
    db: &db::DbState,
    order_id: &str,
) -> Result<ForceOrderSyncRetryResult, String> {
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        ensure_renderer_order_is_not_repair_settlement(&conn, order_id)?;
    }
    sync::cleanup_order_update_queue_rows_for_order(db, Some(order_id))?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, status, lower(COALESCE(error_message, ''))
             FROM parity_sync_queue
             WHERE table_name = 'orders'
               AND record_id = ?1
               AND operation = 'UPDATE'
               AND COALESCE(module_type, '') <> 'repairs'
               AND table_name NOT IN ('repairs', 'repair_attachments')",
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
        crate::sync_queue::renderer_retry_item(&conn, item_id)?;
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

fn delete_renderer_order_delete_queue_rows(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM parity_sync_queue
         WHERE table_name = 'orders'
           AND operation = 'DELETE'
           AND (record_id = ?1 OR status IN ('pending', 'processing', 'failed', 'conflict'))
           AND COALESCE(module_type, '') <> 'repairs'
           AND table_name NOT IN ('repairs', 'repair_attachments')
           AND NOT EXISTS (
               SELECT 1 FROM orders
               WHERE (orders.id = parity_sync_queue.record_id
                      OR orders.supabase_id = parity_sync_queue.record_id)
                 AND lower(trim(COALESCE(orders.order_context, ''))) = 'repair_settlement'
           )",
        rusqlite::params![order_id],
    )
    .map_err(|e| format!("delete renderer order queue rows: {e}"))
}

fn ensure_renderer_retry_processing_contains_no_repair_settlement_rows(
    conn: &rusqlite::Connection,
) -> Result<(), String> {
    let contains_repair_settlement = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1
                 FROM parity_sync_queue queue
                 JOIN orders
                   ON orders.id = queue.record_id OR orders.supabase_id = queue.record_id
                 WHERE queue.status IN ('pending', 'processing', 'failed', 'conflict')
                   AND queue.table_name = 'orders'
                   AND COALESCE(queue.module_type, '') <> 'repairs'
                   AND lower(trim(COALESCE(orders.order_context, ''))) = 'repair_settlement'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("check renderer retry repair settlement rows: {error}"))?;
    if contains_repair_settlement {
        return Err(REPAIR_SETTLEMENT_ROUTE_REQUIRED.to_string());
    }
    Ok(())
}

fn enqueue_order_sync_payload(
    conn: &rusqlite::Connection,
    order_id: &str,
    payload: &Value,
) -> Result<(), String> {
    ensure_renderer_order_payload_is_not_repair_settlement(payload)?;
    ensure_renderer_order_is_not_repair_settlement(conn, order_id)?;
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

fn resolve_order_id_with_remote(
    conn: &rusqlite::Connection,
    order_id_raw: &str,
) -> Result<(String, Option<String>), String> {
    let row = conn
        .query_row(
            "SELECT id, NULLIF(TRIM(COALESCE(supabase_id, '')), ''),
                lower(trim(COALESCE(order_context, '')))
         FROM orders
         WHERE id = ?1 OR supabase_id = ?1
         LIMIT 1",
            rusqlite::params![order_id_raw],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("resolve renderer order with remote identity: {error}"))?;
    match row {
        Some((_, _, context)) if context == "repair_settlement" => {
            Err(REPAIR_SETTLEMENT_ROUTE_REQUIRED.to_string())
        }
        Some((id, remote_id, _)) => Ok((id, remote_id)),
        None => Err("Order not found".to_string()),
    }
}

fn push_unique_identity(candidates: &mut Vec<String>, value: Option<String>) {
    let Some(value) = normalize_optional_text(value) else {
        return;
    };
    if !candidates.iter().any(|candidate| candidate == &value) {
        candidates.push(value);
    }
}

fn value_bool_any(source: &Value, keys: &[&str]) -> Option<bool> {
    for key in keys {
        let Some(value) = source.get(*key) else {
            continue;
        };
        if let Some(flag) = value.as_bool() {
            return Some(flag);
        }
        if let Some(flag) = value.as_i64() {
            return Some(flag != 0);
        }
        if let Some(raw) = value.as_str() {
            let normalized = raw.trim().to_ascii_lowercase();
            if matches!(normalized.as_str(), "true" | "1" | "yes" | "on") {
                return Some(true);
            }
            if matches!(normalized.as_str(), "false" | "0" | "no" | "off") {
                return Some(false);
            }
        }
    }
    None
}

fn remote_order_client_identity_candidates(order_data: &Value) -> Vec<String> {
    let mut candidates = Vec::new();
    for keys in [
        &["client_order_id", "clientOrderId"][..],
        &["client_request_id", "clientRequestId"][..],
        &["local_order_id", "localOrderId"][..],
    ] {
        push_unique_identity(&mut candidates, value_str(order_data, keys));
    }
    candidates
}

fn remote_order_number_identity_candidates(order_data: &Value) -> Vec<String> {
    let mut candidates = Vec::new();
    for keys in [
        &["order_number", "orderNumber"][..],
        &["display_order_number", "displayOrderNumber"][..],
    ] {
        push_unique_identity(&mut candidates, value_str(order_data, keys));
    }
    candidates
}

fn resolve_existing_local_order_for_remote(
    conn: &rusqlite::Connection,
    remote_id: &str,
    order_data: &Value,
) -> Result<Option<String>, String> {
    if let Some(local_id) = conn
        .query_row(
            "SELECT id FROM orders WHERE supabase_id = ?1 OR id = ?1 LIMIT 1",
            rusqlite::params![remote_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("resolve remote order by remote id: {e}"))?
    {
        return Ok(Some(local_id));
    }

    for client_id in remote_order_client_identity_candidates(order_data) {
        if let Some(local_id) = conn
            .query_row(
                "SELECT id
                 FROM orders
                 WHERE id = ?1 OR client_request_id = ?1
                 LIMIT 1",
                rusqlite::params![client_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("resolve remote order by client identity: {e}"))?
        {
            return Ok(Some(local_id));
        }
    }

    for order_number in remote_order_number_identity_candidates(order_data) {
        if let Some(local_id) = conn
            .query_row(
                "SELECT id
                 FROM orders
                 WHERE order_number = ?1 OR display_order_number = ?1
                 LIMIT 1",
                rusqlite::params![order_number],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("resolve remote order by order number: {e}"))?
        {
            return Ok(Some(local_id));
        }
    }

    Ok(None)
}

fn attach_remote_order_identity_to_local(
    conn: &rusqlite::Connection,
    local_id: &str,
    remote_id: &str,
    order_data: &Value,
    synced_at: &str,
) -> Result<(), String> {
    let client_identity = remote_order_client_identity_candidates(order_data)
        .into_iter()
        .next();
    let terminal_id = value_str(order_data, &["terminal_id", "terminalId"]);
    let owner_terminal_id = value_str(order_data, &["owner_terminal_id", "ownerTerminalId"]);
    let source_terminal_id = value_str(order_data, &["source_terminal_id", "sourceTerminalId"]);
    let branch_id = value_str(order_data, &["branch_id", "branchId"]);
    let integration_environment = value_str(
        order_data,
        &["integration_environment", "integrationEnvironment"],
    )
    .filter(|value| value == "sandbox" || value == "production")
    .unwrap_or_else(|| "production".to_string());
    let is_test = value_bool_any(order_data, &["is_test", "isTest"])
        .unwrap_or(integration_environment == "sandbox");

    let updated = conn
        .execute(
        "UPDATE orders
         SET supabase_id = CASE
                 WHEN NULLIF(TRIM(COALESCE(supabase_id, '')), '') IS NULL THEN ?1
                 ELSE supabase_id
             END,
             client_request_id = CASE
                 WHEN ?2 IS NOT NULL
                  AND NULLIF(TRIM(COALESCE(client_request_id, '')), '') IS NULL THEN ?2
                 ELSE client_request_id
             END,
             terminal_id = CASE
                 WHEN ?3 IS NOT NULL
                  AND NULLIF(TRIM(COALESCE(terminal_id, '')), '') IS NULL THEN ?3
                 ELSE terminal_id
             END,
             owner_terminal_id = CASE
                 WHEN ?4 IS NOT NULL
                  AND NULLIF(TRIM(COALESCE(owner_terminal_id, '')), '') IS NULL THEN ?4
                 ELSE owner_terminal_id
             END,
             source_terminal_id = CASE
                 WHEN ?5 IS NOT NULL
                  AND NULLIF(TRIM(COALESCE(source_terminal_id, '')), '') IS NULL THEN ?5
                 ELSE source_terminal_id
             END,
             branch_id = CASE
                 WHEN ?6 IS NOT NULL
                  AND NULLIF(TRIM(COALESCE(branch_id, '')), '') IS NULL THEN ?6
                 ELSE branch_id
             END,
             integration_environment = ?7,
             is_test = ?8,
             sync_status = CASE
                 WHEN lower(COALESCE(sync_status, '')) IN ('pending', 'processing', 'failed', 'conflict') THEN sync_status
                 ELSE 'synced'
             END,
             last_synced_at = ?9
         WHERE id = ?10
           AND (
                NULLIF(TRIM(COALESCE(supabase_id, '')), '') IS NULL
                OR supabase_id = ?1
           )",
        rusqlite::params![
            remote_id,
            client_identity,
            terminal_id,
            owner_terminal_id,
            source_terminal_id,
            branch_id,
            integration_environment,
            if is_test { 1_i64 } else { 0_i64 },
            synced_at,
            local_id,
        ],
        )
        .map_err(|e| format!("attach remote order identity: {e}"))?;

    if updated == 0 {
        return Err("attach remote order identity: conflicting local supabase_id".to_string());
    }

    Ok(())
}

fn build_order_status_patch_body(
    remote_order_id: &str,
    status: &str,
    estimated_time: Option<i64>,
    cancellation_reason: Option<&str>,
    cancelled_at: Option<&str>,
) -> Value {
    let mut body = serde_json::json!({
        "id": remote_order_id,
        "status": status,
    });

    if let Some(estimated_time) = estimated_time.filter(|value| *value > 0) {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("estimated_time".to_string(), Value::from(estimated_time));
            obj.insert("estimatedTime".to_string(), Value::from(estimated_time));
        }
    }

    if status == "cancelled" {
        if let Some(obj) = body.as_object_mut() {
            if let Some(reason) = cancellation_reason
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
            {
                obj.insert(
                    "cancellation_reason".to_string(),
                    Value::String(reason.to_string()),
                );
                obj.insert(
                    "cancellationReason".to_string(),
                    Value::String(reason.to_string()),
                );
            }
            if let Some(cancelled_at) = cancelled_at
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                obj.insert(
                    "cancelled_at".to_string(),
                    Value::String(cancelled_at.to_string()),
                );
                obj.insert(
                    "cancelledAt".to_string(),
                    Value::String(cancelled_at.to_string()),
                );
            }
        }
    }

    body
}

#[derive(Clone)]
struct ImmediateOrderStatusSyncContext {
    admin_url: String,
    api_key: String,
    terminal_id: String,
}

fn normalize_non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_immediate_order_status_sync_context(
    db: &db::DbState,
) -> Option<ImmediateOrderStatusSyncContext> {
    crate::hydrate_terminal_credentials_from_local_settings(db);

    let (db_admin_url, db_api_key, db_terminal_id) = match db.conn.lock() {
        Ok(conn) => (
            db::get_setting(&conn, "terminal", "admin_dashboard_url")
                .or_else(|| db::get_setting(&conn, "terminal", "admin_url")),
            db::get_setting(&conn, "terminal", "pos_api_key")
                .or_else(|| db::get_setting(&conn, "terminal", "api_key")),
            db::get_setting(&conn, "terminal", "terminal_id"),
        ),
        Err(error) => {
            tracing::warn!(
                error = %error,
                "Skipping immediate kiosk status sync because terminal settings could not be read"
            );
            (None, None, None)
        }
    };

    let raw_api_key = normalize_non_empty(
        storage::get_credential("pos_api_key")
            .or_else(|| storage::get_credential("api_key"))
            .or(db_api_key),
    )?;
    let api_key = crate::api::extract_api_key_from_connection_string(&raw_api_key)
        .unwrap_or_else(|| raw_api_key.clone());
    let admin_url = normalize_non_empty(
        storage::get_credential("admin_dashboard_url")
            .or_else(|| storage::get_credential("admin_url"))
            .or(db_admin_url)
            .or_else(|| crate::api::extract_admin_url_from_connection_string(&raw_api_key)),
    )?;
    let terminal_id = normalize_non_empty(
        storage::get_credential("terminal_id")
            .or(db_terminal_id)
            .or_else(|| crate::api::extract_terminal_id_from_connection_string(&raw_api_key)),
    )?;

    Some(ImmediateOrderStatusSyncContext {
        admin_url,
        api_key,
        terminal_id,
    })
}

/// Renderer event carrying the server's `platform_ack` for this till's own
/// accept: what the order's platform (efood, …) was told, including a
/// preparation time it took shorter than the one chosen. The renderer tells
/// the cashier (founder decision, 01/10/2026). Only the PATCH right after an
/// accept carries it; a sync-queue replay, the server's retry cron and webhook
/// auto-accepts only log.
const ORDER_PLATFORM_ACK_EVENT: &str = "order_platform_ack";

/// The till's own accept, whose server answer goes back to the renderer.
struct AcceptAnswerListener {
    app: tauri::AppHandle,
    /// The order id the renderer accepted with, echoed so it can match.
    order_id: String,
}

/// The renderer event for a PATCH answer that relayed the change to a
/// platform; None when the answer carries no `platform_ack` object (released
/// servers, orders from no platform). The app shows only what the server
/// says; it holds no rule about any platform's limits.
fn platform_ack_event_payload(order_id: &str, answer: &Value) -> Option<Value> {
    let platform_ack = answer
        .get("platform_ack")
        .filter(|value| value.is_object())?;
    Some(serde_json::json!({
        "orderId": order_id,
        "platformAck": platform_ack,
    }))
}

fn spawn_immediate_order_status_patch(db: &db::DbState, body: Value) {
    spawn_immediate_order_status_patches(db, vec![body], None);
}

/// The PATCH right after an accept: as `spawn_immediate_order_status_patch`,
/// and the server's answer about the order's platform goes to the renderer.
fn spawn_immediate_order_accept_patch(
    db: &db::DbState,
    body: Value,
    listener: AcceptAnswerListener,
) {
    spawn_immediate_order_status_patches(db, vec![body], Some(listener));
}

#[derive(Debug, PartialEq, Eq)]
enum BoxDecisionConfirmation {
    NotBox,
    PendingLocal,
    AlreadyApplied,
}

fn prepare_box_decision_request(
    conn: &rusqlite::Connection,
    order_id_raw: &str,
    status: &str,
    estimate: Option<i64>,
    reason: Option<&str>,
) -> Result<Option<Value>, String> {
    let (order_id, remote_id) = resolve_order_id_with_remote(conn, order_id_raw)?;
    if !is_box_order(conn, &order_id)? {
        return Ok(None);
    }
    let mutation = if status == "confirmed" {
        BoxOrderMutation::Accept(estimate)
    } else {
        BoxOrderMutation::Reject(reason)
    };
    ensure_box_order_mutation_allowed(conn, &order_id, status, mutation)?;
    if status == "cancelled" {
        // The provider must not see a decline the till's money ledger refuses.
        ensure_no_money_taken_before_cancel(conn, &order_id)?;
    }
    let remote_id = remote_id
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or("BOX decision requires a known remote order; refresh before deciding")?;
    Ok(Some(if status == "confirmed" {
        serde_json::json!({ "id": remote_id, "status": status, "estimated_time": estimate })
    } else {
        serde_json::json!({ "id": remote_id, "status": status, "cancellation_reason": reason })
    }))
}

async fn request_box_decision_confirmation(
    context: &ImmediateOrderStatusSyncContext,
    body: &Value,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "BOX decision requires an online terminal; refresh or retry".to_string())?;
    let url = format!(
        "{}/api/pos/orders",
        crate::api::normalize_admin_url(&context.admin_url)
    );
    let response = client
        .patch(&url)
        .header("x-pos-api-key", &context.api_key)
        .header("x-terminal-id", &context.terminal_id)
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|_| {
            "BOX decision is not confirmed; check connection and retry if still pending".to_string()
        })?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "BOX decision response is unknown; refresh before retrying".to_string())?;
    if !status.is_success() {
        let code = payload
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("BOX_DECISION_REFUSED");
        return Err(format!(
            "BOX decision refused (HTTP {}, {code}); refresh the order",
            status.as_u16()
        ));
    }
    let order = payload
        .get("data")
        .or_else(|| payload.get("order"))
        .unwrap_or(&Value::Null);
    let marker = order.get("box_decision").unwrap_or(&Value::Null);
    let expected_action = if body.get("status").and_then(Value::as_str) == Some("confirmed") {
        "accepted"
    } else {
        "rejected"
    };
    if status.as_u16() != 200
        || payload.get("success").and_then(Value::as_bool) != Some(true)
        || order.get("id") != body.get("id")
        || order.get("status") != body.get("status")
        || marker.get("state").and_then(Value::as_str) != Some("confirmed")
        || marker.get("provider_confirmed").and_then(Value::as_bool) != Some(true)
        || marker.get("action").and_then(Value::as_str) != Some(expected_action)
    {
        return Err(
            "BOX decision is not confirmed; keep the order pending and refresh or retry".into(),
        );
    }
    Ok(())
}

async fn confirm_box_decision_with_context(
    db: &db::DbState,
    order_id_raw: &str,
    body: &Value,
    context: &ImmediateOrderStatusSyncContext,
) -> Result<BoxDecisionConfirmation, String> {
    request_box_decision_confirmation(context, body).await?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    recheck_confirmed_box_decision(&conn, order_id_raw, body)
}

fn recheck_confirmed_box_decision(
    conn: &rusqlite::Connection,
    order_id_raw: &str,
    body: &Value,
) -> Result<BoxDecisionConfirmation, String> {
    let (order_id, remote_id) = resolve_order_id_with_remote(conn, order_id_raw)?;
    if !is_box_order(conn, &order_id)?
        || remote_id.as_deref() != body.get("id").and_then(Value::as_str)
    {
        return Err("BOX order identity changed; refresh before deciding".into());
    }
    let next = body.get("status").and_then(Value::as_str).unwrap_or("");
    let reason = body.get("cancellation_reason").and_then(Value::as_str);
    let current = load_canonical_order_status(&conn, &order_id)?;
    if current == next {
        if next == "cancelled" {
            let stored: Option<String> = conn
                .query_row(
                    "SELECT cancellation_reason FROM orders WHERE id = ?1",
                    rusqlite::params![order_id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("load BOX decision reason: {e}"))?;
            if stored.as_deref() != reason {
                return Err("BOX order decision changed; refresh before deciding".into());
            }
        }
        return Ok(BoxDecisionConfirmation::AlreadyApplied);
    }
    let mutation = if next == "confirmed" {
        BoxOrderMutation::Accept(body.get("estimated_time").and_then(Value::as_i64))
    } else {
        BoxOrderMutation::Reject(reason)
    };
    ensure_box_order_mutation_allowed(&conn, &order_id, next, mutation)?;
    Ok(BoxDecisionConfirmation::PendingLocal)
}

async fn confirm_box_decision_before_mutation(
    db: &db::DbState,
    order_id_raw: &str,
    status: &str,
    estimate: Option<i64>,
    reason: Option<&str>,
) -> Result<(BoxDecisionConfirmation, Option<Value>), String> {
    let request = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        prepare_box_decision_request(&conn, order_id_raw, status, estimate, reason)?
    };
    let Some(body) = request else {
        return Ok((BoxDecisionConfirmation::NotBox, None));
    };
    let context = resolve_immediate_order_status_sync_context(db)
        .ok_or("BOX decision requires an online authenticated terminal; refresh or retry")?;
    let confirmation = confirm_box_decision_with_context(db, order_id_raw, &body, &context).await?;
    Ok((confirmation, Some(body)))
}

fn room_charge_approval_acknowledged(answer: &Value, remote_id: &str) -> bool {
    let order = answer
        .get("data")
        .or_else(|| answer.get("order"))
        .unwrap_or(&Value::Null);
    answer.get("success").and_then(Value::as_bool) == Some(true)
        && order.get("id").and_then(Value::as_str) == Some(remote_id)
        && matches!(
            order.get("status").and_then(Value::as_str),
            Some("confirmed" | "preparing" | "ready" | "completed")
        )
        && order.get("payment_method").and_then(Value::as_str) == Some("room_charge")
        && matches!(
            order.get("payment_status").and_then(Value::as_str),
            Some("paid" | "completed")
        )
}

#[derive(Debug, PartialEq)]
struct RoomChargeApprovalSnapshot {
    local_id: String,
    remote_id: String,
    total_cents: i64,
    items: Value,
    discount_cents: i64,
    tip_cents: i64,
    order_type: String,
}

struct RoomChargeApprovalConfirmation {
    snapshot: RoomChargeApprovalSnapshot,
    status: String,
}

fn kiosk_metadata_requests_room_charge(raw: &str) -> bool {
    let metadata: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    metadata
        .pointer("/kiosk/paymentMethod")
        .or_else(|| metadata.pointer("/kiosk/payment_method"))
        .and_then(Value::as_str)
        .is_some_and(|method| method.trim().eq_ignore_ascii_case("room_charge"))
}

fn order_requests_room_charge(conn: &rusqlite::Connection, local_id: &str) -> Result<bool, String> {
    // v55 removed orders.payment_method: pending kiosk intent is metadata,
    // while actual settlement is derived from the ledger/folio marker.
    let metadata: String = conn
        .query_row(
            "SELECT COALESCE(ghost_metadata, '') FROM orders WHERE id = ?1",
            rusqlite::params![local_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("read room approval intent: {e}"))?;
    Ok(kiosk_metadata_requests_room_charge(&metadata))
}

/// Read under the SQLite mutex both before HTTP and immediately before writing
/// its acknowledgement. Unsynced edits cannot be charged from the server's old copy.
fn capture_room_charge_approval_snapshot(
    conn: &rusqlite::Connection,
    local_id: &str,
) -> Result<RoomChargeApprovalSnapshot, String> {
    let (
        remote_id,
        metadata,
        sync_status,
        total,
        total_cents,
        items,
        discount_cents,
        tip_cents,
        order_type,
        payment_status,
    ): (
        String,
        String,
        String,
        f64,
        Option<i64>,
        String,
        i64,
        i64,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT COALESCE(supabase_id, ''), COALESCE(ghost_metadata, ''), sync_status,
                total_amount, total_amount_cents, items,
                COALESCE(discount_amount_cents, 0), COALESCE(tip_amount_cents, 0),
                COALESCE(order_type, ''), COALESCE(payment_status, 'pending')
                FROM orders WHERE id = ?1",
            rusqlite::params![local_id],
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
        .map_err(|e| format!("ROOM_CHARGE_UNAVAILABLE: read approval snapshot: {e}"))?;
    let queued: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM parity_sync_queue
                       WHERE table_name = 'orders' AND record_id = ?1
                         AND COALESCE(module_type, '') <> 'repairs'
                         AND status IN ('pending', 'processing', 'failed', 'conflict'))
             OR EXISTS(SELECT 1 FROM sync_queue WHERE entity_type = 'order' AND entity_id = ?1
                       AND status IN ('pending', 'in_progress', 'queued_remote', 'deferred', 'failed'))",
        rusqlite::params![local_id], |row| row.get(0),
    ).map_err(|e| format!("ROOM_CHARGE_UNAVAILABLE: verify local changes: {e}"))?;
    if !kiosk_metadata_requests_room_charge(&metadata)
        || sync_status != "synced"
        || queued
        || matches!(payment_status.as_str(), "refunded" | "partially_refunded")
    {
        return Err(
            "ROOM_CHARGE_UNAVAILABLE: synchronize local changes and refresh before approval".into(),
        );
    }
    let remote_id = remote_id.trim().to_string();
    if uuid::Uuid::parse_str(&remote_id).is_err() || !total.is_finite() || total < 0.0 {
        return Err("ROOM_CHARGE_UNAVAILABLE: refresh the order before approval".into());
    }
    let total_cents = total_cents.unwrap_or_else(|| Cents::round_half_up(total).as_i64());
    if total_cents < 0 || total_cents != Cents::round_half_up(total).as_i64() {
        return Err("ROOM_CHARGE_UNAVAILABLE: refresh the order total before approval".into());
    }
    let items = serde_json::from_str::<Value>(&items)
        .map_err(|_| "ROOM_CHARGE_UNAVAILABLE: refresh the order items before approval")?;
    if !items.is_array() {
        return Err("ROOM_CHARGE_UNAVAILABLE: refresh the order items before approval".into());
    }
    Ok(RoomChargeApprovalSnapshot {
        local_id: local_id.to_string(),
        remote_id,
        total_cents,
        items,
        discount_cents,
        tip_cents,
        order_type,
    })
}

fn acknowledged_room_charge_status(
    answer: &Value,
    snapshot: &RoomChargeApprovalSnapshot,
) -> Result<String, String> {
    let order = answer
        .get("data")
        .or_else(|| answer.get("order"))
        .unwrap_or(&Value::Null);
    let total = order.get("total_amount").and_then(|value| {
        value.as_f64().or_else(|| {
            value
                .as_str()
                .and_then(|raw| raw.trim().parse::<f64>().ok())
        })
    });
    if !room_charge_approval_acknowledged(answer, &snapshot.remote_id)
        || !total.is_some_and(|amount| {
            amount.is_finite()
                && amount >= 0.0
                && Cents::round_half_up(amount).as_i64() == snapshot.total_cents
        })
    {
        return Err("ROOM_CHARGE_UNAVAILABLE: the room bill or total was not confirmed; refresh before approval".into());
    }
    Ok(order
        .get("status")
        .and_then(Value::as_str)
        .unwrap()
        .to_string())
}

fn recheck_room_charge_approval(
    conn: &rusqlite::Connection,
    local_id: &str,
    confirmation: &RoomChargeApprovalConfirmation,
) -> Result<String, String> {
    let current = capture_room_charge_approval_snapshot(conn, local_id)?;
    if current != confirmation.snapshot {
        return Err(
            "ROOM_CHARGE_UNAVAILABLE: the order changed during approval; refresh before continuing"
                .into(),
        );
    }
    let current_status = load_canonical_order_status(conn, local_id)?;
    if !matches!(
        current_status.as_str(),
        "pending"
            | "confirmed"
            | "preparing"
            | "ready"
            | "out_for_delivery"
            | "delivered"
            | "completed"
    ) {
        return Err("ROOM_CHARGE_UNAVAILABLE: the order status changed during approval; refresh before continuing".into());
    }
    if can_transition_locally(&current_status, &confirmation.status) {
        return Ok(confirmation.status.clone());
    }
    if can_transition_locally(&confirmation.status, &current_status) {
        // Realtime backflow may have advanced the same paid order while HTTP waited.
        return Ok(current_status);
    }
    Err("ROOM_CHARGE_UNAVAILABLE: conflicting order status; refresh before continuing".into())
}

/// A room folio lives on the server. An offline status change cannot accept its charge.
/// Keep the local order pending until approval and billing are acknowledged together.
async fn confirm_room_charge_before_approval(
    db: &db::DbState,
    order_id_raw: &str,
    estimate: Option<i64>,
) -> Result<Option<RoomChargeApprovalConfirmation>, String> {
    let snapshot = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let (local_id, _) = resolve_order_id_with_remote(&conn, order_id_raw)?;
        if !order_requests_room_charge(&conn, &local_id)? {
            return Ok(None);
        }
        // Validate the transition before the remote request; no local write occurs here.
        ensure_order_status_transition_with_room_confirmation(&conn, &local_id, "confirmed", true)?;
        capture_room_charge_approval_snapshot(&conn, &local_id)?
    };
    let context = resolve_immediate_order_status_sync_context(db)
        .ok_or("ROOM_CHARGE_UNAVAILABLE: an online authenticated terminal is required")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| "ROOM_CHARGE_UNAVAILABLE: could not verify the room bill")?;
    let response = client
        .patch(format!(
            "{}/api/pos/orders",
            crate::api::normalize_admin_url(&context.admin_url)
        ))
        .header("x-pos-api-key", &context.api_key)
        .header("x-terminal-id", &context.terminal_id)
        .json(&build_order_status_patch_body(
            &snapshot.remote_id,
            "confirmed",
            estimate,
            None,
            None,
        ))
        .send()
        .await
        .map_err(|_| "ROOM_CHARGE_UNAVAILABLE: approval is unconfirmed; reconnect and retry")?;
    let status = response.status();
    let answer: Value = response
        .json()
        .await
        .map_err(|_| "ROOM_CHARGE_UNAVAILABLE: approval is unconfirmed; refresh and retry")?;
    if !status.is_success() {
        return Err("ROOM_CHARGE_UNAVAILABLE: the room bill was not confirmed; refresh or choose another payment method".into());
    }
    let status = acknowledged_room_charge_status(&answer, &snapshot)?;
    Ok(Some(RoomChargeApprovalConfirmation { snapshot, status }))
}

pub(crate) fn should_print_box_acceptance_backflow(
    conn: &rusqlite::Connection,
    order_id: &str,
    previous_status: Option<&str>,
    remote_order: &Value,
) -> bool {
    if previous_status != Some("pending")
        || remote_order.get("status").and_then(Value::as_str) != Some("confirmed")
        || !is_box_order(conn, order_id).unwrap_or(false)
    {
        return false;
    }
    // Only the authenticated server snapshot's durable own-ACK proof admits
    // this delayed acceptance print. A pending intent or renderer hint cannot.
    box_has_confirmed_acceptance_proof(remote_order.get("ghost_metadata").unwrap_or(&Value::Null))
}

fn box_has_confirmed_acceptance_proof(raw_metadata: &Value) -> bool {
    let parsed_metadata = raw_metadata
        .as_str()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let metadata = parsed_metadata.as_ref().unwrap_or(raw_metadata);
    let intent = metadata.get("_the_small_box_decision");
    intent.is_some_and(|value| {
        value.get("version").and_then(Value::as_i64) == Some(1)
            && value.get("state").and_then(Value::as_str) == Some("confirmed")
            && value.get("action").and_then(Value::as_str) == Some("accepted")
    })
}

pub(crate) fn skip_unconfirmed_box_arrival_print(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> bool {
    if !is_box_order(conn, order_id).unwrap_or(false) {
        return false;
    }
    let row: Result<(String, String), _> = conn.query_row(
        "SELECT COALESCE(status, ''), COALESCE(ghost_metadata, '') FROM orders WHERE id = ?1",
        rusqlite::params![order_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    let Ok((status, metadata)) = row else {
        return true;
    };
    !matches!(
        status.as_str(),
        "confirmed" | "preparing" | "ready" | "delivered" | "completed"
    ) || !box_has_confirmed_acceptance_proof(&Value::String(metadata))
}

pub(crate) fn enqueue_after_approve_platform_prints(
    db: &db::DbState,
    order_id: &str,
    invalidator: &dyn crate::print::PrintQueueInvalidator,
) {
    let (order_type, is_ghost, plugin, external_order_id, ghost_metadata): (
        String,
        i64,
        String,
        String,
        String,
    ) = {
        let Ok(conn) = db.conn.lock() else {
            return;
        };
        conn.query_row(
            "SELECT COALESCE(order_type, ''), COALESCE(is_ghost, 0), COALESCE(plugin, ''), COALESCE(external_plugin_order_id, ''), COALESCE(ghost_metadata, '') FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).unwrap_or_default()
    };
    let has_food_delivery_metadata = serde_json::from_str::<Value>(&ghost_metadata)
        .ok()
        .and_then(|value| value.get("food_delivery").cloned())
        .is_some();
    let is_platform_order = crate::print::is_food_delivery_plugin(&plugin)
        || !external_order_id.trim().is_empty()
        || has_food_delivery_metadata;
    if is_ghost == 0
        && is_platform_order
        && crate::print::is_print_action_enabled(db, "after_approve")
    {
        for entity_type in crate::print::auto_print_entity_types_for_order_type(&order_type) {
            // A confirmed backflow may win the HTTP await and print before
            // AlreadyApplied returns. Keep BOX automatic acceptance one-time
            // even if that existing job finished during the race.
            let already_printed = db.conn.lock().ok().is_some_and(|conn| {
                is_box_order(&conn, order_id).unwrap_or(false) && conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM print_jobs WHERE entity_type = ?1 AND entity_id = ?2 AND status IN ('pending', 'printing', 'printed', 'dispatched'))",
                    rusqlite::params![entity_type, order_id], |row| row.get::<_, bool>(0),
                ).unwrap_or(false)
            });
            if already_printed {
                continue;
            }
            if let Err(error) =
                crate::print::enqueue_print_job(db, entity_type, order_id, None, invalidator)
            {
                tracing::warn!(order_id = %order_id, entity_type = %entity_type, error = %error, "Failed to enqueue after-approve print job");
            }
        }
    }
}

/// Send several status PATCHes from ONE spawned task, strictly in order. Two
/// independent spawns give no wire ordering — a later status ("delivered")
/// could overtake an earlier one ("ready"), leaving the server on the stale
/// status and syncing the order back into the active grid. A failed PATCH
/// aborts the remainder of the sequence: the sync queue holds the same
/// statuses in order and replays them as the fallback.
fn spawn_immediate_order_status_patches(
    db: &db::DbState,
    bodies: Vec<Value>,
    accept_listener: Option<AcceptAnswerListener>,
) {
    let Some(context) = resolve_immediate_order_status_sync_context(db) else {
        tracing::debug!(
            "Skipping immediate kiosk status sync because terminal credentials are unavailable"
        );
        return;
    };

    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    "Immediate kiosk status sync could not build HTTP client"
                );
                return;
            }
        };
        let url = format!(
            "{}/api/pos/orders",
            crate::api::normalize_admin_url(&context.admin_url)
        );

        for body in bodies {
            let status = body
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let order_id = body
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();

            let response = client
                .patch(&url)
                .header("x-pos-api-key", context.api_key.clone())
                .header("x-terminal-id", context.terminal_id.clone())
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await;

            match response {
                Ok(response) if response.status().is_success() => {
                    tracing::info!(
                        order_id = %order_id,
                        status = %status,
                        "Immediate kiosk status sync succeeded"
                    );
                    if let Some(listener) = accept_listener.as_ref() {
                        match response.json::<Value>().await {
                            Ok(answer) => {
                                if let Some(payload) =
                                    platform_ack_event_payload(&listener.order_id, &answer)
                                {
                                    let _ = listener.app.emit(ORDER_PLATFORM_ACK_EVENT, payload);
                                }
                            }
                            Err(error) => {
                                tracing::debug!(
                                    order_id = %order_id,
                                    error = %error,
                                    "Accept answer could not be read; no platform notice"
                                );
                            }
                        }
                    }
                }
                Ok(response) => {
                    let http_status = response.status().as_u16();
                    let body = response.text().await.unwrap_or_default();
                    tracing::warn!(
                        order_id = %order_id,
                        status = %status,
                        http_status,
                        response = %body.chars().take(500).collect::<String>(),
                        "Immediate kiosk status sync failed; queued retry remains pending"
                    );
                    return;
                }
                Err(error) => {
                    tracing::warn!(
                        order_id = %order_id,
                        status = %status,
                        error = %error,
                        "Immediate kiosk status sync failed; queued retry remains pending"
                    );
                    return;
                }
            }
        }
    });
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
        expected_version: raw.expected_version,
        table_session_id: raw.table_session_id,
        client_event_id: raw.client_event_id,
    })
}

fn validate_edit_settlement_financials(
    financials: Option<EditSettlementFinancialsPayload>,
) -> Result<Option<EditSettlementFinancialsPayload>, String> {
    let Some(financials) = financials else {
        return Ok(None);
    };

    for (field, value) in [
        ("financials.totalAmount", financials.total_amount),
        ("financials.subtotal", financials.subtotal),
        ("financials.discountAmount", financials.discount_amount),
        (
            "financials.discountPercentage",
            financials.discount_percentage,
        ),
        ("financials.taxAmount", financials.tax_amount),
        ("financials.deliveryFee", financials.delivery_fee),
        ("financials.tipAmount", financials.tip_amount),
    ] {
        if let Some(value) = value {
            if !value.is_finite() || value < 0.0 {
                return Err(format!("{field} must be a non-negative number"));
            }
        }
    }

    Ok(Some(financials))
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
        order_updates: raw.order_updates,
        financials: validate_edit_settlement_financials(raw.financials)?,
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

fn item_text_value<'a>(item: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn meaningful_customizations(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Array(items) => !items.is_empty(),
        serde_json::Value::Object(entries) => !entries.is_empty(),
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            !trimmed.is_empty() && !matches!(trimmed, "null" | "[]" | "{}")
        }
        _ => true,
    }
}

fn item_omits_customizations(item: &serde_json::Value) -> bool {
    match item.get("customizations") {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::String(text)) => text.trim().is_empty(),
        Some(_) => false,
    }
}

fn order_item_line_identity(item: &serde_json::Value) -> Vec<String> {
    let mut identities: Vec<String> = [
        "order_item_id",
        "orderItemId",
        "source_order_item_id",
        "sourceOrderItemId",
        "original_order_item_id",
        "originalOrderItemId",
    ]
    .iter()
    .filter_map(|key| item_text_value(item, &[*key]))
    .map(|value| value.to_ascii_lowercase())
    .collect();

    if let Some(item_id) = item_text_value(item, &["id"]) {
        let id_is_menu_item_id = item_text_value(item, &["menu_item_id", "menuItemId"])
            .map(|menu_item_id| menu_item_id.eq_ignore_ascii_case(item_id))
            .unwrap_or(false);
        if !id_is_menu_item_id {
            identities.push(item_id.to_ascii_lowercase());
        }
    }

    identities
}

fn order_item_identity_matches(existing: &serde_json::Value, incoming: &serde_json::Value) -> bool {
    let incoming_ids = order_item_line_identity(incoming);
    if incoming_ids.is_empty() {
        return false;
    }

    let existing_ids = order_item_line_identity(existing);
    existing_ids.iter().any(|existing_id| {
        incoming_ids
            .iter()
            .any(|incoming_id| incoming_id == existing_id)
    })
}

fn close_money_values(left: Option<f64>, right: Option<f64>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => (left - right).abs() < 0.0001,
        _ => false,
    }
}

fn order_item_match_score(existing: &serde_json::Value, incoming: &serde_json::Value) -> i32 {
    if order_item_identity_matches(existing, incoming) {
        return 100;
    }

    let mut score = 0;
    let existing_menu_item_id = item_text_value(existing, &["menu_item_id", "menuItemId"]);
    let incoming_menu_item_id = item_text_value(incoming, &["menu_item_id", "menuItemId"]);
    if existing_menu_item_id.is_some()
        && incoming_menu_item_id.is_some()
        && existing_menu_item_id == incoming_menu_item_id
    {
        score += 20;
    }

    let existing_name = item_text_value(existing, &["menu_item_name", "menuItemName", "name"])
        .map(str::to_ascii_lowercase);
    let incoming_name = item_text_value(incoming, &["menu_item_name", "menuItemName", "name"])
        .map(str::to_ascii_lowercase);
    if existing_name.is_some() && incoming_name.is_some() && existing_name == incoming_name {
        score += 8;
    }

    if close_money_values(
        value_f64(existing, &["unit_price", "unitPrice", "price"]),
        value_f64(incoming, &["unit_price", "unitPrice", "price"]),
    ) {
        score += 4;
    }
    if close_money_values(
        value_f64(existing, &["quantity"]),
        value_f64(incoming, &["quantity"]),
    ) {
        score += 2;
    }
    if close_money_values(
        value_f64(existing, &["total_price", "totalPrice"]),
        value_f64(incoming, &["total_price", "totalPrice"]),
    ) {
        score += 2;
    }

    score
}

fn merge_existing_order_item_customizations(
    conn: &rusqlite::Connection,
    order_id: &str,
    incoming_items: &[serde_json::Value],
) -> Result<Vec<serde_json::Value>, String> {
    let current_items_json: String = conn
        .query_row(
            "SELECT COALESCE(items, '[]') FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("load current order items: {e}"))?;
    let current_items: Vec<serde_json::Value> =
        serde_json::from_str(&current_items_json).unwrap_or_default();

    merge_order_item_customizations(&current_items, incoming_items)
}

fn merge_order_item_customizations(
    current_items: &[Value],
    incoming_items: &[Value],
) -> Result<Vec<Value>, String> {
    let mut used_existing = vec![false; current_items.len()];
    let mut merged = Vec::with_capacity(incoming_items.len());

    for incoming in incoming_items {
        if !item_omits_customizations(incoming) {
            merged.push(incoming.clone());
            continue;
        }

        let incoming_has_line_identity = !order_item_line_identity(incoming).is_empty();
        let mut best_match: Option<(usize, i32)> = None;
        for (index, existing) in current_items.iter().enumerate() {
            if used_existing[index] {
                continue;
            }
            let Some(existing_customizations) = existing.get("customizations") else {
                continue;
            };
            if !meaningful_customizations(existing_customizations) {
                continue;
            }

            let score = order_item_match_score(existing, incoming);
            if (score == 100 || (!incoming_has_line_identity && score >= 34))
                && best_match.map_or(true, |(_, best_score)| score > best_score)
            {
                best_match = Some((index, score));
            }
        }

        let mut next_item = incoming.clone();
        if let Some((index, _)) = best_match {
            used_existing[index] = true;
            if let Some(existing_customizations) = current_items[index].get("customizations") {
                if let Some(object) = next_item.as_object_mut() {
                    object.insert(
                        "customizations".to_string(),
                        existing_customizations.clone(),
                    );
                }
            }
        }
        merged.push(next_item);
    }

    Ok(merged)
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

fn resolve_edit_settlement_totals(
    conn: &rusqlite::Connection,
    order_id: &str,
    payload: &OrderEditSettlementPayload,
) -> Result<(f64, f64), String> {
    let (derived_total, derived_subtotal) =
        derive_next_order_totals(conn, order_id, &payload.items)?;
    let Some(financials) = payload.financials.as_ref() else {
        return Ok((derived_total, derived_subtotal));
    };

    Ok((
        financials.total_amount.unwrap_or(derived_total).max(0.0),
        financials.subtotal.unwrap_or(derived_subtotal).max(0.0),
    ))
}

fn edit_settlement_financial_sync_fields(
    financials: Option<&EditSettlementFinancialsPayload>,
    subtotal_amount: f64,
) -> serde_json::Map<String, serde_json::Value> {
    let mut fields = serde_json::Map::new();
    fields.insert("subtotal".to_string(), serde_json::json!(subtotal_amount));
    fields.insert(
        "subtotal_cents".to_string(),
        serde_json::json!(Cents::round_half_even(subtotal_amount).as_i64()),
    );

    let Some(financials) = financials else {
        return fields;
    };

    if let Some(value) = financials.discount_amount {
        fields.insert("discountAmount".to_string(), serde_json::json!(value));
        fields.insert(
            "discount_amount_cents".to_string(),
            serde_json::json!(Cents::round_half_even(value).as_i64()),
        );
    }
    if let Some(value) = financials.discount_percentage {
        fields.insert("discountPercentage".to_string(), serde_json::json!(value));
    }
    if let Some(value) = financials.tax_amount {
        fields.insert("taxAmount".to_string(), serde_json::json!(value));
        fields.insert(
            "tax_amount_cents".to_string(),
            serde_json::json!(Cents::round_half_even(value).as_i64()),
        );
    }
    if let Some(value) = financials.delivery_fee {
        fields.insert("deliveryFee".to_string(), serde_json::json!(value));
        fields.insert(
            "delivery_fee_cents".to_string(),
            serde_json::json!(Cents::round_half_even(value).as_i64()),
        );
    }
    if let Some(value) = financials.tip_amount {
        fields.insert("tipAmount".to_string(), serde_json::json!(value));
        fields.insert(
            "tip_amount_cents".to_string(),
            serde_json::json!(Cents::round_half_even(value).as_i64()),
        );
    }

    fields
}

fn apply_edit_settlement_financial_adjustments(
    conn: &rusqlite::Connection,
    order_id: &str,
    financials: Option<&EditSettlementFinancialsPayload>,
    now: &str,
) -> Result<(), String> {
    use rusqlite::types::Value;

    let Some(financials) = financials else {
        return Ok(());
    };

    let mut set_clauses: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    fn add_money(
        column: &str,
        value: Option<f64>,
        set_clauses: &mut Vec<String>,
        params: &mut Vec<Value>,
    ) {
        if let Some(value) = value {
            set_clauses.push(format!("{column} = ?"));
            params.push(Value::Real(value));
            set_clauses.push(format!("{column}_cents = ?"));
            params.push(Value::Integer(Cents::round_half_even(value).as_i64()));
        }
    }

    add_money(
        "discount_amount",
        financials.discount_amount,
        &mut set_clauses,
        &mut params,
    );
    if let Some(value) = financials.discount_percentage {
        set_clauses.push("discount_percentage = ?".to_string());
        params.push(Value::Real(value));
    }
    add_money(
        "tax_amount",
        financials.tax_amount,
        &mut set_clauses,
        &mut params,
    );
    add_money(
        "delivery_fee",
        financials.delivery_fee,
        &mut set_clauses,
        &mut params,
    );
    add_money(
        "tip_amount",
        financials.tip_amount,
        &mut set_clauses,
        &mut params,
    );

    if set_clauses.is_empty() {
        return Ok(());
    }

    set_clauses.push("sync_status = 'pending'".to_string());
    set_clauses.push("updated_at = ?".to_string());
    params.push(Value::Text(now.to_string()));

    let sql = format!("UPDATE orders SET {} WHERE id = ?", set_clauses.join(", "));
    params.push(Value::Text(order_id.to_string()));
    conn.execute(&sql, rusqlite::params_from_iter(params.iter()))
        .map_err(|e| format!("apply edit settlement financials: {e}"))?;

    Ok(())
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
    // W4c dual-write: order edit total_amount + subtotal mirror onto cents.
    let total_amount_cents = Cents::round_half_even(total_amount).as_i64();
    let subtotal_amount_cents = Cents::round_half_even(subtotal_amount).as_i64();
    if let Some(notes) = order_notes {
        conn.execute(
            "UPDATE orders
             SET items = ?1,
                 total_amount = ?2, total_amount_cents = ?3,
                 subtotal = ?4, subtotal_cents = ?5,
                 special_instructions = ?6,
                 sync_status = 'pending',
                 updated_at = ?7
             WHERE id = ?8",
            rusqlite::params![
                items_json,
                total_amount,
                total_amount_cents,
                subtotal_amount,
                subtotal_amount_cents,
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
                 total_amount = ?2, total_amount_cents = ?3,
                 subtotal = ?4, subtotal_cents = ?5,
                 sync_status = 'pending',
                 updated_at = ?6
             WHERE id = ?7",
            rusqlite::params![
                items_json,
                total_amount,
                total_amount_cents,
                subtotal_amount,
                subtotal_amount_cents,
                now,
                order_id
            ],
        )
        .map_err(|e| format!("update order items: {e}"))?;
    }

    Ok(())
}

fn load_net_paid_for_order(conn: &rusqlite::Connection, order_id: &str) -> Result<f64, String> {
    payments::load_net_paid_for_order(conn, order_id)
}

/// The settlement when the local ledger holds everything the order proved
/// (the pre-29/09 arithmetic the regression suites pin).
#[cfg(test)]
fn determine_edit_settlement_required_action(paid_total: f64, next_total: f64) -> &'static str {
    determine_edit_settlement_required_action_for_ledger(paid_total, paid_total, next_total)
}

/// The settlement an edit needs.
///
/// Unpaid/pending orders carry no settlement: a product edit just adjusts the
/// still-open balance, so it must never force an immediate collect/refund
/// prompt (the live "no-op edit opens Extra Payment for the full unpaid total"
/// defect). Only orders that already have money applied (paid / partially
/// paid) settle a delta against what was paid.
///
/// `effective_paid` is everything the order proved (the local ledger plus
/// money its status proved that the local rows do not hold, see
/// [`ProvenPaymentCoverage`]); a collection is measured against it, so a grown
/// paid order is asked only for the difference. `ledger_paid` is the money
/// the LOCAL rows hold; a refund is measured against it, because a refund
/// must name a local payment (review of the 29/09/2026 fixes: a shrunk paid
/// order whose rows were missing — offline, or the restore timed out —
/// demanded a refund of money no local row held, and could not be saved).
/// When only the missing proven money makes the order look overpaid, nothing
/// is due here: it stays `paid` and the server ledger settles it later.
fn determine_edit_settlement_required_action_for_ledger(
    effective_paid: f64,
    ledger_paid: f64,
    next_total: f64,
) -> &'static str {
    if effective_paid <= 0.01 {
        return "none";
    }
    if effective_paid + 0.01 < next_total {
        "collect"
    } else if ledger_paid > next_total + 0.01 {
        "refund"
    } else {
        "none"
    }
}

/// The refund an edit settlement requires: what the local rows hold beyond
/// the new total (never the proven-but-missing money, see
/// [`determine_edit_settlement_required_action_for_ledger`]).
fn edit_settlement_required_refund(ledger_paid: f64, next_total: f64) -> f64 {
    Cents::round_half_even((ledger_paid - next_total).max(0.0)).to_f64_dp2()
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

fn should_resolve_stale_overpay_payments_before_edit_action(
    action: &EditSettlementActionPayload,
) -> bool {
    !matches!(action, EditSettlementActionPayload::Refund { .. })
}

/// Money an order's persisted payment status already proved that the LOCAL
/// payment ledger does not hold.
///
/// Field incident 29/09/2026 (Le Petit Paris, Android POS 1.0.12; this
/// desktop path had the same shape): two card-paid orders had no local
/// `order_payments` row. An item edit recomputed `payment_status` from the
/// local ledger alone, found "no coverage", turned the inherited `paid` into
/// `pending` and pushed it; the Z then listed collected money as unpaid.
///
/// A missing local row is not proof that money is gone: the status was proved
/// when the order became paid. Captured BEFORE a write changes the order, the
/// gap between what the status proves (the whole previous total for `paid`,
/// at least one cent for `partially_paid`) and what the local ledger holds is
/// carried through the write, so an edit keeps `paid`, a grown order honestly
/// becomes `partially_paid`, and money collected by the same write still
/// counts. When the local ledger already backs the status the gap is zero and
/// the ledger alone decides, so an explicit refund or void still changes it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ProvenPaymentCoverage {
    /// The order's payment status before this write, normalized.
    prior_status: String,
    /// Cents the prior status proves that the local ledger does not hold.
    missing_cents: i64,
}

impl ProvenPaymentCoverage {
    fn missing_amount(&self) -> f64 {
        Cents::new(self.missing_cents).to_f64_dp2()
    }
}

fn normalized_order_payment_status(raw: &str) -> String {
    let normalized = raw.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" => "pending".to_string(),
        "completed" => "paid".to_string(),
        _ => normalized,
    }
}

/// Read what the order's current payment status proves against its local
/// ledger. Must run before the write mutates the order's total or payments.
fn capture_proven_payment_coverage(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<ProvenPaymentCoverage, String> {
    let (raw_status, total_cents): (String, i64) = conn
        .query_row(
            // W4b: cents-with-real-fallback shim (removed in 4e).
            "SELECT COALESCE(payment_status, 'pending'),
                    COALESCE(total_amount_cents, CAST(ROUND(total_amount * 100) AS INTEGER), 0)
             FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("load order payment proof: {e}"))?;
    let prior_status = normalized_order_payment_status(&raw_status);
    let proven_cents = match prior_status.as_str() {
        "paid" => total_cents.max(0),
        "partially_paid" => total_cents.clamp(0, 1),
        _ => 0,
    };
    let ledger_cents = Cents::round_half_even(load_net_paid_for_order(conn, order_id)?).as_i64();
    Ok(ProvenPaymentCoverage {
        prior_status,
        missing_cents: (proven_cents - ledger_cents).max(0),
    })
}

/// The payment state an edit leaves on the order.
#[derive(Debug, Clone, PartialEq)]
struct OrderPaymentSnapshot {
    status: String,
    /// Derived from completed payment rows; `None` when the local ledger has
    /// none, so no tender is ever invented.
    derived_method: Option<String>,
    /// Merchandise principal in the local ledger, net of each tip and refund.
    ledger_paid: f64,
    /// `ledger_paid` plus the coverage the prior status proved.
    effective_paid: f64,
}

impl OrderPaymentSnapshot {
    /// Method label for IPC responses, which have always carried a string.
    fn method_label(&self) -> String {
        self.derived_method
            .clone()
            .unwrap_or_else(|| "pending".to_string())
    }
}

fn payment_status_for_amounts(paid: f64, order_total: f64) -> &'static str {
    if paid >= order_total - 0.01 {
        if paid > 0.009 {
            "paid"
        } else {
            "pending"
        }
    } else if paid > 0.009 {
        "partially_paid"
    } else {
        "pending"
    }
}

fn refresh_order_payment_snapshot_with_coverage(
    conn: &rusqlite::Connection,
    order_id: &str,
    now: &str,
    coverage: &ProvenPaymentCoverage,
) -> Result<OrderPaymentSnapshot, String> {
    let order_total: f64 = conn
        .query_row(
            // W4b: cents-with-real-fallback shim (removed in 4e).
            "SELECT COALESCE(total_amount_cents, CAST(ROUND(total_amount * 100) AS INTEGER), 0)
             FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .map_err(|e| format!("load order total for snapshot: {e}"))?;

    let ledger_paid = payments::load_principal_paid_for_order(conn, order_id)?;
    let effective_paid = ledger_paid + coverage.missing_amount();
    // A comp (an order whose total is zero) that was settled stays settled.
    // With no money to count the arithmetic reads `pending`, so every edit of
    // a comped order used to turn it `pending` and push that (review of the
    // 29/09/2026 fixes).
    let next_payment_status = if order_total <= 0.0 && coverage.prior_status == "paid" {
        "paid".to_string()
    } else {
        payment_status_for_amounts(effective_paid, order_total).to_string()
    };
    if coverage.missing_cents > 0 {
        tracing::warn!(
            order_id = %order_id,
            prior_status = %coverage.prior_status,
            payment_status = %next_payment_status,
            missing_cents = coverage.missing_cents,
            "Local payment rows are missing; kept the payment status the order already proved"
        );
    }

    // W6: `orders.payment_method` was dropped in migration v55. The
    // method is now derived from `order_payments` rows via
    // `payments::derive_payment_method` on every read. This refresh
    // only persists `payment_status`; the derived method is returned for
    // callers that emit it in a sync payload or IPC response.
    let derived_method = crate::payments::derive_payment_method(conn, order_id)?;

    conn.execute(
        "UPDATE orders
         SET payment_status = ?1,
             updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![next_payment_status, now, order_id],
    )
    .map_err(|e| format!("refresh order payment snapshot: {e}"))?;

    Ok(OrderPaymentSnapshot {
        status: next_payment_status,
        derived_method,
        ledger_paid,
        effective_paid,
    })
}

/// Ledger-only refresh (no prior-status proof), as the pre-29/09 edit paths
/// computed it. Kept for the regression suites that pin the ledger arithmetic.
#[cfg(test)]
fn refresh_order_payment_snapshot(
    conn: &rusqlite::Connection,
    order_id: &str,
    now: &str,
) -> Result<(String, String, f64), String> {
    let snapshot = refresh_order_payment_snapshot_with_coverage(
        conn,
        order_id,
        now,
        &ProvenPaymentCoverage::default(),
    )?;
    Ok((
        snapshot.status.clone(),
        snapshot.method_label(),
        snapshot.ledger_paid,
    ))
}

/// Whether a write should carry the order's payment status to the server.
///
/// A status the order merely keeps and that records no money (`pending`) is
/// never pushed: the server may know better (a payment recorded server-first
/// or on another terminal), and overwriting it with the local default is how
/// two paid orders became `pending` on 29/09/2026. A status that records
/// money, and a status this write changed (a collection, or an explicit
/// refund or void against a complete local ledger), are pushed. The server
/// applies its own ledger rule on top (`readOrderPaymentAuthority`).
fn payment_status_to_push<'a>(
    coverage: &ProvenPaymentCoverage,
    snapshot: &'a OrderPaymentSnapshot,
) -> Option<&'a str> {
    let status = snapshot.status.as_str();
    let records_money = matches!(status, "paid" | "partially_paid" | "refunded");
    if records_money || status != coverage.prior_status {
        Some(status)
    } else {
        None
    }
}

/// Bound on the server-ledger check a cashier-facing edit may wait for.
const LEDGER_RESTORE_BEFORE_EDIT_TIMEOUT: Duration = Duration::from_secs(4);

/// How long one restore attempt answers for the same order: the preview and
/// the save of one edit share it instead of waiting on the server twice.
const LEDGER_RESTORE_SHARE_WINDOW: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq)]
enum LedgerRestoreOutcome {
    NotNeeded,
    Restored(usize),
    NothingToRestore,
    Failed(String),
    TimedOut,
}

/// Which step of an edit asks for the restore.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LedgerRestoreStep {
    /// The settlement preview: its attempt is kept for the save that follows.
    Preview,
    /// The write (save, financial update): reuses a recent preview attempt
    /// and ends the edit's share.
    Write,
}

fn recent_ledger_restores(
) -> &'static std::sync::Mutex<HashMap<String, (Instant, LedgerRestoreOutcome)>> {
    static RECENT: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, (Instant, LedgerRestoreOutcome)>>,
    > = std::sync::OnceLock::new();
    RECENT.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// The outcome of an attempt for this order inside the share window, if any.
/// A write consumes it: the next edit asks the server again.
fn shared_ledger_restore_outcome(
    order_id: &str,
    step: LedgerRestoreStep,
) -> Option<LedgerRestoreOutcome> {
    let mut recent = recent_ledger_restores().lock().ok()?;
    recent.retain(|_, (at, _)| at.elapsed() < LEDGER_RESTORE_SHARE_WINDOW);
    match step {
        LedgerRestoreStep::Preview => recent.get(order_id).map(|(_, outcome)| outcome.clone()),
        LedgerRestoreStep::Write => recent.remove(order_id).map(|(_, outcome)| outcome),
    }
}

fn remember_ledger_restore_outcome(order_id: &str, outcome: &LedgerRestoreOutcome) {
    if let Ok(mut recent) = recent_ledger_restores().lock() {
        recent.insert(order_id.to_string(), (Instant::now(), outcome.clone()));
    }
}

#[cfg(test)]
fn forget_ledger_restores_for_tests() {
    if let Ok(mut recent) = recent_ledger_restores().lock() {
        recent.clear();
    }
}

/// Whether the order claims money its local ledger does not hold while the
/// server holds the order (and so its payment rows).
#[cfg(test)]
fn order_needs_ledger_restore_before_payment_decision(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<bool, String> {
    Ok(ledger_restore_target_before_payment_decision(conn, order_id)?.is_some())
}

/// The server order id to restore the ledger from, when the order claims
/// money its local ledger does not hold and the server holds the order (and
/// so its payment rows): its `supabase_id`, or its own id when that is a
/// server UUID the order was synced under.
fn ledger_restore_target_before_payment_decision(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<Option<String>, String> {
    let row: Option<(String, i64, Option<String>, String, String)> = conn
        .query_row(
            "SELECT COALESCE(payment_status, 'pending'),
                    COALESCE(total_amount_cents, CAST(ROUND(total_amount * 100) AS INTEGER), 0),
                    NULLIF(TRIM(COALESCE(supabase_id, '')), ''),
                    LOWER(TRIM(COALESCE(sync_status, ''))),
                    LOWER(TRIM(COALESCE(order_context, '')))
             FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
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
        .optional()
        .map_err(|e| format!("load order for ledger restore check: {e}"))?;
    let Some((raw_status, total_cents, supabase_id, sync_status, order_context)) = row else {
        return Ok(None);
    };
    if order_context == "repair_settlement" || total_cents <= 0 {
        return Ok(None);
    }
    let required_cents = match normalized_order_payment_status(&raw_status).as_str() {
        "paid" => total_cents,
        "partially_paid" => 1,
        _ => return Ok(None),
    };
    let remote_order_id = match supabase_id {
        Some(remote_order_id) => remote_order_id,
        // Only this terminal knows the order (or it has no server id to ask
        // under): the server has no ledger rows for it to restore from.
        None if sync_status == "synced" => {
            match sync::normalize_optional_uuid_str(Some(order_id)) {
                Some(remote_order_id) => remote_order_id,
                None => return Ok(None),
            }
        }
        None => return Ok(None),
    };
    let ledger_cents =
        Cents::round_half_even(payments::load_principal_paid_for_order(conn, order_id)?).as_i64();
    Ok((ledger_cents < required_cents).then_some(remote_order_id))
}

/// Before an edit decides an order's payment status, make sure the local
/// ledger is not simply MISSING rows the server ledger holds: pull them first
/// (bounded, this runs on a cashier path). Best-effort: offline, on a timeout
/// or on any failure the edit proceeds and keeps the status the order already
/// proved (see [`ProvenPaymentCoverage`]).
///
/// Review of the 29/09/2026 fixes:
/// - only `fetch` (the network read) runs under the timeout; the DB work —
///   the need check before, the mirror after — runs outside it, and the
///   production fetch keeps its blocking credential reads off this task (see
///   `sync::fetch_order_payment_ledger_with_stored_credentials`), so the
///   bound is hard;
/// - one attempt serves the preview and the save of the same edit
///   ([`LEDGER_RESTORE_SHARE_WINDOW`]): the cashier never waits twice;
/// - the rows are applied by `sync::apply_order_payment_ledger_before_payment_decision`:
///   completed server money only, nothing reconstructed from the label, and
///   the payment label never lowered.
async fn restore_payment_ledger_before_payment_decision_with<F, Fut>(
    db: &db::DbState,
    order_id_raw: &str,
    step: LedgerRestoreStep,
    timeout: Duration,
    fetch: F,
) -> LedgerRestoreOutcome
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<serde_json::Value>, String>>,
{
    let (order_id, remote_order_id) = {
        let conn = match db.conn.lock() {
            Ok(conn) => conn,
            Err(error) => return LedgerRestoreOutcome::Failed(error.to_string()),
        };
        let Ok(order_id) = resolve_renderer_order_id(&conn, order_id_raw) else {
            return LedgerRestoreOutcome::NotNeeded;
        };
        match ledger_restore_target_before_payment_decision(&conn, &order_id) {
            Ok(Some(remote_order_id)) => (order_id, remote_order_id),
            Ok(None) => return LedgerRestoreOutcome::NotNeeded,
            Err(error) => return LedgerRestoreOutcome::Failed(error),
        }
    };

    if let Some(shared) = shared_ledger_restore_outcome(&order_id, step) {
        tracing::debug!(
            order_id = %order_id,
            outcome = ?shared,
            "Reusing this edit's server ledger check"
        );
        return shared;
    }

    let fetched = tokio::time::timeout(timeout, fetch(remote_order_id.clone())).await;
    let outcome = match fetched {
        Err(_) => LedgerRestoreOutcome::TimedOut,
        Ok(Err(error)) => LedgerRestoreOutcome::Failed(error),
        Ok(Ok(remote_payments)) => match db.conn.lock() {
            Err(error) => LedgerRestoreOutcome::Failed(error.to_string()),
            Ok(conn) => match sync::apply_order_payment_ledger_before_payment_decision(
                &conn,
                &order_id,
                &remote_order_id,
                &remote_payments,
                &Utc::now().to_rfc3339(),
            ) {
                Ok(0) => LedgerRestoreOutcome::NothingToRestore,
                Ok(restored) => LedgerRestoreOutcome::Restored(restored),
                Err(error) => LedgerRestoreOutcome::Failed(error),
            },
        },
    };
    if step == LedgerRestoreStep::Preview {
        remember_ledger_restore_outcome(&order_id, &outcome);
    }
    match &outcome {
        LedgerRestoreOutcome::Restored(restored) => tracing::info!(
            order_id = %order_id,
            restored = *restored,
            "Restored missing payment rows from the server ledger before an edit"
        ),
        LedgerRestoreOutcome::Failed(error) => tracing::warn!(
            order_id = %order_id,
            error = %error,
            "Server ledger check before an edit failed; keeping the proven payment status"
        ),
        LedgerRestoreOutcome::TimedOut => tracing::warn!(
            order_id = %order_id,
            "Server ledger check before an edit timed out; keeping the proven payment status"
        ),
        LedgerRestoreOutcome::NotNeeded | LedgerRestoreOutcome::NothingToRestore => {}
    }
    outcome
}

async fn restore_payment_ledger_before_payment_decision(
    db: &db::DbState,
    order_id_raw: &str,
    step: LedgerRestoreStep,
) -> LedgerRestoreOutcome {
    restore_payment_ledger_before_payment_decision_with(
        db,
        order_id_raw,
        step,
        LEDGER_RESTORE_BEFORE_EDIT_TIMEOUT,
        |remote_order_id| {
            sync::fetch_order_payment_ledger_with_stored_credentials(
                remote_order_id,
                LEDGER_RESTORE_BEFORE_EDIT_TIMEOUT,
            )
        },
    )
    .await
}

/// Convert one of the optional `order_updates` JSON fields into a
/// `(rusqlite Value, serde_json Value)` pair the caller can bind into a
/// dynamically-built UPDATE statement and forward unchanged into the sync
/// payload. Returns `None` when the field is absent, leaving the column
/// untouched. Treats explicit JSON `null` and empty/whitespace strings as
/// "clear the column".
fn normalize_edit_settlement_nullable_text(
    raw: &Option<serde_json::Value>,
) -> Option<(rusqlite::types::Value, serde_json::Value)> {
    match raw.as_ref()? {
        serde_json::Value::Null => Some((rusqlite::types::Value::Null, serde_json::Value::Null)),
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                Some((rusqlite::types::Value::Null, serde_json::Value::Null))
            } else {
                Some((
                    rusqlite::types::Value::Text(trimmed.to_string()),
                    serde_json::Value::String(trimmed.to_string()),
                ))
            }
        }
        _ => None,
    }
}

/// Apply the optional `order_updates` payload to the local SQLite `orders`
/// row inside the caller's transaction. Returns a JSON object containing the
/// fields that were actually applied (camelCase keys) so the caller can
/// forward the same values into the sync payload destined for Supabase.
fn apply_edit_settlement_order_updates(
    conn: &rusqlite::Connection,
    order_id: &str,
    updates: &EditSettlementOrderUpdatesPayload,
    now: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    use rusqlite::types::Value;

    let mut set_clauses: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    let mut applied: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();

    fn add_text(
        json_key: &str,
        sql_col: &str,
        raw: &Option<serde_json::Value>,
        set_clauses: &mut Vec<String>,
        params: &mut Vec<rusqlite::types::Value>,
        applied: &mut serde_json::Map<String, serde_json::Value>,
    ) {
        if let Some((sql_val, json_val)) = normalize_edit_settlement_nullable_text(raw) {
            set_clauses.push(format!("{sql_col} = ?"));
            params.push(sql_val);
            applied.insert(json_key.to_string(), json_val);
        }
    }

    // order_type is required-string-only (no null/clear semantic).
    if let Some(order_type) = updates.order_type.as_deref() {
        let trimmed = order_type.trim();
        if !trimmed.is_empty() {
            set_clauses.push("order_type = ?".to_string());
            params.push(Value::Text(trimmed.to_string()));
            applied.insert(
                "orderType".to_string(),
                serde_json::Value::String(trimmed.to_string()),
            );
        }
    }

    add_text(
        "customerId",
        "customer_id",
        &updates.customer_id,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "customerName",
        "customer_name",
        &updates.customer_name,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "customerPhone",
        "customer_phone",
        &updates.customer_phone,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "customerEmail",
        "customer_email",
        &updates.customer_email,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "deliveryAddress",
        "delivery_address",
        &updates.delivery_address,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "deliveryCity",
        "delivery_city",
        &updates.delivery_city,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "deliveryPostalCode",
        "delivery_postal_code",
        &updates.delivery_postal_code,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "deliveryFloor",
        "delivery_floor",
        &updates.delivery_floor,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "deliveryNotes",
        "delivery_notes",
        &updates.delivery_notes,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "nameOnRinger",
        "name_on_ringer",
        &updates.name_on_ringer,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "tableNumber",
        "table_number",
        &updates.table_number,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "driverId",
        "driver_id",
        &updates.driver_id,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );
    add_text(
        "driverName",
        "driver_name",
        &updates.driver_name,
        &mut set_clauses,
        &mut params,
        &mut applied,
    );

    if let Some(fee) = updates.delivery_fee {
        if fee.is_finite() && fee >= 0.0 {
            // W4c dual-write: dynamic edit-settlement push for delivery_fee
            // adds the cents sibling alongside the REAL column.
            set_clauses.push("delivery_fee = ?".to_string());
            params.push(Value::Real(fee));
            set_clauses.push("delivery_fee_cents = ?".to_string());
            params.push(Value::Integer(Cents::round_half_even(fee).as_i64()));
            applied.insert("deliveryFee".to_string(), serde_json::json!(fee));
            // W4d-iv additive emission: cents sibling.
            applied.insert(
                "delivery_fee_cents".to_string(),
                serde_json::json!(Cents::round_half_even(fee).as_i64()),
            );
        }
    }

    // waiter_id has no local column on `orders` yet but the admin schema
    // accepts it, so forward the value into the sync payload only.
    if let Some((_, json_val)) = normalize_edit_settlement_nullable_text(&updates.waiter_id) {
        applied.insert("waiterId".to_string(), json_val);
    }

    if set_clauses.is_empty() {
        return Ok(applied);
    }

    set_clauses.push("sync_status = 'pending'".to_string());
    set_clauses.push("updated_at = ?".to_string());
    params.push(Value::Text(now.to_string()));

    let sql = format!("UPDATE orders SET {} WHERE id = ?", set_clauses.join(", "));
    params.push(Value::Text(order_id.to_string()));

    conn.execute(&sql, rusqlite::params_from_iter(params.iter()))
        .map_err(|e| format!("apply edit settlement order updates: {e}"))?;

    Ok(applied)
}

fn enqueue_order_edit_sync(
    conn: &rusqlite::Connection,
    order_id: &str,
    items: &[serde_json::Value],
    order_notes: Option<&str>,
    total_amount: f64,
    subtotal_amount: f64,
    payment_status: Option<&str>,
    payment_method: Option<&str>,
    extra_fields: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let mut payload_map = serde_json::Map::new();
    payload_map.insert(
        "orderId".to_string(),
        serde_json::Value::String(order_id.to_string()),
    );
    payload_map.insert(
        "items".to_string(),
        serde_json::Value::Array(items.to_vec()),
    );
    payload_map.insert(
        "orderNotes".to_string(),
        match order_notes {
            Some(s) => serde_json::Value::String(s.to_string()),
            None => serde_json::Value::Null,
        },
    );
    // W4d-iv additive emission: ship cents sibling alongside the legacy
    // camelCase float key so admin-dashboard schemas can read either.
    payload_map.insert("totalAmount".to_string(), serde_json::json!(total_amount));
    payload_map.insert(
        "total_amount_cents".to_string(),
        serde_json::json!(Cents::round_half_even(total_amount).as_i64()),
    );
    payload_map.insert("subtotal".to_string(), serde_json::json!(subtotal_amount));
    payload_map.insert(
        "subtotal_cents".to_string(),
        serde_json::json!(Cents::round_half_even(subtotal_amount).as_i64()),
    );
    // Only what the ledger (or this write) proves rides along: see
    // `payment_status_to_push`. A method is sent only when completed payment
    // rows name one; the literal "pending" is never a tender.
    if let Some(payment_status) = payment_status {
        payload_map.insert(
            "paymentStatus".to_string(),
            serde_json::Value::String(payment_status.to_string()),
        );
    }
    if let Some(payment_method) = payment_method {
        payload_map.insert(
            "paymentMethod".to_string(),
            serde_json::Value::String(payment_method.to_string()),
        );
    }
    for (key, value) in extra_fields {
        // extra_fields wins over the defaults (e.g. caller may provide an
        // explicit orderType that overrides the empty default).
        payload_map.insert(key.clone(), value.clone());
    }
    let sync_payload = serde_json::Value::Object(payload_map);
    enqueue_order_sync_payload(conn, order_id, &sync_payload)
        .map_err(|e| format!("enqueue order edit parity sync: {e}"))?;
    Ok(())
}

pub(crate) fn list_completed_payments_for_edit(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            // W4b: cents-with-real-fallback shim (removed in 4e).
            "SELECT
                op.id,
                op.method,
                COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0),
                op.created_at,
                op.transaction_ref,
                op.staff_shift_id,
                COALESCE((
                    SELECT SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER)))
                    FROM payment_adjustments pa
                    WHERE pa.payment_id = op.id
                      AND pa.adjustment_type = 'refund'
                ), 0),
                op.currency
             FROM order_payments op
             WHERE op.order_id = ?1
               AND op.status = 'completed'
             ORDER BY op.created_at ASC, op.updated_at ASC",
        )
        .map_err(|e| format!("prepare edit settlement payments: {e}"))?;

    let rows = stmt
        .query_map(rusqlite::params![order_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(|e| format!("query edit settlement payments: {e}"))?;

    let mut payments = Vec::new();
    for (
        id,
        method,
        amount_cents,
        created_at,
        transaction_ref,
        staff_shift_id,
        adjusted_cents,
        currency,
    ) in rows.filter_map(Result::ok)
    {
        // A gift row's proven return floor counts once, as in the settlement
        // snapshot; other rows keep their refund adjustments.
        let refunded_cents = crate::payments::effective_reversed_cents(
            conn,
            &id,
            order_id,
            &method,
            amount_cents,
            adjusted_cents,
        )?;
        // W4b: cents columns → f64 for the existing JSON shape.
        let amount = Cents::new(amount_cents).to_f64_dp2();
        let refunded = Cents::new(refunded_cents).to_f64_dp2();
        let mut payment = serde_json::json!({
            "id": id,
            "method": method,
            "amount": amount,
            "currency": currency,
            "createdAt": created_at,
            "transactionRef": transaction_ref,
            "staffShiftId": staff_shift_id,
            "refundedAmount": refunded,
            "remainingRefundable": (amount - refunded).max(0.0),
        });
        // Shared rule R1 (round 3 review): the platform's settlement row is
        // never refunded at the till, so the edit's refund is never
        // allocated to it. Named only on such a row.
        if crate::payments::payment_is_platform_settlement(conn, &id)? {
            payment["platformSettlement"] = serde_json::Value::Bool(true);
        }
        payments.push(payment);
    }
    Ok(payments)
}

fn load_active_driver_settlement(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    conn.query_row(
        // W4b: cents-with-real-fallback shim (removed in 4e). Existing
        // JSON shape consumed by the renderer is unchanged.
        "SELECT id, driver_id, staff_shift_id,
                COALESCE(cash_collected_cents, CAST(ROUND(cash_collected * 100) AS INTEGER), 0),
                COALESCE(card_amount_cents, CAST(ROUND(card_amount * 100) AS INTEGER), 0),
                COALESCE(cash_to_return_cents, CAST(ROUND(cash_to_return * 100) AS INTEGER), 0)
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
                "cashCollected": Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
                "cardAmount": Cents::new(row.get::<_, i64>(4)?).to_f64_dp2(),
                "cashToReturn": Cents::new(row.get::<_, i64>(5)?).to_f64_dp2(),
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
    parsed.customer_id = normalize_optional_text(parsed.customer_id);
    parsed.customer_name = parsed.customer_name.trim().to_string();
    parsed.customer_phone = parsed.customer_phone.trim().to_string();
    parsed.delivery_address = parsed.delivery_address.trim().to_string();
    parsed.delivery_address_id = normalize_optional_text(parsed.delivery_address_id);
    parsed.customer_email = normalize_optional_text(parsed.customer_email);
    parsed.delivery_postal_code = normalize_optional_text(parsed.delivery_postal_code);
    parsed.delivery_floor = normalize_optional_text(parsed.delivery_floor);
    parsed.delivery_notes = normalize_optional_text(parsed.delivery_notes);
    parsed.name_on_ringer = normalize_optional_text(parsed.name_on_ringer);
    parsed.delivery_address_fingerprint =
        normalize_optional_text(parsed.delivery_address_fingerprint);

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
    if parsed
        .delivery_latitude
        .is_some_and(|value| !value.is_finite() || !(-90.0..=90.0).contains(&value))
    {
        return Err("Invalid deliveryLatitude".into());
    }
    if parsed
        .delivery_longitude
        .is_some_and(|value| !value.is_finite() || !(-180.0..=180.0).contains(&value))
    {
        return Err("Invalid deliveryLongitude".into());
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
    parsed.delivery_address_id = normalize_optional_text(parsed.delivery_address_id);
    parsed.delivery_city = normalize_optional_text(parsed.delivery_city);
    parsed.delivery_postal_code = normalize_optional_text(parsed.delivery_postal_code);
    parsed.delivery_floor = normalize_optional_text(parsed.delivery_floor);
    parsed.delivery_notes = normalize_optional_text(parsed.delivery_notes);
    parsed.name_on_ringer = normalize_optional_text(parsed.name_on_ringer);
    parsed.delivery_address_fingerprint =
        normalize_optional_text(parsed.delivery_address_fingerprint);
    parsed.delivery_zone_id = normalize_optional_text(parsed.delivery_zone_id);

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
    if parsed
        .delivery_latitude
        .is_some_and(|value| !value.is_finite() || !(-90.0..=90.0).contains(&value))
    {
        return Err("Invalid deliveryLatitude".into());
    }
    if parsed
        .delivery_longitude
        .is_some_and(|value| !value.is_finite() || !(-180.0..=180.0).contains(&value))
    {
        return Err("Invalid deliveryLongitude".into());
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
        resolve_renderer_order_id(&conn, &id)?
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

/// What the local status write decided.
pub(crate) enum LocalStatusChange {
    /// A payment blocker refused completion or delivery: the answer to return.
    Blocked(serde_json::Value),
    /// Written and queued locally: the ids for the events and the server patch.
    Applied {
        order_id: String,
        remote_order_id: Option<String>,
    },
}

/// The local half of `order_update_status`: the transition, the guards
/// (payment blockers before completion, money taken before a cancel) and the
/// write with its sync payload.
pub(crate) fn apply_order_status_locally(
    db: &db::DbState,
    order_id_raw: &str,
    status: &str,
    estimated_time: Option<i64>,
    cancellation_reason: Option<&str>,
    now: &str,
) -> Result<LocalStatusChange, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (actual_order_id, remote_order_id) = resolve_order_id_with_remote(&conn, order_id_raw)?;
    ensure_box_order_mutation_allowed(&conn, &actual_order_id, status, BoxOrderMutation::Generic)?;
    let previous_status = ensure_order_status_transition_allowed(&conn, &actual_order_id, status)?;
    // Fix review 30/09/2026 (founder rule, Android parity): money taken on
    // the order is voided or refunded from the order first, or the rest is
    // collected. Cancelling it would take back what the drawer counted for
    // it while its payment stays recorded. Refused before anything is
    // written.
    if status == "cancelled" {
        ensure_generic_table_cancellation_allowed(&conn, &actual_order_id)?;
    }
    if status == "cancelled" && previous_status != "cancelled" {
        ensure_no_money_taken_before_cancel(&conn, &actual_order_id)?;
    }
    if status_requires_payment_integrity_guard(status) {
        // THE-437: prepaid and platform-rider-COD orders settle by bank —
        // record their settlement automatically instead of asking the
        // operator to collect money the platform is holding. Failure falls
        // through to the normal blocker so the operator still gets a path.
        if let Err(error) = payments::auto_settle_platform_order(&conn, &actual_order_id) {
            tracing::warn!(
                order_id = %actual_order_id,
                error = %error,
                "Platform auto-settlement failed; falling back to payment blockers"
            );
        }
        let blockers = payment_integrity::load_order_payment_blockers(&conn, &actual_order_id)?;
        if !blockers.is_empty() {
            let action_label = if status == "delivered" {
                "Cannot mark order as delivered"
            } else {
                "Cannot mark order as completed"
            };
            return Ok(LocalStatusChange::Blocked(
                payment_integrity::build_unsettled_payment_blocker_response(
                    action_label,
                    &blockers,
                ),
            ));
        }
    }
    let was_cancelled = previous_status == "cancelled";
    let next_is_cancelled = status == "cancelled";
    let is_cancellation_reactivation = was_cancelled && status == "pending";

    if !was_cancelled && next_is_cancelled {
        order_ownership::reverse_order_drawer_attribution(&conn, &actual_order_id, now)?;
    }

    if let Some(reason) = cancellation_reason {
        conn.execute(
            "UPDATE orders
             SET status = ?1,
                 cancellation_reason = ?2,
                 sync_status = 'pending',
                 updated_at = ?3
             WHERE id = ?4",
            rusqlite::params![status, reason, now, actual_order_id],
        )
        .map_err(|e| format!("update order status: {e}"))?;
    } else if is_cancellation_reactivation {
        conn.execute(
            "UPDATE orders
             SET status = ?1,
                 cancellation_reason = NULL,
                 sync_status = 'pending',
                 updated_at = ?2
             WHERE id = ?3",
            rusqlite::params![status, now, actual_order_id],
        )
        .map_err(|e| format!("update order status: {e}"))?;
    } else {
        conn.execute(
            "UPDATE orders
             SET status = ?1, sync_status = 'pending', updated_at = ?2
             WHERE id = ?3",
            rusqlite::params![status, now, actual_order_id],
        )
        .map_err(|e| format!("update order status: {e}"))?;
    }
    if let Some(eta) = estimated_time {
        let _ = conn.execute(
            "UPDATE orders SET estimated_time = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![eta, now, actual_order_id],
        );
    }
    let mut sync_payload = serde_json::json!({
        "orderId": actual_order_id,
        "status": status,
        "estimatedTime": estimated_time
    });
    if let Some(reason) = cancellation_reason {
        // Send under both keys so whichever convention the server reads is
        // satisfied (admin-dashboard inspects both shapes).
        if let Some(obj) = sync_payload.as_object_mut() {
            obj.insert(
                "cancellation_reason".to_string(),
                serde_json::Value::String(reason.to_string()),
            );
            obj.insert(
                "cancellationReason".to_string(),
                serde_json::Value::String(reason.to_string()),
            );
            obj.insert(
                "cancelled_at".to_string(),
                serde_json::Value::String(now.to_string()),
            );
        }
    } else if is_cancellation_reactivation {
        if let Some(obj) = sync_payload.as_object_mut() {
            obj.insert("cancellation_reason".to_string(), serde_json::Value::Null);
            obj.insert("cancellationReason".to_string(), serde_json::Value::Null);
            obj.insert("cancelled_at".to_string(), serde_json::Value::Null);
            obj.insert("cancelledAt".to_string(), serde_json::Value::Null);
        }
    }
    enqueue_order_sync_payload(&conn, &actual_order_id, &sync_payload)?;
    Ok(LocalStatusChange::Applied {
        order_id: actual_order_id,
        remote_order_id,
    })
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
    // Only honor cancellation_reason when the transition is actually to
    // cancelled. For other transitions (e.g. complete -> delivered) we never
    // overwrite the existing reason column.
    let cancellation_reason: Option<String> = if status == "cancelled" {
        payload
            .cancellation_reason
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    } else {
        None
    };
    let now = Utc::now().to_rfc3339();

    let (actual_order_id, remote_order_id) = match apply_order_status_locally(
        &db,
        &order_id_raw,
        &status,
        estimated_time,
        cancellation_reason.as_deref(),
        &now,
    )? {
        LocalStatusChange::Blocked(answer) => return Ok(answer),
        LocalStatusChange::Applied {
            order_id,
            remote_order_id,
        } => (order_id, remote_order_id),
    };

    let mut event_payload = serde_json::json!({
        "orderId": actual_order_id,
        "status": status,
        "estimatedTime": estimated_time
    });
    if let Some(reason) = cancellation_reason.as_ref() {
        if let Some(obj) = event_payload.as_object_mut() {
            obj.insert(
                "cancellationReason".to_string(),
                serde_json::Value::String(reason.clone()),
            );
        }
    } else if status == "pending" {
        if let Some(obj) = event_payload.as_object_mut() {
            obj.insert("cancellationReason".to_string(), serde_json::Value::Null);
        }
    }
    let _ = app.emit("order_status_updated", event_payload.clone());
    let _ = app.emit("order_realtime_update", event_payload);

    if let Some(remote_order_id) = remote_order_id.as_deref() {
        spawn_immediate_order_status_patch(
            &db,
            build_order_status_patch_body(
                remote_order_id,
                &status,
                estimated_time,
                cancellation_reason.as_deref(),
                if status == "cancelled" {
                    Some(now.as_str())
                } else {
                    None
                },
            ),
        );
    }

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
        delivery_address_id,
        delivery_city,
        delivery_postal_code,
        delivery_floor,
        delivery_notes,
        name_on_ringer,
        delivery_latitude,
        delivery_longitude,
        delivery_address_fingerprint,
        delivery_zone_id,
        delivery_fee,
        total_amount,
    } = payload;

    let now = chrono::Utc::now().to_rfc3339();
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let actual_order_id = resolve_renderer_order_id(&conn, &order_id)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin pickup to delivery transaction: {e}"))?;

    // W4c dual-write: delivery_fee/total_amount must update their `_cents`
    // siblings too, or the COALESCE-with-real read shim shadows the new
    // REAL values with stale cents.
    let delivery_fee_cents = Cents::round_half_even(delivery_fee).as_i64();
    let total_amount_cents = Cents::round_half_even(total_amount).as_i64();
    tx.execute(
        "UPDATE orders
         SET customer_id = ?1,
             customer_name = ?2,
             customer_phone = ?3,
              customer_email = ?4,
              order_type = 'delivery',
              delivery_address = ?5,
              delivery_address_id = ?6,
              delivery_city = ?7,
              delivery_postal_code = ?8,
              delivery_floor = ?9,
              delivery_notes = ?10,
              name_on_ringer = ?11,
              delivery_latitude = ?12,
              delivery_longitude = ?13,
              delivery_address_fingerprint = ?14,
              delivery_zone_id = ?15,
              delivery_fee = ?16,
              delivery_fee_cents = ?17,
              total_amount = ?18,
              total_amount_cents = ?19,
              driver_id = NULL,
              driver_name = NULL,
              sync_status = 'pending',
              updated_at = ?20
          WHERE id = ?21",
        rusqlite::params![
            customer_id.as_deref(),
            &customer_name,
            &customer_phone,
            customer_email.as_deref(),
            &delivery_address,
            delivery_address_id.as_deref(),
            delivery_city.as_deref(),
            delivery_postal_code.as_deref(),
            delivery_floor.as_deref(),
            delivery_notes.as_deref(),
            name_on_ringer.as_deref(),
            delivery_latitude,
            delivery_longitude,
            delivery_address_fingerprint.as_deref(),
            delivery_zone_id.as_deref(),
            delivery_fee,
            delivery_fee_cents,
            total_amount,
            total_amount_cents,
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
        "deliveryAddressId": delivery_address_id,
        "delivery_address_id": delivery_address_id,
        "deliveryCity": delivery_city,
        "deliveryPostalCode": delivery_postal_code,
        "deliveryFloor": delivery_floor,
        "deliveryNotes": delivery_notes,
        "nameOnRinger": name_on_ringer,
        "deliveryLatitude": delivery_latitude,
        "delivery_latitude": delivery_latitude,
        "deliveryLongitude": delivery_longitude,
        "delivery_longitude": delivery_longitude,
        "deliveryAddressFingerprint": delivery_address_fingerprint,
        "delivery_address_fingerprint": delivery_address_fingerprint,
        "deliveryZoneId": delivery_zone_id,
        "delivery_zone_id": delivery_zone_id,
        // W4d-iv additive emission: legacy camelCase floats stay alongside
        // snake_case_cents siblings so admin-dashboard can read either.
        "deliveryFee": delivery_fee,
        "delivery_fee_cents": Cents::round_half_even(delivery_fee).as_i64(),
        "totalAmount": total_amount,
        "total_amount_cents": Cents::round_half_even(total_amount).as_i64()
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
        customer_id,
        customer_name,
        customer_email,
        customer_phone,
        delivery_address,
        delivery_address_id,
        delivery_postal_code,
        delivery_floor,
        delivery_notes,
        name_on_ringer,
        delivery_latitude,
        delivery_longitude,
        delivery_address_fingerprint,
    } = payload;

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let actual_order_id = resolve_renderer_order_id(&conn, &order_id)?;
        conn.execute(
            "UPDATE orders
             SET customer_name = ?1,
                 customer_phone = ?2,
                  customer_id = COALESCE(?3, customer_id),
                  customer_email = COALESCE(?4, customer_email),
                  delivery_address = ?5,
                  delivery_address_id = COALESCE(?6, delivery_address_id),
                  delivery_postal_code = COALESCE(?7, delivery_postal_code),
                  delivery_floor = COALESCE(?8, delivery_floor),
                  name_on_ringer = COALESCE(?9, name_on_ringer),
                  delivery_notes = COALESCE(?10, delivery_notes),
                  delivery_latitude = COALESCE(?11, delivery_latitude),
                  delivery_longitude = COALESCE(?12, delivery_longitude),
                  delivery_address_fingerprint = COALESCE(?13, delivery_address_fingerprint),
                  sync_status = 'pending',
                  updated_at = ?14
              WHERE id = ?15",
            rusqlite::params![
                &customer_name,
                &customer_phone,
                customer_id.as_deref(),
                customer_email.as_deref(),
                &delivery_address,
                delivery_address_id.as_deref(),
                delivery_postal_code.as_deref(),
                delivery_floor.as_deref(),
                name_on_ringer.as_deref(),
                delivery_notes.as_deref(),
                delivery_latitude,
                delivery_longitude,
                delivery_address_fingerprint.as_deref(),
                &now,
                &actual_order_id,
            ],
        )
        .map_err(|e| format!("update order customer info: {e}"))?;

        let sync_payload = serde_json::json!({
            "orderId": actual_order_id,
            "customerId": customer_id,
            "customer_id": customer_id,
            "customerName": customer_name,
            "customerEmail": customer_email,
            "customerPhone": customer_phone,
            "deliveryAddress": delivery_address,
            "deliveryAddressId": delivery_address_id,
            "delivery_address_id": delivery_address_id,
            "deliveryPostalCode": delivery_postal_code,
            "deliveryFloor": delivery_floor,
            "delivery_floor": delivery_floor,
            "nameOnRinger": name_on_ringer,
            "name_on_ringer": name_on_ringer,
            "deliveryNotes": delivery_notes,
            "deliveryLatitude": delivery_latitude,
            "delivery_latitude": delivery_latitude,
            "deliveryLongitude": delivery_longitude,
            "delivery_longitude": delivery_longitude,
            "deliveryAddressFingerprint": delivery_address_fingerprint,
            "delivery_address_fingerprint": delivery_address_fingerprint,
        });
        enqueue_order_sync_payload(&conn, &actual_order_id, &sync_payload)?;
        actual_order_id
    };

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

fn ensure_full_order_item_replacement_safe(
    conn: &rusqlite::Connection,
    order_id: &str,
    expected_version: Option<i64>,
    requested_session: Option<&str>,
) -> Result<(), String> {
    if room_charge_is_unconfirmed(conn, order_id)? {
        return Err("FOLIO_CHARGE_RECONCILIATION_REQUIRED: synchronize the room charge before changing its items.".to_string());
    }
    let balance = payments::load_order_payment_balance_snapshot(conn, order_id)?;
    let (payment_status,remote_id,session_id,table_id,items_json,version):(String,Option<String>,Option<String>,Option<String>,String,i64)=conn.query_row(
        "SELECT COALESCE(payment_status,'pending'),NULLIF(TRIM(supabase_id),''),NULLIF(TRIM(table_session_id),''),
        NULLIF(TRIM(table_id),''),COALESCE(items,'[]'),COALESCE(remote_version,version,1) FROM orders WHERE id=?1",
        rusqlite::params![order_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))
        .map_err(|error|format!("Read order edit scope: {error}"))?;
    if balance.net_paid > 0.005
        || balance.completed_payment_count > 0
        || matches!(
            payment_status.trim().to_ascii_lowercase().as_str(),
            "paid" | "completed" | "partial" | "partially_paid"
        )
    {
        return Err("Paid order item changes require the settlement/refund workflow.".into());
    }
    if remote_id.is_some() && expected_version.filter(|v| *v >= 1).is_none() {
        return Err(
            "Refresh the order before editing; its original server version is required.".into(),
        );
    }
    if let Some(expected) = expected_version {
        if expected != version {
            return Err("Order changed since editing began. Refresh before saving.".into());
        }
    }
    if table_id.is_none() && session_id.is_none() {
        return Ok(());
    }
    // The only reconstructible local scope is a new, unsynced, unsplit order.
    if remote_id.is_none()
        && session_id
            .as_deref()
            .map_or(true, |id| id.starts_with("local-table-session:"))
    {
        return Ok(());
    }
    let session_id = requested_session
        .ok_or("An exact table check is required before replacing table order items.")?;
    let remote_id = remote_id.ok_or("Sync the table order before changing a server check.")?;
    let table_id =
        table_id.ok_or("Table order ownership is unavailable; refresh before editing.")?;
    let cached = crate::table_session_cache::load(
        conn,
        &serde_json::json!({"sessionId":session_id,"orderId":remote_id,"tableId":table_id}),
    )?;
    let session = &cached["session"];
    if session.pointer("/order/version").and_then(Value::as_i64) != expected_version {
        return Err("Saved table check version changed. Refresh before editing.".into());
    }
    ensure_snapshot_has_complete_unpaid_order(session, &items_json, &remote_id)
}

fn ensure_snapshot_has_complete_unpaid_order(
    session: &Value,
    canonical_items_json: &str,
    remote_id: &str,
) -> Result<(), String> {
    let blocked =
        "Split, transferred, merged or paid checks require the canonical order-edit workflow.";
    let money_or_quantity = |value: Option<&Value>| {
        value
            .and_then(|value| {
                value
                    .as_f64()
                    .or_else(|| value.as_str()?.parse::<f64>().ok())
            })
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or(blocked)
    };
    if money_or_quantity(session.pointer("/balance/paid_total"))? > 0.005
        || session
            .pointer("/metadata/created_by_transfer_from_session_id")
            .is_some()
        || session
            .pointer("/metadata/merged_session_ids")
            .and_then(Value::as_array)
            .is_some_and(|ids| !ids.is_empty())
    {
        return Err(blocked.into());
    }
    let allocations = session
        .get("items")
        .and_then(Value::as_array)
        .ok_or(blocked)?;
    for allocation in allocations {
        if money_or_quantity(allocation.get("paid_quantity"))? > 0.0005
            || matches!(
                allocation.get("status").and_then(Value::as_str),
                Some("transferred" | "voided")
            )
            || allocation
                .get("order_id")
                .and_then(Value::as_str)
                .is_some_and(|id| id != remote_id)
            || allocation
                .pointer("/metadata/transferred_from_session_id")
                .is_some()
            || allocation
                .pointer("/metadata/transferred_to_session_id")
                .is_some()
        {
            return Err(blocked.into());
        }
    }
    let canonical: Vec<Value> = serde_json::from_str(canonical_items_json).map_err(|_| blocked)?;
    let shown = session
        .pointer("/order/order_items")
        .and_then(Value::as_array)
        .ok_or(blocked)?;
    if canonical.len() != shown.len() {
        return Err(blocked.into());
    }
    let identities = |item: &Value| -> [Option<String>; 4] {
        ["source_order_item_id", "order_item_id", "id", "item_id"].map(|key| {
            item.get(key)
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
    };
    let mut matched = HashSet::new();
    for line in shown {
        let identity = identities(line);
        let Some((index, _)) = canonical.iter().enumerate().find(|(index, item)| {
            !matched.contains(index)
                && identities(item)
                    .iter()
                    .flatten()
                    .any(|id| identity.iter().flatten().any(|candidate| id == candidate))
                && (value_f64(item, &["quantity"]).unwrap_or(0.0)
                    - value_f64(line, &["quantity"]).unwrap_or(-1.0))
                .abs()
                    < 0.0005
        }) else {
            return Err(blocked.into());
        };
        matched.insert(index);
    }
    Ok(())
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
    let expected_version = payload.expected_version;
    let table_session_id = payload.table_session_id;
    let client_event_id = payload
        .client_event_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = Utc::now().to_rfc3339();

    let (resolved_order_id, remote_edit_request) = {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        let actual = resolve_renderer_order_id(&conn, &order_id_raw)?;
        let has_remote: bool = conn
            .query_row(
                "SELECT NULLIF(TRIM(supabase_id),'') IS NOT NULL FROM orders WHERE id=?1",
                [&actual],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let original = if has_remote {
            crate::table_session_cache::existing_item_edit_attempt(
                &conn,
                &actual,
                &client_event_id,
            )?
        } else {
            None
        };
        if let Some(original) = original {
            ensure_original_item_edit_intent(
                &original,
                &items,
                notes.as_deref(),
                expected_version,
                table_session_id.as_deref(),
            )?;
            crate::table_attempt_recovery::remember_item(&conn, &actual, &original)?;
            (actual, Some(original))
        } else {
            ensure_full_order_item_replacement_safe(
                &conn,
                &actual,
                expected_version,
                table_session_id.as_deref(),
            )?;
            let (remote,status,table,guests):(Option<String>,String,Option<String>,Option<i64>)=conn.query_row(
            "SELECT NULLIF(TRIM(supabase_id),''),status,table_id,guest_count FROM orders WHERE id=?1",
            rusqlite::params![actual],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))
            .map_err(|error|format!("Read canonical order edit identity: {error}"))?;
            let request = if let Some(remote) = remote {
                let merged = merge_existing_order_item_customizations(&conn, &actual, &items)?;
                let canonical_items: Vec<Value> =
                    merged.iter().map(canonical_item_edit_payload).collect();
                let mut body = serde_json::json!({"id":remote,"status":status,"items":canonical_items,
                "expected_version":expected_version,"table_id":table,"table_session_id":table_session_id,
                "guest_count":guests,"client_event_id":client_event_id});
                if let Some(notes) = &notes {
                    body["special_instructions"] = serde_json::json!(notes);
                }
                crate::table_session_cache::item_edit_attempt(&conn, &actual, &mut body)?;
                Some(body)
            } else {
                None
            };
            (actual, request)
        }
    };
    if let Some(request) = remote_edit_request {
        // A remote denial or uncertain transport leaves the old local totals
        // intact. The durable immutable attempt permits exact replay later.
        let answer = crate::admin_fetch_detailed(
            Some(&db),
            "/api/pos/orders",
            "PATCH",
            Some(request.clone()),
        )
        .await
        .map_err(|error| {
            format!(
                "Order edit was not confirmed. Reconnect and retry the original change: {error}"
            )
        })?;
        let canonical = answer
            .get("data")
            .filter(|order| order.get("id") == request.get("id"))
            .ok_or("Canonical order edit response has no matching order")?;
        if canonical
            .get("order_items")
            .and_then(Value::as_array)
            .is_none()
            || canonical
                .get("version")
                .and_then(Value::as_i64)
                .is_none_or(|version| version < expected_version.unwrap_or(1))
        {
            return Err(
                "Canonical order edit response has no complete item/version snapshot".into(),
            );
        }
        let scoped_session = crate::table_attempt_recovery::confirm_foreground_item(
            &db,
            &resolved_order_id,
            &request,
        )
        .await?;
        if let Ok(order_json) = sync::get_order_by_id(&db, &resolved_order_id) {
            let _ = app.emit("order_realtime_update", order_json);
        }
        return Ok(
            serde_json::json!({"success":true,"orderId":resolved_order_id,"data":answer,"session":scoped_session}),
        );
    }

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let transaction = conn
            .unchecked_transaction()
            .map_err(|error| format!("Begin durable order item edit: {error}"))?;
        let actual_order_id = resolve_renderer_order_id(&conn, &order_id_raw)?;
        ensure_full_order_item_replacement_safe(
            &conn,
            &actual_order_id,
            expected_version,
            table_session_id.as_deref(),
        )?;
        let queued_base_version: i64 = conn
            .query_row(
                "SELECT COALESCE(version,1) FROM orders WHERE id=?1",
                rusqlite::params![actual_order_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let merged_items =
            merge_existing_order_item_customizations(&conn, &actual_order_id, &items)?;
        let total = compute_order_items_total(&merged_items);
        let items_json =
            serde_json::to_string(&merged_items).map_err(|e| format!("serialize items: {e}"))?;
        // W4c dual-write: the post-edit total_amount must propagate to
        // total_amount_cents too — otherwise downstream COALESCE reads
        // get the pre-edit cents value instead of the new real.
        let total_cents = Cents::round_half_even(total).as_i64();
        if let Some(order_notes) = notes.clone() {
            conn.execute(
                "UPDATE orders
                 SET items = ?1, total_amount = ?2, total_amount_cents = ?3, special_instructions = ?4, sync_status = 'pending', updated_at = ?5
                 WHERE id = ?6",
                rusqlite::params![items_json, total, total_cents, order_notes, now, actual_order_id],
            )
            .map_err(|e| format!("update order items: {e}"))?;
        } else {
            conn.execute(
                "UPDATE orders
                 SET items = ?1, total_amount = ?2, total_amount_cents = ?3, sync_status = 'pending', updated_at = ?4
                 WHERE id = ?5",
                rusqlite::params![items_json, total, total_cents, now, actual_order_id],
            )
            .map_err(|e| format!("update order items: {e}"))?;
        }
        let sync_payload = serde_json::json!({
            "orderId": actual_order_id,
            "items": merged_items,
            "orderNotes": notes,
            "expected_version": expected_version.unwrap_or(queued_base_version),
            "table_session_id": table_session_id,
            "client_event_id": client_event_id
        });
        enqueue_order_sync_payload(&conn, &actual_order_id, &sync_payload)?;
        transaction
            .commit()
            .map_err(|error| format!("Commit durable order item edit: {error}"))?;
        actual_order_id
    };

    if let Ok(order_json) = sync::get_order_by_id(&db, &actual_order_id) {
        let _ = app.emit("order_realtime_update", order_json);
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id
    }))
}

fn ensure_original_item_edit_intent(
    original: &Value,
    items: &[Value],
    notes: Option<&str>,
    version: Option<i64>,
    session: Option<&str>,
) -> Result<(), String> {
    let saved = original
        .get("items")
        .and_then(Value::as_array)
        .ok_or("Original edit items are unavailable")?;
    let merged = merge_order_item_customizations(saved, items)?;
    let canonical: Vec<Value> = merged.iter().map(canonical_item_edit_payload).collect();
    if original.get("expected_version").and_then(Value::as_i64) != version
        || original.get("table_session_id").and_then(Value::as_str) != session
        || original.get("special_instructions").and_then(Value::as_str) != notes
        || canonical != *saved
    {
        return Err("RECOVERY_ORIGINAL_REQUEST_REQUIRED".into());
    }
    Ok(())
}

fn canonical_item_edit_payload(item: &Value) -> Value {
    let mut normalized = item.clone();
    let canonical_id = value_str(
        item,
        &[
            "source_order_item_id",
            "sourceOrderItemId",
            "order_item_id",
            "orderItemId",
            "id",
        ],
    )
    .filter(|id| uuid::Uuid::parse_str(id).is_ok());
    if let Some(id) = canonical_id {
        normalized["id"] = serde_json::json!(id);
    } else if let Some(object) = normalized.as_object_mut() {
        object.remove("id");
    }
    normalized["menu_item_id"] = value_str(item, &["menu_item_id", "menuItemId"])
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .map(Value::String)
        .unwrap_or(Value::Null);
    normalized["quantity"] = serde_json::json!(value_f64(item, &["quantity"]).unwrap_or(0.0));
    normalized["unit_price"] =
        serde_json::json!(value_f64(item, &["unit_price", "unitPrice", "price"]).unwrap_or(0.0));
    if let Some(original) = value_f64(item, &["original_unit_price", "originalUnitPrice"]) {
        normalized["original_unit_price"] = serde_json::json!(original);
    }
    normalized
}

#[cfg(test)]
mod table_item_scope_guard_tests {
    use super::*;
    fn snapshot(quantity: f64) -> Value {
        serde_json::json!({
            "balance":{"paid_total":0},"order":{"order_items":[{"id":"line","quantity":quantity}]},
            "items":[{"order_id":"parent","order_item_id":"line","quantity":quantity,"paid_quantity":0,"status":"open"}]
        })
    }
    #[test]
    fn rejects_partial_parent_replacement_and_paid_or_transferred_scopes() {
        let parent = r#"[{"id":"line","quantity":3}]"#;
        assert!(
            ensure_snapshot_has_complete_unpaid_order(&snapshot(1.0), parent, "parent").is_err()
        );
        assert!(
            ensure_snapshot_has_complete_unpaid_order(&snapshot(3.0), parent, "parent").is_ok()
        );
        let mut claimed = snapshot(3.0);
        claimed["balance"]["paid_total"] = serde_json::json!("10");
        assert!(ensure_snapshot_has_complete_unpaid_order(&claimed, parent, "parent").is_err());
        let mut paid = snapshot(3.0);
        paid["items"][0]["paid_quantity"] = serde_json::json!(1);
        assert!(ensure_snapshot_has_complete_unpaid_order(&paid, parent, "parent").is_err());
        let mut transferred = snapshot(3.0);
        transferred["items"][0]["status"] = serde_json::json!("transferred");
        assert!(ensure_snapshot_has_complete_unpaid_order(&transferred, parent, "parent").is_err());
        let mut foreign = snapshot(3.0);
        foreign["items"][0]["order_id"] = serde_json::json!("another-order");
        assert!(ensure_snapshot_has_complete_unpaid_order(&foreign, parent, "parent").is_err());
    }
    #[test]
    fn canonical_edit_keeps_line_identity_separate_from_menu_identity() {
        let line = "11111111-1111-4111-8111-111111111111";
        let menu = "22222222-2222-4222-8222-222222222222";
        let normalized =
            canonical_item_edit_payload(&serde_json::json!({"id":menu,"source_order_item_id":line,
            "menuItemId":menu,"quantity":3,"price":8}));
        assert_eq!(normalized["id"], serde_json::json!(line));
        assert_eq!(normalized["menu_item_id"], serde_json::json!(menu));
        assert_eq!(normalized["quantity"], serde_json::json!(3.0));
    }
    #[test]
    fn crash_edit_exact_saved_intent_replays_without_current_state_rebase() {
        let item = serde_json::json!({"id":"11111111-1111-4111-8111-111111111111","quantity":1,"price":10,"customizations":[{"name":"Oat milk"}]});
        let original = serde_json::json!({"expected_version":7,"table_session_id":"check","items":[canonical_item_edit_payload(&item)]});
        let mut incoming = item.clone();
        incoming.as_object_mut().unwrap().remove("customizations");
        assert!(ensure_original_item_edit_intent(
            &original,
            &[incoming.clone()],
            None,
            Some(7),
            Some("check")
        )
        .is_ok());
        incoming["quantity"] = serde_json::json!(2);
        assert!(ensure_original_item_edit_intent(
            &original,
            &[incoming],
            None,
            Some(7),
            Some("check")
        )
        .is_err());
        assert!(
            ensure_original_item_edit_intent(&original, &[item], None, Some(8), Some("check"))
                .is_err()
        );
    }

    #[test]
    fn parses_original_edit_version_and_attempt_without_rebasing() {
        let parsed = parse_order_update_items_payload(
            Some(serde_json::json!({"orderId":"order","items":[],
            "expectedVersion":7,"tableSessionId":"check","clientEventId":"original-attempt"})),
            None,
        )
        .unwrap();
        assert_eq!(parsed.expected_version, Some(7));
        assert_eq!(parsed.table_session_id.as_deref(), Some("check"));
        assert_eq!(parsed.client_event_id.as_deref(), Some("original-attempt"));
    }
}

#[cfg(test)]
mod generic_table_mutation_guard_tests {
    use super::*;
    use rusqlite::{params, Connection};
    fn database() -> db::DbState {
        let conn = Connection::open_in_memory().unwrap();
        db::run_migrations_for_test(&conn);
        conn.execute("INSERT INTO orders(id,supabase_id,status,payment_status,sync_status,items,total_amount,created_at,updated_at,order_type,organization_id,branch_id) VALUES ('local-parent','11111111-1111-4111-8111-111111111111','pending','pending','synced','[]',10,'2099-01-01T12:00:00Z','2099-01-01T12:00:00Z','dine-in','org','branch')",[]).unwrap();
        db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }
    fn unchanged(db: &db::DbState) {
        let conn = db.conn.lock().unwrap();
        let status: String = conn
            .query_row("SELECT status FROM orders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(status, "pending");
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(queued, 0);
    }
    #[test]
    fn raw_table_cancel_refuses_before_local_status_and_queue_mutation() {
        let db = database();
        db.conn
            .lock()
            .unwrap()
            .execute("UPDATE orders SET table_session_id='canonical-check'", [])
            .unwrap();
        let error = apply_order_status_locally(
            &db,
            "local-parent",
            "cancelled",
            None,
            Some("left"),
            "2099-01-01T12:01:00Z",
        )
        .err()
        .expect("bound table cancellation requires canonical Tables workflow");
        assert!(error.contains("TABLE_ORDER_CANONICAL_CANCEL_REQUIRED"));
        unchanged(&db);
    }
    #[test]
    fn raw_decline_refuses_bound_table_before_local_status_and_queue_mutation() {
        let db = database();
        db.conn
            .lock()
            .unwrap()
            .execute("UPDATE orders SET table_id='bound-table'", [])
            .unwrap();
        let error =
            decline_order_locally(&db, "local-parent", "left", "2099-01-01T12:01:00Z").unwrap_err();
        assert!(error.contains("TABLE_ORDER_CANONICAL_CANCEL_REQUIRED"));
        unchanged(&db);
    }
    #[test]
    fn historical_wire_flag_survives_check_cache_eviction_for_delete_guard() {
        let db = database();
        let conn = db.conn.lock().unwrap();
        let owner = "22222222-2222-4222-8222-222222222222";
        for (key, value) in [
            ("organization_id", "org"),
            ("branch_id", "branch"),
            ("terminal_id", owner),
            ("owner_terminal_db_id", owner),
        ] {
            db::set_setting(&conn, "terminal", key, value).unwrap();
        }
        crate::table_session_cache::remember_order_history(&conn,&serde_json::json!({"id":"11111111-1111-4111-8111-111111111111",
            "organization_id":"org","branch_id":"branch","owner_terminal_id":owner,"has_table_service_history":true})).unwrap();
        conn.execute(
            "UPDATE orders SET order_type='pickup',table_id=NULL,table_session_id=NULL",
            [],
        )
        .unwrap();
        assert!(resolve_renderer_deletable_order_id(&conn, "local-parent")
            .unwrap_err()
            .contains("TABLE_ORDER_HISTORY_DELETE_REFUSED"));
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
    #[test]
    fn authoritative_tombstone_keeps_table_history_hidden_instead_of_hard_delete() {
        let db = database();
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE orders SET table_session_id='canonical-check'", [])
            .unwrap();
        assert_eq!(
            apply_server_order_deletion(&conn, "local-parent", "2099-01-01T12:02:00Z").unwrap(),
            ServerDeletionOutcome::KeptHidden
        );
        let row: (String, Option<String>) = conn
            .query_row(
                "SELECT status,server_deleted_at FROM orders WHERE id='local-parent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("pending".into(), Some("2099-01-01T12:02:00Z".into())));
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(queued, 0);
    }
    #[test]
    fn renderer_delete_refuses_historical_table_even_after_conversion_clears_binding() {
        let db = database();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE orders SET order_type='pickup',table_id=NULL,table_session_id=NULL",
                [],
            )
            .unwrap();
            conn.execute_batch("CREATE TABLE table_session_snapshots_v1(organization_id TEXT,branch_id TEXT,snapshot_json TEXT)").unwrap();
            conn.execute("INSERT INTO table_session_snapshots_v1 VALUES ('org','branch',?1)",params![serde_json::json!({"active_order_id":"11111111-1111-4111-8111-111111111111","status":"closed"}).to_string()]).unwrap();
            assert!(resolve_renderer_deletable_order_id(&conn, "local-parent")
                .unwrap_err()
                .contains("TABLE_ORDER_HISTORY_DELETE_REFUSED"));
        }
        unchanged(&db);
        // Conversion clears the current binding: ordinary pickup cancel stays
        // available, subject to the existing receipt/paid-claim guards.
        assert!(apply_order_status_locally(
            &db,
            "local-parent",
            "cancelled",
            None,
            Some("pickup left"),
            "2099-01-01T12:01:00Z"
        )
        .is_ok());
    }
}

#[tauri::command]
pub async fn orders_preview_edit_settlement(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_order_edit_settlement_preview_payload(arg0)?;
    // The collect/refund prompt must be computed against the whole ledger,
    // not a local mirror that lost rows (29/09/2026).
    restore_payment_ledger_before_payment_decision(
        &db,
        &payload.order_id,
        LedgerRestoreStep::Preview,
    )
    .await;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    preview_edit_settlement_in_connection(&conn, &payload)
}

fn preview_edit_settlement_in_connection(
    conn: &rusqlite::Connection,
    payload: &OrderEditSettlementPayload,
) -> Result<serde_json::Value, String> {
    let actual_order_id = resolve_renderer_order_id(conn, &payload.order_id)?;
    let (next_total, _) = resolve_edit_settlement_totals(conn, &actual_order_id, payload)?;

    let (current_total, payment_status, order_type, is_ghost, branch_id, terminal_id, driver_id): (
        f64,
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
                    row.get::<_, i64>(3)? != 0,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(|e| format!("load edit settlement order context: {e}"))?;

    // W6: derive payment method from completed rows instead of reading
    // the dropped `orders.payment_method` column.
    let payment_method = crate::payments::derive_payment_method(conn, &actual_order_id)?
        .unwrap_or_else(|| "pending".to_string());

    let completed_payments = list_completed_payments_for_edit(conn, &actual_order_id)?;
    let ledger_paid_total = payments::load_principal_paid_for_order(conn, &actual_order_id)?;
    // Money the order's status already proved but the local mirror does not
    // hold still counts (see `ProvenPaymentCoverage`), so a grown paid order
    // is asked for the difference, never for its whole total again. A refund
    // is only ever asked of the money the local rows hold.
    let coverage = capture_proven_payment_coverage(conn, &actual_order_id)?;
    let paid_total = ledger_paid_total + coverage.missing_amount();
    let delta = next_total - current_total;
    let required_action = determine_edit_settlement_required_action_for_ledger(
        paid_total,
        ledger_paid_total,
        next_total,
    );
    let refund_amount = if required_action == "refund" {
        edit_settlement_required_refund(ledger_paid_total, next_total)
    } else {
        0.0
    };
    let driver_settlement = load_active_driver_settlement(conn, &actual_order_id)?;
    let driver_cash_owned =
        order_type.eq_ignore_ascii_case("delivery") && driver_settlement.is_some();
    // Who hands a cash refund back, by the rule only (shared rule R2): shown
    // on the refund screen, never chosen there.
    let cash_handler_by_rule =
        if crate::refunds::courier_still_holds_order_cash(conn, &actual_order_id)? {
            "driver_shift"
        } else {
            "cashier_drawer"
        };

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
        "ledgerPaidTotal": ledger_paid_total,
        "refundAmount": refund_amount,
        "delta": delta,
        "paymentStatus": payment_status,
        "paymentMethod": payment_method,
        "requiredAction": required_action,
        "completedPayments": completed_payments,
        "deliverySettlement": {
            "driverCashOwned": driver_cash_owned,
            "driverEarning": driver_settlement,
        },
        "cashHandlerByRule": cash_handler_by_rule,
    }))
}

#[tauri::command]
pub async fn orders_apply_edit_settlement(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let (payload, action) = parse_order_edit_settlement_apply_payload(arg0)?;
    // A paid order whose local mirror lost rows is restored from the server
    // ledger first, so the edit decides on the whole ledger (29/09/2026).
    restore_payment_ledger_before_payment_decision(
        &db,
        &payload.order_id,
        LedgerRestoreStep::Write,
    )
    .await;
    let now = Utc::now().to_rfc3339();

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let actual_order_id = resolve_renderer_order_id(&conn, &payload.order_id)?;
    let prepared = prepare_edit_settlement(&conn, &actual_order_id, &payload)?;
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;
    let response = match apply_edit_settlement_changes(
        &conn,
        &actual_order_id,
        &payload,
        &prepared,
        action,
        &now,
    ) {
        Ok(value) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
            value
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
    };
    drop(conn);

    if let Ok(order_json) = sync::get_order_by_id(&db, &actual_order_id) {
        let order_type = order_json
            .get("orderType")
            .and_then(|v| v.as_str())
            .unwrap_or("pickup")
            .to_string();
        let is_ghost = order_json
            .get("is_ghost")
            .or_else(|| order_json.get("isGhost"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let _ = app.emit("order_realtime_update", order_json);
        // Auto-reprint the edited order: the receipt document renders at
        // dispatch time, so it reflects the just-committed items AND the
        // full payment breakdown — including an edit-settlement delta
        // recorded in this same transaction with a different method than
        // the original (e.g. cash order, card-settled edit delta).
        print::enqueue_after_edit_auto_print(&db, &actual_order_id, &order_type, is_ghost, &app);
    }

    Ok(response)
}

/// The edit's inputs, read before its transaction starts.
struct PreparedEditSettlement {
    merged_items: Vec<serde_json::Value>,
    next_total: f64,
    next_subtotal: f64,
}

fn prepare_edit_settlement(
    conn: &rusqlite::Connection,
    actual_order_id: &str,
    payload: &OrderEditSettlementPayload,
) -> Result<PreparedEditSettlement, String> {
    let merged_items =
        merge_existing_order_item_customizations(conn, actual_order_id, &payload.items)?;
    let (derived_total, derived_subtotal) =
        derive_next_order_totals(conn, actual_order_id, &merged_items)?;
    let (next_total, next_subtotal) = match payload.financials.as_ref() {
        Some(financials) => (
            financials.total_amount.unwrap_or(derived_total).max(0.0),
            financials.subtotal.unwrap_or(derived_subtotal).max(0.0),
        ),
        None => (derived_total, derived_subtotal),
    };
    Ok(PreparedEditSettlement {
        merged_items,
        next_total,
        next_subtotal,
    })
}

/// [`orders_apply_edit_settlement`] as the regression suites drive it: the
/// same steps inside the same transaction shape as the command.
#[cfg(test)]
fn apply_edit_settlement_in_connection(
    conn: &rusqlite::Connection,
    payload: &OrderEditSettlementPayload,
    action: EditSettlementActionPayload,
    now: &str,
) -> Result<(serde_json::Value, String), String> {
    let actual_order_id = resolve_renderer_order_id(conn, &payload.order_id)?;
    let prepared = prepare_edit_settlement(conn, &actual_order_id, payload)?;
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;
    match apply_edit_settlement_changes(conn, &actual_order_id, payload, &prepared, action, now) {
        Ok(value) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
            Ok((value, actual_order_id))
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// The writes of an edit settlement; the caller owns the transaction.
fn apply_edit_settlement_changes(
    conn: &rusqlite::Connection,
    actual_order_id: &str,
    payload: &OrderEditSettlementPayload,
    prepared: &PreparedEditSettlement,
    action: EditSettlementActionPayload,
    now: &str,
) -> Result<serde_json::Value, String> {
    let actual_order_id = actual_order_id.to_string();
    let merged_items = &prepared.merged_items;
    let next_total = prepared.next_total;
    let next_subtotal = prepared.next_subtotal;
    {
        // What the order's payment status proves, read before this edit
        // changes its total or payments (29/09/2026).
        let coverage = capture_proven_payment_coverage(conn, &actual_order_id)?;

        // Apply order-type / customer / delivery field changes FIRST so the
        // subsequent items/total update and sync-enqueue see the new shape
        // of the row. Without this step the caller's type change (e.g.
        // pickup -> delivery) is silently dropped and the Supabase row
        // keeps the old order_type even though the items/total were edited.
        let applied_order_updates = match payload.order_updates.as_ref() {
            Some(updates) => {
                apply_edit_settlement_order_updates(conn, &actual_order_id, updates, now)?
            }
            None => serde_json::Map::new(),
        };

        update_order_items_in_connection(
            conn,
            &actual_order_id,
            &merged_items,
            payload.order_notes.as_deref(),
            next_total,
            next_subtotal,
            now,
        )?;
        apply_edit_settlement_financial_adjustments(
            conn,
            &actual_order_id,
            payload.financials.as_ref(),
            now,
        )?;

        let stale_payment_ids = if should_resolve_stale_overpay_payments_before_edit_action(&action)
        {
            resolve_stale_unsynced_overpay_payments_for_order(conn, &actual_order_id, now)?
        } else {
            Vec::new()
        };
        // A collection is checked against everything the order proved, not
        // only the rows this terminal still holds; a refund against the money
        // those rows hold (it must name one of them).
        let ledger_paid_before = payments::load_principal_paid_for_order(conn, &actual_order_id)?;
        let paid_total_before = ledger_paid_before + coverage.missing_amount();

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
                    payments::record_payment_in_connection(conn, &input, &options)?;
                }
            }
            EditSettlementActionPayload::Refund {
                refunds: refund_rows,
            } => {
                if refund_rows.is_empty() {
                    return Err("Refund action requires at least one payment allocation".into());
                }
                let refund_total: f64 = refund_rows.iter().map(|refund| refund.amount).sum();
                let required_refund =
                    edit_settlement_required_refund(ledger_paid_before, next_total);
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
                    refunds::refund_payment_in_connection(conn, &refund_payload)?;
                }
            }
        }

        let snapshot =
            refresh_order_payment_snapshot_with_coverage(conn, &actual_order_id, now, &coverage)?;
        let required_action = determine_edit_settlement_required_action_for_ledger(
            snapshot.effective_paid,
            snapshot.ledger_paid,
            next_total,
        );
        let mut sync_extra_fields = applied_order_updates;
        for (key, value) in
            edit_settlement_financial_sync_fields(payload.financials.as_ref(), next_subtotal)
        {
            sync_extra_fields.insert(key, value);
        }
        enqueue_order_edit_sync(
            conn,
            &actual_order_id,
            &merged_items,
            payload.order_notes.as_deref(),
            next_total,
            next_subtotal,
            payment_status_to_push(&coverage, &snapshot),
            snapshot.derived_method.as_deref(),
            &sync_extra_fields,
        )?;

        Ok(serde_json::json!({
            "success": true,
            "orderId": actual_order_id.clone(),
            "nextTotal": next_total,
            "paidTotal": snapshot.effective_paid,
            "paymentStatus": snapshot.status,
            "paymentMethod": snapshot.method_label(),
            "requiredAction": required_action,
            "stalePaymentIdsVoided": stale_payment_ids,
        }))
    }
}

#[tauri::command]
pub async fn order_update_financials(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_order_update_financials_payload(arg0)?;
    // A paid order whose local mirror lost rows is restored from the server
    // ledger first, so the new totals are compared with the whole ledger.
    restore_payment_ledger_before_payment_decision(
        &db,
        &payload.order_id,
        LedgerRestoreStep::Write,
    )
    .await;
    let now = Utc::now().to_rfc3339();

    let (response, actual_order_id) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        update_order_financials_in_connection(&conn, &payload, &now)?
    };

    if let Ok(order_json) = sync::get_order_by_id(&db, &actual_order_id) {
        let _ = app.emit("order_realtime_update", order_json);
    }

    Ok(response)
}

/// The transactional body of [`order_update_financials`]. Returns the IPC
/// response and the resolved local order id.
fn update_order_financials_in_connection(
    conn: &rusqlite::Connection,
    payload: &OrderUpdateFinancialsPayload,
    now: &str,
) -> Result<(serde_json::Value, String), String> {
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

    let actual_order_id = resolve_renderer_order_id(conn, &payload.order_id)?;
    if room_charge_is_unconfirmed(conn, &actual_order_id)? {
        return Err("FOLIO_CHARGE_RECONCILIATION_REQUIRED: synchronize the room charge before changing its amount.".to_string());
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    // W4c dual-write: 6 monetary REAL columns mirror onto cents siblings.
    let edit_total_amount_cents = Cents::round_half_even(payload.total_amount).as_i64();
    let edit_subtotal_cents = Cents::round_half_even(subtotal).as_i64();
    let edit_discount_amount_cents = Cents::round_half_even(discount_amount).as_i64();
    let edit_tax_amount_cents = Cents::round_half_even(tax_amount).as_i64();
    let edit_delivery_fee_cents = Cents::round_half_even(delivery_fee).as_i64();
    let edit_tip_amount_cents = Cents::round_half_even(tip_amount).as_i64();
    let result = (|| -> Result<serde_json::Value, String> {
        // What the order's payment status proves, read before the new totals
        // are written (29/09/2026).
        let coverage = capture_proven_payment_coverage(conn, &actual_order_id)?;
        conn.execute(
            "UPDATE orders
             SET total_amount = ?1, total_amount_cents = ?2,
                 subtotal = ?3, subtotal_cents = ?4,
                 discount_amount = ?5, discount_amount_cents = ?6,
                 discount_percentage = ?7,
                 tax_amount = ?8, tax_amount_cents = ?9,
                 delivery_fee = ?10, delivery_fee_cents = ?11,
                 tip_amount = ?12, tip_amount_cents = ?13,
                 sync_status = 'pending',
                 updated_at = ?14
             WHERE id = ?15",
            rusqlite::params![
                payload.total_amount,
                edit_total_amount_cents,
                subtotal,
                edit_subtotal_cents,
                discount_amount,
                edit_discount_amount_cents,
                discount_percentage,
                tax_amount,
                edit_tax_amount_cents,
                delivery_fee,
                edit_delivery_fee_cents,
                tip_amount,
                edit_tip_amount_cents,
                now,
                actual_order_id,
            ],
        )
        .map_err(|e| format!("update order financials: {e}"))?;

        let stale_payment_ids =
            resolve_stale_unsynced_overpay_payments_for_order(conn, &actual_order_id, now)?;
        let snapshot =
            refresh_order_payment_snapshot_with_coverage(conn, &actual_order_id, now, &coverage)?;

        // W4d-iv additive emission: every monetary field carries its
        // snake_case_cents sibling alongside the legacy camelCase float.
        let mut sync_payload = serde_json::json!({
            "orderId": actual_order_id,
            "totalAmount": payload.total_amount,
            "total_amount_cents": Cents::round_half_even(payload.total_amount).as_i64(),
            "subtotal": subtotal,
            "subtotal_cents": Cents::round_half_even(subtotal).as_i64(),
            "discountAmount": discount_amount,
            "discount_amount_cents": Cents::round_half_even(discount_amount).as_i64(),
            "discountPercentage": discount_percentage,
            "taxAmount": tax_amount,
            "tax_amount_cents": Cents::round_half_even(tax_amount).as_i64(),
            "deliveryFee": delivery_fee,
            "delivery_fee_cents": Cents::round_half_even(delivery_fee).as_i64(),
            "tipAmount": tip_amount,
            "tip_amount_cents": Cents::round_half_even(tip_amount).as_i64(),
        });
        // Only what the ledger (or this write) proves rides along; see
        // `payment_status_to_push`.
        if let Some(fields) = sync_payload.as_object_mut() {
            if let Some(status) = payment_status_to_push(&coverage, &snapshot) {
                fields.insert("paymentStatus".to_string(), serde_json::json!(status));
            }
            if let Some(method) = snapshot.derived_method.as_deref() {
                fields.insert("paymentMethod".to_string(), serde_json::json!(method));
            }
        }
        enqueue_order_sync_payload(conn, &actual_order_id, &sync_payload)
            .map_err(|e| format!("enqueue order financial sync: {e}"))?;

        Ok(serde_json::json!({
            "success": true,
            "orderId": actual_order_id.clone(),
            "paymentStatus": snapshot.status,
            "paymentMethod": snapshot.method_label(),
            "paidTotal": snapshot.effective_paid,
            "stalePaymentIdsVoided": stale_payment_ids,
        }))
    })();

    match result {
        Ok(value) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
            Ok((value, actual_order_id))
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Refusal to delete an order that has payment records (item D6, founder rule
/// 30/09 and 01/10/2026: a payment record is never missing). Deleting the
/// order took its payment rows with it (`ON DELETE CASCADE`), or left them
/// pointing at nothing: money the drawer counted, a card the customer was
/// charged, a void or a set-aside decision, gone from this till.
pub(crate) const ORDER_HAS_PAYMENT_RECORDS: &str = "ORDER_HAS_PAYMENT_RECORDS";

/// Refuse to delete an order that has ANY payment row, whatever its status
/// (completed, voided, refunded, set aside). Every per-order delete path runs
/// it: the renderer's `order_delete` (the admin's realtime delete broadcast)
/// and the server tombstones of the pull and of "Clean up deleted orders".
pub(crate) fn ensure_order_has_no_payment_records(
    conn: &rusqlite::Connection,
    local_order_id: &str,
) -> Result<(), String> {
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_payments WHERE order_id = ?1",
            rusqlite::params![local_order_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("read the order's payment records before a delete: {e}"))?;
    if rows > 0 {
        return Err(format!(
            "{ORDER_HAS_PAYMENT_RECORDS}: this order has {rows} payment record(s); it is not deleted, so they are never orphaned."
        ));
    }
    Ok(())
}

/// What a deletion the server announced did to the local order (shared rule
/// R7, round 3, 01/10/2026).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServerDeletionOutcome {
    /// It had no payment rows and lay in the open period: deleted here too.
    Deleted,
    /// It has payment rows or lies inside a closed Z: kept, hidden as deleted
    /// (`orders.server_deleted_at`, v93). Its payment rows keep counting.
    KeptHidden,
}

/// Does a deletion the server announced keep this order on the till (shared
/// rule R7; founder rule 30/09 and 01/10/2026: a till never deletes an order
/// that has payment rows or lies inside a closed Z)? Payment rows of ANY
/// status count ([`ensure_order_has_no_payment_records`]); "inside a closed
/// Z" is created before the last Z this till ran
/// (`business_day::last_z_anchor_utc`): the Z already reported it, and the
/// rollover keeps such rows for the retention view.
pub(crate) fn server_deletion_keeps_order(
    conn: &rusqlite::Connection,
    local_order_id: &str,
) -> Result<bool, String> {
    if ensure_order_has_no_payment_records(conn, local_order_id).is_err() {
        return Ok(true);
    }
    // A canonical tombstone hides table history using R7, preserving the
    // parent and audit trail even when no money was ever collected.
    if ensure_table_history_delete_allowed(conn, local_order_id).is_err() {
        return Ok(true);
    }
    let Some(last_z) = crate::business_day::last_z_anchor_utc(conn) else {
        return Ok(false);
    };
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM orders
              WHERE id = ?1
                AND datetime(created_at) < datetime(?2)
         )",
        rusqlite::params![local_order_id, last_z],
        |row| row.get(0),
    )
    .map_err(|e| format!("read whether a closed Z holds the order: {e}"))
}

/// Keep a server-deleted order, hidden as deleted (shared rule R7): the
/// order lists skip it (`sync::get_all_orders_since_utc`), its payment rows
/// keep counting in the drawer, the shift and the Z. `updated_at` is left
/// alone, so the order never moves between Z windows. The first deletion's
/// time is kept.
pub(crate) fn hide_server_deleted_order(
    conn: &rusqlite::Connection,
    local_order_id: &str,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE orders
         SET server_deleted_at = COALESCE(server_deleted_at, ?1)
         WHERE id = ?2",
        rusqlite::params![now, local_order_id],
    )
    .map_err(|e| format!("hide the server-deleted order {local_order_id}: {e}"))?;
    Ok(())
}

/// Apply a deletion the server announced to one local order (shared rule R7):
/// an order with payment rows or inside a closed Z is kept and hidden as
/// deleted (`orders.server_deleted_at`; the order lists skip it, its payment
/// rows keep counting); any other order is deleted with its queue rows. Every
/// server deletion path runs it: the pull's tombstones, "Clean up deleted
/// orders" and the admin's realtime delete broadcast (`order_delete`). A
/// repair settlement is never reached here (its callers skip it).
pub(crate) fn apply_server_order_deletion(
    conn: &rusqlite::Connection,
    local_order_id: &str,
    now: &str,
) -> Result<ServerDeletionOutcome, String> {
    if server_deletion_keeps_order(conn, local_order_id)? {
        hide_server_deleted_order(conn, local_order_id, now)?;
        return Ok(ServerDeletionOutcome::KeptHidden);
    }
    // Queue rows have no FK cascade to orders.
    conn.execute(
        "DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id = ?1",
        rusqlite::params![local_order_id],
    )
    .map_err(|e| format!("delete order queue rows for {local_order_id}: {e}"))?;
    conn.execute(
        "DELETE FROM sync_queue
         WHERE entity_type = 'payment'
           AND entity_id IN (SELECT id FROM order_payments WHERE order_id = ?1)",
        rusqlite::params![local_order_id],
    )
    .map_err(|e| format!("delete payment queue rows for {local_order_id}: {e}"))?;
    conn.execute(
        "DELETE FROM sync_queue
         WHERE entity_type = 'payment_adjustment'
           AND entity_id IN (SELECT id FROM payment_adjustments WHERE order_id = ?1)",
        rusqlite::params![local_order_id],
    )
    .map_err(|e| format!("delete payment-adjustment queue rows for {local_order_id}: {e}"))?;
    let deleted = conn
        .execute(
            "DELETE FROM orders
             WHERE id = ?1
               AND lower(trim(COALESCE(order_context, ''))) <> 'repair_settlement'",
            rusqlite::params![local_order_id],
        )
        .map_err(|e| format!("delete ordinary local order {local_order_id}: {e}"))?;
    if deleted != 1 {
        return Err(format!(
            "local deleted-order target {local_order_id} changed classification during the delete"
        ));
    }
    Ok(ServerDeletionOutcome::Deleted)
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

    let mut kept_hidden = false;
    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let actual_order_id = resolve_renderer_deletable_order_id(&conn, &order_id_raw)?;
        // R7 (round 3, 01/10/2026): the admin's delete broadcast is a server
        // deletion. An order with payment rows or inside a closed Z is kept,
        // hidden as deleted; any other order is deleted here too.
        if let Some(actual_id) = actual_order_id.as_ref() {
            if server_deletion_keeps_order(&conn, actual_id)? {
                hide_server_deleted_order(&conn, actual_id, &Utc::now().to_rfc3339())?;
                kept_hidden = true;
            }
        }
        if let Some(actual_id) = actual_order_id.as_ref().filter(|_| !kept_hidden) {
            conn.execute(
                "DELETE FROM orders WHERE id = ?1",
                rusqlite::params![actual_id],
            )
            .map_err(|e| format!("delete order: {e}"))?;
            // Electron parity: order delete remains local-only.
            // Also purge stale queued order delete operations so they cannot poison
            // /api/pos/orders/sync (which only accepts insert/update).
            delete_renderer_order_delete_queue_rows(&conn, actual_id)?;
            // Compatibility cleanup for historical pre-parity order delete rows.
            conn.execute(
                "DELETE FROM sync_queue
                 WHERE entity_type = 'order'
                   AND operation = 'delete'
                   AND (entity_id = ?1 OR status IN ('pending', 'in_progress', 'failed', 'deferred'))
                   AND NOT EXISTS (
                       SELECT 1 FROM orders
                       WHERE (orders.id = sync_queue.entity_id
                              OR orders.supabase_id = sync_queue.entity_id)
                         AND lower(trim(COALESCE(orders.order_context, ''))) = 'repair_settlement'
                   )",
                rusqlite::params![actual_id],
            )
            .map_err(|e| format!("delete legacy renderer order queue rows: {e}"))?;
        }
        actual_order_id
    };

    if let Some(actual_id) = actual_order_id.as_ref() {
        let _ = app.emit("order_deleted", serde_json::json!({ "orderId": actual_id }));
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id,
        "keptHidden": kept_hidden
    }))
}

#[tauri::command]
pub async fn order_save_from_remote(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    let order_data = payload
        .get("orderData")
        .cloned()
        .unwrap_or_else(|| payload.clone());
    ensure_renderer_order_payload_is_not_repair_settlement(&payload)?;
    ensure_renderer_order_payload_is_not_repair_settlement(&order_data)?;
    let suppress_auto_print = value_bool_any(
        &payload,
        &[
            "suppressAutoPrint",
            "suppress_auto_print",
            "skipAutoPrint",
            "skip_auto_print",
        ],
    )
    .or_else(|| {
        value_bool_any(
            &order_data,
            &[
                "suppressAutoPrint",
                "suppress_auto_print",
                "skipAutoPrint",
                "skip_auto_print",
            ],
        )
    })
    .unwrap_or(false);
    let remote_id = value_str(&order_data, &["id", "supabase_id", "supabaseId"])
        .ok_or("Missing remote order id")?;

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if !sync::remote_order_visible_to_current_terminal(&conn, &order_data)? {
            tracing::debug!(
                remote_id = %remote_id,
                "Ignoring remote order outside current isolated terminal scope"
            );
            return Ok(serde_json::json!({
                "success": true,
                "ignored": true,
                "reason": "outside_terminal_scope"
            }));
        }
    }

    let existing_local_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let existing_local_id =
            resolve_existing_local_order_for_remote(&conn, &remote_id, &order_data)?;
        if let Some(local_id) = existing_local_id.as_ref() {
            let now = Utc::now().to_rfc3339();
            ensure_renderer_order_is_not_repair_settlement(&conn, local_id)?;
            attach_remote_order_identity_to_local(&conn, local_id, &remote_id, &order_data, &now)?;
            sync::stamp_remote_folio_charge(&conn, local_id, &order_data)?;
        }
        existing_local_id
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
        .or_else(|| order_data.get("order_items"))
        .or_else(|| order_data.get("orderItems"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let items_json = match &items {
        Value::String(raw) => raw.clone(),
        value => serde_json::to_string(value).unwrap_or_else(|_| "[]".to_string()),
    };

    let order_number = value_str(&order_data, &["order_number", "orderNumber"]);
    let display_order_number =
        value_str(&order_data, &["display_order_number", "displayOrderNumber"])
            .or_else(|| order_number.clone());
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
    let table_id = value_str(&order_data, &["table_id", "tableId"]);
    let table_session_id = value_str(&order_data, &["table_session_id", "tableSessionId"]);
    let guest_count = value_i64(&order_data, &["guest_count", "guestCount"]);
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
    // The server's label in this terminal's vocabulary (`completed` is `paid`).
    let payment_status = sync::normalize_payment_status_for_sync(
        value_str(&order_data, &["payment_status", "paymentStatus"]).as_deref(),
    );
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
    let owner_terminal_id = value_str(&order_data, &["owner_terminal_id", "ownerTerminalId"]);
    let source_terminal_id = value_str(&order_data, &["source_terminal_id", "sourceTerminalId"]);
    let client_request_id = remote_order_client_identity_candidates(&order_data)
        .into_iter()
        .next();
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
    let integration_environment = value_str(
        &order_data,
        &["integration_environment", "integrationEnvironment"],
    )
    .filter(|value| value == "sandbox" || value == "production")
    .unwrap_or_else(|| "production".to_string());
    let is_test = value_bool_any(&order_data, &["is_test", "isTest"])
        .unwrap_or(integration_environment == "sandbox");
    let suppress_auto_print = suppress_auto_print || is_test;
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
    let ghost_metadata = attach_kiosk_payment_method_to_metadata(
        order_data
            .get("ghost_metadata")
            .or_else(|| order_data.get("ghostMetadata")),
        payment_method.as_deref(),
    );
    let created_at = value_str(&order_data, &["created_at", "createdAt"]).unwrap_or(now.clone());
    let updated_at = value_str(&order_data, &["updated_at", "updatedAt"]).unwrap_or(now.clone());

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        // W4c dual-write: 6 monetary REAL columns mirror onto cents siblings.
        let total_amount_cents = Cents::round_half_even(total_amount).as_i64();
        let tax_amount_cents = Cents::round_half_even(tax_amount).as_i64();
        let subtotal_cents = Cents::round_half_even(subtotal).as_i64();
        let discount_amount_cents = Cents::round_half_even(discount_amount).as_i64();
        let tip_amount_cents = Cents::round_half_even(tip_amount).as_i64();
        let delivery_fee_cents = Cents::round_half_even(delivery_fee).as_i64();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, display_order_number, customer_name, customer_phone, customer_email,
                items,
                total_amount, total_amount_cents,
                tax_amount, tax_amount_cents,
                subtotal, subtotal_cents,
                status,
                order_type, table_number, table_id, table_session_id, guest_count,
                delivery_address, delivery_city, delivery_postal_code, delivery_floor,
                delivery_notes, name_on_ringer, special_instructions,
                created_at, updated_at, estimated_time, supabase_id, sync_status,
                payment_status, payment_transaction_id, staff_shift_id,
                staff_id, driver_id, driver_name, discount_percentage,
                discount_amount, discount_amount_cents,
                tip_amount, tip_amount_cents,
                version, terminal_id, owner_terminal_id, source_terminal_id,
                branch_id, client_request_id, plugin, external_plugin_order_id,
                integration_environment, is_test,
                tax_rate,
                delivery_fee, delivery_fee_cents,
                is_ghost, ghost_source, ghost_metadata
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7,
                ?8, ?9,
                ?10, ?11,
                ?12, ?13,
                ?14,
                ?15, ?16, ?17, ?18, ?19,
                ?20, ?21, ?22, ?23,
                ?24, ?25, ?26,
                ?27, ?28, ?29, ?30, 'synced',
                ?31, ?32, ?33,
                ?34, ?35, ?36, ?37,
                ?38, ?39,
                ?40, ?41,
                1, ?42, ?43, ?44,
                ?45, ?46, ?47, ?48,
                ?49, ?50,
                ?51,
                ?52, ?53,
                ?54, ?55, ?56
            )",
            rusqlite::params![
                local_id,
                order_number,
                display_order_number,
                customer_name,
                customer_phone,
                customer_email,
                items_json,
                total_amount,
                total_amount_cents,
                tax_amount,
                tax_amount_cents,
                subtotal,
                subtotal_cents,
                status,
                order_type,
                table_number,
                table_id,
                table_session_id,
                guest_count,
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
                payment_tx_id,
                staff_shift_id,
                staff_id,
                driver_id,
                driver_name,
                discount_pct,
                discount_amount,
                discount_amount_cents,
                tip_amount,
                tip_amount_cents,
                terminal_id,
                owner_terminal_id,
                source_terminal_id,
                branch_id,
                client_request_id,
                plugin,
                external_plugin_order_id,
                integration_environment,
                if is_test { 1_i64 } else { 0_i64 },
                tax_rate,
                delivery_fee,
                delivery_fee_cents,
                if is_ghost { 1_i64 } else { 0_i64 },
                ghost_source,
                ghost_metadata,
            ],
        )
        .map_err(|e| format!("save remote order: {e}"))?;
        if let Some(currency) = order_data
            .get("currency")
            .and_then(Value::as_str)
            .and_then(crate::fiscal::payload_builder::normalize_currency_code)
        {
            conn.execute(
                "UPDATE orders SET currency = ?1 WHERE id = ?2 AND currency IS NULL",
                rusqlite::params![currency, local_id],
            )
            .map_err(|error| format!("save remote order currency: {error}"))?;
        }
        // R6: a folio-charged order says so from the moment it arrives.
        sync::stamp_remote_folio_charge(&conn, &local_id, &order_data)?;
    }

    if let Ok(order_json) = sync::get_order_by_id(&db, &local_id) {
        let _ = app.emit("order_created", order_json);
    }

    // Skip auto-print for ghost orders and pending/split payment orders (receipt
    // will be printed after split payments are individually recorded).
    let skip_auto_print =
        suppress_auto_print || is_ghost || payment_method.as_deref() == Some("pending");
    if !skip_auto_print && crate::print::is_print_action_enabled(&db, "after_order") {
        for entity_type in print::auto_print_entity_types_for_order_type(&order_type) {
            if let Err(error) = print::enqueue_print_job(&db, entity_type, &local_id, None, &app) {
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

    fetch_order_items_for_local_cache(&db, &order_id, true).await
}

/// Shared terminal-authorized read used by the UI and bounded print recovery.
pub(crate) async fn fetch_order_items_for_local_cache(
    db: &db::DbState,
    order_id: &str,
    enrich_catalog: bool,
) -> Result<Value, String> {
    // The underlying REST helper also supports anonymous reads. Food cache
    // hydration must always have the terminal headers and its complete scope.
    #[cfg(not(test))]
    for key in ["terminal_id", "organization_id", "branch_id", "pos_api_key"] {
        if storage::get_credential(key).is_none_or(|value| value.trim().is_empty()) {
            return Err(
                "Food order item fetch requires authenticated terminal configuration".into(),
            );
        }
    }
    fetch_order_items_for_local_cache_with(
        db,
        order_id,
        enrich_catalog,
        |path, params| async move { fetch_supabase_rows(&path, &params).await },
    )
    .await
}

async fn fetch_order_items_for_local_cache_with<F, Fut>(
    db: &db::DbState,
    order_id: &str,
    enrich_catalog: bool,
    fetch_rows: F,
) -> Result<Value, String>
where
    F: Fn(String, Vec<(&'static str, String)>) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let (organization_id, branch_id, _) = {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        food_item_fetch_scope(&conn)?
    };

    let local_identity: Option<(String, Option<String>)> = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        ensure_renderer_order_is_not_repair_settlement(&conn, &order_id)?;
        conn.query_row(
            "SELECT id, supabase_id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            [&order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("check local order before item fetch: {error}"))?
    };
    let remote_order_id = local_identity
        .as_ref()
        .and_then(|(_, remote)| remote.as_deref())
        .filter(|remote| !remote.trim().is_empty())
        .unwrap_or(order_id);

    {
        let remote_orders = fetch_rows(
            "orders".into(),
            vec![
                ("select", "id,order_context,organization_id,branch_id,terminal_id,owner_terminal_id,source_terminal_id".to_string()),
                ("id", format!("eq.{remote_order_id}")),
                ("organization_id", format!("eq.{organization_id}")),
                ("branch_id", format!("eq.{branch_id}")),
                ("limit", "1".to_string()),
            ],
        ).await?;
        let remote_order = remote_orders
            .as_array()
            .filter(|rows| rows.len() == 1)
            .and_then(|rows| rows.first())
            .ok_or("Food item parent order is outside terminal scope or unavailable")?;
        if remote_order.get("id").and_then(Value::as_str) != Some(remote_order_id)
            || remote_order.get("organization_id").and_then(Value::as_str)
                != Some(organization_id.as_str())
            || remote_order.get("branch_id").and_then(Value::as_str) != Some(branch_id.as_str())
        {
            return Err("Food item parent order is outside terminal scope".into());
        }
        if value_str(remote_order, &["order_context", "orderContext"])
            .is_some_and(|context| context.trim().eq_ignore_ascii_case("repair_settlement"))
        {
            return Err(REPAIR_SETTLEMENT_ROUTE_REQUIRED.to_string());
        }
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        if !sync::remote_order_visible_to_current_terminal(&conn, remote_order)? {
            return Err("Food item parent order is outside terminal scope".into());
        }
    }

    if let Ok(items_json) = fetch_rows(
        "order_items".into(),
        vec![
            (
                "select",
                "id,menu_item_id,menu_item_name,quantity,unit_price,total_price,notes,customizations".to_string(),
            ),
            ("order_id", format!("eq.{}", remote_order_id)),
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
            let mut category_ids_by_item: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            let mut category_names_by_id: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            if enrich_catalog && !ids.is_empty() {
                if let Ok(menu_items) = fetch_rows(
                    "menu_items".into(),
                    vec![
                        ("select", "id,name,name_en,name_el,category_id".to_string()),
                        ("id", format!("in.({})", ids.join(","))),
                    ],
                )
                .await
                {
                    if let Some(arr) = menu_items.as_array() {
                        for row in arr {
                            if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
                                let name = value_str(row, &["name", "name_en", "name_el"])
                                    .unwrap_or_else(|| "Item".to_string());
                                names.insert(id.to_string(), name);
                                if let Some(category_id) =
                                    row.get("category_id").and_then(|v| v.as_str())
                                {
                                    category_ids_by_item
                                        .insert(id.to_string(), category_id.to_string());
                                }
                            }
                        }
                    }
                }

                let category_ids: Vec<String> = category_ids_by_item
                    .values()
                    .cloned()
                    .collect::<std::collections::HashSet<_>>()
                    .into_iter()
                    .collect();
                if !category_ids.is_empty() {
                    if let Ok(categories) = fetch_rows(
                        "categories".into(),
                        vec![
                            ("select", "id,name,name_en,name_el".to_string()),
                            ("id", format!("in.({})", category_ids.join(","))),
                        ],
                    )
                    .await
                    {
                        if let Some(arr) = categories.as_array() {
                            for row in arr {
                                if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
                                    let name = value_str(row, &["name", "name_en", "name_el"])
                                        .unwrap_or_else(|| "Category".to_string());
                                    category_names_by_id.insert(id.to_string(), name);
                                }
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
                    let category_name = category_ids_by_item
                        .get(menu_item_id)
                        .and_then(|category_id| category_names_by_id.get(category_id))
                        .cloned();
                    serde_json::json!({
                        "id": row.get("id").cloned().unwrap_or(serde_json::Value::Null),
                        "menu_item_id": menu_item_id,
                        "name": item_name.clone(),
                        "menu_item_name": item_name,
                        "quantity": quantity,
                        "price": unit_price,
                        "unit_price": unit_price,
                        "total_price": total_price,
                        "notes": row.get("notes").cloned().unwrap_or(serde_json::Value::Null),
                        "customizations": row.get("customizations").cloned().unwrap_or(serde_json::Value::Null),
                        "categoryName": category_name.clone(),
                        "category_name": category_name.clone(),
                        "categoryPath": category_name.clone(),
                        "category_path": category_name,
                    })
                })
                .collect();
            let transformed = serde_json::json!(transformed);
            if let Some((local_id, _)) = local_identity.as_ref() {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                if let Some(persisted) = persist_fetched_food_order_items(
                    &conn, local_id, remote_order_id, &transformed,
                )? {
                    return Ok(persisted);
                }
                let plugin: String = conn.query_row(
                    "SELECT COALESCE(plugin, '') FROM orders WHERE id = ?1", [local_id], |row| row.get(0),
                ).map_err(|error| error.to_string())?;
                if print::is_food_delivery_plugin(&plugin) {
                    return Err("Fetched food items could not be persisted under the current order identity and terminal scope".into());
                }
            }
            return Ok(transformed);
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

pub(crate) fn food_item_fetch_scope(
    conn: &rusqlite::Connection,
) -> Result<(String, String, String), String> {
    let read = |key| {
        let value = db::get_setting(conn, "terminal", key);
        #[cfg(not(test))]
        let value = storage::get_credential(key).or(value);
        value
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "Food order item fetch requires organization, branch and terminal scope".to_string()
            })
    };
    Ok((
        read("organization_id")?,
        read("branch_id")?,
        read("terminal_id")?,
    ))
}

/// Fill only an incomplete external-food cache under its existing remote identity.
/// This is not an order edit: status, money, timestamps and outbound queues stay intact.
pub(crate) fn persist_fetched_food_order_items(
    conn: &rusqlite::Connection,
    local_id: &str,
    remote_id: &str,
    fetched: &Value,
) -> Result<Option<Value>, String> {
    let row: Option<(String, String, String, Option<String>, Option<String>)> = conn.query_row(
        "SELECT COALESCE(plugin, ''), COALESCE(supabase_id, ''), COALESCE(items, '[]'), branch_id, organization_id
         FROM orders WHERE id = ?1 AND COALESCE(order_context, '') != 'repair_settlement'",
        [local_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional().map_err(|error| format!("read food item cache identity: {error}"))?;
    let Some((plugin, stored_remote_id, stored_items, branch, org)) = row else {
        return Ok(None);
    };
    if !print::is_food_delivery_plugin(&plugin) || stored_remote_id != remote_id {
        return Ok(None);
    }
    let (organization_id, expected_branch, _) = food_item_fetch_scope(conn)?;
    if branch.as_deref() != Some(expected_branch.as_str())
        || org
            .as_deref()
            .is_some_and(|org| !org.is_empty() && org != organization_id)
    {
        return Ok(None);
    }
    if print::has_usable_food_order_items(&stored_items) {
        return Ok(serde_json::from_str(&stored_items).ok());
    }
    let fetched_json = fetched.to_string();
    if !print::has_usable_food_order_items(&fetched_json) {
        return Ok(None);
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE orders SET items = ?1 WHERE id = ?2 AND supabase_id = ?3",
        rusqlite::params![fetched_json, local_id, remote_id],
    )
    .map_err(|error| format!("persist fetched food order items: {error}"))?;
    release_food_item_waiting_prints(&tx, local_id)?;
    tx.commit()
        .map_err(|error| format!("commit fetched food order items: {error}"))?;
    Ok(Some(fetched.clone()))
}

pub(crate) fn release_food_item_waiting_prints(
    conn: &rusqlite::Connection,
    local_id: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE print_jobs SET next_retry_at = NULL, warning_code = NULL, warning_message = NULL
         WHERE entity_id = ?1 AND status = 'pending' AND document_snapshot_zlib IS NULL
           AND warning_code = 'food_order_items_pending'",
        [local_id],
    )
    .map_err(|error| format!("release food item waiting prints: {error}"))?;
    Ok(())
}

/// An empty/malformed joined snapshot can precede child insertion. Keep an
/// already hydrated food list while still applying the snapshot's other fields.
pub(crate) fn preserve_food_items_on_incomplete_snapshot(
    conn: &rusqlite::Connection,
    local_id: &str,
    incoming: Option<String>,
) -> Result<Option<String>, String> {
    let Some(raw) = incoming.as_ref() else {
        return Ok(incoming);
    };
    if print::has_usable_food_order_items(raw) {
        return Ok(incoming);
    }
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT COALESCE(plugin, ''), COALESCE(items, '[]') FROM orders WHERE id = ?1",
            [local_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("read food items before snapshot: {error}"))?;
    if row.is_some_and(|(plugin, items)| {
        print::is_food_delivery_plugin(&plugin) && print::has_usable_food_order_items(&items)
    }) {
        return Ok(None);
    }
    Ok(incoming)
}

// This classifies only the original CREATE handoff. Payment intent is not a
// persisted orders column (v55 removed payment_method), and this must not be
// used as payment proof or as permission to replay an unknown fiscal operation.
fn enqueue_order_creation_fiscal(
    conn: &rusqlite::Connection,
    order_id: &str,
    normalized: &Value,
) -> Result<(), String> {
    let matches_aliases = |keys: &[&str], expected: &str| {
        let present: Vec<&Value> = keys.iter().filter_map(|key| normalized.get(*key)).collect();
        !present.is_empty() && present.iter().all(|value| value.as_str() == Some(expected))
    };
    if matches_aliases(&["paymentMethod", "payment_method"], "gift_card")
        && matches_aliases(&["paymentStatus", "payment_status"], "pending")
        && normalized.get("initialPayment").is_none()
        && normalized.get("initial_payment").is_none()
    {
        // The dedicated gift checkout owns fiscalization after real settlement.
        // Keep this new pending order and its ordinary order-sync row intact.
        return Ok(());
    }
    crate::fiscal::dispatcher::enqueue_for_order(conn, order_id)
}

#[tauri::command]
pub async fn order_create(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    let normalized = payload.get("orderData").cloned().unwrap_or(payload);
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        ensure_renderer_payload_does_not_target_existing_repair_settlement(&conn, &normalized)?;
    }
    let mut resp = sync::create_order(&db, &normalized, &app)?;
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

        // T22 (fiscalization-core / Req 4.2 + Req 12): best-effort fire-and-forget
        // handoff to the fiscal dispatcher. The order itself is already persisted;
        // a fiscal enqueue failure here MUST NOT fail the order_create command —
        // the cashier always gets a successful response.
        if let Ok(conn_guard) = db.conn.lock() {
            if let Err(fiscal_err) =
                enqueue_order_creation_fiscal(&conn_guard, &order_id, &normalized)
            {
                tracing::warn!(
                    "[order_create] fiscal enqueue best-effort failed for order {order_id}: {fiscal_err}"
                );
            }
        } else {
            tracing::warn!(
                "[order_create] could not lock db for fiscal enqueue (order {order_id}); skipping handoff"
            );
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
    mgr: tauri::State<'_, crate::ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    create_order_with_initial_payment(
        &db,
        &mgr,
        &app,
        payload,
        &crate::unsaved_payments::MOVED_MONEY_SAVE_DELAYS_MS,
    )
    .await
}

static ACTIVE_CHECKOUTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn active_checkouts() -> &'static Mutex<HashSet<String>> {
    ACTIVE_CHECKOUTS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// A new-order checkout in progress on this till, by its client request id
/// (fix review 30/09/2026). Released when the checkout answers.
pub(crate) struct CheckoutInProgress(String);

impl Drop for CheckoutInProgress {
    fn drop(&mut self) {
        if let Ok(mut active) = active_checkouts().lock() {
            active.remove(&self.0);
        }
    }
}

/// Claim a checkout for this press; `None` while the same checkout (the same
/// client request id, on this till's database) is still in progress, e.g.
/// waiting on the card terminal.
pub(crate) fn claim_checkout(
    db: &db::DbState,
    client_request_id: &str,
) -> Result<Option<CheckoutInProgress>, String> {
    let key = format!("{}|{client_request_id}", db.db_path.display());
    let mut active = active_checkouts()
        .lock()
        .map_err(|error| format!("lock active checkouts: {error}"))?;
    if !active.insert(key.clone()) {
        return Ok(None);
    }
    Ok(Some(CheckoutInProgress(key)))
}

/// The answer to a press of Pay while the same checkout is still in progress.
pub(crate) const CHECKOUT_IN_PROGRESS: &str = "CHECKOUT_IN_PROGRESS";

fn checkout_in_progress_response(client_request_id: &str) -> serde_json::Value {
    serde_json::json!({
        "success": false,
        "errorCode": CHECKOUT_IN_PROGRESS,
        "checkoutInProgress": true,
        "orderPersisted": false,
        "clientRequestId": client_request_id,
        "error": "This checkout is still in progress on the card terminal. Wait for it to finish; paying again then checks the same payment and never charges twice.",
    })
}

fn twint_prior_checkout_refusal() -> Value {
    serde_json::json!({
        "success": false, "errorCode": "TWINT_PRIOR_CHECKOUT_RECONCILIATION_REQUIRED",
        "paymentApproved": false, "orderPersisted": false, "requiresReconciliation": true,
        "error": "Check the earlier checkout payment before collecting TWINT money.",
    })
}

/// The new-order checkout: the fiscal checkout (which charges a card on the
/// fiscal device), then the order and its initial payment in one write.
///
/// Item E (fix review 30/09/2026): a card the fiscal device approved is money
/// that moved. If the order write then failed (no cashier shift open, a
/// locked database, ...) the error went back as a plain failure, the order
/// did not exist, nothing durable said the customer had paid, and the next
/// try started a new checkout and a second charge. The order is now held in a
/// durable record (`unsaved_payments`, kind `new_order_checkout`) BEFORE the
/// write, the same write is retried with the same keys, and a write that still
/// fails answers `PAYMENT_NOT_SAVED`: the Z holds on `payments_not_saved`,
/// "Save payment again" writes the order and its payment with the same keys
/// (no new charge), and the manager can record the money given back.
///
/// Fix review 30/09/2026 (double charge on a slow terminal): the screen used
/// to give up after 15 s while the terminal still waited for the card, and
/// the next press of Pay started a second checkout. Now every press of the
/// same cart carries the same client request id, and (1) a press while the
/// same checkout is still in progress never reaches the terminal
/// (`CHECKOUT_IN_PROGRESS`); (2) a press after its charge was held as not
/// saved replays the held order and payment (the payload the card was
/// charged for), never the terminal and never this press's payload.
pub(crate) async fn create_order_with_initial_payment(
    db: &db::DbState,
    mgr: &crate::ecr::DeviceManager,
    invalidator: &dyn crate::print::PrintQueueInvalidator,
    payload: serde_json::Value,
    save_delays_ms: &[u64],
) -> Result<serde_json::Value, String> {
    let mut normalized = payload.get("orderData").cloned().unwrap_or(payload);
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        ensure_renderer_payload_does_not_target_existing_repair_settlement(&conn, &normalized)?;
    }
    let initial_payment = normalized
        .get("initialPayment")
        .or_else(|| normalized.get("initial_payment"))
        .cloned()
        .ok_or("Missing initial payment")?;
    let client_request_id = normalized
        .get("clientRequestId")
        .or_else(|| normalized.get("client_request_id"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if let Some(order) = normalized.as_object_mut() {
        order.insert(
            "clientRequestId".to_string(),
            serde_json::Value::String(client_request_id.clone()),
        );
        order.insert(
            "client_request_id".to_string(),
            serde_json::Value::String(client_request_id.clone()),
        );
        order.insert("initialPayment".into(), initial_payment.clone());
        order.insert("initial_payment".into(), initial_payment.clone());
    }

    // One press at a time per checkout: a second press while the first still
    // waits on the card terminal never reaches the terminal.
    let Some(_checkout) = claim_checkout(db, &client_request_id)? else {
        return Ok(checkout_in_progress_response(&client_request_id));
    };

    let existing_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let existing = conn
            .query_row(
                "SELECT id, lower(trim(COALESCE(order_context, '')))
             FROM orders
             WHERE client_request_id = ?1
             LIMIT 1",
                rusqlite::params![client_request_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|e| format!("query existing checkout order: {e}"))?;
        match existing {
            Some((_, context)) if context == "repair_settlement" => {
                return Err(REPAIR_SETTLEMENT_ROUTE_REQUIRED.to_string())
            }
            Some((id, _)) => Some(id),
            None => None,
        }
    };

    // A durable cashier-confirmed TWINT receipt is saved only as its original
    // checkout. A changed cart, method or new checkout must use recovery.
    let manual_pending = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        crate::unsaved_payments::list(&conn, None)?
            .into_iter()
            .find(|entry| entry.is_manual_twint() && entry.is_new_order_checkout())
    };
    if let Some(entry) = manual_pending {
        if entry.order_id != client_request_id || entry.request != normalized {
            return Ok(crate::unsaved_payments::not_saved_response(&entry, None));
        }
        return Ok(crate::unsaved_payments::save_charged_payment(
            db,
            entry,
            save_delays_ms,
            None,
            |db, entry| crate::unsaved_payments::write_recorded_entry(db, entry, invalidator),
        )
        .await);
    }

    // A card the fiscal device approved for this checkout: money that moved.
    let mut card_money_moved = false;
    let manual_twint = initial_payment
        .get("method")
        .or_else(|| initial_payment.get("paymentMethod"))
        .or_else(|| initial_payment.get("payment_method"))
        .and_then(Value::as_str)
        .is_some_and(|method| method.trim().eq_ignore_ascii_case("twint"));
    if existing_order_id.is_none() {
        // This checkout's charge is held as not saved (item E): replay the
        // held order and payment, the payload the card was charged for.
        let held = {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            crate::unsaved_payments::list(&conn, Some(&client_request_id))?
                .into_iter()
                .find(crate::unsaved_payments::UnsavedChargedPayment::is_new_order_checkout)
        };
        if let Some(entry) = held {
            if manual_twint {
                return Ok(twint_prior_checkout_refusal());
            }
            return Ok(crate::unsaved_payments::save_charged_payment(
                db,
                entry,
                save_delays_ms,
                None,
                |db, entry| crate::unsaved_payments::write_recorded_entry(db, entry, invalidator),
            )
            .await);
        }

        if manual_twint {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            let prior: i64 = conn.query_row(
                "SELECT count(*) FROM ecr_transactions WHERE order_id=?1
                 AND lower(trim(transaction_type)) IN ('sale','fiscal_receipt')
                 AND lower(trim(status)) NOT IN ('declined','error','cancelled')
                 AND (CASE WHEN json_valid(receipt_data) THEN json_extract(receipt_data,'$.returnedToCustomer') END) IS NULL",
                [&client_request_id], |row| row.get(0),
            ).map_err(|e| format!("inspect prior checkout before TWINT: {e}"))?;
            if prior != 0
                || crate::commands::ecr::find_approved_fiscal_transaction(
                    &conn,
                    &client_request_id,
                )?
                .is_some()
            {
                return Ok(twint_prior_checkout_refusal());
            }
        }
    }

    if existing_order_id.is_none() && !manual_twint {
        let checkout = match crate::commands::ecr::fiscal_checkout_for_order_payload(
            db,
            mgr,
            &client_request_id,
            &normalized,
            &initial_payment,
            None,
        )
        .await
        {
            Ok(checkout) => checkout,
            Err(error) => {
                return Ok(serde_json::json!({
                    "success": false,
                    "errorCode": "FISCAL_CHECKOUT_NOT_APPROVED",
                    "paymentApproved": false,
                    "orderPersisted": false,
                    "error": error,
                }));
            }
        };

        if checkout.get("success").and_then(|value| value.as_bool()) != Some(true)
            || checkout.get("approved").and_then(|value| value.as_bool()) != Some(true)
        {
            return Ok(serde_json::json!({
                "success": false,
                "errorCode": "FISCAL_CHECKOUT_NOT_APPROVED",
                "paymentApproved": false,
                "orderPersisted": false,
                "error": checkout
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!("Fiscal checkout was not approved")),
                "fiscalCheckout": checkout,
            }));
        }

        if checkout.get("skipped").and_then(|value| value.as_bool()) != Some(true) {
            let transaction = checkout
                .get("transaction")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let method = initial_payment
                .get("method")
                .or_else(|| initial_payment.get("paymentMethod"))
                .or_else(|| initial_payment.get("payment_method"))
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            let mut approved_payment = initial_payment.clone();
            if let Some(payment) = approved_payment.as_object_mut() {
                if let Some(currency) = transaction.get("currency").and_then(Value::as_str) {
                    payment.insert("currency".to_string(), serde_json::json!(currency));
                }
                if let Some(transaction_id) = transaction
                    .get("transactionId")
                    .and_then(|value| value.as_str())
                {
                    payment.insert(
                        "transactionRef".to_string(),
                        serde_json::Value::String(transaction_id.to_string()),
                    );
                }
                if method == "card" {
                    card_money_moved = true;
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
                payment.insert(
                    "fiscalReceiptNumber".to_string(),
                    transaction
                        .get("fiscalReceiptNumber")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
            }
            if let Some(order) = normalized.as_object_mut() {
                order.insert("initialPayment".to_string(), approved_payment.clone());
                order.insert("initial_payment".to_string(), approved_payment);
            }
        }
    }

    // Item A's criterion holds at checkout too: a card the checkout carries as
    // approved by a payment terminal is money that moved as well.
    if !card_money_moved && existing_order_id.is_none() {
        let checkout_payment = normalized
            .get("initialPayment")
            .or_else(|| normalized.get("initial_payment"))
            .unwrap_or(&initial_payment);
        let method = checkout_payment
            .get("method")
            .or_else(|| checkout_payment.get("paymentMethod"))
            .or_else(|| checkout_payment.get("payment_method"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        card_money_moved = method == "card"
            && crate::commands::payments::payment_payload_has_terminal_approval(checkout_payment);
    }

    let checkout_record = if manual_twint && existing_order_id.is_none() {
        let entry = crate::unsaved_payments::UnsavedChargedPayment::for_manual_twint_checkout(
            db,
            &client_request_id,
            &normalized,
            &Utc::now().to_rfc3339(),
        )?;
        Some((entry.clone(), entry.request))
    } else if card_money_moved {
        crate::unsaved_payments::UnsavedChargedPayment::for_new_order_checkout(
            &client_request_id,
            &normalized,
            &Utc::now().to_rfc3339(),
        )
    } else {
        None
    };
    let (mut resp, fiscal_enqueued) = match checkout_record {
        Some((entry, keyed_order)) => {
            let answer = crate::unsaved_payments::save_charged_payment(
                db,
                entry,
                save_delays_ms,
                None,
                |db, _entry| {
                    crate::unsaved_payments::write_new_order_checkout(db, &keyed_order, invalidator)
                },
            )
            .await;
            if answer.get("success").and_then(|value| value.as_bool()) != Some(true) {
                // Charged, not saved yet (or saved but set aside for review):
                // a typed answer, never a plain failure the renderer retries
                // with a new checkout.
                return Ok(answer);
            }
            (answer, true)
        }
        None => (sync::create_order(db, &normalized, invalidator)?, false),
    };
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

        if !fiscal_enqueued {
            if let Ok(conn) = db.conn.lock() {
                if let Err(fiscal_err) =
                    crate::fiscal::dispatcher::enqueue_for_order(&conn, &order_id)
                {
                    tracing::warn!(
                        "[order_create_with_initial_payment] fiscal enqueue best-effort failed for order {order_id}: {fiscal_err}"
                    );
                }
            }
        }
    }

    Ok(resp)
}

#[tauri::command]
pub async fn orders_clear_all(
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, crate::auth::AuthState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, crate::auth::GuardedCommandError> {
    // Gap review 2026-07-10 P0: `DELETE FROM orders` from the webview with no
    // authorization. Gate it like the sibling reset commands and snapshot first.
    crate::auth::authorize_privileged_action(
        crate::auth::PrivilegedActionScope::SystemControl,
        &db,
        &auth_state,
    )?;
    crate::recovery::snapshot_before_destructive_action(
        &db,
        crate::recovery::RecoveryPointKind::PreClearOperationalData,
    )?;
    let count = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM orders", [])
            .map_err(|e| e.to_string())?
    };
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
    let room_charge_confirmation =
        confirm_room_charge_before_approval(&db, &order_id_raw, estimated_time).await?;
    let (confirmation, request) =
        confirm_box_decision_before_mutation(&db, &order_id_raw, "confirmed", estimated_time, None)
            .await?;
    let confirmed_box = confirmation != BoxDecisionConfirmation::NotBox;
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (order_id, remote_order_id) = resolve_order_id_with_remote(&conn, &order_id_raw)?;
    let approved_status = if let Some(confirmation) = room_charge_confirmation.as_ref() {
        recheck_room_charge_approval(&conn, &order_id, confirmation)?
    } else {
        "confirmed".to_string()
    };
    let confirmed_remotely = confirmed_box || room_charge_confirmation.is_some();
    if let Some(body) = request.as_ref() {
        if recheck_confirmed_box_decision(&conn, &order_id_raw, body)?
            == BoxDecisionConfirmation::AlreadyApplied
        {
            drop(conn);
            enqueue_after_approve_platform_prints(&db, &order_id, &app);
            return Ok(serde_json::json!({ "success": true, "orderId": order_id_raw }));
        }
    }
    ensure_box_order_mutation_allowed(
        &conn,
        &order_id,
        "confirmed",
        BoxOrderMutation::Accept(estimated_time),
    )?;
    ensure_order_status_transition_with_room_confirmation(
        &conn,
        &order_id,
        &approved_status,
        room_charge_confirmation.is_some(),
    )?;
    conn.execute(
        "UPDATE orders
         SET status = ?6,
             estimated_time = COALESCE(?1, estimated_time),
             sync_status = CASE WHEN ?4 THEN 'synced' ELSE 'pending' END,
             payment_status = CASE WHEN ?5 THEN 'paid' ELSE payment_status END,
             folio_charged = CASE WHEN ?5 THEN 1 ELSE folio_charged END,
             updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![
            estimated_time,
            now,
            order_id,
            confirmed_remotely,
            room_charge_confirmation.is_some(),
            approved_status
        ],
    )
    .map_err(|e| format!("approve order: {e}"))?;
    let payload = serde_json::json!({
        "orderId": order_id,
        "status": approved_status,
        "estimatedTime": estimated_time
    });
    if !confirmed_remotely {
        let _ = enqueue_order_sync_payload(&conn, &order_id, &payload);
    }
    drop(conn);

    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload.clone());
    if let Some(remote_order_id) = remote_order_id.as_deref().filter(|_| !confirmed_remotely) {
        // The answer says what the order's platform took (a shorter
        // preparation time is told to the cashier by the renderer).
        spawn_immediate_order_accept_patch(
            &db,
            build_order_status_patch_body(remote_order_id, "confirmed", estimated_time, None, None),
            AcceptAnswerListener {
                app: app.clone(),
                order_id: order_id_raw.clone(),
            },
        );
    }
    // Includes acknowledged backflow; the spooler keeps its existing dedup and sandbox gate.
    enqueue_after_approve_platform_prints(&db, &order_id, &app);
    Ok(
        serde_json::json!({ "success": true, "orderId": order_id_raw, "estimatedTime": estimated_time,
            "roomChargeConfirmed": room_charge_confirmation.is_some() }),
    )
}

/// The local half of `order_decline`: refuses an order money was taken on
/// (fix review 30/09/2026, like every cancel), then cancels it with its
/// reason and queues the change. Answers the local id, the server id and the
/// event payload.
pub(crate) fn decline_order_locally(
    db: &db::DbState,
    order_id_raw: &str,
    reason: &str,
    now: &str,
) -> Result<(String, Option<String>, serde_json::Value), String> {
    decline_order_locally_with_box_confirmation(db, order_id_raw, reason, now, None)
}

fn decline_order_locally_with_box_confirmation(
    db: &db::DbState,
    order_id_raw: &str,
    reason: &str,
    now: &str,
    confirmed_request: Option<&Value>,
) -> Result<(String, Option<String>, serde_json::Value), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (order_id, remote_order_id) = resolve_order_id_with_remote(&conn, order_id_raw)?;
    ensure_generic_table_cancellation_allowed(&conn, &order_id)?;
    let payload = serde_json::json!({
        "orderId": order_id,
        "status": "cancelled",
        "reason": reason,
        "cancellationReason": reason,
        "cancellation_reason": reason,
        "cancelled_at": now
    });
    let confirmed_box = confirmed_request.is_some();
    if let Some(body) = confirmed_request {
        if recheck_confirmed_box_decision(&conn, order_id_raw, body)?
            == BoxDecisionConfirmation::AlreadyApplied
        {
            return Ok((order_id, remote_order_id, payload));
        }
        ensure_box_order_mutation_allowed(
            &conn,
            &order_id,
            "cancelled",
            BoxOrderMutation::Reject(Some(reason)),
        )?;
    } else {
        ensure_box_order_mutation_allowed(
            &conn,
            &order_id,
            "cancelled",
            BoxOrderMutation::Generic,
        )?;
    }
    let previous_status = ensure_order_status_transition_allowed(&conn, &order_id, "cancelled")?;
    if previous_status != "cancelled" {
        ensure_no_money_taken_before_cancel(&conn, &order_id)?;
        order_ownership::reverse_order_drawer_attribution(&conn, &order_id, now)?;
    }
    conn.execute(
        "UPDATE orders
         SET status = 'cancelled',
             cancellation_reason = ?1,
             sync_status = CASE WHEN ?4 THEN 'synced' ELSE 'pending' END,
             updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![reason, now, order_id, confirmed_box],
    )
    .map_err(|e| format!("decline order: {e}"))?;

    if !confirmed_box {
        let _ = enqueue_order_sync_payload(&conn, &order_id, &payload);
    }
    Ok((order_id, remote_order_id, payload))
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
    let (confirmation, request) = confirm_box_decision_before_mutation(
        &db,
        &order_id_raw,
        "cancelled",
        None,
        Some(reason.as_str()),
    )
    .await?;
    let confirmed_box = confirmation != BoxDecisionConfirmation::NotBox;
    let now = Utc::now().to_rfc3339();
    let (_order_id, remote_order_id, payload) = if let Some(body) = request.as_ref() {
        decline_order_locally_with_box_confirmation(&db, &order_id_raw, &reason, &now, Some(body))?
    } else {
        decline_order_locally(&db, &order_id_raw, &reason, &now)?
    };

    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload);
    if let Some(remote_order_id) = remote_order_id.as_deref().filter(|_| !confirmed_box) {
        spawn_immediate_order_status_patch(
            &db,
            build_order_status_patch_body(
                remote_order_id,
                "cancelled",
                None,
                Some(reason.as_str()),
                Some(now.as_str()),
            ),
        );
    }
    Ok(serde_json::json!({ "success": true, "orderId": order_id_raw }))
}

/// Refusal of a cancel on an order money was taken on (item D1; every cancel
/// since the fix review of 30/09/2026).
pub(crate) const ORDER_HAS_PAYMENTS: &str = "ORDER_HAS_PAYMENTS";

/// Money taken on an order (completed payments net of refunds; a voided row
/// does not count) is voided or refunded from the order first, or the rest
/// is collected, before the order is cancelled: a cancel takes back what the
/// drawer counted for the order while its payment stays recorded (founder
/// rule 30/09/2026; Android refuses the plain cancel of an order with
/// settled money too). An unreadable ledger refuses as well.
pub(crate) fn ensure_no_money_taken_before_cancel(
    conn: &rusqlite::Connection,
    local_order_id: &str,
) -> Result<(), String> {
    match cancel_refusal_code(conn, local_order_id)? {
        Some("FOLIO_CHARGE_RECONCILIATION_REQUIRED") => Err("FOLIO_CHARGE_RECONCILIATION_REQUIRED: synchronize the room charge outcome before cancelling this order.".to_string()),
        Some(ORDER_HAS_PAYMENTS) => Err(format!(
            "{ORDER_HAS_PAYMENTS}: money was taken on this order. Void or refund it from the order first, or collect the rest."
        )),
        Some(code) => Err(format!(
            "{code}: this order is marked paid, but its payment is not recorded on this till. Restore it from the server (Sync Now), or record the payment from the Z report, then cancel."
        )),
        None => Ok(()),
    }
}

/// Refusal of a cancel on an order whose label claims money while this till
/// holds no payment record of it (founder rule 30/09/2026 and 01/10/2026: an
/// order is never paid without its payment record; a missing record is
/// restored from the server or recorded by a manager, never charged again).
/// Cancelling it hid it from every integrity check: the Z skips cancelled
/// orders, so the claim and the missing record both vanished.
pub(crate) const ORDER_PAYMENT_NOT_RECORDED: &str = "ORDER_PAYMENT_NOT_RECORDED";

/// Why this till refuses to cancel the order, before any reason or PIN is
/// asked (`None`: it may be cancelled). The one rule every till cancel and
/// decline applies; the renderer asks it through the settlement snapshot
/// (`cancelRefusal`) so the cashier is told first.
///
/// - [`ORDER_HAS_PAYMENTS`]: completed money net of refunds is on it; it is
///   voided or refunded from the order first, or the rest is collected.
/// - [`ORDER_PAYMENT_NOT_RECORDED`]: none is, yet the label claims money
///   (`paid`, `completed`, `partially_paid`, `partial`, any case), the total
///   is above zero, it is no room-folio charge, and the store collects its
///   money. The existing ledger restore (sync) or "Record the payment" (the Z
///   report) comes first; once a record exists the first rule applies, and a
///   void or refund settles the label in the same write.
///
/// A platform order whose money the delivery platform holds or settles is
/// exempt from both: the server labels it paid at ingest, before its
/// settlement row is mirrored here, and declining it must keep working
/// (verifier, 01/10/2026). A platform settlement row is never money the STORE
/// took (shared rule R1, round 3, 01/10/2026,
/// [`payments::platform_settlement_row_sql`]: its `payment_origin` or its
/// external id `platform_settlement:*`), on any order: declining or
/// cancelling a platform-held order stays possible after its settlement is
/// mirrored, and the server decides what becomes of the settlement. It still
/// is the order's payment record, so an order it covers is never refused as
/// "not recorded" either. Money the store's own till took on such an order
/// still refuses. Server-originated cancellations (a pull) never come through
/// here. An unreadable ledger refuses: never "nothing taken" by default.
///
/// A hotel folio charge is exempt from the "not recorded" refusal (shared
/// rule R6): the folio charge is its record ([`payments::order_is_folio_charged`],
/// `orders.folio_charged` stamped from the server's `room_charge`).
fn room_charge_is_unconfirmed(
    conn: &rusqlite::Connection,
    local_order_id: &str,
) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM orders WHERE id=?1 AND json_valid(ghost_metadata) AND json_type(ghost_metadata,'$.room_charge.currency')='text' AND json_type(ghost_metadata,'$.room_charge.applied') IS NULL AND COALESCE(folio_charged,0)=0)", [local_order_id], |row| row.get(0)).map_err(|error| format!("read pending room charge: {error}"))
}

pub(crate) fn cancel_refusal_code(
    conn: &rusqlite::Connection,
    local_order_id: &str,
) -> Result<Option<&'static str>, String> {
    if room_charge_is_unconfirmed(conn, local_order_id)? {
        return Ok(Some("FOLIO_CHARGE_RECONCILIATION_REQUIRED"));
    }
    let store_collectable = payments::order_money_is_store_collectable(conn, local_order_id);
    if payments::load_store_taken_net_paid_cents(conn, local_order_id)? > 0 {
        return Ok(Some(ORDER_HAS_PAYMENTS));
    }
    // R1: the platform's settlement row is no money the store took, but it
    // is the order's payment record.
    let recorded_cents =
        Cents::round_half_even(payments::load_net_paid_for_order(conn, local_order_id)?).as_i64();
    if recorded_cents > 0 {
        return Ok(None);
    }
    let order: Option<(String, i64)> = conn
        .query_row(
            "SELECT LOWER(TRIM(COALESCE(payment_status, ''))),
                    COALESCE(total_amount_cents, CAST(ROUND(total_amount * 100) AS INTEGER), 0)
             FROM orders WHERE id = ?1",
            rusqlite::params![local_order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("read the order's payment label before a cancel: {e}"))?;
    let Some((label, total_cents)) = order else {
        return Ok(None);
    };
    let claims_money = matches!(
        label.as_str(),
        "paid" | "completed" | "partially_paid" | "partial"
    );
    if !claims_money || total_cents <= 0 {
        return Ok(None);
    }
    if !store_collectable || payments::order_is_folio_charged(conn, local_order_id)? {
        return Ok(None);
    }
    Ok(Some(ORDER_PAYMENT_NOT_RECORDED))
}

/// Item D1 (fix review 30/09/2026): cancelling an order that still owes money
/// is explicit. A released table no longer cancels its order (the server
/// frees the table, ends the session and leaves an owing order open), so the
/// operator cancels it from the release question or the table check: a
/// reason, then the desktop's approval for money actions (an active cashier
/// or manager shift on this terminal and a fresh PIN, `CashDrawerControl`;
/// the desktop has no per-staff void permission). Answers the order id and
/// the reason once approved.
///
/// An order money was taken on is refused before any PIN is asked
/// ([`ORDER_HAS_PAYMENTS`], the same rule as Android's release question):
/// its payment is voided or refunded from the order first, or the rest is
/// collected. Cancelling it would take back what the drawer counted for it
/// while the payment stays recorded.
pub(crate) fn authorize_owing_order_cancel(
    db: &db::DbState,
    auth_state: &crate::auth::AuthState,
    arg0: Option<serde_json::Value>,
) -> Result<(String, String, crate::auth::MoneyApprover), crate::auth::GuardedCommandError> {
    let payload = arg0.ok_or("Missing cancel payload")?;
    let order_id = value_str(&payload, &["orderId", "order_id"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or("Missing orderId")?;
    let reason = value_str(
        &payload,
        &["reason", "cancellationReason", "cancellation_reason"],
    )
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .ok_or("A reason is required to cancel an order")?;
    {
        // Unreadable payments refuse too: never "no money taken" by default.
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let (local_order_id, _) = resolve_order_id_with_remote(&conn, &order_id)?;
        ensure_no_money_taken_before_cancel(&conn, &local_order_id)?;
        let (linked_session,has_table): (Option<String>,bool) = conn.query_row(
            "SELECT NULLIF(TRIM(table_session_id),''),NULLIF(TRIM(table_id),'') IS NOT NULL FROM orders WHERE id=?1",
            rusqlite::params![local_order_id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(|error| error.to_string())?;
        if has_table
            && linked_session.is_none()
            && value_str(&payload, &["tableSessionId", "table_session_id"]).is_none()
        {
            return Err("TABLE_CANCEL_SYNC_REQUIRED: Reconnect and sync this table check before cancelling it. The table was not released.".into());
        }
        if (value_str(&payload, &["tableSessionId", "table_session_id"]).is_some()
            || linked_session.is_some())
            && value_str(&payload, &["managerPin", "manager_pin"]).is_none()
        {
            return Err(crate::auth::PrivilegedActionError {
                code: "REAUTH_REQUIRED",
                scope: "cash_drawer_control".into(),
                reason:
                    "A staff member's own PIN is required to approve canonical table cancellation"
                        .into(),
                ttl_seconds: None,
                approval: Some("void_orders"),
            }
            .into());
        }
    }
    // With nobody on shift at this terminal, a manager approves with their own
    // PIN (fix review 30/09/2026).
    let approver = crate::auth::authorize_money_action(
        crate::auth::MoneyApproval::VoidOrders,
        db,
        auth_state,
    )?;
    Ok((order_id, reason, approver))
}

/// What the order still owes, read before it is cancelled (a cancellation
/// reverses what the order counted, so the amount is taken first).
pub(crate) fn owing_order_outstanding_cents(
    db: &db::DbState,
    order_id_raw: &str,
) -> Result<i64, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (order_id, _) = resolve_order_id_with_remote(&conn, order_id_raw)?;
    payments::load_order_payment_balance_snapshot(&conn, &order_id)
        .map(|balance| Cents::round_half_even(balance.outstanding_amount).as_i64())
}

/// The audit entry of an approved cancellation: who, when, why, and what the
/// order still owed when it was cancelled (`None` when that could not be
/// read: recorded as unknown, never as zero).
pub(crate) fn record_owing_order_cancel_audit(
    db: &db::DbState,
    auth_state: &crate::auth::AuthState,
    order_id_raw: &str,
    reason: &str,
    outstanding_cents: Option<i64>,
    approver: &crate::auth::MoneyApprover,
) -> Result<(), String> {
    let session = crate::auth::get_session_json(auth_state);
    // The manager whose own PIN approved it, else the session's staff.
    let cancelled_by = approver.manager_staff_id.clone().or_else(|| {
        ["databaseStaffId", "staffId"].iter().find_map(|key| {
            session
                .get(*key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
    });
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (order_id, _) = resolve_order_id_with_remote(&conn, order_id_raw)?;
    let order_number: Option<String> = conn
        .query_row(
            "SELECT COALESCE(NULLIF(TRIM(display_order_number), ''), order_number)
             FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("load the cancelled order: {e}"))?
        .flatten();
    let payload = serde_json::json!({
        "reason": reason,
        "outstandingCents": outstanding_cents,
        "cancelledBy": cancelled_by,
        "cancelledAt": now,
        "approval": "cash_drawer_control",
        "approvalVia": approver.via,
    });
    conn.execute(
        "INSERT INTO recovery_action_log (
             id, action_id, issue_code, entity_type, entity_id, order_id, order_number,
             success, message, actor_staff_id, payload_json, created_at
         ) VALUES (?1, 'order_cancel_owing', 'order_owes_money', 'order', ?2, ?2, ?3,
                   1, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            order_id,
            order_number,
            format!("Order cancelled with approval: {reason}"),
            cancelled_by,
            payload.to_string(),
            now,
        ],
    )
    .map_err(|e| format!("write the cancellation audit entry: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn order_cancel_with_approval(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, crate::auth::AuthState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, crate::auth::GuardedCommandError> {
    let payload = arg0.clone().ok_or("Missing cancel payload")?;
    let (order_id, reason, approver) = authorize_owing_order_cancel(&db, &auth_state, arg0)?;
    let outstanding_cents = owing_order_outstanding_cents(&db, &order_id)
        .inspect_err(|error| {
            tracing::warn!(
                order_id = %order_id,
                error = %error,
                "Reading what the order owes before cancelling it failed"
            );
        })
        .ok();
    let (local_order_id, remote_order_id, stored_session) = {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        let (local, remote) = resolve_order_id_with_remote(&conn, &order_id)?;
        let stored: Option<String> = conn
            .query_row(
                "SELECT NULLIF(TRIM(table_session_id),'') FROM orders WHERE id=?1",
                rusqlite::params![local],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        (local, remote, stored)
    };
    let table_session_id =
        value_str(&payload, &["tableSessionId", "table_session_id"]).or(stored_session);
    let answer = if let Some(table_session_id) = table_session_id {
        uuid::Uuid::parse_str(&table_session_id).map_err(|_| "TABLE_CANCEL_SYNC_REQUIRED: Reconnect and sync this table check before cancelling it. The table was not released.")?;
        let remote_order_id=remote_order_id.ok_or("TABLE_CANCEL_SYNC_REQUIRED: Reconnect and sync this order before cancelling it. The table was not released.")?;
        let pin = value_str(&payload, &["managerPin", "manager_pin"])
            .ok_or("A staff member's own PIN is required")?;
        let staff_id = approver
            .manager_staff_id
            .as_deref()
            .ok_or("A staff member's own cancellation approval is required")?;
        uuid::Uuid::parse_str(staff_id)
            .map_err(|_| "Cancellation approval has no server staff identity")?;
        let event_id = {
            let conn = db.conn.lock().map_err(|error| error.to_string())?;
            if crate::sync::lan_order_has_pending_edit(&conn, &local_order_id)? {
                return Err("TABLE_CANCEL_SYNC_REQUIRED: Sync or resolve this order's pending edits before cancelling the table check. The table was not released.".into());
            }
            crate::table_session_cache::cancellation_attempt(
                &conn,
                &local_order_id,
                &table_session_id,
                &reason,
                staff_id,
                value_str(&payload, &["clientEventId", "client_event_id"]).as_deref(),
            )?
        };
        let path = format!("/api/pos/table-sessions/{table_session_id}");
        let detail = crate::admin_fetch_detailed(Some(&db), &path, "GET", None)
            .await
            .map_err(|error| error.to_string())?;
        if detail
            .pointer("/session/active_order_id")
            .and_then(Value::as_str)
            != Some(remote_order_id.as_str())
        {
            return Err(
                "The canonical table check belongs to another order. Refresh before cancelling."
                    .into(),
            );
        }
        let grant=crate::admin_fetch_detailed(Some(&db),"/api/pos/table-cancel-approvals","POST",Some(serde_json::json!({
            "session_id":table_session_id,"client_event_id":event_id,"staff_id":staff_id,"pin":pin
        }))).await.map_err(|error|error.to_string())?;
        let approval_token = grant
            .get("approval_token")
            .and_then(Value::as_str)
            .ok_or("Server cancellation approval was not granted")?;
        let cancelled=crate::admin_fetch_detailed(Some(&db),&path,"PATCH",Some(serde_json::json!({
            "action":"whole_order_cancel","client_event_id":event_id,"cancellation_reason":reason,
            "approved_staff_id":staff_id,"approval_token":approval_token,"release_status":"available"
        }))).await.map_err(|error|error.to_string())?;
        if cancelled.get("success").and_then(Value::as_bool) != Some(true) {
            return Err("Server cancellation failed. The table was not released.".into());
        }
        // The server has cancelled the parent and every sibling atomically.
        // Mirroring it locally cannot precede or substitute that transition.
        {
            let mut conn = db.conn.lock().map_err(|error| error.to_string())?;
            let transaction = conn.transaction().map_err(|error| error.to_string())?;
            crate::sync::apply_lan_canonical_response(&transaction, &path, &cancelled)?;
            crate::table_attempt_recovery::foreground_applied(
                &transaction,
                "whole_order_cancel",
                &event_id,
            )?;
            if let Some(ids) = cancelled
                .pointer("/workflow/affected_session_ids")
                .and_then(Value::as_array)
            {
                crate::table_session_cache::invalidate(&transaction, ids)?;
            }
            transaction
                .execute(
                    "UPDATE orders SET cancellation_reason=?1 WHERE id=?2",
                    rusqlite::params![reason, local_order_id],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
        }
        let update = serde_json::json!({"orderId":local_order_id,"status":"cancelled","cancellationReason":reason});
        let _ = app.emit("order_status_updated", update.clone());
        let _ = app.emit("order_realtime_update", update);
        serde_json::json!({"success":true,"orderId":local_order_id,"data":cancelled})
    } else {
        order_update_status(
            Some(serde_json::json!({
                "orderId": order_id,
                "status": "cancelled",
                "cancellationReason": reason,
            })),
            None,
            db.clone(),
            app,
        )
        .await
        .map_err(crate::auth::GuardedCommandError::from)?
    };
    if answer.get("success").and_then(serde_json::Value::as_bool) == Some(true) {
        if let Err(error) = record_owing_order_cancel_audit(
            &db,
            &auth_state,
            &order_id,
            &reason,
            outstanding_cents,
            &approver,
        ) {
            tracing::warn!(
                order_id = %order_id,
                error = %error,
                "The order was cancelled; its audit entry could not be written"
            );
        }
    }
    Ok(answer)
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
    let order_id = resolve_renderer_order_id(&conn, &order_id_raw)?;
    let driver_name = resolve_driver_display_name(&conn, &driver_id);
    ensure_box_order_mutation_allowed(&conn, &order_id, "delivered", BoxOrderMutation::Generic)?;
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

    // A delivery tip can be collected before dispatch. Resolve every pending
    // driver allocation to the actual driver/shift at the same point that the
    // canonical driver earning is created, then rebuild its payment sync row
    // so an already-offline payment cannot retain a stale pending recipient.
    resolve_delivery_tip_recipients_for_assignment(
        &conn,
        &order_id,
        &driver_id,
        &assignment.driver_shift_id,
        &now,
    )?;

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

    let driver_earning_sync_payload =
        order_ownership::build_driver_earning_sync_payload(&conn, &earning_id)?;
    order_ownership::enqueue_or_refresh_driver_earning_sync_row(
        &conn,
        &earning_id,
        &driver_earning_sync_payload,
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
            &app,
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

fn clear_delivery_tip_recipients_for_reset(
    conn: &rusqlite::Connection,
    order_id: &str,
    now: &str,
) -> Result<usize, String> {
    let payment_ids = {
        let mut statement = conn
            .prepare(&format!(
                // A payment set aside for review keeps its tip exactly as
                // recorded: it is not money, and it is never re-sent.
                "SELECT id
                 FROM order_payments
                 WHERE order_id = ?1
                   AND tip_recipient_role = 'driver'
                   AND NOT {}
                   AND COALESCE(
                         tip_amount_cents,
                         CAST(ROUND(tip_amount * 100) AS INTEGER),
                         0
                       ) > 0",
                crate::payment_review::set_aside_payment_sql("order_payments")
            ))
            .map_err(|e| format!("prepare delivery tip reset lookup: {e}"))?;
        let rows = statement
            .query_map(rusqlite::params![order_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("load delivery tip reset payments: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read delivery tip reset payment: {e}"))?
    };

    if payment_ids.is_empty() {
        return Ok(0);
    }

    conn.execute(
        &format!(
            "UPDATE order_payments
         SET tip_recipient_staff_id = NULL,
             tip_recipient_staff_shift_id = NULL,
             sync_status = 'pending',
             sync_state = CASE
                 WHEN EXISTS (
                     SELECT 1
                     FROM orders
                     WHERE orders.id = order_payments.order_id
                       AND COALESCE(orders.supabase_id, '') != ''
                 ) THEN 'pending'
                 ELSE 'waiting_parent'
             END,
             updated_at = ?1
         WHERE order_id = ?2
           AND tip_recipient_role = 'driver'
           AND NOT {}
           AND COALESCE(
                 tip_amount_cents,
                 CAST(ROUND(tip_amount * 100) AS INTEGER),
                 0
               ) > 0",
            crate::payment_review::set_aside_payment_sql("order_payments")
        ),
        rusqlite::params![now, order_id],
    )
    .map_err(|e| format!("clear delivery tip recipient for reset: {e}"))?;

    for payment_id in &payment_ids {
        payments::refresh_payment_sync_queue_entry(conn, payment_id)?;
    }

    Ok(payment_ids.len())
}

fn reset_order_row_to_active(
    conn: &rusqlite::Connection,
    order_id: &str,
    order_type: &str,
    now: &str,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE orders
         SET status = 'pending',
             order_type = ?1,
             driver_id = NULL,
             driver_name = NULL,
             cancellation_reason = NULL,
             sync_status = 'pending',
             updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![order_type, now, order_id],
    )
    .map_err(|e| format!("reset order to active: {e}"))
}

#[tauri::command]
pub async fn order_reset_to_active(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let now = Utc::now().to_rfc3339();
    let (order_id, order_type, driver_was_unassigned, removed_driver_earning) = {
        let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
        let order_id = resolve_renderer_order_id(&conn, &order_id_raw)?;
        ensure_box_order_mutation_allowed(&conn, &order_id, "pending", BoxOrderMutation::Generic)?;
        let (current_status, order_type, current_driver_id): (String, String, Option<String>) =
            conn.query_row(
                "SELECT
                     COALESCE(status, 'pending'),
                     COALESCE(order_type, 'pickup'),
                     driver_id
                 FROM orders
                 WHERE id = ?1",
                rusqlite::params![order_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| format!("load reset order context: {e}"))?;
        let normalized_status = normalize_status_for_storage(&current_status);
        if !matches!(normalized_status.as_str(), "delivered" | "completed") {
            return Err(format!(
                "Only delivered or completed orders can be reset (current: {normalized_status})"
            ));
        }

        let acting_terminal_id = storage::get_credential("terminal_id")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                db::get_setting(&conn, "terminal", "terminal_id")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            });

        let tx = conn
            .transaction()
            .map_err(|e| format!("begin order reset transaction: {e}"))?;

        // Driver assignment moves the completed payment/drawer ownership to
        // the driver's shift. RESET must move that attribution back to the
        // cashier before clearing the driver, while preserving delivery as
        // the actual order type.
        if order_type.eq_ignore_ascii_case("delivery") {
            order_ownership::assign_order_to_cashier_pickup(
                &tx,
                &order_id,
                acting_terminal_id.as_deref(),
                &now,
            )?;
        }

        let removed_driver_earning =
            order_ownership::remove_driver_earning_for_order(&tx, &order_id)?;
        if let Some(ref removed) = removed_driver_earning {
            let _ = sync::clear_non_repair_unsynced_parity_items(
                &tx,
                "driver_earnings",
                removed.id.as_str(),
            );

            if removed.supabase_id.is_some() {
                let driver_sync_payload = serde_json::json!({
                    "id": removed.id.clone(),
                    "supabase_id": removed.supabase_id.clone(),
                    "order_id": order_id.clone(),
                    "deleted_at": now.clone(),
                });
                crate::sync_queue::enqueue_payload_item(
                    &tx,
                    "driver_earnings",
                    &removed.id,
                    "DELETE",
                    &driver_sync_payload,
                    Some(1),
                    Some("financial"),
                    Some("manual"),
                    Some(1),
                )
                .map_err(|e| format!("enqueue reset driver earning deletion: {e}"))?;
            }
        }

        clear_delivery_tip_recipients_for_reset(&tx, &order_id, &now)?;

        reset_order_row_to_active(&tx, &order_id, &order_type, &now)?;

        let sync_payload = serde_json::json!({
            "orderId": order_id,
            "orderType": order_type,
            "status": "pending",
            "driverId": serde_json::Value::Null,
            "driverName": serde_json::Value::Null,
            "resetToActive": true,
        });
        enqueue_order_sync_payload(&tx, &order_id, &sync_payload)?;

        tx.commit()
            .map_err(|e| format!("commit order reset transaction: {e}"))?;

        (
            order_id,
            order_type,
            current_driver_id.is_some(),
            removed_driver_earning.is_some(),
        )
    };

    let event_payload = serde_json::json!({
        "orderId": order_id,
        "status": "pending",
        "orderType": order_type,
        "driverId": serde_json::Value::Null,
        "driverName": serde_json::Value::Null,
        "resetToActive": true,
    });
    let _ = app.emit("order_status_updated", event_payload.clone());
    let _ = app.emit("order_realtime_update", event_payload.clone());

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "orderId": order_id_raw,
            "status": "pending",
            "orderType": order_type,
            "driverUnassigned": driver_was_unassigned,
            "driverEarningRemoved": removed_driver_earning,
        }
    }))
}

/// What Ready on a platform order found before writing anything (item D8,
/// efood late Ready, 01/10/2026).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlatformReadyLocal {
    /// The order is already past Ready (out for delivery, delivered,
    /// completed): nothing to do, no write, no queue row, no PATCH.
    AlreadyClosed { status: String },
    /// The order was cancelled or refunded (by the platform, or here): no
    /// write, no settlement, no queue row, no PATCH; the cashier is told.
    Cancelled { status: String },
    /// Written and queued: the server id for the immediate PATCH and the
    /// status the order now has here (`ready`, or `delivered` for a
    /// platform-fleet order whose settlement covers it).
    Applied {
        remote_order_id: Option<String>,
        local_status: &'static str,
    },
}

/// The local half of `order_notify_platform_ready`.
///
/// A stale card used to reach `ensure_order_status_transition_allowed` and
/// fail with «Invalid status transition: delivered -> ready» (a false
/// "Failed to notify the platform" toast), and a Ready on an order the
/// platform had cancelled could run the platform auto-settlement and record
/// money on a cancelled order. The precheck answers both before anything is
/// written.
pub(crate) fn notify_platform_ready_locally(
    db: &db::DbState,
    order_id_raw: &str,
    now: &str,
) -> Result<PlatformReadyLocal, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (order_id, remote_order_id) = resolve_order_id_with_remote(&conn, order_id_raw)?;
    ensure_box_order_mutation_allowed(&conn, &order_id, "ready", BoxOrderMutation::NotifyReady)?;
    let current_status = load_canonical_order_status(&conn, &order_id)?;
    match current_status.as_str() {
        "out_for_delivery" | "delivered" | "completed" => {
            return Ok(PlatformReadyLocal::AlreadyClosed {
                status: current_status,
            });
        }
        "cancelled" | "refunded" => {
            return Ok(PlatformReadyLocal::Cancelled {
                status: current_status,
            });
        }
        _ => {}
    }
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
    // Platform-fleet orders (efood riders): READY is the store's last touch —
    // the platform never sends pickup/delivery events (their own written
    // answer, 29/08), so the order would sit in the grid forever. The founder
    // wants efood notified AND the card gone: ready relays to the platform
    // below, and locally the order completes to delivered in the same action.
    let mut platform_fleet_done = order_is_platform_fleet(&conn, &order_id);
    if platform_fleet_done {
        // THE-437: mirror the manual delivered path (order_update_status) —
        // settle the platform-held money before completing, and refuse to
        // hide an order that still has payment blockers. Prepaid/online and
        // platform-rider COD orders get their bank-settlement row here;
        // anything unsettleable stays at 'ready' so the operator resolves it
        // instead of discovering a blocked Z at day close.
        if let Err(error) = payments::auto_settle_platform_order(&conn, &order_id) {
            tracing::warn!(
                order_id = %order_id,
                error = %error,
                "Platform auto-settlement failed; leaving order at ready"
            );
        }
        match payment_integrity::load_order_payment_blockers(&conn, &order_id) {
            Ok(blockers) if blockers.is_empty() => {}
            Ok(_) => {
                tracing::info!(
                    order_id = %order_id,
                    "Platform-fleet order kept at ready: payment blockers remain"
                );
                platform_fleet_done = false;
            }
            Err(error) => {
                tracing::warn!(
                    order_id = %order_id,
                    error = %error,
                    "Payment blocker check failed; leaving order at ready"
                );
                platform_fleet_done = false;
            }
        }
    }
    if platform_fleet_done {
        conn.execute(
            "UPDATE orders SET status = 'delivered', sync_status = 'pending', updated_at = ?1
             WHERE id = ?2",
            rusqlite::params![now, order_id],
        )
        .map_err(|e| format!("complete platform-fleet order: {e}"))?;
        let _ = enqueue_order_sync_payload(
            &conn,
            &order_id,
            &serde_json::json!({ "orderId": order_id, "status": "delivered" }),
        );
    }
    Ok(PlatformReadyLocal::Applied {
        remote_order_id,
        local_status: if platform_fleet_done {
            "delivered"
        } else {
            "ready"
        },
    })
}

#[tauri::command]
pub async fn order_notify_platform_ready(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let now = Utc::now().to_rfc3339();
    let (remote_order_id, local_status) =
        match notify_platform_ready_locally(&db, &order_id_raw, &now)? {
            // Nothing written, queued or sent; the renderer refreshes quietly.
            PlatformReadyLocal::AlreadyClosed { status } => {
                return Ok(
                    serde_json::json!({ "success": true, "alreadyClosed": true, "status": status }),
                );
            }
            // Nothing written, queued or sent; the renderer shows the
            // cancellation notice, never a success toast.
            PlatformReadyLocal::Cancelled { status } => {
                return Ok(
                    serde_json::json!({ "success": false, "cancelled": true, "status": status }),
                );
            }
            PlatformReadyLocal::Applied {
                remote_order_id,
                local_status,
            } => (remote_order_id, local_status),
        };
    let payload = serde_json::json!({ "orderId": order_id_raw, "status": local_status });
    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload);
    // Immediate server PATCH so the platform "ready" relay fires in seconds
    // instead of waiting for the 15s sync loop (the queue entry above stays as
    // the offline-replay fallback, matching order_approve/order_decline).
    // Deliberately ONLY "ready": an immediate "delivered" would close the
    // server order before the queued 'ready' fallback replays, turning that
    // replay into a permanent invalid-transition failure on every online
    // press. The queued 'delivered' row closes the server order on the next
    // sync tick, after the queued 'ready' replays in order.
    if let Some(remote_order_id) = remote_order_id.as_deref() {
        spawn_immediate_order_status_patch(
            &db,
            build_order_status_patch_body(remote_order_id, "ready", None, None, None),
        );
    }
    Ok(serde_json::json!({ "success": true, "status": local_status }))
}

/// True for platform orders carried by the platform's own fleet
/// (`ghost_metadata.food_delivery.delivery_provider == "platform_delivery"`).
/// Store-driven platform orders keep the normal ready → delivery flow.
fn order_is_platform_fleet(conn: &rusqlite::Connection, order_id: &str) -> bool {
    let metadata: Option<String> = conn
        .query_row(
            "SELECT ghost_metadata FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    let Some(metadata) = metadata else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&metadata)
        .ok()
        .and_then(|value| {
            value
                .get("food_delivery")?
                .get("delivery_provider")?
                .as_str()
                .map(|provider| provider == "platform_delivery")
        })
        .unwrap_or(false)
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
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        ensure_renderer_order_is_not_repair_settlement(&conn, &order_id)?;
        let canonical_order_id = resolve_renderer_order_id(&conn, &order_id)?;
        ensure_box_order_mutation_allowed(
            &conn,
            &canonical_order_id,
            "preparing",
            BoxOrderMutation::Generic,
        )?;
    }
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
    let order_id = resolve_renderer_order_id(&conn, &order_id_raw)?;
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
            let _ = sync::clear_non_repair_unsynced_parity_items(
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

fn resolve_delivery_tip_recipients_for_assignment(
    conn: &rusqlite::Connection,
    order_id: &str,
    driver_id: &str,
    driver_shift_id: &str,
    now: &str,
) -> Result<usize, String> {
    let payment_ids = {
        let mut statement = conn
            .prepare(&format!(
                // A payment set aside for review keeps its tip exactly as
                // recorded: it is not money, and it is never re-sent.
                "SELECT id
                 FROM order_payments
                 WHERE order_id = ?1
                   AND tip_recipient_role = 'driver'
                   AND NOT {}
                   AND COALESCE(
                         tip_amount_cents,
                         CAST(ROUND(tip_amount * 100) AS INTEGER),
                         0
                       ) > 0",
                crate::payment_review::set_aside_payment_sql("order_payments")
            ))
            .map_err(|e| format!("prepare pending delivery tip lookup: {e}"))?;
        let rows = statement
            .query_map(rusqlite::params![order_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("load pending delivery tip payments: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read pending delivery tip payment: {e}"))?
    };

    if payment_ids.is_empty() {
        return Ok(0);
    }

    conn.execute(
        &format!(
            "UPDATE order_payments
         SET tip_recipient_staff_id = ?1,
             tip_recipient_staff_shift_id = ?2,
             sync_status = 'pending',
             sync_state = CASE
                 WHEN EXISTS (
                     SELECT 1
                     FROM orders
                     WHERE orders.id = order_payments.order_id
                       AND COALESCE(orders.supabase_id, '') != ''
                 ) THEN 'pending'
                 ELSE 'waiting_parent'
             END,
             updated_at = ?3
         WHERE order_id = ?4
           AND tip_recipient_role = 'driver'
           AND NOT {}
           AND COALESCE(
                 tip_amount_cents,
                 CAST(ROUND(tip_amount * 100) AS INTEGER),
                 0
               ) > 0",
            crate::payment_review::set_aside_payment_sql("order_payments")
        ),
        rusqlite::params![driver_id, driver_shift_id, now, order_id],
    )
    .map_err(|e| format!("assign delivery tip to driver payment: {e}"))?;

    for payment_id in &payment_ids {
        payments::refresh_payment_sync_queue_entry(conn, payment_id)?;
    }

    Ok(payment_ids.len())
}

#[tauri::command]
pub async fn order_save_for_retry(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    ensure_renderer_order_payload_is_not_repair_settlement(&payload)?;
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let order_data = payload.get("orderData").unwrap_or(&payload);
        ensure_renderer_payload_does_not_target_existing_repair_settlement(&conn, order_data)?;
    }
    let mut resp = sync::create_order(&db, &payload, &app)?;
    let order_id = resp
        .get("orderId")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or_else(|| {
            resp.get("order")
                .and_then(|value| value.get("id"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
        })
        .ok_or("Retry save did not return an orderId")?;

    let queue_length = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        crate::sync_queue::renderer_get_length(&conn)?
    };
    if let Some(obj) = resp.as_object_mut() {
        obj.insert("queueLength".to_string(), serde_json::json!(queue_length));
    }
    let _ = app.emit(
        "order_sync_conflict",
        serde_json::json!({ "queueLength": queue_length }),
    );
    Ok(serde_json::json!({
        "success": true,
        "orderId": order_id,
        "queueLength": queue_length,
        "data": {
            "orderId": order_id
        }
    }))
}

#[tauri::command]
pub async fn order_get_retry_queue(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let queue = crate::sync_queue::renderer_list_actionable_items(
        &conn,
        &crate::sync_queue::QueueListQuery {
            limit: Some(200),
            module_type: Some("orders".to_string()),
        },
    )?
    .into_iter()
    .filter(|item| item.table_name == "orders" && item.operation == "INSERT")
    .filter(|item| ensure_renderer_order_is_not_repair_settlement(&conn, &item.record_id).is_ok())
    .filter_map(|item| serde_json::from_str::<Value>(&item.data).ok())
    .collect::<Vec<_>>();
    Ok(serde_json::json!(queue))
}

#[tauri::command]
pub async fn order_process_retry_queue(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    cancellation: tauri::State<'_, tokio_util::sync::CancellationToken>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        ensure_renderer_retry_processing_contains_no_repair_settlement_rows(&conn)?;
    }

    let result = sync::process_renderer_parity_queue_guarded(
        &db,
        sync_state.inner().as_ref(),
        &app,
        cancellation.inner(),
        "order_process_retry_queue",
    )
    .await?;
    let queue_status = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        crate::sync_queue::renderer_get_status(&conn)?
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
        resolve_renderer_order_id(&conn, &order_id_raw)?
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
    ensure_renderer_order_is_not_repair_settlement(&conn, &order_id_raw)?;
    let order_id = resolve_order_id(&conn, &order_id_raw).unwrap_or(order_id_raw.clone());
    let mut stmt = conn
        .prepare(
            "SELECT id, status, attempts, error_message, created_at, last_attempt, next_retry_at
             FROM parity_sync_queue
             WHERE table_name = 'orders'
               AND record_id = ?1
               AND operation = 'UPDATE'
               AND COALESCE(module_type, '') <> 'repairs'
               AND table_name NOT IN ('repairs', 'repair_attachments')
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
    fn renderer_order_boundaries_reject_local_repair_settlement_without_mutation() {
        let conn = rusqlite::Connection::open_in_memory().expect("open settlement boundary db");
        db::run_migrations_for_test(&conn);
        db::set_setting(&conn, "terminal", "organization_id", "org-settlement-test")
            .expect("set organization");
        conn.execute(
            "INSERT INTO orders (
                 id, items, total_amount, total_amount_cents, status, sync_status,
                 order_context, created_at, updated_at
             ) VALUES (
                 'repair-settlement-local', '[]', 25.0, 2500, 'pending', 'pending',
                 '  RePaIr_SeTtLeMeNt  ', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed repair settlement order");
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status, error_message
             ) VALUES (
                 'generic-settlement-retry', 'orders', 'repair-settlement-local', 'UPDATE',
                 '{\"status\":\"pending\"}', 'org-settlement-test', datetime('now'),
                 4, 1000, 1, 'orders', 'server-wins', 1, 'failed', 'retry me'
             )",
            [],
        )
        .expect("seed generic settlement retry row");
        let before: (String, i64, String, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, data, error_message
                 FROM parity_sync_queue WHERE id = 'generic-settlement-retry'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read retry row before");
        let db = db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };

        assert_eq!(
            force_order_sync_retry_inner(&db, "repair-settlement-local").unwrap_err(),
            REPAIR_SETTLEMENT_ROUTE_REQUIRED
        );
        let conn = db.conn.lock().expect("lock settlement db");
        assert_eq!(
            resolve_renderer_deletable_order_id(&conn, "repair-settlement-local").unwrap_err(),
            REPAIR_SETTLEMENT_ROUTE_REQUIRED
        );
        assert_eq!(
            enqueue_order_sync_payload(
                &conn,
                "repair-settlement-local",
                &serde_json::json!({"status": "pending"}),
            )
            .unwrap_err(),
            REPAIR_SETTLEMENT_ROUTE_REQUIRED
        );
        let after: (String, i64, String, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, data, error_message
                 FROM parity_sync_queue WHERE id = 'generic-settlement-retry'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read retry row after");
        assert_eq!(after, before);
        let order_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM orders WHERE id = 'repair-settlement-local'",
                [],
                |row| row.get(0),
            )
            .expect("count settlement order");
        assert_eq!(order_count, 1);
    }

    #[test]
    fn renderer_order_payload_boundary_rejects_both_context_spellings() {
        for payload in [
            serde_json::json!({"order_context": "repair_settlement"}),
            serde_json::json!({"orderContext": "  RePaIr_SeTtLeMeNt  "}),
            serde_json::json!({
                "orderData": {"order_context": " REPAIR_SETTLEMENT "}
            }),
        ] {
            assert_eq!(
                ensure_renderer_order_payload_is_not_repair_settlement(&payload).unwrap_err(),
                REPAIR_SETTLEMENT_ROUTE_REQUIRED
            );
        }
        ensure_renderer_order_payload_is_not_repair_settlement(&serde_json::json!({
            "order_context": "ordinary"
        }))
        .expect("ordinary order payload remains allowed");
    }

    #[test]
    fn renderer_create_identity_and_retry_processing_fail_closed_for_repair_settlements() {
        let conn = rusqlite::Connection::open_in_memory().expect("open renderer boundary db");
        db::run_migrations_for_test(&conn);
        db::set_setting(
            &conn,
            "terminal",
            "organization_id",
            "org-renderer-boundary",
        )
        .expect("set organization");
        conn.execute(
            "INSERT INTO orders (
                 id, client_request_id, order_number, items, total_amount, total_amount_cents,
                 status, sync_status, order_context, created_at, updated_at
             ) VALUES (
                 'repair-identity-target', 'repair-client-request', 'R-ATH-26-000001',
                 '[]', 40.0, 4000, 'ready', 'synced', ' repair_SETTLEMENT ',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status
             ) VALUES (
                 'generic-row-targeting-settlement', 'orders', 'repair-identity-target', 'INSERT',
                 '{\"clientRequestId\":\"repair-client-request\"}', 'org-renderer-boundary',
                 datetime('now'), 3, 1000, 1, 'orders', 'server-wins', 1, 'failed'
             )",
            [],
        )
        .unwrap();

        for payload in [
            serde_json::json!({"id": "repair-identity-target"}),
            serde_json::json!({"clientRequestId": "repair-client-request"}),
            serde_json::json!({"orderNumber": "R-ATH-26-000001"}),
        ] {
            assert_eq!(
                ensure_renderer_payload_does_not_target_existing_repair_settlement(&conn, &payload)
                    .unwrap_err(),
                REPAIR_SETTLEMENT_ROUTE_REQUIRED
            );
        }
        assert_eq!(
            ensure_renderer_retry_processing_contains_no_repair_settlement_rows(&conn).unwrap_err(),
            REPAIR_SETTLEMENT_ROUTE_REQUIRED
        );

        let queue_state: (String, i64, String) = conn
            .query_row(
                "SELECT status, attempts, data
                 FROM parity_sync_queue
                 WHERE id = 'generic-row-targeting-settlement'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(queue_state.0, "failed");
        assert_eq!(queue_state.1, 3);
        assert!(queue_state.2.contains("repair-client-request"));

        conn.execute(
            "UPDATE orders SET order_context = NULL WHERE id = 'repair-identity-target'",
            [],
        )
        .unwrap();
        ensure_renderer_payload_does_not_target_existing_repair_settlement(
            &conn,
            &serde_json::json!({"clientRequestId": "repair-client-request"}),
        )
        .expect("ordinary order identity stays usable");
        ensure_renderer_retry_processing_contains_no_repair_settlement_rows(&conn)
            .expect("ordinary retry row stays processable");
    }

    #[test]
    fn renderer_mutation_and_fiscal_commands_keep_guard_before_side_effects() {
        let source = include_str!("orders.rs");
        let cases = [
            // Fix review 30/09/2026: the command writes through its local
            // half (pinned below to delegate to it).
            (
                "apply_order_status_locally",
                "resolve_order_id_with_remote",
                "reverse_order_drawer_attribution",
            ),
            (
                "order_update_customer_info",
                "resolve_renderer_order_id",
                "UPDATE orders",
            ),
            (
                "order_convert_pickup_to_delivery",
                "convert_pickup_order_to_delivery_inner",
                "order_realtime_update",
            ),
            (
                "order_update_items",
                "resolve_renderer_order_id",
                "UPDATE orders",
            ),
            (
                "orders_preview_edit_settlement",
                "resolve_renderer_order_id",
                "list_completed_payments_for_edit",
            ),
            (
                "orders_apply_edit_settlement",
                "resolve_renderer_order_id",
                "BEGIN IMMEDIATE",
            ),
            (
                "order_update_financials",
                "resolve_renderer_order_id",
                "BEGIN IMMEDIATE",
            ),
            (
                "order_delete",
                "resolve_renderer_deletable_order_id",
                "DELETE FROM orders",
            ),
            // Item D6 and shared rule R7 (round 3): no order with payment
            // records, or inside a closed Z, is ever deleted.
            (
                "order_delete",
                "server_deletion_keeps_order",
                "DELETE FROM orders",
            ),
            (
                "order_approve",
                "resolve_order_id_with_remote",
                "UPDATE orders",
            ),
            (
                "decline_order_locally_with_box_confirmation",
                "resolve_order_id_with_remote",
                "reverse_order_drawer_attribution",
            ),
            (
                "order_assign_driver",
                "resolve_renderer_order_id",
                "assign_order_to_driver_shift",
            ),
            (
                "order_reset_to_active",
                "resolve_renderer_order_id",
                "remove_driver_earning_for_order",
            ),
            (
                "notify_platform_ready_locally",
                "resolve_order_id_with_remote",
                "UPDATE orders",
            ),
            (
                "order_update_type",
                "resolve_renderer_order_id",
                "assign_order_to_cashier_pickup",
            ),
            (
                "order_create",
                "ensure_renderer_payload_does_not_target_existing_repair_settlement",
                "sync::create_order",
            ),
            (
                "order_create_with_initial_payment",
                "ensure_renderer_payload_does_not_target_existing_repair_settlement",
                "fiscal_checkout_for_order_payload",
            ),
            (
                "order_save_for_retry",
                "ensure_renderer_payload_does_not_target_existing_repair_settlement",
                "sync::create_order",
            ),
        ];

        for (command, guard, side_effect) in cases {
            let start = source
                .find(&format!("pub async fn {command}"))
                .or_else(|| source.find(&format!("pub(crate) fn {command}(")))
                .or_else(|| source.find(&format!("\nfn {command}(")))
                .unwrap_or_else(|| panic!("missing command source for {command}"));
            let remainder = &source[start..];
            let end = remainder
                .find("\n#[tauri::command]")
                .unwrap_or(remainder.len());
            let body = &remainder[..end];
            let guard_index = body
                .find(guard)
                .unwrap_or_else(|| panic!("missing repair guard {guard} in {command}"));
            let side_effect_index = body
                .find(side_effect)
                .unwrap_or_else(|| panic!("missing side-effect marker {side_effect} in {command}"));
            assert!(
                guard_index < side_effect_index,
                "repair guard must precede {side_effect} in {command}"
            );
        }

        for (command, local_half) in [
            ("order_update_status", "apply_order_status_locally("),
            ("order_decline", "decline_order_locally("),
            (
                "order_notify_platform_ready",
                "notify_platform_ready_locally(",
            ),
        ] {
            let start = source
                .find(&format!("pub async fn {command}("))
                .unwrap_or_else(|| panic!("missing command source for {command}"));
            let remainder = &source[start..];
            let end = remainder
                .find("\n#[tauri::command]")
                .unwrap_or(remainder.len());
            assert!(
                remainder[..end].contains(local_half),
                "{command} must write through {local_half}"
            );
        }
    }

    /// Item D6 (founder rule 30/09 and 01/10/2026): an order with ANY payment
    /// row (completed, voided, refunded, set aside) is never deleted; the
    /// cascade took its records with it.
    #[test]
    fn an_order_with_any_payment_record_is_never_deleted() {
        let conn = rusqlite::Connection::open_in_memory().expect("open delete test database");
        db::run_migrations_for_test(&conn);
        for id in ["order-with-voided-payment", "order-without-payment"] {
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, total_amount_cents, status,
                     payment_status, sync_status, created_at, updated_at)
                 VALUES (?1, '[]', 6.0, 600, 'pending', 'pending', 'synced',
                         datetime('now'), datetime('now'))",
                rusqlite::params![id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                 sync_status, created_at, updated_at)
             VALUES ('pay-voided', 'order-with-voided-payment', 'cash', 6.0, 600, 'voided',
                     'synced', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        let refused = ensure_order_has_no_payment_records(&conn, "order-with-voided-payment")
            .expect_err("a voided payment is a record");
        assert!(refused.starts_with(ORDER_HAS_PAYMENT_RECORDS), "{refused}");
        ensure_order_has_no_payment_records(&conn, "order-without-payment")
            .expect("nothing to orphan");
    }

    #[test]
    fn force_order_retry_ignores_repair_shaped_order_rows() {
        let conn = rusqlite::Connection::open_in_memory().expect("open retry test database");
        db::run_migrations_for_test(&conn);
        db::set_setting(&conn, "terminal", "organization_id", "org-orders-test")
            .expect("set organization");
        conn.execute(
            "INSERT INTO orders (
                 id, items, total_amount, total_amount_cents, status, sync_status,
                 created_at, updated_at
             ) VALUES (
                 'order-generic-retry', '[]', 5.0, 500, 'pending', 'pending',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed local order");
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status, error_message
             ) VALUES (
                 'repair-order-retry-op', 'orders', 'order-generic-retry', 'UPDATE',
                 '{\"ciphertext\":\"repair-private-ciphertext\"}', 'repair-private-org',
                 datetime('now'), 6, 1000, 1, 'repairs', 'manual', 4,
                 'failed', 'Invalid status transition: repair-private-error'
             )",
            [],
        )
        .expect("seed repair-shaped order row");
        let db = db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };

        let result =
            force_order_sync_retry_inner(&db, "order-generic-retry").expect("retry generic order");
        assert_eq!(result.updated, 0);
        assert!(result.inserted_fallback);
        assert!(!result.blocked_by_invalid_transition);

        let conn = db.conn.lock().unwrap();
        let repair_state: (String, i64, Option<String>, String) = conn
            .query_row(
                "SELECT status, attempts, error_message, data
                 FROM parity_sync_queue WHERE id = 'repair-order-retry-op'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(repair_state.0, "failed");
        assert_eq!(repair_state.1, 6);
        assert_eq!(
            repair_state.2.as_deref(),
            Some("REPAIR_RESERVED_OWNER_QUARANTINED")
        );
        assert!(repair_state.3.contains("repair-private-ciphertext"));
        let generic_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE record_id = 'order-generic-retry'
                   AND module_type = 'orders'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(generic_rows, 1);
    }

    #[test]
    fn renderer_order_delete_cleanup_preserves_repair_shaped_rows() {
        let conn = rusqlite::Connection::open_in_memory().expect("open delete test database");
        db::run_migrations_for_test(&conn);
        for (id, module_type, record_id) in [
            ("generic-order-delete", "orders", "order-delete-target"),
            ("generic-other-delete", "orders", "other-order"),
            ("repair-order-delete", "repairs", "order-delete-target"),
        ] {
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, retry_delay_ms, priority, module_type,
                     conflict_strategy, version, status, error_message
                 ) VALUES (
                     ?1, 'orders', ?2, 'DELETE', '{}', 'org-delete', datetime('now'),
                     2, 1000, 1, ?3, 'manual', 1, 'conflict', 'keep-error'
                 )",
                rusqlite::params![id, record_id, module_type],
            )
            .unwrap();
        }

        assert_eq!(
            delete_renderer_order_delete_queue_rows(&conn, "order-delete-target").unwrap(),
            2
        );
        let remaining: Vec<String> = conn
            .prepare("SELECT id FROM parity_sync_queue ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(remaining, vec!["repair-order-delete".to_string()]);
    }

    #[test]
    fn reset_order_row_uses_the_deployed_schema_without_completed_at() {
        let conn = rusqlite::Connection::open_in_memory().expect("open reset test database");
        conn.execute_batch(
            "CREATE TABLE orders (
                id TEXT PRIMARY KEY,
                status TEXT,
                order_type TEXT,
                driver_id TEXT,
                driver_name TEXT,
                cancellation_reason TEXT,
                sync_status TEXT,
                updated_at TEXT
            );
            INSERT INTO orders (
                id, status, order_type, driver_id, driver_name,
                cancellation_reason, sync_status, updated_at
            ) VALUES (
                'order-1', 'delivered', 'delivery', 'driver-1', 'Driver',
                'old reason', 'synced', 'old'
            );",
        )
        .expect("create deployed orders schema");

        let updated =
            reset_order_row_to_active(&conn, "order-1", "delivery", "2026-07-30T20:00:00Z")
                .expect("reset should not require a completed_at column");
        assert_eq!(updated, 1);

        let row: (
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT status, order_type, driver_id, driver_name, cancellation_reason,
                        sync_status, updated_at
                 FROM orders WHERE id = 'order-1'",
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
                    ))
                },
            )
            .expect("read reset order");

        assert_eq!(row.0, "pending");
        assert_eq!(row.1, "delivery");
        assert_eq!(row.2, None);
        assert_eq!(row.3, None);
        assert_eq!(row.4, None);
        assert_eq!(row.5, "pending");
        assert_eq!(row.6, "2026-07-30T20:00:00Z");
    }

    fn platform_fleet_test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("open platform fleet test db");
        conn.execute_batch("CREATE TABLE orders (id TEXT PRIMARY KEY, ghost_metadata TEXT);")
            .expect("create orders table");
        conn
    }

    #[test]
    fn platform_fleet_orders_are_detected_from_ghost_metadata() {
        let conn = platform_fleet_test_conn();
        conn.execute(
            "INSERT INTO orders (id, ghost_metadata) VALUES
                ('efood-rider', '{\"food_delivery\":{\"platform\":\"efood\",\"delivery_provider\":\"platform_delivery\"}}'),
                ('efood-own-driver', '{\"food_delivery\":{\"platform\":\"efood\",\"delivery_provider\":\"vendor_delivery\"}}'),
                ('walk-in', NULL),
                ('corrupt', 'not json')",
            [],
        )
        .expect("seed orders");

        // Only the platform-fleet order auto-completes on Ready; store-driven
        // and regular orders must keep the normal ready → delivery flow.
        assert!(order_is_platform_fleet(&conn, "efood-rider"));
        assert!(!order_is_platform_fleet(&conn, "efood-own-driver"));
        assert!(!order_is_platform_fleet(&conn, "walk-in"));
        assert!(!order_is_platform_fleet(&conn, "corrupt"));
        assert!(!order_is_platform_fleet(&conn, "missing-order"));
    }

    #[test]
    fn ready_to_delivered_is_a_legal_local_transition() {
        // The auto-complete path rides ready → delivered; if the transition
        // table ever forbids it, the platform-fleet flow silently breaks.
        assert!(crate::core_helpers::can_transition_locally(
            "ready",
            "delivered"
        ));
    }

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
    fn parse_status_payload_supports_cancellation_reason_aliases() {
        let parsed = parse_order_update_status_payload(
            Some(serde_json::json!({
                "orderId": "order-2",
                "status": "cancelled",
                "cancellationReason": "Customer request"
            })),
            None,
        )
        .expect("camelCase cancellation reason payload should parse");
        assert_eq!(
            parsed.cancellation_reason.as_deref(),
            Some("Customer request")
        );

        let parsed = parse_order_update_status_payload(
            Some(serde_json::json!({
                "order_id": "order-3",
                "status": "cancelled",
                "cancellation_reason": "Out of stock"
            })),
            None,
        )
        .expect("snake_case cancellation reason payload should parse");
        assert_eq!(parsed.cancellation_reason.as_deref(), Some("Out of stock"));
    }

    #[test]
    fn status_patch_payload_forwards_remote_id_and_eta() {
        let body =
            build_order_status_patch_body("remote-order-1", "confirmed", Some(20), None, None);

        assert_eq!(
            body.get("id").and_then(Value::as_str),
            Some("remote-order-1")
        );
        assert_eq!(
            body.get("status").and_then(Value::as_str),
            Some("confirmed")
        );
        assert_eq!(body.get("estimated_time").and_then(Value::as_i64), Some(20));
        assert_eq!(body.get("estimatedTime").and_then(Value::as_i64), Some(20));
    }

    #[test]
    fn room_charge_acceptance_requires_exact_paid_server_acknowledgement() {
        let confirmed = serde_json::json!({"success": true, "data": {
            "id": "remote-room-order", "status": "confirmed",
            "payment_method": "room_charge", "payment_status": "paid"
        }});
        assert!(room_charge_approval_acknowledged(
            &confirmed,
            "remote-room-order"
        ));
        assert!(!room_charge_approval_acknowledged(
            &confirmed,
            "another-order"
        ));
        for (field, value) in [
            ("status", "pending"),
            ("status", "cancelled"),
            ("payment_status", "pending"),
            ("payment_method", "cash"),
        ] {
            let mut refused = confirmed.clone();
            refused["data"][field] = Value::String(value.into());
            assert!(!room_charge_approval_acknowledged(
                &refused,
                "remote-room-order"
            ));
        }
        assert!(!room_charge_approval_acknowledged(
            &serde_json::json!({"success": true}),
            "remote-room-order"
        ));
    }

    // Founder decision, 01/10/2026: a preparation time the platform does not
    // take is shortened and the cashier is told. The server says so in the
    // accept's PATCH answer (`platform_ack`); the renderer gets it as-is.
    #[test]
    fn accept_answer_with_platform_ack_becomes_the_renderer_event() {
        let answer = serde_json::json!({
            "success": true,
            "data": { "id": "remote-order-1", "status": "confirmed" },
            "platform_ack": {
                "platform": "efood",
                "action": "approved",
                "success": true,
                "preparation_time": {
                    "requested_minutes": 30,
                    "sent_minutes": 27,
                    "max_minutes": 27,
                    "shortened": true
                }
            }
        });

        let payload = platform_ack_event_payload("order-1", &answer)
            .expect("an answer with platform_ack is passed on");

        assert_eq!(
            payload.get("orderId").and_then(Value::as_str),
            Some("order-1")
        );
        assert_eq!(
            payload
                .pointer("/platformAck/platform")
                .and_then(Value::as_str),
            Some("efood")
        );
        assert_eq!(
            payload
                .pointer("/platformAck/preparation_time/sent_minutes")
                .and_then(Value::as_i64),
            Some(27)
        );
        assert_eq!(
            payload
                .pointer("/platformAck/preparation_time/requested_minutes")
                .and_then(Value::as_i64),
            Some(30)
        );
    }

    #[test]
    fn accept_answer_without_platform_ack_raises_no_event() {
        let released_server = serde_json::json!({
            "success": true,
            "data": { "id": "remote-order-1", "status": "confirmed" }
        });
        assert!(platform_ack_event_payload("order-1", &released_server).is_none());

        let not_an_object = serde_json::json!({ "success": true, "platform_ack": "efood" });
        assert!(platform_ack_event_payload("order-1", &not_an_object).is_none());
    }

    #[test]
    fn status_patch_payload_forwards_cancellation_reason() {
        let body = build_order_status_patch_body(
            "remote-order-2",
            "cancelled",
            None,
            Some("  Sold out  "),
            Some("2026-06-09T10:30:00Z"),
        );

        assert_eq!(
            body.get("id").and_then(Value::as_str),
            Some("remote-order-2")
        );
        assert_eq!(
            body.get("status").and_then(Value::as_str),
            Some("cancelled")
        );
        assert_eq!(
            body.get("cancellation_reason").and_then(Value::as_str),
            Some("Sold out")
        );
        assert_eq!(
            body.get("cancellationReason").and_then(Value::as_str),
            Some("Sold out")
        );
        assert_eq!(
            body.get("cancelled_at").and_then(Value::as_str),
            Some("2026-06-09T10:30:00Z")
        );
        assert_eq!(
            body.get("cancelledAt").and_then(Value::as_str),
            Some("2026-06-09T10:30:00Z")
        );
    }

    fn setup_remote_identity_test_orders() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE orders (
                id TEXT PRIMARY KEY,
                supabase_id TEXT,
                client_request_id TEXT,
                order_number TEXT,
                display_order_number TEXT,
                sync_status TEXT,
                terminal_id TEXT,
                owner_terminal_id TEXT,
                source_terminal_id TEXT,
                branch_id TEXT,
                integration_environment TEXT NOT NULL DEFAULT 'production',
                is_test INTEGER NOT NULL DEFAULT 0,
                last_synced_at TEXT
            );",
        )
        .expect("create orders table");
        conn
    }

    #[test]
    fn remote_save_identity_matches_existing_local_client_request_id() {
        let conn = setup_remote_identity_test_orders();
        conn.execute(
            "INSERT INTO orders (
                id, client_request_id, order_number, display_order_number, sync_status
             ) VALUES (
                'local-order-29', 'client-order-29', 'ORD-07072026-00029', '00029', 'pending'
             )",
            [],
        )
        .expect("insert local order");

        let remote_order = serde_json::json!({
            "id": "remote-order-29",
            "client_order_id": "client-order-29",
            "order_number": "ORD-20260707-22:18",
            "terminal_id": "terminal-d80762ac",
            "owner_terminal_id": "d9243042-1745-424e-b37b-0ecb88717a75",
            "source_terminal_id": "terminal-d80762ac",
            "branch_id": "d28cef2e-bbf2-496a-b922-45b497525715"
        });

        let local_id =
            resolve_existing_local_order_for_remote(&conn, "remote-order-29", &remote_order)
                .expect("resolve remote order")
                .expect("local order match");
        assert_eq!(local_id, "local-order-29");

        attach_remote_order_identity_to_local(
            &conn,
            &local_id,
            "remote-order-29",
            &remote_order,
            "2026-07-07T19:19:00Z",
        )
        .expect("attach remote identity");

        let row: (String, String, String, String, String, String, String, i64) = conn
            .query_row(
                "SELECT
                    COALESCE(supabase_id, ''),
                    COALESCE(client_request_id, ''),
                    COALESCE(order_number, ''),
                    COALESCE(display_order_number, ''),
                    COALESCE(owner_terminal_id, ''),
                    COALESCE(source_terminal_id, ''),
                    COALESCE(sync_status, ''),
                    (SELECT COUNT(*) FROM orders)
                 FROM orders
                 WHERE id = 'local-order-29'",
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
            .expect("load attached order");

        assert_eq!(row.0, "remote-order-29");
        assert_eq!(row.1, "client-order-29");
        assert_eq!(row.2, "ORD-07072026-00029");
        assert_eq!(row.3, "00029");
        assert_eq!(row.4, "d9243042-1745-424e-b37b-0ecb88717a75");
        assert_eq!(row.5, "terminal-d80762ac");
        assert_eq!(row.6, "pending");
        assert_eq!(row.7, 1);
    }

    #[test]
    fn remote_save_identity_matches_existing_local_order_number() {
        let conn = setup_remote_identity_test_orders();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, display_order_number, sync_status
             ) VALUES (
                'local-order-30', 'ORD-07072026-00030', '00030', 'synced'
             )",
            [],
        )
        .expect("insert local order");

        let remote_order = serde_json::json!({
            "id": "remote-order-30",
            "order_number": "ORD-07072026-00030"
        });

        let local_id =
            resolve_existing_local_order_for_remote(&conn, "remote-order-30", &remote_order)
                .expect("resolve remote order")
                .expect("local order match");
        assert_eq!(local_id, "local-order-30");

        attach_remote_order_identity_to_local(
            &conn,
            &local_id,
            "remote-order-30",
            &remote_order,
            "2026-07-07T19:20:00Z",
        )
        .expect("attach remote identity");

        let row: (String, String, String, String) = conn
            .query_row(
                "SELECT
                    COALESCE(supabase_id, ''),
                    COALESCE(order_number, ''),
                    COALESCE(display_order_number, ''),
                    COALESCE(sync_status, '')
                 FROM orders
                 WHERE id = 'local-order-30'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("load attached order");

        assert_eq!(row.0, "remote-order-30");
        assert_eq!(row.1, "ORD-07072026-00030");
        assert_eq!(row.2, "00030");
        assert_eq!(row.3, "synced");
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
            "deliveryFloor": "  4  ",
            "deliveryNotes": "  Ring once  ",
            "nameOnRinger": "  Papadopoulos  ",
        })))
        .expect("customer info payload should parse");

        assert_eq!(parsed.order_id, "order-6");
        assert_eq!(parsed.customer_name, "Test Customer");
        assert_eq!(parsed.customer_phone, "12345");
        assert_eq!(parsed.customer_email, None);
        assert_eq!(parsed.delivery_address, "Main St 42");
        assert_eq!(parsed.delivery_postal_code.as_deref(), Some("10558"));
        assert_eq!(parsed.delivery_floor.as_deref(), Some("4"));
        assert_eq!(parsed.delivery_notes.as_deref(), Some("Ring once"));
        assert_eq!(parsed.name_on_ringer.as_deref(), Some("Papadopoulos"));
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
mod item_customization_merge_tests {
    use super::*;
    use rusqlite::{params, Connection};

    fn conn_with_order_items(items: serde_json::Value) -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE orders (
                id TEXT PRIMARY KEY,
                items TEXT
            );",
        )
        .expect("create orders table");
        conn.execute(
            "INSERT INTO orders (id, items) VALUES (?1, ?2)",
            params!["order-1", items.to_string()],
        )
        .expect("insert order");
        conn
    }

    #[test]
    fn restores_existing_customizations_when_existing_line_omits_them() {
        let original_customizations = serde_json::json!([
            {
                "ingredient": { "id": "ing-honey", "name": "Honey" },
                "quantity": 2
            }
        ]);
        let conn = conn_with_order_items(serde_json::json!([
            {
                "id": "line-crepe",
                "menu_item_id": "item-crepe",
                "name": "Crepe",
                "quantity": 1,
                "unit_price": 5.0,
                "total_price": 6.0,
                "customizations": original_customizations
            },
            {
                "id": "line-water",
                "menu_item_id": "item-water",
                "name": "Water",
                "quantity": 1,
                "unit_price": 1.0,
                "total_price": 1.0
            }
        ]));
        let incoming = vec![
            serde_json::json!({
                "id": "edit-line-crepe",
                "source_order_item_id": "line-crepe",
                "menu_item_id": "item-crepe",
                "name": "Crepe",
                "quantity": 1,
                "unit_price": 5.0,
                "total_price": 6.0,
                "customizations": null
            }),
            serde_json::json!({
                "id": "new-coke",
                "menu_item_id": "item-coke",
                "name": "Coca-Cola",
                "quantity": 1,
                "unit_price": 1.5,
                "total_price": 1.5,
                "customizations": null
            }),
        ];

        let merged = merge_existing_order_item_customizations(&conn, "order-1", &incoming)
            .expect("merge should succeed");

        assert_eq!(
            merged[0].get("customizations"),
            Some(&original_customizations)
        );
        assert_eq!(
            merged[1].get("customizations"),
            Some(&serde_json::Value::Null)
        );
    }

    #[test]
    fn restores_existing_customizations_when_id_is_only_menu_item_id() {
        let original_customizations = serde_json::json!([
            {
                "ingredient": { "id": "ing-lemon", "name": "Lemon" },
                "quantity": 1
            }
        ]);
        let conn = conn_with_order_items(serde_json::json!([
            {
                "id": "line-tea",
                "menu_item_id": "item-tea",
                "name": "Tea",
                "quantity": 1,
                "unit_price": 3.0,
                "total_price": 3.5,
                "customizations": original_customizations
            }
        ]));
        let incoming = vec![serde_json::json!({
            "id": "item-tea",
            "menu_item_id": "item-tea",
            "name": "Tea",
            "quantity": 1,
            "unit_price": 3.0,
            "total_price": 3.5,
            "customizations": null
        })];

        let merged = merge_existing_order_item_customizations(&conn, "order-1", &incoming)
            .expect("merge should succeed");

        assert_eq!(
            merged[0].get("customizations"),
            Some(&original_customizations)
        );
    }

    #[test]
    fn keeps_explicit_empty_customizations_as_user_intent() {
        let conn = conn_with_order_items(serde_json::json!([
            {
                "id": "line-crepe",
                "menu_item_id": "item-crepe",
                "name": "Crepe",
                "quantity": 1,
                "unit_price": 5.0,
                "total_price": 6.0,
                "customizations": {
                    "ing-honey": { "name": "Honey" }
                }
            }
        ]));
        let incoming = vec![serde_json::json!({
            "id": "edit-line-crepe",
            "source_order_item_id": "line-crepe",
            "menu_item_id": "item-crepe",
            "name": "Crepe",
            "quantity": 1,
            "unit_price": 5.0,
            "total_price": 5.0,
            "customizations": []
        })];

        let merged = merge_existing_order_item_customizations(&conn, "order-1", &incoming)
            .expect("merge should succeed");

        assert_eq!(
            merged[0].get("customizations"),
            Some(&serde_json::json!([]))
        );
    }
}

#[cfg(test)]
mod box_order_mutation_tests {
    use super::*;

    const REMOTE_ID: &str = "11111111-1111-4111-8111-111111111111";

    #[derive(Clone)]
    struct FeedbackDb(std::sync::Arc<crate::tests::harness::TestDb>);

    impl std::ops::Deref for FeedbackDb {
        type Target = db::DbState;

        fn deref(&self) -> &Self::Target {
            &self.0.state
        }
    }

    fn feedback_db() -> FeedbackDb {
        let db = FeedbackDb(std::sync::Arc::new(crate::tests::harness::TestDb::open()));
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("ALTER TABLE orders ADD COLUMN drawer_amount INTEGER;")
                .unwrap();
            conn.execute(
                "INSERT INTO orders (id, order_number, items, status, plugin, ghost_metadata,
                    drawer_amount, sync_status, supabase_id, order_type, total_amount,
                    total_amount_cents, payment_status, created_at, updated_at)
                 VALUES ('box-order', 'BOX-FIXTURE', '[]', 'pending', 'box', '', 795,
                    'synced', ?1, 'delivery', 7.95, 795, 'pending', ?2, ?2)",
                rusqlite::params![REMOTE_ID, "2026-10-01T12:00:00Z"],
            )
            .unwrap();
        }
        db
    }

    fn feedback_context(url: String) -> ImmediateOrderStatusSyncContext {
        ImmediateOrderStatusSyncContext {
            admin_url: url,
            api_key: "fixture-terminal-key".into(),
            terminal_id: "fixture-terminal".into(),
        }
    }

    fn confirmed_payload(status: &str) -> Value {
        serde_json::json!({ "success": true, "data": { "id": REMOTE_ID, "status": status,
            "box_decision": { "state": "confirmed", "provider_confirmed": true, "action": if status == "confirmed" { "accepted" } else { "rejected" }, "retryable": false } } })
    }

    fn feedback_response_server(
        http_status: u16,
        payload: Value,
    ) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                let text = String::from_utf8_lossy(&request);
                if let Some(split) = text.find("\r\n\r\n") {
                    let length = text[..split]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= split + 4 + length {
                        break;
                    }
                }
            }
            let payload = payload.to_string();
            let response = format!("HTTP/1.1 {http_status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (url, handle)
    }

    #[tokio::test]
    async fn box_http400_is_refused_before_status_drawer_or_queue_mutation() {
        let reasons: Vec<String> = serde_json::from_str(include_str!(
            "../../../../shared/box-rejection-reasons.json"
        ))
        .unwrap();
        for status in ["confirmed", "cancelled"] {
            let db = feedback_db();
            let body = prepare_box_decision_request(
                &db.conn.lock().unwrap(),
                "box-order",
                status,
                Some(25),
                Some(&reasons[0]),
            )
            .unwrap()
            .unwrap();
            let before = snapshot(&db.conn.lock().unwrap());
            let (url, server) = feedback_response_server(
                400,
                serde_json::json!({ "success": false, "code": "BOX_DECISION_EXPIRED", "error": "expired" }),
            );
            let error =
                confirm_box_decision_with_context(&db, "box-order", &body, &feedback_context(url))
                    .await
                    .unwrap_err();
            assert!(error.contains("HTTP 400"));
            assert_eq!(snapshot(&db.conn.lock().unwrap()), before);
            assert_eq!(
                db.conn
                    .lock()
                    .unwrap()
                    .query_row("SELECT COUNT(*) FROM print_jobs", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            let request = server.join().unwrap();
            assert!(request.starts_with("PATCH /api/pos/orders "));
            assert!(request
                .to_ascii_lowercase()
                .contains("x-pos-api-key: fixture-terminal-key"));
            assert!(request
                .to_ascii_lowercase()
                .contains("x-terminal-id: fixture-terminal"));
            let sent: Value =
                serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(sent["id"], REMOTE_ID);
            if status == "confirmed" {
                assert_eq!(sent["estimated_time"], 25);
            } else {
                assert_eq!(sent["cancellation_reason"], reasons[0]);
            }
        }
    }

    #[tokio::test]
    async fn box_http202_unknown_or_missing_confirmation_keeps_pending_without_queue() {
        for (status, payload) in [
            (
                202,
                serde_json::json!({ "success": true, "data": { "id": REMOTE_ID, "status": "pending", "box_decision": { "state": "pending", "provider_confirmed": false, "action": "accepted", "retryable": true } } }),
            ),
            (
                200,
                serde_json::json!({ "success": true, "data": { "id": REMOTE_ID, "status": "confirmed" } }),
            ),
            (200, confirmed_payload("cancelled")),
            (202, confirmed_payload("confirmed")),
        ] {
            let db = feedback_db();
            let body = prepare_box_decision_request(
                &db.conn.lock().unwrap(),
                "box-order",
                "confirmed",
                Some(25),
                None,
            )
            .unwrap()
            .unwrap();
            let before = snapshot(&db.conn.lock().unwrap());
            let (url, server) = feedback_response_server(status, payload);
            assert!(confirm_box_decision_with_context(
                &db,
                "box-order",
                &body,
                &feedback_context(url)
            )
            .await
            .is_err());
            assert_eq!(snapshot(&db.conn.lock().unwrap()), before);
            assert_eq!(
                db.conn
                    .lock()
                    .unwrap()
                    .query_row("SELECT COUNT(*) FROM print_jobs", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn box_http200_matching_confirmation_allows_local_commit_without_second_request() {
        let reasons: Vec<String> = serde_json::from_str(include_str!(
            "../../../../shared/box-rejection-reasons.json"
        ))
        .unwrap();
        for status in ["confirmed", "cancelled"] {
            let db = feedback_db();
            let body = prepare_box_decision_request(
                &db.conn.lock().unwrap(),
                "box-order",
                status,
                Some(25),
                Some(&reasons[0]),
            )
            .unwrap()
            .unwrap();
            let before = snapshot(&db.conn.lock().unwrap());
            let server =
                crate::tests::fake_http::MockServer::new(confirmed_payload(status).to_string());
            assert_eq!(
                confirm_box_decision_with_context(
                    &db,
                    "box-order",
                    &body,
                    &feedback_context(server.url.clone())
                )
                .await
                .unwrap(),
                BoxDecisionConfirmation::PendingLocal
            );
            assert_eq!(snapshot(&db.conn.lock().unwrap()), before);
            assert_eq!(server.count(), 1);
        }
    }

    #[tokio::test]
    async fn box_acknowledged_same_backflow_succeeds_without_reapplying_side_effects() {
        let reasons: Vec<String> = serde_json::from_str(include_str!(
            "../../../../shared/box-rejection-reasons.json"
        ))
        .unwrap();
        for status in ["confirmed", "cancelled"] {
            let db = feedback_db();
            let body = prepare_box_decision_request(
                &db.conn.lock().unwrap(),
                "box-order",
                status,
                Some(25),
                Some(&reasons[0]),
            )
            .unwrap()
            .unwrap();
            let callback_db = db.clone();
            let reason = reasons[0].clone();
            let server = crate::tests::fake_http::MockServer::new_with_request_hook(
                confirmed_payload(status).to_string(),
                move || {
                    callback_db.conn.lock().unwrap().execute("UPDATE orders SET status = ?1, cancellation_reason = ?2 WHERE id = 'box-order'", rusqlite::params![status, reason]).unwrap();
                },
            );
            assert_eq!(
                confirm_box_decision_with_context(
                    &db,
                    "box-order",
                    &body,
                    &feedback_context(server.url.clone())
                )
                .await
                .unwrap(),
                BoxDecisionConfirmation::AlreadyApplied
            );
            let after = snapshot(&db.conn.lock().unwrap());
            assert_eq!(after.0, status);
            assert_eq!(after.1, 795);
            assert_eq!(after.3, 0);
            if status == "confirmed" {
                enqueue_after_approve_platform_prints(
                    &db,
                    "box-order",
                    &crate::print::NoopPrintQueueInvalidator,
                );
                db.conn
                    .lock()
                    .unwrap()
                    .execute("UPDATE print_jobs SET status = 'printed'", [])
                    .unwrap();
                enqueue_after_approve_platform_prints(
                    &db,
                    "box-order",
                    &crate::print::NoopPrintQueueInvalidator,
                );
                assert_eq!(
                    db.conn
                        .lock()
                        .unwrap()
                        .query_row("SELECT COUNT(*) FROM print_jobs", [], |row| row
                            .get::<_, i64>(0))
                        .unwrap(),
                    1
                );
            }
        }
    }

    fn seed_feedback_payment(conn: &rusqlite::Connection, method: &str) {
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                 transaction_ref, payment_origin, remote_payment_id, sync_status, sync_state, created_at, updated_at)
             VALUES ('box-payment', 'box-order', ?1, 7.95, 795, 'completed',
                 'platform_settlement:online:box-order', 'sync_reconstructed', 'remote-box-payment',
                 'synced', 'applied', '2026-10-01T12:00:00Z', '2026-10-01T12:00:00Z')",
            rusqlite::params![method],
        )
        .unwrap();
    }

    #[test]
    fn box_extracted_local_helpers_refuse_before_financial_or_status_writes() {
        let db = feedback_db();
        let before = snapshot(&db.conn.lock().unwrap());
        assert!(apply_order_status_locally(
            &db,
            "box-order",
            "completed",
            None,
            None,
            "2026-10-01T12:00:00Z"
        )
        .is_err());
        assert!(
            decline_order_locally(&db, "box-order", "free text", "2026-10-01T12:00:00Z").is_err()
        );
        assert!(notify_platform_ready_locally(&db, "box-order", "2026-10-01T12:00:00Z").is_err());
        assert_eq!(snapshot(&db.conn.lock().unwrap()), before);
        assert_eq!(
            db.conn
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM order_payments", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn box_decline_payment_preflight_precedes_provider_request() {
        let reasons: Vec<String> = serde_json::from_str(include_str!(
            "../../../../shared/box-rejection-reasons.json"
        ))
        .unwrap();
        for (method, label, expected) in [
            (Some("cash"), "pending", ORDER_HAS_PAYMENTS),
            (Some("card"), "pending", ORDER_HAS_PAYMENTS),
            (None, "paid", ORDER_PAYMENT_NOT_RECORDED),
        ] {
            let db = feedback_db();
            let conn = db.conn.lock().unwrap();
            if let Some(method) = method {
                // A settlement-like reference cannot hide till CASH/CARD.
                seed_feedback_payment(&conn, method);
            }
            conn.execute("UPDATE orders SET payment_status = ?1", [label])
                .unwrap();
            let before = snapshot(&conn);
            let error = prepare_box_decision_request(
                &conn,
                "box-order",
                "cancelled",
                None,
                Some(&reasons[0]),
            )
            .expect_err("payment guard must prevent constructing a provider request");
            assert!(error.starts_with(expected), "{error}");
            assert_eq!(snapshot(&conn), before);
        }
    }

    #[tokio::test]
    async fn box_confirmed_decline_preserves_platform_settlement_and_skips_duplicate_queue() {
        let reasons: Vec<String> = serde_json::from_str(include_str!(
            "../../../../shared/box-rejection-reasons.json"
        ))
        .unwrap();
        let db = feedback_db();
        let body = {
            let conn = db.conn.lock().unwrap();
            seed_feedback_payment(&conn, "other");
            conn.execute("UPDATE orders SET payment_status = 'paid'", [])
                .unwrap();
            prepare_box_decision_request(&conn, "box-order", "cancelled", None, Some(&reasons[0]))
                .unwrap()
                .unwrap()
        };
        let server =
            crate::tests::fake_http::MockServer::new(confirmed_payload("cancelled").to_string());
        assert_eq!(
            confirm_box_decision_with_context(
                &db,
                "box-order",
                &body,
                &feedback_context(server.url.clone())
            )
            .await
            .unwrap(),
            BoxDecisionConfirmation::PendingLocal
        );
        decline_order_locally_with_box_confirmation(
            &db,
            "box-order",
            &reasons[0],
            "2026-10-01T12:00:00Z",
            Some(&body),
        )
        .unwrap();
        let conn = db.conn.lock().unwrap();
        let after = snapshot(&conn);
        assert_eq!(after.0, "cancelled");
        assert_eq!(after.2, "synced");
        assert_eq!(after.3, 0);
        assert_eq!(
            conn.query_row(
                "SELECT status FROM order_payments WHERE id = 'box-payment'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "completed"
        );
        assert_eq!(server.count(), 1);
    }

    #[tokio::test]
    async fn box_decline_rechecks_till_money_after_provider_confirmation() {
        let reasons: Vec<String> = serde_json::from_str(include_str!(
            "../../../../shared/box-rejection-reasons.json"
        ))
        .unwrap();
        let db = feedback_db();
        let body = prepare_box_decision_request(
            &db.conn.lock().unwrap(),
            "box-order",
            "cancelled",
            None,
            Some(&reasons[0]),
        )
        .unwrap()
        .unwrap();
        let server =
            crate::tests::fake_http::MockServer::new(confirmed_payload("cancelled").to_string());
        assert_eq!(
            confirm_box_decision_with_context(
                &db,
                "box-order",
                &body,
                &feedback_context(server.url.clone())
            )
            .await
            .unwrap(),
            BoxDecisionConfirmation::PendingLocal
        );
        seed_feedback_payment(&db.conn.lock().unwrap(), "cash");
        let before = snapshot(&db.conn.lock().unwrap());
        let error = decline_order_locally_with_box_confirmation(
            &db,
            "box-order",
            &reasons[0],
            "2026-10-01T12:00:00Z",
            Some(&body),
        )
        .expect_err("cash collected during HTTP await must refuse before local effects");
        assert!(error.starts_with(ORDER_HAS_PAYMENTS), "{error}");
        assert_eq!(snapshot(&db.conn.lock().unwrap()), before);
        assert_eq!(server.count(), 1);
    }

    #[tokio::test]
    async fn box_opposite_backflow_and_transport_unknown_cannot_commit() {
        let db = feedback_db();
        let body = prepare_box_decision_request(
            &db.conn.lock().unwrap(),
            "box-order",
            "confirmed",
            Some(25),
            None,
        )
        .unwrap()
        .unwrap();
        let callback_db = db.clone();
        let server = crate::tests::fake_http::MockServer::new_with_request_hook(
            confirmed_payload("confirmed").to_string(),
            move || {
                callback_db
                    .conn
                    .lock()
                    .unwrap()
                    .execute(
                        "UPDATE orders SET status = 'cancelled' WHERE id = 'box-order'",
                        [],
                    )
                    .unwrap();
            },
        );
        assert!(confirm_box_decision_with_context(
            &db,
            "box-order",
            &body,
            &feedback_context(server.url.clone())
        )
        .await
        .is_err());
        assert_eq!(
            snapshot(&db.conn.lock().unwrap()),
            ("cancelled".into(), 795, "synced".into(), 0)
        );
        let db = feedback_db();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let before = snapshot(&db.conn.lock().unwrap());
        assert!(
            confirm_box_decision_with_context(&db, "box-order", &body, &feedback_context(url))
                .await
                .is_err()
        );
        assert_eq!(snapshot(&db.conn.lock().unwrap()), before);
    }

    #[test]
    fn box_remote_identity_required_while_non_box_remains_optimistic() {
        let db = feedback_db();
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE orders SET supabase_id = NULL", [])
            .unwrap();
        assert!(
            prepare_box_decision_request(&conn, "box-order", "confirmed", Some(25), None).is_err()
        );
        conn.execute("UPDATE orders SET plugin = 'efood'", [])
            .unwrap();
        assert!(
            prepare_box_decision_request(&conn, "box-order", "confirmed", None, None)
                .unwrap()
                .is_none()
        );
        assert!(prepare_box_decision_request(
            &conn,
            "box-order",
            "cancelled",
            None,
            Some("free text")
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn box_delayed_acceptance_print_requires_own_confirmed_intent_and_pending_transition() {
        let db = feedback_db();
        let conn = db.conn.lock().unwrap();
        let mut remote = serde_json::json!({ "status": "confirmed", "ghost_metadata": { "_the_small_box_decision": { "version": 1, "state": "confirmed", "action": "accepted" } } });
        assert!(should_print_box_acceptance_backflow(
            &conn,
            "box-order",
            Some("pending"),
            &remote
        ));
        assert!(!should_print_box_acceptance_backflow(
            &conn,
            "box-order",
            Some("confirmed"),
            &remote
        ));
        remote["ghost_metadata"]["_the_small_box_decision"]["state"] = serde_json::json!("pending");
        assert!(!should_print_box_acceptance_backflow(
            &conn,
            "box-order",
            Some("pending"),
            &remote
        ));
        remote["ghost_metadata"]["_the_small_box_decision"]["state"] =
            serde_json::json!("confirmed");
        remote["ghost_metadata"]["_the_small_box_decision"]["action"] =
            serde_json::json!("rejected");
        assert!(!should_print_box_acceptance_backflow(
            &conn,
            "box-order",
            Some("pending"),
            &remote
        ));
        remote["ghost_metadata"]["_the_small_box_decision"]["action"] =
            serde_json::json!("accepted");
        remote["ghost_metadata"] = Value::String(remote["ghost_metadata"].to_string());
        assert!(should_print_box_acceptance_backflow(
            &conn,
            "box-order",
            Some("pending"),
            &remote
        ));
        conn.execute("UPDATE orders SET plugin = 'efood'", [])
            .unwrap();
        assert!(!should_print_box_acceptance_backflow(
            &conn,
            "box-order",
            Some("pending"),
            &remote
        ));
    }

    #[tokio::test]
    async fn box_final_command_lock_recheck_handles_same_opposite_and_identity_backflow() {
        let db = feedback_db();
        let body = prepare_box_decision_request(
            &db.conn.lock().unwrap(),
            "box-order",
            "confirmed",
            Some(25),
            None,
        )
        .unwrap()
        .unwrap();
        let server =
            crate::tests::fake_http::MockServer::new(confirmed_payload("confirmed").to_string());
        assert_eq!(
            confirm_box_decision_with_context(
                &db,
                "box-order",
                &body,
                &feedback_context(server.url.clone())
            )
            .await
            .unwrap(),
            BoxDecisionConfirmation::PendingLocal
        );
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE orders SET status = 'confirmed'", [])
            .unwrap();
        assert_eq!(
            recheck_confirmed_box_decision(&conn, "box-order", &body).unwrap(),
            BoxDecisionConfirmation::AlreadyApplied
        );
        conn.execute("UPDATE orders SET status = 'cancelled'", [])
            .unwrap();
        assert!(recheck_confirmed_box_decision(&conn, "box-order", &body).is_err());
        conn.execute("UPDATE orders SET status = 'confirmed', supabase_id = '22222222-2222-4222-8222-222222222222'", []).unwrap();
        assert!(recheck_confirmed_box_decision(&conn, "box-order", &body).is_err());
        assert_eq!(snapshot(&conn).1, 795);
        assert_eq!(snapshot(&conn).3, 0);
    }

    fn connection(plugin: &str, status: &str, metadata: &str) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT, plugin TEXT, ghost_metadata TEXT, drawer_amount INTEGER, sync_status TEXT); CREATE TABLE sync_queue (id TEXT);").unwrap();
        conn.execute(
            "INSERT INTO orders VALUES ('box-order', ?1, ?2, ?3, 795, 'synced')",
            rusqlite::params![status, plugin, metadata],
        )
        .unwrap();
        conn
    }

    fn snapshot(conn: &rusqlite::Connection) -> (String, i64, String, i64) {
        conn.query_row("SELECT status, drawer_amount, sync_status, (SELECT COUNT(*) FROM sync_queue) FROM orders WHERE id = 'box-order'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap()
    }

    #[test]
    fn box_pending_generic_mutations_fail_before_any_persistence() {
        for plugin in ["box", " BOX_GR ", "boxgr"] {
            let conn = connection(plugin, "pending", "");
            let before = snapshot(&conn);
            for next in [
                "confirmed",
                "preparing",
                "ready",
                "delivered",
                "completed",
                "cancelled",
            ] {
                assert!(ensure_box_order_mutation_allowed(
                    &conn,
                    "box-order",
                    next,
                    BoxOrderMutation::Generic
                )
                .is_err());
                assert_eq!(snapshot(&conn), before);
            }
            assert!(ensure_box_order_mutation_allowed(
                &conn,
                "box-order",
                "ready",
                BoxOrderMutation::NotifyReady
            )
            .is_err());
            assert_eq!(snapshot(&conn), before);
        }
    }

    #[test]
    fn box_accept_requires_pending_and_positive_estimate() {
        let conn = connection("box", "pending", "");
        for estimate in [None, Some(0), Some(-1)] {
            assert!(ensure_box_order_mutation_allowed(
                &conn,
                "box-order",
                "confirmed",
                BoxOrderMutation::Accept(estimate)
            )
            .is_err());
        }
        assert!(ensure_box_order_mutation_allowed(
            &conn,
            "box-order",
            "confirmed",
            BoxOrderMutation::Accept(Some(30))
        )
        .is_ok());
        let conn = connection("box", "confirmed", "");
        assert!(ensure_box_order_mutation_allowed(
            &conn,
            "box-order",
            "confirmed",
            BoxOrderMutation::Accept(Some(30))
        )
        .is_err());
    }

    #[test]
    fn box_decline_uses_exact_shared_json_reasons_only() {
        let reasons: Vec<String> = serde_json::from_str(include_str!(
            "../../../../shared/box-rejection-reasons.json"
        ))
        .unwrap();
        let conn = connection("box", "pending", "");
        for reason in &reasons {
            assert!(ensure_box_order_mutation_allowed(
                &conn,
                "box-order",
                "cancelled",
                BoxOrderMutation::Reject(Some(reason))
            )
            .is_ok());
            let padded = format!(" {reason}");
            assert!(ensure_box_order_mutation_allowed(
                &conn,
                "box-order",
                "cancelled",
                BoxOrderMutation::Reject(Some(&padded))
            )
            .is_err());
        }
        for reason in [None, Some(""), Some("other"), Some("Declined")] {
            assert!(ensure_box_order_mutation_allowed(
                &conn,
                "box-order",
                "cancelled",
                BoxOrderMutation::Reject(reason)
            )
            .is_err());
        }
        let conn = connection("box", "cancelled", "");
        assert!(ensure_box_order_mutation_allowed(
            &conn,
            "box-order",
            "cancelled",
            BoxOrderMutation::Reject(Some(&reasons[0]))
        )
        .is_err());
    }

    #[test]
    fn box_accepted_local_fulfilment_remains_but_cancel_restore_notify_fail() {
        for status in [
            "confirmed",
            "preparing",
            "ready",
            "delivered",
            "completed",
            "cancelled",
        ] {
            let conn = connection("box", status, "");
            let before = snapshot(&conn);
            for next in ["cancelled", "pending"] {
                assert!(ensure_box_order_mutation_allowed(
                    &conn,
                    "box-order",
                    next,
                    BoxOrderMutation::Generic
                )
                .is_err());
            }
            assert!(ensure_box_order_mutation_allowed(
                &conn,
                "box-order",
                "ready",
                BoxOrderMutation::NotifyReady
            )
            .is_err());
            assert_eq!(snapshot(&conn), before);
        }
        let conn = connection("box", "confirmed", "");
        for next in ["preparing", "ready", "delivered", "completed"] {
            assert!(ensure_box_order_mutation_allowed(
                &conn,
                "box-order",
                next,
                BoxOrderMutation::Generic
            )
            .is_ok());
        }
    }

    #[test]
    fn box_legacy_metadata_fallback_and_non_box_precedence_preserved() {
        let metadata = r#"{"food_delivery":{"platform":"box"}}"#;
        let conn = connection("", "pending", metadata);
        assert!(ensure_box_order_mutation_allowed(
            &conn,
            "box-order",
            "ready",
            BoxOrderMutation::Generic
        )
        .is_err());
        let conn = connection("efood", "pending", metadata);
        assert!(ensure_box_order_mutation_allowed(
            &conn,
            "box-order",
            "ready",
            BoxOrderMutation::Generic
        )
        .is_ok());
        assert!(ensure_box_order_mutation_allowed(
            &conn,
            "box-order",
            "confirmed",
            BoxOrderMutation::Accept(None)
        )
        .is_ok());
        assert!(ensure_box_order_mutation_allowed(
            &conn,
            "box-order",
            "cancelled",
            BoxOrderMutation::Reject(Some("free text"))
        )
        .is_ok());
        assert!(ensure_box_order_mutation_allowed(
            &conn,
            "box-order",
            "ready",
            BoxOrderMutation::NotifyReady
        )
        .is_ok());
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
        // W4e Step 0: dual-populate (10.0 → 1000).
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES (?1, '[]', 10.0, 1000, ?2, 'pending', datetime('now'), datetime('now'))",
            params![order_id, status],
        )
        .unwrap();
    }

    fn room_charge_snapshot_fixture(db: &db::DbState) -> RoomChargeApprovalSnapshot {
        insert_order(db, "room-snapshot", "pending");
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE orders SET ghost_metadata = '{\"kiosk\":{\"paymentMethod\":\"room_charge\"}}', sync_status = 'synced',
                    supabase_id = '11111111-1111-4111-8111-111111111111'
             WHERE id = 'room-snapshot'", [],
        ).unwrap();
        capture_room_charge_approval_snapshot(&conn, "room-snapshot").unwrap()
    }

    #[test]
    fn room_charge_snapshot_rejects_unsynced_rows_and_both_outstanding_queues() {
        let db = test_db();
        room_charge_snapshot_fixture(&db);
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE orders SET sync_status = 'pending' WHERE id = 'room-snapshot'",
            [],
        )
        .unwrap();
        assert!(capture_room_charge_approval_snapshot(&conn, "room-snapshot").is_err());
        conn.execute(
            "UPDATE orders SET sync_status = 'synced' WHERE id = 'room-snapshot'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue (id, table_name, record_id, operation, data, organization_id, status)
             VALUES ('room-edit', 'orders', 'room-snapshot', 'UPDATE', '{}', 'org-test', 'processing')", [],
        ).unwrap();
        assert!(capture_room_charge_approval_snapshot(&conn, "room-snapshot").is_err());
        conn.execute("DELETE FROM parity_sync_queue WHERE id = 'room-edit'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('order', 'room-snapshot', 'update', '{}', 'room-edit', 'pending')", [],
        ).unwrap();
        assert!(capture_room_charge_approval_snapshot(&conn, "room-snapshot").is_err());
        conn.execute(
            "DELETE FROM sync_queue WHERE idempotency_key = 'room-edit'",
            [],
        )
        .unwrap();
        assert!(capture_room_charge_approval_snapshot(&conn, "room-snapshot").is_ok());
    }

    #[test]
    fn room_charge_ack_requires_authoritative_matching_total_and_unchanged_items() {
        let db = test_db();
        let snapshot = room_charge_snapshot_fixture(&db);
        let mut answer = serde_json::json!({"success": true, "data": {
            "id": snapshot.remote_id, "status": "ready", "payment_method": "room_charge",
            "payment_status": "paid", "total_amount": "10.00"
        }});
        assert_eq!(
            acknowledged_room_charge_status(&answer, &snapshot).unwrap(),
            "ready"
        );
        for total in [
            Value::Null,
            serde_json::json!(15),
            serde_json::json!(-10),
            serde_json::json!("NaN"),
        ] {
            answer["data"]["total_amount"] = total;
            assert!(acknowledged_room_charge_status(&answer, &snapshot).is_err());
        }
        let confirmation = RoomChargeApprovalConfirmation {
            snapshot,
            status: "ready".into(),
        };
        let conn = db.conn.lock().unwrap();
        // Even a later completed sync cannot hide an in-flight edit from this ACK.
        conn.execute("UPDATE orders SET total_amount = 15, total_amount_cents = 1500 WHERE id = 'room-snapshot'", []).unwrap();
        assert!(recheck_room_charge_approval(&conn, "room-snapshot", &confirmation).is_err());
        conn.execute("UPDATE orders SET total_amount = 10, total_amount_cents = 1000, items = '[{\"name\":\"changed item\"}]' WHERE id = 'room-snapshot'", []).unwrap();
        assert!(recheck_room_charge_approval(&conn, "room-snapshot", &confirmation).is_err());
        let (payment_status, charged): (String, i64) = conn
            .query_row(
                "SELECT payment_status, folio_charged FROM orders WHERE id = 'room-snapshot'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((payment_status.as_str(), charged), ("pending", 0));
    }

    #[test]
    fn room_charge_recheck_preserves_advanced_backflow_and_rejects_cancellation() {
        let db = test_db();
        let snapshot = room_charge_snapshot_fixture(&db);
        let mut confirmation = RoomChargeApprovalConfirmation {
            snapshot,
            status: "ready".into(),
        };
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            recheck_room_charge_approval(&conn, "room-snapshot", &confirmation).unwrap(),
            "ready"
        );
        conn.execute(
            "UPDATE orders SET status = 'completed' WHERE id = 'room-snapshot'",
            [],
        )
        .unwrap();
        confirmation.status = "confirmed".into();
        assert_eq!(
            recheck_room_charge_approval(&conn, "room-snapshot", &confirmation).unwrap(),
            "completed"
        );
        conn.execute(
            "UPDATE orders SET payment_status = 'refunded' WHERE id = 'room-snapshot'",
            [],
        )
        .unwrap();
        assert!(recheck_room_charge_approval(&conn, "room-snapshot", &confirmation).is_err());
        conn.execute(
            "UPDATE orders SET payment_status = 'paid' WHERE id = 'room-snapshot'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE orders SET status = 'cancelled' WHERE id = 'room-snapshot'",
            [],
        )
        .unwrap();
        assert!(recheck_room_charge_approval(&conn, "room-snapshot", &confirmation).is_err());
        conn.execute("UPDATE orders SET status = 'pending', ghost_metadata = '{\"kiosk\":{\"paymentMethod\":\"cash\"}}' WHERE id = 'room-snapshot'", []).unwrap();
        assert!(recheck_room_charge_approval(&conn, "room-snapshot", &confirmation).is_err());
    }

    #[tokio::test]
    async fn twint_new_checkout_refuses_held_card_unknown_sale_fiscal_and_orphan_approval() {
        for prior in ["held", "sale", "fiscal", "orphan"] {
            for method_key in ["method", "paymentMethod", "payment_method"] {
                let db = test_db();
                let reference = format!("twint-checkout-{prior}-{method_key}");
                {
                    let conn = db.conn.lock().unwrap();
                    if prior == "held" {
                        let card = serde_json::json!({"initialPayment":{"method":"card","amount":12,"currency":"CHF","transactionRef":"approved-card","terminalApproved":true,"paymentOrigin":"terminal"}});
                        let (entry, _) =
                            crate::unsaved_payments::UnsavedChargedPayment::for_new_order_checkout(
                                &reference, &card, "now",
                            )
                            .unwrap();
                        crate::unsaved_payments::record(&conn, &entry).unwrap();
                    } else if prior == "orphan" {
                        db::set_setting(&conn,"ecr_orphaned_receipts",&reference,&serde_json::json!({"id":"orphan-approval","status":"approved","deviceId":"device"}).to_string()).unwrap();
                    } else {
                        conn.execute("INSERT INTO ecr_devices(id,name,device_type,brand,protocol,connection_type,connection_details) VALUES ('device','Reader','payment_terminal','test','test','network','{}')",[]).unwrap();
                        conn.execute("INSERT INTO ecr_transactions(id,device_id,order_id,transaction_type,amount,currency,status,started_at) VALUES ('prior','device',?1,?2,1200,'CHF','timeout','now')",params![reference, if prior=="sale" {"sale"} else {"fiscal_receipt"}]).unwrap();
                    }
                }
                let mut tender = serde_json::json!({"amount":12,"currency":"CHF","idempotencyKey":"twint-original","metadata":{"provider":"twint","confirmation":"cashier","confirmation_action":"confirm","qr_mode":"static_qr_manual"}});
                tender[method_key] = serde_json::json!(" TWINT ");
                let result = create_order_with_initial_payment(
                    &db,
                    &crate::ecr::DeviceManager::new(),
                    &crate::print::NoopPrintQueueInvalidator,
                    serde_json::json!({"clientRequestId":reference,"initialPayment":tender}),
                    &[],
                )
                .await
                .unwrap();
                assert_eq!(
                    result["errorCode"],
                    "TWINT_PRIOR_CHECKOUT_RECONCILIATION_REQUIRED"
                );
                let conn = db.conn.lock().unwrap();
                assert_eq!(
                    conn.query_row("SELECT count(*) FROM orders", [], |row| row
                        .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
                assert_eq!(
                    conn.query_row("SELECT count(*) FROM order_payments", [], |row| row
                        .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
                if prior == "held" {
                    assert_eq!(
                        crate::unsaved_payments::list(&conn, Some(&reference))
                            .unwrap()
                            .len(),
                        1
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn twint_manual_receipt_failure_restart_recovery_saves_original_once_without_provider_approval(
    ) {
        let db = crate::tests::harness::TestDb::open();
        {
            let conn = db.state.conn.lock().unwrap();
            for (key, value) in [
                ("organization_id", "manual-org"),
                ("branch_id", "manual-branch"),
                ("terminal_id", "manual-terminal"),
            ] {
                db::set_setting(&conn, "terminal", key, value).unwrap();
            }
            for (key, value) in [
                ("currency", "CHF"),
                ("store_currency_available", "true"),
                ("store_currency_source", "branch_country"),
                ("store_currency_branch_id", "manual-branch"),
            ] {
                db::set_setting(&conn, "restaurant", key, value).unwrap();
            }
        }
        let payload = serde_json::json!({"clientRequestId":"manual-checkout","organizationId":"manual-org","branchId":"manual-branch","terminalId":"manual-terminal","items":[{"name":"Coffee","quantity":1,"price":12}],"totalAmount":12,"subtotal":12,"status":"completed","orderType":"takeaway","initialPayment":{"method":"twint","amount":12,"currency":"CHF","idempotencyKey":"manual-receipt-key","staffId":"manual-cashier","staffShiftId":"manual-shift","metadata":{"provider":"twint","confirmation":"cashier","confirmation_action":"skip","qr_mode":"static_qr_manual"}}});
        let mgr = crate::ecr::DeviceManager::new();
        let first = create_order_with_initial_payment(
            &db.state,
            &mgr,
            &crate::print::NoopPrintQueueInvalidator,
            payload.clone(),
            &[],
        )
        .await
        .unwrap();
        assert_eq!(first["errorCode"], "PAYMENT_NOT_SAVED");
        assert_eq!(first["manualReceiptConfirmed"], true);
        assert!(first["paymentApproved"].is_null());
        let db = db.restart();
        {
            let conn = db.state.conn.lock().unwrap();
            let held = crate::unsaved_payments::list(&conn, None).unwrap();
            assert_eq!(held.len(), 1);
            assert!(held[0].is_manual_twint());
            assert_eq!(held[0].amount_cents, 1200);
            assert_eq!(
                held[0].request["initialPayment"]["metadata"]["confirmation_action"],
                "skip"
            );
            assert!(held[0].transaction_ref.is_none());
        }
        let mut changed = payload.clone();
        changed["totalAmount"] = serde_json::json!(15);
        let conflict = create_order_with_initial_payment(
            &db.state,
            &mgr,
            &crate::print::NoopPrintQueueInvalidator,
            changed,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(conflict["errorCode"], "PAYMENT_NOT_SAVED");
        {
            let conn = db.state.conn.lock().unwrap();
            assert_eq!(
                conn.query_row("SELECT count(*) FROM orders", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            conn.execute("INSERT INTO staff_shifts(id,staff_id,staff_name,branch_id,terminal_id,role_type,check_in_time,opening_cash_amount,status,sync_status,created_at,updated_at,currency) VALUES ('manual-shift','manual-cashier','Cashier','manual-branch','manual-terminal','cashier','now',0,'active','pending','now','now','CHF')",[]).unwrap();
        }
        // Recovery loads the durable original, rather than asking the QR UI
        // for another scan or cashier receipt confirmation.
        let saved = crate::unsaved_payments::save_unsaved_payments(
            &db.state,
            None,
            Some("manual-receipt-key"),
            &[],
            &crate::print::NoopPrintQueueInvalidator,
        )
        .await
        .unwrap();
        assert_eq!(saved["success"], true);
        assert_eq!(saved["saved"], 1);
        let again = create_order_with_initial_payment(
            &db.state,
            &mgr,
            &crate::print::NoopPrintQueueInvalidator,
            payload,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(again["success"], true);
        let conn = db.state.conn.lock().unwrap();
        assert!(crate::unsaved_payments::list(&conn, None)
            .unwrap()
            .is_empty());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM orders", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let row:(String,String,Option<String>,String)=conn.query_row("SELECT method,currency,transaction_ref,metadata FROM order_payments WHERE idempotency_key='manual-receipt-key'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!((&row.0, &row.1), (&"twint".into(), &"CHF".into()));
        assert!(row.2.is_none());
        assert_eq!(
            serde_json::from_str::<Value>(&row.3).unwrap()["confirmation_action"],
            "skip"
        );
    }

    #[test]
    fn food_item_readiness_cache_fill_is_durable_scoped_and_preserves_order_edits() {
        let db = test_db();
        insert_order(&db, "food-cache", "confirmed");
        let conn = db.conn.lock().unwrap();
        let remote_id = uuid::Uuid::new_v4().to_string();
        for (key, value) in [
            ("organization_id", "food-org"),
            ("branch_id", "food-branch"),
            ("terminal_id", "food-terminal"),
        ] {
            db::set_setting(&conn, "terminal", key, value).unwrap();
        }
        conn.execute("UPDATE orders SET plugin = 'efood', supabase_id = ?1,
            branch_id = 'food-branch', estimated_time = 30, updated_at = '2026-10-02T16:08:26Z', notes = ?2
            WHERE id = 'food-cache'", params![remote_id, "Πολλά σχόλια 🙂\nδεύτερη γραμμή"]).unwrap();
        let fetched = serde_json::json!([
            {"name":"Waffle","quantity":1,"unit_price":8,"total_price":8,
             "notes":"χωρίς ζάχαρη", "customizations":[{"name":"σοκολάτα","quantity":1}]},
            {"name":"Drink","quantity":1,"unit_price":2,"total_price":2}
        ]);
        assert!(
            persist_fetched_food_order_items(&conn, "food-cache", "wrong-remote", &fetched)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            persist_fetched_food_order_items(&conn, "food-cache", &remote_id, &fetched).unwrap(),
            Some(fetched.clone())
        );
        let stored: (String, String, String, i64, String, f64) = conn
            .query_row(
                "SELECT items, status, sync_status, estimated_time, updated_at, total_amount
             FROM orders WHERE id = 'food-cache'",
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
        assert_eq!(serde_json::from_str::<Value>(&stored.0).unwrap(), fetched);
        assert_eq!(
            (
                stored.1.as_str(),
                stored.2.as_str(),
                stored.3,
                stored.4.as_str(),
                stored.5
            ),
            ("confirmed", "pending", 30, "2026-10-02T16:08:26Z", 10.0)
        );
        // A transient empty fetch and a competing nonempty fetch cannot replace
        // the complete local list (which may contain legitimate local edits).
        assert_eq!(
            persist_fetched_food_order_items(
                &conn,
                "food-cache",
                &remote_id,
                &serde_json::json!([])
            )
            .unwrap(),
            Some(fetched.clone())
        );
        let competing = serde_json::json!([{"name":"Other","quantity":1}]);
        assert_eq!(
            persist_fetched_food_order_items(&conn, "food-cache", &remote_id, &competing).unwrap(),
            Some(fetched.clone())
        );
        for incoming in ["[]", "null", "\"[]\"", "[null]"] {
            assert!(preserve_food_items_on_incomplete_snapshot(
                &conn,
                "food-cache",
                Some(incoming.into())
            )
            .unwrap()
            .is_none());
        }
        conn.execute(
            "UPDATE orders SET plugin = 'pos' WHERE id = 'food-cache'",
            [],
        )
        .unwrap();
        assert_eq!(
            preserve_food_items_on_incomplete_snapshot(&conn, "food-cache", Some("[]".into()))
                .unwrap(),
            Some("[]".into())
        );
    }

    #[tokio::test]
    async fn food_item_readiness_authorized_fetch_persists_before_return_and_empty_fetch_keeps_cache(
    ) {
        let db = test_db();
        insert_order(&db, "food-fetch", "confirmed");
        let remote_id = uuid::Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            for (key, value) in [
                ("organization_id", "food-org"),
                ("branch_id", "food-branch"),
                ("terminal_id", "food-terminal"),
            ] {
                db::set_setting(&conn, "terminal", key, value).unwrap();
            }
            conn.execute(
                "UPDATE orders SET plugin = 'efood', supabase_id = ?1, branch_id = 'food-branch'
                WHERE id = 'food-fetch'",
                [&remote_id],
            )
            .unwrap();
            // Explicit detail hydration remains available after automatic recovery
            // has exhausted its persisted attempt cap.
            for _ in 0..6 {
                conn.execute("INSERT INTO recovery_action_log (id, action_id, issue_code, entity_id, payload_json)
                    VALUES (?1, 'hydrate_food_print_items', 'food_order_items_pending', 'food-fetch', ?2)",
                    params![uuid::Uuid::new_v4().to_string(), serde_json::json!({"remoteOrderId":remote_id,"version":1}).to_string()]).unwrap();
            }
        }
        let rows = serde_json::json!([
            {"id":"waffle-row", "menu_item_name":"Waffle", "quantity":1, "unit_price":8,
             "total_price":8, "notes":"χωρίς ζάχαρη 🙂", "customizations":[{"name":"σοκολάτα"}]},
            {"id":"drink-row", "menu_item_name":"Drink", "quantity":1, "unit_price":2, "total_price":2}
        ]);
        let empty = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fetch = |path: String, params: Vec<(&'static str, String)>| {
            let remote_id = remote_id.clone();
            let rows = rows.clone();
            let empty = empty.clone();
            async move {
                match path.as_str() {
                    "orders" => {
                        assert!(params.contains(&("id", format!("eq.{remote_id}"))));
                        assert!(params.contains(&("organization_id", "eq.food-org".into())));
                        assert!(params.contains(&("branch_id", "eq.food-branch".into())));
                        Ok(
                            serde_json::json!([{"id":remote_id, "organization_id":"food-org",
                            "branch_id":"food-branch", "terminal_id":"food-terminal"}]),
                        )
                    }
                    "order_items" => {
                        assert!(
                            params.contains(&("order_id", format!("eq.{remote_id}"))),
                            "must resolve the local ID to its remote ID"
                        );
                        Ok(if empty.load(std::sync::atomic::Ordering::SeqCst) {
                            serde_json::json!([])
                        } else {
                            rows
                        })
                    }
                    _ => panic!("unexpected network request: {path}"),
                }
            }
        };
        let returned = fetch_order_items_for_local_cache_with(&db, "food-fetch", false, &fetch)
            .await
            .unwrap();
        assert_eq!(returned.as_array().unwrap().len(), 2);
        assert_eq!(returned[0]["notes"], "χωρίς ζάχαρη 🙂");
        assert_eq!(returned[0]["customizations"], rows[0]["customizations"]);
        let stored: String = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT items FROM orders WHERE id = 'food-fetch'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), returned);
        empty.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            fetch_order_items_for_local_cache_with(&db, "food-fetch", false, &fetch)
                .await
                .unwrap(),
            returned
        );
    }

    #[test]
    fn gift_create_fiscal_handoff_preserves_pending_order_without_a_fiscal_row() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                 id, organization_id, branch_id, items, total_amount, total_amount_cents,
                 status, payment_status, sync_status, created_at, updated_at
             ) VALUES (
                 'gift-create-original', 'org-gift-create', 'branch-gift-create', '[]', 10.0, 1000,
                 'pending', 'pending', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, module_type, status
             ) VALUES (
                 'gift-original-order-sync', 'orders', 'gift-create-original', 'INSERT',
                 '{\"paymentMethod\":\"gift_card\",\"paymentStatus\":\"pending\"}',
                 'org-gift-create', datetime('now'), 'orders', 'pending'
             )",
            [],
        )
        .unwrap();

        for original in [
            serde_json::json!({"paymentMethod":"gift_card", "paymentStatus":"pending"}),
            serde_json::json!({"payment_method":"gift_card", "payment_status":"pending"}),
            serde_json::json!({"paymentMethod":"gift_card", "payment_method":"gift_card",
                "paymentStatus":"pending", "payment_status":"pending"}),
        ] {
            enqueue_order_creation_fiscal(&conn, "gift-create-original", &original).unwrap();
            enqueue_order_creation_fiscal(&conn, "gift-create-original", &original).unwrap();
        }
        let retained: (String, String, i64) = conn.query_row(
            "SELECT payment_status, sync_status, total_amount_cents FROM orders WHERE id = 'gift-create-original'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(retained, ("pending".into(), "pending".into(), 1000));
        let rows: (i64, i64, i64, i64) = conn.query_row(
            "SELECT
                 (SELECT COUNT(*) FROM parity_sync_queue WHERE module_type = 'fiscal'),
                 (SELECT COUNT(*) FROM parity_sync_queue WHERE id = 'gift-original-order-sync' AND status = 'pending'),
                 (SELECT COUNT(*) FROM order_payments),
                 (SELECT COUNT(*) FROM fiscal_sequence_counters)",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(rows, (0, 1, 0, 0));
    }

    #[test]
    fn gift_create_fiscal_handoff_keeps_ordinary_and_noncanonical_enqueue_behavior() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        for (index, payload) in [
            serde_json::json!({"paymentMethod":"cash", "paymentStatus":"pending"}),
            serde_json::json!({"paymentMethod":"card", "paymentStatus":"pending"}),
            serde_json::json!({"paymentMethod":"gift_card", "paymentStatus":"completed"}),
            serde_json::json!({"paymentMethod":"gift_card"}),
            serde_json::json!({"paymentMethod":"gift_card", "payment_method":"cash", "paymentStatus":"pending"}),
            serde_json::json!({"paymentMethod":"gift_card", "paymentStatus":"pending", "payment_status":"completed"}),
            serde_json::json!({"paymentMethod":"gift_card", "paymentStatus":"pending", "initialPayment":null}),
            serde_json::json!({"paymentMethod":"gift_card", "paymentStatus":"pending", "initial_payment":{}}),
        ].into_iter().enumerate() {
            let order_id = format!("ordinary-create-control-{index}");
            conn.execute(
                "INSERT INTO orders (
                     id, organization_id, branch_id, items, total_amount, total_amount_cents,
                     status, payment_status, sync_status, created_at, updated_at, currency
                 ) VALUES (?1, 'org-gift-control', 'branch-gift-control', '[]', 10.0, 1000,
                     'pending', 'pending', 'pending', datetime('now'), datetime('now'), 'EUR')",
                [&order_id],
            ).unwrap();
            enqueue_order_creation_fiscal(&conn, &order_id, &payload).unwrap();
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE module_type = 'fiscal' AND record_id = ?1",
                [&order_id], |row| row.get(0),
            ).unwrap();
            assert_eq!(count, 1, "ordinary fiscal handoff remains for control {index}");
        }
    }

    #[test]
    fn delivery_driver_assignment_resolves_and_requeues_pending_tip_recipient() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, order_type, total_amount, total_amount_cents,
                 tip_amount, tip_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-driver-tip', 'remote-order-driver-tip', '[]', 'delivery',
                 12.0, 1200, 2.0, 200, 'pending', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("insert delivery order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents,
                 tip_amount, tip_amount_cents, tip_recipient_role,
                 status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'payment-driver-tip', 'order-driver-tip', 'cash', 12.0, 1200,
                 2.0, 200, 'driver',
                 'completed', 'synced', 'applied', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("insert pending driver tip payment");

        let updated = resolve_delivery_tip_recipients_for_assignment(
            &conn,
            "order-driver-tip",
            "driver-1",
            "driver-shift-1",
            "2026-07-23T10:00:00Z",
        )
        .expect("resolve driver tip");
        assert_eq!(updated, 1);

        let (staff_id, shift_id, sync_status, sync_state): (
            Option<String>,
            Option<String>,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT tip_recipient_staff_id, tip_recipient_staff_shift_id,
                        sync_status, sync_state
                 FROM order_payments
                 WHERE id = 'payment-driver-tip'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("load assigned driver tip payment");
        assert_eq!(staff_id.as_deref(), Some("driver-1"));
        assert_eq!(shift_id.as_deref(), Some("driver-shift-1"));
        assert_eq!(sync_status, "pending");
        assert_eq!(sync_state, "pending");

        let queue_data: String = conn
            .query_row(
                "SELECT data
                 FROM parity_sync_queue
                 WHERE table_name = 'payments'
                   AND record_id = 'payment-driver-tip'",
                [],
                |row| row.get(0),
            )
            .expect("load rebuilt payment sync payload");
        let queue_payload: serde_json::Value =
            serde_json::from_str(&queue_data).expect("parse rebuilt payment sync payload");
        assert_eq!(
            queue_payload
                .get("tipRecipientStaffId")
                .and_then(serde_json::Value::as_str),
            Some("driver-1")
        );
        assert_eq!(
            queue_payload
                .get("tipRecipientStaffShiftId")
                .and_then(serde_json::Value::as_str),
            Some("driver-shift-1")
        );

        let reassigned = resolve_delivery_tip_recipients_for_assignment(
            &conn,
            "order-driver-tip",
            "driver-2",
            "driver-shift-2",
            "2026-07-23T10:15:00Z",
        )
        .expect("reassign driver tip");
        assert_eq!(reassigned, 1);

        let (reassigned_staff_id, reassigned_shift_id): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT tip_recipient_staff_id, tip_recipient_staff_shift_id
                 FROM order_payments
                 WHERE id = 'payment-driver-tip'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load reassigned driver tip payment");
        assert_eq!(reassigned_staff_id.as_deref(), Some("driver-2"));
        assert_eq!(reassigned_shift_id.as_deref(), Some("driver-shift-2"));

        let reassigned_queue_data: String = conn
            .query_row(
                "SELECT data
                 FROM parity_sync_queue
                 WHERE table_name = 'payments'
                   AND record_id = 'payment-driver-tip'",
                [],
                |row| row.get(0),
            )
            .expect("load requeued reassigned driver tip");
        let reassigned_queue_payload: serde_json::Value =
            serde_json::from_str(&reassigned_queue_data)
                .expect("parse requeued reassigned driver tip");
        assert_eq!(
            reassigned_queue_payload
                .get("tipRecipientStaffId")
                .and_then(serde_json::Value::as_str),
            Some("driver-2")
        );
        assert_eq!(
            reassigned_queue_payload
                .get("tipRecipientStaffShiftId")
                .and_then(serde_json::Value::as_str),
            Some("driver-shift-2")
        );
    }

    fn insert_order_with_financials(
        db: &db::DbState,
        order_id: &str,
        items_json: &str,
        subtotal: f64,
        total_amount: f64,
        payment_status: &str,
    ) {
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate cents siblings via Cents::round_half_even.
        let subtotal_cents = Cents::round_half_even(subtotal).as_i64();
        let total_amount_cents = Cents::round_half_even(total_amount).as_i64();
        conn.execute(
            "INSERT INTO orders (
                 id, items, subtotal, subtotal_cents, total_amount, total_amount_cents, status, payment_status,
                 sync_status, created_at, updated_at
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, 'completed', ?7, 'pending', datetime('now'), datetime('now')
             )",
            params![order_id, items_json, subtotal, subtotal_cents, total_amount, total_amount_cents, payment_status],
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
        // W4e Step 0: dual-populate amount + amount_cents.
        let amount_cents = Cents::round_half_even(amount).as_i64();
        conn.execute(
            "INSERT INTO payment_adjustments (
                 id, payment_id, order_id, adjustment_type, amount, amount_cents,
                 reason, staff_id, sync_state, created_at, updated_at
             ) VALUES (
                 ?1, ?2, ?3, 'refund', ?4, ?5,
                 'edit settlement test', NULL, 'pending', datetime('now'), datetime('now')
             )",
            params![adjustment_id, payment_id, order_id, amount, amount_cents],
        )
        .unwrap();
    }

    fn insert_pickup_order_for_conversion(db: &db::DbState, order_id: &str) {
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (15.0 → 1500).
        conn.execute(
            "INSERT INTO orders (
                 id, order_number, items, subtotal, subtotal_cents, total_amount, total_amount_cents, status, order_type,
                 sync_status, created_at, updated_at
             ) VALUES (
                 ?1, '00001', '[]', 15.0, 1500, 15.0, 1500, 'pending', 'pickup',
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
    fn local_transition_validation_allows_delivered_to_cancelled() {
        let db = test_db();
        insert_order(&db, "order-delivered", "delivered");
        let conn = db.conn.lock().unwrap();

        let previous_status =
            ensure_order_status_transition_allowed(&conn, "order-delivered", "cancelled").expect(
                "delivered -> cancelled should be allowed for returned delivery corrections",
            );
        assert_eq!(previous_status, "delivered");
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
    fn pending_room_charge_cannot_bypass_online_approval_through_generic_status() {
        let db = test_db();
        insert_order(&db, "room-pending", "pending");
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE orders SET ghost_metadata = '{\"kiosk\":{\"paymentMethod\":\"room_charge\"}}' WHERE id = 'room-pending'", []).unwrap();
        let error =
            ensure_order_status_transition_allowed(&conn, "room-pending", "confirmed").unwrap_err();
        assert!(error.starts_with("ROOM_CHARGE_UNAVAILABLE"));
        assert_eq!(
            load_canonical_order_status(&conn, "room-pending").unwrap(),
            "pending"
        );
        assert!(ensure_order_status_transition_with_room_confirmation(
            &conn,
            "room-pending",
            "confirmed",
            true
        )
        .is_ok());
        assert!(ensure_order_status_transition_allowed(&conn, "room-pending", "cancelled").is_ok());
    }

    #[test]
    fn completion_guard_detects_order_without_persisted_payment() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (13.7 → 1370).
            conn.execute(
                "INSERT INTO orders (
                     id, order_number, items, total_amount, total_amount_cents, status, payment_status,
                     sync_status, created_at, updated_at
                 ) VALUES (
                     'order-unpaid-final', 'ORD-guard-1', '[]', 13.7, 1370, 'pending', 'pending',
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
        for stale_status in ["pending", "failed", "conflict"] {
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
                 SET status = ?1,
                     attempts = 3,
                     error_message = 'Parent shift not yet synced'
                 WHERE table_name = 'driver_earnings'
                   AND record_id = 'earning-1'",
                rusqlite::params![stale_status],
            )
            .unwrap();

            let payload = serde_json::json!({
                "id": "earning-1",
                "driver_id": "driver-1",
                "staff_shift_id": "shift-new",
                "order_id": "order-new"
            });

            order_ownership::enqueue_or_refresh_driver_earning_sync_row(
                &conn,
                "earning-1",
                &payload,
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

            let (status, retry_count, last_error, payload_text): (
                String,
                i64,
                Option<String>,
                String,
            ) = conn
                .query_row(
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
    fn resolve_edit_settlement_totals_honors_financial_payload() {
        let db = test_db();
        insert_order_with_financials(
            &db,
            "order-delivery-reprice",
            r#"[{"name":"Crepe","quantity":1,"unit_price":12.8,"total_price":12.8}]"#,
            12.0,
            12.0,
            "paid",
        );

        let payload = OrderEditSettlementPayload {
            order_id: "order-delivery-reprice".to_string(),
            items: vec![serde_json::json!({
                "name": "Crepe",
                "quantity": 1,
                "unit_price": 12.8,
                "total_price": 12.8
            })],
            order_notes: None,
            order_updates: None,
            financials: Some(EditSettlementFinancialsPayload {
                total_amount: Some(12.8),
                subtotal: Some(12.8),
                tax_amount: Some(0.0),
                delivery_fee: Some(0.0),
                ..Default::default()
            }),
        };

        let conn = db.conn.lock().unwrap();
        let (derived_total, _) =
            derive_next_order_totals(&conn, "order-delivery-reprice", &payload.items)
                .expect("derived totals");
        let (next_total, next_subtotal) =
            resolve_edit_settlement_totals(&conn, "order-delivery-reprice", &payload)
                .expect("resolved totals");

        assert!((derived_total - 12.0).abs() < 0.001);
        assert!((next_total - 12.8).abs() < 0.001);
        assert!((next_subtotal - 12.8).abs() < 0.001);
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
            "paid",
        );

        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (10.0 → 1000).
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, created_at, updated_at
             ) VALUES (
                 'payment-edit-partial', 'order-edit-partial', 'cash', 10.0, 1000, 'completed',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        // W4e Step 0: dual-populate (12.0 → 1200).
        conn.execute(
            "UPDATE orders
             SET total_amount = 12.0,
                 total_amount_cents = 1200,
                 subtotal = 12.0,
                 subtotal_cents = 1200,
                 updated_at = datetime('now')
             WHERE id = 'order-edit-partial'",
            [],
        )
        .unwrap();

        let (payment_status, payment_method, total_paid) =
            refresh_order_payment_snapshot(&conn, "order-edit-partial", "2026-03-20T12:00:00Z")
                .expect("refresh payment snapshot");

        assert_eq!(payment_status, "partially_paid");
        // W6: with one completed cash row, derive_payment_method returns
        // "cash" (not "split"). The old `has_item_assignments` / sticky
        // stored-column logic that wrote "split" for partial states is
        // gone; partial-vs-paid now lives purely in `payment_status`.
        assert_eq!(payment_method, "cash");
        assert!((total_paid - 10.0).abs() < 0.001);
    }

    #[test]
    fn payment_principal_tip_edit_preview_and_snapshot_do_not_invent_missing_money() {
        let db = test_db();
        insert_order_with_financials(
            &db,
            "tip-edit",
            r#"[{"name":"Coffee","quantity":1,"unit_price":12,"total_price":12}]"#,
            12.0,
            12.0,
            "paid",
        );
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,tip_amount,tip_amount_cents,status,created_at,updated_at) VALUES ('tip-edit-payment','tip-edit','cash',14,1400,8,800,'completed','now','now')",[]).unwrap();
        let coverage = capture_proven_payment_coverage(&conn, "tip-edit").unwrap();
        assert_eq!(
            coverage.missing_cents, 0,
            "Known receipt tips must not manufacture missing historical money"
        );
        let payload = OrderEditSettlementPayload {
            order_id: "tip-edit".into(),
            items: vec![
                serde_json::json!({"name":"Coffee","quantity":1,"unit_price":12,"total_price":12}),
            ],
            order_notes: None,
            order_updates: None,
            financials: None,
        };
        let preview = preview_edit_settlement_in_connection(&conn, &payload).unwrap();
        assert_eq!(preview["paidTotal"], 6.0);
        assert_eq!(preview["requiredAction"], "collect");
        let snapshot =
            refresh_order_payment_snapshot_with_coverage(&conn, "tip-edit", "now", &coverage)
                .unwrap();
        assert_eq!(snapshot.status, "partially_paid");
        assert_eq!(snapshot.ledger_paid, 6.0);
        assert_eq!(
            payments::load_net_paid_for_order(&conn, "tip-edit").unwrap(),
            14.0
        );
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
    fn determine_edit_settlement_required_action_unpaid_orders_never_settle() {
        // Unpaid/pending order (no payment applied): a no-op edit keeps the same
        // total and a real edit changes it — neither may force collect/refund.
        // This is the live #00014 defect: a no-op edit on an €18.50 unpaid pickup
        // order opened an Extra Payment prompt for the full amount.
        assert_eq!(determine_edit_settlement_required_action(0.0, 18.5), "none");
        assert_eq!(determine_edit_settlement_required_action(0.0, 0.0), "none");
        assert_eq!(determine_edit_settlement_required_action(0.0, 25.0), "none");
        // Boundary: a residual cent of paid total is still treated as unpaid.
        assert_eq!(
            determine_edit_settlement_required_action(0.01, 18.5),
            "none"
        );
        // Partially paid still collects the remaining delta as before.
        assert_eq!(
            determine_edit_settlement_required_action(5.0, 18.5),
            "collect"
        );
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
            "partially_paid",
        );

        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (7.4 → 740).
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'payment-edit-stale', 'order-edit-stale', 'cash', 7.4, 740, 'completed',
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
    fn edit_settlement_refund_action_skips_stale_overpay_auto_void() {
        let db = test_db();
        insert_order_with_financials(
            &db,
            "order-edit-refund-pending-payment",
            r#"[
                {"name":"Gianniotiki","quantity":2,"unit_price":6.9,"total_price":13.8},
                {"name":"Crepe","quantity":1,"unit_price":5.9,"total_price":5.9},
                {"name":"Crepe","quantity":1,"unit_price":5.6,"total_price":5.6}
            ]"#,
            25.3,
            25.3,
            "paid",
        );

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, sync_status, sync_state,
                 created_at, updated_at
             ) VALUES (
                 'payment-edit-refund-pending', 'order-edit-refund-pending-payment',
                 'cash', 25.3, 2530, 'completed', 'pending', 'pending',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();

        update_order_items_in_connection(
            &conn,
            "order-edit-refund-pending-payment",
            &[
                serde_json::json!({
                    "name": "Gianniotiki",
                    "quantity": 1,
                    "unit_price": 6.9,
                    "total_price": 6.9
                }),
                serde_json::json!({
                    "name": "Baguette",
                    "quantity": 1,
                    "unit_price": 5.9,
                    "total_price": 5.9
                }),
                serde_json::json!({
                    "name": "Crepe",
                    "quantity": 1,
                    "unit_price": 5.9,
                    "total_price": 5.9
                }),
                serde_json::json!({
                    "name": "Crepe",
                    "quantity": 1,
                    "unit_price": 5.6,
                    "total_price": 5.6
                }),
            ],
            None,
            24.3,
            24.3,
            "2026-05-19T00:27:00Z",
        )
        .unwrap();

        let action = EditSettlementActionPayload::Refund {
            refunds: vec![EditSettlementRefundPayload {
                payment_id: "payment-edit-refund-pending".to_string(),
                amount: 1.0,
                reason: "Edit settlement refund".to_string(),
                refund_method: Some("cash".to_string()),
                cash_handler: Some("cashier_drawer".to_string()),
                staff_id: None,
                staff_shift_id: None,
            }],
        };
        let stale_payment_ids = if should_resolve_stale_overpay_payments_before_edit_action(&action)
        {
            resolve_stale_unsynced_overpay_payments_for_order(
                &conn,
                "order-edit-refund-pending-payment",
                "2026-05-19T00:27:00Z",
            )
            .unwrap()
        } else {
            Vec::new()
        };

        assert!(
            stale_payment_ids.is_empty(),
            "refund settlement must preserve the parent payment so the refund can attach to it"
        );
        let status: String = conn
            .query_row(
                "SELECT status FROM order_payments WHERE id = 'payment-edit-refund-pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "completed");

        let paid_total =
            load_net_paid_for_order(&conn, "order-edit-refund-pending-payment").unwrap();
        assert!((paid_total - 25.3).abs() < 0.001);
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
            "paid",
        );

        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (12.8 → 1280).
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, created_at, updated_at
             ) VALUES (
                 'payment-net-paid', 'order-net-paid', 'card', 12.8, 1280, 'completed',
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

    // Same-method edit deltas must keep presenting as that method; only
    // mixed-method rows collapse to "split". The test below covers the
    // genuine cash+card case.

    #[test]
    fn refresh_order_payment_snapshot_flags_split_when_methods_actually_differ() {
        // Complementary test: if the two completed payments use different
        // methods (e.g. €10 cash + €2 card), the card SHOULD render the
        // split presentation. This keeps the genuine split flow intact.
        let db = test_db();
        insert_order_with_financials(
            &db,
            "order-delta-mixed",
            r#"[{"name":"Crepe","quantity":1,"unit_price":12.0,"total_price":12.0}]"#,
            12.0,
            12.0,
            "paid",
        );

        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (10.0 → 1000, 2.0 → 200).
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, created_at, updated_at
             ) VALUES (
                 'payment-mixed-1', 'order-delta-mixed', 'cash', 10.0, 1000, 'completed',
                 datetime('now', '-1 minute'), datetime('now', '-1 minute')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, created_at, updated_at
             ) VALUES (
                 'payment-mixed-2', 'order-delta-mixed', 'card', 2.0, 200, 'completed',
                 datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();

        let (payment_status, payment_method, _total_paid) =
            refresh_order_payment_snapshot(&conn, "order-delta-mixed", "2026-04-22T14:30:00Z")
                .expect("refresh payment snapshot");

        assert_eq!(payment_status, "paid");
        assert_eq!(
            payment_method, "split",
            "mixed methods must still render as split"
        );
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
            "paid",
        );

        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (12.8 → 1280).
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, created_at, updated_at
             ) VALUES (
                 'payment-edit-refunded', 'order-edit-refunded', 'card', 12.8, 1280, 'completed',
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
        // W6: one completed card row + refund adjustment → derive
        // returns "card" (the sole method actually on file). The
        // partial state is signaled by `payment_status`, not by the
        // method label.
        assert_eq!(payment_method, "card");
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
            "partially_paid",
        );

        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (7.4 → 740).
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'payment-financial-drop', 'order-financial-drop', 'cash', 7.4, 740, 'completed',
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
        // W4e Step 0: dual-populate the financial-drop UPDATE — the seed
        // wrote total_amount_cents=1000 (from 10.0); after this UPDATE
        // production reads must see 690 (from 6.9), so we also write
        // total_amount_cents=690 here. Without this, production's
        // COALESCE-with-real shim prefers the stale 1000 and the
        // overpay-stale detector fails to flag the 7.4 payment.
        conn.execute(
            "UPDATE orders
             SET total_amount = 6.9,
                 total_amount_cents = 690,
                 subtotal = 6.9,
                 subtotal_cents = 690,
                 discount_amount = 0,
                 discount_amount_cents = 0,
                 discount_percentage = 0,
                 tax_amount = 0,
                 tax_amount_cents = 0,
                 delivery_fee = 0,
                 delivery_fee_cents = 0,
                 tip_amount = 0,
                 tip_amount_cents = 0,
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
                delivery_address_id: None,
                delivery_city: Some("Athens".into()),
                delivery_postal_code: Some("10558".into()),
                delivery_floor: Some("3".into()),
                delivery_notes: Some("Side door".into()),
                name_on_ringer: Some("Alice".into()),
                delivery_latitude: None,
                delivery_longitude: None,
                delivery_address_fingerprint: None,
                delivery_zone_id: None,
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

/// Field incident 29/09/2026 (Le Petit Paris, Android POS 1.0.12; the same
/// path existed on the desktop): two card-paid orders had no local payment
/// row, an item edit recomputed the payment status from the local ledger
/// alone, downgraded `paid` to `pending` and pushed it. These pin the desktop
/// counterpart of the fix: never downgrade a paid order because the local
/// ledger lacks rows, restore the rows from the server first, never push a
/// local `pending` nobody set, and still honour an explicit void.
#[cfg(test)]
mod paid_edit_ledger_tests {
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

    /// A server-known order the checkout marked paid, whose local payment
    /// mirror was never written (the 29/09 state).
    fn seed_order(
        conn: &Connection,
        order_id: &str,
        total: f64,
        payment_status: &str,
        supabase_id: Option<&str>,
    ) {
        let total_cents = Cents::round_half_even(total).as_i64();
        let items = serde_json::json!([{
            "name": "Crepe",
            "quantity": 1,
            "unit_price": total,
            "total_price": total,
        }])
        .to_string();
        let sync_status = if supabase_id.is_some() {
            "synced"
        } else {
            "pending"
        };
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, subtotal, subtotal_cents, total_amount, total_amount_cents,
                 status, payment_status, sync_status, created_at, updated_at
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?4, ?5, 'completed', ?6, ?7,
                 '2026-09-29T11:05:13Z', '2026-09-29T11:05:13Z'
             )",
            params![
                order_id,
                supabase_id,
                items,
                total,
                total_cents,
                payment_status,
                sync_status,
            ],
        )
        .expect("seed order");
    }

    fn insert_completed_payment(
        conn: &Connection,
        payment_id: &str,
        order_id: &str,
        method: &str,
        amount: f64,
    ) {
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, sync_status, sync_state,
                 created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'completed', 'synced', 'applied', datetime('now'), datetime('now'))",
            params![
                payment_id,
                order_id,
                method,
                amount,
                Cents::round_half_even(amount).as_i64()
            ],
        )
        .expect("insert completed payment");
    }

    fn edit_payload(order_id: &str, total: f64, notes: Option<&str>) -> OrderEditSettlementPayload {
        OrderEditSettlementPayload {
            order_id: order_id.to_string(),
            items: vec![serde_json::json!({
                "name": "Crepe",
                "quantity": 1,
                "unit_price": total,
                "total_price": total,
            })],
            order_notes: notes.map(ToString::to_string),
            order_updates: None,
            financials: None,
        }
    }

    fn stored_payment_status(conn: &Connection, order_id: &str) -> String {
        conn.query_row(
            "SELECT payment_status FROM orders WHERE id = ?1",
            params![order_id],
            |row| row.get(0),
        )
        .expect("read payment status")
    }

    /// The newest queued order push for this order.
    fn queued_order_push(conn: &Connection, order_id: &str) -> serde_json::Value {
        let data: String = conn
            .query_row(
                "SELECT data FROM parity_sync_queue
                 WHERE table_name = 'orders' AND record_id = ?1
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                params![order_id],
                |row| row.get(0),
            )
            .expect("queued order push");
        serde_json::from_str(&data).expect("parse queued order push")
    }

    #[test]
    fn an_edit_keeps_a_card_paid_order_paid_when_its_local_payment_rows_are_missing() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "order-lpp-7",
            7.0,
            "paid",
            Some("remote-order-lpp-7"),
        );

        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("order-lpp-7", 7.0, Some("no sugar")),
            EditSettlementActionPayload::None,
            "2026-09-29T12:31:57Z",
        )
        .expect("apply edit");

        assert_eq!(response["paymentStatus"], "paid", "{response}");
        assert_eq!(stored_payment_status(&conn, "order-lpp-7"), "paid");
        let push = queued_order_push(&conn, "order-lpp-7");
        assert_eq!(push["paymentStatus"], "paid", "{push}");
        assert!(
            push.get("paymentMethod").is_none(),
            "no tender may be invented for rows the terminal does not hold: {push}"
        );
    }

    #[test]
    fn a_financials_update_keeps_the_proven_paid_status_without_local_rows() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "order-lpp-13",
            13.0,
            "paid",
            Some("remote-order-lpp-13"),
        );
        let payload: OrderUpdateFinancialsPayload = serde_json::from_value(serde_json::json!({
            "orderId": "order-lpp-13",
            "totalAmount": 13.0,
            "subtotal": 13.0,
        }))
        .unwrap();

        let (response, _) =
            update_order_financials_in_connection(&conn, &payload, "2026-09-29T16:42:00Z")
                .expect("update financials");

        assert_eq!(response["paymentStatus"], "paid", "{response}");
        assert_eq!(stored_payment_status(&conn, "order-lpp-13"), "paid");
        let push = queued_order_push(&conn, "order-lpp-13");
        assert_eq!(push["paymentStatus"], "paid", "{push}");
        assert!(push.get("paymentMethod").is_none(), "{push}");
    }

    #[test]
    fn a_grown_paid_order_without_local_rows_asks_only_for_the_difference() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "order-grown",
            7.0,
            "paid",
            Some("remote-order-grown"),
        );

        let preview =
            preview_edit_settlement_in_connection(&conn, &edit_payload("order-grown", 9.0, None))
                .expect("preview");
        assert_eq!(preview["requiredAction"], "collect", "{preview}");
        assert_eq!(preview["paidTotal"], 7.0, "{preview}");
        assert_eq!(preview["ledgerPaidTotal"], 0.0, "{preview}");

        // Without a collection the order is honestly partially paid, never
        // pending: the proven 7.00 still counts.
        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("order-grown", 9.0, None),
            EditSettlementActionPayload::MarkPartial,
            "2026-09-29T12:40:00Z",
        )
        .expect("apply grown edit");
        assert_eq!(response["paymentStatus"], "partially_paid", "{response}");
        assert_eq!(response["requiredAction"], "collect", "{response}");
        assert_eq!(
            queued_order_push(&conn, "order-grown")["paymentStatus"],
            "partially_paid"
        );
    }

    #[test]
    fn collecting_the_difference_completes_a_grown_order_whose_rows_are_missing() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "order-grown-paid",
            7.0,
            "paid",
            Some("remote-order-grown-paid"),
        );
        conn.execute(
            "UPDATE orders SET currency='EUR', branch_id='edit-branch' WHERE id='order-grown-paid'",
            [],
        )
        .unwrap();
        for (category, key, value) in [
            ("terminal", "branch_id", "edit-branch"),
            ("restaurant", "store_currency_branch_id", "edit-branch"),
            ("restaurant", "store_currency_available", "true"),
            ("restaurant", "store_currency_source", "branch_country"),
            ("restaurant", "currency", "EUR"),
        ] {
            db::set_setting(&conn, category, key, value).unwrap();
        }
        conn.execute(
            "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                check_in_time, status, sync_status, created_at, updated_at, currency)
             VALUES ('edit-cashier-shift', 'edit-cashier', 'cashier', 'edit-branch', 'edit-terminal',
                datetime('now'), 'active', 'pending', datetime('now'), datetime('now'), 'EUR')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents, opened_at, created_at, updated_at, currency)
             VALUES ('edit-drawer', 'edit-cashier-shift', 'edit-cashier', 'edit-branch', 'edit-terminal',
                0, 0, datetime('now'), datetime('now'), datetime('now'), 'EUR')",
            [],
        ).unwrap();
        let action: EditSettlementActionPayload = serde_json::from_value(serde_json::json!({
            "type": "collect",
            "payments": [{ "method": "card", "amount": 2.0 }],
        }))
        .unwrap();

        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("order-grown-paid", 9.0, None),
            action,
            "2026-09-29T12:45:00Z",
        )
        .expect("collect the difference");

        assert_eq!(response["paymentStatus"], "paid", "{response}");
        assert_eq!(stored_payment_status(&conn, "order-grown-paid"), "paid");

        // Collecting the whole new total again (the pre-fix outstanding) is
        // refused: the proven 7.00 is already money in hand.
        seed_order(
            &conn,
            "order-grown-over",
            7.0,
            "paid",
            Some("remote-order-grown-over"),
        );
        let over: EditSettlementActionPayload = serde_json::from_value(serde_json::json!({
            "type": "collect",
            "payments": [{ "method": "cash", "amount": 9.0 }],
        }))
        .unwrap();
        let error = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("order-grown-over", 9.0, None),
            over,
            "2026-09-29T12:46:00Z",
        )
        .expect_err("collecting the proven money twice must be refused");
        assert!(error.contains("exceeds outstanding balance"), "{error}");
        assert_eq!(stored_payment_status(&conn, "order-grown-over"), "paid");
    }

    #[test]
    fn a_pending_status_the_edit_did_not_change_is_never_pushed() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "order-unpaid",
            8.5,
            "pending",
            Some("remote-order-unpaid"),
        );

        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("order-unpaid", 9.5, None),
            EditSettlementActionPayload::None,
            "2026-09-29T13:00:00Z",
        )
        .expect("apply edit to unpaid order");

        assert_eq!(response["paymentStatus"], "pending");
        let push = queued_order_push(&conn, "order-unpaid");
        assert!(
            push.get("paymentStatus").is_none() && push.get("paymentMethod").is_none(),
            "a local default must not overwrite what the server knows: {push}"
        );
    }

    #[test]
    fn an_explicit_void_against_a_complete_ledger_still_changes_and_pushes_the_status() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "order-void",
            10.0,
            "partially_paid",
            Some("remote-order-void"),
        );
        // The 7.40 row was never accepted by the server (it exceeded the
        // total); the financial update voids it as a stale overpayment.
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, sync_status, sync_state,
                 created_at, updated_at
             ) VALUES ('payment-void', 'order-void', 'cash', 7.4, 740, 'completed', 'failed', 'failed',
                 datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        let payload: OrderUpdateFinancialsPayload = serde_json::from_value(serde_json::json!({
            "orderId": "order-void",
            "totalAmount": 6.9,
            "subtotal": 6.9,
        }))
        .unwrap();

        let (response, _) =
            update_order_financials_in_connection(&conn, &payload, "2026-09-29T13:10:00Z")
                .expect("update financials");

        assert_eq!(
            response["stalePaymentIdsVoided"],
            serde_json::json!(["payment-void"])
        );
        assert_eq!(response["paymentStatus"], "pending", "{response}");
        assert_eq!(
            queued_order_push(&conn, "order-void")["paymentStatus"],
            "pending",
            "an explicit void is a real change and is pushed"
        );
    }

    #[test]
    fn a_complete_local_ledger_alone_decides_the_status() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "order-mirrored",
            12.0,
            "paid",
            Some("remote-order-mirrored"),
        );
        insert_completed_payment(&conn, "payment-mirrored", "order-mirrored", "card", 12.0);

        let coverage = capture_proven_payment_coverage(&conn, "order-mirrored").unwrap();
        assert_eq!(coverage.missing_cents, 0);
        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("order-mirrored", 12.0, Some("extra napkins")),
            EditSettlementActionPayload::None,
            "2026-09-29T13:20:00Z",
        )
        .expect("apply edit");
        assert_eq!(response["paymentStatus"], "paid");
        assert_eq!(
            queued_order_push(&conn, "order-mirrored")["paymentMethod"],
            "card"
        );
    }

    #[test]
    fn only_server_known_orders_that_claim_money_they_do_not_hold_need_a_restore() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "needs-restore",
            7.0,
            "paid",
            Some("remote-needs-restore"),
        );
        seed_order(
            &conn,
            "partial-needs-restore",
            7.0,
            "partially_paid",
            Some("remote-partial"),
        );
        seed_order(&conn, "local-only", 7.0, "paid", None);
        seed_order(&conn, "unpaid", 7.0, "pending", Some("remote-unpaid"));
        seed_order(&conn, "mirrored", 7.0, "paid", Some("remote-mirrored"));
        insert_completed_payment(&conn, "payment-mirrored-7", "mirrored", "cash", 7.0);
        seed_order(&conn, "repair", 7.0, "paid", Some("remote-repair"));
        conn.execute(
            "UPDATE orders SET order_context = 'repair_settlement' WHERE id = 'repair'",
            [],
        )
        .unwrap();

        for (order_id, expected) in [
            ("needs-restore", true),
            ("partial-needs-restore", true),
            ("local-only", false),
            ("unpaid", false),
            ("mirrored", false),
            ("repair", false),
            ("missing-order", false),
        ] {
            assert_eq!(
                order_needs_ledger_restore_before_payment_decision(&conn, order_id).unwrap(),
                expected,
                "{order_id}"
            );
        }
    }

    /// A row of `GET /api/pos/payments?order_id=` as the server answers it.
    fn server_payment(
        id: &str,
        remote_order_id: &str,
        method: &str,
        amount: f64,
        status: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "order_id": remote_order_id,
            "payment_method": method,
            "amount": amount,
            "status": status,
            "currency": "EUR",
            "created_at": "2026-09-29T11:05:20Z",
            "updated_at": "2026-09-29T11:30:00Z",
        })
    }

    fn completed_local_payments(conn: &Connection, order_id: &str) -> Vec<(String, i64)> {
        let mut stmt = conn
            .prepare(
                "SELECT method, COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))
                 FROM order_payments WHERE order_id = ?1 AND status = 'completed'
                 ORDER BY created_at, id",
            )
            .unwrap();
        stmt.query_map(params![order_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[tokio::test]
    async fn the_server_ledger_is_restored_before_the_edit_decides() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            seed_order(
                &conn,
                "order-restore",
                13.0,
                "paid",
                Some("remote-order-restore"),
            );
        }

        let outcome = restore_payment_ledger_before_payment_decision_with(
            &db,
            "order-restore",
            LedgerRestoreStep::Write,
            Duration::from_secs(1),
            |remote_order_id| async move {
                assert_eq!(remote_order_id, "remote-order-restore");
                Ok(vec![server_payment(
                    "payment-restored",
                    &remote_order_id,
                    "card",
                    13.0,
                    "completed",
                )])
            },
        )
        .await;
        assert_eq!(outcome, LedgerRestoreOutcome::Restored(1));

        let conn = db.conn.lock().unwrap();
        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("order-restore", 13.0, Some("to go")),
            EditSettlementActionPayload::None,
            "2026-09-29T14:31:00Z",
        )
        .expect("apply edit after restore");
        assert_eq!(response["paymentStatus"], "paid");
        let push = queued_order_push(&conn, "order-restore");
        assert_eq!(push["paymentStatus"], "paid");
        assert_eq!(
            push["paymentMethod"], "card",
            "the tender comes from the restored row, as recorded"
        );
    }

    #[tokio::test]
    async fn an_unreachable_or_slow_server_leaves_the_proven_status_in_place() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            seed_order(
                &conn,
                "order-offline",
                7.0,
                "paid",
                Some("remote-order-offline"),
            );
            seed_order(&conn, "order-slow", 7.0, "paid", Some("remote-order-slow"));
            seed_order(
                &conn,
                "order-unpaid-check",
                7.0,
                "pending",
                Some("remote-unpaid-check"),
            );
        }

        let failed = restore_payment_ledger_before_payment_decision_with(
            &db,
            "order-offline",
            LedgerRestoreStep::Write,
            Duration::from_secs(1),
            |_| async { Err::<Vec<serde_json::Value>, String>("network unreachable".to_string()) },
        )
        .await;
        assert_eq!(
            failed,
            LedgerRestoreOutcome::Failed("network unreachable".to_string())
        );

        let timed_out = restore_payment_ledger_before_payment_decision_with(
            &db,
            "order-slow",
            LedgerRestoreStep::Write,
            Duration::from_millis(20),
            |_| async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok::<Vec<serde_json::Value>, String>(Vec::new())
            },
        )
        .await;
        assert_eq!(timed_out, LedgerRestoreOutcome::TimedOut);

        let mut restore_called = false;
        let not_needed = restore_payment_ledger_before_payment_decision_with(
            &db,
            "order-unpaid-check",
            LedgerRestoreStep::Write,
            Duration::from_secs(1),
            |_| {
                restore_called = true;
                async { Ok::<Vec<serde_json::Value>, String>(Vec::new()) }
            },
        )
        .await;
        assert_eq!(not_needed, LedgerRestoreOutcome::NotNeeded);
        assert!(
            !restore_called,
            "an order that claims no money is never fetched"
        );

        let conn = db.conn.lock().unwrap();
        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("order-offline", 7.0, Some("offline edit")),
            EditSettlementActionPayload::None,
            "2026-09-29T15:00:00Z",
        )
        .expect("offline edit");
        assert_eq!(response["paymentStatus"], "paid");
        assert_eq!(
            queued_order_push(&conn, "order-offline")["paymentStatus"],
            "paid"
        );
    }

    /// Review of the 29/09/2026 fixes (probe ported): shrinking a paid order
    /// whose local payment rows are missing (offline, or the restore timed
    /// out) demanded a refund of money no local row held — the refund picker
    /// had no payment to refund against and the edit could not be saved.
    #[test]
    fn a_shrunk_paid_order_whose_rows_are_missing_saves_without_a_refund() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(&conn, "o-shrink", 10.0, "paid", Some("remote-o-shrink"));

        let preview =
            preview_edit_settlement_in_connection(&conn, &edit_payload("o-shrink", 8.0, None))
                .expect("preview");
        assert_eq!(preview["requiredAction"], "none", "{preview}");
        assert_eq!(preview["refundAmount"], 0.0, "{preview}");
        assert_eq!(preview["paidTotal"], 10.0, "the proven money still counts");
        assert_eq!(preview["ledgerPaidTotal"], 0.0);
        assert_eq!(
            preview["completedPayments"].as_array().map(Vec::len),
            Some(0)
        );

        // A refund cannot be asked of rows that do not exist.
        let refund: EditSettlementActionPayload = serde_json::from_value(serde_json::json!({
            "type": "refund",
            "refunds": [{ "paymentId": "no-such-payment", "amount": 2.0, "reason": "probe", "refundMethod": "cash" }],
        }))
        .unwrap();
        let error = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("o-shrink", 8.0, None),
            refund,
            "2026-09-29T12:00:00Z",
        )
        .expect_err("nothing to refund locally");
        assert!(
            error.contains("must match the overpaid amount 0.00"),
            "{error}"
        );

        // The save goes through and the order stays paid; the server ledger
        // settles the missing money later.
        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("o-shrink", 8.0, None),
            EditSettlementActionPayload::None,
            "2026-09-29T12:01:00Z",
        )
        .expect("the shrunk order saves");
        assert_eq!(response["paymentStatus"], "paid", "{response}");
        assert_eq!(response["requiredAction"], "none", "{response}");
        assert_eq!(stored_payment_status(&conn, "o-shrink"), "paid");
        assert_eq!(
            queued_order_push(&conn, "o-shrink")["paymentStatus"],
            "paid"
        );
    }

    /// When the local rows do hold more than the new total, the refund is the
    /// money THEY hold beyond it — never the proven-but-missing money.
    #[test]
    fn a_refund_is_only_asked_of_the_money_the_local_rows_hold() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // Paid 15.00; this terminal holds a 10.00 card row, 5.00 is missing.
        seed_order(&conn, "o-mixed", 15.0, "paid", Some("remote-o-mixed"));
        insert_completed_payment(&conn, "pay-mixed-card", "o-mixed", "card", 10.0);

        let preview =
            preview_edit_settlement_in_connection(&conn, &edit_payload("o-mixed", 8.0, None))
                .expect("preview");
        assert_eq!(preview["requiredAction"], "refund", "{preview}");
        assert_eq!(preview["refundAmount"], 2.0, "{preview}");
        assert_eq!(preview["paidTotal"], 15.0);
        assert_eq!(preview["ledgerPaidTotal"], 10.0);

        // The pre-fix amount (everything proven minus the new total) is refused.
        let refund = |amount: f64| -> EditSettlementActionPayload {
            serde_json::from_value(serde_json::json!({
                "type": "refund",
                "refunds": [{ "paymentId": "pay-mixed-card", "amount": amount, "reason": "edit", "refundMethod": "card" }],
            }))
            .unwrap()
        };
        let error = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("o-mixed", 8.0, None),
            refund(7.0),
            "2026-09-29T12:10:00Z",
        )
        .expect_err("the missing money is not refunded here");
        assert!(error.contains("overpaid amount 2.00"), "{error}");

        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("o-mixed", 8.0, None),
            refund(2.0),
            "2026-09-29T12:11:00Z",
        )
        .expect("refund what the local rows hold");
        assert_eq!(response["paymentStatus"], "paid", "{response}");
        assert_eq!(response["requiredAction"], "none", "{response}");
    }

    /// Review of the 29/09/2026 fixes (probe ported): the restore reused the
    /// payment mirror, which ignored the server row's `status` and inserted a
    /// payment another terminal had VOIDED as completed money.
    #[tokio::test]
    async fn a_voided_server_payment_is_never_restored_as_collected_money() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            seed_order(&conn, "o-voided", 10.0, "paid", Some("remote-o-voided"));
        }

        let outcome = restore_payment_ledger_before_payment_decision_with(
            &db,
            "o-voided",
            LedgerRestoreStep::Preview,
            Duration::from_secs(2),
            |remote_order_id| async move {
                Ok(vec![
                    server_payment(
                        "remote-pay-voided",
                        &remote_order_id,
                        "card",
                        10.0,
                        "voided",
                    ),
                    server_payment(
                        "remote-pay-refunded",
                        &remote_order_id,
                        "cash",
                        10.0,
                        "refunded",
                    ),
                ])
            },
        )
        .await;
        assert_eq!(outcome, LedgerRestoreOutcome::NothingToRestore);

        let conn = db.conn.lock().unwrap();
        assert!(
            completed_local_payments(&conn, "o-voided").is_empty(),
            "voided or refunded server money is not money in hand"
        );
        let preview =
            preview_edit_settlement_in_connection(&conn, &edit_payload("o-voided", 12.0, None))
                .expect("preview");
        assert_eq!(preview["ledgerPaidTotal"], 0.0, "{preview}");
        assert_eq!(stored_payment_status(&conn, "o-voided"), "paid");
        drop(conn);
        forget_ledger_restores_for_tests();
    }

    /// The real restore path keeps the label the order proved even when the
    /// server holds only part of the money, and the edit then decides on the
    /// restored rows plus the proven remainder.
    #[tokio::test]
    async fn a_partial_server_ledger_never_lowers_the_proven_label_before_an_edit() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            seed_order(&conn, "o-partial", 13.0, "paid", Some("remote-o-partial"));
        }

        let outcome = restore_payment_ledger_before_payment_decision_with(
            &db,
            "o-partial",
            LedgerRestoreStep::Write,
            Duration::from_secs(2),
            |remote_order_id| async move {
                Ok(vec![server_payment(
                    "remote-pay-partial",
                    &remote_order_id,
                    "cash",
                    5.0,
                    "completed",
                )])
            },
        )
        .await;
        assert_eq!(outcome, LedgerRestoreOutcome::Restored(1));

        let conn = db.conn.lock().unwrap();
        assert_eq!(
            stored_payment_status(&conn, "o-partial"),
            "paid",
            "the mirror's recompute read partially_paid; the proven label stays"
        );
        assert_eq!(
            completed_local_payments(&conn, "o-partial"),
            vec![("cash".to_string(), 500)]
        );
        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("o-partial", 13.0, Some("no onions")),
            EditSettlementActionPayload::None,
            "2026-09-29T14:40:00Z",
        )
        .expect("apply edit");
        assert_eq!(response["paymentStatus"], "paid", "{response}");
        assert_eq!(response["requiredAction"], "none", "{response}");
        assert_eq!(
            queued_order_push(&conn, "o-partial")["paymentStatus"],
            "paid"
        );
    }

    /// Review of the 29/09/2026 fixes: the 4 s bound was soft (the DB lock
    /// and credential reads ran inside the timed future) and the preview and
    /// the save each waited on the server. Only the fetch is timed now, the
    /// DB is free while it runs, and the save reuses the preview's attempt.
    #[tokio::test]
    async fn one_server_check_serves_the_preview_and_the_save_of_an_edit() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            seed_order(&conn, "o-shared", 7.0, "paid", Some("remote-o-shared"));
        }

        let db_ref = &db;
        let preview = restore_payment_ledger_before_payment_decision_with(
            db_ref,
            "o-shared",
            LedgerRestoreStep::Preview,
            Duration::from_millis(50),
            |_| async move {
                assert!(
                    db_ref.conn.try_lock().is_ok(),
                    "no DB lock is held while the server is asked"
                );
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok::<Vec<serde_json::Value>, String>(Vec::new())
            },
        )
        .await;
        assert_eq!(preview, LedgerRestoreOutcome::TimedOut);

        let started = Instant::now();
        let mut asked_again = false;
        let save = restore_payment_ledger_before_payment_decision_with(
            db_ref,
            "o-shared",
            LedgerRestoreStep::Write,
            Duration::from_secs(4),
            |_| {
                asked_again = true;
                async { Ok::<Vec<serde_json::Value>, String>(Vec::new()) }
            },
        )
        .await;
        assert!(!asked_again, "the save must not ask the server again");
        assert_eq!(save, LedgerRestoreOutcome::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(1));

        // The save ended the edit: the next edit asks the server again.
        let mut asked = false;
        let next_edit = restore_payment_ledger_before_payment_decision_with(
            db_ref,
            "o-shared",
            LedgerRestoreStep::Preview,
            Duration::from_secs(1),
            |_| {
                asked = true;
                async { Ok::<Vec<serde_json::Value>, String>(Vec::new()) }
            },
        )
        .await;
        assert!(asked);
        assert_eq!(next_edit, LedgerRestoreOutcome::NothingToRestore);
        forget_ledger_restores_for_tests();
    }

    /// Review of the 29/09/2026 fixes: a comp (zero total) the order had
    /// settled read `pending` after any edit — no money to count — and that
    /// was pushed.
    #[test]
    fn a_comped_order_stays_paid_through_an_edit() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(&conn, "o-comp", 0.0, "paid", Some("remote-o-comp"));

        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("o-comp", 0.0, Some("on the house")),
            EditSettlementActionPayload::None,
            "2026-09-29T16:00:00Z",
        )
        .expect("edit the comp");
        assert_eq!(response["paymentStatus"], "paid", "{response}");
        assert_eq!(stored_payment_status(&conn, "o-comp"), "paid");
        assert_eq!(queued_order_push(&conn, "o-comp")["paymentStatus"], "paid");

        let payload: OrderUpdateFinancialsPayload = serde_json::from_value(serde_json::json!({
            "orderId": "o-comp",
            "totalAmount": 0.0,
            "subtotal": 0.0,
        }))
        .unwrap();
        let (response, _) =
            update_order_financials_in_connection(&conn, &payload, "2026-09-29T16:05:00Z")
                .expect("update financials");
        assert_eq!(response["paymentStatus"], "paid", "{response}");

        // A zero-total order nobody settled is not turned into a paid one.
        seed_order(&conn, "o-zero-pending", 0.0, "pending", Some("remote-zero"));
        let (response, _) = apply_edit_settlement_in_connection(
            &conn,
            &edit_payload("o-zero-pending", 0.0, None),
            EditSettlementActionPayload::None,
            "2026-09-29T16:10:00Z",
        )
        .expect("edit the zero order");
        assert_eq!(response["paymentStatus"], "pending", "{response}");
    }
}
