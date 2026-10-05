use crate::lan_transport::{self, LanTransportState};
use serde_json::Value;

#[tauri::command]
pub async fn lan_transport_start(
    arg0: Option<Value>,
    app: tauri::AppHandle,
    state: tauri::State<'_, LanTransportState>,
) -> Result<Value, String> {
    if arg0.as_ref().is_some_and(|value| {
        value
            .get("port")
            .and_then(Value::as_u64)
            .is_some_and(|port| port != lan_transport::PORT as u64)
    }) {
        return Err("LAN_FIXED_PORT_REQUIRED".into());
    }
    lan_transport::enable(app, &state).await
}
#[tauri::command]
pub async fn lan_transport_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanTransportState>,
) -> Result<Value, String> {
    lan_transport::disable(&app, &state).await
}
#[tauri::command]
pub fn lan_transport_status(state: tauri::State<'_, LanTransportState>) -> Result<Value, String> {
    lan_transport::status(&state)
}
fn child(arg0: &Option<Value>) -> Result<&str, String> {
    arg0.as_ref()
        .and_then(|value| value.get("child_terminal_id"))
        .and_then(Value::as_str)
        .ok_or("LAN_CHILD_REQUIRED".into())
}
#[tauri::command]
pub async fn lan_transport_pair(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    lan_transport::pair(&app, child(&arg0)?).await
}
#[tauri::command]
pub async fn lan_transport_revoke(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    lan_transport::revoke(&app, child(&arg0)?).await
}
