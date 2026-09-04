use crate::recovery::{DestructiveSnapshotDecision, RecoveryPointKind};
use crate::reset::{ResetLaunchOutcome, ResetMode, TrustedResetPaths};
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};

pub(crate) const NATIVE_MESSAGE_BOX_YES_NO: u32 = 0x0000_0004;
pub(crate) const NATIVE_MESSAGE_BOX_WARNING: u32 = 0x0000_0030;
pub(crate) const NATIVE_MESSAGE_BOX_DEFAULT_NO: u32 = 0x0000_0100;
pub(crate) const NATIVE_MESSAGE_BOX_ERROR: u32 = 0x0000_0010;
pub(crate) const NATIVE_CONFIRM_YES: i32 = 6;
#[cfg(test)]
pub(crate) const NATIVE_CONFIRM_NO: i32 = 7;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StartupMode {
    Normal,
    ResetHelper(PathBuf),
    EmergencyRecovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// The shared postfix intentionally distinguishes terminal process outcomes
// from the similarly named startup modes above.
#[allow(clippy::enum_variant_names)]
pub(crate) enum StartupDisposition {
    NormalExited,
    HelperExited,
    RecoveryExited,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EmergencyRecoveryDisposition {
    Cancelled,
    Accepted(ResetLaunchOutcome),
    NotStarted(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeStartupFailure {
    InvalidArguments,
    AlreadyRunning,
    EmergencyRecoveryFailed,
    ResetNotStarted,
    NormalStartupFailed,
}

impl NativeStartupFailure {
    fn code(self) -> &'static str {
        match self {
            Self::InvalidArguments => "INVALID_STARTUP_ARGUMENTS",
            Self::AlreadyRunning => "POS_ALREADY_RUNNING",
            Self::EmergencyRecoveryFailed => "EMERGENCY_RECOVERY_FAILED",
            Self::ResetNotStarted => "RESET_NOT_STARTED",
            Self::NormalStartupFailed => "NORMAL_STARTUP_FAILED",
        }
    }

    fn guidance(self) -> &'static str {
        match self {
            Self::InvalidArguments => {
                "Use the installed The Small POS shortcuts only. / Χρησιμοποιήστε μόνο τις εγκατεστημένες συντομεύσεις του The Small POS."
            }
            Self::AlreadyRunning => {
                "The Small POS is already running. Close the existing POS process and try again. / Το The Small POS εκτελείται ήδη. Κλείστε την υπάρχουσα διεργασία POS και δοκιμάστε ξανά."
            }
            Self::EmergencyRecoveryFailed => {
                "Emergency Recovery stopped without starting a reset. Local data was not intentionally deleted. / Η Επείγουσα Ανάκτηση σταμάτησε χωρίς να ξεκινήσει επαναφορά. Τα τοπικά δεδομένα δεν διαγράφηκαν σκόπιμα."
            }
            Self::ResetNotStarted => {
                "The reset helper did not start. Local data was not intentionally deleted. / Ο βοηθός επαναφοράς δεν ξεκίνησε. Τα τοπικά δεδομένα δεν διαγράφηκαν σκόπιμα."
            }
            Self::NormalStartupFailed => {
                "The Small POS could not start safely. / Το The Small POS δεν μπόρεσε να ξεκινήσει με ασφάλεια."
            }
        }
    }
}

pub(crate) fn show_native_startup_failure_with<F>(failure: NativeStartupFailure, display: F)
where
    F: FnOnce(&str, u32),
{
    let message = format!(
        "{}\n\nError code / Κωδικός: {}\n\nContact support / Επικοινωνήστε με την υποστήριξη.",
        failure.guidance(),
        failure.code()
    );
    display(&message, NATIVE_MESSAGE_BOX_ERROR);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KnownFolderRoots {
    pub(crate) roaming: PathBuf,
    pub(crate) local: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrustedAppPaths {
    pub(crate) app_data_dir: PathBuf,
    pub(crate) local_state_dir: PathBuf,
}

pub(crate) fn parse_startup_mode_from<I, S>(args: I) -> Result<StartupMode, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    match args.as_slice() {
        [] => Ok(StartupMode::Normal),
        [flag] if flag == OsStr::new("--emergency-recovery") => Ok(StartupMode::EmergencyRecovery),
        [flag, manifest] if flag == OsStr::new("--reset-helper") && !manifest.is_empty() => {
            let manifest_path = PathBuf::from(manifest);
            if crate::reset::is_generated_reset_manifest_path(&manifest_path) {
                Ok(StartupMode::ResetHelper(manifest_path))
            } else {
                Err("INVALID_STARTUP_ARGUMENTS".to_string())
            }
        }
        _ => Err("INVALID_STARTUP_ARGUMENTS".to_string()),
    }
}

pub(crate) fn parse_process_startup_mode() -> Result<StartupMode, String> {
    parse_startup_mode_from(std::env::args_os().skip(1))
}

pub(crate) fn run_startup_with<G, A, H, R, N>(
    mode: StartupMode,
    acquire_runtime: A,
    run_helper: H,
    run_recovery: R,
    run_normal: N,
) -> Result<StartupDisposition, String>
where
    A: FnOnce() -> Result<G, String>,
    H: FnOnce(PathBuf) -> Result<(), String>,
    R: FnOnce() -> Result<(), String>,
    N: FnOnce() -> Result<(), String>,
{
    if let StartupMode::ResetHelper(manifest_path) = mode {
        run_helper(manifest_path)?;
        return Ok(StartupDisposition::HelperExited);
    }

    let _runtime_guard = acquire_runtime()?;
    match mode {
        StartupMode::EmergencyRecovery => {
            run_recovery()?;
            Ok(StartupDisposition::RecoveryExited)
        }
        StartupMode::Normal => {
            run_normal()?;
            Ok(StartupDisposition::NormalExited)
        }
        StartupMode::ResetHelper(_) => unreachable!(),
    }
}

pub(crate) fn native_confirmation_flags() -> u32 {
    NATIVE_MESSAGE_BOX_YES_NO | NATIVE_MESSAGE_BOX_WARNING | NATIVE_MESSAGE_BOX_DEFAULT_NO
}

pub(crate) fn native_confirmation_allows_reset(result: i32) -> bool {
    result == NATIVE_CONFIRM_YES
}

pub(crate) fn native_confirmation_result(result: i32) -> Result<bool, String> {
    if result == 0 {
        return Err("NATIVE_CONFIRMATION_FAILED".to_string());
    }
    Ok(native_confirmation_allows_reset(result))
}

pub(crate) fn trusted_app_paths_from_roots(
    roots: &KnownFolderRoots,
    compiled_identifier: &str,
) -> Result<TrustedAppPaths, String> {
    let identifier_path = Path::new(compiled_identifier);
    if compiled_identifier.trim().is_empty()
        || identifier_path.components().count() != 1
        || !matches!(
            identifier_path.components().next(),
            Some(Component::Normal(_))
        )
    {
        return Err("COMPILED_APP_IDENTIFIER_INVALID".to_string());
    }
    Ok(TrustedAppPaths {
        app_data_dir: roots.roaming.join(compiled_identifier),
        local_state_dir: roots.local.join(compiled_identifier),
    })
}

pub(crate) fn run_emergency_recovery_with<C, O, P, L>(
    confirm: C,
    existing_ownership: O,
    preflight: P,
    launch: L,
) -> Result<EmergencyRecoveryDisposition, String>
where
    C: FnOnce() -> Result<bool, String>,
    O: FnOnce() -> Result<Option<ResetLaunchOutcome>, String>,
    P: FnOnce() -> Result<DestructiveSnapshotDecision, String>,
    L: FnOnce() -> ResetLaunchOutcome,
{
    if !confirm()? {
        return Ok(EmergencyRecoveryDisposition::Cancelled);
    }
    if let Some(existing) = existing_ownership()? {
        return Ok(EmergencyRecoveryDisposition::Accepted(existing));
    }
    let _recovery_decision = preflight()?;
    match launch() {
        accepted @ ResetLaunchOutcome::Accepted { .. } => {
            Ok(EmergencyRecoveryDisposition::Accepted(accepted))
        }
        ResetLaunchOutcome::NotStarted { error } => {
            Ok(EmergencyRecoveryDisposition::NotStarted(error))
        }
    }
}

pub(crate) fn preflight_existing_database_for_emergency(
    app_data_dir: &Path,
) -> Result<DestructiveSnapshotDecision, String> {
    let Some(db) = crate::db::open_existing_for_recovery(app_data_dir)? else {
        return Ok(DestructiveSnapshotDecision::SkippedNoDatabase);
    };
    crate::recovery::preflight_snapshot_before_destructive_action(
        &db,
        RecoveryPointKind::PreEmergencyReset,
    )
}

#[cfg(target_os = "windows")]
fn wide_null(value: &OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn windows_known_folder(csidl: u32) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::Shell::{SHGetFolderPathW, SHGFP_TYPE_CURRENT};

    let mut buffer = [0u16; 260];
    let result = unsafe {
        SHGetFolderPathW(
            std::ptr::null_mut(),
            csidl as i32,
            std::ptr::null_mut(),
            SHGFP_TYPE_CURRENT as u32,
            buffer.as_mut_ptr(),
        )
    };
    if result < 0 {
        return Err(format!(
            "KNOWN_FOLDER_RESOLUTION_FAILED: HRESULT {result:#x}"
        ));
    }
    let length = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    if length == 0 {
        return Err("KNOWN_FOLDER_RESOLUTION_FAILED: empty path".to_string());
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

#[cfg(target_os = "windows")]
pub(crate) fn resolve_windows_known_folder_roots() -> Result<KnownFolderRoots, String> {
    use windows_sys::Win32::UI::Shell::{CSIDL_APPDATA, CSIDL_LOCAL_APPDATA};
    Ok(KnownFolderRoots {
        roaming: windows_known_folder(CSIDL_APPDATA)?,
        local: windows_known_folder(CSIDL_LOCAL_APPDATA)?,
    })
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn resolve_windows_known_folder_roots() -> Result<KnownFolderRoots, String> {
    Err("EMERGENCY_RECOVERY_UNSUPPORTED_PLATFORM".to_string())
}

#[cfg(target_os = "windows")]
pub(crate) struct RuntimeMutexGuard {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
impl std::fmt::Debug for RuntimeMutexGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeMutexGuard")
            .finish_non_exhaustive()
    }
}

#[cfg(target_os = "windows")]
impl Drop for RuntimeMutexGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn acquire_runtime_mutex_for_identifier(
    compiled_identifier: &str,
) -> Result<RuntimeMutexGuard, String> {
    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_ALREADY_EXISTS, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Threading::CreateMutexW;

    trusted_app_paths_from_roots(
        &KnownFolderRoots {
            roaming: PathBuf::from("trusted"),
            local: PathBuf::from("trusted"),
        },
        compiled_identifier,
    )?;
    let mutex_name = format!("Local\\{compiled_identifier}.runtime");
    let encoded = wide_null(OsStr::new(&mutex_name));
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, encoded.as_ptr()) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(format!("RUNTIME_MUTEX_CREATE_FAILED: {}", unsafe {
            GetLastError()
        }));
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
        return Err("POS_ALREADY_RUNNING".to_string());
    }
    Ok(RuntimeMutexGuard { handle })
}

#[cfg(not(target_os = "windows"))]
#[derive(Debug)]
pub(crate) struct RuntimeMutexGuard;

#[cfg(not(target_os = "windows"))]
pub(crate) fn acquire_runtime_mutex_for_identifier(
    _compiled_identifier: &str,
) -> Result<RuntimeMutexGuard, String> {
    Ok(RuntimeMutexGuard)
}

#[cfg(target_os = "windows")]
fn show_native_message(text: &str, caption: &str, style: u32) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW;
    let text = wide_null(OsStr::new(text));
    let caption = wide_null(OsStr::new(caption));
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), style) }
}

#[cfg(target_os = "windows")]
pub(crate) fn show_native_emergency_confirmation() -> Result<bool, String> {
    let result = show_native_message(
        "FULL TERMINAL WIPE / ΠΛΗΡΗΣ ΔΙΑΓΡΑΦΗ ΤΕΡΜΑΤΙΚΟΥ\n\nThis removes local orders, unsynced work, POS credentials, and repair encryption keys. Recovery snapshots cannot preserve native repair data.\n\nΘα διαγραφούν τοπικές παραγγελίες, μη συγχρονισμένη εργασία, διαπιστευτήρια POS και κλειδιά κρυπτογράφησης επισκευών.\n\nContinue? / Συνέχεια;",
        "The Small POS — Emergency Recovery",
        native_confirmation_flags(),
    );
    native_confirmation_result(result)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn show_native_emergency_confirmation() -> Result<bool, String> {
    Err("EMERGENCY_RECOVERY_UNSUPPORTED_PLATFORM".to_string())
}

#[cfg(target_os = "windows")]
pub(crate) fn show_native_reset_helper_confirmation() -> Result<bool, String> {
    let result = show_native_message(
        "FINAL TERMINAL RESET CONFIRMATION / ΤΕΛΙΚΗ ΕΠΙΒΕΒΑΙΩΣΗ ΕΠΑΝΑΦΟΡΑΣ\n\nThe Small POS is ready to permanently remove local terminal data, unsynced work, credentials, and repair encryption keys. No is the safe default.\n\nΤο The Small POS είναι έτοιμο να διαγράψει οριστικά τοπικά δεδομένα, μη συγχρονισμένη εργασία, διαπιστευτήρια και κλειδιά κρυπτογράφησης επισκευών. Η ασφαλής προεπιλογή είναι Όχι.\n\nContinue? / Συνέχεια;",
        "The Small POS — Final Reset Confirmation",
        native_confirmation_flags(),
    );
    native_confirmation_result(result)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn show_native_reset_helper_confirmation() -> Result<bool, String> {
    Err("RESET_HELPER_CONFIRMATION_UNSUPPORTED_PLATFORM".to_string())
}

#[cfg(target_os = "windows")]
pub(crate) fn show_native_already_running() {
    show_native_startup_failure(NativeStartupFailure::AlreadyRunning);
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn show_native_already_running() {}

#[cfg(target_os = "windows")]
pub(crate) fn show_native_startup_failure(failure: NativeStartupFailure) {
    show_native_startup_failure_with(failure, |message, flags| {
        let _ = show_native_message(message, "The Small POS", flags);
    });
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn show_native_startup_failure(_failure: NativeStartupFailure) {}

pub(crate) fn run_native_emergency_recovery(
    compiled_identifier: &str,
) -> Result<EmergencyRecoveryDisposition, String> {
    let trusted_paths = std::cell::RefCell::new(None::<TrustedAppPaths>);
    run_emergency_recovery_with(
        show_native_emergency_confirmation,
        crate::reset::existing_accepted_reset_ownership,
        || {
            let roots = resolve_windows_known_folder_roots()?;
            let paths = trusted_app_paths_from_roots(&roots, compiled_identifier)?;
            let decision = preflight_existing_database_for_emergency(&paths.app_data_dir)?;
            trusted_paths.replace(Some(paths));
            Ok(decision)
        },
        || {
            let paths = trusted_paths
                .borrow_mut()
                .take()
                .expect("preflight must publish trusted paths before launch");
            let app_executable = match std::env::current_exe() {
                Ok(path) => path,
                Err(error) => {
                    return ResetLaunchOutcome::NotStarted {
                        error: format!("resolve current executable: {error}"),
                    };
                }
            };
            crate::reset::launch_native_reset(
                ResetMode::EmergencyReset,
                TrustedResetPaths {
                    app_executable,
                    app_data_dir: paths.app_data_dir,
                    local_state_dir: Some(paths.local_state_dir),
                },
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recovery::DestructiveSnapshotDecision;
    use crate::reset::ResetLaunchOutcome;
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::cell::{Cell, RefCell};
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use uuid::Uuid;

    fn accepted(operation_id: &str) -> ResetLaunchOutcome {
        ResetLaunchOutcome::Accepted {
            operation_id: operation_id.to_string(),
            response: json!({
                "success": true,
                "started": true,
                "operationId": operation_id,
                "mode": "emergency_reset",
            }),
            post_spawn_warning: None,
        }
    }

    fn temp_path(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()))
    }

    #[test]
    fn startup_parser_accepts_only_normal_exact_helper_or_exact_emergency() {
        let helper_operation_id = "11111111-1111-4111-8111-111111111111";
        let generated_helper_manifest = std::env::temp_dir()
            .join("the-small-pos-reset")
            .join(format!("manifest-{helper_operation_id}.json"));
        assert_eq!(
            parse_startup_mode_from(Vec::<OsString>::new()).unwrap(),
            StartupMode::Normal
        );
        assert_eq!(
            parse_startup_mode_from([
                OsString::from("--reset-helper"),
                generated_helper_manifest.clone().into_os_string(),
            ])
            .unwrap(),
            StartupMode::ResetHelper(generated_helper_manifest)
        );
        assert_eq!(
            parse_startup_mode_from([OsString::from("--emergency-recovery")]).unwrap(),
            StartupMode::EmergencyRecovery
        );

        for invalid in [
            vec![OsString::from("--reset-helper")],
            vec![
                OsString::from("--reset-helper"),
                OsString::from("--emergency-recovery"),
            ],
            vec![
                OsString::from("--reset-helper"),
                OsString::from("manifest.json"),
            ],
            vec![
                OsString::from("--reset-helper"),
                OsString::from(r"C:\untrusted\manifest.json"),
            ],
            vec![
                OsString::from("--reset-helper"),
                OsString::from("manifest.json"),
                OsString::from("extra"),
            ],
            vec![
                OsString::from("--emergency-recovery"),
                OsString::from("extra"),
            ],
            vec![
                OsString::from("--emergency-recovery"),
                OsString::from("--emergency-recovery"),
            ],
            vec![OsString::from("--emergency-recover")],
            vec![OsString::from("--Emergency-Recovery")],
            vec![OsString::from("--emergency-recovery=yes")],
            vec![
                OsString::from("--reset-helper"),
                OsString::from("manifest.json"),
                OsString::from("--emergency-recovery"),
            ],
            vec![OsString::from("ordinary-extra")],
        ] {
            assert!(
                parse_startup_mode_from(invalid).is_err(),
                "non-exact startup arguments must fail closed"
            );
        }
    }

    #[test]
    fn helper_bypasses_runtime_mutex_while_normal_and_recovery_share_it() {
        let mutex_calls = Cell::new(0);
        let helper_calls = Cell::new(0);
        let recovery_calls = Cell::new(0);
        let normal_calls = Cell::new(0);

        let disposition = run_startup_with(
            StartupMode::ResetHelper(PathBuf::from("manifest.json")),
            || {
                mutex_calls.set(mutex_calls.get() + 1);
                Ok(())
            },
            |_| {
                helper_calls.set(helper_calls.get() + 1);
                Ok(())
            },
            || {
                recovery_calls.set(recovery_calls.get() + 1);
                Ok(())
            },
            || {
                normal_calls.set(normal_calls.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(disposition, StartupDisposition::HelperExited);
        assert_eq!(mutex_calls.get(), 0);
        assert_eq!(helper_calls.get(), 1);
        assert_eq!(recovery_calls.get(), 0);
        assert_eq!(normal_calls.get(), 0);

        run_startup_with(
            StartupMode::EmergencyRecovery,
            || {
                mutex_calls.set(mutex_calls.get() + 1);
                Ok(())
            },
            |_| unreachable!(),
            || {
                recovery_calls.set(recovery_calls.get() + 1);
                Ok(())
            },
            || {
                normal_calls.set(normal_calls.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        run_startup_with(
            StartupMode::Normal,
            || {
                mutex_calls.set(mutex_calls.get() + 1);
                Ok(())
            },
            |_| unreachable!(),
            || unreachable!(),
            || {
                normal_calls.set(normal_calls.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(mutex_calls.get(), 2);
        assert_eq!(recovery_calls.get(), 1);
        assert_eq!(normal_calls.get(), 1);
    }

    #[test]
    fn runtime_guard_is_held_during_normal_and_recovery_and_released_afterward() {
        struct Guard(Arc<AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }

        for mode in [StartupMode::Normal, StartupMode::EmergencyRecovery] {
            let held = Arc::new(AtomicBool::new(false));
            let held_for_acquire = held.clone();
            let held_for_recovery = held.clone();
            let held_for_normal = held.clone();
            run_startup_with(
                mode,
                move || {
                    held_for_acquire.store(true, Ordering::SeqCst);
                    Ok(Guard(held_for_acquire.clone()))
                },
                |_| unreachable!(),
                move || {
                    assert!(held_for_recovery.load(Ordering::SeqCst));
                    Ok(())
                },
                move || {
                    assert!(held_for_normal.load(Ordering::SeqCst));
                    Ok(())
                },
            )
            .unwrap();
            assert!(!held.load(Ordering::SeqCst));
        }
    }

    #[test]
    fn native_confirmation_is_yes_only_and_defaults_to_no() {
        let flags = native_confirmation_flags();
        assert_ne!(flags & NATIVE_MESSAGE_BOX_YES_NO, 0);
        assert_ne!(flags & NATIVE_MESSAGE_BOX_WARNING, 0);
        assert_ne!(flags & NATIVE_MESSAGE_BOX_DEFAULT_NO, 0);
        assert!(native_confirmation_allows_reset(NATIVE_CONFIRM_YES));
        for denied in [NATIVE_CONFIRM_NO, 0, -1, 2, 3] {
            assert!(!native_confirmation_allows_reset(denied));
        }
        assert_eq!(native_confirmation_result(NATIVE_CONFIRM_YES), Ok(true));
        assert_eq!(native_confirmation_result(NATIVE_CONFIRM_NO), Ok(false));
        assert_eq!(
            native_confirmation_result(0),
            Err("NATIVE_CONFIRMATION_FAILED".to_string())
        );
    }

    #[test]
    fn native_failure_dialog_uses_stable_bilingual_guidance_without_error_details() {
        let shown = RefCell::new(Vec::new());
        for failure in [
            NativeStartupFailure::InvalidArguments,
            NativeStartupFailure::AlreadyRunning,
            NativeStartupFailure::EmergencyRecoveryFailed,
            NativeStartupFailure::ResetNotStarted,
            NativeStartupFailure::NormalStartupFailed,
        ] {
            show_native_startup_failure_with(failure, |message, flags| {
                shown.borrow_mut().push((message.to_string(), flags));
            });
        }
        let shown = shown.into_inner();
        assert_eq!(shown.len(), 5);
        for (message, flags) in &shown {
            assert!(message.contains("Error code / Κωδικός"));
            assert!(message.contains("Contact support / Επικοινωνήστε"));
            assert!(!message.contains("C:\\Customers\\secret\\pos.db"));
            assert!(!message.contains("sqlite"));
            assert_ne!(*flags & NATIVE_MESSAGE_BOX_ERROR, 0);
        }
        assert!(shown[1].0.contains("POS_ALREADY_RUNNING"));
        assert!(!shown[1].0.contains("before Emergency Recovery"));
    }

    #[test]
    fn cancel_close_or_prompt_error_has_zero_recovery_or_reset_activity() {
        for confirmation in [Ok(false), Err("native prompt failed".to_string())] {
            let ownership_calls = Cell::new(0);
            let preflight_calls = Cell::new(0);
            let launch_calls = Cell::new(0);
            let result = run_emergency_recovery_with(
                || confirmation,
                || {
                    ownership_calls.set(ownership_calls.get() + 1);
                    Ok(None)
                },
                || {
                    preflight_calls.set(preflight_calls.get() + 1);
                    Ok(DestructiveSnapshotDecision::Created)
                },
                || {
                    launch_calls.set(launch_calls.get() + 1);
                    accepted("unexpected")
                },
            );
            assert!(matches!(
                result,
                Ok(EmergencyRecoveryDisposition::Cancelled) | Err(_)
            ));
            assert_eq!(ownership_calls.get(), 0);
            assert_eq!(preflight_calls.get(), 0);
            assert_eq!(launch_calls.get(), 0);
        }
    }

    #[test]
    fn emergency_happy_path_orders_confirm_preflight_launch_and_never_runs_normal_ui() {
        let order = RefCell::new(Vec::new());
        let normal_builder_calls = Cell::new(0);
        let result = run_startup_with(
            StartupMode::EmergencyRecovery,
            || Ok(()),
            |_| unreachable!(),
            || {
                let outcome = run_emergency_recovery_with(
                    || {
                        order.borrow_mut().push("confirm");
                        Ok(true)
                    },
                    || {
                        order.borrow_mut().push("ownership");
                        Ok(None)
                    },
                    || {
                        order.borrow_mut().push("preflight");
                        Ok(DestructiveSnapshotDecision::SkippedNativeRepairState)
                    },
                    || {
                        order.borrow_mut().push("launch");
                        accepted("native-operation")
                    },
                )?;
                assert_eq!(
                    outcome,
                    EmergencyRecoveryDisposition::Accepted(accepted("native-operation"))
                );
                Ok(())
            },
            || {
                normal_builder_calls.set(normal_builder_calls.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(result, StartupDisposition::RecoveryExited);
        assert_eq!(
            order.into_inner(),
            vec!["confirm", "ownership", "preflight", "launch"]
        );
        assert_eq!(normal_builder_calls.get(), 0);
    }

    #[test]
    fn accepted_replay_skips_preflight_and_second_helper() {
        let preflight_calls = Cell::new(0);
        let launch_calls = Cell::new(0);
        let existing = accepted("same-operation");
        let result = run_emergency_recovery_with(
            || Ok(true),
            || Ok(Some(existing.clone())),
            || {
                preflight_calls.set(preflight_calls.get() + 1);
                Ok(DestructiveSnapshotDecision::Created)
            },
            || {
                launch_calls.set(launch_calls.get() + 1);
                accepted("duplicate-operation")
            },
        )
        .unwrap();
        assert_eq!(result, EmergencyRecoveryDisposition::Accepted(existing));
        assert_eq!(preflight_calls.get(), 0);
        assert_eq!(launch_calls.get(), 0);
    }

    #[test]
    fn launching_indeterminate_and_preflight_failure_never_launch_or_fall_through() {
        let launch_calls = Cell::new(0);
        let indeterminate = run_emergency_recovery_with(
            || Ok(true),
            || Err("RESET_LAUNCH_INDETERMINATE".to_string()),
            || unreachable!(),
            || {
                launch_calls.set(launch_calls.get() + 1);
                accepted("unexpected")
            },
        );
        assert_eq!(indeterminate.unwrap_err(), "RESET_LAUNCH_INDETERMINATE");
        assert_eq!(launch_calls.get(), 0);

        let failed_preflight = run_emergency_recovery_with(
            || Ok(true),
            || Ok(None),
            || Err("RECOVERY_PREFLIGHT_FAILED".to_string()),
            || {
                launch_calls.set(launch_calls.get() + 1);
                accepted("unexpected")
            },
        );
        assert_eq!(failed_preflight.unwrap_err(), "RECOVERY_PREFLIGHT_FAILED");
        assert_eq!(launch_calls.get(), 0);
    }

    #[test]
    fn trusted_paths_use_unicode_known_folders_and_compiled_identifier_only() {
        let roots = KnownFolderRoots {
            roaming: PathBuf::from(r"C:\Χρήστες\δοκιμή\AppData\Roaming"),
            local: PathBuf::from(r"C:\Χρήστες\δοκιμή\AppData\Local"),
        };
        let paths = trusted_app_paths_from_roots(&roots, "com.thesmall.pos").unwrap();
        assert_eq!(paths.app_data_dir, roots.roaming.join("com.thesmall.pos"));
        assert_eq!(paths.local_state_dir, roots.local.join("com.thesmall.pos"));
        assert!(!paths.app_data_dir.to_string_lossy().contains("APPDATA"));
        assert!(trusted_app_paths_from_roots(&roots, "../renderer-value").is_err());
    }

    #[test]
    fn missing_existing_database_creates_nothing() {
        let app_data_dir = temp_path("emergency-missing-db");
        assert!(!app_data_dir.exists());
        assert!(crate::db::open_existing_for_recovery(&app_data_dir)
            .unwrap()
            .is_none());
        assert!(!app_data_dir.exists());
        assert!(matches!(
            preflight_existing_database_for_emergency(&app_data_dir).unwrap(),
            DestructiveSnapshotDecision::SkippedNoDatabase
        ));
        assert!(!app_data_dir.exists());
    }

    #[test]
    fn existing_database_open_preserves_schema_and_data_without_migration() {
        let app_data_dir = temp_path("emergency-existing-db");
        let state = crate::db::init(&app_data_dir).expect("initialize existing database");
        {
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO local_settings (setting_category, setting_key, setting_value, updated_at)
                 VALUES ('test', 'preserved', 'yes', datetime('now'))",
                [],
            )
            .unwrap();
        }
        drop(state);
        let before = fs::read(app_data_dir.join("pos.db")).unwrap();
        let opened = crate::db::open_existing_for_recovery(&app_data_dir)
            .unwrap()
            .expect("existing db");
        let conn = opened.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT setting_value FROM local_settings
                  WHERE setting_category='test' AND setting_key='preserved'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "yes"
        );
        drop(conn);
        drop(opened);
        assert_eq!(fs::read(app_data_dir.join("pos.db")).unwrap(), before);
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn corrupt_or_locked_existing_database_fails_closed_without_replacement() {
        let corrupt_dir = temp_path("emergency-corrupt-db");
        fs::create_dir_all(&corrupt_dir).unwrap();
        let corrupt_bytes = b"not a sqlite database";
        fs::write(corrupt_dir.join("pos.db"), corrupt_bytes).unwrap();
        assert!(crate::db::open_existing_for_recovery(&corrupt_dir).is_err());
        assert_eq!(fs::read(corrupt_dir.join("pos.db")).unwrap(), corrupt_bytes);

        let locked_dir = temp_path("emergency-locked-db");
        let state = crate::db::init(&locked_dir).unwrap();
        drop(state);
        let locker = Connection::open(locked_dir.join("pos.db")).unwrap();
        locker.execute_batch("BEGIN EXCLUSIVE").unwrap();
        assert!(crate::db::open_existing_for_recovery(&locked_dir).is_err());
        locker.execute_batch("ROLLBACK").unwrap();
        let _ = fs::remove_dir_all(corrupt_dir);
        let _ = fs::remove_dir_all(locked_dir);
    }

    #[test]
    fn existing_db_preflight_creates_generic_snapshot_or_skips_native_repairs() {
        let generic_dir = temp_path("emergency-generic-preflight");
        drop(crate::db::init(&generic_dir).unwrap());
        assert!(matches!(
            preflight_existing_database_for_emergency(&generic_dir).unwrap(),
            DestructiveSnapshotDecision::Created
        ));
        assert!(crate::recovery::recovery_root_for_app_data(&generic_dir).exists());

        let native_dir = temp_path("emergency-native-preflight");
        let native = crate::db::init(&native_dir).unwrap();
        {
            let conn = native.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, retry_delay_ms, priority, module_type,
                     conflict_strategy, version, status, repair_aggregate_id
                 ) VALUES (
                     ?1, 'repairs', ?2, 'UPDATE', 'ciphertext', 'org', datetime('now'),
                     0, 1000, 1, 'repairs', 'manual', 0, 'pending', ?2
                 )",
                params![Uuid::new_v4().to_string(), Uuid::new_v4().to_string()],
            )
            .unwrap();
        }
        drop(native);
        assert!(matches!(
            preflight_existing_database_for_emergency(&native_dir).unwrap(),
            DestructiveSnapshotDecision::SkippedNativeRepairState
        ));
        let _ = fs::remove_dir_all(generic_dir);
        let _ = fs::remove_dir_all(native_dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn concurrent_recovery_launchers_reach_the_helper_seam_exactly_once() {
        use std::sync::mpsc;

        let identifier = format!("com.thesmall.pos.test.{}", Uuid::new_v4());
        let helper_launches = Arc::new(AtomicUsize::new(0));
        let helper_launches_for_first = helper_launches.clone();
        let identifier_for_first = identifier.clone();
        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();

        let first = std::thread::spawn(move || {
            run_startup_with(
                StartupMode::EmergencyRecovery,
                || acquire_runtime_mutex_for_identifier(&identifier_for_first),
                |_| unreachable!(),
                || {
                    helper_launches_for_first.fetch_add(1, Ordering::SeqCst);
                    first_entered_tx.send(()).unwrap();
                    release_first_rx.recv().unwrap();
                    Ok(())
                },
                || unreachable!(),
            )
        });
        first_entered_rx.recv().unwrap();

        let helper_launches_for_second = helper_launches.clone();
        let second = run_startup_with(
            StartupMode::EmergencyRecovery,
            || acquire_runtime_mutex_for_identifier(&identifier),
            |_| unreachable!(),
            || {
                helper_launches_for_second.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            || unreachable!(),
        );
        assert_eq!(second.unwrap_err(), "POS_ALREADY_RUNNING");
        release_first_tx.send(()).unwrap();
        assert_eq!(
            first.join().expect("first recovery launcher thread"),
            Ok(StartupDisposition::RecoveryExited)
        );
        assert_eq!(helper_launches.load(Ordering::SeqCst), 1);

        acquire_runtime_mutex_for_identifier(&identifier)
            .expect("mutex must be reusable after recovery exits");
    }
}
