use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::{db, UpdaterRuntimeState};

const UPDATER_ARTIFACT_DIR: &str = "updater";
const UPDATER_PUBKEY_PLACEHOLDER: &str = "__TAURI_UPDATER_PUBKEY__";

fn parse_update_channel_payload(arg0: Option<serde_json::Value>) -> String {
    let raw = match arg0 {
        Some(serde_json::Value::Object(obj)) => {
            let payload = serde_json::Value::Object(obj);
            crate::value_str(
                &payload,
                &["channel", "updateChannel", "update_channel", "arg0"],
            )
        }
        Some(serde_json::Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    };

    raw.unwrap_or_else(|| "stable".to_string()).to_lowercase()
}

fn configured_updater_pubkey() -> Option<String> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).ok()?;
    config
        .get("plugins")
        .and_then(|value| value.get("updater"))
        .and_then(|value| value.get("pubkey"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_updater_configuration(
    is_debug_build: bool,
    configured_pubkey: Option<&str>,
) -> Result<(), String> {
    if is_debug_build {
        return Err(
            "Updater is disabled in local development builds. Use a packaged release build to test updates."
                .to_string(),
        );
    }

    let pubkey = configured_pubkey
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Updater public key is missing from this build.".to_string())?;

    if pubkey == UPDATER_PUBKEY_PLACEHOLDER {
        return Err(
            "Updater public key is not configured for this build. Inject TAURI_UPDATER_PUBKEY or use a packaged release build."
                .to_string(),
        );
    }

    Ok(())
}

fn ensure_updater_is_available() -> Result<(), String> {
    validate_updater_configuration(cfg!(debug_assertions), configured_updater_pubkey().as_deref())
}

fn update_state_string(state: &serde_json::Value, key: &str) -> Option<String> {
    state
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn update_state_bool(state: &serde_json::Value, key: &str) -> bool {
    state
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn update_state_path(state: &serde_json::Value, key: &str) -> Option<PathBuf> {
    update_state_string(state, key).map(PathBuf::from)
}

fn set_state_value(state: &mut serde_json::Value, key: &str, value: serde_json::Value) {
    if let Some(obj) = state.as_object_mut() {
        obj.insert(key.to_string(), value);
    }
}

fn set_downloading_state(state: &mut serde_json::Value) {
    set_state_value(state, "checking", serde_json::json!(false));
    set_state_value(state, "available", serde_json::json!(true));
    set_state_value(state, "downloading", serde_json::json!(true));
    set_state_value(state, "ready", serde_json::json!(false));
    set_state_value(state, "installPending", serde_json::json!(false));
    set_state_value(state, "installingVersion", serde_json::Value::Null);
    set_state_value(state, "error", serde_json::Value::Null);
    set_state_value(state, "progress", serde_json::json!(0));
}

fn set_download_ready_state(
    state: &mut serde_json::Value,
    update_info: serde_json::Value,
    version: &str,
    artifact_path: &Path,
) {
    set_state_value(state, "checking", serde_json::json!(false));
    set_state_value(state, "available", serde_json::json!(true));
    set_state_value(state, "downloading", serde_json::json!(false));
    set_state_value(state, "ready", serde_json::json!(true));
    set_state_value(state, "error", serde_json::Value::Null);
    set_state_value(state, "progress", serde_json::json!(100));
    set_state_value(state, "updateInfo", update_info);
    set_state_value(state, "downloadedVersion", serde_json::json!(version));
    set_state_value(
        state,
        "downloadedArtifactPath",
        serde_json::json!(artifact_path.to_string_lossy().to_string()),
    );
    set_state_value(state, "installPending", serde_json::json!(false));
    set_state_value(state, "installingVersion", serde_json::Value::Null);
}

fn set_installing_state(state: &mut serde_json::Value, version: &str) {
    set_state_value(state, "checking", serde_json::json!(false));
    set_state_value(state, "available", serde_json::json!(false));
    set_state_value(state, "downloading", serde_json::json!(false));
    set_state_value(state, "ready", serde_json::json!(false));
    set_state_value(state, "installPending", serde_json::json!(false));
    set_state_value(state, "installingVersion", serde_json::json!(version));
    set_state_value(state, "error", serde_json::Value::Null);
}

fn reset_update_state(state: &mut serde_json::Value) {
    set_state_value(state, "checking", serde_json::json!(false));
    set_state_value(state, "available", serde_json::json!(false));
    set_state_value(state, "downloading", serde_json::json!(false));
    set_state_value(state, "ready", serde_json::json!(false));
    set_state_value(state, "error", serde_json::Value::Null);
    set_state_value(state, "progress", serde_json::json!(0));
    set_state_value(state, "updateInfo", serde_json::Value::Null);
    set_state_value(state, "downloadedVersion", serde_json::Value::Null);
    set_state_value(state, "downloadedArtifactPath", serde_json::Value::Null);
    set_state_value(state, "installPending", serde_json::json!(false));
    set_state_value(state, "installingVersion", serde_json::Value::Null);
}

fn clear_runtime_update_state(updater_runtime: &UpdaterRuntimeState) -> Result<(), String> {
    let mut pending = updater_runtime
        .pending_update
        .lock()
        .map_err(|e| format!("updater state lock failed: {e}"))?;
    *pending = None;
    drop(pending);

    let mut downloaded = updater_runtime
        .downloaded_bytes
        .lock()
        .map_err(|e| format!("updater bytes lock failed: {e}"))?;
    *downloaded = None;
    Ok(())
}

fn remove_artifact(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

fn sanitize_filename_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-' => ch,
            _ => '_',
        })
        .collect()
}

fn updater_artifact_path(
    app: &AppHandle,
    update: &tauri_plugin_updater::Update,
) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let artifacts_dir = app_data_dir.join(UPDATER_ARTIFACT_DIR);
    std::fs::create_dir_all(&artifacts_dir)
        .map_err(|e| format!("Failed to create updater artifact dir: {e}"))?;

    let remote_filename = update
        .download_url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("update.bin");

    let filename = format!(
        "{}-{}",
        sanitize_filename_component(&update.version),
        sanitize_filename_component(remote_filename),
    );

    Ok(artifacts_dir.join(filename))
}

fn artifact_exists(path: Option<&Path>) -> bool {
    path.map(|value| value.exists()).unwrap_or(false)
}

fn should_clear_state_for_current_version(
    state: &serde_json::Value,
    current_version: &str,
) -> bool {
    let downloaded_version = update_state_string(state, "downloadedVersion");
    let installing_version = update_state_string(state, "installingVersion");
    let ready = update_state_bool(state, "ready");
    let install_pending = update_state_bool(state, "installPending");
    let artifact_path = update_state_path(state, "downloadedArtifactPath");
    let has_update_info_version = state
        .get("updateInfo")
        .and_then(|value| value.get("version"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some();

    if downloaded_version.as_deref() == Some(current_version)
        || installing_version.as_deref() == Some(current_version)
    {
        return true;
    }

    let has_persisted_session = ready
        || install_pending
        || downloaded_version.is_some()
        || installing_version.is_some()
        || artifact_path.is_some();

    if has_persisted_session && !artifact_exists(artifact_path.as_deref()) {
        return true;
    }

    ready && downloaded_version.is_none() && !has_update_info_version
}

fn reconcile_persisted_update_state(db: &db::DbState) -> Result<serde_json::Value, String> {
    let mut state = crate::read_update_state(db)?;
    let current_version = env!("CARGO_PKG_VERSION");
    let artifact_path = update_state_path(&state, "downloadedArtifactPath");

    if should_clear_state_for_current_version(&state, current_version) {
        remove_artifact(artifact_path.as_deref());
        reset_update_state(&mut state);
        crate::write_update_state(db, &state)?;
    }

    Ok(state)
}

fn rehydrate_downloaded_bytes(
    updater_runtime: &UpdaterRuntimeState,
    artifact_path: &Path,
) -> Result<Vec<u8>, String> {
    {
        let downloaded = updater_runtime
            .downloaded_bytes
            .lock()
            .map_err(|e| format!("updater bytes lock failed: {e}"))?;
        if let Some(bytes) = downloaded.as_ref() {
            return Ok(bytes.clone());
        }
    }

    let bytes = std::fs::read(artifact_path)
        .map_err(|e| format!("Failed to read downloaded update artifact: {e}"))?;

    let mut downloaded = updater_runtime
        .downloaded_bytes
        .lock()
        .map_err(|e| format!("updater bytes lock failed: {e}"))?;
    *downloaded = Some(bytes.clone());
    Ok(bytes)
}

async fn fetch_matching_remote_update(
    app: &AppHandle,
    target_version: &str,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let updater = app
        .updater()
        .map_err(|error| format!("Failed to initialize updater: {error}"))?;

    match updater.check().await {
        Ok(Some(update)) if update.version == target_version => Ok(Some(update)),
        Ok(Some(_)) | Ok(None) => Ok(None),
        Err(error) => Err(format!("Failed to rehydrate downloaded update: {error}")),
    }
}

async fn ensure_pending_update_loaded(
    app: &AppHandle,
    target_version: &str,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    {
        let updater_runtime = app.state::<UpdaterRuntimeState>();
        let pending = updater_runtime
            .pending_update
            .lock()
            .map_err(|e| format!("updater state lock failed: {e}"))?;
        if let Some(update) = pending.as_ref() {
            return Ok(Some(update.clone()));
        }
    }

    let update = fetch_matching_remote_update(app, target_version).await?;

    if let Some(remote_update) = update.as_ref() {
        let updater_runtime = app.state::<UpdaterRuntimeState>();
        let mut pending = updater_runtime
            .pending_update
            .lock()
            .map_err(|e| format!("updater state lock failed: {e}"))?;
        *pending = Some(remote_update.clone());
    }

    Ok(update)
}

pub async fn reconcile_update_state_on_startup(app: AppHandle) {
    let mut state = {
        let db = app.state::<db::DbState>();
        match reconcile_persisted_update_state(&db) {
            Ok(state) => state,
            Err(error) => {
                eprintln!("[updates] Failed to reconcile updater state on startup: {error}");
                return;
            }
        }
    };

    let downloaded_version = update_state_string(&state, "downloadedVersion");
    let artifact_path = update_state_path(&state, "downloadedArtifactPath");
    let install_pending = update_state_bool(&state, "installPending");

    let (Some(version), Some(artifact_path)) = (downloaded_version, artifact_path) else {
        return;
    };

    if !artifact_path.exists() {
        return;
    }

    let matching_update = match ensure_pending_update_loaded(&app, &version).await {
        Ok(update) => update,
        Err(error) => {
            eprintln!("[updates] Failed to rehydrate updater session: {error}");
            return;
        }
    };

    let Some(update) = matching_update else {
        let db = app.state::<db::DbState>();
        remove_artifact(Some(&artifact_path));
        reset_update_state(&mut state);
        let _ = crate::write_update_state(&db, &state);
        let updater_runtime = app.state::<UpdaterRuntimeState>();
        let _ = clear_runtime_update_state(&updater_runtime);
        return;
    };

    {
        let updater_runtime = app.state::<UpdaterRuntimeState>();
        if let Ok(bytes) = rehydrate_downloaded_bytes(&updater_runtime, &artifact_path) {
            let update_info = crate::update_info_from_release(&update);
            if install_pending {
                set_installing_state(&mut state, &version);
                let db = app.state::<db::DbState>();
                let _ = crate::write_update_state(&db, &state);
                if let Err(error) = update.install(bytes) {
                    let message = format!("Failed to install update: {error}");
                    set_download_ready_state(&mut state, update_info, &version, &artifact_path);
                    set_state_value(&mut state, "error", serde_json::json!(message.clone()));
                    let _ = crate::write_update_state(&db, &state);
                    let _ = app.emit("update_error", serde_json::json!({ "message": message }));
                }
            } else {
                set_download_ready_state(&mut state, update_info, &version, &artifact_path);
                let db = app.state::<db::DbState>();
                let _ = crate::write_update_state(&db, &state);
            }
        }
    }
}

#[tauri::command]
pub async fn update_get_state(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    reconcile_persisted_update_state(&db)
}

#[tauri::command]
pub async fn update_check(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    updater_runtime: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<(), String> {
    if let Err(message) = ensure_updater_is_available() {
        let mut state = crate::read_update_state(&db)?;
        reset_update_state(&mut state);
        set_state_value(&mut state, "error", serde_json::json!(message.clone()));
        crate::write_update_state(&db, &state)?;
        let _ = app.emit("update_error", serde_json::json!({ "message": message }));
        return Ok(());
    }

    let mut state = crate::read_update_state(&db)?;
    let prior_artifact = update_state_path(&state, "downloadedArtifactPath");
    remove_artifact(prior_artifact.as_deref());
    let _ = clear_runtime_update_state(&updater_runtime);

    reset_update_state(&mut state);
    set_state_value(&mut state, "checking", serde_json::json!(true));
    crate::write_update_state(&db, &state)?;
    let _ = app.emit("update_checking", serde_json::json!({}));

    match crate::updater_manifest_is_reachable().await {
        Ok(true) => {}
        Ok(false) => {
            set_state_value(
                &mut state,
                "error",
                serde_json::json!("Updater endpoint is unreachable"),
            );
            crate::write_update_state(&db, &state)?;
            let _ = app.emit(
                "update_error",
                serde_json::json!({ "message": "Updater endpoint is unreachable" }),
            );
            return Ok(());
        }
        Err(error) => {
            let message = format!("Failed to reach updater manifest: {error}");
            set_state_value(&mut state, "error", serde_json::json!(message.clone()));
            crate::write_update_state(&db, &state)?;
            let _ = app.emit("update_error", serde_json::json!({ "message": message }));
            return Ok(());
        }
    }

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            let message = format!("Failed to initialize updater: {error}");
            set_state_value(&mut state, "checking", serde_json::json!(false));
            set_state_value(&mut state, "error", serde_json::json!(message.clone()));
            crate::write_update_state(&db, &state)?;
            let _ = app.emit("update_error", serde_json::json!({ "message": message }));
            return Ok(());
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let update_info = crate::update_info_from_release(&update);
            {
                let mut pending = updater_runtime
                    .pending_update
                    .lock()
                    .map_err(|e| format!("updater state lock failed: {e}"))?;
                *pending = Some(update);
            }

            set_state_value(&mut state, "checking", serde_json::json!(false));
            set_state_value(&mut state, "available", serde_json::json!(true));
            set_state_value(&mut state, "downloading", serde_json::json!(false));
            set_state_value(&mut state, "ready", serde_json::json!(false));
            set_state_value(&mut state, "error", serde_json::Value::Null);
            set_state_value(&mut state, "progress", serde_json::json!(0));
            set_state_value(&mut state, "updateInfo", update_info.clone());
            set_state_value(&mut state, "downloadedVersion", serde_json::Value::Null);
            set_state_value(
                &mut state,
                "downloadedArtifactPath",
                serde_json::Value::Null,
            );
            set_state_value(&mut state, "installPending", serde_json::json!(false));
            set_state_value(&mut state, "installingVersion", serde_json::Value::Null);
            crate::write_update_state(&db, &state)?;
            let _ = app.emit("update_available", update_info);
        }
        Ok(None) => {
            set_state_value(&mut state, "checking", serde_json::json!(false));
            crate::write_update_state(&db, &state)?;
            let _ = app.emit("update_not_available", serde_json::Value::Null);
        }
        Err(error) => {
            let message = format!("Failed to check for updates: {error}");
            set_state_value(&mut state, "checking", serde_json::json!(false));
            set_state_value(&mut state, "error", serde_json::json!(message.clone()));
            crate::write_update_state(&db, &state)?;
            let _ = app.emit("update_error", serde_json::json!({ "message": message }));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn update_download(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    updater_runtime: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<serde_json::Value, String> {
    if let Err(message) = ensure_updater_is_available() {
        let _ = app.emit(
            "update_error",
            serde_json::json!({ "message": message.clone() }),
        );
        return Ok(serde_json::json!({ "success": false, "error": message }));
    }

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

    let artifact_path = updater_artifact_path(&app, &update)?;
    let artifact_version = update.version.clone();
    let mut state = crate::read_update_state(&db)?;
    let prior_artifact = update_state_path(&state, "downloadedArtifactPath");
    remove_artifact(prior_artifact.as_deref());

    set_downloading_state(&mut state);
    crate::write_update_state(&db, &state)?;
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
            if let Err(error) = std::fs::write(&artifact_path, &bytes) {
                let message = format!("Failed to persist downloaded update: {error}");
                let _ = clear_runtime_update_state(&updater_runtime);
                remove_artifact(Some(&artifact_path));
                set_state_value(&mut state, "downloading", serde_json::json!(false));
                set_state_value(&mut state, "ready", serde_json::json!(false));
                set_state_value(&mut state, "error", serde_json::json!(message.clone()));
                set_state_value(&mut state, "progress", serde_json::json!(0));
                set_state_value(&mut state, "downloadedVersion", serde_json::Value::Null);
                set_state_value(
                    &mut state,
                    "downloadedArtifactPath",
                    serde_json::Value::Null,
                );
                set_state_value(&mut state, "installPending", serde_json::json!(false));
                set_state_value(&mut state, "installingVersion", serde_json::Value::Null);
                crate::write_update_state(&db, &state)?;
                let _ = app.emit(
                    "update_error",
                    serde_json::json!({ "message": message.clone() }),
                );
                return Ok(serde_json::json!({ "success": false, "error": message }));
            }

            {
                let mut downloaded = updater_runtime
                    .downloaded_bytes
                    .lock()
                    .map_err(|e| format!("updater bytes lock failed: {e}"))?;
                *downloaded = Some(bytes);
            }

            let update_info = state
                .get("updateInfo")
                .cloned()
                .unwrap_or_else(|| crate::update_info_from_release(&update));

            set_download_ready_state(
                &mut state,
                update_info.clone(),
                &artifact_version,
                &artifact_path,
            );
            crate::write_update_state(&db, &state)?;

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

            let _ = app.emit("update_downloaded", update_info);
            Ok(serde_json::json!({ "success": true }))
        }
        Err(error) => {
            let message = format!("Failed to download update: {error}");
            let _ = clear_runtime_update_state(&updater_runtime);
            remove_artifact(Some(&artifact_path));

            set_state_value(&mut state, "downloading", serde_json::json!(false));
            set_state_value(&mut state, "ready", serde_json::json!(false));
            set_state_value(&mut state, "error", serde_json::json!(message.clone()));
            set_state_value(&mut state, "progress", serde_json::json!(0));
            set_state_value(&mut state, "downloadedVersion", serde_json::Value::Null);
            set_state_value(
                &mut state,
                "downloadedArtifactPath",
                serde_json::Value::Null,
            );
            set_state_value(&mut state, "installPending", serde_json::json!(false));
            set_state_value(&mut state, "installingVersion", serde_json::Value::Null);
            crate::write_update_state(&db, &state)?;
            let _ = app.emit(
                "update_error",
                serde_json::json!({ "message": message.clone() }),
            );
            Ok(serde_json::json!({ "success": false, "error": message }))
        }
    }
}

#[tauri::command]
pub async fn update_cancel_download(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let message = "Cancelling an in-progress Tauri updater download is not supported".to_string();
    let _ = app.emit(
        "update_error",
        serde_json::json!({ "message": message.clone() }),
    );
    Ok(serde_json::json!({ "success": false, "error": message }))
}

#[tauri::command]
pub async fn update_schedule_install(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let mut state = crate::read_update_state(&db)?;
    let artifact_path = update_state_path(&state, "downloadedArtifactPath");
    let downloaded_version = update_state_string(&state, "downloadedVersion");

    if downloaded_version.is_none() || !artifact_exists(artifact_path.as_deref()) {
        return Ok(serde_json::json!({
            "success": false,
            "error": "Update payload is missing. Download the update again."
        }));
    }

    set_state_value(&mut state, "installPending", serde_json::json!(true));
    crate::write_update_state(&db, &state)?;

    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn update_install(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    updater_runtime: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<serde_json::Value, String> {
    if let Err(message) = ensure_updater_is_available() {
        let _ = app.emit(
            "update_error",
            serde_json::json!({ "message": message.clone() }),
        );
        return Ok(serde_json::json!({ "success": false, "error": message }));
    }

    let mut state = crate::read_update_state(&db)?;
    let downloaded_version = update_state_string(&state, "downloadedVersion");
    let artifact_path = update_state_path(&state, "downloadedArtifactPath");

    let (Some(version), Some(artifact_path)) = (downloaded_version, artifact_path) else {
        let message = "Update payload is missing. Download the update again.".to_string();
        let _ = app.emit(
            "update_error",
            serde_json::json!({ "message": message.clone() }),
        );
        return Ok(serde_json::json!({ "success": false, "error": message }));
    };

    if !artifact_path.exists() {
        let message = "Update payload is missing. Download the update again.".to_string();
        let _ = app.emit(
            "update_error",
            serde_json::json!({ "message": message.clone() }),
        );
        return Ok(serde_json::json!({ "success": false, "error": message }));
    }

    let pending_update = ensure_pending_update_loaded(&app, &version).await?;

    let Some(update) = pending_update else {
        let message = "Downloaded update is no longer valid. Check for updates again.".to_string();
        let _ = app.emit(
            "update_error",
            serde_json::json!({ "message": message.clone() }),
        );
        return Ok(serde_json::json!({ "success": false, "error": message }));
    };

    let bytes = rehydrate_downloaded_bytes(&updater_runtime, &artifact_path)?;

    set_installing_state(&mut state, &version);
    crate::write_update_state(&db, &state)?;

    match update.install(bytes) {
        Ok(_) => Ok(serde_json::json!({ "success": true })),
        Err(error) => {
            let message = format!("Failed to install update: {error}");
            let update_info = state
                .get("updateInfo")
                .cloned()
                .unwrap_or_else(|| crate::update_info_from_release(&update));
            set_download_ready_state(&mut state, update_info, &version, &artifact_path);
            set_state_value(&mut state, "error", serde_json::json!(message.clone()));
            crate::write_update_state(&db, &state)?;

            let _ = app.emit(
                "update_error",
                serde_json::json!({ "message": message.clone() }),
            );
            Ok(serde_json::json!({ "success": false, "error": message }))
        }
    }
}

#[tauri::command]
pub async fn update_set_channel(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let channel = parse_update_channel_payload(arg0);
    if channel != "stable" && channel != "beta" {
        return Err("Invalid update channel".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "update_channel", &channel)?;
    Ok(serde_json::json!({ "success": true, "channel": channel }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_update_channel_payload_supports_string_and_object() {
        let from_string = parse_update_channel_payload(Some(serde_json::json!("beta")));
        let from_object = parse_update_channel_payload(Some(serde_json::json!({
            "update_channel": "stable"
        })));
        assert_eq!(from_string, "beta");
        assert_eq!(from_object, "stable");
    }

    #[test]
    fn parse_update_channel_payload_defaults_to_stable() {
        let from_none = parse_update_channel_payload(None);
        let from_empty = parse_update_channel_payload(Some(serde_json::json!("   ")));
        assert_eq!(from_none, "stable");
        assert_eq!(from_empty, "stable");
    }

    #[test]
    fn validate_updater_configuration_rejects_debug_builds() {
        let result = validate_updater_configuration(true, Some("real-pubkey"));
        assert_eq!(
            result.unwrap_err(),
            "Updater is disabled in local development builds. Use a packaged release build to test updates."
        );
    }

    #[test]
    fn validate_updater_configuration_rejects_placeholder_pubkey() {
        let result = validate_updater_configuration(false, Some(UPDATER_PUBKEY_PLACEHOLDER));
        assert_eq!(
            result.unwrap_err(),
            "Updater public key is not configured for this build. Inject TAURI_UPDATER_PUBKEY or use a packaged release build."
        );
    }

    #[test]
    fn validate_updater_configuration_accepts_release_with_pubkey() {
        let result = validate_updater_configuration(false, Some("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu"));
        assert!(result.is_ok());
    }
}
