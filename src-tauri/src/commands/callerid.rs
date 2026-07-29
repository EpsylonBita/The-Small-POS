//! Tauri IPC command handlers for the Caller ID / VoIP module.

use std::sync::Arc;

use serde_json::Value;
use tracing::info;

use crate::{
    callerid::{
        self,
        types::{CallerIdConfig, CallerIdMode, CallerIdTransport},
    },
    db, storage,
};

const LEGACY_CALLER_ID_DISABLED: &str = "Legacy Caller ID disabled";

/// Legacy SIP password key from the abandoned auth-based flow.
const LEGACY_KEY_SIP_PASSWORD: &str = "sip_password";

/// Settings category for caller ID config in local_settings table.
const CALLERID_CATEGORY: &str = "callerid";

fn parse_mode(value: Option<&str>, default: CallerIdMode) -> CallerIdMode {
    match value.unwrap_or_default().trim() {
        "pbx_ip_trust_legacy" => CallerIdMode::PbxIpTrustLegacy,
        "authenticated_sip" => CallerIdMode::AuthenticatedSip,
        _ => default,
    }
}

fn parse_transport(value: Option<&str>, default: CallerIdTransport) -> CallerIdTransport {
    match value.unwrap_or_default().trim() {
        "tcp" => CallerIdTransport::Tcp,
        "udp" => CallerIdTransport::Udp,
        _ => default,
    }
}

fn has_stored_password() -> bool {
    storage::has_credential(storage::KEY_CALLERID_SIP_PASSWORD)
        || storage::has_credential(LEGACY_KEY_SIP_PASSWORD)
}

fn normalize_config(mut config: CallerIdConfig) -> CallerIdConfig {
    config.sip_server = config.sip_server.trim().to_string();
    config.sip_username = config.sip_username.trim().to_string();
    config.auth_username = config.auth_username.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    config.outbound_proxy = config.outbound_proxy.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    config.provider_preset_id = config.provider_preset_id.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    if config.sip_port == 0 {
        config.sip_port = 5060;
    }
    if config.listen_port == 0 {
        config.listen_port = 5060;
    }
    config.has_password = has_stored_password();
    config
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

fn load_config(db_state: &db::DbState) -> CallerIdConfig {
    let conn = match db_state.conn.lock() {
        Ok(c) => c,
        Err(_) => return CallerIdConfig::default(),
    };

    let get = |key: &str| -> Option<String> {
        db::get_setting(&conn, CALLERID_CATEGORY, key).filter(|v| !v.is_empty())
    };

    let mode_value = get("mode");
    normalize_config(CallerIdConfig {
        mode: parse_mode(mode_value.as_deref(), CallerIdMode::PbxIpTrustLegacy),
        transport: parse_transport(get("transport").as_deref(), CallerIdTransport::Udp),
        sip_server: get("sip_server").unwrap_or_default(),
        sip_port: get("sip_port").and_then(|v| v.parse().ok()).unwrap_or(5060),
        sip_username: get("sip_username").unwrap_or_default(),
        auth_username: get("auth_username"),
        outbound_proxy: get("outbound_proxy"),
        provider_preset_id: get("provider_preset_id"),
        listen_port: get("listen_port")
            .and_then(|v| v.parse().ok())
            .unwrap_or(5060),
        enabled: get("enabled")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false),
        has_password: has_stored_password(),
    })
}

fn resolve_runtime_config(_db_state: &db::DbState, _payload: Option<&Value>) -> Result<(), String> {
    Err(LEGACY_CALLER_ID_DISABLED.to_string())
}

pub fn start_grandstream_fxo_runtime(
    app_handle: tauri::AppHandle,
    mgr: Arc<callerid::CallerIdManager>,
    root_cancel: tokio_util::sync::CancellationToken,
) -> impl std::future::Future<Output = Option<u64>> + Send + 'static {
    let reserved_start =
        callerid::grandstream_fxo::start_connector_supervisor(app_handle, mgr, root_cancel);
    async move {
        let installed_generation = reserved_start.await;
        if let Some(generation) = installed_generation {
            info!(
                generation,
                "Grandstream FXO Caller ID source supervisor started"
            );
        }
        installed_generation
    }
}

async fn complete_callerid_start<F>(start: F) -> Value
where
    F: std::future::Future<Output = Option<u64>>,
{
    if start.await.is_some() {
        serde_json::json!({ "status": "starting" })
    } else {
        serde_json::json!({ "status": "superseded" })
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Start (or restart) the server-configured Grandstream FXO source supervisor.
#[tauri::command]
pub async fn callerid_start(
    app: tauri::AppHandle,
    _db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, Arc<callerid::CallerIdManager>>,
    cancel_token: tauri::State<'_, tokio_util::sync::CancellationToken>,
) -> Result<Value, String> {
    let start =
        start_grandstream_fxo_runtime(app, Arc::clone(mgr.inner()), cancel_token.inner().clone());
    Ok(complete_callerid_start(start).await)
}

/// Stop the SIP listener.
#[tauri::command]
pub async fn callerid_stop(
    mgr: tauri::State<'_, Arc<callerid::CallerIdManager>>,
) -> Result<Value, String> {
    mgr.stop().await;
    info!("Caller ID SIP listener stopped via command");
    Ok(serde_json::json!({ "status": "stopped" }))
}

/// Get the current listener status.
#[tauri::command]
pub async fn callerid_get_status(
    mgr: tauri::State<'_, Arc<callerid::CallerIdManager>>,
) -> Result<Value, String> {
    let status = mgr.get_status();
    Ok(serde_json::to_value(&status).unwrap_or_default())
}

/// Legacy SIP configuration is read-only in the Phase 1 runtime.
#[tauri::command]
pub async fn callerid_save_config(
    db: tauri::State<'_, db::DbState>,
    _mgr: tauri::State<'_, Arc<callerid::CallerIdManager>>,
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<Value, String> {
    let payload = crate::parse_channel_payload(arg0, arg1);
    resolve_runtime_config(&db, Some(&payload))?;
    Err(LEGACY_CALLER_ID_DISABLED.to_string())
}

/// Get caller ID configuration.
#[tauri::command]
pub async fn callerid_get_config(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let config = load_config(&db);

    Ok(serde_json::json!({
        "mode": config.mode,
        "transport": config.transport,
        "sipServer": config.sip_server,
        "sipPort": config.sip_port,
        "sipUsername": config.sip_username,
        "authUsername": config.auth_username,
        "outboundProxy": config.outbound_proxy,
        "providerPresetId": config.provider_preset_id,
        "listenPort": config.listen_port,
        "enabled": config.enabled,
        "hasPassword": config.has_password,
    }))
}

/// Legacy SIP connection tests are unavailable in the Phase 1 runtime.
#[tauri::command]
pub async fn callerid_test_connection(
    db: tauri::State<'_, db::DbState>,
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<Value, String> {
    let payload = crate::parse_channel_payload(arg0, arg1);
    resolve_runtime_config(
        &db,
        if payload == serde_json::json!({}) {
            None
        } else {
            Some(&payload)
        },
    )?;

    Err(LEGACY_CALLER_ID_DISABLED.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn test_db_state() -> db::DbState {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE local_settings (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                setting_category TEXT NOT NULL,
                setting_key TEXT NOT NULL,
                setting_value TEXT NOT NULL,
                last_sync TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE(setting_category, setting_key)
            );",
        )
        .expect("create local_settings");
        db::DbState {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    #[test]
    fn existing_enabled_config_is_rejected_by_legacy_runtime_resolution() {
        let db_state = test_db_state();
        {
            let conn = db_state.conn.lock().expect("lock test db");
            db::set_setting(&conn, CALLERID_CATEGORY, "enabled", "true")
                .expect("seed enabled legacy config");
            db::set_setting(&conn, CALLERID_CATEGORY, "sip_server", "127.0.0.1")
                .expect("seed server");
            db::set_setting(&conn, CALLERID_CATEGORY, "sip_username", "100")
                .expect("seed username");
        }

        let activation = resolve_runtime_config(&db_state, None);

        assert_eq!(
            activation.expect_err("legacy runtime activation must fail closed"),
            "Legacy Caller ID disabled"
        );
        assert!(
            load_config(&db_state).enabled,
            "fail-closed activation must preserve existing user configuration"
        );
    }

    #[test]
    fn runtime_start_wrapper_preserves_connector_install_outcome() {
        fn assert_install_outcome<F, Fut>(_start: F)
        where
            F: FnOnce(
                tauri::AppHandle,
                Arc<callerid::CallerIdManager>,
                tokio_util::sync::CancellationToken,
            ) -> Fut,
            Fut: std::future::Future<Output = Option<u64>>,
        {
        }

        assert_install_outcome(start_grandstream_fxo_runtime);
    }

    #[tokio::test]
    async fn superseded_start_returns_an_honest_command_response() {
        let response = complete_callerid_start(async { None }).await;

        assert_eq!(response, serde_json::json!({ "status": "superseded" }));
    }

    #[tokio::test]
    async fn installed_start_keeps_the_existing_command_response() {
        let response = complete_callerid_start(async { Some(42) }).await;

        assert_eq!(response, serde_json::json!({ "status": "starting" }));
    }
}
