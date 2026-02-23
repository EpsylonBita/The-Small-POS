#![recursion_limit = "256"]

//! The Small POS - Tauri v2 Backend
//!
//! This module registers all IPC command handlers that the React frontend
//! calls via `@tauri-apps/api/core::invoke()`. Command names use snake_case
//! derived from the Electron IPC channel names (e.g. `auth:login` -> `auth_login`).

use chrono::Utc;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Emitter;
use tracing::{info, warn};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// App start time for uptime calculation (epoch seconds).
pub(crate) static APP_START_EPOCH: AtomicU64 = AtomicU64::new(0);
/// Last lazy menu warm-up attempt (unix ms) to throttle cache-miss-triggered syncs.
static MENU_WARMUP_LAST_ATTEMPT_MS: AtomicU64 = AtomicU64::new(0);

const MENU_WARMUP_THROTTLE_MS: u64 = 15_000;

mod api;
mod auth;
mod commands;
mod core_helpers;
mod customer_display;
mod data_helpers;
mod db;
mod diagnostics;
mod drawer;
#[allow(dead_code)]
mod ecr;
mod escpos;
mod hardware_manager;
mod loyalty;
mod menu;
mod payments;
mod print;
mod printers;
mod refunds;
mod scale;
mod scanner;
mod serial;
mod shifts;
mod storage;
mod sync;
mod terminal_helpers;
mod zreport;

const MODULE_CACHE_FILE: &str = "module-cache.json";
pub(crate) const MODULE_CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const UPDATER_MANIFEST_URL: &str =
    "https://github.com/EpsylonBita/The-Small-POS/releases/latest/download/latest.json";
const EXTERNAL_URL_MAX_LEN: usize = 2048;
const ALLOWED_EXTERNAL_HOSTS: &[&str] = &[
    "stripe.com",
    "checkout.stripe.com",
    "buy.stripe.com",
    "billing.stripe.com",
    "google.com",
    "www.google.com",
    "maps.google.com",
    "thesmall.app",
    "admin.thesmall.app",
];
const ALLOWED_EXTERNAL_HOST_SUFFIXES: &[&str] = &[".stripe.com", ".google.com", ".thesmall.app"];

#[derive(Default)]
struct UpdaterRuntimeState {
    pending_update: std::sync::Mutex<Option<tauri_plugin_updater::Update>>,
    downloaded_bytes: std::sync::Mutex<Option<Vec<u8>>>,
}

pub(crate) fn parse_channel_payload(
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

pub(crate) fn value_str(v: &serde_json::Value, keys: &[&str]) -> Option<String> {
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

pub(crate) fn value_f64(v: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(n) = v.get(*key).and_then(|x| x.as_f64()) {
            return Some(n);
        }
    }
    None
}

pub(crate) fn value_i64(v: &serde_json::Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(n) = v.get(*key).and_then(|x| x.as_i64()) {
            return Some(n);
        }
    }
    None
}

pub(crate) use core_helpers::{
    build_admin_query, clear_operational_data_inner, fetch_supabase_rows,
    normalize_status_for_storage, payload_arg0_as_string, read_module_cache, read_update_state,
    stats_for_modules, update_info_from_release, validate_admin_api_path, write_module_cache,
    write_update_state,
};
pub(crate) use data_helpers::{
    load_orders_for_period, normalize_phone, parse_item_totals, read_local_json,
    read_local_json_array, resolve_order_id, validate_external_url, write_local_json,
};
pub(crate) use terminal_helpers::{
    credential_key_for_terminal_setting, extract_branch_id_from_terminal_settings_response,
    extract_ghost_mode_feature_from_terminal_settings_response,
    extract_org_id_from_terminal_settings_response, handle_invalid_terminal_credentials,
    hydrate_terminal_credentials_from_local_settings, is_sensitive_terminal_setting,
    is_terminal_auth_failure, mask_terminal_id, read_local_setting, scrub_sensitive_local_settings,
};

pub(crate) async fn maybe_lazy_warm_menu_cache(
    db: &db::DbState,
    app: &tauri::AppHandle,
    source: &str,
) {
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

// ============================================================================
// IPC command handlers
//
// Real implementations delegate to their respective modules (storage, api,
// auth, db, menu, sync). Commands still marked "(stubs)" will be replaced
// as additional subsystems are built out.
// ============================================================================

// -- Modules -----------------------------------------------------------------

pub(crate) fn read_system_clipboard_text() -> Result<String, String> {
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

pub(crate) fn write_system_clipboard_text(text: &str) -> Result<(), String> {
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

// -- Update ------------------------------------------------------------------

// -- API proxy ---------------------------------------------------------------

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
            hydrate_terminal_credentials_from_local_settings(&db_state);
            app.manage(db_state);

            // Auth state
            app.manage(auth::AuthState::new());
            app.manage(UpdaterRuntimeState::default());
            app.manage(ecr::DeviceManager::new());
            app.manage(commands::runtime::ScreenCaptureSignalPollingState::default());

            // Sync state (shared between commands and background loop)
            let sync_state = Arc::new(sync::SyncState::new());
            app.manage(sync_state.clone());

            // Second DB connection for the background sync loop
            let db_for_sync =
                Arc::new(db::init(&app_data_dir).expect("Failed to init sync database"));
            let db_for_startup = db_for_sync.clone();

            // Start background sync loop (15s interval)
            sync::start_sync_loop(app.handle().clone(), db_for_sync, sync_state.clone(), 15);

            // Third DB connection for the background print worker
            let db_for_print =
                Arc::new(db::init(&app_data_dir).expect("Failed to init print database"));

            // Start background print worker (5s interval)
            print::start_print_worker(db_for_print, app_data_dir.clone(), 5);

            // Start background printer status monitor (15s interval)
            let db_for_printer_status =
                Arc::new(db::init(&app_data_dir).expect("Failed to init printer status database"));
            commands::print::start_printer_status_monitor(
                app.handle().clone(),
                db_for_printer_status,
                15,
            );

            // Start background system health monitor (30s interval)
            let db_for_system_health =
                Arc::new(db::init(&app_data_dir).expect("Failed to init system health database"));
            commands::diagnostics::start_system_health_monitor(
                app.handle().clone(),
                db_for_system_health,
                sync_state.clone(),
                30,
            );

            // Start background menu version monitor (30s interval)
            let db_for_menu_version =
                Arc::new(db::init(&app_data_dir).expect("Failed to init menu monitor database"));
            commands::menu::start_menu_version_monitor(
                app.handle().clone(),
                db_for_menu_version,
                30,
            );

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
                            if let Some(ghost_enabled) =
                                extract_ghost_mode_feature_from_terminal_settings_response(&resp)
                            {
                                let value = if ghost_enabled { "true" } else { "false" };
                                let _ =
                                    storage::set_credential("ghost_mode_feature_enabled", value);
                                if let Ok(conn) = startup_db.conn.lock() {
                                    let _ = db::set_setting(
                                        &conn,
                                        "terminal",
                                        "ghost_mode_feature_enabled",
                                        value,
                                    );
                                }
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
            commands::runtime::app_shutdown,
            commands::runtime::app_restart,
            commands::runtime::app_get_version,
            commands::runtime::app_get_shutdown_status,
            commands::runtime::system_get_info,
            commands::runtime::system_open_external_url,
            // Auth
            commands::auth::auth_login,
            commands::auth::auth_logout,
            commands::auth::auth_get_current_session,
            commands::auth::auth_validate_session,
            commands::auth::auth_has_permission,
            commands::auth::auth_get_session_stats,
            commands::auth::auth_setup_pin,
            // Staff auth
            commands::auth::staff_auth_authenticate_pin,
            commands::auth::staff_auth_get_session,
            commands::auth::staff_auth_get_current,
            commands::auth::staff_auth_has_permission,
            commands::auth::staff_auth_has_any_permission,
            commands::auth::staff_auth_logout,
            commands::auth::staff_auth_validate_session,
            commands::auth::staff_auth_track_activity,
            // Settings
            commands::settings::get_settings,
            commands::settings::settings_is_configured,
            commands::settings::settings_get,
            commands::settings::settings_get_local,
            commands::settings::settings_set,
            commands::settings::settings_update_local,
            commands::settings::settings_factory_reset,
            commands::settings::settings_update_terminal_credentials,
            commands::settings::settings_get_admin_url,
            commands::settings::settings_clear_connection,
            commands::settings::settings_get_discount_max,
            commands::settings::settings_set_discount_max,
            commands::settings::settings_get_tax_rate,
            commands::settings::settings_set_tax_rate,
            commands::settings::settings_get_language,
            commands::settings::settings_set_language,
            commands::settings::update_settings,
            // Terminal config
            commands::settings::terminal_config_get_settings,
            commands::settings::terminal_config_get_setting,
            commands::settings::terminal_config_get_branch_id,
            commands::settings::terminal_config_get_terminal_id,
            commands::settings::terminal_config_get_organization_id,
            commands::settings::terminal_config_get_business_type,
            commands::settings::terminal_config_get_full_config,
            commands::settings::terminal_config_refresh,
            // Orders
            commands::orders::order_get_all,
            commands::orders::order_get_by_id,
            commands::orders::order_get_by_customer_phone,
            commands::orders::order_create,
            commands::orders::order_update_status,
            commands::orders::order_update_items,
            commands::orders::order_approve,
            commands::orders::order_decline,
            commands::orders::order_assign_driver,
            commands::orders::order_delete,
            commands::orders::order_save_from_remote,
            commands::orders::order_fetch_items_from_supabase,
            commands::orders::order_notify_platform_ready,
            commands::orders::order_update_preparation,
            commands::orders::order_update_type,
            commands::orders::order_save_for_retry,
            commands::orders::order_get_retry_queue,
            commands::orders::order_process_retry_queue,
            commands::orders::orders_clear_all,
            commands::orders::orders_get_conflicts,
            commands::orders::orders_resolve_conflict,
            commands::orders::orders_force_sync_retry,
            commands::orders::orders_get_retry_info,
            // Sync
            commands::sync::sync_get_status,
            commands::sync::sync_get_network_status,
            commands::sync::sync_get_inter_terminal_status,
            commands::sync::sync_force,
            commands::sync::sync_validate_pending_orders,
            commands::sync::sync_remove_invalid_orders,
            commands::sync::sync_clear_all,
            commands::sync::sync_clear_failed,
            commands::sync::sync_clear_old_orders,
            commands::sync::sync_get_financial_stats,
            commands::sync::sync_get_failed_financial_items,
            commands::sync::sync_retry_financial_item,
            commands::sync::sync_retry_all_failed_financial,
            commands::sync::sync_get_unsynced_financial_summary,
            commands::sync::sync_validate_financial_integrity,
            commands::sync::sync_requeue_orphaned_financial,
            commands::sync::sync_clear_all_orders,
            commands::sync::sync_cleanup_deleted_orders,
            commands::sync::sync_rediscover_parent,
            commands::sync::sync_fetch_tables,
            commands::sync::sync_fetch_reservations,
            commands::sync::sync_fetch_suppliers,
            commands::sync::sync_fetch_analytics,
            commands::sync::sync_fetch_orders,
            commands::sync::sync_fetch_rooms,
            commands::sync::sync_update_room_status,
            commands::sync::sync_fetch_drive_thru,
            commands::sync::sync_update_drive_thru_order_status,
            commands::sync::rooms_get_availability,
            commands::sync::appointments_get_today_metrics,
            // Menu
            commands::menu::menu_get_categories,
            commands::menu::menu_get_subcategories,
            commands::menu::menu_get_ingredients,
            commands::menu::menu_get_subcategory_ingredients,
            commands::menu::menu_get_combos,
            commands::menu::menu_sync,
            commands::menu::menu_update_category,
            commands::menu::menu_update_subcategory,
            commands::menu::menu_update_ingredient,
            commands::menu::menu_update_combo,
            commands::menu::menu_trigger_check_for_updates,
            // Shifts
            commands::shifts::shift_open,
            commands::shifts::shift_close,
            commands::shifts::shift_get_active,
            commands::shifts::shift_get_active_by_terminal,
            commands::shifts::shift_get_active_by_terminal_loose,
            commands::shifts::shift_get_active_cashier_by_terminal,
            commands::shifts::shift_get_summary,
            commands::shifts::shift_record_expense,
            commands::shifts::shift_get_expenses,
            commands::shifts::shift_list_staff_for_checkin,
            commands::shifts::shift_get_staff_roles,
            commands::shifts::shift_record_staff_payment,
            commands::shifts::shift_get_staff_payments,
            commands::shifts::shift_get_staff_payments_by_staff,
            commands::shifts::shift_get_staff_payment_total_for_date,
            commands::shifts::shift_get_scheduled_shifts,
            commands::shifts::shift_get_today_scheduled_shifts,
            commands::shifts::shift_backfill_driver_earnings,
            commands::shifts::shift_print_checkout,
            // Payments
            commands::payments::payment_record,
            commands::payments::payment_void,
            commands::payments::payment_update_payment_status,
            commands::payments::payment_get_order_payments,
            commands::payments::payment_get_receipt_preview,
            // Refunds / Adjustments
            commands::payments::refund_payment,
            commands::payments::refund_void_payment,
            commands::payments::refund_list_order_adjustments,
            commands::payments::refund_get_payment_balance,
            // Z-Reports
            commands::zreports::zreport_generate,
            commands::zreports::zreport_get,
            commands::zreports::zreport_list,
            commands::zreports::zreport_print,
            // Print
            commands::print::payment_print_receipt,
            commands::print::kitchen_print_ticket,
            commands::print::print_list_jobs,
            commands::print::print_get_receipt_file,
            commands::print::print_reprint_job,
            commands::print::label_print,
            commands::print::label_print_batch,
            // Screen capture / Geo
            commands::runtime::screen_capture_get_sources,
            commands::runtime::screen_capture_start_signal_polling,
            commands::runtime::screen_capture_stop_signal_polling,
            commands::runtime::geo_ip,
            // Legacy printer manager channels
            commands::print::printer_scan_network,
            commands::print::printer_scan_bluetooth,
            commands::print::printer_discover,
            commands::print::printer_add,
            commands::print::printer_update,
            commands::print::printer_remove,
            commands::print::printer_get_all,
            commands::print::printer_get,
            commands::print::printer_get_status,
            commands::print::printer_get_all_statuses,
            commands::print::printer_submit_job,
            commands::print::printer_cancel_job,
            commands::print::printer_retry_job,
            commands::print::printer_test,
            commands::print::printer_test_greek_direct,
            commands::print::printer_diagnostics,
            commands::print::printer_bluetooth_status,
            commands::print::printer_open_cash_drawer,
            // Printer profiles
            commands::print::printer_list_system_printers,
            commands::print::printer_create_profile,
            commands::print::printer_update_profile,
            commands::print::printer_delete_profile,
            commands::print::printer_list_profiles,
            commands::print::printer_get_profile,
            commands::print::printer_set_default_profile,
            commands::print::printer_get_default_profile,
            // ECR
            commands::ecr::ecr_discover_devices,
            commands::ecr::ecr_get_devices,
            commands::ecr::ecr_get_device,
            commands::ecr::ecr_add_device,
            commands::ecr::ecr_update_device,
            commands::ecr::ecr_remove_device,
            commands::ecr::ecr_get_default_terminal,
            commands::ecr::ecr_connect_device,
            commands::ecr::ecr_disconnect_device,
            commands::ecr::ecr_get_device_status,
            commands::ecr::ecr_get_all_statuses,
            commands::ecr::ecr_process_payment,
            commands::ecr::ecr_process_refund,
            commands::ecr::ecr_void_transaction,
            commands::ecr::ecr_cancel_transaction,
            commands::ecr::ecr_settlement,
            commands::ecr::ecr_get_recent_transactions,
            commands::ecr::ecr_query_transactions,
            commands::ecr::ecr_get_transaction_stats,
            commands::ecr::ecr_get_transaction_for_order,
            commands::ecr::ecr_test_connection,
            commands::ecr::ecr_test_print,
            commands::ecr::ecr_fiscal_print,
            // Cash drawer
            commands::hardware::drawer_open,
            // Serial ports
            commands::hardware::serial_list_ports,
            commands::hardware::serial_open,
            commands::hardware::serial_close,
            commands::hardware::serial_read,
            commands::hardware::serial_write,
            // Scale
            commands::hardware::scale_connect,
            commands::hardware::scale_disconnect,
            commands::hardware::scale_read_weight,
            commands::hardware::scale_tare,
            commands::hardware::scale_get_status,
            // Customer display
            commands::hardware::display_connect,
            commands::hardware::display_disconnect,
            commands::hardware::display_show_line,
            commands::hardware::display_show_item,
            commands::hardware::display_show_total,
            commands::hardware::display_clear,
            commands::hardware::display_get_status,
            // Serial barcode scanner
            commands::hardware::scanner_serial_start,
            commands::hardware::scanner_serial_stop,
            commands::hardware::scanner_serial_status,
            // Loyalty card reader
            commands::hardware::loyalty_reader_start,
            commands::hardware::loyalty_reader_stop,
            commands::hardware::loyalty_process_card,
            commands::hardware::loyalty_reader_status,
            // Hardware manager
            commands::hardware::hardware_get_status,
            commands::hardware::hardware_reconnect,
            // Dashboard metrics
            commands::analytics::inventory_get_stock_metrics,
            commands::analytics::products_get_catalog_count,
            // Customers
            commands::customers::customer_invalidate_cache,
            commands::customers::customer_get_cache_stats,
            commands::customers::customer_clear_cache,
            commands::customers::customer_lookup_by_phone,
            commands::customers::customer_lookup_by_id,
            commands::customers::customer_search,
            commands::customers::customer_create,
            commands::customers::customer_update,
            commands::customers::customer_update_ban_status,
            commands::customers::customer_add_address,
            commands::customers::customer_update_address,
            commands::customers::customer_resolve_conflict,
            commands::customers::customer_get_conflicts,
            // Drivers
            commands::analytics::driver_record_earning,
            commands::analytics::driver_get_earnings,
            commands::analytics::driver_get_shift_summary,
            commands::analytics::driver_get_active,
            // Delivery zones
            commands::analytics::delivery_zone_track_validation,
            commands::analytics::delivery_zone_get_analytics,
            commands::analytics::delivery_zone_request_override,
            // Reports
            commands::analytics::report_get_today_statistics,
            commands::analytics::report_get_sales_trend,
            commands::analytics::report_get_top_items,
            commands::analytics::report_get_weekly_top_items,
            commands::analytics::report_get_hourly_sales,
            commands::analytics::report_get_payment_method_breakdown,
            commands::analytics::report_get_order_type_breakdown,
            commands::analytics::report_generate_z_report,
            commands::analytics::report_get_daily_staff_performance,
            commands::analytics::report_print_z_report,
            commands::analytics::report_submit_z_report,
            // Modules
            commands::modules::modules_fetch_from_admin,
            commands::modules::modules_get_cached,
            commands::modules::modules_save_cache,
            // Utility compatibility
            commands::system_ui::clipboard_read_text,
            commands::system_ui::clipboard_write_text,
            commands::system_ui::show_notification,
            // Window
            commands::system_ui::window_get_state,
            commands::system_ui::window_minimize,
            commands::system_ui::window_maximize,
            commands::system_ui::window_close,
            commands::system_ui::window_toggle_fullscreen,
            commands::system_ui::window_reload,
            commands::system_ui::window_force_reload,
            commands::system_ui::window_toggle_devtools,
            commands::system_ui::window_zoom_in,
            commands::system_ui::window_zoom_out,
            commands::system_ui::window_zoom_reset,
            // Database
            commands::diagnostics::database_health_check,
            commands::diagnostics::database_get_stats,
            commands::diagnostics::database_reset,
            commands::diagnostics::database_clear_operational_data,
            commands::diagnostics::diagnostic_check_delivered_orders,
            commands::diagnostics::diagnostic_fix_missing_driver_ids,
            // Diagnostics
            commands::diagnostics::diagnostics_get_about,
            commands::diagnostics::diagnostics_get_system_health,
            commands::diagnostics::diagnostics_export,
            commands::diagnostics::diagnostics_open_export_dir,
            // Updates
            commands::updates::update_get_state,
            commands::updates::update_check,
            commands::updates::update_download,
            commands::updates::update_cancel_download,
            commands::updates::update_install,
            commands::updates::update_set_channel,
            // API proxy
            commands::api_bridge::api_fetch_from_admin,
            commands::api_bridge::sync_test_parent_connection,
            commands::api_bridge::admin_sync_terminal_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running The Small POS");
}
