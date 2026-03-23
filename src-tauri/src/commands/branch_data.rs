use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{db, read_local_json, read_local_setting, read_module_cache, storage};

const CACHE_KEY_TABLES: &str = "tables";
const CACHE_KEY_STAFF_SCHEDULE: &str = "staff_schedule";
const CACHE_KEY_DELIVERY_ZONES: &str = "delivery_zones";
const CACHE_KEY_COUPONS: &str = "coupons";
const CACHE_KEY_CATALOG_OFFERS: &str = "catalog_offers";
const DELIVERY_ZONES_LOCAL_KEY: &str = "delivery_zones_cache_v1";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchScopedPayload {
    #[serde(default, alias = "branch_id")]
    branch_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StaffSchedulePayload {
    #[serde(default, alias = "branch_id")]
    branch_id: Option<String>,
    #[serde(default, alias = "start_date")]
    start_date: Option<String>,
    #[serde(default, alias = "end_date")]
    end_date: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CouponValidatePayload {
    #[serde(default)]
    code: Option<String>,
    #[serde(default, alias = "order_total")]
    order_total: Option<f64>,
    #[serde(default, alias = "branch_id")]
    branch_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogOffersPayload {
    #[serde(default, alias = "branch_id")]
    branch_id: Option<String>,
    #[serde(default, alias = "catalog_type")]
    catalog_type: Option<String>,
}

#[derive(Debug)]
struct CacheEntry {
    synced_at: String,
    version: Option<String>,
    payload: Value,
}

#[derive(Debug, Clone)]
struct DatasetStatus {
    cache_key: String,
    scope_key: String,
    synced_at: Option<String>,
    available: bool,
    source: &'static str,
    item_count: Option<usize>,
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_branch_id(db: &db::DbState, explicit: Option<String>) -> Result<String, String> {
    trimmed(explicit)
        .or_else(|| storage::get_credential("branch_id"))
        .or_else(|| read_local_setting(db, "terminal", "branch_id"))
        .ok_or_else(|| "Branch is not configured locally yet. Connect once to download local branch data.".to_string())
}

fn normalize_scope_key(values: &[Option<&str>]) -> String {
    let parts: Vec<&str> = values
        .iter()
        .copied()
        .flatten()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    if parts.is_empty() {
        "default".to_string()
    } else {
        parts.join("::")
    }
}

fn extract_payload(response: Value) -> Value {
    response.get("data").cloned().unwrap_or(response)
}

fn payload_version(payload: &Value) -> Option<String> {
    payload
        .get("version")
        .or_else(|| payload.get("timestamp"))
        .or_else(|| payload.get("updated_at"))
        .or_else(|| payload.get("updatedAt"))
        .or_else(|| payload.get("sync_timestamp"))
        .and_then(Value::as_str)
        .map(|value| value.to_string())
}

fn cache_payload(
    conn: &rusqlite::Connection,
    branch_id: &str,
    cache_key: &str,
    scope_key: &str,
    payload: &Value,
) -> Result<String, String> {
    let synced_at = Utc::now().to_rfc3339();
    let payload_json =
        serde_json::to_string(payload).map_err(|error| format!("serialize cache payload: {error}"))?;
    conn.execute(
        "INSERT INTO branch_ops_cache (branch_id, cache_key, scope_key, version, synced_at, payload_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(branch_id, cache_key, scope_key) DO UPDATE SET
            version = excluded.version,
            synced_at = excluded.synced_at,
            payload_json = excluded.payload_json",
        params![
            branch_id,
            cache_key,
            scope_key,
            payload_version(payload),
            synced_at,
            payload_json
        ],
    )
    .map_err(|error| format!("save branch ops cache: {error}"))?;
    Ok(synced_at)
}

fn read_cache_entry(
    conn: &rusqlite::Connection,
    branch_id: &str,
    cache_key: &str,
    scope_key: &str,
) -> Result<Option<CacheEntry>, String> {
    let row = conn
        .query_row(
            "SELECT synced_at, version, payload_json
             FROM branch_ops_cache
             WHERE branch_id = ?1 AND cache_key = ?2 AND scope_key = ?3
             LIMIT 1",
            params![branch_id, cache_key, scope_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read branch ops cache: {error}"))?;

    let Some((synced_at, version, payload_json)) = row else {
        return Ok(None);
    };

    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|error| format!("parse cached payload: {error}"))?;

    Ok(Some(CacheEntry {
        synced_at,
        version,
        payload,
    }))
}

fn cache_age_ms(synced_at: &str) -> Option<i64> {
    let parsed = DateTime::parse_from_rfc3339(synced_at).ok()?;
    Some((Utc::now() - parsed.with_timezone(&Utc)).num_milliseconds().max(0))
}

fn local_first_success(payload: Value, source: &str, synced_at: Option<String>, version: Option<String>) -> Value {
    json!({
        "success": true,
        "data": payload,
        "meta": {
            "source": source,
            "syncedAt": synced_at,
            "cacheAgeMs": synced_at.as_deref().and_then(cache_age_ms),
            "version": version,
        }
    })
}

fn cached_dataset_status(
    conn: &rusqlite::Connection,
    branch_id: &str,
    cache_key: &str,
    scope_key: &str,
) -> DatasetStatus {
    match read_cache_entry(conn, branch_id, cache_key, scope_key) {
        Ok(Some(entry)) => DatasetStatus {
            cache_key: cache_key.to_string(),
            scope_key: scope_key.to_string(),
            synced_at: Some(entry.synced_at),
            available: true,
            source: "branch_ops_cache",
            item_count: entry.payload.as_array().map(|items| items.len()).or_else(|| {
                entry
                    .payload
                    .as_object()
                    .and_then(|object| object.values().find_map(Value::as_array))
                    .map(|items| items.len())
            }),
        },
        _ => DatasetStatus {
            cache_key: cache_key.to_string(),
            scope_key: scope_key.to_string(),
            synced_at: None,
            available: false,
            source: "branch_ops_cache",
            item_count: None,
        },
    }
}

fn cached_dataset_status_latest(
    conn: &rusqlite::Connection,
    branch_id: &str,
    cache_key: &str,
) -> DatasetStatus {
    let row = conn
        .query_row(
            "SELECT scope_key, synced_at, payload_json
             FROM branch_ops_cache
             WHERE branch_id = ?1 AND cache_key = ?2
             ORDER BY synced_at DESC
             LIMIT 1",
            params![branch_id, cache_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional();

    match row {
        Ok(Some((scope_key, synced_at, payload_json))) => {
            let payload = serde_json::from_str::<Value>(&payload_json).unwrap_or(Value::Null);
            DatasetStatus {
                cache_key: cache_key.to_string(),
                scope_key,
                synced_at: Some(synced_at),
                available: !payload.is_null(),
                source: "branch_ops_cache",
                item_count: payload.as_array().map(|items| items.len()).or_else(|| {
                    payload
                        .as_object()
                        .and_then(|object| object.values().find_map(Value::as_array))
                        .map(|items| items.len())
                }),
            }
        }
        _ => DatasetStatus {
            cache_key: cache_key.to_string(),
            scope_key: "latest".to_string(),
            synced_at: None,
            available: false,
            source: "branch_ops_cache",
            item_count: None,
        },
    }
}

async fn fetch_branch_scoped_payload(
    db: &db::DbState,
    branch_id: &str,
    cache_key: &str,
    scope_key: &str,
    path: String,
) -> Result<Value, String> {
    match crate::admin_fetch(Some(db), &path, "GET", None).await {
        Ok(response) => {
            let payload = extract_payload(response);
            let synced_at = {
                let conn = db.conn.lock().map_err(|error| error.to_string())?;
                cache_payload(&conn, branch_id, cache_key, scope_key, &payload)?
            };
            Ok(local_first_success(
                payload,
                "remote",
                Some(synced_at),
                None,
            ))
        }
        Err(remote_error) => {
            let cached = {
                let conn = db.conn.lock().map_err(|error| error.to_string())?;
                read_cache_entry(&conn, branch_id, cache_key, scope_key)?
            };
            if let Some(entry) = cached {
                return Ok(local_first_success(
                    entry.payload,
                    "cache",
                    Some(entry.synced_at),
                    entry.version,
                ));
            }

            Err(format!(
                "{remote_error}. Connect once to download local branch data for offline use."
            ))
        }
    }
}

fn is_coupon_active(coupon: &Value) -> bool {
    coupon
        .get("is_active")
        .or_else(|| coupon.get("isActive"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn is_coupon_expired(coupon: &Value) -> bool {
    coupon
        .get("expires_at")
        .or_else(|| coupon.get("expiresAt"))
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|expires_at| expires_at.with_timezone(&Utc) < Utc::now())
        .unwrap_or(false)
}

fn coupon_usage_exhausted(coupon: &Value) -> bool {
    let usage_limit = coupon
        .get("usage_limit")
        .or_else(|| coupon.get("usageLimit"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if usage_limit <= 0 {
        return false;
    }
    let usage_count = coupon
        .get("usage_count")
        .or_else(|| coupon.get("usageCount"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    usage_count >= usage_limit
}

fn coupon_min_order_amount(coupon: &Value) -> f64 {
    coupon
        .get("min_order_amount")
        .or_else(|| coupon.get("minOrderAmount"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn normalize_coupon_discount(coupon: &Value, order_total: f64) -> f64 {
    let discount_type = coupon
        .get("discount_type")
        .or_else(|| coupon.get("discountType"))
        .and_then(Value::as_str)
        .unwrap_or("fixed");
    let discount_value = coupon
        .get("discount_value")
        .or_else(|| coupon.get("discountValue"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0);

    if discount_type.eq_ignore_ascii_case("percentage") {
        ((order_total * discount_value) / 100.0).max(0.0)
    } else {
        discount_value.min(order_total.max(0.0))
    }
}

fn coupons_from_payload(payload: &Value) -> Vec<Value> {
    payload
        .get("coupons")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
pub async fn branch_data_get_tables(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload: BranchScopedPayload = arg0
        .map(serde_json::from_value)
        .transpose()
        .unwrap_or_default()
        .unwrap_or_default();
    let branch_id = resolve_branch_id(&db, payload.branch_id)?;
    let path = format!("/api/pos/tables?branch_id={branch_id}");
    fetch_branch_scoped_payload(&db, &branch_id, CACHE_KEY_TABLES, "all", path).await
}

#[tauri::command]
pub async fn branch_data_get_staff_schedule(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload: StaffSchedulePayload = arg0
        .map(serde_json::from_value)
        .transpose()
        .unwrap_or_default()
        .unwrap_or_default();
    let branch_id = resolve_branch_id(&db, payload.branch_id)?;
    let scope_key = normalize_scope_key(&[
        payload.start_date.as_deref(),
        payload.end_date.as_deref(),
    ]);
    let mut query = vec![format!("branch_id={branch_id}")];
    if let Some(start_date) = trimmed(payload.start_date) {
        query.push(format!("start_date={start_date}"));
    }
    if let Some(end_date) = trimmed(payload.end_date) {
        query.push(format!("end_date={end_date}"));
    }
    let path = format!("/api/pos/staff-schedule?{}", query.join("&"));
    fetch_branch_scoped_payload(
        &db,
        &branch_id,
        CACHE_KEY_STAFF_SCHEDULE,
        &scope_key,
        path,
    )
    .await
}

#[tauri::command]
pub async fn branch_data_get_delivery_zones(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload: BranchScopedPayload = arg0
        .map(serde_json::from_value)
        .transpose()
        .unwrap_or_default()
        .unwrap_or_default();
    let branch_id = resolve_branch_id(&db, payload.branch_id)?;
    let path = format!("/api/pos/delivery-zones?branch_id={branch_id}");
    fetch_branch_scoped_payload(&db, &branch_id, CACHE_KEY_DELIVERY_ZONES, "all", path).await
}

#[tauri::command]
pub async fn branch_data_get_catalog_offers(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload: CatalogOffersPayload = arg0
        .map(serde_json::from_value)
        .transpose()
        .unwrap_or_default()
        .unwrap_or_default();
    let branch_id = resolve_branch_id(&db, payload.branch_id)?;
    let catalog_type = trimmed(payload.catalog_type).unwrap_or_else(|| "menu".to_string());
    let scope_key = normalize_scope_key(&[Some(catalog_type.as_str())]);
    let path = format!("/api/pos/offers?branch_id={branch_id}&catalog_type={catalog_type}");
    fetch_branch_scoped_payload(
        &db,
        &branch_id,
        CACHE_KEY_CATALOG_OFFERS,
        &scope_key,
        path,
    )
    .await
}

async fn get_coupons_local_first(
    db: &db::DbState,
    branch_id: &str,
) -> Result<Value, String> {
    fetch_branch_scoped_payload(
        db,
        branch_id,
        CACHE_KEY_COUPONS,
        "all",
        "/api/pos/coupons".to_string(),
    )
    .await
}

#[tauri::command]
pub async fn branch_data_validate_coupon(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload: CouponValidatePayload = arg0
        .map(serde_json::from_value)
        .transpose()
        .unwrap_or_default()
        .unwrap_or_default();
    let branch_id = resolve_branch_id(&db, payload.branch_id)?;
    let code = trimmed(payload.code).ok_or_else(|| "Coupon code is required".to_string())?;
    let order_total = payload.order_total.unwrap_or(0.0).max(0.0);
    let coupons_result = get_coupons_local_first(&db, &branch_id).await?;
    let coupons_payload = coupons_result
        .get("data")
        .cloned()
        .unwrap_or_else(|| json!({ "coupons": [] }));
    let coupons = coupons_from_payload(&coupons_payload);

    let matching_coupon = coupons.into_iter().find(|coupon| {
        coupon
            .get("code")
            .and_then(Value::as_str)
            .map(|candidate| candidate.eq_ignore_ascii_case(&code))
            .unwrap_or(false)
    });

    let Some(coupon) = matching_coupon else {
        return Ok(json!({
            "success": true,
            "data": {
                "valid": false,
                "error": "Coupon not found",
            },
            "meta": coupons_result.get("meta").cloned().unwrap_or_else(|| json!({}))
        }));
    };

    if !is_coupon_active(&coupon) {
        return Ok(json!({
            "success": true,
            "data": { "valid": false, "error": "Coupon is inactive" },
            "meta": coupons_result.get("meta").cloned().unwrap_or_else(|| json!({}))
        }));
    }

    if is_coupon_expired(&coupon) {
        return Ok(json!({
            "success": true,
            "data": { "valid": false, "error": "Coupon has expired" },
            "meta": coupons_result.get("meta").cloned().unwrap_or_else(|| json!({}))
        }));
    }

    if coupon_usage_exhausted(&coupon) {
        return Ok(json!({
            "success": true,
            "data": { "valid": false, "error": "Coupon usage limit has been reached" },
            "meta": coupons_result.get("meta").cloned().unwrap_or_else(|| json!({}))
        }));
    }

    let min_order_amount = coupon_min_order_amount(&coupon);
    if order_total + f64::EPSILON < min_order_amount {
        return Ok(json!({
            "success": true,
            "data": {
                "valid": false,
                "error": format!("Minimum order amount is {:.2}", min_order_amount),
            },
            "meta": coupons_result.get("meta").cloned().unwrap_or_else(|| json!({}))
        }));
    }

    let discount_amount = normalize_coupon_discount(&coupon, order_total);

    Ok(json!({
        "success": true,
        "data": {
            "valid": true,
            "coupon": {
                "id": coupon.get("id").cloned().unwrap_or(Value::Null),
                "code": coupon.get("code").cloned().unwrap_or_else(|| Value::String(code)),
                "name": coupon.get("name").cloned().unwrap_or(Value::Null),
                "description": coupon.get("description").cloned().unwrap_or(Value::Null),
                "discount_type": coupon.get("discount_type").cloned().or_else(|| coupon.get("discountType").cloned()).unwrap_or_else(|| json!("fixed")),
                "discount_value": coupon.get("discount_value").cloned().or_else(|| coupon.get("discountValue").cloned()).unwrap_or_else(|| json!(0)),
                "min_order_amount": coupon.get("min_order_amount").cloned().or_else(|| coupon.get("minOrderAmount").cloned()).unwrap_or_else(|| json!(0)),
                "usage_limit": coupon.get("usage_limit").cloned().or_else(|| coupon.get("usageLimit").cloned()).unwrap_or(Value::Null),
                "usage_count": coupon.get("usage_count").cloned().or_else(|| coupon.get("usageCount").cloned()).unwrap_or_else(|| json!(0)),
                "expires_at": coupon.get("expires_at").cloned().or_else(|| coupon.get("expiresAt").cloned()).unwrap_or(Value::Null),
                "discount_amount": discount_amount,
            }
        },
        "meta": coupons_result.get("meta").cloned().unwrap_or_else(|| json!({}))
    }))
}

#[tauri::command]
pub async fn branch_data_get_bundle_status(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload: BranchScopedPayload = arg0
        .map(serde_json::from_value)
        .transpose()
        .unwrap_or_default()
        .unwrap_or_default();
    let branch_id = resolve_branch_id(&db, payload.branch_id)?;

    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    let mut datasets = vec![
        cached_dataset_status(&conn, &branch_id, CACHE_KEY_TABLES, "all"),
        cached_dataset_status_latest(&conn, &branch_id, CACHE_KEY_STAFF_SCHEDULE),
        cached_dataset_status(&conn, &branch_id, CACHE_KEY_DELIVERY_ZONES, "all"),
        cached_dataset_status(&conn, &branch_id, CACHE_KEY_COUPONS, "all"),
        cached_dataset_status(&conn, &branch_id, CACHE_KEY_CATALOG_OFFERS, "menu"),
    ];

    let menu_status = conn
        .query_row(
            "SELECT MAX(updated_at), COUNT(*) FROM menu_cache",
            [],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
        )
        .map(|(synced_at, count)| DatasetStatus {
            cache_key: "menu_cache".to_string(),
            scope_key: "default".to_string(),
            synced_at,
            available: count > 0,
            source: "sqlite",
            item_count: Some(count.max(0) as usize),
        })
        .unwrap_or(DatasetStatus {
            cache_key: "menu_cache".to_string(),
            scope_key: "default".to_string(),
            synced_at: None,
            available: false,
            source: "sqlite",
            item_count: None,
        });
    datasets.push(menu_status);

    let printer_profile_status = conn
        .query_row(
            "SELECT MAX(updated_at), COUNT(*) FROM printer_profiles",
            [],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
        )
        .map(|(synced_at, count)| DatasetStatus {
            cache_key: "printer_profiles".to_string(),
            scope_key: "local".to_string(),
            synced_at,
            available: count > 0,
            source: "sqlite",
            item_count: Some(count.max(0) as usize),
        })
        .unwrap_or(DatasetStatus {
            cache_key: "printer_profiles".to_string(),
            scope_key: "local".to_string(),
            synced_at: None,
            available: false,
            source: "sqlite",
            item_count: None,
        });
    datasets.push(printer_profile_status);
    drop(conn);

    let module_status = read_module_cache(&db)
        .ok()
        .map(|payload| DatasetStatus {
            cache_key: "modules".to_string(),
            scope_key: "default".to_string(),
            synced_at: payload
                .get("apiTimestamp")
                .and_then(Value::as_str)
                .map(|value| value.to_string()),
            available: payload
                .get("apiModules")
                .and_then(Value::as_array)
                .map(|items| !items.is_empty())
                .unwrap_or(false),
            source: "file",
            item_count: payload
                .get("apiModules")
                .and_then(Value::as_array)
                .map(|items| items.len()),
        })
        .unwrap_or(DatasetStatus {
            cache_key: "modules".to_string(),
            scope_key: "default".to_string(),
            synced_at: None,
            available: false,
            source: "file",
            item_count: None,
        });
    datasets.push(module_status);

    let delivery_local_status = read_local_json(&db, DELIVERY_ZONES_LOCAL_KEY)
        .ok()
        .map(|payload| DatasetStatus {
            cache_key: "delivery_zones_local".to_string(),
            scope_key: "default".to_string(),
            synced_at: payload
                .get("syncedAt")
                .or_else(|| payload.get("updatedAt"))
                .and_then(Value::as_str)
                .map(|value| value.to_string()),
            available: payload
                .get("zones")
                .and_then(Value::as_array)
                .map(|zones| !zones.is_empty())
                .unwrap_or(false),
            source: "local_settings",
            item_count: payload
                .get("zones")
                .and_then(Value::as_array)
                .map(|zones| zones.len()),
        })
        .unwrap_or(DatasetStatus {
            cache_key: "delivery_zones_local".to_string(),
            scope_key: "default".to_string(),
            synced_at: None,
            available: false,
            source: "local_settings",
            item_count: None,
        });
    datasets.push(delivery_local_status);

    let required_missing: Vec<String> = datasets
        .iter()
        .filter(|dataset| {
            matches!(
                dataset.cache_key.as_str(),
                "menu_cache" | "tables" | "staff_schedule" | "delivery_zones" | "modules"
            ) && !dataset.available
        })
        .map(|dataset| dataset.cache_key.clone())
        .collect();

    Ok(json!({
        "success": true,
        "data": {
            "branchId": branch_id,
            "generatedAt": Utc::now().to_rfc3339(),
            "datasets": datasets.into_iter().map(|dataset| json!({
                "cacheKey": dataset.cache_key,
                "scopeKey": dataset.scope_key,
                "syncedAt": dataset.synced_at,
                "available": dataset.available,
                "source": dataset.source,
                "itemCount": dataset.item_count,
            })).collect::<Vec<Value>>(),
            "hasRequiredCoreData": required_missing.is_empty(),
            "missingRequiredDatasets": required_missing,
        }
    }))
}
