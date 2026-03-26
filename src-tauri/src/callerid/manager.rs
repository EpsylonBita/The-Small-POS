//! Caller ID Manager — lifecycle orchestrator for the SIP listener.
//!
//! Thread-safe singleton registered as Tauri managed state. Holds the
//! listener configuration, status, and a handle to the background task.

use std::sync::Mutex;
use tracing::info;

use super::types::{CallerIdConfig, CallerIdStatus, CallerIdStatusReason, ListenerStatus};

// ---------------------------------------------------------------------------
// Inner state
// ---------------------------------------------------------------------------

struct Inner {
    config: CallerIdConfig,
    status: ListenerStatus,
    error: Option<String>,
    reason: Option<CallerIdStatusReason>,
    registered: bool,
    calls_detected: u64,
    /// Handle to cancel the background listener task
    task_cancel: Option<tokio_util::sync::CancellationToken>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            config: CallerIdConfig::default(),
            status: ListenerStatus::Stopped,
            error: None,
            reason: None,
            registered: false,
            calls_detected: 0,
            task_cancel: None,
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

    /// Update the configuration. Does **not** restart the listener —
    /// call `stop()` then `start()` for that.
    pub fn update_config(&self, config: CallerIdConfig) {
        if let Ok(mut inner) = self.inner.lock() {
            info!(
                mode = ?config.mode,
                transport = ?config.transport,
                server = %config.sip_server,
                port = config.sip_port,
                username = %config.sip_username,
                listen_port = config.listen_port,
                enabled = config.enabled,
                has_password = config.has_password,
                "CallerIdManager config updated"
            );
            inner.config = config;
        }
    }

    /// Get a clone of the current configuration.
    #[allow(dead_code)]
    pub fn get_config(&self) -> CallerIdConfig {
        self.inner
            .lock()
            .map(|i| i.config.clone())
            .unwrap_or_default()
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

    /// Record that we're now in the `Listening` state after successful startup.
    #[allow(dead_code)]
    pub fn set_listening(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = ListenerStatus::Listening;
            inner.error = None;
            inner.reason = None;
        }
    }

    /// Record that registration was sent.
    pub fn set_registering(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = ListenerStatus::Registering;
            inner.reason = None;
        }
    }

    /// Record that registration succeeded.
    pub fn set_registered(&self, registered: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.registered = registered;
            if registered {
                inner.status = ListenerStatus::Listening;
                inner.error = None;
                inner.reason = None;
            }
        }
    }

    /// Record an error state.
    pub fn set_error(&self, error: String, reason: CallerIdStatusReason) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = ListenerStatus::Error;
            inner.error = Some(error);
            inner.reason = Some(reason);
        }
    }

    /// Increment the calls detected counter.
    pub fn increment_calls(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.calls_detected += 1;
        }
    }

    /// Store the cancellation token for the background listener task.
    pub fn set_task_cancel(&self, token: tokio_util::sync::CancellationToken) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.task_cancel = Some(token);
        }
    }

    /// Stop the background listener task (if running).
    pub fn stop(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(cancel) = inner.task_cancel.take() {
                info!("CallerIdManager: stopping SIP listener");
                cancel.cancel();
            }
            inner.status = ListenerStatus::Stopped;
            inner.registered = false;
            inner.error = None;
            inner.reason = None;
        }
    }

    /// Whether the listener is currently running (not stopped, not error).
    pub fn is_running(&self) -> bool {
        self.inner
            .lock()
            .map(|i| {
                matches!(
                    i.status,
                    ListenerStatus::Listening | ListenerStatus::Registering
                )
            })
            .unwrap_or(false)
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
    fn test_update_config() {
        let mgr = CallerIdManager::new();
        let config = CallerIdConfig {
            sip_server: "10.0.0.1".into(),
            sip_port: 5060,
            sip_username: "100".into(),
            listen_port: 5062,
            enabled: true,
            ..Default::default()
        };
        mgr.update_config(config.clone());
        let got = mgr.get_config();
        assert_eq!(got.sip_server, "10.0.0.1");
        assert_eq!(got.listen_port, 5062);
        assert!(got.enabled);
    }

    #[test]
    fn test_status_transitions() {
        let mgr = CallerIdManager::new();

        mgr.set_registering();
        assert_eq!(mgr.get_status().status, ListenerStatus::Registering);

        mgr.set_registered(true);
        assert_eq!(mgr.get_status().status, ListenerStatus::Listening);
        assert!(mgr.get_status().registered);

        mgr.set_error(
            "Connection refused".into(),
            CallerIdStatusReason::NetworkError,
        );
        assert_eq!(mgr.get_status().status, ListenerStatus::Error);
        assert_eq!(
            mgr.get_status().error.as_deref(),
            Some("Connection refused")
        );
        assert_eq!(
            mgr.get_status().reason,
            Some(CallerIdStatusReason::NetworkError)
        );

        mgr.stop();
        assert_eq!(mgr.get_status().status, ListenerStatus::Stopped);
        assert!(!mgr.get_status().registered);
    }

    #[test]
    fn test_increment_calls() {
        let mgr = CallerIdManager::new();
        mgr.increment_calls();
        mgr.increment_calls();
        mgr.increment_calls();
        assert_eq!(mgr.get_status().calls_detected, 3);
    }

    #[test]
    fn test_is_running() {
        let mgr = CallerIdManager::new();
        assert!(!mgr.is_running());

        mgr.set_listening();
        assert!(mgr.is_running());

        mgr.stop();
        assert!(!mgr.is_running());
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
        mgr.set_listening();
        mgr.shutdown();
        assert_eq!(mgr.get_status().status, ListenerStatus::Stopped);
    }
}
