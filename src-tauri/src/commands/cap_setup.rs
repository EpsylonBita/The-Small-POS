//! Customer-facing setup assistance for the RBS Cap Driver Service.
//!
//! Founder requirement: a customer must never have to hunt for "CAP Driver" on
//! the web. This module exposes exactly two fixed operations behind one
//! command, `ecr_cap_setup`:
//!
//! * `status` — a read-only Windows query. Is `CapDriverSVC` installed, is it
//!   running, and (if installed) what do the allow-listed fields of its own
//!   `CapDriverSVC.ini` say about the capture folders, the code page and the
//!   cashier it talks to. No X/Z report, no cashier connection, no hardware
//!   command and no reconfiguration happens here.
//! * `open_installer` — verifies or prepares the vendor's own installer and
//!   launches it elevated and *visible*, so the customer completes the vendor's
//!   first-activation screen themselves.
//!
//! Security boundary, deliberately narrow:
//!
//! * The renderer supplies an action string and nothing else. No path, no URL,
//!   no command line, no executable choice crosses the IPC boundary; an
//!   unknown action is rejected before anything is touched.
//! * Config parsing is allow-listed to seven keys. `DEVKEY`, `DEVICEID`,
//!   `CapDriverKey`, serial numbers and any other unlock credential are never
//!   read into the result and never logged — they are not in the allow-list, so
//!   no code path can return them.
//! * Bytes are trusted only by digest, never by location. The pinned archive is
//!   hashed before extraction, and every executable/DLL is re-hashed through a
//!   handle that denies writers and deleters, held across the launch.
//! * An existing installation is never replaced, reconfigured or written to. If
//!   it cannot be verified and opened, the operation fails with an actionable
//!   code instead of staging something over it.
//! * We never install or start the service ourselves, and a successful launch
//!   is reported as "installer launched", never as "installed".

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// The vendor's official package. This exact URL and this exact digest are the
/// only bytes this module will ever execute or compare against. The digest was
/// verified against the copy the founder downloaded by hand.
pub const OFFICIAL_ARCHIVE_URL: &str =
    "https://my.rbs.net.gr/files/protocols/CapDriverService-with-examples.zip";
pub const OFFICIAL_ARCHIVE_SHA256: &str =
    "150fe427533a7e4beda197b760c062ded661411708620fb2173e128edc4b1f25";

#[allow(dead_code)]
const SERVICE_NAME: &str = "CapDriverSVC";
#[allow(dead_code)]
const SERVICE_EXECUTABLE: &str = "CapDriverSVC.exe";
const SERVICE_INI: &str = "CapDriverSVC.ini";
#[allow(dead_code)]
const INSTALLER_EXECUTABLE: &str = "CapDriverServiceInstaller.exe";

/// Everything the vendor ships lives under this single archive directory.
const ARCHIVE_ROOT: &str = "CapDriverService";

/// The four files the service and its installer actually need. These are the
/// only names whose bytes are ever verified, staged or launched.
const ESSENTIAL_FILES: [&str; 4] = [
    "CapDriverMsg.exe",
    "CapDriverServiceInstaller.exe",
    "CapDriverSVC.exe",
    "INIFileParser.dll",
];

/// The package also ships a `FileMover` helper that some installer builds use.
/// It is staged when present — matched by name, never executed by us. Anything
/// else in the archive (examples, docs, demo keys) stays out.
const OPTIONAL_PREFIX: &str = "filemover";
const VENDOR_FILE_MOVER: &str = "CapDriverServiceFileMover.final.exe";

const MAX_DOWNLOAD_BYTES: u64 = 10 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_BYTES: u64 = 24 * 1024 * 1024;
const MAX_INI_BYTES: u64 = 64 * 1024;
#[allow(dead_code)]
const DOWNLOAD_TIMEOUT_SECONDS: u64 = 30;

/// `FILE_ATTRIBUTE_REPARSE_POINT`. Kept platform-neutral so the classifier can
/// be unit tested on any host.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

/// A junction, symlink or mount point anywhere along a path we are about to
/// write into or execute from redirects us somewhere we never validated.
pub fn attributes_are_reparse_point(attributes: u32) -> bool {
    attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

// -- Result contract ---------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapSetupSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    /// `utf-8` or `windows-1253`. Absent whenever the INI has no code page or
    /// names one we do not support, so the UI can never silently assume UTF-8
    /// for fiscal text; `code` says which of the two it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_encoding: Option<String>,
}

impl CapSetupSettings {
    fn is_empty(&self) -> bool {
        self.capture_path.is_none() && self.output_path.is_none() && self.file_encoding.is_none()
    }
}

/// Field names here are deliberately `snake_case`: this object is handed
/// straight to the existing mydata device-setup shape, which stores
/// `serial_port` / `baud_rate`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapSetupTarget {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_port: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baud_rate: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapSetupResult {
    pub success: bool,
    pub platform_supported: bool,
    pub service_installed: bool,
    pub service_running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer_launched: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<CapSetupSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<CapSetupTarget>,
}

impl CapSetupResult {
    #[cfg(any(not(target_os = "windows"), test))]
    fn unsupported() -> Self {
        Self {
            success: false,
            platform_supported: false,
            service_installed: false,
            service_running: false,
            installer_launched: None,
            code: Some("CAP_SETUP_PLATFORM_UNSUPPORTED".into()),
            settings: None,
            target: None,
        }
    }

    /// A second `open_installer` while one is still running. Reports no service
    /// facts at all rather than stale ones.
    fn already_in_progress() -> Self {
        Self {
            success: false,
            platform_supported: cfg!(target_os = "windows"),
            service_installed: false,
            service_running: false,
            installer_launched: Some(false),
            code: Some("CAP_SETUP_ALREADY_IN_PROGRESS".into()),
            settings: None,
            target: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapSetupAction {
    Status,
    OpenInstaller,
}

/// The only renderer-controlled input in this module.
pub fn parse_action(action: &str) -> Result<CapSetupAction, String> {
    match action.trim() {
        "status" => Ok(CapSetupAction::Status),
        "open_installer" => Ok(CapSetupAction::OpenInstaller),
        _ => Err("CAP_SETUP_UNKNOWN_ACTION".into()),
    }
}

// -- Single-flight guard -----------------------------------------------------

static OPEN_INSTALLER_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Held for the whole download/stage/launch sequence. The renderer cannot be
/// trusted to serialise clicks, so concurrency is bounded here: a second call
/// is refused rather than staging or launching twice.
#[derive(Debug)]
pub struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        OPEN_INSTALLER_IN_FLIGHT.store(false, Ordering::Release);
    }
}

pub fn try_begin_open_installer() -> Option<InFlightGuard> {
    OPEN_INSTALLER_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
        .then(|| InFlightGuard)
}

// -- Service snapshot --------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSnapshot {
    pub installed: bool,
    pub running: bool,
    #[serde(default)]
    pub image_path: String,
}

/// Pull the executable out of a Windows service `ImagePath`.
///
/// The vendor registers the service with a plain path, but Windows service
/// image paths may be quoted and may carry arguments, so both forms are
/// handled. Anything that is not a single absolute `.exe` is refused rather
/// than guessed at.
pub fn executable_from_image_path(image_path: &str) -> Option<PathBuf> {
    let trimmed = image_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if let Some(rest) = trimmed.strip_prefix('"') {
        rest.split('"').next().unwrap_or("").to_string()
    } else {
        // Unquoted: arguments start after the `.exe`.
        let lowered = trimmed.to_ascii_lowercase();
        match lowered.find(".exe") {
            Some(index) => trimmed[..index + 4].to_string(),
            None => trimmed.split_whitespace().next().unwrap_or("").to_string(),
        }
    };
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return None;
    }
    let path = PathBuf::from(candidate);
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return None;
    }
    if !path.is_absolute() {
        return None;
    }
    Some(path)
}

/// The directory an installed service actually runs from, or `None` when the
/// registered image path is not something we are willing to reason about.
pub fn installation_directory(snapshot: &ServiceSnapshot) -> Option<PathBuf> {
    if !snapshot.installed {
        return None;
    }
    let executable = executable_from_image_path(&snapshot.image_path)?;
    if !executable
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case(SERVICE_EXECUTABLE))
    {
        return None;
    }
    executable.parent().map(Path::to_path_buf)
}

// -- Configuration parsing ---------------------------------------------------

/// Keys this module is allowed to read. Everything else in the INI —
/// `DEVKEY`, `DEVICEID`, `CapDriverKey`, `Serial Number`, any password — is
/// dropped before it can reach a result, a log line or an error message.
const INI_ALLOWLIST: [&str; 7] = [
    "WORKFOLDER",
    "OUTPUTFOLDER",
    "CODEPAGE",
    "ADR",
    "BAUD",
    "RS232_PORT",
    "COMTYPE",
];

fn trim_ascii_bytes(mut bytes: &[u8]) -> &[u8] {
    while let [first, rest @ ..] = bytes {
        if first.is_ascii_whitespace() {
            bytes = rest;
        } else {
            break;
        }
    }
    while let [rest @ .., last] = bytes {
        if last.is_ascii_whitespace() {
            bytes = rest;
        } else {
            break;
        }
    }
    bytes
}

fn sanitize_text_value(value: &str, max_len: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_len {
        return None;
    }
    if value.chars().any(|ch| ch.is_control()) {
        return None;
    }
    Some(value.to_string())
}

fn normalize_serial_port(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let digits = value
        .strip_prefix("COM")
        .or_else(|| value.strip_prefix("com"))
        .unwrap_or(value);
    let number: u32 = digits.trim().parse().ok()?;
    if number == 0 || number > 256 {
        return None;
    }
    Some(format!("COM{number}"))
}

fn normalize_baud_rate(value: &str) -> Option<u32> {
    let baud: u32 = value.trim().parse().ok()?;
    (300..=921_600).contains(&baud).then_some(baud)
}

fn normalize_code_page(value: &str) -> Result<String, ()> {
    match value.trim().to_ascii_uppercase().as_str() {
        "1253" | "WINDOWS-1253" | "CP1253" => Ok("windows-1253".into()),
        "UTF8" | "UTF-8" | "65001" => Ok("utf-8".into()),
        _ => Err(()),
    }
}

/// What an installed service's own INI tells us, reduced to the allow-listed
/// fields. Returns `(settings, target, code)`.
///
/// The INI is read as bytes on purpose. Its keys are ASCII, but a capture
/// folder can hold Greek characters in a code page we cannot identify from the
/// file alone, and a lossy decode would hand the POS a *different* path than
/// the service uses. Such a value is therefore omitted and reported, never
/// guessed at.
///
/// `code` reports, in this order: an undecodable allow-listed value, then the
/// code page (missing or unsupported — the UI must not assume UTF-8), then the
/// cashier target. `settings.file_encoding` and `target` are independent
/// signals and stay absent whenever their input was not usable.
pub fn parse_service_ini(
    contents: &[u8],
) -> (CapSetupSettings, Option<CapSetupTarget>, Option<String>) {
    let mut settings = CapSetupSettings::default();
    let mut undecodable_value = false;
    let mut code_page: Option<String> = None;
    let mut code_page_unsupported = false;
    let mut com_type: Option<String> = None;
    let mut host: Option<String> = None;
    let mut serial_port: Option<String> = None;
    let mut baud_rate: Option<u32> = None;

    for line in contents.split(|byte| *byte == b'\n') {
        let line = trim_ascii_bytes(line);
        if line.is_empty() || matches!(line[0], b';' | b'#' | b'[') {
            continue;
        }
        let Some(separator) = line.iter().position(|byte| *byte == b'=') else {
            continue;
        };
        let (key_bytes, value_bytes) = (&line[..separator], &line[separator + 1..]);
        let Ok(key) = std::str::from_utf8(key_bytes) else {
            continue; // not an ASCII key, so not one of ours
        };
        let key = key.trim().to_ascii_uppercase();
        if !INI_ALLOWLIST.contains(&key.as_str()) {
            continue;
        }
        // A trailing inline comment is not part of a value.
        let value_bytes = match value_bytes.iter().position(|byte| *byte == b';') {
            Some(index) => &value_bytes[..index],
            None => value_bytes,
        };
        let value_bytes = trim_ascii_bytes(value_bytes);
        let Ok(value) = std::str::from_utf8(value_bytes) else {
            undecodable_value = true;
            continue;
        };
        if !value.is_ascii() {
            undecodable_value = true;
            continue;
        }

        match key.as_str() {
            "WORKFOLDER" => settings.capture_path = sanitize_text_value(value, 260),
            "OUTPUTFOLDER" => settings.output_path = sanitize_text_value(value, 260),
            "CODEPAGE" => {
                if !value.trim().is_empty() {
                    match normalize_code_page(value) {
                        Ok(encoding) => code_page = Some(encoding),
                        Err(()) => code_page_unsupported = true,
                    }
                }
            }
            "ADR" => {
                host = sanitize_text_value(value, 255).filter(|h| !h.contains(char::is_whitespace))
            }
            "BAUD" => baud_rate = normalize_baud_rate(value),
            "RS232_PORT" => serial_port = normalize_serial_port(value),
            "COMTYPE" => com_type = sanitize_text_value(value, 16).map(|v| v.to_ascii_uppercase()),
            _ => {}
        }
    }

    settings.file_encoding = code_page;

    let mut target_issue: Option<&str> = None;
    let target = match com_type.as_deref() {
        // No port is ever guessed for a network cashier: the vendor INI does
        // not carry one and inventing 5000 would point the POS at nothing.
        Some("TCP") | Some("UDP") => match host {
            Some(host) => Some(CapSetupTarget {
                kind: "network".into(),
                host: Some(host),
                serial_port: None,
                baud_rate: None,
            }),
            None => {
                target_issue = Some("CAP_SETUP_TARGET_INCOMPLETE");
                None
            }
        },
        Some("COM") => match serial_port {
            Some(port) => Some(CapSetupTarget {
                kind: "usb_serial".into(),
                host: None,
                serial_port: Some(port),
                baud_rate,
            }),
            None => {
                target_issue = Some("CAP_SETUP_TARGET_INCOMPLETE");
                None
            }
        },
        Some(_) => {
            target_issue = Some("CAP_SETUP_TARGET_UNSUPPORTED");
            None
        }
        None => None,
    };

    let code = if undecodable_value {
        Some("CAP_SETUP_CONFIG_UNSUPPORTED_ENCODING".to_string())
    } else if code_page_unsupported {
        Some("CAP_SETUP_CODEPAGE_UNSUPPORTED".to_string())
    } else if settings.file_encoding.is_none() {
        Some("CAP_SETUP_CODEPAGE_MISSING".to_string())
    } else {
        target_issue.map(str::to_string)
    };

    (settings, target, code)
}

/// Build the `status` result from a service snapshot.
///
/// `read_ini` is only ever called when the service is actually installed: an
/// absent service must not import the demo configuration that ships inside the
/// vendor package (it carries a demo device key and a demo cashier serial).
pub fn status_from_snapshot<F>(snapshot: &ServiceSnapshot, read_ini: F) -> CapSetupResult
where
    F: FnOnce(&Path) -> Result<Vec<u8>, String>,
{
    let mut result = CapSetupResult {
        success: true,
        platform_supported: true,
        service_installed: snapshot.installed,
        service_running: snapshot.running,
        installer_launched: None,
        code: None,
        settings: None,
        target: None,
    };

    if !snapshot.installed {
        result.code = Some("CAP_SETUP_SERVICE_ABSENT".into());
        return result;
    }

    let Some(directory) = installation_directory(snapshot) else {
        result.code = Some("CAP_SETUP_CONFIG_UNREADABLE".into());
        return result;
    };

    match read_ini(&directory.join(SERVICE_INI)) {
        Ok(contents) => {
            let (settings, target, code) = parse_service_ini(&contents);
            result.settings = (!settings.is_empty()).then_some(settings);
            result.target = target;
            result.code = code;
        }
        Err(_) => result.code = Some("CAP_SETUP_CONFIG_UNREADABLE".into()),
    }

    result
}

/// The `status` result when Windows could not answer whether the service
/// exists. An unanswered query is not an absent service, and it must never
/// fall through to reading or importing any configuration.
pub fn status_query_failure(code: &str) -> CapSetupResult {
    CapSetupResult {
        success: false,
        platform_supported: true,
        code: Some(code.to_string()),
        ..CapSetupResult::default()
    }
}

// -- Official package: hashing, reading, staging -----------------------------

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(bytes);
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Hash gate. Runs before a single byte is extracted, compared or executed.
pub fn verify_official_archive(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err("CAP_SETUP_DOWNLOAD_TOO_LARGE".into());
    }
    if sha256_hex(bytes) == OFFICIAL_ARCHIVE_SHA256 {
        Ok(())
    } else {
        Err("CAP_SETUP_ARCHIVE_HASH_MISMATCH".into())
    }
}

/// A symlink inside a package we are about to execute from is never benign, so
/// the entry's Unix file-type bits are checked rather than its permissions.
fn is_symlink_mode(mode: Option<u32>) -> bool {
    mode.is_some_and(|mode| mode & 0o170_000 == 0o120_000)
}

/// Which archive entries are kept, keyed by file name inside
/// `CapDriverService/`. Returns `None` for anything not kept.
fn kept_entry_name(raw_name: &str) -> Option<String> {
    let normalized = raw_name.replace('\\', "/");
    if normalized.contains("..") || normalized.starts_with('/') || normalized.contains(':') {
        return None;
    }
    let mut parts = normalized.split('/').filter(|part| !part.is_empty());
    let root = parts.next()?;
    if !root.eq_ignore_ascii_case(ARCHIVE_ROOT) {
        return None;
    }
    let name = parts.next()?;
    if parts.next().is_some() {
        return None; // the files we keep live directly under the root
    }
    if let Some(essential) = ESSENTIAL_FILES
        .iter()
        .find(|candidate| candidate.eq_ignore_ascii_case(name))
    {
        return Some((*essential).to_string());
    }
    let lowered = name.to_ascii_lowercase();
    if (lowered.starts_with(OPTIONAL_PREFIX) && lowered.ends_with(".exe"))
        || name.eq_ignore_ascii_case(VENDOR_FILE_MOVER)
    {
        return Some(name.to_string());
    }
    None
}

/// A name we are willing to create inside a staging directory: one ordinary
/// file-name component, nothing that could climb, redirect or hide.
fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name != "."
        && name != ".."
        && !name.contains("..")
        && Path::new(name).components().count() == 1
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
}

fn is_sample_ini_name(raw_name: &str) -> bool {
    let normalized = raw_name.replace('\\', "/");
    !normalized.contains("..") && normalized.to_ascii_lowercase().ends_with(".ini")
}

/// The vendor package, held in memory. Nothing here has been written to disk
/// yet, which is what lets the same bytes serve both "verify what is already
/// installed" and "stage a fresh copy".
#[derive(Debug, Clone, Default)]
pub struct OfficialPackage {
    pub files: Vec<(String, Vec<u8>)>,
    /// The vendor's sample INI. It contains demo credentials, so it is only
    /// ever used as a *template* and never written out as-is.
    pub sample_ini: Option<Vec<u8>>,
}

impl OfficialPackage {
    /// `name -> sha256` for every file we keep, including `FileMover` when the
    /// package ships it.
    pub fn digests(&self) -> BTreeMap<String, String> {
        self.files
            .iter()
            .map(|(name, bytes)| (name.clone(), sha256_hex(bytes)))
            .collect()
    }

    /// `name -> sha256` restricted to the four essential files, which is all we
    /// can expect to find in a directory someone else installed.
    pub fn essential_digests(&self) -> BTreeMap<String, String> {
        self.digests()
            .into_iter()
            .filter(|(name, _)| {
                ESSENTIAL_FILES
                    .iter()
                    .any(|essential| essential.eq_ignore_ascii_case(name))
            })
            .collect()
    }
}

pub fn read_official_package(archive: &[u8]) -> Result<OfficialPackage, String> {
    read_official_package_with_limits(archive, MAX_ENTRY_BYTES, MAX_TOTAL_EXTRACTED_BYTES)
}

/// Allow-listed, in-memory read of the vendor archive. Rejects traversal,
/// absolute names, nested paths, symlinks, oversized entries and name
/// collisions; requires all four essential files to be present.
pub fn read_official_package_with_limits(
    archive: &[u8],
    max_entry_bytes: u64,
    max_total_bytes: u64,
) -> Result<OfficialPackage, String> {
    use std::io::Read;

    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|_| "CAP_SETUP_ARCHIVE_UNREADABLE".to_string())?;

    let mut package = OfficialPackage::default();
    let mut sample_is_service_ini = false;
    let mut total: u64 = 0;

    for index in 0..zip.len() {
        // `Read::take` consumes the entry, so no mutable binding is needed.
        let entry = zip
            .by_index(index)
            .map_err(|_| "CAP_SETUP_ARCHIVE_ENTRY_REJECTED".to_string())?;
        let raw_name = entry.name().to_string();

        if is_symlink_mode(entry.unix_mode()) {
            return Err("CAP_SETUP_ARCHIVE_ENTRY_REJECTED".into());
        }
        if entry.is_dir() {
            continue;
        }

        if is_sample_ini_name(&raw_name) && entry.size() <= MAX_INI_BYTES {
            let prefers = Path::new(&raw_name.replace('\\', "/"))
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case(SERVICE_INI));
            if package.sample_ini.is_none() || (prefers && !sample_is_service_ini) {
                // Bounded even if the entry lies about its uncompressed size.
                let mut contents = Vec::new();
                if entry.take(MAX_INI_BYTES).read_to_end(&mut contents).is_ok() {
                    package.sample_ini = Some(contents);
                    sample_is_service_ini = prefers;
                }
            }
            continue;
        }

        let Some(name) = kept_entry_name(&raw_name) else {
            continue;
        };
        if !is_safe_file_name(&name) {
            return Err("CAP_SETUP_ARCHIVE_ENTRY_REJECTED".into());
        }
        if entry.size() > max_entry_bytes {
            return Err("CAP_SETUP_ARCHIVE_ENTRY_REJECTED".into());
        }
        total = total.saturating_add(entry.size());
        if total > max_total_bytes {
            return Err("CAP_SETUP_ARCHIVE_ENTRY_REJECTED".into());
        }
        if package
            .files
            .iter()
            .any(|(existing, _)| existing.eq_ignore_ascii_case(&name))
        {
            return Err("CAP_SETUP_ARCHIVE_ENTRY_REJECTED".into());
        }

        let mut contents = Vec::with_capacity(entry.size() as usize);
        entry
            .take(max_entry_bytes + 1)
            .read_to_end(&mut contents)
            .map_err(|_| "CAP_SETUP_ARCHIVE_ENTRY_REJECTED".to_string())?;
        if contents.len() as u64 > max_entry_bytes {
            return Err("CAP_SETUP_ARCHIVE_ENTRY_REJECTED".into());
        }
        package.files.push((name, contents));
    }

    if !ESSENTIAL_FILES.iter().all(|essential| {
        package
            .files
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case(essential))
    }) {
        return Err("CAP_SETUP_ARCHIVE_INCOMPLETE".into());
    }

    Ok(package)
}

/// Compare what a directory actually contains with the pinned package. Every
/// expected file must be present with the exact expected digest; location is
/// never treated as integrity.
pub fn verify_digests(
    expected: &BTreeMap<String, String>,
    actual: &BTreeMap<String, String>,
) -> Result<(), String> {
    for (name, digest) in expected {
        match actual.get(name) {
            Some(found) if found == digest => {}
            _ => return Err("CAP_SETUP_EXISTING_INSTALL_UNVERIFIED".into()),
        }
    }
    Ok(())
}

/// Keys whose values must never be carried over from the vendor's sample INI.
/// The sample ships a working demo device key and a demo cashier serial;
/// installing those would point a customer's POS at the vendor's demo identity.
const SECRET_INI_KEYS: [&str; 8] = [
    "DEVKEY",
    "DEVICEID",
    "DEVICEKEY",
    "CAPDRIVERKEY",
    "SERIAL",
    "SERIALNUMBER",
    "SERIAL_NUMBER",
    "PASSWORD",
];

/// Target fields that must start blank. The sample's demo IP would otherwise
/// look like a configured cashier; the customer picks the real target in the
/// vendor's own screen.
const BLANK_INI_KEYS: [&str; 3] = ["ADR", "RS232_PORT", "COMTYPE"];

/// A first-run configuration derived from the vendor sample: same structure and
/// key names, credentials and target blanked, folders and code page set to our
/// defaults. Without a usable sample, a minimal INI is generated instead.
///
/// This is only ever written into a *fresh staging directory*. An existing
/// configuration is never touched.
pub fn sanitized_default_ini(sample: Option<&str>) -> String {
    let defaults = [
        ("WORKFOLDER", "C:\\Capture\\"),
        ("OUTPUTFOLDER", "C:\\Capture\\Output\\"),
        ("CODEPAGE", "UTF8"),
    ];

    let Some(sample) = sample else {
        return format!(
            "[{ARCHIVE_ROOT}]\r\nWORKFOLDER=C:\\Capture\\\r\nOUTPUTFOLDER=C:\\Capture\\Output\\\r\nCODEPAGE=UTF8\r\nCOMTYPE=\r\nADR=\r\nRS232_PORT=\r\nDEVKEY=\r\nDEVICEID=\r\n"
        );
    };

    let mut out = String::with_capacity(sample.len());
    for line in sample.lines() {
        let trimmed = line.trim();
        if let Some((raw_key, _)) = trimmed.split_once('=') {
            let key = raw_key.trim().to_ascii_uppercase();
            if SECRET_INI_KEYS.contains(&key.as_str()) || BLANK_INI_KEYS.contains(&key.as_str()) {
                out.push_str(&format!("{}=\r\n", raw_key.trim()));
                continue;
            }
            if let Some((_, value)) = defaults
                .iter()
                .find(|(default_key, _)| *default_key == key.as_str())
            {
                out.push_str(&format!("{}={}\r\n", raw_key.trim(), value));
                continue;
            }
        }
        out.push_str(trimmed);
        out.push_str("\r\n");
    }
    out
}

/// `%ProgramData%`, accepted only in the one shape Windows actually uses. An
/// arbitrary environment override must not be able to redirect staging, so
/// anything that is not `<drive>:\ProgramData` falls back to the system default.
pub fn validated_program_data(candidate: Option<&str>) -> PathBuf {
    let fallback = PathBuf::from("C:\\ProgramData");
    let Some(candidate) = candidate else {
        return fallback;
    };
    let trimmed = candidate.trim().trim_end_matches(['\\', '/']);
    let mut characters = trimmed.chars();
    let drive = characters.next();
    let matches_shape = drive.is_some_and(|drive| drive.is_ascii_alphabetic())
        && characters.next() == Some(':')
        && matches!(characters.next(), Some('\\') | Some('/'))
        && characters.as_str().eq_ignore_ascii_case("ProgramData");
    if !matches_shape {
        return fallback;
    }
    PathBuf::from(format!("{}:\\ProgramData", drive.unwrap()))
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase().replace('/', "\\")
}

/// Staging must never overlap an installation, in either direction: we do not
/// write next to a customer's installed binaries, and we never treat our own
/// staging area as an installation.
pub fn staging_conflicts_with_installation(staging: &Path, installation: Option<&Path>) -> bool {
    let Some(installation) = installation else {
        return false;
    };
    let staging = path_key(staging);
    let installation = path_key(installation);
    staging == installation
        || staging.starts_with(&format!("{installation}\\"))
        || installation.starts_with(&format!("{staging}\\"))
}

// -- Windows implementation --------------------------------------------------

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::ffi::OsStr;
    use std::fs::File;
    use std::io::Read;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED, HANDLE},
        System::Threading::{WaitForSingleObject, INFINITE},
        UI::{
            Shell::{
                ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
            },
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    /// Share readers only: writers and deleters are refused for as long as we
    /// hold the handle, which is what makes "verified bytes" still true at the
    /// moment Windows starts the process.
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    /// The probe's own exit code for "Windows could not answer", kept in sync
    /// with `STATUS_SCRIPT` by test.
    #[allow(dead_code)]
    const SERVICE_QUERY_EXIT_FAILED: i32 = 21;

    /// Fixed, no-interpolation PowerShell probe. Read-only: it asks Windows
    /// whether the service exists, whether it is running and where its binary
    /// lives. It never touches the cashier and never changes the service.
    ///
    /// `Stop` plus an explicit non-zero exit keeps a *failed* CIM query
    /// distinguishable from a service that is legitimately absent (a filter
    /// that matches nothing is not an error).
    const STATUS_SCRIPT: &str = concat!(
        "$ErrorActionPreference='Stop';",
        "try {",
        " $s = Get-CimInstance -ClassName Win32_Service -Filter \"Name='CapDriverSVC'\" -ErrorAction Stop;",
        " if ($null -eq $s) { Write-Output '{\"installed\":false,\"running\":false,\"imagePath\":\"\"}' }",
        " else { Write-Output (ConvertTo-Json -Compress -InputObject ([ordered]@{",
        " installed=$true; running=($s.State -eq 'Running'); imagePath=[string]$s.PathName })) }",
        " exit 0",
        "} catch { exit 21 }"
    );

    fn powershell() -> Result<PathBuf, String> {
        let system_root = std::env::var_os("SystemRoot")
            .ok_or_else(|| "CAP_SETUP_SERVICE_QUERY_FAILED".to_string())?;
        let path = PathBuf::from(system_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if !path.is_file() {
            return Err("CAP_SETUP_SERVICE_QUERY_FAILED".into());
        }
        Ok(path)
    }

    fn encoded_command(script: &str) -> String {
        let utf16le = script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        STANDARD.encode(utf16le)
    }

    pub(super) fn query_service() -> Result<ServiceSnapshot, String> {
        let output = Command::new(powershell()?)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
            ])
            .arg(encoded_command(STATUS_SCRIPT))
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|_| "CAP_SETUP_SERVICE_QUERY_FAILED".to_string())?;
        if !output.status.success() {
            return Err("CAP_SETUP_SERVICE_QUERY_FAILED".into());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str::<ServiceSnapshot>(stdout.trim())
            .map_err(|_| "CAP_SETUP_SERVICE_QUERY_FAILED".to_string())
    }

    fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
        metadata.file_type().is_symlink()
            || attributes_are_reparse_point(metadata.file_attributes())
    }

    /// Every ancestor that exists must be a plain directory. Checking only the
    /// leaf would leave a junction higher up free to redirect the whole path.
    fn ensure_safe_ancestry(path: &Path) -> Result<(), String> {
        let mut ancestors: Vec<&Path> = path.ancestors().skip(1).collect();
        ancestors.reverse();
        for ancestor in ancestors {
            match std::fs::symlink_metadata(ancestor) {
                Ok(metadata) => {
                    if is_reparse_point(&metadata) || !metadata.is_dir() {
                        return Err("CAP_SETUP_PATH_UNSAFE".into());
                    }
                }
                // A component that does not exist yet is created by us below.
                Err(_) => continue,
            }
        }
        Ok(())
    }

    /// An existing regular file, reached through plain directories, with no
    /// reparse point on the path or the file itself. This is a structural
    /// check; it makes no claim about who may write the file, which is why the
    /// bytes are also hashed through a handle that denies writers.
    fn safe_existing_file(path: &Path) -> Result<PathBuf, String> {
        ensure_safe_ancestry(path)?;
        let metadata = std::fs::symlink_metadata(path).map_err(|_| "CAP_SETUP_PATH_UNSAFE")?;
        if is_reparse_point(&metadata) || !metadata.is_file() {
            return Err("CAP_SETUP_PATH_UNSAFE".into());
        }
        let canonical = path.canonicalize().map_err(|_| "CAP_SETUP_PATH_UNSAFE")?;
        if !canonical.is_file() {
            return Err("CAP_SETUP_PATH_UNSAFE".into());
        }
        Ok(dunce::simplified(&canonical).to_path_buf())
    }

    fn read_service_ini(path: &Path) -> Result<Vec<u8>, String> {
        let path = safe_existing_file(path)?;
        let metadata = std::fs::metadata(&path).map_err(|_| "CAP_SETUP_CONFIG_UNREADABLE")?;
        if metadata.len() > MAX_INI_BYTES {
            return Err("CAP_SETUP_CONFIG_UNREADABLE".into());
        }
        std::fs::read(&path).map_err(|_| "CAP_SETUP_CONFIG_UNREADABLE".into())
    }

    pub(super) fn status() -> Result<CapSetupResult, String> {
        match query_service() {
            Ok(snapshot) => Ok(status_from_snapshot(&snapshot, read_service_ini)),
            Err(code) => Ok(status_query_failure(&code)),
        }
    }

    /// A file we have hashed and are keeping locked. Dropping the handle
    /// releases the lock, so these are held until after the launch returns.
    #[derive(Debug)]
    struct LockedFile {
        path: PathBuf,
        digest: String,
        #[allow(dead_code)]
        handle: File,
    }

    fn open_locked_and_digest(path: &Path) -> Result<LockedFile, String> {
        let path = safe_existing_file(path)?;
        let mut handle = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&path)
            .map_err(|_| "CAP_SETUP_EXISTING_INSTALL_UNVERIFIED".to_string())?;
        let mut bytes = Vec::new();
        (&mut handle)
            .take(MAX_ENTRY_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "CAP_SETUP_EXISTING_INSTALL_UNVERIFIED".to_string())?;
        if bytes.len() as u64 > MAX_ENTRY_BYTES {
            return Err("CAP_SETUP_EXISTING_INSTALL_UNVERIFIED".into());
        }
        Ok(LockedFile {
            digest: sha256_hex(&bytes),
            path,
            handle,
        })
    }

    /// Hash and lock every expected file in `directory`, then compare the
    /// result with the pinned package. Nothing in `directory` is written,
    /// renamed or removed.
    fn verify_and_lock(
        directory: &Path,
        expected: &BTreeMap<String, String>,
    ) -> Result<Vec<LockedFile>, String> {
        ensure_safe_ancestry(directory)?;
        let metadata = std::fs::symlink_metadata(directory).map_err(|_| "CAP_SETUP_PATH_UNSAFE")?;
        if is_reparse_point(&metadata) || !metadata.is_dir() {
            return Err("CAP_SETUP_PATH_UNSAFE".into());
        }

        let mut locked = Vec::new();
        let mut actual = BTreeMap::new();
        for name in expected.keys() {
            if !is_safe_file_name(name) {
                return Err("CAP_SETUP_PATH_UNSAFE".into());
            }
            let file = open_locked_and_digest(&directory.join(name))?;
            actual.insert(name.clone(), file.digest.clone());
            locked.push(file);
        }
        verify_digests(expected, &actual)?;
        Ok(locked)
    }

    /// `C:\ProgramData\TheSmall\CapDriver` — a stable location outside any
    /// installation, with no spaces, which the vendor's installer requires.
    fn staging_root() -> PathBuf {
        let program_data = std::env::var("ProgramData").ok();
        validated_program_data(program_data.as_deref())
            .join("TheSmall")
            .join("CapDriver")
    }

    /// A brand-new staging directory. Nothing is ever deleted here: an
    /// enumerated `stage-*` path could be an active installer's working copy,
    /// so previous attempts are left alone rather than recursively removed.
    fn fresh_staging_directory(installation: Option<&Path>) -> Result<PathBuf, String> {
        let root = staging_root();
        if root.to_string_lossy().contains(' ') {
            return Err("CAP_SETUP_STAGING_FAILED".into());
        }
        ensure_safe_ancestry(&root)?;
        create_directory_chain(&root)?;

        let directory = root.join(format!("stage-{}", uuid::Uuid::new_v4().as_simple()));
        if directory.to_string_lossy().contains(' ') {
            return Err("CAP_SETUP_STAGING_FAILED".into());
        }
        if staging_conflicts_with_installation(&directory, installation) {
            return Err("CAP_SETUP_STAGING_FAILED".into());
        }
        std::fs::create_dir(&directory).map_err(|_| "CAP_SETUP_STAGING_FAILED".to_string())?;
        let metadata =
            std::fs::symlink_metadata(&directory).map_err(|_| "CAP_SETUP_STAGING_FAILED")?;
        if is_reparse_point(&metadata) || !metadata.is_dir() {
            return Err("CAP_SETUP_PATH_UNSAFE".into());
        }
        Ok(directory)
    }

    /// Create each missing component, re-checking as we go so a component that
    /// appears mid-way cannot be a redirect.
    fn create_directory_chain(path: &Path) -> Result<(), String> {
        let mut ancestors: Vec<&Path> = path.ancestors().collect();
        ancestors.reverse();
        for ancestor in ancestors {
            if ancestor.as_os_str().is_empty() {
                continue;
            }
            match std::fs::symlink_metadata(ancestor) {
                Ok(metadata) => {
                    if is_reparse_point(&metadata) || !metadata.is_dir() {
                        return Err("CAP_SETUP_PATH_UNSAFE".into());
                    }
                }
                Err(_) => {
                    if std::fs::create_dir(ancestor).is_err() && !ancestor.is_dir() {
                        return Err("CAP_SETUP_STAGING_FAILED".into());
                    }
                    let metadata = std::fs::symlink_metadata(ancestor)
                        .map_err(|_| "CAP_SETUP_STAGING_FAILED")?;
                    if is_reparse_point(&metadata) || !metadata.is_dir() {
                        return Err("CAP_SETUP_PATH_UNSAFE".into());
                    }
                }
            }
        }
        Ok(())
    }

    fn write_new_file(directory: &Path, name: &str, contents: &[u8]) -> Result<PathBuf, String> {
        use std::io::Write;

        if !is_safe_file_name(name) {
            return Err("CAP_SETUP_STAGING_FAILED".into());
        }
        let target = directory.join(name);
        if target.parent() != Some(directory) {
            return Err("CAP_SETUP_STAGING_FAILED".into());
        }
        // Write under a temporary name and rename into place, so a partially
        // written executable is never visible under its real name.
        let pending = directory.join(format!("{name}.part"));
        let mut handle = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(FILE_SHARE_READ)
            .open(&pending)
            .map_err(|_| "CAP_SETUP_STAGING_FAILED".to_string())?;
        handle
            .write_all(contents)
            .and_then(|()| handle.sync_all())
            .map_err(|_| "CAP_SETUP_STAGING_FAILED".to_string())?;
        drop(handle);
        std::fs::rename(&pending, &target).map_err(|_| "CAP_SETUP_STAGING_FAILED".to_string())?;
        Ok(target)
    }

    /// The first-run INI. `create_new` means an existing configuration can
    /// never be overwritten, and a failure here fails the whole operation
    /// rather than launching an installer with no configuration to save.
    fn write_sanitized_ini(directory: &Path, sample: Option<&[u8]>) -> Result<PathBuf, String> {
        use std::io::Write;

        // A sample we cannot decode is discarded rather than guessed at; the
        // built-in template covers that case.
        let template = sample.and_then(|bytes| std::str::from_utf8(bytes).ok());
        let contents = sanitized_default_ini(template);
        let target = directory.join(SERVICE_INI);
        if target.parent() != Some(directory) {
            return Err("CAP_SETUP_CONFIG_WRITE_FAILED".into());
        }
        let mut handle = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(FILE_SHARE_READ)
            .open(&target)
            .map_err(|_| "CAP_SETUP_CONFIG_WRITE_FAILED".to_string())?;
        handle
            .write_all(contents.as_bytes())
            .and_then(|()| handle.sync_all())
            .map_err(|_| "CAP_SETUP_CONFIG_WRITE_FAILED".to_string())?;
        Ok(target)
    }

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Launch the vendor installer elevated and *visible*: the customer has to
    /// see and complete the vendor's own activation screen. We do not wait for
    /// it, we pass it no arguments, and we never report installation from a
    /// launch.
    fn launch_elevated(installer: &Path) -> Result<HANDLE, String> {
        let verb = wide_null(OsStr::new("runas"));
        let file = wide_null(installer.as_os_str());
        let directory = installer
            .parent()
            .map(|parent| wide_null(parent.as_os_str()));

        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = ptr::null();
        info.lpDirectory = directory
            .as_ref()
            .map_or(ptr::null(), |value| value.as_ptr());
        info.nShow = SW_SHOWNORMAL;

        let launched = unsafe { ShellExecuteExW(&mut info) };
        if launched == 0 {
            let code = unsafe { GetLastError() };
            return Err(if code == ERROR_CANCELLED {
                "CAP_SETUP_UAC_CANCELLED".to_string()
            } else {
                "CAP_SETUP_LAUNCH_FAILED".to_string()
            });
        }
        if info.hProcess.is_null() {
            return Err("CAP_SETUP_LAUNCH_UNTRACKED".into());
        }
        Ok(info.hProcess)
    }

    /// Keep verified files and the process alive until the installer closes.
    /// The caller reports the launch first, then waits on its background thread.
    pub(super) struct ActiveInstaller {
        process: HANDLE,
        _locked: Vec<LockedFile>,
    }

    impl ActiveInstaller {
        pub(super) fn wait_until_exit(self) {
            unsafe {
                WaitForSingleObject(self.process, INFINITE);
            }
        }
    }

    impl Drop for ActiveInstaller {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.process);
            }
        }
    }

    fn download_official_archive() -> Result<Vec<u8>, String> {
        if !OFFICIAL_ARCHIVE_URL.starts_with("https://") {
            return Err("CAP_SETUP_DOWNLOAD_FAILED".into());
        }
        let client = reqwest::blocking::Client::builder()
            .https_only(true)
            // A redirect leaves the origin we pinned, so it is refused rather
            // than followed.
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECONDS))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|_| "CAP_SETUP_DOWNLOAD_FAILED".to_string())?;
        let response = client
            .get(OFFICIAL_ARCHIVE_URL)
            .send()
            .map_err(|_| "CAP_SETUP_DOWNLOAD_FAILED".to_string())?;
        if response.status().is_redirection() {
            return Err("CAP_SETUP_REDIRECT_REJECTED".into());
        }
        if !response.status().is_success() {
            return Err("CAP_SETUP_DOWNLOAD_FAILED".into());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_DOWNLOAD_BYTES)
        {
            return Err("CAP_SETUP_DOWNLOAD_TOO_LARGE".into());
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_DOWNLOAD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "CAP_SETUP_DOWNLOAD_FAILED".to_string())?;
        if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err("CAP_SETUP_DOWNLOAD_TOO_LARGE".into());
        }
        Ok(bytes)
    }

    /// Verify an existing installation and hand back its installer, or stage a
    /// fresh official copy. Either way the launched file has been hashed
    /// against the pinned package and is locked against writers.
    fn prepare_installer(
        installation: Option<&Path>,
    ) -> Result<(PathBuf, Vec<LockedFile>), String> {
        let archive = download_official_archive()?;
        verify_official_archive(&archive)?;
        let package = read_official_package(&archive)?;

        if let Some(installation) = installation {
            // An installed service is never replaced or reconfigured: if its
            // own files do not match the official package, we report that and
            // stop instead of staging something alongside it.
            let mut expected = package.essential_digests();
            // Older installations may omit the helper, but any copy that is
            // present must be verified before the installer could execute it.
            for (name, digest) in package.digests() {
                if installation
                    .join(&name)
                    .try_exists()
                    .map_err(|_| "CAP_SETUP_PATH_UNSAFE")?
                {
                    expected.insert(name, digest);
                }
            }
            let locked = verify_and_lock(installation, &expected)?;
            let installer = locked
                .iter()
                .find(|file| {
                    file.path
                        .file_name()
                        .is_some_and(|name| name.eq_ignore_ascii_case(INSTALLER_EXECUTABLE))
                })
                .map(|file| file.path.clone())
                .ok_or_else(|| "CAP_SETUP_EXISTING_INSTALL_UNVERIFIED".to_string())?;
            return Ok((installer, locked));
        }

        let directory = fresh_staging_directory(installation)?;
        for (name, contents) in &package.files {
            write_new_file(&directory, name, contents)?;
        }
        write_sanitized_ini(&directory, package.sample_ini.as_deref())?;
        // Re-hash from disk through locked handles immediately before launch.
        let locked = verify_and_lock(&directory, &package.digests())?;
        let installer = directory.join(INSTALLER_EXECUTABLE);
        Ok((safe_existing_file(&installer)?, locked))
    }

    pub(super) fn open_installer() -> Result<(CapSetupResult, Option<ActiveInstaller>), String> {
        let snapshot = query_service();
        let mut result = CapSetupResult {
            success: false,
            platform_supported: true,
            service_installed: snapshot.as_ref().is_ok_and(|snapshot| snapshot.installed),
            service_running: snapshot.as_ref().is_ok_and(|snapshot| snapshot.running),
            installer_launched: Some(false),
            code: None,
            settings: None,
            target: None,
        };

        // An unanswered service query is not an absent service: acting on it
        // could stage over a real installation.
        let snapshot = match snapshot {
            Ok(snapshot) => snapshot,
            Err(code) => {
                result.code = Some(code);
                return Ok((result, None));
            }
        };
        if snapshot.installed && installation_directory(&snapshot).is_none() {
            result.code = Some("CAP_SETUP_EXISTING_INSTALL_UNVERIFIED".into());
            return Ok((result, None));
        }
        let installation = installation_directory(&snapshot);

        let (installer, locked) = match prepare_installer(installation.as_deref()) {
            Ok(prepared) => prepared,
            Err(code) => {
                result.code = Some(code);
                return Ok((result, None));
            }
        };

        match launch_elevated(&installer) {
            Ok(process) => {
                result.success = true;
                result.installer_launched = Some(true);
                result.code = Some("CAP_SETUP_INSTALLER_LAUNCHED".into());
                return Ok((
                    result,
                    Some(ActiveInstaller {
                        process,
                        _locked: locked,
                    }),
                ));
            }
            Err(code) => result.code = Some(code),
        }
        drop(locked);
        Ok((result, None))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_status_probe_is_read_only_and_names_one_fixed_service() {
            assert!(STATUS_SCRIPT.contains("Get-CimInstance"));
            assert!(STATUS_SCRIPT.contains(SERVICE_NAME));
            for forbidden in [
                "Start-Service",
                "Stop-Service",
                "New-Service",
                "Set-Service",
                "Invoke-Expression",
                "Remove-Item",
            ] {
                assert!(
                    !STATUS_SCRIPT.contains(forbidden),
                    "status probe must not be able to {forbidden}"
                );
            }
        }

        #[test]
        fn a_failed_service_query_exits_nonzero_instead_of_reporting_absence() {
            assert!(STATUS_SCRIPT.contains("$ErrorActionPreference='Stop'"));
            assert!(STATUS_SCRIPT.contains("-ErrorAction Stop"));
            assert!(STATUS_SCRIPT.contains(&format!("exit {SERVICE_QUERY_EXIT_FAILED}")));
            assert!(!STATUS_SCRIPT.contains("SilentlyContinue"));
            // A filter that matches nothing is a legitimate "absent" answer.
            assert!(STATUS_SCRIPT.contains("$null -eq $s"));
        }

        #[test]
        fn the_encoded_probe_round_trips_without_shell_quoting() {
            let decoded = STANDARD
                .decode(encoded_command(STATUS_SCRIPT))
                .expect("decode probe");
            let utf16 = decoded
                .chunks_exact(2)
                .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                .collect::<Vec<_>>();
            assert_eq!(String::from_utf16(&utf16).expect("utf16"), STATUS_SCRIPT);
        }

        #[test]
        fn the_staging_root_is_fixed_and_free_of_spaces() {
            let root = staging_root();
            assert!(!root.to_string_lossy().contains(' '));
            assert!(root.ends_with("TheSmall\\CapDriver") || root.ends_with("TheSmall/CapDriver"));
            assert!(root.starts_with(validated_program_data(
                std::env::var("ProgramData").ok().as_deref()
            )));
        }

        #[test]
        fn an_ancestor_that_is_a_file_makes_the_whole_path_unsafe() {
            let directory = super::super::tests::temp_dir("ancestry");
            let file = directory.join("not-a-directory");
            std::fs::write(&file, b"x").expect("seed file");
            assert_eq!(
                ensure_safe_ancestry(&file.join("child").join("leaf.exe")).unwrap_err(),
                "CAP_SETUP_PATH_UNSAFE"
            );
            assert!(ensure_safe_ancestry(&directory.join("leaf.exe")).is_ok());
            let _ = std::fs::remove_dir_all(&directory);
        }

        #[test]
        fn a_directory_of_plain_components_is_created_and_accepted() {
            let directory = super::super::tests::temp_dir("chain");
            let nested = directory.join("TheSmall").join("CapDriver");
            create_directory_chain(&nested).expect("create chain");
            assert!(nested.is_dir());
            create_directory_chain(&nested).expect("idempotent");
            let _ = std::fs::remove_dir_all(&directory);
        }

        #[test]
        fn a_tampered_file_is_refused_and_never_unlocked_for_launch() {
            let directory = super::super::tests::temp_dir("tamper");
            std::fs::write(directory.join("CapDriverSVC.exe"), b"service").expect("seed");
            let mut expected = BTreeMap::new();
            expected.insert("CapDriverSVC.exe".to_string(), sha256_hex(b"service"));
            assert!(verify_and_lock(&directory, &expected).is_ok());

            std::fs::write(directory.join("CapDriverSVC.exe"), b"swapped").expect("tamper");
            assert_eq!(
                verify_and_lock(&directory, &expected).unwrap_err(),
                "CAP_SETUP_EXISTING_INSTALL_UNVERIFIED"
            );
            let _ = std::fs::remove_dir_all(&directory);
        }

        #[test]
        fn a_missing_file_is_refused_rather_than_treated_as_verified() {
            let directory = super::super::tests::temp_dir("missing");
            let mut expected = BTreeMap::new();
            expected.insert("CapDriverSVC.exe".to_string(), sha256_hex(b"service"));
            assert_eq!(
                verify_and_lock(&directory, &expected).unwrap_err(),
                "CAP_SETUP_PATH_UNSAFE"
            );
            let _ = std::fs::remove_dir_all(&directory);
        }

        #[test]
        fn an_existing_configuration_is_never_overwritten_and_the_failure_is_reported() {
            let directory = super::super::tests::temp_dir("ini");
            let existing = b"[CapDriverService]\r\nDEVKEY=real-customer-key\r\n";
            std::fs::write(directory.join(SERVICE_INI), existing).expect("seed config");

            assert_eq!(
                write_sanitized_ini(&directory, None).unwrap_err(),
                "CAP_SETUP_CONFIG_WRITE_FAILED"
            );
            assert_eq!(
                std::fs::read(directory.join(SERVICE_INI)).expect("read back"),
                existing
            );
            let _ = std::fs::remove_dir_all(&directory);
        }

        #[test]
        fn a_first_run_configuration_is_written_once_into_a_fresh_directory() {
            let directory = super::super::tests::temp_dir("ini-fresh");
            let written = write_sanitized_ini(&directory, None).expect("write config");
            let contents = std::fs::read(&written).expect("read config");
            let (settings, target, code) = parse_service_ini(&contents);
            assert_eq!(settings.file_encoding.as_deref(), Some("utf-8"));
            assert!(target.is_none());
            assert_eq!(code, None);
            let _ = std::fs::remove_dir_all(&directory);
        }

        #[test]
        fn an_undecodable_configuration_is_reported_instead_of_being_read_lossily() {
            let directory = super::super::tests::temp_dir("ini-bytes");
            // WORKFOLDER in code page 1253, which we cannot identify from the
            // file alone.
            let mut contents = b"WORKFOLDER=C:\\".to_vec();
            contents.extend_from_slice(&[0xC1, 0xC2, 0xC3]);
            contents.extend_from_slice(b"\\\r\nCODEPAGE=1253\r\n");
            std::fs::write(directory.join(SERVICE_INI), &contents).expect("seed config");

            let read = read_service_ini(&directory.join(SERVICE_INI)).expect("read config");
            let (settings, _, code) = parse_service_ini(&read);
            assert!(settings.capture_path.is_none());
            assert_eq!(
                code.as_deref(),
                Some("CAP_SETUP_CONFIG_UNSUPPORTED_ENCODING")
            );
            let _ = std::fs::remove_dir_all(&directory);
        }

        #[test]
        fn staged_files_are_written_only_under_safe_single_component_names() {
            let directory = super::super::tests::temp_dir("write-name");
            assert!(write_new_file(&directory, "CapDriverSVC.exe", b"service").is_ok());
            for hostile in [
                "../escaped.exe",
                "sub\\nested.exe",
                "C:\\absolute.exe",
                "..",
            ] {
                assert_eq!(
                    write_new_file(&directory, hostile, b"x").unwrap_err(),
                    "CAP_SETUP_STAGING_FAILED",
                    "{hostile} must not be written"
                );
            }
            let _ = std::fs::remove_dir_all(&directory);
        }
    }
}

// -- Command -----------------------------------------------------------------

/// Deliver launch status promptly, retaining the launch permit while its UI
/// remains open. Waiting happens on the existing native worker thread.
fn finish_setup_worker<T>(
    result: T,
    report: impl FnOnce(T),
    wait_for_exit: impl FnOnce(),
    guard: Option<InFlightGuard>,
) {
    report(result);
    wait_for_exit();
    drop(guard);
}

async fn run(action: CapSetupAction) -> Result<CapSetupResult, String> {
    // Single-flight before anything else: two clicks must not download, stage
    // or launch twice.
    let guard = match action {
        CapSetupAction::Status => None,
        CapSetupAction::OpenInstaller => match try_begin_open_installer() {
            Some(guard) => Some(guard),
            None => return Ok(CapSetupResult::already_in_progress()),
        },
    };

    #[cfg(target_os = "windows")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        // A dedicated OS thread: `reqwest::blocking` panics if it is built or
        // driven from inside a Tokio runtime context, including a
        // `spawn_blocking` worker.
        std::thread::Builder::new()
            .name("cap-setup".into())
            .spawn(move || {
                let (outcome, installer) = match action {
                    CapSetupAction::Status => (windows_impl::status(), None),
                    CapSetupAction::OpenInstaller => match windows_impl::open_installer() {
                        Ok((result, installer)) => (Ok(result), installer),
                        Err(error) => (Err(error), None),
                    },
                };
                finish_setup_worker(
                    outcome,
                    |result| {
                        let _ = tx.send(result);
                    },
                    || {
                        if let Some(installer) = installer {
                            installer.wait_until_exit();
                        }
                    },
                    guard,
                );
            })
            .map_err(|_| "CAP_SETUP_WORKER_FAILED".to_string())?;
        rx.await
            .map_err(|_| "CAP_SETUP_WORKER_FAILED".to_string())?
    }

    #[cfg(not(target_os = "windows"))]
    {
        drop(guard);
        Ok(CapSetupResult::unsupported())
    }
}

/// `bridge.ecr.capSetup(action)`. The renderer sends only the action string.
#[tauri::command]
pub async fn ecr_cap_setup(arg0: Option<String>) -> Result<CapSetupResult, String> {
    let action = parse_action(arg0.as_deref().unwrap_or_default())?;
    run(action).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, contents) in entries {
                writer.start_file(*name, options).expect("start entry");
                writer.write_all(contents).expect("write entry");
            }
            writer.finish().expect("finish archive");
        }
        buffer
    }

    fn official_layout() -> Vec<(&'static str, &'static [u8])> {
        vec![
            ("CapDriverService/CapDriverMsg.exe", b"msg" as &[u8]),
            (
                "CapDriverService/CapDriverServiceInstaller.exe",
                b"installer",
            ),
            ("CapDriverService/CapDriverSVC.exe", b"service"),
            ("CapDriverService/INIFileParser.dll", b"parser"),
        ]
    }

    pub(super) fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "cap-setup-{label}-{}",
            uuid::Uuid::new_v4().as_simple()
        ));
        std::fs::create_dir_all(&path).expect("temp dir");
        path
    }

    const SAMPLE_INI: &str = "[CapDriverService]\r\n\
WORKFOLDER=C:\\Capture\\\r\n\
OUTPUTFOLDER=C:\\Capture\\Output\\\r\n\
CODEPAGE=1253\r\n\
COMTYPE=TCP\r\n\
ADR=192.168.1.50\r\n\
BAUD=9600\r\n\
RS232_PORT=COM3\r\n\
DEVKEY=059560323478\r\n\
DEVICEID=CFB66000001\r\n\
SERIALNUMBER=CFB66000001\r\n\
PASSWORD=your_test_password\r\n";

    // -- Action surface ------------------------------------------------------

    #[test]
    fn only_the_two_documented_actions_are_accepted() {
        assert_eq!(parse_action("status").unwrap(), CapSetupAction::Status);
        assert_eq!(
            parse_action("open_installer").unwrap(),
            CapSetupAction::OpenInstaller
        );
        for unknown in [
            "",
            "install",
            "start_service",
            "STATUS",
            "open_installer;calc.exe",
        ] {
            assert_eq!(
                parse_action(unknown).unwrap_err(),
                "CAP_SETUP_UNKNOWN_ACTION",
                "{unknown} must be rejected"
            );
        }
    }

    #[tokio::test]
    async fn the_command_rejects_an_unknown_action_before_touching_the_system() {
        assert_eq!(
            ecr_cap_setup(Some("import_config".into()))
                .await
                .unwrap_err(),
            "CAP_SETUP_UNKNOWN_ACTION"
        );
        assert_eq!(
            ecr_cap_setup(None).await.unwrap_err(),
            "CAP_SETUP_UNKNOWN_ACTION"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn a_non_windows_host_reports_unsupported_and_performs_no_action() {
        let result = ecr_cap_setup(Some("open_installer".into()))
            .await
            .expect("non-windows result");
        assert!(!result.success);
        assert!(!result.platform_supported);
        assert!(!result.service_installed);
        assert_eq!(
            result.code.as_deref(),
            Some("CAP_SETUP_PLATFORM_UNSUPPORTED")
        );
        assert!(result.installer_launched.is_none());
    }

    #[test]
    fn the_unsupported_result_never_claims_a_service_or_a_launch() {
        let result = CapSetupResult::unsupported();
        assert!(!result.platform_supported);
        assert!(!result.service_installed);
        assert!(!result.service_running);
        assert!(result.installer_launched.is_none());
    }

    // -- Single-flight -------------------------------------------------------

    #[test]
    fn a_second_open_installer_is_refused_while_one_is_still_running() {
        let first = try_begin_open_installer().expect("first claim");
        assert!(
            try_begin_open_installer().is_none(),
            "a concurrent open_installer must not stage or launch again"
        );
        let reported = std::cell::Cell::new(false);
        finish_setup_worker(
            (),
            |_| reported.set(true),
            || {
                assert!(
                    reported.get(),
                    "launch must be reported before waiting for installer exit"
                );
                assert!(
                    try_begin_open_installer().is_none(),
                    "the open installer still owns the permit"
                );
            },
            Some(first),
        );
        let again = try_begin_open_installer().expect("claim after completion");
        drop(again);
    }

    #[test]
    fn the_in_progress_result_reports_no_launch_and_no_service_facts() {
        let result = CapSetupResult::already_in_progress();
        assert!(!result.success);
        assert_eq!(result.installer_launched, Some(false));
        assert!(!result.service_installed);
        assert_eq!(
            result.code.as_deref(),
            Some("CAP_SETUP_ALREADY_IN_PROGRESS")
        );
    }

    // -- Configuration parsing ----------------------------------------------

    #[test]
    fn parsed_configuration_never_carries_a_device_key_serial_or_password() {
        let (settings, target, code) = parse_service_ini(SAMPLE_INI.as_bytes());
        let result = CapSetupResult {
            success: true,
            platform_supported: true,
            service_installed: true,
            service_running: true,
            installer_launched: None,
            code,
            settings: Some(settings),
            target,
        };
        let json = serde_json::to_string(&result).expect("serialize");
        for secret in [
            "059560323478",
            "CFB66000001",
            "your_test_password",
            "DEVKEY",
            "DEVICEID",
            "PASSWORD",
        ] {
            assert!(
                !json.contains(secret),
                "status output leaked {secret}: {json}"
            );
        }
        assert!(json.contains("192.168.1.50"));
    }

    #[test]
    fn a_tcp_configuration_maps_to_a_network_target_without_inventing_a_port() {
        let (settings, target, code) = parse_service_ini(SAMPLE_INI.as_bytes());
        assert_eq!(code, None);
        assert_eq!(settings.capture_path.as_deref(), Some("C:\\Capture\\"));
        assert_eq!(
            settings.output_path.as_deref(),
            Some("C:\\Capture\\Output\\")
        );
        assert_eq!(settings.file_encoding.as_deref(), Some("windows-1253"));
        let target = target.expect("network target");
        assert_eq!(target.kind, "network");
        assert_eq!(target.host.as_deref(), Some("192.168.1.50"));
        assert_eq!(target.serial_port, None);
        assert_eq!(target.baud_rate, None);
        let json = serde_json::to_string(&target).expect("serialize target");
        assert!(!json.contains("port\":"), "no port may be guessed: {json}");
    }

    #[test]
    fn a_udp_configuration_maps_to_the_same_network_shape() {
        let (_, target, code) = parse_service_ini(b"COMTYPE=UDP\nADR=10.0.0.7\nCODEPAGE=UTF8\n");
        assert_eq!(code, None);
        let target = target.expect("network target");
        assert_eq!(target.kind, "network");
        assert_eq!(target.host.as_deref(), Some("10.0.0.7"));
    }

    #[test]
    fn a_com_configuration_maps_to_a_serial_target_with_its_baud_rate() {
        let (settings, target, code) =
            parse_service_ini(b"COMTYPE=COM\nRS232_PORT=COM3\nBAUD=115200\nCODEPAGE=UTF-8\n");
        assert_eq!(code, None);
        assert_eq!(settings.file_encoding.as_deref(), Some("utf-8"));
        let target = target.expect("serial target");
        assert_eq!(target.kind, "usb_serial");
        assert_eq!(target.serial_port.as_deref(), Some("COM3"));
        assert_eq!(target.baud_rate, Some(115_200));
        assert_eq!(target.host, None);
    }

    #[test]
    fn a_missing_and_an_unsupported_code_page_stay_distinguishable() {
        let (settings, _, code) = parse_service_ini(b"CODEPAGE=437\nCOMTYPE=TCP\nADR=10.0.0.9\n");
        assert_eq!(settings.file_encoding, None);
        assert_eq!(code.as_deref(), Some("CAP_SETUP_CODEPAGE_UNSUPPORTED"));

        let (settings, target, code) = parse_service_ini(b"COMTYPE=TCP\nADR=10.0.0.9\n");
        assert_eq!(settings.file_encoding, None);
        assert_eq!(code.as_deref(), Some("CAP_SETUP_CODEPAGE_MISSING"));
        assert!(target.is_some(), "the target is still reported");

        let (settings, _, code) = parse_service_ini(b"CODEPAGE=\nCOMTYPE=TCP\nADR=10.0.0.9\n");
        assert_eq!(settings.file_encoding, None);
        assert_eq!(code.as_deref(), Some("CAP_SETUP_CODEPAGE_MISSING"));
    }

    #[test]
    fn an_unsupported_or_incomplete_target_is_reported_rather_than_assumed() {
        let (_, target, code) = parse_service_ini(b"CODEPAGE=UTF8\nCOMTYPE=BLUETOOTH\n");
        assert!(target.is_none());
        assert_eq!(code.as_deref(), Some("CAP_SETUP_TARGET_UNSUPPORTED"));

        let (_, target, code) = parse_service_ini(b"CODEPAGE=UTF8\nCOMTYPE=TCP\n");
        assert!(target.is_none());
        assert_eq!(code.as_deref(), Some("CAP_SETUP_TARGET_INCOMPLETE"));
    }

    #[test]
    fn a_value_we_cannot_decode_is_omitted_and_reported_never_guessed() {
        let mut contents = b"CODEPAGE=UTF8\r\nWORKFOLDER=C:\\".to_vec();
        contents.extend_from_slice(&[0xC1, 0xC2]); // code page 1253 bytes
        contents.extend_from_slice(b"\\\r\nOUTPUTFOLDER=C:\\Capture\\Output\\\r\n");
        let (settings, _, code) = parse_service_ini(&contents);
        assert!(settings.capture_path.is_none());
        assert_eq!(
            settings.output_path.as_deref(),
            Some("C:\\Capture\\Output\\"),
            "an ASCII value on another line is still usable"
        );
        assert_eq!(
            code.as_deref(),
            Some("CAP_SETUP_CONFIG_UNSUPPORTED_ENCODING")
        );
    }

    #[test]
    fn the_service_executable_is_recovered_from_quoted_and_argument_bearing_image_paths() {
        assert_eq!(
            executable_from_image_path("\"C:\\CapDriverService\\CapDriverSVC.exe\" -service"),
            Some(PathBuf::from("C:\\CapDriverService\\CapDriverSVC.exe"))
        );
        assert_eq!(
            executable_from_image_path("C:\\CapDriverService\\CapDriverSVC.exe /run"),
            Some(PathBuf::from("C:\\CapDriverService\\CapDriverSVC.exe"))
        );
        assert_eq!(executable_from_image_path(""), None);
        assert_eq!(executable_from_image_path("CapDriverSVC.exe"), None);
        assert_eq!(executable_from_image_path("C:\\svc\\run.bat"), None);
    }

    #[test]
    fn an_installation_directory_is_only_taken_from_the_services_own_binary() {
        let snapshot = ServiceSnapshot {
            installed: true,
            running: true,
            image_path: "\"C:\\CapDriverService\\CapDriverSVC.exe\"".into(),
        };
        assert_eq!(
            installation_directory(&snapshot),
            Some(PathBuf::from("C:\\CapDriverService"))
        );
        assert_eq!(installation_directory(&ServiceSnapshot::default()), None);
        assert_eq!(
            installation_directory(&ServiceSnapshot {
                installed: true,
                running: false,
                image_path: "C:\\Windows\\System32\\svchost.exe -k netsvcs".into(),
            }),
            None,
            "only CapDriverSVC.exe identifies the installation"
        );
    }

    // -- Status --------------------------------------------------------------

    #[test]
    fn an_absent_service_reports_nothing_and_imports_no_sample_configuration() {
        let mut consulted = false;
        let result = status_from_snapshot(&ServiceSnapshot::default(), |_| {
            consulted = true;
            Ok(SAMPLE_INI.as_bytes().to_vec())
        });
        assert!(
            !consulted,
            "an absent service must not read any INI, sample or otherwise"
        );
        assert!(result.success);
        assert!(result.platform_supported);
        assert!(!result.service_installed);
        assert!(result.settings.is_none());
        assert!(result.target.is_none());
        assert_eq!(result.code.as_deref(), Some("CAP_SETUP_SERVICE_ABSENT"));
    }

    #[test]
    fn an_installed_service_is_read_from_its_own_directory() {
        let mut seen: Option<PathBuf> = None;
        let snapshot = ServiceSnapshot {
            installed: true,
            running: true,
            image_path: "\"C:\\CapDriverService\\CapDriverSVC.exe\"".into(),
        };
        let result = status_from_snapshot(&snapshot, |path| {
            seen = Some(path.to_path_buf());
            Ok(SAMPLE_INI.as_bytes().to_vec())
        });
        assert_eq!(
            seen,
            Some(PathBuf::from("C:\\CapDriverService\\CapDriverSVC.ini"))
        );
        assert!(result.service_running);
        assert!(result.settings.is_some());
        assert_eq!(result.target.expect("target").kind, "network");
    }

    #[test]
    fn an_unreadable_configuration_is_reported_without_detail() {
        let snapshot = ServiceSnapshot {
            installed: true,
            running: false,
            image_path: "C:\\CapDriverService\\CapDriverSVC.exe".into(),
        };
        let result = status_from_snapshot(&snapshot, |_| Err("io error".into()));
        assert_eq!(result.code.as_deref(), Some("CAP_SETUP_CONFIG_UNREADABLE"));
        assert!(result.settings.is_none());
    }

    #[test]
    fn a_failed_service_query_never_falls_back_to_a_configuration() {
        let result = status_query_failure("CAP_SETUP_SERVICE_QUERY_FAILED");
        assert!(!result.success);
        assert!(result.platform_supported);
        assert!(
            !result.service_installed && !result.service_running,
            "an unanswered query claims nothing about the service"
        );
        assert!(result.settings.is_none());
        assert!(result.target.is_none());
        assert_eq!(
            result.code.as_deref(),
            Some("CAP_SETUP_SERVICE_QUERY_FAILED")
        );
    }

    // -- Package handling ----------------------------------------------------

    #[test]
    fn the_pinned_url_and_digest_are_the_official_ones() {
        assert_eq!(
            OFFICIAL_ARCHIVE_URL,
            "https://my.rbs.net.gr/files/protocols/CapDriverService-with-examples.zip"
        );
        assert!(OFFICIAL_ARCHIVE_URL.starts_with("https://"));
        assert_eq!(
            OFFICIAL_ARCHIVE_SHA256,
            "150fe427533a7e4beda197b760c062ded661411708620fb2173e128edc4b1f25"
        );
    }

    #[test]
    fn an_archive_that_does_not_match_the_pinned_digest_is_refused() {
        assert_eq!(
            verify_official_archive(b"not the vendor package").unwrap_err(),
            "CAP_SETUP_ARCHIVE_HASH_MISMATCH"
        );
        assert_eq!(
            verify_official_archive(&vec![0u8; (MAX_DOWNLOAD_BYTES + 1) as usize]).unwrap_err(),
            "CAP_SETUP_DOWNLOAD_TOO_LARGE"
        );
    }

    #[test]
    fn the_official_layout_yields_exactly_the_essential_files() {
        let package = read_official_package(&zip_with(&official_layout())).expect("read package");
        let mut names = package
            .files
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        names.sort();
        let mut expected = ESSENTIAL_FILES.map(String::from).to_vec();
        expected.sort();
        assert_eq!(names, expected);
        assert_eq!(package.digests().len(), ESSENTIAL_FILES.len());
        assert_eq!(package.essential_digests().len(), ESSENTIAL_FILES.len());
    }

    #[test]
    fn the_optional_file_mover_is_kept_but_extras_and_examples_are_not() {
        let mut entries = official_layout();
        entries.push((
            "CapDriverService/CapDriverServiceFileMover.final.exe",
            b"mover",
        ));
        entries.push(("CapDriverService/Examples/demo.exe", b"demo"));
        entries.push(("CapDriverService/readme.txt", b"docs"));
        entries.push(("OtherPackage/CapDriverSVC.exe", b"impostor"));
        let package = read_official_package(&zip_with(&entries)).expect("read package");
        let names = package
            .files
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        assert!(names.iter().any(|name| name == VENDOR_FILE_MOVER));
        assert_eq!(names.len(), ESSENTIAL_FILES.len() + 1);
        assert!(!names.iter().any(|name| name == "readme.txt"));
        assert!(!names.iter().any(|name| name == "demo.exe"));
        // The impostor root shares a file name but is not the vendor's tree.
        assert_eq!(
            package
                .files
                .iter()
                .find(|(name, _)| name == "CapDriverSVC.exe")
                .map(|(_, bytes)| bytes.as_slice()),
            Some(b"service" as &[u8])
        );
        // FileMover is kept for the installer's benefit, never verified as
        // essential against someone else's installation.
        assert_eq!(package.essential_digests().len(), ESSENTIAL_FILES.len());
    }

    #[test]
    #[ignore = "requires the pinned official vendor ZIP via POS_CAP_ARCHIVE_FIXTURE"]
    fn pinned_vendor_archive_has_required_files_and_safe_first_configuration() {
        let path =
            std::env::var_os("POS_CAP_ARCHIVE_FIXTURE").expect("provide official archive fixture");
        let archive = std::fs::read(path).expect("read official fixture");
        verify_official_archive(&archive).expect("official archive digest");
        let package = read_official_package(&archive).expect("parse official package");
        assert!(package
            .files
            .iter()
            .any(|(name, _)| name == VENDOR_FILE_MOVER));
        assert_eq!(package.files.len(), ESSENTIAL_FILES.len() + 1);
        let sample = package
            .sample_ini
            .as_deref()
            .and_then(|bytes| std::str::from_utf8(bytes).ok());
        let ini = sanitized_default_ini(sample);
        for key in ["DEVKEY", "DEVICEID", "ADR", "RS232_PORT", "COMTYPE"] {
            assert!(
                ini.lines()
                    .any(|line| line.trim().eq_ignore_ascii_case(&format!("{key}="))),
                "first configuration field must be blank: {key}"
            );
        }
        let (settings, target, _) = parse_service_ini(ini.as_bytes());
        assert_eq!(settings.file_encoding.as_deref(), Some("utf-8"));
        assert!(target.is_none());
    }

    #[test]
    fn a_package_missing_an_essential_file_is_refused() {
        let mut entries = official_layout();
        entries.retain(|(name, _)| !name.ends_with("INIFileParser.dll"));
        assert_eq!(
            read_official_package(&zip_with(&entries)).unwrap_err(),
            "CAP_SETUP_ARCHIVE_INCOMPLETE"
        );
    }

    #[test]
    fn traversal_and_absolute_entry_names_are_never_kept() {
        for hostile in [
            "CapDriverService/../CapDriverServiceInstaller.exe",
            "../CapDriverService/CapDriverSVC.exe",
            "/CapDriverService/CapDriverSVC.exe",
            "C:/CapDriverService/CapDriverSVC.exe",
            "CapDriverService/nested/../CapDriverSVC.exe",
            "CapDriverService/sub/CapDriverSVC.exe",
        ] {
            assert!(
                kept_entry_name(hostile).is_none(),
                "{hostile} must not resolve to a kept file"
            );
        }

        let mut entries = official_layout();
        entries.push(("CapDriverService/../escaped.exe", b"escape"));
        let package = read_official_package(&zip_with(&entries)).expect("read package");
        assert_eq!(package.files.len(), ESSENTIAL_FILES.len());
    }

    #[test]
    fn only_plain_single_component_names_are_ever_staged() {
        assert!(is_safe_file_name("CapDriverSVC.exe"));
        assert!(is_safe_file_name("FileMover.exe"));
        for hostile in [
            "",
            ".",
            "..",
            "../escaped.exe",
            "sub/nested.exe",
            "sub\\nested.exe",
            "C:\\absolute.exe",
            "stream.exe:zone",
            "spaced name.exe",
        ] {
            assert!(!is_safe_file_name(hostile), "{hostile} must be refused");
        }
    }

    #[test]
    fn an_oversized_entry_is_refused_before_anything_is_kept() {
        let big = vec![0u8; 4096];
        let entries: Vec<(&str, &[u8])> = vec![
            ("CapDriverService/CapDriverMsg.exe", b"msg"),
            (
                "CapDriverService/CapDriverServiceInstaller.exe",
                big.as_slice(),
            ),
            ("CapDriverService/CapDriverSVC.exe", b"service"),
            ("CapDriverService/INIFileParser.dll", b"parser"),
        ];
        assert_eq!(
            read_official_package_with_limits(&zip_with(&entries), 1024, 8192).unwrap_err(),
            "CAP_SETUP_ARCHIVE_ENTRY_REJECTED"
        );
        assert_eq!(
            read_official_package_with_limits(&zip_with(&official_layout()), 1024, 4).unwrap_err(),
            "CAP_SETUP_ARCHIVE_ENTRY_REJECTED"
        );
    }

    #[test]
    fn a_colliding_entry_cannot_shadow_a_file_already_kept() {
        // Windows file names are case-insensitive, so a second entry differing
        // only in case would otherwise overwrite an already staged binary.
        let mut entries = official_layout();
        entries.push(("CapDriverService/CAPDRIVERSVC.EXE", b"swapped"));
        assert_eq!(
            read_official_package(&zip_with(&entries)).unwrap_err(),
            "CAP_SETUP_ARCHIVE_ENTRY_REJECTED"
        );

        let mut entries = official_layout();
        entries.push(("CapDriverService/FileMover.exe", b"mover"));
        entries.push(("CapDriverService/filemover.exe", b"impostor"));
        assert_eq!(
            read_official_package(&zip_with(&entries)).unwrap_err(),
            "CAP_SETUP_ARCHIVE_ENTRY_REJECTED"
        );
    }

    #[test]
    fn a_symlink_entry_is_refused() {
        // `SimpleFileOptions::unix_permissions` masks with 0o777, so the file
        // type bits have to be written into the central directory by hand:
        // version-made-by = Unix (3) and external attributes = S_IFLNK | 0777.
        let mut buffer = zip_with(&[(
            "CapDriverService/CapDriverSVC.exe",
            b"C:\\Windows\\System32\\cmd.exe" as &[u8],
        )]);
        let header = buffer
            .windows(4)
            .position(|window| window == b"PK\x01\x02")
            .expect("central directory header");
        buffer[header + 4] = 30;
        buffer[header + 5] = 3;
        buffer[header + 38..header + 42].copy_from_slice(&(0o120_777u32 << 16).to_le_bytes());

        assert_eq!(
            read_official_package(&buffer).unwrap_err(),
            "CAP_SETUP_ARCHIVE_ENTRY_REJECTED"
        );
    }

    #[test]
    fn unix_file_type_bits_identify_a_symlink_entry_regardless_of_permissions() {
        assert!(is_symlink_mode(Some(0o120_777)));
        assert!(is_symlink_mode(Some(0o120_644)));
        assert!(!is_symlink_mode(Some(0o100_755)));
        assert!(!is_symlink_mode(Some(0o040_755)));
        assert!(!is_symlink_mode(None));
    }

    #[test]
    fn digest_comparison_refuses_tampered_and_missing_files() {
        let package = read_official_package(&zip_with(&official_layout())).expect("read package");
        let expected = package.essential_digests();
        assert!(verify_digests(&expected, &expected).is_ok());

        let mut tampered = expected.clone();
        tampered.insert("CapDriverSVC.exe".into(), sha256_hex(b"swapped"));
        assert_eq!(
            verify_digests(&expected, &tampered).unwrap_err(),
            "CAP_SETUP_EXISTING_INSTALL_UNVERIFIED"
        );

        let mut missing = expected.clone();
        missing.remove("INIFileParser.dll");
        assert_eq!(
            verify_digests(&expected, &missing).unwrap_err(),
            "CAP_SETUP_EXISTING_INSTALL_UNVERIFIED"
        );
    }

    // -- Staging location ----------------------------------------------------

    #[test]
    fn only_the_system_program_data_shape_is_accepted_for_staging() {
        assert_eq!(
            validated_program_data(Some("C:\\ProgramData")),
            PathBuf::from("C:\\ProgramData")
        );
        assert_eq!(
            validated_program_data(Some("D:\\ProgramData\\")),
            PathBuf::from("D:\\ProgramData")
        );
        for hostile in [
            "C:\\Users\\Public",
            "\\\\server\\share\\ProgramData",
            "C:\\ProgramData\\Evil",
            "ProgramData",
            "",
        ] {
            assert_eq!(
                validated_program_data(Some(hostile)),
                PathBuf::from("C:\\ProgramData"),
                "{hostile} must not redirect staging"
            );
        }
        assert_eq!(
            validated_program_data(None),
            PathBuf::from("C:\\ProgramData")
        );
    }

    #[test]
    fn staging_never_overlaps_an_installed_service_directory() {
        let installation = PathBuf::from("C:\\CapDriverService");
        assert!(staging_conflicts_with_installation(
            &installation,
            Some(&installation)
        ));
        assert!(staging_conflicts_with_installation(
            &PathBuf::from("C:\\CapDriverService\\stage-1"),
            Some(&installation)
        ));
        assert!(staging_conflicts_with_installation(
            &PathBuf::from("c:/capdriverservice"),
            Some(&installation)
        ));
        assert!(!staging_conflicts_with_installation(
            &PathBuf::from("C:\\ProgramData\\TheSmall\\CapDriver\\stage-1"),
            Some(&installation)
        ));
        assert!(!staging_conflicts_with_installation(
            &PathBuf::from("C:\\ProgramData\\TheSmall\\CapDriver\\stage-1"),
            None
        ));
    }

    #[test]
    fn reparse_attributes_are_recognised_wherever_they_appear() {
        assert!(attributes_are_reparse_point(FILE_ATTRIBUTE_REPARSE_POINT));
        assert!(attributes_are_reparse_point(0x0000_0410));
        assert!(!attributes_are_reparse_point(0x0000_0010));
        assert!(!attributes_are_reparse_point(0));
    }

    // -- Sanitised first-run configuration -----------------------------------

    #[test]
    fn the_vendor_sample_is_read_as_a_template_only() {
        let mut entries = official_layout();
        entries.push(("CapDriverService/CapDriverSVC.ini", SAMPLE_INI.as_bytes()));
        let package = read_official_package(&zip_with(&entries)).expect("read package");
        assert!(package.sample_ini.is_some());
        assert!(
            !package
                .files
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case(SERVICE_INI)),
            "the demo INI is never one of the staged files"
        );
    }

    #[test]
    fn the_first_run_configuration_blanks_demo_credentials_and_the_demo_target() {
        let sanitized = sanitized_default_ini(Some(SAMPLE_INI));
        for secret in [
            "059560323478",
            "CFB66000001",
            "your_test_password",
            "192.168.1.50",
        ] {
            assert!(
                !sanitized.contains(secret),
                "{secret} must not be installed: {sanitized}"
            );
        }
        assert!(sanitized.contains("DEVKEY=\r\n"));
        assert!(sanitized.contains("DEVICEID=\r\n"));
        assert!(sanitized.contains("ADR=\r\n"));
        assert!(sanitized.contains("RS232_PORT=\r\n"));
        assert!(sanitized.contains("COMTYPE=\r\n"));
        assert!(sanitized.contains("WORKFOLDER=C:\\Capture\\"));
        assert!(sanitized.contains("OUTPUTFOLDER=C:\\Capture\\Output\\"));
        assert!(sanitized.contains("CODEPAGE=UTF8"));
        assert!(sanitized.contains("[CapDriverService]"));

        let (settings, target, code) = parse_service_ini(sanitized.as_bytes());
        assert_eq!(settings.file_encoding.as_deref(), Some("utf-8"));
        assert!(
            target.is_none(),
            "no cashier is configured for the customer"
        );
        assert_eq!(code, None);
    }

    #[test]
    fn a_package_without_a_usable_sample_still_yields_a_credential_free_configuration() {
        let sanitized = sanitized_default_ini(None);
        let (settings, target, code) = parse_service_ini(sanitized.as_bytes());
        assert_eq!(code, None);
        assert_eq!(settings.file_encoding.as_deref(), Some("utf-8"));
        assert!(target.is_none());
        assert!(sanitized.contains("DEVKEY=\r\n"));
        assert!(sanitized.contains("DEVICEID=\r\n"));
    }

    #[test]
    fn the_service_name_and_essential_file_list_stay_pinned() {
        assert_eq!(SERVICE_NAME, "CapDriverSVC");
        assert_eq!(SERVICE_EXECUTABLE, "CapDriverSVC.exe");
        assert_eq!(SERVICE_INI, "CapDriverSVC.ini");
        assert_eq!(
            ESSENTIAL_FILES,
            [
                "CapDriverMsg.exe",
                "CapDriverServiceInstaller.exe",
                "CapDriverSVC.exe",
                "INIFileParser.dll",
            ]
        );
    }

    /// Hash + layout check against the real vendor package when the fixture is
    /// available. Bytes are only read and hashed; nothing is executed.
    #[test]
    fn the_official_fixture_matches_the_pinned_digest_and_layout() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../output/agent-runs/mydata-lan-support/official-capdriver.zip");
        let Ok(archive) = std::fs::read(&fixture) else {
            eprintln!("skipping: official fixture not present at {fixture:?}");
            return;
        };

        verify_official_archive(&archive).expect("fixture must be the pinned official archive");
        let package = read_official_package(&archive).expect("read official package");
        for essential in ESSENTIAL_FILES {
            assert!(
                package
                    .files
                    .iter()
                    .any(|(name, _)| name.eq_ignore_ascii_case(essential)),
                "{essential} missing from the official package"
            );
        }
        for (name, _) in &package.files {
            assert!(is_safe_file_name(name), "{name} is not a safe staged name");
        }
        if let Some(sample) = package.sample_ini.as_deref() {
            let template = std::str::from_utf8(sample).ok();
            let sanitized = sanitized_default_ini(template);
            let (_, target, _) = parse_service_ini(sanitized.as_bytes());
            assert!(
                target.is_none(),
                "the vendor sample's demo target must not survive sanitising"
            );
            for line in sanitized.lines() {
                if let Some((key, value)) = line.split_once('=') {
                    let key = key.trim().to_ascii_uppercase();
                    if SECRET_INI_KEYS.contains(&key.as_str())
                        || BLANK_INI_KEYS.contains(&key.as_str())
                    {
                        assert!(value.trim().is_empty(), "{key} must be blank");
                    }
                }
            }
        }
    }
}
