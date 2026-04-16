use chrono::Utc;
use tauri::Emitter;
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

fn is_cacheable_admin_get(method: &str, path: &str) -> bool {
    method.eq_ignore_ascii_case("GET")
        && path.starts_with("/api/pos/")
        && !path.contains("/api/pos/auth")
        && !path.contains("/api/pos/updates")
}

fn admin_api_cache_key(path: &str) -> String {
    format!("{ADMIN_API_CACHE_PREFIX}{path}")
}

pub(crate) fn cache_admin_get_response(
    db: &db::DbState,
    path: &str,
    response: &serde_json::Value,
) -> Result<(), String> {
    let envelope = serde_json::json!({
        "path": path,
        "cachedAt": Utc::now().to_rfc3339(),
        "data": response,
    });
    write_local_json(db, &admin_api_cache_key(path), &envelope)
}

pub(crate) fn read_cached_admin_get_response(
    db: &db::DbState,
    path: &str,
) -> Option<(serde_json::Value, Option<String>)> {
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
    crate::hydrate_terminal_credentials_from_local_settings(&db);

    let terminal_id = storage::get_credential("terminal_id")
        .or_else(|| crate::read_local_setting(&db, "terminal", "terminal_id"))
        .ok_or("Terminal not configured: missing terminal ID")?;

    let path = format!("/api/pos/settings/{terminal_id}");
    let resp = crate::admin_fetch(Some(&db), &path, "GET", None).await?;

    let mut updated: Vec<String> = Vec::new();
    if let Some(bid) = crate::extract_branch_id_from_terminal_settings_response(&resp) {
        storage::set_credential("branch_id", &bid)?;
        if let Ok(conn) = db.conn.lock() {
            let _ = db::set_setting(&conn, "terminal", "branch_id", &bid);
        }
        updated.push("branch_id".into());
    }
    if let Some(oid) = crate::extract_org_id_from_terminal_settings_response(&resp) {
        storage::set_credential("organization_id", &oid)?;
        if let Ok(conn) = db.conn.lock() {
            let _ = db::set_setting(&conn, "terminal", "organization_id", &oid);
        }
        updated.push("organization_id".into());
    }
    if let Some(ghost_enabled) =
        crate::extract_ghost_mode_feature_from_terminal_settings_response(&resp)
    {
        let ghost_value = if ghost_enabled { "true" } else { "false" };
        storage::set_credential("ghost_mode_feature_enabled", ghost_value)?;
        if let Ok(conn) = db.conn.lock() {
            let _ = db::set_setting(&conn, "terminal", "ghost_mode_feature_enabled", ghost_value);
        }
        updated.push("ghost_mode_feature_enabled".into());
    }
    if let Some(supa) = resp.get("supabase") {
        if let Some(url) = supa.get("url").and_then(|v| v.as_str()) {
            if !url.is_empty() {
                storage::set_credential("supabase_url", url)?;
                if let Ok(conn) = db.conn.lock() {
                    let _ = db::set_setting(&conn, "terminal", "supabase_url", url);
                }
                updated.push("supabase_url".into());
            }
        }
        if let Some(key) = supa.get("anon_key").and_then(|v| v.as_str()) {
            if !key.is_empty() {
                storage::set_credential("supabase_anon_key", key)?;
                updated.push("supabase_anon_key".into());
            }
        }
    }
    if let Ok(snapshot_updates) = crate::cache_terminal_settings_snapshot(&db, &resp) {
        if !snapshot_updates.is_empty() {
            updated.extend(snapshot_updates);
        }
    }
    tracing::info!("admin_sync_terminal_config: updated {:?}", updated);
    crate::scrub_sensitive_local_settings(&db);
    let _ = app.emit(
        "terminal_config_updated",
        serde_json::json!({ "updated": updated.clone() }),
    );
    let _ = app.emit(
        "terminal_settings_updated",
        serde_json::json!({ "updated": updated.clone() }),
    );
    Ok(serde_json::json!({ "success": true, "updated": updated }))
}

#[tauri::command]
pub async fn api_fetch_from_admin(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    crate::hydrate_terminal_credentials_from_local_settings(&db);

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

    let cacheable_get = is_cacheable_admin_get(&method, &final_path);

    match crate::admin_fetch(Some(&db), &final_path, &method, body).await {
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

            Ok(serde_json::json!({
                "success": false,
                "error": if cacheable_get {
                    format!("{e}. No cached local copy is available yet for offline use.")
                } else {
                    e
                }
            }))
        }
    }
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
