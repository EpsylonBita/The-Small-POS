use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tracing::info;

use crate::{api, auth, db, payments, recovery, storage, sync, sync_queue};

fn parse_point_id(arg0: Option<Value>) -> Result<String, String> {
    crate::payload_arg0_as_string(arg0, &["id", "pointId", "point_id", "value"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing recovery point id".to_string())
}

fn parse_open_dir_payload(arg0: Option<Value>) -> Option<String> {
    crate::payload_arg0_as_string(arg0, &["path", "dir", "directory", "value"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn open_directory(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = dir;
        Err("Opening recovery folder is not supported on this platform".into())
    }
}

fn request_field_str<'a>(request: &'a Value, key: &str) -> Option<&'a str> {
    request.get(key).and_then(Value::as_str).map(str::trim)
}

fn request_field_i64(request: &Value, key: &str) -> Option<i64> {
    request.get(key).and_then(|value| match value {
        Value::Number(num) => num.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn request_param<'a>(request: &'a Value, key: &str) -> Option<&'a Value> {
    request.get("params").and_then(Value::as_object)?.get(key)
}

fn request_param_str(request: &Value, key: &str) -> Option<String> {
    request_param(request, key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn request_param_i64(request: &Value, key: &str) -> Option<i64> {
    request_param(request, key).and_then(|value| match value {
        Value::Number(num) => num.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn request_param_string_array(request: &Value, key: &str) -> Vec<String> {
    request_param(request, key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn load_admin_url(db: &db::DbState) -> Result<String, String> {
    let admin_url = storage::get_credential("admin_dashboard_url")
        .or_else(|| storage::get_credential("admin_url"))
        .or_else(|| crate::read_local_setting(db, "terminal", "admin_dashboard_url"))
        .or_else(|| crate::read_local_setting(db, "terminal", "admin_url"))
        .ok_or_else(|| "Admin URL not configured".to_string())?;
    let normalized = api::normalize_admin_url(&admin_url);
    if normalized.trim().is_empty() {
        return Err("Admin URL not configured".into());
    }
    Ok(normalized)
}

fn load_pos_api_key() -> Result<String, String> {
    let raw_api_key = storage::get_credential("pos_api_key")
        .ok_or_else(|| "POS API key not configured".to_string())?;
    let extracted =
        api::extract_api_key_from_connection_string(&raw_api_key).unwrap_or(raw_api_key);
    let normalized = extracted.trim().to_string();
    if normalized.is_empty() {
        return Err("POS API key not configured".into());
    }
    Ok(normalized)
}

fn failed_payment_total_conflict_for_payment(
    conn: &rusqlite::Connection,
    payment_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT error_message
         FROM parity_sync_queue
         WHERE table_name = 'payments'
           AND record_id = ?1
           AND status = 'failed'
           AND error_message IS NOT NULL
           AND lower(error_message) LIKE '%payment exceeds order total%'
         ORDER BY COALESCE(last_attempt, created_at) DESC, created_at DESC
         LIMIT 1",
        rusqlite::params![payment_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("load payment total conflict row: {e}"))
}

fn prepare_payment_total_conflict_repair(
    conn: &rusqlite::Connection,
    payment_id: &str,
) -> Result<(String, bool), String> {
    let local_order_id: String = conn
        .query_row(
            "SELECT order_id FROM order_payments WHERE id = ?1",
            rusqlite::params![payment_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("load payment repair context: {e}"))?;

    let queued_parent_order =
        sync::force_requeue_local_order_update_after_lagged_snapshot(conn, &local_order_id)?;
    let now = chrono::Utc::now().to_rfc3339();
    let payload = payments::build_payment_sync_payload_for_payment(conn, payment_id)?;
    sync::upsert_payment_sync_queue_row(
        conn, payment_id, &payload, "pending", 0, None, None, None, &now,
    )
    .map_err(|e| format!("requeue repaired payment parity row: {e}"))?;

    Ok((local_order_id, queued_parent_order))
}

fn format_cents(cents: i64) -> String {
    format!("{:.2}", cents as f64 / 100.0)
}

fn load_payment_settlement_equation(
    conn: &rusqlite::Connection,
    payment_id: &str,
) -> Result<Option<String>, String> {
    let row: Option<(i64, i64, i64)> = conn
        .query_row(
            "SELECT COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0),
                    COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER), 0),
                    COALESCE((
                        SELECT SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER), 0))
                        FROM payment_adjustments pa
                        WHERE pa.payment_id = op.id
                          AND pa.order_id = op.order_id
                          AND pa.adjustment_type = 'refund'
                          AND COALESCE(pa.adjustment_context, '') = 'edit_settlement'
                    ), 0)
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE op.id = ?1",
            rusqlite::params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("load payment settlement equation: {e}"))?;

    let Some((payment_cents, order_total_cents, refund_cents)) = row else {
        return Ok(None);
    };
    if refund_cents <= 0 {
        return Ok(Some(format!(
            "{} - 0.00 = {}; local order total {}",
            format_cents(payment_cents),
            format_cents(payment_cents),
            format_cents(order_total_cents),
        )));
    }
    Ok(Some(format!(
        "{} - {} = {}; local order total {}",
        format_cents(payment_cents),
        format_cents(refund_cents),
        format_cents(payment_cents - refund_cents),
        format_cents(order_total_cents),
    )))
}

fn promote_waiting_settlement_refunds_for_payment(
    conn: &rusqlite::Connection,
    payment_id: &str,
) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "SELECT pa.id
             FROM payment_adjustments pa
             JOIN order_payments op ON op.id = pa.payment_id
             WHERE pa.payment_id = ?1
               AND pa.sync_state = 'waiting_parent'
               AND pa.adjustment_type = 'refund'
               AND COALESCE(pa.adjustment_context, '') = 'edit_settlement'
               AND op.sync_state = 'applied'
               AND NULLIF(TRIM(COALESCE(op.remote_payment_id, '')), '') IS NOT NULL",
        )
        .map_err(|e| format!("prepare waiting settlement refunds: {e}"))?;

    let adjustment_ids: Vec<String> = stmt
        .query_map(rusqlite::params![payment_id], |row| row.get(0))
        .map_err(|e| format!("query waiting settlement refunds: {e}"))?
        .filter_map(Result::ok)
        .collect();
    drop(stmt);

    let now = chrono::Utc::now().to_rfc3339();
    let mut promoted = 0usize;
    for adjustment_id in adjustment_ids {
        let updated = conn
            .execute(
                "UPDATE payment_adjustments
                 SET sync_state = 'pending',
                     sync_retry_count = 0,
                     sync_last_error = NULL,
                     sync_next_retry_at = NULL,
                     updated_at = ?1
                 WHERE id = ?2
                   AND sync_state = 'waiting_parent'",
                rusqlite::params![now, adjustment_id.as_str()],
            )
            .map_err(|e| format!("promote waiting settlement refund: {e}"))?;
        if updated == 0 {
            continue;
        }
        promoted += 1;

        let _ = conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'pending',
                 attempts = 0,
                 last_attempt = NULL,
                 error_message = NULL,
                 next_retry_at = NULL,
                 retry_delay_ms = 1000,
                 priority = CASE WHEN priority > 1 THEN priority ELSE 1 END,
                 claim_generation = claim_generation + 1
             WHERE table_name = 'payment_adjustments'
               AND record_id = ?1
               AND status IN ('pending', 'processing', 'failed', 'conflict')",
            rusqlite::params![adjustment_id.as_str()],
        );
    }

    Ok(promoted)
}

#[tauri::command]
pub async fn recovery_list_points(
    db: tauri::State<'_, db::DbState>,
) -> Result<recovery::RecoveryListResponse, String> {
    let points = recovery::list_recovery_points(&db)?;
    Ok(recovery::RecoveryListResponse {
        success: true,
        points,
    })
}

#[tauri::command]
pub async fn recovery_create_snapshot(
    db: tauri::State<'_, db::DbState>,
) -> Result<recovery::RecoveryPointMetadata, String> {
    recovery::create_manual_snapshot(&db)
}

#[tauri::command]
pub async fn recovery_export_current(
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<recovery::RecoveryExportResponse, auth::GuardedCommandError> {
    auth::authorize_privileged_action(
        auth::PrivilegedActionScope::SystemControl,
        &db,
        &auth_state,
    )?;
    recovery::export_current_bundle(&db).map_err(Into::into)
}

#[tauri::command]
pub async fn recovery_export_point(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<recovery::RecoveryExportResponse, auth::GuardedCommandError> {
    auth::authorize_privileged_action(
        auth::PrivilegedActionScope::SystemControl,
        &db,
        &auth_state,
    )?;
    let point_id = parse_point_id(arg0)?;
    recovery::export_recovery_point(&db, &point_id).map_err(Into::into)
}

#[tauri::command]
pub async fn recovery_restore_point(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<recovery::RecoveryRestoreResponse, auth::GuardedCommandError> {
    auth::authorize_privileged_action(
        auth::PrivilegedActionScope::SystemControl,
        &db,
        &auth_state,
    )?;
    let point_id = parse_point_id(arg0)?;
    recovery::stage_restore_from_point(&db, &point_id).map_err(Into::into)
}

#[tauri::command]
pub async fn recovery_open_dir(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let app_data_dir = db
        .db_path
        .parent()
        .ok_or_else(|| "database path does not have a parent directory".to_string())?;
    let recovery_root = recovery::recovery_root_for_app_data(app_data_dir);
    let requested_path = parse_open_dir_payload(arg0);
    let target = if let Some(requested_path) = requested_path {
        let candidate = std::path::PathBuf::from(&requested_path);
        let normalized = if candidate.is_file() {
            candidate
                .parent()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| recovery_root.clone())
        } else {
            candidate
        };
        if !normalized.starts_with(&recovery_root) {
            return Err("Recovery path must stay inside the recovery directory".into());
        }
        normalized
    } else {
        recovery_root.clone()
    };

    if !target.exists() {
        return Err(format!(
            "Recovery directory does not exist: {}",
            target.display()
        ));
    }

    open_directory(&target)?;
    Ok(serde_json::json!({
        "success": true,
        "path": target.to_string_lossy().to_string(),
    }))
}

#[tauri::command]
pub async fn recovery_execute_action(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, auth::GuardedCommandError> {
    let request = arg0.ok_or_else(|| "Missing recovery action request".to_string())?;
    let action_id = request
        .get("actionId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match action_id {
        "openConnectionSettings" => Ok(json!({
            "success": true,
            "requiresRefresh": false,
            "routeTarget": {
                "screen": "connectionSettings",
            },
        })),
        "contactOperator" => Ok(json!({
            "success": true,
            "requiresRefresh": false,
            "message": "No automated fix is available for this issue yet. Contact operator.",
        })),
        "clearLegacyFinancialOrphan" => {
            let entity_type = request_field_str(&request, "entityType")
                .map(ToOwned::to_owned)
                .or_else(|| request_param_str(&request, "entityType"))
                .or_else(|| request_param_str(&request, "entity_type"))
                .ok_or("Missing entityType for legacy orphan cleanup")?;
            let entity_id = request_field_str(&request, "entityId")
                .map(ToOwned::to_owned)
                .or_else(|| request_param_str(&request, "entityId"))
                .or_else(|| request_param_str(&request, "entity_id"))
                .or_else(|| request_field_str(&request, "paymentId").map(ToOwned::to_owned))
                .or_else(|| request_param_str(&request, "paymentId"))
                .or_else(|| request_field_str(&request, "adjustmentId").map(ToOwned::to_owned))
                .or_else(|| request_param_str(&request, "adjustmentId"))
                .ok_or("Missing entityId for legacy orphan cleanup")?;

            info!(
                entity_type = %entity_type,
                entity_id = %entity_id,
                "Running local legacy financial parity orphan cleanup"
            );

            let orphan_rows =
                sync::count_legacy_financial_parity_orphan_rows(&db, &entity_type, &entity_id)
                    .map_err(auth::GuardedCommandError::from)?;
            if orphan_rows == 0 {
                return Ok(json!({
                    "success": true,
                    "requiresRefresh": true,
                    "message": "No stale legacy financial rows remained for this issue.",
                }));
            }

            let result = sync::clear_legacy_financial_parity_orphan(&db, &entity_type, &entity_id)
                .map_err(auth::GuardedCommandError::from)?;

            info!(
                entity_type = %entity_type,
                entity_id = %entity_id,
                cleared = result.cleared,
                "Completed local legacy financial parity orphan cleanup"
            );

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Cleared {} stale legacy financial parity row(s).",
                    result.cleared,
                ),
            }))
        }
        "openShiftRepair" | "forceCloseShift" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let shift_id = request
                .get("shiftId")
                .and_then(|v| v.as_str())
                .ok_or("Missing shiftId for shift repair action")?;

            let reason = request
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("Stuck shift recovery via POS");

            let body = json!({
                "shift_id": shift_id,
                "reason": reason,
            });

            let api_result =
                crate::admin_fetch(Some(&db), "/api/pos/shifts/force-close", "POST", Some(body))
                    .await
                    .map_err(|e| format!("Force-close API call failed: {e}"))?;

            let api_success = api_result
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if !api_success {
                let api_error = api_result
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown server error");
                return Err(format!("Server rejected force-close: {api_error}").into());
            }

            // Update local SQLite to match
            let now = chrono::Utc::now().to_rfc3339();
            if let Ok(conn) = db.conn.lock() {
                let _ = conn.execute(
                    "UPDATE staff_shifts
                     SET status = 'abandoned',
                         check_out_time = ?1,
                         closing_cash_amount = 0,
                         expected_cash_amount = 0,
                         cash_variance = 0,
                         sync_status = 'synced',
                         updated_at = ?1
                     WHERE id = ?2",
                    rusqlite::params![now, shift_id],
                );

                // Close associated cash_drawer_sessions
                let _ = conn.execute(
                    "UPDATE cash_drawer_sessions
                     SET closed_at = ?1,
                         closing_amount = 0,
                         updated_at = ?1
                     WHERE staff_shift_id = ?2 AND closed_at IS NULL",
                    rusqlite::params![now, shift_id],
                );
            }

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": "Shift force-closed successfully",
            }))
        }

        "retrySync" => {
            let queue_id = request.get("queueId").and_then(|v| v.as_i64());
            let entity_id = request
                .get("entityId")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if let Some(qid) = queue_id {
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = 'pending', retry_count = 0, updated_at = datetime('now') WHERE id = ?1",
                        rusqlite::params![qid],
                    );
                }
            } else if !entity_id.is_empty() {
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = 'pending', retry_count = 0, updated_at = datetime('now') WHERE entity_id = ?1 AND status IN ('failed', 'blocked')",
                        rusqlite::params![entity_id],
                    );
                }
            }

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": "Sync rows were requeued.",
            }))
        }
        "runParitySyncNow" => {
            let admin_url = load_admin_url(&db)?;
            let api_key = load_pos_api_key()?;
            let result = sync_queue::process_queue(&db.conn, &admin_url, &api_key)
                .await
                .map_err(auth::GuardedCommandError::from)?;
            let status = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                sync_queue::get_status(&conn)
            }
            .map_err(auth::GuardedCommandError::from)?;

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Parity sync processed {} item(s), failed {}, conflicts {}, remaining {}.",
                    result.processed,
                    result.failed,
                    result.conflicts,
                    status.total,
                ),
            }))
        }
        "repairPaymentTotalConflict" => {
            // Safe recovery only: this requeues the parent order update and the
            // known payment parity row. It does not void, delete, or mutate
            // drawer cash, so it must be available from Recovery Center even
            // when no staff shift session is active.
            let payment_id = request_field_str(&request, "paymentId")
                .map(ToOwned::to_owned)
                .or_else(|| request_param_str(&request, "paymentId"))
                .or_else(|| request_param_str(&request, "sampleRecordId"))
                .or_else(|| request_param_str(&request, "payment_id"))
                .or_else(|| request_field_str(&request, "entityId").map(ToOwned::to_owned))
                .ok_or_else(|| {
                    "Missing payment id for payment/order mismatch repair".to_string()
                })?;

            let (order_id, queued_parent_order) = {
                let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
                prepare_payment_total_conflict_repair(&conn, payment_id.as_str())
                    .map_err(auth::GuardedCommandError::from)?
            };

            let admin_url = load_admin_url(&db)?;
            let api_key = load_pos_api_key()?;
            let result = sync_queue::process_queue(&db.conn, &admin_url, &api_key)
                .await
                .map_err(auth::GuardedCommandError::from)?;
            let promoted_adjustments = {
                let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
                promote_waiting_settlement_refunds_for_payment(&conn, payment_id.as_str())
                    .map_err(auth::GuardedCommandError::from)?
            };
            let adjustment_result = if promoted_adjustments > 0 {
                Some(
                    sync_queue::process_queue(&db.conn, &admin_url, &api_key)
                        .await
                        .map_err(auth::GuardedCommandError::from)?,
                )
            } else {
                None
            };
            let remaining_conflict = {
                let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
                failed_payment_total_conflict_for_payment(&conn, payment_id.as_str())
                    .map_err(auth::GuardedCommandError::from)?
            };

            if let Some(error) = remaining_conflict {
                let equation = {
                    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
                    load_payment_settlement_equation(&conn, payment_id.as_str())
                        .map_err(auth::GuardedCommandError::from)?
                };
                return Err(format!(
                    "Payment/order mismatch still exists for payment {payment_id}: {error}. {}",
                    equation
                        .map(|value| format!("Settlement math: {value}."))
                        .unwrap_or_else(|| "Settlement math unavailable.".to_string())
                )
                .into());
            }

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Payment/order mismatch repair retried payment {payment_id} for order {order_id}. Parent order update queued: {}. Processed {}, failed {}, conflicts {}. Promoted refund adjustments: {}. Adjustment pass processed {}, failed {}, conflicts {}.",
                    if queued_parent_order { "yes" } else { "no" },
                    result.processed,
                    result.failed,
                    result.conflicts,
                    promoted_adjustments,
                    adjustment_result.as_ref().map(|value| value.processed).unwrap_or(0),
                    adjustment_result.as_ref().map(|value| value.failed).unwrap_or(0),
                    adjustment_result.as_ref().map(|value| value.conflicts).unwrap_or(0),
                ),
            }))
        }
        "retryParityItem" => {
            let item_id = request_param_str(&request, "sampleItemId")
                .or_else(|| request_field_str(&request, "entityId").map(ToOwned::to_owned))
                .ok_or_else(|| "Missing parity item id".to_string())?;
            {
                let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
                sync_queue::retry_item(&conn, item_id.as_str())
                    .map_err(auth::GuardedCommandError::from)?;
            }
            let admin_url = load_admin_url(&db)?;
            let api_key = load_pos_api_key()?;
            let result = sync_queue::process_queue(&db.conn, &admin_url, &api_key)
                .await
                .map_err(auth::GuardedCommandError::from)?;
            let status = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                sync_queue::get_status(&conn)
            }
            .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Parity item was retried now: processed {}, failed {}, conflicts {}, remaining {}.",
                    result.processed,
                    result.failed,
                    result.conflicts,
                    status.total,
                ),
            }))
        }
        "retryParityModule" => {
            let module_type = request_param_str(&request, "moduleType")
                .or_else(|| request_field_str(&request, "entityId").map(ToOwned::to_owned))
                .ok_or_else(|| "Missing parity module type".to_string())?;
            let result = {
                let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
                sync_queue::retry_items_by_module(&conn, module_type.as_str())
            }
            .map_err(auth::GuardedCommandError::from)?;
            let admin_url = load_admin_url(&db)?;
            let api_key = load_pos_api_key()?;
            let process_result = sync_queue::process_queue(&db.conn, &admin_url, &api_key)
                .await
                .map_err(auth::GuardedCommandError::from)?;
            let status = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                sync_queue::get_status(&conn)
            }
            .map_err(auth::GuardedCommandError::from)?;

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Parity module {} retried {} item(s) now: processed {}, failed {}, conflicts {}, remaining {}.",
                    module_type,
                    result.retried,
                    process_result.processed,
                    process_result.failed,
                    process_result.conflicts,
                    status.total,
                ),
            }))
        }
        "validatePendingOrders" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let result =
                sync::validate_pending_orders(&db).map_err(auth::GuardedCommandError::from)?;
            let total_pending = result
                .get("total_pending")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let invalid = result.get("invalid").and_then(Value::as_i64).unwrap_or(0);
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Validated {total_pending} pending order(s); {invalid} invalid row(s) still need removal.",
                ),
            }))
        }
        "removeInvalidOrders" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let order_ids = request_param_string_array(&request, "orderIds");
            if order_ids.is_empty() {
                return Err("No invalid orders were provided for removal".into());
            }
            let result = sync::remove_invalid_orders(&db, order_ids)
                .map_err(auth::GuardedCommandError::from)?;
            let removed = result.get("removed").and_then(Value::as_i64).unwrap_or(0);
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Removed {removed} invalid order row(s) from the local queue."),
            }))
        }
        "retryFinancialItem" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let queue_id = request_field_i64(&request, "queueId")
                .or_else(|| request_param_i64(&request, "queueId"))
                .ok_or_else(|| "Missing financial queue id".to_string())?;
            sync::retry_financial_queue_item(&db, queue_id)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": "Financial sync item was requeued.",
            }))
        }
        "retryAllFailedFinancial" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let count: usize = {
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

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {count} failed financial sync item(s)."),
            }))
        }
        "resolveCheckoutPaymentBlocker" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;

            let order_id = request_field_str(&request, "orderId")
                .map(ToOwned::to_owned)
                .ok_or_else(|| "Missing orderId for checkout payment repair".to_string())?;
            let preferred_method = request_param_str(&request, "preferredMethod")
                .or_else(|| request_param_str(&request, "paymentMethod"))
                .or_else(
                    || match request_param_str(&request, "reasonCode").as_deref() {
                        Some("missing_cash_payment") | Some("partial_cash_payment") => {
                            Some("cash".to_string())
                        }
                        Some("missing_card_payment") | Some("partial_card_payment") => {
                            Some("card".to_string())
                        }
                        _ => None,
                    },
                )
                .unwrap_or_else(|| "card".to_string());

            let result = payments::resolve_unsettled_payment_blocker_payment(
                &db,
                &json!({
                    "orderId": order_id,
                    "method": preferred_method,
                }),
            )
            .map_err(auth::GuardedCommandError::from)?;

            let success = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !success {
                let message = result
                    .get("error")
                    .and_then(Value::as_str)
                    .or_else(|| result.get("message").and_then(Value::as_str))
                    .unwrap_or("Failed to repair the missing payment record");
                return Err(message.to_string().into());
            }

            let order_number = request_field_str(&request, "orderNumber")
                .unwrap_or("the order")
                .to_string();
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Recorded the missing {} payment for {}.",
                    preferred_method,
                    order_number,
                ),
            }))
        }
        "repairOrphanedFinancial" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let admin_url = load_admin_url(&db)?;
            let api_key = load_pos_api_key()?;
            let stats = sync::repair_orphaned_financial_queue_items(&db, &admin_url, &api_key)
                .await
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Repaired {} orphaned item(s), requeued {}, skipped {}.",
                    stats.repaired,
                    stats.requeued,
                    stats.skipped,
                ),
            }))
        }
        "repairWaitingParentPayments" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired =
                sync::reconcile_deferred_payments(&db).map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Promoted {repaired} waiting-parent payment(s) for retry."),
            }))
        }
        "repairWaitingParentAdjustments" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::reconcile_deferred_adjustments(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Promoted {repaired} waiting-parent adjustment(s) for retry."),
            }))
        }
        "requeueFailedOrderValidationRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_failed_order_validation_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} failed order validation row(s)."),
            }))
        }
        "requeueRetryableFailedShiftRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_retryable_failed_shift_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} retryable failed shift row(s)."),
            }))
        }
        "requeueFailedFinancialShiftRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_failed_financial_shift_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} failed shift-bound financial row(s)."),
            }))
        }
        "requeueFailedShiftCashierReferenceRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_failed_shift_cashier_reference_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} failed cashier-reference shift row(s)."),
            }))
        }
        "requeueFailedAdjustmentMissingEndpointRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_failed_adjustment_missing_endpoint_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} adjustment row(s) blocked by the legacy endpoint error."),
            }))
        }
        "requeueFailedAdjustmentLegacyValidationRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_failed_adjustment_legacy_validation_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} adjustment row(s) blocked by legacy validation."),
            }))
        }

        _ => Err(format!("Unknown recovery action: {action_id}").into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    fn test_db() -> db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    #[test]
    fn payment_total_conflict_repair_promotes_waiting_settlement_refund_parity_row() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-recovery-settlement', 'remote-order-recovery-settlement', '[]', 4.89, 489, 'completed', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, sync_status, sync_state, remote_payment_id, created_at, updated_at
             ) VALUES (
                 'pay-recovery-settlement', 'order-recovery-settlement', 'card', 15.19, 1519, 'completed', 'synced', 'applied',
                 '42d3701a-6b2f-4fbb-b803-36216bf2df44', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed payment");
        conn.execute(
            "INSERT INTO payment_adjustments (
                 id, payment_id, order_id, adjustment_type, amount, amount_cents, reason,
                 adjustment_context, idempotency_key, sync_state, created_at, updated_at
             ) VALUES (
                 'adj-recovery-settlement', 'pay-recovery-settlement', 'order-recovery-settlement',
                 'refund', 10.30, 1030, 'Order edit settlement',
                 'edit_settlement', 'adjustment:adj-recovery-settlement',
                 'waiting_parent', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed adjustment");
        crate::sync_queue::enqueue_payload_item(
            &conn,
            "payment_adjustments",
            "adj-recovery-settlement",
            "INSERT",
            &json!({
                "paymentId": "pay-recovery-settlement",
                "orderId": "order-recovery-settlement",
                "adjustmentType": "refund",
                "adjustmentContext": "edit_settlement",
                "amount": 10.30,
            }),
            Some(1),
            Some("payment"),
            Some("manual"),
            Some(1),
        )
        .expect("enqueue adjustment");
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 error_message = 'Waiting for parent payment sync'
             WHERE table_name = 'payment_adjustments'
               AND record_id = 'adj-recovery-settlement'",
            [],
        )
        .expect("defer adjustment parity row");

        let promoted =
            promote_waiting_settlement_refunds_for_payment(&conn, "pay-recovery-settlement")
                .expect("promote waiting refund");
        assert_eq!(promoted, 1);

        let sync_state: String = conn
            .query_row(
                "SELECT sync_state FROM payment_adjustments WHERE id = 'adj-recovery-settlement'",
                [],
                |row| row.get(0),
            )
            .expect("load adjustment state");
        assert_eq!(sync_state, "pending");

        let queue_state: (String, Option<String>) = conn
            .query_row(
                "SELECT status, error_message
                 FROM parity_sync_queue
                 WHERE table_name = 'payment_adjustments'
                   AND record_id = 'adj-recovery-settlement'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load parity row state");
        assert_eq!(queue_state, ("pending".to_string(), None));

        let equation = load_payment_settlement_equation(&conn, "pay-recovery-settlement")
            .expect("load settlement equation")
            .expect("settlement equation");
        assert_eq!(equation, "15.19 - 10.30 = 4.89; local order total 4.89");
    }
}
