//! Tauri IPC command handlers for the Caller ID / VoIP module.

use std::sync::Arc;

use serde_json::Value;
use tracing::{info, warn};

use crate::{
    callerid::{
        self,
        types::{
            CallerIdConfig, CallerIdMode, CallerIdStatusReason, CallerIdTransport,
            ResolvedCallerIdConfig,
        },
    },
    db, storage, value_str,
};

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

fn parse_optional_string(
    payload: &Value,
    keys: &[&str],
    current: Option<String>,
) -> Option<String> {
    for key in keys {
        if let Some(value) = payload.get(*key) {
            if value.is_null() {
                return None;
            }
            if let Some(raw) = value.as_str() {
                let trimmed = raw.trim();
                return if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                };
            }
        }
    }

    current
}

fn parse_u16(payload: &Value, keys: &[&str], current: u16) -> u16 {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(|v| v.as_u64()) {
            return value as u16;
        }
    }
    current
}

fn parse_bool(payload: &Value, keys: &[&str], current: bool) -> bool {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(|v| v.as_bool()) {
            return value;
        }
    }
    current
}

fn parse_password_override(payload: &Value) -> Option<Option<String>> {
    for key in ["password", "sipPassword"] {
        if let Some(value) = payload.get(key) {
            if value.is_null() {
                return Some(None);
            }
            if let Some(raw) = value.as_str() {
                let trimmed = raw.trim();
                return if trimmed.is_empty() {
                    Some(None)
                } else {
                    Some(Some(trimmed.to_string()))
                };
            }
        }
    }

    None
}

fn has_stored_password() -> bool {
    storage::has_credential(storage::KEY_CALLERID_SIP_PASSWORD)
        || storage::has_credential(LEGACY_KEY_SIP_PASSWORD)
}

fn get_stored_password() -> Option<String> {
    storage::get_credential(storage::KEY_CALLERID_SIP_PASSWORD)
        .or_else(|| storage::get_credential(LEGACY_KEY_SIP_PASSWORD))
}

fn set_password(password: Option<&str>) -> Result<(), String> {
    match password {
        Some(value) if !value.trim().is_empty() => {
            storage::set_credential(storage::KEY_CALLERID_SIP_PASSWORD, value.trim())?;
        }
        _ => {
            storage::delete_credential(storage::KEY_CALLERID_SIP_PASSWORD)?;
        }
    }

    if let Err(error) = storage::delete_credential(LEGACY_KEY_SIP_PASSWORD) {
        warn!(
            error = %error,
            "Failed to clear legacy Caller ID SIP password from keyring"
        );
    }

    Ok(())
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

fn save_config(db_state: &db::DbState, config: &CallerIdConfig) -> Result<(), String> {
    let conn = db_state.conn.lock().map_err(|e| e.to_string())?;

    db::set_setting(
        &conn,
        CALLERID_CATEGORY,
        "mode",
        match config.mode {
            CallerIdMode::AuthenticatedSip => "authenticated_sip",
            CallerIdMode::PbxIpTrustLegacy => "pbx_ip_trust_legacy",
        },
    )?;
    db::set_setting(
        &conn,
        CALLERID_CATEGORY,
        "transport",
        match config.transport {
            CallerIdTransport::Udp => "udp",
            CallerIdTransport::Tcp => "tcp",
        },
    )?;
    db::set_setting(&conn, CALLERID_CATEGORY, "sip_server", &config.sip_server)?;
    db::set_setting(
        &conn,
        CALLERID_CATEGORY,
        "sip_port",
        &config.sip_port.to_string(),
    )?;
    db::set_setting(
        &conn,
        CALLERID_CATEGORY,
        "sip_username",
        &config.sip_username,
    )?;
    db::set_setting(
        &conn,
        CALLERID_CATEGORY,
        "auth_username",
        config.auth_username.as_deref().unwrap_or(""),
    )?;
    db::set_setting(
        &conn,
        CALLERID_CATEGORY,
        "outbound_proxy",
        config.outbound_proxy.as_deref().unwrap_or(""),
    )?;
    db::set_setting(
        &conn,
        CALLERID_CATEGORY,
        "provider_preset_id",
        config.provider_preset_id.as_deref().unwrap_or(""),
    )?;
    db::set_setting(
        &conn,
        CALLERID_CATEGORY,
        "listen_port",
        &config.listen_port.to_string(),
    )?;
    db::set_setting(
        &conn,
        CALLERID_CATEGORY,
        "enabled",
        if config.enabled { "true" } else { "false" },
    )?;

    Ok(())
}

fn merge_config_from_payload(base: &CallerIdConfig, payload: &Value) -> CallerIdConfig {
    let mode = parse_mode(value_str(payload, &["mode"]).as_deref(), base.mode);
    let transport = parse_transport(
        value_str(payload, &["transport"]).as_deref(),
        base.transport,
    );

    normalize_config(CallerIdConfig {
        mode,
        transport,
        sip_server: value_str(payload, &["sipServer", "sip_server"])
            .unwrap_or_else(|| base.sip_server.clone()),
        sip_port: parse_u16(payload, &["sipPort", "sip_port"], base.sip_port),
        sip_username: value_str(payload, &["sipUsername", "sip_username"])
            .unwrap_or_else(|| base.sip_username.clone()),
        auth_username: parse_optional_string(
            payload,
            &["authUsername", "auth_username"],
            base.auth_username.clone(),
        ),
        outbound_proxy: parse_optional_string(
            payload,
            &["outboundProxy", "outbound_proxy"],
            base.outbound_proxy.clone(),
        ),
        provider_preset_id: parse_optional_string(
            payload,
            &["providerPresetId", "provider_preset_id"],
            base.provider_preset_id.clone(),
        ),
        listen_port: parse_u16(payload, &["listenPort", "listen_port"], base.listen_port),
        enabled: parse_bool(payload, &["enabled"], base.enabled),
        has_password: base.has_password,
    })
}

fn resolve_runtime_config(
    db_state: &db::DbState,
    payload: Option<&Value>,
) -> Result<ResolvedCallerIdConfig, String> {
    let saved = load_config(db_state);
    let config = payload
        .map(|value| merge_config_from_payload(&saved, value))
        .unwrap_or(saved);

    let password = match payload.and_then(parse_password_override) {
        Some(password_override) => password_override,
        None => get_stored_password(),
    };

    Ok(ResolvedCallerIdConfig {
        config: normalize_config(CallerIdConfig {
            has_password: password.is_some(),
            ..config
        }),
        sip_password: password,
    })
}

fn validate_config(
    resolved: &ResolvedCallerIdConfig,
    require_enabled: bool,
) -> Result<(), (CallerIdStatusReason, String)> {
    let config = &resolved.config;

    if require_enabled && !config.enabled {
        return Err((
            CallerIdStatusReason::InvalidConfig,
            "Caller ID is not enabled".into(),
        ));
    }

    if config.sip_server.is_empty() || config.sip_username.is_empty() {
        return Err((
            CallerIdStatusReason::InvalidConfig,
            "SIP server and username must be configured".into(),
        ));
    }

    if matches!(config.mode, CallerIdMode::AuthenticatedSip)
        && resolved
            .sip_password
            .as_deref()
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
    {
        return Err((
            CallerIdStatusReason::InvalidConfig,
            "A SIP password is required for authenticated SIP".into(),
        ));
    }

    Ok(())
}

fn result_message(success: bool, reason: Option<CallerIdStatusReason>, message: String) -> Value {
    serde_json::json!({
        "success": success,
        "reasonCode": reason,
        "message": message,
    })
}

fn start_listener_with_config(
    app: &tauri::AppHandle,
    mgr: &Arc<callerid::CallerIdManager>,
    cancel_token: &tokio_util::sync::CancellationToken,
    resolved: ResolvedCallerIdConfig,
) -> Result<Value, String> {
    if mgr.is_running() {
        return Ok(serde_json::json!({ "status": "already_running" }));
    }

    if let Err((reason, message)) = validate_config(&resolved, true) {
        mgr.set_error(message.clone(), reason);
        return Err(message);
    }

    mgr.update_config(resolved.config.clone());
    let child_cancel = cancel_token.child_token();
    mgr.set_registering();

    callerid::sip_listener::start_sip_listener(
        resolved,
        Arc::clone(mgr),
        app.clone(),
        child_cancel,
    );

    info!("Caller ID SIP listener started");
    Ok(serde_json::json!({ "status": "started" }))
}

pub fn autostart_if_enabled(
    app: &tauri::AppHandle,
    db_state: &db::DbState,
    mgr: &Arc<callerid::CallerIdManager>,
    cancel_token: &tokio_util::sync::CancellationToken,
) {
    let resolved = match resolve_runtime_config(db_state, None) {
        Ok(config) => config,
        Err(error) => {
            warn!(error = %error, "Caller ID startup load failed");
            return;
        }
    };

    if !resolved.config.enabled {
        return;
    }

    if let Err(error) = start_listener_with_config(app, mgr, cancel_token, resolved) {
        warn!(error = %error, "Caller ID autostart failed");
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Start the SIP listener.
#[tauri::command]
pub async fn callerid_start(
    app: tauri::AppHandle,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, Arc<callerid::CallerIdManager>>,
    cancel_token: tauri::State<'_, tokio_util::sync::CancellationToken>,
) -> Result<Value, String> {
    let resolved = resolve_runtime_config(&db, None)?;
    start_listener_with_config(&app, mgr.inner(), &cancel_token, resolved)
}

/// Stop the SIP listener.
#[tauri::command]
pub async fn callerid_stop(
    mgr: tauri::State<'_, Arc<callerid::CallerIdManager>>,
) -> Result<Value, String> {
    mgr.stop();
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

/// Save caller ID configuration.
#[tauri::command]
pub async fn callerid_save_config(
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, Arc<callerid::CallerIdManager>>,
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<Value, String> {
    let payload = crate::parse_channel_payload(arg0, arg1);
    let saved = load_config(&db);
    let config = merge_config_from_payload(&saved, &payload);

    if let Some(password_override) = parse_password_override(&payload) {
        set_password(password_override.as_deref())?;
    }

    let config = normalize_config(config);
    save_config(&db, &config)?;
    let updated = load_config(&db);
    mgr.update_config(updated);

    info!("Caller ID config saved");
    Ok(serde_json::json!({ "success": true }))
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

/// Test SIP connection — sends a REGISTER and waits for acceptance.
#[tauri::command]
pub async fn callerid_test_connection(
    db: tauri::State<'_, db::DbState>,
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<Value, String> {
    let payload = crate::parse_channel_payload(arg0, arg1);
    let resolved = resolve_runtime_config(
        &db,
        if payload == serde_json::json!({}) {
            None
        } else {
            Some(&payload)
        },
    )?;

    if let Err((reason, message)) = validate_config(&resolved, false) {
        return Ok(result_message(false, Some(reason), message));
    }

    match callerid::sip_listener::test_sip_connection(&resolved).await {
        Ok(()) => Ok(result_message(
            true,
            None,
            "SIP registration accepted — connection successful".into(),
        )),
        Err((reason, message)) => Ok(result_message(false, Some(reason), message)),
    }
}
