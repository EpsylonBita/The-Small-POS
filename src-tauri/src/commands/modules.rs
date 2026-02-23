use chrono::Utc;
use serde::Deserialize;
use tauri::Emitter;

use crate::{db, storage};

#[derive(Debug, Default)]
struct ModulesSaveCachePayload {
    modules: Vec<serde_json::Value>,
    organization_id: Option<String>,
    terminal_id: Option<String>,
    api_timestamp: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ModulesSaveCacheObject {
    #[serde(default)]
    modules: Option<Vec<serde_json::Value>>,
    #[serde(default, alias = "apiModules")]
    api_modules: Option<Vec<serde_json::Value>>,
    #[serde(default, alias = "organization_id")]
    organization_id: Option<String>,
    #[serde(default, alias = "terminal_id")]
    terminal_id: Option<String>,
    #[serde(default, alias = "api_timestamp")]
    api_timestamp: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_modules_save_cache_payload(arg0: Option<serde_json::Value>) -> ModulesSaveCachePayload {
    match arg0 {
        Some(serde_json::Value::Array(arr)) => ModulesSaveCachePayload {
            modules: arr,
            organization_id: None,
            terminal_id: None,
            api_timestamp: None,
        },
        Some(serde_json::Value::Object(obj)) => {
            let parsed: ModulesSaveCacheObject =
                serde_json::from_value(serde_json::Value::Object(obj.clone())).unwrap_or_default();
            let modules = parsed
                .modules
                .or(parsed.api_modules)
                .or_else(|| {
                    obj.get("modules")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .or_else(|| obj.get("apiModules").and_then(|v| v.as_array()).cloned())
                })
                .unwrap_or_default();

            ModulesSaveCachePayload {
                modules,
                organization_id: normalize_optional_string(parsed.organization_id),
                terminal_id: normalize_optional_string(parsed.terminal_id),
                api_timestamp: normalize_optional_string(parsed.api_timestamp.or(parsed.timestamp)),
            }
        }
        _ => ModulesSaveCachePayload::default(),
    }
}

#[tauri::command]
pub async fn modules_fetch_from_admin(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    crate::hydrate_terminal_credentials_from_local_settings(&db);

    let terminal_id = storage::get_credential("terminal_id")
        .or_else(|| crate::read_local_setting(&db, "terminal", "terminal_id"))
        .ok_or("Terminal not configured: missing terminal_id")?;
    if storage::get_credential("terminal_id").is_none() && !terminal_id.trim().is_empty() {
        let _ = storage::set_credential("terminal_id", &terminal_id);
    }
    let path = format!("/api/pos/modules/enabled?terminal_id={terminal_id}");

    match crate::admin_fetch(Some(&db), &path, "GET", None).await {
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
                .unwrap_or_else(|| crate::stats_for_modules(&api_modules));
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
            let _ = crate::write_module_cache(&db, &cache_payload);
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
        Err(fetch_err) => match crate::read_module_cache(&db) {
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
                        "stats": crate::stats_for_modules(
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
pub async fn modules_get_cached(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let cache = match crate::read_module_cache(&db) {
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
    let is_valid = cache_age < crate::MODULE_CACHE_TTL_MS;

    Ok(serde_json::json!({
        "success": true,
        "modules": {
            "success": true,
            "modules": api_modules,
            "organization_id": organization_id,
            "terminal_id": terminal_id,
            "timestamp": api_timestamp,
            "stats": crate::stats_for_modules(
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
pub async fn modules_save_cache(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_modules_save_cache_payload(arg0);

    let organization_id = parsed
        .organization_id
        .or_else(|| storage::get_credential("organization_id"))
        .unwrap_or_default();
    let terminal_id = parsed
        .terminal_id
        .or_else(|| storage::get_credential("terminal_id"))
        .unwrap_or_default();
    let api_timestamp = parsed
        .api_timestamp
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    let cache_payload = serde_json::json!({
        "apiModules": parsed.modules,
        "organizationId": organization_id,
        "terminalId": terminal_id,
        "timestamp": Utc::now().timestamp_millis(),
        "apiTimestamp": api_timestamp,
    });
    crate::write_module_cache(&db, &cache_payload)?;
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

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_modules_save_cache_payload_supports_array_payload() {
        let parsed = parse_modules_save_cache_payload(Some(serde_json::json!([
            { "module_id": "orders" },
            { "module_id": "reports" }
        ])));
        assert_eq!(parsed.modules.len(), 2);
        assert!(parsed.organization_id.is_none());
    }

    #[test]
    fn parse_modules_save_cache_payload_supports_object_with_modules() {
        let parsed = parse_modules_save_cache_payload(Some(serde_json::json!({
            "modules": [{ "module_id": "inventory" }],
            "organizationId": "org-1",
            "terminalId": "term-1",
            "apiTimestamp": "2026-02-22T00:00:00Z"
        })));
        assert_eq!(parsed.modules.len(), 1);
        assert_eq!(parsed.organization_id.as_deref(), Some("org-1"));
        assert_eq!(parsed.terminal_id.as_deref(), Some("term-1"));
        assert_eq!(
            parsed.api_timestamp.as_deref(),
            Some("2026-02-22T00:00:00Z")
        );
    }

    #[test]
    fn parse_modules_save_cache_payload_supports_api_modules_alias() {
        let parsed = parse_modules_save_cache_payload(Some(serde_json::json!({
            "apiModules": [{ "module_id": "kiosk" }],
            "organization_id": "org-2",
            "terminal_id": "term-2",
            "api_timestamp": "2026-02-22T01:00:00Z"
        })));
        assert_eq!(parsed.modules.len(), 1);
        assert_eq!(parsed.organization_id.as_deref(), Some("org-2"));
        assert_eq!(parsed.terminal_id.as_deref(), Some("term-2"));
        assert_eq!(
            parsed.api_timestamp.as_deref(),
            Some("2026-02-22T01:00:00Z")
        );
    }

    #[test]
    fn parse_modules_save_cache_payload_trims_empty_metadata() {
        let parsed = parse_modules_save_cache_payload(Some(serde_json::json!({
            "modules": [],
            "organizationId": "   ",
            "terminalId": " term-3 ",
            "timestamp": " 2026-02-22T02:00:00Z "
        })));
        assert_eq!(parsed.modules.len(), 0);
        assert!(parsed.organization_id.is_none());
        assert_eq!(parsed.terminal_id.as_deref(), Some("term-3"));
        assert_eq!(
            parsed.api_timestamp.as_deref(),
            Some("2026-02-22T02:00:00Z")
        );
    }
}
