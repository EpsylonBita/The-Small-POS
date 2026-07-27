//! Caller ID Manager — retained stopped-state facade for legacy IPC cleanup.
//!
//! Phase 1 does not compile or start the legacy SIP listener. This state stays
//! registered so status and stop calls remain safe during upgrades.

use std::sync::Mutex;
use tracing::info;

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
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            status: ListenerStatus::Stopped,
            error: None,
            reason: None,
            registered: false,
            calls_detected: 0,
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
}

impl CallerIdManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
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

    /// Keep legacy state stopped. No listener task exists in the Phase 1 graph.
    pub fn stop(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = ListenerStatus::Stopped;
            inner.registered = false;
            inner.error = None;
            inner.reason = None;
        }
    }

    /// Graceful shutdown — stop listener and clear state.
    #[allow(dead_code)]
    pub fn shutdown(&self) {
        self.stop();
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

    #[test]
    fn test_stop_without_task_is_safe() {
        let mgr = CallerIdManager::new();
        mgr.stop(); // Should not panic
        assert_eq!(mgr.get_status().status, ListenerStatus::Stopped);
    }

    #[test]
    fn test_shutdown() {
        let mgr = CallerIdManager::new();
        mgr.shutdown();
        assert_eq!(mgr.get_status().status, ListenerStatus::Stopped);
    }
}
