//! Caller ID Manager — retained stopped-state facade for legacy IPC cleanup.
//!
//! Phase 1 does not compile or start the legacy SIP listener. This state stays
//! registered so status and stop calls remain safe during upgrades.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
use tracing::info;
use uuid::Uuid;

use super::types::{CallerIdStatus, CallerIdStatusReason, ListenerStatus};

// ---------------------------------------------------------------------------
// Inner state
// ---------------------------------------------------------------------------

struct Inner {
    status: ListenerStatus,
    error: Option<String>,
    reason: Option<CallerIdStatusReason>,
    registered: bool,
    calls_detected: u64,
    generation: u64,
    stop_epoch: u64,
    supervisor_cancel: Option<CancellationToken>,
    supervisor_task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            status: ListenerStatus::Stopped,
            error: None,
            reason: None,
            registered: false,
            calls_detected: 0,
            generation: 0,
            stop_epoch: 0,
            supervisor_cancel: None,
            supervisor_task: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Central manager for the Caller ID / SIP listener.
///
/// Registered as Tauri managed state. The inner state is guarded by a
/// `Mutex` (same pattern as `ecr::DeviceManager`).
pub struct CallerIdManager {
    inner: Mutex<Inner>,
    lifecycle: tokio::sync::Mutex<()>,
    source_versions: Mutex<HashMap<Uuid, u32>>,
}

impl CallerIdManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            lifecycle: tokio::sync::Mutex::new(()),
            source_versions: Mutex::new(HashMap::new()),
        }
    }

    /// Get the current listener status.
    pub fn get_status(&self) -> CallerIdStatus {
        self.inner
            .lock()
            .map(|i| CallerIdStatus {
                status: i.status,
                error: i.error.clone(),
                reason: i.reason,
                registered: i.registered,
                calls_detected: i.calls_detected,
            })
            .unwrap_or(CallerIdStatus {
                status: ListenerStatus::Error,
                error: Some("Failed to acquire lock".into()),
                reason: Some(CallerIdStatusReason::Unknown),
                registered: false,
                calls_detected: 0,
            })
    }

    pub fn is_generation_current(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .is_ok_and(|inner| inner.generation == generation)
    }

    pub(crate) fn accept_source_version_snapshot<T>(
        &self,
        versions: &[(Uuid, u32)],
        accept: impl FnOnce() -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        let Ok(mut highest) = self.source_versions.lock() else {
            return Ok(None);
        };
        if versions.iter().any(|(source_id, source_version)| {
            highest
                .get(source_id)
                .is_some_and(|accepted| source_version < accepted)
        }) {
            return Ok(None);
        }
        let accepted = accept()?;
        for (source_id, source_version) in versions {
            highest
                .entry(*source_id)
                .and_modify(|current| *current = (*current).max(*source_version))
                .or_insert(*source_version);
        }
        Ok(Some(accepted))
    }

    #[cfg(test)]
    pub(crate) fn highest_source_version(&self, source_id: Uuid) -> Option<u32> {
        self.source_versions
            .lock()
            .ok()
            .and_then(|highest| highest.get(&source_id).copied())
    }

    pub fn set_listening(&self, generation: u64, active_workers: usize) -> bool {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation != generation {
                return false;
            }
            inner.status = if active_workers == 0 {
                ListenerStatus::Stopped
            } else {
                ListenerStatus::Listening
            };
            inner.error = None;
            inner.reason = None;
            return true;
        }
        false
    }

    pub fn set_error(&self, generation: u64, error: String, reason: CallerIdStatusReason) -> bool {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation != generation {
                return false;
            }
            inner.status = ListenerStatus::Error;
            inner.error = Some(error);
            inner.reason = Some(reason);
            return true;
        }
        false
    }

    pub fn increment_calls(&self, generation: u64) -> bool {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation != generation {
                return false;
            }
            inner.calls_detected = inner.calls_detected.saturating_add(1);
            return true;
        }
        false
    }

    async fn retire_supervisor(&self) {
        let task = self
            .inner
            .lock()
            .map(|mut inner| {
                inner.generation = inner.generation.saturating_add(1);
                let cancel = inner.supervisor_cancel.take();
                let task = inner.supervisor_task.take();
                if let Some(cancel) = cancel {
                    cancel.cancel();
                }
                inner.status = ListenerStatus::Stopped;
                inner.registered = false;
                inner.error = None;
                inner.reason = None;
                task
            })
            .unwrap_or(None);
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    /// Reserve this start synchronously, then replace the supervisor when the
    /// returned future is polled. A completed stop invalidates the reservation.
    pub fn replace_supervisor<F, Fut>(
        self: &Arc<Self>,
        root_cancel: CancellationToken,
        run: F,
    ) -> impl Future<Output = Option<u64>> + Send + 'static
    where
        F: FnOnce(u64, CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let manager = Arc::clone(self);
        let reserved_stop_epoch = self.inner.lock().ok().map(|inner| inner.stop_epoch);
        async move {
            let reserved_stop_epoch = reserved_stop_epoch?;
            let _lifecycle = manager.lifecycle.lock().await;
            if manager
                .inner
                .lock()
                .map_or(true, |inner| inner.stop_epoch != reserved_stop_epoch)
            {
                return None;
            }
            manager.retire_supervisor().await;
            if root_cancel.is_cancelled() {
                return None;
            }

            let (generation, supervisor_cancel) = {
                let mut inner = manager.inner.lock().ok()?;
                let generation = inner.generation;
                let supervisor_cancel = root_cancel.child_token();
                inner.supervisor_cancel = Some(supervisor_cancel.clone());
                (generation, supervisor_cancel)
            };
            let task = tauri::async_runtime::spawn(run(generation, supervisor_cancel));
            if let Ok(mut inner) = manager.inner.lock() {
                if inner.generation == generation {
                    inner.supervisor_task = Some(task);
                    return Some(generation);
                }
            }
            task.abort();
            None
        }
    }

    /// Stop and conclusively join the current connector supervisor.
    pub async fn stop(&self) {
        let _lifecycle = self.lifecycle.lock().await;
        if let Ok(mut inner) = self.inner.lock() {
            inner.stop_epoch = inner.stop_epoch.wrapping_add(1);
        }
        self.retire_supervisor().await;
    }

    fn reset_stopped_state(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = ListenerStatus::Stopped;
            inner.registered = false;
            inner.error = None;
            inner.reason = None;
        }
    }

    /// Graceful shutdown — stop listener and clear state.
    #[allow(dead_code)]
    pub async fn shutdown(&self) {
        self.stop().await;
        self.reset_stopped_state();
        info!("CallerIdManager shutdown complete");
    }
}

impl Default for CallerIdManager {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    #[test]
    fn test_new_manager_defaults() {
        let mgr = CallerIdManager::new();
        let status = mgr.get_status();
        assert_eq!(status.status, ListenerStatus::Stopped);
        assert!(!status.registered);
        assert_eq!(status.calls_detected, 0);
        assert!(status.error.is_none());
        assert!(status.reason.is_none());
    }

    #[tokio::test]
    async fn test_stop_without_task_is_safe() {
        let mgr = CallerIdManager::new();
        mgr.stop().await;
        assert_eq!(mgr.get_status().status, ListenerStatus::Stopped);
    }

    #[tokio::test]
    async fn test_shutdown() {
        let mgr = CallerIdManager::new();
        mgr.shutdown().await;
        assert_eq!(mgr.get_status().status, ListenerStatus::Stopped);
    }

    #[tokio::test]
    async fn stopping_the_manager_cancels_the_connector_supervisor() {
        let mgr = Arc::new(CallerIdManager::new());
        let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
        let generation = mgr
            .replace_supervisor(
                CancellationToken::new(),
                move |_generation, cancel| async move {
                    cancel.cancelled().await;
                    let _ = cancelled_tx.send(());
                },
            )
            .await
            .expect("installed supervisor generation");
        mgr.set_listening(generation, 1);

        mgr.stop().await;

        cancelled_rx
            .await
            .expect("supervisor observed cancellation");
        assert_eq!(mgr.get_status().status, ListenerStatus::Stopped);
    }

    #[tokio::test]
    async fn one_worker_error_can_recover_without_resetting_detected_calls() {
        let mgr = Arc::new(CallerIdManager::new());
        let generation = mgr
            .replace_supervisor(
                CancellationToken::new(),
                move |_generation, cancel| async move {
                    cancel.cancelled().await;
                },
            )
            .await
            .expect("installed supervisor generation");
        mgr.increment_calls(generation);
        mgr.set_error(
            generation,
            "one source channel failed".into(),
            CallerIdStatusReason::PortInUse,
        );
        mgr.set_listening(generation, 3);

        let status = mgr.get_status();
        assert_eq!(status.status, ListenerStatus::Listening);
        assert_eq!(status.calls_detected, 1);
        assert!(status.error.is_none());
        assert!(status.reason.is_none());
        mgr.stop().await;
    }

    #[tokio::test]
    async fn stopped_generation_cannot_acknowledge_work_or_overwrite_stopped_status() {
        let mgr = Arc::new(CallerIdManager::new());
        let old_task_manager = Arc::clone(&mgr);
        mgr.replace_supervisor(
            CancellationToken::new(),
            move |generation, cancel| async move {
                cancel.cancelled().await;
                old_task_manager.increment_calls(generation);
                old_task_manager.set_listening(generation, 1);
                old_task_manager.set_error(
                    generation,
                    "obsolete generation".into(),
                    CallerIdStatusReason::NetworkError,
                );
            },
        )
        .await;

        mgr.stop().await;

        let status = mgr.get_status();
        assert_eq!(status.status, ListenerStatus::Stopped);
        assert_eq!(status.calls_detected, 0);
        assert!(status.error.is_none());
        assert!(status.reason.is_none());
    }

    #[tokio::test]
    async fn replacement_generation_starts_only_after_old_supervisor_terminates() {
        let mgr = Arc::new(CallerIdManager::new());
        let old_terminated = Arc::new(AtomicBool::new(false));
        let old_terminated_in_task = Arc::clone(&old_terminated);
        mgr.replace_supervisor(
            CancellationToken::new(),
            move |_generation, cancel| async move {
                cancel.cancelled().await;
                old_terminated_in_task.store(true, Ordering::SeqCst);
            },
        )
        .await;

        let old_terminated_at_replacement_start = Arc::clone(&old_terminated);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        mgr.replace_supervisor(
            CancellationToken::new(),
            move |_generation, cancel| async move {
                let _ = started_tx.send(old_terminated_at_replacement_start.load(Ordering::SeqCst));
                cancel.cancelled().await;
            },
        )
        .await;

        assert!(
            started_rx.await.expect("replacement reports its start"),
            "replacement became authoritative before the old supervisor terminated"
        );
        mgr.stop().await;
    }

    #[tokio::test]
    async fn queued_start_reserved_before_stop_cannot_install_after_stop_returns() {
        let mgr = Arc::new(CallerIdManager::new());
        let supervisor_started = Arc::new(AtomicBool::new(false));
        let supervisor_started_in_task = Arc::clone(&supervisor_started);
        let queued_start = mgr.replace_supervisor(
            CancellationToken::new(),
            move |_generation, cancel| async move {
                supervisor_started_in_task.store(true, Ordering::SeqCst);
                cancel.cancelled().await;
            },
        );

        mgr.stop().await;
        let installed = queued_start.await;
        if installed.is_some() {
            mgr.stop().await;
        }

        assert!(
            installed.is_none(),
            "a start queued before stop installed a supervisor after stop returned"
        );
        assert!(
            !supervisor_started.load(Ordering::SeqCst),
            "a start queued before stop launched supervisor work after stop returned"
        );
        assert_eq!(mgr.get_status().status, ListenerStatus::Stopped);
    }

    #[tokio::test]
    async fn start_requested_after_stop_can_install_intentionally() {
        let mgr = Arc::new(CallerIdManager::new());
        mgr.stop().await;
        let supervisor_started = Arc::new(AtomicBool::new(false));
        let supervisor_started_in_task = Arc::clone(&supervisor_started);

        let installed = mgr
            .replace_supervisor(
                CancellationToken::new(),
                move |_generation, cancel| async move {
                    supervisor_started_in_task.store(true, Ordering::SeqCst);
                    cancel.cancelled().await;
                },
            )
            .await;

        assert!(installed.is_some());
        mgr.stop().await;
        assert!(supervisor_started.load(Ordering::SeqCst));
    }
}
