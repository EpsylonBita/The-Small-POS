use rusqlite::params;
use serde_json::Value;
use tauri::Emitter;

use crate::{api, db, menu, storage};

#[derive(Debug, PartialEq)]
struct SettingsSetPayload {
    category: String,
    key: String,
    value_node: Value,
}

fn value_to_settings_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn value_to_bool_string(value: &Value) -> Option<String> {
    if let Some(flag) = value.as_bool() {
        return Some(if flag { "true" } else { "false" }.to_string());
    }
    if let Some(flag) = value.as_i64() {
        return Some(if flag == 1 { "true" } else { "false" }.to_string());
    }
    if let Some(flag) = value.as_str() {
        let normalized = flag.trim().to_ascii_lowercase();
        if normalized == "true" || normalized == "1" || normalized == "yes" || normalized == "on" {
            return Some("true".to_string());
        }
        if normalized == "false" || normalized == "0" || normalized == "no" || normalized == "off" {
            return Some("false".to_string());
        }
    }
    None
}

fn parse_settings_set_payload(
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<SettingsSetPayload, String> {
    let mut category = "general".to_string();
    let mut key: Option<String> = None;
    let mut value_node = arg1.unwrap_or(Value::Null);

    if let Some(Value::Object(obj)) = arg0.as_ref() {
        if let Some(cat) = obj
            .get("category")
            .or_else(|| obj.get("settingType"))
            .and_then(|v| v.as_str())
        {
            if !cat.trim().is_empty() {
                category = cat.trim().to_string();
            }
        }
        key = obj
            .get("key")
            .or_else(|| obj.get("settingKey"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string());
        if value_node.is_null() {
            value_node = obj
                .get("value")
                .or_else(|| obj.get("settingValue"))
                .cloned()
                .unwrap_or(Value::Null);
        }
    }

    if key.is_none() {
        if let Some(Value::String(raw)) = arg0.as_ref() {
            let trimmed = raw.trim();
            if let Some((cat, k)) = trimmed.split_once('.') {
                category = cat.to_string();
                key = Some(k.to_string());
            } else if !trimmed.is_empty() {
                key = Some(trimmed.to_string());
            }
        }
    }

    let key = key.ok_or("Missing setting key")?;
    Ok(SettingsSetPayload {
        category,
        key,
        value_node,
    })
}

fn parse_settings_update_local_payload(
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<Vec<(String, String, String)>, String> {
    let mut updates: Vec<(String, String, String)> = Vec::new();

    if let Some(Value::Object(obj)) = arg0.as_ref() {
        if let Some(setting_type) = obj.get("settingType").and_then(|v| v.as_str()) {
            if let Some(settings_obj) = obj.get("settings").and_then(|v| v.as_object()) {
                for (key, value) in settings_obj {
                    updates.push((
                        setting_type.to_string(),
                        key.clone(),
                        value_to_settings_string(value),
                    ));
                }
            }
        }
    }

    if updates.is_empty() {
        match (arg0.as_ref(), arg1.as_ref()) {
            // Bridge form: settings:update-local('terminal', { branch_id: '...' })
            (Some(Value::String(category)), Some(Value::Object(settings_obj))) => {
                for (key, value) in settings_obj {
                    updates.push((
                        category.clone(),
                        key.clone(),
                        value_to_settings_string(value),
                    ));
                }
            }
            // Legacy/flat form: settings:update-local('terminal.branch_id', '...')
            (Some(Value::String(full_key)), Some(value)) => {
                let value = value_to_settings_string(value);
                if let Some((category, key)) = full_key.split_once('.') {
                    updates.push((category.to_string(), key.to_string(), value));
                } else {
                    updates.push(("general".to_string(), full_key.clone(), value));
                }
            }
            _ => {}
        }
    }

    if updates.is_empty() {
        return Err(
            "settings:update-local expects { settingType, settings } or (category, settings)"
                .to_string(),
        );
    }

    Ok(updates)
}

fn parse_terminal_config_get_setting_payload(
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> (Option<String>, Option<String>) {
    let mut category: Option<String> = None;
    let mut key: Option<String> = None;

    if let Some(Value::Object(obj)) = arg0.as_ref() {
        category = obj
            .get("category")
            .or_else(|| obj.get("settingType"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        key = obj
            .get("key")
            .or_else(|| obj.get("settingKey"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        if key.is_none() {
            if let Some(Value::String(full_key)) = obj
                .get("fullKey")
                .or_else(|| obj.get("setting"))
                .or_else(|| obj.get("name"))
            {
                if let Some((cat, k)) = full_key.split_once('.') {
                    category = Some(cat.to_string());
                    key = Some(k.to_string());
                } else if !full_key.trim().is_empty() {
                    key = Some(full_key.trim().to_string());
                }
            }
        }
    }

    if category.is_none() || key.is_none() {
        if let (Some(Value::String(cat)), Some(Value::String(k))) = (arg0.as_ref(), arg1.as_ref()) {
            if category.is_none() && !cat.trim().is_empty() {
                category = Some(cat.trim().to_string());
            }
            if key.is_none() && !k.trim().is_empty() {
                key = Some(k.trim().to_string());
            }
        }
    }

    if key.is_none() {
        if let Some(Value::String(single)) = arg0.as_ref() {
            let trimmed = single.trim();
            if let Some((cat, k)) = trimmed.split_once('.') {
                category = Some(cat.to_string());
                key = Some(k.to_string());
            } else if !trimmed.is_empty() {
                key = Some(trimmed.to_string());
            }
        }
    }

    (category, key)
}

async fn refresh_terminal_context_from_admin(db: &db::DbState) -> Result<(), String> {
    let raw_api_key =
        storage::get_credential("pos_api_key").ok_or("Terminal not configured: missing API key")?;
    let api_key = api::extract_api_key_from_connection_string(&raw_api_key)
        .unwrap_or_else(|| raw_api_key.clone());
    if api_key != raw_api_key {
        let _ = storage::set_credential("pos_api_key", api_key.trim());
    }

    let terminal_id = storage::get_credential("terminal_id")
        .or_else(|| api::extract_terminal_id_from_connection_string(&raw_api_key))
        .ok_or("Terminal not configured: missing terminal ID")?;
    let _ = storage::set_credential("terminal_id", terminal_id.trim());

    let admin_url = storage::get_credential("admin_dashboard_url")
        .or_else(|| api::extract_admin_url_from_connection_string(&raw_api_key))
        .ok_or("Terminal not configured: missing admin URL")?;
    let normalized_admin_url = api::normalize_admin_url(&admin_url);
    if normalized_admin_url.is_empty() {
        return Err("Terminal not configured: invalid admin URL".into());
    }
    let _ = storage::set_credential("admin_dashboard_url", normalized_admin_url.trim());

    let path = format!("/api/pos/settings/{terminal_id}");
    let resp = api::fetch_from_admin(&normalized_admin_url, &api_key, &path, "GET", None).await?;

    if let Some(bid) = crate::extract_branch_id_from_terminal_settings_response(&resp) {
        let _ = storage::set_credential("branch_id", &bid);
        if let Ok(conn) = db.conn.lock() {
            let _ = db::set_setting(&conn, "terminal", "branch_id", &bid);
        }
        tracing::info!(branch_id = %bid, "Stored branch_id from admin settings");
    }
    if let Some(oid) = crate::extract_org_id_from_terminal_settings_response(&resp) {
        let _ = storage::set_credential("organization_id", &oid);
        if let Ok(conn) = db.conn.lock() {
            let _ = db::set_setting(&conn, "terminal", "organization_id", &oid);
        }
        tracing::info!("Stored organization_id from admin settings");
    }
    if let Some(ghost_enabled) =
        crate::extract_ghost_mode_feature_from_terminal_settings_response(&resp)
    {
        let value = if ghost_enabled { "true" } else { "false" };
        let _ = storage::set_credential("ghost_mode_feature_enabled", value);
        if let Ok(conn) = db.conn.lock() {
            let _ = db::set_setting(&conn, "terminal", "ghost_mode_feature_enabled", value);
        }
        tracing::info!(
            ghost_mode_feature_enabled = %value,
            "Stored ghost_mode_feature_enabled from admin settings"
        );
    }

    // Supabase runtime config (in case connection code didn't include it)
    if let Some(supa) = resp.get("supabase") {
        if let Some(url) = supa.get("url").and_then(|v| v.as_str()) {
            if !url.is_empty() && storage::get_credential("supabase_url").is_none() {
                let _ = storage::set_credential("supabase_url", url);
                if let Ok(conn) = db.conn.lock() {
                    let _ = db::set_setting(&conn, "terminal", "supabase_url", url);
                }
            }
        }
        if let Some(key) = supa.get("anon_key").and_then(|v| v.as_str()) {
            if !key.is_empty() && storage::get_credential("supabase_anon_key").is_none() {
                let _ = storage::set_credential("supabase_anon_key", key);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn settings_is_configured(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    crate::hydrate_terminal_credentials_from_local_settings(&db);
    let configured = storage::is_configured()
        || (crate::read_local_setting(&db, "terminal", "admin_dashboard_url").is_some()
            && crate::read_local_setting(&db, "terminal", "terminal_id").is_some()
            && storage::get_credential("pos_api_key").is_some());
    let reason = if configured {
        "all_credentials_present"
    } else {
        "missing_credentials"
    };
    Ok(serde_json::json!({ "configured": configured, "reason": reason }))
}

#[tauri::command]
pub async fn settings_get(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = crate::parse_channel_payload(arg0.clone(), arg1.clone());
    let mut category = crate::value_str(&payload, &["category", "settingType"]);
    let mut key = crate::value_str(&payload, &["key", "settingKey"]);
    let default_value = payload
        .get("defaultValue")
        .cloned()
        .or_else(|| payload.get("default").cloned())
        .or(arg2)
        .unwrap_or(serde_json::Value::Null);

    if category.is_none() || key.is_none() {
        if let (Some(serde_json::Value::String(cat)), Some(serde_json::Value::String(k))) =
            (arg0.as_ref(), arg1.as_ref())
        {
            category = Some(cat.clone());
            key = Some(k.clone());
        }
    }

    if key.is_none() {
        if let Some(serde_json::Value::String(single)) = arg0.as_ref() {
            if let Some((cat, k)) = single.split_once('.') {
                category = Some(cat.to_string());
                key = Some(k.to_string());
            } else {
                key = Some(single.clone());
            }
        }
    }

    if let (Some(cat), Some(k)) = (category.clone(), key.clone()) {
        if cat == "terminal" && crate::is_sensitive_terminal_setting(&k) {
            if let Some(credential_key) = crate::credential_key_for_terminal_setting(&k) {
                if let Some(v) = storage::get_credential(credential_key) {
                    return Ok(serde_json::Value::String(v));
                }
            }
            if !default_value.is_null() {
                return Ok(default_value);
            }
            return Ok(serde_json::Value::Null);
        }

        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if let Some(v) = db::get_setting(&conn, &cat, &k) {
            return Ok(serde_json::Value::String(v));
        }
        drop(conn);

        if cat == "terminal" {
            if let Some(credential_key) = crate::credential_key_for_terminal_setting(&k) {
                if let Some(v) = storage::get_credential(credential_key) {
                    return Ok(serde_json::Value::String(v));
                }
            }
        }

        if !default_value.is_null() {
            return Ok(default_value);
        }
        return Ok(serde_json::Value::Null);
    }

    if let Some(k) = key {
        // Legacy one-arg form: settings:get('terminal_id')
        return Ok(storage::settings_get(Some(&k)));
    }

    get_settings(db).await
}

#[tauri::command]
pub async fn settings_get_local(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    if arg0.is_none() {
        return get_settings(db).await;
    }

    if let Some(serde_json::Value::String(key)) = arg0 {
        if let Some((category, setting_key)) = key.split_once('.') {
            if category == "terminal" && crate::is_sensitive_terminal_setting(setting_key) {
                if let Some(credential_key) =
                    crate::credential_key_for_terminal_setting(setting_key)
                {
                    if let Some(v) = storage::get_credential(credential_key) {
                        return Ok(serde_json::Value::String(v));
                    }
                }
                return Ok(serde_json::Value::Null);
            }

            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            if let Some(v) = db::get_setting(&conn, category, setting_key) {
                return Ok(serde_json::Value::String(v));
            }
            drop(conn);

            if category == "terminal" {
                if let Some(credential_key) =
                    crate::credential_key_for_terminal_setting(setting_key)
                {
                    if let Some(v) = storage::get_credential(credential_key) {
                        return Ok(serde_json::Value::String(v));
                    }
                }
            }
            return Ok(serde_json::Value::Null);
        }
        return Ok(storage::settings_get(Some(&key)));
    }

    get_settings(db).await
}

#[tauri::command]
pub async fn settings_factory_reset(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let _ = crate::clear_operational_data_inner(&db);
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM local_settings", [])
            .map_err(|e| format!("clear local settings: {e}"))?;
        conn.execute("DELETE FROM menu_cache", [])
            .map_err(|e| format!("clear menu cache: {e}"))?;
    }
    let result = storage::factory_reset()?;
    let _ = app.emit(
        "app_reset",
        serde_json::json!({ "source": "factory_reset" }),
    );
    let _ = app.emit(
        "terminal_disabled",
        serde_json::json!({ "reason": "factory_reset" }),
    );
    Ok(result)
}

#[tauri::command]
pub async fn settings_update_terminal_credentials(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = arg0.ok_or("Missing credentials payload")?;
    let result = storage::update_terminal_credentials(&payload)?;

    // Mirror non-sensitive terminal metadata into local_settings for
    // compatibility paths. Sensitive credentials stay in OS keyring only.
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if let Some(v) = storage::get_credential("terminal_id")
            .or_else(|| crate::value_str(&payload, &["terminalId", "terminal_id"]))
        {
            db::set_setting(&conn, "terminal", "terminal_id", &v)?;
        }
        if let Some(v) = storage::get_credential("admin_dashboard_url").or_else(|| {
            crate::value_str(
                &payload,
                &["adminDashboardUrl", "adminUrl", "admin_dashboard_url"],
            )
        }) {
            db::set_setting(&conn, "terminal", "admin_dashboard_url", &v)?;
        }
        if let Some(v) = storage::get_credential("branch_id")
            .or_else(|| crate::value_str(&payload, &["branchId", "branch_id"]))
        {
            db::set_setting(&conn, "terminal", "branch_id", &v)?;
        }
        if let Some(v) = storage::get_credential("organization_id")
            .or_else(|| crate::value_str(&payload, &["organizationId", "organization_id"]))
        {
            db::set_setting(&conn, "terminal", "organization_id", &v)?;
        }
        if let Some(v) = storage::get_credential("supabase_url")
            .or_else(|| crate::value_str(&payload, &["supabaseUrl", "supabase_url"]))
        {
            db::set_setting(&conn, "terminal", "supabase_url", &v)?;
        }
        let ghost_mode_feature =
            storage::get_credential("ghost_mode_feature_enabled").or_else(|| {
                payload
                    .get("ghostModeFeatureEnabled")
                    .or_else(|| payload.get("ghost_mode_feature_enabled"))
                    .and_then(value_to_bool_string)
            });
        if let Some(v) = ghost_mode_feature {
            db::set_setting(&conn, "terminal", "ghost_mode_feature_enabled", &v)?;
        }
    }

    // After saving credentials, fetch terminal config from admin API
    // to populate branch_id, organization_id, and feature flags.
    if let Err(e) = refresh_terminal_context_from_admin(&db).await {
        tracing::warn!(error = %e, "Failed to fetch terminal config from admin (non-fatal)");
    }

    let _ = app.emit(
        "terminal_credentials_updated",
        serde_json::json!({ "success": true }),
    );
    let _ = app.emit("terminal_enabled", serde_json::json!({ "success": true }));
    crate::scrub_sensitive_local_settings(&db);

    Ok(result)
}

#[tauri::command]
pub async fn settings_get_admin_url(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    Ok(
        match storage::get_credential("admin_dashboard_url")
            .or_else(|| crate::read_local_setting(&db, "terminal", "admin_dashboard_url"))
            .or_else(|| crate::read_local_setting(&db, "terminal", "admin_url"))
        {
            Some(url) => serde_json::Value::String(url),
            None => serde_json::Value::Null,
        },
    )
}

/// Returns all settings merged: local_settings DB + terminal credential store.
/// The StaffShiftModal uses this to look up `terminal.branch_id`.
#[tauri::command]
pub async fn get_settings(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut all = db::get_all_settings(&conn);

    // Merge credential store values into terminal.*
    let map = all.as_object_mut().ok_or("internal")?;
    let terminal = map
        .entry("terminal")
        .or_insert_with(|| serde_json::json!({}));
    if let serde_json::Value::Object(ref mut t) = terminal {
        if let Some(bid) = storage::get_credential("branch_id") {
            t.entry("branch_id")
                .or_insert(serde_json::Value::String(bid));
        }
        if let Some(oid) = storage::get_credential("organization_id") {
            t.entry("organization_id")
                .or_insert(serde_json::Value::String(oid));
        }
        if let Some(tid) = storage::get_credential("terminal_id") {
            t.entry("terminal_id")
                .or_insert(serde_json::Value::String(tid));
        }
        if let Some(admin) = storage::get_credential("admin_dashboard_url") {
            t.entry("admin_dashboard_url")
                .or_insert(serde_json::Value::String(admin));
        }
        if let Some(bt) = storage::get_credential("business_type") {
            t.entry("business_type")
                .or_insert(serde_json::Value::String(bt));
        }
        if let Some(ghost_feature) = storage::get_credential("ghost_mode_feature_enabled") {
            t.entry("ghost_mode_feature_enabled")
                .or_insert(serde_json::Value::String(ghost_feature));
        }
    }

    // Also add flat keys for legacy lookups (e.g. `terminal.branch_id`)
    let bid_flat = storage::get_credential("branch_id");
    if let Some(bid) = bid_flat {
        map.insert("terminal.branch_id".into(), serde_json::Value::String(bid));
    }
    if let Some(oid) = storage::get_credential("organization_id") {
        map.insert(
            "terminal.organization_id".into(),
            serde_json::Value::String(oid),
        );
    }
    if let Some(tid) = storage::get_credential("terminal_id") {
        map.insert(
            "terminal.terminal_id".into(),
            serde_json::Value::String(tid),
        );
    }
    if let Some(admin) = storage::get_credential("admin_dashboard_url") {
        map.insert(
            "terminal.admin_dashboard_url".into(),
            serde_json::Value::String(admin),
        );
    }
    if let Some(ghost_feature) = storage::get_credential("ghost_mode_feature_enabled") {
        map.insert(
            "terminal.ghost_mode_feature_enabled".into(),
            serde_json::Value::String(ghost_feature),
        );
    }

    Ok(all)
}

#[tauri::command]
pub async fn settings_clear_connection(app: tauri::AppHandle) -> Result<Value, String> {
    storage::delete_credential("admin_dashboard_url")?;
    storage::delete_credential("pos_api_key")?;
    let _ = app.emit(
        "terminal_disabled",
        serde_json::json!({ "reason": "connection_cleared" }),
    );
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn settings_set(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let parsed = parse_settings_set_payload(arg0, arg1)?;
    let category = parsed.category;
    let key = parsed.key;
    let mut value = match parsed.value_node {
        serde_json::Value::String(s) => s,
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    };
    let mut extra_terminal_updates: Vec<(String, String)> = Vec::new();
    if category == "terminal" {
        if key == "admin_dashboard_url" || key == "admin_url" {
            value = api::normalize_admin_url(&value);
        }
        if key == "pos_api_key" {
            let original_api_value = value.clone();
            if let Some(decoded_key) =
                api::extract_api_key_from_connection_string(&original_api_value)
            {
                value = decoded_key;
            }
            if let Some(decoded_tid) =
                api::extract_terminal_id_from_connection_string(&original_api_value)
            {
                extra_terminal_updates.push(("terminal_id".to_string(), decoded_tid));
            }
            if let Some(decoded_url) =
                api::extract_admin_url_from_connection_string(&original_api_value)
            {
                extra_terminal_updates.push(("admin_dashboard_url".to_string(), decoded_url));
            }
        }
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    if category == "terminal" && crate::is_sensitive_terminal_setting(&key) {
        let _ = conn.execute(
            "DELETE FROM local_settings
             WHERE setting_category = 'terminal' AND setting_key = ?1",
            params![&key],
        );
    } else {
        db::set_setting(&conn, &category, &key, &value)?;
    }
    for (ekey, evalue) in &extra_terminal_updates {
        db::set_setting(&conn, "terminal", ekey, evalue)?;
    }
    drop(conn);

    if category == "terminal" {
        if let Some(credential_key) = crate::credential_key_for_terminal_setting(&key) {
            if value.trim().is_empty() {
                let _ = storage::delete_credential(credential_key);
            } else {
                let _ = storage::set_credential(credential_key, value.trim());
            }
        }
        for (ekey, evalue) in &extra_terminal_updates {
            if let Some(credential_key) = crate::credential_key_for_terminal_setting(ekey.as_str())
            {
                let _ = storage::set_credential(credential_key, evalue.trim());
            }
        }
    }

    let full_key = format!("{category}.{key}");
    let _ = app.emit("settings_update", serde_json::json!({ "key": full_key }));
    let _ = app.emit(
        "terminal_settings_updated",
        serde_json::json!({ "key": full_key }),
    );
    if category == "terminal" && crate::is_sensitive_terminal_setting(&key) {
        crate::scrub_sensitive_local_settings(&db);
    }
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn settings_update_local(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let updates = parse_settings_update_local_payload(arg0, arg1)?;

    let mut normalized_updates: Vec<(String, String, String)> = Vec::new();
    for (category, key, value) in updates.into_iter() {
        let mut normalized_value = value;
        normalized_updates.push((category.clone(), key.clone(), normalized_value.clone()));

        if category == "terminal" {
            if key == "admin_dashboard_url" || key == "admin_url" {
                normalized_value = api::normalize_admin_url(&normalized_value);
                normalized_updates.pop();
                normalized_updates.push((category.clone(), key.clone(), normalized_value.clone()));
            }

            if key == "pos_api_key" {
                let original_api_value = normalized_value.clone();
                if let Some(decoded_key) =
                    api::extract_api_key_from_connection_string(&original_api_value)
                {
                    normalized_value = decoded_key;
                    normalized_updates.pop();
                    normalized_updates.push((
                        category.clone(),
                        key.clone(),
                        normalized_value.clone(),
                    ));
                }

                if let Some(decoded_tid) =
                    api::extract_terminal_id_from_connection_string(&original_api_value)
                {
                    normalized_updates.push((
                        "terminal".to_string(),
                        "terminal_id".to_string(),
                        decoded_tid,
                    ));
                }
                if let Some(decoded_url) =
                    api::extract_admin_url_from_connection_string(&original_api_value)
                {
                    normalized_updates.push((
                        "terminal".to_string(),
                        "admin_dashboard_url".to_string(),
                        decoded_url,
                    ));
                }
            }
        }
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    for (category, key, value) in &normalized_updates {
        let is_sensitive_terminal =
            category == "terminal" && crate::is_sensitive_terminal_setting(key.as_str());
        let is_legacy_staff_pin = category == "staff" && key == "simple_pin";
        if is_sensitive_terminal || is_legacy_staff_pin {
            let _ = conn.execute(
                "DELETE FROM local_settings
                 WHERE setting_category = ?1 AND setting_key = ?2",
                params![category, key],
            );
        } else {
            db::set_setting(&conn, category, key, value)?;
        }
        if category == "terminal" {
            if let Some(credential_key) = crate::credential_key_for_terminal_setting(key) {
                if value.trim().is_empty() {
                    let _ = storage::delete_credential(credential_key);
                } else {
                    let _ = storage::set_credential(credential_key, value.trim());
                }
            }
        }
    }
    drop(conn);

    let updated_keys: Vec<String> = normalized_updates
        .iter()
        .map(|(cat, key, _)| format!("{cat}.{key}"))
        .collect();
    let _ = app.emit(
        "settings_update",
        serde_json::json!({ "updated": updated_keys.clone() }),
    );
    let _ = app.emit(
        "terminal_settings_updated",
        serde_json::json!({ "updated": updated_keys }),
    );
    crate::scrub_sensitive_local_settings(&db);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn settings_get_discount_max(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let val = db::get_setting(&conn, "general", "discount_max");
    Ok(match val {
        Some(v) => serde_json::json!(v.parse::<f64>().unwrap_or(100.0)),
        None => serde_json::json!(100.0),
    })
}

#[tauri::command]
pub async fn settings_set_discount_max(
    arg0: Option<f64>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let pct = arg0.unwrap_or(100.0);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "discount_max", &pct.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn settings_get_tax_rate(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let val = db::get_setting(&conn, "general", "tax_rate");
    Ok(match val {
        Some(v) => serde_json::json!(v.parse::<f64>().unwrap_or(0.0)),
        None => serde_json::json!(0.0),
    })
}

#[tauri::command]
pub async fn settings_set_tax_rate(
    arg0: Option<f64>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let pct = arg0.unwrap_or(0.0);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "tax_rate", &pct.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn settings_get_language(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let val = db::get_setting(&conn, "general", "language");
    Ok(serde_json::Value::String(
        val.unwrap_or_else(|| "en".into()),
    ))
}

#[tauri::command]
pub async fn settings_set_language(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let lang = arg0.unwrap_or_else(|| "en".into());
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "language", &lang)?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn update_settings(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let map = payload
        .as_object()
        .ok_or("update-settings expects an object payload")?;
    let mut updated = 0usize;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    for (k, v) in map {
        let value = match v {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        if let Some((category, key)) = k.split_once('.') {
            db::set_setting(&conn, category, key, &value)?;
        } else {
            db::set_setting(&conn, "general", k, &value)?;
        }
        updated += 1;
    }
    drop(conn);
    let _ = app.emit("settings_update", serde_json::json!({ "updated": updated }));
    if map.keys().any(|k| k.contains("permission")) {
        let _ = app.emit(
            "staff_permission_update",
            serde_json::json!({ "updated": true }),
        );
    }
    Ok(serde_json::json!({ "success": true, "updated": updated }))
}

#[tauri::command]
pub async fn terminal_config_get_settings() -> Result<Value, String> {
    // readFromSettings() in terminal-credentials.ts expects either:
    //   settings['terminal.terminal_id']  (dot-notation flat key)
    //   settings.terminal?.terminal_id    (nested object)
    // Build both forms so the frontend can find credentials either way.
    let flat = storage::get_full_config();
    let tid = flat
        .get("terminal_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let api = flat.get("api_key").and_then(|v| v.as_str()).unwrap_or("");
    let org = flat
        .get("organization_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let bid = flat.get("branch_id").and_then(|v| v.as_str()).unwrap_or("");
    let ghost_mode_feature_enabled = flat
        .get("ghost_mode_feature_enabled")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    Ok(serde_json::json!({
        // Nested form: settings.terminal?.terminal_id
        "terminal": {
            "terminal_id": tid,
            "pos_api_key": api,
            "organization_id": org,
            "branch_id": bid,
            "ghost_mode_feature_enabled": ghost_mode_feature_enabled,
        },
        // Dot-notation form: settings['terminal.terminal_id']
        "terminal.terminal_id": tid,
        "terminal.pos_api_key": api,
        "terminal.organization_id": org,
        "terminal.branch_id": bid,
        "terminal.ghost_mode_feature_enabled": ghost_mode_feature_enabled,
    }))
}

#[tauri::command]
pub async fn terminal_config_get_setting(
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<Value, String> {
    let (category, key) = parse_terminal_config_get_setting_payload(arg0, arg1);
    Ok(storage::get_setting(category.as_deref(), key.as_deref()))
}

#[tauri::command]
pub async fn terminal_config_get_branch_id(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    storage::get_credential("branch_id")
        .or_else(|| crate::read_local_setting(&db, "terminal", "branch_id"))
        .ok_or_else(|| "Terminal not configured".into())
}

#[tauri::command]
pub async fn terminal_config_get_terminal_id(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    storage::get_credential("terminal_id")
        .or_else(|| crate::read_local_setting(&db, "terminal", "terminal_id"))
        .ok_or_else(|| "Terminal not configured".into())
}

#[tauri::command]
pub async fn terminal_config_get_organization_id(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    storage::get_credential("organization_id")
        .or_else(|| crate::read_local_setting(&db, "terminal", "organization_id"))
        .ok_or_else(|| "Terminal not configured".into())
}

#[tauri::command]
pub async fn terminal_config_get_business_type(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    Ok(storage::get_credential("business_type")
        .or_else(|| crate::read_local_setting(&db, "terminal", "business_type"))
        .or_else(|| crate::read_local_setting(&db, "general", "business_type"))
        .unwrap_or_else(|| "food".into()))
}

#[tauri::command]
pub async fn terminal_config_get_full_config() -> Result<Value, String> {
    Ok(storage::get_full_config())
}

#[tauri::command]
pub async fn terminal_config_refresh(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    crate::hydrate_terminal_credentials_from_local_settings(&db);
    let result = match menu::sync_menu(&db).await {
        Ok(value) => value,
        Err(error) => {
            if crate::is_terminal_auth_failure(&error) {
                crate::handle_invalid_terminal_credentials(
                    Some(&db),
                    &app,
                    "terminal_config_refresh",
                    &error,
                );
                return Ok(serde_json::json!({
                    "success": false,
                    "errorCode": "invalid_terminal_credentials",
                    "error": error
                }));
            }
            return Err(error);
        }
    };

    if let Err(error) = refresh_terminal_context_from_admin(&db).await {
        tracing::warn!(
            error = %error,
            "terminal_config_refresh: failed to refresh terminal settings (non-fatal)"
        );
    }

    let _ = app.emit(
        "terminal_config_updated",
        serde_json::json!({ "source": "terminal_config_refresh" }),
    );
    let _ = app.emit(
        "hardware_config_update",
        serde_json::json!({ "source": "terminal_config_refresh" }),
    );
    let _ = app.emit(
        "terminal_settings_updated",
        serde_json::json!({ "source": "terminal_config_refresh" }),
    );
    Ok(result)
}

#[cfg(test)]
mod dto_tests {
    use super::{
        parse_settings_set_payload, parse_settings_update_local_payload,
        parse_terminal_config_get_setting_payload, SettingsSetPayload,
    };

    #[test]
    fn parse_settings_set_payload_supports_object_and_flat_key() {
        let object_payload = parse_settings_set_payload(
            Some(serde_json::json!({
                "category": "terminal",
                "key": "branch_id",
                "value": "branch-1"
            })),
            None,
        )
        .expect("object payload should parse");

        let flat_payload = parse_settings_set_payload(
            Some(serde_json::json!("terminal.admin_dashboard_url")),
            Some(serde_json::json!("https://admin.example.com")),
        )
        .expect("flat payload should parse");

        assert_eq!(
            object_payload,
            SettingsSetPayload {
                category: "terminal".to_string(),
                key: "branch_id".to_string(),
                value_node: serde_json::json!("branch-1"),
            }
        );
        assert_eq!(flat_payload.category, "terminal");
        assert_eq!(flat_payload.key, "admin_dashboard_url");
        assert_eq!(
            flat_payload.value_node,
            serde_json::json!("https://admin.example.com")
        );
    }

    #[test]
    fn parse_settings_set_payload_rejects_missing_key() {
        let err = parse_settings_set_payload(Some(serde_json::json!({ "value": "x" })), None)
            .expect_err("missing key should be rejected");
        assert!(err.contains("Missing setting key"), "unexpected err: {err}");
    }

    #[test]
    fn parse_settings_update_local_payload_supports_object_bridge_and_flat_forms() {
        let object_form = parse_settings_update_local_payload(
            Some(serde_json::json!({
                "settingType": "terminal",
                "settings": {
                    "branch_id": "branch-2",
                    "organization_id": "org-2"
                }
            })),
            None,
        )
        .expect("object form should parse");

        let bridge_form = parse_settings_update_local_payload(
            Some(serde_json::json!("terminal")),
            Some(serde_json::json!({ "terminal_id": "term-2" })),
        )
        .expect("bridge form should parse");

        let flat_form = parse_settings_update_local_payload(
            Some(serde_json::json!("general.language")),
            Some(serde_json::json!("el")),
        )
        .expect("flat form should parse");

        assert_eq!(
            object_form,
            vec![
                (
                    "terminal".to_string(),
                    "branch_id".to_string(),
                    "branch-2".to_string()
                ),
                (
                    "terminal".to_string(),
                    "organization_id".to_string(),
                    "org-2".to_string()
                )
            ]
        );
        assert_eq!(
            bridge_form,
            vec![(
                "terminal".to_string(),
                "terminal_id".to_string(),
                "term-2".to_string()
            )]
        );
        assert_eq!(
            flat_form,
            vec![(
                "general".to_string(),
                "language".to_string(),
                "el".to_string()
            )]
        );
    }

    #[test]
    fn parse_settings_update_local_payload_rejects_invalid_shape() {
        let err = parse_settings_update_local_payload(Some(serde_json::json!({})), None)
            .expect_err("invalid payload should be rejected");
        assert!(
            err.contains("settings:update-local expects"),
            "unexpected err: {err}"
        );
    }

    #[test]
    fn parse_terminal_config_get_setting_payload_supports_object_tuple_and_flat_key() {
        let object_form = parse_terminal_config_get_setting_payload(
            Some(serde_json::json!({
                "category": "terminal",
                "key": "branch_id"
            })),
            None,
        );
        let tuple_form = parse_terminal_config_get_setting_payload(
            Some(serde_json::json!("terminal")),
            Some(serde_json::json!("terminal_id")),
        );
        let flat_form = parse_terminal_config_get_setting_payload(
            Some(serde_json::json!("terminal.organization_id")),
            None,
        );

        assert_eq!(
            object_form,
            (Some("terminal".to_string()), Some("branch_id".to_string()))
        );
        assert_eq!(
            tuple_form,
            (
                Some("terminal".to_string()),
                Some("terminal_id".to_string())
            )
        );
        assert_eq!(
            flat_form,
            (
                Some("terminal".to_string()),
                Some("organization_id".to_string())
            )
        );
    }
}
