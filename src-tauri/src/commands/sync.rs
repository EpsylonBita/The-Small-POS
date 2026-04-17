use chrono::Local;
use serde::Deserialize;
use tauri::Emitter;
use zeroize::Zeroizing;

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
    sync_id: serde_json::Value,
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

const ACTIONABLE_FINANCIAL_QUEUE_STATUSES_SQL: &str =
    "'failed', 'pending', 'in_progress', 'deferred', 'queued_remote'";
const ACTIONABLE_FINANCIAL_ENTITY_TYPES_SQL: &str =
    "'payment_adjustment', 'shift_expense', 'staff_payment', 'driver_earning', 'driver_earnings'";

fn parse_retry_financial_queue_id(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::Number(num) => num.as_i64(),
        serde_json::Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn load_zeroized_pos_api_key() -> Result<Zeroizing<String>, String> {
    let raw_api_key =
        Zeroizing::new(storage::get_credential("pos_api_key").ok_or("API key not configured")?);
    Ok(Zeroizing::new(
        api::extract_api_key_from_connection_string(&raw_api_key)
            .unwrap_or_else(|| (*raw_api_key).clone()),
    ))
}

fn load_zeroized_pos_api_key_optional() -> Option<Zeroizing<String>> {
    let raw_api_key = Zeroizing::new(storage::get_credential("pos_api_key")?);
    Some(Zeroizing::new(
        api::extract_api_key_from_connection_string(&raw_api_key)
            .unwrap_or_else(|| (*raw_api_key).clone()),
    ))
}

fn parse_retry_financial_item_payload(arg0: Option<serde_json::Value>) -> Result<i64, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(sync_id)) => serde_json::json!({
            "syncId": sync_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let parsed: SyncRetryFinancialItemPayload = serde_json::from_value(payload.clone())
        .map_err(|e| format!("Invalid retry financial payload: {e}"))?;

    parse_retry_financial_queue_id(&parsed.sync_id)
        .or_else(|| value_i64(&payload, &["syncId", "sync_id", "id"]))
        .filter(|id| *id > 0)
        .ok_or_else(|| "Missing sync item id".into())
}

fn query_financial_queue_items(limit: i64, db: &db::DbState) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, entity_type, entity_id, operation, payload, status, last_error, retry_count, created_at
             FROM sync_queue
             WHERE status IN ({ACTIONABLE_FINANCIAL_QUEUE_STATUSES_SQL})
               AND entity_type IN ({ACTIONABLE_FINANCIAL_ENTITY_TYPES_SQL})
             ORDER BY
               CASE status
                 WHEN 'failed' THEN 0
                 WHEN 'pending' THEN 1
                 WHEN 'deferred' THEN 2
                 WHEN 'queued_remote' THEN 3
                 WHEN 'in_progress' THEN 4
                 ELSE 9
               END,
               datetime(created_at) DESC,
               id DESC
             LIMIT ?1"
        ))
        .map_err(|e| e.to_string())?;
    let rows: Vec<(
        i64,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        i64,
        String,
    )> = stmt
        .query_map([limit], |row| {
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
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(
            |(
                queue_id,
                entity_type,
                entity_id,
                operation,
                payload,
                status,
                last_error,
                retry_count,
                created_at,
            )| {
                let dependency =
                    sync::resolve_financial_parent_shift_dependency(&conn, &entity_type, &payload);
                serde_json::json!({
                    "queueId": queue_id,
                    "entityType": entity_type,
                    "entityId": entity_id,
                    "operation": operation,
                    "payload": payload,
                    "status": status,
                    "lastError": last_error,
                    "retryCount": retry_count,
                    "createdAt": created_at,
                    "parentShiftId": dependency.as_ref().map(|value| value.parent_shift_id.clone()),
                    "parentShiftSyncStatus": dependency.as_ref().and_then(|value| value.parent_shift_sync_status.clone()),
                    "parentShiftQueueId": dependency.as_ref().and_then(|value| value.parent_shift_queue_id),
                    "parentShiftQueueStatus": dependency.as_ref().and_then(|value| value.parent_shift_queue_status.clone()),
                    "dependencyBlockReason": dependency.as_ref().and_then(|value| value.dependency_block_reason.clone()),
                    // Compatibility aliases for legacy renderer fields
                    "id": queue_id,
                    "table_name": entity_type,
                    "record_id": entity_id,
                    "data": payload,
                    "attempts": retry_count,
                    "error_message": last_error,
                    "created_at": created_at,
                })
            },
        )
        .collect();
    Ok(serde_json::json!({ "items": items }))
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
    query_financial_queue_items(limit, &db)
}

#[tauri::command]
pub async fn sync_get_financial_queue_items(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let limit = parse_failed_financial_items_limit(arg0);
    query_financial_queue_items(limit, &db)
}

#[tauri::command]
pub async fn sync_retry_financial_item(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let id = parse_retry_financial_item_payload(arg0)?;
    sync::retry_financial_queue_item(&db, id)?;

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
        let now = chrono::Utc::now().to_rfc3339();
        let count = conn.execute(
            "UPDATE sync_queue
             SET status = 'pending',
                 retry_count = 0,
                 last_error = NULL,
                 next_retry_at = NULL,
                 updated_at = ?1
             WHERE status = 'failed'
               AND entity_type IN ('payment_adjustment', 'shift_expense', 'staff_payment', 'driver_earning', 'driver_earnings')",
            rusqlite::params![now],
        )
        .map_err(|e| e.to_string())?;
        if count > 0 {
            let _ = conn.execute(
                "UPDATE payment_adjustments
                 SET sync_state = 'pending',
                     sync_retry_count = 0,
                     sync_last_error = NULL,
                     sync_next_retry_at = NULL,
                     updated_at = ?1
                 WHERE id IN (
                     SELECT entity_id
                     FROM sync_queue
                     WHERE entity_type = 'payment_adjustment'
                       AND status = 'pending'
                       AND updated_at = ?1
                 )",
                rusqlite::params![now],
            );
        }
        count
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
               AND entity_type IN ('payment_adjustment', 'shift_expense', 'staff_payment', 'driver_earning', 'driver_earnings')",
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
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut issues = Vec::new();

    let mut payment_stmt = conn
        .prepare(
            "SELECT
                op.id,
                op.order_id,
                COALESCE(o.order_number, op.order_id) AS order_number,
                COALESCE(o.sync_status, ''),
                COALESCE(o.supabase_id, ''),
                COALESCE(op.sync_last_error, ''),
                (
                    SELECT sq.id
                    FROM sync_queue sq
                    WHERE sq.entity_type = 'payment'
                      AND sq.entity_id = op.id
                    ORDER BY
                      CASE sq.status
                        WHEN 'failed' THEN 0
                        WHEN 'deferred' THEN 1
                        WHEN 'pending' THEN 2
                        WHEN 'queued_remote' THEN 3
                        WHEN 'in_progress' THEN 4
                        ELSE 9
                      END,
                      sq.id DESC
                    LIMIT 1
                ) AS queue_id,
                (
                    SELECT sq.status
                    FROM sync_queue sq
                    WHERE sq.entity_type = 'payment'
                      AND sq.entity_id = op.id
                    ORDER BY
                      CASE sq.status
                        WHEN 'failed' THEN 0
                        WHEN 'deferred' THEN 1
                        WHEN 'pending' THEN 2
                        WHEN 'queued_remote' THEN 3
                        WHEN 'in_progress' THEN 4
                        ELSE 9
                      END,
                      sq.id DESC
                    LIMIT 1
                ) AS queue_status,
                (
                    SELECT sq.last_error
                    FROM sync_queue sq
                    WHERE sq.entity_type = 'payment'
                      AND sq.entity_id = op.id
                    ORDER BY
                      CASE sq.status
                        WHEN 'failed' THEN 0
                        WHEN 'deferred' THEN 1
                        WHEN 'pending' THEN 2
                        WHEN 'queued_remote' THEN 3
                        WHEN 'in_progress' THEN 4
                        ELSE 9
                      END,
                      sq.id DESC
                    LIMIT 1
                ) AS queue_last_error
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE op.sync_state = 'waiting_parent'
             ORDER BY COALESCE(op.updated_at, op.created_at, '') ASC, op.id ASC",
        )
        .map_err(|e| format!("prepare waiting-parent payments query: {e}"))?;

    let waiting_parent_payments: Vec<(
        String,
        String,
        String,
        String,
        String,
        String,
        Option<i64>,
        Option<String>,
        Option<String>,
    )> = payment_stmt
        .query_map([], |row| {
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
            ))
        })
        .map_err(|e| format!("query waiting-parent payments: {e}"))?
        .filter_map(Result::ok)
        .collect();
    drop(payment_stmt);

    for (
        payment_id,
        order_id,
        order_number,
        parent_sync_status,
        parent_supabase_id,
        payment_sync_error,
        queue_id,
        queue_status,
        queue_last_error,
    ) in waiting_parent_payments
    {
        let parent_has_remote_identity = !parent_supabase_id.trim().is_empty();
        let details = if parent_has_remote_identity {
            "Parent order already has remote identity, but the payment is still waiting for promotion."
        } else {
            "Parent order has not synced to the backend yet, so this payment cannot be promoted."
        };

        issues.push(serde_json::json!({
            "entityType": "payment",
            "entityId": payment_id,
            "orderId": order_id,
            "orderNumber": order_number,
            "paymentId": payment_id,
            "queueId": queue_id,
            "queueStatus": queue_status,
            "reasonCode": "order_payment_waiting_parent",
            "suggestedFix": "repair_waiting_parent_payments",
            "syncState": "waiting_parent",
            "parentSyncState": if parent_sync_status.trim().is_empty() { serde_json::Value::Null } else { serde_json::json!(parent_sync_status) },
            "lastError": queue_last_error
                .filter(|value| !value.trim().is_empty())
                .or_else(|| (!payment_sync_error.trim().is_empty()).then_some(payment_sync_error)),
            "details": details,
        }));
    }

    let mut adjustment_stmt = conn
        .prepare(
            "SELECT
                pa.id,
                pa.payment_id,
                pa.order_id,
                COALESCE(o.order_number, pa.order_id) AS order_number,
                COALESCE(op.sync_state, ''),
                op.remote_payment_id,
                COALESCE(pa.sync_last_error, ''),
                (
                    SELECT sq.id
                    FROM sync_queue sq
                    WHERE sq.entity_type = 'payment_adjustment'
                      AND sq.entity_id = pa.id
                    ORDER BY
                      CASE sq.status
                        WHEN 'failed' THEN 0
                        WHEN 'deferred' THEN 1
                        WHEN 'pending' THEN 2
                        WHEN 'queued_remote' THEN 3
                        WHEN 'in_progress' THEN 4
                        ELSE 9
                      END,
                      sq.id DESC
                    LIMIT 1
                ) AS queue_id,
                (
                    SELECT sq.status
                    FROM sync_queue sq
                    WHERE sq.entity_type = 'payment_adjustment'
                      AND sq.entity_id = pa.id
                    ORDER BY
                      CASE sq.status
                        WHEN 'failed' THEN 0
                        WHEN 'deferred' THEN 1
                        WHEN 'pending' THEN 2
                        WHEN 'queued_remote' THEN 3
                        WHEN 'in_progress' THEN 4
                        ELSE 9
                      END,
                      sq.id DESC
                    LIMIT 1
                ) AS queue_status,
                (
                    SELECT sq.last_error
                    FROM sync_queue sq
                    WHERE sq.entity_type = 'payment_adjustment'
                      AND sq.entity_id = pa.id
                    ORDER BY
                      CASE sq.status
                        WHEN 'failed' THEN 0
                        WHEN 'deferred' THEN 1
                        WHEN 'pending' THEN 2
                        WHEN 'queued_remote' THEN 3
                        WHEN 'in_progress' THEN 4
                        ELSE 9
                      END,
                      sq.id DESC
                    LIMIT 1
                ) AS queue_last_error
             FROM payment_adjustments pa
             LEFT JOIN order_payments op ON op.id = pa.payment_id
             LEFT JOIN orders o ON o.id = pa.order_id
             WHERE pa.sync_state = 'waiting_parent'
             ORDER BY COALESCE(pa.updated_at, pa.created_at, '') ASC, pa.id ASC",
        )
        .map_err(|e| format!("prepare waiting-parent adjustments query: {e}"))?;

    let waiting_parent_adjustments: Vec<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<i64>,
        Option<String>,
        Option<String>,
    )> = adjustment_stmt
        .query_map([], |row| {
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
        })
        .map_err(|e| format!("query waiting-parent adjustments: {e}"))?
        .filter_map(Result::ok)
        .collect();
    drop(adjustment_stmt);
    drop(conn);

    for (
        adjustment_id,
        payment_id,
        order_id,
        order_number,
        parent_payment_sync_state,
        remote_payment_id,
        adjustment_sync_error,
        queue_id,
        queue_status,
        queue_last_error,
    ) in waiting_parent_adjustments
    {
        let canonical_remote_payment_id =
            sync::normalize_optional_uuid_str(remote_payment_id.as_deref());
        let (reason_code, suggested_fix, details) = if parent_payment_sync_state.trim() != "applied"
        {
            (
                    "payment_adjustment_waiting_parent",
                    "repair_waiting_parent_adjustments",
                    "Parent payment has not reached the applied state yet, so the adjustment cannot be promoted.",
                )
        } else if canonical_remote_payment_id.is_none() {
            (
                "payment_adjustment_missing_canonical_remote_payment",
                "repair_orphaned_financial",
                "Parent payment is applied, but the canonical remote payment id is still missing.",
            )
        } else {
            (
                    "payment_adjustment_waiting_parent",
                    "repair_waiting_parent_adjustments",
                    "Parent payment is applied and has a canonical remote id, but the adjustment is still waiting.",
                )
        };

        issues.push(serde_json::json!({
            "entityType": "payment_adjustment",
            "entityId": adjustment_id,
            "orderId": order_id,
            "orderNumber": order_number,
            "paymentId": payment_id,
            "adjustmentId": adjustment_id,
            "queueId": queue_id,
            "queueStatus": queue_status,
            "reasonCode": reason_code,
            "suggestedFix": suggested_fix,
            "syncState": "waiting_parent",
            "parentSyncState": if parent_payment_sync_state.trim().is_empty() { serde_json::Value::Null } else { serde_json::json!(parent_payment_sync_state) },
            "lastError": queue_last_error
                .filter(|value| !value.trim().is_empty())
                .or_else(|| (!adjustment_sync_error.trim().is_empty()).then_some(adjustment_sync_error)),
            "details": details,
        }));
    }

    Ok(serde_json::json!({
        "valid": issues.is_empty(),
        "issues": issues,
    }))
}

#[tauri::command]
pub async fn sync_requeue_orphaned_financial(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let admin_url = storage::get_credential("admin_url")
        .ok_or_else(|| "Admin URL not configured".to_string())?;
    let api_key = load_zeroized_pos_api_key()?;
    let stats = sync::repair_orphaned_financial_queue_items(&db, &admin_url, &api_key).await?;

    let _ = app.emit(
        "sync_retry_scheduled",
        serde_json::json!({
            "repair": "orphaned_financial",
            "repaired": stats.repaired,
            "requeued": stats.requeued,
            "skipped": stats.skipped,
        }),
    );
    emit_sync_status_snapshot(&app, &db, &sync_state).await;

    Ok(serde_json::json!({
        "success": true,
        "repaired": stats.repaired,
        "requeued": stats.requeued,
        "skipped": stats.skipped
    }))
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
    let api_key = load_zeroized_pos_api_key()?;

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
    let api_key = load_zeroized_pos_api_key_optional();
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
    use crate::db;
    use rusqlite::params;

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
    fn parse_retry_financial_item_supports_string_number_and_object() {
        let from_string = parse_retry_financial_item_payload(Some(serde_json::json!("41")))
            .expect("string payload should parse");
        let from_object =
            parse_retry_financial_item_payload(Some(serde_json::json!({ "syncId": "42" })))
                .expect("object payload should parse");
        let from_number =
            parse_retry_financial_item_payload(Some(serde_json::json!({ "syncId": 43 })))
                .expect("numeric payload should parse");
        assert_eq!(from_string, 41);
        assert_eq!(from_object, 42);
        assert_eq!(from_number, 43);
    }

    #[test]
    fn query_financial_queue_items_returns_numeric_queue_ids() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status
             ) VALUES ('driver_earning', 'earning-1', 'create', '{}', 'idem-1', 'failed')",
            params![],
        )
        .expect("insert financial queue row");
        let db = db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };

        let response = query_financial_queue_items(10, &db).expect("query financial queue");
        let items = response
            .get("items")
            .and_then(serde_json::Value::as_array)
            .expect("items array");
        let queue_id = items
            .first()
            .and_then(|item| item.get("queueId"))
            .and_then(serde_json::Value::as_i64)
            .expect("numeric queue id");

        assert!(queue_id > 0, "queue id should remain numeric");
    }

    #[test]
    fn query_financial_queue_items_includes_payment_adjustments() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status, last_error
             ) VALUES (
                'payment_adjustment',
                'adj-include',
                'insert',
                '{\"paymentId\":\"pay-include\"}',
                'adjustment:adj-include',
                'failed',
                'Validation failed'
             )",
            [],
        )
        .expect("insert failed payment adjustment");
        let db = db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };

        let response = query_financial_queue_items(10, &db).expect("query financial queue");
        let items = response
            .get("items")
            .and_then(serde_json::Value::as_array)
            .expect("items array");
        let item = items.first().expect("payment adjustment item");

        assert_eq!(
            item.get("entityType").and_then(serde_json::Value::as_str),
            Some("payment_adjustment")
        );
        assert_eq!(
            item.get("entityId").and_then(serde_json::Value::as_str),
            Some("adj-include")
        );
    }

    #[test]
    fn query_financial_queue_items_returns_parent_shift_dependency_metadata() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                'shift-parent', 'cashier-1', 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("insert parent shift");
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status, last_error
             ) VALUES (
                'shift', 'shift-parent', 'insert', '{}', 'shift-parent:open', 'failed', 'Shift sync needs retry'
             )",
            [],
        )
        .expect("insert failed shift queue row");
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status
             ) VALUES (
                'staff_payment',
                'payment-1',
                'insert',
                '{\"cashierShiftId\":\"shift-parent\",\"amount\":20}',
                'payment-1:insert',
                'deferred'
             )",
            [],
        )
        .expect("insert financial queue row");

        let db = db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };

        let response = query_financial_queue_items(10, &db).expect("query financial queue");
        let items = response
            .get("items")
            .and_then(serde_json::Value::as_array)
            .expect("items array");
        let item = items.first().expect("first item");

        assert_eq!(
            item.get("parentShiftId")
                .and_then(serde_json::Value::as_str),
            Some("shift-parent")
        );
        assert_eq!(
            item.get("parentShiftSyncStatus")
                .and_then(serde_json::Value::as_str),
            Some("pending")
        );
        assert_eq!(
            item.get("parentShiftQueueStatus")
                .and_then(serde_json::Value::as_str),
            Some("failed")
        );
        assert_eq!(
            item.get("dependencyBlockReason")
                .and_then(serde_json::Value::as_str),
            Some("Cashier shift sync needs attention")
        );
    }

    #[test]
    fn retry_financial_item_requeues_parent_shift_dependency() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at
             ) VALUES (
                'shift-parent', 'cashier-1', 'cashier', datetime('now'), 'active', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("insert parent shift");
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, last_error
             ) VALUES (
                'shift', 'shift-parent', 'insert', '{}', 'shift-parent:open', 'failed', 3, 'Network error while syncing shift'
             )",
            [],
        )
        .expect("insert failed shift queue row");
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, last_error
             ) VALUES (
                'staff_payment',
                'payment-1',
                'insert',
                '{\"cashierShiftId\":\"shift-parent\",\"amount\":20}',
                'payment-1:insert',
                'deferred',
                1,
                'Waiting for cashier shift sync'
             )",
            [],
        )
        .expect("insert financial queue row");

        let db = db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };

        let child_queue_id = {
            let conn = db.conn.lock().expect("lock db");
            conn.query_row(
                "SELECT id FROM sync_queue WHERE entity_type = 'staff_payment' AND entity_id = 'payment-1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("financial queue id")
        };

        sync::retry_financial_queue_item(&db, child_queue_id).expect("retry financial item");

        let conn = db.conn.lock().expect("lock db");
        let (shift_queue_status, shift_retry_count): (String, i64) = conn
            .query_row(
                "SELECT status, retry_count
                 FROM sync_queue
                 WHERE entity_type = 'shift' AND entity_id = 'shift-parent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("shift queue row");
        let shift_sync_status: String = conn
            .query_row(
                "SELECT sync_status FROM staff_shifts WHERE id = 'shift-parent'",
                [],
                |row| row.get(0),
            )
            .expect("shift sync status");
        let (child_status, child_retry_count, child_error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, retry_count, last_error
                 FROM sync_queue
                 WHERE id = ?1",
                [child_queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("financial queue row");

        assert_eq!(shift_queue_status, "pending");
        assert_eq!(shift_retry_count, 0);
        assert_eq!(shift_sync_status, "pending");
        assert_eq!(child_status, "deferred");
        assert_eq!(child_retry_count, 0);
        assert_eq!(
            child_error.as_deref(),
            Some("Waiting for cashier shift sync")
        );
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
