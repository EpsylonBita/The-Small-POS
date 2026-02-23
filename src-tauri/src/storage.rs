//! Secure terminal config storage using the OS credential store.
//!
//! On Windows this uses DPAPI (via the `keyring` crate), on macOS Keychain,
//! and on Linux the Secret Service API. This replaces Electron's
//! `safeStorage` + flat-file approach.

use keyring::Entry;
use serde_json::Value;
use tracing::{info, warn};

const SERVICE_NAME: &str = "the-small-pos";

// Credential keys
const KEY_ADMIN_URL: &str = "admin_dashboard_url";
const KEY_TERMINAL_ID: &str = "terminal_id";
const KEY_API_KEY: &str = "pos_api_key";
const KEY_BRANCH_ID: &str = "branch_id";
const KEY_ORG_ID: &str = "organization_id";
const KEY_BUSINESS_TYPE: &str = "business_type";
const KEY_SUPABASE_URL: &str = "supabase_url";
const KEY_SUPABASE_ANON_KEY: &str = "supabase_anon_key";
const KEY_GHOST_MODE_FEATURE_ENABLED: &str = "ghost_mode_feature_enabled";

/// All credential keys managed by this module.
const ALL_KEYS: &[&str] = &[
    KEY_ADMIN_URL,
    KEY_TERMINAL_ID,
    KEY_API_KEY,
    KEY_BRANCH_ID,
    KEY_ORG_ID,
    KEY_BUSINESS_TYPE,
    KEY_SUPABASE_URL,
    KEY_SUPABASE_ANON_KEY,
    KEY_GHOST_MODE_FEATURE_ENABLED,
];

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/// Retrieve a single credential from the OS keyring. Returns `None` when the
/// entry does not exist (or the platform returns a "not found" error).
pub fn get_credential(key: &str) -> Option<String> {
    let entry = match Entry::new(SERVICE_NAME, key) {
        Ok(e) => e,
        Err(e) => {
            warn!(key, error = %e, "keyring: failed to create entry");
            return None;
        }
    };
    match entry.get_password() {
        Ok(pw) => Some(pw),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            warn!(key, error = %e, "keyring: failed to read credential");
            None
        }
    }
}

/// Store a credential in the OS keyring.
pub fn set_credential(key: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a credential from the OS keyring. Silently succeeds if the entry
/// does not exist.
pub fn delete_credential(key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Returns `true` when the three mandatory credentials exist.
pub fn has_credential(key: &str) -> bool {
    get_credential(key).is_some()
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

/// The terminal is considered configured when admin URL, terminal ID, and API
/// key are all present in the credential store.
pub fn is_configured() -> bool {
    has_credential(KEY_ADMIN_URL) && has_credential(KEY_TERMINAL_ID) && has_credential(KEY_API_KEY)
}

/// Return all stored terminal config as a JSON value that matches the shape
/// the React frontend expects.
pub fn get_full_config() -> Value {
    serde_json::json!({
        "terminal_id":     get_credential(KEY_TERMINAL_ID),
        "branch_id":       get_credential(KEY_BRANCH_ID),
        "organization_id": get_credential(KEY_ORG_ID),
        "admin_url":       get_credential(KEY_ADMIN_URL),
        "api_key":         get_credential(KEY_API_KEY),
        "business_type":   get_credential(KEY_BUSINESS_TYPE).unwrap_or_else(|| "food".to_string()),
        "supabase_url":    get_credential(KEY_SUPABASE_URL),
        "supabase_anon_key": get_credential(KEY_SUPABASE_ANON_KEY),
        "ghost_mode_feature_enabled": get_credential(KEY_GHOST_MODE_FEATURE_ENABLED),
    })
}

/// Store terminal credentials received during onboarding.
///
/// Expected JSON shape (camelCase, matching the TS `UpdateTerminalCredentialsPayload`):
/// ```json
/// {
///   "terminalId": "...",
///   "apiKey": "...",
///   "adminUrl": "...",      // optional
///   "branchId": "...",      // optional
///   "organizationId": "..." // optional
/// }
/// ```
pub fn update_terminal_credentials(payload: &Value) -> Result<Value, String> {
    let raw_api_key = payload
        .get("apiKey")
        .or_else(|| payload.get("pos_api_key"))
        .and_then(Value::as_str)
        .ok_or("Missing required field: apiKey")?;
    let mut terminal_id = payload
        .get("terminalId")
        .or_else(|| payload.get("terminal_id"))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut admin_url = payload
        .get("adminDashboardUrl")
        .or_else(|| payload.get("adminUrl"))
        .or_else(|| payload.get("admin_dashboard_url"))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut api_key = raw_api_key.trim().to_string();
    if let Some(decoded_key) = crate::api::extract_api_key_from_connection_string(raw_api_key) {
        api_key = decoded_key;
        if let Some(decoded_tid) =
            crate::api::extract_terminal_id_from_connection_string(raw_api_key)
        {
            terminal_id = Some(decoded_tid);
        }
        if let Some(decoded_url) = crate::api::extract_admin_url_from_connection_string(raw_api_key)
        {
            admin_url = Some(decoded_url);
        }
    }

    let terminal_id = terminal_id.ok_or("Missing required field: terminalId")?;
    if api_key.trim().is_empty() {
        return Err("Missing required field: apiKey".to_string());
    }

    set_credential(KEY_TERMINAL_ID, &terminal_id)?;
    set_credential(KEY_API_KEY, api_key.trim())?;

    if let Some(url) = admin_url.as_deref() {
        let normalized = crate::api::normalize_admin_url(url);
        if !normalized.trim().is_empty() {
            set_credential(KEY_ADMIN_URL, normalized.trim())?;
        }
    }
    if let Some(bid) = payload
        .get("branchId")
        .or_else(|| payload.get("branch_id"))
        .and_then(Value::as_str)
    {
        set_credential(KEY_BRANCH_ID, bid)?;
    }
    if let Some(oid) = payload
        .get("organizationId")
        .or_else(|| payload.get("organization_id"))
        .and_then(Value::as_str)
    {
        set_credential(KEY_ORG_ID, oid)?;
    }
    if let Some(surl) = payload
        .get("supabaseUrl")
        .or_else(|| payload.get("supabase_url"))
        .and_then(Value::as_str)
    {
        set_credential(KEY_SUPABASE_URL, surl)?;
    }
    if let Some(skey) = payload
        .get("supabaseAnonKey")
        .or_else(|| payload.get("supabase_anon_key"))
        .and_then(Value::as_str)
    {
        set_credential(KEY_SUPABASE_ANON_KEY, skey)?;
    }
    if let Some(ghost_enabled) = payload
        .get("ghostModeFeatureEnabled")
        .or_else(|| payload.get("ghost_mode_feature_enabled"))
    {
        let normalized = if let Some(flag) = ghost_enabled.as_bool() {
            Some(flag)
        } else if let Some(flag) = ghost_enabled.as_i64() {
            Some(flag == 1)
        } else if let Some(flag) = ghost_enabled.as_str() {
            let lower = flag.trim().to_ascii_lowercase();
            if lower == "true" || lower == "1" || lower == "yes" || lower == "on" {
                Some(true)
            } else if lower == "false" || lower == "0" || lower == "no" || lower == "off" {
                Some(false)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(flag) = normalized {
            set_credential(
                KEY_GHOST_MODE_FEATURE_ENABLED,
                if flag { "true" } else { "false" },
            )?;
        }
    }

    info!(terminal_id = %terminal_id, "terminal credentials updated");
    Ok(serde_json::json!({ "success": true }))
}

/// Delete every stored credential (factory reset).
pub fn factory_reset() -> Result<Value, String> {
    info!("performing factory reset – deleting all credentials");
    for key in ALL_KEYS {
        delete_credential(key)?;
    }
    Ok(serde_json::json!({ "success": true }))
}

/// Read a single terminal config value by key name.
///
/// The `category` parameter is accepted for compatibility with the existing
/// `terminal_config_get_setting(category, key)` stub but is currently unused.
pub fn get_setting(_category: Option<&str>, key: Option<&str>) -> Value {
    match key {
        Some(k) => match get_credential(k) {
            Some(v) => Value::String(v),
            None => Value::Null,
        },
        None => Value::Null,
    }
}

/// Generic settings getter. For now we read from the credential store; once
/// the SQLite database (M4) is available, `settings_get` / `settings_get_local`
/// will read from the `local_settings` table instead.
pub fn settings_get(key: Option<&str>) -> Value {
    match key {
        Some(k) => match get_credential(k) {
            Some(v) => Value::String(v),
            None => Value::Null,
        },
        None => Value::Null,
    }
}
