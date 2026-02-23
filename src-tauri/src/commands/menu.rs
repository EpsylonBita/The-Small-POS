use chrono::Utc;
use serde::Deserialize;
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Emitter;
use tracing::{debug, info, warn};

use crate::{
    admin_fetch, db, handle_invalid_terminal_credentials,
    hydrate_terminal_credentials_from_local_settings, is_terminal_auth_failure, mask_terminal_id,
    maybe_lazy_warm_menu_cache, menu, read_local_setting, storage, value_str,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MenuSubcategoryPayload {
    #[serde(alias = "subcategory_id", alias = "id")]
    subcategory_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MenuCategoryUpdatePayload {
    #[serde(alias = "categoryId", alias = "category_id")]
    id: String,
    #[serde(alias = "isActive", alias = "is_active")]
    is_active: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MenuSubcategoryUpdatePayload {
    #[serde(alias = "subcategoryId", alias = "subcategory_id")]
    id: String,
    #[serde(alias = "isAvailable", alias = "is_available")]
    is_available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MenuIngredientUpdatePayload {
    #[serde(alias = "ingredientId", alias = "ingredient_id")]
    id: String,
    #[serde(alias = "isAvailable", alias = "is_available")]
    is_available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MenuComboUpdatePayload {
    #[serde(alias = "comboId", alias = "combo_id")]
    id: String,
    #[serde(alias = "isActive", alias = "is_active")]
    is_active: bool,
}

const MENU_VERSION_MONITOR_MIN_INTERVAL_SECS: u64 = 10;
const MENU_MONITOR_WARN_THROTTLE_SECS: u64 = 300;
const MENU_MONITOR_OFFLINE_LOG_THROTTLE_SECS: u64 = 120;
static MENU_PAYLOAD_WARN_STATE: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
static MENU_OFFLINE_INFO_STATE: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

fn should_emit_menu_payload_warn() -> bool {
    let now = Instant::now();
    let guard = MENU_PAYLOAD_WARN_STATE
        .get_or_init(|| Mutex::new(None))
        .lock();
    let Ok(mut last_warned_at) = guard else {
        return true;
    };

    match *last_warned_at {
        Some(previous) if previous.elapsed().as_secs() < MENU_MONITOR_WARN_THROTTLE_SECS => false,
        _ => {
            *last_warned_at = Some(now);
            true
        }
    }
}

fn should_emit_menu_offline_info() -> bool {
    let now = Instant::now();
    let guard = MENU_OFFLINE_INFO_STATE
        .get_or_init(|| Mutex::new(None))
        .lock();
    let Ok(mut last_info_at) = guard else {
        return true;
    };

    match *last_info_at {
        Some(previous) if previous.elapsed().as_secs() < MENU_MONITOR_OFFLINE_LOG_THROTTLE_SECS => {
            false
        }
        _ => {
            *last_info_at = Some(now);
            true
        }
    }
}

fn is_menu_payload_shape_error(error: &str) -> bool {
    error.contains("Menu sync response missing menu payload")
        || error.contains("Menu sync payload is missing all menu sections")
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

fn menu_sync_snapshot(result: &serde_json::Value) -> (bool, String, serde_json::Value, String) {
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
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let timestamp = if timestamp.is_empty() {
        Utc::now().to_rfc3339()
    } else {
        timestamp
    };

    (updated, version, counts, timestamp)
}

fn emit_menu_sync_event(
    app: &tauri::AppHandle,
    source: &str,
    updated: bool,
    version: &str,
    counts: &serde_json::Value,
    timestamp: &str,
) {
    let _ = app.emit(
        "menu_sync",
        serde_json::json!({
            "source": source,
            "updated": updated,
            "version": version,
            "counts": counts,
            "timestamp": timestamp,
        }),
    );
}

fn emit_menu_version_checked_event(
    app: &tauri::AppHandle,
    source: &str,
    success: bool,
    updated: bool,
    version: Option<&str>,
    counts: Option<&serde_json::Value>,
    error: Option<&str>,
) {
    let payload = serde_json::json!({
        "source": source,
        "success": success,
        "updated": updated,
        "version": version,
        "counts": counts,
        "error": error,
        "checkedAt": Utc::now().to_rfc3339(),
    });
    let _ = app.emit("menu_version_checked", payload);
}

fn merge_menu_payload_args(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> serde_json::Value {
    match (arg0, arg1) {
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
    }
}

fn parse_menu_subcategory_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(subcategory_id)) => serde_json::json!({
            "subcategoryId": subcategory_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let mut parsed: MenuSubcategoryPayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid subcategory payload: {e}"))?;
    parsed.subcategory_id = parsed.subcategory_id.trim().to_string();
    if parsed.subcategory_id.is_empty() {
        return Err("Missing subcategoryId".into());
    }
    Ok(parsed.subcategory_id)
}

fn parse_menu_category_update_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<MenuCategoryUpdatePayload, String> {
    let payload = merge_menu_payload_args(arg0, arg1);
    let mut parsed: MenuCategoryUpdatePayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid category update payload: {e}"))?;
    parsed.id = parsed.id.trim().to_string();
    if parsed.id.is_empty() {
        return Err("Missing category id".into());
    }
    Ok(parsed)
}

fn parse_menu_subcategory_update_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<MenuSubcategoryUpdatePayload, String> {
    let payload = merge_menu_payload_args(arg0, arg1);
    let mut parsed: MenuSubcategoryUpdatePayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid subcategory update payload: {e}"))?;
    parsed.id = parsed.id.trim().to_string();
    if parsed.id.is_empty() {
        return Err("Missing subcategory id".into());
    }
    Ok(parsed)
}

fn parse_menu_ingredient_update_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<MenuIngredientUpdatePayload, String> {
    let payload = merge_menu_payload_args(arg0, arg1);
    let mut parsed: MenuIngredientUpdatePayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid ingredient update payload: {e}"))?;
    parsed.id = parsed.id.trim().to_string();
    if parsed.id.is_empty() {
        return Err("Missing ingredient id".into());
    }
    Ok(parsed)
}

fn parse_menu_combo_update_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<MenuComboUpdatePayload, String> {
    let payload = merge_menu_payload_args(arg0, arg1);
    let mut parsed: MenuComboUpdatePayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid combo update payload: {e}"))?;
    parsed.id = parsed.id.trim().to_string();
    if parsed.id.is_empty() {
        return Err("Missing combo id".into());
    }
    Ok(parsed)
}

pub fn start_menu_version_monitor(app: tauri::AppHandle, db: Arc<db::DbState>, interval_secs: u64) {
    let cadence = Duration::from_secs(interval_secs.max(MENU_VERSION_MONITOR_MIN_INTERVAL_SECS));

    tauri::async_runtime::spawn(async move {
        info!(
            interval_secs = cadence.as_secs(),
            "Starting menu version monitor"
        );

        loop {
            if storage::is_configured() {
                hydrate_terminal_credentials_from_local_settings(db.as_ref());

                match menu::sync_menu(db.as_ref()).await {
                    Ok(result) => {
                        let (updated, version, counts, timestamp) = menu_sync_snapshot(&result);
                        emit_menu_version_checked_event(
                            &app,
                            "menu_version_monitor",
                            true,
                            updated,
                            Some(&version),
                            Some(&counts),
                            None,
                        );

                        if updated {
                            emit_menu_sync_event(
                                &app,
                                "menu_version_monitor",
                                true,
                                &version,
                                &counts,
                                &timestamp,
                            );
                        }
                    }
                    Err(error) => {
                        let mut success = false;
                        let mut event_error: Option<&str> = Some(error.as_str());

                        if is_terminal_auth_failure(&error) {
                            handle_invalid_terminal_credentials(
                                Some(db.as_ref()),
                                &app,
                                "menu_version_monitor",
                                &error,
                            );
                        } else if is_menu_connectivity_error(&error) {
                            if should_emit_menu_offline_info() {
                                info!(
                                    error = %error,
                                    throttle_secs = MENU_MONITOR_OFFLINE_LOG_THROTTLE_SECS,
                                    "Menu version monitor offline; continuing with cached menu"
                                );
                            } else {
                                debug!(
                                    error = %error,
                                    "Menu version monitor offline log suppressed by throttle"
                                );
                            }
                            success = true;
                            event_error = None;
                        } else if is_menu_payload_shape_error(&error) {
                            if should_emit_menu_payload_warn() {
                                warn!(
                                    error = %error,
                                    throttle_secs = MENU_MONITOR_WARN_THROTTLE_SECS,
                                    "Menu version monitor sync payload missing expected sections"
                                );
                            } else {
                                debug!(
                                    error = %error,
                                    "Menu version monitor payload warning suppressed by throttle"
                                );
                            }
                        } else {
                            warn!(
                                error = %error,
                                "Menu version monitor sync iteration failed"
                            );
                        }
                        emit_menu_version_checked_event(
                            &app,
                            "menu_version_monitor",
                            success,
                            false,
                            None,
                            None,
                            event_error,
                        );
                    }
                }
            }

            tokio::time::sleep(cadence).await;
        }
    });
}

#[tauri::command]
pub async fn menu_get_categories(
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
pub async fn menu_get_subcategories(
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
pub async fn menu_get_ingredients(
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
pub async fn menu_get_subcategory_ingredients(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let subcategory_id = parse_menu_subcategory_payload(arg0)?;
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
pub async fn menu_get_combos(
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
pub async fn menu_sync(
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
            let (updated, version, counts, timestamp) = menu_sync_snapshot(&result);

            emit_menu_sync_event(
                &app,
                "menu_sync_command",
                updated,
                &version,
                &counts,
                &timestamp,
            );

            info!(
                terminal_id = %masked_terminal_id,
                updated = updated,
                version = %version,
                "menu_sync command: completed"
            );

            emit_menu_version_checked_event(
                &app,
                "menu_sync_command",
                true,
                updated,
                Some(&version),
                Some(&counts),
                None,
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
                emit_menu_version_checked_event(
                    &app,
                    "menu_sync_command",
                    false,
                    false,
                    None,
                    None,
                    Some(error.as_str()),
                );
                return Ok(serde_json::json!({
                    "success": false,
                    "errorCode": "invalid_terminal_credentials",
                    "error": error
                }));
            }

            if is_menu_connectivity_error(&error) {
                if should_emit_menu_offline_info() {
                    info!(
                        terminal_id = %masked_terminal_id,
                        error = %error,
                        "menu_sync command: offline; returning cached-menu status"
                    );
                } else {
                    debug!(
                        terminal_id = %masked_terminal_id,
                        error = %error,
                        "menu_sync command offline log suppressed by throttle"
                    );
                }
                emit_menu_version_checked_event(
                    &app,
                    "menu_sync_command",
                    true,
                    false,
                    None,
                    None,
                    None,
                );
                return Ok(serde_json::json!({
                    "success": true,
                    "updated": false,
                    "offline": true
                }));
            }

            warn!(
                terminal_id = %masked_terminal_id,
                error = %error,
                "menu_sync command: failed"
            );
            emit_menu_version_checked_event(
                &app,
                "menu_sync_command",
                false,
                false,
                None,
                None,
                Some(error.as_str()),
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
pub async fn menu_update_category(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_menu_category_update_payload(arg0, arg1)?;
    let id = payload.id;
    let is_active = payload.is_active;

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
pub async fn menu_update_subcategory(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_menu_subcategory_update_payload(arg0, arg1)?;
    let id = payload.id;
    let is_available = payload.is_available;

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
pub async fn menu_update_ingredient(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_menu_ingredient_update_payload(arg0, arg1)?;
    let id = payload.id;
    let is_available = payload.is_available;

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
pub async fn menu_update_combo(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_menu_combo_update_payload(arg0, arg1)?;
    let id = payload.id;
    let is_active = payload.is_active;
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
pub async fn menu_trigger_check_for_updates(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let _ = app.emit(
        "menu_check_for_updates",
        serde_json::json!({ "source": "menu" }),
    );
    Ok(serde_json::json!({ "success": true }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_menu_subcategory_payload_supports_string_and_object() {
        let from_string = parse_menu_subcategory_payload(Some(serde_json::json!("sub-1")))
            .expect("string payload should parse");
        let from_object = parse_menu_subcategory_payload(Some(serde_json::json!({
            "subcategoryId": "sub-2"
        })))
        .expect("object payload should parse");
        assert_eq!(from_string, "sub-1");
        assert_eq!(from_object, "sub-2");
    }

    #[test]
    fn parse_menu_category_update_payload_supports_legacy_tuple() {
        let parsed = parse_menu_category_update_payload(
            Some(serde_json::json!("cat-1")),
            Some(serde_json::json!({ "isActive": true })),
        )
        .expect("legacy tuple payload should parse");
        assert_eq!(parsed.id, "cat-1");
        assert!(parsed.is_active);
    }

    #[test]
    fn parse_menu_subcategory_update_payload_supports_aliases() {
        let parsed = parse_menu_subcategory_update_payload(
            Some(serde_json::json!({
                "subcategory_id": "sub-3",
                "is_available": false
            })),
            None,
        )
        .expect("alias payload should parse");
        assert_eq!(parsed.id, "sub-3");
        assert!(!parsed.is_available);
    }

    #[test]
    fn parse_menu_ingredient_update_payload_rejects_missing_flag() {
        let err = parse_menu_ingredient_update_payload(
            Some(serde_json::json!({ "ingredientId": "ing-1" })),
            None,
        )
        .expect_err("missing isAvailable should fail");
        assert!(err.contains("Invalid ingredient update payload"));
    }

    #[test]
    fn parse_menu_combo_update_payload_supports_object() {
        let parsed = parse_menu_combo_update_payload(
            Some(serde_json::json!({
                "comboId": "combo-1",
                "isActive": true
            })),
            None,
        )
        .expect("combo payload should parse");
        assert_eq!(parsed.id, "combo-1");
        assert!(parsed.is_active);
    }

    #[test]
    fn menu_sync_snapshot_defaults_missing_fields() {
        let (updated, version, counts, timestamp) = menu_sync_snapshot(&serde_json::json!({}));
        assert!(!updated);
        assert_eq!(version, "unknown");
        assert_eq!(
            counts.get("categories").and_then(|value| value.as_u64()),
            Some(0)
        );
        assert!(!timestamp.trim().is_empty());
    }
}
