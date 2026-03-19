use chrono::{TimeZone, Utc};
use reqwest::Url;
use std::path::PathBuf;

use crate::{db, storage, MODULE_CACHE_FILE};

pub(crate) fn payload_arg0_as_string(
    arg0: Option<serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    match arg0 {
        Some(serde_json::Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Some(serde_json::Value::Object(obj)) => {
            let payload = serde_json::Value::Object(obj);
            crate::value_str(&payload, keys)
        }
        _ => None,
    }
}

pub(crate) fn build_admin_query(path: &str, options: Option<&serde_json::Value>) -> String {
    fn enc(s: &str) -> String {
        s.replace('%', "%25")
            .replace('&', "%26")
            .replace('=', "%3D")
            .replace(' ', "%20")
            .replace('+', "%2B")
            .replace('?', "%3F")
            .replace('#', "%23")
    }
    let mut query: Vec<(String, String)> = Vec::new();
    if let Some(serde_json::Value::Object(map)) = options {
        for (k, v) in map {
            if v.is_null() {
                continue;
            }
            let sval = match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Bool(b) => b.to_string(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => v.to_string(),
            };
            if !sval.is_empty() {
                query.push((k.clone(), sval));
            }
        }
    }
    if query.is_empty() {
        return path.to_string();
    }
    let mut out = String::from(path);
    out.push('?');
    out.push_str(
        &query
            .iter()
            .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
            .collect::<Vec<String>>()
            .join("&"),
    );
    out
}

pub(crate) fn validate_admin_api_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Missing API path".into());
    }

    // Reject null bytes, backslashes, and control characters.
    if path.bytes().any(|b| b == 0 || b == b'\\' || b < 0x20) {
        return Err("Invalid characters in API path".into());
    }

    // Decode percent-encoded sequences and re-validate against traversal.
    // Manual decode to avoid adding a crate dependency.
    let decoded = percent_decode_simple(path);

    if decoded.contains("..") {
        return Err("Invalid API path".into());
    }
    if decoded.bytes().any(|b| b == 0 || b == b'\\' || b < 0x20) {
        return Err("Invalid characters in API path (encoded)".into());
    }

    if path.starts_with("http://") || path.starts_with("https://") {
        return Err("Absolute URLs are not allowed".into());
    }
    if !path.starts_with("/api/") {
        return Err("Only /api/* paths are allowed".into());
    }
    let allowed_prefixes = ["/api/pos/", "/api/health", "/api/menu/combos/"];
    if allowed_prefixes.iter().any(|p| path.starts_with(p)) {
        return Ok(());
    }
    Err("Path is outside the POS/admin allowlist".into())
}

/// Simple percent-decode: replaces `%XX` sequences with the decoded byte.
/// Does not handle `+` as space (not needed for path validation).
fn percent_decode_simple(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn normalize_status_for_storage(status: &str) -> String {
    match status.trim().to_lowercase().as_str() {
        "approved" => "confirmed".to_string(),
        "declined" | "rejected" => "cancelled".to_string(),
        "canceled" => "cancelled".to_string(),
        other => other.to_string(),
    }
}

pub(crate) fn can_transition_locally(from_status: &str, to_status: &str) -> bool {
    let from = normalize_status_for_storage(from_status);
    let to = normalize_status_for_storage(to_status);

    if from.is_empty() || to.is_empty() {
        return false;
    }

    if from == to {
        return true;
    }

    match from.as_str() {
        "pending" => matches!(
            to.as_str(),
            "confirmed"
                | "preparing"
                | "ready"
                | "out_for_delivery"
                | "delivered"
                | "completed"
                | "cancelled"
        ),
        "confirmed" => matches!(
            to.as_str(),
            "preparing" | "ready" | "out_for_delivery" | "delivered" | "completed" | "cancelled"
        ),
        "preparing" => matches!(
            to.as_str(),
            "ready" | "out_for_delivery" | "delivered" | "completed" | "cancelled"
        ),
        "ready" => matches!(
            to.as_str(),
            "out_for_delivery" | "delivered" | "completed" | "cancelled"
        ),
        "out_for_delivery" => matches!(to.as_str(), "delivered" | "completed" | "cancelled"),
        "delivered" => matches!(to.as_str(), "completed" | "refunded"),
        "completed" => to == "refunded",
        "cancelled" => to == "pending",
        _ => false,
    }
}

fn module_cache_path(db: &db::DbState) -> PathBuf {
    db.db_path
        .parent()
        .map(|p| p.join(MODULE_CACHE_FILE))
        .unwrap_or_else(|| PathBuf::from(MODULE_CACHE_FILE))
}

pub(crate) fn read_module_cache(db: &db::DbState) -> Result<serde_json::Value, String> {
    let path = module_cache_path(db);
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read module cache: {e}"))?;
    serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| format!("parse module cache: {e}"))
}

pub(crate) fn write_module_cache(
    db: &db::DbState,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let path = module_cache_path(db);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create cache dir: {e}"))?;
    }
    let text =
        serde_json::to_string_pretty(payload).map_err(|e| format!("serialize cache: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("write module cache: {e}"))
}

pub(crate) fn clear_operational_data_inner(db: &db::DbState) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute_batch(
        "
        BEGIN IMMEDIATE;
        DELETE FROM payment_adjustments;
        DELETE FROM order_payments;
        DELETE FROM shift_expenses;
        DELETE FROM cash_drawer_sessions;
        DELETE FROM staff_shifts;
        DELETE FROM print_jobs;
        DELETE FROM z_reports;
        DELETE FROM sync_queue;
        DELETE FROM orders;
        COMMIT;
        ",
    )
    .map_err(|e| format!("clear operational data: {e}"))?;

    Ok(serde_json::json!({
        "success": true
    }))
}

pub(crate) async fn fetch_supabase_rows(
    path: &str,
    params: &[(&str, String)],
) -> Result<serde_json::Value, String> {
    let supabase_url =
        storage::get_credential("supabase_url").ok_or("Supabase not configured: missing URL")?;
    let supabase_key = storage::get_credential("supabase_anon_key")
        .ok_or("Supabase not configured: missing anon key")?;

    let base = supabase_url.trim_end_matches('/');
    let mut url = Url::parse(&format!("{base}/rest/v1/{path}"))
        .map_err(|e| format!("Invalid Supabase URL: {e}"))?;
    {
        let mut qp = url.query_pairs_mut();
        for (k, v) in params {
            qp.append_pair(k, v);
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .get(url)
        .header("apikey", &supabase_key)
        .header("Authorization", format!("Bearer {supabase_key}"))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("Supabase request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Supabase error ({status}): {body}"));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Supabase JSON parse error: {e}"))
}

fn default_update_state() -> serde_json::Value {
    serde_json::json!({
        "checking": false,
        "available": false,
        "downloading": false,
        "ready": false,
        "error": serde_json::Value::Null,
        "progress": 0,
        "updateInfo": serde_json::Value::Null,
        "downloadedVersion": serde_json::Value::Null,
        "downloadedArtifactPath": serde_json::Value::Null,
        "installPending": false,
        "installingVersion": serde_json::Value::Null,
    })
}

pub(crate) fn normalize_update_state(state: &serde_json::Value) -> serde_json::Value {
    let mut normalized = default_update_state();

    if let (Some(source), Some(target)) = (state.as_object(), normalized.as_object_mut()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }

    let downloaded_version = normalized
        .get("downloadedVersion")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if normalized
        .get("updateInfo")
        .and_then(|value| value.get("version"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        if let Some(version) = downloaded_version {
            if let Some(target) = normalized.as_object_mut() {
                target.insert(
                    "updateInfo".to_string(),
                    serde_json::json!({
                        "version": version,
                    }),
                );
            }
        }
    }

    normalized
}

pub(crate) fn read_update_state(db: &db::DbState) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    if let Some(raw) = db::get_setting(&conn, "local", "updater_state") {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
            return Ok(normalize_update_state(&parsed));
        }
    }
    Ok(default_update_state())
}

pub(crate) fn write_update_state(
    db: &db::DbState,
    state: &serde_json::Value,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let normalized = normalize_update_state(state);
    db::set_setting(&conn, "local", "updater_state", &normalized.to_string())
}

pub(crate) fn update_info_from_release(update: &tauri_plugin_updater::Update) -> serde_json::Value {
    let release_date = update
        .date
        .as_ref()
        .and_then(|d| {
            Utc.timestamp_opt(d.unix_timestamp(), d.nanosecond())
                .single()
        })
        .map(|d| d.to_rfc3339());

    serde_json::json!({
        "version": update.version.clone(),
        "releaseDate": release_date,
        "releaseNotes": update.body.clone(),
        "releaseName": format!("v{}", update.version),
    })
}

pub(crate) fn stats_for_modules(modules: &[serde_json::Value]) -> serde_json::Value {
    let total_modules = modules.len() as i64;
    let core_modules_count = modules
        .iter()
        .filter(|m| m.get("is_core").and_then(|v| v.as_bool()).unwrap_or(false))
        .count() as i64;
    let purchased_modules_count = modules
        .iter()
        .filter(|m| {
            m.get("is_purchased")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        })
        .count() as i64;

    serde_json::json!({
        "total_modules": total_modules,
        "core_modules_count": core_modules_count,
        "purchased_modules_count": purchased_modules_count,
    })
}
