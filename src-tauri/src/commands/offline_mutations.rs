use chrono::{Duration as ChronoDuration, Utc};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::Emitter;
use uuid::Uuid;

use crate::{db, menu, read_local_setting, storage, sync_queue, value_str};

use super::api_bridge::{
    cache_admin_get_response, list_cached_admin_get_paths, read_cached_admin_get_response,
};

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

fn object_payload(arg0: Option<Value>, arg1: Option<Value>) -> Result<Value, String> {
    let payload = crate::parse_channel_payload(arg0, arg1);
    if payload.is_object() {
        Ok(payload)
    } else {
        Err("Expected object payload".to_string())
    }
}

fn read_string(payload: &Value, keys: &[&str]) -> Option<String> {
    value_str(payload, keys).map(|value| value.trim().to_string())
}

fn read_bool(payload: &Value, keys: &[&str]) -> Option<bool> {
    for key in keys {
        if let Some(value) = payload.get(*key) {
            if let Some(boolean) = value.as_bool() {
                return Some(boolean);
            }
            if let Some(text) = value.as_str() {
                let trimmed = text.trim();
                if trimmed.eq_ignore_ascii_case("true") {
                    return Some(true);
                }
                if trimmed.eq_ignore_ascii_case("false") {
                    return Some(false);
                }
            }
        }
    }
    None
}

fn read_i64(payload: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(value) = payload.get(*key) {
            if let Some(number) = value.as_i64() {
                return Some(number);
            }
            if let Some(number) = value.as_u64() {
                return Some(number as i64);
            }
            if let Some(text) = value.as_str() {
                if let Ok(parsed) = text.trim().parse::<i64>() {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

fn read_f64(payload: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(value) = payload.get(*key) {
            if let Some(number) = value.as_f64() {
                return Some(number);
            }
            if let Some(text) = value.as_str() {
                if let Ok(parsed) = text.trim().parse::<f64>() {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

fn temp_id(prefix: &str) -> String {
    format!("local-{prefix}-{}", Uuid::new_v4())
}

fn organization_id(db: &db::DbState, payload: &Value) -> String {
    read_string(payload, &["organization_id", "organizationId"])
        .or_else(|| storage::get_credential("organization_id"))
        .or_else(|| read_local_setting(db, "terminal", "organization_id"))
        .unwrap_or_else(|| "pending-org".to_string())
}

fn branch_id(db: &db::DbState, payload: &Value) -> String {
    read_string(payload, &["branch_id", "branchId"])
        .or_else(|| storage::get_credential("branch_id"))
        .or_else(|| read_local_setting(db, "terminal", "branch_id"))
        .unwrap_or_default()
}

fn set_object_field(object: &mut Map<String, Value>, key: &str, value: Value) {
    object.insert(key.to_string(), value);
}

fn enqueue_parity_item(
    conn: &Connection,
    table_name: &str,
    record_id: &str,
    operation: &str,
    payload: &Value,
    module_type: &str,
    conflict_strategy: &str,
) -> Result<String, String> {
    sync_queue::enqueue_payload_item(
        conn,
        table_name,
        record_id,
        operation,
        payload,
        Some(0),
        Some(module_type),
        Some(conflict_strategy),
        Some(1),
    )
}

fn emit_queue_hint(app: &tauri::AppHandle, module_type: &str) {
    let _ = app.emit(
        "sync:status",
        json!({
            "queuedRemote": 1,
            "moduleType": module_type,
        }),
    );
}

fn get_array_mut_path<'a>(root: &'a mut Value, path: &[&str]) -> Option<&'a mut Vec<Value>> {
    let mut current = root;
    for segment in path {
        current = current.get_mut(*segment)?;
    }
    current.as_array_mut()
}

fn upsert_array_record(items: &mut Vec<Value>, record: &Value) -> Value {
    let record_id = record
        .get("id")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .unwrap_or_default();

    if !record_id.is_empty() {
        for item in items.iter_mut() {
            let item_id = item
                .get("id")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .unwrap_or_default();
            if item_id == record_id {
                *item = record.clone();
                return record.clone();
            }
        }
    }

    items.push(record.clone());
    record.clone()
}

fn update_array_record<F>(items: &mut Vec<Value>, record_id: &str, mut updater: F) -> Option<Value>
where
    F: FnMut(&mut Map<String, Value>),
{
    for item in items.iter_mut() {
        let item_id = item
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        if item_id != record_id {
            continue;
        }
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        updater(object);
        return Some(Value::Object(object.clone()));
    }
    None
}

fn patch_cached_admin_paths<F>(db: &db::DbState, prefix: &str, mut patcher: F) -> Result<(), String>
where
    F: FnMut(&str, &mut Value) -> Result<bool, String>,
{
    let mut paths = list_cached_admin_get_paths(db, &[prefix.to_string()])?;
    if paths.iter().all(|path| path != prefix) {
        paths.push(prefix.to_string());
    }
    paths.sort();
    paths.dedup();

    for path in paths {
        let Some((mut cached, _)) = read_cached_admin_get_response(db, &path) else {
            continue;
        };
        if patcher(&path, &mut cached)? {
            cache_admin_get_response(db, &path, &cached)?;
        }
    }

    Ok(())
}

fn patch_branch_cache_rows<F>(
    db: &db::DbState,
    branch_id: &str,
    cache_key: &str,
    mut patcher: F,
) -> Result<(), String>
where
    F: FnMut(&str, &mut Value) -> bool,
{
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT scope_key, payload_json
             FROM branch_ops_cache
             WHERE branch_id = ?1 AND cache_key = ?2",
        )
        .map_err(|e| format!("prepare branch cache query: {e}"))?;
    let rows = stmt
        .query_map(params![branch_id, cache_key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query branch cache rows: {e}"))?;
    let row_values = rows.filter_map(Result::ok).collect::<Vec<_>>();
    drop(stmt);

    for (scope_key, payload_json) in row_values {
        let mut payload =
            serde_json::from_str::<Value>(&payload_json).map_err(|e| format!("parse cache: {e}"))?;
        if !patcher(&scope_key, &mut payload) {
            continue;
        }
        let updated_payload =
            serde_json::to_string(&payload).map_err(|e| format!("serialize cache: {e}"))?;
        conn.execute(
            "UPDATE branch_ops_cache
             SET payload_json = ?1,
                 synced_at = ?2,
                 version = ?3
             WHERE branch_id = ?4 AND cache_key = ?5 AND scope_key = ?6",
            params![
                updated_payload,
                now_rfc3339(),
                format!("offline:{}", Uuid::new_v4()),
                branch_id,
                cache_key,
                scope_key
            ],
        )
        .map_err(|e| format!("update branch cache row: {e}"))?;
    }

    Ok(())
}

fn write_menu_section(db: &db::DbState, section: &str, payload: &[Value]) -> Result<(), String> {
    let json_str = serde_json::to_string(&Value::Array(payload.to_vec()))
        .map_err(|e| format!("serialize menu section {section}: {e}"))?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO menu_cache (id, cache_key, data, version, updated_at)
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, datetime('now'))
         ON CONFLICT(cache_key) DO UPDATE SET
            data = excluded.data,
            version = excluded.version,
            updated_at = excluded.updated_at",
        params![section, json_str, format!("offline:{}", Uuid::new_v4())],
    )
    .map_err(|e| format!("upsert menu cache {section}: {e}"))?;
    Ok(())
}

pub(crate) fn patch_menu_flag(
    db: &db::DbState,
    section: &str,
    item_id: &str,
    field: &str,
    value: bool,
) -> Result<Value, String> {
    let mut items = match section {
        "categories" => menu::get_categories(db),
        "subcategories" => menu::get_subcategories(db),
        "ingredients" => menu::get_ingredients(db),
        "combos" => menu::get_combos(db),
        _ => Vec::new(),
    };
    let now = now_rfc3339();
    let updated = update_array_record(&mut items, item_id, |object| {
        set_object_field(object, field, Value::Bool(value));
        set_object_field(object, "updated_at", Value::String(now.clone()));
        set_object_field(object, "updatedAt", Value::String(now.clone()));
    })
    .ok_or_else(|| "Menu cache item not found locally".to_string())?;
    write_menu_section(db, section, &items)?;
    Ok(updated)
}

fn patch_inventory_cache(
    db: &db::DbState,
    product_id: &str,
    new_quantity: i64,
) -> Result<Option<Value>, String> {
    let mut updated: Option<Value> = None;
    patch_cached_admin_paths(db, "/api/pos/sync/inventory_items", |_path, data| {
        let Some(items) = get_array_mut_path(data, &["data"]) else {
            return Ok(false);
        };
        let now = now_rfc3339();
        let result = update_array_record(items, product_id, |object| {
            set_object_field(object, "stock_quantity", Value::from(new_quantity));
            set_object_field(object, "updated_at", Value::String(now.clone()));
        });
        if let Some(value) = result {
            updated = Some(value);
            return Ok(true);
        }
        Ok(false)
    })?;
    Ok(updated)
}

fn patch_coupon_caches(db: &db::DbState, record: &Value) -> Result<(), String> {
    patch_cached_admin_paths(db, "/api/pos/coupons", |_path, data| {
        let Some(items) = get_array_mut_path(data, &["coupons"]) else {
            return Ok(false);
        };
        upsert_array_record(items, record);
        Ok(true)
    })
}

fn patch_coupon_active_state(
    db: &db::DbState,
    coupon_id: &str,
    is_active: bool,
) -> Result<Option<Value>, String> {
    let mut updated: Option<Value> = None;
    patch_cached_admin_paths(db, "/api/pos/coupons", |_path, data| {
        let Some(items) = get_array_mut_path(data, &["coupons"]) else {
            return Ok(false);
        };
        let result = update_array_record(items, coupon_id, |object| {
            set_object_field(object, "is_active", Value::Bool(is_active));
            set_object_field(object, "updated_at", Value::String(now_rfc3339()));
        });
        if let Some(value) = result {
            updated = Some(value);
            return Ok(true);
        }
        Ok(false)
    })?;
    Ok(updated)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryAdjustPayload {
    #[serde(alias = "product_id", alias = "id")]
    product_id: String,
    adjustment: i64,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

#[tauri::command]
pub async fn offline_inventory_adjust(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload_value = object_payload(arg0, arg1)?;
    let payload: InventoryAdjustPayload = serde_json::from_value(payload_value.clone())
        .map_err(|e| format!("Invalid inventory adjustment payload: {e}"))?;
    let product_id = payload.product_id.trim().to_string();
    if product_id.is_empty() {
        return Err("Missing product_id".to_string());
    }

    let _ = patch_inventory_cache(&db, &product_id, payload.adjustment)?;
    let queue_payload = json!({
        "product_id": product_id,
        "adjustment": payload.adjustment,
        "reason": payload.reason.unwrap_or_else(|| "count".to_string()),
        "notes": payload.notes,
        "organization_id": organization_id(&db, &payload_value),
        "branch_id": branch_id(&db, &payload_value),
    });

    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "inventory_adjustments",
            queue_payload
                .get("product_id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            "UPDATE",
            &queue_payload,
            "inventory",
            "manual",
        )?
    };

    let _ = app.emit(
        "inventory_adjusted",
        json!({
            "productId": queue_payload.get("product_id"),
            "adjustment": queue_payload.get("adjustment"),
            "queued": true,
            "queueId": queue_id,
        }),
    );
    emit_queue_hint(&app, "inventory");

    Ok(json!({
        "success": true,
        "data": {
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

#[tauri::command]
pub async fn offline_coupon_upsert(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let mut payload = object_payload(arg0, arg1)?;
    let now = now_rfc3339();
    let operation = if read_string(&payload, &["id"]).is_some() {
        "UPDATE"
    } else {
        "INSERT"
    };
    let coupon_id = read_string(&payload, &["id"]).unwrap_or_else(|| temp_id("coupon"));
    let resolved_branch_id = branch_id(&db, &payload);
    let resolved_organization_id = organization_id(&db, &payload);
    let Some(object) = payload.as_object_mut() else {
        return Err("Coupon payload must be an object".to_string());
    };
    set_object_field(object, "id", Value::String(coupon_id.clone()));
    set_object_field(object, "updated_at", Value::String(now.clone()));
    if operation == "INSERT" {
        set_object_field(object, "created_at", Value::String(now.clone()));
        object.entry("usage_count".to_string()).or_insert(Value::from(0));
    }
    object
        .entry("branch_id".to_string())
        .or_insert(Value::String(resolved_branch_id));
    object
        .entry("organization_id".to_string())
        .or_insert(Value::String(resolved_organization_id));

    patch_coupon_caches(&db, &payload)?;

    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "coupons",
            &coupon_id,
            operation,
            &payload,
            "promotions",
            "manual",
        )?
    };

    let _ = app.emit(
        "coupon_updated",
        json!({
            "coupon": payload,
            "queued": true,
            "queueId": queue_id,
        }),
    );
    emit_queue_hint(&app, "promotions");

    Ok(json!({
        "success": true,
        "data": {
            "coupon": payload,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

#[tauri::command]
pub async fn offline_coupon_set_active(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let coupon_id = read_string(&payload, &["couponId", "coupon_id", "id"])
        .ok_or_else(|| "Missing coupon id".to_string())?;
    let is_active = read_bool(&payload, &["isActive", "is_active"])
        .ok_or_else(|| "Missing coupon active state".to_string())?;
    let updated_coupon = patch_coupon_active_state(&db, &coupon_id, is_active)?;

    let queue_payload = json!({
        "id": coupon_id,
        "is_active": is_active,
        "organization_id": organization_id(&db, &payload),
        "branch_id": branch_id(&db, &payload),
    });

    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "coupons",
            queue_payload.get("id").and_then(Value::as_str).unwrap_or_default(),
            "UPDATE",
            &queue_payload,
            "promotions",
            "manual",
        )?
    };

    let _ = app.emit(
        "coupon_updated",
        json!({
            "couponId": queue_payload.get("id"),
            "isActive": is_active,
            "queued": true,
            "queueId": queue_id,
        }),
    );
    emit_queue_hint(&app, "promotions");

    Ok(json!({
        "success": true,
        "data": {
            "coupon": updated_coupon,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

fn build_local_reservation(db: &db::DbState, payload: &Value) -> Value {
    let now = now_rfc3339();
    let reservation_id = read_string(payload, &["id"]).unwrap_or_else(|| temp_id("reservation"));
    let reservation_date = read_string(payload, &["reservationDate", "reservation_date"])
        .unwrap_or_else(|| Utc::now().date_naive().to_string());
    let reservation_time = read_string(payload, &["reservationTime", "reservation_time"])
        .unwrap_or_else(|| "12:00".to_string());
    let reservation_datetime = format!("{reservation_date}T{reservation_time}:00");
    json!({
        "id": reservation_id,
        "organization_id": organization_id(db, payload),
        "branch_id": branch_id(db, payload),
        "reservation_number": read_string(payload, &["reservationNumber", "reservation_number"]).unwrap_or_else(|| format!("RES-{}", &Uuid::new_v4().simple().to_string()[..8].to_uppercase())),
        "customer_id": read_string(payload, &["customerId", "customer_id"]),
        "customer_name": read_string(payload, &["customerName", "customer_name"]).unwrap_or_else(|| "Walk-in".to_string()),
        "customer_phone": read_string(payload, &["customerPhone", "customer_phone"]).unwrap_or_default(),
        "customer_email": read_string(payload, &["customerEmail", "customer_email"]),
        "party_size": read_i64(payload, &["partySize", "party_size"]).unwrap_or(2),
        "table_id": read_string(payload, &["tableId", "table_id"]),
        "room_id": read_string(payload, &["roomId", "room_id"]),
        "room_number": read_string(payload, &["roomNumber", "room_number"]),
        "check_in_date": read_string(payload, &["checkInDate", "check_in_date"]),
        "check_out_date": read_string(payload, &["checkOutDate", "check_out_date"]),
        "reservation_date": reservation_date,
        "reservation_time": reservation_time,
        "reservation_datetime": reservation_datetime,
        "duration_minutes": read_i64(payload, &["durationMinutes", "duration_minutes"]).unwrap_or(90),
        "status": read_string(payload, &["status"]).unwrap_or_else(|| "pending".to_string()),
        "special_requests": read_string(payload, &["specialRequests", "special_requests"]),
        "notes": read_string(payload, &["notes"]),
        "confirmed_at": Value::Null,
        "seated_at": Value::Null,
        "completed_at": Value::Null,
        "cancelled_at": Value::Null,
        "cancellation_reason": read_string(payload, &["cancellation_reason", "cancellationReason"]),
        "created_at": now,
        "updated_at": now,
    })
}

fn patch_reservation_caches(db: &db::DbState, reservation: &Value) -> Result<(), String> {
    let reservation_id = read_string(reservation, &["id"]).unwrap_or_default();
    patch_cached_admin_paths(db, "/api/pos/reservations", |path, data| {
        let mut changed = false;
        if let Some(items) = get_array_mut_path(data, &["reservations"]) {
            upsert_array_record(items, reservation);
            changed = true;
        }
        if !reservation_id.is_empty() && path.ends_with(&format!("/{}", reservation_id)) {
            if let Some(object) = data.as_object_mut() {
                object.insert("reservation".to_string(), reservation.clone());
                changed = true;
            }
        }
        Ok(changed)
    })
}

#[tauri::command]
pub async fn offline_reservation_create(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let reservation = build_local_reservation(&db, &payload);
    let reservation_id = read_string(&reservation, &["id"]).unwrap_or_default();
    patch_reservation_caches(&db, &reservation)?;

    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "reservations",
            &reservation_id,
            "INSERT",
            &payload,
            "hospitality",
            "manual",
        )?
    };

    let _ = app.emit(
        "reservation_updated",
        json!({
            "reservation": reservation,
            "queued": true,
            "queueId": queue_id,
        }),
    );
    emit_queue_hint(&app, "hospitality");

    Ok(json!({
        "success": true,
        "data": {
            "reservation": reservation,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

#[tauri::command]
pub async fn offline_reservation_update(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let reservation_id = read_string(&payload, &["reservationId", "reservation_id", "id"])
        .ok_or_else(|| "Missing reservation id".to_string())?;
    let mut reservation = build_local_reservation(&db, &payload);
    if let Some(object) = reservation.as_object_mut() {
        set_object_field(object, "id", Value::String(reservation_id.clone()));
    }
    patch_reservation_caches(&db, &reservation)?;

    let mut queue_object = payload.as_object().cloned().unwrap_or_default();
    queue_object.insert("id".to_string(), Value::String(reservation_id.clone()));
    let queue_payload = Value::Object(queue_object);
    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "reservations",
            &reservation_id,
            "UPDATE",
            &queue_payload,
            "hospitality",
            "manual",
        )?
    };

    let _ = app.emit(
        "reservation_updated",
        json!({
            "reservation": reservation,
            "queued": true,
            "queueId": queue_id,
        }),
    );
    emit_queue_hint(&app, "hospitality");

    Ok(json!({
        "success": true,
        "data": {
            "reservation": reservation,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

fn default_end_time(start_time: &str, duration_minutes: i64) -> String {
    let parsed = chrono::DateTime::parse_from_rfc3339(start_time)
        .map(|value| value.with_timezone(&Utc));
    match parsed {
        Ok(start) => (start + ChronoDuration::minutes(duration_minutes)).to_rfc3339(),
        Err(_) => start_time.to_string(),
    }
}

fn build_local_appointment(db: &db::DbState, payload: &Value) -> Value {
    let now = now_rfc3339();
    let appointment_id = read_string(payload, &["id"]).unwrap_or_else(|| temp_id("appointment"));
    let start_time = read_string(payload, &["start_time", "startTime"]).unwrap_or_else(now_rfc3339);
    let duration_minutes = read_i64(payload, &["total_duration_minutes", "duration_minutes"]).unwrap_or(30);
    let end_time = read_string(payload, &["end_time", "endTime"])
        .unwrap_or_else(|| default_end_time(&start_time, duration_minutes));
    json!({
        "id": appointment_id,
        "organization_id": organization_id(db, payload),
        "branch_id": branch_id(db, payload),
        "customer_id": read_string(payload, &["customer_id", "customerId"]),
        "customer_name": read_string(payload, &["customer_name", "customerName"]),
        "customer_phone": read_string(payload, &["customer_phone", "customerPhone"]),
        "customer_email": read_string(payload, &["customer_email", "customerEmail"]),
        "staff_id": read_string(payload, &["staff_id", "staffId"]),
        "service_id": read_string(payload, &["service_id", "serviceId"]),
        "start_time": start_time,
        "end_time": end_time,
        "status": read_string(payload, &["status"]).unwrap_or_else(|| "scheduled".to_string()),
        "notes": read_string(payload, &["notes"]),
        "created_at": now,
        "updated_at": now,
        "is_multi_service": payload.get("services").and_then(Value::as_array).map(|rows| !rows.is_empty()).unwrap_or(false),
        "total_duration_minutes": duration_minutes,
        "total_price": read_f64(payload, &["total_price", "totalPrice"]),
        "appointment_services": payload.get("services").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "appointment_resources": payload.get("resources").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
    })
}

fn patch_appointment_caches(db: &db::DbState, appointment: &Value) -> Result<(), String> {
    let appointment_id = read_string(appointment, &["id"]).unwrap_or_default();
    patch_cached_admin_paths(db, "/api/pos/appointments", |path, data| {
        let mut changed = false;
        if let Some(items) = get_array_mut_path(data, &["appointments"]) {
            upsert_array_record(items, appointment);
            changed = true;
        }
        if !appointment_id.is_empty() && path.ends_with(&format!("/{}", appointment_id)) {
            if let Some(object) = data.as_object_mut() {
                object.insert("appointment".to_string(), appointment.clone());
                changed = true;
            }
        }
        Ok(changed)
    })
}

#[tauri::command]
pub async fn offline_appointment_create(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let appointment = build_local_appointment(&db, &payload);
    let appointment_id = read_string(&appointment, &["id"]).unwrap_or_default();
    patch_appointment_caches(&db, &appointment)?;

    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "appointments",
            &appointment_id,
            "INSERT",
            &payload,
            "salon",
            "manual",
        )?
    };

    let _ = app.emit(
        "appointment_updated",
        json!({
            "appointment": appointment,
            "queued": true,
            "queueId": queue_id,
        }),
    );
    emit_queue_hint(&app, "salon");

    Ok(json!({
        "success": true,
        "data": {
            "appointment": appointment,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

#[tauri::command]
pub async fn offline_appointment_update_status(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let appointment_id = read_string(&payload, &["appointmentId", "appointment_id", "id"])
        .ok_or_else(|| "Missing appointment id".to_string())?;
    let status = read_string(&payload, &["status"]).ok_or_else(|| "Missing appointment status".to_string())?;
    let mut appointment = build_local_appointment(&db, &payload);
    if let Some(object) = appointment.as_object_mut() {
        set_object_field(object, "id", Value::String(appointment_id.clone()));
        set_object_field(object, "status", Value::String(status.clone()));
    }
    patch_appointment_caches(&db, &appointment)?;

    let queue_payload = json!({
        "id": appointment_id,
        "status": status,
        "cancellation_reason": read_string(&payload, &["cancellation_reason", "cancellationReason"]),
    });
    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "appointments",
            queue_payload.get("id").and_then(Value::as_str).unwrap_or_default(),
            "UPDATE",
            &queue_payload,
            "salon",
            "manual",
        )?
    };

    let _ = app.emit(
        "appointment_updated",
        json!({
            "appointment": appointment,
            "queued": true,
            "queueId": queue_id,
        }),
    );
    emit_queue_hint(&app, "salon");

    Ok(json!({
        "success": true,
        "data": {
            "appointment": appointment,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

fn patch_staff_schedule_cache(
    db: &db::DbState,
    branch: &str,
    shift: &Value,
) -> Result<(), String> {
    patch_branch_cache_rows(db, branch, "staff_schedule", |_scope_key, payload| {
        let Some(shifts) = get_array_mut_path(payload, &["shifts"]) else {
            return false;
        };
        upsert_array_record(shifts, shift);
        true
    })
}

#[tauri::command]
pub async fn offline_staff_shift_create(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let branch = branch_id(&db, &payload);
    if branch.trim().is_empty() {
        return Err("Missing branch id".to_string());
    }
    let now = now_rfc3339();
    let shift = json!({
        "id": temp_id("shift"),
        "staff_id": read_string(&payload, &["staff_id", "staffId"]).ok_or_else(|| "Missing staff_id".to_string())?,
        "start_time": read_string(&payload, &["start_time", "startTime"]).ok_or_else(|| "Missing start_time".to_string())?,
        "end_time": read_string(&payload, &["end_time", "endTime"]).ok_or_else(|| "Missing end_time".to_string())?,
        "notes": read_string(&payload, &["notes"]),
        "status": read_string(&payload, &["status"]).unwrap_or_else(|| "scheduled".to_string()),
        "branch_id": branch,
        "organization_id": organization_id(&db, &payload),
        "created_at": now,
        "updated_at": now,
    });
    patch_staff_schedule_cache(&db, &branch, &shift)?;

    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "salon_staff_shifts",
            shift.get("id").and_then(Value::as_str).unwrap_or_default(),
            "INSERT",
            &payload,
            "salon",
            "manual",
        )?
    };

    let _ = app.emit(
        "staff_schedule_updated",
        json!({
            "shift": shift,
            "queued": true,
            "queueId": queue_id,
        }),
    );
    emit_queue_hint(&app, "salon");

    Ok(json!({
        "success": true,
        "data": {
            "shift": shift,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

fn patch_drive_thru_cache(
    db: &db::DbState,
    order_id: &str,
    status: &str,
) -> Result<Option<Value>, String> {
    let mut updated: Option<Value> = None;
    patch_cached_admin_paths(db, "/api/pos/drive-through", |_path, data| {
        let Some(items) = get_array_mut_path(data, &["orders"]) else {
            return Ok(false);
        };
        let now = now_rfc3339();
        let result = update_array_record(items, order_id, |object| {
            set_object_field(object, "status", Value::String(status.to_string()));
            set_object_field(object, "updated_at", Value::String(now.clone()));
            if status == "served" {
                set_object_field(object, "served_at", Value::String(now.clone()));
            }
        });
        if let Some(value) = result {
            updated = Some(value);
            return Ok(true);
        }
        Ok(false)
    })?;
    Ok(updated)
}

#[tauri::command]
pub async fn offline_drive_thru_update_status(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let order_id = read_string(&payload, &["drive_through_order_id", "driveThruOrderId", "orderId", "id"])
        .ok_or_else(|| "Missing drive-through order id".to_string())?;
    let status = read_string(&payload, &["status"]).ok_or_else(|| "Missing drive-through status".to_string())?;
    let updated_order = patch_drive_thru_cache(&db, &order_id, &status)?;
    let queue_payload = json!({
        "drive_through_order_id": order_id,
        "status": status,
        "organization_id": organization_id(&db, &payload),
        "branch_id": branch_id(&db, &payload),
    });
    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "drive_thru_orders",
            queue_payload
                .get("drive_through_order_id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            "UPDATE",
            &queue_payload,
            "fast_food",
            "server-wins",
        )?
    };

    emit_queue_hint(&app, "fast_food");
    Ok(json!({
        "success": true,
        "data": {
            "order": updated_order,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

fn patch_rooms_cache(db: &db::DbState, room_id: &str, status: &str) -> Result<Option<Value>, String> {
    let mut updated: Option<Value> = None;
    patch_cached_admin_paths(db, "/api/pos/rooms", |_path, data| {
        let Some(items) = get_array_mut_path(data, &["rooms"]) else {
            return Ok(false);
        };
        let result = update_array_record(items, room_id, |object| {
            set_object_field(object, "status", Value::String(status.to_string()));
            set_object_field(object, "updated_at", Value::String(now_rfc3339()));
        });
        if let Some(value) = result {
            updated = Some(value);
            return Ok(true);
        }
        Ok(false)
    })?;
    Ok(updated)
}

#[tauri::command]
pub async fn offline_room_update_status(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let room_id = read_string(&payload, &["roomId", "room_id", "id"])
        .ok_or_else(|| "Missing room id".to_string())?;
    let status = read_string(&payload, &["status"]).ok_or_else(|| "Missing room status".to_string())?;
    let updated_room = patch_rooms_cache(&db, &room_id, &status)?;
    let queue_payload = json!({
        "room_id": room_id,
        "status": status,
        "organization_id": organization_id(&db, &payload),
        "branch_id": branch_id(&db, &payload),
    });
    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "rooms",
            queue_payload.get("room_id").and_then(Value::as_str).unwrap_or_default(),
            "UPDATE",
            &queue_payload,
            "hospitality",
            "manual",
        )?
    };

    emit_queue_hint(&app, "hospitality");
    Ok(json!({
        "success": true,
        "data": {
            "room": updated_room,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

fn patch_housekeeping_cache(
    db: &db::DbState,
    task_id: &str,
    field: &str,
    value: Value,
) -> Result<Option<Value>, String> {
    let mut updated: Option<Value> = None;
    patch_cached_admin_paths(db, "/api/pos/housekeeping", |_path, data| {
        let Some(items) = get_array_mut_path(data, &["tasks"]) else {
            return Ok(false);
        };
        let result = update_array_record(items, task_id, |object| {
            set_object_field(object, field, value.clone());
            set_object_field(object, "updated_at", Value::String(now_rfc3339()));
        });
        if let Some(value) = result {
            updated = Some(value);
            return Ok(true);
        }
        Ok(false)
    })?;
    Ok(updated)
}

#[tauri::command]
pub async fn offline_housekeeping_update_status(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let task_id = read_string(&payload, &["taskId", "task_id", "id"])
        .ok_or_else(|| "Missing housekeeping task id".to_string())?;
    let status = read_string(&payload, &["status"]).ok_or_else(|| "Missing housekeeping status".to_string())?;
    let updated_task = patch_housekeeping_cache(&db, &task_id, "status", Value::String(status.clone()))?;
    let queue_payload = json!({
        "task_id": task_id,
        "status": status,
        "organization_id": organization_id(&db, &payload),
        "branch_id": branch_id(&db, &payload),
    });
    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "housekeeping_tasks",
            queue_payload.get("task_id").and_then(Value::as_str).unwrap_or_default(),
            "UPDATE",
            &queue_payload,
            "hospitality",
            "manual",
        )?
    };

    emit_queue_hint(&app, "hospitality");
    Ok(json!({
        "success": true,
        "data": {
            "task": updated_task,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

#[tauri::command]
pub async fn offline_housekeeping_assign_staff(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let task_id = read_string(&payload, &["taskId", "task_id", "id"])
        .ok_or_else(|| "Missing housekeeping task id".to_string())?;
    let staff_id = payload
        .get("assigned_staff_id")
        .or_else(|| payload.get("assignedStaffId"))
        .cloned()
        .unwrap_or(Value::Null);
    let updated_task = patch_housekeeping_cache(&db, &task_id, "assigned_staff_id", staff_id.clone())?;
    let queue_payload = json!({
        "id": task_id,
        "assigned_staff_id": staff_id,
        "organization_id": organization_id(&db, &payload),
        "branch_id": branch_id(&db, &payload),
    });
    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "housekeeping_tasks",
            queue_payload.get("id").and_then(Value::as_str).unwrap_or_default(),
            "UPDATE",
            &queue_payload,
            "hospitality",
            "manual",
        )?
    };

    emit_queue_hint(&app, "hospitality");
    Ok(json!({
        "success": true,
        "data": {
            "task": updated_task,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

fn patch_products_cache(
    db: &db::DbState,
    product_id: &str,
    quantity: i64,
) -> Result<Option<Value>, String> {
    let mut updated: Option<Value> = None;
    for prefix in ["/api/pos/products", "/api/pos/products/low-stock"] {
        patch_cached_admin_paths(db, prefix, |_path, data| {
            let Some(items) = get_array_mut_path(data, &["products"]) else {
                return Ok(false);
            };
            let result = update_array_record(items, product_id, |object| {
                set_object_field(object, "quantity", Value::from(quantity));
                set_object_field(object, "updated_at", Value::String(now_rfc3339()));
            });
            if let Some(value) = result {
                updated = Some(value);
                return Ok(true);
            }
            Ok(false)
        })?;
    }
    Ok(updated)
}

#[tauri::command]
pub async fn offline_product_update_quantity(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let product_id = read_string(&payload, &["productId", "product_id", "id"])
        .ok_or_else(|| "Missing product id".to_string())?;
    let quantity = read_i64(&payload, &["quantity"]).ok_or_else(|| "Missing quantity".to_string())?;
    let updated_product = patch_products_cache(&db, &product_id, quantity)?;
    let queue_payload = json!({
        "quantity": quantity,
        "organization_id": organization_id(&db, &payload),
        "branch_id": branch_id(&db, &payload),
    });
    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "products",
            &product_id,
            "UPDATE",
            &queue_payload,
            "inventory",
            "manual",
        )?
    };

    emit_queue_hint(&app, "inventory");
    Ok(json!({
        "success": true,
        "data": {
            "product": updated_product,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}
