//! Brings the POS screen back when WebView2 loses the process that draws it.
//!
//! WebView2 runs the page in a separate render process. When that process exits (a crash, the
//! system ending it, a failed start), the window stays open and turns blank white, and nothing
//! reloads it: the till looks alive and takes no touch. Reproduced on the dev till on
//! 11/11/2026 (page reloads while its window was minimised and restored in a loop); until then
//! nothing listened for the event, so the cause of such an exit was never even logged.
//!
//! The remedy is the one WebView2 documents for this event: reload the page. The signed-in
//! session and the saved cart draft survive a reload. It is narrow and capped:
//! - only `RENDER_PROCESS_EXITED` of the POS webview is acted on. An unresponsive renderer and
//!   every other failed process are logged only: WebView2 restarts its GPU and utility
//!   processes itself, and reloading a page that may still answer could lose what the cashier
//!   is typing. A lost browser process cannot be repaired from here and is logged as an error;
//! - at most `MAX_RELOADS` reloads within any `RELOAD_WINDOW`. A page that dies on every load
//!   therefore cannot loop fast, and it is never abandoned either: past the cap the next reload
//!   waits until the window has room again, and the log says how long;
//! - every event and every remedy is written to the day's log with the kind, the reason and
//!   the exit code WebView2 reports.
//!
//! The budget lives in memory: it guards one process against a reload loop. It mutates no
//! queue, payment or order, so there is nothing to snapshot or restore.

// The policy is used by the Windows listener only; other targets compile it for the tests.
#![cfg_attr(not(windows), allow(dead_code))]

use std::time::{Duration, Instant};

/// Reloads allowed within any `RELOAD_WINDOW`; a further one waits for room.
pub const MAX_RELOADS: usize = 3;
pub const RELOAD_WINDOW: Duration = Duration::from_secs(120);

/// The process WebView2 reported, reduced to what the remedy needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailedProcess {
    Browser,
    Renderer,
    RendererUnresponsive,
    Other,
}

impl FailedProcess {
    /// From `COREWEBVIEW2_PROCESS_FAILED_KIND`.
    pub fn from_kind(kind: i32) -> Self {
        match kind {
            0 => Self::Browser,
            1 => Self::Renderer,
            2 => Self::RendererUnresponsive,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Remedy {
    /// Reload the page: its render process is gone.
    Reload,
    /// Nothing to do from here, or nothing safe to do.
    LogOnly,
    /// The render process keeps dying: reload once the window has room again.
    ReloadAfter(Duration),
}

/// Reloads done recently or already scheduled, so a page that dies on every load cannot loop.
#[derive(Default)]
pub struct ReloadBudget {
    /// When each counted reload happens; a scheduled one lies in the future.
    reloads: Vec<Instant>,
}

impl ReloadBudget {
    pub fn decide(&mut self, process: FailedProcess, now: Instant) -> Remedy {
        if process != FailedProcess::Renderer {
            return Remedy::LogOnly;
        }
        self.reloads
            .retain(|at| now.saturating_duration_since(*at) < RELOAD_WINDOW);
        if self.reloads.len() < MAX_RELOADS {
            self.reloads.push(now);
            return Remedy::Reload;
        }
        // Room opens when the oldest of the last MAX_RELOADS leaves the window.
        self.reloads.sort();
        let oldest_counted = self.reloads[self.reloads.len() - MAX_RELOADS];
        let at = (oldest_counted + RELOAD_WINDOW).max(now);
        self.reloads.push(at);
        Remedy::ReloadAfter(at.saturating_duration_since(now))
    }
}

/// Plain name of a `COREWEBVIEW2_PROCESS_FAILED_KIND`, for the log.
pub fn kind_name(kind: i32) -> &'static str {
    match kind {
        0 => "browser process exited",
        1 => "render process exited",
        2 => "render process unresponsive",
        3 => "frame render process exited",
        4 => "utility process exited",
        5 => "sandbox helper process exited",
        6 => "gpu process exited",
        7 => "ppapi plugin process exited",
        8 => "ppapi broker process exited",
        _ => "unknown process exited",
    }
}

/// Plain name of a `COREWEBVIEW2_PROCESS_FAILED_REASON`, for the log.
pub fn reason_name(reason: i32) -> &'static str {
    match reason {
        0 => "unexpected",
        1 => "unresponsive",
        2 => "terminated",
        3 => "crashed",
        4 => "launch failed",
        5 => "out of memory",
        6 => "profile deleted",
        _ => "unknown",
    }
}

/// Listen for failed WebView2 processes of the POS webview. Call once, after the main window
/// exists.
#[cfg(windows)]
pub fn install(app: &tauri::AppHandle) {
    use tauri::Manager;
    use tracing::warn;

    // `get_webview`, not `get_webview_window`: the main window also hosts the efood Partner
    // child webview. That one is an external page with its own lifecycle and is not reloaded.
    let Some(webview) = app.get_webview("main") else {
        warn!(target: "webview_recovery", "main webview not found: a lost render process will not be recovered");
        return;
    };
    let reload_handle = webview.clone();
    let result = webview.with_webview(move |platform| {
        use tracing::{error, info};
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
            COREWEBVIEW2_PROCESS_FAILED_REASON,
        };
        use webview2_com::ProcessFailedEventHandler;
        use windows::core::Interface;

        // SAFETY: called on the main thread with a live controller, as `with_webview` requires.
        let core = match unsafe { platform.controller().CoreWebView2() } {
            Ok(core) => core,
            Err(error) => {
                warn!(target: "webview_recovery", "CoreWebView2 unavailable: {error}");
                return;
            }
        };
        let mut budget = ReloadBudget::default();
        let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            // SAFETY: `args` is the live event argument and `kind` a valid out pointer.
            unsafe { args.ProcessFailedKind(&mut kind)? };
            // Reason and exit code exist from WebView2 runtime 89; older ones report neither.
            let detail = args
                .cast::<ICoreWebView2ProcessFailedEventArgs2>()
                .ok()
                .map(|args| {
                    let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                    let mut exit_code = 0i32;
                    // SAFETY: live event argument, valid out pointers; failures leave defaults.
                    unsafe {
                        let _ = args.Reason(&mut reason);
                        let _ = args.ExitCode(&mut exit_code);
                    }
                    (reason.0, exit_code)
                });
            let reason = detail.map(|(reason, _)| reason_name(reason)).unwrap_or("not reported");
            let exit_code = detail
                .map(|(_, code)| format!("{:#010x}", code as u32))
                .unwrap_or_else(|| "not reported".to_string());

            match budget.decide(FailedProcess::from_kind(kind.0), Instant::now()) {
                Remedy::Reload => {
                    warn!(
                        target: "webview_recovery",
                        "WEBVIEW_PROCESS_FAILED kind=\"{}\" reason=\"{reason}\" exit_code={exit_code} remedy=reload",
                        kind_name(kind.0),
                    );
                    // After this callback returns, never inside it.
                    let webview = reload_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        match webview.reload() {
                            Ok(()) => info!(target: "webview_recovery", "WEBVIEW_RELOAD_REQUESTED after its render process exited"),
                            Err(error) => error!(target: "webview_recovery", "WEBVIEW_RELOAD_FAILED {error}"),
                        }
                    });
                }
                Remedy::ReloadAfter(wait) => {
                    error!(
                        target: "webview_recovery",
                        "WEBVIEW_PROCESS_FAILED kind=\"{}\" reason=\"{reason}\" exit_code={exit_code} remedy=reload_in_{}s: {MAX_RELOADS} reloads in {} s did not hold, the screen stays blank until then",
                        kind_name(kind.0),
                        wait.as_secs(),
                        RELOAD_WINDOW.as_secs(),
                    );
                    let webview = reload_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(wait).await;
                        match webview.reload() {
                            Ok(()) => info!(target: "webview_recovery", "WEBVIEW_RELOAD_REQUESTED after waiting for the reload budget"),
                            Err(error) => error!(target: "webview_recovery", "WEBVIEW_RELOAD_FAILED {error}"),
                        }
                    });
                }
                Remedy::LogOnly if FailedProcess::from_kind(kind.0) == FailedProcess::Browser => error!(
                    target: "webview_recovery",
                    "WEBVIEW_PROCESS_FAILED kind=\"{}\" reason=\"{reason}\" exit_code={exit_code} remedy=none: restart the application",
                    kind_name(kind.0),
                ),
                Remedy::LogOnly => warn!(
                    target: "webview_recovery",
                    "WEBVIEW_PROCESS_FAILED kind=\"{}\" reason=\"{reason}\" exit_code={exit_code} remedy=none",
                    kind_name(kind.0),
                ),
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: `core` is live, the handler is a valid COM object that WebView2 keeps alive,
        // and `token` is a valid out pointer. The registration lasts as long as the webview.
        if let Err(error) = unsafe { core.add_ProcessFailed(&handler, &mut token) } {
            warn!(target: "webview_recovery", "ProcessFailed registration failed: {error}");
        }
    });
    if let Err(error) = result {
        warn!(target: "webview_recovery", "with_webview failed: {error}");
    }
}

#[cfg(not(windows))]
pub fn install(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_lost_render_process_is_reloaded() {
        let now = Instant::now();
        let mut budget = ReloadBudget::default();
        assert_eq!(
            budget.decide(FailedProcess::from_kind(1), now),
            Remedy::Reload
        );
        // A page that may still answer, a frame, the GPU or a utility process: log only.
        for kind in [2, 3, 4, 5, 6, 7, 8, 9, 42] {
            assert_eq!(
                ReloadBudget::default().decide(FailedProcess::from_kind(kind), now),
                Remedy::LogOnly,
                "kind {kind}"
            );
        }
        // A lost browser process cannot be repaired by a reload.
        assert_eq!(FailedProcess::from_kind(0), FailedProcess::Browser);
        assert_eq!(
            ReloadBudget::default().decide(FailedProcess::Browser, now),
            Remedy::LogOnly
        );
    }

    #[test]
    fn a_page_that_keeps_dying_reloads_slowly_and_is_never_abandoned() {
        let start = Instant::now();
        let at = |second: u64| start + Duration::from_secs(second);
        let mut budget = ReloadBudget::default();
        for second in [0, 10, 20] {
            assert_eq!(
                budget.decide(FailedProcess::Renderer, at(second)),
                Remedy::Reload
            );
        }
        // A fourth loss within the window waits until the first reload is 120 s old.
        assert_eq!(
            budget.decide(FailedProcess::Renderer, at(30)),
            Remedy::ReloadAfter(Duration::from_secs(90))
        );
        // That reload happens at 120 s. If the page dies again at once, the next one waits for
        // the reload of second 10 to leave the window, and so on: never more than three
        // reloads in any 120 seconds, and always a next attempt.
        assert_eq!(
            budget.decide(FailedProcess::Renderer, at(125)),
            Remedy::ReloadAfter(Duration::from_secs(5))
        );
        assert_eq!(
            budget.decide(FailedProcess::Renderer, at(135)),
            Remedy::ReloadAfter(Duration::from_secs(5))
        );
        assert_eq!(
            budget.decide(FailedProcess::Renderer, at(145)),
            Remedy::ReloadAfter(Duration::from_secs(95))
        );
        // Once the page holds for a while, the budget is whole again.
        assert_eq!(
            budget.decide(FailedProcess::Renderer, at(600)),
            Remedy::Reload
        );
    }

    #[test]
    fn a_wait_is_never_negative_when_the_window_already_has_room_at_the_edge() {
        let start = Instant::now();
        let mut budget = ReloadBudget::default();
        for _ in 0..MAX_RELOADS {
            assert_eq!(
                budget.decide(FailedProcess::Renderer, start),
                Remedy::Reload
            );
        }
        // Exactly at the edge the oldest reloads have left the window.
        assert_eq!(
            budget.decide(FailedProcess::Renderer, start + RELOAD_WINDOW),
            Remedy::Reload
        );
    }

    #[test]
    fn other_failures_do_not_spend_the_reload_budget() {
        let now = Instant::now();
        let mut budget = ReloadBudget::default();
        for _ in 0..10 {
            assert_eq!(
                budget.decide(FailedProcess::RendererUnresponsive, now),
                Remedy::LogOnly
            );
            assert_eq!(budget.decide(FailedProcess::Other, now), Remedy::LogOnly);
        }
        for _ in 0..MAX_RELOADS {
            assert_eq!(budget.decide(FailedProcess::Renderer, now), Remedy::Reload);
        }
        assert_eq!(
            budget.decide(FailedProcess::Renderer, now),
            Remedy::ReloadAfter(RELOAD_WINDOW)
        );
    }

    #[test]
    fn names_what_webview2_reports() {
        assert_eq!(kind_name(1), "render process exited");
        assert_eq!(kind_name(2), "render process unresponsive");
        assert_eq!(kind_name(0), "browser process exited");
        assert_eq!(kind_name(99), "unknown process exited");
        assert_eq!(reason_name(3), "crashed");
        assert_eq!(reason_name(5), "out of memory");
        assert_eq!(reason_name(2), "terminated");
        assert_eq!(reason_name(99), "unknown");
    }
}
