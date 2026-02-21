//! The Small POS - Tauri v2 Backend
//!
//! This module registers all IPC command handlers that the React frontend
//! calls via `@tauri-apps/api/core::invoke()`. Command names use snake_case
//! derived from the Electron IPC channel names (e.g. `auth:login` -> `auth_login`).

use chrono::{Datelike, Local, TimeZone, Utc};
use reqwest::Url;
use rusqlite::params;
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;
use tracing::{info, warn};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// App start time for uptime calculation (epoch seconds).
static APP_START_EPOCH: AtomicU64 = AtomicU64::new(0);
/// Last lazy menu warm-up attempt (unix ms) to throttle cache-miss-triggered syncs.
static MENU_WARMUP_LAST_ATTEMPT_MS: AtomicU64 = AtomicU64::new(0);

const MENU_WARMUP_THROTTLE_MS: u64 = 15_000;

mod api;
mod auth;
mod db;
mod diagnostics;
mod drawer;
mod menu;
mod payments;
mod print;
mod printers;
mod refunds;
mod shifts;
mod storage;
mod sync;
mod zreport;

const MODULE_CACHE_FILE: &str = "module-cache.json";
const MODULE_CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const UPDATER_MANIFEST_URL: &str =
    "https://github.com/EpsylonBita/The-Small-POS/releases/latest/download/latest.json";

#[derive(Default)]
struct UpdaterRuntimeState {
    pending_update: std::sync::Mutex<Option<tauri_plugin_updater::Update>>,
    downloaded_bytes: std::sync::Mutex<Option<Vec<u8>>>,
}

fn parse_channel_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> serde_json::Value {
    match (arg0, arg1) {
        (Some(serde_json::Value::Object(mut obj0)), Some(serde_json::Value::Object(obj1))) => {
            for (k, v) in obj1 {
                obj0.insert(k, v);
            }
            serde_json::Value::Object(obj0)
        }
        (Some(v), _) => v,
        (None, Some(v)) => v,
        _ => serde_json::json!({}),
    }
}

fn value_str(v: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = v.get(*key).and_then(|x| x.as_str()) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn value_f64(v: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(n) = v.get(*key).and_then(|x| x.as_f64()) {
            return Some(n);
        }
    }
    None
}

fn value_i64(v: &serde_json::Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(n) = v.get(*key).and_then(|x| x.as_i64()) {
            return Some(n);
        }
    }
    None
}

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

fn extract_org_id_from_terminal_settings_response(resp: &serde_json::Value) -> Option<String> {
    value_str(resp, &["organization_id"]).or_else(|| {
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

fn extract_branch_id_from_terminal_settings_response(resp: &serde_json::Value) -> Option<String> {
    value_str(resp, &["branch_id"]).or_else(|| {
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

fn credential_key_for_terminal_setting(setting_key: &str) -> Option<&'static str> {
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

fn read_local_setting(db: &db::DbState, category: &str, key: &str) -> Option<String> {
    let conn = db.conn.lock().ok()?;
    db::get_setting(&conn, category, key)
}

fn hydrate_terminal_credentials_from_local_settings(db: &db::DbState) {
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

fn is_terminal_auth_failure(error: &str) -> bool {
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

fn handle_invalid_terminal_credentials(
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

fn mask_terminal_id(terminal_id: &str) -> String {
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

async fn maybe_lazy_warm_menu_cache(db: &db::DbState, app: &tauri::AppHandle, source: &str) {
    let has_api_key = storage::get_credential("pos_api_key")
        .or_else(|| read_local_setting(db, "terminal", "pos_api_key"))
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !has_api_key {
        return;
    }

    let now_ms = Utc::now().timestamp_millis().max(0) as u64;
    let last_attempt = MENU_WARMUP_LAST_ATTEMPT_MS.load(Ordering::Relaxed);
    if now_ms.saturating_sub(last_attempt) < MENU_WARMUP_THROTTLE_MS {
        return;
    }
    if MENU_WARMUP_LAST_ATTEMPT_MS
        .compare_exchange(last_attempt, now_ms, Ordering::SeqCst, Ordering::Relaxed)
        .is_err()
    {
        return;
    }

    hydrate_terminal_credentials_from_local_settings(db);
    info!(
        source = %source,
        throttle_ms = MENU_WARMUP_THROTTLE_MS,
        "Menu cache empty, attempting lazy warm-up sync"
    );

    match menu::sync_menu(db).await {
        Ok(result) => {
            let version = result
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let updated = result
                .get("updated")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let counts = result
                .get("counts")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let _ = app.emit(
                "menu_sync",
                serde_json::json!({
                    "source": source,
                    "updated": updated,
                    "version": version,
                    "counts": counts,
                    "timestamp": Utc::now().to_rfc3339(),
                }),
            );
            info!(
                source = %source,
                updated = updated,
                version = %version,
                "Lazy menu warm-up sync completed"
            );
        }
        Err(error) => {
            if is_terminal_auth_failure(&error) {
                handle_invalid_terminal_credentials(Some(db), app, source, &error);
                return;
            }
            warn!(source = %source, error = %error, "Lazy menu warm-up sync failed");
        }
    }
}

fn payload_arg0_as_string(arg0: Option<serde_json::Value>, keys: &[&str]) -> Option<String> {
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
            value_str(&payload, keys)
        }
        _ => None,
    }
}

fn build_admin_query(path: &str, options: Option<&serde_json::Value>) -> String {
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

fn validate_admin_api_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Missing API path".into());
    }
    if path.contains("..") {
        return Err("Invalid API path".into());
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

fn normalize_status_for_storage(status: &str) -> String {
    match status.trim().to_lowercase().as_str() {
        "approved" => "confirmed".to_string(),
        "declined" | "rejected" => "cancelled".to_string(),
        "canceled" => "cancelled".to_string(),
        other => other.to_string(),
    }
}

fn module_cache_path(db: &db::DbState) -> PathBuf {
    db.db_path
        .parent()
        .map(|p| p.join(MODULE_CACHE_FILE))
        .unwrap_or_else(|| PathBuf::from(MODULE_CACHE_FILE))
}

fn read_module_cache(db: &db::DbState) -> Result<serde_json::Value, String> {
    let path = module_cache_path(db);
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read module cache: {e}"))?;
    serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| format!("parse module cache: {e}"))
}

fn write_module_cache(db: &db::DbState, payload: &serde_json::Value) -> Result<(), String> {
    let path = module_cache_path(db);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create cache dir: {e}"))?;
    }
    let text =
        serde_json::to_string_pretty(payload).map_err(|e| format!("serialize cache: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("write module cache: {e}"))
}

fn clear_operational_data_inner(db: &db::DbState) -> Result<serde_json::Value, String> {
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

async fn fetch_supabase_rows(
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

async fn admin_fetch(
    db: Option<&db::DbState>,
    path: &str,
    method: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    validate_admin_api_path(path)?;

    if let Some(db_state) = db {
        hydrate_terminal_credentials_from_local_settings(db_state);
    }

    let mut raw_api_key =
        storage::get_credential("pos_api_key").ok_or("Terminal not configured: missing API key")?;
    let api_key_source = raw_api_key.clone();
    if let Some(decoded_api_key) = api::extract_api_key_from_connection_string(&api_key_source) {
        if decoded_api_key != raw_api_key {
            let _ = storage::set_credential("pos_api_key", decoded_api_key.trim());
            if let Some(db_state) = db {
                if let Ok(conn) = db_state.conn.lock() {
                    let _ =
                        db::set_setting(&conn, "terminal", "pos_api_key", decoded_api_key.trim());
                }
            }
            raw_api_key = decoded_api_key;
        }

        if let Some(decoded_tid) = api::extract_terminal_id_from_connection_string(&api_key_source)
        {
            let _ = storage::set_credential("terminal_id", decoded_tid.trim());
            if let Some(db_state) = db {
                if let Ok(conn) = db_state.conn.lock() {
                    let _ = db::set_setting(&conn, "terminal", "terminal_id", decoded_tid.trim());
                }
            }
        }
    }

    let mut admin_url = storage::get_credential("admin_dashboard_url")
        .or_else(|| {
            db.and_then(|db_state| read_local_setting(db_state, "terminal", "admin_dashboard_url"))
        })
        .or_else(|| db.and_then(|db_state| read_local_setting(db_state, "terminal", "admin_url")))
        .unwrap_or_default();

    if admin_url.trim().is_empty() {
        if let Some(decoded_url) = api::extract_admin_url_from_connection_string(&api_key_source) {
            admin_url = decoded_url;
        }
    }

    let normalized_admin_url = api::normalize_admin_url(&admin_url);
    if normalized_admin_url.trim().is_empty() {
        return Err("Terminal not configured: missing admin URL".to_string());
    }

    if storage::get_credential("admin_dashboard_url")
        .map(|v| v.trim().to_string())
        .as_deref()
        != Some(normalized_admin_url.trim())
    {
        let _ = storage::set_credential("admin_dashboard_url", normalized_admin_url.trim());
        if let Some(db_state) = db {
            if let Ok(conn) = db_state.conn.lock() {
                let _ = db::set_setting(
                    &conn,
                    "terminal",
                    "admin_dashboard_url",
                    normalized_admin_url.trim(),
                );
            }
        }
    }

    let api_key = raw_api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("Terminal not configured: missing API key".to_string());
    }

    api::fetch_from_admin(&normalized_admin_url, &api_key, path, method, body).await
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
    })
}

fn read_update_state(db: &db::DbState) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    if let Some(raw) = db::get_setting(&conn, "local", "updater_state") {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
            return Ok(parsed);
        }
    }
    Ok(default_update_state())
}

fn write_update_state(db: &db::DbState, state: &serde_json::Value) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "local", "updater_state", &state.to_string())
}

async fn updater_manifest_is_reachable() -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("updater manifest client: {e}"))?;

    let response = match client.head(UPDATER_MANIFEST_URL).send().await {
        Ok(resp) => resp,
        Err(_) => client
            .get(UPDATER_MANIFEST_URL)
            .send()
            .await
            .map_err(|e| format!("updater manifest request: {e}"))?,
    };

    Ok(response.status().is_success())
}

fn update_info_from_release(update: &tauri_plugin_updater::Update) -> serde_json::Value {
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

fn stats_for_modules(modules: &[serde_json::Value]) -> serde_json::Value {
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

fn ensure_staff_payments_table(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS staff_payments (
            id TEXT PRIMARY KEY,
            cashier_shift_id TEXT NOT NULL,
            paid_to_staff_id TEXT NOT NULL,
            amount REAL NOT NULL,
            payment_type TEXT NOT NULL,
            notes TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_staff_payments_cashier_shift_id
            ON staff_payments(cashier_shift_id);
        CREATE INDEX IF NOT EXISTS idx_staff_payments_paid_to_staff_id
            ON staff_payments(paid_to_staff_id);
        CREATE INDEX IF NOT EXISTS idx_staff_payments_created_at
            ON staff_payments(created_at);
        ",
    )
    .map_err(|e| format!("ensure staff_payments table: {e}"))
}

fn map_scheduled_shift_row(row: &serde_json::Value) -> serde_json::Value {
    let staff_node = row.get("staff");
    let staff_obj = match staff_node {
        Some(serde_json::Value::Object(obj)) => Some(serde_json::Value::Object(obj.clone())),
        Some(serde_json::Value::Array(arr)) => arr
            .first()
            .and_then(|v| v.as_object().cloned())
            .map(serde_json::Value::Object),
        _ => None,
    };
    let staff_first = staff_obj
        .as_ref()
        .and_then(|s| s.get("first_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let staff_last = staff_obj
        .as_ref()
        .and_then(|s| s.get("last_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let staff_name = format!("{} {}", staff_first, staff_last).trim().to_string();

    serde_json::json!({
        "id": row.get("id").cloned().unwrap_or(serde_json::Value::Null),
        "staffId": row.get("staff_id").cloned().unwrap_or(serde_json::Value::Null),
        "branchId": row.get("branch_id").cloned().unwrap_or(serde_json::Value::Null),
        "startTime": row.get("start_time").cloned().unwrap_or(serde_json::Value::Null),
        "endTime": row.get("end_time").cloned().unwrap_or(serde_json::Value::Null),
        "breakStart": row.get("break_start").cloned().unwrap_or(serde_json::Value::Null),
        "breakEnd": row.get("break_end").cloned().unwrap_or(serde_json::Value::Null),
        "status": row.get("status").cloned().unwrap_or(serde_json::Value::Null),
        "notes": row.get("notes").cloned().unwrap_or(serde_json::Value::Null),
        "staffName": if staff_name.is_empty() { "Unknown".to_string() } else { staff_name },
        "staffCode": staff_obj
            .as_ref()
            .and_then(|s| s.get("staff_code"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
    })
}

fn read_ecr_devices(db: &db::DbState) -> Result<Vec<serde_json::Value>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let raw = db::get_setting(&conn, "local", "ecr_devices");
    if let Some(value) = raw {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&value) {
            if let Some(arr) = parsed.as_array() {
                return Ok(arr.clone());
            }
        }
    }
    Ok(Vec::new())
}

fn write_ecr_devices(db: &db::DbState, devices: &[serde_json::Value]) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(
        &conn,
        "local",
        "ecr_devices",
        &serde_json::Value::Array(devices.to_vec()).to_string(),
    )
}

fn read_local_json(db: &db::DbState, key: &str) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let raw = db::get_setting(&conn, "local", key);
    if let Some(raw) = raw {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
            return Ok(parsed);
        }
    }
    Ok(serde_json::Value::Null)
}

fn read_local_json_array(db: &db::DbState, key: &str) -> Result<Vec<serde_json::Value>, String> {
    let parsed = read_local_json(db, key)?;
    Ok(parsed.as_array().cloned().unwrap_or_default())
}

fn write_local_json(db: &db::DbState, key: &str, value: &serde_json::Value) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "local", key, &value.to_string())
}

fn normalize_phone(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
}

fn resolve_order_id(conn: &rusqlite::Connection, order_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
        rusqlite::params![order_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

#[allow(clippy::type_complexity)]
fn load_orders_for_period(
    conn: &rusqlite::Connection,
    branch_id: &str,
    date_from: &str,
    date_to: &str,
) -> Result<
    Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    )>,
    String,
> {
    let mut stmt = conn
        .prepare(
            "SELECT id, status, created_at, items, staff_id, payment_method
             FROM orders
             WHERE (?1 = '' OR branch_id = ?1)
               AND substr(created_at, 1, 10) >= ?2
               AND substr(created_at, 1, 10) <= ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![branch_id, date_from, date_to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn parse_item_totals(items_json: &str) -> (f64, std::collections::HashMap<String, f64>) {
    let mut total = 0.0;
    let mut by_name: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    let parsed =
        serde_json::from_str::<serde_json::Value>(items_json).unwrap_or(serde_json::json!([]));
    if let Some(items) = parsed.as_array() {
        for item in items {
            let qty = value_f64(item, &["quantity"]).unwrap_or(1.0).max(0.0);
            let line_total = value_f64(item, &["total_price", "totalPrice"]).unwrap_or_else(|| {
                value_f64(item, &["unit_price", "unitPrice", "price"]).unwrap_or(0.0) * qty
            });
            total += line_total;
            let name = value_str(item, &["name", "item_name", "title"])
                .unwrap_or_else(|| "Item".to_string());
            *by_name.entry(name).or_insert(0.0) += qty.max(1.0);
        }
    }
    (total, by_name)
}

// ============================================================================
// IPC command handlers
//
// Real implementations delegate to their respective modules (storage, api,
// auth, db, menu, sync). Commands still marked "(stubs)" will be replaced
// as additional subsystems are built out.
// ============================================================================

// -- App lifecycle -----------------------------------------------------------

#[tauri::command]
async fn app_shutdown(app: tauri::AppHandle) -> Result<(), String> {
    info!("app:shutdown requested");
    let _ = app.emit(
        "control_command_received",
        serde_json::json!({ "command": "shutdown" }),
    );
    let _ = app.emit(
        "app_shutdown_initiated",
        serde_json::json!({ "source": "ipc" }),
    );
    let _ = app.emit("app_close", serde_json::json!({ "reason": "shutdown" }));
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn app_restart(app: tauri::AppHandle) -> Result<(), String> {
    info!("app:restart requested");
    let _ = app.emit(
        "control_command_received",
        serde_json::json!({ "command": "restart" }),
    );
    let _ = app.emit(
        "app_restart_initiated",
        serde_json::json!({ "source": "ipc" }),
    );
    app.restart();
}

#[tauri::command]
async fn app_get_version() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }))
}

#[tauri::command]
async fn app_get_shutdown_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "shuttingDown": false }))
}

#[tauri::command]
async fn system_get_info(db: tauri::State<'_, db::DbState>) -> Result<serde_json::Value, String> {
    let db_size = std::fs::metadata(&db.db_path).map(|m| m.len()).unwrap_or(0);
    let is_configured = storage::is_configured();
    let start = APP_START_EPOCH.load(Ordering::Relaxed);
    let uptime = if start > 0 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        now.saturating_sub(start)
    } else {
        0
    };

    Ok(serde_json::json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
        "db_path": db.db_path.to_string_lossy(),
        "db_size_bytes": db_size,
        "is_configured": is_configured,
        "uptime_seconds": uptime,
    }))
}

// -- Auth --------------------------------------------------------------------

#[tauri::command]
async fn auth_login(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<serde_json::Value, String> {
    auth::login(arg0, &db, &auth_state)
}

#[tauri::command]
async fn auth_logout(
    auth_state: tauri::State<'_, auth::AuthState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    auth::logout(&auth_state);
    let _ = app.emit("session_timeout", serde_json::json!({ "reason": "logout" }));
    Ok(())
}

#[tauri::command]
async fn auth_get_current_session(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<serde_json::Value, String> {
    Ok(auth::get_session_json(&auth_state))
}

#[tauri::command]
async fn auth_validate_session(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<serde_json::Value, String> {
    Ok(auth::validate_session(&auth_state))
}

#[tauri::command]
async fn auth_has_permission(
    arg0: Option<String>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<bool, String> {
    Ok(auth::has_permission(&auth_state, arg0.as_deref()))
}

#[tauri::command]
async fn auth_get_session_stats(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<serde_json::Value, String> {
    Ok(auth::get_session_stats(&auth_state))
}

#[tauri::command]
async fn auth_setup_pin(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<serde_json::Value, String> {
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

// -- Staff auth --------------------------------------------------------------

#[tauri::command]
async fn staff_auth_authenticate_pin(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<serde_json::Value, String> {
    // staff_auth:authenticate-pin uses the same login logic
    auth::login(arg0, &db, &auth_state)
}

#[tauri::command]
async fn staff_auth_get_session(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<serde_json::Value, String> {
    Ok(auth::get_session_json(&auth_state))
}

#[tauri::command]
async fn staff_auth_get_current(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<serde_json::Value, String> {
    Ok(auth::get_current_user(&auth_state))
}

#[tauri::command]
async fn staff_auth_has_permission(
    arg0: Option<String>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<bool, String> {
    Ok(auth::has_permission(&auth_state, arg0.as_deref()))
}

#[tauri::command]
async fn staff_auth_has_any_permission(
    arg0: Option<Vec<String>>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<bool, String> {
    Ok(auth::has_any_permission(&auth_state, arg0.as_deref()))
}

#[tauri::command]
async fn staff_auth_logout(auth_state: tauri::State<'_, auth::AuthState>) -> Result<(), String> {
    auth::logout(&auth_state);
    Ok(())
}

#[tauri::command]
async fn staff_auth_validate_session(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<serde_json::Value, String> {
    Ok(auth::validate_session(&auth_state))
}

#[tauri::command]
async fn staff_auth_track_activity(
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<(), String> {
    auth::track_activity(&auth_state);
    Ok(())
}

// -- Settings ----------------------------------------------------------------

#[tauri::command]
async fn settings_is_configured(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);
    let configured = storage::is_configured()
        || (read_local_setting(&db, "terminal", "admin_dashboard_url").is_some()
            && read_local_setting(&db, "terminal", "terminal_id").is_some()
            && read_local_setting(&db, "terminal", "pos_api_key").is_some());
    let reason = if configured {
        "all_credentials_present"
    } else {
        "missing_credentials"
    };
    Ok(serde_json::json!({ "configured": configured, "reason": reason }))
}

#[tauri::command]
async fn settings_get(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_channel_payload(arg0.clone(), arg1.clone());
    let mut category = value_str(&payload, &["category", "settingType"]);
    let mut key = value_str(&payload, &["key", "settingKey"]);
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
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if let Some(v) = db::get_setting(&conn, &cat, &k) {
            return Ok(serde_json::Value::String(v));
        }
        drop(conn);

        if cat == "terminal" {
            if let Some(credential_key) = credential_key_for_terminal_setting(&k) {
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
async fn settings_get_local(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    if arg0.is_none() {
        return get_settings(db).await;
    }

    if let Some(serde_json::Value::String(key)) = arg0 {
        if let Some((category, setting_key)) = key.split_once('.') {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            if let Some(v) = db::get_setting(&conn, category, setting_key) {
                return Ok(serde_json::Value::String(v));
            }
            drop(conn);

            if category == "terminal" {
                if let Some(credential_key) = credential_key_for_terminal_setting(setting_key) {
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
async fn settings_factory_reset(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let _ = clear_operational_data_inner(&db);
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
async fn settings_update_terminal_credentials(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing credentials payload")?;
    let result = storage::update_terminal_credentials(&payload)?;

    // Mirror credentials into local_settings for Electron compatibility paths.
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if let Some(v) = storage::get_credential("terminal_id")
            .or_else(|| value_str(&payload, &["terminalId", "terminal_id"]))
        {
            db::set_setting(&conn, "terminal", "terminal_id", &v)?;
        }
        if let Some(v) = storage::get_credential("pos_api_key")
            .or_else(|| value_str(&payload, &["apiKey", "pos_api_key"]))
        {
            db::set_setting(&conn, "terminal", "pos_api_key", &v)?;
        }
        if let Some(v) = storage::get_credential("admin_dashboard_url").or_else(|| {
            value_str(
                &payload,
                &["adminDashboardUrl", "adminUrl", "admin_dashboard_url"],
            )
        }) {
            db::set_setting(&conn, "terminal", "admin_dashboard_url", &v)?;
        }
        if let Some(v) = storage::get_credential("branch_id")
            .or_else(|| value_str(&payload, &["branchId", "branch_id"]))
        {
            db::set_setting(&conn, "terminal", "branch_id", &v)?;
        }
        if let Some(v) = storage::get_credential("organization_id")
            .or_else(|| value_str(&payload, &["organizationId", "organization_id"]))
        {
            db::set_setting(&conn, "terminal", "organization_id", &v)?;
        }
        if let Some(v) = storage::get_credential("supabase_url")
            .or_else(|| value_str(&payload, &["supabaseUrl", "supabase_url"]))
        {
            db::set_setting(&conn, "terminal", "supabase_url", &v)?;
        }
        if let Some(v) = storage::get_credential("supabase_anon_key")
            .or_else(|| value_str(&payload, &["supabaseAnonKey", "supabase_anon_key"]))
        {
            db::set_setting(&conn, "terminal", "supabase_anon_key", &v)?;
        }
    }

    // After saving credentials, try to fetch terminal config from admin API
    // to populate branch_id and organization_id (not in the connection code).
    if let (Some(admin_url), Some(api_key), Some(terminal_id)) = (
        storage::get_credential("admin_dashboard_url"),
        storage::get_credential("pos_api_key"),
        storage::get_credential("terminal_id"),
    ) {
        let path = format!("/api/pos/settings/{terminal_id}");
        match api::fetch_from_admin(&admin_url, &api_key, &path, "GET", None).await {
            Ok(resp) => {
                if let Some(bid) = extract_branch_id_from_terminal_settings_response(&resp) {
                    let _ = storage::set_credential("branch_id", &bid);
                    if let Ok(conn) = db.conn.lock() {
                        let _ = db::set_setting(&conn, "terminal", "branch_id", &bid);
                    }
                    tracing::info!(branch_id = %bid, "Stored branch_id from admin settings");
                }
                // Also try to get organization_id from terminal lookup
                if let Some(oid) = extract_org_id_from_terminal_settings_response(&resp) {
                    let _ = storage::set_credential("organization_id", &oid);
                    if let Ok(conn) = db.conn.lock() {
                        let _ = db::set_setting(&conn, "terminal", "organization_id", &oid);
                    }
                    tracing::info!("Stored organization_id from admin settings");
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
                        if !key.is_empty() && storage::get_credential("supabase_anon_key").is_none()
                        {
                            let _ = storage::set_credential("supabase_anon_key", key);
                            if let Ok(conn) = db.conn.lock() {
                                let _ =
                                    db::set_setting(&conn, "terminal", "supabase_anon_key", key);
                            }
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "Failed to fetch terminal config from admin (non-fatal)");
            }
        }
    }

    let _ = app.emit(
        "terminal_credentials_updated",
        serde_json::json!({ "success": true }),
    );
    let _ = app.emit("terminal_enabled", serde_json::json!({ "success": true }));

    Ok(result)
}

#[tauri::command]
async fn settings_get_admin_url(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    Ok(
        match storage::get_credential("admin_dashboard_url")
            .or_else(|| read_local_setting(&db, "terminal", "admin_dashboard_url"))
            .or_else(|| read_local_setting(&db, "terminal", "admin_url"))
        {
            Some(url) => serde_json::Value::String(url),
            None => serde_json::Value::Null,
        },
    )
}

/// Returns all settings merged: local_settings DB + terminal credential store.
/// The StaffShiftModal uses this to look up `terminal.branch_id`.
#[tauri::command]
async fn get_settings(db: tauri::State<'_, db::DbState>) -> Result<serde_json::Value, String> {
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
        if let Some(api) = storage::get_credential("pos_api_key") {
            t.entry("pos_api_key")
                .or_insert(serde_json::Value::String(api));
        }
        if let Some(admin) = storage::get_credential("admin_dashboard_url") {
            t.entry("admin_dashboard_url")
                .or_insert(serde_json::Value::String(admin));
        }
        if let Some(bt) = storage::get_credential("business_type") {
            t.entry("business_type")
                .or_insert(serde_json::Value::String(bt));
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
    if let Some(api) = storage::get_credential("pos_api_key") {
        map.insert(
            "terminal.pos_api_key".into(),
            serde_json::Value::String(api),
        );
    }
    if let Some(admin) = storage::get_credential("admin_dashboard_url") {
        map.insert(
            "terminal.admin_dashboard_url".into(),
            serde_json::Value::String(admin),
        );
    }

    Ok(all)
}

#[tauri::command]
async fn settings_clear_connection(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    storage::delete_credential("admin_dashboard_url")?;
    storage::delete_credential("pos_api_key")?;
    let _ = app.emit(
        "terminal_disabled",
        serde_json::json!({ "reason": "connection_cleared" }),
    );
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn settings_set(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let mut category = "general".to_string();
    let mut key: Option<String> = None;
    let mut value_node = arg1.unwrap_or(serde_json::Value::Null);

    if let Some(serde_json::Value::Object(obj)) = arg0.as_ref() {
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
                .unwrap_or(serde_json::Value::Null);
        }
    }

    if key.is_none() {
        if let Some(serde_json::Value::String(raw)) = arg0.as_ref() {
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
    let mut value = match value_node {
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
    db::set_setting(&conn, &category, &key, &value)?;
    for (ekey, evalue) in &extra_terminal_updates {
        db::set_setting(&conn, "terminal", ekey, evalue)?;
    }
    drop(conn);

    if category == "terminal" {
        if let Some(credential_key) = credential_key_for_terminal_setting(&key) {
            if value.trim().is_empty() {
                let _ = storage::delete_credential(credential_key);
            } else {
                let _ = storage::set_credential(credential_key, value.trim());
            }
        }
        for (ekey, evalue) in &extra_terminal_updates {
            if let Some(credential_key) = credential_key_for_terminal_setting(ekey.as_str()) {
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
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn settings_update_local(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let mut updates: Vec<(String, String, String)> = Vec::new();

    if let Some(serde_json::Value::Object(obj)) = arg0.as_ref() {
        if let Some(setting_type) = obj.get("settingType").and_then(|v| v.as_str()) {
            if let Some(settings_obj) = obj.get("settings").and_then(|v| v.as_object()) {
                for (k, v) in settings_obj {
                    let value = match v {
                        serde_json::Value::String(s) => s.clone(),
                        serde_json::Value::Null => String::new(),
                        other => other.to_string(),
                    };
                    updates.push((setting_type.to_string(), k.clone(), value));
                }
            }
        }
    }

    if updates.is_empty() {
        match (arg0.as_ref(), arg1.as_ref()) {
            // Bridge form: settings:update-local('terminal', { branch_id: '...' })
            (
                Some(serde_json::Value::String(category)),
                Some(serde_json::Value::Object(settings_obj)),
            ) => {
                for (k, v) in settings_obj {
                    let value = match v {
                        serde_json::Value::String(s) => s.clone(),
                        serde_json::Value::Null => String::new(),
                        other => other.to_string(),
                    };
                    updates.push((category.clone(), k.clone(), value));
                }
            }
            // Legacy/flat form: settings:update-local('terminal.branch_id', '...')
            (Some(serde_json::Value::String(full_key)), Some(v)) => {
                let value = match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Null => String::new(),
                    other => other.to_string(),
                };
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
        db::set_setting(&conn, category, key, value)?;
        if category == "terminal" {
            if let Some(credential_key) = credential_key_for_terminal_setting(key) {
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
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn settings_get_discount_max(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let val = db::get_setting(&conn, "general", "discount_max");
    Ok(match val {
        Some(v) => serde_json::json!(v.parse::<f64>().unwrap_or(100.0)),
        None => serde_json::json!(100.0),
    })
}

#[tauri::command]
async fn settings_set_discount_max(
    arg0: Option<f64>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let pct = arg0.unwrap_or(100.0);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "discount_max", &pct.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn settings_get_tax_rate(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let val = db::get_setting(&conn, "general", "tax_rate");
    Ok(match val {
        Some(v) => serde_json::json!(v.parse::<f64>().unwrap_or(0.0)),
        None => serde_json::json!(0.0),
    })
}

#[tauri::command]
async fn settings_set_tax_rate(
    arg0: Option<f64>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let pct = arg0.unwrap_or(0.0);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "tax_rate", &pct.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn settings_get_language(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let val = db::get_setting(&conn, "general", "language");
    Ok(serde_json::Value::String(
        val.unwrap_or_else(|| "en".into()),
    ))
}

#[tauri::command]
async fn settings_set_language(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let lang = arg0.unwrap_or_else(|| "en".into());
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "language", &lang)?;
    Ok(serde_json::json!({ "success": true }))
}

// -- Terminal config ---------------------------------------------------------

#[tauri::command]
async fn terminal_config_get_settings() -> Result<serde_json::Value, String> {
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

    Ok(serde_json::json!({
        // Nested form: settings.terminal?.terminal_id
        "terminal": {
            "terminal_id": tid,
            "pos_api_key": api,
            "organization_id": org,
            "branch_id": bid,
        },
        // Dot-notation form: settings['terminal.terminal_id']
        "terminal.terminal_id": tid,
        "terminal.pos_api_key": api,
        "terminal.organization_id": org,
        "terminal.branch_id": bid,
    }))
}

#[tauri::command]
async fn terminal_config_get_setting(
    arg0: Option<String>,
    arg1: Option<String>,
) -> Result<serde_json::Value, String> {
    Ok(storage::get_setting(arg0.as_deref(), arg1.as_deref()))
}

#[tauri::command]
async fn terminal_config_get_branch_id(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    storage::get_credential("branch_id")
        .or_else(|| read_local_setting(&db, "terminal", "branch_id"))
        .ok_or_else(|| "Terminal not configured".into())
}

#[tauri::command]
async fn terminal_config_get_terminal_id(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    storage::get_credential("terminal_id")
        .or_else(|| read_local_setting(&db, "terminal", "terminal_id"))
        .ok_or_else(|| "Terminal not configured".into())
}

#[tauri::command]
async fn terminal_config_get_organization_id(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    storage::get_credential("organization_id")
        .or_else(|| read_local_setting(&db, "terminal", "organization_id"))
        .ok_or_else(|| "Terminal not configured".into())
}

#[tauri::command]
async fn terminal_config_get_business_type(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    Ok(storage::get_credential("business_type")
        .or_else(|| read_local_setting(&db, "terminal", "business_type"))
        .or_else(|| read_local_setting(&db, "general", "business_type"))
        .unwrap_or_else(|| "food".into()))
}

#[tauri::command]
async fn terminal_config_get_full_config() -> Result<serde_json::Value, String> {
    Ok(storage::get_full_config())
}

#[tauri::command]
async fn terminal_config_refresh(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);
    let result = match menu::sync_menu(&db).await {
        Ok(value) => value,
        Err(error) => {
            if is_terminal_auth_failure(&error) {
                handle_invalid_terminal_credentials(
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

// -- Orders ------------------------------------------------------------------

#[tauri::command]
async fn order_get_all(
    db: tauri::State<'_, db::DbState>,
) -> Result<Vec<serde_json::Value>, String> {
    sync::get_all_orders(&db)
}

#[tauri::command]
async fn order_get_by_id(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let id = payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .or(arg1)
    .ok_or("Missing order ID")?;
    let resolved_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let by_local: Option<String> = conn
            .query_row(
                "SELECT id FROM orders WHERE id = ?1 LIMIT 1",
                rusqlite::params![id.clone()],
                |row| row.get(0),
            )
            .ok();
        if let Some(v) = by_local {
            v
        } else {
            conn.query_row(
                "SELECT id FROM orders WHERE supabase_id = ?1 LIMIT 1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .map_err(|_| "Order not found")?
        }
    };
    sync::get_order_by_id(&db, &resolved_id)
}

#[tauri::command]
async fn order_get_by_customer_phone(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let customer_phone =
        payload_arg0_as_string(arg0, &["customerPhone", "customer_phone", "phone"])
            .or(arg1)
            .ok_or("Missing customer phone")?;
    let normalized = customer_phone
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '(' | ')'))
        .collect::<String>();
    let all_orders = sync::get_all_orders(&db)?;
    let filtered: Vec<serde_json::Value> = all_orders
        .into_iter()
        .filter(|o| {
            let phone = o
                .get("customerPhone")
                .and_then(|v| v.as_str())
                .or_else(|| o.get("customer_phone").and_then(|v| v.as_str()))
                .unwrap_or("")
                .chars()
                .filter(|c| !matches!(c, ' ' | '-' | '(' | ')'))
                .collect::<String>();
            !phone.is_empty() && (phone.contains(&normalized) || normalized.contains(&phone))
        })
        .collect();

    Ok(serde_json::json!({
        "success": true,
        "orders": filtered
    }))
}

#[tauri::command]
async fn order_update_status(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let (order_id_raw, status_raw, estimated_time) = match arg0 {
        Some(serde_json::Value::Object(obj)) => {
            let payload = serde_json::Value::Object(obj);
            (
                value_str(
                    &payload,
                    &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
                ),
                value_str(&payload, &["status"]).or(arg1),
                value_i64(&payload, &["estimatedTime", "estimated_time"]),
            )
        }
        Some(serde_json::Value::String(id)) => (Some(id), arg1, None),
        _ => (None, arg1, None),
    };

    let order_id_raw = order_id_raw.ok_or("Missing orderId")?;
    let status = normalize_status_for_storage(&status_raw.ok_or("Missing status")?);
    let now = Utc::now().to_rfc3339();

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id_raw],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "Order not found")?
    };

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE orders
             SET status = ?1, sync_status = 'pending', updated_at = ?2
             WHERE id = ?3",
            rusqlite::params![status, now, actual_order_id],
        )
        .map_err(|e| format!("update order status: {e}"))?;
        if let Some(eta) = estimated_time {
            let _ = conn.execute(
                "UPDATE orders SET estimated_time = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![eta, now, actual_order_id],
            );
        }
        let sync_payload = serde_json::json!({
            "orderId": actual_order_id,
            "status": status,
            "estimatedTime": estimated_time
        });
        let idem = format!(
            "order:update-status:{}:{}",
            actual_order_id,
            Utc::now().timestamp_millis()
        );
        let _ = conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('order', ?1, 'update', ?2, ?3)",
            rusqlite::params![actual_order_id, sync_payload.to_string(), idem],
        );
    }

    let event_payload = serde_json::json!({
        "orderId": actual_order_id,
        "status": status,
        "estimatedTime": estimated_time
    });
    let _ = app.emit("order_status_updated", event_payload.clone());
    let _ = app.emit("order_realtime_update", event_payload);

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id
    }))
}

#[tauri::command]
async fn order_update_items(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = match (arg0, arg1) {
        // Common invoke shape from typed bridge: (orderId, items[])
        (Some(serde_json::Value::String(order_id)), Some(serde_json::Value::Array(items))) => {
            serde_json::json!({
                "orderId": order_id,
                "items": items
            })
        }
        // Alternate invoke shape: (orderId, { items, orderNotes? })
        (Some(serde_json::Value::String(order_id)), Some(serde_json::Value::Object(mut extra))) => {
            extra.insert("orderId".to_string(), serde_json::Value::String(order_id));
            serde_json::Value::Object(extra)
        }
        // If arg0 is object and arg1 is array, treat arg1 as items override
        (Some(serde_json::Value::Object(mut base)), Some(serde_json::Value::Array(items))) => {
            base.insert("items".to_string(), serde_json::Value::Array(items));
            serde_json::Value::Object(base)
        }
        // Generic object/object merge
        (Some(serde_json::Value::Object(mut base)), Some(serde_json::Value::Object(extra))) => {
            for (k, v) in extra {
                base.insert(k, v);
            }
            serde_json::Value::Object(base)
        }
        (Some(v), None) => v,
        (None, Some(v)) => v,
        _ => serde_json::json!({}),
    };
    let order_id_raw = value_str(
        &payload,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .ok_or("Missing orderId")?;
    let items = payload
        .get("items")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    if !items.is_array() {
        return Err("items must be an array".into());
    }
    let notes = value_str(
        &payload,
        &["orderNotes", "order_notes", "notes", "special_instructions"],
    );
    let total = items
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|item| {
                    let qty = value_f64(item, &["quantity"]).unwrap_or(1.0);
                    if let Some(tp) = value_f64(item, &["total_price", "totalPrice"]) {
                        tp
                    } else {
                        value_f64(item, &["unit_price", "unitPrice", "price"]).unwrap_or(0.0) * qty
                    }
                })
                .sum::<f64>()
        })
        .unwrap_or(0.0);
    let now = Utc::now().to_rfc3339();

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id_raw],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "Order not found")?
    };

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let items_json =
            serde_json::to_string(&items).map_err(|e| format!("serialize items: {e}"))?;
        if let Some(order_notes) = notes.clone() {
            conn.execute(
                "UPDATE orders
                 SET items = ?1, total_amount = ?2, special_instructions = ?3, sync_status = 'pending', updated_at = ?4
                 WHERE id = ?5",
                rusqlite::params![items_json, total, order_notes, now, actual_order_id],
            )
            .map_err(|e| format!("update order items: {e}"))?;
        } else {
            conn.execute(
                "UPDATE orders
                 SET items = ?1, total_amount = ?2, sync_status = 'pending', updated_at = ?3
                 WHERE id = ?4",
                rusqlite::params![items_json, total, now, actual_order_id],
            )
            .map_err(|e| format!("update order items: {e}"))?;
        }
        let sync_payload = serde_json::json!({
            "orderId": actual_order_id,
            "items": items,
            "orderNotes": notes
        });
        let idem = format!(
            "order:update-items:{}:{}",
            actual_order_id,
            Utc::now().timestamp_millis()
        );
        let _ = conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('order', ?1, 'update', ?2, ?3)",
            rusqlite::params![actual_order_id, sync_payload.to_string(), idem],
        );
    }

    if let Ok(order_json) = sync::get_order_by_id(&db, &actual_order_id) {
        let _ = app.emit("order_realtime_update", order_json);
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id
    }))
}

#[tauri::command]
async fn order_delete(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .or(arg1)
    .ok_or("Missing orderId")?;

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id_raw],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };

    if let Some(actual_id) = actual_order_id.clone() {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM orders WHERE id = ?1",
            rusqlite::params![actual_id.clone()],
        )
        .map_err(|e| format!("delete order: {e}"))?;
        // Electron parity: order delete remains local-only.
        // Also purge stale queued order delete operations so they cannot poison
        // /api/pos/orders/sync (which only accepts insert/update).
        let _ = conn.execute(
            "DELETE FROM sync_queue
             WHERE entity_type = 'order'
               AND operation = 'delete'
               AND (entity_id = ?1 OR status IN ('pending', 'in_progress', 'failed', 'deferred'))",
            rusqlite::params![actual_id],
        );
        let _ = app.emit("order_deleted", serde_json::json!({ "orderId": actual_id }));
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id
    }))
}

#[tauri::command]
async fn order_save_from_remote(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    let order_data = payload.get("orderData").cloned().unwrap_or(payload);
    let remote_id = value_str(&order_data, &["id", "supabase_id", "supabaseId"])
        .ok_or("Missing remote order id")?;

    let existing_local_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE supabase_id = ?1 OR id = ?1 LIMIT 1",
            rusqlite::params![remote_id.clone()],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };
    if let Some(local_id) = existing_local_id {
        return Ok(serde_json::json!({
            "success": true,
            "orderId": local_id,
            "alreadyExists": true
        }));
    }

    let local_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let items = order_data
        .get("items")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let items_json = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());

    let order_number = value_str(&order_data, &["order_number", "orderNumber"]);
    let customer_name = value_str(&order_data, &["customer_name", "customerName"]);
    let customer_phone = value_str(&order_data, &["customer_phone", "customerPhone"]);
    let customer_email = value_str(&order_data, &["customer_email", "customerEmail"]);
    let total_amount = value_f64(&order_data, &["total_amount", "totalAmount"]).unwrap_or(0.0);
    let tax_amount = value_f64(&order_data, &["tax_amount", "taxAmount"]).unwrap_or(0.0);
    let subtotal = value_f64(&order_data, &["subtotal"]).unwrap_or(0.0);
    let status = normalize_status_for_storage(
        &value_str(&order_data, &["status"]).unwrap_or_else(|| "pending".to_string()),
    );
    let order_type =
        value_str(&order_data, &["order_type", "orderType"]).unwrap_or_else(|| "pickup".into());
    let table_number = value_str(&order_data, &["table_number", "tableNumber"]);
    let delivery_address = value_str(
        &order_data,
        &["delivery_address", "deliveryAddress", "address"],
    );
    let delivery_notes = value_str(&order_data, &["delivery_notes", "deliveryNotes"]);
    let name_on_ringer = value_str(&order_data, &["name_on_ringer", "nameOnRinger"]);
    let special_instructions = value_str(&order_data, &["special_instructions", "notes"]);
    let estimated_time = value_i64(&order_data, &["estimated_time", "estimatedTime"]);
    let payment_status = value_str(&order_data, &["payment_status", "paymentStatus"])
        .unwrap_or_else(|| "pending".into());
    let payment_method = value_str(&order_data, &["payment_method", "paymentMethod"]);
    let payment_tx_id = value_str(
        &order_data,
        &["payment_transaction_id", "paymentTransactionId"],
    );
    let staff_shift_id = value_str(&order_data, &["staff_shift_id", "staffShiftId"]);
    let staff_id = value_str(&order_data, &["staff_id", "staffId"]);
    let discount_pct =
        value_f64(&order_data, &["discount_percentage", "discountPercentage"]).unwrap_or(0.0);
    let discount_amount =
        value_f64(&order_data, &["discount_amount", "discountAmount"]).unwrap_or(0.0);
    let tip_amount = value_f64(&order_data, &["tip_amount", "tipAmount"]).unwrap_or(0.0);
    let tax_rate = value_f64(&order_data, &["tax_rate", "taxRate"]);
    let delivery_fee = value_f64(&order_data, &["delivery_fee", "deliveryFee"]).unwrap_or(0.0);
    let branch_id = value_str(&order_data, &["branch_id", "branchId"])
        .or_else(|| storage::get_credential("branch_id"));
    let terminal_id = value_str(&order_data, &["terminal_id", "terminalId"])
        .or_else(|| storage::get_credential("terminal_id"));
    let plugin = value_str(
        &order_data,
        &["plugin", "platform", "order_plugin", "orderPlatform"],
    );
    let external_plugin_order_id = value_str(
        &order_data,
        &[
            "external_plugin_order_id",
            "externalPluginOrderId",
            "external_platform_order_id",
            "externalPlatformOrderId",
        ],
    );
    let created_at = value_str(&order_data, &["created_at", "createdAt"]).unwrap_or(now.clone());
    let updated_at = value_str(&order_data, &["updated_at", "updatedAt"]).unwrap_or(now.clone());

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO orders (
                id, order_number, customer_name, customer_phone, customer_email,
                items, total_amount, tax_amount, subtotal, status,
                order_type, table_number, delivery_address, delivery_notes,
                name_on_ringer, special_instructions, created_at, updated_at,
                estimated_time, supabase_id, sync_status, payment_status, payment_method,
                payment_transaction_id, staff_shift_id, staff_id, discount_percentage,
                discount_amount, tip_amount, version, terminal_id, branch_id,
                plugin, external_plugin_order_id, tax_rate, delivery_fee
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18,
                ?19, ?20, 'synced', ?21, ?22,
                ?23, ?24, ?25, ?26,
                ?27, ?28, 1, ?29, ?30,
                ?31, ?32, ?33, ?34
            )",
            rusqlite::params![
                local_id,
                order_number,
                customer_name,
                customer_phone,
                customer_email,
                items_json,
                total_amount,
                tax_amount,
                subtotal,
                status,
                order_type,
                table_number,
                delivery_address,
                delivery_notes,
                name_on_ringer,
                special_instructions,
                created_at,
                updated_at,
                estimated_time,
                remote_id,
                payment_status,
                payment_method,
                payment_tx_id,
                staff_shift_id,
                staff_id,
                discount_pct,
                discount_amount,
                tip_amount,
                terminal_id,
                branch_id,
                plugin,
                external_plugin_order_id,
                tax_rate,
                delivery_fee,
            ],
        )
        .map_err(|e| format!("save remote order: {e}"))?;
    }

    if let Ok(order_json) = sync::get_order_by_id(&db, &local_id) {
        let _ = app.emit("order_created", order_json);
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": local_id
    }))
}

#[tauri::command]
async fn order_fetch_items_from_supabase(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .or(arg1)
    .ok_or("Missing orderId")?;

    if let Ok(items_json) = fetch_supabase_rows(
        "order_items",
        &[
            (
                "select",
                "id,menu_item_id,quantity,unit_price,total_price,notes,customizations".to_string(),
            ),
            ("order_id", format!("eq.{}", order_id)),
        ],
    )
    .await
    {
        let rows = items_json.as_array().cloned().unwrap_or_default();
        if !rows.is_empty() {
            let ids: Vec<String> = rows
                .iter()
                .filter_map(|r| {
                    r.get("menu_item_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .collect();

            let mut names: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            if !ids.is_empty() {
                if let Ok(subcats) = fetch_supabase_rows(
                    "subcategories",
                    &[
                        ("select", "id,name,name_en,name_el".to_string()),
                        ("id", format!("in.({})", ids.join(","))),
                    ],
                )
                .await
                {
                    if let Some(arr) = subcats.as_array() {
                        for row in arr {
                            if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
                                let name = value_str(row, &["name", "name_en", "name_el"])
                                    .unwrap_or_else(|| "Item".to_string());
                                names.insert(id.to_string(), name);
                            }
                        }
                    }
                }
            }

            let transformed: Vec<serde_json::Value> = rows
                .into_iter()
                .enumerate()
                .map(|(i, row)| {
                    let menu_item_id = row.get("menu_item_id").and_then(|v| v.as_str()).unwrap_or("");
                    let quantity = row.get("quantity").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    let unit_price = row.get("unit_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let total_price = row
                        .get("total_price")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(unit_price * quantity);
                    let default_name = format!("Item {}", i + 1);
                    let item_name = names.get(menu_item_id).cloned().unwrap_or(default_name);
                    serde_json::json!({
                        "id": row.get("id").cloned().unwrap_or(serde_json::Value::Null),
                        "menu_item_id": menu_item_id,
                        "name": item_name,
                        "quantity": quantity,
                        "price": unit_price,
                        "unit_price": unit_price,
                        "total_price": total_price,
                        "notes": row.get("notes").cloned().unwrap_or(serde_json::Value::Null),
                        "customizations": row.get("customizations").cloned().unwrap_or(serde_json::Value::Null),
                    })
                })
                .collect();
            return Ok(serde_json::json!(transformed));
        }
    }

    // Fallback: use local order cache (by local ID or Supabase ID).
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let items_str: Option<String> = conn
        .query_row(
            "SELECT items FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id],
            |row| row.get(0),
        )
        .ok();
    if let Some(s) = items_str {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if v.is_array() {
                return Ok(v);
            }
        }
    }
    Ok(serde_json::json!([]))
}

#[tauri::command]
async fn order_create(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    _app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    let normalized = payload.get("orderData").cloned().unwrap_or(payload);
    let mut resp = sync::create_order(&db, &normalized)?;
    let order_id = resp
        .get("orderId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            resp.get("order")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    if let Some(order_id) = order_id.clone() {
        if let Some(obj) = resp.as_object_mut() {
            obj.entry("orderId".to_string())
                .or_insert_with(|| serde_json::Value::String(order_id.clone()));
            obj.entry("data".to_string())
                .or_insert_with(|| serde_json::json!({ "orderId": order_id.clone() }));
        }
    }

    // NOTE: We intentionally do NOT emit order_created/order_realtime_update here.
    // Self-created orders are added to state directly in the frontend store.
    // Only order_save_from_remote() emits these events (for orders from other terminals).
    Ok(resp)
}

#[tauri::command]
async fn orders_clear_all(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let count = conn
        .execute("DELETE FROM orders", [])
        .map_err(|e| e.to_string())?;
    let _ = app.emit("orders_cleared", serde_json::json!({ "count": count }));
    Ok(serde_json::json!({
        "success": true,
        "cleared": count
    }))
}

#[tauri::command]
async fn orders_get_conflicts() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!([]))
}

#[tauri::command]
async fn orders_resolve_conflict(
    arg0: Option<String>,
    arg1: Option<String>,
    _arg2: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conflict_id = arg0.unwrap_or_default();
    let strategy = arg1.unwrap_or_else(|| "server_wins".to_string());
    let _ = app.emit(
        "order_conflict_resolved",
        serde_json::json!({
            "conflictId": conflict_id,
            "strategy": strategy
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "conflictId": conflict_id,
        "strategy": strategy
    }))
}

#[tauri::command]
async fn order_approve(
    arg0: Option<String>,
    arg1: Option<i64>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let estimated_time = arg1;
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    conn.execute(
        "UPDATE orders
         SET status = 'confirmed',
             estimated_time = COALESCE(?1, estimated_time),
             sync_status = 'pending',
             updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![estimated_time, now, order_id],
    )
    .map_err(|e| format!("approve order: {e}"))?;

    let payload = serde_json::json!({
        "orderId": order_id,
        "status": "confirmed",
        "estimatedTime": estimated_time
    });
    let idem = format!(
        "order:approve:{}:{}",
        order_id,
        Utc::now().timestamp_millis()
    );
    let _ = conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('order', ?1, 'update', ?2, ?3)",
        rusqlite::params![order_id, payload.to_string(), idem],
    );
    drop(conn);

    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload.clone());
    Ok(
        serde_json::json!({ "success": true, "orderId": order_id_raw, "estimatedTime": estimated_time }),
    )
}

#[tauri::command]
async fn order_decline(
    arg0: Option<String>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let reason = arg1.unwrap_or_else(|| "Declined".to_string());
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    conn.execute(
        "UPDATE orders
         SET status = 'cancelled',
             cancellation_reason = ?1,
             sync_status = 'pending',
             updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![reason, now, order_id],
    )
    .map_err(|e| format!("decline order: {e}"))?;

    let payload = serde_json::json!({
        "orderId": order_id,
        "status": "cancelled",
        "reason": reason
    });
    let idem = format!(
        "order:decline:{}:{}",
        order_id,
        Utc::now().timestamp_millis()
    );
    let _ = conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('order', ?1, 'update', ?2, ?3)",
        rusqlite::params![order_id, payload.to_string(), idem],
    );
    drop(conn);

    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload);
    Ok(serde_json::json!({ "success": true, "orderId": order_id_raw }))
}

#[tauri::command]
async fn order_assign_driver(
    arg0: Option<String>,
    arg1: Option<String>,
    arg2: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let driver_id = arg1.ok_or("Missing driverId")?;
    let notes = arg2;
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    conn.execute(
        "UPDATE orders
         SET staff_id = ?1,
             delivery_notes = COALESCE(?2, delivery_notes),
             sync_status = 'pending',
             updated_at = ?3
         WHERE id = ?4",
        rusqlite::params![driver_id, notes, now, order_id],
    )
    .map_err(|e| format!("assign driver: {e}"))?;
    drop(conn);

    let payload = serde_json::json!({
        "orderId": order_id_raw,
        "driverId": driver_id,
        "notes": notes
    });
    let _ = app.emit("order_realtime_update", payload.clone());
    Ok(serde_json::json!({ "success": true, "data": payload }))
}

#[tauri::command]
async fn order_notify_platform_ready(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE orders SET status = 'ready', sync_status = 'pending', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, order_id],
    )
    .map_err(|e| format!("set ready status: {e}"))?;
    drop(conn);
    let payload = serde_json::json!({ "orderId": order_id_raw, "status": "ready" });
    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn order_update_preparation(
    arg0: Option<String>,
    arg1: Option<String>,
    arg2: Option<f64>,
    arg3: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id = arg0.ok_or("Missing orderId")?;
    let stage = arg1.unwrap_or_else(|| "preparing".to_string());
    let progress = arg2.unwrap_or(0.0).clamp(0.0, 100.0);
    let message = arg3;
    let mut all = read_local_json_array(&db, "order_preparation_states")?;
    all.retain(|item| {
        item.get("orderId")
            .and_then(|v| v.as_str())
            .map(|v| v != order_id)
            .unwrap_or(true)
    });
    all.push(serde_json::json!({
        "orderId": order_id,
        "stage": stage,
        "progress": progress,
        "message": message,
        "updatedAt": Utc::now().to_rfc3339()
    }));
    write_local_json(
        &db,
        "order_preparation_states",
        &serde_json::Value::Array(all),
    )?;

    let payload = serde_json::json!({
        "orderId": order_id,
        "preparationStage": stage,
        "preparationProgress": progress,
        "message": message
    });
    let _ = app.emit("order_realtime_update", payload.clone());
    Ok(serde_json::json!({ "success": true, "data": payload }))
}

#[tauri::command]
async fn order_update_type(
    arg0: Option<String>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let order_type = arg1.ok_or("Missing orderType")?;
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    conn.execute(
        "UPDATE orders SET order_type = ?1, sync_status = 'pending', updated_at = ?2 WHERE id = ?3",
        rusqlite::params![order_type, now, order_id],
    )
    .map_err(|e| format!("update order type: {e}"))?;
    let payload = serde_json::json!({
        "orderId": order_id,
        "orderType": order_type
    });
    let idem = format!(
        "order:update-type:{}:{}",
        order_id,
        Utc::now().timestamp_millis()
    );
    let _ = conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('order', ?1, 'update', ?2, ?3)",
        rusqlite::params![order_id, payload.to_string(), idem],
    );
    drop(conn);
    let _ = app.emit("order_realtime_update", payload);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn order_save_for_retry(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    let mut queue = read_local_json_array(&db, "order_retry_queue")?;
    queue.push(serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "order": payload,
        "retryCount": 0,
        "savedAt": Utc::now().to_rfc3339()
    }));
    write_local_json(
        &db,
        "order_retry_queue",
        &serde_json::Value::Array(queue.clone()),
    )?;
    let _ = app.emit(
        "order_sync_conflict",
        serde_json::json!({ "queueLength": queue.len() }),
    );
    Ok(serde_json::json!({ "success": true, "queueLength": queue.len() }))
}

#[tauri::command]
async fn order_get_retry_queue(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let queue = read_local_json_array(&db, "order_retry_queue")?;
    Ok(serde_json::json!(queue))
}

#[tauri::command]
async fn order_process_retry_queue(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let queue = read_local_json_array(&db, "order_retry_queue")?;
    let mut remaining: Vec<serde_json::Value> = Vec::new();
    let mut processed = 0usize;
    for mut item in queue {
        let order_payload = item
            .get("order")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let result = sync::create_order(&db, &order_payload);
        if result.is_ok() {
            processed += 1;
            continue;
        }
        let retry_count = item.get("retryCount").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        if let Some(obj) = item.as_object_mut() {
            obj.insert("retryCount".to_string(), serde_json::json!(retry_count));
            obj.insert(
                "lastAttemptAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
            if let Err(err) = result {
                obj.insert("lastError".to_string(), serde_json::json!(err));
            }
        }
        if retry_count < 3 {
            remaining.push(item);
        }
    }
    write_local_json(
        &db,
        "order_retry_queue",
        &serde_json::Value::Array(remaining.clone()),
    )?;
    let _ = app.emit(
        "sync_retry_scheduled",
        serde_json::json!({
            "processed": processed,
            "remaining": remaining.len()
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "processed": processed,
        "remaining": remaining.len()
    }))
}

#[tauri::command]
async fn orders_force_sync_retry(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    let updated = conn
        .execute(
            "UPDATE sync_queue
             SET status = 'pending', retry_count = 0, last_error = NULL, updated_at = datetime('now')
             WHERE entity_type = 'order' AND entity_id = ?1",
            rusqlite::params![order_id],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        let fallback_payload = serde_json::json!({ "orderId": order_id_raw });
        let idem = format!(
            "order:force-retry:{}:{}",
            order_id_raw,
            Utc::now().timestamp_millis()
        );
        let _ = conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('order', ?1, 'update', ?2, ?3)",
            rusqlite::params![order_id_raw, fallback_payload.to_string(), idem],
        );
    }
    Ok(serde_json::json!({ "success": true, "orderId": order_id_raw, "updated": updated }))
}

#[tauri::command]
async fn orders_get_retry_info(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).unwrap_or(order_id_raw.clone());
    let mut stmt = conn
        .prepare(
            "SELECT id, status, retry_count, max_retries, last_error, created_at, updated_at
             FROM sync_queue
             WHERE entity_type = 'order' AND entity_id = ?1
             ORDER BY id DESC
             LIMIT 5",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![order_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "status": row.get::<_, String>(1)?,
                "retryCount": row.get::<_, i64>(2)?,
                "maxRetries": row.get::<_, i64>(3)?,
                "lastError": row.get::<_, Option<String>>(4)?,
                "createdAt": row.get::<_, String>(5)?,
                "updatedAt": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let entries: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!({
        "success": true,
        "orderId": order_id_raw,
        "entries": entries,
        "hasRetries": !entries.is_empty()
    }))
}

#[tauri::command]
async fn payment_update_payment_status(
    arg0: Option<String>,
    arg1: Option<String>,
    arg2: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let payment_status = arg1.ok_or("Missing payment status")?;
    let payment_method = arg2;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    conn.execute(
        "UPDATE orders
         SET payment_status = ?1,
             payment_method = COALESCE(?2, payment_method),
             sync_status = 'pending',
             updated_at = ?3
         WHERE id = ?4",
        rusqlite::params![
            payment_status,
            payment_method,
            Utc::now().to_rfc3339(),
            order_id
        ],
    )
    .map_err(|e| format!("update payment status: {e}"))?;
    drop(conn);
    let payload = serde_json::json!({
        "orderId": order_id_raw,
        "paymentStatus": payment_status,
        "paymentMethod": payment_method
    });
    let _ = app.emit("order_payment_updated", payload.clone());
    Ok(serde_json::json!({ "success": true, "data": payload }))
}

// -- Sync --------------------------------------------------------------------

#[tauri::command]
async fn sync_get_status(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
) -> Result<serde_json::Value, String> {
    sync::get_sync_status(&db, &sync_state)
}

#[tauri::command]
async fn sync_get_network_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let status = sync::check_network_status().await;
    let _ = app.emit("network_status", status.clone());
    Ok(status)
}

#[tauri::command]
async fn sync_force(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    match sync::force_sync(&db, &sync_state).await {
        Ok(()) => {
            let _ = app.emit("sync_complete", serde_json::json!({ "trigger": "manual" }));
            Ok(())
        }
        Err(e) => {
            let _ = app.emit("sync_error", serde_json::json!({ "error": e }));
            Err(e)
        }
    }
}

#[tauri::command]
async fn sync_validate_pending_orders(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync::validate_pending_orders(&db)
}

#[tauri::command]
async fn sync_remove_invalid_orders(
    db: tauri::State<'_, db::DbState>,
    order_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    sync::remove_invalid_orders(&db, order_ids)
}

#[tauri::command]
async fn sync_get_financial_stats(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let pending_payments: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_payments WHERE sync_state IN ('pending', 'syncing')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let pending_adjustments: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM payment_adjustments WHERE sync_state IN ('pending', 'syncing')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let failed_payments: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_payments WHERE sync_state = 'failed'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let failed_adjustments: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM payment_adjustments WHERE sync_state = 'failed'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(serde_json::json!({
        "pendingPayments": pending_payments,
        "pendingAdjustments": pending_adjustments,
        "failedPayments": failed_payments,
        "failedAdjustments": failed_adjustments,
        "totalPending": pending_payments + pending_adjustments,
        "totalFailed": failed_payments + failed_adjustments,
    }))
}

#[tauri::command]
async fn sync_get_failed_financial_items(
    arg0: Option<i64>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let limit = arg0.unwrap_or(50);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, entity_type, payload, status, last_error, retry_count, created_at
             FROM sync_queue
             WHERE status = 'failed' AND entity_type IN ('order_payment', 'payment_adjustment')
             ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "entityType": row.get::<_, String>(1)?,
                "payload": row.get::<_, String>(2)?,
                "status": row.get::<_, String>(3)?,
                "lastError": row.get::<_, Option<String>>(4)?,
                "retryCount": row.get::<_, i64>(5)?,
                "createdAt": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let items: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!({ "items": items }))
}

#[tauri::command]
async fn sync_retry_financial_item(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let id = arg0.ok_or("Missing sync item id")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sync_queue SET status = 'pending', retry_count = 0, last_error = NULL WHERE id = ?1",
        [&id],
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("sync_retry_scheduled", serde_json::json!({ "id": id }));
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn sync_retry_all_failed_financial(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let count = conn
        .execute(
            "UPDATE sync_queue SET status = 'pending', retry_count = 0, last_error = NULL
             WHERE status = 'failed' AND entity_type IN ('order_payment', 'payment_adjustment')",
            [],
        )
        .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "sync_retry_scheduled",
        serde_json::json!({ "count": count }),
    );
    Ok(serde_json::json!({ "success": true, "count": count }))
}

#[tauri::command]
async fn sync_get_unsynced_financial_summary(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status != 'synced' AND entity_type IN ('order_payment', 'payment_adjustment')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(serde_json::json!({ "totalUnsynced": total }))
}

#[tauri::command]
async fn sync_validate_financial_integrity(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    // Stub: returns clean status
    let _ = db;
    Ok(serde_json::json!({ "valid": true, "issues": [] }))
}

#[tauri::command]
async fn sync_requeue_orphaned_financial(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let _ = db;
    Ok(serde_json::json!({ "success": true, "requeued": 0 }))
}

#[tauri::command]
async fn sync_clear_all_orders(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "DELETE FROM sync_queue WHERE entity_type IN ('order', 'payment', 'payment_adjustment')",
        [],
    );
    let cleared = conn
        .execute("DELETE FROM orders", [])
        .map_err(|e| e.to_string())?;
    let _ = app.emit("orders_cleared", serde_json::json!({ "count": cleared }));
    Ok(serde_json::json!({ "success": true, "cleared": cleared }))
}

#[tauri::command]
async fn sync_cleanup_deleted_orders(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);
    let admin_url =
        storage::get_credential("admin_dashboard_url").ok_or("Admin URL not configured")?;
    let api_key = storage::get_credential("pos_api_key").ok_or("API key not configured")?;

    // Fetch deleted IDs from server (all deletions since epoch)
    let resp = api::fetch_from_admin(
        &admin_url,
        &api_key,
        "/api/pos/orders/sync?limit=100&include_deleted=true&since=1970-01-01T00:00:00.000Z",
        "GET",
        None,
    )
    .await
    .map_err(|e| format!("Failed to fetch deleted orders: {e}"))?;

    let deleted_ids = resp
        .get("deleted_ids")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();

    let checked = deleted_ids.len();
    let mut deleted = 0usize;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    for deleted_id in &deleted_ids {
        let Some(remote_id) = deleted_id.as_str().filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        let local_id: Option<String> = conn
            .query_row(
                "SELECT id FROM orders WHERE supabase_id = ?1 OR id = ?1 LIMIT 1",
                rusqlite::params![remote_id],
                |row| row.get(0),
            )
            .ok();
        if let Some(local_id) = local_id {
            let _ = conn.execute(
                "DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id = ?1",
                rusqlite::params![local_id],
            );
            let _ = conn.execute(
                "DELETE FROM sync_queue WHERE entity_type = 'payment' AND entity_id IN (SELECT id FROM order_payments WHERE order_id = ?1)",
                rusqlite::params![local_id],
            );
            let _ = conn.execute(
                "DELETE FROM sync_queue WHERE entity_type = 'payment_adjustment' AND entity_id IN (SELECT id FROM payment_adjustments WHERE order_id = ?1)",
                rusqlite::params![local_id],
            );
            let count = conn
                .execute(
                    "DELETE FROM orders WHERE id = ?1",
                    rusqlite::params![local_id],
                )
                .unwrap_or(0);
            deleted += count;
        }
    }

    Ok(serde_json::json!({ "success": true, "deleted": deleted, "checked": checked }))
}

async fn sync_fetch_with_options(
    path: &str,
    arg0: Option<serde_json::Value>,
    db: &db::DbState,
) -> Result<serde_json::Value, String> {
    let full_path = build_admin_query(path, arg0.as_ref());
    match admin_fetch(Some(db), &full_path, "GET", None).await {
        Ok(v) => Ok(v),
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "error": e
        })),
    }
}

#[tauri::command]
async fn sync_clear_all(db: tauri::State<'_, db::DbState>) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let cleared = conn
        .execute("DELETE FROM sync_queue", [])
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true, "cleared": cleared }))
}

#[tauri::command]
async fn sync_clear_failed(db: tauri::State<'_, db::DbState>) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let cleared = conn
        .execute("DELETE FROM sync_queue WHERE status = 'failed'", [])
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true, "cleared": cleared }))
}

#[tauri::command]
async fn sync_clear_old_orders(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    // Clean orphaned sync_queue entries for old orders
    let _ = conn.execute(
        "DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id IN (
            SELECT id FROM orders WHERE substr(created_at, 1, 10) < ?1
        )",
        rusqlite::params![today],
    );
    let cleared = conn
        .execute(
            "DELETE FROM orders WHERE substr(created_at, 1, 10) < ?1",
            rusqlite::params![today],
        )
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true, "cleared": cleared }))
}

#[tauri::command]
async fn sync_get_inter_terminal_status(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);

    let admin_url = storage::get_credential("admin_dashboard_url");
    let api_key = storage::get_credential("pos_api_key");
    let terminal_id = storage::get_credential("terminal_id");

    let Some(admin_url_val) = admin_url else {
        return Ok(serde_json::json!({
            "parentInfo": serde_json::Value::Null,
            "isParentReachable": false,
            "routingMode": "unknown",
        }));
    };
    let Some(api_key_val) = api_key else {
        return Ok(serde_json::json!({
            "parentInfo": serde_json::Value::Null,
            "isParentReachable": false,
            "routingMode": "unknown",
        }));
    };

    let connectivity = api::test_connectivity(&admin_url_val, &api_key_val).await;
    let normalized_admin_url = api::normalize_admin_url(&admin_url_val);
    let parent_info = serde_json::json!({
        "adminUrl": normalized_admin_url.clone(),
        "host": normalized_admin_url,
        "name": terminal_id.clone().unwrap_or_else(|| "Main POS".to_string()),
        "terminalId": terminal_id,
    });

    Ok(serde_json::json!({
        "parentInfo": parent_info,
        "isParentReachable": connectivity.success,
        "routingMode": if connectivity.success { "via_parent" } else { "direct_cloud" },
        "latencyMs": connectivity.latency_ms,
    }))
}

#[tauri::command]
async fn sync_rediscover_parent() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn sync_fetch_tables(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/tables", arg0, &db).await
}

#[tauri::command]
async fn sync_fetch_reservations(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/reservations", arg0, &db).await
}

#[tauri::command]
async fn sync_fetch_suppliers(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/suppliers", arg0, &db).await
}

#[tauri::command]
async fn sync_fetch_analytics(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/analytics", arg0, &db).await
}

#[tauri::command]
async fn sync_fetch_orders(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/orders", arg0, &db).await
}

#[tauri::command]
async fn sync_fetch_rooms(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/rooms", arg0, &db).await
}

#[tauri::command]
async fn sync_update_room_status(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(room_id)) => serde_json::json!({
            "roomId": room_id,
            "status": arg1.clone()
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let room_id = value_str(&payload, &["roomId", "room_id", "id"]).ok_or("Missing roomId")?;
    let status = value_str(&payload, &["status"])
        .or(arg1)
        .ok_or("Missing status")?;
    let path = format!("/api/pos/rooms/{room_id}");
    let body = serde_json::json!({ "status": status });

    match admin_fetch(Some(&db), &path, "PATCH", Some(body)).await {
        Ok(v) => Ok(v),
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "error": e
        })),
    }
}

#[tauri::command]
async fn sync_fetch_drive_thru(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    sync_fetch_with_options("/api/pos/drive-through", arg0, &db).await
}

#[tauri::command]
async fn sync_update_drive_thru_order_status(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(order_id)) => serde_json::json!({
            "driveThruOrderId": order_id,
            "status": arg1.clone()
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let order_id = value_str(
        &payload,
        &[
            "driveThruOrderId",
            "drive_through_order_id",
            "driveThruOrderID",
            "orderId",
            "id",
        ],
    )
    .ok_or("Missing drive-through order ID")?;
    let status = value_str(&payload, &["status"])
        .or(arg1)
        .ok_or("Missing status")?;
    let body = serde_json::json!({
        "drive_through_order_id": order_id,
        "status": status
    });

    match admin_fetch(Some(&db), "/api/pos/drive-through", "PATCH", Some(body)).await {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                if obj.get("order").is_none() {
                    if let Some(alt) = obj.get("drive_through_order").cloned() {
                        obj.insert("order".to_string(), alt);
                    }
                }
            }
            Ok(v)
        }
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "error": e
        })),
    }
}

#[tauri::command]
async fn rooms_get_availability(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    match admin_fetch(Some(&db), "/api/pos/rooms", "GET", None).await {
        Ok(resp) => {
            let rooms = resp
                .get("rooms")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let total = rooms.len() as i64;
            let available = rooms
                .iter()
                .filter(|r| {
                    r.get("status")
                        .and_then(|v| v.as_str())
                        .map(|s| s.eq_ignore_ascii_case("available"))
                        .unwrap_or(false)
                })
                .count() as i64;

            Ok(serde_json::json!({
                "success": true,
                "available": available,
                "total": total
            }))
        }
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "notImplemented": true,
            "message": e,
            "available": 0,
            "total": 0
        })),
    }
}

#[tauri::command]
async fn appointments_get_today_metrics() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": false,
        "notImplemented": true,
        "message": "Appointments service not yet implemented. Metrics derived from orders.",
        "scheduled": 0,
        "completed": 0,
        "canceled": 0
    }))
}

/// Standalone command to fetch terminal settings from admin API.
/// Called on app startup and can be called manually to refresh config.
#[tauri::command]
async fn admin_sync_terminal_config(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);

    let terminal_id = storage::get_credential("terminal_id")
        .or_else(|| read_local_setting(&db, "terminal", "terminal_id"))
        .ok_or("Terminal not configured: missing terminal ID")?;

    let path = format!("/api/pos/settings/{terminal_id}");
    let resp = admin_fetch(Some(&db), &path, "GET", None).await?;

    let mut updated: Vec<String> = Vec::new();
    if let Some(bid) = extract_branch_id_from_terminal_settings_response(&resp) {
        storage::set_credential("branch_id", &bid)?;
        if let Ok(conn) = db.conn.lock() {
            let _ = db::set_setting(&conn, "terminal", "branch_id", &bid);
        }
        updated.push("branch_id".into());
    }
    if let Some(oid) = extract_org_id_from_terminal_settings_response(&resp) {
        storage::set_credential("organization_id", &oid)?;
        if let Ok(conn) = db.conn.lock() {
            let _ = db::set_setting(&conn, "terminal", "organization_id", &oid);
        }
        updated.push("organization_id".into());
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
                if let Ok(conn) = db.conn.lock() {
                    let _ = db::set_setting(&conn, "terminal", "supabase_anon_key", key);
                }
                updated.push("supabase_anon_key".into());
            }
        }
    }
    info!("admin_sync_terminal_config: updated {:?}", updated);
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

// -- Menu --------------------------------------------------------------------

#[tauri::command]
async fn menu_get_categories(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    let mut categories = menu::get_categories(&db);
    let source = if categories.is_empty() {
        maybe_lazy_warm_menu_cache(&db, &app, "menu_get_categories").await;
        categories = menu::get_categories(&db);
        if categories.is_empty() {
            "empty_after_warmup"
        } else {
            "lazy_sync"
        }
    } else {
        "cache"
    };
    info!(source = %source, count = categories.len(), "menu_get_categories");
    Ok(categories)
}

#[tauri::command]
async fn menu_get_subcategories(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    let mut subcategories = menu::get_subcategories(&db);
    let source = if subcategories.is_empty() {
        maybe_lazy_warm_menu_cache(&db, &app, "menu_get_subcategories").await;
        subcategories = menu::get_subcategories(&db);
        if subcategories.is_empty() {
            "empty_after_warmup"
        } else {
            "lazy_sync"
        }
    } else {
        "cache"
    };
    info!(
        source = %source,
        count = subcategories.len(),
        "menu_get_subcategories"
    );
    Ok(subcategories)
}

#[tauri::command]
async fn menu_get_ingredients(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    let mut ingredients = menu::get_ingredients(&db);
    let source = if ingredients.is_empty() {
        maybe_lazy_warm_menu_cache(&db, &app, "menu_get_ingredients").await;
        ingredients = menu::get_ingredients(&db);
        if ingredients.is_empty() {
            "empty_after_warmup"
        } else {
            "lazy_sync"
        }
    } else {
        "cache"
    };
    info!(source = %source, count = ingredients.len(), "menu_get_ingredients");
    Ok(ingredients)
}

#[tauri::command]
async fn menu_get_subcategory_ingredients(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let subcategory_id = arg0.ok_or("Missing subcategoryId")?;
    let mut ingredients = menu::get_ingredients(&db);
    if ingredients.is_empty() {
        maybe_lazy_warm_menu_cache(&db, &app, "menu_get_subcategory_ingredients").await;
        ingredients = menu::get_ingredients(&db);
    }
    let mut filtered: Vec<serde_json::Value> = ingredients
        .into_iter()
        .filter(|item| {
            value_str(item, &["subcategory_id", "subcategoryId", "subcategory"])
                .map(|v| v == subcategory_id)
                .unwrap_or(false)
        })
        .collect();

    if filtered.is_empty() {
        let mut subcategories = menu::get_subcategories(&db);
        if subcategories.is_empty() {
            maybe_lazy_warm_menu_cache(&db, &app, "menu_get_subcategory_ingredients").await;
            subcategories = menu::get_subcategories(&db);
        }
        for entry in subcategories {
            let sid = value_str(&entry, &["id", "subcategory_id", "subcategoryId"]);
            if sid.as_deref() != Some(subcategory_id.as_str()) {
                continue;
            }
            if let Some(arr) = entry.get("ingredients").and_then(|v| v.as_array()) {
                filtered = arr.clone();
                break;
            }
        }
    }

    info!(
        subcategory_id = %subcategory_id,
        count = filtered.len(),
        "menu_get_subcategory_ingredients"
    );
    Ok(serde_json::json!(filtered))
}

#[tauri::command]
async fn menu_get_combos(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    let mut combos = menu::get_combos(&db);
    let source = if combos.is_empty() {
        maybe_lazy_warm_menu_cache(&db, &app, "menu_get_combos").await;
        combos = menu::get_combos(&db);
        if combos.is_empty() {
            "empty_after_warmup"
        } else {
            "lazy_sync"
        }
    } else {
        "cache"
    };
    info!(source = %source, count = combos.len(), "menu_get_combos");
    Ok(combos)
}

#[tauri::command]
async fn menu_sync(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);

    let terminal_id = storage::get_credential("terminal_id")
        .or_else(|| read_local_setting(&db, "terminal", "terminal_id"))
        .unwrap_or_default();
    let masked_terminal_id = mask_terminal_id(&terminal_id);

    info!(
        terminal_id = %masked_terminal_id,
        "menu_sync command: starting deterministic backend sync"
    );

    match menu::sync_menu(&db).await {
        Ok(result) => {
            let updated = result
                .get("updated")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let version = result
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let counts = result.get("counts").cloned().unwrap_or_else(|| {
                serde_json::json!({
                    "categories": 0,
                    "subcategories": 0,
                    "ingredients": 0,
                    "combos": 0
                })
            });
            let timestamp = result
                .get("timestamp")
                .cloned()
                .unwrap_or_else(|| serde_json::json!(Utc::now().to_rfc3339()));

            let _ = app.emit(
                "menu_sync",
                serde_json::json!({
                    "source": "menu_sync_command",
                    "updated": updated,
                    "version": version,
                    "counts": counts.clone(),
                    "timestamp": timestamp.clone(),
                }),
            );

            info!(
                terminal_id = %masked_terminal_id,
                updated = updated,
                version = %version,
                "menu_sync command: completed"
            );

            Ok(serde_json::json!({
                "success": true,
                "updated": updated,
                "version": version,
                "counts": counts,
                "timestamp": timestamp
            }))
        }
        Err(error) => {
            if is_terminal_auth_failure(&error) {
                handle_invalid_terminal_credentials(Some(&db), &app, "menu_sync_command", &error);
                return Ok(serde_json::json!({
                    "success": false,
                    "errorCode": "invalid_terminal_credentials",
                    "error": error
                }));
            }

            warn!(
                terminal_id = %masked_terminal_id,
                error = %error,
                "menu_sync command: failed"
            );
            Ok(serde_json::json!({
                "success": false,
                "errorCode": "menu_sync_failed",
                "error": error
            }))
        }
    }
}

#[tauri::command]
async fn menu_update_category(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = match (arg0, arg1) {
        (Some(serde_json::Value::String(id)), Some(serde_json::Value::Object(mut extra))) => {
            extra.insert("id".to_string(), serde_json::Value::String(id));
            serde_json::Value::Object(extra)
        }
        (Some(serde_json::Value::Object(mut base)), Some(serde_json::Value::Object(extra))) => {
            for (k, v) in extra {
                base.insert(k, v);
            }
            serde_json::Value::Object(base)
        }
        (Some(v), _) => v,
        (None, Some(v)) => v,
        _ => serde_json::json!({}),
    };

    let id =
        value_str(&payload, &["id", "categoryId", "category_id"]).ok_or("Missing category id")?;
    let is_active = payload
        .get("is_active")
        .or_else(|| payload.get("isActive"))
        .and_then(|v| v.as_bool())
        .ok_or("Missing is_active")?;

    let path = format!("/api/pos/sync/menu_categories/{id}");
    let result = match admin_fetch(
        Some(&db),
        &path,
        "PATCH",
        Some(serde_json::json!({ "is_active": is_active })),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return Ok(serde_json::json!({
                "success": false,
                "error": e
            }));
        }
    };

    let _ = menu::sync_menu(&db).await;
    let _ = app.emit(
        "menu_sync",
        serde_json::json!({
            "table": "menu_categories",
            "action": "update",
            "id": id
        }),
    );

    Ok(result)
}

#[tauri::command]
async fn menu_update_subcategory(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = match (arg0, arg1) {
        (Some(serde_json::Value::String(id)), Some(serde_json::Value::Object(mut extra))) => {
            extra.insert("id".to_string(), serde_json::Value::String(id));
            serde_json::Value::Object(extra)
        }
        (Some(serde_json::Value::Object(mut base)), Some(serde_json::Value::Object(extra))) => {
            for (k, v) in extra {
                base.insert(k, v);
            }
            serde_json::Value::Object(base)
        }
        (Some(v), _) => v,
        (None, Some(v)) => v,
        _ => serde_json::json!({}),
    };

    let id = value_str(&payload, &["id", "subcategoryId", "subcategory_id"])
        .ok_or("Missing subcategory id")?;
    let is_available = payload
        .get("is_available")
        .or_else(|| payload.get("isAvailable"))
        .and_then(|v| v.as_bool())
        .ok_or("Missing is_available")?;

    let path = format!("/api/pos/sync/subcategories/{id}");
    let result = match admin_fetch(
        Some(&db),
        &path,
        "PATCH",
        Some(serde_json::json!({ "is_available": is_available })),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return Ok(serde_json::json!({
                "success": false,
                "error": e
            }));
        }
    };

    let _ = menu::sync_menu(&db).await;
    let _ = app.emit(
        "menu_sync",
        serde_json::json!({
            "table": "subcategories",
            "action": "update",
            "id": id
        }),
    );

    Ok(result)
}

#[tauri::command]
async fn menu_update_ingredient(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = match (arg0, arg1) {
        (Some(serde_json::Value::String(id)), Some(serde_json::Value::Object(mut extra))) => {
            extra.insert("id".to_string(), serde_json::Value::String(id));
            serde_json::Value::Object(extra)
        }
        (Some(serde_json::Value::Object(mut base)), Some(serde_json::Value::Object(extra))) => {
            for (k, v) in extra {
                base.insert(k, v);
            }
            serde_json::Value::Object(base)
        }
        (Some(v), _) => v,
        (None, Some(v)) => v,
        _ => serde_json::json!({}),
    };

    let id = value_str(&payload, &["id", "ingredientId", "ingredient_id"])
        .ok_or("Missing ingredient id")?;
    let is_available = payload
        .get("is_available")
        .or_else(|| payload.get("isAvailable"))
        .and_then(|v| v.as_bool())
        .ok_or("Missing is_available")?;

    let path = format!("/api/pos/sync/ingredients/{id}");
    let result = match admin_fetch(
        Some(&db),
        &path,
        "PATCH",
        Some(serde_json::json!({ "is_available": is_available })),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return Ok(serde_json::json!({
                "success": false,
                "error": e
            }));
        }
    };

    let _ = menu::sync_menu(&db).await;
    let _ = app.emit(
        "menu_sync",
        serde_json::json!({
            "table": "ingredients",
            "action": "update",
            "id": id
        }),
    );

    Ok(result)
}

#[tauri::command]
async fn menu_update_combo(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = match (arg0, arg1) {
        (Some(serde_json::Value::String(id)), Some(serde_json::Value::Object(mut extra))) => {
            extra.insert("id".to_string(), serde_json::Value::String(id));
            serde_json::Value::Object(extra)
        }
        (Some(serde_json::Value::Object(mut base)), Some(serde_json::Value::Object(extra))) => {
            for (k, v) in extra {
                base.insert(k, v);
            }
            serde_json::Value::Object(base)
        }
        (Some(v), _) => v,
        (None, Some(v)) => v,
        _ => serde_json::json!({}),
    };

    let id = value_str(&payload, &["id", "comboId", "combo_id"]).ok_or("Missing combo id")?;
    let is_active = payload
        .get("is_active")
        .or_else(|| payload.get("isActive"))
        .and_then(|v| v.as_bool())
        .ok_or("Missing is_active")?;
    let body = serde_json::json!({ "is_active": is_active });

    let sync_path = format!("/api/pos/sync/menu_combos/{id}");
    let fallback_path = format!("/api/menu/combos/{id}");

    let result = match admin_fetch(Some(&db), &sync_path, "PATCH", Some(body.clone())).await {
        Ok(v) => v,
        Err(sync_err) => match admin_fetch(Some(&db), &fallback_path, "PATCH", Some(body)).await {
            Ok(v) => v,
            Err(fallback_err) => {
                return Ok(serde_json::json!({
                    "success": false,
                    "error": format!("sync endpoint error: {sync_err}; fallback error: {fallback_err}")
                }));
            }
        },
    };

    let _ = menu::sync_menu(&db).await;
    let _ = app.emit(
        "menu_sync",
        serde_json::json!({
            "table": "menu_combos",
            "action": "update",
            "id": id
        }),
    );

    Ok(result)
}

#[tauri::command]
async fn menu_trigger_check_for_updates(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let _ = app.emit(
        "menu_check_for_updates",
        serde_json::json!({ "source": "menu" }),
    );
    Ok(serde_json::json!({ "success": true }))
}

// -- Shifts ------------------------------------------------------------------

#[tauri::command]
async fn shift_open(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing shift payload")?;
    let result = shifts::open_shift(&db, &payload)?;
    let _ = app.emit(
        "shift_updated",
        serde_json::json!({
            "action": "open",
            "shift": result
        }),
    );
    Ok(result)
}

#[tauri::command]
async fn shift_close(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing shift close payload")?;
    let result = shifts::close_shift(&db, &payload)?;
    let _ = app.emit(
        "shift_updated",
        serde_json::json!({
            "action": "close",
            "shift": result
        }),
    );
    Ok(result)
}

#[tauri::command]
async fn shift_get_active(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let staff_id = arg0.ok_or("Missing staffId")?;
    shifts::get_active(&db, &staff_id)
}

#[tauri::command]
async fn shift_get_active_by_terminal(
    arg0: Option<String>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let branch_id = arg0.ok_or("Missing branchId")?;
    let terminal_id = arg1.ok_or("Missing terminalId")?;
    shifts::get_active_by_terminal(&db, &branch_id, &terminal_id)
}

#[tauri::command]
async fn shift_get_active_by_terminal_loose(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let terminal_id = arg0.ok_or("Missing terminalId")?;
    shifts::get_active_by_terminal_loose(&db, &terminal_id)
}

#[tauri::command]
async fn shift_get_active_cashier_by_terminal(
    arg0: Option<String>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let branch_id = arg0.ok_or("Missing branchId")?;
    let terminal_id = arg1.ok_or("Missing terminalId")?;
    shifts::get_active_cashier_by_terminal(&db, &branch_id, &terminal_id)
}

#[tauri::command]
async fn shift_get_summary(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let shift_id = arg0.ok_or("Missing shiftId")?;
    shifts::get_shift_summary(&db, &shift_id)
}

#[tauri::command]
async fn shift_record_expense(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing expense payload")?;
    shifts::record_expense(&db, &payload)
}

#[tauri::command]
async fn shift_get_expenses(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let shift_id = arg0.ok_or("Missing shiftId")?;
    shifts::get_expenses(&db, &shift_id)
}

// -- Staff listing (for shift check-in) --------------------------------------

/// List staff members eligible for POS check-in, fetched via Supabase RPC.
#[tauri::command]
async fn shift_list_staff_for_checkin(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);

    let branch_id = arg0
        .or_else(|| storage::get_credential("branch_id"))
        .or_else(|| read_local_setting(&db, "terminal", "branch_id"))
        .ok_or("Missing branchId")?;
    let supabase_url = storage::get_credential("supabase_url")
        .or_else(|| read_local_setting(&db, "terminal", "supabase_url"))
        .ok_or("Supabase not configured: missing URL")?;
    let supabase_key = storage::get_credential("supabase_anon_key")
        .or_else(|| read_local_setting(&db, "terminal", "supabase_anon_key"))
        .ok_or("Supabase not configured: missing anon key")?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let url = format!(
        "{}/rest/v1/rpc/pos_list_staff_for_checkin",
        supabase_url.trim_end_matches('/')
    );

    let resp = client
        .post(&url)
        .header("apikey", &supabase_key)
        .header("Authorization", format!("Bearer {supabase_key}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "p_branch_id": branch_id }))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch staff: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Staff fetch failed ({status}): {body}"));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {e}"))?;

    let staff_list = data
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| {
            let id = value_str(&row, &["id"])?;
            let first_name = value_str(&row, &["first_name", "firstName"]).unwrap_or_default();
            let last_name = value_str(&row, &["last_name", "lastName"]).unwrap_or_default();
            let composed_name = format!("{first_name} {last_name}").trim().to_string();
            let name = value_str(&row, &["name", "full_name", "fullName", "display_name"])
                .or_else(|| {
                    if composed_name.is_empty() {
                        None
                    } else {
                        Some(composed_name.clone())
                    }
                })
                .unwrap_or_else(|| "Staff".to_string());

            let role_id = value_str(&row, &["role_id", "roleId"]).unwrap_or_default();
            let role_name =
                value_str(&row, &["role_name", "roleName"]).unwrap_or_else(|| "staff".to_string());
            let role_display_name = value_str(&row, &["role_display_name", "roleDisplayName"])
                .unwrap_or_else(|| "Staff".to_string());

            let roles = row
                .get("roles")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|role| {
                    let rid = value_str(&role, &["role_id", "roleId", "id"])
                        .or_else(|| if role_id.is_empty() { None } else { Some(role_id.clone()) })?;
                    Some(serde_json::json!({
                        "role_id": rid,
                        "role_name": value_str(&role, &["role_name", "roleName", "name"])
                            .unwrap_or_else(|| role_name.clone()),
                        "role_display_name": value_str(&role, &["role_display_name", "roleDisplayName", "display_name", "displayName"])
                            .unwrap_or_else(|| role_display_name.clone()),
                        "role_color": value_str(&role, &["role_color", "roleColor", "color"])
                            .unwrap_or_else(|| "#6B7280".to_string()),
                        "is_primary": role.get("is_primary").and_then(|v| v.as_bool()).unwrap_or(false),
                    }))
                })
                .collect::<Vec<serde_json::Value>>();

            Some(serde_json::json!({
                "id": id,
                "name": name,
                "first_name": first_name,
                "last_name": last_name,
                "email": value_str(&row, &["email"]).unwrap_or_default(),
                "role_id": role_id,
                "role_name": role_name,
                "role_display_name": role_display_name,
                "roles": roles,
                "can_login_pos": row.get("can_login_pos").and_then(|v| v.as_bool()).unwrap_or(true),
                "is_active": row.get("is_active").and_then(|v| v.as_bool()).unwrap_or(true),
                "hourly_rate": row.get("hourly_rate").cloned().unwrap_or(serde_json::Value::Null),
            }))
        })
        .collect::<Vec<serde_json::Value>>();

    Ok(serde_json::json!({
        "success": true,
        "data": staff_list
    }))
}

/// Get roles for a list of staff IDs.
#[tauri::command]
async fn shift_get_staff_roles(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);

    let staff_ids = if let Some(serde_json::Value::Array(arr)) = arg0.as_ref() {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect::<Vec<String>>()
    } else if let Some(serde_json::Value::Object(obj)) = arg0.as_ref() {
        if let Some(serde_json::Value::Array(arr)) =
            obj.get("staffIds").or_else(|| obj.get("staff_ids"))
        {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<String>>()
        } else {
            Vec::new()
        }
    } else if let Some(serde_json::Value::String(single)) = arg0.as_ref() {
        let trimmed = single.trim();
        if trimmed.is_empty() {
            Vec::new()
        } else {
            vec![trimmed.to_string()]
        }
    } else {
        Vec::new()
    };

    if staff_ids.is_empty() {
        return Ok(serde_json::json!({
            "success": true,
            "data": {}
        }));
    }

    let supabase_url = storage::get_credential("supabase_url")
        .or_else(|| read_local_setting(&db, "terminal", "supabase_url"))
        .ok_or("Supabase not configured: missing URL")?;
    let supabase_key = storage::get_credential("supabase_anon_key")
        .or_else(|| read_local_setting(&db, "terminal", "supabase_anon_key"))
        .ok_or("Supabase not configured: missing anon key")?;
    let organization_id = storage::get_credential("organization_id")
        .or_else(|| read_local_setting(&db, "terminal", "organization_id"))
        .unwrap_or_default();
    let branch_id = storage::get_credential("branch_id")
        .or_else(|| read_local_setting(&db, "terminal", "branch_id"))
        .unwrap_or_default();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let base = supabase_url.trim_end_matches('/');

    // Build role metadata lookup first.
    let roles_url =
        format!("{base}/rest/v1/roles?select=id,name,display_name,color&is_active=eq.true");
    let mut roles_req = client
        .get(&roles_url)
        .header("apikey", &supabase_key)
        .header("Authorization", format!("Bearer {supabase_key}"))
        .header("Content-Type", "application/json");
    if !organization_id.trim().is_empty() {
        roles_req = roles_req.header("x-organization-id", organization_id.trim());
    }
    if !branch_id.trim().is_empty() {
        roles_req = roles_req.header("x-branch-id", branch_id.trim());
    }

    let mut role_lookup: std::collections::HashMap<String, (String, String, String)> =
        std::collections::HashMap::new();
    if let Ok(resp) = roles_req.send().await {
        if resp.status().is_success() {
            if let Ok(rows) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = rows.as_array() {
                    for row in arr {
                        if let Some(id) = value_str(row, &["id"]) {
                            let name =
                                value_str(row, &["name"]).unwrap_or_else(|| "staff".to_string());
                            let display = value_str(row, &["display_name", "displayName"])
                                .unwrap_or_else(|| "Staff".to_string());
                            let color =
                                value_str(row, &["color"]).unwrap_or_else(|| "#6B7280".to_string());
                            role_lookup.insert(id, (name, display, color));
                        }
                    }
                }
            }
        }
    }

    // Prefer RPC; fallback to direct staff_roles query if RPC unavailable.
    let rpc_url = format!("{base}/rest/v1/rpc/pos_get_staff_roles_by_ids");
    let mut rpc_req = client
        .post(&rpc_url)
        .header("apikey", &supabase_key)
        .header("Authorization", format!("Bearer {supabase_key}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "p_staff_ids": staff_ids }));
    if !organization_id.trim().is_empty() {
        rpc_req = rpc_req.header("x-organization-id", organization_id.trim());
    }
    if !branch_id.trim().is_empty() {
        rpc_req = rpc_req.header("x-branch-id", branch_id.trim());
    }

    let mut roles_rows: Vec<serde_json::Value> = Vec::new();
    match rpc_req.send().await {
        Ok(resp) if resp.status().is_success() => {
            let parsed = resp
                .json::<serde_json::Value>()
                .await
                .map_err(|e| format!("Failed to parse staff role RPC response: {e}"))?;
            roles_rows = parsed.as_array().cloned().unwrap_or_default();
        }
        _ => {
            let ids = staff_ids
                .iter()
                .map(|s| s.replace(',', ""))
                .collect::<Vec<String>>()
                .join(",");
            let fallback_url = format!(
                "{base}/rest/v1/staff_roles?staff_id=in.({ids})&select=staff_id,role_id,is_primary"
            );
            let mut fallback_req = client
                .get(&fallback_url)
                .header("apikey", &supabase_key)
                .header("Authorization", format!("Bearer {supabase_key}"))
                .header("Content-Type", "application/json");
            if !organization_id.trim().is_empty() {
                fallback_req = fallback_req.header("x-organization-id", organization_id.trim());
            }
            if !branch_id.trim().is_empty() {
                fallback_req = fallback_req.header("x-branch-id", branch_id.trim());
            }

            let fallback_resp = fallback_req
                .send()
                .await
                .map_err(|e| format!("Failed to fetch staff roles fallback: {e}"))?;
            if fallback_resp.status().is_success() {
                let parsed = fallback_resp
                    .json::<serde_json::Value>()
                    .await
                    .map_err(|e| format!("Failed to parse staff roles fallback response: {e}"))?;
                roles_rows = parsed.as_array().cloned().unwrap_or_default();
            }
        }
    }

    let mut roles_by_staff: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();
    let mut seen_by_staff: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    for row in roles_rows {
        let staff_id = value_str(&row, &["staff_id", "staffId"]).unwrap_or_default();
        let role_id = value_str(&row, &["role_id", "roleId"]).unwrap_or_default();
        if staff_id.is_empty() || role_id.is_empty() {
            continue;
        }

        let seen = seen_by_staff.entry(staff_id.clone()).or_default();
        if !seen.insert(role_id.clone()) {
            continue;
        }

        let (fallback_name, fallback_display, fallback_color) =
            role_lookup.get(&role_id).cloned().unwrap_or_else(|| {
                (
                    "staff".to_string(),
                    "Staff".to_string(),
                    "#6B7280".to_string(),
                )
            });

        let role_obj = serde_json::json!({
            "role_id": role_id,
            "role_name": value_str(&row, &["role_name", "roleName"]).unwrap_or(fallback_name),
            "role_display_name": value_str(&row, &["role_display_name", "roleDisplayName"]).unwrap_or(fallback_display),
            "role_color": value_str(&row, &["role_color", "roleColor"]).unwrap_or(fallback_color),
            "is_primary": row.get("is_primary").and_then(|v| v.as_bool()).unwrap_or(false),
        });
        roles_by_staff.entry(staff_id).or_default().push(role_obj);
    }

    Ok(serde_json::json!({
        "success": true,
        "data": roles_by_staff
    }))
}

#[tauri::command]
async fn shift_record_staff_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing staff payment payload")?;
    let cashier_shift_id = value_str(&payload, &["cashierShiftId", "cashier_shift_id"])
        .ok_or("Missing cashierShiftId")?;
    let paid_to_staff_id = value_str(
        &payload,
        &[
            "paidToStaffId",
            "paid_to_staff_id",
            "recipientStaffId",
            "recipient_staff_id",
            "staffId",
            "staff_id",
        ],
    )
    .ok_or("Missing paidToStaffId")?;
    let amount = value_f64(&payload, &["amount"]).ok_or("Missing amount")?;
    let payment_type =
        value_str(&payload, &["paymentType", "payment_type"]).unwrap_or_else(|| "wage".to_string());
    let notes = value_str(&payload, &["notes"]);

    let payment_id = uuid::Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    ensure_staff_payments_table(&conn)?;

    conn.execute(
        "INSERT INTO staff_payments (
            id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            payment_id,
            cashier_shift_id,
            paid_to_staff_id,
            amount,
            payment_type,
            notes,
            created_at
        ],
    )
    .map_err(|e| format!("record staff payment: {e}"))?;

    let _ = conn.execute(
        "UPDATE cash_drawer_sessions
         SET total_staff_payments = COALESCE(total_staff_payments, 0) + ?1,
             updated_at = datetime('now')
         WHERE staff_shift_id = ?2",
        rusqlite::params![amount, cashier_shift_id],
    );

    let sync_payload = serde_json::json!({
        "id": payment_id,
        "cashierShiftId": cashier_shift_id,
        "paidToStaffId": paid_to_staff_id,
        "amount": amount,
        "paymentType": payment_type,
        "notes": notes
    });
    let idem = format!(
        "staff-payment:{}:{}",
        payment_id,
        Utc::now().timestamp_millis()
    );
    let _ = conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('staff_payment', ?1, 'insert', ?2, ?3)",
        rusqlite::params![payment_id, sync_payload.to_string(), idem],
    );

    Ok(serde_json::json!({
        "success": true,
        "paymentId": payment_id
    }))
}

#[tauri::command]
async fn shift_get_staff_payments(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let cashier_shift_id = arg0.ok_or("Missing cashierShiftId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    ensure_staff_payments_table(&conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at
             FROM staff_payments
             WHERE cashier_shift_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![cashier_shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "cashier_shift_id": row.get::<_, String>(1)?,
                "paid_to_staff_id": row.get::<_, String>(2)?,
                "amount": row.get::<_, f64>(3)?,
                "payment_type": row.get::<_, String>(4)?,
                "notes": row.get::<_, Option<String>>(5)?,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let items: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!(items))
}

#[tauri::command]
async fn shift_get_staff_payments_by_staff(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let staff_id = value_str(&payload, &["staffId", "staff_id"]).ok_or("Missing staffId")?;
    let date_from = value_str(&payload, &["dateFrom", "date_from"]);
    let date_to = value_str(&payload, &["dateTo", "date_to"]);

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    ensure_staff_payments_table(&conn)?;

    let query =
        "SELECT id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at
                 FROM staff_payments
                 WHERE paid_to_staff_id = ?1
                   AND (?2 IS NULL OR substr(created_at, 1, 10) >= ?2)
                   AND (?3 IS NULL OR substr(created_at, 1, 10) <= ?3)
                 ORDER BY created_at DESC";
    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![staff_id, date_from, date_to], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "cashier_shift_id": row.get::<_, String>(1)?,
                "paid_to_staff_id": row.get::<_, String>(2)?,
                "amount": row.get::<_, f64>(3)?,
                "payment_type": row.get::<_, String>(4)?,
                "notes": row.get::<_, Option<String>>(5)?,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let items: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!(items))
}

#[tauri::command]
async fn shift_get_staff_payment_total_for_date(
    arg0: Option<String>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<f64, String> {
    let staff_id = arg0.ok_or("Missing staffId")?;
    let date = arg1.ok_or("Missing date")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    ensure_staff_payments_table(&conn)?;
    let total: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM staff_payments
             WHERE paid_to_staff_id = ?1 AND substr(created_at, 1, 10) = ?2",
            rusqlite::params![staff_id, date],
            |row| row.get(0),
        )
        .unwrap_or(0.0);
    Ok(total)
}

#[tauri::command]
async fn shift_backfill_driver_earnings(
    _arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Read legacy JSON array from local_settings
    let json_str = db::get_setting(&conn, "local", "driver_earnings_v1");
    let entries: Vec<serde_json::Value> = match json_str {
        Some(s) => serde_json::from_str(&s).unwrap_or_default(),
        None => {
            return Ok(
                serde_json::json!({ "message": "No legacy data found", "processed": 0, "total": 0 }),
            )
        }
    };

    let total = entries.len();
    let mut processed = 0i64;

    for entry in &entries {
        let id =
            value_str(entry, &["id"]).unwrap_or_else(|| format!("de-bf-{}", uuid::Uuid::new_v4()));
        let driver_id = match value_str(entry, &["driverId", "driver_id"]) {
            Some(v) => v,
            None => continue,
        };
        let shift_id = value_str(
            entry,
            &["shiftId", "shift_id", "staffShiftId", "staff_shift_id"],
        );
        let order_id = match value_str(entry, &["orderId", "order_id"]) {
            Some(v) => v,
            None => continue,
        };
        let branch_id = value_str(entry, &["branchId", "branch_id"]).unwrap_or_default();
        let delivery_fee = value_f64(entry, &["deliveryFee", "delivery_fee"]).unwrap_or(0.0);
        let tip_amount = value_f64(entry, &["tipAmount", "tip_amount"]).unwrap_or(0.0);
        let total_earning = delivery_fee + tip_amount;
        let payment_method = value_str(entry, &["paymentMethod", "payment_method"])
            .unwrap_or_else(|| "cash".to_string());
        let cash_collected = value_f64(entry, &["cashCollected", "cash_collected"]).unwrap_or(0.0);
        let card_amount = value_f64(entry, &["cardAmount", "card_amount"]).unwrap_or(0.0);
        let cash_to_return = cash_collected - card_amount;
        let order_details = entry
            .get("orderDetails")
            .or_else(|| entry.get("order_details"))
            .map(|v| v.to_string());
        let created_at = value_str(entry, &["createdAt", "created_at"])
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        let updated_at = value_str(entry, &["updatedAt", "updated_at"])
            .unwrap_or_else(|| Utc::now().to_rfc3339());

        let result = conn.execute(
            "INSERT OR IGNORE INTO driver_earnings (
                id, driver_id, staff_shift_id, order_id, branch_id,
                delivery_fee, tip_amount, total_earning,
                payment_method, cash_collected, card_amount, cash_to_return,
                order_details, settled, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?15)",
            params![
                id,
                driver_id,
                shift_id,
                order_id,
                branch_id,
                delivery_fee,
                tip_amount,
                total_earning,
                payment_method,
                cash_collected,
                card_amount,
                cash_to_return,
                order_details,
                created_at,
                updated_at
            ],
        );

        match result {
            Ok(rows) if rows > 0 => processed += 1,
            Ok(_) => {} // INSERT OR IGNORE skipped duplicate
            Err(e) => warn!("Backfill skip for order {order_id}: {e}"),
        }
    }

    // Delete the legacy JSON key after successful backfill
    if processed > 0 || total > 0 {
        let _ = conn.execute(
            "DELETE FROM local_settings WHERE setting_category = 'local' AND setting_key = 'driver_earnings_v1'",
            [],
        );
        info!("Driver earnings backfill complete: {processed}/{total} migrated from JSON to SQL");
    }

    Ok(serde_json::json!({
        "message": "Backfill completed",
        "processed": processed,
        "total": total
    }))
}

#[tauri::command]
async fn shift_get_scheduled_shifts(
    arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let branch_id = value_str(&payload, &["branchId", "branch_id"]).ok_or("Missing branchId")?;
    let start_date =
        value_str(&payload, &["startDate", "start_date"]).ok_or("Missing startDate")?;
    let end_date = value_str(&payload, &["endDate", "end_date"]).ok_or("Missing endDate")?;
    let staff_id = value_str(&payload, &["staffId", "staff_id"]);

    let mut params = vec![
        (
            "select",
            "id,staff_id,branch_id,start_time,end_time,break_start,break_end,status,notes,staff(id,first_name,last_name,staff_code)"
                .to_string(),
        ),
        ("branch_id", format!("eq.{branch_id}")),
        ("start_time", format!("gte.{start_date}")),
        ("start_time", format!("lte.{end_date}")),
        ("order", "start_time.asc".to_string()),
    ];
    if let Some(sid) = staff_id {
        params.push(("staff_id", format!("eq.{sid}")));
    }

    let raw = fetch_supabase_rows("salon_staff_shifts", &params).await?;
    let arr = raw.as_array().cloned().unwrap_or_default();
    let mapped: Vec<serde_json::Value> = arr.iter().map(map_scheduled_shift_row).collect();
    Ok(serde_json::json!(mapped))
}

#[tauri::command]
async fn shift_get_today_scheduled_shifts(
    arg0: Option<String>,
) -> Result<serde_json::Value, String> {
    let branch_id = arg0.ok_or("Missing branchId")?;
    let now_local = Local::now();
    let y = now_local.year();
    let m = now_local.month();
    let d = now_local.day();
    let start_local = Local
        .with_ymd_and_hms(y, m, d, 0, 0, 0)
        .single()
        .ok_or("Failed to compute local start of day")?;
    let end_local = Local
        .with_ymd_and_hms(y, m, d, 23, 59, 59)
        .single()
        .ok_or("Failed to compute local end of day")?;

    let params = vec![
        (
            "select",
            "id,staff_id,branch_id,start_time,end_time,break_start,break_end,status,notes,staff(id,first_name,last_name,staff_code)"
                .to_string(),
        ),
        ("branch_id", format!("eq.{branch_id}")),
        ("start_time", format!("gte.{}", start_local.to_rfc3339())),
        ("start_time", format!("lte.{}", end_local.to_rfc3339())),
        ("order", "start_time.asc".to_string()),
    ];

    let raw = fetch_supabase_rows("salon_staff_shifts", &params).await?;
    let arr = raw.as_array().cloned().unwrap_or_default();
    let mapped: Vec<serde_json::Value> = arr.iter().map(map_scheduled_shift_row).collect();
    Ok(serde_json::json!(mapped))
}

// -- Payments ----------------------------------------------------------------

#[tauri::command]
async fn payment_record(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing payment payload")?;
    payments::record_payment(&db, &payload)
}

#[tauri::command]
async fn payment_void(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing void payment payload")?;
    let payment_id = payload
        .get("paymentId")
        .or_else(|| payload.get("payment_id"))
        .and_then(|v| v.as_str())
        .ok_or("Missing paymentId")?;
    let reason = payload
        .get("reason")
        .and_then(|v| v.as_str())
        .ok_or("Missing reason")?;
    let voided_by = payload
        .get("voidedBy")
        .or_else(|| payload.get("voided_by"))
        .and_then(|v| v.as_str());
    payments::void_payment(&db, payment_id, reason, voided_by)
}

#[tauri::command]
async fn payment_get_order_payments(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = arg0.ok_or("Missing orderId")?;
    payments::get_order_payments(&db, &order_id)
}

#[tauri::command]
async fn payment_get_receipt_preview(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = arg0.ok_or("Missing orderId")?;
    payments::get_receipt_preview(&db, &order_id)
}

// -- Refunds / Adjustments ---------------------------------------------------

#[tauri::command]
async fn refund_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing refund payload")?;
    refunds::refund_payment(&db, &payload)
}

#[tauri::command]
async fn refund_void_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing void payment payload")?;
    let payment_id = payload
        .get("paymentId")
        .or_else(|| payload.get("payment_id"))
        .and_then(|v| v.as_str())
        .ok_or("Missing paymentId")?;
    let reason = payload
        .get("reason")
        .and_then(|v| v.as_str())
        .ok_or("Missing reason")?;
    let staff_id = payload
        .get("staffId")
        .or_else(|| payload.get("staff_id"))
        .and_then(|v| v.as_str());
    refunds::void_payment_with_adjustment(&db, payment_id, reason, staff_id)
}

#[tauri::command]
async fn refund_list_order_adjustments(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = arg0.ok_or("Missing orderId")?;
    refunds::list_order_adjustments(&db, &order_id)
}

#[tauri::command]
async fn refund_get_payment_balance(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payment_id = arg0.ok_or("Missing paymentId")?;
    refunds::get_payment_balance(&db, &payment_id)
}

// -- Z-Reports ---------------------------------------------------------------

#[tauri::command]
async fn zreport_generate(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));

    let has_shift_id = payload.get("shiftId").and_then(|v| v.as_str()).is_some()
        || payload.get("shift_id").and_then(|v| v.as_str()).is_some();
    let has_branch_date = payload.get("branchId").and_then(|v| v.as_str()).is_some()
        || payload.get("date").and_then(|v| v.as_str()).is_some();

    if has_shift_id && !has_branch_date {
        zreport::generate_z_report(&db, &payload)
    } else {
        zreport::generate_z_report_for_date(&db, &payload)
    }
}

#[tauri::command]
async fn zreport_get(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    zreport::get_z_report(&db, &payload)
}

#[tauri::command]
async fn zreport_list(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    zreport::list_z_reports(&db, &payload)
}

#[tauri::command]
async fn zreport_print(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    zreport::print_z_report(&db, &payload)
}

// -- Print -------------------------------------------------------------------

#[tauri::command]
async fn payment_print_receipt(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    // Accept either { orderId } payload or a plain order ID string
    let order_id = match &arg0 {
        Some(serde_json::Value::Object(obj)) => obj
            .get("orderId")
            .or_else(|| obj.get("order_id"))
            .and_then(|v| v.as_str())
            .map(String::from),
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        _ => None,
    }
    .ok_or("Missing orderId")?;

    print::enqueue_print_job(&db, "order_receipt", &order_id, None)
}

#[tauri::command]
async fn kitchen_print_ticket(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = match &arg0 {
        Some(serde_json::Value::Object(obj)) => obj
            .get("orderId")
            .or_else(|| obj.get("order_id"))
            .and_then(|v| v.as_str())
            .map(String::from),
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        _ => None,
    }
    .ok_or("Missing orderId")?;

    print::enqueue_print_job(&db, "kitchen_ticket", &order_id, None)
}

#[tauri::command]
async fn print_list_jobs(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    print::list_print_jobs(&db, arg0.as_deref())
}

#[tauri::command]
async fn print_get_receipt_file(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let order_id = arg0.ok_or("Missing orderId")?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let path = print::generate_receipt_file(&db, &order_id, &data_dir)?;
    Ok(serde_json::json!({
        "success": true,
        "path": path,
    }))
}

// -- Printer profiles --------------------------------------------------------

#[tauri::command]
async fn printer_list_system_printers() -> Result<serde_json::Value, String> {
    let names = printers::list_system_printers();
    Ok(serde_json::json!({
        "success": true,
        "printers": names,
    }))
}

#[tauri::command]
async fn printer_create_profile(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing printer profile payload")?;
    printers::create_printer_profile(&db, &payload)
}

#[tauri::command]
async fn printer_update_profile(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing printer profile payload")?;
    printers::update_printer_profile(&db, &payload)
}

#[tauri::command]
async fn printer_delete_profile(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let id = arg0.ok_or("Missing profileId")?;
    printers::delete_printer_profile(&db, &id)
}

#[tauri::command]
async fn printer_list_profiles(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    printers::list_printer_profiles(&db)
}

#[tauri::command]
async fn printer_get_profile(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let id = arg0.ok_or("Missing profileId")?;
    printers::get_printer_profile(&db, &id)
}

#[tauri::command]
async fn printer_set_default_profile(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let id = arg0.ok_or("Missing profileId")?;
    printers::set_default_printer_profile(&db, &id)
}

#[tauri::command]
async fn printer_get_default_profile(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    printers::get_default_printer_profile(&db)
}

#[tauri::command]
async fn print_reprint_job(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let job_id = arg0.ok_or("Missing jobId")?;
    printers::reprint_job(&db, &job_id)
}

// -- Screen Capture ----------------------------------------------------------

#[tauri::command]
async fn screen_capture_get_sources(
    _arg0: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let _ = app.emit(
        "screen_capture_start",
        serde_json::json!({ "source": "get_sources" }),
    );
    Ok(serde_json::json!({
        "success": true,
        "sources": [{
            "id": "primary",
            "name": "Primary Screen",
            "display_id": "primary"
        }]
    }))
    .inspect(|_payload| {
        let _ = app.emit(
            "screen_capture_stop",
            serde_json::json!({ "source": "get_sources" }),
        );
    })
}

// -- Geo ---------------------------------------------------------------------

#[tauri::command]
async fn geo_ip() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // Primary provider
    if let Ok(resp) = client.get("https://ipapi.co/json/").send().await {
        if resp.status().is_success() {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                if let (Some(lat), Some(lng)) = (
                    v.get("latitude").and_then(|x| x.as_f64()),
                    v.get("longitude").and_then(|x| x.as_f64()),
                ) {
                    return Ok(serde_json::json!({
                        "ok": true,
                        "latitude": lat,
                        "longitude": lng
                    }));
                }
            }
        }
    }

    // Fallback provider
    if let Ok(resp) = client.get("https://ipwho.is/").send().await {
        if resp.status().is_success() {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                if let (Some(lat), Some(lng)) = (
                    v.get("latitude").and_then(|x| x.as_f64()),
                    v.get("longitude").and_then(|x| x.as_f64()),
                ) {
                    return Ok(serde_json::json!({
                        "ok": true,
                        "latitude": lat,
                        "longitude": lng
                    }));
                }
            }
        }
    }

    Ok(serde_json::json!({ "ok": false }))
}

// -- ECR ---------------------------------------------------------------------

#[tauri::command]
async fn ecr_discover_devices(
    _arg0: Option<Vec<String>>,
    _arg1: Option<u64>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let devices = read_ecr_devices(&db)?;
    Ok(serde_json::json!({
        "success": true,
        "devices": devices
    }))
}

#[tauri::command]
async fn ecr_get_devices(db: tauri::State<'_, db::DbState>) -> Result<serde_json::Value, String> {
    let devices = read_ecr_devices(&db)?;
    Ok(serde_json::json!({
        "success": true,
        "devices": devices
    }))
}

#[tauri::command]
async fn ecr_get_device(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let device_id = arg0.ok_or("Missing deviceId")?;
    let devices = read_ecr_devices(&db)?;
    let device = devices.into_iter().find(|d| {
        d.get("id")
            .and_then(|v| v.as_str())
            .map(|id| id == device_id)
            .unwrap_or(false)
    });
    Ok(serde_json::json!({
        "success": device.is_some(),
        "device": device,
        "error": if device.is_none() { serde_json::json!("Device not found") } else { serde_json::Value::Null }
    }))
}

#[tauri::command]
async fn ecr_add_device(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let mut config = arg0.unwrap_or(serde_json::json!({}));
    let device_id = config
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("ecr-{}", &uuid::Uuid::new_v4().to_string()[..8]));
    if let Some(obj) = config.as_object_mut() {
        obj.insert(
            "id".to_string(),
            serde_json::Value::String(device_id.clone()),
        );
        obj.entry("connected".to_string())
            .or_insert(serde_json::json!(false));
        obj.entry("status".to_string())
            .or_insert(serde_json::json!("disconnected"));
    } else {
        config = serde_json::json!({
            "id": device_id,
            "connected": false,
            "status": "disconnected"
        });
    }

    let mut devices = read_ecr_devices(&db)?;
    devices.retain(|d| {
        d.get("id")
            .and_then(|v| v.as_str())
            .map(|id| id != device_id)
            .unwrap_or(true)
    });
    devices.push(config.clone());
    write_ecr_devices(&db, &devices)?;

    Ok(serde_json::json!({
        "success": true,
        "device": config
    }))
}

#[tauri::command]
async fn ecr_update_device(
    arg0: Option<String>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let device_id = arg0.ok_or("Missing deviceId")?;
    let updates = arg1.unwrap_or(serde_json::json!({}));

    let mut devices = read_ecr_devices(&db)?;
    let mut updated_device: Option<serde_json::Value> = None;
    for device in &mut devices {
        let is_target = device
            .get("id")
            .and_then(|v| v.as_str())
            .map(|id| id == device_id)
            .unwrap_or(false);
        if !is_target {
            continue;
        }
        if let (Some(dst), Some(src)) = (device.as_object_mut(), updates.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
        updated_device = Some(device.clone());
        break;
    }

    if updated_device.is_none() {
        return Ok(serde_json::json!({
            "success": false,
            "error": "Device not found"
        }));
    }
    write_ecr_devices(&db, &devices)?;
    let _ = app.emit(
        "ecr_event_device_status_changed",
        serde_json::json!({
            "deviceId": device_id,
            "device": updated_device
        }),
    );

    Ok(serde_json::json!({
        "success": true,
        "device": updated_device
    }))
}

#[tauri::command]
async fn ecr_remove_device(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let device_id = arg0.ok_or("Missing deviceId")?;
    let mut devices = read_ecr_devices(&db)?;
    let before = devices.len();
    devices.retain(|d| {
        d.get("id")
            .and_then(|v| v.as_str())
            .map(|id| id != device_id)
            .unwrap_or(true)
    });
    let removed = before.saturating_sub(devices.len());
    write_ecr_devices(&db, &devices)?;
    Ok(serde_json::json!({
        "success": removed > 0,
        "removed": removed
    }))
}

#[tauri::command]
async fn ecr_get_default_terminal(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let devices = read_ecr_devices(&db)?;
    let connected = devices.iter().find(|d| {
        d.get("connected")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    });
    let default_device = connected.cloned().or_else(|| devices.first().cloned());
    Ok(serde_json::json!({
        "success": default_device.is_some(),
        "device": default_device
    }))
}

#[tauri::command]
async fn ecr_connect_device(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let device_id = arg0.ok_or("Missing deviceId")?;
    let mut devices = read_ecr_devices(&db)?;
    let mut found = false;
    for device in &mut devices {
        let is_target = device
            .get("id")
            .and_then(|v| v.as_str())
            .map(|id| id == device_id)
            .unwrap_or(false);
        if !is_target {
            continue;
        }
        if let Some(obj) = device.as_object_mut() {
            obj.insert("connected".to_string(), serde_json::json!(true));
            obj.insert("status".to_string(), serde_json::json!("connected"));
        }
        found = true;
    }
    if found {
        write_ecr_devices(&db, &devices)?;
        let _ = app.emit(
            "ecr_event_device_connected",
            serde_json::json!({ "deviceId": device_id }),
        );
        let _ = app.emit(
            "ecr_event_device_status_changed",
            serde_json::json!({
                "deviceId": device_id,
                "status": "connected"
            }),
        );
    }
    Ok(serde_json::json!({
        "success": found
    }))
}

#[tauri::command]
async fn ecr_disconnect_device(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let device_id = arg0.ok_or("Missing deviceId")?;
    let mut devices = read_ecr_devices(&db)?;
    let mut found = false;
    for device in &mut devices {
        let is_target = device
            .get("id")
            .and_then(|v| v.as_str())
            .map(|id| id == device_id)
            .unwrap_or(false);
        if !is_target {
            continue;
        }
        if let Some(obj) = device.as_object_mut() {
            obj.insert("connected".to_string(), serde_json::json!(false));
            obj.insert("status".to_string(), serde_json::json!("disconnected"));
        }
        found = true;
    }
    if found {
        write_ecr_devices(&db, &devices)?;
        let _ = app.emit(
            "ecr_event_device_disconnected",
            serde_json::json!({ "deviceId": device_id }),
        );
        let _ = app.emit(
            "ecr_event_device_status_changed",
            serde_json::json!({
                "deviceId": device_id,
                "status": "disconnected"
            }),
        );
    }
    Ok(serde_json::json!({
        "success": found
    }))
}

#[tauri::command]
async fn ecr_get_device_status(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let device_id = arg0.ok_or("Missing deviceId")?;
    let devices = read_ecr_devices(&db)?;
    let device = devices.into_iter().find(|d| {
        d.get("id")
            .and_then(|v| v.as_str())
            .map(|id| id == device_id)
            .unwrap_or(false)
    });
    let connected = device
        .as_ref()
        .and_then(|d| d.get("connected"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let status = device
        .as_ref()
        .and_then(|d| d.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or(if connected {
            "connected"
        } else {
            "disconnected"
        });
    Ok(serde_json::json!({
        "success": device.is_some(),
        "deviceId": device_id,
        "connected": connected,
        "status": status
    }))
}

#[tauri::command]
async fn ecr_get_all_statuses(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let devices = read_ecr_devices(&db)?;
    let statuses: Vec<serde_json::Value> = devices
        .iter()
        .map(|d| {
            let device_id = d.get("id").cloned().unwrap_or(serde_json::Value::Null);
            let connected = d
                .get("connected")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let status = d.get("status").cloned().unwrap_or_else(|| {
                serde_json::json!(if connected {
                    "connected"
                } else {
                    "disconnected"
                })
            });
            serde_json::json!({
                "deviceId": device_id,
                "connected": connected,
                "status": status
            })
        })
        .collect();
    Ok(serde_json::json!({
        "success": true,
        "statuses": statuses
    }))
}

#[tauri::command]
async fn ecr_process_payment(
    arg0: Option<f64>,
    arg1: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let amount = arg0.unwrap_or(0.0);
    let options = arg1.unwrap_or(serde_json::json!({}));
    let _ = app.emit(
        "ecr_event_transaction_started",
        serde_json::json!({
            "type": "payment",
            "amount": amount
        }),
    );
    let _ = app.emit(
        "ecr_event_transaction_status",
        serde_json::json!({
            "status": "processing",
            "type": "payment"
        }),
    );
    let transaction = serde_json::json!({
        "id": format!("txn-{}", uuid::Uuid::new_v4()),
        "amount": amount,
        "status": "approved"
    });
    let _ = app.emit("ecr_event_transaction_completed", transaction.clone());
    let _ = app.emit(
        "ecr_event_display_message",
        serde_json::json!({
            "message": "Payment approved"
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "transaction": transaction,
        "options": options
    }))
}

#[tauri::command]
async fn ecr_process_refund(
    arg0: Option<f64>,
    arg1: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let amount = arg0.unwrap_or(0.0);
    let options = arg1.unwrap_or(serde_json::json!({}));
    let _ = app.emit(
        "ecr_event_transaction_started",
        serde_json::json!({
            "type": "refund",
            "amount": amount
        }),
    );
    let _ = app.emit(
        "ecr_event_transaction_status",
        serde_json::json!({
            "status": "processing",
            "type": "refund"
        }),
    );
    let transaction = serde_json::json!({
        "id": format!("txn-{}", uuid::Uuid::new_v4()),
        "amount": amount,
        "status": "approved"
    });
    let _ = app.emit("ecr_event_transaction_completed", transaction.clone());
    let _ = app.emit(
        "ecr_event_display_message",
        serde_json::json!({
            "message": "Refund approved"
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "transaction": transaction,
        "options": options
    }))
}

#[tauri::command]
async fn ecr_void_transaction(
    arg0: Option<String>,
    arg1: Option<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let txid = arg0.unwrap_or_default();
    if txid.is_empty() {
        let _ = app.emit(
            "ecr_event_error",
            serde_json::json!({
                "error": "Missing transactionId"
            }),
        );
        return Err("Missing transactionId".into());
    }
    let _ = app.emit(
        "ecr_event_transaction_status",
        serde_json::json!({
            "status": "voided",
            "transactionId": txid
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "transactionId": txid,
        "deviceId": arg1
    }))
}

#[tauri::command]
async fn ecr_cancel_transaction(
    arg0: Option<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let _ = app.emit(
        "ecr_event_transaction_status",
        serde_json::json!({
            "status": "cancelled",
            "deviceId": arg0
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "deviceId": arg0,
        "cancelled": true
    }))
}

#[tauri::command]
async fn ecr_settlement(
    arg0: Option<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let _ = app.emit(
        "ecr_event_display_message",
        serde_json::json!({
            "message": "Settlement started",
            "deviceId": arg0
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "deviceId": arg0
    }))
}

#[tauri::command]
async fn ecr_get_recent_transactions(_arg0: Option<i64>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": true,
        "transactions": []
    }))
}

#[tauri::command]
async fn ecr_query_transactions(
    _arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": true,
        "transactions": []
    }))
}

#[tauri::command]
async fn ecr_get_transaction_stats(
    _arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": true,
        "count": 0,
        "totalAmount": 0
    }))
}

#[tauri::command]
async fn ecr_get_transaction_for_order(_arg0: Option<String>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": true,
        "transaction": serde_json::Value::Null
    }))
}

// -- Dashboard metrics -------------------------------------------------------

#[tauri::command]
async fn inventory_get_stock_metrics() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": false,
        "notImplemented": true,
        "message": "Inventory service not yet implemented",
        "inStock": 0,
        "lowStock": 0,
        "outOfStock": 0,
    }))
}

#[tauri::command]
async fn products_get_catalog_count() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": false,
        "notImplemented": true,
        "message": "Product catalog service not yet implemented",
        "total": 0,
    }))
}

// -- Cash drawer -------------------------------------------------------------

#[tauri::command]
async fn drawer_open(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    drawer::open_cash_drawer(&db, arg0.as_deref())
}

// -- Modules -----------------------------------------------------------------

#[tauri::command]
async fn modules_fetch_from_admin(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);

    let terminal_id = storage::get_credential("terminal_id")
        .or_else(|| read_local_setting(&db, "terminal", "terminal_id"))
        .ok_or("Terminal not configured: missing terminal_id")?;
    if storage::get_credential("terminal_id").is_none() && !terminal_id.trim().is_empty() {
        let _ = storage::set_credential("terminal_id", &terminal_id);
    }
    let path = format!("/api/pos/modules/enabled?terminal_id={terminal_id}");

    match admin_fetch(Some(&db), &path, "GET", None).await {
        Ok(resp) => {
            let payload = if let Some(data) = resp.get("data") {
                data
            } else {
                &resp
            };

            let api_modules = payload
                .get("modules")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let organization_id = payload
                .get("organization_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| storage::get_credential("organization_id"))
                .unwrap_or_default();
            if !organization_id.trim().is_empty() {
                let _ = storage::set_credential("organization_id", &organization_id);
            }
            if let Some(server_terminal_id) = payload.get("terminal_id").and_then(|v| v.as_str()) {
                let trimmed = server_terminal_id.trim();
                if !trimmed.is_empty() {
                    let _ = storage::set_credential("terminal_id", trimmed);
                }
            }
            let api_timestamp = payload
                .get("timestamp")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            let stats = payload
                .get("stats")
                .cloned()
                .unwrap_or_else(|| stats_for_modules(&api_modules));
            let processing_time_ms = payload
                .get("processing_time_ms")
                .cloned()
                .unwrap_or_else(|| serde_json::json!(0));

            let cache_payload = serde_json::json!({
                "apiModules": api_modules,
                "organizationId": organization_id,
                "terminalId": terminal_id,
                "timestamp": Utc::now().timestamp_millis(),
                "apiTimestamp": api_timestamp,
            });
            let _ = write_module_cache(&db, &cache_payload);
            let _ = app.emit(
                "modules_sync_complete",
                serde_json::json!({
                    "count": cache_payload
                        .get("apiModules")
                        .and_then(|v| v.as_array())
                        .map(|v| v.len())
                        .unwrap_or(0)
                }),
            );

            Ok(serde_json::json!({
                "success": true,
                "modules": {
                    "success": true,
                    "modules": cache_payload.get("apiModules").cloned().unwrap_or_else(|| serde_json::json!([])),
                    "organization_id": cache_payload.get("organizationId").cloned().unwrap_or_else(|| serde_json::json!("")),
                    "terminal_id": cache_payload.get("terminalId").cloned().unwrap_or_else(|| serde_json::json!("")),
                    "timestamp": cache_payload.get("apiTimestamp").cloned().unwrap_or_else(|| serde_json::json!(Utc::now().to_rfc3339())),
                    "stats": stats,
                    "processing_time_ms": processing_time_ms,
                },
                "fromCache": false
            }))
        }
        Err(fetch_err) => match read_module_cache(&db) {
            Ok(cache) => {
                let api_modules = cache
                    .get("apiModules")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let organization_id = cache
                    .get("organizationId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let terminal_id_cached = cache
                    .get("terminalId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let api_timestamp = cache
                    .get("apiTimestamp")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                Ok(serde_json::json!({
                    "success": true,
                    "modules": {
                        "success": true,
                        "modules": api_modules,
                        "organization_id": organization_id,
                        "terminal_id": terminal_id_cached,
                        "timestamp": api_timestamp,
                        "stats": stats_for_modules(
                            cache
                                .get("apiModules")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.as_slice())
                                .unwrap_or(&[])
                        ),
                        "processing_time_ms": 0,
                    },
                    "fromCache": true,
                    "error": fetch_err
                }))
            }
            Err(_) => {
                let _ = app.emit(
                    "modules_sync_error",
                    serde_json::json!({ "error": fetch_err }),
                );
                Ok(serde_json::json!({
                    "success": false,
                    "error": fetch_err,
                    "modules": serde_json::Value::Null
                }))
            }
        },
    }
}

#[tauri::command]
async fn modules_get_cached(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let cache = match read_module_cache(&db) {
        Ok(c) => c,
        Err(_) => {
            return Ok(serde_json::json!({
                "success": false,
                "error": "No cached modules found",
                "modules": serde_json::Value::Null,
                "isValid": false
            }))
        }
    };

    let api_modules = cache
        .get("apiModules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let organization_id = cache
        .get("organizationId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let terminal_id = cache
        .get("terminalId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let api_timestamp = cache
        .get("apiTimestamp")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cached_at = cache.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
    let now = Utc::now().timestamp_millis();
    let cache_age = (now - cached_at).max(0);
    let is_valid = cache_age < MODULE_CACHE_TTL_MS;

    Ok(serde_json::json!({
        "success": true,
        "modules": {
            "success": true,
            "modules": api_modules,
            "organization_id": organization_id,
            "terminal_id": terminal_id,
            "timestamp": api_timestamp,
            "stats": stats_for_modules(
                cache
                    .get("apiModules")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.as_slice())
                    .unwrap_or(&[])
            ),
            "processing_time_ms": 0,
        },
        "isValid": is_valid,
        "cacheAge": cache_age
    }))
}

#[tauri::command]
async fn modules_save_cache(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let modules = match &payload {
        serde_json::Value::Array(arr) => arr.clone(),
        serde_json::Value::Object(_) => payload
            .get("modules")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };

    let organization_id = value_str(&payload, &["organizationId", "organization_id"])
        .or_else(|| storage::get_credential("organization_id"))
        .unwrap_or_default();
    let terminal_id = value_str(&payload, &["terminalId", "terminal_id"])
        .or_else(|| storage::get_credential("terminal_id"))
        .unwrap_or_default();
    let api_timestamp = value_str(&payload, &["apiTimestamp", "api_timestamp", "timestamp"])
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    let cache_payload = serde_json::json!({
        "apiModules": modules,
        "organizationId": organization_id,
        "terminalId": terminal_id,
        "timestamp": Utc::now().timestamp_millis(),
        "apiTimestamp": api_timestamp,
    });
    write_module_cache(&db, &cache_payload)?;
    let _ = app.emit(
        "modules_refresh_needed",
        serde_json::json!({
            "count": cache_payload
                .get("apiModules")
                .and_then(|v| v.as_array())
                .map(|v| v.len())
                .unwrap_or(0)
        }),
    );

    Ok(serde_json::json!({ "success": true }))
}

fn read_system_clipboard_text() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-Clipboard -Raw",
            ])
            .output()
            .map_err(|e| format!("read clipboard: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).to_string();
            return Err(format!("read clipboard failed: {err}"));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end_matches(['\r', '\n'])
            .to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Clipboard read is not implemented on this platform".into())
    }
}

fn write_system_clipboard_text(text: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        use std::process::Stdio;
        let mut child = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("write clipboard spawn: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("write clipboard stdin: {e}"))?;
        }
        let output = child
            .wait_with_output()
            .map_err(|e| format!("write clipboard wait: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).to_string();
            return Err(format!("write clipboard failed: {err}"));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = text;
        Err("Clipboard write is not implemented on this platform".into())
    }
}

// -- Compatibility utility commands -----------------------------------------

#[tauri::command]
async fn clipboard_read_text(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    match read_system_clipboard_text() {
        Ok(text) => {
            let _ = write_local_json(&db, "clipboard_fallback_text", &serde_json::json!(text));
            Ok(serde_json::json!(text))
        }
        Err(_) => {
            let fallback = read_local_json(&db, "clipboard_fallback_text")?;
            Ok(serde_json::json!(fallback
                .as_str()
                .unwrap_or_default()
                .to_string()))
        }
    }
}

#[tauri::command]
async fn clipboard_write_text(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let text = arg0.unwrap_or_default();
    let _ = write_local_json(&db, "clipboard_fallback_text", &serde_json::json!(text));
    let _ = write_system_clipboard_text(&text);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn show_notification(arg0: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let title = value_str(&payload, &["title"]).unwrap_or_else(|| "The Small POS".to_string());
    let body = value_str(&payload, &["body", "message"]).unwrap_or_default();
    info!(title = %title, body = %body, "show-notification requested");
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn update_settings(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
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
async fn customer_get_cache_stats(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    Ok(serde_json::json!({
        "total": cache.len(),
        "valid": cache.len(),
        "expired": 0
    }))
}

#[tauri::command]
async fn customer_clear_cache(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let existing = read_local_json_array(&db, "customer_cache_v1")?;
    let count = existing.len();
    write_local_json(&db, "customer_cache_v1", &serde_json::json!([]))?;
    let _ = app.emit("customer_deleted", serde_json::json!({ "count": count }));
    Ok(serde_json::json!({ "success": true, "cleared": count }))
}

#[tauri::command]
async fn customer_invalidate_cache(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let phone = arg0.ok_or("Missing phone")?;
    let phone_norm = normalize_phone(&phone);
    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    let before = cache.len();
    cache.retain(|entry| {
        let p = value_str(entry, &["phone", "customerPhone", "mobile", "telephone"])
            .map(|s| normalize_phone(&s))
            .unwrap_or_default();
        p != phone_norm
    });
    let removed = before.saturating_sub(cache.len());
    write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
    if removed > 0 {
        let _ = app.emit(
            "customer_deleted",
            serde_json::json!({ "removed": removed }),
        );
    }
    Ok(serde_json::json!({ "success": true, "removed": removed }))
}

#[tauri::command]
async fn customer_lookup_by_phone(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let phone = arg0.ok_or("Missing phone")?;
    let phone_norm = normalize_phone(&phone);
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    if let Some(found) = cache.into_iter().find(|entry| {
        value_str(entry, &["phone", "customerPhone", "mobile", "telephone"])
            .map(|s| normalize_phone(&s))
            .map(|s| s == phone_norm)
            .unwrap_or(false)
    }) {
        return Ok(found);
    }

    // Fallback from local orders history.
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT customer_name, customer_phone, customer_email
             FROM orders
             WHERE customer_phone IS NOT NULL
               AND replace(replace(replace(replace(customer_phone, '-', ''), ' ', ''), '(', ''), ')', '') LIKE ?1
             ORDER BY updated_at DESC
             LIMIT 1",
            rusqlite::params![format!("%{phone_norm}%")],
            |row| {
                Ok(serde_json::json!({
                    "id": format!("cust-{}", uuid::Uuid::new_v4()),
                    "name": row.get::<_, Option<String>>(0)?,
                    "phone": row.get::<_, Option<String>>(1)?,
                    "email": row.get::<_, Option<String>>(2)?,
                    "source": "orders_fallback"
                }))
            },
        )
        .ok();
    Ok(row.unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
async fn customer_lookup_by_id(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let customer_id = arg0.ok_or("Missing customerId")?;
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    let found = cache.into_iter().find(|entry| {
        value_str(entry, &["id", "customerId"])
            .map(|id| id == customer_id)
            .unwrap_or(false)
    });
    Ok(found.unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
async fn customer_search(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let query = arg0.unwrap_or_default().to_lowercase();
    if query.is_empty() {
        return Ok(serde_json::json!([]));
    }
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    let matches: Vec<serde_json::Value> = cache
        .into_iter()
        .filter(|entry| {
            let name = value_str(entry, &["name", "fullName"])
                .unwrap_or_default()
                .to_lowercase();
            let phone = value_str(entry, &["phone", "customerPhone"])
                .unwrap_or_default()
                .to_lowercase();
            let email = value_str(entry, &["email"])
                .unwrap_or_default()
                .to_lowercase();
            name.contains(&query) || phone.contains(&query) || email.contains(&query)
        })
        .collect();
    Ok(serde_json::json!(matches))
}

#[tauri::command]
async fn customer_create(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let mut customer = payload;
    let customer_id = value_str(&customer, &["id", "customerId"])
        .unwrap_or_else(|| format!("cust-{}", uuid::Uuid::new_v4()));
    if let Some(obj) = customer.as_object_mut() {
        obj.insert("id".to_string(), serde_json::json!(customer_id));
        obj.entry("version".to_string())
            .or_insert(serde_json::json!(1));
        obj.entry("createdAt".to_string())
            .or_insert(serde_json::json!(Utc::now().to_rfc3339()));
        obj.insert(
            "updatedAt".to_string(),
            serde_json::json!(Utc::now().to_rfc3339()),
        );
        obj.entry("addresses".to_string())
            .or_insert(serde_json::json!([]));
    }
    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    cache.retain(|entry| {
        value_str(entry, &["id", "customerId"])
            .map(|id| id != customer_id)
            .unwrap_or(true)
    });
    cache.push(customer.clone());
    write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
    let _ = app.emit("customer_created", customer.clone());
    let _ = app.emit("customer_realtime_update", customer.clone());
    Ok(serde_json::json!({ "success": true, "data": customer }))
}

#[tauri::command]
async fn customer_update(
    arg0: Option<String>,
    arg1: Option<serde_json::Value>,
    arg2: Option<i64>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let customer_id = arg0.ok_or("Missing customerId")?;
    let updates = arg1.unwrap_or(serde_json::json!({}));
    let expected_version = arg2.unwrap_or(0);
    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;

    let mut updated_customer: Option<serde_json::Value> = None;
    let mut conflict: Option<serde_json::Value> = None;
    for entry in &mut cache {
        let id = value_str(entry, &["id", "customerId"]).unwrap_or_default();
        if id != customer_id {
            continue;
        }
        let current_version = entry.get("version").and_then(|v| v.as_i64()).unwrap_or(1);
        if expected_version > 0 && expected_version != current_version {
            conflict = Some(serde_json::json!({
                "id": format!("cc-{}", uuid::Uuid::new_v4()),
                "customerId": customer_id,
                "expectedVersion": expected_version,
                "currentVersion": current_version,
                "updates": updates
            }));
            break;
        }
        if let (Some(dst), Some(src)) = (entry.as_object_mut(), updates.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
            dst.insert(
                "version".to_string(),
                serde_json::json!(current_version + 1),
            );
            dst.insert(
                "updatedAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
        }
        updated_customer = Some(entry.clone());
        break;
    }

    if let Some(conflict_payload) = conflict {
        let mut conflicts = read_local_json_array(&db, "customer_conflicts_v1")?;
        conflicts.push(conflict_payload.clone());
        write_local_json(
            &db,
            "customer_conflicts_v1",
            &serde_json::Value::Array(conflicts),
        )?;
        let _ = app.emit("customer_sync_conflict", conflict_payload.clone());
        return Ok(serde_json::json!({
            "success": false,
            "conflict": true,
            "error": "Version conflict",
            "data": conflict_payload
        }));
    }

    if let Some(customer) = updated_customer.clone() {
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
        return Ok(serde_json::json!({ "success": true, "data": customer }));
    }

    Err("Customer not found".into())
}

#[tauri::command]
async fn customer_update_ban_status(
    arg0: Option<String>,
    arg1: Option<bool>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let customer_id = arg0.ok_or("Missing customerId")?;
    let is_banned = arg1.unwrap_or(false);
    customer_update(
        Some(customer_id),
        Some(serde_json::json!({ "isBanned": is_banned })),
        None,
        db,
        app,
    )
    .await
}

#[tauri::command]
async fn customer_add_address(
    arg0: Option<String>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let customer_id = arg0.ok_or("Missing customerId")?;
    let mut address = arg1.unwrap_or(serde_json::json!({}));
    if let Some(obj) = address.as_object_mut() {
        obj.entry("id".to_string())
            .or_insert_with(|| serde_json::json!(format!("addr-{}", uuid::Uuid::new_v4())));
        obj.entry("createdAt".to_string())
            .or_insert_with(|| serde_json::json!(Utc::now().to_rfc3339()));
    }

    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    let mut updated: Option<serde_json::Value> = None;
    for entry in &mut cache {
        let id = value_str(entry, &["id", "customerId"]).unwrap_or_default();
        if id != customer_id {
            continue;
        }
        if let Some(obj) = entry.as_object_mut() {
            let addresses = obj
                .entry("addresses".to_string())
                .or_insert_with(|| serde_json::json!([]));
            if let Some(arr) = addresses.as_array_mut() {
                arr.push(address.clone());
            }
            let next_version = obj.get("version").and_then(|v| v.as_i64()).unwrap_or(1) + 1;
            obj.insert("version".to_string(), serde_json::json!(next_version));
            obj.insert(
                "updatedAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
            updated = Some(serde_json::Value::Object(obj.clone()));
        }
        break;
    }

    if let Some(customer) = updated.clone() {
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
        return Ok(serde_json::json!({ "success": true, "data": customer }));
    }
    Err("Customer not found".into())
}

#[tauri::command]
async fn customer_update_address(
    arg0: Option<String>,
    arg1: Option<serde_json::Value>,
    arg2: Option<i64>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let target_id = arg0.ok_or("Missing customerId/addressId")?;
    let updates = arg1.unwrap_or(serde_json::json!({}));
    let _expected_version = arg2.unwrap_or(0);
    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    let mut updated: Option<serde_json::Value> = None;

    for entry in &mut cache {
        let customer_id = value_str(entry, &["id", "customerId"]).unwrap_or_default();
        if let Some(obj) = entry.as_object_mut() {
            let mut touched = customer_id == target_id;
            if let Some(addresses) = obj.get_mut("addresses").and_then(|v| v.as_array_mut()) {
                for addr in addresses {
                    let aid = value_str(addr, &["id", "addressId"]).unwrap_or_default();
                    if aid == target_id {
                        if let (Some(dst), Some(src)) = (addr.as_object_mut(), updates.as_object())
                        {
                            for (k, v) in src {
                                dst.insert(k.clone(), v.clone());
                            }
                        }
                        touched = true;
                        break;
                    }
                }
            }
            if touched {
                let next_version = obj.get("version").and_then(|v| v.as_i64()).unwrap_or(1) + 1;
                obj.insert("version".to_string(), serde_json::json!(next_version));
                obj.insert(
                    "updatedAt".to_string(),
                    serde_json::json!(Utc::now().to_rfc3339()),
                );
                updated = Some(serde_json::Value::Object(obj.clone()));
                break;
            }
        }
    }

    if let Some(customer) = updated.clone() {
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
        return Ok(serde_json::json!({ "success": true, "data": customer }));
    }
    Err("Customer/address not found".into())
}

#[tauri::command]
async fn customer_get_conflicts(
    _arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conflicts = read_local_json_array(&db, "customer_conflicts_v1")?;
    Ok(serde_json::json!(conflicts))
}

#[tauri::command]
async fn customer_resolve_conflict(
    arg0: Option<String>,
    arg1: Option<String>,
    arg2: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conflict_id = arg0.ok_or("Missing conflictId")?;
    let strategy = arg1.unwrap_or_else(|| "server_wins".to_string());
    let data = arg2.unwrap_or(serde_json::json!({}));
    let mut conflicts = read_local_json_array(&db, "customer_conflicts_v1")?;
    let mut resolved: Option<serde_json::Value> = None;
    conflicts.retain(|entry| {
        let id = value_str(entry, &["id", "conflictId"]).unwrap_or_default();
        if id == conflict_id {
            resolved = Some(entry.clone());
            false
        } else {
            true
        }
    });
    write_local_json(
        &db,
        "customer_conflicts_v1",
        &serde_json::Value::Array(conflicts),
    )?;

    if let Some(conflict) = resolved.clone() {
        if strategy == "merge" || strategy == "client_wins" {
            if let Some(customer_id) = value_str(&conflict, &["customerId", "customer_id"]) {
                let _ = customer_update(Some(customer_id), Some(data), None, db, app.clone()).await;
            }
        }
        let _ = app.emit(
            "customer_conflict_resolved",
            serde_json::json!({
                "conflictId": conflict_id,
                "strategy": strategy
            }),
        );
        return Ok(serde_json::json!({ "success": true }));
    }
    Ok(serde_json::json!({ "success": false, "error": "Conflict not found" }))
}

#[tauri::command]
async fn driver_record_earning(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let id = value_str(&payload, &["id"]).unwrap_or_else(|| format!("de-{}", uuid::Uuid::new_v4()));
    let driver_id = value_str(&payload, &["driverId", "driver_id"]).ok_or("Missing driverId")?;
    let shift_id = value_str(
        &payload,
        &["shiftId", "shift_id", "staffShiftId", "staff_shift_id"],
    );
    let order_id = value_str(&payload, &["orderId", "order_id"]).ok_or("Missing orderId")?;
    let delivery_fee = value_f64(&payload, &["deliveryFee", "delivery_fee"]).unwrap_or(0.0);
    let tip_amount = value_f64(&payload, &["tipAmount", "tip_amount"]).unwrap_or(0.0);
    let payment_method = value_str(&payload, &["paymentMethod", "payment_method"])
        .unwrap_or_else(|| "cash".to_string());
    let cash_collected = value_f64(&payload, &["cashCollected", "cash_collected"]).unwrap_or(0.0);
    let card_amount = value_f64(&payload, &["cardAmount", "card_amount"]).unwrap_or(0.0);

    let total_earning = delivery_fee + tip_amount;
    let cash_to_return = cash_collected - card_amount;
    let now = Utc::now().to_rfc3339();

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Validate shift exists and is active (if provided)
    if let Some(ref sid) = shift_id {
        let status: Option<String> = conn
            .query_row(
                "SELECT status FROM staff_shifts WHERE id = ?1",
                params![sid],
                |row| row.get(0),
            )
            .ok();
        match status.as_deref() {
            None => return Err("Shift not found".to_string()),
            Some(s) if s != "active" => {
                return Err("Cannot record earnings on inactive shift".to_string())
            }
            _ => {}
        }
    }

    // Check for duplicate order_id
    let existing: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM driver_earnings WHERE order_id = ?1",
            params![order_id],
            |row| row.get::<_, i32>(0),
        )
        .unwrap_or(0)
        > 0;
    if existing {
        return Err("Earning already recorded for this order".to_string());
    }

    // Resolve branch_id from shift if not provided
    let branch_id = value_str(&payload, &["branchId", "branch_id"]).unwrap_or_else(|| {
        shift_id
            .as_ref()
            .and_then(|sid| {
                conn.query_row(
                    "SELECT branch_id FROM staff_shifts WHERE id = ?1",
                    params![sid],
                    |row| row.get::<_, Option<String>>(0),
                )
                .ok()
                .flatten()
            })
            .unwrap_or_default()
    });

    // Fetch order details for the JSON column
    let order_details: Option<String> = conn
        .query_row(
            "SELECT order_number, delivery_address, table_number, total_amount, payment_method, status FROM orders WHERE id = ?1",
            params![order_id],
            |row| {
                let detail = serde_json::json!({
                    "order_number": row.get::<_, Option<String>>(0).unwrap_or(None),
                    "address": row.get::<_, Option<String>>(1).unwrap_or(None)
                        .or_else(|| row.get::<_, Option<String>>(2).unwrap_or(None))
                        .unwrap_or_else(|| "N/A".to_string()),
                    "price": row.get::<_, f64>(3).unwrap_or(0.0),
                    "payment_type": row.get::<_, Option<String>>(4).unwrap_or(None),
                    "status": row.get::<_, Option<String>>(5).unwrap_or(None),
                });
                Ok(detail.to_string())
            },
        )
        .ok();

    conn.execute(
        "INSERT INTO driver_earnings (
            id, driver_id, staff_shift_id, order_id, branch_id,
            delivery_fee, tip_amount, total_earning,
            payment_method, cash_collected, card_amount, cash_to_return,
            order_details, settled, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?15)",
        params![
            id,
            driver_id,
            shift_id,
            order_id,
            branch_id,
            delivery_fee,
            tip_amount,
            total_earning,
            payment_method,
            cash_collected,
            card_amount,
            cash_to_return,
            order_details,
            now,
            now
        ],
    )
    .map_err(|e| format!("driver_record_earning insert: {e}"))?;

    info!("Recorded driver earning {id} for order {order_id}");

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "id": id,
            "driverId": driver_id,
            "shiftId": shift_id,
            "orderId": order_id,
            "branchId": branch_id,
            "deliveryFee": delivery_fee,
            "tipAmount": tip_amount,
            "totalEarning": total_earning,
            "paymentMethod": payment_method,
            "cashCollected": cash_collected,
            "cardAmount": card_amount,
            "cashToReturn": cash_to_return,
            "settled": false,
            "createdAt": now,
            "updatedAt": now
        }
    }))
}

#[tauri::command]
async fn driver_get_earnings(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let shift_id = arg0.ok_or("Missing shiftId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, driver_id, staff_shift_id, order_id, branch_id,
                    delivery_fee, tip_amount, total_earning,
                    payment_method, cash_collected, card_amount, cash_to_return,
                    order_details, settled, settled_at, settlement_batch_id,
                    is_transferred, supabase_id, created_at, updated_at
             FROM driver_earnings
             WHERE staff_shift_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| format!("driver_get_earnings prepare: {e}"))?;

    let rows = stmt
        .query_map(params![shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "driver_id": row.get::<_, String>(1)?,
                "staff_shift_id": row.get::<_, Option<String>>(2)?,
                "order_id": row.get::<_, String>(3)?,
                "branch_id": row.get::<_, String>(4)?,
                "delivery_fee": row.get::<_, f64>(5)?,
                "tip_amount": row.get::<_, f64>(6)?,
                "total_earning": row.get::<_, f64>(7)?,
                "payment_method": row.get::<_, String>(8)?,
                "cash_collected": row.get::<_, f64>(9)?,
                "card_amount": row.get::<_, f64>(10)?,
                "cash_to_return": row.get::<_, f64>(11)?,
                "order_details": row.get::<_, Option<String>>(12)?,
                "settled": row.get::<_, i32>(13)? != 0,
                "settled_at": row.get::<_, Option<String>>(14)?,
                "settlement_batch_id": row.get::<_, Option<String>>(15)?,
                "is_transferred": row.get::<_, i32>(16)? != 0,
                "supabase_id": row.get::<_, Option<String>>(17)?,
                "created_at": row.get::<_, String>(18)?,
                "updated_at": row.get::<_, String>(19)?,
            }))
        })
        .map_err(|e| format!("driver_get_earnings query: {e}"))?;

    let mut result = Vec::new();
    for row in rows {
        match row {
            Ok(v) => result.push(v),
            Err(e) => warn!("driver_get_earnings row error: {e}"),
        }
    }
    Ok(serde_json::json!(result))
}

#[tauri::command]
async fn driver_get_shift_summary(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let shift_id = arg0.ok_or("Missing shiftId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let (
        count,
        total_fees,
        total_tips,
        total_earnings,
        cash_collected,
        card_amount,
        cash_to_return,
    ): (i64, f64, f64, f64, f64, f64, f64) = conn
        .query_row(
            "SELECT
                COUNT(*),
                COALESCE(SUM(delivery_fee), 0),
                COALESCE(SUM(tip_amount), 0),
                COALESCE(SUM(total_earning), 0),
                COALESCE(SUM(cash_collected), 0),
                COALESCE(SUM(card_amount), 0),
                COALESCE(SUM(cash_to_return), 0)
             FROM driver_earnings
             WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(|e| format!("driver_get_shift_summary query: {e}"))?;

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "shiftId": shift_id,
            "entries": count,
            "totalDeliveries": count,
            "totalDeliveryFees": total_fees,
            "totalTips": total_tips,
            "totalEarnings": total_earnings,
            "cashCollected": cash_collected,
            "totalCashCollected": cash_collected,
            "cardAmount": card_amount,
            "totalCardAmount": card_amount,
            "totalCashToReturn": cash_to_return
        }
    }))
}

#[tauri::command]
async fn driver_get_active(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let branch_id = arg0.unwrap_or_default();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, staff_id, staff_name, branch_id, check_in_time
             FROM staff_shifts
             WHERE role_type = 'driver' AND status = 'active'
               AND (?1 = '' OR branch_id = ?1)
             ORDER BY check_in_time ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![branch_id], |row| {
            Ok(serde_json::json!({
                "shiftId": row.get::<_, String>(0)?,
                "staffId": row.get::<_, String>(1)?,
                "staffName": row.get::<_, Option<String>>(2)?,
                "branchId": row.get::<_, Option<String>>(3)?,
                "checkInTime": row.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let data: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!({ "success": true, "data": data }))
}

#[tauri::command]
async fn delivery_zone_track_validation(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let mut payload = arg0.unwrap_or(serde_json::json!({}));
    let id =
        value_str(&payload, &["id"]).unwrap_or_else(|| format!("dzv-{}", uuid::Uuid::new_v4()));
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("id".to_string(), serde_json::json!(id));
        obj.entry("timestamp".to_string())
            .or_insert(serde_json::json!(Utc::now().to_rfc3339()));
    }
    let mut logs = read_local_json_array(&db, "delivery_validation_logs_v1")?;
    logs.push(payload.clone());
    write_local_json(
        &db,
        "delivery_validation_logs_v1",
        &serde_json::Value::Array(logs),
    )?;
    Ok(serde_json::json!({ "success": true, "data": payload, "aggregated": false }))
}

#[tauri::command]
async fn delivery_zone_get_analytics(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let filters = arg0.unwrap_or(serde_json::json!({}));
    let zone_filter = value_str(&filters, &["zoneId", "zone_id"]);
    let logs = read_local_json_array(&db, "delivery_validation_logs_v1")?;
    let mut total = 0i64;
    let mut valid = 0i64;
    let mut overrides = 0i64;
    for row in logs {
        if let Some(zone) = zone_filter.as_ref() {
            let zid = value_str(&row, &["zoneId", "zone_id"]).unwrap_or_default();
            if &zid != zone {
                continue;
            }
        }
        total += 1;
        let result = value_str(&row, &["result"])
            .unwrap_or_default()
            .to_lowercase();
        if matches!(result.as_str(), "valid" | "ok" | "success" | "inside_zone") {
            valid += 1;
        }
        if row
            .get("overrideApplied")
            .or_else(|| row.get("override_applied"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            overrides += 1;
        }
    }
    Ok(serde_json::json!({
        "success": true,
        "data": [{
            "zoneId": zone_filter,
            "totalValidations": total,
            "validCount": valid,
            "invalidCount": total - valid,
            "overrideCount": overrides,
            "validRate": if total > 0 { (valid as f64) / (total as f64) } else { 0.0 }
        }]
    }))
}

#[tauri::command]
async fn delivery_zone_request_override(
    arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    Ok(serde_json::json!({
        "success": true,
        "data": {
            "approved": true,
            "requestedAt": Utc::now().to_rfc3339(),
            "request": payload
        }
    }))
}

#[tauri::command]
async fn report_get_today_statistics(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let branch_id = value_str(&payload, &["branchId", "branch_id"]).unwrap_or_default();
    let date = value_str(&payload, &["date"])
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let orders = load_orders_for_period(&conn, &branch_id, &date, &date)?;
    let mut total_sales = 0.0f64;
    let mut completed = 0i64;
    let mut cancelled = 0i64;
    for (_id, status, _created_at, items_json, _staff, _payment_method) in &orders {
        let (order_total, _) = parse_item_totals(items_json);
        total_sales += order_total;
        let st = status.to_lowercase();
        if matches!(
            st.as_str(),
            "completed" | "delivered" | "approved" | "ready"
        ) {
            completed += 1;
        }
        if matches!(st.as_str(), "cancelled" | "canceled" | "declined") {
            cancelled += 1;
        }
    }
    let total_orders = orders.len() as i64;
    let avg = if total_orders > 0 {
        total_sales / (total_orders as f64)
    } else {
        0.0
    };
    Ok(serde_json::json!({
        "success": true,
        "totalOrders": total_orders,
        "completedOrders": completed,
        "cancelledOrders": cancelled,
        "totalSales": total_sales,
        "averageOrderValue": avg
    }))
}

#[tauri::command]
async fn report_get_sales_trend(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let branch_id = value_str(&payload, &["branchId", "branch_id"]).unwrap_or_default();
    let days = value_i64(&payload, &["days"]).unwrap_or(7).clamp(1, 60);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut points: Vec<serde_json::Value> = Vec::new();
    for i in (0..days).rev() {
        let date = (Local::now() - chrono::Duration::days(i))
            .format("%Y-%m-%d")
            .to_string();
        let orders = load_orders_for_period(&conn, &branch_id, &date, &date)?;
        let mut total = 0.0f64;
        for (_id, _status, _created, items, _staff, _payment_method) in orders.iter() {
            let (order_total, _) = parse_item_totals(items);
            total += order_total;
        }
        points.push(serde_json::json!({
            "date": date,
            "sales": total,
            "orders": orders.len()
        }));
    }
    Ok(serde_json::json!({ "success": true, "data": points }))
}

#[tauri::command]
async fn report_get_top_items(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let branch_id = value_str(&payload, &["branchId", "branch_id"]).unwrap_or_default();
    let date = value_str(&payload, &["date"])
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let limit = value_i64(&payload, &["limit"]).unwrap_or(10).clamp(1, 50) as usize;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let orders = load_orders_for_period(&conn, &branch_id, &date, &date)?;
    let mut qty_by_item: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for (_id, _status, _created, items, _staff, _payment_method) in orders {
        let (_total, map) = parse_item_totals(&items);
        for (name, qty) in map {
            *qty_by_item.entry(name).or_insert(0.0) += qty;
        }
    }
    let mut items: Vec<(String, f64)> = qty_by_item.into_iter().collect();
    items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top: Vec<serde_json::Value> = items
        .into_iter()
        .take(limit)
        .map(|(name, quantity)| serde_json::json!({ "name": name, "quantity": quantity }))
        .collect();
    Ok(serde_json::json!({ "success": true, "data": top }))
}

#[tauri::command]
async fn report_get_weekly_top_items(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let branch_id = value_str(&payload, &["branchId", "branch_id"]).unwrap_or_default();
    let limit = value_i64(&payload, &["limit"]).unwrap_or(10).clamp(1, 50) as usize;
    let today = Local::now().format("%Y-%m-%d").to_string();
    let from = (Local::now() - chrono::Duration::days(6))
        .format("%Y-%m-%d")
        .to_string();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let orders = load_orders_for_period(&conn, &branch_id, &from, &today)?;
    let mut qty_by_item: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for (_id, _status, _created, items, _staff, _payment_method) in orders {
        let (_total, map) = parse_item_totals(&items);
        for (name, qty) in map {
            *qty_by_item.entry(name).or_insert(0.0) += qty;
        }
    }
    let mut items: Vec<(String, f64)> = qty_by_item.into_iter().collect();
    items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top: Vec<serde_json::Value> = items
        .into_iter()
        .take(limit)
        .map(|(name, quantity)| serde_json::json!({ "name": name, "quantity": quantity }))
        .collect();
    Ok(serde_json::json!({ "success": true, "data": top }))
}

#[tauri::command]
async fn report_get_daily_staff_performance(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let branch_id = value_str(&payload, &["branchId", "branch_id"]).unwrap_or_default();
    let date = value_str(&payload, &["date"])
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let orders = load_orders_for_period(&conn, &branch_id, &date, &date)?;
    let mut perf: std::collections::HashMap<String, (i64, f64)> = std::collections::HashMap::new();
    for (_id, _status, _created, items, staff, _payment_method) in orders {
        let staff_id = staff.unwrap_or_else(|| "unknown".to_string());
        let (total, _) = parse_item_totals(&items);
        let entry = perf.entry(staff_id).or_insert((0, 0.0));
        entry.0 += 1;
        entry.1 += total;
    }
    let data: Vec<serde_json::Value> = perf
        .into_iter()
        .map(|(staff_id, (orders_count, sales_total))| {
            serde_json::json!({
                "staffId": staff_id,
                "orders": orders_count,
                "sales": sales_total
            })
        })
        .collect();
    Ok(serde_json::json!({ "success": true, "data": data }))
}

#[tauri::command]
async fn report_generate_z_report(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));

    // If payload has shiftId (and no branchId/date), use single-shift path
    let has_shift_id = payload.get("shiftId").and_then(|v| v.as_str()).is_some()
        || payload.get("shift_id").and_then(|v| v.as_str()).is_some();
    let has_branch_or_date = payload.get("branchId").and_then(|v| v.as_str()).is_some()
        || payload.get("date").and_then(|v| v.as_str()).is_some();

    let generated = if has_shift_id && !has_branch_or_date {
        zreport::generate_z_report(&db, &payload)?
    } else {
        zreport::generate_z_report_for_date(&db, &payload)?
    };

    // Frontend expects report_json fields (sales, cashDrawer, etc.) directly
    // under "data". Extract reportJson from the nested response.
    let report_data = generated
        .get("report")
        .and_then(|r| r.get("reportJson"))
        .cloned()
        .unwrap_or(generated.clone());

    Ok(serde_json::json!({ "success": true, "data": report_data }))
}

#[tauri::command]
async fn report_submit_z_report(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let result = zreport::submit_z_report(&db, &payload)?;
    let _ = app.emit("sync_complete", serde_json::json!({ "entity": "z_report" }));
    Ok(result)
}

/// Transform a flat Rust printer profile (from DB) into Electron-compatible format.
///
/// Maps DB columns → frontend PrinterConfig shape:
/// - `printerType` → `type`
/// - `paperWidthMm` (80) → `paperSize` ("80mm")
/// - `connectionJson` (parsed) or fallback → `connectionDetails`
/// - `isDefault` / `enabled` kept as booleans
fn profile_to_electron_format(profile: &serde_json::Value) -> serde_json::Value {
    let printer_type = value_str(profile, &["printerType", "printer_type"])
        .unwrap_or_else(|| "system".to_string());

    let paper_width = profile
        .get("paperWidthMm")
        .or_else(|| profile.get("paper_width_mm"))
        .and_then(|v| v.as_i64())
        .unwrap_or(80);
    let paper_size = format!("{paper_width}mm");

    // Parse connectionJson or build default from printerName
    let conn_details = profile
        .get("connectionJson")
        .or_else(|| profile.get("connection_json"))
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .unwrap_or_else(|| {
            let printer_name =
                value_str(profile, &["printerName", "printer_name"]).unwrap_or_default();
            serde_json::json!({
                "type": printer_type,
                "systemName": printer_name
            })
        });

    let is_default = profile
        .get("isDefault")
        .or_else(|| profile.get("is_default"))
        .map(|v| v.as_bool().unwrap_or(false) || v.as_i64().unwrap_or(0) != 0)
        .unwrap_or(false);

    let enabled = profile
        .get("enabled")
        .map(|v| v.as_bool().unwrap_or(true) || v.as_i64().unwrap_or(1) != 0)
        .unwrap_or(true);

    serde_json::json!({
        "id": value_str(profile, &["id"]).unwrap_or_default(),
        "name": value_str(profile, &["name"]).unwrap_or_default(),
        "type": printer_type,
        "connectionDetails": conn_details,
        "paperSize": paper_size,
        "characterSet": value_str(profile, &["characterSet", "character_set"]).unwrap_or_else(|| "PC437_USA".to_string()),
        "greekRenderMode": value_str(profile, &["greekRenderMode", "greek_render_mode"]),
        "receiptTemplate": value_str(profile, &["receiptTemplate", "receipt_template"]),
        "role": value_str(profile, &["role"]).unwrap_or_else(|| "receipt".to_string()),
        "isDefault": is_default,
        "fallbackPrinterId": value_str(profile, &["fallbackPrinterId", "fallback_printer_id"]),
        "enabled": enabled,
        "createdAt": value_str(profile, &["createdAt", "created_at"]),
        "updatedAt": value_str(profile, &["updatedAt", "updated_at"]),
    })
}

/// Transform an Electron-compatible printer config (from frontend) into flat Rust profile format.
///
/// Maps frontend PrinterConfig → DB columns:
/// - `type` → `printerType`
/// - `connectionDetails.systemName` → `printerName`
/// - `connectionDetails` (serialized) → `connectionJson`
/// - `paperSize` ("80mm") → `paperWidthMm` (80)
fn electron_to_profile_input(id: Option<String>, payload: serde_json::Value) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    let obj = payload.as_object();

    // Pass through id
    if let Some(id) = id {
        out.insert("id".to_string(), serde_json::json!(id));
    }

    // name
    if let Some(name) = obj.and_then(|o| o.get("name")).and_then(|v| v.as_str()) {
        out.insert("name".to_string(), serde_json::json!(name));
    }

    // type → printerType
    let printer_type = obj
        .and_then(|o| o.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("system");
    out.insert("printerType".to_string(), serde_json::json!(printer_type));

    // connectionDetails → printerName + connectionJson
    if let Some(conn) = obj.and_then(|o| o.get("connectionDetails")) {
        // Serialize full connectionDetails as JSON
        if let Ok(json_str) = serde_json::to_string(conn) {
            out.insert("connectionJson".to_string(), serde_json::json!(json_str));
        }

        // Extract printerName from connectionDetails based on type
        let printer_name = conn
            .get("systemName")
            .and_then(|v| v.as_str())
            .or_else(|| conn.get("hostname").and_then(|v| v.as_str()))
            .or_else(|| conn.get("ip").and_then(|v| v.as_str()))
            .or_else(|| conn.get("address").and_then(|v| v.as_str()))
            .or_else(|| conn.get("deviceName").and_then(|v| v.as_str()))
            .or_else(|| obj.and_then(|o| o.get("name")).and_then(|v| v.as_str()))
            .unwrap_or("Printer");
        out.insert("printerName".to_string(), serde_json::json!(printer_name));
    } else if !out.contains_key("printerName") {
        // Fallback: use name as printerName
        let fallback = out
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Printer")
            .to_string();
        out.insert("printerName".to_string(), serde_json::json!(fallback));
    }

    // paperSize ("80mm") → paperWidthMm (80)
    if let Some(ps) = obj
        .and_then(|o| o.get("paperSize"))
        .and_then(|v| v.as_str())
    {
        let mm = ps.trim_end_matches("mm").parse::<i64>().unwrap_or(80);
        out.insert("paperWidthMm".to_string(), serde_json::json!(mm));
    }

    // Direct pass-through fields
    let pass_fields = [
        ("role", "role"),
        ("characterSet", "characterSet"),
        ("greekRenderMode", "greekRenderMode"),
        ("receiptTemplate", "receiptTemplate"),
        ("fallbackPrinterId", "fallbackPrinterId"),
    ];
    for (src, dst) in pass_fields {
        if let Some(v) = obj.and_then(|o| o.get(src)) {
            out.insert(dst.to_string(), v.clone());
        }
    }

    // Bool fields
    if let Some(v) = obj
        .and_then(|o| o.get("isDefault"))
        .and_then(|v| v.as_bool())
    {
        out.insert("isDefault".to_string(), serde_json::json!(v));
    }
    if let Some(v) = obj.and_then(|o| o.get("enabled")).and_then(|v| v.as_bool()) {
        out.insert("enabled".to_string(), serde_json::json!(v));
    }

    serde_json::Value::Object(out)
}

#[derive(Default)]
struct ConfiguredPrinterLookup {
    names: HashSet<String>,
    addresses: HashSet<String>,
}

fn normalize_lookup_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_lowercase())
}

fn format_mac_address(hex12: &str) -> String {
    let upper = hex12.to_uppercase();
    let parts: Vec<String> = upper
        .chars()
        .collect::<Vec<char>>()
        .chunks(2)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect();
    parts.join(":")
}

fn extract_mac_from_instance_id(instance_id: &str) -> Option<String> {
    let upper = instance_id.to_uppercase();
    if let Some(start) = upper.find("DEV_") {
        let candidate = upper.get(start + 4..start + 16)?;
        if candidate.len() == 12 && candidate.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(format_mac_address(candidate));
        }
    }

    if upper.contains("BTH") {
        for token in upper.split(|c: char| !c.is_ascii_hexdigit()) {
            if token.len() == 12 && token.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(format_mac_address(token));
            }
        }
    }

    None
}

fn stable_bt_fallback_address(instance_id: &str, name: &str) -> String {
    let seed = if !instance_id.trim().is_empty() {
        instance_id
    } else if !name.trim().is_empty() {
        name
    } else {
        "unknown"
    };
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    format!("bt-instance-{:016x}", hasher.finish())
}

fn normalize_address_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(mac) = extract_mac_from_instance_id(trimmed) {
        return Some(mac.to_lowercase());
    }
    Some(trimmed.to_lowercase())
}

fn is_internal_bluetooth_name(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    if lower.is_empty() {
        return true;
    }
    [
        "adapter",
        "enumerator",
        "protocol",
        "transport",
        "radio",
        "wireless bluetooth",
        "host controller",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn is_printer_like_bluetooth_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    [
        "printer", "thermal", "receipt", "pos", "epson", "star", "bixolon", "citizen", "zebra",
        "brother", "tm-", "tsp", "srp-", "ct-",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn dedupe_discovered_printers(printers: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut deduped: Vec<serde_json::Value> = Vec::new();

    for entry in printers {
        let printer_type = value_str(&entry, &["type"])
            .unwrap_or_else(|| "unknown".to_string())
            .to_lowercase();
        let address = value_str(&entry, &["address"]).unwrap_or_default();
        let normalized_address = normalize_address_token(&address).unwrap_or_default();
        let name = value_str(&entry, &["name"])
            .unwrap_or_default()
            .to_lowercase();

        let key = if !normalized_address.is_empty() {
            format!("{printer_type}:{normalized_address}")
        } else {
            format!("{printer_type}:name:{name}")
        };

        if seen.insert(key) {
            deduped.push(entry);
        }
    }

    deduped
}

fn configured_printer_lookup(db: &db::DbState) -> ConfiguredPrinterLookup {
    let mut lookup = ConfiguredPrinterLookup::default();

    if let Ok(profiles) = printers::list_printer_profiles(db) {
        if let Some(arr) = profiles.as_array() {
            for profile in arr {
                if let Some(name) = value_str(profile, &["printerName", "printer_name", "name"]) {
                    if let Some(token) = normalize_lookup_token(&name) {
                        lookup.names.insert(token);
                    }
                    if let Some(address_token) = normalize_address_token(&name) {
                        lookup.addresses.insert(address_token);
                    }
                }
                if let Some(address) = value_str(
                    profile,
                    &["address", "ip", "host", "drawerHost", "drawer_host"],
                ) {
                    if let Some(address_token) = normalize_address_token(&address) {
                        lookup.addresses.insert(address_token);
                    }
                }
            }
        }
    }

    lookup
}

fn is_configured_discovery_entry(
    configured: &ConfiguredPrinterLookup,
    name: &str,
    address: &str,
) -> bool {
    let name_token = normalize_lookup_token(name).unwrap_or_default();
    let address_token = normalize_address_token(address).unwrap_or_default();
    (!name_token.is_empty() && configured.names.contains(&name_token))
        || (!address_token.is_empty() && configured.addresses.contains(&address_token))
}

fn parse_powershell_device_rows(parsed: serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(arr) = parsed.as_array() {
        arr.clone()
    } else if parsed.is_object() {
        vec![parsed]
    } else {
        vec![]
    }
}

#[cfg(target_os = "windows")]
fn discover_bluetooth_printers_native(
    configured: &ConfiguredPrinterLookup,
) -> Result<Vec<serde_json::Value>, String> {
    use std::process::Command;

    let script = r#"
$ErrorActionPreference = 'Stop'
$devices = Get-PnpDevice -Class Bluetooth | Where-Object {
  $_.Status -eq 'OK' -and
  $_.FriendlyName -and
  $_.FriendlyName -notlike '*Adapter*' -and
  $_.FriendlyName -notlike '*Enumerator*' -and
  $_.FriendlyName -notlike '*Protocol*' -and
  $_.FriendlyName -notlike '*Transport*'
}
$devices | Select-Object FriendlyName, InstanceId, Class, Status | ConvertTo-Json -Depth 6 -Compress
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| format!("Failed to execute Bluetooth discovery command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        warn!(
            stderr = %stderr,
            "Bluetooth discovery PowerShell command returned a non-success status"
        );
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() || stdout == "null" {
        info!("Bluetooth discovery returned no paired devices");
        return Ok(vec![]);
    }

    let parsed: serde_json::Value = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(error) => {
            warn!(
                error = %error,
                output = %stdout,
                "Bluetooth discovery output was not valid JSON"
            );
            return Ok(vec![]);
        }
    };

    let candidates = parse_powershell_device_rows(parsed);

    let mut printer_like: Vec<serde_json::Value> = Vec::new();
    let mut others: Vec<serde_json::Value> = Vec::new();

    for device in candidates {
        let name = value_str(&device, &["FriendlyName", "friendlyName", "name"])
            .unwrap_or_else(|| "Bluetooth Device".to_string());
        if is_internal_bluetooth_name(&name) {
            continue;
        }

        let instance_id = value_str(&device, &["InstanceId", "instanceId"]).unwrap_or_default();
        let address = extract_mac_from_instance_id(&instance_id)
            .unwrap_or_else(|| stable_bt_fallback_address(&instance_id, &name));
        let is_configured = is_configured_discovery_entry(configured, &name, &address);

        let row = serde_json::json!({
            "name": name,
            "type": "bluetooth",
            "address": address,
            "port": 1,
            "model": serde_json::Value::Null,
            "manufacturer": serde_json::Value::Null,
            "isConfigured": is_configured,
            "source": "windows-pnp"
        });

        if is_printer_like_bluetooth_name(
            row.get("name").and_then(|v| v.as_str()).unwrap_or_default(),
        ) {
            printer_like.push(row);
        } else {
            others.push(row);
        }
    }

    printer_like.extend(others);
    let deduped = dedupe_discovered_printers(printer_like);
    info!(
        discovered = deduped.len(),
        "Bluetooth discovery completed from native Windows paired-device scan"
    );
    Ok(deduped)
}

#[cfg(not(target_os = "windows"))]
fn discover_bluetooth_printers_native(
    _configured: &ConfiguredPrinterLookup,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![])
}

#[cfg(test)]
mod bluetooth_discovery_tests {
    use super::*;

    #[test]
    fn extract_mac_from_dev_token() {
        let mac = extract_mac_from_instance_id("BTHENUM\\DEV_AABBCCDDEEFF\\8&1234");
        assert_eq!(mac, Some("AA:BB:CC:DD:EE:FF".to_string()));
    }

    #[test]
    fn extract_mac_from_bth_hex_token() {
        let mac = extract_mac_from_instance_id("BTHLEDEVICE\\{GUID}\\A1B2C3D4E5F6");
        assert_eq!(mac, Some("A1:B2:C3:D4:E5:F6".to_string()));
    }

    #[test]
    fn fallback_bt_address_is_stable() {
        let a = stable_bt_fallback_address("INSTANCE-1", "Printer");
        let b = stable_bt_fallback_address("INSTANCE-1", "Printer");
        assert_eq!(a, b);
        assert!(a.starts_with("bt-instance-"));
    }

    #[test]
    fn parse_rows_accepts_single_object() {
        let parsed = serde_json::json!({
            "FriendlyName": "Printer One",
            "InstanceId": "BTHENUM\\DEV_AABBCCDDEEFF\\x"
        });
        let rows = parse_powershell_device_rows(parsed);
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn parse_rows_accepts_array() {
        let parsed = serde_json::json!([
            { "FriendlyName": "One", "InstanceId": "A" },
            { "FriendlyName": "Two", "InstanceId": "B" }
        ]);
        let rows = parse_powershell_device_rows(parsed);
        assert_eq!(rows.len(), 2);
    }
}

#[tauri::command]
async fn printer_scan_network(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let configured = configured_printer_lookup(&db);
    let printers = printers::list_system_printers();
    let discovered: Vec<serde_json::Value> = printers
        .into_iter()
        .map(|name| {
            let address = name.clone();
            serde_json::json!({
                "name": name,
                "type": "system",
                "address": address,
                "model": serde_json::Value::Null,
                "manufacturer": "system",
                "isConfigured": is_configured_discovery_entry(&configured, &name, &address)
            })
        })
        .collect();
    Ok(serde_json::json!({
        "success": true,
        "printers": discovered,
        "type": "network"
    }))
}

#[tauri::command]
async fn printer_scan_bluetooth(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let configured = configured_printer_lookup(&db);
    let printers = discover_bluetooth_printers_native(&configured)?;
    let message = if cfg!(target_os = "windows") {
        if printers.is_empty() {
            "No paired Bluetooth devices found".to_string()
        } else {
            format!("Discovered {} Bluetooth device(s)", printers.len())
        }
    } else {
        "Bluetooth native scan is currently supported on Windows only".to_string()
    };
    Ok(serde_json::json!({
        "success": true,
        "printers": printers,
        "type": "bluetooth",
        "message": message
    }))
}

#[tauri::command]
async fn printer_discover(
    arg0: Option<Vec<String>>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let requested: Vec<String> = arg0
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().to_lowercase())
        .collect();
    info!(
        requested_types = ?requested,
        "printer_discover requested"
    );
    let discover_all = requested.is_empty();
    let wants_system_like = discover_all
        || requested
            .iter()
            .any(|t| matches!(t.as_str(), "system" | "network" | "wifi" | "usb"));
    let wants_bluetooth = discover_all || requested.iter().any(|t| t == "bluetooth");

    let configured = configured_printer_lookup(&db);
    let mut out: Vec<serde_json::Value> = Vec::new();

    if wants_system_like {
        for printer_name in printers::list_system_printers() {
            let address = printer_name.clone();
            out.push(serde_json::json!({
                "name": printer_name,
                "type": "system",
                "address": address,
                "port": serde_json::Value::Null,
                "model": serde_json::Value::Null,
                "manufacturer": "system",
                "isConfigured": is_configured_discovery_entry(&configured, &printer_name, &address)
            }));
        }
    }

    if wants_bluetooth {
        let bluetooth = discover_bluetooth_printers_native(&configured)?;
        info!(
            bluetooth_candidates = bluetooth.len(),
            "printer_discover native bluetooth scan result"
        );
        out.extend(bluetooth);
    }

    let deduped = dedupe_discovered_printers(out);
    info!(result_count = deduped.len(), "printer_discover completed");

    Ok(serde_json::json!({ "success": true, "printers": deduped }))
}

#[tauri::command]
async fn printer_add(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = electron_to_profile_input(None, arg0.unwrap_or(serde_json::json!({})));
    let created = printers::create_printer_profile(&db, &payload)?;
    let profile_id = value_str(&created, &["profileId"]).unwrap_or_default();
    let profile = if profile_id.is_empty() {
        serde_json::Value::Null
    } else {
        let raw =
            printers::get_printer_profile(&db, &profile_id).unwrap_or(serde_json::Value::Null);
        profile_to_electron_format(&raw)
    };
    let _ = app.emit(
        "printer_status_changed",
        serde_json::json!({
            "printerId": profile_id,
            "status": "configured"
        }),
    );
    Ok(serde_json::json!({ "success": true, "printer": profile }))
}

#[tauri::command]
async fn printer_update(
    arg0: Option<String>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let printer_id = arg0.ok_or("Missing printerId")?;
    let payload = electron_to_profile_input(
        Some(printer_id.clone()),
        arg1.unwrap_or(serde_json::json!({})),
    );
    let _ = printers::update_printer_profile(&db, &payload)?;
    let raw = printers::get_printer_profile(&db, &printer_id)?;
    let profile = profile_to_electron_format(&raw);
    let _ = app.emit(
        "printer_status_changed",
        serde_json::json!({
            "printerId": printer_id,
            "status": "updated"
        }),
    );
    Ok(serde_json::json!({ "success": true, "printer": profile }))
}

#[tauri::command]
async fn printer_remove(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let printer_id = arg0.ok_or("Missing printerId")?;
    let result = printers::delete_printer_profile(&db, &printer_id)?;
    let _ = app.emit(
        "printer_status_changed",
        serde_json::json!({
            "printerId": printer_id,
            "status": "removed"
        }),
    );
    Ok(result)
}

#[tauri::command]
async fn printer_get_all(db: tauri::State<'_, db::DbState>) -> Result<serde_json::Value, String> {
    let profiles = printers::list_printer_profiles(&db)?;
    let electron_profiles: Vec<serde_json::Value> = profiles
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(profile_to_electron_format)
        .collect();
    Ok(serde_json::json!({ "success": true, "printers": electron_profiles }))
}

#[tauri::command]
async fn printer_get(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let printer_id = arg0.ok_or("Missing printerId")?;
    let raw = printers::get_printer_profile(&db, &printer_id)?;
    let profile = profile_to_electron_format(&raw);
    Ok(serde_json::json!({ "success": true, "printer": profile }))
}

#[tauri::command]
async fn printer_get_status(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let printer_id = arg0.ok_or("Missing printerId")?;
    let profile = printers::get_printer_profile(&db, &printer_id)?;
    let printer_name = value_str(&profile, &["printerName", "printer_name"]).unwrap_or_default();
    let system = printers::list_system_printers();
    let connected = system.iter().any(|name| name == &printer_name);
    let state = if connected { "online" } else { "offline" };

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let queue_len: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE status IN ('pending', 'printing') AND printer_profile_id = ?1",
            rusqlite::params![printer_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    Ok(serde_json::json!({
        "success": true,
        "printerId": printer_id,
        "state": state,
        "connected": connected,
        "queueLength": queue_len,
        "printerName": printer_name,
        "lastSeen": chrono::Utc::now().to_rfc3339()
    }))
}

#[tauri::command]
async fn printer_get_all_statuses(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let profiles = printers::list_printer_profiles(&db)?;
    let system = printers::list_system_printers();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut status_map = serde_json::Map::new();
    if let Some(arr) = profiles.as_array() {
        for profile in arr {
            let printer_id = value_str(profile, &["id"]).unwrap_or_default();
            let printer_name =
                value_str(profile, &["printerName", "printer_name"]).unwrap_or_default();
            let connected = system.iter().any(|name| name == &printer_name);

            // Count pending print jobs for this printer
            let queue_len: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM print_jobs WHERE status IN ('pending', 'printing') AND printer_profile_id = ?1",
                    rusqlite::params![printer_id],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            let state = if connected { "online" } else { "offline" };
            status_map.insert(
                printer_id.clone(),
                serde_json::json!({
                    "printerId": printer_id,
                    "state": state,
                    "queueLength": queue_len,
                    "lastSeen": chrono::Utc::now().to_rfc3339()
                }),
            );
        }
    }
    Ok(serde_json::json!({ "success": true, "statuses": status_map }))
}

#[tauri::command]
async fn printer_submit_job(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let entity_type = value_str(&payload, &["entityType", "entity_type"])
        .unwrap_or_else(|| "order_receipt".to_string());
    let entity_id = value_str(&payload, &["entityId", "entity_id", "orderId", "order_id"])
        .unwrap_or_else(|| format!("entity-{}", uuid::Uuid::new_v4()));
    let printer_profile_id = value_str(&payload, &["printerProfileId", "printer_profile_id"]);

    let allowed = matches!(
        entity_type.as_str(),
        "order_receipt" | "kitchen_ticket" | "z_report"
    );
    if allowed {
        return print::enqueue_print_job(
            &db,
            &entity_type,
            &entity_id,
            printer_profile_id.as_deref(),
        );
    }

    let mut jobs = read_local_json_array(&db, "virtual_print_jobs_v1")?;
    let job_id = format!("vjob-{}", uuid::Uuid::new_v4());
    jobs.push(serde_json::json!({
        "id": job_id,
        "payload": payload,
        "status": "queued",
        "createdAt": Utc::now().to_rfc3339()
    }));
    write_local_json(
        &db,
        "virtual_print_jobs_v1",
        &serde_json::Value::Array(jobs),
    )?;
    Ok(serde_json::json!({ "success": true, "jobId": job_id }))
}

#[tauri::command]
async fn printer_cancel_job(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let job_id = arg0.ok_or("Missing jobId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let affected = conn
        .execute(
            "UPDATE print_jobs SET status = 'cancelled', updated_at = datetime('now')
             WHERE id = ?1 AND status IN ('pending', 'printing')",
            rusqlite::params![job_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": affected > 0, "affected": affected }))
}

#[tauri::command]
async fn printer_retry_job(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let job_id = arg0.ok_or("Missing jobId")?;
    printers::reprint_job(&db, &job_id)
}

#[tauri::command]
async fn printer_test(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let printer_id = arg0.ok_or("Missing printerId")?;
    let profile = printers::get_printer_profile(&db, &printer_id)?;
    let printer_name = value_str(&profile, &["printerName", "printer_name"]).unwrap_or_default();

    if printer_name.is_empty() {
        return Err("Printer has no system printer name configured".into());
    }

    let start = std::time::Instant::now();

    // Generate a simple test page HTML
    let now_str = chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S UTC")
        .to_string();
    let test_html = format!(
        r#"<!DOCTYPE html>
<html><head><style>
body {{ font-family: monospace; font-size: 12px; width: 280px; margin: 0 auto; }}
h2 {{ text-align: center; margin: 10px 0; }}
hr {{ border: 1px dashed #000; }}
p {{ margin: 4px 0; }}
</style></head><body>
<h2>TEST PRINT</h2>
<hr>
<p>Printer: {}</p>
<p>Date: {}</p>
<hr>
<p>ABCDEFGHIJKLMNOPQRSTUVWXYZ</p>
<p>abcdefghijklmnopqrstuvwxyz</p>
<p>0123456789 !@#$%^&*()</p>
<hr>
<p style="text-align:center">-- End of Test --</p>
</body></html>"#,
        printer_name, now_str
    );

    // Write to temp file
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let receipts_dir = app_dir.join("receipts");
    std::fs::create_dir_all(&receipts_dir).map_err(|e| format!("create receipts dir: {e}"))?;
    let test_file = receipts_dir.join(format!("test_{}.html", printer_id));
    std::fs::write(&test_file, &test_html).map_err(|e| format!("write test file: {e}"))?;

    // Send to Windows printer
    let file_path = test_file.to_string_lossy().to_string();
    match printers::print_to_windows(&printer_name, &file_path) {
        Ok(()) => {
            let latency_ms = start.elapsed().as_millis() as u64;
            info!(
                printer = %printer_name,
                latency_ms = latency_ms,
                "Test print dispatched"
            );
            Ok(serde_json::json!({
                "success": true,
                "printerId": printer_id,
                "latencyMs": latency_ms,
                "message": "Test print dispatched"
            }))
        }
        Err(e) => {
            warn!(printer = %printer_name, error = %e, "Test print failed");
            Ok(serde_json::json!({
                "success": false,
                "printerId": printer_id,
                "error": e,
                "latencyMs": start.elapsed().as_millis() as u64
            }))
        }
    }
}

#[tauri::command]
async fn printer_test_greek_direct(
    arg0: Option<String>,
    arg1: Option<String>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": true,
        "mode": arg0.unwrap_or_else(|| "ascii".to_string()),
        "printerName": arg1.unwrap_or_else(|| "POS-80".to_string())
    }))
}

#[tauri::command]
async fn printer_diagnostics(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let printer_id = arg0.ok_or("Missing printerId")?;
    let profile = printers::get_printer_profile(&db, &printer_id)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let total_jobs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE printer_profile_id = ?1",
            rusqlite::params![printer_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let failed_jobs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE status = 'failed' AND printer_profile_id = ?1",
            rusqlite::params![printer_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let successful_jobs = total_jobs - failed_jobs;

    let printer_type = value_str(&profile, &["printerType", "printer_type"])
        .unwrap_or_else(|| "system".to_string());
    let printer_name = value_str(&profile, &["printerName", "printer_name"]).unwrap_or_default();
    let system = printers::list_system_printers();
    let connected = system.iter().any(|name| name == &printer_name);

    Ok(serde_json::json!({
        "success": true,
        "diagnostics": {
            "printerId": printer_id,
            "connectionType": printer_type,
            "model": printer_name,
            "isOnline": connected,
            "recentJobs": {
                "total": total_jobs,
                "successful": successful_jobs,
                "failed": failed_jobs
            }
        }
    }))
}

#[tauri::command]
async fn printer_bluetooth_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "available": false,
        "message": "Bluetooth printer transport is not implemented in Tauri backend yet"
    }))
}

#[tauri::command]
async fn printer_open_cash_drawer(
    arg0: Option<String>,
    _arg1: Option<i64>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let result = drawer::open_cash_drawer(&db, arg0.as_deref())?;
    let _ = app.emit(
        "printer_status_changed",
        serde_json::json!({
            "printerId": arg0,
            "status": "drawer_opened"
        }),
    );
    Ok(result)
}

#[tauri::command]
async fn label_print(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let request = arg0.unwrap_or(serde_json::json!({}));
    let printer_id = arg1;
    let mut jobs = read_local_json_array(&db, "label_print_jobs_v1")?;
    let job_id = format!("label-{}", uuid::Uuid::new_v4());
    jobs.push(serde_json::json!({
        "id": job_id,
        "request": request,
        "printerId": printer_id,
        "createdAt": Utc::now().to_rfc3339()
    }));
    write_local_json(&db, "label_print_jobs_v1", &serde_json::Value::Array(jobs))?;
    Ok(serde_json::json!({ "success": true, "jobId": job_id }))
}

#[tauri::command]
async fn label_print_batch(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    arg2: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let items = arg0.unwrap_or(serde_json::json!([]));
    let label_type = arg1.unwrap_or_else(|| "barcode".to_string());
    let printer_id = arg2;
    let mut jobs = read_local_json_array(&db, "label_print_jobs_v1")?;
    let job_id = format!("label-batch-{}", uuid::Uuid::new_v4());
    jobs.push(serde_json::json!({
        "id": job_id,
        "items": items,
        "labelType": label_type,
        "printerId": printer_id,
        "createdAt": Utc::now().to_rfc3339()
    }));
    write_local_json(&db, "label_print_jobs_v1", &serde_json::Value::Array(jobs))?;
    Ok(serde_json::json!({ "success": true, "jobId": job_id }))
}

// -- Window (stubs) ----------------------------------------------------------

#[tauri::command]
async fn window_get_state(window: tauri::Window) -> Result<serde_json::Value, String> {
    let is_maximized = window.is_maximized().unwrap_or(false);
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    Ok(serde_json::json!({
        "isMaximized": is_maximized,
        "isFullScreen": is_fullscreen,
    }))
}

#[tauri::command]
async fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_maximize(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_toggle_fullscreen(window: tauri::Window) -> Result<(), String> {
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    window
        .set_fullscreen(!is_fullscreen)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_reload(_window: tauri::Window) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn window_force_reload(_window: tauri::Window) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn window_toggle_devtools() -> Result<(), String> {
    // Devtools toggle is runtime-specific in Tauri v2 and may be disabled in
    // production builds. Keep command parity without hard failure.
    Ok(())
}

#[tauri::command]
async fn window_zoom_in(_window: tauri::Window) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn window_zoom_out(_window: tauri::Window) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn window_zoom_reset(_window: tauri::Window) -> Result<(), String> {
    Ok(())
}

// -- Database ----------------------------------------------------------------

#[tauri::command]
async fn database_health_check(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    // Verify core tables exist
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let tables: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let payload = serde_json::json!({
        "success": true,
        "data": { "status": "ok", "tables": tables }
    });
    let _ = app.emit("database_health_update", payload.clone());
    Ok(payload)
}

#[tauri::command]
async fn database_get_stats(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let total_orders: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
        .unwrap_or(0);
    let pending_sync: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let active_sessions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM staff_sessions WHERE is_active = 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(serde_json::json!({
        "totalOrders": total_orders,
        "pendingSync": pending_sync,
        "activeSessions": active_sessions,
    }))
}

#[tauri::command]
async fn database_reset(db: tauri::State<'_, db::DbState>) -> Result<serde_json::Value, String> {
    clear_operational_data_inner(&db)
}

#[tauri::command]
async fn database_clear_operational_data(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    clear_operational_data_inner(&db)
}

// -- Diagnostics / About / System Health ------------------------------------

#[tauri::command]
async fn diagnostics_get_about() -> Result<serde_json::Value, String> {
    Ok(diagnostics::get_about_info())
}

#[tauri::command]
async fn diagnostics_get_system_health(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
) -> Result<serde_json::Value, String> {
    let mut health = diagnostics::get_system_health(&db)?;

    // Augment with live online/offline status
    let network = sync::check_network_status().await;
    let is_online = network
        .get("isOnline")
        .or_else(|| network.get("online"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Last sync time from sync state
    let last_sync = sync_state.last_sync.lock().ok().and_then(|g| g.clone());

    if let Some(obj) = health.as_object_mut() {
        obj.insert("isOnline".into(), serde_json::json!(is_online));
        obj.insert("lastSyncTime".into(), serde_json::json!(last_sync));
    }

    Ok(health)
}

#[tauri::command]
async fn diagnostics_export(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let zip_path = diagnostics::export_diagnostics(&db, &data_dir)?;
    Ok(serde_json::json!({
        "success": true,
        "path": zip_path,
    }))
}

// -- Update ------------------------------------------------------------------

#[tauri::command]
async fn update_get_state(db: tauri::State<'_, db::DbState>) -> Result<serde_json::Value, String> {
    read_update_state(&db)
}

#[tauri::command]
async fn update_check(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    updater_runtime: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<(), String> {
    let mut state = read_update_state(&db)?;
    if let Some(obj) = state.as_object_mut() {
        obj.insert("checking".to_string(), serde_json::json!(true));
        obj.insert("available".to_string(), serde_json::json!(false));
        obj.insert("downloading".to_string(), serde_json::json!(false));
        obj.insert("ready".to_string(), serde_json::json!(false));
        obj.insert("error".to_string(), serde_json::Value::Null);
        obj.insert("progress".to_string(), serde_json::json!(0));
    }
    write_update_state(&db, &state)?;
    let _ = app.emit("update_checking", serde_json::json!({}));

    if let Ok(mut bytes) = updater_runtime.downloaded_bytes.lock() {
        *bytes = None;
    }

    match updater_manifest_is_reachable().await {
        Ok(true) => {}
        Ok(false) => {
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::Value::Null);
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            write_update_state(&db, &state)?;
            let _ = app.emit("update_not_available", serde_json::Value::Null);
            return Ok(());
        }
        Err(error) => {
            let message = format!("Failed to reach updater manifest: {error}");
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }
            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::json!(message.clone()));
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            write_update_state(&db, &state)?;
            let _ = app.emit("update_error", serde_json::json!({ "message": message }));
            return Ok(());
        }
    }

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            let message = format!("Failed to initialize updater: {error}");
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }
            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::json!(message.clone()));
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            write_update_state(&db, &state)?;
            let _ = app.emit("update_error", serde_json::json!({ "message": message }));
            return Ok(());
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let update_info = update_info_from_release(&update);
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = Some(update);
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(true));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::Value::Null);
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), update_info.clone());
            }
            write_update_state(&db, &state)?;
            let _ = app.emit("update_available", update_info);
        }
        Ok(None) => {
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::Value::Null);
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            write_update_state(&db, &state)?;
            let _ = app.emit("update_not_available", serde_json::Value::Null);
        }
        Err(error) => {
            let message = format!("Failed to check for updates: {error}");
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::json!(message.clone()));
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            write_update_state(&db, &state)?;
            let _ = app.emit("update_error", serde_json::json!({ "message": message }));
        }
    }
    Ok(())
}

#[tauri::command]
async fn update_download(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    updater_runtime: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<serde_json::Value, String> {
    let pending_update = {
        let guard = updater_runtime
            .pending_update
            .lock()
            .map_err(|e| format!("updater state lock failed: {e}"))?;
        guard.clone()
    };

    let Some(update) = pending_update else {
        let message = "No update available to download".to_string();
        let _ = app.emit(
            "update_error",
            serde_json::json!({ "message": message.clone() }),
        );
        return Ok(serde_json::json!({ "success": false, "error": message }));
    };

    let mut state = read_update_state(&db)?;
    if let Some(obj) = state.as_object_mut() {
        obj.insert("checking".to_string(), serde_json::json!(false));
        obj.insert("available".to_string(), serde_json::json!(true));
        obj.insert("downloading".to_string(), serde_json::json!(true));
        obj.insert("ready".to_string(), serde_json::json!(false));
        obj.insert("error".to_string(), serde_json::Value::Null);
        obj.insert("progress".to_string(), serde_json::json!(0));
    }
    write_update_state(&db, &state)?;
    let _ = app.emit(
        "download_progress",
        serde_json::json!({
            "percent": 0.0,
            "bytesPerSecond": 0,
            "transferred": 0,
            "total": 0
        }),
    );

    let transferred = std::sync::Arc::new(AtomicU64::new(0));
    let transferred_for_event = transferred.clone();
    let app_for_event = app.clone();

    match update
        .download(
            move |chunk_len, total| {
                let total_bytes = total.unwrap_or(0);
                let transferred_now = transferred_for_event
                    .fetch_add(chunk_len as u64, Ordering::Relaxed)
                    + chunk_len as u64;
                let percent = if total_bytes > 0 {
                    (transferred_now as f64 / total_bytes as f64 * 100.0).min(100.0)
                } else {
                    0.0
                };
                let _ = app_for_event.emit(
                    "download_progress",
                    serde_json::json!({
                        "percent": percent,
                        "bytesPerSecond": 0,
                        "transferred": transferred_now,
                        "total": total_bytes
                    }),
                );
            },
            || {},
        )
        .await
    {
        Ok(bytes) => {
            if let Ok(mut downloaded) = updater_runtime.downloaded_bytes.lock() {
                *downloaded = Some(bytes);
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(true));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(true));
                obj.insert("error".to_string(), serde_json::Value::Null);
                obj.insert("progress".to_string(), serde_json::json!(100));
            }
            write_update_state(&db, &state)?;

            let transferred_final = transferred.load(Ordering::Relaxed);
            let _ = app.emit(
                "download_progress",
                serde_json::json!({
                    "percent": 100.0,
                    "bytesPerSecond": 0,
                    "transferred": transferred_final,
                    "total": transferred_final
                }),
            );

            let info = state
                .get("updateInfo")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let _ = app.emit("update_downloaded", info);
            Ok(serde_json::json!({ "success": true }))
        }
        Err(error) => {
            let message = format!("Failed to download update: {error}");
            if let Ok(mut downloaded) = updater_runtime.downloaded_bytes.lock() {
                *downloaded = None;
            }

            if let Some(obj) = state.as_object_mut() {
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::json!(message.clone()));
                obj.insert("progress".to_string(), serde_json::json!(0));
            }
            write_update_state(&db, &state)?;
            let _ = app.emit(
                "update_error",
                serde_json::json!({ "message": message.clone() }),
            );
            Ok(serde_json::json!({ "success": false, "error": message }))
        }
    }
}

#[tauri::command]
async fn update_cancel_download(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let message = "Cancelling an in-progress Tauri updater download is not supported".to_string();
    let _ = app.emit(
        "update_error",
        serde_json::json!({ "message": message.clone() }),
    );
    Ok(serde_json::json!({ "success": false, "error": message }))
}

#[tauri::command]
async fn update_install(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    updater_runtime: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<serde_json::Value, String> {
    let pending_update = {
        let guard = updater_runtime
            .pending_update
            .lock()
            .map_err(|e| format!("updater state lock failed: {e}"))?;
        guard.clone()
    };
    let downloaded_bytes = {
        let guard = updater_runtime
            .downloaded_bytes
            .lock()
            .map_err(|e| format!("updater bytes lock failed: {e}"))?;
        guard.clone()
    };

    let Some(update) = pending_update else {
        let message = "Update not downloaded".to_string();
        let _ = app.emit(
            "update_error",
            serde_json::json!({ "message": message.clone() }),
        );
        return Ok(serde_json::json!({ "success": false, "error": message }));
    };

    let Some(bytes) = downloaded_bytes else {
        let message = "Update payload is missing. Download the update again.".to_string();
        let _ = app.emit(
            "update_error",
            serde_json::json!({ "message": message.clone() }),
        );
        return Ok(serde_json::json!({ "success": false, "error": message }));
    };

    match update.install(bytes) {
        Ok(_) => {
            if let Ok(mut pending) = updater_runtime.pending_update.lock() {
                *pending = None;
            }
            if let Ok(mut downloaded) = updater_runtime.downloaded_bytes.lock() {
                *downloaded = None;
            }

            let mut state = read_update_state(&db)?;
            if let Some(obj) = state.as_object_mut() {
                obj.insert("checking".to_string(), serde_json::json!(false));
                obj.insert("available".to_string(), serde_json::json!(false));
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::Value::Null);
                obj.insert("progress".to_string(), serde_json::json!(0));
                obj.insert("updateInfo".to_string(), serde_json::Value::Null);
            }
            write_update_state(&db, &state)?;

            let _ = app.emit(
                "app_restart_required",
                serde_json::json!({ "source": "updater" }),
            );
            Ok(serde_json::json!({ "success": true }))
        }
        Err(error) => {
            let message = format!("Failed to install update: {error}");
            let mut state = read_update_state(&db)?;
            if let Some(obj) = state.as_object_mut() {
                obj.insert("downloading".to_string(), serde_json::json!(false));
                obj.insert("ready".to_string(), serde_json::json!(false));
                obj.insert("error".to_string(), serde_json::json!(message.clone()));
            }
            write_update_state(&db, &state)?;

            let _ = app.emit(
                "update_error",
                serde_json::json!({ "message": message.clone() }),
            );
            Ok(serde_json::json!({ "success": false, "error": message }))
        }
    }
}

#[tauri::command]
async fn update_set_channel(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let channel = arg0.unwrap_or_else(|| "stable".to_string());
    if channel != "stable" && channel != "beta" {
        return Err("Invalid update channel".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "update_channel", &channel)?;
    Ok(serde_json::json!({ "success": true, "channel": channel }))
}

// -- API proxy ---------------------------------------------------------------

#[tauri::command]
async fn api_fetch_from_admin(
    arg0: Option<String>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);

    let path = arg0.ok_or("Missing API path")?;
    let opts = arg1.unwrap_or(serde_json::json!({}));
    let method = opts
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .trim()
        .to_uppercase();
    let body = opts.get("body").cloned();
    let query = opts.get("query").or_else(|| opts.get("params"));
    let final_path = if let Some(q) = query {
        build_admin_query(&path, Some(q))
    } else {
        path.clone()
    };

    if let Err(e) = validate_admin_api_path(&final_path) {
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

    match admin_fetch(Some(&db), &final_path, &method, body).await {
        Ok(v) => Ok(serde_json::json!({
            "success": true,
            "data": v,
            "status": 200
        })),
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "error": e
        })),
    }
}

#[tauri::command]
async fn sync_test_parent_connection(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);
    let admin_url = storage::get_credential("admin_dashboard_url")
        .ok_or("Terminal not configured: missing admin URL")?;
    let api_key =
        storage::get_credential("pos_api_key").ok_or("Terminal not configured: missing API key")?;

    let result = api::test_connectivity(&admin_url, &api_key).await;
    serde_json::to_value(&result).map_err(|e| e.to_string())
}

// ============================================================================
// App entry point
// ============================================================================

pub fn run() {
    // Record start time for uptime tracking
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    APP_START_EPOCH.store(epoch, Ordering::Relaxed);

    // Initialize structured logging (console + rolling file)
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,the_small_pos_lib=debug"));

    // Prune old log files before setting up the appender
    diagnostics::prune_old_logs();

    // Rolling file appender: creates daily log files in the logs directory
    let log_dir = diagnostics::get_log_dir();
    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = tracing_appender::rolling::daily(&log_dir, "pos");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    let file_layer = fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true);
    let console_layer = fmt::layer().with_target(true);
    tracing_subscriber::registry()
        .with(env_filter)
        .with(console_layer)
        .with(file_layer)
        .init();

    // Keep the guard alive for the lifetime of the app — dropping it flushes logs.
    // We leak it intentionally since the app runs until process exit.
    std::mem::forget(_guard);

    info!("Starting The Small POS v{}", env!("CARGO_PKG_VERSION"));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            use std::sync::Arc;
            use tauri::Manager;

            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");

            // Main DB connection for Tauri commands
            let db_state = db::init(&app_data_dir).expect("Failed to initialize database");
            app.manage(db_state);

            // Auth state
            app.manage(auth::AuthState::new());
            app.manage(UpdaterRuntimeState::default());

            // Sync state (shared between commands and background loop)
            let sync_state = Arc::new(sync::SyncState::new());
            app.manage(sync_state.clone());

            // Second DB connection for the background sync loop
            let db_for_sync =
                Arc::new(db::init(&app_data_dir).expect("Failed to init sync database"));
            let db_for_startup = db_for_sync.clone();

            // Start background sync loop (15s interval)
            sync::start_sync_loop(app.handle().clone(), db_for_sync, sync_state, 15);

            // Third DB connection for the background print worker
            let db_for_print =
                Arc::new(db::init(&app_data_dir).expect("Failed to init print database"));

            // Start background print worker (5s interval)
            print::start_print_worker(db_for_print, app_data_dir.clone(), 5);

            // Fetch terminal config (branch_id etc.) from admin on startup
            if storage::is_configured() {
                let startup_app = app.handle().clone();
                let startup_db = db_for_startup.clone();
                tauri::async_runtime::spawn(async move {
                    let raw_api_key = match storage::get_credential("pos_api_key") {
                        Some(k) => k,
                        None => return,
                    };
                    let api_key = api::extract_api_key_from_connection_string(&raw_api_key)
                        .unwrap_or_else(|| raw_api_key.clone());
                    if api_key != raw_api_key {
                        let _ = storage::set_credential("pos_api_key", api_key.trim());
                    }

                    let terminal_id = storage::get_credential("terminal_id")
                        .or_else(|| api::extract_terminal_id_from_connection_string(&raw_api_key));
                    let terminal_id = match terminal_id {
                        Some(t) if !t.trim().is_empty() => {
                            let _ = storage::set_credential("terminal_id", t.trim());
                            t
                        }
                        _ => return,
                    };

                    let admin_url = storage::get_credential("admin_dashboard_url")
                        .or_else(|| api::extract_admin_url_from_connection_string(&raw_api_key));
                    let admin_url = match admin_url {
                        Some(u) if !u.trim().is_empty() => {
                            let normalized = api::normalize_admin_url(&u);
                            if !normalized.is_empty() {
                                let _ = storage::set_credential(
                                    "admin_dashboard_url",
                                    normalized.trim(),
                                );
                                normalized
                            } else {
                                return;
                            }
                        }
                        _ => return,
                    };

                    let path = format!("/api/pos/settings/{terminal_id}");
                    match api::fetch_from_admin(&admin_url, &api_key, &path, "GET", None).await {
                        Ok(resp) => {
                            if let Some(bid) =
                                extract_branch_id_from_terminal_settings_response(&resp)
                            {
                                let _ = storage::set_credential("branch_id", &bid);
                                info!(branch_id = %bid, "Startup: stored branch_id from admin");
                            }
                            if let Some(oid) = extract_org_id_from_terminal_settings_response(&resp)
                            {
                                let _ = storage::set_credential("organization_id", &oid);
                            }
                            if let Some(supa) = resp.get("supabase") {
                                if let Some(url) = supa.get("url").and_then(|v| v.as_str()) {
                                    if !url.is_empty() {
                                        let _ = storage::set_credential("supabase_url", url);
                                    }
                                }
                                if let Some(key) = supa.get("anon_key").and_then(|v| v.as_str()) {
                                    if !key.is_empty() {
                                        let _ = storage::set_credential("supabase_anon_key", key);
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            warn!("Startup: failed to fetch terminal config: {e}");
                            if is_terminal_auth_failure(&e) {
                                handle_invalid_terminal_credentials(
                                    Some(startup_db.as_ref()),
                                    &startup_app,
                                    "startup_terminal_config_fetch",
                                    &e,
                                );
                            }
                        }
                    }
                });
            }

            info!("Database, auth, sync, and print worker registered");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // App lifecycle
            app_shutdown,
            app_restart,
            app_get_version,
            app_get_shutdown_status,
            system_get_info,
            // Auth
            auth_login,
            auth_logout,
            auth_get_current_session,
            auth_validate_session,
            auth_has_permission,
            auth_get_session_stats,
            auth_setup_pin,
            // Staff auth
            staff_auth_authenticate_pin,
            staff_auth_get_session,
            staff_auth_get_current,
            staff_auth_has_permission,
            staff_auth_has_any_permission,
            staff_auth_logout,
            staff_auth_validate_session,
            staff_auth_track_activity,
            // Settings
            get_settings,
            settings_is_configured,
            settings_get,
            settings_get_local,
            settings_set,
            settings_update_local,
            settings_factory_reset,
            settings_update_terminal_credentials,
            settings_get_admin_url,
            settings_clear_connection,
            settings_get_discount_max,
            settings_set_discount_max,
            settings_get_tax_rate,
            settings_set_tax_rate,
            settings_get_language,
            settings_set_language,
            update_settings,
            // Terminal config
            terminal_config_get_settings,
            terminal_config_get_setting,
            terminal_config_get_branch_id,
            terminal_config_get_terminal_id,
            terminal_config_get_organization_id,
            terminal_config_get_business_type,
            terminal_config_get_full_config,
            terminal_config_refresh,
            // Orders
            order_get_all,
            order_get_by_id,
            order_get_by_customer_phone,
            order_create,
            order_update_status,
            order_update_items,
            order_approve,
            order_decline,
            order_assign_driver,
            order_delete,
            order_save_from_remote,
            order_fetch_items_from_supabase,
            order_notify_platform_ready,
            order_update_preparation,
            order_update_type,
            order_save_for_retry,
            order_get_retry_queue,
            order_process_retry_queue,
            orders_clear_all,
            orders_get_conflicts,
            orders_resolve_conflict,
            orders_force_sync_retry,
            orders_get_retry_info,
            // Sync
            sync_get_status,
            sync_get_network_status,
            sync_get_inter_terminal_status,
            sync_force,
            sync_validate_pending_orders,
            sync_remove_invalid_orders,
            sync_clear_all,
            sync_clear_failed,
            sync_clear_old_orders,
            sync_get_financial_stats,
            sync_get_failed_financial_items,
            sync_retry_financial_item,
            sync_retry_all_failed_financial,
            sync_get_unsynced_financial_summary,
            sync_validate_financial_integrity,
            sync_requeue_orphaned_financial,
            sync_clear_all_orders,
            sync_cleanup_deleted_orders,
            sync_rediscover_parent,
            sync_fetch_tables,
            sync_fetch_reservations,
            sync_fetch_suppliers,
            sync_fetch_analytics,
            sync_fetch_orders,
            sync_fetch_rooms,
            sync_update_room_status,
            sync_fetch_drive_thru,
            sync_update_drive_thru_order_status,
            rooms_get_availability,
            appointments_get_today_metrics,
            // Menu
            menu_get_categories,
            menu_get_subcategories,
            menu_get_ingredients,
            menu_get_subcategory_ingredients,
            menu_get_combos,
            menu_sync,
            menu_update_category,
            menu_update_subcategory,
            menu_update_ingredient,
            menu_update_combo,
            menu_trigger_check_for_updates,
            // Shifts
            shift_open,
            shift_close,
            shift_get_active,
            shift_get_active_by_terminal,
            shift_get_active_by_terminal_loose,
            shift_get_active_cashier_by_terminal,
            shift_get_summary,
            shift_record_expense,
            shift_get_expenses,
            shift_list_staff_for_checkin,
            shift_get_staff_roles,
            shift_record_staff_payment,
            shift_get_staff_payments,
            shift_get_staff_payments_by_staff,
            shift_get_staff_payment_total_for_date,
            shift_get_scheduled_shifts,
            shift_get_today_scheduled_shifts,
            shift_backfill_driver_earnings,
            // Payments
            payment_record,
            payment_void,
            payment_update_payment_status,
            payment_get_order_payments,
            payment_get_receipt_preview,
            // Refunds / Adjustments
            refund_payment,
            refund_void_payment,
            refund_list_order_adjustments,
            refund_get_payment_balance,
            // Z-Reports
            zreport_generate,
            zreport_get,
            zreport_list,
            zreport_print,
            // Print
            payment_print_receipt,
            kitchen_print_ticket,
            print_list_jobs,
            print_get_receipt_file,
            print_reprint_job,
            label_print,
            label_print_batch,
            // Screen capture / Geo
            screen_capture_get_sources,
            geo_ip,
            // Legacy printer manager channels
            printer_scan_network,
            printer_scan_bluetooth,
            printer_discover,
            printer_add,
            printer_update,
            printer_remove,
            printer_get_all,
            printer_get,
            printer_get_status,
            printer_get_all_statuses,
            printer_submit_job,
            printer_cancel_job,
            printer_retry_job,
            printer_test,
            printer_test_greek_direct,
            printer_diagnostics,
            printer_bluetooth_status,
            printer_open_cash_drawer,
            // Printer profiles
            printer_list_system_printers,
            printer_create_profile,
            printer_update_profile,
            printer_delete_profile,
            printer_list_profiles,
            printer_get_profile,
            printer_set_default_profile,
            printer_get_default_profile,
            // ECR
            ecr_discover_devices,
            ecr_get_devices,
            ecr_get_device,
            ecr_add_device,
            ecr_update_device,
            ecr_remove_device,
            ecr_get_default_terminal,
            ecr_connect_device,
            ecr_disconnect_device,
            ecr_get_device_status,
            ecr_get_all_statuses,
            ecr_process_payment,
            ecr_process_refund,
            ecr_void_transaction,
            ecr_cancel_transaction,
            ecr_settlement,
            ecr_get_recent_transactions,
            ecr_query_transactions,
            ecr_get_transaction_stats,
            ecr_get_transaction_for_order,
            // Cash drawer
            drawer_open,
            // Dashboard metrics
            inventory_get_stock_metrics,
            products_get_catalog_count,
            // Customers
            customer_invalidate_cache,
            customer_get_cache_stats,
            customer_clear_cache,
            customer_lookup_by_phone,
            customer_lookup_by_id,
            customer_search,
            customer_create,
            customer_update,
            customer_update_ban_status,
            customer_add_address,
            customer_update_address,
            customer_resolve_conflict,
            customer_get_conflicts,
            // Drivers
            driver_record_earning,
            driver_get_earnings,
            driver_get_shift_summary,
            driver_get_active,
            // Delivery zones
            delivery_zone_track_validation,
            delivery_zone_get_analytics,
            delivery_zone_request_override,
            // Reports
            report_get_today_statistics,
            report_get_sales_trend,
            report_get_top_items,
            report_get_weekly_top_items,
            report_generate_z_report,
            report_get_daily_staff_performance,
            report_submit_z_report,
            // Modules
            modules_fetch_from_admin,
            modules_get_cached,
            modules_save_cache,
            // Utility compatibility
            clipboard_read_text,
            clipboard_write_text,
            show_notification,
            // Window
            window_get_state,
            window_minimize,
            window_maximize,
            window_close,
            window_toggle_fullscreen,
            window_reload,
            window_force_reload,
            window_toggle_devtools,
            window_zoom_in,
            window_zoom_out,
            window_zoom_reset,
            // Database
            database_health_check,
            database_get_stats,
            database_reset,
            database_clear_operational_data,
            // Diagnostics
            diagnostics_get_about,
            diagnostics_get_system_health,
            diagnostics_export,
            // Updates
            update_get_state,
            update_check,
            update_download,
            update_cancel_download,
            update_install,
            update_set_channel,
            // API proxy
            api_fetch_from_admin,
            sync_test_parent_connection,
            admin_sync_terminal_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running The Small POS");
}
