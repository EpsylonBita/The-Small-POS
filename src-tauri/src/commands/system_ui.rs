use serde_json::Value;
use tauri::Emitter;
use tracing::info;

use crate::db;

const MAX_CLIPBOARD_TEXT_LEN: usize = 1_000_000;

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
pub async fn window_reload(_window: tauri::Window) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn window_force_reload(_window: tauri::Window) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn window_toggle_devtools() -> Result<(), String> {
    // Devtools toggle is runtime-specific in Tauri v2 and may be disabled in
    // production builds. Keep command parity without hard failure.
    Ok(())
}

#[tauri::command]
pub async fn window_zoom_in(_window: tauri::Window) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn window_zoom_out(_window: tauri::Window) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn window_zoom_reset(_window: tauri::Window) -> Result<(), String> {
    Ok(())
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
