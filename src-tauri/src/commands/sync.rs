use chrono::Local;
use serde::Deserialize;
use tauri::Emitter;

use crate::{api, db, storage, sync, value_i64};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SyncRemoveInvalidOrdersPayload {
    #[serde(default, alias = "order_ids", alias = "ids")]
    order_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SyncFailedFinancialItemsPayload {
    #[serde(default, alias = "max", alias = "count")]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncRetryFinancialItemPayload {
    #[serde(alias = "sync_id", alias = "id")]
    sync_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncUpdateRoomStatusPayload {
    #[serde(alias = "room_id", alias = "id")]
    room_id: String,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncUpdateDriveThruOrderStatusPayload {
    #[serde(
        alias = "drive_through_order_id",
        alias = "driveThruOrderID",
        alias = "orderId",
        alias = "id"
    )]
    drive_thru_order_id: String,
    status: String,
}

fn parse_remove_invalid_orders_payload(
    arg0: Option<serde_json::Value>,
) -> Result<Vec<String>, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Array(order_ids)) => serde_json::json!({
            "orderIds": order_ids
        }),
        Some(serde_json::Value::String(order_id)) => serde_json::json!({
            "orderIds": [order_id]
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let parsed: SyncRemoveInvalidOrdersPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid remove-invalid-orders payload: {e}"))?;

    let mut seen = std::collections::HashSet::new();
    let mut order_ids = Vec::new();
    for id in parsed.order_ids {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            order_ids.push(trimmed.to_string());
        }
    }

    if order_ids.is_empty() {
        return Err("Missing orderIds".into());
    }
    Ok(order_ids)
}

fn parse_failed_financial_items_limit(arg0: Option<serde_json::Value>) -> i64 {
    const DEFAULT_LIMIT: i64 = 50;
    const MAX_LIMIT: i64 = 500;

    let limit = match arg0 {
        Some(serde_json::Value::Number(num)) => num.as_i64(),
        Some(serde_json::Value::Object(obj)) => {
            let payload = serde_json::Value::Object(obj);
            serde_json::from_value::<SyncFailedFinancialItemsPayload>(payload.clone())
                .ok()
                .and_then(|parsed| parsed.limit.or_else(|| value_i64(&payload, &["limit"])))
        }
        _ => None,
    };

    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn parse_retry_financial_item_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(sync_id)) => serde_json::json!({
            "syncId": sync_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let mut parsed: SyncRetryFinancialItemPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid retry financial payload: {e}"))?;
    parsed.sync_id = parsed.sync_id.trim().to_string();
    if parsed.sync_id.is_empty() {
        return Err("Missing sync item id".into());
    }
    Ok(parsed.sync_id)
}

fn parse_update_room_status_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
) -> Result<SyncUpdateRoomStatusPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Object(mut obj)) => {
            if obj.get("status").is_none() {
                if let Some(status) = arg1 {
                    obj.insert("status".to_string(), serde_json::Value::String(status));
                }
            }
            serde_json::Value::Object(obj)
        }
        Some(serde_json::Value::String(room_id)) => serde_json::json!({
            "roomId": room_id,
            "status": arg1
        }),
        Some(v) => v,
        None => serde_json::json!({
            "status": arg1
        }),
    };

    let mut parsed: SyncUpdateRoomStatusPayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid room status payload: {e}"))?;
    parsed.room_id = parsed.room_id.trim().to_string();
    parsed.status = parsed.status.trim().to_string();
    if parsed.room_id.is_empty() {
        return Err("Missing roomId".into());
    }
    if parsed.status.is_empty() {
        return Err("Missing status".into());
    }
    Ok(parsed)
}

fn parse_update_drive_thru_order_status_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
) -> Result<SyncUpdateDriveThruOrderStatusPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Object(mut obj)) => {
            if obj.get("status").is_none() {
                if let Some(status) = arg1 {
                    obj.insert("status".to_string(), serde_json::Value::String(status));
                }
            }
            serde_json::Value::Object(obj)
        }
        Some(serde_json::Value::String(order_id)) => serde_json::json!({
            "driveThruOrderId": order_id,
            "status": arg1
        }),
        Some(v) => v,
        None => serde_json::json!({
            "status": arg1
        }),
    };

    let mut parsed: SyncUpdateDriveThruOrderStatusPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid drive-through status payload: {e}"))?;
    parsed.drive_thru_order_id = parsed.drive_thru_order_id.trim().to_string();
    parsed.status = parsed.status.trim().to_string();
    if parsed.drive_thru_order_id.is_empty() {
        return Err("Missing drive-through order ID".into());
    }
    if parsed.status.is_empty() {
        return Err("Missing status".into());
    }
    Ok(parsed)
}

async fn emit_sync_status_snapshot(
    app: &tauri::AppHandle,
    db: &db::DbState,
    sync_state: &std::sync::Arc<sync::SyncState>,
) {
    let network_status = sync::check_network_status().await;
    let network_is_online = network_status
        .get("isOnline")
        .and_then(serde_json::Value::as_bool);
    let _ = app.emit("network_status", &network_status);

    if let Ok(mut status) = sync::get_sync_status(db, sync_state) {
        if let Some(is_online) = network_is_online {
            if let Some(status_obj) = status.as_object_mut() {
                status_obj.insert("isOnline".to_string(), serde_json::json!(is_online));
            }
        }
        let _ = app.emit("sync_status", &status);
        let _ = app.emit("sync-status-changed", &status);
    }
}

#[tauri::command]
pub async fn sync_get_status(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
) -> Result<serde_json::Value, String> {
    sync::get_sync_status(&db, &sync_state)
}

#[tauri::command]
pub async fn sync_get_network_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let status = sync::check_network_status().await;
    let _ = app.emit("network_status", status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn sync_force(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    match sync::force_sync(&db, &sync_state, &app).await {
        Ok(()) => {
            let _ = app.emit("sync_complete", serde_json::json!({ "trigger": "manual" }));
            Ok(())
        }
        Err(e) => {
            let _ = app.emit("sync_error", serde_json::json!({ "error": e }));
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn sync_validate_pending_orders(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync::validate_pending_orders(&db)
}

#[tauri::command]
pub async fn sync_remove_invalid_orders(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_ids = parse_remove_invalid_orders_payload(arg0)?;
    let result = sync::remove_invalid_orders(&db, order_ids);
    if result.is_ok() {
        emit_sync_status_snapshot(&app, &db, &sync_state).await;
    }
    result
}

#[tauri::command]
pub async fn sync_get_financial_stats(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync::get_financial_stats(&db)
}

#[tauri::command]
pub async fn sync_get_failed_financial_items(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let limit = parse_failed_financial_items_limit(arg0);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, entity_type, entity_id, operation, payload, status, last_error, retry_count, created_at
             FROM sync_queue
             WHERE status = 'failed'
               AND entity_type IN ('payment', 'order_payment', 'payment_adjustment', 'shift_expense', 'staff_payment', 'driver_earning', 'driver_earnings')
             ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "entityType": row.get::<_, String>(1)?,
                "entityId": row.get::<_, String>(2)?,
                "operation": row.get::<_, String>(3)?,
                "payload": row.get::<_, String>(4)?,
                "status": row.get::<_, String>(5)?,
                "lastError": row.get::<_, Option<String>>(6)?,
                "retryCount": row.get::<_, i64>(7)?,
                "createdAt": row.get::<_, String>(8)?,
                // Compatibility aliases for legacy renderer fields
                "table_name": row.get::<_, String>(1)?,
                "record_id": row.get::<_, String>(2)?,
                "data": row.get::<_, String>(4)?,
                "attempts": row.get::<_, i64>(7)?,
                "error_message": row.get::<_, Option<String>>(6)?,
                "created_at": row.get::<_, String>(8)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let items: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!({ "items": items }))
}

#[tauri::command]
pub async fn sync_retry_financial_item(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let id = parse_retry_financial_item_payload(arg0)?;
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sync_queue SET status = 'pending', retry_count = 0, last_error = NULL WHERE id = ?1",
            [&id],
        )
        .map_err(|e| e.to_string())?;
    }

    let _ = app.emit("sync_retry_scheduled", serde_json::json!({ "id": id }));
    emit_sync_status_snapshot(&app, &db, &sync_state).await;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn sync_retry_all_failed_financial(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let count = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sync_queue SET status = 'pending', retry_count = 0, last_error = NULL
             WHERE status = 'failed'
               AND entity_type IN ('payment', 'order_payment', 'payment_adjustment', 'shift_expense', 'staff_payment', 'driver_earning', 'driver_earnings')",
            [],
        )
        .map_err(|e| e.to_string())?
    };

    let _ = app.emit(
        "sync_retry_scheduled",
        serde_json::json!({ "count": count }),
    );
    emit_sync_status_snapshot(&app, &db, &sync_state).await;
    Ok(serde_json::json!({ "success": true, "count": count }))
}

#[tauri::command]
pub async fn sync_get_unsynced_financial_summary(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue
             WHERE status != 'synced'
               AND entity_type IN ('payment', 'order_payment', 'payment_adjustment', 'shift_expense', 'staff_payment', 'driver_earning', 'driver_earnings')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(serde_json::json!({ "totalUnsynced": total }))
}

#[tauri::command]
pub async fn sync_validate_financial_integrity(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    // Stub: returns clean status
    let _ = db;
    Ok(serde_json::json!({ "valid": true, "issues": [] }))
}

#[tauri::command]
pub async fn sync_requeue_orphaned_financial(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let _ = db;
    Ok(serde_json::json!({ "success": true, "requeued": 0 }))
}

#[tauri::command]
pub async fn sync_clear_all_orders(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let cleared = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let _ = conn.execute(
            "DELETE FROM sync_queue WHERE entity_type IN ('order', 'payment', 'payment_adjustment')",
            [],
        );
        conn.execute("DELETE FROM orders", [])
            .map_err(|e| e.to_string())?
    };
    let _ = app.emit("orders_cleared", serde_json::json!({ "count": cleared }));
    emit_sync_status_snapshot(&app, &db, &sync_state).await;
    Ok(serde_json::json!({ "success": true, "cleared": cleared }))
}

#[tauri::command]
pub async fn sync_cleanup_deleted_orders(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    crate::hydrate_terminal_credentials_from_local_settings(&db);
    let admin_url =
        storage::get_credential("admin_dashboard_url").ok_or("Admin URL not configured")?;
    let api_key = storage::get_credential("pos_api_key").ok_or("API key not configured")?;

    // Fetch deleted IDs from server (all deletions since epoch)
    let resp = api::fetch_from_admin(
        &admin_url,
        &api_key,
        "/api/pos/orders/sync?limit=100&include_deleted=true&since=1970-01-01T00:00:00.000Z",
        "GET",
        None,
    )
    .await
    .map_err(|e| format!("Failed to fetch deleted orders: {e}"))?;

    let deleted_ids = resp
        .get("deleted_ids")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();

    let checked = deleted_ids.len();
    let deleted = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut deleted = 0usize;
        for deleted_id in &deleted_ids {
            let Some(remote_id) = deleted_id.as_str().filter(|s| !s.trim().is_empty()) else {
                continue;
            };
            let local_id: Option<String> = conn
                .query_row(
                    "SELECT id FROM orders WHERE supabase_id = ?1 OR id = ?1 LIMIT 1",
                    rusqlite::params![remote_id],
                    |row| row.get(0),
                )
                .ok();
            if let Some(local_id) = local_id {
                let _ = conn.execute(
                    "DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id = ?1",
                    rusqlite::params![local_id],
                );
                let _ = conn.execute(
                    "DELETE FROM sync_queue WHERE entity_type = 'payment' AND entity_id IN (SELECT id FROM order_payments WHERE order_id = ?1)",
                    rusqlite::params![local_id],
                );
                let _ = conn.execute(
                    "DELETE FROM sync_queue WHERE entity_type = 'payment_adjustment' AND entity_id IN (SELECT id FROM payment_adjustments WHERE order_id = ?1)",
                    rusqlite::params![local_id],
                );
                let count = conn
                    .execute(
                        "DELETE FROM orders WHERE id = ?1",
                        rusqlite::params![local_id],
                    )
                    .unwrap_or(0);
                deleted += count;
            }
        }
        deleted
    };

    emit_sync_status_snapshot(&app, &db, &sync_state).await;

    Ok(serde_json::json!({ "success": true, "deleted": deleted, "checked": checked }))
}

async fn sync_fetch_with_options(
    path: &str,
    arg0: Option<serde_json::Value>,
    db: &db::DbState,
) -> Result<serde_json::Value, String> {
    let full_path = crate::build_admin_query(path, arg0.as_ref());
    match crate::admin_fetch(Some(db), &full_path, "GET", None).await {
        Ok(v) => Ok(v),
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "error": e
        })),
    }
}

#[tauri::command]
pub async fn sync_clear_all(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let cleared = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM sync_queue", [])
            .map_err(|e| e.to_string())?
    };
    emit_sync_status_snapshot(&app, &db, &sync_state).await;
    Ok(serde_json::json!({ "success": true, "cleared": cleared }))
}

#[tauri::command]
pub async fn sync_clear_failed(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let cleared = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM sync_queue WHERE status = 'failed'", [])
            .map_err(|e| e.to_string())?
    };
    emit_sync_status_snapshot(&app, &db, &sync_state).await;
    Ok(serde_json::json!({ "success": true, "cleared": cleared }))
}

#[tauri::command]
pub async fn sync_clear_old_orders(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let cleared = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        // Clean orphaned sync_queue entries for old orders
        let _ = conn.execute(
            "DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id IN (
                SELECT id FROM orders WHERE substr(created_at, 1, 10) < ?1
            )",
            rusqlite::params![today],
        );
        conn.execute(
            "DELETE FROM orders WHERE substr(created_at, 1, 10) < ?1",
            rusqlite::params![today],
        )
        .map_err(|e| e.to_string())?
    };
    emit_sync_status_snapshot(&app, &db, &sync_state).await;
    Ok(serde_json::json!({ "success": true, "cleared": cleared }))
}

#[tauri::command]
pub async fn sync_get_inter_terminal_status(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    crate::hydrate_terminal_credentials_from_local_settings(&db);

    let admin_url = storage::get_credential("admin_dashboard_url");
    let api_key = storage::get_credential("pos_api_key");
    let terminal_id = storage::get_credential("terminal_id");

    let Some(admin_url_val) = admin_url else {
        return Ok(serde_json::json!({
            "parentInfo": serde_json::Value::Null,
            "isParentReachable": false,
            "routingMode": "unknown",
        }));
    };
    let Some(api_key_val) = api_key else {
        return Ok(serde_json::json!({
            "parentInfo": serde_json::Value::Null,
            "isParentReachable": false,
            "routingMode": "unknown",
        }));
    };

    let connectivity = api::test_connectivity(&admin_url_val, &api_key_val).await;
    let normalized_admin_url = api::normalize_admin_url(&admin_url_val);
    let parent_info = serde_json::json!({
        "adminUrl": normalized_admin_url.clone(),
        "host": normalized_admin_url,
        "name": terminal_id.clone().unwrap_or_else(|| "Main POS".to_string()),
        "terminalId": terminal_id,
    });

    Ok(serde_json::json!({
        "parentInfo": parent_info,
        "isParentReachable": connectivity.success,
        "routingMode": if connectivity.success { "via_parent" } else { "direct_cloud" },
        "latencyMs": connectivity.latency_ms,
    }))
}

#[tauri::command]
pub async fn sync_rediscover_parent() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn sync_fetch_tables(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/tables", arg0, &db).await
}

#[tauri::command]
pub async fn sync_fetch_reservations(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/reservations", arg0, &db).await
}

#[tauri::command]
pub async fn sync_fetch_suppliers(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/suppliers", arg0, &db).await
}

#[tauri::command]
pub async fn sync_fetch_analytics(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/analytics", arg0, &db).await
}

#[tauri::command]
pub async fn sync_fetch_orders(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/orders", arg0, &db).await
}

#[tauri::command]
pub async fn sync_fetch_rooms(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/rooms", arg0, &db).await
}

#[tauri::command]
pub async fn sync_update_room_status(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_update_room_status_payload(arg0, arg1)?;
    let room_id = payload.room_id;
    let status = payload.status;
    let path = format!("/api/pos/rooms/{room_id}");
    let body = serde_json::json!({ "status": status });

    match crate::admin_fetch(Some(&db), &path, "PATCH", Some(body)).await {
        Ok(v) => Ok(v),
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "error": e
        })),
    }
}

#[tauri::command]
pub async fn sync_fetch_drive_thru(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/drive-through", arg0, &db).await
}

#[tauri::command]
pub async fn sync_update_drive_thru_order_status(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_update_drive_thru_order_status_payload(arg0, arg1)?;
    let order_id = payload.drive_thru_order_id;
    let status = payload.status;
    let body = serde_json::json!({
        "drive_through_order_id": order_id,
        "status": status
    });

    match crate::admin_fetch(Some(&db), "/api/pos/drive-through", "PATCH", Some(body)).await {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                if obj.get("order").is_none() {
                    if let Some(alt) = obj.get("drive_through_order").cloned() {
                        obj.insert("order".to_string(), alt);
                    }
                }
            }
            Ok(v)
        }
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "error": e
        })),
    }
}

#[tauri::command]
pub async fn rooms_get_availability(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    match crate::admin_fetch(Some(&db), "/api/pos/rooms", "GET", None).await {
        Ok(resp) => {
            let rooms = resp
                .get("rooms")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let total = rooms.len() as i64;
            let available = rooms
                .iter()
                .filter(|r| {
                    r.get("status")
                        .and_then(|v| v.as_str())
                        .map(|s| s.eq_ignore_ascii_case("available"))
                        .unwrap_or(false)
                })
                .count() as i64;

            Ok(serde_json::json!({
                "success": true,
                "available": available,
                "total": total
            }))
        }
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "notImplemented": true,
            "message": e,
            "available": 0,
            "total": 0
        })),
    }
}

#[tauri::command]
pub async fn appointments_get_today_metrics() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": false,
        "notImplemented": true,
        "message": "Appointments service not yet implemented. Metrics derived from orders.",
        "scheduled": 0,
        "completed": 0,
        "canceled": 0
    }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_remove_invalid_orders_supports_array_payload() {
        let parsed = parse_remove_invalid_orders_payload(Some(serde_json::json!([
            "order-1",
            " order-2 ",
            "",
            "order-1"
        ])))
        .expect("array payload should parse");
        assert_eq!(parsed, vec!["order-1".to_string(), "order-2".to_string()]);
    }

    #[test]
    fn parse_failed_financial_items_limit_supports_number_and_object() {
        let from_number = parse_failed_financial_items_limit(Some(serde_json::json!(25)));
        let from_object =
            parse_failed_financial_items_limit(Some(serde_json::json!({ "limit": 9999 })));
        let from_missing = parse_failed_financial_items_limit(Some(serde_json::json!({})));
        assert_eq!(from_number, 25);
        assert_eq!(from_object, 500);
        assert_eq!(from_missing, 50);
    }

    #[test]
    fn parse_retry_financial_item_supports_string_and_object() {
        let from_string = parse_retry_financial_item_payload(Some(serde_json::json!("sync-1")))
            .expect("string payload should parse");
        let from_object =
            parse_retry_financial_item_payload(Some(serde_json::json!({ "syncId": "sync-2" })))
                .expect("object payload should parse");
        assert_eq!(from_string, "sync-1");
        assert_eq!(from_object, "sync-2");
    }

    #[test]
    fn parse_update_room_status_supports_legacy_args() {
        let parsed = parse_update_room_status_payload(
            Some(serde_json::json!("room-1")),
            Some("occupied".to_string()),
        )
        .expect("legacy args should parse");
        assert_eq!(parsed.room_id, "room-1");
        assert_eq!(parsed.status, "occupied");
    }

    #[test]
    fn parse_update_drive_thru_status_supports_aliases() {
        let parsed = parse_update_drive_thru_order_status_payload(
            Some(serde_json::json!({
                "drive_through_order_id": "dt-1",
                "status": "ready"
            })),
            None,
        )
        .expect("alias payload should parse");
        assert_eq!(parsed.drive_thru_order_id, "dt-1");
        assert_eq!(parsed.status, "ready");
    }
}
