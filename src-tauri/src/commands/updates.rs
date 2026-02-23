use std::sync::atomic::{AtomicU64, Ordering};

use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

use crate::{db, UpdaterRuntimeState};

fn parse_update_channel_payload(arg0: Option<serde_json::Value>) -> String {
    let raw = match arg0 {
        Some(serde_json::Value::Object(obj)) => {
            let payload = serde_json::Value::Object(obj);
            crate::value_str(
                &payload,
                &["channel", "updateChannel", "update_channel", "arg0"],
            )
        }
        Some(serde_json::Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    };

    raw.unwrap_or_else(|| "stable".to_string()).to_lowercase()
}

#[tauri::command]
pub async fn update_get_state(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    crate::read_update_state(&db)
}

#[tauri::command]
pub async fn update_check(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    updater_runtime: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<(), String> {
    let mut state = crate::read_update_state(&db)?;
    if let Some(obj) = state.as_object_mut() {
        obj.insert("checking".to_string(), serde_json::json!(true));
        obj.insert("available".to_string(), serde_json::json!(false));
        obj.insert("downloading".to_string(), serde_json::json!(false));
        obj.insert("ready".to_string(), serde_json::json!(false));
        obj.insert("error".to_string(), serde_json::Value::Null);
        obj.insert("progress".to_string(), serde_json::json!(0));
    }
    crate::write_update_state(&db, &state)?;
    let _ = app.emit("update_checking", serde_json::json!({}));

    if let Ok(mut bytes) = updater_runtime.downloaded_bytes.lock() {
        *bytes = None;
    }

    match crate::updater_manifest_is_reachable().await {
        Ok(true) => {}
        Ok(false) => {
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert(
                    "error".to_string(),
                    serde_json::json!("Updater endpoint is unreachable"),
                );
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            crate::write_update_state(&db, &state)?;
            let _ = app.emit(
                "update_error",
                serde_json::json!({ "message": "Updater endpoint is unreachable" }),
            );
            return Ok(());
        }
        Err(error) => {
            let message = format!("Failed to reach updater manifest: {error}");
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }
            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::json!(message.clone()));
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            crate::write_update_state(&db, &state)?;
            let _ = app.emit("update_error", serde_json::json!({ "message": message }));
            return Ok(());
        }
    }

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            let message = format!("Failed to initialize updater: {error}");
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }
            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::json!(message.clone()));
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            crate::write_update_state(&db, &state)?;
            let _ = app.emit("update_error", serde_json::json!({ "message": message }));
            return Ok(());
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let update_info = crate::update_info_from_release(&update);
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = Some(update);
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(true));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::Value::Null);
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), update_info.clone());
            }
            crate::write_update_state(&db, &state)?;
            let _ = app.emit("update_available", update_info);
        }
        Ok(None) => {
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::Value::Null);
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            crate::write_update_state(&db, &state)?;
            let _ = app.emit("update_not_available", serde_json::Value::Null);
        }
        Err(error) => {
            let message = format!("Failed to check for updates: {error}");
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::json!(message.clone()));
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            crate::write_update_state(&db, &state)?;
            let _ = app.emit("update_error", serde_json::json!({ "message": message }));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn update_download(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    updater_runtime: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<serde_json::Value, String> {
    let pending_update = {
        let guard = updater_runtime
            .pending_update
            .lock()
            .map_err(|e| format!("updater state lock failed: {e}"))?;
        guard.clone()
    };

    let Some(update) = pending_update else {
        let message = "No update available to download".to_string();
        let _ = app.emit(
            "update_error",
            serde_json::json!({ "message": message.clone() }),
        );
        return Ok(serde_json::json!({ "success": false, "error": message }));
    };

    let mut state = crate::read_update_state(&db)?;
    if let Some(obj) = state.as_object_mut() {
        obj.insert("checking".to_string(), serde_json::json!(false));
        obj.insert("available".to_string(), serde_json::json!(true));
        obj.insert("downloading".to_string(), serde_json::json!(true));
        obj.insert("ready".to_string(), serde_json::json!(false));
        obj.insert("error".to_string(), serde_json::Value::Null);
        obj.insert("progress".to_string(), serde_json::json!(0));
    }
    crate::write_update_state(&db, &state)?;
    let _ = app.emit(
        "download_progress",
        serde_json::json!({
            "percent": 0.0,
            "bytesPerSecond": 0,
            "transferred": 0,
            "total": 0
        }),
    );

    let transferred = std::sync::Arc::new(AtomicU64::new(0));
    let transferred_for_event = transferred.clone();
    let app_for_event = app.clone();

    match update
        .download(
            move |chunk_len, total| {
                let total_bytes = total.unwrap_or(0);
                let transferred_now = transferred_for_event
                    .fetch_add(chunk_len as u64, Ordering::Relaxed)
                    + chunk_len as u64;
                let percent = if total_bytes > 0 {
                    (transferred_now as f64 / total_bytes as f64 * 100.0).min(100.0)
                } else {
                    0.0
                };
                let _ = app_for_event.emit(
                    "download_progress",
                    serde_json::json!({
                        "percent": percent,
                        "bytesPerSecond": 0,
                        "transferred": transferred_now,
                        "total": total_bytes
                    }),
                );
            },
            || {},
        )
        .await
    {
        Ok(bytes) => {
            if let Ok(mut downloaded) = updater_runtime.downloaded_bytes.lock() {
                *downloaded = Some(bytes);
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(true));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(true));
                obj.insert("error".to_string(), serde_json::Value::Null);
                obj.insert("progress".to_string(), serde_json::json!(100));
            }
            crate::write_update_state(&db, &state)?;

            let transferred_final = transferred.load(Ordering::Relaxed);
            let _ = app.emit(
                "download_progress",
                serde_json::json!({
                    "percent": 100.0,
                    "bytesPerSecond": 0,
                    "transferred": transferred_final,
                    "total": transferred_final
                }),
            );

            let info = state
                .get("updateInfo")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let _ = app.emit("update_downloaded", info);
            Ok(serde_json::json!({ "success": true }))
        }
        Err(error) => {
            let message = format!("Failed to download update: {error}");
            if let Ok(mut downloaded) = updater_runtime.downloaded_bytes.lock() {
                *downloaded = None;
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::json!(message.clone()));
                obj.insert("progress".to_string(), serde_json::json!(0));
            }
            crate::write_update_state(&db, &state)?;
            let _ = app.emit(
                "update_error",
                serde_json::json!({ "message": message.clone() }),
            );
            Ok(serde_json::json!({ "success": false, "error": message }))
        }
    }
}

#[tauri::command]
pub async fn update_cancel_download(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let message = "Cancelling an in-progress Tauri updater download is not supported".to_string();
    let _ = app.emit(
        "update_error",
        serde_json::json!({ "message": message.clone() }),
    );
    Ok(serde_json::json!({ "success": false, "error": message }))
}

#[tauri::command]
pub async fn update_install(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    updater_runtime: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<serde_json::Value, String> {
    let pending_update = {
        let guard = updater_runtime
            .pending_update
            .lock()
            .map_err(|e| format!("updater state lock failed: {e}"))?;
        guard.clone()
    };
    let downloaded_bytes = {
        let guard = updater_runtime
            .downloaded_bytes
            .lock()
            .map_err(|e| format!("updater bytes lock failed: {e}"))?;
        guard.clone()
    };

    let Some(update) = pending_update else {
        let message = "Update not downloaded".to_string();
        let _ = app.emit(
            "update_error",
            serde_json::json!({ "message": message.clone() }),
        );
        return Ok(serde_json::json!({ "success": false, "error": message }));
    };

    let Some(bytes) = downloaded_bytes else {
        let message = "Update payload is missing. Download the update again.".to_string();
        let _ = app.emit(
            "update_error",
            serde_json::json!({ "message": message.clone() }),
        );
        return Ok(serde_json::json!({ "success": false, "error": message }));
    };

    match update.install(bytes) {
        Ok(_) => {
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }
            if let Ok(mut downloaded) = updater_runtime.downloaded_bytes.lock() {
                *downloaded = None;
            }

            let mut state = crate::read_update_state(&db)?;
            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::Value::Null);
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            crate::write_update_state(&db, &state)?;

            let _ = app.emit(
                "app_restart_required",
                serde_json::json!({ "source": "updater" }),
            );
            Ok(serde_json::json!({ "success": true }))
        }
        Err(error) => {
            let message = format!("Failed to install update: {error}");
            let mut state = crate::read_update_state(&db)?;
            if let Some(obj) = state.as_object_mut() {
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::json!(message.clone()));
            }
            crate::write_update_state(&db, &state)?;

            let _ = app.emit(
                "update_error",
                serde_json::json!({ "message": message.clone() }),
            );
            Ok(serde_json::json!({ "success": false, "error": message }))
        }
    }
}

#[tauri::command]
pub async fn update_set_channel(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let channel = parse_update_channel_payload(arg0);
    if channel != "stable" && channel != "beta" {
        return Err("Invalid update channel".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "update_channel", &channel)?;
    Ok(serde_json::json!({ "success": true, "channel": channel }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_update_channel_payload_supports_string_and_object() {
        let from_string = parse_update_channel_payload(Some(serde_json::json!("beta")));
        let from_object = parse_update_channel_payload(Some(serde_json::json!({
            "update_channel": "stable"
        })));
        assert_eq!(from_string, "beta");
        assert_eq!(from_object, "stable");
    }

    #[test]
    fn parse_update_channel_payload_defaults_to_stable() {
        let from_none = parse_update_channel_payload(None);
        let from_empty = parse_update_channel_payload(Some(serde_json::json!("   ")));
        assert_eq!(from_none, "stable");
        assert_eq!(from_empty, "stable");
    }
}
