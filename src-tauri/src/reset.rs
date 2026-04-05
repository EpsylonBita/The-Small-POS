use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

const RESET_STATUS_DIR: &str = "the-small-pos-reset";
const RESET_STATUS_FILE: &str = "status.json";
const HELPER_ARG: &str = "--reset-helper";
const HELPER_STARTUP_GRACE_MS: u64 = 1_000;
const APP_EXIT_DELAY_MS: u64 = 800;
const FILESYSTEM_DELETE_RETRY_MS: u64 = 500;
const FILESYSTEM_DELETE_TIMEOUT_MS: u64 = 60_000;
const KEYRING_DELETE_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode {
    FactoryReset,
    EmergencyReset,
}

impl ResetMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FactoryReset => "factory_reset",
            Self::EmergencyReset => "emergency_reset",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResetPhase {
    Preparing,
    WaitingForShutdown,
    KeyringCleanup,
    FilesystemCleanup,
    Verifying,
    Relaunching,
    Completed,
    Failed,
}

impl ResetPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::WaitingForShutdown => "waiting_for_shutdown",
            Self::KeyringCleanup => "keyring_cleanup",
            Self::FilesystemCleanup => "filesystem_cleanup",
            Self::Verifying => "verifying",
            Self::Relaunching => "relaunching",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetStatus {
    pub operation_id: String,
    pub mode: String,
    pub phase: String,
    pub state: String,
    pub updated_at: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub failing_key: Option<String>,
    pub failing_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetManifest {
    pub operation_id: String,
    pub mode: ResetMode,
    pub app_executable: PathBuf,
    pub app_data_dir: PathBuf,
    pub local_state_dir: Option<PathBuf>,
    pub status_path: PathBuf,
    pub manifest_path: PathBuf,
    pub credential_keys: Vec<String>,
    pub wipe_paths: Vec<PathBuf>,
}

fn reset_status_root() -> PathBuf {
    std::env::temp_dir().join(RESET_STATUS_DIR)
}

pub fn reset_status_path() -> PathBuf {
    reset_status_root().join(RESET_STATUS_FILE)
}

fn ensure_status_root() -> Result<(), String> {
    fs::create_dir_all(reset_status_root()).map_err(|e| format!("create reset status dir: {e}"))
}

fn write_status(status: &ResetStatus) -> Result<(), String> {
    ensure_status_root()?;
    let path = reset_status_path();
    let encoded =
        serde_json::to_vec_pretty(status).map_err(|e| format!("serialize reset status: {e}"))?;
    fs::write(path, encoded).map_err(|e| format!("write reset status: {e}"))
}

fn make_status(
    manifest: &ResetManifest,
    phase: ResetPhase,
    state: &str,
    error_code: Option<&str>,
    error_message: Option<String>,
    failing_key: Option<String>,
    failing_path: Option<String>,
) -> ResetStatus {
    ResetStatus {
        operation_id: manifest.operation_id.clone(),
        mode: manifest.mode.as_str().to_string(),
        phase: phase.as_str().to_string(),
        state: state.to_string(),
        updated_at: Utc::now().to_rfc3339(),
        error_code: error_code.map(|value| value.to_string()),
        error_message,
        failing_key,
        failing_path,
    }
}

fn emit_progress(app: &AppHandle, manifest: &ResetManifest, phase: ResetPhase) {
    let payload = json!({
        "operationId": manifest.operation_id,
        "mode": manifest.mode.as_str(),
        "phase": phase.as_str(),
        "state": "running",
        "updatedAt": Utc::now().to_rfc3339(),
    });
    let _ = app.emit("reset_progress", payload);
}

fn emit_failed(app: &AppHandle, manifest: &ResetManifest, error_code: &str, error_message: &str) {
    let payload = json!({
        "operationId": manifest.operation_id,
        "mode": manifest.mode.as_str(),
        "phase": ResetPhase::Failed.as_str(),
        "state": "failed",
        "errorCode": error_code,
        "errorMessage": error_message,
        "updatedAt": Utc::now().to_rfc3339(),
    });
    let _ = app.emit("reset_failed", payload);
}

fn collect_wipe_paths(app_data_dir: &Path, local_state_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut unique = BTreeSet::new();
    let mut paths = Vec::new();
    let recovery_root = crate::recovery::recovery_root_for_app_data(app_data_dir);

    let mut push_path = |path: &Path| {
        let encoded = path.to_string_lossy().to_string();
        if encoded.trim().is_empty() {
            return;
        }
        if unique.insert(encoded) {
            paths.push(path.to_path_buf());
        }
    };

    if app_data_dir.exists() {
        match fs::read_dir(app_data_dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path == recovery_root {
                        continue;
                    }
                    push_path(&path);
                }
            }
            Err(error) => {
                warn!(
                    path = %app_data_dir.display(),
                    error = %error,
                    "Reset manifest could not enumerate app data dir"
                );
            }
        }
    }

    if let Some(local_state_dir) = local_state_dir {
        push_path(local_state_dir);
    }

    paths
}

fn write_manifest(manifest: &ResetManifest) -> Result<(), String> {
    ensure_status_root()?;
    let encoded = serde_json::to_vec_pretty(manifest)
        .map_err(|e| format!("serialize reset manifest: {e}"))?;
    fs::write(&manifest.manifest_path, encoded).map_err(|e| format!("write reset manifest: {e}"))
}

fn build_manifest(app: &AppHandle, mode: ResetMode) -> Result<ResetManifest, String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let app_executable =
        std::env::current_exe().map_err(|e| format!("resolve current executable: {e}"))?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    let local_state_dir = crate::diagnostics::get_log_dir()
        .parent()
        .map(|path| path.to_path_buf());
    let status_path = reset_status_path();
    let manifest_path = reset_status_root().join(format!("manifest-{operation_id}.json"));
    let wipe_paths = collect_wipe_paths(&app_data_dir, local_state_dir.as_deref());

    Ok(ResetManifest {
        operation_id,
        mode,
        app_executable,
        app_data_dir,
        local_state_dir,
        status_path,
        manifest_path,
        credential_keys: crate::storage::managed_keys()
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        wipe_paths,
    })
}

pub fn get_reset_status() -> Result<Option<ResetStatus>, String> {
    let path = reset_status_path();
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read(path).map_err(|e| format!("read reset status: {e}"))?;
    let status = serde_json::from_slice::<ResetStatus>(&contents)
        .map_err(|e| format!("parse reset status: {e}"))?;
    Ok(Some(status))
}

pub fn clear_reset_status() -> Result<(), String> {
    let path = reset_status_path();
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("clear reset status: {e}"))?;
    }
    Ok(())
}

pub fn maybe_run_reset_helper_from_args() -> Result<bool, String> {
    let mut args = std::env::args_os().skip(1);
    let Some(first_arg) = args.next() else {
        return Ok(false);
    };
    if first_arg != HELPER_ARG {
        return Ok(false);
    }

    let manifest_path = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "Missing reset manifest path".to_string())?;

    run_reset_helper(&manifest_path)?;
    Ok(true)
}

pub fn launch_reset(
    app: &AppHandle,
    mode: ResetMode,
    cancel_token: &tokio_util::sync::CancellationToken,
    device_manager: &crate::ecr::DeviceManager,
) -> Result<serde_json::Value, String> {
    let manifest = build_manifest(app, mode)?;
    write_manifest(&manifest)?;
    write_status(&make_status(
        &manifest,
        ResetPhase::Preparing,
        "running",
        None,
        None,
        None,
        None,
    ))?;
    let _ = app.emit(
        "reset_started",
        json!({
            "operationId": manifest.operation_id,
            "mode": manifest.mode.as_str(),
            "updatedAt": Utc::now().to_rfc3339(),
        }),
    );
    emit_progress(app, &manifest, ResetPhase::Preparing);

    let mut command = Command::new(&manifest.app_executable);
    command.arg(HELPER_ARG).arg(&manifest.manifest_path);
    if let Err(error) = command.spawn() {
        let error_message = format!("Failed to start reset helper: {error}");
        let _ = write_failed_status(
            &manifest,
            "prepare_shutdown_failed",
            error_message.clone(),
            None,
            None,
        );
        emit_failed(app, &manifest, "prepare_shutdown_failed", &error_message);
        return Err(error_message);
    }

    write_status(&make_status(
        &manifest,
        ResetPhase::WaitingForShutdown,
        "running",
        None,
        None,
        None,
        None,
    ))?;
    emit_progress(app, &manifest, ResetPhase::WaitingForShutdown);

    cancel_token.cancel();

    info!("Reset launch: starting best-effort device shutdown");
    device_manager.shutdown();

    let app_to_exit = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(APP_EXIT_DELAY_MS)).await;
        app_to_exit.exit(0);
    });

    info!(
        operation_id = %manifest.operation_id,
        mode = %manifest.mode.as_str(),
        "Reset helper launched; scheduled application shutdown"
    );

    Ok(json!({
        "success": true,
        "started": true,
        "operationId": manifest.operation_id,
        "mode": manifest.mode.as_str(),
    }))
}

fn run_keyring_delete_with_timeout(key: String) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let worker_key = key.clone();
    thread::spawn(move || {
        let result = crate::storage::delete_credential(&worker_key);
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_millis(KEYRING_DELETE_TIMEOUT_MS)) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("Timed out deleting credential key '{key}'"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(format!("Reset helper lost keyring worker for key '{key}'"))
        }
    }
}

fn remove_path_once(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

fn remove_path_with_retries(path: &Path) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_millis(FILESYSTEM_DELETE_TIMEOUT_MS);
    let mut last_error: Option<String> = None;

    while Instant::now() <= deadline {
        match remove_path_once(path) {
            Ok(()) => {
                if !path.exists() {
                    return Ok(());
                }
                last_error = Some("path still exists after delete".to_string());
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
        thread::sleep(Duration::from_millis(FILESYSTEM_DELETE_RETRY_MS));
    }

    Err(last_error.unwrap_or_else(|| "unknown filesystem delete error".to_string()))
}

fn verify_reset(manifest: &ResetManifest) -> Result<(), (String, Option<String>, Option<String>)> {
    for key in &manifest.credential_keys {
        if crate::storage::get_credential(key).is_some() {
            return Err((
                "keyring_delete_failed".to_string(),
                Some(key.clone()),
                None,
            ));
        }
    }

    for path in &manifest.wipe_paths {
        if path.exists() {
            return Err((
                "filesystem_delete_failed".to_string(),
                None,
                Some(path.to_string_lossy().to_string()),
            ));
        }
    }

    Ok(())
}

fn write_failed_status(
    manifest: &ResetManifest,
    error_code: &str,
    error_message: String,
    failing_key: Option<String>,
    failing_path: Option<String>,
) -> Result<(), String> {
    let status = make_status(
        manifest,
        ResetPhase::Failed,
        "failed",
        Some(error_code),
        Some(error_message),
        failing_key,
        failing_path,
    );
    write_status(&status)
}

pub fn run_reset_helper(manifest_path: &Path) -> Result<(), String> {
    let manifest_contents =
        fs::read(manifest_path).map_err(|e| format!("read reset manifest: {e}"))?;
    let manifest = serde_json::from_slice::<ResetManifest>(&manifest_contents)
        .map_err(|e| format!("parse reset manifest: {e}"))?;

    write_status(&make_status(
        &manifest,
        ResetPhase::WaitingForShutdown,
        "running",
        None,
        None,
        None,
        None,
    ))?;
    thread::sleep(Duration::from_millis(HELPER_STARTUP_GRACE_MS));

    for key in &manifest.credential_keys {
        write_status(&make_status(
            &manifest,
            ResetPhase::KeyringCleanup,
            "running",
            None,
            None,
            Some(key.clone()),
            None,
        ))?;
        info!(key = %key, "Reset helper deleting credential");
        if let Err(error) = run_keyring_delete_with_timeout(key.clone()) {
            let error_message = format!("Failed to delete credential '{key}': {error}");
            let _ = write_failed_status(
                &manifest,
                "keyring_delete_failed",
                error_message.clone(),
                Some(key.clone()),
                None,
            );
            return Err(error_message);
        }
    }

    for path in &manifest.wipe_paths {
        let failing_path = path.to_string_lossy().to_string();
        write_status(&make_status(
            &manifest,
            ResetPhase::FilesystemCleanup,
            "running",
            None,
            None,
            None,
            Some(failing_path.clone()),
        ))?;
        info!(path = %failing_path, "Reset helper deleting local path");
        if let Err(error) = remove_path_with_retries(path) {
            let error_message = format!("Failed to delete '{failing_path}': {error}");
            let _ = write_failed_status(
                &manifest,
                "filesystem_delete_failed",
                error_message.clone(),
                None,
                Some(failing_path),
            );
            return Err(error_message);
        }
    }

    write_status(&make_status(
        &manifest,
        ResetPhase::Verifying,
        "running",
        None,
        None,
        None,
        None,
    ))?;

    if let Err((error_code, failing_key, failing_path)) = verify_reset(&manifest) {
        let error_message = match (&failing_key, &failing_path) {
            (Some(key), _) => format!("Credential '{key}' is still present after reset"),
            (_, Some(path)) => format!("Path '{path}' still exists after reset"),
            _ => "Reset verification failed".to_string(),
        };
        let _ = write_failed_status(
            &manifest,
            &error_code,
            error_message.clone(),
            failing_key,
            failing_path,
        );
        return Err(error_message);
    }

    write_status(&make_status(
        &manifest,
        ResetPhase::Relaunching,
        "running",
        None,
        None,
        None,
        None,
    ))?;

    if let Err(error) = Command::new(&manifest.app_executable).spawn() {
        let error_message = format!("Failed to relaunch app: {error}");
        let _ = write_failed_status(
            &manifest,
            "relaunch_failed",
            error_message.clone(),
            None,
            None,
        );
        return Err(error_message);
    }

    write_status(&make_status(
        &manifest,
        ResetPhase::Completed,
        "completed",
        None,
        None,
        None,
        None,
    ))?;

    if let Err(error) = fs::remove_file(manifest_path) {
        warn!(path = %manifest_path.display(), error = %error, "Failed to remove reset manifest");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn collect_wipe_paths_deduplicates_entries() {
        let path = PathBuf::from(r"C:\tmp\one");
        let paths = collect_wipe_paths(&path, Some(&path));
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0], path);
    }

    #[test]
    fn collect_wipe_paths_preserves_recovery_dir() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("the-small-pos-reset-wipe-{suffix}"));
        let app_data = dir.join("data");
        let recovery = crate::recovery::recovery_root_for_app_data(&app_data);
        let receipts = app_data.join("receipts");
        fs::create_dir_all(&recovery).unwrap();
        fs::create_dir_all(&receipts).unwrap();
        fs::write(app_data.join("pos.db"), b"db").unwrap();

        let paths = collect_wipe_paths(&app_data, None);
        assert!(paths.contains(&app_data.join("pos.db")));
        assert!(paths.contains(&receipts));
        assert!(!paths.contains(&recovery));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_status_roundtrip() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("the-small-pos-reset-test-{suffix}"));
        fs::create_dir_all(&dir).unwrap();
        let manifest = ResetManifest {
            operation_id: "test".to_string(),
            mode: ResetMode::FactoryReset,
            app_executable: dir.join("app.exe"),
            app_data_dir: dir.join("data"),
            local_state_dir: Some(dir.join("local")),
            status_path: dir.join("status.json"),
            manifest_path: dir.join("manifest.json"),
            credential_keys: vec!["terminal_id".to_string()],
            wipe_paths: vec![dir.join("data")],
        };
        let status = make_status(
            &manifest,
            ResetPhase::Preparing,
            "running",
            None,
            None,
            None,
            None,
        );
        let encoded = serde_json::to_vec_pretty(&status).unwrap();
        let decoded = serde_json::from_slice::<ResetStatus>(&encoded).unwrap();
        assert_eq!(decoded.operation_id, "test");
        assert_eq!(decoded.phase, "preparing");
        let _ = fs::remove_dir_all(&dir);
    }
}
