use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

const RESET_STATUS_DIR: &str = "the-small-pos-reset";
const RESET_STATUS_FILE: &str = "status.json";
const RESET_OWNERSHIP_FILE: &str = "ownership.json";
const RESET_OWNERSHIP_VERSION: u8 = 2;
const RESET_OWNERSHIP_TRANSITION_TIMEOUT_MS: u32 = 5_000;
const HELPER_ARG: &str = "--reset-helper";
const HELPER_STARTUP_GRACE_MS: u64 = 1_000;
const APP_EXIT_DELAY_MS: u64 = 800;
const NORMAL_RESET_GATE_POLL_MS: u64 = 50;
const NORMAL_RESET_GATE_ATTEMPTS: u32 = 100;
const FILESYSTEM_DELETE_RETRY_MS: u64 = 500;
const FILESYSTEM_DELETE_TIMEOUT_MS: u64 = 60_000;
const KEYRING_DELETE_TIMEOUT_MS: u64 = 10_000;
const DEV_SERVER_PORT: u16 = 1420;
const DEV_RELAUNCH_SETTLE_MS: u64 = 2_000;
const DEV_SERVER_READY_TIMEOUT_MS: u64 = 20_000;
const DEV_SERVER_POLL_MS: u64 = 250;

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

#[derive(Debug, Clone)]
pub(crate) struct TrustedResetPaths {
    pub(crate) app_executable: PathBuf,
    pub(crate) app_data_dir: PathBuf,
    pub(crate) local_state_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct ResetManifestBinding {
    operation_id: String,
    mode: ResetMode,
    manifest_path: PathBuf,
    manifest_sha256: String,
    app_executable: PathBuf,
    app_data_dir: PathBuf,
    local_state_dir: Option<PathBuf>,
    status_path: PathBuf,
    credential_keys: Vec<String>,
    wipe_paths: Vec<PathBuf>,
}

/// Non-serializable proof that the native reset helper completed every
/// authorization gate for one immutable manifest.
#[derive(Debug)]
pub(crate) struct ResetCredentialOwner {
    operation_id: String,
    manifest_sha256: String,
    credential_keys: Vec<String>,
    _private: (),
}

impl ResetCredentialOwner {
    pub(crate) fn authorizes(&self, key: &str) -> bool {
        is_canonical_operation_id(&self.operation_id)
            && self.manifest_sha256.len() == 64
            && self
                .manifest_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && self.credential_keys.iter().any(|managed| managed == key)
            && self.credential_keys
                == crate::storage::managed_keys()
                    .iter()
                    .map(|managed| (*managed).to_string())
                    .collect::<Vec<_>>()
    }
}

#[derive(Debug)]
struct AuthorizedResetManifest {
    manifest: ResetManifest,
    credential_owner: Arc<ResetCredentialOwner>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResetLaunchOutcome {
    NotStarted {
        error: String,
    },
    Accepted {
        operation_id: String,
        response: serde_json::Value,
        post_spawn_warning: Option<String>,
    },
}

impl ResetLaunchOutcome {
    fn not_started(error: impl Into<String>) -> Self {
        Self::NotStarted {
            error: error.into(),
        }
    }

    fn accepted(mut response: serde_json::Value, post_spawn_warning: Option<String>) -> Self {
        let operation_id = response
            .get("operationId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        expose_post_spawn_warning(&mut response, post_spawn_warning.as_deref());
        Self::Accepted {
            operation_id,
            response,
            post_spawn_warning,
        }
    }

    pub(crate) fn into_command_result(mut self) -> Result<serde_json::Value, String> {
        match &mut self {
            Self::NotStarted { error } => Err(std::mem::take(error)),
            Self::Accepted {
                operation_id: _,
                response,
                post_spawn_warning,
            } => {
                expose_post_spawn_warning(response, post_spawn_warning.as_deref());
                Ok(std::mem::take(response))
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ResetOwnershipState {
    Launching,
    Accepted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResetOwnershipRecord {
    version: u8,
    operation_id: String,
    mode: ResetMode,
    state: ResetOwnershipState,
    response: serde_json::Value,
    post_spawn_warning: Option<String>,
    manifest_path: PathBuf,
    manifest_sha256: String,
    app_executable: PathBuf,
    app_data_dir: PathBuf,
    local_state_dir: Option<PathBuf>,
    status_path: PathBuf,
    credential_keys: Vec<String>,
    wipe_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResetOwnershipTransitionAcquisition {
    Acquired,
    Abandoned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResetOwnershipTransitionAcquireError {
    CreateFailed,
    Timeout,
    WaitFailed,
}

impl ResetOwnershipTransitionAcquireError {
    fn as_code(self) -> &'static str {
        match self {
            Self::CreateFailed => "RESET_OWNERSHIP_TRANSITION_CREATE_FAILED",
            Self::Timeout => "RESET_OWNERSHIP_TRANSITION_TIMEOUT",
            Self::WaitFailed => "RESET_OWNERSHIP_TRANSITION_WAIT_FAILED",
        }
    }
}

fn classify_reset_ownership_transition_wait(
    wait_result: u32,
) -> Result<ResetOwnershipTransitionAcquisition, ResetOwnershipTransitionAcquireError> {
    match wait_result {
        0x0000_0000 => Ok(ResetOwnershipTransitionAcquisition::Acquired),
        0x0000_0080 => Ok(ResetOwnershipTransitionAcquisition::Abandoned),
        0x0000_0102 => Err(ResetOwnershipTransitionAcquireError::Timeout),
        _ => Err(ResetOwnershipTransitionAcquireError::WaitFailed),
    }
}

#[cfg(target_os = "windows")]
struct ResetOwnershipTransitionGuard {
    handle: windows_sys::Win32::Foundation::HANDLE,
    _acquisition: ResetOwnershipTransitionAcquisition,
}

#[cfg(target_os = "windows")]
impl Drop for ResetOwnershipTransitionGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::ReleaseMutex;

        unsafe {
            if ReleaseMutex(self.handle) == 0 {
                warn!("Failed to release reset ownership transition mutex");
            }
            if CloseHandle(self.handle) == 0 {
                warn!("Failed to close reset ownership transition mutex handle");
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn acquire_reset_ownership_transition_for_identifier(
    compiled_identifier: &str,
    timeout_ms: u32,
) -> Result<ResetOwnershipTransitionGuard, ResetOwnershipTransitionAcquireError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};

    if compiled_identifier.is_empty()
        || compiled_identifier.contains(['\\', '/'])
        || compiled_identifier.contains('\0')
    {
        return Err(ResetOwnershipTransitionAcquireError::CreateFailed);
    }
    let mutex_name = format!("Local\\{compiled_identifier}.reset-ownership-transition");
    let encoded = OsStr::new(&mutex_name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, encoded.as_ptr()) };
    if handle.is_null() {
        return Err(ResetOwnershipTransitionAcquireError::CreateFailed);
    }

    let acquisition = match classify_reset_ownership_transition_wait(unsafe {
        WaitForSingleObject(handle, timeout_ms)
    }) {
        Ok(acquisition) => acquisition,
        Err(error) => {
            unsafe {
                CloseHandle(handle);
            }
            return Err(error);
        }
    };
    if acquisition == ResetOwnershipTransitionAcquisition::Abandoned {
        warn!("Acquired abandoned reset ownership transition mutex; revalidating durable state");
    }
    Ok(ResetOwnershipTransitionGuard {
        handle,
        _acquisition: acquisition,
    })
}

#[cfg(not(target_os = "windows"))]
struct ResetOwnershipTransitionGuard {
    _guard: MutexGuard<'static, ()>,
    _acquisition: ResetOwnershipTransitionAcquisition,
}

#[cfg(not(target_os = "windows"))]
fn acquire_reset_ownership_transition_for_identifier(
    _compiled_identifier: &str,
    _timeout_ms: u32,
) -> Result<ResetOwnershipTransitionGuard, ResetOwnershipTransitionAcquireError> {
    static TRANSITION: OnceLock<Mutex<()>> = OnceLock::new();
    let guard = TRANSITION
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| ResetOwnershipTransitionAcquireError::WaitFailed)?;
    Ok(ResetOwnershipTransitionGuard {
        _guard: guard,
        _acquisition: ResetOwnershipTransitionAcquisition::Acquired,
    })
}

fn acquire_reset_ownership_transition(
) -> Result<ResetOwnershipTransitionGuard, ResetOwnershipTransitionAcquireError> {
    let identifier = compiled_app_identifier_from_build_config()
        .map_err(|_| ResetOwnershipTransitionAcquireError::CreateFailed)?;
    acquire_reset_ownership_transition_for_identifier(
        &identifier,
        RESET_OWNERSHIP_TRANSITION_TIMEOUT_MS,
    )
}

fn with_reset_ownership_transition_dependency<T, A, G, F>(
    acquire_transition: A,
    operation: F,
) -> Result<T, String>
where
    A: FnOnce() -> Result<G, ResetOwnershipTransitionAcquireError>,
    F: FnOnce() -> Result<T, String>,
{
    let _guard = acquire_transition().map_err(|error| error.as_code().to_string())?;
    operation()
}

fn with_reset_ownership_transition<T, F>(operation: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    with_reset_ownership_transition_dependency(acquire_reset_ownership_transition, operation)
}

fn reset_orchestration_mutex() -> &'static Mutex<()> {
    static RESET_ORCHESTRATION: OnceLock<Mutex<()>> = OnceLock::new();
    RESET_ORCHESTRATION.get_or_init(|| Mutex::new(()))
}

fn process_accepted_reset_ownership() -> &'static Mutex<Option<ResetLaunchOutcome>> {
    static ACCEPTED: OnceLock<Mutex<Option<ResetLaunchOutcome>>> = OnceLock::new();
    ACCEPTED.get_or_init(|| Mutex::new(None))
}

fn record_process_accepted_reset_ownership(outcome: &ResetLaunchOutcome) -> Result<(), String> {
    let ResetLaunchOutcome::Accepted { .. } = outcome else {
        return Ok(());
    };
    *process_accepted_reset_ownership()
        .lock()
        .map_err(|_| "RESET_OWNERSHIP_UNAVAILABLE".to_string())? = Some(outcome.clone());
    Ok(())
}

fn clear_process_accepted_reset_ownership() -> Result<(), String> {
    *process_accepted_reset_ownership()
        .lock()
        .map_err(|_| "RESET_OWNERSHIP_UNAVAILABLE".to_string())? = None;
    Ok(())
}

pub(crate) fn acquire_reset_orchestration() -> Result<MutexGuard<'static, ()>, String> {
    reset_orchestration_mutex()
        .lock()
        .map_err(|_| "RESET_ORCHESTRATION_UNAVAILABLE".to_string())
}

fn reset_ownership_path() -> PathBuf {
    reset_status_root().join(RESET_OWNERSHIP_FILE)
}

fn reset_manifest_path_for_operation(operation_id: &str) -> PathBuf {
    reset_status_root().join(format!("manifest-{operation_id}.json"))
}

fn reset_claim_path(operation_id: &str) -> PathBuf {
    reset_status_root().join(format!("claim-{operation_id}.lock"))
}

fn is_canonical_operation_id(operation_id: &str) -> bool {
    uuid::Uuid::parse_str(operation_id)
        .map(|parsed| parsed.hyphenated().to_string() == operation_id)
        .unwrap_or(false)
}

pub(crate) fn is_generated_reset_manifest_path(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(operation_id) = file_name
        .strip_prefix("manifest-")
        .and_then(|name| name.strip_suffix(".json"))
    else {
        return false;
    };
    is_canonical_operation_id(operation_id)
        && path == reset_manifest_path_for_operation(operation_id)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn write_reset_ownership_unlocked(record: &ResetOwnershipRecord) -> Result<(), String> {
    ensure_status_root()?;
    let encoded = serde_json::to_vec_pretty(record)
        .map_err(|error| format!("serialize reset ownership: {error}"))?;
    fs::write(reset_ownership_path(), encoded)
        .map_err(|error| format!("write reset ownership: {error}"))
}

fn read_reset_ownership_bytes() -> Result<Option<Vec<u8>>, String> {
    let path = reset_ownership_path();
    if !path.exists() {
        return Ok(None);
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("read reset ownership: {error}"))
}

fn decode_reset_ownership(encoded: &[u8]) -> Result<ResetOwnershipRecord, String> {
    let record = serde_json::from_slice::<ResetOwnershipRecord>(encoded)
        .map_err(|error| format!("parse reset ownership: {error}"))?;
    if record.version != RESET_OWNERSHIP_VERSION
        || !is_canonical_operation_id(&record.operation_id)
        || record
            .response
            .get("operationId")
            .and_then(serde_json::Value::as_str)
            != Some(record.operation_id.as_str())
        || record
            .response
            .get("mode")
            .and_then(serde_json::Value::as_str)
            != Some(record.mode.as_str())
        || record.manifest_sha256.len() != 64
        || !record
            .manifest_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("RESET_OWNERSHIP_CORRUPT".to_string());
    }
    Ok(record)
}

fn read_reset_ownership() -> Result<Option<ResetOwnershipRecord>, String> {
    read_reset_ownership_bytes()?
        .map(|encoded| decode_reset_ownership(&encoded))
        .transpose()
}

fn clear_reset_ownership_unlocked() -> Result<(), String> {
    let operation_id = read_reset_ownership()
        .ok()
        .flatten()
        .map(|record| record.operation_id);
    clear_process_accepted_reset_ownership()?;
    let path = reset_ownership_path();
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("clear reset ownership: {error}"))?;
    }
    if let Some(operation_id) = operation_id {
        let claim_path = reset_claim_path(&operation_id);
        if claim_path.exists() {
            fs::remove_file(claim_path)
                .map_err(|error| format!("clear reset helper claim: {error}"))?;
        }
    }
    Ok(())
}

fn clear_reset_ownership_with_dependencies<A, G, C>(
    acquire_transition: A,
    clear_unlocked: C,
) -> Result<(), String>
where
    A: FnOnce() -> Result<G, ResetOwnershipTransitionAcquireError>,
    C: FnOnce() -> Result<(), String>,
{
    with_reset_ownership_transition_dependency(acquire_transition, clear_unlocked)
}

fn clear_reset_ownership() -> Result<(), String> {
    clear_reset_ownership_with_dependencies(
        acquire_reset_ownership_transition,
        clear_reset_ownership_unlocked,
    )
}

fn clear_reset_ownership_for_operation_unlocked(operation_id: &str) -> Result<(), String> {
    if read_reset_ownership()?
        .as_ref()
        .is_some_and(|record| record.operation_id == operation_id)
    {
        clear_reset_ownership_unlocked()?;
    }
    Ok(())
}

fn clear_reset_ownership_for_operation(operation_id: &str) -> Result<(), String> {
    with_reset_ownership_transition(|| clear_reset_ownership_for_operation_unlocked(operation_id))
}

fn acknowledge_completed_reset_ownership_with_dependencies<A, G, R, C>(
    operation_id: &str,
    acquire_transition: A,
    read_ownership: R,
    clear_unlocked: C,
) -> Result<(), String>
where
    A: FnOnce() -> Result<G, ResetOwnershipTransitionAcquireError>,
    R: FnOnce() -> Result<Option<ResetOwnershipRecord>, String>,
    C: FnOnce() -> Result<(), String>,
{
    with_reset_ownership_transition_dependency(acquire_transition, || {
        let Some(record) = read_ownership()? else {
            return Err("RESET_OWNERSHIP_MISSING".to_string());
        };
        if record.operation_id != operation_id || record.state != ResetOwnershipState::Accepted {
            return Err("RESET_OWNERSHIP_CHANGED".to_string());
        }
        clear_unlocked()
    })
}

fn acknowledge_completed_reset_ownership(operation_id: &str) -> Result<(), String> {
    acknowledge_completed_reset_ownership_with_dependencies(
        operation_id,
        acquire_reset_ownership_transition,
        read_reset_ownership,
        clear_reset_ownership_unlocked,
    )
}

fn record_reset_launching_unlocked(
    binding: &ResetManifestBinding,
    response: &serde_json::Value,
) -> Result<(), String> {
    write_reset_ownership_unlocked(&ResetOwnershipRecord {
        version: RESET_OWNERSHIP_VERSION,
        operation_id: binding.operation_id.clone(),
        mode: binding.mode,
        state: ResetOwnershipState::Launching,
        response: response.clone(),
        post_spawn_warning: None,
        manifest_path: binding.manifest_path.clone(),
        manifest_sha256: binding.manifest_sha256.clone(),
        app_executable: binding.app_executable.clone(),
        app_data_dir: binding.app_data_dir.clone(),
        local_state_dir: binding.local_state_dir.clone(),
        status_path: binding.status_path.clone(),
        credential_keys: binding.credential_keys.clone(),
        wipe_paths: binding.wipe_paths.clone(),
    })
}

fn record_reset_launching_with_dependencies<A, G, W>(
    binding: &ResetManifestBinding,
    response: &serde_json::Value,
    acquire_transition: A,
    write_launching: W,
) -> Result<(), String>
where
    A: FnOnce() -> Result<G, ResetOwnershipTransitionAcquireError>,
    W: FnOnce(&ResetManifestBinding, &serde_json::Value) -> Result<(), String>,
{
    with_reset_ownership_transition_dependency(acquire_transition, || {
        write_launching(binding, response)
    })
}

fn record_reset_launching(
    binding: &ResetManifestBinding,
    response: &serde_json::Value,
) -> Result<(), String> {
    record_reset_launching_with_dependencies(
        binding,
        response,
        acquire_reset_ownership_transition,
        record_reset_launching_unlocked,
    )
}

fn publish_claimed_helper_accepted_unlocked(record: &ResetOwnershipRecord) -> Result<(), String> {
    if record.state != ResetOwnershipState::Launching {
        return Err("RESET_HELPER_REPLAYED".to_string());
    }
    let mut accepted = record.clone();
    accepted.state = ResetOwnershipState::Accepted;
    accepted.post_spawn_warning = None;
    write_reset_ownership_unlocked(&accepted)
}

pub(crate) fn existing_accepted_reset_ownership() -> Result<Option<ResetLaunchOutcome>, String> {
    if let Some(accepted) = process_accepted_reset_ownership()
        .lock()
        .map_err(|_| "RESET_OWNERSHIP_UNAVAILABLE".to_string())?
        .clone()
    {
        return Ok(Some(accepted));
    }
    let Some(record) = read_reset_ownership()? else {
        return Ok(None);
    };
    match record.state {
        ResetOwnershipState::Launching => Err("RESET_LAUNCH_INDETERMINATE".to_string()),
        ResetOwnershipState::Accepted => Ok(Some(ResetLaunchOutcome::Accepted {
            operation_id: record.operation_id,
            response: record.response,
            post_spawn_warning: record.post_spawn_warning,
        })),
    }
}

fn normal_startup_reset_gate_with<O, S, C, W>(
    read_ownership: O,
    mut read_status: S,
    clear_completed_ownership: C,
    mut wait: W,
    attempts: u32,
) -> Result<(), String>
where
    O: FnOnce() -> Result<Option<ResetLaunchOutcome>, String>,
    S: FnMut() -> Result<Option<ResetStatus>, String>,
    C: FnOnce(&str) -> Result<(), String>,
    W: FnMut(),
{
    let Some(ownership) = read_ownership()? else {
        return Ok(());
    };
    let ResetLaunchOutcome::Accepted { operation_id, .. } = ownership else {
        return Err("RESET_OWNERSHIP_CORRUPT".to_string());
    };

    for attempt in 0..attempts.max(1) {
        if let Some(status) = read_status()? {
            let completed =
                status.phase == ResetPhase::Completed.as_str() && status.state == "completed";
            if completed && status.operation_id != operation_id {
                return Err("RESET_OWNERSHIP_CORRUPT".to_string());
            }
            if completed {
                return clear_completed_ownership(&operation_id);
            }
        }
        if attempt + 1 < attempts.max(1) {
            wait();
        }
    }

    Err("RESET_IN_PROGRESS".to_string())
}

/// A reset helper bypasses the POS runtime mutex, so it retains durable
/// Accepted ownership through relaunch. The replacement normal process calls
/// this while holding that mutex and is the only process allowed to acknowledge
/// the helper's Completed status. Until then, ordinary startup remains closed.
pub(crate) fn prepare_normal_startup_after_reset() -> Result<(), String> {
    normal_startup_reset_gate_with(
        existing_accepted_reset_ownership,
        get_reset_status,
        acknowledge_completed_reset_ownership,
        || thread::sleep(Duration::from_millis(NORMAL_RESET_GATE_POLL_MS)),
        NORMAL_RESET_GATE_ATTEMPTS,
    )
}

pub(crate) fn persist_reset_launch_outcome(outcome: &ResetLaunchOutcome) -> Result<(), String> {
    match outcome {
        ResetLaunchOutcome::Accepted { .. } => record_process_accepted_reset_ownership(outcome),
        ResetLaunchOutcome::NotStarted { .. } => clear_reset_ownership(),
    }
}

fn expose_post_spawn_warning(response: &mut serde_json::Value, warning: Option<&str>) {
    let Some(warning) = warning else {
        return;
    };
    if let Some(response) = response.as_object_mut() {
        response.insert(
            "postSpawnWarning".to_string(),
            serde_json::Value::String(warning.to_string()),
        );
    }
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

fn manifest_binding_for_bytes(
    manifest: &ResetManifest,
    encoded: &[u8],
) -> Result<ResetManifestBinding, String> {
    if !is_canonical_operation_id(&manifest.operation_id)
        || !is_generated_reset_manifest_path(&manifest.manifest_path)
        || manifest.manifest_path != reset_manifest_path_for_operation(&manifest.operation_id)
    {
        return Err("RESET_MANIFEST_LAYOUT_INVALID".to_string());
    }
    Ok(ResetManifestBinding {
        operation_id: manifest.operation_id.clone(),
        mode: manifest.mode,
        manifest_path: manifest.manifest_path.clone(),
        manifest_sha256: sha256_hex(encoded),
        app_executable: manifest.app_executable.clone(),
        app_data_dir: manifest.app_data_dir.clone(),
        local_state_dir: manifest.local_state_dir.clone(),
        status_path: manifest.status_path.clone(),
        credential_keys: manifest.credential_keys.clone(),
        wipe_paths: manifest.wipe_paths.clone(),
    })
}

fn write_manifest_with_binding(manifest: &ResetManifest) -> Result<ResetManifestBinding, String> {
    ensure_status_root()?;
    let encoded = serde_json::to_vec_pretty(manifest)
        .map_err(|e| format!("serialize reset manifest: {e}"))?;
    let binding = manifest_binding_for_bytes(manifest, &encoded)?;
    fs::write(&manifest.manifest_path, encoded)
        .map_err(|e| format!("write reset manifest: {e}"))?;
    Ok(binding)
}

fn build_manifest_for_paths(
    mode: ResetMode,
    paths: TrustedResetPaths,
) -> Result<ResetManifest, String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let status_path = reset_status_path();
    let manifest_path = reset_manifest_path_for_operation(&operation_id);
    let wipe_paths = collect_wipe_paths(&paths.app_data_dir, paths.local_state_dir.as_deref());

    Ok(ResetManifest {
        operation_id,
        mode,
        app_executable: paths.app_executable,
        app_data_dir: paths.app_data_dir,
        local_state_dir: paths.local_state_dir,
        status_path,
        manifest_path,
        credential_keys: crate::storage::managed_keys()
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        wipe_paths,
    })
}

fn build_manifest(app: &AppHandle, mode: ResetMode) -> Result<ResetManifest, String> {
    build_manifest_for_paths(
        mode,
        TrustedResetPaths {
            app_executable: std::env::current_exe()
                .map_err(|e| format!("resolve current executable: {e}"))?,
            app_data_dir: app
                .path()
                .app_data_dir()
                .map_err(|e| format!("resolve app data dir: {e}"))?,
            local_state_dir: crate::diagnostics::get_log_dir()
                .parent()
                .map(|path| path.to_path_buf()),
        },
    )
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

fn clear_reset_status_file_unlocked() -> Result<(), String> {
    let path = reset_status_path();
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("clear reset status: {e}"))?;
    }
    Ok(())
}

fn clear_reset_status_with_dependencies<A, G, S, C>(
    acquire_transition: A,
    clear_status_file: S,
    clear_ownership_unlocked: C,
) -> Result<(), String>
where
    A: FnOnce() -> Result<G, ResetOwnershipTransitionAcquireError>,
    S: FnOnce() -> Result<(), String>,
    C: FnOnce() -> Result<(), String>,
{
    with_reset_ownership_transition_dependency(acquire_transition, || {
        clear_ownership_unlocked()?;
        clear_status_file()
    })
}

pub fn clear_reset_status() -> Result<(), String> {
    clear_reset_status_with_dependencies(
        acquire_reset_ownership_transition,
        clear_reset_status_file_unlocked,
        clear_reset_ownership_unlocked,
    )
}

pub fn launch_reset(
    app: &AppHandle,
    mode: ResetMode,
    cancel_token: &tokio_util::sync::CancellationToken,
    device_manager: &crate::ecr::DeviceManager,
) -> ResetLaunchOutcome {
    launch_reset_engine(
        build_manifest(app, mode),
        |manifest| {
            let _ = app.emit(
                "reset_started",
                json!({
                    "operationId": manifest.operation_id,
                    "mode": manifest.mode.as_str(),
                    "updatedAt": Utc::now().to_rfc3339(),
                }),
            );
            emit_progress(app, manifest, ResetPhase::Preparing);
        },
        |manifest, error| emit_failed(app, manifest, "prepare_shutdown_failed", error),
        |manifest| {
            emit_progress(app, manifest, ResetPhase::WaitingForShutdown);

            cancel_token.cancel();

            info!("Reset launch: starting best-effort device shutdown");
            device_manager.shutdown();

            let app_to_exit = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(APP_EXIT_DELAY_MS)).await;
                app_to_exit.exit(0);
            });
        },
    )
}

pub(crate) fn launch_native_reset(mode: ResetMode, paths: TrustedResetPaths) -> ResetLaunchOutcome {
    launch_reset_engine(
        build_manifest_for_paths(mode, paths),
        |_| {},
        |_, _| {},
        |_| {},
    )
}

fn launch_reset_engine<P, F, H>(
    manifest: Result<ResetManifest, String>,
    after_preparing: P,
    after_failure: F,
    continue_shutdown_handoff: H,
) -> ResetLaunchOutcome
where
    P: FnOnce(&ResetManifest),
    F: FnOnce(&ResetManifest, &str),
    H: FnOnce(&ResetManifest),
{
    let (manifest, outcome) = start_reset_with_dependencies(
        manifest,
        write_manifest_with_binding,
        |manifest| {
            write_status(&make_status(
                manifest,
                ResetPhase::Preparing,
                "running",
                None,
                None,
                None,
                None,
            ))
        },
        after_preparing,
        record_reset_launching,
        |manifest, response| {
            let mut command = Command::new(&manifest.app_executable);
            command.arg(HELPER_ARG).arg(&manifest.manifest_path);
            spawn_reset_helper_with_handoff(
                || command.spawn(),
                || {
                    let accepted = ResetLaunchOutcome::accepted(response.clone(), None);
                    record_process_accepted_reset_ownership(&accepted)
                },
                || {
                    write_status(&make_status(
                        manifest,
                        ResetPhase::WaitingForShutdown,
                        "running",
                        None,
                        None,
                        None,
                        None,
                    ))
                },
                || {
                    continue_shutdown_handoff(manifest);
                },
                response.clone(),
            )
        },
    );
    let Some(manifest) = manifest else {
        return outcome;
    };

    if let ResetLaunchOutcome::NotStarted { error } = &outcome {
        if let Err(clear_error) = clear_reset_ownership_for_operation(&manifest.operation_id) {
            warn!(
                error = %clear_error,
                operation_id = %manifest.operation_id,
                "Failed to clear retryable reset launch ownership"
            );
        }
        let _ = write_failed_status(
            &manifest,
            "prepare_shutdown_failed",
            error.clone(),
            None,
            None,
        );
        after_failure(&manifest, error);
    }

    if matches!(outcome, ResetLaunchOutcome::Accepted { .. }) {
        if let Err(error) = record_process_accepted_reset_ownership(&outcome) {
            warn!(
                error = %error,
                operation_id = %manifest.operation_id,
                "Reset helper spawned but process-local accepted ownership update failed"
            );
        }
        info!(
            operation_id = %manifest.operation_id,
            mode = %manifest.mode.as_str(),
            "Reset helper launched; scheduled application shutdown"
        );
    }

    outcome
}

fn start_reset_with_dependencies<WM, WS, P, O, S>(
    manifest: Result<ResetManifest, String>,
    write_manifest_dependency: WM,
    write_preparing_status: WS,
    after_preparing: P,
    record_launching_ownership: O,
    spawn_helper: S,
) -> (Option<ResetManifest>, ResetLaunchOutcome)
where
    WM: FnOnce(&ResetManifest) -> Result<ResetManifestBinding, String>,
    WS: FnOnce(&ResetManifest) -> Result<(), String>,
    P: FnOnce(&ResetManifest),
    O: FnOnce(&ResetManifestBinding, &serde_json::Value) -> Result<(), String>,
    S: FnOnce(&ResetManifest, serde_json::Value) -> ResetLaunchOutcome,
{
    let manifest = match manifest {
        Ok(manifest) => manifest,
        Err(error) => return (None, ResetLaunchOutcome::not_started(error)),
    };
    let binding = match write_manifest_dependency(&manifest) {
        Ok(binding) => binding,
        Err(error) => return (Some(manifest), ResetLaunchOutcome::not_started(error)),
    };
    if let Err(error) = write_preparing_status(&manifest) {
        return (Some(manifest), ResetLaunchOutcome::not_started(error));
    }
    after_preparing(&manifest);

    let response = json!({
        "success": true,
        "started": true,
        "operationId": manifest.operation_id,
        "mode": manifest.mode.as_str(),
    });
    if let Err(error) = record_launching_ownership(&binding, &response) {
        return (Some(manifest), ResetLaunchOutcome::not_started(error));
    }
    let outcome = spawn_helper(&manifest, response);
    (Some(manifest), outcome)
}

fn spawn_reset_helper_with_handoff<S, A, W, H>(
    spawn_helper: S,
    record_accepted_ownership: A,
    write_waiting_status: W,
    continue_shutdown_handoff: H,
    response: serde_json::Value,
) -> ResetLaunchOutcome
where
    S: FnOnce() -> std::io::Result<std::process::Child>,
    A: FnOnce() -> Result<(), String>,
    W: FnOnce() -> Result<(), String>,
    H: FnOnce(),
{
    let _helper = match spawn_helper() {
        Ok(helper) => helper,
        Err(error) => {
            return ResetLaunchOutcome::not_started(format!(
                "Failed to start reset helper: {error}"
            ));
        }
    };

    if let Err(error) = record_accepted_ownership() {
        warn!(
            error,
            "Reset helper spawned while accepted metadata update failed; durable launching claim remains authoritative"
        );
    }

    let post_spawn_warning = write_waiting_status().err();
    if let Some(error) = post_spawn_warning.as_deref() {
        warn!(
            error,
            "Reset helper accepted ownership but WaitingForShutdown status write failed; continuing shutdown handoff"
        );
    }
    continue_shutdown_handoff();

    ResetLaunchOutcome::accepted(response, post_spawn_warning)
}

fn validate_reset_helper_parent_binding(
    manifest_path: &Path,
    manifest_bytes: &[u8],
    manifest: &ResetManifest,
    ownership: &ResetOwnershipRecord,
) -> Result<(), String> {
    if ownership.state != ResetOwnershipState::Launching {
        return Err("RESET_HELPER_REPLAYED".to_string());
    }
    if !is_canonical_operation_id(&manifest.operation_id)
        || !is_generated_reset_manifest_path(manifest_path)
        || manifest.manifest_path != manifest_path
        || manifest.manifest_path != reset_manifest_path_for_operation(&manifest.operation_id)
    {
        return Err("RESET_HELPER_MANIFEST_LAYOUT_INVALID".to_string());
    }
    if ownership.operation_id != manifest.operation_id || ownership.mode != manifest.mode {
        return Err("RESET_HELPER_OWNERSHIP_MISMATCH".to_string());
    }
    if ownership.manifest_path != manifest_path
        || ownership.manifest_sha256 != sha256_hex(manifest_bytes)
    {
        return Err("RESET_HELPER_MANIFEST_BINDING_MISMATCH".to_string());
    }
    if manifest.status_path != reset_status_path()
        || ownership.status_path != manifest.status_path
        || !manifest.status_path.is_absolute()
    {
        return Err("RESET_HELPER_STATUS_PATH_INVALID".to_string());
    }
    if !manifest.app_executable.is_absolute() || ownership.app_executable != manifest.app_executable
    {
        return Err("RESET_HELPER_EXECUTABLE_INVALID".to_string());
    }
    if !manifest.app_data_dir.is_absolute()
        || ownership.app_data_dir != manifest.app_data_dir
        || ownership.local_state_dir != manifest.local_state_dir
        || manifest
            .local_state_dir
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
    {
        return Err("RESET_HELPER_APP_PATH_BINDING_INVALID".to_string());
    }

    let managed_keys = crate::storage::managed_keys()
        .iter()
        .map(|key| (*key).to_string())
        .collect::<Vec<_>>();
    if manifest.credential_keys != managed_keys
        || ownership.credential_keys != manifest.credential_keys
    {
        return Err("RESET_HELPER_CREDENTIAL_KEYS_INVALID".to_string());
    }

    if ownership.wipe_paths != manifest.wipe_paths {
        return Err("RESET_HELPER_WIPE_PATH_BINDING_INVALID".to_string());
    }
    let recovery_root = crate::recovery::recovery_root_for_app_data(&manifest.app_data_dir);
    let mut unique_wipe_paths = BTreeSet::new();
    for path in &manifest.wipe_paths {
        let is_local_state = manifest.local_state_dir.as_ref() == Some(path);
        let is_direct_app_data_child = path.parent() == Some(manifest.app_data_dir.as_path());
        if !path.is_absolute()
            || path == &recovery_root
            || (!is_local_state && !is_direct_app_data_child)
            || !unique_wipe_paths.insert(path.clone())
        {
            return Err("RESET_HELPER_WIPE_PATHS_INVALID".to_string());
        }
    }

    Ok(())
}

fn validate_bound_reset_helper(
    manifest_path: &Path,
    manifest_bytes: &[u8],
    manifest: &ResetManifest,
    ownership: &ResetOwnershipRecord,
    trusted_paths: &TrustedResetPaths,
) -> Result<(), String> {
    validate_reset_helper_parent_binding(manifest_path, manifest_bytes, manifest, ownership)?;
    if !trusted_paths.app_executable.is_absolute()
        || manifest.app_executable != trusted_paths.app_executable
        || !trusted_paths.app_data_dir.is_absolute()
        || manifest.app_data_dir != trusted_paths.app_data_dir
        || manifest.local_state_dir != trusted_paths.local_state_dir
        || trusted_paths
            .local_state_dir
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
    {
        return Err("RESET_HELPER_APP_PATH_BINDING_INVALID".to_string());
    }
    Ok(())
}

fn compiled_app_identifier_from_build_config() -> Result<String, String> {
    let config = serde_json::from_str::<serde_json::Value>(include_str!("../tauri.conf.json"))
        .map_err(|_| "COMPILED_APP_CONFIG_INVALID".to_string())?;
    config
        .get("identifier")
        .and_then(serde_json::Value::as_str)
        .filter(|identifier| !identifier.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "COMPILED_APP_IDENTIFIER_INVALID".to_string())
}

fn resolve_trusted_reset_paths_for_helper() -> Result<TrustedResetPaths, String> {
    let roots = crate::startup_recovery::resolve_windows_known_folder_roots()?;
    let identifier = compiled_app_identifier_from_build_config()?;
    let paths = crate::startup_recovery::trusted_app_paths_from_roots(&roots, &identifier)?;
    Ok(TrustedResetPaths {
        app_executable: std::env::current_exe()
            .map_err(|_| "RESET_HELPER_CURRENT_EXECUTABLE_FAILED".to_string())?,
        app_data_dir: paths.app_data_dir,
        local_state_dir: Some(paths.local_state_dir),
    })
}

fn claim_reset_operation_once(operation_id: &str, manifest_sha256: &str) -> Result<(), String> {
    if !is_canonical_operation_id(operation_id)
        || manifest_sha256.len() != 64
        || !manifest_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("RESET_HELPER_CLAIM_INVALID".to_string());
    }
    ensure_status_root()?;
    let mut claim = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(reset_claim_path(operation_id))
        .map_err(|_| "RESET_HELPER_ALREADY_CLAIMED".to_string())?;
    claim
        .write_all(manifest_sha256.as_bytes())
        .and_then(|_| claim.sync_all())
        .map_err(|_| "RESET_HELPER_CLAIM_WRITE_FAILED".to_string())
}

fn clear_matching_launching_ownership_unlocked_with_dependencies<R, D>(
    expected_ownership: &ResetOwnershipRecord,
    expected_bytes: &[u8],
    read_current: R,
    remove_current: D,
) -> Result<(), String>
where
    R: FnOnce() -> Result<Option<Vec<u8>>, String>,
    D: FnOnce() -> Result<(), String>,
{
    if expected_ownership.state != ResetOwnershipState::Launching {
        return Err("RESET_HELPER_CANCEL_STATE_INVALID".to_string());
    }
    let current_bytes = read_current()?
        .ok_or_else(|| "RESET_HELPER_OWNERSHIP_CHANGED_BEFORE_CANCEL".to_string())?;
    if current_bytes != expected_bytes {
        return Err("RESET_HELPER_OWNERSHIP_CHANGED_BEFORE_CANCEL".to_string());
    }
    let current = decode_reset_ownership(&current_bytes)?;
    if current.state != ResetOwnershipState::Launching
        || current.operation_id != expected_ownership.operation_id
        || current.manifest_path != expected_ownership.manifest_path
        || current.manifest_sha256 != expected_ownership.manifest_sha256
    {
        return Err("RESET_HELPER_OWNERSHIP_CHANGED_BEFORE_CANCEL".to_string());
    }
    remove_current()
}

fn clear_matching_launching_ownership_with_dependencies<A, G, R, D>(
    expected_ownership: &ResetOwnershipRecord,
    expected_bytes: &[u8],
    acquire_transition: A,
    read_current: R,
    remove_current: D,
) -> Result<(), String>
where
    A: FnOnce() -> Result<G, ResetOwnershipTransitionAcquireError>,
    R: FnOnce() -> Result<Option<Vec<u8>>, String>,
    D: FnOnce() -> Result<(), String>,
{
    with_reset_ownership_transition_dependency(acquire_transition, || {
        clear_matching_launching_ownership_unlocked_with_dependencies(
            expected_ownership,
            expected_bytes,
            read_current,
            remove_current,
        )
    })
}

fn authorize_reset_helper_with_native_gate_dependencies<RM, RO, T, F, A, G, D, C, P>(
    manifest_path: &Path,
    read_manifest: RM,
    mut read_ownership: RO,
    trusted_reset_paths: T,
    confirm_final_reset: F,
    mut acquire_transition: A,
    mut remove_ownership: D,
    claim_once: C,
    publish_accepted: P,
) -> Result<AuthorizedResetManifest, String>
where
    RM: FnOnce() -> Result<Vec<u8>, String>,
    RO: FnMut() -> Result<Option<Vec<u8>>, String>,
    T: FnOnce() -> Result<TrustedResetPaths, String>,
    F: FnOnce() -> Result<bool, String>,
    A: FnMut() -> Result<G, ResetOwnershipTransitionAcquireError>,
    D: FnMut() -> Result<(), String>,
    C: FnOnce(&str, &str) -> Result<(), String>,
    P: FnOnce(&ResetOwnershipRecord) -> Result<(), String>,
{
    let manifest_bytes = read_manifest()?;
    let manifest = serde_json::from_slice::<ResetManifest>(&manifest_bytes)
        .map_err(|_| "RESET_HELPER_MANIFEST_INVALID".to_string())?;
    let first_ownership_bytes =
        read_ownership()?.ok_or_else(|| "RESET_HELPER_OWNERSHIP_MISSING".to_string())?;
    let first_ownership = decode_reset_ownership(&first_ownership_bytes)?;
    validate_reset_helper_parent_binding(
        manifest_path,
        &manifest_bytes,
        &manifest,
        &first_ownership,
    )?;
    let trusted_paths = match trusted_reset_paths() {
        Ok(paths) => paths,
        Err(error) => {
            clear_matching_launching_ownership_with_dependencies(
                &first_ownership,
                &first_ownership_bytes,
                &mut acquire_transition,
                &mut read_ownership,
                &mut remove_ownership,
            )?;
            return Err(error);
        }
    };
    validate_bound_reset_helper(
        manifest_path,
        &manifest_bytes,
        &manifest,
        &first_ownership,
        &trusted_paths,
    )?;

    match confirm_final_reset() {
        Ok(true) => {}
        Ok(false) => {
            clear_matching_launching_ownership_with_dependencies(
                &first_ownership,
                &first_ownership_bytes,
                &mut acquire_transition,
                &mut read_ownership,
                &mut remove_ownership,
            )?;
            return Err("RESET_HELPER_CONFIRMATION_DENIED".to_string());
        }
        Err(_) => {
            clear_matching_launching_ownership_with_dependencies(
                &first_ownership,
                &first_ownership_bytes,
                &mut acquire_transition,
                &mut read_ownership,
                remove_ownership,
            )?;
            return Err("RESET_HELPER_CONFIRMATION_FAILED".to_string());
        }
    }

    let _transition_guard = acquire_transition().map_err(|error| error.as_code().to_string())?;
    let preclaim_ownership_bytes = read_ownership()?
        .ok_or_else(|| "RESET_HELPER_OWNERSHIP_MISSING_BEFORE_CLAIM".to_string())?;
    if preclaim_ownership_bytes != first_ownership_bytes {
        return Err("RESET_HELPER_OWNERSHIP_CHANGED_BEFORE_CLAIM".to_string());
    }
    let preclaim_ownership = decode_reset_ownership(&preclaim_ownership_bytes)?;
    validate_bound_reset_helper(
        manifest_path,
        &manifest_bytes,
        &manifest,
        &preclaim_ownership,
        &trusted_paths,
    )?;
    claim_once(&manifest.operation_id, &first_ownership.manifest_sha256)?;

    let claimed_ownership_bytes = read_ownership()?
        .ok_or_else(|| "RESET_HELPER_OWNERSHIP_MISSING_AFTER_CLAIM".to_string())?;
    if claimed_ownership_bytes != first_ownership_bytes {
        return Err("RESET_HELPER_OWNERSHIP_CHANGED_AFTER_CLAIM".to_string());
    }
    let claimed_ownership = decode_reset_ownership(&claimed_ownership_bytes)?;
    validate_bound_reset_helper(
        manifest_path,
        &manifest_bytes,
        &manifest,
        &claimed_ownership,
        &trusted_paths,
    )?;
    publish_accepted(&claimed_ownership)?;
    let credential_owner = Arc::new(ResetCredentialOwner {
        operation_id: manifest.operation_id.clone(),
        manifest_sha256: first_ownership.manifest_sha256.clone(),
        credential_keys: manifest.credential_keys.clone(),
        _private: (),
    });
    Ok(AuthorizedResetManifest {
        manifest,
        credential_owner,
    })
}

fn authorize_reset_helper(manifest_path: &Path) -> Result<AuthorizedResetManifest, String> {
    authorize_reset_helper_with_native_gate_dependencies(
        manifest_path,
        || fs::read(manifest_path).map_err(|_| "RESET_HELPER_MANIFEST_READ_FAILED".to_string()),
        read_reset_ownership_bytes,
        resolve_trusted_reset_paths_for_helper,
        crate::startup_recovery::show_native_reset_helper_confirmation,
        acquire_reset_ownership_transition,
        || {
            fs::remove_file(reset_ownership_path())
                .map_err(|_| "RESET_HELPER_CANCEL_CLEANUP_FAILED".to_string())
        },
        claim_reset_operation_once,
        publish_claimed_helper_accepted_unlocked,
    )
}

fn run_keyring_delete_with_timeout_dependency<D>(
    owner: Arc<ResetCredentialOwner>,
    key: String,
    timeout: Duration,
    delete_key: D,
) -> Result<(), String>
where
    D: FnOnce(Arc<ResetCredentialOwner>, String) -> Result<(), String> + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    let worker_key = key.clone();
    thread::spawn(move || {
        let result = delete_key(owner, worker_key);
        let _ = tx.send(result);
    });

    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("Timed out deleting credential key '{key}'"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(format!("Reset helper lost keyring worker for key '{key}'"))
        }
    }
}

fn run_keyring_delete_with_timeout(
    owner: Arc<ResetCredentialOwner>,
    key: String,
) -> Result<(), String> {
    run_keyring_delete_with_timeout_dependency(
        owner,
        key,
        Duration::from_millis(KEYRING_DELETE_TIMEOUT_MS),
        |owner, worker_key| {
            crate::storage::delete_managed_credential_for_reset(&owner, &worker_key)
        },
    )
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
            return Err(("keyring_delete_failed".to_string(), Some(key.clone()), None));
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

fn infer_pos_tauri_project_dir(app_executable: &Path) -> Option<PathBuf> {
    app_executable
        .ancestors()
        .find(|path| path.file_name().and_then(|name| name.to_str()) == Some("src-tauri"))
        .and_then(|src_tauri_dir| src_tauri_dir.parent().map(Path::to_path_buf))
}

fn can_connect_to_dev_server(port: u16) -> bool {
    let addresses = [
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ];

    addresses.iter().any(|address| {
        TcpStream::connect_timeout(address, Duration::from_millis(DEV_SERVER_POLL_MS)).is_ok()
    })
}

fn wait_for_dev_server(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() <= deadline {
        if can_connect_to_dev_server(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(DEV_SERVER_POLL_MS));
    }
    false
}

fn npm_executable() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn start_dev_frontend_server(project_dir: &Path) -> Result<(), String> {
    Command::new(npm_executable())
        .arg("run")
        .arg("dev")
        .current_dir(project_dir)
        .env("TAURI_ENV_DEBUG", "true")
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("start Vite dev server: {error}"))
}

fn spawn_app_executable(manifest: &ResetManifest) -> Result<(), String> {
    Command::new(&manifest.app_executable)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to relaunch app: {error}"))
}

fn relaunch_after_reset(manifest: &ResetManifest) -> Result<(), String> {
    if cfg!(debug_assertions) {
        let project_dir =
            infer_pos_tauri_project_dir(&manifest.app_executable).ok_or_else(|| {
                format!(
                    "Could not infer pos-tauri project dir from executable '{}'",
                    manifest.app_executable.display()
                )
            })?;

        thread::sleep(Duration::from_millis(DEV_RELAUNCH_SETTLE_MS));
        if !can_connect_to_dev_server(DEV_SERVER_PORT) {
            info!(
                project_dir = %project_dir.display(),
                port = DEV_SERVER_PORT,
                "Reset helper starting Vite dev server for debug relaunch"
            );
            start_dev_frontend_server(&project_dir)?;
        }

        if !wait_for_dev_server(
            DEV_SERVER_PORT,
            Duration::from_millis(DEV_SERVER_READY_TIMEOUT_MS),
        ) {
            return Err(format!(
                "Vite dev server did not become reachable at http://localhost:{DEV_SERVER_PORT}"
            ));
        }
    }

    spawn_app_executable(manifest)
}

fn run_reset_helper_with_dependencies<A, W, S, K, D, V, L, M>(
    manifest_path: &Path,
    authorize: A,
    mut write_status_dependency: W,
    mut sleep_dependency: S,
    mut delete_key: K,
    mut delete_path: D,
    mut verify: V,
    mut relaunch: L,
    mut remove_manifest: M,
) -> Result<(), String>
where
    A: FnOnce(&Path) -> Result<AuthorizedResetManifest, String>,
    W: FnMut(&ResetStatus) -> Result<(), String>,
    S: FnMut(Duration),
    K: FnMut(Arc<ResetCredentialOwner>, String) -> Result<(), String>,
    D: FnMut(&Path) -> Result<(), String>,
    V: FnMut(&ResetManifest) -> Result<(), (String, Option<String>, Option<String>)>,
    L: FnMut(&ResetManifest) -> Result<(), String>,
    M: FnMut(&Path) -> Result<(), String>,
{
    let authorized = authorize(manifest_path)?;
    let manifest = authorized.manifest;
    let credential_owner = authorized.credential_owner;

    write_status_dependency(&make_status(
        &manifest,
        ResetPhase::WaitingForShutdown,
        "running",
        None,
        None,
        None,
        None,
    ))?;
    sleep_dependency(Duration::from_millis(HELPER_STARTUP_GRACE_MS));

    for key in &manifest.credential_keys {
        write_status_dependency(&make_status(
            &manifest,
            ResetPhase::KeyringCleanup,
            "running",
            None,
            None,
            Some(key.clone()),
            None,
        ))?;
        info!(key = %key, "Reset helper deleting credential");
        if let Err(error) = delete_key(Arc::clone(&credential_owner), key.clone()) {
            let error_message = format!("Failed to delete credential '{key}': {error}");
            let _ = write_status_dependency(&make_status(
                &manifest,
                ResetPhase::Failed,
                "failed",
                Some("keyring_delete_failed"),
                Some(error_message.clone()),
                Some(key.clone()),
                None,
            ));
            return Err(error_message);
        }
    }

    for path in &manifest.wipe_paths {
        let failing_path = path.to_string_lossy().to_string();
        write_status_dependency(&make_status(
            &manifest,
            ResetPhase::FilesystemCleanup,
            "running",
            None,
            None,
            None,
            Some(failing_path.clone()),
        ))?;
        info!(path = %failing_path, "Reset helper deleting local path");
        if let Err(error) = delete_path(path) {
            let error_message = format!("Failed to delete '{failing_path}': {error}");
            let _ = write_status_dependency(&make_status(
                &manifest,
                ResetPhase::Failed,
                "failed",
                Some("filesystem_delete_failed"),
                Some(error_message.clone()),
                None,
                Some(failing_path),
            ));
            return Err(error_message);
        }
    }

    write_status_dependency(&make_status(
        &manifest,
        ResetPhase::Verifying,
        "running",
        None,
        None,
        None,
        None,
    ))?;

    if let Err((error_code, failing_key, failing_path)) = verify(&manifest) {
        let error_message = match (&failing_key, &failing_path) {
            (Some(key), _) => format!("Credential '{key}' is still present after reset"),
            (_, Some(path)) => format!("Path '{path}' still exists after reset"),
            _ => "Reset verification failed".to_string(),
        };
        let _ = write_status_dependency(&make_status(
            &manifest,
            ResetPhase::Failed,
            "failed",
            Some(&error_code),
            Some(error_message.clone()),
            failing_key,
            failing_path,
        ));
        return Err(error_message);
    }

    write_status_dependency(&make_status(
        &manifest,
        ResetPhase::Relaunching,
        "running",
        None,
        None,
        None,
        None,
    ))?;

    if let Err(error) = relaunch(&manifest) {
        let _ = write_status_dependency(&make_status(
            &manifest,
            ResetPhase::Failed,
            "failed",
            Some("relaunch_failed"),
            Some(error.clone()),
            None,
            None,
        ));
        return Err(error);
    }

    write_status_dependency(&make_status(
        &manifest,
        ResetPhase::Completed,
        "completed",
        None,
        None,
        None,
        None,
    ))?;

    if let Err(error) = remove_manifest(manifest_path) {
        warn!(path = %manifest_path.display(), error = %error, "Failed to remove reset manifest");
    }

    Ok(())
}

pub fn run_reset_helper(manifest_path: &Path) -> Result<(), String> {
    run_reset_helper_with_dependencies(
        manifest_path,
        authorize_reset_helper,
        write_status,
        thread::sleep,
        run_keyring_delete_with_timeout,
        remove_path_with_retries,
        verify_reset,
        relaunch_after_reset,
        |path| fs::remove_file(path).map_err(|error| error.to_string()),
    )
}

/// Execute the reset-helper process branch. A helper failure is terminal: the
/// supplied process terminator cannot return, so callers cannot accidentally
/// continue into normal startup while a timed-out keyring worker still exists.
// Matching on `Infallible` is the MSRV-compatible way to encode divergence.
#[allow(unreachable_code)]
pub(crate) fn run_reset_helper_process_with<H, X>(
    manifest_path: &Path,
    run_helper: H,
    terminate_process: X,
) where
    H: FnOnce(&Path) -> Result<(), String>,
    X: FnOnce(i32, String) -> std::convert::Infallible,
{
    if let Err(error) = run_helper(manifest_path) {
        match terminate_process(1, error) {}
    }
}

#[cfg(test)]
pub(crate) fn factory_reset_with_authorized_owner_for_test() -> Result<serde_json::Value, String> {
    let owner = Arc::new(ResetCredentialOwner {
        operation_id: "123e4567-e89b-42d3-a456-426614174000".to_string(),
        manifest_sha256: "a".repeat(64),
        credential_keys: crate::storage::managed_keys()
            .iter()
            .map(|key| (*key).to_string())
            .collect(),
        _private: (),
    });
    for key in crate::storage::managed_keys() {
        crate::storage::delete_managed_credential_for_reset(&owner, key)?;
    }
    Ok(serde_json::json!({ "success": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::cell::{Cell, RefCell};
    use std::process::Stdio;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Barrier, Condvar};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Debug, Default, Clone, PartialEq, Eq)]
    struct HelperEffectCounts {
        statuses: usize,
        keyring_deletes: usize,
        filesystem_deletes: usize,
        verifications: usize,
        relaunches: usize,
        manifest_removals: usize,
    }

    #[derive(Clone, Default)]
    struct TestTransitionLock {
        state: Arc<(Mutex<bool>, Condvar)>,
    }

    struct TestTransitionGuard {
        state: Arc<(Mutex<bool>, Condvar)>,
    }

    impl TestTransitionLock {
        fn acquire(&self) -> Result<TestTransitionGuard, ResetOwnershipTransitionAcquireError> {
            let (locked, available) = &*self.state;
            let mut held = locked
                .lock()
                .map_err(|_| ResetOwnershipTransitionAcquireError::WaitFailed)?;
            while *held {
                held = available
                    .wait(held)
                    .map_err(|_| ResetOwnershipTransitionAcquireError::WaitFailed)?;
            }
            *held = true;
            drop(held);
            Ok(TestTransitionGuard {
                state: self.state.clone(),
            })
        }
    }

    impl Drop for TestTransitionGuard {
        fn drop(&mut self) {
            let (locked, available) = &*self.state;
            let mut held = locked.lock().unwrap();
            *held = false;
            available.notify_one();
        }
    }

    fn trusted_helper_reset_paths() -> TrustedResetPaths {
        let identifier = "com.thesmall.pos";
        TrustedResetPaths {
            app_executable: std::env::current_exe().expect("current test executable"),
            app_data_dir: std::env::temp_dir()
                .join("the-small-pos-helper-trusted-roaming")
                .join(identifier),
            local_state_dir: Some(
                std::env::temp_dir()
                    .join("the-small-pos-helper-trusted-local")
                    .join(identifier),
            ),
        }
    }

    fn helper_test_manifest(operation_id: &str) -> ResetManifest {
        let root = std::env::temp_dir().join("the-small-pos-reset");
        let trusted_paths = trusted_helper_reset_paths();
        let app_data_dir = trusted_paths.app_data_dir;
        let local_state_dir = trusted_paths.local_state_dir.unwrap();
        ResetManifest {
            operation_id: operation_id.to_string(),
            mode: ResetMode::EmergencyReset,
            app_executable: trusted_paths.app_executable,
            app_data_dir: app_data_dir.clone(),
            local_state_dir: Some(local_state_dir.clone()),
            status_path: root.join("status.json"),
            manifest_path: root.join(format!("manifest-{operation_id}.json")),
            credential_keys: crate::storage::managed_keys()
                .iter()
                .map(|key| (*key).to_string())
                .collect(),
            wipe_paths: vec![app_data_dir.join("pos.db"), local_state_dir],
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn bound_ownership_value(
        trusted_manifest: &ResetManifest,
        manifest_bytes: &[u8],
    ) -> serde_json::Value {
        json!({
            "version": 2,
            "operationId": trusted_manifest.operation_id,
            "mode": trusted_manifest.mode,
            "state": "launching",
            "response": {
                "success": true,
                "started": true,
                "operationId": trusted_manifest.operation_id,
                "mode": trusted_manifest.mode.as_str(),
            },
            "postSpawnWarning": null,
            "manifestPath": trusted_manifest.manifest_path,
            "manifestSha256": sha256_hex(manifest_bytes),
            "appExecutable": trusted_manifest.app_executable,
            "appDataDir": trusted_manifest.app_data_dir,
            "localStateDir": trusted_manifest.local_state_dir,
            "statusPath": trusted_manifest.status_path,
            "credentialKeys": trusted_manifest.credential_keys,
            "wipePaths": trusted_manifest.wipe_paths,
        })
    }

    fn run_helper_probe(
        manifest_path: PathBuf,
        manifest_bytes: Vec<u8>,
        ownership: Result<Option<Vec<u8>>, String>,
        trusted_paths: TrustedResetPaths,
        claim_error: Option<&str>,
        publish_error: Option<&str>,
    ) -> (Result<(), String>, HelperEffectCounts, usize, usize) {
        let effects = Rc::new(RefCell::new(HelperEffectCounts::default()));
        let claim_calls = Rc::new(Cell::new(0_usize));
        let publish_calls = Rc::new(Cell::new(0_usize));

        let result = run_reset_helper_with_dependencies(
            &manifest_path,
            |path| {
                authorize_reset_helper_with_native_gate_dependencies(
                    path,
                    || Ok(manifest_bytes),
                    || ownership.clone(),
                    || Ok(trusted_paths),
                    || Ok(true),
                    || Ok(()),
                    || Ok(()),
                    |_, _| {
                        claim_calls.set(claim_calls.get() + 1);
                        claim_error.map_or(Ok(()), |error| Err(error.to_string()))
                    },
                    |_| {
                        publish_calls.set(publish_calls.get() + 1);
                        publish_error.map_or(Ok(()), |error| Err(error.to_string()))
                    },
                )
            },
            {
                let effects = effects.clone();
                move |_| {
                    effects.borrow_mut().statuses += 1;
                    Ok(())
                }
            },
            |_| {},
            {
                let effects = effects.clone();
                move |_, _| {
                    effects.borrow_mut().keyring_deletes += 1;
                    Ok(())
                }
            },
            {
                let effects = effects.clone();
                move |_| {
                    effects.borrow_mut().filesystem_deletes += 1;
                    Ok(())
                }
            },
            {
                let effects = effects.clone();
                move |_| {
                    effects.borrow_mut().verifications += 1;
                    Ok(())
                }
            },
            {
                let effects = effects.clone();
                move |_| {
                    effects.borrow_mut().relaunches += 1;
                    Ok(())
                }
            },
            {
                let effects = effects.clone();
                move |_| {
                    effects.borrow_mut().manifest_removals += 1;
                    Ok(())
                }
            },
        );

        let effect_snapshot = effects.borrow().clone();
        (
            result,
            effect_snapshot,
            claim_calls.get(),
            publish_calls.get(),
        )
    }

    fn run_native_gated_helper_probe(
        manifest: ResetManifest,
        confirmation: Result<bool, String>,
    ) -> (
        Result<(), String>,
        HelperEffectCounts,
        usize,
        usize,
        usize,
        usize,
    ) {
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let ownership_bytes =
            serde_json::to_vec_pretty(&bound_ownership_value(&manifest, &manifest_bytes)).unwrap();
        let trusted_paths = trusted_helper_reset_paths();
        let effects = Rc::new(RefCell::new(HelperEffectCounts::default()));
        let prompt_calls = Rc::new(Cell::new(0_usize));
        let cleanup_calls = Rc::new(Cell::new(0_usize));
        let claim_calls = Rc::new(Cell::new(0_usize));
        let publish_calls = Rc::new(Cell::new(0_usize));

        let result = run_reset_helper_with_dependencies(
            &manifest.manifest_path,
            |path| {
                authorize_reset_helper_with_native_gate_dependencies(
                    path,
                    || Ok(manifest_bytes),
                    || Ok(Some(ownership_bytes.clone())),
                    || Ok(trusted_paths),
                    || {
                        prompt_calls.set(prompt_calls.get() + 1);
                        confirmation
                    },
                    || Ok(()),
                    || {
                        cleanup_calls.set(cleanup_calls.get() + 1);
                        Ok(())
                    },
                    |_, _| {
                        claim_calls.set(claim_calls.get() + 1);
                        Ok(())
                    },
                    |_| {
                        publish_calls.set(publish_calls.get() + 1);
                        Ok(())
                    },
                )
            },
            {
                let effects = effects.clone();
                move |_| {
                    effects.borrow_mut().statuses += 1;
                    Ok(())
                }
            },
            |_| {},
            {
                let effects = effects.clone();
                move |_, _| {
                    effects.borrow_mut().keyring_deletes += 1;
                    Ok(())
                }
            },
            {
                let effects = effects.clone();
                move |_| {
                    effects.borrow_mut().filesystem_deletes += 1;
                    Ok(())
                }
            },
            {
                let effects = effects.clone();
                move |_| {
                    effects.borrow_mut().verifications += 1;
                    Ok(())
                }
            },
            {
                let effects = effects.clone();
                move |_| {
                    effects.borrow_mut().relaunches += 1;
                    Ok(())
                }
            },
            {
                let effects = effects.clone();
                move |_| {
                    effects.borrow_mut().manifest_removals += 1;
                    Ok(())
                }
            },
        );

        let effect_snapshot = effects.borrow().clone();
        (
            result,
            effect_snapshot,
            prompt_calls.get(),
            cleanup_calls.get(),
            claim_calls.get(),
            publish_calls.get(),
        )
    }

    fn assert_helper_rejected_without_effects(
        result: Result<(), String>,
        effects: HelperEffectCounts,
    ) {
        assert!(result.is_err(), "untrusted helper input must fail closed");
        assert_eq!(effects, HelperEffectCounts::default());
    }

    #[test]
    fn helper_rejects_missing_corrupt_mismatched_and_replayed_ownership_before_effects() {
        let manifest = helper_test_manifest("12121212-1212-4212-8212-121212121212");
        let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let trusted_ownership = bound_ownership_value(&manifest, &bytes);

        let mut wrong_operation = trusted_ownership.clone();
        wrong_operation["operationId"] = json!("13131313-1313-4313-8313-131313131313");
        wrong_operation["response"]["operationId"] = json!("13131313-1313-4313-8313-131313131313");

        let mut wrong_mode = trusted_ownership.clone();
        wrong_mode["mode"] = json!("factory_reset");
        wrong_mode["response"]["mode"] = json!("factory_reset");

        let mut replayed = trusted_ownership.clone();
        replayed["state"] = json!("accepted");

        let cases = [
            ("missing", Ok(None)),
            ("corrupt", Ok(Some(b"{not-json".to_vec()))),
            (
                "wrong-operation",
                Ok(Some(serde_json::to_vec_pretty(&wrong_operation).unwrap())),
            ),
            (
                "wrong-mode",
                Ok(Some(serde_json::to_vec_pretty(&wrong_mode).unwrap())),
            ),
            (
                "accepted-replay",
                Ok(Some(serde_json::to_vec_pretty(&replayed).unwrap())),
            ),
        ];

        for (case, ownership) in cases {
            let (result, effects, claim_calls, publish_calls) = run_helper_probe(
                manifest.manifest_path.clone(),
                bytes.clone(),
                ownership,
                trusted_helper_reset_paths(),
                None,
                None,
            );
            assert_helper_rejected_without_effects(result, effects);
            assert_eq!(claim_calls, 0, "{case} must fail before claiming");
            assert_eq!(publish_calls, 0, "{case} must not publish Accepted");
        }
    }

    #[test]
    fn helper_rejects_manifest_path_digest_and_destructive_value_tamper_before_effects() {
        let trusted = helper_test_manifest("14141414-1414-4414-8414-141414141414");
        let trusted_bytes = serde_json::to_vec_pretty(&trusted).unwrap();
        let trusted_ownership = bound_ownership_value(&trusted, &trusted_bytes);

        let mut cases = Vec::new();
        cases.push((
            "cli-path",
            std::env::temp_dir().join("untrusted-manifest.json"),
            trusted_bytes.clone(),
            trusted_ownership.clone(),
            trusted.app_executable.clone(),
        ));

        let mut byte_tamper = trusted_bytes.clone();
        byte_tamper.extend_from_slice(b" ");
        cases.push((
            "digest",
            trusted.manifest_path.clone(),
            byte_tamper,
            trusted_ownership.clone(),
            trusted.app_executable.clone(),
        ));

        let mut tampered_manifests = Vec::new();
        let mut manifest_path = trusted.clone();
        manifest_path.manifest_path = std::env::temp_dir().join("other-manifest.json");
        tampered_manifests.push(("manifest-path", manifest_path));
        let mut status_path = trusted.clone();
        status_path.status_path = std::env::temp_dir().join("other-status.json");
        tampered_manifests.push(("status-path", status_path));
        let mut executable = trusted.clone();
        executable.app_executable = std::env::temp_dir().join("attacker.exe");
        tampered_manifests.push(("executable", executable));
        let mut keys = trusted.clone();
        keys.credential_keys = vec!["terminal_id".to_string()];
        tampered_manifests.push(("managed-key-set", keys));
        let mut wipe_paths = trusted.clone();
        wipe_paths.wipe_paths = vec![std::env::temp_dir().join("unrelated-customer-data")];
        tampered_manifests.push(("wipe-path-set", wipe_paths));

        for (case, tampered) in tampered_manifests {
            let tampered_bytes = serde_json::to_vec_pretty(&tampered).unwrap();
            let mut ownership = bound_ownership_value(&trusted, &tampered_bytes);
            ownership["manifestSha256"] = json!(sha256_hex(&tampered_bytes));
            cases.push((
                case,
                trusted.manifest_path.clone(),
                tampered_bytes,
                ownership,
                trusted.app_executable.clone(),
            ));
        }

        let mut current_executable_record = trusted.clone();
        current_executable_record.app_executable = std::env::temp_dir().join("attacker.exe");
        let current_executable_bytes =
            serde_json::to_vec_pretty(&current_executable_record).unwrap();
        cases.push((
            "current-executable",
            trusted.manifest_path.clone(),
            current_executable_bytes.clone(),
            bound_ownership_value(&current_executable_record, &current_executable_bytes),
            trusted.app_executable.clone(),
        ));

        for (case, path, bytes, ownership, current_executable) in cases {
            let mut trusted_paths = trusted_helper_reset_paths();
            trusted_paths.app_executable = current_executable;
            let (result, effects, claim_calls, publish_calls) = run_helper_probe(
                path,
                bytes,
                Ok(Some(serde_json::to_vec_pretty(&ownership).unwrap())),
                trusted_paths,
                None,
                None,
            );
            assert_helper_rejected_without_effects(result, effects);
            assert_eq!(claim_calls, 0, "{case} must fail before claiming");
            assert_eq!(publish_calls, 0, "{case} must not publish Accepted");
        }
    }

    #[test]
    fn self_consistent_forged_local_state_root_is_rejected_before_claim_or_effects() {
        let mut manifest = helper_test_manifest("31313131-3131-4131-8131-313131313131");
        let forged_local_state = std::env::temp_dir().join("forged-customer-local-state");
        manifest.local_state_dir = Some(forged_local_state.clone());
        manifest.wipe_paths = vec![manifest.app_data_dir.join("pos.db"), forged_local_state];

        let (result, effects, prompt_calls, cleanup_calls, claim_calls, publish_calls) =
            run_native_gated_helper_probe(manifest, Ok(true));

        assert_helper_rejected_without_effects(result, effects);
        assert_eq!(prompt_calls, 0);
        assert_eq!(cleanup_calls, 0);
        assert_eq!(claim_calls, 0);
        assert_eq!(publish_calls, 0);
    }

    #[test]
    fn self_consistent_forged_app_data_root_and_child_are_rejected_before_claim_or_effects() {
        let mut manifest = helper_test_manifest("32323232-3232-4232-8232-323232323232");
        let forged_app_data = std::env::temp_dir().join("forged-customer-app-data");
        manifest.app_data_dir = forged_app_data.clone();
        manifest.wipe_paths = vec![
            forged_app_data.join("arbitrary-child"),
            manifest.local_state_dir.clone().unwrap(),
        ];

        let (result, effects, prompt_calls, cleanup_calls, claim_calls, publish_calls) =
            run_native_gated_helper_probe(manifest, Ok(true));

        assert_helper_rejected_without_effects(result, effects);
        assert_eq!(prompt_calls, 0);
        assert_eq!(cleanup_calls, 0);
        assert_eq!(claim_calls, 0);
        assert_eq!(publish_calls, 0);
    }

    #[test]
    fn trusted_forged_pair_no_close_other_or_dialog_failure_cleans_launching_before_claim() {
        let confirmations = [
            ("no", Ok(false)),
            ("close-or-default-other", Ok(false)),
            (
                "dialog-api-failure",
                Err("NATIVE_CONFIRMATION_FAILED".to_string()),
            ),
        ];

        for (index, (case, confirmation)) in confirmations.into_iter().enumerate() {
            let operation_id = format!("33333333-3333-4333-8333-33333333333{index}");
            let manifest = helper_test_manifest(&operation_id);
            let (result, effects, prompt_calls, cleanup_calls, claim_calls, publish_calls) =
                run_native_gated_helper_probe(manifest, confirmation);

            assert_helper_rejected_without_effects(result, effects);
            assert_eq!(prompt_calls, 1, "{case} must execute the final prompt");
            assert_eq!(
                cleanup_calls, 1,
                "{case} must clear only its Launching state"
            );
            assert_eq!(claim_calls, 0, "{case} must not claim");
            assert_eq!(publish_calls, 0, "{case} must not publish Accepted");
        }
    }

    #[test]
    fn unsupported_trusted_root_resolution_cleans_exact_launching_without_effects() {
        let manifest = helper_test_manifest("37373737-3737-4737-8737-373737373737");
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let ownership_bytes =
            serde_json::to_vec_pretty(&bound_ownership_value(&manifest, &manifest_bytes)).unwrap();
        let ownership_reads = Cell::new(0_usize);
        let prompt_calls = Cell::new(0_usize);
        let cleanup_calls = Cell::new(0_usize);
        let claim_calls = Cell::new(0_usize);
        let publish_calls = Cell::new(0_usize);

        let result = authorize_reset_helper_with_native_gate_dependencies(
            &manifest.manifest_path,
            || Ok(manifest_bytes),
            || {
                ownership_reads.set(ownership_reads.get() + 1);
                Ok(Some(ownership_bytes.clone()))
            },
            || Err("EMERGENCY_RECOVERY_UNSUPPORTED_PLATFORM".to_string()),
            || {
                prompt_calls.set(prompt_calls.get() + 1);
                Ok(true)
            },
            || Ok(()),
            || {
                cleanup_calls.set(cleanup_calls.get() + 1);
                Ok(())
            },
            |_, _| {
                claim_calls.set(claim_calls.get() + 1);
                Ok(())
            },
            |_| {
                publish_calls.set(publish_calls.get() + 1);
                Ok(())
            },
        );

        assert_eq!(
            result.unwrap_err(),
            "EMERGENCY_RECOVERY_UNSUPPORTED_PLATFORM"
        );
        assert_eq!(
            ownership_reads.get(),
            2,
            "initial binding plus transition-locked cleanup must each read ownership"
        );
        assert_eq!(prompt_calls.get(), 0);
        assert_eq!(cleanup_calls.get(), 1);
        assert_eq!(claim_calls.get(), 0);
        assert_eq!(publish_calls.get(), 0);
    }

    #[test]
    fn transition_wait_results_are_typed_and_abandoned_ownership_is_acquired() {
        assert_eq!(
            classify_reset_ownership_transition_wait(0x0000_0000),
            Ok(ResetOwnershipTransitionAcquisition::Acquired)
        );
        assert_eq!(
            classify_reset_ownership_transition_wait(0x0000_0080),
            Ok(ResetOwnershipTransitionAcquisition::Abandoned)
        );
        assert_eq!(
            classify_reset_ownership_transition_wait(0x0000_0102),
            Err(ResetOwnershipTransitionAcquireError::Timeout)
        );
        assert_eq!(
            classify_reset_ownership_transition_wait(0xffff_ffff),
            Err(ResetOwnershipTransitionAcquireError::WaitFailed)
        );
        assert_eq!(
            classify_reset_ownership_transition_wait(0x0000_0001),
            Err(ResetOwnershipTransitionAcquireError::WaitFailed)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_transition_mutex_waits_across_threads_and_times_out_closed() {
        let identifier = format!(
            "com.thesmall.pos.test.{}",
            uuid::Uuid::new_v4().hyphenated()
        );
        let guard = acquire_reset_ownership_transition_for_identifier(&identifier, 1_000)
            .expect("first waiter owns the named transition mutex");
        let contender_identifier = identifier.clone();
        let contender = std::thread::spawn(move || {
            acquire_reset_ownership_transition_for_identifier(&contender_identifier, 25).map(|_| ())
        });

        assert_eq!(
            contender.join().expect("transition contender").unwrap_err(),
            ResetOwnershipTransitionAcquireError::Timeout
        );
        drop(guard);
        let reacquired = acquire_reset_ownership_transition_for_identifier(&identifier, 1_000)
            .expect("released named transition mutex is retryable");
        drop(reacquired);
    }

    #[test]
    fn transition_lock_timeout_and_failure_block_yes_before_claim_or_publication() {
        for error in [
            ResetOwnershipTransitionAcquireError::CreateFailed,
            ResetOwnershipTransitionAcquireError::Timeout,
            ResetOwnershipTransitionAcquireError::WaitFailed,
        ] {
            let manifest = helper_test_manifest("38383838-3838-4838-8838-383838383838");
            let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
            let ownership_bytes =
                serde_json::to_vec_pretty(&bound_ownership_value(&manifest, &manifest_bytes))
                    .unwrap();
            let prompt_calls = Cell::new(0_usize);
            let cleanup_calls = Cell::new(0_usize);
            let claim_calls = Cell::new(0_usize);
            let publish_calls = Cell::new(0_usize);

            let result = authorize_reset_helper_with_native_gate_dependencies(
                &manifest.manifest_path,
                || Ok(manifest_bytes),
                || Ok(Some(ownership_bytes.clone())),
                || Ok(trusted_helper_reset_paths()),
                || {
                    prompt_calls.set(prompt_calls.get() + 1);
                    Ok(true)
                },
                || Err::<(), _>(error),
                || {
                    cleanup_calls.set(cleanup_calls.get() + 1);
                    Ok(())
                },
                |_, _| {
                    claim_calls.set(claim_calls.get() + 1);
                    Ok(())
                },
                |_| {
                    publish_calls.set(publish_calls.get() + 1);
                    Ok(())
                },
            );

            assert_eq!(result.unwrap_err(), error.as_code());
            assert_eq!(prompt_calls.get(), 1);
            assert_eq!(cleanup_calls.get(), 0);
            assert_eq!(claim_calls.get(), 0);
            assert_eq!(publish_calls.get(), 0);
        }
    }

    #[test]
    fn parent_completed_and_explicit_clear_mutations_each_acquire_once() {
        let manifest = helper_test_manifest("40404040-4040-4040-8040-404040404040");
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let binding = manifest_binding_for_bytes(&manifest, &manifest_bytes).unwrap();
        let response = json!({
            "success": true,
            "started": true,
            "operationId": manifest.operation_id,
            "mode": manifest.mode.as_str(),
        });
        let acquisitions = Cell::new(0_usize);
        let mutations = Cell::new(0_usize);

        record_reset_launching_with_dependencies(
            &binding,
            &response,
            || {
                acquisitions.set(acquisitions.get() + 1);
                Ok(())
            },
            |_, _| {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
        )
        .expect("parent Launching publication is transition-locked");

        let mut accepted_value = bound_ownership_value(&manifest, &manifest_bytes);
        accepted_value["state"] = json!("accepted");
        let accepted = decode_reset_ownership(
            &serde_json::to_vec_pretty(&accepted_value).expect("accepted ownership bytes"),
        )
        .expect("accepted ownership record");
        acknowledge_completed_reset_ownership_with_dependencies(
            &manifest.operation_id,
            || {
                acquisitions.set(acquisitions.get() + 1);
                Ok(())
            },
            || Ok(Some(accepted)),
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
        )
        .expect("Completed acknowledgement is transition-locked");

        clear_reset_status_with_dependencies(
            || {
                acquisitions.set(acquisitions.get() + 1);
                Ok(())
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
        )
        .expect("status plus ownership clear uses one non-nested transition guard");

        clear_reset_ownership_with_dependencies(
            || {
                acquisitions.set(acquisitions.get() + 1);
                Ok(())
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
        )
        .expect("explicit ownership clear is transition-locked");

        assert_eq!(acquisitions.get(), 4);
        assert_eq!(mutations.get(), 5);
    }

    #[test]
    fn combined_cleanup_clears_authoritative_ownership_before_status() {
        let calls = RefCell::new(Vec::new());

        clear_reset_status_with_dependencies(
            || {
                calls.borrow_mut().push("lock");
                Ok(())
            },
            || {
                calls.borrow_mut().push("status");
                Ok(())
            },
            || {
                calls.borrow_mut().push("ownership");
                Ok(())
            },
        )
        .expect("combined cleanup succeeds");

        assert_eq!(
            calls.into_inner(),
            vec!["lock", "ownership", "status"],
            "authoritative ownership must clear before non-authoritative status"
        );
    }

    #[test]
    fn combined_cleanup_ownership_failure_leaves_status_untouched() {
        let calls = RefCell::new(Vec::new());

        let result = clear_reset_status_with_dependencies(
            || {
                calls.borrow_mut().push("lock");
                Ok(())
            },
            || {
                calls.borrow_mut().push("status");
                Ok(())
            },
            || {
                calls.borrow_mut().push("ownership");
                Err("ownership clear failed".to_string())
            },
        );

        assert_eq!(result.unwrap_err(), "ownership clear failed");
        assert_eq!(
            calls.into_inner(),
            vec!["lock", "ownership"],
            "status must remain when authoritative ownership cannot clear"
        );
    }

    #[test]
    fn combined_cleanup_status_failure_follows_ownership_and_propagates() {
        let calls = RefCell::new(Vec::new());

        let result = clear_reset_status_with_dependencies(
            || {
                calls.borrow_mut().push("lock");
                Ok(())
            },
            || {
                calls.borrow_mut().push("status");
                Err("status clear failed".to_string())
            },
            || {
                calls.borrow_mut().push("ownership");
                Ok(())
            },
        );

        assert_eq!(result.unwrap_err(), "status clear failed");
        assert_eq!(
            calls.into_inner(),
            vec!["lock", "ownership", "status"],
            "status errors propagate only after ownership has cleared"
        );
    }

    #[test]
    fn parent_completed_and_clear_lock_failures_never_mutate_ownership() {
        let manifest = helper_test_manifest("41414141-4141-4141-8141-414141414141");
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let binding = manifest_binding_for_bytes(&manifest, &manifest_bytes).unwrap();
        let response = json!({
            "success": true,
            "started": true,
            "operationId": manifest.operation_id,
            "mode": manifest.mode.as_str(),
        });
        let reads = Cell::new(0_usize);
        let mutations = Cell::new(0_usize);

        let parent = record_reset_launching_with_dependencies(
            &binding,
            &response,
            || Err::<(), _>(ResetOwnershipTransitionAcquireError::Timeout),
            |_, _| {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
        );
        assert_eq!(
            parent.unwrap_err(),
            ResetOwnershipTransitionAcquireError::Timeout.as_code()
        );

        let completed = acknowledge_completed_reset_ownership_with_dependencies(
            &manifest.operation_id,
            || Err::<(), _>(ResetOwnershipTransitionAcquireError::WaitFailed),
            || {
                reads.set(reads.get() + 1);
                Ok(None)
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
        );
        assert_eq!(
            completed.unwrap_err(),
            ResetOwnershipTransitionAcquireError::WaitFailed.as_code()
        );

        let status_clear = clear_reset_status_with_dependencies(
            || Err::<(), _>(ResetOwnershipTransitionAcquireError::CreateFailed),
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
        );
        assert_eq!(
            status_clear.unwrap_err(),
            ResetOwnershipTransitionAcquireError::CreateFailed.as_code()
        );

        let explicit_clear = clear_reset_ownership_with_dependencies(
            || Err::<(), _>(ResetOwnershipTransitionAcquireError::Timeout),
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
        );
        assert_eq!(
            explicit_clear.unwrap_err(),
            ResetOwnershipTransitionAcquireError::Timeout.as_code()
        );

        assert_eq!(reads.get(), 0);
        assert_eq!(mutations.get(), 0);
    }

    #[test]
    fn trusted_roots_and_exact_yes_run_one_confirmed_helper() {
        let manifest = helper_test_manifest("34343434-3434-4434-8434-343434343434");
        let expected_key_count = manifest.credential_keys.len();
        let expected_path_count = manifest.wipe_paths.len();
        let (result, effects, prompt_calls, cleanup_calls, claim_calls, publish_calls) =
            run_native_gated_helper_probe(manifest, Ok(true));

        assert_eq!(result, Ok(()));
        assert_eq!(prompt_calls, 1);
        assert_eq!(cleanup_calls, 0);
        assert_eq!(claim_calls, 1);
        assert_eq!(publish_calls, 1);
        assert_eq!(
            effects.statuses,
            expected_key_count + expected_path_count + 4
        );
        assert_eq!(effects.keyring_deletes, expected_key_count);
        assert_eq!(effects.filesystem_deletes, expected_path_count);
        assert_eq!(effects.verifications, 1);
        assert_eq!(effects.relaunches, 1);
        assert_eq!(effects.manifest_removals, 1);
    }

    #[test]
    fn denied_cleanup_refuses_to_remove_changed_or_non_launching_ownership() {
        let manifest = helper_test_manifest("35353535-3535-4535-8535-353535353535");
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let expected_bytes =
            serde_json::to_vec_pretty(&bound_ownership_value(&manifest, &manifest_bytes)).unwrap();
        let expected_record = decode_reset_ownership(&expected_bytes).unwrap();
        let removals = Cell::new(0_usize);

        clear_matching_launching_ownership_with_dependencies(
            &expected_record,
            &expected_bytes,
            || Ok(()),
            || Ok(Some(expected_bytes.clone())),
            || {
                removals.set(removals.get() + 1);
                Ok(())
            },
        )
        .expect("exact Launching ownership is retryable cleanup");
        assert_eq!(removals.get(), 1);

        let mut changed_value = bound_ownership_value(&manifest, &manifest_bytes);
        changed_value["state"] = json!("accepted");
        let changed_bytes = serde_json::to_vec_pretty(&changed_value).unwrap();
        let result = clear_matching_launching_ownership_with_dependencies(
            &expected_record,
            &expected_bytes,
            || Ok(()),
            || Ok(Some(changed_bytes)),
            || {
                removals.set(removals.get() + 1);
                Ok(())
            },
        );
        assert_eq!(
            result.unwrap_err(),
            "RESET_HELPER_OWNERSHIP_CHANGED_BEFORE_CANCEL"
        );
        assert_eq!(removals.get(), 1);
    }

    #[test]
    fn denial_cleanup_cannot_remove_accepted_published_after_its_comparison() {
        let manifest = helper_test_manifest("36363636-3636-4636-8636-363636363636");
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let launching_bytes =
            serde_json::to_vec_pretty(&bound_ownership_value(&manifest, &manifest_bytes)).unwrap();
        let launching_record = decode_reset_ownership(&launching_bytes).unwrap();
        let mut accepted_value = bound_ownership_value(&manifest, &manifest_bytes);
        accepted_value["state"] = json!("accepted");
        let accepted_bytes = serde_json::to_vec_pretty(&accepted_value).unwrap();

        let ownership = Arc::new(Mutex::new(Some(launching_bytes.clone())));
        let transition = TestTransitionLock::default();
        let comparison_complete = Arc::new(Barrier::new(2));
        let allow_cleanup = Arc::new(Barrier::new(2));
        let cleanup = {
            let ownership = ownership.clone();
            let transition = transition.clone();
            let comparison_complete = comparison_complete.clone();
            let allow_cleanup = allow_cleanup.clone();
            std::thread::spawn(move || {
                clear_matching_launching_ownership_with_dependencies(
                    &launching_record,
                    &launching_bytes,
                    || transition.acquire(),
                    || {
                        let current = ownership.lock().unwrap().clone();
                        comparison_complete.wait();
                        allow_cleanup.wait();
                        Ok(current)
                    },
                    || {
                        *ownership.lock().unwrap() = None;
                        Ok(())
                    },
                )
            })
        };

        comparison_complete.wait();
        let writer_started = Arc::new(Barrier::new(2));
        let writer = {
            let ownership = ownership.clone();
            let transition = transition.clone();
            let writer_started = writer_started.clone();
            let accepted_bytes = accepted_bytes.clone();
            std::thread::spawn(move || {
                writer_started.wait();
                with_reset_ownership_transition_dependency(
                    || transition.acquire(),
                    || {
                        *ownership.lock().unwrap() = Some(accepted_bytes);
                        Ok(())
                    },
                )
            })
        };
        writer_started.wait();
        allow_cleanup.wait();
        cleanup
            .join()
            .expect("denial cleanup worker")
            .expect("denial cleanup succeeds first");
        writer
            .join()
            .expect("Accepted writer")
            .expect("Accepted writer proceeds after cleanup releases the transition");

        assert_eq!(
            ownership.lock().unwrap().as_ref(),
            Some(&accepted_bytes),
            "denial must never erase Accepted published after its comparison"
        );
    }

    #[test]
    fn concurrent_denial_cannot_erase_yes_transition_or_share_its_success() {
        let manifest = helper_test_manifest("39393939-3939-4939-8939-393939393939");
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let launching_bytes =
            serde_json::to_vec_pretty(&bound_ownership_value(&manifest, &manifest_bytes)).unwrap();
        let mut accepted_value = bound_ownership_value(&manifest, &manifest_bytes);
        accepted_value["state"] = json!("accepted");
        let accepted_bytes = serde_json::to_vec_pretty(&accepted_value).unwrap();
        let ownership = Arc::new(Mutex::new(Some(launching_bytes)));
        let transition = TestTransitionLock::default();
        let prompts_complete = Arc::new(Barrier::new(2));
        let yes_has_guard = Arc::new(Barrier::new(2));
        let claim_calls = Arc::new(AtomicUsize::new(0));
        let publish_calls = Arc::new(AtomicUsize::new(0));
        let removal_calls = Arc::new(AtomicUsize::new(0));

        let yes = {
            let manifest = manifest.clone();
            let manifest_bytes = manifest_bytes.clone();
            let ownership = ownership.clone();
            let transition = transition.clone();
            let prompts_complete = prompts_complete.clone();
            let yes_has_guard = yes_has_guard.clone();
            let claim_calls = claim_calls.clone();
            let publish_calls = publish_calls.clone();
            let removal_calls = removal_calls.clone();
            let accepted_bytes = accepted_bytes.clone();
            std::thread::spawn(move || {
                authorize_reset_helper_with_native_gate_dependencies(
                    &manifest.manifest_path,
                    || Ok(manifest_bytes),
                    || Ok(ownership.lock().unwrap().clone()),
                    || Ok(trusted_helper_reset_paths()),
                    || {
                        prompts_complete.wait();
                        Ok(true)
                    },
                    || {
                        let guard = transition.acquire()?;
                        yes_has_guard.wait();
                        Ok(guard)
                    },
                    || {
                        removal_calls.fetch_add(1, Ordering::SeqCst);
                        *ownership.lock().unwrap() = None;
                        Ok(())
                    },
                    |_, _| {
                        claim_calls.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                    |_| {
                        publish_calls.fetch_add(1, Ordering::SeqCst);
                        *ownership.lock().unwrap() = Some(accepted_bytes);
                        Ok(())
                    },
                )
            })
        };
        let denied = {
            let manifest = manifest.clone();
            let manifest_bytes = manifest_bytes.clone();
            let ownership = ownership.clone();
            let transition = transition.clone();
            let prompts_complete = prompts_complete.clone();
            let yes_has_guard = yes_has_guard.clone();
            let claim_calls = claim_calls.clone();
            let publish_calls = publish_calls.clone();
            let removal_calls = removal_calls.clone();
            std::thread::spawn(move || {
                authorize_reset_helper_with_native_gate_dependencies(
                    &manifest.manifest_path,
                    || Ok(manifest_bytes),
                    || Ok(ownership.lock().unwrap().clone()),
                    || Ok(trusted_helper_reset_paths()),
                    || {
                        prompts_complete.wait();
                        Ok(false)
                    },
                    || {
                        yes_has_guard.wait();
                        transition.acquire()
                    },
                    || {
                        removal_calls.fetch_add(1, Ordering::SeqCst);
                        *ownership.lock().unwrap() = None;
                        Ok(())
                    },
                    |_, _| {
                        claim_calls.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                    |_| {
                        publish_calls.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                )
            })
        };

        assert!(yes.join().expect("Yes helper").is_ok());
        assert_eq!(
            denied.join().expect("denied helper").unwrap_err(),
            "RESET_HELPER_OWNERSHIP_CHANGED_BEFORE_CANCEL"
        );
        assert_eq!(claim_calls.load(Ordering::SeqCst), 1);
        assert_eq!(publish_calls.load(Ordering::SeqCst), 1);
        assert_eq!(removal_calls.load(Ordering::SeqCst), 0);
        assert_eq!(ownership.lock().unwrap().as_ref(), Some(&accepted_bytes));
    }

    #[test]
    fn compiled_helper_identifier_is_derived_from_embedded_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let configured_identifier = config["identifier"].as_str().unwrap();

        assert_eq!(configured_identifier, "com.thesmall.pos");
        assert_eq!(
            compiled_app_identifier_from_build_config().unwrap(),
            configured_identifier
        );
    }

    #[test]
    fn claimed_helper_publish_failure_has_zero_destructive_or_relaunch_effects() {
        let manifest = helper_test_manifest("15151515-1515-4515-8515-151515151515");
        let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let ownership =
            serde_json::to_vec_pretty(&bound_ownership_value(&manifest, &bytes)).unwrap();

        let (result, effects, claim_calls, publish_calls) = run_helper_probe(
            manifest.manifest_path.clone(),
            bytes,
            Ok(Some(ownership)),
            trusted_helper_reset_paths(),
            None,
            Some("injected accepted publication failure"),
        );

        assert_helper_rejected_without_effects(result, effects);
        assert_eq!(claim_calls, 1);
        assert_eq!(publish_calls, 1);
    }

    #[test]
    fn matching_parent_bound_helper_claims_publishes_and_runs_exact_effects() {
        let manifest = helper_test_manifest("16161616-1616-4616-8616-161616161616");
        let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let ownership =
            serde_json::to_vec_pretty(&bound_ownership_value(&manifest, &bytes)).unwrap();

        let (result, effects, claim_calls, publish_calls) = run_helper_probe(
            manifest.manifest_path.clone(),
            bytes,
            Ok(Some(ownership)),
            trusted_helper_reset_paths(),
            None,
            None,
        );

        assert_eq!(result, Ok(()));
        assert_eq!(claim_calls, 1);
        assert_eq!(publish_calls, 1);
        assert_eq!(
            effects.statuses,
            manifest.credential_keys.len() + manifest.wipe_paths.len() + 4
        );
        assert_eq!(effects.keyring_deletes, manifest.credential_keys.len());
        assert_eq!(effects.filesystem_deletes, manifest.wipe_paths.len());
        assert_eq!(effects.verifications, 1);
        assert_eq!(effects.relaunches, 1);
        assert_eq!(effects.manifest_removals, 1);
    }

    #[test]
    fn concurrent_helpers_have_exactly_one_atomic_claim_winner() {
        let operation_id = format!("{}", uuid::Uuid::new_v4().hyphenated());
        let manifest = helper_test_manifest(&operation_id);
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let ownership_bytes =
            serde_json::to_vec_pretty(&bound_ownership_value(&manifest, &manifest_bytes)).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let prompt_calls = Arc::new(AtomicUsize::new(0));
        let publish_calls = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let barrier = barrier.clone();
            let manifest_bytes = manifest_bytes.clone();
            let ownership_bytes = ownership_bytes.clone();
            let manifest_path = manifest.manifest_path.clone();
            let trusted_paths = trusted_helper_reset_paths();
            let prompt_calls = prompt_calls.clone();
            let publish_calls = publish_calls.clone();
            workers.push(std::thread::spawn(move || {
                let effects = Arc::new(Mutex::new(HelperEffectCounts::default()));
                let result = run_reset_helper_with_dependencies(
                    &manifest_path,
                    |path| {
                        authorize_reset_helper_with_native_gate_dependencies(
                            path,
                            || Ok(manifest_bytes),
                            || Ok(Some(ownership_bytes.clone())),
                            || Ok(trusted_paths),
                            || {
                                prompt_calls.fetch_add(1, Ordering::SeqCst);
                                Ok(true)
                            },
                            || Ok(()),
                            || Ok(()),
                            |operation_id, manifest_sha256| {
                                barrier.wait();
                                claim_reset_operation_once(operation_id, manifest_sha256)
                            },
                            |_| {
                                publish_calls.fetch_add(1, Ordering::SeqCst);
                                Ok(())
                            },
                        )
                    },
                    {
                        let effects = effects.clone();
                        move |_| {
                            effects.lock().unwrap().statuses += 1;
                            Ok(())
                        }
                    },
                    |_| {},
                    {
                        let effects = effects.clone();
                        move |_, _| {
                            effects.lock().unwrap().keyring_deletes += 1;
                            Ok(())
                        }
                    },
                    {
                        let effects = effects.clone();
                        move |_| {
                            effects.lock().unwrap().filesystem_deletes += 1;
                            Ok(())
                        }
                    },
                    {
                        let effects = effects.clone();
                        move |_| {
                            effects.lock().unwrap().verifications += 1;
                            Ok(())
                        }
                    },
                    {
                        let effects = effects.clone();
                        move |_| {
                            effects.lock().unwrap().relaunches += 1;
                            Ok(())
                        }
                    },
                    {
                        let effects = effects.clone();
                        move |_| {
                            effects.lock().unwrap().manifest_removals += 1;
                            Ok(())
                        }
                    },
                );
                let effect_snapshot = effects.lock().unwrap().clone();
                (result, effect_snapshot)
            }));
        }
        let results = workers
            .into_iter()
            .map(|worker| worker.join().expect("claim worker"))
            .collect::<Vec<_>>();

        assert_eq!(
            results.iter().filter(|(result, _)| result.is_ok()).count(),
            1
        );
        assert_eq!(
            results.iter().filter(|(result, _)| result.is_err()).count(),
            1
        );
        assert_eq!(prompt_calls.load(Ordering::SeqCst), 2);
        assert_eq!(publish_calls.load(Ordering::SeqCst), 1);
        let (_, rejected_effects) = results
            .iter()
            .find(|(result, _)| result.is_err())
            .expect("one helper is rejected");
        assert_eq!(rejected_effects, &HelperEffectCounts::default());
        let (_, accepted_effects) = results
            .iter()
            .find(|(result, _)| result.is_ok())
            .expect("one helper is accepted");
        assert_eq!(
            accepted_effects.statuses,
            manifest.credential_keys.len() + manifest.wipe_paths.len() + 4
        );
        assert_eq!(
            accepted_effects.keyring_deletes,
            manifest.credential_keys.len()
        );
        assert_eq!(
            accepted_effects.filesystem_deletes,
            manifest.wipe_paths.len()
        );
        assert_eq!(accepted_effects.verifications, 1);
        assert_eq!(accepted_effects.relaunches, 1);
        assert_eq!(accepted_effects.manifest_removals, 1);
        let _ = fs::remove_file(reset_claim_path(&operation_id));
    }

    #[test]
    #[serial_test::serial]
    fn parent_launching_record_binds_exact_manifest_bytes_path_and_destructive_values() {
        clear_reset_status().expect("clear prior reset tracking");
        let manifest = helper_test_manifest("17171717-1717-4717-8717-171717171717");
        let response = json!({
            "success": true,
            "started": true,
            "operationId": manifest.operation_id,
            "mode": manifest.mode.as_str(),
        });

        let binding = write_manifest_with_binding(&manifest).expect("write bound manifest");
        record_reset_launching(&binding, &response).expect("record bound Launching ownership");
        let ownership = read_reset_ownership()
            .expect("read bound ownership")
            .expect("bound ownership exists");

        assert_eq!(ownership.state, ResetOwnershipState::Launching);
        assert_eq!(ownership.manifest_path, manifest.manifest_path);
        assert_eq!(ownership.manifest_sha256, binding.manifest_sha256);
        assert_eq!(ownership.app_executable, manifest.app_executable);
        assert_eq!(ownership.app_data_dir, manifest.app_data_dir);
        assert_eq!(ownership.local_state_dir, manifest.local_state_dir);
        assert_eq!(ownership.status_path, manifest.status_path);
        assert_eq!(ownership.credential_keys, manifest.credential_keys);
        assert_eq!(ownership.wipe_paths, manifest.wipe_paths);

        let _ = fs::remove_file(&manifest.manifest_path);
        clear_reset_status().expect("clear bound ownership");
    }

    #[test]
    #[serial_test::serial]
    fn stale_launching_ownership_is_indeterminate_and_never_reported_accepted() {
        clear_reset_status().expect("clear prior reset tracking");
        let operation_id = "77777777-7777-4777-8777-777777777777";
        let mut manifest = helper_test_manifest(operation_id);
        manifest.mode = ResetMode::FactoryReset;
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let binding = manifest_binding_for_bytes(&manifest, &manifest_bytes).unwrap();
        let response = serde_json::json!({
            "success": true,
            "started": true,
            "operationId": operation_id,
            "mode": "factory_reset"
        });
        record_reset_launching(&binding, &response).expect("persist pre-spawn launching claim");

        let error = existing_accepted_reset_ownership()
            .expect_err("stale pre-spawn claim must not become accepted ownership");

        assert_eq!(error, "RESET_LAUNCH_INDETERMINATE");
        clear_reset_status().expect("clear stale launching claim");
    }

    #[test]
    #[serial_test::serial]
    fn helper_start_promotes_matching_launching_claim_to_durable_accepted() {
        clear_reset_status().expect("clear prior reset tracking");
        let operation_id = "76767676-7676-4676-8676-767676767676";
        let mut manifest = helper_test_manifest(operation_id);
        manifest.mode = ResetMode::FactoryReset;
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let binding = manifest_binding_for_bytes(&manifest, &manifest_bytes).unwrap();
        let response = serde_json::json!({
            "success": true,
            "started": true,
            "operationId": operation_id,
            "mode": "factory_reset"
        });
        record_reset_launching(&binding, &response).expect("persist pre-spawn launching claim");
        let ownership_bytes = fs::read(reset_ownership_path()).unwrap();
        authorize_reset_helper_with_native_gate_dependencies(
            &manifest.manifest_path,
            || Ok(manifest_bytes),
            || Ok(Some(ownership_bytes.clone())),
            || Ok(trusted_helper_reset_paths()),
            || Ok(true),
            acquire_reset_ownership_transition,
            || Ok(()),
            |_, _| Ok(()),
            publish_claimed_helper_accepted_unlocked,
        )
        .expect("helper claims and promotes durable ownership");
        let accepted = existing_accepted_reset_ownership()
            .expect("read promoted ownership")
            .expect("accepted ownership exists")
            .into_command_result()
            .expect("promoted ownership is accepted");

        assert_eq!(accepted, response);
        write_status(&make_status(
            &manifest,
            ResetPhase::Completed,
            "completed",
            None,
            None,
            None,
            None,
        ))
        .expect("persist completed helper handoff");
        prepare_normal_startup_after_reset()
            .expect("replacement normal process acknowledges exact ownership");
        assert!(existing_accepted_reset_ownership()
            .expect("read acknowledged ownership")
            .is_none());
        clear_reset_status().expect("clear completed reset status");
    }

    #[test]
    fn injected_manifest_status_ownership_and_spawn_failures_never_accept_or_handoff() {
        for (failing_stage, operation_id) in [
            ("manifest", "18181818-1818-4818-8818-181818181818"),
            ("status", "19191919-1919-4919-8919-191919191919"),
            ("ownership", "20202020-2020-4020-8020-202020202020"),
            ("spawn", "21212121-2121-4121-8121-212121212121"),
        ] {
            let manifest_calls = Cell::new(0_u32);
            let status_calls = Cell::new(0_u32);
            let ownership_calls = Cell::new(0_u32);
            let spawn_calls = Cell::new(0_u32);
            let preparing_calls = Cell::new(0_u32);
            let manifest = helper_test_manifest(operation_id);
            let manifest_for_write = manifest.clone();

            let (_manifest, outcome) = start_reset_with_dependencies(
                Ok(manifest),
                |_| {
                    manifest_calls.set(manifest_calls.get() + 1);
                    if failing_stage == "manifest" {
                        Err("injected manifest failure".to_string())
                    } else {
                        let encoded = serde_json::to_vec_pretty(&manifest_for_write).unwrap();
                        manifest_binding_for_bytes(&manifest_for_write, &encoded)
                    }
                },
                |_| {
                    status_calls.set(status_calls.get() + 1);
                    if failing_stage == "status" {
                        Err("injected status failure".to_string())
                    } else {
                        Ok(())
                    }
                },
                |_| preparing_calls.set(preparing_calls.get() + 1),
                |_, _| {
                    ownership_calls.set(ownership_calls.get() + 1);
                    if failing_stage == "ownership" {
                        Err("injected ownership failure".to_string())
                    } else {
                        Ok(())
                    }
                },
                |_, response| {
                    spawn_calls.set(spawn_calls.get() + 1);
                    assert_eq!(failing_stage, "spawn");
                    ResetLaunchOutcome::not_started(format!(
                        "injected spawn failure for {}",
                        response["operationId"]
                    ))
                },
            );

            assert!(matches!(outcome, ResetLaunchOutcome::NotStarted { .. }));
            assert_eq!(manifest_calls.get(), 1);
            assert_eq!(status_calls.get(), u32::from(failing_stage != "manifest"));
            assert_eq!(
                preparing_calls.get(),
                u32::from(!matches!(failing_stage, "manifest" | "status"))
            );
            assert_eq!(
                ownership_calls.get(),
                u32::from(!matches!(failing_stage, "manifest" | "status"))
            );
            assert_eq!(spawn_calls.get(), u32::from(failing_stage == "spawn"));
        }
    }

    #[test]
    fn post_spawn_status_failure_returns_one_accepted_ownership_and_continues_handoff() {
        let spawn_count = Cell::new(0_u32);
        let handoff_count = Cell::new(0_u32);
        let mut command = Command::new(std::env::current_exe().expect("current test executable"));
        command
            .arg("--exact")
            .arg("reset-helper-spawn-probe-does-not-exist")
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let ownership = spawn_reset_helper_with_handoff(
            || {
                spawn_count.set(spawn_count.get() + 1);
                command.spawn()
            },
            || Ok(()),
            || Err("injected waiting-for-shutdown status failure".to_string()),
            || handoff_count.set(handoff_count.get() + 1),
            serde_json::json!({
                "success": true,
                "started": true,
                "operationId": "88888888-8888-4888-8888-888888888888",
                "mode": "factory_reset"
            }),
        );

        assert_eq!(spawn_count.get(), 1);
        assert_eq!(handoff_count.get(), 1);
        assert_eq!(
            ownership,
            ResetLaunchOutcome::Accepted {
                operation_id: "88888888-8888-4888-8888-888888888888".to_string(),
                response: serde_json::json!({
                    "success": true,
                    "started": true,
                    "operationId": "88888888-8888-4888-8888-888888888888",
                    "mode": "factory_reset",
                    "postSpawnWarning": "injected waiting-for-shutdown status failure"
                }),
                post_spawn_warning: Some(
                    "injected waiting-for-shutdown status failure".to_string()
                ),
            }
        );
    }

    #[test]
    fn replacement_normal_startup_clears_only_completed_accepted_ownership() {
        let operation_id = "98989898-9898-4898-8898-989898989898";
        let ownership = ResetLaunchOutcome::accepted(
            json!({
                "success": true,
                "started": true,
                "operationId": operation_id,
                "mode": ResetMode::EmergencyReset.as_str(),
            }),
            None,
        );
        let status_reads = Cell::new(0_u32);
        let waits = Cell::new(0_u32);
        let cleared = RefCell::new(Vec::new());

        normal_startup_reset_gate_with(
            || Ok(Some(ownership.clone())),
            || {
                status_reads.set(status_reads.get() + 1);
                Ok(Some(ResetStatus {
                    operation_id: operation_id.to_string(),
                    mode: ResetMode::EmergencyReset.as_str().to_string(),
                    phase: if status_reads.get() == 1 {
                        ResetPhase::Relaunching.as_str().to_string()
                    } else {
                        ResetPhase::Completed.as_str().to_string()
                    },
                    state: if status_reads.get() == 1 {
                        "running".to_string()
                    } else {
                        "completed".to_string()
                    },
                    updated_at: Utc::now().to_rfc3339(),
                    error_code: None,
                    error_message: None,
                    failing_key: None,
                    failing_path: None,
                }))
            },
            |completed_operation_id| {
                cleared
                    .borrow_mut()
                    .push(completed_operation_id.to_string());
                Ok(())
            },
            || waits.set(waits.get() + 1),
            2,
        )
        .expect("replacement process acknowledges completed helper handoff");

        assert_eq!(status_reads.get(), 2);
        assert_eq!(waits.get(), 1);
        assert_eq!(cleared.into_inner(), vec![operation_id]);

        let clear_attempts = Cell::new(0_u32);
        let blocked = normal_startup_reset_gate_with(
            || Ok(Some(ownership)),
            || {
                Ok(Some(ResetStatus {
                    operation_id: operation_id.to_string(),
                    mode: ResetMode::EmergencyReset.as_str().to_string(),
                    phase: ResetPhase::FilesystemCleanup.as_str().to_string(),
                    state: "running".to_string(),
                    updated_at: Utc::now().to_rfc3339(),
                    error_code: None,
                    error_message: None,
                    failing_key: None,
                    failing_path: None,
                }))
            },
            |_| {
                clear_attempts.set(clear_attempts.get() + 1);
                Ok(())
            },
            || {},
            1,
        );
        assert_eq!(blocked.unwrap_err(), "RESET_IN_PROGRESS");
        assert_eq!(clear_attempts.get(), 0);
    }

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

    #[test]
    fn infer_pos_tauri_project_dir_from_debug_executable_path() {
        let path = PathBuf::from("repo")
            .join("pos-tauri")
            .join("src-tauri")
            .join("target")
            .join("debug")
            .join(if cfg!(windows) {
                "the-small-pos.exe"
            } else {
                "the-small-pos"
            });
        assert_eq!(
            infer_pos_tauri_project_dir(&path),
            Some(PathBuf::from("repo").join("pos-tauri"))
        );
    }

    fn authorized_reset_owner_for_test() -> Arc<ResetCredentialOwner> {
        Arc::new(ResetCredentialOwner {
            operation_id: "123e4567-e89b-42d3-a456-426614174000".to_string(),
            manifest_sha256: "a".repeat(64),
            credential_keys: crate::storage::managed_keys()
                .iter()
                .map(|key| (*key).to_string())
                .collect(),
            _private: (),
        })
    }

    #[test]
    fn authorized_reset_capability_clears_every_exact_managed_key() {
        let seeded = crate::storage::managed_keys()
            .iter()
            .map(|key| ((*key).to_string(), format!("value-{key}")))
            .collect::<Vec<_>>();
        let _guard = crate::tests::fake_keyring::install_seeded(seeded);
        let owner = authorized_reset_owner_for_test();

        for key in crate::storage::managed_keys() {
            crate::storage::delete_managed_credential_for_reset(&owner, key)
                .expect("authorized reset must delete and verify every managed key");
            assert_eq!(crate::storage::get_credential_strict(key).unwrap(), None);
        }
    }

    #[test]
    fn reset_capability_rejects_unknown_key_and_verifies_retained_key() {
        let _guard = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "terminal-a"),
            ("unknown_dynamic_key", "keep"),
        ]);
        let owner = authorized_reset_owner_for_test();
        assert_eq!(
            crate::storage::delete_managed_credential_for_reset(&owner, "unknown_dynamic_key")
                .unwrap_err(),
            "RESET_CREDENTIAL_KEY_NOT_AUTHORIZED"
        );
        assert_eq!(
            crate::storage::get_credential_strict("unknown_dynamic_key").unwrap(),
            Some(zeroize::Zeroizing::new("keep".to_string()))
        );

        crate::tests::fake_keyring::fail_deletes_for("terminal_id", "raw backend detail");
        assert_eq!(
            crate::storage::delete_managed_credential_for_reset(&owner, "terminal_id").unwrap_err(),
            "RESET_CREDENTIAL_DELETE_FAILED"
        );
        assert!(crate::storage::get_credential("terminal_id").is_some());
        let mut retained = helper_test_manifest("123e4567-e89b-42d3-a456-426614174001");
        retained.credential_keys = vec!["terminal_id".to_string()];
        assert_eq!(
            verify_reset(&retained),
            Err((
                "keyring_delete_failed".to_string(),
                Some("terminal_id".to_string()),
                None
            ))
        );
    }

    #[test]
    fn protected_production_delete_surface_remains_capability_scoped() {
        let storage_source = include_str!("storage.rs");
        assert!(storage_source.contains(
            "delete_managed_credential_for_reset(\n    owner: &crate::reset::ResetCredentialOwner"
        ));
        assert!(storage_source.contains("delete_terminal_credential(\n    _owner: &crate::commands::settings::TerminalCredentialOwner"));
        assert!(storage_source.contains("delete_repair_identity_uncoordinated"));
        assert!(storage_source.contains("TERMINAL_CREDENTIAL_OWNER_REQUIRED"));
        assert!(!storage_source.contains("pub fn delete_managed_credential_for_reset"));
    }

    #[derive(Debug, PartialEq, Eq)]
    struct SimulatedResetHelperExit {
        code: i32,
        error: String,
    }

    #[test]
    fn keyring_timeout_is_bounded_and_the_worker_receives_one_fixed_key() {
        let owner = authorized_reset_owner_for_test();
        let (selected_tx, selected_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();

        let started = Instant::now();
        let error = run_keyring_delete_with_timeout_dependency(
            owner,
            "terminal_id".to_string(),
            Duration::from_millis(25),
            move |worker_owner, worker_key| {
                assert!(worker_owner.authorizes(&worker_key));
                selected_tx.send(worker_key).unwrap();
                release_rx.recv().unwrap();
                finished_tx.send(()).unwrap();
                Ok(())
            },
        )
        .expect_err("a timed-out keyring worker must fail closed");

        assert_eq!(error, "Timed out deleting credential key 'terminal_id'");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "timeout must return within a bounded interval"
        );
        assert_eq!(
            selected_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("worker receives its owned key"),
            "terminal_id"
        );
        release_tx.send(()).unwrap();
        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("delayed worker completes after the probe releases it");
        assert!(
            selected_rx.try_recv().is_err(),
            "worker selected another key"
        );
    }

    #[test]
    fn helper_timeout_exit_boundary_precedes_reprovision_and_blocks_late_delete() {
        let owner = authorized_reset_owner_for_test();
        let credentials = Arc::new(Mutex::new(std::collections::BTreeMap::from([
            ("terminal_id".to_string(), "old-terminal".to_string()),
            ("organization_id".to_string(), "org-a".to_string()),
        ])));
        let helper_process_alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let normal_startup_reached = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (selected_tx, selected_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();

        let worker_credentials = Arc::clone(&credentials);
        let worker_process_alive = Arc::clone(&helper_process_alive);
        let normal_startup_probe = Arc::clone(&normal_startup_reached);
        let helper_process_for_exit = Arc::clone(&helper_process_alive);
        let started = Instant::now();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_reset_helper_process_with(
                Path::new("ignored-test-manifest.json"),
                move |_| {
                    run_keyring_delete_with_timeout_dependency(
                        owner,
                        "terminal_id".to_string(),
                        Duration::from_millis(25),
                        move |worker_owner, worker_key| {
                            assert!(worker_owner.authorizes(&worker_key));
                            selected_tx.send(worker_key.clone()).unwrap();
                            release_rx.recv().unwrap();
                            if worker_process_alive.load(Ordering::SeqCst) {
                                worker_credentials.lock().unwrap().remove(&worker_key);
                            }
                            finished_tx.send(()).unwrap();
                            Ok(())
                        },
                    )
                },
                move |code, error| -> std::convert::Infallible {
                    helper_process_for_exit.store(false, Ordering::SeqCst);
                    std::panic::panic_any(SimulatedResetHelperExit { code, error });
                },
            );
            normal_startup_probe.store(true, Ordering::SeqCst);
        }));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "helper timeout must reach its terminal exit path promptly"
        );

        let exit = result
            .expect_err("helper failure must take the divergent exit path")
            .downcast::<SimulatedResetHelperExit>()
            .expect("probe exits with the bounded helper failure");
        assert_eq!(exit.code, 1);
        assert_eq!(
            exit.error,
            "Timed out deleting credential key 'terminal_id'"
        );
        assert!(!normal_startup_reached.load(Ordering::SeqCst));
        assert!(!helper_process_alive.load(Ordering::SeqCst));
        assert_eq!(
            selected_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("worker owns the original fixed key"),
            "terminal_id"
        );

        // The AtomicBool is the in-process model of the OS process boundary:
        // a real `process::exit(1)` terminates the detached worker before a
        // replacement process can publish new onboarding credentials.
        credentials.lock().unwrap().insert(
            "terminal_id".to_string(),
            "reprovisioned-terminal".to_string(),
        );
        release_tx.send(()).unwrap();
        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("late worker observes the terminal process boundary");

        let credentials = credentials.lock().unwrap();
        assert_eq!(
            credentials.get("terminal_id").map(String::as_str),
            Some("reprovisioned-terminal")
        );
        assert_eq!(
            credentials.get("organization_id").map(String::as_str),
            Some("org-a")
        );
        assert!(
            selected_rx.try_recv().is_err(),
            "worker selected another key"
        );
    }
}
