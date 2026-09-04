use chrono::Utc;
use serde::Deserialize;
use tauri::Emitter;

use crate::{db, storage};

#[derive(Debug)]
struct AuthoritativeRepairAccess {
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    repairs_enabled: bool,
}

fn canonical_uuid(value: &str) -> Option<String> {
    let parsed = uuid::Uuid::parse_str(value).ok()?;
    let canonical = parsed.hyphenated().to_string();
    (canonical == value).then_some(canonical)
}

fn parse_authoritative_repair_access(
    payload: &serde_json::Value,
    requested_terminal_id: &str,
) -> Result<AuthoritativeRepairAccess, String> {
    let exact_string = |key: &str| {
        payload
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| value.trim() == *value && !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "REPAIR_AUTHORITATIVE_IDENTITY_INVALID".to_string())
    };
    let organization_id = exact_string("organization_id")?;
    let branch_id = exact_string("branch_id")?;
    let terminal_id = exact_string("terminal_id")?;
    if canonical_uuid(&organization_id).is_none()
        || canonical_uuid(&branch_id).is_none()
        || terminal_id != requested_terminal_id
    {
        return Err(if terminal_id != requested_terminal_id {
            "REPAIR_AUTHORITATIVE_IDENTITY_MISMATCH".to_string()
        } else {
            "REPAIR_AUTHORITATIVE_IDENTITY_INVALID".to_string()
        });
    }
    let modules = payload
        .get("modules")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "REPAIR_AUTHORITATIVE_MODULES_INVALID".to_string())?;
    let repairs_enabled = modules.iter().any(|module| {
        module.get("module_id").and_then(serde_json::Value::as_str) == Some("repairs")
    });
    Ok(AuthoritativeRepairAccess {
        organization_id,
        branch_id,
        terminal_id,
        repairs_enabled,
    })
}

#[derive(Debug, Default)]
struct ModulesSaveCachePayload {
    modules: Vec<serde_json::Value>,
    organization_id: Option<String>,
    terminal_id: Option<String>,
    admin_dashboard_url: Option<String>,
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
    #[serde(default, alias = "admin_dashboard_url", alias = "adminUrl")]
    admin_dashboard_url: Option<String>,
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
            admin_dashboard_url: None,
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
                admin_dashboard_url: normalize_optional_string(parsed.admin_dashboard_url),
                api_timestamp: normalize_optional_string(parsed.api_timestamp.or(parsed.timestamp)),
            }
        }
        _ => ModulesSaveCachePayload::default(),
    }
}

fn current_module_identity(db: &db::DbState) -> (String, String, String, String) {
    let organization_id = storage::get_credential("organization_id")
        .or_else(|| crate::read_local_setting(db, "terminal", "organization_id"))
        .unwrap_or_default();
    let branch_id = storage::get_credential("branch_id")
        .or_else(|| crate::read_local_setting(db, "terminal", "branch_id"))
        .unwrap_or_default();
    let terminal_id = storage::get_credential("terminal_id")
        .or_else(|| crate::read_local_setting(db, "terminal", "terminal_id"))
        .unwrap_or_default();
    let admin_dashboard_url = storage::get_credential("admin_dashboard_url")
        .or_else(|| crate::read_local_setting(db, "terminal", "admin_dashboard_url"))
        .unwrap_or_default();
    (organization_id, branch_id, terminal_id, admin_dashboard_url)
}

fn cache_identity_matches(
    cache: &serde_json::Value,
    organization_id: &str,
    branch_id: &str,
    terminal_id: &str,
    admin_dashboard_url: &str,
) -> bool {
    let cached_org = cache
        .get("organizationId")
        .or_else(|| cache.get("organization_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let cached_terminal = cache
        .get("terminalId")
        .or_else(|| cache.get("terminal_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let cached_branch = cache
        .get("branchId")
        .or_else(|| cache.get("branch_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let cached_admin = cache
        .get("adminDashboardUrl")
        .or_else(|| cache.get("admin_dashboard_url"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Module caches written before the repair rollout did not carry a branch.
    // Preserve their established generic-module offline fallback when the
    // original org/terminal/origin tuple still matches. Repair access never
    // relies on this compatibility path: it is filtered independently through
    // the native branch-bound entitlement below.
    let compatible_branch = cached_branch.is_empty() || cached_branch == branch_id;

    cached_org == organization_id
        && compatible_branch
        && cached_terminal == terminal_id
        && cached_admin == admin_dashboard_url
}

fn cache_age_ms(cache: &serde_json::Value) -> i64 {
    let cached_at = cache.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
    (Utc::now().timestamp_millis() - cached_at).max(0)
}

fn cache_is_stale(cache: &serde_json::Value) -> bool {
    cache_age_ms(cache) >= crate::MODULE_CACHE_TTL_MS
}

fn cache_fallback_allowed(fetch_err: &str, identity_match: bool) -> bool {
    if !identity_match {
        return false;
    }

    let lower = fetch_err.to_ascii_lowercase();
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("invalid api key")
        || lower.contains("not authorized")
        || lower.contains("terminal identity mismatch")
    {
        return false;
    }

    true
}

fn cached_modules_for_native_access(
    cache: &serde_json::Value,
    repair_access_retained: bool,
) -> Vec<serde_json::Value> {
    let mut modules = cache
        .get("apiModules")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if !repair_access_retained {
        modules.retain(|module| {
            module.get("module_id").and_then(serde_json::Value::as_str) != Some("repairs")
        });
    }
    modules
}

fn native_repair_cache_access_available(db: &db::DbState) -> bool {
    let Ok(connection) = db.conn.lock() else {
        return false;
    };
    crate::repairs::acquire_renderer_access(&connection).is_ok()
}

fn is_network_or_server_failure(error: &crate::api::AdminFetchError) -> bool {
    error.is_transport_failure()
        || error
            .status()
            .is_some_and(|status| (500..600).contains(&status))
}

fn is_terminal_configuration_error(error: &str) -> bool {
    error
        .trim()
        .to_ascii_lowercase()
        .starts_with("terminal not configured")
}

fn module_terminal_config_failure_payload(error: &str) -> serde_json::Value {
    serde_json::json!({
        "success": false,
        "error": error,
        "errorCode": "terminal_not_configured",
        "recoveryAction": "open_connection_settings",
        "fromCache": false,
        "modules": serde_json::Value::Null,
    })
}

fn module_terminal_auth_failure_payload(error: &str) -> serde_json::Value {
    let requires_reset = crate::sync::terminal_auth_failure_requires_reset(error);
    serde_json::json!({
        "success": false,
        "error": error,
        "errorCode": if requires_reset {
            "invalid_terminal_credentials"
        } else {
            "terminal_auth_paused"
        },
        "recoveryAction": if requires_reset {
            "open_connection_settings"
        } else {
            "refresh_terminal_settings"
        },
        "fromCache": false,
        "modules": serde_json::Value::Null,
    })
}

fn emit_modules_sync_error(app: &tauri::AppHandle, payload: &serde_json::Value) {
    let _ = app.emit("modules_sync_error", payload.clone());
}

fn persisted_staff_session_id(raw: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "REPAIR_STAFF_SESSION_REQUIRED".to_string())?;
    let session_id = value
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "REPAIR_STAFF_SESSION_REQUIRED".to_string())?;
    canonical_uuid(session_id).ok_or_else(|| "REPAIR_STAFF_SESSION_REQUIRED".to_string())
}

async fn finalize_repair_access_if_signed_in(
    db: &db::DbState,
    access: &AuthoritativeRepairAccess,
    pending: &crate::repairs::RepairAccessReconciliation,
) -> Result<&'static str, String> {
    let Some(persisted_session) = storage::session_get_strict()? else {
        return Ok("pending_staff_session");
    };
    let staff_session_id = persisted_staff_session_id(&persisted_session)?;
    let (base_url, api_key) = crate::resolve_admin_endpoint(Some(db))
        .await
        .map_err(|_| "REPAIR_NATIVE_ENDPOINT_UNAVAILABLE".to_string())?;
    let native_scope = crate::repair_transport::NativeRepairScope {
        organization_id: access.organization_id.clone(),
        branch_id: access.branch_id.clone(),
        terminal_id: access.terminal_id.clone(),
    };
    let bootstrap = crate::repair_transport::send_repair_actor_bootstrap_request(
        &base_url,
        &api_key,
        Some(&persisted_session),
        &native_scope,
        &staff_session_id,
    )
    .await
    .map_err(|error| error.code().to_string())?;
    if let Err(error) = crate::repairs::finalize_authoritative_offline_access(
        db,
        pending,
        &bootstrap.numbering_lease,
    ) {
        crate::repair_transport::clear_repair_actor_attestation()?;
        return Err(error);
    }
    Ok("enabled")
}

#[tauri::command]
pub async fn modules_fetch_from_admin(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    sync_state: tauri::State<'_, std::sync::Arc<crate::sync::SyncState>>,
) -> Result<serde_json::Value, String> {
    let terminal_id = storage::get_credential_strict("terminal_id")
        .map_err(|_| "TERMINAL_CREDENTIAL_READ_FAILED".to_string())?
        .map(|value| value.to_string());
    let Some(terminal_id) = terminal_id else {
        // Missing native terminal identity is authoritative evidence that the
        // prior repair scope cannot be trusted for offline access. Fail closed
        // before returning the ordinary module configuration payload.
        let _ = crate::repairs::latch_startup_access_pending();
        let payload =
            module_terminal_config_failure_payload("Terminal not configured: missing terminal_id");
        emit_modules_sync_error(&app, &payload);
        return Ok(payload);
    };
    let path = format!("/api/pos/modules/enabled?terminal_id={terminal_id}");
    let access_decision = crate::repairs::start_authoritative_access_decision()?;

    match crate::admin_fetch_detailed(Some(&db), &path, "GET", None).await {
        Ok(resp) => {
            let payload = if let Some(data) = resp.get("data") {
                data
            } else {
                &resp
            };

            let repair_access = match parse_authoritative_repair_access(payload, &terminal_id) {
                Ok(access) => access,
                Err(error) => {
                    let _ = crate::repairs::latch_authoritative_access_pending(access_decision);
                    let failure = serde_json::json!({
                        "success": false,
                        "error": error,
                        "errorCode": "repair_authoritative_identity_invalid",
                        "fromCache": false,
                        "modules": serde_json::Value::Null,
                    });
                    emit_modules_sync_error(&app, &failure);
                    return Ok(failure);
                }
            };
            let pending = crate::repairs::begin_authoritative_access_reconciliation(
                &db,
                &repair_access.organization_id,
                &repair_access.branch_id,
                &repair_access.terminal_id,
                repair_access.repairs_enabled,
                access_decision,
            )?;
            let repair_access_state = if pending.is_disabled() {
                "module_required"
            } else {
                match finalize_repair_access_if_signed_in(&db, &repair_access, &pending).await {
                    Ok(state) => state,
                    Err(error) => {
                        tracing::warn!(error_code = %error, "Repair access remains fail-closed pending bootstrap");
                        if error == "REPAIR_SESSION_KEYRING_UNAVAILABLE" {
                            "keyring_unavailable"
                        } else {
                            "pending_bootstrap"
                        }
                    }
                }
            };
            if pending.is_disabled()
                || (pending.identity_changed() && repair_access_state == "enabled")
            {
                let reason = if pending.is_disabled() {
                    "module_revoked"
                } else {
                    "identity_rebound"
                };
                let _ = app.emit(
                    "repairs:scope-reset",
                    serde_json::json!({
                        "scopeToken": pending.scope_token(),
                        "reason": reason,
                    }),
                );
            }

            let api_modules = payload
                .get("modules")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let organization_id = repair_access.organization_id.clone();
            let branch_id = repair_access.branch_id.clone();
            let admin_dashboard_url = storage::get_credential_strict("admin_dashboard_url")
                .map_err(|_| "TERMINAL_CREDENTIAL_READ_FAILED".to_string())?
                .map(|value| value.to_string())
                .unwrap_or_default();
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
                "branchId": branch_id,
                "terminalId": terminal_id,
                "adminDashboardUrl": admin_dashboard_url,
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
                    "branch_id": cache_payload.get("branchId").cloned().unwrap_or_else(|| serde_json::json!("")),
                    "terminal_id": cache_payload.get("terminalId").cloned().unwrap_or_else(|| serde_json::json!("")),
                    "timestamp": cache_payload.get("apiTimestamp").cloned().unwrap_or_else(|| serde_json::json!(Utc::now().to_rfc3339())),
                    "stats": stats,
                    "processing_time_ms": processing_time_ms,
                },
                "fromCache": false,
                "cacheAgeMs": 0,
                "stale": false,
                "identityMatch": true
                ,"repairAccessState": repair_access_state
            }))
        }
        Err(fetch_err) if is_terminal_configuration_error(&fetch_err.to_string()) => {
            let _ = crate::repairs::latch_authoritative_access_pending(access_decision);
            let fetch_err = fetch_err.to_string();
            let payload = module_terminal_config_failure_payload(&fetch_err);
            emit_modules_sync_error(&app, &payload);
            Ok(payload)
        }
        Err(fetch_err) if crate::is_terminal_auth_failure(&fetch_err.to_string()) => {
            let _ = crate::repairs::latch_authoritative_access_pending(access_decision);
            let fetch_err = fetch_err.to_string();
            let payload = module_terminal_auth_failure_payload(&fetch_err);
            if crate::sync::terminal_auth_failure_requires_reset(&fetch_err) {
                crate::handle_invalid_terminal_credentials(
                    Some(&db),
                    &app,
                    "modules_fetch_from_admin",
                    &fetch_err,
                );
            } else {
                crate::sync::handle_soft_terminal_auth_failure(
                    &db,
                    sync_state.inner().as_ref(),
                    &app,
                    "modules_fetch_from_admin",
                    &fetch_err,
                );
            }
            emit_modules_sync_error(&app, &payload);
            Ok(payload)
        }
        Err(fetch_err) => {
            let repair_access_retained = if is_network_or_server_failure(&fetch_err) {
                crate::repairs::retain_verified_access_after_network_failure(&db, access_decision)
                    .is_ok()
            } else {
                let _ = crate::repairs::latch_authoritative_access_pending(access_decision);
                false
            };
            let fetch_err = fetch_err.to_string();
            match crate::read_module_cache(&db) {
                Ok(cache) => {
                    let (current_org, current_branch, current_terminal, current_admin_url) =
                        current_module_identity(&db);
                    let identity_match = cache_identity_matches(
                        &cache,
                        &current_org,
                        &current_branch,
                        &current_terminal,
                        &current_admin_url,
                    );
                    if !cache_fallback_allowed(&fetch_err, identity_match) {
                        let payload = serde_json::json!({
                            "success": false,
                            "error": fetch_err,
                            "fromCache": false,
                            "identityMatch": identity_match,
                            "modules": serde_json::Value::Null
                        });
                        emit_modules_sync_error(&app, &payload);
                        return Ok(payload);
                    }

                    let api_modules =
                        cached_modules_for_native_access(&cache, repair_access_retained);
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
                    let cache_age_ms = cache_age_ms(&cache);
                    let stale = cache_is_stale(&cache);

                    Ok(serde_json::json!({
                        "success": true,
                        "modules": {
                            "success": true,
                            "modules": api_modules,
                            "organization_id": organization_id,
                            "terminal_id": terminal_id_cached,
                            "timestamp": api_timestamp,
                            "stats": crate::stats_for_modules(&api_modules),
                            "processing_time_ms": 0,
                        },
                        "fromCache": true,
                        "cacheAgeMs": cache_age_ms,
                        "stale": stale,
                        "identityMatch": identity_match,
                        "repairAccessRetained": repair_access_retained,
                        "error": fetch_err
                    }))
                }
                Err(_) => {
                    let payload = serde_json::json!({
                        "success": false,
                        "error": fetch_err,
                        "modules": serde_json::Value::Null
                    });
                    emit_modules_sync_error(&app, &payload);
                    Ok(payload)
                }
            }
        }
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

    let repair_access_retained = native_repair_cache_access_available(&db);
    let api_modules = cached_modules_for_native_access(&cache, repair_access_retained);
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
    let (current_org, current_branch, current_terminal, current_admin_url) =
        current_module_identity(&db);
    let identity_match = cache_identity_matches(
        &cache,
        &current_org,
        &current_branch,
        &current_terminal,
        &current_admin_url,
    );
    let api_timestamp = cache
        .get("apiTimestamp")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cache_age = cache_age_ms(&cache);
    let is_valid = cache_age < crate::MODULE_CACHE_TTL_MS && identity_match;

    Ok(serde_json::json!({
        "success": true,
        "modules": {
            "success": true,
            "modules": api_modules,
            "organization_id": organization_id,
            "terminal_id": terminal_id,
            "timestamp": api_timestamp,
            "stats": crate::stats_for_modules(&api_modules),
            "processing_time_ms": 0,
        },
        "isValid": is_valid,
        "cacheAge": cache_age,
        "cacheAgeMs": cache_age,
        "stale": cache_age >= crate::MODULE_CACHE_TTL_MS,
        "identityMatch": identity_match,
        "repairAccessRetained": repair_access_retained
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
    let branch_id = storage::get_credential("branch_id")
        .or_else(|| crate::read_local_setting(&db, "terminal", "branch_id"))
        .unwrap_or_default();
    let terminal_id = parsed
        .terminal_id
        .or_else(|| storage::get_credential("terminal_id"))
        .unwrap_or_default();
    let admin_dashboard_url = parsed
        .admin_dashboard_url
        .or_else(|| storage::get_credential("admin_dashboard_url"))
        .unwrap_or_default();
    let api_timestamp = parsed
        .api_timestamp
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    let repair_access_retained = native_repair_cache_access_available(&db);
    let mut modules = parsed.modules;
    if !repair_access_retained {
        modules.retain(|module| {
            module.get("module_id").and_then(serde_json::Value::as_str) != Some("repairs")
        });
    }

    let cache_payload = serde_json::json!({
        "apiModules": modules,
        "organizationId": organization_id,
        "branchId": branch_id,
        "terminalId": terminal_id,
        "adminDashboardUrl": admin_dashboard_url,
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

    #[test]
    fn module_terminal_config_failure_payload_points_to_connection_settings() {
        let payload =
            module_terminal_config_failure_payload("Terminal not configured: missing API key");

        assert_eq!(payload["success"], false);
        assert_eq!(payload["errorCode"], "terminal_not_configured");
        assert_eq!(payload["recoveryAction"], "open_connection_settings");
        assert_eq!(payload["modules"], serde_json::Value::Null);
    }

    #[test]
    fn module_terminal_auth_failure_payload_points_to_auth_recovery() {
        let payload = module_terminal_auth_failure_payload(
            r#"Per-terminal authentication required (HTTP 403): {"success":false,"code":"per_terminal_auth_required","error":"Per-terminal authentication required","authSource":"bearer"}"#,
        );

        assert_eq!(payload["success"], false);
        assert_eq!(payload["errorCode"], "terminal_auth_paused");
        assert_eq!(payload["recoveryAction"], "refresh_terminal_settings");
        assert_eq!(payload["fromCache"], false);
        assert_eq!(payload["modules"], serde_json::Value::Null);
    }

    #[test]
    fn authoritative_repair_access_uses_exact_server_branch_and_terminal_identity() {
        let response = serde_json::json!({
            "success": true,
            "organization_id": "11111111-1111-4111-8111-111111111111",
            "branch_id": "22222222-2222-4222-8222-222222222222",
            "terminal_id": "terminal-alpha",
            "modules": [{ "module_id": "repairs" }]
        });
        let access = parse_authoritative_repair_access(&response, "terminal-alpha")
            .expect("authenticated response owns repair scope");
        assert_eq!(access.branch_id, "22222222-2222-4222-8222-222222222222");
        assert!(access.repairs_enabled);

        let mut mismatched = response.clone();
        mismatched["terminal_id"] = serde_json::json!("terminal-renderer-cache");
        assert_eq!(
            parse_authoritative_repair_access(&mismatched, "terminal-alpha").unwrap_err(),
            "REPAIR_AUTHORITATIVE_IDENTITY_MISMATCH"
        );

        let mut missing_branch = response;
        missing_branch.as_object_mut().unwrap().remove("branch_id");
        assert_eq!(
            parse_authoritative_repair_access(&missing_branch, "terminal-alpha").unwrap_err(),
            "REPAIR_AUTHORITATIVE_IDENTITY_INVALID"
        );
    }

    #[test]
    fn http_400_body_containing_500_never_retains_repair_access() {
        let client_error = crate::api::AdminFetchError::with_status(
            "Unexpected response from admin dashboard (HTTP 400): requested limit 500 is invalid",
            400,
        );
        assert!(
            !is_network_or_server_failure(&client_error),
            "body digits must never be mistaken for the actual HTTP status"
        );
        assert!(is_network_or_server_failure(
            &crate::api::AdminFetchError::with_status(
                "Admin dashboard server error (HTTP 503)",
                503,
            )
        ));
        assert!(is_network_or_server_failure(
            &crate::api::AdminFetchError::transport(
                "Network error communicating with admin dashboard"
            )
        ));
        assert!(!is_network_or_server_failure(
            &crate::api::AdminFetchError::statusless(
                "Local validation mentions Network and HTTP 500"
            )
        ));
    }

    #[test]
    fn unretained_native_access_removes_repairs_from_generic_module_cache() {
        let cache = serde_json::json!({
            "apiModules": [
                { "module_id": "orders" },
                { "module_id": "repairs" },
                { "module_id": "users" }
            ]
        });
        let denied = cached_modules_for_native_access(&cache, false);
        assert_eq!(
            denied
                .iter()
                .filter_map(|module| {
                    module.get("module_id").and_then(serde_json::Value::as_str)
                })
                .collect::<Vec<_>>(),
            vec!["orders", "users"]
        );
        assert_eq!(cached_modules_for_native_access(&cache, true).len(), 3);
    }

    #[test]
    fn legacy_cache_without_branch_preserves_only_generic_offline_compatibility() {
        let legacy = serde_json::json!({
            "apiModules": [
                { "module_id": "orders" },
                { "module_id": "repairs" },
                { "module_id": "users" }
            ],
            "organizationId": "11111111-1111-4111-8111-111111111111",
            "terminalId": "terminal-alpha",
            "adminDashboardUrl": "https://admin.example.com"
        });

        assert!(cache_identity_matches(
            &legacy,
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "terminal-alpha",
            "https://admin.example.com",
        ));
        assert_eq!(
            cached_modules_for_native_access(&legacy, false)
                .iter()
                .filter_map(|module| module.get("module_id").and_then(serde_json::Value::as_str))
                .collect::<Vec<_>>(),
            vec!["orders", "users"],
            "legacy generic modules remain available, while repairs still requires native branch-bound access",
        );

        let mut branch_bound = legacy;
        branch_bound["branchId"] = serde_json::json!("33333333-3333-4333-8333-333333333333");
        assert!(!cache_identity_matches(
            &branch_bound,
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "terminal-alpha",
            "https://admin.example.com",
        ));
    }
}
