//! Menu cache layer for The Small POS.
//!
//! Reads cached menu data (categories, subcategories, ingredients, combos)
//! from the local SQLite `menu_cache` table, and provides a sync function
//! that fetches fresh data from the admin dashboard API.

use chrono::Utc;
use rusqlite::params;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tracing::{error, trace, warn};

use crate::api;
use crate::db::DbState;
use crate::storage;

#[derive(Debug, Clone)]
pub struct MenuVersionDigest {
    pub token: String,
    pub latest_updated_at: Option<String>,
    pub counts: Value,
    #[allow(dead_code)]
    pub timestamp: String,
}

#[derive(Debug, Clone)]
struct MenuSyncCredentials {
    api_key: String,
    terminal_id: String,
    admin_url: String,
}

// ---------------------------------------------------------------------------
// Cache readers
// ---------------------------------------------------------------------------

/// Read a cached menu array by key. Returns an empty array on miss or error.
fn read_cache(db: &DbState, cache_key: &str) -> Vec<Value> {
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(e) => {
            error!("menu cache lock failed: {e}");
            return vec![];
        }
    };

    let json_str: Option<String> = conn
        .query_row(
            "SELECT data FROM menu_cache WHERE cache_key = ?1",
            params![cache_key],
            |row| row.get(0),
        )
        .ok();

    match json_str {
        Some(s) => match serde_json::from_str::<Value>(&s) {
            Ok(Value::Array(arr)) => arr,
            Ok(other) => {
                warn!("menu_cache[{cache_key}] is not an array, wrapping");
                vec![other]
            }
            Err(e) => {
                error!("menu_cache[{cache_key}] JSON parse error: {e}");
                vec![]
            }
        },
        None => vec![],
    }
}

/// Get cached categories.
pub fn get_categories(db: &DbState) -> Vec<Value> {
    read_cache(db, "categories")
}

/// Get cached subcategories.
pub fn get_subcategories(db: &DbState) -> Vec<Value> {
    read_cache(db, "subcategories")
}

/// Get cached ingredients (menu items).
pub fn get_ingredients(db: &DbState) -> Vec<Value> {
    read_cache(db, "ingredients")
}

/// Get cached combos.
pub fn get_combos(db: &DbState) -> Vec<Value> {
    read_cache(db, "combos")
}

fn section_count(data: &Value, key: &str) -> usize {
    data.get(key)
        .and_then(Value::as_array)
        .map(|arr| arr.len())
        .unwrap_or(0)
}

fn section_or_empty(data: &Value, key: &str) -> Value {
    data.get(key)
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            let mut normalized = serde_json::Map::new();
            for key in keys {
                if let Some(entry) = map.get(key) {
                    normalized.insert(key.clone(), canonicalize_json(entry));
                }
            }
            Value::Object(normalized)
        }
        Value::Array(arr) => {
            let mut normalized_items: Vec<(String, Value)> = arr
                .iter()
                .map(|item| {
                    let normalized = canonicalize_json(item);
                    let as_string =
                        serde_json::to_string(&normalized).unwrap_or_else(|_| "null".to_string());
                    (as_string, normalized)
                })
                .collect();
            normalized_items.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Array(
                normalized_items
                    .into_iter()
                    .map(|(_, normalized)| normalized)
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

fn hash_canonical_json(value: &Value) -> String {
    let normalized = canonicalize_json(value);
    let serialized = serde_json::to_string(&normalized).unwrap_or_else(|_| "{}".to_string());
    let mut hasher = DefaultHasher::new();
    serialized.hash(&mut hasher);
    format!("digest:{:016x}", hasher.finish())
}

/// Compute a stable local version from the actual menu sections we cache.
/// This avoids treating response timestamps as menu-version changes.
fn compute_menu_payload_version(data: &Value) -> String {
    let snapshot = serde_json::json!({
        "categories": section_or_empty(data, "categories"),
        "subcategories": section_or_empty(data, "subcategories"),
        "ingredients": section_or_empty(data, "ingredients"),
        "combos": section_or_empty(data, "combos"),
    });

    hash_canonical_json(&snapshot)
}

fn normalize_non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn parse_count(value: Option<&Value>) -> u64 {
    let Some(raw) = value else {
        return 0;
    };

    if let Some(parsed) = raw.as_u64() {
        return parsed;
    }
    if let Some(parsed) = raw.as_i64().filter(|n| *n >= 0) {
        return parsed as u64;
    }
    if let Some(parsed) = raw.as_f64().filter(|n| *n >= 0.0) {
        return parsed as u64;
    }
    if let Some(parsed) = raw
        .as_str()
        .and_then(|text| text.trim().parse::<u64>().ok())
    {
        return parsed;
    }
    0
}

fn normalize_digest_counts(payload: &Value) -> Value {
    let counts = payload.get("counts");
    let categories = parse_count(
        counts
            .and_then(|c| c.get("categories"))
            .or_else(|| counts.and_then(|c| c.get("menu_categories"))),
    );
    let subcategories = parse_count(
        counts
            .and_then(|c| c.get("subcategories"))
            .or_else(|| counts.and_then(|c| c.get("menu_subcategories"))),
    );
    let ingredients = parse_count(
        counts
            .and_then(|c| c.get("ingredients"))
            .or_else(|| counts.and_then(|c| c.get("menu_ingredients"))),
    );
    let combos = parse_count(
        counts
            .and_then(|c| c.get("combos"))
            .or_else(|| counts.and_then(|c| c.get("menu_combos"))),
    );

    serde_json::json!({
        "categories": categories,
        "subcategories": subcategories,
        "ingredients": ingredients,
        "combos": combos
    })
}

fn build_menu_version_token(
    payload: &Value,
    latest_updated_at: Option<&str>,
    counts: &Value,
) -> String {
    let snapshot = serde_json::json!({
        "latest_updated_at": latest_updated_at,
        "last_updated": payload.get("last_updated").cloned().unwrap_or(Value::Null),
        "counts": counts
    });
    hash_canonical_json(&snapshot)
}

fn resolve_menu_sync_credentials() -> Result<MenuSyncCredentials, String> {
    let raw_api_key =
        storage::get_credential("pos_api_key").ok_or("Terminal not configured: missing API key")?;
    let api_key = api::extract_api_key_from_connection_string(&raw_api_key)
        .unwrap_or_else(|| raw_api_key.clone());
    let terminal_id = storage::get_credential("terminal_id")
        .or_else(|| api::extract_terminal_id_from_connection_string(&raw_api_key))
        .ok_or("Terminal not configured: missing terminal ID")?;
    let admin_url = storage::get_credential("admin_dashboard_url")
        .or_else(|| api::extract_admin_url_from_connection_string(&raw_api_key))
        .ok_or("Terminal not configured: missing admin URL")?;

    if storage::get_credential("terminal_id").is_none() {
        let _ = storage::set_credential("terminal_id", terminal_id.trim());
    }
    if storage::get_credential("admin_dashboard_url").is_none() {
        let _ = storage::set_credential("admin_dashboard_url", admin_url.trim());
    }
    if api_key != raw_api_key {
        let _ = storage::set_credential("pos_api_key", api_key.trim());
    }

    Ok(MenuSyncCredentials {
        api_key,
        terminal_id,
        admin_url,
    })
}

pub async fn fetch_menu_version_digest(_db: &DbState) -> Result<MenuVersionDigest, String> {
    let credentials = resolve_menu_sync_credentials()?;
    let terminal_id_for_query = validate_terminal_id_for_query(&credentials.terminal_id)?;
    let path = format!("/api/pos/menu-version?terminal_id={terminal_id_for_query}");
    let masked_terminal_id = mask_terminal_id(&credentials.terminal_id);
    trace!(
        terminal_id = %masked_terminal_id,
        path = %path,
        "menu_version_digest: requesting digest from admin"
    );

    let payload = match api::fetch_from_admin(
        &credentials.admin_url,
        &credentials.api_key,
        &path,
        "GET",
        None,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            if !is_menu_connectivity_error(&error) {
                warn!(
                    terminal_id = %masked_terminal_id,
                    path = %path,
                    error = %error,
                    "menu_version_digest: admin request failed"
                );
            }
            return Err(error);
        }
    };

    if payload
        .get("success")
        .and_then(Value::as_bool)
        .is_some_and(|success| !success)
    {
        let message = normalize_non_empty_string(payload.get("error"))
            .unwrap_or_else(|| "Menu version digest request failed".to_string());
        return Err(message);
    }

    let counts = normalize_digest_counts(&payload);
    let latest_updated_at = normalize_non_empty_string(payload.get("latest_updated_at"));
    let timestamp = normalize_non_empty_string(payload.get("timestamp"))
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let token = build_menu_version_token(&payload, latest_updated_at.as_deref(), &counts);

    Ok(MenuVersionDigest {
        token,
        latest_updated_at,
        counts,
        timestamp,
    })
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

fn validate_terminal_id_for_query(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Terminal not configured: missing terminal ID".to_string());
    }
    if trimmed.len() > 128 {
        return Err("Terminal ID is too long".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Terminal ID contains unsupported characters".to_string());
    }
    Ok(trimmed)
}

fn is_menu_connectivity_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("cannot reach admin dashboard")
        || lower.contains("network error")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connection refused")
        || lower.contains("connection reset")
        || lower.contains("failed to lookup address")
        || lower.contains("dns")
}

// ---------------------------------------------------------------------------
// Sync from admin dashboard
// ---------------------------------------------------------------------------

/// Fetch menu data from the admin dashboard and update the local cache.
///
/// Calls `GET /api/pos/menu-sync` with the terminal's API key, then
/// upserts each menu section into the `menu_cache` table.
pub async fn sync_menu(db: &DbState) -> Result<Value, String> {
    let credentials = resolve_menu_sync_credentials()?;

    let terminal_id_for_query = validate_terminal_id_for_query(&credentials.terminal_id)?;
    let path = format!(
        "/api/pos/menu-sync?terminal_id={terminal_id_for_query}&last_sync=1970-01-01T00%3A00%3A00.000Z&include_inactive=false"
    );
    let masked_terminal_id = mask_terminal_id(&credentials.terminal_id);
    trace!(
        terminal_id = %masked_terminal_id,
        path = %path,
        "menu_sync: requesting menu payload from admin"
    );
    let resp = match api::fetch_from_admin(
        &credentials.admin_url,
        &credentials.api_key,
        &path,
        "GET",
        None,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            if !is_menu_connectivity_error(&error) {
                warn!(
                    terminal_id = %masked_terminal_id,
                    path = %path,
                    error = %error,
                    "menu_sync: admin request failed"
                );
            }
            return Err(error);
        }
    };

    // Admin contract shape:
    // { success, menu_data: { categories, subcategories, ingredients, combos, ... }, timestamp, ... }
    // Keep compatibility with legacy wrappers that returned { data: ... }.
    let data = resp
        .get("menu_data")
        .or_else(|| resp.get("data").and_then(|d| d.get("menu_data")))
        .or_else(|| resp.get("data"))
        .or_else(|| {
            if resp.get("categories").is_some()
                || resp.get("subcategories").is_some()
                || resp.get("ingredients").is_some()
                || resp.get("combos").is_some()
            {
                Some(&resp)
            } else {
                None
            }
        })
        .ok_or("Menu sync response missing menu payload")?;

    if data.get("categories").is_none()
        && data.get("subcategories").is_none()
        && data.get("ingredients").is_none()
        && data.get("combos").is_none()
    {
        return Err("Menu sync payload is missing all menu sections".to_string());
    }

    let category_count = section_count(data, "categories");
    let subcategory_count = section_count(data, "subcategories");
    let ingredient_count = section_count(data, "ingredients");
    let combo_count = section_count(data, "combos");
    let counts = serde_json::json!({
        "categories": category_count,
        "subcategories": subcategory_count,
        "ingredients": ingredient_count,
        "combos": combo_count
    });

    let version = compute_menu_payload_version(data);
    let timestamp = resp
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    // Check if version matches current cache to skip unnecessary writes
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let cached_version: Option<String> = conn
            .query_row(
                "SELECT version FROM menu_cache WHERE cache_key = 'categories'",
                [],
                |row| row.get(0),
            )
            .ok()
            .flatten();

        if cached_version.as_deref() == Some(version.as_str()) {
            trace!(
                terminal_id = %masked_terminal_id,
                version = %version,
                categories = category_count,
                subcategories = subcategory_count,
                ingredients = ingredient_count,
                combos = combo_count,
                "menu_sync: cache already at latest version"
            );
            return Ok(serde_json::json!({
                "success": true,
                "updated": false,
                "version": version,
                "counts": counts,
                "timestamp": timestamp
            }));
        }
    }

    // Upsert each section
    let sections = ["categories", "subcategories", "ingredients", "combos"];
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    for section in &sections {
        let empty = Value::Array(vec![]);
        let section_data = data.get(*section).unwrap_or(&empty);
        let json_str =
            serde_json::to_string(section_data).map_err(|e| format!("serialize {section}: {e}"))?;

        conn.execute(
            "INSERT INTO menu_cache (id, cache_key, data, version, updated_at)
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, datetime('now'))
             ON CONFLICT(cache_key) DO UPDATE SET
                data = excluded.data,
                version = excluded.version,
                updated_at = excluded.updated_at",
            params![*section, json_str, version],
        )
        .map_err(|e| format!("upsert menu_cache[{section}]: {e}"))?;
    }

    trace!(
        terminal_id = %masked_terminal_id,
        version = %version,
        categories = category_count,
        subcategories = subcategory_count,
        ingredients = ingredient_count,
        combos = combo_count,
        "menu_sync: cache updated"
    );

    Ok(serde_json::json!({
        "success": true,
        "updated": true,
        "version": version,
        "counts": counts,
        "timestamp": if timestamp.trim().is_empty() { Utc::now().to_rfc3339() } else { timestamp }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_version_is_order_invariant() {
        let first = serde_json::json!({
            "categories": [
                { "id": "c2", "display_order": 2 },
                { "id": "c1", "display_order": 1 }
            ],
            "subcategories": [
                { "id": "s2", "name": "B" },
                { "id": "s1", "name": "A" }
            ],
            "ingredients": [],
            "combos": []
        });
        let second = serde_json::json!({
            "categories": [
                { "display_order": 1, "id": "c1" },
                { "display_order": 2, "id": "c2" }
            ],
            "subcategories": [
                { "name": "A", "id": "s1" },
                { "name": "B", "id": "s2" }
            ],
            "ingredients": [],
            "combos": []
        });

        assert_eq!(
            compute_menu_payload_version(&first),
            compute_menu_payload_version(&second)
        );
    }

    #[test]
    fn payload_version_changes_when_content_changes() {
        let base = serde_json::json!({
            "categories": [{ "id": "c1", "name": "Savory" }],
            "subcategories": [],
            "ingredients": [],
            "combos": []
        });
        let changed = serde_json::json!({
            "categories": [{ "id": "c1", "name": "Sweet" }],
            "subcategories": [],
            "ingredients": [],
            "combos": []
        });

        assert_ne!(
            compute_menu_payload_version(&base),
            compute_menu_payload_version(&changed)
        );
    }

    #[test]
    fn menu_version_token_is_stable_for_equivalent_payloads() {
        let first = serde_json::json!({
            "latest_updated_at": "2026-02-25T10:00:00Z",
            "last_updated": {
                "subcategories": "2026-02-25T09:00:00Z",
                "menu_categories": "2026-02-25T08:00:00Z",
                "ingredients": "2026-02-25T09:30:00Z",
                "menu_combos": "2026-02-25T07:00:00Z"
            },
            "counts": {
                "menu_categories": 4,
                "subcategories": 12,
                "ingredients": 33,
                "menu_combos": 2
            }
        });
        let second = serde_json::json!({
            "counts": {
                "ingredients": 33,
                "menu_combos": 2,
                "subcategories": 12,
                "menu_categories": 4
            },
            "last_updated": {
                "menu_combos": "2026-02-25T07:00:00Z",
                "ingredients": "2026-02-25T09:30:00Z",
                "menu_categories": "2026-02-25T08:00:00Z",
                "subcategories": "2026-02-25T09:00:00Z"
            },
            "latest_updated_at": "2026-02-25T10:00:00Z"
        });

        let first_counts = normalize_digest_counts(&first);
        let second_counts = normalize_digest_counts(&second);
        let first_token = build_menu_version_token(
            &first,
            first.get("latest_updated_at").and_then(Value::as_str),
            &first_counts,
        );
        let second_token = build_menu_version_token(
            &second,
            second.get("latest_updated_at").and_then(Value::as_str),
            &second_counts,
        );
        assert_eq!(first_token, second_token);
    }
}
