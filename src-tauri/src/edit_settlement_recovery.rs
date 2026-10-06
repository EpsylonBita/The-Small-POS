//! A local edit and its payment/refund have one immutable, scoped receipt.
//! Replaying an IPC reply never asks the operator to collect the delta again.
use crate::{db, table_session_cache};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

fn amount(value: &Value, key: &str) -> Result<i64, String> {
    let value = match value.get(key).filter(|v| !v.is_null()) {
        None => 0.0,
        Some(v) => v
            .as_f64()
            .or_else(|| v.as_str()?.parse().ok())
            .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?,
    };
    if !value.is_finite() {
        return Err("EDIT_CANONICAL_SNAPSHOT_INVALID".into());
    }
    Ok(crate::money::Cents::round_half_even(value).as_i64())
}

fn text_alias(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
}

// Canonical API removes _meta and renderer hydration decorates ingredient
// cache rows. Preserve every selection field and unknown ingredient field;
// only established catalogue/display decoration is irrelevant to the receipt.
fn customizations(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("_meta");
    }
    let selections: Option<Vec<Value>> = match &value {
        Value::Array(rows) => Some(rows.clone()),
        Value::Object(rows)
            if rows.values().all(|row| {
                row.pointer("/ingredient/id")
                    .and_then(Value::as_str)
                    .is_some()
            }) =>
        {
            Some(rows.values().cloned().collect())
        }
        _ => None,
    };
    if let Some(mut rows) = selections {
        if rows.iter().all(|row| {
            row.pointer("/ingredient/id")
                .and_then(Value::as_str)
                .is_some()
        }) {
            for row in &mut rows {
                if let Some(ingredient) = row.get_mut("ingredient").and_then(Value::as_object_mut) {
                    for key in [
                        "name",
                        "name_en",
                        "name_el",
                        "name_de",
                        "name_fr",
                        "name_it",
                        "name_sq",
                        "description",
                        "category_id",
                        "category_name",
                        "allergens",
                        "cost",
                        "delivery_price",
                        "pickup_price",
                        "dine_in_price",
                        "instore_price",
                        "display_order",
                        "flavor_type",
                        "is_available",
                        "item_color",
                        "min_stock_level",
                        "stock_quantity",
                        "updated_at",
                    ] {
                        ingredient.remove(key);
                    }
                }
            }
            rows.sort_by(|a, b| {
                a.pointer("/ingredient/id")
                    .and_then(Value::as_str)
                    .cmp(&b.pointer("/ingredient/id").and_then(Value::as_str))
            });
            value = Value::Array(rows);
        }
    }
    if value.is_null()
        || value.as_array().is_some_and(Vec::is_empty)
        || value.as_object().is_some_and(|v| v.is_empty())
        || value.as_str() == Some("")
    {
        Value::Null
    } else {
        value
    }
}

pub(crate) fn items(value: &Value) -> Result<Vec<Value>, String> {
    let rows = value.as_array().ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
    let mut result = Vec::new();
    for item in rows {
        let id = text_alias(
            item,
            &[
                "source_order_item_id",
                "sourceOrderItemId",
                "order_item_id",
                "orderItemId",
                "id",
            ],
        )
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or("EDIT_ORIGINAL_ITEMS_UNAVAILABLE")?;
        let quantity = item
            .get("quantity")
            .and_then(Value::as_f64)
            .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
        if !quantity.is_finite() || quantity <= 0.0 {
            return Err("EDIT_CANONICAL_SNAPSHOT_INVALID".into());
        }
        let unit = item
            .get("unit_price")
            .or_else(|| item.get("unitPrice"))
            .or_else(|| item.get("price"))
            .cloned()
            .unwrap_or(Value::Null);
        let unit_cents = amount(&json!({"unit":unit}), "unit")?;
        let custom = item
            .get("customizations")
            .or_else(|| item.get("modifiers"))
            .cloned()
            .unwrap_or(Value::Null);
        let custom = match custom {
            Value::String(raw) => serde_json::from_str::<Value>(&raw).unwrap_or(Value::String(raw)),
            other => other,
        };
        let custom = customizations(custom);
        result.push(json!({"id":id,"menu":text_alias(item,&["menu_item_id","menuItemId"]),
            "retail":text_alias(item,&["retail_product_id","retailProductId"]),"quantity":quantity,"unitCents":unit_cents,
            "totalCents":amount(&json!({"line":item.get("total_price").or_else(||item.get("totalPrice")).cloned().unwrap_or(json!((unit_cents as f64 / 100.0)*quantity))}),"line")?,
            "originalUnitCents":amount(&json!({"unit":item.get("original_unit_price").or_else(||item.get("originalUnitPrice")).filter(|v|!v.is_null()).cloned().unwrap_or(unit.clone())}),"unit")?,
            "name":text_alias(item,&["name","menu_item_name","menuItemName"]),"notes":text_alias(item,&["notes"]),"customizations":custom,
            "overridden":item.get("is_price_overridden").or_else(||item.get("isPriceOverridden")).and_then(Value::as_bool).unwrap_or(false)}));
    }
    result.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    if result.windows(2).any(|pair| pair[0]["id"] == pair[1]["id"]) {
        return Err("EDIT_CANONICAL_SNAPSHOT_INVALID".into());
    }
    Ok(result)
}

pub(crate) const EDIT_HEADER_FIELDS: &[(&str, &str)] = &[
    ("orderType", "order_type"),
    ("customerId", "customer_id"),
    ("customerName", "customer_name"),
    ("customerPhone", "customer_phone"),
    ("customerEmail", "customer_email"),
    ("deliveryAddress", "delivery_address"),
    ("deliveryAddressId", "delivery_address_id"),
    ("deliveryCity", "delivery_city"),
    ("deliveryPostalCode", "delivery_postal_code"),
    ("deliveryFloor", "delivery_floor"),
    ("deliveryNotes", "delivery_notes"),
    ("nameOnRinger", "name_on_ringer"),
    ("deliveryLatitude", "delivery_latitude"),
    ("deliveryLongitude", "delivery_longitude"),
    ("deliveryAddressFingerprint", "delivery_address_fingerprint"),
    ("deliveryZoneId", "delivery_zone_id"),
    ("tableNumber", "table_number"),
    ("driverId", "driver_id"),
    ("driverName", "driver_name"),
];
pub(crate) fn capture_order_headers(conn: &Connection, order: &str) -> Result<Value, String> {
    let fields = EDIT_HEADER_FIELDS
        .iter()
        .map(|(_, column)| format!("'{column}',{column}"))
        .collect::<Vec<_>>()
        .join(",");
    let raw: String = conn
        .query_row(
            &format!("SELECT json_object({fields}) FROM orders WHERE id=?1"),
            [order],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}
fn same_header_value(left: &Value, right: &Value) -> bool {
    if left.is_null() || left.as_str() == Some("") {
        right.is_null() || right.as_str() == Some("")
    } else {
        left == right
    }
}

/// The local revision and canonical wire revision are independent. Capture the
/// complete original before waiting on the fresh remote snapshot, never the cart.
pub(crate) fn capture_preflight(conn: &Connection, order: &str) -> Result<Value, String> {
    let mut original:Value=conn.query_row("SELECT supabase_id,organization_id,branch_id,COALESCE(version,1),status,order_type,currency,total_amount,subtotal,discount_amount,tax_amount,delivery_fee,tip_amount,items,special_instructions,sync_status,notes,table_id,table_session_id,folio_charged,order_context,payment_status FROM orders WHERE id=?1",[order],|row|
        Ok(json!({"id":row.get::<_,Option<String>>(0)?,"organization_id":row.get::<_,Option<String>>(1)?,"branch_id":row.get::<_,Option<String>>(2)?,
            "localVersion":row.get::<_,i64>(3)?,"status":row.get::<_,String>(4)?,"order_type":row.get::<_,Option<String>>(5)?,"currency":row.get::<_,Option<String>>(6)?,
            "total_amount":row.get::<_,f64>(7)?,"subtotal":row.get::<_,Option<f64>>(8)?,"discount_amount":row.get::<_,Option<f64>>(9)?,
            "tax_amount":row.get::<_,Option<f64>>(10)?,"delivery_fee":row.get::<_,Option<f64>>(11)?,"tip_amount":row.get::<_,Option<f64>>(12)?,
            "itemsRaw":row.get::<_,String>(13)?,"special_instructions":row.get::<_,Option<String>>(14)?,"sync_status":row.get::<_,String>(15)?,"notes":row.get::<_,Option<String>>(16)?,"table_id":row.get::<_,Option<String>>(17)?,"table_session_id":row.get::<_,Option<String>>(18)?,"folio_charged":row.get::<_,Option<bool>>(19)?,"order_context":row.get::<_,Option<String>>(20)?,"payment_status":row.get::<_,Option<String>>(21)?})))
        .map_err(|error|error.to_string())?;
    if original["sync_status"] != "synced"
        || original["id"]
            .as_str()
            .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err("EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED".into());
    }
    let pending:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM parity_sync_queue WHERE table_name='orders' AND record_id=?1 AND status NOT IN ('completed','synced'))",[order],|row|row.get(0)).map_err(|error|error.to_string())?;
    if pending {
        return Err("EDIT_PREVIOUS_SETTLEMENT_SYNC_REQUIRED".into());
    }
    original["headers"] = capture_order_headers(conn, order)?;
    original["items"] = serde_json::from_str(original["itemsRaw"].as_str().unwrap())
        .map_err(|_| "EDIT_ORIGINAL_ITEMS_UNAVAILABLE")?;
    original.as_object_mut().unwrap().remove("itemsRaw");
    let mut statement=conn.prepare("SELECT remote_payment_id,method,COALESCE(amount_cents,CAST(ROUND(amount*100) AS INTEGER)),COALESCE(tip_amount_cents,CAST(ROUND(tip_amount*100) AS INTEGER),0),currency,status,COALESCE((SELECT SUM(COALESCE(a.amount_cents,CAST(ROUND(a.amount*100) AS INTEGER))) FROM payment_adjustments a WHERE a.payment_id=p.id AND a.adjustment_type IN ('refund','void')),0) FROM order_payments p WHERE order_id=?1 AND status IN ('completed','refunded') ORDER BY remote_payment_id").map_err(|error|error.to_string())?;
    let rows=statement.query_map([order],|row|Ok(json!({"id":row.get::<_,Option<String>>(0)?,"method":row.get::<_,String>(1)?,"amountCents":row.get::<_,i64>(2)?,"tipCents":row.get::<_,i64>(3)?,"currency":row.get::<_,String>(4)?,"returnedCents":row.get::<_,i64>(6)?}))).map_err(|error|error.to_string())?;
    original["payments"] = Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?,
    );
    original["paidCents"] = json!(crate::money::Cents::round_half_even(
        crate::payments::load_principal_paid_for_order(conn, order)?
    )
    .as_i64());
    Ok(original)
}

pub(crate) fn remember_canonical_preflight(
    conn: &Connection,
    order: &str,
    event: &str,
    before: &Value,
    remote: &Value,
) -> Result<(i64, i64), String> {
    let scope = table_session_cache::current_scope(conn)?;
    if capture_preflight(conn, order)? != *before {
        return Err("EDIT_SETTLEMENT_VERSION_CHANGED".into());
    }
    if matches!(
        before["payment_status"].as_str(),
        Some("paid" | "completed")
    ) && before["paidCents"].as_i64().unwrap_or(0) < amount(before, "total_amount")?
    {
        return Err("EDIT_ORIGINAL_PAYMENT_SYNC_REQUIRED".into());
    }
    let canonical = &remote["order"];
    let version = canonical["version"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
    if canonical["id"] != before["id"]
        || canonical["organization_id"] != scope.organization
        || canonical["branch_id"] != scope.branch
        || before["organization_id"] != scope.organization
        || before["branch_id"] != scope.branch
    {
        return Err("EDIT_SETTLEMENT_SCOPE_MISMATCH".into());
    }
    if text_alias(canonical, &["table_id", "table_session_id"]).is_some()
        || canonical["has_table_service_history"].as_bool() == Some(true)
        || canonical["folio_charged"].as_bool() == Some(true)
        || canonical["order_context"] == "repair_settlement"
        || matches!(
            canonical["order_type"].as_str(),
            Some("dine-in" | "dine_in" | "table")
        )
    {
        return Err("TABLE_EDIT_SCOPED_SETTLEMENT_REQUIRED".into());
    }
    if EDIT_HEADER_FIELDS
        .iter()
        .any(|(_, column)| !same_header_value(&before["headers"][*column], &canonical[*column]))
    {
        return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
    }
    if text_alias(canonical, &["notes"]) != text_alias(before, &["notes"]) {
        return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
    }
    if canonical["status"] != before["status"]
        || canonical["order_type"] != before["order_type"]
        || text_alias(canonical, &["special_instructions"])
            != text_alias(before, &["special_instructions"])
        || items(&canonical["items"])? != items(&before["items"])?
    {
        return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
    }
    for field in [
        "total_amount",
        "subtotal",
        "discount_amount",
        "tax_amount",
        "delivery_fee",
        "tip_amount",
    ] {
        if amount(canonical, field)? != amount(before, field)? {
            return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
        }
    }
    if canonical["currency"]
        .as_str()
        .zip(before["currency"].as_str())
        .is_some_and(|(a, b)| a != b)
    {
        return Err("PAYMENT_CURRENCY_MISMATCH".into());
    }
    if remote["retained_paid_cents"].as_i64() != before["paidCents"].as_i64() {
        return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
    }
    let adjustments = remote["adjustments"]
        .as_array()
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
    for adjustment in adjustments {
        if adjustment["organization_id"] != scope.organization
            || adjustment["branch_id"] != scope.branch
            || adjustment["order_id"] != canonical["id"]
        {
            return Err("EDIT_SETTLEMENT_SCOPE_MISMATCH".into());
        }
        if !matches!(
            adjustment["adjustment_type"].as_str(),
            Some("refund" | "void")
        ) || !remote["payments"]
            .as_array()
            .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?
            .iter()
            .any(|p| p["id"] == adjustment["payment_id"])
        {
            return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
        }
    }
    let mut payments = Vec::new();
    for payment in remote["payments"]
        .as_array()
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?
    {
        if payment["status"] == "voided" {
            continue;
        }
        if !matches!(payment["status"].as_str(), Some("completed" | "refunded")) {
            return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
        }
        if canonical["currency"]
            .as_str()
            .is_some_and(|unit| payment["currency"].as_str() != Some(unit))
        {
            return Err("PAYMENT_CURRENCY_MISMATCH".into());
        }
        let metadata = &payment["metadata"];
        let origin = text_alias(metadata, &["payment_origin", "paymentOrigin"])
            .unwrap_or_else(|| "manual".into());
        let device =
            text_alias(metadata, &["terminal_device_id", "terminalDeviceId"]).unwrap_or_default();
        let reference = text_alias(payment, &["external_transaction_id"]).unwrap_or_default();
        let protected = [
            "provider",
            "terminal_reference",
            "terminalReference",
            "ecr_terminal_reference",
            "terminalTransactionId",
        ]
        .iter()
        .any(|key| {
            metadata
                .get(key)
                .is_some_and(|v| !v.is_null() && v.as_str() != Some(""))
        }) || ["terminal_processed", "terminalProcessed"]
            .iter()
            .any(|key| {
                metadata
                    .get(key)
                    .is_some_and(|v| v.as_bool() == Some(true) || v.as_str() == Some("true"))
            });
        if !crate::manual_order_cancellation::original_is_manual(
            payment["payment_method"].as_str().unwrap_or(""),
            &origin,
            &device,
            &reference,
        ) || protected
        {
            return Err("EDIT_ORIGINAL_PROVIDER_REFUND_REQUIRED".into());
        }
        if payment["organization_id"] != scope.organization
            || payment["branch_id"] != scope.branch
            || payment["order_id"] != canonical["id"]
        {
            return Err("EDIT_SETTLEMENT_SCOPE_MISMATCH".into());
        }
        let mut returned = 0;
        for adjustment in adjustments.iter().filter(|a| {
            a["payment_id"] == payment["id"]
                && matches!(a["adjustment_type"].as_str(), Some("refund" | "void"))
        }) {
            if adjustment["organization_id"] != scope.organization
                || adjustment["branch_id"] != scope.branch
                || adjustment["order_id"] != canonical["id"]
            {
                return Err("EDIT_SETTLEMENT_SCOPE_MISMATCH".into());
            }
            returned += adjustment["amount_cents"]
                .as_i64()
                .map(Ok)
                .unwrap_or_else(|| amount(adjustment, "amount"))?;
        }
        payments.push(json!({"id":payment["id"],"method":payment["payment_method"],
            "amountCents":payment["amount_cents"].as_i64().map(Ok).unwrap_or_else(||amount(payment,"amount"))?,
            "tipCents":payment["tip_amount_cents"].as_i64().map(Ok).unwrap_or_else(||amount(payment,"tip_amount"))?,
            "currency":payment["currency"],"returnedCents":returned}));
    }
    payments.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    if Value::Array(payments) != before["payments"] {
        return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
    }
    let local = before["localVersion"]
        .as_i64()
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
    db::set_setting(conn,"edit_settlement_preflight_v1",&format!("{}:{}:{}:{event}",scope.organization,scope.branch,scope.terminal),
        &json!({"orderId":order,"canonicalVersion":version,"localVersion":local,"original":before,"canonicalOrderId":canonical["id"],"fulfillmentRepricing":remote["fulfillment_repricing"]}).to_string())?;
    Ok((version, local))
}

pub(crate) fn require_canonical_preflight(
    conn: &Connection,
    order: &str,
    event: &str,
    version: i64,
    local: i64,
) -> Result<(), String> {
    let scope = table_session_cache::current_scope(conn)?;
    let raw = db::get_setting(
        conn,
        "edit_settlement_preflight_v1",
        &format!(
            "{}:{}:{}:{event}",
            scope.organization, scope.branch, scope.terminal
        ),
    )
    .ok_or("EDIT_CANONICAL_PREFLIGHT_REQUIRED")?;
    let proof: Value =
        serde_json::from_str(&raw).map_err(|_| "EDIT_CANONICAL_PREFLIGHT_REQUIRED")?;
    if proof["orderId"] != order
        || proof["canonicalVersion"] != version
        || proof["localVersion"] != local
        || proof["original"] != capture_preflight(conn, order)?
    {
        return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
    }
    Ok(())
}

pub(crate) fn require_fulfillment_capability(
    conn: &Connection,
    order: &str,
    event: &str,
    target: Option<&str>,
) -> Result<(), String> {
    let Some(target) = target else {
        return Ok(());
    };
    let scope = table_session_cache::current_scope(conn)?;
    let raw = db::get_setting(
        conn,
        "edit_settlement_preflight_v1",
        &format!(
            "{}:{}:{}:{event}",
            scope.organization, scope.branch, scope.terminal
        ),
    )
    .ok_or("EDIT_CANONICAL_PREFLIGHT_REQUIRED")?;
    let proof: Value =
        serde_json::from_str(&raw).map_err(|_| "EDIT_CANONICAL_PREFLIGHT_REQUIRED")?;
    if proof["orderId"] != order {
        return Err("EDIT_SETTLEMENT_SCOPE_MISMATCH".into());
    }
    if proof["original"]["order_type"].as_str() != Some(target)
        && proof["fulfillmentRepricing"] != true
    {
        return Err("POS_ORDER_SETTLEMENT_UNAVAILABLE".into());
    }
    Ok(())
}

fn schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS edit_settlement_attempts_v1 (
        organization_id TEXT NOT NULL, branch_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
        client_event_id TEXT NOT NULL, order_id TEXT NOT NULL, request_json TEXT NOT NULL,
        state TEXT NOT NULL, response_json TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(organization_id,branch_id,terminal_id,client_event_id));",
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn require_original_financial_attempt(
    conn: &Connection,
    order: &str,
    key: Option<&str>,
) -> Result<(), String> {
    if crate::table_manual_cancellation::pending(conn, "")?
        .iter()
        .any(|id| id == order)
    {
        return Err("TABLE_CANCELLATION_PENDING".into());
    }
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='edit_settlement_attempts_v1')",[],|row|row.get(0)).map_err(|error|error.to_string())?;
    if !exists {
        return Ok(());
    }
    let mut statement=conn.prepare("SELECT client_event_id FROM edit_settlement_attempts_v1 WHERE order_id=?1 AND state IN ('prepared','refused')").map_err(|error|error.to_string())?;
    let rows = statement
        .query_map([order], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    for row in rows {
        let event = row.map_err(|error| error.to_string())?;
        if key.is_none_or(|key| !key.starts_with(&format!("edit:{event}:"))) {
            return Err("ORDER_EDIT_SETTLEMENT_PENDING".into());
        }
    }
    Ok(())
}

pub(crate) fn pending_financial_edits(
    conn: &Connection,
    branch: &str,
) -> Result<Vec<String>, String> {
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='edit_settlement_attempts_v1')",[],|row|row.get(0)).map_err(|error|error.to_string())?;
    if !exists {
        return Ok(Vec::new());
    }
    let mut statement=conn.prepare("SELECT DISTINCT order_id FROM edit_settlement_attempts_v1 WHERE state IN ('prepared','refused') AND (?1='' OR branch_id=?1) AND (NOT json_valid(request_json) OR json_extract(request_json,'$.action.type') IN ('collect','refund'))").map_err(|error|error.to_string())?;
    let rows = statement
        .query_map([branch], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn inspect(
    conn: &Connection,
    event: &str,
    order: &str,
) -> Result<Option<Value>, String> {
    schema(conn)?;
    let scope = table_session_cache::current_scope(conn)?;
    let row: Option<(String, String, Option<String>)> = conn.query_row(
        "SELECT request_json,state,response_json FROM edit_settlement_attempts_v1
         WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND client_event_id=?4 AND order_id=?5",
        params![scope.organization,scope.branch,scope.terminal,event,order],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).optional().map_err(|error| error.to_string())?;
    row.map(|(request,state,response)| Ok(json!({"request":serde_json::from_str::<Value>(&request).map_err(|error|error.to_string())?,
        "state":state,"response":response.map(|raw|serde_json::from_str::<Value>(&raw)).transpose().map_err(|error|error.to_string())?}))).transpose()
}

pub(crate) fn validate_target(conn: &Connection, order: &str, expected: i64) -> Result<(), String> {
    validate_versioned_target(conn, order, expected, false)
}

pub(crate) fn validate_local_target(
    conn: &Connection,
    order: &str,
    expected: i64,
) -> Result<(), String> {
    validate_versioned_target(conn, order, expected, true)
}

fn validate_versioned_target(
    conn: &Connection,
    order: &str,
    expected: i64,
    local: bool,
) -> Result<(), String> {
    let scope = table_session_cache::current_scope(conn)?;
    let (organization,branch,version,table,status):(Option<String>,String,i64,bool,String)=conn.query_row(
        "SELECT organization_id,COALESCE(branch_id,''),CASE WHEN ?2 THEN COALESCE(version,1) ELSE COALESCE(remote_version,version,1) END,
         (NULLIF(TRIM(table_id),'') IS NOT NULL OR NULLIF(TRIM(table_session_id),'') IS NOT NULL),status FROM orders WHERE id=?1",
        params![order,local],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).map_err(|error|error.to_string())?;
    if organization.as_deref() != Some(&scope.organization) || branch != scope.branch {
        return Err("EDIT_SETTLEMENT_SCOPE_MISMATCH".into());
    }
    if expected < 1 || expected != version {
        return Err("EDIT_SETTLEMENT_VERSION_CHANGED".into());
    }
    if table {
        return Err("TABLE_EDIT_SCOPED_SETTLEMENT_REQUIRED".into());
    }
    if matches!(status.as_str(), "cancelled" | "canceled" | "refunded") {
        return Err("EDIT_SETTLEMENT_ORDER_NOT_EDITABLE".into());
    }
    Ok(())
}

pub(crate) fn run(
    conn: &Connection,
    order: &str,
    request: &Value,
    apply: impl FnOnce(&Connection) -> Result<Value, String>,
) -> Result<Value, String> {
    let event = request
        .get("client_event_id")
        .or_else(|| request.get("clientEventId"))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty() && id.len() <= 255)
        .ok_or("EDIT_SETTLEMENT_ID_REQUIRED")?;
    let expected = request
        .get("expected_version")
        .or_else(|| request.get("expectedVersion"))
        .and_then(Value::as_i64)
        .ok_or("EDIT_SETTLEMENT_VERSION_REQUIRED")?;
    let scope = table_session_cache::current_scope(conn)?;
    if let Some(original) = inspect(conn, event, order)? {
        if original["request"] != *request {
            return Err("RECOVERY_ORIGINAL_REQUEST_REQUIRED".into());
        }
        if original["state"].as_str() == Some("applied") {
            return Ok(original["response"].clone());
        }
    }
    require_original_financial_attempt(conn, order, Some(&format!("edit:{event}:")))?;
    // This receipt is durable before the local transaction; a lost process can
    // replay exactly. The applied receipt commits WITH all financial writes.
    db::with_full_sync(conn, |conn| {
        conn.execute("INSERT OR IGNORE INTO edit_settlement_attempts_v1
            (organization_id,branch_id,terminal_id,client_event_id,order_id,request_json,state,created_at)
            VALUES(?1,?2,?3,?4,?5,?6,'prepared',?7)",
            params![scope.organization,scope.branch,scope.terminal,event,order,request.to_string(),chrono::Utc::now().to_rfc3339()]).map_err(|error|error.to_string())?;
        // Reusing an event for another order is never a new operation.
        let owner:String=conn.query_row("SELECT order_id FROM edit_settlement_attempts_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND client_event_id=?4",
            params![scope.organization,scope.branch,scope.terminal,event],|row|row.get(0)).map_err(|error|error.to_string())?;
        if owner != order {
            return Err("RECOVERY_ORIGINAL_REQUEST_REQUIRED".into());
        }
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        let target = match request
            .get("expected_local_version")
            .or_else(|| request.get("expectedLocalVersion"))
            .and_then(Value::as_i64)
        {
            Some(local) => validate_local_target(conn, order, local),
            None => validate_target(conn, order, expected),
        };
        let applied = target.and_then(|_| apply(conn)).and_then(|response| {
            finish(conn, &scope, event, "applied", &response)?;
            Ok(response)
        });
        match applied {
            Ok(response) => {
                conn.execute_batch("COMMIT")
                    .map_err(|error| format!("EDIT_SETTLEMENT_OUTCOME_UNKNOWN: {error}"))?;
                Ok(response)
            }
            Err(error) => {
                conn.execute_batch("ROLLBACK")
                    .map_err(|rollback| format!("EDIT_SETTLEMENT_OUTCOME_UNKNOWN: {rollback}"))?;
                // Rollback proves no new database writes, NOT that physical
                // cash/card confirmation never happened. Retain the original
                // action for an exact save retry, never authorize recollection.
                let response = json!({"success":false,"code":"EDIT_SETTLEMENT_NOT_APPLIED","error":error,
                    "clientEventId":event,"orderId":order,"transactionRolledBack":true,
                    "paymentPersisted":false,"requiresReconciliation":true});
                finish(conn, &scope, event, "refused", &response)?;
                Ok(response)
            }
        }
    })
}

fn finish(
    conn: &Connection,
    scope: &table_session_cache::Scope,
    event: &str,
    state: &str,
    response: &Value,
) -> Result<(), String> {
    conn.execute(
        "UPDATE edit_settlement_attempts_v1 SET state=?1,response_json=?2
        WHERE organization_id=?3 AND branch_id=?4 AND terminal_id=?5 AND client_event_id=?6",
        params![
            state,
            response.to_string(),
            scope.organization,
            scope.branch,
            scope.terminal,
            event
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}
