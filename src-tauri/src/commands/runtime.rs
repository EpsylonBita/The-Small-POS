use tauri::Emitter;
use tracing::info;

use crate::{
    auth, db, ecr, payload_arg0_as_string, storage, validate_external_url, APP_START_EPOCH,
};

fn parse_external_url_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(arg0, &["url", "href", "target", "value"])
        .ok_or("Missing external URL payload".into())
}

#[tauri::command]
pub async fn app_shutdown(
    app: tauri::AppHandle,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<(), auth::GuardedCommandError> {
    auth::authorize_privileged_action(
        auth::PrivilegedActionScope::SystemControl,
        &db,
        &auth_state,
    )?;
    info!("app:shutdown requested");
    let _ = app.emit(
        "control_command_received",
        serde_json::json!({ "command": "shutdown" }),
    );
    let _ = app.emit(
        "app_shutdown_initiated",
        serde_json::json!({ "source": "ipc" }),
    );
    let _ = app.emit("app_close", serde_json::json!({ "reason": "shutdown" }));
    mgr.shutdown();
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn app_restart(
    app: tauri::AppHandle,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<(), auth::GuardedCommandError> {
    auth::authorize_privileged_action(
        auth::PrivilegedActionScope::SystemControl,
        &db,
        &auth_state,
    )?;
    info!("app:restart requested");
    let _ = app.emit(
        "control_command_received",
        serde_json::json!({ "command": "restart" }),
    );
    let _ = app.emit(
        "app_restart_initiated",
        serde_json::json!({ "source": "ipc" }),
    );
    mgr.shutdown();
    app.restart();
}

#[tauri::command]
pub async fn app_get_version() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }))
}

#[tauri::command]
pub async fn app_get_shutdown_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "shuttingDown": false }))
}

#[tauri::command]
pub async fn system_get_info(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let db_size = std::fs::metadata(&db.db_path).map(|m| m.len()).unwrap_or(0);
    let is_configured = storage::is_configured();
    let start = APP_START_EPOCH.load(std::sync::atomic::Ordering::Relaxed);
    let uptime = if start > 0 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        now.saturating_sub(start)
    } else {
        0
    };

    Ok(serde_json::json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
        "db_path": db.db_path.to_string_lossy(),
        "db_size_bytes": db_size,
        "is_configured": is_configured,
        "uptime_seconds": uptime,
    }))
}

#[tauri::command]
pub async fn system_open_external_url(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let url_raw = parse_external_url_payload(arg0)?;
    let parsed = validate_external_url(&url_raw, Some(&db))?;
    let host = parsed.host_str().unwrap_or("unknown").to_string();
    let scheme = parsed.scheme().to_string();
    webbrowser::open(parsed.as_str()).map_err(|e| format!("Failed to open external URL: {e}"))?;
    info!(
        scheme = %scheme,
        host = %host,
        "Opened external URL via secure gateway"
    );
    Ok(serde_json::json!({
        "success": true,
        "host": host,
        "scheme": scheme
    }))
}

#[tauri::command]
pub async fn geo_ip() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // Primary provider
    if let Ok(resp) = client.get("https://ipapi.co/json/").send().await {
        if resp.status().is_success() {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                if let (Some(lat), Some(lng)) = (
                    v.get("latitude").and_then(|x| x.as_f64()),
                    v.get("longitude").and_then(|x| x.as_f64()),
                ) {
                    return Ok(serde_json::json!({
                        "ok": true,
                        "latitude": lat,
                        "longitude": lng
                    }));
                }
            }
        }
    }

    // Fallback provider
    if let Ok(resp) = client.get("https://ipwho.is/").send().await {
        if resp.status().is_success() {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                if let (Some(lat), Some(lng)) = (
                    v.get("latitude").and_then(|x| x.as_f64()),
                    v.get("longitude").and_then(|x| x.as_f64()),
                ) {
                    return Ok(serde_json::json!({
                        "ok": true,
                        "latitude": lat,
                        "longitude": lng
                    }));
                }
            }
        }
    }

    Ok(serde_json::json!({ "ok": false }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_external_url_payload_supports_string_and_object() {
        let from_string =
            parse_external_url_payload(Some(serde_json::json!("https://example.com")))
                .expect("string URL should parse");
        let from_object = parse_external_url_payload(Some(serde_json::json!({
            "url": "https://example.org"
        })))
        .expect("object URL should parse");
        assert_eq!(from_string, "https://example.com");
        assert_eq!(from_object, "https://example.org");
    }

    #[test]
    fn parse_external_url_payload_rejects_missing() {
        let err = parse_external_url_payload(Some(serde_json::json!({})))
            .expect_err("missing URL should fail");
        assert!(err.contains("Missing external URL payload"));
    }
}
