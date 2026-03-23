use serde_json::Value;

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
        return Err(format!("Recovery directory does not exist: {}", target.display()));
    }

    open_directory(&target)?;
    Ok(serde_json::json!({
        "success": true,
        "path": target.to_string_lossy().to_string(),
    }))
}
