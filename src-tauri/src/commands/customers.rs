use chrono::Utc;
use serde::Deserialize;
use tauri::Emitter;

use crate::{
    db, normalize_phone, payload_arg0_as_string, read_local_json_array, value_i64, value_str,
    write_local_json,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomerLookupPayload {
    #[serde(alias = "customer_id", alias = "id")]
    customer_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomerPhonePayload {
    #[serde(alias = "customerPhone", alias = "mobile", alias = "telephone")]
    phone: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomerSearchPayload {
    #[serde(alias = "q", alias = "term", alias = "search")]
    query: String,
}

#[derive(Debug)]
struct CustomerUpdatePayload {
    customer_id: String,
    updates: serde_json::Value,
    expected_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomerBanPayload {
    #[serde(alias = "customer_id", alias = "id")]
    customer_id: String,
    #[serde(default, alias = "is_banned")]
    is_banned: bool,
}

#[derive(Debug)]
struct CustomerAddressPayload {
    customer_id: String,
    address: serde_json::Value,
}

#[derive(Debug)]
struct CustomerUpdateAddressPayload {
    target_id: String,
    updates: serde_json::Value,
    expected_version: i64,
}

#[derive(Debug)]
struct CustomerResolveConflictPayload {
    conflict_id: String,
    strategy: String,
    data: serde_json::Value,
}

fn parse_lookup_payload(
    arg0: Option<serde_json::Value>,
    err_msg: &str,
) -> Result<CustomerLookupPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(customer_id)) => serde_json::json!({
            "customerId": customer_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let mut parsed: CustomerLookupPayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid customer id payload: {e}"))?;
    parsed.customer_id = parsed.customer_id.trim().to_string();
    if parsed.customer_id.is_empty() {
        return Err(err_msg.to_string());
    }
    Ok(parsed)
}

fn parse_phone_payload(arg0: Option<serde_json::Value>) -> Result<CustomerPhonePayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(phone)) => serde_json::json!({
            "phone": phone
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let mut parsed: CustomerPhonePayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid phone payload: {e}"))?;
    parsed.phone = parsed.phone.trim().to_string();
    if parsed.phone.is_empty() {
        return Err("Missing phone".into());
    }
    Ok(parsed)
}

fn parse_search_payload(arg0: Option<serde_json::Value>) -> CustomerSearchPayload {
    let payload = match arg0 {
        Some(serde_json::Value::String(query)) => serde_json::json!({
            "query": query
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => serde_json::json!({
            "query": v.to_string()
        }),
        None => serde_json::json!({
            "query": ""
        }),
    };
    let mut parsed: CustomerSearchPayload =
        serde_json::from_value(payload).unwrap_or_else(|_| CustomerSearchPayload {
            query: String::new(),
        });
    parsed.query = parsed.query.trim().to_string();
    parsed
}

fn parse_customer_update_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
) -> Result<CustomerUpdatePayload, String> {
    let base = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(customer_id)) => serde_json::json!({
            "customerId": customer_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let customer_id =
        payload_arg0_as_string(Some(base.clone()), &["customerId", "customer_id", "id"])
            .ok_or("Missing customerId")?;

    let updates = arg1
        .or_else(|| base.get("updates").cloned())
        .unwrap_or_else(|| serde_json::json!({}));
    if !updates.is_object() {
        return Err("updates must be an object".into());
    }

    let expected_version = match arg2 {
        Some(serde_json::Value::Number(num)) => num.as_i64().unwrap_or(0),
        Some(serde_json::Value::String(num)) => num.parse::<i64>().unwrap_or(0),
        Some(serde_json::Value::Object(obj)) => value_i64(
            &serde_json::Value::Object(obj),
            &["currentVersion", "current_version", "version"],
        )
        .unwrap_or(0),
        Some(_) => 0,
        None => value_i64(&base, &["currentVersion", "current_version", "version"]).unwrap_or(0),
    };

    Ok(CustomerUpdatePayload {
        customer_id,
        updates,
        expected_version,
    })
}

fn parse_customer_ban_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<CustomerBanPayload, String> {
    let payload = match (arg0, arg1) {
        (
            Some(serde_json::Value::String(customer_id)),
            Some(serde_json::Value::Bool(is_banned)),
        ) => {
            serde_json::json!({
                "customerId": customer_id,
                "isBanned": is_banned
            })
        }
        (Some(serde_json::Value::Object(mut obj)), Some(serde_json::Value::Bool(is_banned))) => {
            obj.insert("isBanned".to_string(), serde_json::Value::Bool(is_banned));
            serde_json::Value::Object(obj)
        }
        (Some(v), None) => v,
        (Some(v), Some(_)) => v,
        (None, Some(v)) => v,
        (None, None) => serde_json::json!({}),
    };

    let mut parsed: CustomerBanPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid customer ban payload: {e}"))?;
    parsed.customer_id = parsed.customer_id.trim().to_string();
    if parsed.customer_id.is_empty() {
        return Err("Missing customerId".into());
    }
    Ok(parsed)
}

fn parse_customer_address_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<CustomerAddressPayload, String> {
    let base = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(customer_id)) => serde_json::json!({
            "customerId": customer_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let customer_id =
        payload_arg0_as_string(Some(base.clone()), &["customerId", "customer_id", "id"])
            .ok_or("Missing customerId")?;
    let address = arg1
        .or_else(|| base.get("address").cloned())
        .unwrap_or_else(|| serde_json::json!({}));
    if !address.is_object() {
        return Err("address must be an object".into());
    }

    Ok(CustomerAddressPayload {
        customer_id,
        address,
    })
}

fn parse_customer_update_address_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
) -> Result<CustomerUpdateAddressPayload, String> {
    let base = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(target_id)) => serde_json::json!({
            "targetId": target_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let target_id = payload_arg0_as_string(
        Some(base.clone()),
        &[
            "targetId",
            "addressId",
            "address_id",
            "customerId",
            "customer_id",
            "id",
        ],
    )
    .ok_or("Missing customerId/addressId")?;

    let updates = arg1
        .or_else(|| base.get("updates").cloned())
        .unwrap_or_else(|| serde_json::json!({}));
    if !updates.is_object() {
        return Err("updates must be an object".into());
    }

    let expected_version = match arg2 {
        Some(serde_json::Value::Number(num)) => num.as_i64().unwrap_or(0),
        Some(serde_json::Value::String(num)) => num.parse::<i64>().unwrap_or(0),
        Some(serde_json::Value::Object(obj)) => value_i64(
            &serde_json::Value::Object(obj),
            &["expectedVersion", "expected_version", "version"],
        )
        .unwrap_or(0),
        Some(_) => 0,
        None => value_i64(&base, &["expectedVersion", "expected_version", "version"]).unwrap_or(0),
    };

    Ok(CustomerUpdateAddressPayload {
        target_id,
        updates,
        expected_version,
    })
}

fn parse_customer_resolve_conflict_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
) -> Result<CustomerResolveConflictPayload, String> {
    let base = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(conflict_id)) => serde_json::json!({
            "conflictId": conflict_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let conflict_id =
        payload_arg0_as_string(Some(base.clone()), &["conflictId", "conflict_id", "id"])
            .ok_or("Missing conflictId")?;
    let strategy = arg1
        .and_then(|v| v.as_str().map(|s| s.trim().to_string()))
        .or_else(|| value_str(&base, &["strategy"]))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "server_wins".to_string());
    let data = arg2
        .or_else(|| base.get("data").cloned())
        .unwrap_or_else(|| serde_json::json!({}));

    Ok(CustomerResolveConflictPayload {
        conflict_id,
        strategy,
        data,
    })
}

#[tauri::command]
pub async fn customer_get_cache_stats(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    Ok(serde_json::json!({
        "total": cache.len(),
        "valid": cache.len(),
        "expired": 0
    }))
}

#[tauri::command]
pub async fn customer_clear_cache(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let existing = read_local_json_array(&db, "customer_cache_v1")?;
    let count = existing.len();
    write_local_json(&db, "customer_cache_v1", &serde_json::json!([]))?;
    let _ = app.emit("customer_deleted", serde_json::json!({ "count": count }));
    Ok(serde_json::json!({ "success": true, "cleared": count }))
}

#[tauri::command]
pub async fn customer_invalidate_cache(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_phone_payload(arg0)?;
    let phone = payload.phone;
    let phone_norm = normalize_phone(&phone);
    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    let before = cache.len();
    cache.retain(|entry| {
        let p = value_str(entry, &["phone", "customerPhone", "mobile", "telephone"])
            .map(|s| normalize_phone(&s))
            .unwrap_or_default();
        p != phone_norm
    });
    let removed = before.saturating_sub(cache.len());
    write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
    if removed > 0 {
        let _ = app.emit(
            "customer_deleted",
            serde_json::json!({ "removed": removed }),
        );
    }
    Ok(serde_json::json!({ "success": true, "removed": removed }))
}

#[tauri::command]
pub async fn customer_lookup_by_phone(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_phone_payload(arg0)?;
    let phone = payload.phone;
    let phone_norm = normalize_phone(&phone);
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    if let Some(found) = cache.into_iter().find(|entry| {
        value_str(entry, &["phone", "customerPhone", "mobile", "telephone"])
            .map(|s| normalize_phone(&s))
            .map(|s| s == phone_norm)
            .unwrap_or(false)
    }) {
        return Ok(found);
    }

    // Fallback from local orders history.
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT customer_name, customer_phone, customer_email
             FROM orders
             WHERE customer_phone IS NOT NULL
               AND replace(replace(replace(replace(customer_phone, '-', ''), ' ', ''), '(', ''), ')', '') LIKE ?1
             ORDER BY updated_at DESC
             LIMIT 1",
            rusqlite::params![format!("%{phone_norm}%")],
            |row| {
                Ok(serde_json::json!({
                    "id": format!("cust-{}", uuid::Uuid::new_v4()),
                    "name": row.get::<_, Option<String>>(0)?,
                    "phone": row.get::<_, Option<String>>(1)?,
                    "email": row.get::<_, Option<String>>(2)?,
                    "source": "orders_fallback"
                }))
            },
        )
        .ok();
    Ok(row.unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn customer_lookup_by_id(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_lookup_payload(arg0, "Missing customerId")?;
    let customer_id = payload.customer_id;
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    let found = cache.into_iter().find(|entry| {
        value_str(entry, &["id", "customerId"])
            .map(|id| id == customer_id)
            .unwrap_or(false)
    });
    Ok(found.unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn customer_search(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let query = parse_search_payload(arg0).query.to_lowercase();
    if query.is_empty() {
        return Ok(serde_json::json!([]));
    }
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    let matches: Vec<serde_json::Value> = cache
        .into_iter()
        .filter(|entry| {
            let name = value_str(entry, &["name", "fullName"])
                .unwrap_or_default()
                .to_lowercase();
            let phone = value_str(entry, &["phone", "customerPhone"])
                .unwrap_or_default()
                .to_lowercase();
            let email = value_str(entry, &["email"])
                .unwrap_or_default()
                .to_lowercase();
            name.contains(&query) || phone.contains(&query) || email.contains(&query)
        })
        .collect();
    Ok(serde_json::json!(matches))
}

#[tauri::command]
pub async fn customer_create(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let mut customer = payload;
    let customer_id = value_str(&customer, &["id", "customerId"])
        .unwrap_or_else(|| format!("cust-{}", uuid::Uuid::new_v4()));
    if let Some(obj) = customer.as_object_mut() {
        obj.insert("id".to_string(), serde_json::json!(customer_id));
        obj.entry("version".to_string())
            .or_insert(serde_json::json!(1));
        obj.entry("createdAt".to_string())
            .or_insert(serde_json::json!(Utc::now().to_rfc3339()));
        obj.insert(
            "updatedAt".to_string(),
            serde_json::json!(Utc::now().to_rfc3339()),
        );
        obj.entry("addresses".to_string())
            .or_insert(serde_json::json!([]));
    }
    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    cache.retain(|entry| {
        value_str(entry, &["id", "customerId"])
            .map(|id| id != customer_id)
            .unwrap_or(true)
    });
    cache.push(customer.clone());
    write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
    let _ = app.emit("customer_created", customer.clone());
    let _ = app.emit("customer_realtime_update", customer.clone());
    Ok(serde_json::json!({ "success": true, "data": customer }))
}

#[tauri::command]
pub async fn customer_update(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_update_payload(arg0, arg1, arg2)?;
    let customer_id = payload.customer_id;
    let updates = payload.updates;
    let expected_version = payload.expected_version;
    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;

    let mut updated_customer: Option<serde_json::Value> = None;
    let mut conflict: Option<serde_json::Value> = None;
    for entry in &mut cache {
        let id = value_str(entry, &["id", "customerId"]).unwrap_or_default();
        if id != customer_id {
            continue;
        }
        let current_version = entry.get("version").and_then(|v| v.as_i64()).unwrap_or(1);
        if expected_version > 0 && expected_version != current_version {
            conflict = Some(serde_json::json!({
                "id": format!("cc-{}", uuid::Uuid::new_v4()),
                "customerId": customer_id,
                "expectedVersion": expected_version,
                "currentVersion": current_version,
                "updates": updates
            }));
            break;
        }
        if let (Some(dst), Some(src)) = (entry.as_object_mut(), updates.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
            dst.insert(
                "version".to_string(),
                serde_json::json!(current_version + 1),
            );
            dst.insert(
                "updatedAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
        }
        updated_customer = Some(entry.clone());
        break;
    }

    if let Some(conflict_payload) = conflict {
        let mut conflicts = read_local_json_array(&db, "customer_conflicts_v1")?;
        conflicts.push(conflict_payload.clone());
        write_local_json(
            &db,
            "customer_conflicts_v1",
            &serde_json::Value::Array(conflicts),
        )?;
        let _ = app.emit("customer_sync_conflict", conflict_payload.clone());
        return Ok(serde_json::json!({
            "success": false,
            "conflict": true,
            "error": "Version conflict",
            "data": conflict_payload
        }));
    }

    if let Some(customer) = updated_customer.clone() {
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
        return Ok(serde_json::json!({ "success": true, "data": customer }));
    }

    Err("Customer not found".into())
}

#[tauri::command]
pub async fn customer_update_ban_status(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_ban_payload(arg0, arg1)?;
    customer_update(
        Some(serde_json::json!(payload.customer_id)),
        Some(serde_json::json!({ "isBanned": payload.is_banned })),
        None,
        db,
        app,
    )
    .await
}

#[tauri::command]
pub async fn customer_add_address(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_address_payload(arg0, arg1)?;
    let customer_id = payload.customer_id;
    let mut address = payload.address;
    if let Some(obj) = address.as_object_mut() {
        obj.entry("id".to_string())
            .or_insert_with(|| serde_json::json!(format!("addr-{}", uuid::Uuid::new_v4())));
        obj.entry("createdAt".to_string())
            .or_insert_with(|| serde_json::json!(Utc::now().to_rfc3339()));
    }

    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    let mut updated: Option<serde_json::Value> = None;
    for entry in &mut cache {
        let id = value_str(entry, &["id", "customerId"]).unwrap_or_default();
        if id != customer_id {
            continue;
        }
        if let Some(obj) = entry.as_object_mut() {
            let addresses = obj
                .entry("addresses".to_string())
                .or_insert_with(|| serde_json::json!([]));
            if let Some(arr) = addresses.as_array_mut() {
                arr.push(address.clone());
            }
            let next_version = obj.get("version").and_then(|v| v.as_i64()).unwrap_or(1) + 1;
            obj.insert("version".to_string(), serde_json::json!(next_version));
            obj.insert(
                "updatedAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
            updated = Some(serde_json::Value::Object(obj.clone()));
        }
        break;
    }

    if let Some(customer) = updated.clone() {
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
        return Ok(serde_json::json!({ "success": true, "data": customer }));
    }
    Err("Customer not found".into())
}

#[tauri::command]
pub async fn customer_update_address(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_update_address_payload(arg0, arg1, arg2)?;
    let target_id = payload.target_id;
    let updates = payload.updates;
    let _expected_version = payload.expected_version;
    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    let mut updated: Option<serde_json::Value> = None;

    for entry in &mut cache {
        let customer_id = value_str(entry, &["id", "customerId"]).unwrap_or_default();
        if let Some(obj) = entry.as_object_mut() {
            let mut touched = customer_id == target_id;
            if let Some(addresses) = obj.get_mut("addresses").and_then(|v| v.as_array_mut()) {
                for addr in addresses {
                    let aid = value_str(addr, &["id", "addressId"]).unwrap_or_default();
                    if aid == target_id {
                        if let (Some(dst), Some(src)) = (addr.as_object_mut(), updates.as_object())
                        {
                            for (k, v) in src {
                                dst.insert(k.clone(), v.clone());
                            }
                        }
                        touched = true;
                        break;
                    }
                }
            }
            if touched {
                let next_version = obj.get("version").and_then(|v| v.as_i64()).unwrap_or(1) + 1;
                obj.insert("version".to_string(), serde_json::json!(next_version));
                obj.insert(
                    "updatedAt".to_string(),
                    serde_json::json!(Utc::now().to_rfc3339()),
                );
                updated = Some(serde_json::Value::Object(obj.clone()));
                break;
            }
        }
    }

    if let Some(customer) = updated.clone() {
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
        return Ok(serde_json::json!({ "success": true, "data": customer }));
    }
    Err("Customer/address not found".into())
}

#[tauri::command]
pub async fn customer_get_conflicts(
    _arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conflicts = read_local_json_array(&db, "customer_conflicts_v1")?;
    Ok(serde_json::json!(conflicts))
}

#[tauri::command]
pub async fn customer_resolve_conflict(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_resolve_conflict_payload(arg0, arg1, arg2)?;
    let conflict_id = payload.conflict_id;
    let strategy = payload.strategy;
    let data = payload.data;
    let mut conflicts = read_local_json_array(&db, "customer_conflicts_v1")?;
    let mut resolved: Option<serde_json::Value> = None;
    conflicts.retain(|entry| {
        let id = value_str(entry, &["id", "conflictId"]).unwrap_or_default();
        if id == conflict_id {
            resolved = Some(entry.clone());
            false
        } else {
            true
        }
    });
    write_local_json(
        &db,
        "customer_conflicts_v1",
        &serde_json::Value::Array(conflicts),
    )?;

    if let Some(conflict) = resolved.clone() {
        if strategy == "merge" || strategy == "client_wins" {
            if let Some(customer_id) = value_str(&conflict, &["customerId", "customer_id"]) {
                let _ = customer_update(
                    Some(serde_json::json!(customer_id)),
                    Some(data),
                    None,
                    db,
                    app.clone(),
                )
                .await;
            }
        }
        let _ = app.emit(
            "customer_conflict_resolved",
            serde_json::json!({
                "conflictId": conflict_id,
                "strategy": strategy
            }),
        );
        return Ok(serde_json::json!({ "success": true }));
    }
    Ok(serde_json::json!({ "success": false, "error": "Conflict not found" }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_phone_payload_supports_string_and_alias() {
        let from_string = parse_phone_payload(Some(serde_json::json!("2101234567")))
            .expect("string phone payload should parse");
        let from_alias = parse_phone_payload(Some(serde_json::json!({
            "customerPhone": " 6999999999 "
        })))
        .expect("alias phone payload should parse");
        assert_eq!(from_string.phone, "2101234567");
        assert_eq!(from_alias.phone, "6999999999");
    }

    #[test]
    fn parse_customer_update_payload_supports_legacy_tuple() {
        let parsed = parse_customer_update_payload(
            Some(serde_json::json!("cust-1")),
            Some(serde_json::json!({ "name": "Updated" })),
            Some(serde_json::json!(7)),
        )
        .expect("customer update tuple payload should parse");
        assert_eq!(parsed.customer_id, "cust-1");
        assert_eq!(parsed.expected_version, 7);
        assert_eq!(
            parsed.updates.get("name").and_then(|v| v.as_str()),
            Some("Updated")
        );
    }

    #[test]
    fn parse_customer_ban_payload_supports_legacy_args() {
        let parsed = parse_customer_ban_payload(
            Some(serde_json::json!("cust-2")),
            Some(serde_json::json!(true)),
        )
        .expect("customer ban tuple payload should parse");
        assert_eq!(parsed.customer_id, "cust-2");
        assert!(parsed.is_banned);
    }

    #[test]
    fn parse_customer_update_address_payload_supports_object() {
        let parsed = parse_customer_update_address_payload(
            Some(serde_json::json!({
                "addressId": "addr-1",
                "expectedVersion": 3
            })),
            Some(serde_json::json!({ "floor": "2" })),
            None,
        )
        .expect("address update payload should parse");
        assert_eq!(parsed.target_id, "addr-1");
        assert_eq!(parsed.expected_version, 3);
        assert_eq!(
            parsed.updates.get("floor").and_then(|v| v.as_str()),
            Some("2")
        );
    }

    #[test]
    fn parse_customer_resolve_conflict_payload_supports_legacy_tuple() {
        let parsed = parse_customer_resolve_conflict_payload(
            Some(serde_json::json!("conflict-1")),
            Some(serde_json::json!("client_wins")),
            Some(serde_json::json!({ "name": "Merged" })),
        )
        .expect("resolve conflict tuple payload should parse");
        assert_eq!(parsed.conflict_id, "conflict-1");
        assert_eq!(parsed.strategy, "client_wins");
        assert_eq!(
            parsed.data.get("name").and_then(|v| v.as_str()),
            Some("Merged")
        );
    }
}
