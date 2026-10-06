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
    // A 1.4.122 edit the server refused is not "still syncing": waiting will
    // not heal it, a manager must review it (fix 1).
    if legacy_edit_review_pending(conn, order)? {
        return Err(LEGACY_EDIT_REVIEW_CODE.into());
    }
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
        &json!({"orderId":order,"canonicalVersion":version,"localVersion":local,"original":before,"canonicalOrderId":canonical["id"],"fulfillmentRepricing":remote["fulfillment_repricing"],
            "methodPolicy":edit_method_policy(conn, remote)}).to_string())?;
    Ok((version, local))
}

/// The order PATCH accepts at most this many lines (`UpdateOrderStatusSchema`
/// items .max(50)), while the read-only quote accepts 500.
pub(crate) const EDIT_PATCH_MAX_LINES: i64 = 50;

fn feature_flag(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::Number(number) => match number.as_i64() {
            Some(1) => Some(true),
            Some(0) => Some(false),
            _ => None,
        },
        Value::String(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Some(true),
            "false" | "0" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// The terminal's synced feature flags, normalized like the server gate
/// (`requirePosTerminalFeature`): an explicit cash/card flag wins, otherwise
/// the legacy `payment_processing` flag, otherwise allowed; an explicit
/// `payment_processing: false` disables every tender.
fn local_method_policy(conn: &Connection) -> (bool, bool) {
    let raw = db::get_setting(conn, "terminal", "enabled_features")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let read = |snake: &str, camel: &str| {
        raw.get(snake)
            .and_then(feature_flag)
            .or_else(|| raw.get(camel).and_then(feature_flag))
    };
    let processing = read("payment_processing", "paymentProcessing");
    let cash = read("cash_payments", "cashPayments")
        .or(processing)
        .unwrap_or(true);
    let card = read("card_payments", "cardPayments")
        .or(processing)
        .unwrap_or(true);
    let disabled = processing == Some(false);
    (cash && !disabled, card && !disabled)
}

/// Which manual tenders this terminal may record for an edit difference and
/// the PATCH line limit (fix 5, 06/10/2026). The server's own gate answer in
/// the capability (`method_policy`, `max_lines`) wins; an older server
/// without it falls back to the synced terminal flags and the known limit.
pub(crate) fn edit_method_policy(conn: &Connection, capability: &Value) -> Value {
    let server = capability.get("method_policy").filter(|policy| {
        ["cash", "card", "cash_payments", "card_payments"]
            .iter()
            .any(|key| policy.get(*key).and_then(Value::as_bool).is_some())
    });
    let (cash, card, source) = match server {
        Some(policy) => {
            let flag = |primary: &str, alias: &str| {
                policy
                    .get(primary)
                    .and_then(Value::as_bool)
                    .or_else(|| policy.get(alias).and_then(Value::as_bool))
                    .unwrap_or(false)
            };
            let processing = policy
                .get("payment_processing")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            (
                processing && flag("cash", "cash_payments"),
                processing && flag("card", "card_payments"),
                "server",
            )
        }
        None => {
            let (cash, card) = local_method_policy(conn);
            (cash, card, "terminal_settings")
        }
    };
    let max_lines = capability
        .get("max_lines")
        .and_then(Value::as_i64)
        .filter(|limit| *limit > 0)
        .unwrap_or(EDIT_PATCH_MAX_LINES);
    let allowed: Vec<&str> = [("cash", cash), ("card", card)]
        .into_iter()
        .filter(|(_, allowed)| *allowed)
        .map(|(method, _)| method)
        .collect();
    json!({"cash":cash,"card":card,"allowedMethods":allowed,"maxLines":max_lines,"source":source})
}

/// The confirmed tenders and line count must fit the policy the picker was
/// gated on; the server enforces the same policy with 403 / 400 only after
/// money changed hands.
pub(crate) fn require_edit_policy(
    conn: &Connection,
    order: &str,
    event: &str,
    methods: &[String],
    lines: usize,
) -> Result<(), String> {
    let scope = table_session_cache::current_scope(conn)?;
    let policy = db::get_setting(
        conn,
        "edit_settlement_preflight_v1",
        &format!(
            "{}:{}:{}:{event}",
            scope.organization, scope.branch, scope.terminal
        ),
    )
    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    .filter(|proof| proof["orderId"] == order)
    .map(|proof| proof["methodPolicy"].clone())
    .filter(Value::is_object)
    .unwrap_or_else(|| edit_method_policy(conn, &Value::Null));
    if lines as i64 > policy["maxLines"].as_i64().unwrap_or(EDIT_PATCH_MAX_LINES) {
        return Err("EDIT_TOO_MANY_LINES".into());
    }
    if methods
        .iter()
        .any(|method| policy.get(method.as_str()).and_then(Value::as_bool) != Some(true))
    {
        return Err("EDIT_SETTLEMENT_METHOD_UNAVAILABLE".into());
    }
    Ok(())
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
    require_original_financial_attempt_superseding(conn, order, key, &[])
}

/// The same fence, except that a NEW edit may name earlier attempts it
/// replaces. Only an attempt proven never applied can be replaced (fix 4,
/// 06/10/2026): its declared money was not recorded anywhere, so the new
/// event records it once instead. Anything else still holds the order.
pub(crate) fn require_original_financial_attempt_superseding(
    conn: &Connection,
    order: &str,
    key: Option<&str>,
    supersedes: &[String],
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
    // A refused attempt that confirmed no money (`none`) cannot hide a tender;
    // it never holds the order. A prepared one may still be in its commit.
    let mut statement=conn.prepare("SELECT client_event_id FROM edit_settlement_attempts_v1 WHERE order_id=?1
        AND (state='prepared' OR (state='refused' AND (NOT json_valid(request_json) OR COALESCE(json_extract(request_json,'$.action.type'),'')<>'none')))").map_err(|error|error.to_string())?;
    let rows = statement
        .query_map([order], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    for event in rows {
        if key.is_some_and(|key| key.starts_with(&format!("edit:{event}:"))) {
            continue;
        }
        if supersedes.iter().any(|replaced| replaced == &event)
            && proven_not_applied(conn, order, &event)?
        {
            continue;
        }
        return Err("ORDER_EDIT_SETTLEMENT_PENDING".into());
    }
    Ok(())
}

/// An attempt that can be replaced or reconciled: its journal never reached
/// `applied` and nothing carries its identity. The applied state commits in
/// the same SQLite transaction as every financial write and outbox row, so a
/// `prepared` journal read under the connection lock is a crashed attempt.
pub(crate) fn proven_not_applied(
    conn: &Connection,
    order: &str,
    event: &str,
) -> Result<bool, String> {
    let Some(journal) = inspect(conn, event, order)? else {
        return Ok(false);
    };
    if !matches!(journal["state"].as_str(), Some("prepared" | "refused")) {
        return Ok(false);
    }
    let key = format!("edit:{event}:%");
    let carried:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM order_payments WHERE idempotency_key LIKE ?1)
        OR EXISTS(SELECT 1 FROM payment_adjustments WHERE idempotency_key LIKE ?1)
        OR EXISTS(SELECT 1 FROM parity_sync_queue WHERE json_valid(data) AND (COALESCE(json_extract(data,'$.client_event_id'),'')=?2
            OR COALESCE(json_extract(data,'$.parentEditEventId'),'')=?2))",params![key,event],|row|row.get(0)).map_err(|error|error.to_string())?;
    Ok(!carried)
}

fn supersede_unapplied(
    conn: &Connection,
    scope: &table_session_cache::Scope,
    order: &str,
    supersedes: &[String],
    event: &str,
) -> Result<(), String> {
    for replaced in supersedes
        .iter()
        .filter(|replaced| replaced.as_str() != event)
    {
        if !proven_not_applied(conn, order, replaced)? {
            return Err("ORDER_EDIT_SETTLEMENT_PENDING".into());
        }
        conn.execute("UPDATE edit_settlement_attempts_v1 SET state='superseded',
            response_json=json_set(CASE WHEN json_valid(response_json) THEN response_json ELSE '{}' END,'$.supersededBy',?1,'$.supersededAt',?2)
            WHERE organization_id=?3 AND branch_id=?4 AND terminal_id=?5 AND client_event_id=?6 AND order_id=?7 AND state IN ('prepared','refused')",
            params![event,chrono::Utc::now().to_rfc3339(),scope.organization,scope.branch,scope.terminal,replaced,order]).map_err(|error|error.to_string())?;
    }
    Ok(())
}

/// Requested replacements of earlier attempts, from the confirmed request.
pub(crate) fn superseded_events(request: &Value) -> Vec<String> {
    let mut events: Vec<String> = Vec::new();
    for key in ["supersedes_client_event_id", "supersedesClientEventId"] {
        match request.get(key) {
            Some(Value::String(event)) if !event.trim().is_empty() => {
                events.push(event.trim().to_string())
            }
            Some(Value::Array(rows)) => events.extend(
                rows.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|event| !event.is_empty())
                    .map(str::to_string),
            ),
            _ => {}
        }
    }
    events.sort();
    events.dedup();
    events
}

/// A manager closes an attempt that can never apply without recording money
/// (fix 5, 06/10/2026). Nothing is charged, returned or rewritten: the
/// original evidence stays in the journal and an audit row names who decided.
/// The drawer count then shows any physical difference.
pub(crate) fn reconcile_unapplied(
    conn: &Connection,
    order: &str,
    event: &str,
    approval: &Value,
    reason: &str,
) -> Result<Value, String> {
    schema(conn)?;
    let scope = table_session_cache::current_scope(conn)?;
    let reason = reason.trim();
    if reason.is_empty() || reason.len() > 500 {
        return Err("EDIT_RECONCILIATION_REASON_REQUIRED".into());
    }
    let journal = inspect(conn, event, order)?.ok_or("RECOVERY_ORIGINAL_REQUEST_REQUIRED")?;
    if journal["state"] == "reconciled" {
        return Ok(
            json!({"success":true,"state":"reconciled","clientEventId":event,"orderId":order,"replayed":true}),
        );
    }
    if !proven_not_applied(conn, order, event)? {
        return Err("EDIT_RECONCILIATION_NOT_PROVEN".into());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let audit = json!({"decision":"closed_without_money","reason":reason,"approval":approval,"at":now,
        "previousState":journal["state"],"charged":false});
    db::with_full_sync(conn, |conn| {
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS edit_settlement_reconciliations_v1 (
                organization_id TEXT NOT NULL, branch_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
                client_event_id TEXT NOT NULL, order_id TEXT NOT NULL, request_json TEXT NOT NULL,
                previous_response_json TEXT, audit_json TEXT NOT NULL, created_at TEXT NOT NULL,
                PRIMARY KEY(organization_id,branch_id,terminal_id,client_event_id));",
            )
            .map_err(|error| error.to_string())?;
            let changed=conn.execute("UPDATE edit_settlement_attempts_v1 SET state='reconciled',
                response_json=json_set(CASE WHEN json_valid(response_json) THEN response_json ELSE '{}' END,'$.reconciliation',json(?1))
                WHERE organization_id=?2 AND branch_id=?3 AND terminal_id=?4 AND client_event_id=?5 AND order_id=?6 AND state IN ('prepared','refused')",
                params![audit.to_string(),scope.organization,scope.branch,scope.terminal,event,order]).map_err(|error|error.to_string())?;
            if changed != 1 {
                return Err("EDIT_RECONCILIATION_NOT_PROVEN".into());
            }
            conn.execute(
                "INSERT INTO edit_settlement_reconciliations_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    scope.organization,
                    scope.branch,
                    scope.terminal,
                    event,
                    order,
                    journal["request"].to_string(),
                    journal["response"].to_string(),
                    audit.to_string(),
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => conn
                .execute_batch("COMMIT")
                .map_err(|error| error.to_string()),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })?;
    Ok(
        json!({"success":true,"state":"reconciled","clientEventId":event,"orderId":order,"audit":audit}),
    )
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
    admission: impl FnOnce(&Connection) -> Result<(), String>,
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
    schema(conn)?;
    let scope = table_session_cache::current_scope(conn)?;
    if let Some(original) = inspect(conn, event, order)? {
        if original["request"] != *request {
            return Err("RECOVERY_ORIGINAL_REQUEST_REQUIRED".into());
        }
        match original["state"].as_str() {
            Some("applied") => return Ok(original["response"].clone()),
            // Closed attempts never run again; their answer stays readable.
            Some("superseded" | "reconciled") => {
                let mut closed = original["response"].clone();
                if !closed.is_object() {
                    closed = json!({});
                }
                closed["success"] = json!(false);
                closed["code"] = json!("EDIT_SETTLEMENT_CLOSED");
                closed["state"] = original["state"].clone();
                return Ok(closed);
            }
            _ => {}
        }
    }
    let supersedes = superseded_events(request);
    // Another unresolved attempt holds the order (the preview refuses this
    // before any picker); a new attempt never becomes a second hold.
    require_original_financial_attempt_superseding(
        conn,
        order,
        Some(&format!("edit:{event}:")),
        &supersedes,
    )?;
    let not_applied = |error: String| {
        // Rollback (or a refusal before the transaction) proves no new
        // database writes, NOT that physical cash/card confirmation never
        // happened. Retain the confirmed action: an exact save retry, a
        // re-quote under a new event, or a manager reconciliation; never
        // authorize recollection.
        json!({"success":false,"code":"EDIT_SETTLEMENT_NOT_APPLIED","error":error,
            "clientEventId":event,"orderId":order,"transactionRolledBack":true,
            "paymentPersisted":false,"requiresReconciliation":true,"requoteAllowed":true})
    };
    // Fix 4 (06/10/2026): the confirmed action is journaled BEFORE anything is
    // re-validated. A check that fails after the operator confirmed money
    // used to leave the declared cash untraced: no journal, no Z blocker.
    // The applied receipt still commits WITH all financial writes.
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
        if let Err(error) = admission(conn) {
            let response = not_applied(error);
            finish(conn, &scope, event, "refused", &response)?;
            return Ok(response);
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
        // The replaced attempt is closed inside the same transaction before the
        // financial writes (their own guards then see no other open attempt);
        // a failed apply rolls the replacement back with them.
        let applied = target
            .and_then(|_| supersede_unapplied(conn, &scope, order, &supersedes, event))
            .and_then(|_| apply(conn))
            .and_then(|response| {
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
                let response = not_applied(error);
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

// ---------------------------------------------------------------------------
// Fix 1 (06/10/2026): identity-less 1.4.122 paid edits
// ---------------------------------------------------------------------------
//
// Desktop 1.4.122 saved a paid edit as an `orders` UPDATE carrying the complete
// item snapshot but no `client_event_id`/`expected_version`, plus the
// difference as an untagged `payments` INSERT (or `payment_adjustments` for a
// return) in the same transaction. The server's atomic editor refused that
// UPDATE ("Stable client_event_id and request identity required"); the payment
// then waited 50 times for its parent and was escalated, and the store's Z
// failed with PARITY_SYNC_PARTIAL.
//
// Server hotfix (PR #329) adopts such a legacy item edit through
// `edit_pos_order_atomic` with `client_event_id = 'legacy-edit:' +
// sha256(request)`, the current server version, only from the order's owning
// terminal, only for internal POS orders, only while the order has no edit
// event, never moving its status and re-deriving the payment snapshot from the
// ledger. The identity is derived from the UNCHANGED request, so the till
// never rewrites the legacy row's payload. It only:
// 1. puts a row the old server refused for its missing identity back in line,
//    unchanged, with a persisted guard (cooldown, attempt cap, audit);
// 2. releases the difference rows that were parked waiting for that parent
//    once the server acknowledges it (`release_legacy_edit_dependents`); they
//    then sync idempotently on their original identity (`payment:<id>`);
// 3. names a legacy edit the server refused for any other reason (a newer
//    canonical edit exists, another terminal owns the order) for a manager.

/// The server's refusal of an identity-less item edit (pre-hotfix).
pub(crate) const LEGACY_IDENTITY_REFUSAL: &str =
    "Stable client_event_id and request identity required";
/// Exported, stable marker of a legacy edit a manager must review.
pub(crate) const LEGACY_EDIT_REVIEW_CODE: &str = "LEGACY_EDIT_REVIEW_REQUIRED";
const LEGACY_EDIT_MAX_REQUEUES: i64 = 3;
const LEGACY_EDIT_REQUEUE_COOLDOWN_MINUTES: i64 = 15;

/// SQL predicate for an identity-less item UPDATE of an order (alias `q`).
const LEGACY_EDIT_ROW_PREDICATE: &str = "q.table_name='orders' AND q.operation='UPDATE'
    AND json_valid(q.data) AND json_type(q.data,'$.items')='array' AND json_array_length(q.data,'$.items')>0
    AND COALESCE(json_extract(q.data,'$.client_event_id'),'')=''
    AND json_type(q.data,'$.settlement_context') IS NULL";

/// An `orders` UPDATE payload in the identity-less 1.4.122 item-edit shape.
pub(crate) fn is_legacy_edit_payload(payload: &Value) -> bool {
    payload["items"]
        .as_array()
        .is_some_and(|items| !items.is_empty())
        && payload
            .get("client_event_id")
            .and_then(Value::as_str)
            .is_none_or(|event| event.trim().is_empty())
        && payload.get("settlement_context").is_none_or(Value::is_null)
}

fn legacy_edit_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS legacy_edit_replays_v1 (
        queue_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, branch_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL, order_id TEXT NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, audit_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
    )
    .map_err(|error| error.to_string())
}

/// Put identity-refused legacy edit rows back in line, unchanged (bounded).
///
/// Narrow eligibility: an identity-less item UPDATE the server refused with
/// exactly [`LEGACY_IDENTITY_REFUSAL`]. Only scheduling metadata changes; the
/// previous metadata is snapshotted in the guard row in the same transaction.
/// The server adopts the edit at most once (it refuses a second adoption once
/// the order has an edit event), so a retry can never apply twice.
pub(crate) fn requeue_legacy_edits(conn: &Connection) -> Result<usize, String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM parity_sync_queue q WHERE q.status IN ('conflict','failed') AND q.table_name='orders'
             AND COALESCE(q.error_message,'') LIKE ?1)",
            [format!("%{LEGACY_IDENTITY_REFUSAL}%")],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        return Ok(0);
    }
    legacy_edit_schema(conn)?;
    let scope = table_session_cache::current_scope(conn)?;
    let now = chrono::Utc::now();
    let sql = format!(
        "SELECT q.id,q.record_id,q.data,q.status,q.attempts,q.error_message,q.next_retry_at
         FROM parity_sync_queue q JOIN orders o ON o.id=q.record_id
         WHERE {LEGACY_EDIT_ROW_PREDICATE} AND q.status IN ('conflict','failed')
           AND COALESCE(q.error_message,'') LIKE ?1
           AND o.organization_id=?2 AND o.branch_id=?3
           AND NULLIF(TRIM(COALESCE(o.supabase_id,'')),'') IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM legacy_edit_replays_v1 r WHERE r.queue_id=q.id
             AND (r.attempts>=?4 OR (r.next_attempt_at IS NOT NULL AND r.next_attempt_at>?5)))
         ORDER BY q.created_at,q.id LIMIT 5"
    );
    let rows: Vec<(
        String,
        String,
        String,
        String,
        i64,
        Option<String>,
        Option<String>,
    )> = {
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![
                    format!("%{LEGACY_IDENTITY_REFUSAL}%"),
                    scope.organization,
                    scope.branch,
                    LEGACY_EDIT_MAX_REQUEUES,
                    now.to_rfc3339()
                ],
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
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let mut requeued = 0;
    for (id, order, data, status, attempts, error, next_retry) in rows {
        let next =
            (now + chrono::Duration::minutes(LEGACY_EDIT_REQUEUE_COOLDOWN_MINUTES)).to_rfc3339();
        let audit = json!({"action":"requeue_unchanged","at":now.to_rfc3339(),"previous":{
            "status":status,"attempts":attempts,"error_message":error,"next_retry_at":next_retry}});
        conn.execute_batch("SAVEPOINT legacy_edit_requeue")
            .map_err(|error| error.to_string())?;
        let result = (|| -> Result<usize, String> {
            conn.execute("INSERT INTO legacy_edit_replays_v1(queue_id,organization_id,branch_id,terminal_id,order_id,state,attempts,next_attempt_at,audit_json,created_at,updated_at)
                VALUES(?1,?2,?3,?4,?5,'requeued',1,?6,json_array(json(?7)),?8,?8) ON CONFLICT(queue_id) DO UPDATE SET state='requeued',
                attempts=legacy_edit_replays_v1.attempts+1,next_attempt_at=excluded.next_attempt_at,
                audit_json=json_insert(legacy_edit_replays_v1.audit_json,'$[#]',json(?7)),updated_at=excluded.updated_at",
                params![id,scope.organization,scope.branch,scope.terminal,order,next,audit.to_string(),now.to_rfc3339()]).map_err(|error|error.to_string())?;
            conn.execute(
                "UPDATE parity_sync_queue SET status='pending',attempts=0,error_message=NULL,next_retry_at=NULL,last_attempt=NULL
                 WHERE id=?1 AND data=?2 AND status IN ('conflict','failed')",
                params![id, data],
            )
            .map_err(|error| error.to_string())
        })();
        match result {
            Ok(changed) => {
                conn.execute_batch("RELEASE legacy_edit_requeue")
                    .map_err(|error| error.to_string())?;
                requeued += changed;
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK TO legacy_edit_requeue");
                let _ = conn.execute_batch("RELEASE legacy_edit_requeue");
                return Err(error);
            }
        }
    }
    Ok(requeued)
}

/// Name a legacy edit the server refused for a reason other than its
/// missing identity (after the hotfix: a newer canonical edit exists, or
/// only the order's owning terminal may replay it). Its payload stays
/// untouched; its exported reason tells the manager what to review.
pub(crate) fn mark_legacy_edits_for_review(conn: &Connection) -> Result<usize, String> {
    let sql = format!(
        "SELECT q.id,q.error_message FROM parity_sync_queue q
         WHERE {LEGACY_EDIT_ROW_PREDICATE} AND q.status='conflict'
           AND NULLIF(TRIM(COALESCE(q.error_message,'')),'') IS NOT NULL
           AND COALESCE(q.error_message,'') NOT LIKE ?1
           AND COALESCE(q.error_message,'') NOT LIKE ?2
           AND (COALESCE(q.error_message,'') LIKE '%POS_ORDER_EDIT_CONFLICT%'
             OR lower(COALESCE(q.error_message,'')) LIKE '%newer canonical edit%'
             OR lower(COALESCE(q.error_message,'')) LIKE '%terminal that owns the order%')"
    );
    let rows: Vec<(String, String)> = {
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![
                    format!("%{LEGACY_IDENTITY_REFUSAL}%"),
                    format!("{LEGACY_EDIT_REVIEW_CODE}%")
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let mut marked = 0;
    for (id, reason) in rows {
        let reason = reason.trim();
        let reason: String = reason.chars().take(200).collect();
        let message = format!(
            "{LEGACY_EDIT_REVIEW_CODE}: {reason} | An order edit saved by an older version of this till was refused by the server. The server keeps the original order and payments; this till holds the edit and its receipt. Nothing was collected again. A manager must review this order before the Z."
        );
        marked += conn
            .execute(
                "UPDATE parity_sync_queue SET error_message=?1 WHERE id=?2 AND status='conflict'",
                params![message, id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(marked)
}

/// Whether an order holds a legacy edit a manager must review.
pub(crate) fn legacy_edit_review_pending(conn: &Connection, order: &str) -> Result<bool, String> {
    let sql = format!(
        "SELECT EXISTS(SELECT 1 FROM parity_sync_queue q WHERE q.record_id=?1 AND {LEGACY_EDIT_ROW_PREDICATE}
         AND q.status='conflict' AND COALESCE(q.error_message,'') LIKE ?2)"
    );
    conn.query_row(
        &sql,
        params![order, format!("{LEGACY_EDIT_REVIEW_CODE}%")],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

/// Once the server acknowledges an order's legacy edit, its difference rows
/// that were parked waiting on that parent go back in line unchanged. They
/// sync on their original identity (`payment:<id>`), so the server keeps one
/// receipt each and nothing is collected or returned again. Rows the server
/// refused for their own reason are left for review.
pub(crate) fn release_legacy_edit_dependents(
    conn: &Connection,
    order: &str,
) -> Result<usize, String> {
    let parent_wait =
        "(q.status IN ('pending','deferred') OR (q.status IN ('conflict','failed') AND
        (lower(COALESCE(q.error_message,'')) LIKE '%waiting for parent order%'
         OR lower(COALESCE(q.error_message,'')) LIKE '%deferred too many times%')))";
    let untagged =
        "(NOT json_valid(q.data) OR COALESCE(json_extract(q.data,'$.parentEditEventId'),'')='')";
    let mut released = conn
        .execute(
            &format!(
                "UPDATE parity_sync_queue AS q SET status='pending',attempts=0,error_message=NULL,next_retry_at=NULL,last_attempt=NULL
                 WHERE q.table_name='payments' AND {parent_wait} AND {untagged}
                   AND q.record_id IN (SELECT p.id FROM order_payments p WHERE p.order_id=?1 AND p.status='completed'
                     AND NULLIF(TRIM(COALESCE(p.remote_payment_id,'')),'') IS NULL)"
            ),
            [order],
        )
        .map_err(|error| error.to_string())?;
    released += conn
        .execute(
            &format!(
                "UPDATE parity_sync_queue AS q SET status='pending',attempts=0,error_message=NULL,next_retry_at=NULL,last_attempt=NULL
                 WHERE q.table_name='payment_adjustments' AND {parent_wait} AND {untagged}
                   AND q.record_id IN (SELECT a.id FROM payment_adjustments a WHERE a.order_id=?1
                     AND COALESCE(a.sync_state,'')<>'applied')"
            ),
            [order],
        )
        .map_err(|error| error.to_string())?;
    Ok(released)
}
