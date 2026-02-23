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
        _ => None,
    }
}

pub(crate) fn is_sensitive_terminal_setting(setting_key: &str) -> bool {
    let key = setting_key.trim().to_ascii_lowercase();
    matches!(
        key.as_str(),
        "pos_api_key"
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
    warn!(
        source = %source,
        error = %error,
        "Invalid terminal credentials detected; clearing stored API key and forcing onboarding reset"
    );
    clear_terminal_api_key(db);
    let _ = app.emit(
        "app_reset",
        serde_json::json!({
            "reason": "invalid_terminal_credentials",
            "source": source
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
