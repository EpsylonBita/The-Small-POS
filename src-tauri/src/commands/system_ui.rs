use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde_json::Value;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tracing::info;

use crate::db;

const MAX_CLIPBOARD_TEXT_LEN: usize = 1_000_000;
const DISPLAY_WINDOW_PREFIX: &str = "external-display";
const WINDOW_ZOOM_DEFAULT: f64 = 1.0;
const WINDOW_ZOOM_STEP: f64 = 0.1;
const WINDOW_ZOOM_MIN: f64 = 0.5;
const WINDOW_ZOOM_MAX: f64 = 2.0;

static WINDOW_ZOOM_LEVELS: LazyLock<Mutex<HashMap<String, f64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn value_to_text(value: Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn parse_clipboard_text_payload(arg0: Option<Value>) -> Result<String, String> {
    let text = match arg0 {
        Some(Value::Object(obj)) => {
            let payload = Value::Object(obj);
            crate::value_str(&payload, &["text", "value", "content"]).unwrap_or_default()
        }
        Some(v) => value_to_text(v).unwrap_or_default(),
        None => String::new(),
    };

    if text.len() > MAX_CLIPBOARD_TEXT_LEN {
        return Err(format!(
            "Clipboard payload too large (max {} bytes)",
            MAX_CLIPBOARD_TEXT_LEN
        ));
    }
    Ok(text)
}

fn parse_notification_payload(arg0: Option<Value>) -> (String, String) {
    match arg0 {
        Some(Value::String(message)) => ("The Small POS".to_string(), message),
        Some(Value::Object(obj)) => {
            let payload = Value::Object(obj);
            let title = crate::value_str(&payload, &["title"])
                .unwrap_or_else(|| "The Small POS".to_string());
            let body = crate::value_str(&payload, &["body", "message", "text"]).unwrap_or_default();
            (title, body)
        }
        _ => ("The Small POS".to_string(), String::new()),
    }
}

fn current_window_state(window: &tauri::Window) -> Value {
    let is_maximized = window.is_maximized().unwrap_or(false);
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    serde_json::json!({
        "isMaximized": is_maximized,
        "isFullScreen": is_fullscreen,
    })
}

fn emit_window_state_changed(window: &tauri::Window) {
    let _ = window.emit("window_state_changed", current_window_state(window));
}

fn current_webview_window(window: &tauri::Window) -> Result<tauri::WebviewWindow, String> {
    window
        .app_handle()
        .get_webview_window(window.label())
        .ok_or_else(|| format!("No webview window found for label {}", window.label()))
}

fn current_zoom_scale(window: &tauri::Window) -> f64 {
    WINDOW_ZOOM_LEVELS
        .lock()
        .ok()
        .and_then(|levels| levels.get(window.label()).copied())
        .unwrap_or(WINDOW_ZOOM_DEFAULT)
}

fn set_window_zoom(window: &tauri::Window, scale: f64) -> Result<(), String> {
    let clamped = scale.clamp(WINDOW_ZOOM_MIN, WINDOW_ZOOM_MAX);
    let webview = current_webview_window(window)?;
    webview.set_zoom(clamped).map_err(|e| e.to_string())?;

    if let Ok(mut levels) = WINDOW_ZOOM_LEVELS.lock() {
        levels.insert(window.label().to_string(), clamped);
    }

    Ok(())
}

fn display_content_type(arg0: Option<&Value>) -> String {
    let requested = arg0
        .and_then(|payload| {
            crate::value_str(
                payload,
                &[
                    "contentType",
                    "content_type",
                    "displayType",
                    "display_type",
                    "kind",
                ],
            )
        })
        .unwrap_or_else(|| "customer_display".to_string())
        .trim()
        .to_lowercase();

    match requested.as_str() {
        "kitchen_display" | "kds" | "kitchen" => "kitchen_display".to_string(),
        _ => "customer_display".to_string(),
    }
}

fn display_window_label(content_type: &str) -> String {
    format!("{}-{}", DISPLAY_WINDOW_PREFIX, content_type)
}

fn display_window_title(content_type: &str) -> &'static str {
    match content_type {
        "kitchen_display" => "Kitchen Display",
        _ => "Customer Display",
    }
}

fn display_window_url(content_type: &str) -> WebviewUrl {
    WebviewUrl::App(format!("index.html?externalDisplay={content_type}").into())
}

fn monitor_to_json(index: usize, monitor: &tauri::Monitor) -> Value {
    let size = monitor.size();
    let position = monitor.position();
    let work_area = monitor.work_area();
    serde_json::json!({
        "index": index,
        "id": index,
        "name": monitor
            .name()
            .cloned()
            .unwrap_or_else(|| format!("Display {}", index + 1)),
        "scaleFactor": monitor.scale_factor(),
        "position": {
            "x": position.x,
            "y": position.y,
        },
        "size": {
            "width": size.width,
            "height": size.height,
        },
        "workArea": {
            "x": work_area.position.x,
            "y": work_area.position.y,
            "width": work_area.size.width,
            "height": work_area.size.height,
        },
    })
}

fn read_display_index(arg0: Option<&Value>) -> Option<usize> {
    let payload = arg0?;
    let value = payload
        .get("displayIndex")
        .or_else(|| payload.get("display_index"))
        .or_else(|| payload.get("monitorIndex"))
        .or_else(|| payload.get("monitor_index"))
        .or_else(|| payload.get("id"))?;

    if let Some(n) = value.as_u64() {
        return usize::try_from(n).ok();
    }

    value
        .as_str()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
}

fn active_display_windows(app: &tauri::AppHandle) -> Vec<Value> {
    ["customer_display", "kitchen_display"]
        .into_iter()
        .filter_map(|content_type| {
            let label = display_window_label(content_type);
            if app.get_webview_window(&label).is_some() {
                Some(serde_json::json!({
                    "contentType": content_type,
                    "label": label,
                }))
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
pub async fn display_list_monitors(app: tauri::AppHandle) -> Result<Value, String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let displays: Vec<Value> = monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| monitor_to_json(index, monitor))
        .collect();

    Ok(serde_json::json!({
        "success": true,
        "supported": true,
        "displays": displays,
        "activePresentations": active_display_windows(&app),
    }))
}

#[tauri::command]
pub async fn display_open_window(
    app: tauri::AppHandle,
    arg0: Option<Value>,
) -> Result<Value, String> {
    let content_type = display_content_type(arg0.as_ref());
    let label = display_window_label(&content_type);
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let monitor_index =
        read_display_index(arg0.as_ref()).unwrap_or(if monitors.len() > 1 { 1 } else { 0 });
    let monitor = monitors
        .get(monitor_index)
        .or_else(|| monitors.first())
        .ok_or_else(|| "No monitors are available".to_string())?;

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
    }

    let position = monitor.position();
    let size = monitor.size();
    let scale_factor = monitor.scale_factor().max(1.0);
    let logical_width = f64::from(size.width) / scale_factor;
    let logical_height = f64::from(size.height) / scale_factor;
    let logical_x = f64::from(position.x) / scale_factor;
    let logical_y = f64::from(position.y) / scale_factor;

    let window = WebviewWindowBuilder::new(&app, &label, display_window_url(&content_type))
        .title(display_window_title(&content_type))
        .position(logical_x, logical_y)
        .inner_size(logical_width, logical_height)
        .decorations(false)
        .resizable(true)
        .always_on_top(false)
        .build()
        .map_err(|e| e.to_string())?;

    let _ = window.set_fullscreen(true);
    let _ = window.set_focus();

    Ok(serde_json::json!({
        "success": true,
        "supported": true,
        "activeDisplayId": monitor_index,
        "contentType": content_type,
        "label": label,
        "display": monitor_to_json(monitor_index, monitor),
    }))
}

#[tauri::command]
pub async fn display_close_window(
    app: tauri::AppHandle,
    arg0: Option<Value>,
) -> Result<Value, String> {
    let content_type = display_content_type(arg0.as_ref());
    let label = display_window_label(&content_type);

    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|e| e.to_string())?;
    }

    Ok(serde_json::json!({
        "success": true,
        "contentType": content_type,
        "label": label,
        "activePresentations": active_display_windows(&app),
    }))
}

#[tauri::command]
pub async fn clipboard_read_text(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    match crate::read_system_clipboard_text() {
        Ok(text) => {
            let _ =
                crate::write_local_json(&db, "clipboard_fallback_text", &serde_json::json!(text));
            Ok(serde_json::json!(text))
        }
        Err(_) => {
            let fallback = crate::read_local_json(&db, "clipboard_fallback_text")?;
            Ok(serde_json::json!(fallback
                .as_str()
                .unwrap_or_default()
                .to_string()))
        }
    }
}

#[tauri::command]
pub async fn clipboard_write_text(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let text = parse_clipboard_text_payload(arg0)?;
    let _ = crate::write_local_json(&db, "clipboard_fallback_text", &serde_json::json!(text));
    let _ = crate::write_system_clipboard_text(&text);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn show_notification(arg0: Option<Value>) -> Result<Value, String> {
    let (title, body) = parse_notification_payload(arg0);
    info!(title = %title, body = %body, "show-notification requested");
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn window_get_state(window: tauri::Window) -> Result<Value, String> {
    let state = current_window_state(&window);
    emit_window_state_changed(&window);
    Ok(state)
}

#[tauri::command]
pub async fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())?;
    emit_window_state_changed(&window);
    Ok(())
}

#[tauri::command]
pub async fn window_maximize(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    emit_window_state_changed(&window);
    Ok(())
}

#[tauri::command]
pub async fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_toggle_fullscreen(window: tauri::Window) -> Result<(), String> {
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    window
        .set_fullscreen(!is_fullscreen)
        .map_err(|e| e.to_string())?;
    emit_window_state_changed(&window);
    Ok(())
}

#[tauri::command]
pub async fn window_reload(window: tauri::Window) -> Result<(), String> {
    current_webview_window(&window)?
        .reload()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_force_reload(window: tauri::Window) -> Result<(), String> {
    current_webview_window(&window)?
        .eval("window.location.reload();")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_toggle_devtools(window: tauri::Window) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let webview = current_webview_window(&window)?;
        if webview.is_devtools_open() {
            webview.close_devtools();
        } else {
            webview.open_devtools();
        }
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = window;
        Err("Developer tools are only available in debug builds".to_string())
    }
}

#[tauri::command]
pub async fn window_zoom_in(window: tauri::Window) -> Result<(), String> {
    set_window_zoom(&window, current_zoom_scale(&window) + WINDOW_ZOOM_STEP)
}

#[tauri::command]
pub async fn window_zoom_out(window: tauri::Window) -> Result<(), String> {
    set_window_zoom(&window, current_zoom_scale(&window) - WINDOW_ZOOM_STEP)
}

#[tauri::command]
pub async fn window_zoom_reset(window: tauri::Window) -> Result<(), String> {
    set_window_zoom(&window, WINDOW_ZOOM_DEFAULT)
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_clipboard_text_payload_supports_string_and_object() {
        let from_string = parse_clipboard_text_payload(Some(serde_json::json!("hello world")))
            .expect("string payload should parse");
        let from_object = parse_clipboard_text_payload(Some(serde_json::json!({
            "text": "receipt copied"
        })))
        .expect("object payload should parse");
        assert_eq!(from_string, "hello world");
        assert_eq!(from_object, "receipt copied");
    }

    #[test]
    fn parse_clipboard_text_payload_rejects_oversized_text() {
        let oversized = "a".repeat(MAX_CLIPBOARD_TEXT_LEN + 1);
        let err = parse_clipboard_text_payload(Some(serde_json::json!(oversized)))
            .expect_err("oversized payload should fail");
        assert!(err.contains("Clipboard payload too large"));
    }

    #[test]
    fn parse_notification_payload_supports_string_and_object() {
        let from_string = parse_notification_payload(Some(serde_json::json!("Sync complete")));
        let from_object = parse_notification_payload(Some(serde_json::json!({
            "title": "Print",
            "message": "Job queued"
        })));
        assert_eq!(from_string.0, "The Small POS");
        assert_eq!(from_string.1, "Sync complete");
        assert_eq!(from_object.0, "Print");
        assert_eq!(from_object.1, "Job queued");
    }
}
