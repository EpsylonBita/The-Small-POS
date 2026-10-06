//! Fresh canonical revision for non-financial header corrections. Local form
//! revisions and canonical CAS revisions are different clocks.
use rusqlite::Connection;
use serde_json::{json, Value};

pub(crate) fn capture(conn: &Connection, order: &str, request: &Value) -> Result<Value, String> {
    let scope = crate::table_session_cache::current_scope(conn)?;
    let mut original: Value = conn.query_row(
        "SELECT supabase_id,organization_id,branch_id,COALESCE(version,1),remote_version,status,total_amount,items,notes,special_instructions,sync_status FROM orders WHERE id=?1",
        [order], |r| Ok(json!({"id":r.get::<_,Option<String>>(0)?,"organizationId":r.get::<_,Option<String>>(1)?,
            "branchId":r.get::<_,Option<String>>(2)?,"localVersion":r.get::<_,i64>(3)?,"remoteVersion":r.get::<_,Option<i64>>(4)?,
            "status":r.get::<_,String>(5)?,"totalCents":crate::money::Cents::round_half_even(r.get::<_,f64>(6)?).as_i64(),
            "items":r.get::<_,String>(7)?,"notes":r.get::<_,Option<String>>(8)?,"special_instructions":r.get::<_,Option<String>>(9)?,
            "syncStatus":r.get::<_,String>(10)?}))) .map_err(|e|e.to_string())?;
    if original["organizationId"] != scope.organization || original["branchId"] != scope.branch {
        return Err("EDIT_SETTLEMENT_SCOPE_MISMATCH".into());
    }
    let expected_local = request
        .get("expectedLocalVersion")
        .or_else(|| request.get("expected_local_version"))
        .and_then(Value::as_i64);
    let expected_display = request
        .get("expectedVersion")
        .or_else(|| request.get("expected_version"))
        .and_then(Value::as_i64);
    let displayed = original["remoteVersion"]
        .as_i64()
        .or(original["localVersion"].as_i64());
    if expected_local.is_some_and(|v| Some(v) != original["localVersion"].as_i64())
        || expected_display.is_some_and(|v| Some(v) != displayed)
    {
        return Err("ORDER_VERSION_CONFLICT".into());
    }
    original["terminalId"] = json!(scope.terminal);
    original["headers"] = crate::edit_settlement_recovery::capture_order_headers(conn, order)?;
    let payments:String=conn.query_row("SELECT COALESCE(json_group_array(json_object('id',id,'remote',remote_payment_id,'status',status,'amount',amount,'currency',currency,'method',method,'tip',tip_amount,'origin',payment_origin,'reference',transaction_ref,'sync',sync_status)), '[]') FROM (SELECT * FROM order_payments WHERE order_id=?1 ORDER BY id)",[order],|r|r.get(0)).map_err(|e|e.to_string())?;
    original["localPayments"] = json!(payments);
    let adjustments:String=conn.query_row("SELECT COALESCE(json_group_array(json_object('id',id,'payment',payment_id,'type',adjustment_type,'amount',amount,'cents',amount_cents,'method',refund_method,'handler',cash_handler,'shift',staff_shift_id)), '[]') FROM (SELECT * FROM payment_adjustments WHERE order_id=?1 ORDER BY id)",[order],|r|r.get(0)).map_err(|e|e.to_string())?;
    original["localAdjustments"] = json!(adjustments);
    let pending:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM parity_sync_queue WHERE table_name='orders' AND record_id=?1 AND operation='UPDATE')",[order],|r|r.get(0)).map_err(|e|e.to_string())?;
    if pending {
        return Err("ORDER_HEADER_SYNC_REQUIRED".into());
    }
    Ok(original)
}

fn same(left: &Value, right: &Value) -> bool {
    left == right
        || ((left.is_null() || left.as_str() == Some(""))
            && (right.is_null() || right.as_str() == Some("")))
}

fn item_signatures(raw: &Value) -> Result<Vec<String>, String> {
    let value = if let Some(raw) = raw.as_str() {
        serde_json::from_str(raw).map_err(|_| "EDIT_CANONICAL_SNAPSHOT_INVALID")?
    } else {
        raw.clone()
    };
    let mut signatures = Vec::new();
    for item in value.as_array().ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")? {
        let mut item = item.clone();
        let object = item
            .as_object_mut()
            .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
        for key in [
            "source_order_item_id",
            "sourceOrderItemId",
            "order_item_id",
            "orderItemId",
        ] {
            object.remove(key);
        }
        object.insert("id".into(), json!("11111111-1111-4111-8111-111111111111"));
        let mut normalized = crate::edit_settlement_recovery::items(&json!([item]))?.remove(0);
        normalized.as_object_mut().unwrap().remove("id");
        signatures.push(normalized.to_string());
    }
    signatures.sort();
    Ok(signatures)
}

/// Reads never change the cached order. Only an exact original permits the
/// fresh wire version; a changed order remains editable for explicit refresh.
pub(crate) fn verify(
    conn: &Connection,
    order: &str,
    before: &Value,
    answer: &Value,
) -> Result<Value, String> {
    if capture(conn, order, &json!({}))? != *before {
        return Err("ORDER_VERSION_CONFLICT".into());
    }
    let rows = answer
        .get("orders")
        .and_then(Value::as_array)
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
    if answer["success"] != true || answer["exact_order_lookup"] != true || rows.len() != 1 {
        return Err("EDIT_CANONICAL_SNAPSHOT_INVALID".into());
    }
    let canonical = &rows[0];
    if canonical["id"] != before["id"]
        || canonical["organization_id"] != before["organizationId"]
        || canonical["branch_id"] != before["branchId"]
    {
        return Err("EDIT_SETTLEMENT_SCOPE_MISMATCH".into());
    }
    let version = canonical["version"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
    if before["remoteVersion"]
        .as_i64()
        .is_some_and(|known| version < known)
    {
        return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
    }
    let amount = canonical["total_amount"]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
    if json!(crate::money::Cents::round_half_even(amount).as_i64()) != before["totalCents"]
        || canonical["status"] != before["status"]
    {
        return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
    }
    for (_, field) in crate::edit_settlement_recovery::EDIT_HEADER_FIELDS {
        if !same(&canonical[*field], &before["headers"][*field]) {
            return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
        }
    }
    if item_signatures(&canonical["items"])? != item_signatures(&before["items"])? {
        return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
    }
    for field in ["notes", "special_instructions"] {
        if !same(&canonical[field], &before[field]) {
            return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
        }
    }
    Ok(json!({"version":1,"canonicalVersion":version,"original":before}))
}

/// Offline metadata remains a queued correction against its existing CAS base.
/// A transport failure is not evidence that a newer canonical revision matches.
pub(crate) fn offline(
    conn: &Connection,
    order: &str,
    original: &Value,
    error: &crate::api::AdminFetchError,
) -> Result<Value, String> {
    if !error.is_transport_failure() {
        return Err("EDIT_CANONICAL_PREFLIGHT_REQUIRED".into());
    }
    let version = original["remoteVersion"]
        .as_i64()
        .or(original["localVersion"].as_i64())
        .filter(|v| *v > 0)
        .ok_or("ORDER_VERSION_CONFLICT")?;
    let proof = json!({"version":1,"canonicalVersion":version,"source":"offline_cached_revision","original":original});
    verify_local(conn, order, &proof)?;
    Ok(proof)
}

fn intent(request: &Value) -> Value {
    json!({"items":request["items"],"orderUpdates":request.get("orderUpdates").or_else(||request.get("order_updates")).unwrap_or(&Value::Null),"financials":request["financials"],
        "orderNotes":request.get("orderNotes").or_else(||request.get("order_notes")).or_else(||request.get("notes")).or_else(||request.get("special_instructions")).unwrap_or(&Value::Null)})
}

pub(crate) fn verify_local(conn: &Connection, order: &str, proof: &Value) -> Result<i64, String> {
    if proof["version"] != 1 || capture(conn, order, &json!({}))? != proof["original"] {
        return Err("ORDER_VERSION_CONFLICT".into());
    }
    proof["canonicalVersion"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or("EDIT_CANONICAL_PREFLIGHT_REQUIRED".into())
}

pub(crate) fn remote_id(original: &Value) -> Result<Option<&str>, String> {
    match original["id"].as_str().filter(|id| !id.trim().is_empty()) {
        Some(id) if uuid::Uuid::parse_str(id).is_ok() => {
            if original["syncStatus"] != "synced" {
                return Err("ORDER_HEADER_SYNC_REQUIRED".into());
            }
            Ok(Some(id))
        }
        Some(_) => Err("EDIT_CANONICAL_SNAPSHOT_INVALID".into()),
        None => Ok(None),
    }
}

fn cache_key(conn: &Connection, event: &str) -> Result<String, String> {
    let scope = crate::table_session_cache::current_scope(conn)?;
    Ok(format!(
        "{}:{}:{}:{event}",
        scope.organization, scope.branch, scope.terminal
    ))
}
pub(crate) fn remember(
    conn: &Connection,
    order: &str,
    event: &str,
    proof: &Value,
    request: &Value,
) -> Result<(), String> {
    verify_local(conn, order, proof)?;
    crate::db::set_setting(
        conn,
        "order_header_preflight_v1",
        &cache_key(conn, event)?,
        &json!({"orderId":order,"proof":proof,"intent":intent(request)}).to_string(),
    )
}
pub(crate) fn remembered(
    conn: &Connection,
    order: &str,
    event: &str,
    request: &Value,
) -> Result<Option<Value>, String> {
    let Some(raw) =
        crate::db::get_setting(conn, "order_header_preflight_v1", &cache_key(conn, event)?)
    else {
        return Ok(None);
    };
    let saved: Value =
        serde_json::from_str(&raw).map_err(|_| "EDIT_CANONICAL_PREFLIGHT_REQUIRED")?;
    if saved["orderId"] != order || saved["intent"] != intent(request) {
        return Err("RECOVERY_ORIGINAL_REQUEST_REQUIRED".into());
    }
    capture(conn, order, request)?;
    verify_local(conn, order, &saved["proof"])?;
    Ok(Some(saved["proof"].clone()))
}
