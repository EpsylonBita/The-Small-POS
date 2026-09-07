//! Reduce WebView2 memory only while the POS window is inactive.
//!
//! `MemoryUsageTargetLevel::Low` is a best-effort hint, not a forced GC or
//! a memory cap. It can page memory to disk and slow subsequent interaction.
//! Keep Normal while the window is visible and focused; restore it on focus
//! before the operator resumes mouse, touch, or keyboard interaction. Scripts
//! and networking continue while inactive (we never suspend the webview).

#[cfg(any(windows, test))]
use std::time::{Duration, Instant};
use tauri::AppHandle;
#[cfg(windows)]
use tracing::{debug, warn};

/// Visibility changes have no dedicated Tauri window event. Reconcile them
/// occasionally without repeatedly toggling the memory target.
#[cfg(windows)]
const ACTIVITY_CHECK_INTERVAL_SECS: u64 = 5;
#[cfg(any(windows, test))]
const UNFOCUSED_GRACE: Duration = Duration::from_secs(30);

#[cfg(windows)]
#[derive(Default)]
struct MemoryPolicyState(std::sync::Mutex<WindowActivityPolicy>);

#[cfg(windows)]
pub fn start_activity_policy(app: AppHandle) {
    use tauri::{Manager, WindowEvent};

    app.manage(MemoryPolicyState::default());
    if let Some(window) = app.get_webview_window("main") {
        let event_app = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_)) {
                if let Err(error) = reconcile_memory_target(&event_app) {
                    warn!("memory policy: window activity update failed: {error}");
                }
            }
        });
    }

    tauri::async_runtime::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(ACTIVITY_CHECK_INTERVAL_SECS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if app.get_webview_window("main").is_none() {
                break;
            }
            if let Err(error) = reconcile_memory_target(&app) {
                warn!("memory policy: activity check failed: {error}");
            }
        }
    });
}

#[cfg(not(windows))]
pub fn start_activity_policy(_app: AppHandle) {}

/// Keep the existing bridge channel compatible. A request now reconciles the
/// current activity policy; it cannot force Low during an active order.
#[tauri::command]
pub async fn memory_trim_webview(app: AppHandle) -> Result<(), String> {
    reconcile_memory_target(&app)
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MemoryTarget {
    Normal,
    Low,
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct WindowActivityPolicy {
    unfocused_since: Option<Instant>,
}

#[cfg(any(windows, test))]
impl WindowActivityPolicy {
    fn target_for_window(
        &mut self,
        focused: Option<bool>,
        visible: Option<bool>,
        minimized: Option<bool>,
        now: Instant,
    ) -> MemoryTarget {
        match (focused, visible, minimized) {
            (Some(_), Some(false), Some(_)) | (Some(_), Some(_), Some(true)) => {
                self.unfocused_since = None;
                MemoryTarget::Low
            }
            (Some(false), Some(true), Some(false)) => {
                // A native picker or a brief focus change is still operator
                // activity. Only lower memory after sustained loss of focus.
                let since = self.unfocused_since.get_or_insert(now);
                if now.saturating_duration_since(*since) >= UNFOCUSED_GRACE {
                    MemoryTarget::Low
                } else {
                    MemoryTarget::Normal
                }
            }
            // Focus regained or incomplete native state: restore Normal and
            // discard the old inactivity deadline so it cannot fire later.
            _ => {
                self.unfocused_since = None;
                MemoryTarget::Normal
            }
        }
    }
}

#[cfg(windows)]
fn reconcile_memory_target(app: &AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let activity_app = app.clone();
    // Decide inside the main-thread task, not when it is queued. A timer or
    // legacy IPC request queued before focus returns cannot apply stale Low.
    // There are no delayed restores or overlapping Low/Normal sleep cycles.
    app.run_on_main_thread(move || {
        let Some(window) = activity_app.get_webview_window("main") else {
            return;
        };
        let target = activity_app
            .try_state::<MemoryPolicyState>()
            .and_then(|state| {
                let mut policy = state.0.lock().ok()?;
                Some(policy.target_for_window(
                    window.is_focused().ok(),
                    window.is_visible().ok(),
                    window.is_minimized().ok(),
                    Instant::now(),
                ))
            })
            .unwrap_or(MemoryTarget::Normal);
        apply_memory_target(&window, target);
    })
    .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn apply_memory_target(window: &tauri::WebviewWindow, target: MemoryTarget) {
    // Called on the main thread, so the native state check and COM update
    // run together without another asynchronous hop between them.
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
                // MemoryUsageTargetLevel API (2023). Do not fill logs on
                // every activity check when this runtime cannot support it.
                static WARNED: std::sync::atomic::AtomicBool =
                    std::sync::atomic::AtomicBool::new(false);
                if !WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    warn!("memory policy: ICoreWebView2_19 unsupported: {error}");
                }
                return;
            }
        };
        let level = COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(match target {
            MemoryTarget::Normal => 0,
            MemoryTarget::Low => 1,
        });
        let mut current = COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL::default();
        if unsafe { core.MemoryUsageTargetLevel(&mut current) }.is_ok() && current == level {
            return;
        }
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
fn reconcile_memory_target(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_pos_stays_normal_across_repeated_requests() {
        let mut policy = WindowActivityPolicy::default();
        let now = Instant::now();
        for elapsed in [0, 300, 3600] {
            assert_eq!(
                policy.target_for_window(
                    Some(true),
                    Some(true),
                    Some(false),
                    now + Duration::from_secs(elapsed)
                ),
                MemoryTarget::Normal
            );
        }
    }

    #[test]
    fn hidden_or_minimized_pos_can_reduce_memory_immediately() {
        for (focused, visible, minimized) in [
            (false, false, false),
            (true, false, false),
            (false, true, true),
        ] {
            assert_eq!(
                WindowActivityPolicy::default().target_for_window(
                    Some(focused),
                    Some(visible),
                    Some(minimized),
                    Instant::now()
                ),
                MemoryTarget::Low
            );
        }
    }

    #[test]
    fn brief_focus_loss_does_not_trim_and_old_deadline_is_discarded() {
        let mut policy = WindowActivityPolicy::default();
        let now = Instant::now();
        for (seconds, focused) in [
            (0, false),
            (29, false),
            (30, true),
            (31, false),
            (60, false),
        ] {
            assert_eq!(
                policy.target_for_window(
                    Some(focused),
                    Some(true),
                    Some(false),
                    now + Duration::from_secs(seconds)
                ),
                MemoryTarget::Normal
            );
        }
    }

    #[test]
    fn sustained_inactivity_reduces_memory_and_focus_restores_without_delay() {
        let mut policy = WindowActivityPolicy::default();
        let now = Instant::now();
        policy.target_for_window(Some(false), Some(true), Some(false), now);
        assert_eq!(
            policy.target_for_window(
                Some(false),
                Some(true),
                Some(false),
                now + Duration::from_secs(30)
            ),
            MemoryTarget::Low
        );
        assert_eq!(
            policy.target_for_window(
                Some(true),
                Some(true),
                Some(false),
                now + Duration::from_secs(31)
            ),
            MemoryTarget::Normal
        );
    }

    #[test]
    fn unknown_window_state_preserves_responsiveness() {
        for (focused, visible, minimized) in [
            (None, Some(true), Some(false)),
            (Some(false), None, Some(false)),
            (Some(false), Some(false), None),
            (None, None, None),
        ] {
            let mut policy = WindowActivityPolicy::default();
            let now = Instant::now();
            policy.target_for_window(Some(false), Some(true), Some(false), now);
            assert_eq!(
                policy.target_for_window(
                    focused,
                    visible,
                    minimized,
                    now + Duration::from_secs(60)
                ),
                MemoryTarget::Normal
            );
            assert_eq!(
                policy.target_for_window(
                    Some(false),
                    Some(true),
                    Some(false),
                    now + Duration::from_secs(61)
                ),
                MemoryTarget::Normal
            );
        }
    }
}
