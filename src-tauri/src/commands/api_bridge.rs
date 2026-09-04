use chrono::Utc;
use zeroize::Zeroizing;

use crate::{api, db, read_local_json, storage, value_str, write_local_json};

const ADMIN_API_CACHE_PREFIX: &str = "admin_api_get::";

#[derive(Debug)]
struct AdminFetchCompatPayload {
    path: String,
    options: serde_json::Value,
}

fn merge_json_options(base: serde_json::Value, overlay: serde_json::Value) -> serde_json::Value {
    match (base, overlay) {
        (serde_json::Value::Object(mut left), serde_json::Value::Object(right)) => {
            for (key, value) in right {
                left.insert(key, value);
            }
            serde_json::Value::Object(left)
        }
        (serde_json::Value::Object(left), serde_json::Value::Null) => {
            serde_json::Value::Object(left)
        }
        (_, value) => value,
    }
}

fn parse_admin_fetch_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<AdminFetchCompatPayload, String> {
    let mut path: Option<String> = None;
    let mut options = serde_json::json!({});

    match arg0 {
        Some(serde_json::Value::String(s)) => {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                path = Some(trimmed.to_string());
            }
        }
        Some(serde_json::Value::Object(mut obj)) => {
            let payload = serde_json::Value::Object(obj.clone());
            path = value_str(&payload, &["path", "apiPath", "api_path", "endpoint"]);
            if let Some(nested_options) = obj.remove("options") {
                options = nested_options;
            } else {
                obj.remove("path");
                obj.remove("apiPath");
                obj.remove("api_path");
                obj.remove("endpoint");
                if !obj.is_empty() {
                    options = serde_json::Value::Object(obj);
                }
            }
        }
        _ => {}
    }

    if let Some(arg1_value) = arg1 {
        match arg1_value {
            serde_json::Value::String(s) => {
                if path.is_none() {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        path = Some(trimmed.to_string());
                    }
                }
            }
            value @ serde_json::Value::Object(_) => {
                options = merge_json_options(options, value);
            }
            serde_json::Value::Null => {}
            _ => {}
        }
    }

    let path = path.ok_or("Missing API path")?;
    let options = if options.is_object() {
        options
    } else {
        serde_json::json!({})
    };

    Ok(AdminFetchCompatPayload { path, options })
}

fn canonical_admin_route(path: &str) -> &str {
    path.split(['?', '#'])
        .next()
        .unwrap_or(path)
        .trim_end_matches('/')
}

fn is_caller_id_admin_route(path: &str) -> bool {
    let route = canonical_admin_route(path);
    route == "/api/pos/caller-id" || route.starts_with("/api/pos/caller-id/")
}

fn decode_admin_route_once(route: &str) -> String {
    fn hex_value(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let bytes = route.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn normalized_admin_route(path: &str) -> Option<String> {
    let mut decoded = canonical_admin_route(path).to_string();
    for _ in 0..8 {
        let next = decode_admin_route_once(&decoded);
        if next == decoded {
            break;
        }
        decoded = next;
    }
    if decode_admin_route_once(&decoded) != decoded {
        return None;
    }
    let decoded_route = decoded.split(['?', '#']).next().unwrap_or(decoded.as_str());
    if decoded_route.contains('\\') {
        return None;
    }
    let mut collapsed = String::with_capacity(decoded_route.len());
    for segment in decoded_route.split('/') {
        match segment {
            "" | "." => continue,
            ".." => return None,
            _ => {
                collapsed.push('/');
                collapsed.push_str(segment);
            }
        }
    }
    if collapsed.is_empty() {
        collapsed.push('/');
    }
    Some(collapsed)
}

fn is_repair_admin_route(path: &str) -> bool {
    let Some(route) = normalized_admin_route(path) else {
        return true;
    };
    route == "/api/pos/repairs" || route.starts_with("/api/pos/repairs/")
}

fn validate_generic_admin_fetch(_method: &str, path: &str) -> Result<(), &'static str> {
    if is_repair_admin_route(path) {
        Err("REPAIR_TYPED_TRANSPORT_REQUIRED")
    } else {
        Ok(())
    }
}

/// True when the GET carries an `updated_since` delta cursor
/// (procurement-loop Task 10.1: `/api/pos/purchase-orders?updated_since=...`).
/// Delta pulls are point-in-time diffs: serving one from cache is
/// semantically wrong (the caller advances its cursor from `serverTime`),
/// and every sync cycle uses a fresh cursor value, so caching them would
/// also grow `local_settings` by one dead row per cycle forever. The
/// canonical (cursorless) path stays cacheable for offline fallback.
fn is_delta_cursor_admin_get(path: &str) -> bool {
    path.split_once('?')
        .map(|(_, query)| {
            query
                .split('&')
                .any(|pair| pair.starts_with("updated_since="))
        })
        .unwrap_or(false)
}

fn is_cacheable_admin_get(method: &str, path: &str) -> bool {
    let route = canonical_admin_route(path);
    method.eq_ignore_ascii_case("GET")
        && route.starts_with("/api/pos/")
        && !route.contains("/api/pos/auth")
        && !route.contains("/api/pos/updates")
        && !is_caller_id_admin_route(path)
        && !is_repair_admin_route(path)
        && !is_delta_cursor_admin_get(path)
}

fn admin_api_cache_key(path: &str) -> String {
    format!("{ADMIN_API_CACHE_PREFIX}{path}")
}

pub(crate) fn purge_caller_id_admin_cache(db: &db::DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM local_settings
         WHERE setting_category = 'local'
           AND setting_key GLOB ?1",
        [format!("{ADMIN_API_CACHE_PREFIX}/api/pos/caller-id*")],
    )
    .map_err(|e| format!("purge legacy Caller ID API cache: {e}"))
}

pub(crate) fn purge_repair_admin_cache(db: &db::DbState) -> Result<usize, String> {
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let transaction = conn
        .transaction()
        .map_err(|e| format!("begin legacy repair API cache purge: {e}"))?;
    let keys = {
        let mut statement = transaction
            .prepare(
                "SELECT setting_key
                 FROM local_settings
                 WHERE setting_category = 'local'
                   AND setting_key LIKE ?1",
            )
            .map_err(|e| format!("scan legacy repair API cache: {e}"))?;
        let rows = statement
            .query_map([format!("{ADMIN_API_CACHE_PREFIX}%")], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| format!("query legacy repair API cache: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read legacy repair API cache: {e}"))?;
        rows
    };
    let mut removed = 0usize;
    for key in keys {
        let Some(path) = key.strip_prefix(ADMIN_API_CACHE_PREFIX) else {
            continue;
        };
        if !is_repair_admin_route(path) {
            continue;
        }
        removed = removed.saturating_add(
            transaction
                .execute(
                    "DELETE FROM local_settings
                     WHERE setting_category = 'local' AND setting_key = ?1",
                    [&key],
                )
                .map_err(|e| format!("delete legacy repair API cache: {e}"))?,
        );
    }
    transaction
        .commit()
        .map_err(|e| format!("commit legacy repair API cache purge: {e}"))?;
    Ok(removed)
}

fn admin_fetch_error_payload(
    error: &api::AdminFetchError,
    cacheable_get: bool,
) -> serde_json::Value {
    let status = error.status();
    let error_text = if cacheable_get {
        format!("{error}. No cached local copy is available yet for offline use.")
    } else {
        error.to_string()
    };
    let mut payload = serde_json::json!({
        "success": false,
        "error": error_text
    });
    if let Some(status) = status {
        payload["status"] = serde_json::json!(status);
    }
    payload
}

pub(crate) fn cache_admin_get_response(
    db: &db::DbState,
    path: &str,
    response: &serde_json::Value,
) -> Result<(), String> {
    if is_repair_admin_route(path) {
        return Ok(());
    }
    let envelope = serde_json::json!({
        "path": path,
        "cachedAt": Utc::now().to_rfc3339(),
        "data": response,
    });
    write_local_json(db, &admin_api_cache_key(path), &envelope)?;

    if path.split('?').next() == Some("/api/pos/integrations") {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let cleared = crate::sync::clear_non_fiscal_order_receipt_numbers(&conn)?;
        if cleared > 0 {
            tracing::info!(
                cleared,
                "Cleared stale non-fiscal order receipt numbers after integrations cache refresh"
            );
        }
    }

    Ok(())
}

pub(crate) fn read_cached_admin_get_response(
    db: &db::DbState,
    path: &str,
) -> Option<(serde_json::Value, Option<String>)> {
    if is_repair_admin_route(path) {
        return None;
    }
    let envelope = read_local_json(db, &admin_api_cache_key(path)).ok()?;
    let data = envelope
        .get("data")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    if data.is_null() {
        return None;
    }
    let cached_at = envelope
        .get("cachedAt")
        .or_else(|| envelope.get("updatedAt"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    Some((data, cached_at))
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedAdminPathQuery {
    #[serde(default)]
    prefixes: Vec<String>,
}

pub(crate) fn list_cached_admin_get_paths(
    db: &db::DbState,
    prefixes: &[String],
) -> Result<Vec<String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT setting_key
             FROM local_settings
             WHERE setting_category = 'local'
               AND setting_key LIKE ?1
             ORDER BY setting_key ASC",
        )
        .map_err(|e| format!("prepare cached admin path query: {e}"))?;
    let rows = stmt
        .query_map([format!("{ADMIN_API_CACHE_PREFIX}%")], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("query cached admin paths: {e}"))?;

    let trimmed_prefixes = prefixes
        .iter()
        .map(|prefix| prefix.trim().to_string())
        .filter(|prefix| !prefix.is_empty())
        .collect::<Vec<_>>();

    let mut paths = rows
        .filter_map(Result::ok)
        .filter_map(|setting_key| {
            setting_key
                .strip_prefix(ADMIN_API_CACHE_PREFIX)
                .map(str::to_string)
        })
        .filter(|path| !is_repair_admin_route(path))
        .filter(|path| {
            trimmed_prefixes.is_empty()
                || trimmed_prefixes
                    .iter()
                    .any(|prefix| path.starts_with(prefix.as_str()))
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

#[tauri::command]
pub async fn admin_sync_terminal_config(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    admin_sync_terminal_config_core(&db, &app).await
}

async fn admin_sync_terminal_config_core(
    db: &db::DbState,
    app: &impl crate::terminal_helpers::TerminalEventSink,
) -> Result<serde_json::Value, String> {
    crate::commands::settings::refresh_terminal_context_from_admin_with_completion(db, || {
        app.emit_json(
            "terminal_config_updated",
            serde_json::json!({ "source": "admin_sync_terminal_config" }),
        );
        Ok(())
    })
    .await?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn api_fetch_from_admin(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let parsed = parse_admin_fetch_payload(arg0, arg1)?;
    let path = parsed.path;
    let opts = parsed.options;
    let method = opts
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .trim()
        .to_uppercase();
    let body = opts.get("body").cloned();
    let query = opts.get("query").or_else(|| opts.get("params"));
    let final_path = if let Some(q) = query {
        crate::build_admin_query(&path, Some(q))
    } else {
        path.clone()
    };

    if let Err(error) = validate_generic_admin_fetch(&method, &final_path) {
        return Ok(serde_json::json!({
            "success": false,
            "error": error
        }));
    }

    if let Err(e) = crate::validate_admin_api_path(&final_path) {
        return Ok(serde_json::json!({
            "success": false,
            "error": e
        }));
    }
    if !matches!(method.as_str(), "GET" | "POST" | "PATCH" | "PUT" | "DELETE") {
        return Ok(serde_json::json!({
            "success": false,
            "error": "Unsupported HTTP method"
        }));
    }

    crate::hydrate_terminal_credentials_from_local_settings(&db);

    let cacheable_get = is_cacheable_admin_get(&method, &final_path);

    match crate::admin_fetch_detailed(Some(&db), &final_path, &method, body).await {
        Ok(v) => {
            if cacheable_get {
                let _ = cache_admin_get_response(&db, &final_path, &v);
            }

            Ok(serde_json::json!({
                "success": true,
                "data": v,
                "status": 200,
                "meta": {
                    "source": "remote"
                }
            }))
        }
        Err(e) => {
            if cacheable_get {
                if let Some((cached_data, cached_at)) =
                    read_cached_admin_get_response(&db, &final_path)
                {
                    return Ok(serde_json::json!({
                        "success": true,
                        "data": cached_data,
                        "status": 200,
                        "meta": {
                            "source": "cache",
                            "cachedAt": cached_at,
                            "offlineFallback": true,
                            "path": final_path,
                        }
                    }));
                }
            }

            Ok(admin_fetch_error_payload(&e, cacheable_get))
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomerMessagingRequestInput {
    staff_session_id: String,
    path: String,
    method: String,
    #[serde(default)]
    body: Option<serde_json::Value>,
}

fn validate_customer_messaging_request(
    input: &CustomerMessagingRequestInput,
) -> Result<(), &'static str> {
    let staff = uuid::Uuid::parse_str(input.staff_session_id.trim())
        .map_err(|_| "CUSTOMER_MESSAGING_STAFF_SESSION_REQUIRED")?;
    if staff.to_string() != input.staff_session_id.trim().to_ascii_lowercase() {
        return Err("CUSTOMER_MESSAGING_STAFF_SESSION_REQUIRED");
    }
    let method = input.method.trim().to_ascii_uppercase();
    let route = normalized_admin_route(&input.path).ok_or("CUSTOMER_MESSAGING_ROUTE_INVALID")?;
    let allowed = (matches!(method.as_str(), "GET" | "POST")
        && route == "/api/pos/customer-messaging")
        || (method == "POST"
            && matches!(
                route.as_str(),
                "/api/pos/customer-messaging/messages/send"
                    | "/api/pos/customer-messaging/link-sessions"
            ))
        || (method == "POST"
            && route.starts_with("/api/pos/customer-messaging/messages/")
            && route.ends_with("/retry")
            && route
                .split('/')
                .nth(5)
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()));
    if !allowed {
        return Err("CUSTOMER_MESSAGING_ROUTE_INVALID");
    }
    Ok(())
}

#[tauri::command]
pub async fn customer_messaging_request(
    input: CustomerMessagingRequestInput,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    validate_customer_messaging_request(&input).map_err(str::to_string)?;
    crate::validate_admin_api_path(&input.path)?;
    crate::hydrate_terminal_credentials_from_local_settings(&db);
    let (admin_url, api_key) = crate::resolve_admin_endpoint(Some(&db))
        .await
        .map_err(|error| error.to_string())?;
    crate::api::fetch_from_admin_detailed_with_staff_session(
        &admin_url,
        &api_key,
        &input.path,
        &input.method,
        input.body,
        Some(input.staff_session_id.trim()),
        crate::api::DEFAULT_TIMEOUT,
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn api_list_cached_paths(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let query: CachedAdminPathQuery = arg0
        .map(serde_json::from_value)
        .transpose()
        .unwrap_or_default()
        .unwrap_or_default();
    let paths = list_cached_admin_get_paths(&db, &query.prefixes)?;
    Ok(serde_json::json!({
        "success": true,
        "paths": paths,
    }))
}

#[tauri::command]
pub async fn sync_test_parent_connection(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    crate::hydrate_terminal_credentials_from_local_settings(&db);
    let admin_url = storage::get_credential("admin_dashboard_url")
        .ok_or("Terminal not configured: missing admin URL")?;
    let raw_api_key = Zeroizing::new(
        storage::get_credential("pos_api_key").ok_or("Terminal not configured: missing API key")?,
    );
    let api_key = Zeroizing::new(
        api::extract_api_key_from_connection_string(&raw_api_key)
            .unwrap_or_else(|| (*raw_api_key).clone()),
    );

    let result = api::test_connectivity(&admin_url, &api_key).await;
    serde_json::to_value(&result).map_err(|e| e.to_string())
}

#[cfg(test)]
mod dto_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    const OLD_ORG: &str = "11111111-1111-4111-8111-111111111111";
    const OLD_BRANCH: &str = "22222222-2222-4222-8222-222222222222";
    const OLD_TERMINAL: &str = "33333333-3333-4333-8333-333333333333";
    const NEW_ORG: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const NEW_BRANCH: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    #[test]
    fn customer_messaging_bridge_accepts_only_fixed_routes_and_uuid_session() {
        let valid = CustomerMessagingRequestInput {
            staff_session_id: OLD_ORG.to_string(),
            path: format!("/api/pos/customer-messaging?customer_id={NEW_ORG}&limit=25"),
            method: "GET".to_string(),
            body: None,
        };
        assert_eq!(validate_customer_messaging_request(&valid), Ok(()));

        let preference = CustomerMessagingRequestInput {
            staff_session_id: OLD_ORG.to_string(),
            path: "/api/pos/customer-messaging".to_string(),
            method: "POST".to_string(),
            body: Some(serde_json::json!({
                "customer_id": NEW_ORG,
                "decision": "no_preference",
                "channel": null,
                "connection_id": null,
                "purpose": "transactional"
            })),
        };
        assert_eq!(validate_customer_messaging_request(&preference), Ok(()));

        let hostile = CustomerMessagingRequestInput {
            path: "/api/pos/plugin-credentials".to_string(),
            ..valid
        };
        assert_eq!(
            validate_customer_messaging_request(&hostile),
            Err("CUSTOMER_MESSAGING_ROUTE_INVALID")
        );
        let invalid_session = CustomerMessagingRequestInput {
            staff_session_id: "attacker-session".to_string(),
            path: "/api/pos/customer-messaging/messages/send".to_string(),
            method: "POST".to_string(),
            body: Some(serde_json::json!({})),
        };
        assert_eq!(
            validate_customer_messaging_request(&invalid_session),
            Err("CUSTOMER_MESSAGING_STAFF_SESSION_REQUIRED")
        );
    }

    #[derive(Default)]
    struct CaptureTerminalEvents {
        events: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl crate::terminal_helpers::TerminalEventSink for CaptureTerminalEvents {
        fn emit_json(&self, event: &str, payload: serde_json::Value) {
            self.events
                .lock()
                .expect("capture terminal event")
                .push((event.to_string(), payload));
        }
    }

    impl CaptureTerminalEvents {
        fn len(&self) -> usize {
            self.events.lock().expect("read terminal events").len()
        }
    }

    fn keyring_identity_snapshot() -> Vec<(String, Option<String>)> {
        [
            "terminal_id",
            "organization_id",
            "branch_id",
            "admin_dashboard_url",
            "pos_api_key",
            "ghost_mode_feature_enabled",
            crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
            "pos_session",
        ]
        .into_iter()
        .map(|key| (key.to_string(), crate::storage::get_credential(key)))
        .collect()
    }

    fn seed_command_identity(server_url: &str) -> crate::tests::fake_keyring::Guard {
        let scope = serde_json::json!({
            "version": 1,
            "organization_id": OLD_ORG,
            "branch_id": OLD_BRANCH,
            "terminal_id": OLD_TERMINAL,
            "scope_token": "44444444-4444-4444-8444-444444444444",
            "scope_epoch": 3,
            "transition_pending": false,
            "reset_pending": false,
            "offline_terminal_token": null,
            "offline_sequence_lease_start": null,
            "offline_sequence_lease_end": null
        });
        crate::tests::fake_keyring::install_seeded([
            ("terminal_id".to_string(), OLD_TERMINAL.to_string()),
            ("organization_id".to_string(), OLD_ORG.to_string()),
            ("branch_id".to_string(), OLD_BRANCH.to_string()),
            ("admin_dashboard_url".to_string(), server_url.to_string()),
            ("pos_api_key".to_string(), "compat-api-key".to_string()),
            (
                crate::storage::KEY_REPAIR_SCOPE_V1.to_string(),
                scope.to_string(),
            ),
            (
                crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1.to_string(),
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=".to_string(),
            ),
            (
                crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1.to_string(),
                "old-actor".to_string(),
            ),
            ("pos_session".to_string(), "old-staff-session".to_string()),
        ])
    }

    fn seed_command_db(state: &db::DbState, server_url: &str) {
        let connection = state.conn.lock().expect("seed managed command db");
        for (key, value) in [
            ("terminal_id", OLD_TERMINAL),
            ("organization_id", OLD_ORG),
            ("branch_id", OLD_BRANCH),
            ("admin_dashboard_url", server_url),
        ] {
            db::set_setting(&connection, "terminal", key, value).expect("seed identity mirror");
        }
        connection
            .execute(
                "INSERT INTO repair_cache (
                    organization_id, branch_id, terminal_id, repair_id, display_number,
                    status, authoritative_status, priority, intake_mode,
                    authoritative_version, optimistic_version, scope_generation,
                    workspace_nonce, workspace_ciphertext, dirty, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 'R-COMPAT', 'received', 'received',
                           'normal', 'standard', 0, 1, 3, zeroblob(12), zeroblob(24),
                           1, datetime('now'), datetime('now'))",
                rusqlite::params![
                    OLD_ORG,
                    OLD_BRANCH,
                    OLD_TERMINAL,
                    "55555555-5555-4555-8555-555555555555"
                ],
            )
            .expect("seed old repair row");
        connection
            .execute(
                "INSERT INTO parity_sync_queue (
                    id, table_name, record_id, operation, data, organization_id,
                    created_at, retry_delay_ms, module_type, conflict_strategy,
                    version, repair_aggregate_id, status
                 ) VALUES (?1, 'repairs', ?2, 'INSERT', 'opaque', ?3,
                           datetime('now'), 1000, 'repairs', 'manual', 0, ?2, 'pending')",
                rusqlite::params![
                    "66666666-6666-4666-8666-666666666666",
                    "55555555-5555-4555-8555-555555555555",
                    OLD_ORG
                ],
            )
            .expect("seed old repair queue row");
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn registered_admin_sync_identity_change_uses_canonical_purge_before_one_success() {
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let response = serde_json::json!({
            "terminal_id": OLD_TERMINAL,
            "organization_id": NEW_ORG,
            "branch_id": NEW_BRANCH,
            "ghost_mode_feature_enabled": true
        });
        let server = crate::tests::fake_http::MockServer::new(response.to_string());
        let _keyring = seed_command_identity(server.url.as_str());
        let database = crate::tests::harness::TestDb::open();
        seed_command_db(&database.state, server.url.as_str());
        let events = CaptureTerminalEvents::default();

        let result = super::admin_sync_terminal_config_core(&database.state, &events)
            .await
            .expect("canonical compatibility refresh");
        assert_eq!(
            result.get("success").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            crate::storage::get_credential("organization_id").as_deref(),
            Some(NEW_ORG)
        );
        assert_eq!(
            crate::storage::get_credential("branch_id").as_deref(),
            Some(NEW_BRANCH)
        );
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
                .is_none()
        );
        assert!(crate::storage::get_credential("pos_session").is_none());
        let connection = database.state.conn.lock().expect("verify purge");
        let repair_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM repair_cache", [], |row| row.get(0))
            .expect("count repair rows");
        let queue_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE module_type = 'repairs'",
                [],
                |row| row.get(0),
            )
            .expect("count repair queue rows");
        drop(connection);
        assert_eq!((repair_rows, queue_rows), (0, 0));
        assert_eq!(events.len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn registered_admin_sync_missing_identity_has_zero_mutation_and_zero_success() {
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let server = crate::tests::fake_http::MockServer::new(
            serde_json::json!({ "terminal_id": OLD_TERMINAL }).to_string(),
        );
        let _keyring = seed_command_identity(server.url.as_str());
        let database = crate::tests::harness::TestDb::open();
        seed_command_db(&database.state, server.url.as_str());
        let events = CaptureTerminalEvents::default();
        let before_keyring = keyring_identity_snapshot();
        let before_db = {
            let connection = database.state.conn.lock().expect("snapshot db");
            db::get_all_settings(&connection)
        };

        super::admin_sync_terminal_config_core(&database.state, &events)
            .await
            .expect_err("missing authoritative tenant identity must fail");

        assert_eq!(keyring_identity_snapshot(), before_keyring);
        let after_db = {
            let connection = database.state.conn.lock().expect("verify db");
            db::get_all_settings(&connection)
        };
        assert_eq!(after_db, before_db);
        assert_eq!(events.len(), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn registered_admin_sync_missing_managed_url_never_uses_matching_sqlite_fallback() {
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let server = crate::tests::fake_http::MockServer::new(
            serde_json::json!({
                "terminal_id": OLD_TERMINAL,
                "organization_id": OLD_ORG,
                "branch_id": OLD_BRANCH
            })
            .to_string(),
        );
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", OLD_TERMINAL),
            ("organization_id", OLD_ORG),
            ("branch_id", OLD_BRANCH),
            ("pos_api_key", "plain-api-key"),
        ]);
        let database = crate::tests::harness::TestDb::open();
        seed_command_db(&database.state, server.url.as_str());
        let events = CaptureTerminalEvents::default();
        let before = keyring_identity_snapshot();

        super::admin_sync_terminal_config_core(&database.state, &events)
            .await
            .expect_err("registered command must require managed Admin URL");

        assert_eq!(server.count(), 0);
        assert_eq!(events.len(), 0);
        assert_eq!(keyring_identity_snapshot(), before);
        assert!(crate::storage::get_credential("admin_dashboard_url").is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn registered_admin_sync_same_identity_emits_one_bounded_success() {
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let response = serde_json::json!({
            "terminal_id": OLD_TERMINAL,
            "organization_id": OLD_ORG,
            "branch_id": OLD_BRANCH
        });
        let server = crate::tests::fake_http::MockServer::new(response.to_string());
        let _keyring = seed_command_identity(server.url.as_str());
        let database = crate::tests::harness::TestDb::open();
        seed_command_db(&database.state, server.url.as_str());
        let events = CaptureTerminalEvents::default();

        super::admin_sync_terminal_config_core(&database.state, &events)
            .await
            .expect("same-identity compatibility refresh");

        assert_eq!(events.len(), 1);
        let connection = database.state.conn.lock().expect("verify rows retained");
        let repair_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM repair_cache", [], |row| row.get(0))
            .expect("count repair rows");
        assert_eq!(repair_rows, 1);
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn identity_change_secondary_sqlite_failure_never_publishes_b_or_success() {
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let response = serde_json::json!({
            "terminal_id": OLD_TERMINAL,
            "organization_id": NEW_ORG,
            "branch_id": NEW_BRANCH,
            "ghost_mode_feature_enabled": true
        });
        let server = crate::tests::fake_http::MockServer::new(response.to_string());
        let _keyring = seed_command_identity(server.url.as_str());
        let database = crate::tests::harness::TestDb::open();
        seed_command_db(&database.state, server.url.as_str());
        {
            let connection = database
                .state
                .conn
                .lock()
                .expect("inject secondary failure");
            connection
                .execute_batch(
                    "CREATE TRIGGER fail_compat_secondary_write
                     BEFORE INSERT ON local_settings
                     WHEN NEW.setting_category = 'terminal'
                      AND NEW.setting_key = 'ghost_mode_feature_enabled'
                      AND NEW.setting_value = 'true'
                     BEGIN
                       SELECT RAISE(ABORT, 'private secondary write failure');
                     END;",
                )
                .expect("install secondary failure trigger");
        }
        let events = CaptureTerminalEvents::default();

        let error = super::admin_sync_terminal_config_core(&database.state, &events)
            .await
            .expect_err("secondary failure must fail closed before B publication");
        assert!(!error.contains("private secondary write failure"));
        assert_eq!(events.len(), 0);
        let published_b = crate::storage::get_credential("organization_id").as_deref()
            == Some(NEW_ORG)
            || crate::storage::get_credential("branch_id").as_deref() == Some(NEW_BRANCH);
        let pending =
            crate::commands::settings::terminal_connection_rebind_pending(&database.state)
                .expect("read durable candidate marker");
        assert!(
            !published_b || pending,
            "B became usable after a failed secondary generation"
        );
    }

    fn test_db_state() -> db::DbState {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS local_settings (
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
    fn parse_admin_fetch_payload_supports_legacy_tuple() {
        let parsed = parse_admin_fetch_payload(
            Some(serde_json::json!("/api/pos/coupons")),
            Some(serde_json::json!({
                "method": "post",
                "body": { "name": "happy-hour" }
            })),
        )
        .expect("legacy tuple should parse");

        assert_eq!(parsed.path, "/api/pos/coupons");
        assert_eq!(
            parsed.options.get("method").and_then(|v| v.as_str()),
            Some("post")
        );
    }

    #[test]
    fn parse_admin_fetch_payload_supports_object_payload() {
        let parsed = parse_admin_fetch_payload(
            Some(serde_json::json!({
                "path": "/api/pos/tables",
                "method": "GET",
                "query": { "limit": 100 }
            })),
            None,
        )
        .expect("object payload should parse");

        assert_eq!(parsed.path, "/api/pos/tables");
        assert_eq!(
            parsed
                .options
                .get("query")
                .and_then(|v| v.get("limit"))
                .and_then(|v| v.as_i64()),
            Some(100)
        );
    }

    #[test]
    fn parse_admin_fetch_payload_merges_options_from_arg1() {
        let parsed = parse_admin_fetch_payload(
            Some(serde_json::json!({
                "path": "/api/pos/services",
                "options": { "method": "GET" }
            })),
            Some(serde_json::json!({
                "query": { "active": true }
            })),
        )
        .expect("options merge should parse");

        assert_eq!(
            parsed.options.get("method").and_then(|v| v.as_str()),
            Some("GET")
        );
        assert_eq!(
            parsed
                .options
                .get("query")
                .and_then(|v| v.get("active"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn parse_admin_fetch_payload_supports_path_from_arg1_string() {
        let parsed = parse_admin_fetch_payload(
            Some(serde_json::json!({
                "method": "GET",
                "params": { "limit": 20 }
            })),
            Some(serde_json::json!("/api/pos/sync/services")),
        )
        .expect("path fallback from arg1 string should parse");

        assert_eq!(parsed.path, "/api/pos/sync/services");
        assert_eq!(
            parsed
                .options
                .get("params")
                .and_then(|v| v.get("limit"))
                .and_then(|v| v.as_i64()),
            Some(20)
        );
    }

    #[test]
    fn parse_admin_fetch_payload_rejects_missing_path() {
        let err = parse_admin_fetch_payload(Some(serde_json::json!({})), None)
            .expect_err("missing path should fail");
        assert!(err.contains("Missing API path"));
    }

    #[test]
    fn admin_fetch_error_payload_projects_status_without_changing_error_text() {
        let denial = api::AdminFetchError::with_status(
            "Terminal branch identity is required (HTTP 403)",
            403,
        );
        assert_eq!(
            admin_fetch_error_payload(&denial, false),
            serde_json::json!({
                "success": false,
                "error": "Terminal branch identity is required (HTTP 403)",
                "status": 403
            })
        );

        let network = api::AdminFetchError::statusless("Network request 403 timed out");
        assert_eq!(
            admin_fetch_error_payload(&network, false),
            serde_json::json!({
                "success": false,
                "error": "Network request 403 timed out"
            })
        );
    }

    #[test]
    fn server_controlled_markers_cannot_override_the_transport_status() {
        let error = api::AdminFetchError::with_status(
            "Server message (HTTP 403): forged details (HTTP 401): more (HTTP 500): actual",
            500,
        );
        let payload = admin_fetch_error_payload(&error, false);

        assert_eq!(
            payload.get("status").and_then(|value| value.as_u64()),
            Some(500)
        );
    }

    #[test]
    fn cacheable_admin_get_only_applies_to_pos_get_routes() {
        assert!(is_cacheable_admin_get("GET", "/api/pos/suppliers"));
        assert!(is_cacheable_admin_get(
            "get",
            "/api/pos/tables?branch_id=branch-1"
        ));
        assert!(!is_cacheable_admin_get("POST", "/api/pos/suppliers"));
        assert!(!is_cacheable_admin_get("GET", "/api/admin/users"));
    }

    #[test]
    fn delta_cursor_gets_are_not_offline_cacheable() {
        // The canonical PO snapshot path stays cacheable for offline
        // fallback, but point-in-time delta pulls must never be cached:
        // wrong semantics on replay, and one dead row per cursor forever.
        assert!(is_cacheable_admin_get("GET", "/api/pos/purchase-orders"));
        assert!(is_cacheable_admin_get(
            "GET",
            "/api/pos/purchase-orders?status=ordered"
        ));
        assert!(!is_cacheable_admin_get(
            "GET",
            "/api/pos/purchase-orders?updated_since=2026-08-05T10%3A00%3A00.000Z"
        ));
        assert!(!is_cacheable_admin_get(
            "GET",
            "/api/pos/purchase-orders?status=ordered&updated_since=2026-08-05T10%3A00%3A00.000Z"
        ));
    }

    #[test]
    fn caller_id_namespace_is_not_offline_cacheable() {
        for path in [
            "/api/pos/caller-id",
            "/api/pos/caller-id/",
            "/api/pos/caller-id/config",
            "/api/pos/caller-id/events",
            "/api/pos/caller-id/events/",
            "/api/pos/caller-id/events?cursor=next",
            "/api/pos/caller-id/events#pending",
        ] {
            assert!(
                !is_cacheable_admin_get("GET", path),
                "Caller ID live route must not be cached: {path}"
            );
        }
        assert!(is_cacheable_admin_get("GET", "/api/pos/suppliers"));
    }

    #[test]
    fn repair_get_namespace_is_never_cached_and_legacy_rows_are_purged() {
        for path in [
            "/api/pos/repairs",
            "/api/pos/repairs/",
            "/api/pos/repairs?status=ready",
            "/api/pos/repairs/settings",
            "/api/pos/repairs/88888888-8888-4888-8888-888888888888",
            "/api/pos/repairs/88888888-8888-4888-8888-888888888888/attachments?limit=20",
        ] {
            assert!(
                !is_cacheable_admin_get("GET", path),
                "repair route must not use generic Admin GET cache: {path}"
            );
        }
        assert!(is_cacheable_admin_get("GET", "/api/pos/repairs-export"));
        assert!(is_cacheable_admin_get("GET", "/api/pos/suppliers"));

        let db = test_db_state();
        let repair_path = "/api/pos/repairs?status=ready";
        let near_prefix_path = "/api/pos/repairs-export?format=csv";
        let ordinary_path = "/api/pos/suppliers";
        let repair_key = admin_api_cache_key(repair_path);
        let equivalent_repair_paths = [
            "/api/pos/%72epairs?status=ready",
            "/api/pos/%2572epairs/settings",
            "/api/pos//repairs/88888888-8888-4888-8888-888888888888",
            "/api/pos/./repairs/88888888-8888-4888-8888-888888888888",
            "/api/pos/%255crepairs/88888888-8888-4888-8888-888888888888",
        ];
        let near_prefix_key = admin_api_cache_key(near_prefix_path);
        write_local_json(
            &db,
            &repair_key,
            &serde_json::json!({
                "path": repair_path,
                "cachedAt": "2026-08-26T10:00:00Z",
                "data": { "repairs": [{ "intake_notes": "legacy PII" }] }
            }),
        )
        .expect("seed legacy repair cache");
        for path in equivalent_repair_paths {
            write_local_json(
                &db,
                &admin_api_cache_key(path),
                &serde_json::json!({
                    "path": path,
                    "cachedAt": "2026-08-26T10:00:00Z",
                    "data": { "repairs": [{ "diagnosis": "legacy encoded PII" }] }
                }),
            )
            .expect("seed equivalent legacy repair cache");
        }
        write_local_json(
            &db,
            &near_prefix_key,
            &serde_json::json!({
                "path": near_prefix_path,
                "cachedAt": "2026-08-26T10:00:00Z",
                "data": { "items": [] }
            }),
        )
        .expect("seed near-prefix cache");
        cache_admin_get_response(&db, ordinary_path, &serde_json::json!({ "items": [] }))
            .expect("seed ordinary cache");

        assert!(read_cached_admin_get_response(&db, repair_path).is_none());
        assert!(read_cached_admin_get_response(&db, ordinary_path).is_some());
        let listed = list_cached_admin_get_paths(&db, &[]).expect("list cache paths");
        assert!(!listed.iter().any(|path| is_repair_admin_route(path)));
        assert!(listed.contains(&ordinary_path.to_string()));

        assert_eq!(
            purge_repair_admin_cache(&db).expect("purge legacy repair cache"),
            1 + equivalent_repair_paths.len()
        );
        assert!(read_local_json(&db, &repair_key)
            .expect("read purged repair cache key")
            .is_null());
        for path in equivalent_repair_paths {
            assert!(
                read_local_json(&db, &admin_api_cache_key(path))
                    .expect("read equivalent purged repair cache key")
                    .is_null(),
                "equivalent repair cache path was retained: {path}"
            );
        }
        assert!(!read_local_json(&db, &near_prefix_key)
            .expect("read retained near-prefix cache key")
            .is_null());
        assert!(read_cached_admin_get_response(&db, ordinary_path).is_some());

        cache_admin_get_response(
            &db,
            "/api/pos/repairs/settings",
            &serde_json::json!({ "settings": { "private": true } }),
        )
        .expect("repair cache write is a safe no-op");
        assert!(
            read_local_json(&db, &admin_api_cache_key("/api/pos/repairs/settings"))
                .expect("read repair cache no-op key")
                .is_null()
        );
    }

    #[test]
    fn generic_admin_bridge_rejects_every_repair_namespace_form_and_method() {
        let repair_paths = [
            "/api/pos/repairs",
            "/api/pos/repairs/",
            "/api/pos/repairs?status=ready",
            "/api/pos/repairs#fragment",
            "/api/pos/repairs/settings",
            "/api/pos/%72epairs",
            "/api/pos/%2572epairs",
            "/api/pos/repairs%2F88888888-8888-4888-8888-888888888888",
            "/api/pos/repairs%252F88888888-8888-4888-8888-888888888888",
            "/api/pos//repairs",
            "/api/pos/./repairs",
            "/api/pos/%2e/repairs",
            "/api/pos/%2E/repairs",
            "/api/pos/%252e/repairs",
            "/api/pos\\repairs",
            "/api/pos/%5crepairs",
            "/api/pos/%255crepairs",
        ];
        for method in ["GET", "POST", "PATCH", "PUT", "DELETE"] {
            for path in repair_paths {
                assert_eq!(
                    validate_generic_admin_fetch(method, path),
                    Err("REPAIR_TYPED_TRANSPORT_REQUIRED"),
                    "generic {method} unexpectedly allowed {path}"
                );
            }
        }
        for allowed in [
            "/api/pos/repairs-export",
            "/api/pos/repairs-export?format=csv",
            "/api/pos/suppliers?search=repairs%2Fready",
        ] {
            assert_eq!(validate_generic_admin_fetch("GET", allowed), Ok(()));
        }
    }

    #[test]
    fn caller_id_cache_purge_removes_legacy_sensitive_rows_only() {
        let db = test_db_state();
        let sensitive_path = "/api/pos/caller-id/config";
        let ordinary_path = "/api/pos/suppliers";
        cache_admin_get_response(
            &db,
            sensitive_path,
            &serde_json::json!({
                "sourceLines": [{ "credentials": { "present": true } }]
            }),
        )
        .expect("seed sensitive legacy cache");
        cache_admin_get_response(
            &db,
            ordinary_path,
            &serde_json::json!({
                "items": []
            }),
        )
        .expect("seed ordinary cache");

        purge_caller_id_admin_cache(&db).expect("purge Caller ID cache");

        assert!(read_cached_admin_get_response(&db, sensitive_path).is_none());
        assert!(read_cached_admin_get_response(&db, ordinary_path).is_some());
    }

    #[test]
    fn admin_api_cache_round_trips_from_local_settings() {
        let db = test_db_state();
        let path = "/api/pos/inventory?branch_id=branch-1";
        let response = serde_json::json!({
            "success": true,
            "items": [{ "id": "inv-1" }]
        });

        cache_admin_get_response(&db, path, &response).expect("cache response");
        let (cached_data, cached_at) =
            read_cached_admin_get_response(&db, path).expect("cached response");

        assert_eq!(cached_data, response);
        assert!(cached_at.is_some());
    }
}
