//! Short-lived plaintext cache for verified repair attachment viewing.
//!
//! Files are written under the OS app-cache directory with random names and
//! fixed MIME-derived extensions. Paths never cross IPC and are opened with
//! an argument-based platform API. Scope transitions and startup remove the
//! cache without following symlinks.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use uuid::Uuid;

const CACHE_DIRECTORY: &str = "repair-attachment-content-v1";
const MAX_ATTACHMENT_BYTES: usize = 15 * 1024 * 1024;
const ATTACHMENT_TTL: Duration = Duration::from_secs(15 * 60);

static CACHE_ROOT: OnceLock<PathBuf> = OnceLock::new();
static CACHE_GENERATION: AtomicU64 = AtomicU64::new(1);
static CACHE_LOCK: Mutex<()> = Mutex::new(());

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value)
        .ok()
        .map(|parsed| parsed.hyphenated().to_string() == value)
        .unwrap_or(false)
}

fn extension_for_mime(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "application/pdf" => Some("pdf"),
        _ => None,
    }
}

fn remove_without_following(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("REPAIR_ATTACHMENT_CACHE_PURGE_FAILED".to_string()),
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).map_err(|_| "REPAIR_ATTACHMENT_CACHE_PURGE_FAILED".to_string())
    } else if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|_| "REPAIR_ATTACHMENT_CACHE_PURGE_FAILED".to_string())
    } else {
        Err("REPAIR_ATTACHMENT_CACHE_PURGE_FAILED".to_string())
    }
}

fn prepare_empty_root(root: &Path) -> Result<(), String> {
    remove_without_following(root)?;
    fs::create_dir_all(root)
        .map_err(|_| "REPAIR_ATTACHMENT_CACHE_INITIALIZE_FAILED".to_string())?;
    let metadata = fs::symlink_metadata(root)
        .map_err(|_| "REPAIR_ATTACHMENT_CACHE_INITIALIZE_FAILED".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("REPAIR_ATTACHMENT_CACHE_INITIALIZE_FAILED".to_string());
    }
    Ok(())
}

pub(crate) fn initialize(app_cache_dir: &Path) -> Result<(), String> {
    let _guard = CACHE_LOCK
        .lock()
        .map_err(|_| "REPAIR_ATTACHMENT_CACHE_UNAVAILABLE".to_string())?;
    let root = app_cache_dir.join(CACHE_DIRECTORY);
    prepare_empty_root(&root)?;
    match CACHE_ROOT.set(root.clone()) {
        Ok(()) => {
            CACHE_GENERATION.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        Err(_) if CACHE_ROOT.get() == Some(&root) => {
            CACHE_GENERATION.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        Err(_) => Err("REPAIR_ATTACHMENT_CACHE_INITIALIZE_FAILED".to_string()),
    }
}

pub(crate) fn generation() -> u64 {
    CACHE_GENERATION.load(Ordering::SeqCst)
}

fn scope_directory(root: &Path, scope_token: &str) -> Result<PathBuf, String> {
    if !canonical_uuid(scope_token) {
        return Err("REPAIR_ATTACHMENT_CACHE_SCOPE_INVALID".to_string());
    }
    Ok(root.join(scope_token))
}

fn purge_expired_scope_at(root: &Path, scope_token: &str, now: SystemTime) -> Result<(), String> {
    let directory = scope_directory(root, scope_token)?;
    let directory_metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("REPAIR_ATTACHMENT_CACHE_PURGE_FAILED".to_string()),
    };
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return remove_without_following(&directory);
    }
    for entry in
        fs::read_dir(&directory).map_err(|_| "REPAIR_ATTACHMENT_CACHE_PURGE_FAILED".to_string())?
    {
        let entry = entry.map_err(|_| "REPAIR_ATTACHMENT_CACHE_PURGE_FAILED".to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "REPAIR_ATTACHMENT_CACHE_PURGE_FAILED".to_string())?;
        let expired = metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata
                .modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .map_or(true, |age| age >= ATTACHMENT_TTL);
        if expired {
            remove_without_following(&path)?;
        }
    }
    Ok(())
}

pub(crate) fn purge_scope(scope_token: &str) -> Result<(), String> {
    let Some(root) = CACHE_ROOT.get() else {
        return Ok(());
    };
    let _guard = CACHE_LOCK
        .lock()
        .map_err(|_| "REPAIR_ATTACHMENT_CACHE_PURGE_FAILED".to_string())?;
    CACHE_GENERATION.fetch_add(1, Ordering::SeqCst);
    let directory = scope_directory(root, scope_token)?;
    remove_without_following(&directory)
}

pub(crate) fn purge_all() -> Result<(), String> {
    let Some(root) = CACHE_ROOT.get() else {
        return Ok(());
    };
    let _guard = CACHE_LOCK
        .lock()
        .map_err(|_| "REPAIR_ATTACHMENT_CACHE_PURGE_FAILED".to_string())?;
    CACHE_GENERATION.fetch_add(1, Ordering::SeqCst);
    prepare_empty_root(root)
}

fn write_and_open_at<F>(
    root: &Path,
    scope_token: &str,
    attachment_id: &str,
    mime_type: &str,
    bytes: &[u8],
    opener: F,
) -> Result<PathBuf, String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|_| "REPAIR_ATTACHMENT_CACHE_WRITE_FAILED".to_string())?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err("REPAIR_ATTACHMENT_CACHE_WRITE_FAILED".to_string());
    }
    let extension = extension_for_mime(mime_type)
        .ok_or_else(|| "REPAIR_ATTACHMENT_CONTENT_INVALID".to_string())?;
    if !canonical_uuid(attachment_id) || bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("REPAIR_ATTACHMENT_CONTENT_INVALID".to_string());
    }
    purge_expired_scope_at(root, scope_token, SystemTime::now())?;
    let directory = scope_directory(root, scope_token)?;
    fs::create_dir_all(&directory)
        .map_err(|_| "REPAIR_ATTACHMENT_CACHE_WRITE_FAILED".to_string())?;
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|_| "REPAIR_ATTACHMENT_CACHE_WRITE_FAILED".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("REPAIR_ATTACHMENT_CACHE_WRITE_FAILED".to_string());
    }

    let path = directory.join(format!("{}.{}", Uuid::new_v4(), extension));
    let write_result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|_| "REPAIR_ATTACHMENT_CACHE_WRITE_FAILED".to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "REPAIR_ATTACHMENT_CACHE_WRITE_FAILED".to_string())?;
        drop(file);
        opener(&path).map_err(|_| "REPAIR_ATTACHMENT_OPEN_FAILED".to_string())
    })();
    if let Err(error) = write_result {
        let _ = remove_without_following(&path);
        return Err(error);
    }
    Ok(path)
}

fn schedule_ttl_cleanup(path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ATTACHMENT_TTL).await;
        for attempt in 0..5 {
            if remove_without_following(&path).is_ok() {
                return;
            }
            if attempt < 4 {
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        }
    });
}

#[cfg(windows)]
fn open_with_platform(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let file: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        Err("REPAIR_ATTACHMENT_OPEN_FAILED".to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn open_with_platform(path: &Path) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|_| "REPAIR_ATTACHMENT_OPEN_FAILED".to_string())
}

pub(crate) fn store_and_open(
    expected_generation: u64,
    scope_token: &str,
    attachment_id: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<bool, String> {
    let _guard = CACHE_LOCK
        .lock()
        .map_err(|_| "REPAIR_ATTACHMENT_CACHE_UNAVAILABLE".to_string())?;
    if expected_generation != CACHE_GENERATION.load(Ordering::SeqCst) {
        return Err("REPAIR_ATTACHMENT_CACHE_SCOPE_CHANGED".to_string());
    }
    let root = CACHE_ROOT
        .get()
        .ok_or_else(|| "REPAIR_ATTACHMENT_CACHE_UNAVAILABLE".to_string())?;
    let path = write_and_open_at(
        root,
        scope_token,
        attachment_id,
        mime_type,
        bytes,
        open_with_platform,
    )?;
    schedule_ttl_cleanup(path);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCOPE_ID: &str = "10000000-0000-4000-8000-000000000001";
    const ATTACHMENT_ID: &str = "10000000-0000-4000-8000-000000000002";

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("repair-attachment-cache-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn writes_random_fixed_extension_in_the_scoped_cache() {
        let root = test_root();
        prepare_empty_root(&root).unwrap();
        let mut opened = false;
        let result = write_and_open_at(
            &root,
            SCOPE_ID,
            ATTACHMENT_ID,
            "image/jpeg",
            b"verified bytes",
            |path| {
                opened = true;
                assert_eq!(
                    path.extension().and_then(|value| value.to_str()),
                    Some("jpg")
                );
                assert_eq!(fs::read(path).unwrap(), b"verified bytes");
                assert!(!path.to_string_lossy().contains(ATTACHMENT_ID));
                Ok(())
            },
        );
        assert!(result.is_ok());
        assert!(opened);
        remove_without_following(&root).unwrap();
    }

    #[test]
    fn failed_open_removes_plaintext_immediately() {
        let root = test_root();
        prepare_empty_root(&root).unwrap();
        assert_eq!(
            write_and_open_at(
                &root,
                SCOPE_ID,
                ATTACHMENT_ID,
                "application/pdf",
                b"verified bytes",
                |_| Err("simulated".to_string()),
            ),
            Err("REPAIR_ATTACHMENT_OPEN_FAILED".to_string())
        );
        let directory = root.join(SCOPE_ID);
        assert_eq!(fs::read_dir(directory).unwrap().count(), 0);
        remove_without_following(&root).unwrap();
    }

    #[test]
    fn startup_preparation_removes_all_prior_plaintext() {
        let root = test_root();
        fs::create_dir_all(root.join(SCOPE_ID)).unwrap();
        fs::write(root.join(SCOPE_ID).join("prior.pdf"), b"private").unwrap();
        prepare_empty_root(&root).unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        remove_without_following(&root).unwrap();
    }
}
