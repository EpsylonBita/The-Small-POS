//! Periodic WebView2 memory trim — the shop-till "2GB at the PIN screen" fix.
//!
//! Measured live on the shop till (release 1.4.67, 2026-08-18, via CDP): the
//! renderer held a 28MB JS heap and 321 DOM nodes, yet `blink_gc` — Blink's
//! Oilpan heap for browser-side objects (animations, DOM wrappers, style
//! objects) — sat at 490MB. Two forced unified GCs dropped it to 33MB.
//!
//! Mechanism: V8 schedules major (unified) collections from *JS-heap* pressure.
//! The POS keeps its JS heap tiny and calm, so a major collection almost never
//! fires — while every modal open/close (check-in above all) churns out
//! Blink-side objects that only a major collection can reclaim. A till that
//! runs for days accumulates them without bound.
//!
//! `MemoryUsageTargetLevel` is WebView2's supported knob for exactly this:
//! moving Normal→Low purges caches and runs the collector; Normal restores
//! full performance. We dip to Low briefly on a timer, and on demand via the
//! `trim_webview_memory` command (the renderer calls it after check-in closes).

use tauri::AppHandle;
#[cfg(windows)]
use tracing::{debug, warn};

/// How often the till asks WebView2 to take out the garbage. Live service
/// generates Blink-side garbage at ~30MB/min (measured on the shop till
/// during an evening shift), so 5 minutes caps the standing pile at
/// ~150MB between trims.
pub const TRIM_INTERVAL_SECS: u64 = 300;
/// How long each trim stays at the Low target. The purge + collection happen
/// on the Normal→Low transition; this window just gives the browser time to
/// finish before full caching resumes.
pub const TRIM_LOW_WINDOW_SECS: u64 = 20;

/// Background loop: every [`TRIM_INTERVAL_SECS`], dip the webview to the Low
/// memory target for [`TRIM_LOW_WINDOW_SECS`], then restore Normal.
pub fn spawn_periodic_trim(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(TRIM_INTERVAL_SECS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick completes immediately; skip it so startup isn't
        // spent collecting an empty heap.
        interval.tick().await;
        loop {
            interval.tick().await;
            trim_once(&app).await;
        }
    });
}

/// One trim cycle: Low, brief dwell, Normal.
pub async fn trim_once(app: &AppHandle) {
    set_memory_target(app, MemoryTarget::Low);
    tokio::time::sleep(std::time::Duration::from_secs(TRIM_LOW_WINDOW_SECS)).await;
    set_memory_target(app, MemoryTarget::Normal);
}

/// Renderer-triggered trim for known garbage cliffs (check-in modal close).
/// Invoked from the bridge as channel `memory:trim-webview`.
#[tauri::command]
pub async fn memory_trim_webview(app: AppHandle) -> Result<(), String> {
    trim_once(&app).await;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryTarget {
    Normal,
    Low,
}

#[cfg(windows)]
fn set_memory_target(app: &AppHandle, target: MemoryTarget) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // with_webview schedules the closure onto the main thread, where the
    // WebView2 COM objects live (they are single-threaded apartment objects).
    let result = window.with_webview(move |webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL,
        };
        use windows::core::Interface;

        let controller = webview.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(error) => {
                warn!("memory trim: CoreWebView2 unavailable: {error}");
                return;
            }
        };
        let core: ICoreWebView2_19 = match core.cast() {
            Ok(core) => core,
            Err(error) => {
                // Would only happen on a WebView2 runtime older than the
                // MemoryUsageTargetLevel API (2023); log once per attempt and
                // let the till keep running untrimmed rather than crash.
                warn!("memory trim: ICoreWebView2_19 unsupported: {error}");
                return;
            }
        };
        let level = COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(match target {
            MemoryTarget::Normal => 0,
            MemoryTarget::Low => 1,
        });
        match unsafe { core.SetMemoryUsageTargetLevel(level) } {
            Ok(()) => debug!("memory trim: target set to {target:?}"),
            Err(error) => warn!("memory trim: SetMemoryUsageTargetLevel failed: {error}"),
        }
    });
    if let Err(error) = result {
        warn!("memory trim: with_webview failed: {error}");
    }
}

#[cfg(not(windows))]
fn set_memory_target(_app: &AppHandle, _target: MemoryTarget) {
    // WebKit (macOS dev builds) has no equivalent knob; the unified-GC
    // starvation was only ever observed on WebView2 tills.
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The trim must stay a rare, brief dip — an accidental edit that makes it
    /// aggressive would turn a memory fix into a latency bug on live tills.
    #[test]
    fn trim_cadence_stays_gentle() {
        assert!(TRIM_INTERVAL_SECS >= 300, "trim at most every 5 minutes");
        assert!(TRIM_LOW_WINDOW_SECS <= 60, "low-target dwell stays short");
        assert!(
            TRIM_LOW_WINDOW_SECS * 10 <= TRIM_INTERVAL_SECS,
            "the till must spend the overwhelming majority of time at Normal"
        );
    }
}
