//! Narrow Windows firewall management for the local Caller ID listener.
//!
//! The renderer can request only three fixed operations: inspect, install, or
//! remove the installer-owned rule. Install/remove always cross the Windows
//! UAC boundary; no renderer-controlled path, program, port, or profile is
//! accepted.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdFirewallStatus {
    pub supported: bool,
    pub configured: bool,
    pub private_network_active: bool,
    pub public_network_active: bool,
    pub network_profile_known: bool,
    pub public_rule_present: bool,
}

impl CallerIdFirewallStatus {
    #[cfg(any(not(target_os = "windows"), test))]
    fn unsupported() -> Self {
        Self {
            supported: false,
            configured: false,
            private_network_active: false,
            public_network_active: false,
            network_profile_known: false,
            public_rule_present: false,
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::CallerIdFirewallStatus;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::{
        ffi::OsStr,
        os::{windows::ffi::OsStrExt, windows::process::CommandExt},
        path::{Path, PathBuf},
        process::Command,
        ptr,
    };
    use tauri::{path::BaseDirectory, AppHandle, Manager};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED, WAIT_FAILED, WAIT_OBJECT_0},
        System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
        UI::{
            Shell::{
                ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
                SHELLEXECUTEINFOW,
            },
            WindowsAndMessaging::SW_HIDE,
        },
    };

    const HELPER_NAME: &str = "caller-id-firewall.ps1";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const UAC_CANCELLED_ERROR: &str = "CALLER_ID_FIREWALL_UAC_CANCELLED";

    struct FirewallPaths {
        helper: PathBuf,
        executable: PathBuf,
        powershell: PathBuf,
    }

    fn canonical_file(path: PathBuf, label: &str) -> Result<PathBuf, String> {
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("Unable to resolve {label}: {error}"))?;
        if !canonical.is_file() {
            return Err(format!("{label} is not a regular file"));
        }
        Ok(canonical)
    }

    /// Convert Rust's canonical Windows path into the ordinary absolute form
    /// accepted and returned by Windows Firewall. `std::fs::canonicalize`
    /// deliberately produces `\\?\` paths on Windows; passing that spelling
    /// across the NetSecurity boundary can either be rejected or normalized to
    /// a different string, which makes the installed rule look absent.
    fn firewall_external_path(path: &Path) -> Result<PathBuf, String> {
        let simplified = dunce::simplified(path).to_path_buf();
        if !simplified.is_absolute() {
            return Err("The POS executable path is not absolute".into());
        }
        if simplified.to_string_lossy().starts_with(r"\\?\") {
            return Err(
                "The POS executable path could not be converted for Windows Firewall".into(),
            );
        }
        Ok(simplified)
    }

    fn resolve_paths(app: &AppHandle) -> Result<FirewallPaths, String> {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| {
                format!("Unable to resolve the application resource directory: {error}")
            })?
            .canonicalize()
            .map_err(|error| {
                format!("Unable to verify the application resource directory: {error}")
            })?;
        let helper = canonical_file(
            app.path()
                .resolve(HELPER_NAME, BaseDirectory::Resource)
                .map_err(|error| {
                    format!("Unable to resolve the Caller ID firewall helper: {error}")
                })?,
            "Caller ID firewall helper",
        )?;
        if helper.parent() != Some(resource_dir.as_path()) {
            return Err(
                "Caller ID firewall helper resolved outside the application resource directory"
                    .into(),
            );
        }

        let executable = canonical_file(
            std::env::current_exe()
                .map_err(|error| format!("Unable to resolve the POS executable: {error}"))?,
            "POS executable",
        )?;
        if !executable
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        {
            return Err("The POS executable path is not a Windows executable".into());
        }
        let executable = firewall_external_path(&executable)?;

        let system_root = std::env::var_os("SystemRoot")
            .ok_or_else(|| "Windows SystemRoot is unavailable".to_string())?;
        let powershell = canonical_file(
            PathBuf::from(system_root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
            "Windows PowerShell",
        )?;

        Ok(FirewallPaths {
            helper,
            executable,
            powershell,
        })
    }

    fn status(paths: &FirewallPaths) -> Result<CallerIdFirewallStatus, String> {
        let output = Command::new(&paths.powershell)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&paths.helper)
            .args(["-Action", "Status", "-ExecutablePath"])
            .arg(&paths.executable)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("Unable to inspect Caller ID network access: {error}"))?;

        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                format!(
                    "Caller ID network-access inspection failed with exit code {}",
                    output.status.code().unwrap_or(-1)
                )
            } else {
                format!("Caller ID network-access inspection failed: {detail}")
            });
        }

        serde_json::from_slice::<CallerIdFirewallStatus>(&output.stdout)
            .map_err(|error| format!("Caller ID network-access status was invalid: {error}"))
    }

    fn powershell_single_quote(value: &Path) -> String {
        value.to_string_lossy().replace('\'', "''")
    }

    fn encoded_elevated_command(paths: &FirewallPaths, action: &str) -> String {
        let command = format!(
            "& '{}' -Action '{}' -ExecutablePath '{}'",
            powershell_single_quote(&paths.helper),
            action,
            powershell_single_quote(&paths.executable),
        );
        let utf16le = command
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        STANDARD.encode(utf16le)
    }

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn run_elevated(paths: &FirewallPaths, action: &str) -> Result<(), String> {
        if !matches!(action, "Install" | "Remove") {
            return Err("Unsupported Caller ID firewall action".into());
        }
        let encoded = encoded_elevated_command(paths, action);
        let parameters =
            format!("-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {encoded}");
        let verb = wide_null(OsStr::new("runas"));
        let file = wide_null(paths.powershell.as_os_str());
        let parameters = wide_null(OsStr::new(&parameters));

        let mut execute_info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        execute_info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        execute_info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
        execute_info.lpVerb = verb.as_ptr();
        execute_info.lpFile = file.as_ptr();
        execute_info.lpParameters = parameters.as_ptr();
        execute_info.lpDirectory = ptr::null();
        execute_info.nShow = SW_HIDE;

        let launched = unsafe { ShellExecuteExW(&mut execute_info) };
        if launched == 0 {
            let code = unsafe { GetLastError() };
            return if code == ERROR_CANCELLED {
                Err(UAC_CANCELLED_ERROR.into())
            } else {
                Err(format!(
                    "Unable to request Windows administrator approval: {}",
                    std::io::Error::from_raw_os_error(code as i32)
                ))
            };
        }
        if execute_info.hProcess.is_null() {
            return Err("Windows did not return the firewall-helper process handle".into());
        }

        let process = execute_info.hProcess;
        let wait_result = unsafe { WaitForSingleObject(process, INFINITE) };
        if wait_result == WAIT_FAILED {
            let code = unsafe { GetLastError() };
            unsafe { CloseHandle(process) };
            return Err(format!(
                "Waiting for Windows network approval failed: {}",
                std::io::Error::from_raw_os_error(code as i32)
            ));
        }
        if wait_result != WAIT_OBJECT_0 {
            unsafe { CloseHandle(process) };
            return Err(format!(
                "Windows network approval returned an unexpected wait result: {wait_result}"
            ));
        }

        let mut exit_code = 1u32;
        let read_exit_code = unsafe { GetExitCodeProcess(process, &mut exit_code) };
        unsafe { CloseHandle(process) };
        if read_exit_code == 0 {
            let code = unsafe { GetLastError() };
            return Err(format!(
                "Unable to read the firewall-helper result: {}",
                std::io::Error::from_raw_os_error(code as i32)
            ));
        }
        if exit_code != 0 {
            return Err(format!(
                "Windows did not apply the Caller ID network-access change (exit code {exit_code})"
            ));
        }
        Ok(())
    }

    pub(super) fn inspect(app: &AppHandle) -> Result<CallerIdFirewallStatus, String> {
        status(&resolve_paths(app)?)
    }

    pub(super) fn change(
        app: &AppHandle,
        action: &'static str,
    ) -> Result<CallerIdFirewallStatus, String> {
        let paths = resolve_paths(app)?;
        run_elevated(&paths, action)?;
        status(&paths)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn powershell_path_quoting_doubles_single_quotes() {
            let quoted =
                powershell_single_quote(Path::new("C:\\Program Files\\Owner's POS\\app.exe"));
            assert_eq!(quoted, "C:\\Program Files\\Owner''s POS\\app.exe");
        }

        #[test]
        fn firewall_path_removes_windows_verbatim_prefix_before_external_use() {
            let external = firewall_external_path(Path::new(
                r"\\?\C:\Program Files\The Small POS\The Small POS.exe",
            ))
            .expect("convert canonical Windows path");

            assert_eq!(
                external,
                PathBuf::from(r"C:\Program Files\The Small POS\The Small POS.exe")
            );
        }

        #[test]
        fn firewall_status_json_is_fail_closed_and_camel_case() {
            let status: CallerIdFirewallStatus = serde_json::from_str(
                r#"{"supported":true,"configured":false,"privateNetworkActive":false,"publicNetworkActive":true,"networkProfileKnown":true,"publicRulePresent":true}"#,
            )
            .expect("parse status");

            assert!(!status.configured);
            assert!(status.public_network_active);
            assert!(status.public_rule_present);
        }
    }
}

pub async fn inspect(app: AppHandle) -> Result<CallerIdFirewallStatus, String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(move || windows::inspect(&app))
            .await
            .map_err(|error| {
                format!("Caller ID network-access check stopped unexpectedly: {error}")
            })?
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(CallerIdFirewallStatus::unsupported())
    }
}

pub async fn enable(app: AppHandle) -> Result<CallerIdFirewallStatus, String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(move || windows::change(&app, "Install"))
            .await
            .map_err(|error| {
                format!("Caller ID network-access setup stopped unexpectedly: {error}")
            })?
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(CallerIdFirewallStatus::unsupported())
    }
}

pub async fn remove(app: AppHandle) -> Result<CallerIdFirewallStatus, String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(move || windows::change(&app, "Remove"))
            .await
            .map_err(|error| {
                format!("Caller ID network-access removal stopped unexpectedly: {error}")
            })?
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(CallerIdFirewallStatus::unsupported())
    }
}

#[tauri::command]
pub async fn callerid_firewall_status(app: AppHandle) -> Result<CallerIdFirewallStatus, String> {
    inspect(app).await
}

#[tauri::command]
pub async fn callerid_firewall_enable(app: AppHandle) -> Result<CallerIdFirewallStatus, String> {
    enable(app).await
}

#[tauri::command]
pub async fn callerid_firewall_remove(app: AppHandle) -> Result<CallerIdFirewallStatus, String> {
    remove(app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_status_never_claims_network_access() {
        let status = CallerIdFirewallStatus::unsupported();
        assert!(!status.supported);
        assert!(!status.configured);
        assert!(!status.private_network_active);
        assert!(!status.public_rule_present);
    }
}
