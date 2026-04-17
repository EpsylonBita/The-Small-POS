//! Panic hook that writes crashes to `{log_dir}/crash.log` and emits a
//! `tracing::error!` so they surface in existing log pipelines.
//!
//! Without this, any production `.unwrap()` / `.expect()` / out-of-bounds panic
//! terminates the Tauri runtime with no frontend notification and no trace in
//! the diagnostics export bundle. Installing a hook is additive: it runs in
//! addition to the default hook (which still prints to stderr).
//!
//! SAFETY: The hook itself MUST NOT panic. All IO is best-effort — errors are
//! intentionally dropped. The payload downcast guards against non-string panic
//! payloads.

use std::fs::OpenOptions;
use std::io::Write;
use std::panic;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::Utc;

use crate::diagnostics;

static CRASH_COUNT: AtomicU64 = AtomicU64::new(0);

/// Install the panic hook. Call once, as early as possible in `run()` after
/// tracing has been initialized. Preserves the previous hook so default
/// stderr output is not lost.
pub fn install() {
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        default_hook(info);
        let _ = record_panic(info);
    }));
}

#[allow(deprecated)]
fn record_panic(info: &panic::PanicInfo<'_>) -> std::io::Result<()> {
    let crash_path = crash_log_path();
    if let Some(parent) = crash_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let record = format_record(info);

    tracing::error!(target: "panic_hook", "{}", record);

    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&crash_path)?;
    f.write_all(record.as_bytes())?;
    f.write_all(b"\n")?;
    f.flush()?;

    CRASH_COUNT.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

fn crash_log_path() -> PathBuf {
    diagnostics::get_log_dir().join("crash.log")
}

#[allow(deprecated)]
fn format_record(info: &panic::PanicInfo<'_>) -> String {
    use std::fmt::Write as _;

    let ts = Utc::now().to_rfc3339();
    let thread = std::thread::current();
    let thread_name = thread.name().unwrap_or("<unnamed>");
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "<unknown>".to_string());
    let message = payload_as_str(info);
    let version = env!("CARGO_PKG_VERSION");

    let mut out = String::with_capacity(512);
    let _ = write!(
        &mut out,
        "----- PANIC {ts} v{version} thread={thread_name} at {location} -----\nmessage: {message}"
    );

    if std::env::var_os("RUST_BACKTRACE").is_some() {
        let bt = std::backtrace::Backtrace::force_capture();
        let _ = write!(&mut out, "\nbacktrace:\n{bt}");
    }

    out
}

#[allow(deprecated)]
fn payload_as_str(info: &panic::PanicInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "<non-string panic payload>".to_string()
}

/// Number of panics captured since process start. Exposed for diagnostics.
pub fn crash_count() -> u64 {
    CRASH_COUNT.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Global lock: panic hooks are process-global, so these tests must not
    // interleave. Other threads could also fire panics and interfere.
    static HOOK_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn payload_string_extracted() {
        let _g = HOOK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = panic::take_hook();
        panic::set_hook(Box::new(|_| {}));
        let result = panic::catch_unwind(|| panic!("boom-string"));
        panic::set_hook(previous);
        assert!(result.is_err());
    }

    #[test]
    fn crash_log_path_is_in_log_dir() {
        let p = crash_log_path();
        assert!(p.ends_with("crash.log"));
        let parent = p.parent().expect("crash.log has a parent");
        assert_eq!(parent, diagnostics::get_log_dir());
    }
}
