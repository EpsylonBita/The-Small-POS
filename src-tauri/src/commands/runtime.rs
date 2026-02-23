use serde::Deserialize;
use std::collections::HashSet;
use std::time::Duration;
use tauri::Emitter;
use tracing::{info, warn};
use uuid::Uuid;

use crate::{db, payload_arg0_as_string, storage, validate_external_url, APP_START_EPOCH};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ScreenCaptureSourcesPayload {
    #[serde(default, alias = "source_types", alias = "sourceTypes")]
    types: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ScreenCaptureSignalPollingPayload {
    #[serde(default, alias = "request_id", alias = "id")]
    request_id: Option<String>,
    #[serde(default)]
    after: Option<String>,
    #[serde(default, alias = "interval_ms")]
    interval_ms: Option<u64>,
}

struct ScreenCaptureSignalPollingHandle {
    request_id: String,
    cancel_tx: tokio::sync::watch::Sender<bool>,
}

#[derive(Default)]
pub struct ScreenCaptureSignalPollingState {
    active: std::sync::Mutex<Option<ScreenCaptureSignalPollingHandle>>,
}

const SCREEN_CAPTURE_AFTER_MAX_LEN: usize = 128;

fn parse_external_url_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(arg0, &["url", "href", "target", "value"])
        .ok_or("Missing external URL payload".into())
}

fn parse_screen_capture_sources_payload(arg0: Option<serde_json::Value>) -> Vec<String> {
    let raw_types: Vec<String> = match arg0 {
        Some(serde_json::Value::Object(obj)) => {
            let payload_value = serde_json::Value::Object(obj.clone());
            let parsed: ScreenCaptureSourcesPayload =
                serde_json::from_value(payload_value).unwrap_or_default();
            if !parsed.types.is_empty() {
                parsed.types
            } else if let Some(single) = obj.get("type").and_then(|v| v.as_str()) {
                vec![single.to_string()]
            } else {
                vec![]
            }
        }
        Some(serde_json::Value::Array(arr)) => arr
            .into_iter()
            .filter_map(|value| value.as_str().map(|s| s.to_string()))
            .collect(),
        Some(serde_json::Value::String(single)) => {
            let trimmed = single.trim();
            if trimmed.is_empty() {
                vec![]
            } else {
                vec![trimmed.to_string()]
            }
        }
        _ => vec![],
    };

    let mut normalized: Vec<String> = raw_types
        .into_iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| matches!(value.as_str(), "screen" | "window"))
        .collect();
    normalized.sort();
    normalized.dedup();
    if normalized.is_empty() {
        normalized.push("screen".to_string());
    }
    normalized
}

fn parse_screen_capture_signal_polling_payload(
    arg0: Option<serde_json::Value>,
) -> Result<(String, Option<String>, Duration), String> {
    let request_id_raw =
        payload_arg0_as_string(arg0.clone(), &["requestId", "request_id", "id", "value"])
            .or_else(|| {
                arg0.clone()
                    .and_then(|value| {
                        serde_json::from_value::<ScreenCaptureSignalPollingPayload>(value).ok()
                    })
                    .and_then(|payload| payload.request_id)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            })
            .ok_or("Missing screen share request ID".to_string())?;
    let request_id = Uuid::parse_str(request_id_raw.trim())
        .map(|value| value.to_string())
        .map_err(|_| "Invalid screen share request ID".to_string())?;

    let mut after: Option<String> = None;
    let mut interval_ms: Option<u64> = None;

    if let Some(value) = arg0 {
        if let Ok(payload) = serde_json::from_value::<ScreenCaptureSignalPollingPayload>(value) {
            if let Some(cursor) = payload
                .after
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
            {
                if cursor.len() > SCREEN_CAPTURE_AFTER_MAX_LEN {
                    return Err("Invalid screen share signal cursor".to_string());
                }
                after = Some(cursor);
            }
            interval_ms = payload.interval_ms;
        }
    }

    let interval = interval_ms.unwrap_or(800).clamp(400, 5000);
    Ok((request_id, after, Duration::from_millis(interval)))
}

#[tauri::command]
pub async fn app_shutdown(app: tauri::AppHandle) -> Result<(), String> {
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
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn app_restart(app: tauri::AppHandle) -> Result<(), String> {
    info!("app:restart requested");
    let _ = app.emit(
        "control_command_received",
        serde_json::json!({ "command": "restart" }),
    );
    let _ = app.emit(
        "app_restart_initiated",
        serde_json::json!({ "source": "ipc" }),
    );
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
pub async fn screen_capture_get_sources(
    arg0: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let requested_types = parse_screen_capture_sources_payload(arg0);
    let _ = app.emit(
        "screen_capture_start",
        serde_json::json!({
            "source": "get_sources",
            "requestedTypes": requested_types.clone()
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "requestedTypes": requested_types,
        "sources": [{
            "id": "primary",
            "name": "Primary Screen",
            "display_id": "primary"
        }]
    }))
    .inspect(|_payload| {
        let _ = app.emit(
            "screen_capture_stop",
            serde_json::json!({ "source": "get_sources" }),
        );
    })
}

#[tauri::command]
pub async fn screen_capture_start_signal_polling(
    arg0: Option<serde_json::Value>,
    app: tauri::AppHandle,
    poll_state: tauri::State<'_, ScreenCaptureSignalPollingState>,
) -> Result<serde_json::Value, String> {
    let (request_id, mut last_signal_timestamp, cadence) =
        parse_screen_capture_signal_polling_payload(arg0)?;

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut guard = poll_state
            .active
            .lock()
            .map_err(|e| format!("screen capture polling state lock: {e}"))?;
        if let Some(existing) = guard.take() {
            let _ = existing.cancel_tx.send(true);
        }
        *guard = Some(ScreenCaptureSignalPollingHandle {
            request_id: request_id.clone(),
            cancel_tx: cancel_tx.clone(),
        });
    }

    let app_handle = app.clone();
    let request_id_for_task = request_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut seen_signal_ids: HashSet<String> = HashSet::new();
        let mut last_request_status: Option<String> = None;

        loop {
            if *cancel_rx.borrow() {
                break;
            }

            let mut polling_url =
                match reqwest::Url::parse("http://localhost/api/pos/screen-share/terminal") {
                    Ok(url) => url,
                    Err(error) => {
                        let error_message =
                            format!("failed to build screen-capture polling URL: {error}");
                        warn!(
                            request_id = %request_id_for_task,
                            error = %error_message,
                            "Screen capture signal polling URL parse failed"
                        );
                        let _ = app_handle.emit(
                            "screen_capture_signal_poll_error",
                            serde_json::json!({
                                "requestId": request_id_for_task.clone(),
                                "error": error_message
                            }),
                        );
                        break;
                    }
                };
            {
                let mut query_pairs = polling_url.query_pairs_mut();
                query_pairs.append_pair("requestId", &request_id_for_task);
                if let Some(after) = last_signal_timestamp.as_ref() {
                    query_pairs.append_pair("after", after);
                }
            }

            let path = match polling_url.query() {
                Some(query) => format!("{}?{}", polling_url.path(), query),
                None => polling_url.path().to_string(),
            };

            match crate::admin_fetch(None, path.as_str(), "GET", None).await {
                Ok(response) => {
                    let request_payload = response
                        .get("request")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let request_status = request_payload
                        .get("status")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string());
                    let status_changed = request_status != last_request_status;

                    let mut new_signals: Vec<serde_json::Value> = Vec::new();
                    if let Some(signals) =
                        response.get("signals").and_then(|value| value.as_array())
                    {
                        for signal in signals {
                            let signal_id = signal
                                .get("id")
                                .and_then(|value| value.as_str())
                                .map(|value| value.to_string());
                            if let Some(id) = signal_id {
                                if seen_signal_ids.contains(&id) {
                                    continue;
                                }
                                seen_signal_ids.insert(id);
                            }

                            if let Some(created_at) =
                                signal.get("created_at").and_then(|value| value.as_str())
                            {
                                if last_signal_timestamp
                                    .as_ref()
                                    .map(|last| created_at > last.as_str())
                                    .unwrap_or(true)
                                {
                                    last_signal_timestamp = Some(created_at.to_string());
                                }
                            }

                            new_signals.push(signal.clone());
                        }
                    }

                    if status_changed || !new_signals.is_empty() {
                        last_request_status = request_status.clone();
                        let _ = app_handle.emit(
                            "screen_capture_signal_batch",
                            serde_json::json!({
                                "requestId": request_id_for_task.clone(),
                                "request": request_payload,
                                "signals": new_signals,
                                "lastSignalTimestamp": last_signal_timestamp
                            }),
                        );
                    }

                    if matches!(request_status.as_deref(), Some("stopped") | Some("failed")) {
                        break;
                    }
                }
                Err(error) => {
                    warn!(
                        request_id = %request_id_for_task,
                        error = %error,
                        "Screen capture signal polling iteration failed"
                    );
                    let _ = app_handle.emit(
                        "screen_capture_signal_poll_error",
                        serde_json::json!({
                            "requestId": request_id_for_task.clone(),
                            "error": error
                        }),
                    );
                }
            }

            tokio::select! {
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        break;
                    }
                }
                _ = tokio::time::sleep(cadence) => {}
            }
        }

        let _ = app_handle.emit(
            "screen_capture_signal_poll_stopped",
            serde_json::json!({
                "requestId": request_id_for_task.clone()
            }),
        );
    });

    Ok(serde_json::json!({
        "success": true,
        "requestId": request_id,
        "intervalMs": cadence.as_millis(),
    }))
}

#[tauri::command]
pub async fn screen_capture_stop_signal_polling(
    arg0: Option<serde_json::Value>,
    poll_state: tauri::State<'_, ScreenCaptureSignalPollingState>,
) -> Result<serde_json::Value, String> {
    let requested_id = payload_arg0_as_string(arg0, &["requestId", "request_id", "id", "value"])
        .map(|value| {
            Uuid::parse_str(value.trim())
                .map(|parsed| parsed.to_string())
                .map_err(|_| "Invalid screen share request ID".to_string())
        })
        .transpose()?;

    let mut stopped = false;
    let mut active_request_id: Option<String> = None;

    let mut guard = poll_state
        .active
        .lock()
        .map_err(|e| format!("screen capture polling state lock: {e}"))?;

    if let Some(active) = guard.as_ref() {
        active_request_id = Some(active.request_id.clone());
        let should_stop = requested_id
            .as_ref()
            .map(|requested| requested == &active.request_id)
            .unwrap_or(true);

        if should_stop {
            if let Some(existing) = guard.take() {
                let _ = existing.cancel_tx.send(true);
                stopped = true;
            }
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "stopped": stopped,
        "requestId": requested_id.or(active_request_id),
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

    #[test]
    fn parse_screen_capture_sources_payload_supports_object_and_defaults() {
        let from_object = parse_screen_capture_sources_payload(Some(serde_json::json!({
            "types": ["screen", "window", "invalid"]
        })));
        assert_eq!(
            from_object,
            vec!["screen".to_string(), "window".to_string()]
        );

        let from_empty = parse_screen_capture_sources_payload(Some(serde_json::json!({})));
        assert_eq!(from_empty, vec!["screen".to_string()]);
    }

    #[test]
    fn parse_screen_capture_sources_payload_supports_legacy_string() {
        let from_string = parse_screen_capture_sources_payload(Some(serde_json::json!("window")));
        assert_eq!(from_string, vec!["window".to_string()]);
    }

    #[test]
    fn parse_screen_capture_signal_polling_payload_supports_string_and_object() {
        let from_string = parse_screen_capture_signal_polling_payload(Some(serde_json::json!(
            "11111111-1111-1111-1111-111111111111"
        )))
        .expect("string payload should parse");
        assert_eq!(from_string.0, "11111111-1111-1111-1111-111111111111");
        assert_eq!(from_string.2.as_millis(), 800);

        let from_object = parse_screen_capture_signal_polling_payload(Some(serde_json::json!({
            "requestId": "22222222-2222-2222-2222-222222222222",
            "after": "2026-02-22T20:00:00.000Z",
            "intervalMs": 1200
        })))
        .expect("object payload should parse");

        assert_eq!(from_object.0, "22222222-2222-2222-2222-222222222222");
        assert_eq!(from_object.1.as_deref(), Some("2026-02-22T20:00:00.000Z"));
        assert_eq!(from_object.2.as_millis(), 1200);
    }

    #[test]
    fn parse_screen_capture_signal_polling_payload_rejects_missing_request_id() {
        let err = parse_screen_capture_signal_polling_payload(Some(serde_json::json!({})))
            .expect_err("missing request id should fail");
        assert!(err.contains("Missing screen share request ID"));
    }

    #[test]
    fn parse_screen_capture_signal_polling_payload_rejects_invalid_request_id() {
        let err = parse_screen_capture_signal_polling_payload(Some(serde_json::json!({
            "requestId": "not-a-uuid",
            "after": "2026-02-22T20:00:00.000Z"
        })))
        .expect_err("invalid request id should fail");
        assert!(err.contains("Invalid screen share request ID"));
    }

    #[test]
    fn parse_screen_capture_signal_polling_payload_rejects_oversized_cursor() {
        let oversized_cursor = "a".repeat(256);
        let err = parse_screen_capture_signal_polling_payload(Some(serde_json::json!({
            "requestId": "22222222-2222-2222-2222-222222222222",
            "after": oversized_cursor
        })))
        .expect_err("oversized cursor should fail");
        assert!(err.contains("Invalid screen share signal cursor"));
    }
}
