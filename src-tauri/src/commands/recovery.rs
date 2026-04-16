use serde_json::{json, Value};

use crate::{auth, db, recovery};

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
    auth::authorize_privileged_action(
        auth::PrivilegedActionScope::CashDrawerControl,
        &db,
        &auth_state,
    )?;

    let request = arg0.ok_or_else(|| "Missing recovery action request".to_string())?;
    let action_id = request
        .get("actionId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match action_id {
        "openShiftRepair" | "forceCloseShift" => {
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
            }))
        }

        _ => Err(format!("Unknown recovery action: {action_id}").into()),
    }
}
