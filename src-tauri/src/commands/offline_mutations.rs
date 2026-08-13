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

fn update_array_record<F>(items: &mut [Value], record_id: &str, mut updater: F) -> Option<Value>
where
    F: FnMut(&mut Map<String, Value>),
{
    for item in items.iter_mut() {
        let item_id = item
            .get("id")
            .or_else(|| item.get("product_id"))
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
        let mut payload = serde_json::from_str::<Value>(&payload_json)
            .map_err(|e| format!("parse cache: {e}"))?;
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
    adjustment: i64,
) -> Result<Option<Value>, String> {
    let mut updated: Option<Value> = None;
    patch_cached_admin_paths(db, "/api/pos/inventory", |_path, data| {
        let items = if let Some(items) = get_array_mut_path(data, &["inventory"]) {
            items
        } else if let Some(items) = get_array_mut_path(data, &["data"]) {
            items
        } else {
            return Ok(false);
        };
        let now = now_rfc3339();
        let result = update_array_record(items, product_id, |object| {
            let current = object
                .get("stock_quantity")
                .or_else(|| object.get("quantity"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let next_quantity = current.saturating_add(adjustment);
            set_object_field(object, "stock_quantity", Value::from(next_quantity));
            set_object_field(object, "quantity", Value::from(next_quantity));
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
        object
            .entry("usage_count".to_string())
            .or_insert(Value::from(0));
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
            queue_payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
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
    let parsed =
        chrono::DateTime::parse_from_rfc3339(start_time).map(|value| value.with_timezone(&Utc));
    match parsed {
        Ok(start) => (start + ChronoDuration::minutes(duration_minutes)).to_rfc3339(),
        Err(_) => start_time.to_string(),
    }
}

fn build_local_appointment(db: &db::DbState, payload: &Value) -> Value {
    let now = now_rfc3339();
    let appointment_id = read_string(payload, &["id"]).unwrap_or_else(|| temp_id("appointment"));
    let start_time = read_string(payload, &["start_time", "startTime"]).unwrap_or_else(now_rfc3339);
    let duration_minutes =
        read_i64(payload, &["total_duration_minutes", "duration_minutes"]).unwrap_or(30);
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
    let status = read_string(&payload, &["status"])
        .ok_or_else(|| "Missing appointment status".to_string())?;
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
            queue_payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
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

fn patch_staff_schedule_cache(db: &db::DbState, branch: &str, shift: &Value) -> Result<(), String> {
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
        "break_start": read_string(&payload, &["break_start", "breakStart"]),
        "break_end": read_string(&payload, &["break_end", "breakEnd"]),
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
    let order_id = read_string(
        &payload,
        &[
            "drive_through_order_id",
            "driveThruOrderId",
            "orderId",
            "id",
        ],
    )
    .ok_or_else(|| "Missing drive-through order id".to_string())?;
    let status = read_string(&payload, &["status"])
        .ok_or_else(|| "Missing drive-through status".to_string())?;
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

fn patch_rooms_cache(
    db: &db::DbState,
    room_id: &str,
    status: &str,
) -> Result<Option<Value>, String> {
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
    let status =
        read_string(&payload, &["status"]).ok_or_else(|| "Missing room status".to_string())?;
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
            queue_payload
                .get("room_id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
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

/// Capture an offline room check-in: patch the cached `/api/pos/rooms`
/// entry to `occupied` and enqueue a `room_checkins` parity item whose
/// `record_id` is the exactly-once replay key (`client_request_id`).
///
/// The replay key is generated at capture time when the caller did not
/// supply one and is persisted inside the queued payload so it survives
/// restarts — the server's `POST /api/pos/rooms/{roomId}/checkin` keys
/// idempotent replay on `clientRequestId`.
fn capture_room_checkin(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    let room_id = read_string(payload, &["roomId", "room_id"])
        .ok_or_else(|| "Missing room id".to_string())?;
    let guest_name = read_string(payload, &["guestName", "guest_name"])
        .ok_or_else(|| "Missing guest name".to_string())?;
    let check_in_date = read_string(payload, &["checkInDate", "check_in_date"])
        .ok_or_else(|| "Missing check-in date".to_string())?;
    let check_out_date = read_string(payload, &["checkOutDate", "check_out_date"])
        .ok_or_else(|| "Missing check-out date".to_string())?;
    let client_request_id = read_string(payload, &["clientRequestId", "client_request_id"])
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let updated_room = patch_rooms_cache(db, &room_id, "occupied")?;

    let queue_payload = json!({
        "room_id": room_id,
        "guest_name": guest_name,
        "guest_phone": read_string(payload, &["guestPhone", "guest_phone"]),
        "guest_email": read_string(payload, &["guestEmail", "guest_email"]),
        "check_in_date": check_in_date,
        "check_out_date": check_out_date,
        "party_size": read_i64(payload, &["partySize", "party_size"]),
        "notes": read_string(payload, &["notes"]),
        "client_request_id": client_request_id.clone(),
        "organization_id": organization_id(db, payload),
        "branch_id": branch_id(db, payload),
    });

    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "room_checkins",
            &client_request_id,
            "INSERT",
            &queue_payload,
            "hospitality",
            "manual",
        )?
    };

    Ok(json!({
        "success": true,
        "data": {
            "room": updated_room,
            "clientRequestId": client_request_id,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

#[tauri::command]
pub async fn offline_room_checkin(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let response = capture_room_checkin(&db, &payload)?;
    emit_queue_hint(&app, "hospitality");
    Ok(response)
}

/// Capture an offline goods receipt against a purchase order
/// (procurement-loop Task 10.3) and enqueue a `po_receipts` parity item
/// whose `record_id` is the exactly-once replay key (the capture-time
/// `idempotency_key`).
///
/// The idempotency key (UUID) and `recorded_at` are generated AT CAPTURE
/// when the caller did not supply them and are persisted inside the queued
/// payload so they survive restarts — replay sends the stored key as the
/// `Idempotency-Key` header (see `sync_queue::prepare_po_receipt_request`)
/// so crash-retry duplicates collapse server-side to one effect
/// [R11.2, R11.3, R11.4].
///
/// No local cache is patched here: the pending-sync overlay derives from
/// the queue row itself (renderer `po-receipt-queue.ts`), so the cached
/// PO snapshot stays a faithful mirror of the server and the optimistic
/// adjustment can never double-count after replay.
fn capture_po_receipt(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    let purchase_order_id = read_string(payload, &["purchaseOrderId", "purchase_order_id"])
        .ok_or_else(|| "Missing purchase order id".to_string())?;
    let staff_id = read_string(payload, &["staffId", "staff_id"])
        .ok_or_else(|| "Missing staff id".to_string())?;
    let lines = payload
        .get("lines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if lines.is_empty() {
        return Err("Missing receipt lines".to_string());
    }
    for line in &lines {
        let quantity = read_f64(line, &["quantityReceived", "quantity_received"]);
        if !matches!(quantity, Some(value) if value != 0.0) {
            return Err("Receipt lines must carry a non-zero quantityReceived".to_string());
        }
        let has_target = read_string(line, &["purchaseOrderItemId", "purchase_order_item_id"])
            .is_some()
            || line.get("unplanned").map(Value::is_object).unwrap_or(false);
        if !has_target {
            return Err(
                "Receipt lines must reference a purchase order item or an unplanned catalog item"
                    .to_string(),
            );
        }
    }
    let idempotency_key = read_string(payload, &["idempotencyKey", "idempotency_key"])
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let recorded_at =
        read_string(payload, &["recordedAt", "recorded_at"]).unwrap_or_else(now_rfc3339);
    let kind = read_string(payload, &["kind"]).unwrap_or_else(|| "delivery".to_string());

    let queue_payload = json!({
        "purchase_order_id": purchase_order_id,
        "idempotency_key": idempotency_key.clone(),
        "recorded_at": recorded_at.clone(),
        "staff_id": staff_id,
        "source": "pos_desktop",
        "kind": kind,
        "notes": read_string(payload, &["notes"]),
        // Kept in the shared camelCase ReceiptCommitRequest line shape;
        // replay passes them through to the server untouched.
        "lines": lines,
        "organization_id": organization_id(db, payload),
        "branch_id": branch_id(db, payload),
    });

    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "po_receipts",
            &idempotency_key,
            "INSERT",
            &queue_payload,
            "suppliers",
            "manual",
        )?
    };

    Ok(json!({
        "success": true,
        "data": {
            "idempotencyKey": idempotency_key,
            "recordedAt": recorded_at,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

#[tauri::command]
pub async fn offline_po_receipt(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let response = capture_po_receipt(&db, &payload)?;
    let _ = app.emit(
        "po_receipt_queued",
        json!({
            "purchaseOrderId": read_string(&payload, &["purchaseOrderId", "purchase_order_id"]),
            "queueId": response
                .get("data")
                .and_then(|data| data.get("queueId"))
                .cloned(),
            "queued": true,
        }),
    );
    emit_queue_hint(&app, "suppliers");
    Ok(response)
}

/// Queue a reviewed scanned invoice for replay when the connection drops at the
/// Save moment (invoice-scan-capture Task 11.3, design surface D-Rust5).
///
/// Built on the `po_receipt` precedent, with one difference that matters: the
/// replay key is **not** minted here. It is the capture id — the id the pages
/// were staged under and the id the server's commit claim is keyed on — so the
/// same document committed twice (crash, lost ack, impatient retry) converges on
/// one invoice and one stock effect no matter which path got there first [R9.5].
///
/// `recorded_at` and `staff_id` are likewise captured HERE, at Save time, and
/// persisted inside the queued payload: replay must record who saved the invoice
/// and when they saved it, not who happened to be signed in when the queue
/// finally drained [R13.2].
///
/// The three blocks the server reads (`draft`, `capture`, `poLinkage`) are stored
/// in their camelCase wire shape and replayed untouched — the renderer built them
/// for the online call, and the offline path must not be a second, divergent
/// serializer of the same invoice.
fn capture_supplier_import_commit(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    let draft = payload
        .get("draft")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| "Missing import draft".to_string())?;

    let capture = payload
        .get("capture")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| "Missing capture details".to_string())?;
    let mut capture = capture;

    let capture_value = Value::Object(capture.clone());
    let capture_id = read_string(&capture_value, &["captureId", "capture_id"])
        .or_else(|| read_string(payload, &["captureId", "capture_id"]))
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "Missing capture id".to_string())?;
    let source_kind = read_string(&capture_value, &["sourceKind", "source_kind"])
        .ok_or_else(|| "Missing capture source".to_string())?;
    let captured_at = read_string(&capture_value, &["capturedAt", "captured_at"])
        .ok_or_else(|| "Missing capture time".to_string())?;

    let staff_id = read_string(payload, &["staffId", "staff_id"])
        .or_else(|| {
            read_string(
                &capture_value,
                &["committedByStaffId", "committed_by_staff_id"],
            )
        })
        .ok_or_else(|| "Missing staff id".to_string())?;
    // Save time, not drain time [R13.2].
    let recorded_at =
        read_string(payload, &["recordedAt", "recorded_at"]).unwrap_or_else(now_rfc3339);

    capture.insert("captureId".to_string(), Value::String(capture_id.clone()));
    capture.insert("sourceKind".to_string(), Value::String(source_kind));
    capture.insert("capturedAt".to_string(), Value::String(captured_at));
    capture
        .entry("committedByStaffId".to_string())
        .or_insert_with(|| Value::String(staff_id.clone()));

    let po_linkage = payload
        .get("poLinkage")
        .or_else(|| payload.get("po_linkage"))
        .and_then(Value::as_object)
        .cloned();
    if let Some(linkage) = po_linkage.as_ref() {
        let linkage_value = Value::Object(linkage.clone());
        let purchase_order_id =
            read_string(&linkage_value, &["purchaseOrderId", "purchase_order_id"])
                .ok_or_else(|| "Missing purchase order id".to_string())?;
        if Uuid::parse_str(&purchase_order_id).is_err() {
            return Err("Purchase order id must be a uuid".to_string());
        }
        let mode = read_string(&linkage_value, &["mode"]).unwrap_or_default();
        if mode != "confirm_existing" && mode != "record_delivery" {
            return Err("Unsupported purchase order linkage mode".to_string());
        }
    }

    let queue_payload = json!({
        // The capture id IS the replay key; both spellings are stored so the
        // queue's generic header lookup and the request builder read the same
        // value even if one of them is refactored.
        "capture_id": capture_id.clone(),
        "idempotency_key": capture_id.clone(),
        "recorded_at": recorded_at.clone(),
        "staff_id": staff_id,
        "source": "pos_desktop",
        // Kept in the shared camelCase commit-request shape; replay passes them
        // to the server untouched.
        "draft": draft,
        "capture": Value::Object(capture),
        "po_linkage": po_linkage.map(Value::Object).unwrap_or(Value::Null),
        "organization_id": organization_id(db, payload),
        "branch_id": branch_id(db, payload),
    });

    let queue_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        enqueue_parity_item(
            &conn,
            "supplier_import_commits",
            &capture_id,
            "INSERT",
            &queue_payload,
            "suppliers",
            "manual",
        )?
    };

    Ok(json!({
        "success": true,
        "data": {
            "captureId": capture_id,
            "idempotencyKey": capture_id,
            "recordedAt": recorded_at,
            "queueId": queue_id,
            "queued": true,
        }
    }))
}

#[tauri::command]
pub async fn offline_supplier_import_commit(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = object_payload(arg0, arg1)?;
    let response = capture_supplier_import_commit(&db, &payload)?;
    emit_queue_hint(&app, "suppliers");
    Ok(response)
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
    let status = read_string(&payload, &["status"])
        .ok_or_else(|| "Missing housekeeping status".to_string())?;
    let updated_task =
        patch_housekeeping_cache(&db, &task_id, "status", Value::String(status.clone()))?;
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
            queue_payload
                .get("task_id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
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
    let updated_task =
        patch_housekeeping_cache(&db, &task_id, "assigned_staff_id", staff_id.clone())?;
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
            queue_payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
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
    let quantity =
        read_i64(&payload, &["quantity"]).ok_or_else(|| "Missing quantity".to_string())?;
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

#[cfg(test)]
mod offline_room_checkin_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Real schema via the production migration chain + the parity queue
    /// DDL (`sync_queue::create_tables`) — never inline fake schemas.
    fn test_db_state() -> db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        db::run_migrations_for_test(&conn);
        sync_queue::create_tables(&conn).expect("create parity queue tables");
        db::DbState {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    fn seed_rooms_cache(db: &db::DbState, path: &str) {
        let response = json!({
            "success": true,
            "rooms": [
                {
                    "id": "room-1",
                    "room_number": "101",
                    "status": "available",
                    "updated_at": "2026-01-01T00:00:00Z",
                },
                {
                    "id": "room-2",
                    "room_number": "102",
                    "status": "available",
                    "updated_at": "2026-01-01T00:00:00Z",
                },
            ],
        });
        cache_admin_get_response(db, path, &response).expect("seed rooms cache");
    }

    /// Org + branch included inline so the helpers never fall through to
    /// the OS keyring (`storage::get_credential`) during tests.
    fn base_payload() -> Value {
        json!({
            "room_id": "room-1",
            "guest_name": "Maria Papadopoulou",
            "check_in_date": "2026-06-12",
            "check_out_date": "2026-06-14",
            "organization_id": "org-room-checkin",
            "branch_id": "branch-room-checkin",
        })
    }

    fn read_queue_row(
        db: &db::DbState,
    ) -> (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    ) {
        let conn = db.conn.lock().expect("db lock");
        conn.query_row(
            "SELECT table_name, record_id, operation, data, organization_id,
                    module_type, conflict_strategy, status
             FROM parity_sync_queue",
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
        .expect("exactly one parity queue row")
    }

    fn room_status(cached: &Value, room_id: &str) -> String {
        cached
            .get("rooms")
            .and_then(Value::as_array)
            .and_then(|rooms| {
                rooms
                    .iter()
                    .find(|room| room.get("id").and_then(Value::as_str) == Some(room_id))
            })
            .and_then(|room| room.get("status"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn room_checkin_patches_all_cached_rooms_paths_to_occupied() {
        let db = test_db_state();
        seed_rooms_cache(&db, "/api/pos/rooms");
        seed_rooms_cache(&db, "/api/pos/rooms?branch_id=branch-room-checkin");

        let response = capture_room_checkin(&db, &base_payload()).expect("capture check-in");

        for path in [
            "/api/pos/rooms",
            "/api/pos/rooms?branch_id=branch-room-checkin",
        ] {
            let (cached, _) =
                read_cached_admin_get_response(&db, path).expect("rooms cache present");
            assert_eq!(room_status(&cached, "room-1"), "occupied");
            assert_eq!(room_status(&cached, "room-2"), "available");
        }

        assert_eq!(response.get("success").and_then(Value::as_bool), Some(true));
        let data = response.get("data").expect("data envelope");
        assert_eq!(
            data.get("room")
                .and_then(|room| room.get("status"))
                .and_then(Value::as_str),
            Some("occupied")
        );
        assert_eq!(data.get("queued").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn room_checkin_enqueue_row_shape_with_generated_client_request_id() {
        let db = test_db_state();
        seed_rooms_cache(&db, "/api/pos/rooms");

        let response = capture_room_checkin(&db, &base_payload()).expect("capture check-in");
        let generated = response
            .get("data")
            .and_then(|data| data.get("clientRequestId"))
            .and_then(Value::as_str)
            .expect("clientRequestId in response")
            .to_string();
        Uuid::parse_str(&generated).expect("generated client_request_id must be a uuid");

        let (
            table_name,
            record_id,
            operation,
            data,
            organization_id,
            module_type,
            conflict_strategy,
            status,
        ) = read_queue_row(&db);
        assert_eq!(table_name, "room_checkins");
        assert_eq!(record_id, generated);
        assert_eq!(operation, "INSERT");
        assert_eq!(organization_id, "org-room-checkin");
        assert_eq!(module_type, "hospitality");
        assert_eq!(conflict_strategy, "manual");
        assert_eq!(status, "pending");

        // Payload round-trip: the replay key is persisted in the queued
        // payload (must survive restarts), alongside the capture fields.
        let queued: Value = serde_json::from_str(&data).expect("queued payload parses");
        assert_eq!(
            queued.get("client_request_id").and_then(Value::as_str),
            Some(generated.as_str())
        );
        assert_eq!(
            queued.get("room_id").and_then(Value::as_str),
            Some("room-1")
        );
        assert_eq!(
            queued.get("guest_name").and_then(Value::as_str),
            Some("Maria Papadopoulou")
        );
        assert_eq!(
            queued.get("check_in_date").and_then(Value::as_str),
            Some("2026-06-12")
        );
        assert_eq!(
            queued.get("check_out_date").and_then(Value::as_str),
            Some("2026-06-14")
        );
        assert_eq!(
            queued.get("branch_id").and_then(Value::as_str),
            Some("branch-room-checkin")
        );
        // Optional capture fields are present as explicit nulls.
        assert_eq!(queued.get("guest_phone"), Some(&Value::Null));
        assert_eq!(queued.get("guest_email"), Some(&Value::Null));
        assert_eq!(queued.get("party_size"), Some(&Value::Null));
        assert_eq!(queued.get("notes"), Some(&Value::Null));
    }

    #[test]
    fn room_checkin_preserves_caller_client_request_id_and_optionals() {
        let db = test_db_state();
        seed_rooms_cache(&db, "/api/pos/rooms");

        let mut payload = base_payload();
        let object = payload.as_object_mut().expect("payload object");
        object.insert(
            "client_request_id".to_string(),
            json!("5e0e7c6a-9f1d-4d5c-8a3b-2f4f6f8d9a1b"),
        );
        object.insert("guest_phone".to_string(), json!("+30 694 000 0000"));
        object.insert("guest_email".to_string(), json!("maria@example.com"));
        object.insert("party_size".to_string(), json!(3));
        object.insert("notes".to_string(), json!("Late arrival"));

        let response = capture_room_checkin(&db, &payload).expect("capture check-in");
        assert_eq!(
            response
                .get("data")
                .and_then(|data| data.get("clientRequestId"))
                .and_then(Value::as_str),
            Some("5e0e7c6a-9f1d-4d5c-8a3b-2f4f6f8d9a1b")
        );

        let (_, record_id, _, data, _, _, _, _) = read_queue_row(&db);
        assert_eq!(record_id, "5e0e7c6a-9f1d-4d5c-8a3b-2f4f6f8d9a1b");

        let queued: Value = serde_json::from_str(&data).expect("queued payload parses");
        assert_eq!(
            queued.get("client_request_id").and_then(Value::as_str),
            Some("5e0e7c6a-9f1d-4d5c-8a3b-2f4f6f8d9a1b")
        );
        assert_eq!(
            queued.get("guest_phone").and_then(Value::as_str),
            Some("+30 694 000 0000")
        );
        assert_eq!(
            queued.get("guest_email").and_then(Value::as_str),
            Some("maria@example.com")
        );
        assert_eq!(queued.get("party_size").and_then(Value::as_i64), Some(3));
        assert_eq!(
            queued.get("notes").and_then(Value::as_str),
            Some("Late arrival")
        );
    }

    #[test]
    fn room_checkin_enqueues_even_when_rooms_cache_is_cold() {
        let db = test_db_state();

        let response = capture_room_checkin(&db, &base_payload()).expect("capture check-in");
        let data = response.get("data").expect("data envelope");
        assert_eq!(data.get("room"), Some(&Value::Null));
        assert_eq!(data.get("queued").and_then(Value::as_bool), Some(true));

        let (table_name, _, operation, _, _, _, _, status) = read_queue_row(&db);
        assert_eq!(table_name, "room_checkins");
        assert_eq!(operation, "INSERT");
        assert_eq!(status, "pending");
    }

    #[test]
    fn room_checkin_validates_required_fields() {
        let db = test_db_state();

        let cases: [(&str, &str); 4] = [
            ("room_id", "Missing room id"),
            ("guest_name", "Missing guest name"),
            ("check_in_date", "Missing check-in date"),
            ("check_out_date", "Missing check-out date"),
        ];
        for (field, expected_error) in cases {
            let mut payload = base_payload();
            payload
                .as_object_mut()
                .expect("payload object")
                .remove(field);
            let error =
                capture_room_checkin(&db, &payload).expect_err("missing required field must fail");
            assert!(
                error.contains(expected_error),
                "expected '{expected_error}' in '{error}'"
            );
        }

        let conn = db.conn.lock().expect("db lock");
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
                row.get(0)
            })
            .expect("count queue rows");
        assert_eq!(queued, 0, "validation failures must not enqueue");
    }
}

#[cfg(test)]
mod offline_po_receipt_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Real schema via the production migration chain + the parity queue
    /// DDL (`sync_queue::create_tables`) — never inline fake schemas.
    fn test_db_state() -> db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        db::run_migrations_for_test(&conn);
        sync_queue::create_tables(&conn).expect("create parity queue tables");
        db::DbState {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    /// Org + branch included inline so the helpers never fall through to
    /// the OS keyring (`storage::get_credential`) during tests. Lines use
    /// the shared camelCase ReceiptCommitRequest shape the renderer sends.
    fn base_payload() -> Value {
        json!({
            "purchaseOrderId": "33333333-3333-4333-8333-333333333333",
            "staffId": "44444444-4444-4444-8444-444444444444",
            "lines": [
                {
                    "purchaseOrderItemId": "55555555-5555-4555-8555-555555555555",
                    "quantityReceived": 6,
                    "unitCost": 2.4,
                },
            ],
            "notes": "Back-door delivery",
            "organization_id": "org-po-receipt",
            "branch_id": "branch-po-receipt",
        })
    }

    fn read_queue_row(
        db: &db::DbState,
    ) -> (String, String, String, String, String, String, String) {
        let conn = db.conn.lock().expect("db lock");
        conn.query_row(
            "SELECT table_name, record_id, operation, data, organization_id,
                    module_type, conflict_strategy
             FROM parity_sync_queue",
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
        .expect("exactly one parity queue row")
    }

    #[test]
    fn po_receipt_enqueue_row_shape_with_capture_time_key_and_recorded_at() {
        let db = test_db_state();

        let response = capture_po_receipt(&db, &base_payload()).expect("capture receipt");
        let data = response.get("data").expect("data envelope");
        let generated_key = data
            .get("idempotencyKey")
            .and_then(Value::as_str)
            .expect("idempotencyKey in response")
            .to_string();
        Uuid::parse_str(&generated_key).expect("generated idempotency_key must be a uuid");
        let recorded_at = data
            .get("recordedAt")
            .and_then(Value::as_str)
            .expect("recordedAt in response")
            .to_string();
        chrono::DateTime::parse_from_rfc3339(&recorded_at)
            .expect("capture-time recorded_at must be RFC3339");
        assert_eq!(data.get("queued").and_then(Value::as_bool), Some(true));

        let (table_name, record_id, operation, queued_data, organization_id, module_type, strategy) =
            read_queue_row(&db);
        assert_eq!(table_name, "po_receipts");
        assert_eq!(record_id, generated_key, "record_id mirrors the replay key");
        assert_eq!(operation, "INSERT");
        assert_eq!(organization_id, "org-po-receipt");
        assert_eq!(module_type, "suppliers");
        assert_eq!(
            strategy, "manual",
            "409 PO_STATE_CONFLICT must reach staff review, never auto-resolve"
        );

        // Durability round-trip: key + recorded_at + lines live ON THE
        // QUEUE ROW so they survive app restarts [R11.2, R11.3].
        let queued: Value = serde_json::from_str(&queued_data).expect("queued payload parses");
        assert_eq!(
            queued.get("idempotency_key").and_then(Value::as_str),
            Some(generated_key.as_str())
        );
        assert_eq!(
            queued.get("recorded_at").and_then(Value::as_str),
            Some(recorded_at.as_str())
        );
        assert_eq!(
            queued.get("purchase_order_id").and_then(Value::as_str),
            Some("33333333-3333-4333-8333-333333333333")
        );
        assert_eq!(
            queued.get("staff_id").and_then(Value::as_str),
            Some("44444444-4444-4444-8444-444444444444")
        );
        assert_eq!(
            queued.get("source").and_then(Value::as_str),
            Some("pos_desktop")
        );
        assert_eq!(queued.get("kind").and_then(Value::as_str), Some("delivery"));
        assert_eq!(
            queued["lines"][0]["purchaseOrderItemId"],
            json!("55555555-5555-4555-8555-555555555555")
        );
        assert_eq!(queued["lines"][0]["quantityReceived"], json!(6));
    }

    #[test]
    fn po_receipt_preserves_caller_supplied_key_and_capture_time() {
        // The receive dialog generates key + recorded_at at capture and the
        // online path may have already sent them; re-queuing after a network
        // failure must reuse them so the server collapses the duplicate.
        let db = test_db_state();

        let mut payload = base_payload();
        let object = payload.as_object_mut().expect("payload object");
        object.insert(
            "idempotencyKey".to_string(),
            json!("7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"),
        );
        object.insert("recordedAt".to_string(), json!("2026-08-05T10:15:00+00:00"));
        object.insert("kind".to_string(), json!("correction"));

        let response = capture_po_receipt(&db, &payload).expect("capture receipt");
        let data = response.get("data").expect("data envelope");
        assert_eq!(
            data.get("idempotencyKey").and_then(Value::as_str),
            Some("7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
        );
        assert_eq!(
            data.get("recordedAt").and_then(Value::as_str),
            Some("2026-08-05T10:15:00+00:00")
        );

        let (_, record_id, _, queued_data, _, _, _) = read_queue_row(&db);
        assert_eq!(record_id, "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
        let queued: Value = serde_json::from_str(&queued_data).expect("queued payload parses");
        assert_eq!(
            queued.get("recorded_at").and_then(Value::as_str),
            Some("2026-08-05T10:15:00+00:00")
        );
        assert_eq!(
            queued.get("kind").and_then(Value::as_str),
            Some("correction")
        );
    }

    #[test]
    fn po_receipt_validates_required_fields_without_enqueueing() {
        let db = test_db_state();

        // Missing purchase order / staff.
        for (field, expected_error) in [
            ("purchaseOrderId", "Missing purchase order id"),
            ("staffId", "Missing staff id"),
            ("lines", "Missing receipt lines"),
        ] {
            let mut payload = base_payload();
            payload
                .as_object_mut()
                .expect("payload object")
                .remove(field);
            let error =
                capture_po_receipt(&db, &payload).expect_err("missing required field must fail");
            assert!(
                error.contains(expected_error),
                "expected '{expected_error}' in '{error}'"
            );
        }

        // Zero-quantity and targetless lines are refused at capture.
        let mut zero_quantity = base_payload();
        zero_quantity["lines"][0]["quantityReceived"] = json!(0);
        let error = capture_po_receipt(&db, &zero_quantity).expect_err("zero quantity must fail");
        assert!(error.contains("non-zero"), "unexpected error: {error}");

        let mut targetless = base_payload();
        targetless["lines"] = json!([{ "quantityReceived": 2 }]);
        let error = capture_po_receipt(&db, &targetless).expect_err("targetless line must fail");
        assert!(
            error.contains("purchase order item"),
            "unexpected error: {error}"
        );

        let conn = db.conn.lock().expect("db lock");
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
                row.get(0)
            })
            .expect("count queue rows");
        assert_eq!(queued, 0, "validation failures must not enqueue");
    }
}

#[cfg(test)]
mod offline_supplier_import_commit_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    const CAPTURE_ID: &str = "8b2c1d4e-5f60-4a7b-9c8d-0e1f2a3b4c5d";
    const PO_ID: &str = "66666666-6666-4666-8666-666666666666";
    const STAFF_ID: &str = "77777777-7777-4777-8777-777777777777";

    /// Real schema via the production migration chain + the parity queue
    /// DDL (`sync_queue::create_tables`) — never inline fake schemas.
    fn test_db_state() -> db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        db::run_migrations_for_test(&conn);
        sync_queue::create_tables(&conn).expect("create parity queue tables");
        db::DbState {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    /// Org + branch inline so the helpers never fall through to the OS
    /// keyring during tests. `draft`, `capture` and `poLinkage` are the exact
    /// blocks the online commit call sends.
    fn base_payload() -> Value {
        json!({
            "draft": {
                "supplierName": "Fresh Produce Ltd",
                "invoiceNumber": "INV-2026-118",
                "rows": [
                    { "rowNumber": 1, "name": "Tomatoes", "quantity": 6, "unitCost": 1.25 }
                ],
            },
            "capture": {
                "captureId": CAPTURE_ID,
                "sourceKind": "watched_folder",
                "sourceName": "Back office scans",
                "capturedAt": "2026-08-05T18:02:00+00:00",
                "capturedByStaffId": STAFF_ID,
                "storageKeys": ["org-capture/branch-capture/captures/x/page-000.png"],
            },
            "poLinkage": {
                "purchaseOrderId": PO_ID,
                "mode": "confirm_existing",
            },
            "staffId": STAFF_ID,
            "organization_id": "org-capture",
            "branch_id": "branch-capture",
        })
    }

    fn read_queue_row(
        db: &db::DbState,
    ) -> (String, String, String, String, String, String, String) {
        let conn = db.conn.lock().expect("db lock");
        conn.query_row(
            "SELECT table_name, record_id, operation, data, organization_id,
                    module_type, conflict_strategy
             FROM parity_sync_queue",
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
        .expect("exactly one parity queue row")
    }

    #[test]
    fn supplier_import_commit_enqueues_under_the_capture_id_as_its_replay_key() {
        let db = test_db_state();

        let response =
            capture_supplier_import_commit(&db, &base_payload()).expect("capture commit");
        let data = response.get("data").expect("data envelope");
        assert_eq!(
            data.get("captureId").and_then(Value::as_str),
            Some(CAPTURE_ID)
        );
        // The replay key is NOT minted here — it IS the capture id, which is
        // what the server commit claim is keyed on [R9.5].
        assert_eq!(
            data.get("idempotencyKey").and_then(Value::as_str),
            Some(CAPTURE_ID),
        );
        let recorded_at = data
            .get("recordedAt")
            .and_then(Value::as_str)
            .expect("recordedAt in response");
        chrono::DateTime::parse_from_rfc3339(recorded_at)
            .expect("capture-time recorded_at must be RFC3339");
        assert_eq!(data.get("queued").and_then(Value::as_bool), Some(true));

        let (table_name, record_id, operation, queued_data, organization_id, module_type, strategy) =
            read_queue_row(&db);
        assert_eq!(table_name, "supplier_import_commits");
        assert_eq!(record_id, CAPTURE_ID, "record_id mirrors the replay key");
        assert_eq!(operation, "INSERT");
        assert_eq!(organization_id, "org-capture");
        assert_eq!(module_type, "suppliers");
        assert_eq!(
            strategy, "manual",
            "a rejected invoice must reach staff review, never auto-resolve"
        );

        // Durability round-trip: the invoice, its provenance and the linkage
        // live ON THE QUEUE ROW so they survive app restarts [R11.6, R17.3].
        let queued: Value = serde_json::from_str(&queued_data).expect("queued payload parses");
        assert_eq!(
            queued.get("capture_id").and_then(Value::as_str),
            Some(CAPTURE_ID)
        );
        assert_eq!(
            queued.get("idempotency_key").and_then(Value::as_str),
            Some(CAPTURE_ID)
        );
        assert_eq!(
            queued.get("recorded_at").and_then(Value::as_str),
            Some(recorded_at)
        );
        assert_eq!(
            queued.get("staff_id").and_then(Value::as_str),
            Some(STAFF_ID)
        );
        assert_eq!(queued["draft"]["rows"][0]["name"], json!("Tomatoes"));
        assert_eq!(queued["capture"]["sourceKind"], json!("watched_folder"));
        assert_eq!(
            queued["capture"]["capturedAt"],
            json!("2026-08-05T18:02:00+00:00")
        );
        // Who pressed Save is recorded at Save time, not at drain time [R13.2].
        assert_eq!(queued["capture"]["committedByStaffId"], json!(STAFF_ID));
        assert_eq!(queued["po_linkage"]["purchaseOrderId"], json!(PO_ID));
    }

    #[test]
    fn supplier_import_commit_preserves_a_caller_supplied_save_time_and_saver() {
        let db = test_db_state();

        let mut payload = base_payload();
        payload["recordedAt"] = json!("2026-08-05T18:30:00+00:00");
        payload["capture"]["committedByStaffId"] = json!("99999999-9999-4999-8999-999999999999");

        capture_supplier_import_commit(&db, &payload).expect("capture commit");
        let (_, _, _, queued_data, _, _, _) = read_queue_row(&db);
        let queued: Value = serde_json::from_str(&queued_data).expect("queued payload parses");
        assert_eq!(
            queued.get("recorded_at").and_then(Value::as_str),
            Some("2026-08-05T18:30:00+00:00"),
        );
        assert_eq!(
            queued["capture"]["committedByStaffId"],
            json!("99999999-9999-4999-8999-999999999999"),
            "an explicitly named saver is never overwritten",
        );
    }

    #[test]
    fn a_commit_without_a_purchase_order_is_queued_unlinked() {
        let db = test_db_state();

        let mut payload = base_payload();
        payload
            .as_object_mut()
            .expect("payload object")
            .remove("poLinkage");

        capture_supplier_import_commit(&db, &payload).expect("capture unlinked commit");
        let (_, _, _, queued_data, _, _, _) = read_queue_row(&db);
        let queued: Value = serde_json::from_str(&queued_data).expect("queued payload parses");
        assert_eq!(
            queued.get("po_linkage"),
            Some(&Value::Null),
            "PO linkage is optional — declining it must not block Save",
        );
    }

    #[test]
    fn supplier_import_commit_validation_failures_never_enqueue() {
        let db = test_db_state();

        for (field, expected_error) in [("draft", "draft"), ("capture", "capture")] {
            let mut payload = base_payload();
            payload
                .as_object_mut()
                .expect("payload object")
                .remove(field);
            let error = capture_supplier_import_commit(&db, &payload)
                .expect_err("missing required field must fail");
            assert!(
                error.contains(expected_error),
                "expected '{expected_error}' in '{error}'"
            );
        }

        // Provenance the server enum would reject, and a PO id that would
        // reach a procurement RPC, are refused at capture rather than queued
        // to dead-letter later.
        let mut without_capture_time = base_payload();
        without_capture_time["capture"]
            .as_object_mut()
            .expect("capture object")
            .remove("capturedAt");
        let error = capture_supplier_import_commit(&db, &without_capture_time)
            .expect_err("missing capture time must fail");
        assert!(error.contains("capture time"), "unexpected error: {error}");

        let mut without_staff = base_payload();
        without_staff
            .as_object_mut()
            .expect("payload object")
            .remove("staffId");
        without_staff["capture"]
            .as_object_mut()
            .expect("capture object")
            .remove("committedByStaffId");
        let error = capture_supplier_import_commit(&db, &without_staff)
            .expect_err("missing staff id must fail");
        assert!(error.contains("staff id"), "unexpected error: {error}");

        let mut bad_po = base_payload();
        bad_po["poLinkage"]["purchaseOrderId"] = json!("../escape");
        let error = capture_supplier_import_commit(&db, &bad_po).expect_err("bad PO id must fail");
        assert!(error.contains("uuid"), "unexpected error: {error}");

        let mut bad_mode = base_payload();
        bad_mode["poLinkage"]["mode"] = json!("just_link_it");
        let error = capture_supplier_import_commit(&db, &bad_mode).expect_err("bad mode must fail");
        assert!(error.contains("linkage mode"), "unexpected error: {error}");

        let conn = db.conn.lock().expect("db lock");
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
                row.get(0)
            })
            .expect("count queue rows");
        assert_eq!(queued, 0, "validation failures must not enqueue");
    }
}
