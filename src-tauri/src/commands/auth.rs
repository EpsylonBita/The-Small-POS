use serde_json::Value;
use tauri::Emitter;

use crate::{api, auth, db, storage};

fn parse_permission_payload(arg0: Option<Value>) -> Option<String> {
    let payload = arg0?;

    match payload {
        Value::String(permission) => {
            let trimmed = permission.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Object(map) => ["permission", "name", "key", "arg0"]
            .iter()
            .find_map(|key| map.get(*key).and_then(|v| v.as_str()))
            .and_then(|permission| {
                let trimmed = permission.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }),
        _ => None,
    }
}

fn parse_permissions_payload(arg0: Option<Value>) -> Vec<String> {
    fn normalize_vec(values: Vec<Value>) -> Vec<String> {
        values
            .into_iter()
            .filter_map(|value| value.as_str().map(|s| s.trim().to_string()))
            .filter(|value| !value.is_empty())
            .collect()
    }

    match arg0 {
        Some(Value::Array(values)) => normalize_vec(values),
        Some(Value::String(permission)) => {
            let trimmed = permission.trim();
            if trimmed.is_empty() {
                vec![]
            } else {
                vec![trimmed.to_string()]
            }
        }
        Some(Value::Object(map)) => {
            if let Some(array) = map
                .get("permissions")
                .or_else(|| map.get("scopes"))
                .or_else(|| map.get("list"))
                .and_then(|v| v.as_array())
            {
                return normalize_vec(array.clone());
            }

            if let Some(permission) = parse_permission_payload(Some(Value::Object(map.clone()))) {
                return vec![permission];
            }

            vec![]
        }
        _ => vec![],
    }
}

#[tauri::command]
pub async fn auth_login(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, String> {
    auth::login(arg0, &db, &auth_state)
}

#[tauri::command]
pub async fn auth_logout(
    auth_state: tauri::State<'_, auth::AuthState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    auth::logout(&auth_state);
    let _ = app.emit("session_timeout", serde_json::json!({ "reason": "logout" }));
    Ok(())
}

// -- Secure session blob (Wave 1 C6) -----------------------------------------
//
// The renderer used to persist the authenticated session (including
// `sessionId`, `staffId`, `branchId`, `organizationId`) to plain
// `localStorage`. That placed a live credential in renderer-accessible
// storage, where any script in the JS context could read it. These three
// commands route the blob through the OS keyring via `storage.rs` so the
// cleartext only exists in the JS heap at the moment of hydration.
//
// The blob is opaque to Rust: the renderer serialises its own shape with
// `JSON.stringify` and re-parses on retrieval. Validation of the session
// (e.g. expiry) is the renderer's job — Rust only guards durability and
// at-rest protection.

#[tauri::command]
pub async fn auth_secure_session_get() -> Result<Option<String>, String> {
    Ok(storage::session_get())
}

#[tauri::command]
pub async fn auth_secure_session_set(arg0: Option<Value>) -> Result<(), String> {
    let payload = arg0.ok_or_else(|| "Missing session payload".to_string())?;
    let raw = match payload {
        Value::String(s) => s,
        // Allow callers that forgot to stringify — serialise on the Rust
        // side. We still store as a string so the get() round-trip is
        // stable.
        other => serde_json::to_string(&other)
            .map_err(|e| format!("session payload serialisation failed: {e}"))?,
    };
    storage::session_set(&raw)
}

#[tauri::command]
pub async fn auth_secure_session_clear() -> Result<(), String> {
    storage::session_clear()
}

#[tauri::command]
pub async fn auth_get_current_session(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, String> {
    Ok(auth::get_session_json(&auth_state))
}

#[tauri::command]
pub async fn auth_validate_session(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, String> {
    Ok(auth::validate_session(&auth_state))
}

#[tauri::command]
pub async fn auth_has_permission(
    arg0: Option<Value>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<bool, String> {
    let permission = parse_permission_payload(arg0);
    Ok(auth::has_permission(&auth_state, permission.as_deref()))
}

#[tauri::command]
pub async fn auth_get_session_stats(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, String> {
    Ok(auth::get_session_stats(&auth_state))
}

#[tauri::command]
pub async fn auth_confirm_privileged_action(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, auth::PrivilegedActionError> {
    auth::confirm_privileged_action(arg0, &db, &auth_state)
}

#[tauri::command]
pub async fn auth_setup_pin(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, String> {
    // Security hardening: once an admin PIN is set, require an active admin
    // session before allowing PIN reset/overwrite — UNLESS the admin has
    // remotely triggered a PIN reset (pin_reset_required flag). In that case
    // the user is on the login screen with no session and must be allowed to
    // set a new PIN to break the deadlock.
    let (has_admin_pin, pin_reset_required) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let has_pin = db::get_setting(&conn, "staff", "admin_pin_hash").is_some();
        let reset_flag = db::get_setting(&conn, "terminal", "pin_reset_required")
            .map(|v| v == "true")
            .unwrap_or(false);
        (has_pin, reset_flag)
    };
    if has_admin_pin && !pin_reset_required {
        let session = auth::get_session_json(&auth_state);
        let role_name = session
            .get("role")
            .and_then(|r| r.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if role_name != "admin" {
            return Err("Unauthorized: active admin session required to change PIN".into());
        }
    }
    let result = auth::setup_pin(arg0, &db)?;

    // Fire-and-forget: acknowledge PIN reset to admin server so the remote
    // pos_configurations flag doesn't re-sync as true on next settings fetch.
    tokio::spawn(async move {
        let Some(api_key) = storage::get_credential("pos_api_key") else {
            return;
        };
        let Some(admin_url) = storage::get_credential("admin_dashboard_url") else {
            return;
        };
        let Some(terminal_id) = storage::get_credential("terminal_id") else {
            return;
        };

        let path = format!("/api/pos/settings/{terminal_id}");
        let body = serde_json::json!({
            "settings": { "terminal": { "pin_reset_required": false } }
        });
        match api::fetch_from_admin(&admin_url, &api_key, &path, "POST", Some(body)).await {
            Ok(_) => tracing::info!("PIN reset acknowledged to admin server"),
            Err(e) => tracing::warn!("Failed to ack PIN reset to admin (non-fatal): {e}"),
        }
    });

    Ok(result)
}

#[tauri::command]
pub async fn staff_auth_authenticate_pin(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, String> {
    // staff_auth:authenticate-pin uses the same login logic
    auth::login(arg0, &db, &auth_state)
}

#[tauri::command]
pub async fn staff_auth_verify_check_in_pin(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    auth::verify_staff_check_in_pin(arg0, &db)
}

/// staff-auth:refresh-directory — fetch the staff directory (with
/// currentShift data) from the admin dashboard and persist it into the
/// local staff_auth_cache. Caller can optionally override branch_id via
/// `{ branchId: "..." }`; otherwise it's resolved from the keyring.
#[tauri::command]
pub async fn staff_auth_refresh_directory(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let branch_override = arg0
        .as_ref()
        .and_then(|v| v.get("branchId").or_else(|| v.get("branch_id")))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    auth::refresh_staff_auth_directory(&db, branch_override.as_deref()).await
}

#[tauri::command]
pub async fn staff_auth_get_session(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, String> {
    Ok(auth::get_session_json(&auth_state))
}

#[tauri::command]
pub async fn staff_auth_get_current(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, String> {
    Ok(auth::get_current_user(&auth_state))
}

#[tauri::command]
pub async fn staff_auth_has_permission(
    arg0: Option<Value>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<bool, String> {
    let permission = parse_permission_payload(arg0);
    Ok(auth::has_permission(&auth_state, permission.as_deref()))
}

#[tauri::command]
pub async fn staff_auth_has_any_permission(
    arg0: Option<Value>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<bool, String> {
    let permissions = parse_permissions_payload(arg0);
    let permissions_ref = if permissions.is_empty() {
        None
    } else {
        Some(permissions.as_slice())
    };
    Ok(auth::has_any_permission(&auth_state, permissions_ref))
}

#[tauri::command]
pub async fn staff_auth_logout(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<(), String> {
    auth::logout(&auth_state);
    Ok(())
}

#[tauri::command]
pub async fn staff_auth_validate_session(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, String> {
    Ok(auth::validate_session(&auth_state))
}

#[tauri::command]
pub async fn staff_auth_track_activity(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<(), String> {
    auth::track_activity(&auth_state);
    Ok(())
}

#[cfg(test)]
mod dto_tests {
    use super::{parse_permission_payload, parse_permissions_payload};

    #[test]
    fn parse_permission_payload_supports_string_and_object() {
        let from_string = parse_permission_payload(Some(serde_json::json!("orders.view")));
        let from_object = parse_permission_payload(Some(serde_json::json!({
            "permission": "orders.edit"
        })));
        let from_alias = parse_permission_payload(Some(serde_json::json!({
            "name": "reports.view"
        })));

        assert_eq!(from_string.as_deref(), Some("orders.view"));
        assert_eq!(from_object.as_deref(), Some("orders.edit"));
        assert_eq!(from_alias.as_deref(), Some("reports.view"));
    }

    #[test]
    fn parse_permissions_payload_supports_array_and_object_aliases() {
        let from_array = parse_permissions_payload(Some(serde_json::json!([
            "orders.view",
            "  ",
            "orders.edit"
        ])));
        let from_object = parse_permissions_payload(Some(serde_json::json!({
            "permissions": ["inventory.view", "inventory.edit"]
        })));
        let from_single = parse_permissions_payload(Some(serde_json::json!({
            "permission": "shifts.view"
        })));

        assert_eq!(from_array, vec!["orders.view", "orders.edit"]);
        assert_eq!(from_object, vec!["inventory.view", "inventory.edit"]);
        assert_eq!(from_single, vec!["shifts.view"]);
    }
}
