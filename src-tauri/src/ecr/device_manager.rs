//! ECR Device Manager — central lifecycle orchestrator.
//!
//! Manages connected ECR devices (fiscal cash registers and payment terminals),
//! handling transport creation, protocol initialization, and transaction routing.
//! Registered as Tauri managed state.

use crate::ecr::protocol::*;
use crate::ecr::protocols;
use crate::ecr::transport;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Managed device
// ---------------------------------------------------------------------------

struct ManagedDevice {
    device_id: String,
    protocol: Box<dyn EcrProtocol>,
}

type DeviceHandle = Arc<Mutex<ManagedDevice>>;

// ---------------------------------------------------------------------------
// Device Manager
// ---------------------------------------------------------------------------

/// Central manager for all connected ECR devices.
///
/// Thread-safe singleton registered as Tauri managed state.
///
/// Locking strategy: the outer `Mutex<HashMap>` is held only for the
/// duration of map lookups/inserts (microseconds). Each device is wrapped
/// in its own `Arc<Mutex<ManagedDevice>>` so that a long-running protocol
/// exchange (e.g. ZVT transactions up to 60s) on device A does not block
/// concurrent status polls or transactions on device B. Previously the
/// HashMap mutex was held for the entire protocol call, serializing all
/// ECR traffic through a single lock.
pub struct DeviceManager {
    devices: Mutex<HashMap<String, DeviceHandle>>,
}

impl DeviceManager {
    pub fn new() -> Self {
        Self {
            devices: Mutex::new(HashMap::new()),
        }
    }

    /// Clone-out a handle for a device if one exists, releasing the map
    /// lock before the caller operates on the device. Returns None if
    /// the device id is not registered.
    fn handle_for(&self, device_id: &str) -> Result<Option<DeviceHandle>, String> {
        let devices = self.devices.lock().map_err(|e| e.to_string())?;
        Ok(devices.get(device_id).cloned())
    }

    /// Connect a device by creating transport + protocol and initializing.
    pub fn connect_device(
        &self,
        device_id: &str,
        connection_type: &str,
        connection_details: &serde_json::Value,
        protocol_name: &str,
        protocol_config: &serde_json::Value,
    ) -> Result<(), String> {
        // Disconnect existing if any
        let _ = self.disconnect_device(device_id);

        // Create transport
        let transport_box = transport::create_transport(connection_type, connection_details)?;
        let transport_description = transport_box.description();
        let initial_transport_state = transport_box.state();

        // Create protocol adapter
        let mut protocol =
            protocols::create_protocol(protocol_name, transport_box, protocol_config)?;

        // Initialize (connects transport + handshake)
        protocol.initialize()?;
        let protocol_display_name = protocol.name().to_string();

        // Store managed device behind its own Mutex
        let handle: DeviceHandle = Arc::new(Mutex::new(ManagedDevice {
            device_id: device_id.to_string(),
            protocol,
        }));
        {
            let mut devices = self.devices.lock().map_err(|e| e.to_string())?;
            devices.insert(device_id.to_string(), handle);
        }

        info!(
            "Device {device_id} connected ({protocol_display_name} via {transport_description}, initial transport state: {initial_transport_state:?})"
        );
        Ok(())
    }

    /// Disconnect a device and remove from the manager.
    pub fn disconnect_device(&self, device_id: &str) -> Result<(), String> {
        // Remove from the map first (short critical section), then abort the
        // protocol outside the map lock so it cannot serialize other devices.
        let removed = {
            let mut devices = self.devices.lock().map_err(|e| e.to_string())?;
            devices.remove(device_id)
        };
        if let Some(handle) = removed {
            // Wave 3: recover from a poisoned mutex. A panic inside a
            // prior transaction would otherwise block cleanup forever.
            let mut dev = handle.lock().unwrap_or_else(|poisoned| {
                warn!(
                    "ManagedDevice mutex poisoned during disconnect; recovering guard"
                );
                poisoned.into_inner()
            });
            let _ = dev.protocol.abort();
            info!("Device {} disconnected", dev.device_id);
        }
        Ok(())
    }

    /// Process a transaction through a specific device.
    pub fn process_transaction(
        &self,
        device_id: &str,
        request: &TransactionRequest,
    ) -> Result<TransactionResponse, String> {
        let handle = self
            .handle_for(device_id)?
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
        // Wave 3: on HEAD, a panic inside `process_transaction` for any
        // device poisoned this mutex forever, permanently bricking the
        // device in the manager's view. We now recover the guard from
        // the `PoisonError` and continue — the device protocol is
        // expected to be in a recoverable state or surface its own
        // error on the next call. A fresh error is still preferable to
        // a permanent lockout.
        let mut dev = handle.lock().unwrap_or_else(|poisoned| {
            warn!(
                device_id = %device_id,
                "ManagedDevice mutex poisoned by prior transaction panic; recovering"
            );
            poisoned.into_inner()
        });
        dev.protocol.process_transaction(request)
    }

    /// Get status of a connected device.
    pub fn get_device_status(&self, device_id: &str) -> Result<DeviceStatus, String> {
        let handle = match self.handle_for(device_id)? {
            Some(h) => h,
            None => return Ok(DeviceStatus::default()),
        };
        let mut dev = handle.lock().unwrap_or_else(|poisoned| {
            warn!(
                device_id = %device_id,
                "ManagedDevice mutex poisoned; recovering for get_device_status"
            );
            poisoned.into_inner()
        });
        dev.protocol.get_status()
    }

    /// Test connectivity of a device.
    pub fn test_connection(
        &self,
        device_id: &str,
        connection_type: &str,
        connection_details: &serde_json::Value,
        protocol_name: &str,
        protocol_config: &serde_json::Value,
    ) -> Result<bool, String> {
        // If already connected, test through existing connection
        if let Some(handle) = self.handle_for(device_id)? {
            let mut dev = handle.lock().unwrap_or_else(|poisoned| {
                warn!(
                    device_id = %device_id,
                    "ManagedDevice mutex poisoned; recovering for test_connection"
                );
                poisoned.into_inner()
            });
            return dev.protocol.test_connection();
        }

        // Otherwise, create a temporary connection for testing
        let transport_box = transport::create_transport(connection_type, connection_details)?;
        let mut protocol =
            protocols::create_protocol(protocol_name, transport_box, protocol_config)?;
        protocol.test_connection()
    }

    /// Run end-of-day settlement on a device.
    pub fn settlement(&self, device_id: &str) -> Result<SettlementResult, String> {
        let handle = self
            .handle_for(device_id)?
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
        let mut dev = handle.lock().map_err(|e| e.to_string())?;
        dev.protocol.settlement()
    }

    /// Send raw bytes to a device (for "POS sends receipt" mode).
    pub fn send_raw(&self, device_id: &str, data: &[u8]) -> Result<usize, String> {
        let handle = self
            .handle_for(device_id)?
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
        let mut dev = handle.lock().map_err(|e| e.to_string())?;
        dev.protocol.send_raw(data)
    }

    /// Check if a device is currently connected/managed.
    pub fn is_connected(&self, device_id: &str) -> bool {
        self.devices
            .lock()
            .map(|d| d.contains_key(device_id))
            .unwrap_or(false)
    }

    /// List all connected device IDs.
    pub fn connected_device_ids(&self) -> Vec<String> {
        self.devices
            .lock()
            .map(|d| d.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Gracefully disconnect all devices (app shutdown).
    pub fn shutdown(&self) {
        let ids = self.connected_device_ids();
        for id in &ids {
            if let Err(e) = self.disconnect_device(id) {
                warn!("Error disconnecting {id} during shutdown: {e}");
            }
        }
        info!(
            "DeviceManager shutdown — {} devices disconnected",
            ids.len()
        );
    }
}

impl Default for DeviceManager {
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
    fn test_device_manager_new() {
        let mgr = DeviceManager::new();
        assert!(mgr.connected_device_ids().is_empty());
        assert!(!mgr.is_connected("nonexistent"));
    }

    #[test]
    fn test_disconnect_nonexistent_is_ok() {
        let mgr = DeviceManager::new();
        assert!(mgr.disconnect_device("does-not-exist").is_ok());
    }

    #[test]
    fn test_process_transaction_without_connect_errors() {
        let mgr = DeviceManager::new();
        let req = TransactionRequest {
            transaction_id: "tx-1".into(),
            transaction_type: TransactionType::Sale,
            amount: 1000,
            currency: "EUR".into(),
            order_id: None,
            tip_amount: None,
            original_transaction_id: None,
            fiscal_data: None,
        };
        let result = mgr.process_transaction("no-device", &req);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not connected"));
    }

    #[test]
    fn test_get_status_disconnected_returns_default() {
        let mgr = DeviceManager::new();
        let status = mgr.get_device_status("no-device").unwrap();
        assert!(!status.connected);
        assert!(!status.ready);
    }

    #[test]
    fn test_shutdown_empty_manager() {
        let mgr = DeviceManager::new();
        mgr.shutdown(); // Should not panic
    }
}
