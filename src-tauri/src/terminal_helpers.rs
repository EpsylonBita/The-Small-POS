use tauri::Emitter;
use tracing::warn;

use crate::{api, db, storage};

fn nested_value_str(v: &serde_json::Value, pointers: &[&str]) -> Option<String> {
    for pointer in pointers {
        if let Some(s) = v.pointer(pointer).and_then(|x| x.as_str()) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn nested_value_bool(v: &serde_json::Value, pointers: &[&str]) -> Option<bool> {
    for pointer in pointers {
        if let Some(value) = v.pointer(pointer) {
            if let Some(flag) = value.as_bool() {
                return Some(flag);
            }
            if let Some(flag) = value.as_i64() {
                return Some(flag == 1);
            }
            if let Some(flag) = value.as_str() {
                let normalized = flag.trim().to_ascii_lowercase();
                if normalized == "true"
                    || normalized == "1"
                    || normalized == "yes"
                    || normalized == "on"
                {
                    return Some(true);
                }
                if normalized == "false"
                    || normalized == "0"
                    || normalized == "no"
                    || normalized == "off"
                {
                    return Some(false);
                }
            }
        }
    }
    None
}

fn nested_object_value(v: &serde_json::Value, pointers: &[&str]) -> Option<serde_json::Value> {
    for pointer in pointers {
        if let Some(value) = v.pointer(pointer) {
            if value.is_object() {
                return Some(value.clone());
            }
        }
    }
    None
}

fn nested_value_number_string(v: &serde_json::Value, pointers: &[&str]) -> Option<String> {
    for pointer in pointers {
        if let Some(value) = v.pointer(pointer) {
            if let Some(number) = value.as_f64() {
                if number.is_finite() {
                    return Some(number.to_string());
                }
            }
            if let Some(text) = value.as_str() {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

pub(crate) fn extract_org_id_from_terminal_settings_response(
    resp: &serde_json::Value,
) -> Option<String> {
    crate::value_str(resp, &["organization_id"]).or_else(|| {
        nested_value_str(
            resp,
            &[
                "/settings/terminal/organization_id",
                "/settings/general/organization_id",
                "/terminal/organization_id",
                "/organization/id",
            ],
        )
    })
}

pub(crate) fn extract_branch_id_from_terminal_settings_response(
    resp: &serde_json::Value,
) -> Option<String> {
    crate::value_str(resp, &["branch_id"]).or_else(|| {
        nested_value_str(
            resp,
            &[
                "/settings/terminal/branch_id",
                "/terminal/branch_id",
                "/branch/id",
            ],
        )
    })
}

pub(crate) fn extract_ghost_mode_feature_from_terminal_settings_response(
    resp: &serde_json::Value,
) -> Option<bool> {
    if let Some(value) = resp.get("ghost_mode_feature_enabled") {
        if let Some(flag) = value.as_bool() {
            return Some(flag);
        }
        if let Some(flag) = value.as_i64() {
            return Some(flag == 1);
        }
        if let Some(flag) = value.as_str() {
            let normalized = flag.trim().to_ascii_lowercase();
            if normalized == "true"
                || normalized == "1"
                || normalized == "yes"
                || normalized == "on"
            {
                return Some(true);
            }
            if normalized == "false"
                || normalized == "0"
                || normalized == "no"
                || normalized == "off"
            {
                return Some(false);
            }
        }
    }

    nested_value_bool(
        resp,
        &[
            "/settings/terminal/ghost_mode_feature_enabled",
            "/terminal/ghost_mode_feature_enabled",
            "/terminal/enabled_features/ghost_mode",
            "/enabled_features/ghost_mode",
        ],
    )
}

fn is_local_only_setting_category(category: &str) -> bool {
    matches!(
        category.trim().to_ascii_lowercase().as_str(),
        "ui" | "hardware"
            | "peripherals"
            | "display"
            | "scanner"
            | "scale"
            | "printer"
            | "payment_terminal"
            | "system"
    )
}

fn is_syncable_system_setting(setting_key: &str) -> bool {
    matches!(
        setting_key.trim().to_ascii_lowercase().as_str(),
        "business_day_start_hour" | "business_day_start"
    )
}

fn is_local_only_terminal_setting(setting_key: &str) -> bool {
    matches!(
        setting_key.trim().to_ascii_lowercase().as_str(),
        "display_brightness"
            | "screen_timeout"
            | "touch_sensitivity"
            | "audio_enabled"
            | "receipt_auto_print"
            | "auto_print_receipts"
            | "cash_drawer_enabled"
            | "barcode_scanner_enabled"
            | "customer_display_enabled"
            | "cash_drawer_port"
            | "barcode_scanner_port"
            | "card_reader_enabled"
            | "scale_enabled"
            | "scale_port"
            | "scale_baud_rate"
            | "scale_protocol"
            | "loyalty_card_reader"
            | "wifi_ssid"
            | "ethernet_enabled"
            | "display_connection_type"
            | "display_port"
            | "display_baud_rate"
            | "display_tcp_port"
            | "scanner_baud_rate"
    )
}

pub(crate) fn extract_terminal_type_from_terminal_settings_response(
    resp: &serde_json::Value,
) -> Option<String> {
    crate::value_str(resp, &["terminal_type"]).or_else(|| {
        nested_value_str(
            resp,
            &[
                "/settings/terminal/terminal_type",
                "/terminal/terminal_type",
                "/terminal/type",
            ],
        )
    })
}

pub(crate) fn extract_parent_terminal_id_from_terminal_settings_response(
    resp: &serde_json::Value,
) -> Option<String> {
    crate::value_str(resp, &["parent_terminal_id"]).or_else(|| {
        nested_value_str(
            resp,
            &[
                "/settings/terminal/parent_terminal_id",
                "/terminal/parent_terminal_id",
                "/terminal/parent/id",
            ],
        )
    })
}

pub(crate) fn extract_owner_terminal_id_from_terminal_settings_response(
    resp: &serde_json::Value,
) -> Option<String> {
    crate::value_str(resp, &["owner_terminal_id"]).or_else(|| {
        nested_value_str(
            resp,
            &[
                "/settings/terminal/owner_terminal_id",
                "/terminal/owner_terminal_id",
                "/terminal/owner/id",
            ],
        )
    })
}

pub(crate) fn extract_owner_terminal_db_id_from_terminal_settings_response(
    resp: &serde_json::Value,
) -> Option<String> {
    crate::value_str(resp, &["owner_terminal_db_id"]).or_else(|| {
        nested_value_str(
            resp,
            &[
                "/settings/terminal/owner_terminal_db_id",
                "/terminal/owner_terminal_db_id",
                "/terminal/owner/db_id",
            ],
        )
    })
}

pub(crate) fn extract_source_terminal_id_from_terminal_settings_response(
    resp: &serde_json::Value,
) -> Option<String> {
    crate::value_str(resp, &["source_terminal_id"]).or_else(|| {
        nested_value_str(
            resp,
            &[
                "/settings/terminal/source_terminal_id",
                "/terminal/source_terminal_id",
                "/terminal/source/id",
            ],
        )
    })
}

pub(crate) fn extract_source_terminal_db_id_from_terminal_settings_response(
    resp: &serde_json::Value,
) -> Option<String> {
    crate::value_str(resp, &["source_terminal_db_id"]).or_else(|| {
        nested_value_str(
            resp,
            &[
                "/settings/terminal/source_terminal_db_id",
                "/terminal/source_terminal_db_id",
                "/terminal/source/db_id",
            ],
        )
    })
}

pub(crate) fn extract_pos_operating_mode_from_terminal_settings_response(
    resp: &serde_json::Value,
) -> Option<String> {
    crate::value_str(resp, &["pos_operating_mode"]).or_else(|| {
        nested_value_str(
            resp,
            &[
                "/settings/terminal/pos_operating_mode",
                "/terminal/pos_operating_mode",
                "/branch/pos_operating_mode",
            ],
        )
    })
}

pub(crate) fn extract_enabled_features_from_terminal_settings_response(
    resp: &serde_json::Value,
) -> Option<serde_json::Value> {
    if let Some(value) = resp.get("enabled_features") {
        if value.is_object() {
            return Some(value.clone());
        }
    }

    nested_object_value(
        resp,
        &[
            "/settings/terminal/enabled_features",
            "/terminal/enabled_features",
        ],
    )
}

fn setting_value_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        serde_json::Value::Bool(flag) => Some(if *flag { "true" } else { "false" }.to_string()),
        serde_json::Value::Number(num) => Some(num.to_string()),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            serde_json::to_string(value).ok().and_then(|encoded| {
                let trimmed = encoded.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            })
        }
    }
}

/// Persist terminal settings snapshot from `/api/pos/settings/{terminal_id}`
/// into local settings for offline rendering.
pub(crate) fn cache_terminal_settings_snapshot(
    db: &db::DbState,
    resp: &serde_json::Value,
) -> Result<Vec<String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut updated = Vec::new();

    if let Some(settings_obj) = resp.get("settings").and_then(|value| value.as_object()) {
        for (category, category_values) in settings_obj {
            let normalized_category = category.trim().to_ascii_lowercase();
            if is_local_only_setting_category(category) && normalized_category != "system" {
                continue;
            }
            let Some(values_obj) = category_values.as_object() else {
                continue;
            };
            for (key, raw_value) in values_obj {
                if normalized_category == "system" && !is_syncable_system_setting(key) {
                    continue;
                }
                if normalized_category == "terminal"
                    && (is_sensitive_terminal_setting(key) || is_local_only_terminal_setting(key))
                {
                    continue;
                }
                let Some(serialized) = setting_value_to_string(raw_value) else {
                    continue;
                };
                db::set_setting(&conn, category, key, &serialized)?;
                updated.push(format!("{category}.{key}"));
            }
        }
    }

    if let Some(org) = resp
        .get("organization_branding")
        .and_then(|value| value.as_object())
    {
        if let Some(name) = org
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            db::set_setting(&conn, "organization", "name", name)?;
            updated.push("organization.name".to_string());
        }
        if let Some(logo_url) = org
            .get("logo_url")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            db::set_setting(&conn, "organization", "logo_url", logo_url)?;
            updated.push("organization.logo_url".to_string());
        }
    }

    if let Some(branch_name) =
        nested_value_str(resp, &["/branch_info/name", "/branch_info/display_name"])
    {
        db::set_setting(&conn, "restaurant", "name", &branch_name)?;
        updated.push("restaurant.name".to_string());

        let branch_subtitle = nested_value_str(
            resp,
            &[
                "/branch_info/subtitle",
                "/branch_info/display_name",
                "/settings/restaurant/subtitle",
            ],
        )
        .unwrap_or_else(|| branch_name.clone());
        db::set_setting(&conn, "restaurant", "subtitle", &branch_subtitle)?;
        updated.push("restaurant.subtitle".to_string());
    }

    if let Some(terminal_name) = nested_value_str(
        resp,
        &[
            "/terminal_name",
            "/terminal_info/name",
            "/settings/terminal/name",
            "/settings/terminal/display_name",
        ],
    ) {
        db::set_setting(&conn, "terminal", "name", &terminal_name)?;
        updated.push("terminal.name".to_string());
    }

    if let Some(terminal_location) = nested_value_str(
        resp,
        &[
            "/terminal_location",
            "/terminal_info/location",
            "/settings/terminal/location",
        ],
    ) {
        db::set_setting(&conn, "terminal", "location", &terminal_location)?;
        updated.push("terminal.location".to_string());
    }

    // Persist explicit terminal fallbacks for printing paths.
    if let Some(store_name) = nested_value_str(
        resp,
        &[
            "/settings/restaurant/name",
            "/settings/terminal/store_name",
            "/branch_info/name",
            "/branch_info/display_name",
            "/organization_branding/name",
        ],
    ) {
        db::set_setting(&conn, "terminal", "store_name", &store_name)?;
        updated.push("terminal.store_name".to_string());
    }
    if let Some(store_address) = nested_value_str(
        resp,
        &[
            "/settings/restaurant/address",
            "/settings/terminal/store_address",
            "/branch_info/address",
            "/organization_branding/address",
        ],
    ) {
        // Compose "address, city" if branch_info provides both.
        let city = nested_value_str(resp, &["/branch_info/city"]);
        let full_address = if let Some(city) = city.as_deref().filter(|c| !c.is_empty()) {
            if store_address.contains(city) {
                store_address.clone()
            } else {
                format!("{store_address}, {city}")
            }
        } else {
            store_address
        };
        db::set_setting(&conn, "restaurant", "address", &full_address)?;
        db::set_setting(&conn, "terminal", "store_address", &full_address)?;
        updated.push("restaurant.address".to_string());
    }
    if let Some(store_phone) = nested_value_str(
        resp,
        &[
            "/settings/restaurant/phone",
            "/settings/terminal/store_phone",
            "/branch_info/phone",
            "/organization_branding/phone",
        ],
    ) {
        db::set_setting(&conn, "restaurant", "phone", &store_phone)?;
        db::set_setting(&conn, "terminal", "store_phone", &store_phone)?;
        updated.push("restaurant.phone".to_string());
    }
    if let Some(latitude) = nested_value_number_string(
        resp,
        &[
            "/settings/restaurant/latitude",
            "/settings/terminal/store_latitude",
            "/branch_info/latitude",
        ],
    ) {
        db::set_setting(&conn, "restaurant", "latitude", &latitude)?;
        db::set_setting(&conn, "terminal", "store_latitude", &latitude)?;
        updated.push("restaurant.latitude".to_string());
    }
    if let Some(longitude) = nested_value_number_string(
        resp,
        &[
            "/settings/restaurant/longitude",
            "/settings/terminal/store_longitude",
            "/branch_info/longitude",
        ],
    ) {
        db::set_setting(&conn, "restaurant", "longitude", &longitude)?;
        db::set_setting(&conn, "terminal", "store_longitude", &longitude)?;
        updated.push("restaurant.longitude".to_string());
    }

    // Branch tax_id → organization.vat_number (for receipt header).
    // Falls back to organization_branding.vat_number when branch lacks tax_id.
    if let Some(tax_id) = nested_value_str(
        resp,
        &["/branch_info/tax_id", "/organization_branding/vat_number"],
    ) {
        db::set_setting(&conn, "organization", "vat_number", &tax_id)?;
        updated.push("organization.vat_number".to_string());
    }

    // Branch tax_office → organization.tax_office (for receipt header).
    if let Some(tax_office) = nested_value_str(resp, &["/branch_info/tax_office"]) {
        db::set_setting(&conn, "organization", "tax_office", &tax_office)?;
        updated.push("organization.tax_office".to_string());
    }

    Ok(updated)
}

pub(crate) fn credential_key_for_terminal_setting(setting_key: &str) -> Option<&'static str> {
    match setting_key {
        "terminal_id" => Some("terminal_id"),
        "pos_api_key" => Some("pos_api_key"),
        "admin_dashboard_url" | "admin_url" => Some("admin_dashboard_url"),
        "branch_id" => Some("branch_id"),
        "organization_id" => Some("organization_id"),
        "business_type" => Some("business_type"),
        "supabase_url" => Some("supabase_url"),
        "supabase_anon_key" => Some("supabase_anon_key"),
        "ghost_mode_feature_enabled" => Some("ghost_mode_feature_enabled"),
        _ => None,
    }
}

pub(crate) fn is_sensitive_terminal_setting(setting_key: &str) -> bool {
    let key = setting_key.trim().to_ascii_lowercase();
    matches!(
        key.as_str(),
        "pos_api_key"
            | "supabase_anon_key"
            | "service_role_key"
            | "supabase_service_role_key"
            | "supabase_service_key"
            | "jwt_secret"
            | "supabase_jwt_secret"
            | "admin_api_token"
            | "access_token"
            | "refresh_token"
            | "client_secret"
    ) || key.contains("service_role")
        || key.ends_with("_secret")
        || key.ends_with("_token")
}

pub(crate) fn scrub_sensitive_local_settings(db: &db::DbState) {
    let sensitive_keys = [
        "pos_api_key",
        "supabase_anon_key",
        "service_role_key",
        "supabase_service_role_key",
        "supabase_service_key",
        "jwt_secret",
        "supabase_jwt_secret",
        "admin_api_token",
        "access_token",
        "refresh_token",
        "client_secret",
    ];

    if let Ok(conn) = db.conn.lock() {
        for key in sensitive_keys {
            let _ = conn.execute(
                "DELETE FROM local_settings
                 WHERE setting_category = 'terminal'
                   AND setting_key = ?1",
                rusqlite::params![key],
            );
        }

        let _ = conn.execute(
            "DELETE FROM local_settings
             WHERE setting_category = 'terminal'
               AND (
                    lower(setting_key) LIKE '%service_role%'
                 OR lower(setting_key) LIKE '%_secret'
                 OR lower(setting_key) LIKE '%_token'
               )",
            [],
        );
    }
}

pub(crate) fn read_local_setting(db: &db::DbState, category: &str, key: &str) -> Option<String> {
    let conn = db.conn.lock().ok()?;
    db::get_setting(&conn, category, key)
}

fn normalized_keyring_credential(credential_key: &str) -> Option<String> {
    let value = storage::get_credential(credential_key)?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = if credential_key == "admin_dashboard_url" {
        api::normalize_admin_url(trimmed)
    } else {
        trimmed.to_string()
    };

    if normalized.trim().is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn keyring_matches_expected_value(credential_key: &str, expected_value: &str) -> bool {
    normalized_keyring_credential(credential_key).as_deref() == Some(expected_value)
}

fn local_terminal_setting_is_purge_safe(setting_key: &str, raw_value: &str) -> bool {
    let trimmed = raw_value.trim();
    if trimmed.is_empty() {
        return false;
    }

    match setting_key {
        "terminal_id" => {
            if trimmed == "terminal-001" {
                return false;
            }
            keyring_matches_expected_value("terminal_id", trimmed)
        }
        "pos_api_key" => {
            let expected_api_key = api::extract_api_key_from_connection_string(trimmed)
                .unwrap_or_else(|| trimmed.to_string());
            if expected_api_key.trim().is_empty()
                || !keyring_matches_expected_value("pos_api_key", expected_api_key.trim())
            {
                return false;
            }

            if let Some(decoded_tid) = api::extract_terminal_id_from_connection_string(trimmed)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            {
                if decoded_tid == "terminal-001"
                    || !keyring_matches_expected_value("terminal_id", &decoded_tid)
                {
                    return false;
                }
            }

            if let Some(decoded_url) = api::extract_admin_url_from_connection_string(trimmed)
                .map(|value| api::normalize_admin_url(&value))
                .filter(|value| !value.is_empty())
            {
                if !keyring_matches_expected_value("admin_dashboard_url", &decoded_url) {
                    return false;
                }
            }

            true
        }
        "admin_dashboard_url" | "admin_url" => {
            let normalized = api::normalize_admin_url(trimmed);
            !normalized.is_empty()
                && keyring_matches_expected_value("admin_dashboard_url", &normalized)
        }
        _ => keyring_matches_expected_value(setting_key, trimmed),
    }
}

/// Delete plaintext credential rows from `local_settings` once the OS keyring
/// holds an equivalent value. Runs after `hydrate_terminal_credentials_from_local_settings`
/// to retire the legacy plaintext fallback — the OS keyring (DPAPI-backed on
/// Windows via the `keyring` crate) becomes the sole source of truth.
///
/// Safety: we only delete a row if `storage::get_credential` returns a
/// non-empty value for that key. If a hydration failed (e.g., keyring write
/// error), the plaintext row is preserved so the next boot can retry.
///
/// `terminal_id` has an extra guard: we never purge if the value is the
/// generic placeholder `"terminal-001"` that `hydrate` explicitly ignores,
/// so we match that skip here too.
pub(crate) fn purge_hydrated_terminal_credentials_from_local_settings(db: &db::DbState) {
    // Credential keys that map 1:1 between `local_settings` (category='terminal')
    // and the OS keyring. Mirrors the `mappings` in
    // `hydrate_terminal_credentials_from_local_settings`.
    const CREDENTIAL_KEYS: &[&str] = &[
        "terminal_id",
        "pos_api_key",
        "admin_dashboard_url",
        "branch_id",
        "organization_id",
        "business_type",
        "supabase_url",
        "supabase_anon_key",
        "ghost_mode_feature_enabled",
        // legacy alias kept in sync by the hydrate function
        "admin_url",
    ];

    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(_) => return,
    };

    for key in CREDENTIAL_KEYS {
        let local_value = match db::get_setting(&conn, "terminal", key) {
            Some(v) => v,
            None => continue,
        };
        if !local_terminal_setting_is_purge_safe(key, &local_value) {
            continue;
        }
        match db::delete_setting(&conn, "terminal", key) {
            Ok(rows) if rows > 0 => {
                tracing::info!(
                    target: "credentials.purge",
                    key = %key,
                    "Deleted plaintext credential from local_settings (keyring is authoritative)"
                );
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(
                    target: "credentials.purge",
                    key = %key,
                    error = %e,
                    "Failed to delete plaintext credential row"
                );
            }
        }
    }
}

pub(crate) fn hydrate_terminal_credentials_from_local_settings(db: &db::DbState) {
    // Keep keyring credentials aligned with local_settings values used by Electron
    // compatibility paths.
    let mappings = [
        ("terminal_id", "terminal_id"),
        ("pos_api_key", "pos_api_key"),
        ("admin_dashboard_url", "admin_dashboard_url"),
        ("branch_id", "branch_id"),
        ("organization_id", "organization_id"),
        ("business_type", "business_type"),
        ("supabase_url", "supabase_url"),
        ("supabase_anon_key", "supabase_anon_key"),
        ("ghost_mode_feature_enabled", "ghost_mode_feature_enabled"),
    ];

    for (credential_key, setting_key) in mappings {
        if let Some(value) = read_local_setting(db, "terminal", setting_key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                if credential_key == "terminal_id" && trimmed == "terminal-001" {
                    continue;
                }

                let normalized_value = if credential_key == "admin_dashboard_url" {
                    api::normalize_admin_url(trimmed)
                } else if credential_key == "pos_api_key" {
                    if let Some(decoded) = api::extract_api_key_from_connection_string(trimmed) {
                        if let Some(decoded_tid) =
                            api::extract_terminal_id_from_connection_string(trimmed)
                        {
                            let _ = storage::set_credential("terminal_id", decoded_tid.trim());
                        }
                        if let Some(decoded_url) =
                            api::extract_admin_url_from_connection_string(trimmed)
                        {
                            let _ =
                                storage::set_credential("admin_dashboard_url", decoded_url.trim());
                        }
                        decoded
                    } else {
                        trimmed.to_string()
                    }
                } else {
                    trimmed.to_string()
                };

                if !normalized_value.trim().is_empty() {
                    match storage::get_credential(credential_key) {
                        Some(current) if current.trim() == normalized_value.trim() => {}
                        _ => {
                            let _ =
                                storage::set_credential(credential_key, normalized_value.trim());
                        }
                    }
                }
            }
        }
    }

    // Backward compatibility for legacy admin_url key.
    if let Some(value) = read_local_setting(db, "terminal", "admin_url") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            let normalized = api::normalize_admin_url(trimmed);
            if !normalized.is_empty() {
                match storage::get_credential("admin_dashboard_url") {
                    Some(current) if current.trim() == normalized => {}
                    _ => {
                        let _ = storage::set_credential("admin_dashboard_url", &normalized);
                    }
                }
            }
        }
    }
}

pub(crate) fn is_terminal_auth_failure(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("invalid api key for terminal")
        || lower.contains("terminal identity mismatch")
        || lower.contains("api key is invalid or expired")
        || lower.contains("terminal not authorized")
        || lower.contains("terminal not found or inactive")
}

pub(crate) fn terminal_access_reset_reason(error: &str) -> &'static str {
    let lower = error.to_lowercase();
    if lower.contains("terminal not found or inactive") {
        "terminal_deleted"
    } else {
        "invalid_terminal_credentials"
    }
}

fn clear_terminal_api_key(db: Option<&db::DbState>) {
    let _ = storage::delete_credential("pos_api_key");
    if let Some(db_state) = db {
        if let Ok(conn) = db_state.conn.lock() {
            let _ = conn.execute(
                "DELETE FROM local_settings
                 WHERE setting_category = 'terminal'
                   AND setting_key IN ('pos_api_key', 'api_key')",
                [],
            );
        }
    }
}

pub(crate) fn handle_invalid_terminal_credentials(
    db: Option<&db::DbState>,
    app: &tauri::AppHandle,
    source: &str,
    error: &str,
) {
    let reason = terminal_access_reset_reason(error);
    warn!(
        source = %source,
        error = %error,
        reason = %reason,
        "Terminal access revoked; clearing stored API key and forcing onboarding reset without deleting local data"
    );
    clear_terminal_api_key(db);
    let _ = app.emit(
        "app_reset",
        serde_json::json!({
            "reason": reason,
            "source": source,
            "error": error,
        }),
    );
    let _ = app.emit(
        "terminal_disabled",
        serde_json::json!({
            "reason": reason,
            "source": source,
            "error": error,
        }),
    );
}

pub(crate) fn mask_terminal_id(terminal_id: &str) -> String {
    let trimmed = terminal_id.trim();
    if trimmed.is_empty() {
        return "unknown".to_string();
    }
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    format!("***{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serial_test::serial;
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn test_db() -> db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        db::DbState {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    const TEST_CREDENTIAL_KEYS: &[&str] = &[
        "terminal_id",
        "pos_api_key",
        "admin_dashboard_url",
        "admin_url",
        "branch_id",
        "organization_id",
        "business_type",
        "supabase_url",
        "supabase_anon_key",
        "ghost_mode_feature_enabled",
    ];

    struct CredentialCleanupGuard;

    impl Drop for CredentialCleanupGuard {
        fn drop(&mut self) {
            clear_test_credentials();
        }
    }

    fn clear_test_credentials() {
        for key in TEST_CREDENTIAL_KEYS {
            let _ = storage::delete_credential(key);
        }
    }

    fn credential_guard() -> CredentialCleanupGuard {
        clear_test_credentials();
        CredentialCleanupGuard
    }

    fn set_terminal_setting(db: &db::DbState, key: &str, value: &str) {
        let conn = db.conn.lock().expect("lock db");
        db::set_setting(&conn, "terminal", key, value).expect("store terminal setting");
    }

    #[test]
    fn cache_snapshot_persists_branch_identity_and_receipt_fallbacks() {
        let db = test_db();
        let payload = serde_json::json!({
            "terminal_name": "Front Counter",
            "terminal_location": "Counter A",
            "organization_branding": {
                "name": "The Small Group",
                "logo_url": "https://example.com/logo.png"
            },
            "branch_info": {
                "name": "Kifisia Branch",
                "address": "Main St 42",
                "city": "Athens",
                "phone": "2101234567",
                "latitude": 38.0742,
                "longitude": 23.8113,
                "tax_id": "123456789",
                "tax_office": "DOY ATHENS"
            },
            "settings": {
                "terminal": {}
            }
        });

        let updated = cache_terminal_settings_snapshot(&db, &payload).expect("cache snapshot");
        assert!(updated.iter().any(|key| key == "restaurant.name"));
        assert!(updated.iter().any(|key| key == "restaurant.subtitle"));

        let conn = db.conn.lock().expect("lock db");
        assert_eq!(
            db::get_setting(&conn, "organization", "name").as_deref(),
            Some("The Small Group")
        );
        assert_eq!(
            db::get_setting(&conn, "restaurant", "name").as_deref(),
            Some("Kifisia Branch")
        );
        assert_eq!(
            db::get_setting(&conn, "restaurant", "subtitle").as_deref(),
            Some("Kifisia Branch")
        );
        assert_eq!(
            db::get_setting(&conn, "terminal", "store_name").as_deref(),
            Some("Kifisia Branch")
        );
        assert_eq!(
            db::get_setting(&conn, "terminal", "name").as_deref(),
            Some("Front Counter")
        );
        assert_eq!(
            db::get_setting(&conn, "terminal", "location").as_deref(),
            Some("Counter A")
        );
        assert_eq!(
            db::get_setting(&conn, "restaurant", "address").as_deref(),
            Some("Main St 42, Athens")
        );
        assert_eq!(
            db::get_setting(&conn, "terminal", "store_address").as_deref(),
            Some("Main St 42, Athens")
        );
        assert_eq!(
            db::get_setting(&conn, "restaurant", "phone").as_deref(),
            Some("2101234567")
        );
        assert_eq!(
            db::get_setting(&conn, "restaurant", "latitude").as_deref(),
            Some("38.0742")
        );
        assert_eq!(
            db::get_setting(&conn, "terminal", "store_latitude").as_deref(),
            Some("38.0742")
        );
        assert_eq!(
            db::get_setting(&conn, "restaurant", "longitude").as_deref(),
            Some("23.8113")
        );
        assert_eq!(
            db::get_setting(&conn, "terminal", "store_longitude").as_deref(),
            Some("23.8113")
        );
        assert_eq!(
            db::get_setting(&conn, "organization", "vat_number").as_deref(),
            Some("123456789")
        );
        assert_eq!(
            db::get_setting(&conn, "organization", "tax_office").as_deref(),
            Some("DOY ATHENS")
        );
    }

    #[test]
    fn cache_snapshot_uses_display_name_when_branch_name_is_missing() {
        let db = test_db();
        let payload = serde_json::json!({
            "branch_info": {
                "display_name": "Downtown Branch",
                "address": "Main St 42",
                "city": "Athens",
                "phone": "2101234567"
            },
            "settings": {
                "terminal": {}
            }
        });

        cache_terminal_settings_snapshot(&db, &payload).expect("cache snapshot");
        let conn = db.conn.lock().expect("lock db");

        assert_eq!(
            db::get_setting(&conn, "restaurant", "name").as_deref(),
            Some("Downtown Branch")
        );
        assert_eq!(
            db::get_setting(&conn, "restaurant", "subtitle").as_deref(),
            Some("Downtown Branch")
        );
        assert_eq!(
            db::get_setting(&conn, "terminal", "store_name").as_deref(),
            Some("Downtown Branch")
        );
    }

    #[test]
    fn cache_snapshot_only_persists_whitelisted_system_settings() {
        let db = test_db();
        let payload = serde_json::json!({
            "settings": {
                "system": {
                    "business_day_start_hour": 7,
                    "business_day_start": "07:00",
                    "last_z_report_timestamp": "2026-03-27T22:00:00Z",
                    "random_runtime_value": "skip-me"
                },
                "ui": {
                    "theme": "dark"
                }
            }
        });

        let updated = cache_terminal_settings_snapshot(&db, &payload).expect("cache snapshot");
        let conn = db.conn.lock().expect("lock db");

        assert!(updated
            .iter()
            .any(|key| key == "system.business_day_start_hour"));
        assert!(updated.iter().any(|key| key == "system.business_day_start"));
        assert!(!updated
            .iter()
            .any(|key| key == "system.last_z_report_timestamp"));
        assert_eq!(
            db::get_setting(&conn, "system", "business_day_start_hour").as_deref(),
            Some("7")
        );
        assert_eq!(
            db::get_setting(&conn, "system", "business_day_start").as_deref(),
            Some("07:00")
        );
        assert!(
            db::get_setting(&conn, "system", "last_z_report_timestamp").is_none(),
            "local-only runtime system keys must stay local"
        );
        assert!(
            db::get_setting(&conn, "system", "random_runtime_value").is_none(),
            "unapproved system keys must not be cached"
        );
        assert!(
            db::get_setting(&conn, "ui", "theme").is_none(),
            "ui remains a fully local-only category"
        );
    }

    #[test]
    fn terminal_access_reset_reason_maps_explicitly_inactive_terminal_to_terminal_deleted() {
        assert_eq!(
            terminal_access_reset_reason("Terminal not found or inactive (HTTP 401)"),
            "terminal_deleted"
        );
    }

    #[test]
    fn generic_terminal_lookup_miss_is_not_treated_as_terminal_revocation() {
        assert_eq!(
            terminal_access_reset_reason("Terminal not found (HTTP 404)"),
            "invalid_terminal_credentials"
        );
        assert!(
            !is_terminal_auth_failure("Terminal not found (HTTP 404)"),
            "generic lookup misses must not wipe local terminal credentials"
        );
    }

    #[test]
    fn terminal_access_reset_reason_keeps_key_mismatch_non_destructive() {
        assert_eq!(
            terminal_access_reset_reason("Invalid API key for terminal (HTTP 401)"),
            "invalid_terminal_credentials"
        );
        assert_eq!(
            terminal_access_reset_reason("Terminal identity mismatch (HTTP 403)"),
            "invalid_terminal_credentials"
        );
    }

    #[test]
    #[serial]
    fn hydrate_connection_string_populates_decoded_and_derived_credentials() {
        let _guard = credential_guard();
        let db = test_db();
        let connection_string =
            r#"{"key":"decoded-api-key","tid":"terminal-9","url":"admin.example.com/api"}"#;

        set_terminal_setting(&db, "pos_api_key", connection_string);
        hydrate_terminal_credentials_from_local_settings(&db);

        assert_eq!(
            storage::get_credential("pos_api_key").as_deref(),
            Some("decoded-api-key")
        );
        assert_eq!(
            storage::get_credential("terminal_id").as_deref(),
            Some("terminal-9")
        );
        assert_eq!(
            storage::get_credential("admin_dashboard_url").as_deref(),
            Some("https://admin.example.com")
        );
    }

    #[test]
    #[serial]
    fn purge_keeps_plaintext_connection_string_until_companion_credentials_exist() {
        let _guard = credential_guard();
        let db = test_db();
        let connection_string =
            r#"{"key":"decoded-api-key","tid":"terminal-9","url":"admin.example.com/api"}"#;

        set_terminal_setting(&db, "pos_api_key", connection_string);
        storage::set_credential("pos_api_key", "decoded-api-key").expect("seed api key");

        purge_hydrated_terminal_credentials_from_local_settings(&db);

        let conn = db.conn.lock().expect("lock db");
        assert_eq!(
            db::get_setting(&conn, "terminal", "pos_api_key").as_deref(),
            Some(connection_string)
        );
    }

    #[test]
    #[serial]
    fn purge_drops_plaintext_connection_string_after_companion_credentials_exist() {
        let _guard = credential_guard();
        let db = test_db();
        let connection_string =
            r#"{"key":"decoded-api-key","tid":"terminal-9","url":"admin.example.com/api"}"#;

        set_terminal_setting(&db, "pos_api_key", connection_string);
        storage::set_credential("pos_api_key", "decoded-api-key").expect("seed api key");
        storage::set_credential("terminal_id", "terminal-9").expect("seed terminal id");
        storage::set_credential("admin_dashboard_url", "https://admin.example.com")
            .expect("seed admin url");

        purge_hydrated_terminal_credentials_from_local_settings(&db);

        let conn = db.conn.lock().expect("lock db");
        assert!(
            db::get_setting(&conn, "terminal", "pos_api_key").is_none(),
            "plaintext connection-string fallback should be removed once decoded credentials are durable"
        );
    }

    #[test]
    #[serial]
    fn purge_legacy_admin_url_uses_admin_dashboard_alias() {
        let _guard = credential_guard();
        let db = test_db();

        set_terminal_setting(&db, "admin_url", "admin.example.com/api/");
        storage::set_credential("admin_dashboard_url", "https://admin.example.com")
            .expect("seed admin dashboard url");

        purge_hydrated_terminal_credentials_from_local_settings(&db);

        let conn = db.conn.lock().expect("lock db");
        assert!(
            db::get_setting(&conn, "terminal", "admin_url").is_none(),
            "legacy admin_url row should purge once the normalized admin_dashboard_url credential exists"
        );
    }

    #[test]
    #[serial]
    fn purge_keeps_legacy_admin_url_when_dashboard_alias_is_missing() {
        let _guard = credential_guard();
        let db = test_db();

        set_terminal_setting(&db, "admin_url", "admin.example.com/api/");

        purge_hydrated_terminal_credentials_from_local_settings(&db);

        let conn = db.conn.lock().expect("lock db");
        assert_eq!(
            db::get_setting(&conn, "terminal", "admin_url").as_deref(),
            Some("admin.example.com/api/")
        );
    }
}
