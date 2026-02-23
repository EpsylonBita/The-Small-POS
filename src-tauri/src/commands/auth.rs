use serde_json::Value;
use tauri::Emitter;

use crate::{auth, db};

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
pub async fn auth_setup_pin(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, String> {
    // Security hardening: once an admin PIN is set, require an active admin
    // session before allowing PIN reset/overwrite.
    let has_admin_pin = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        db::get_setting(&conn, "staff", "admin_pin_hash").is_some()
    };
    if has_admin_pin {
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
    auth::setup_pin(arg0, &db)
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
