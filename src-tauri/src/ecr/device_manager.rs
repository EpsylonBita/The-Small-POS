//! ECR Device Manager — central lifecycle orchestrator.
//!
//! Manages connected ECR devices (fiscal cash registers and payment terminals),
//! handling transport creation, protocol initialization, and transaction routing.
//! Registered as Tauri managed state.

use crate::ecr::protocol::*;
use crate::ecr::protocols;
use crate::ecr::transport;
use std::collections::HashMap;
use std::sync::Mutex;
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Managed device
// ---------------------------------------------------------------------------

struct ManagedDevice {
    device_id: String,
    protocol: Box<dyn EcrProtocol>,
}

// ---------------------------------------------------------------------------
// Device Manager
// ---------------------------------------------------------------------------

/// Central manager for all connected ECR devices.
///
/// Thread-safe singleton registered as Tauri managed state.
pub struct DeviceManager {
    devices: Mutex<HashMap<String, ManagedDevice>>,
}

impl DeviceManager {
    pub fn new() -> Self {
        Self {
            devices: Mutex::new(HashMap::new()),
        }
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

        // Create protocol adapter
        let mut protocol =
            protocols::create_protocol(protocol_name, transport_box, protocol_config)?;

        // Initialize (connects transport + handshake)
        protocol.initialize()?;

        // Store managed device
        let mut devices = self.devices.lock().map_err(|e| e.to_string())?;
        devices.insert(
            device_id.to_string(),
            ManagedDevice {
                device_id: device_id.to_string(),
                protocol,
            },
        );

        info!("Device {device_id} connected ({protocol_name} via {connection_type})");
        Ok(())
    }

    /// Disconnect a device and remove from the manager.
    pub fn disconnect_device(&self, device_id: &str) -> Result<(), String> {
        let mut devices = self.devices.lock().map_err(|e| e.to_string())?;
        if let Some(mut dev) = devices.remove(device_id) {
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
        let mut devices = self.devices.lock().map_err(|e| e.to_string())?;
        let dev = devices
            .get_mut(device_id)
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
        dev.protocol.process_transaction(request)
    }

    /// Get status of a connected device.
    pub fn get_device_status(&self, device_id: &str) -> Result<DeviceStatus, String> {
        let mut devices = self.devices.lock().map_err(|e| e.to_string())?;
        match devices.get_mut(device_id) {
            Some(dev) => dev.protocol.get_status(),
            None => Ok(DeviceStatus::default()),
        }
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
        {
            let mut devices = self.devices.lock().map_err(|e| e.to_string())?;
            if let Some(dev) = devices.get_mut(device_id) {
                return dev.protocol.test_connection();
            }
        }

        // Otherwise, create a temporary connection for testing
        let transport_box = transport::create_transport(connection_type, connection_details)?;
        let mut protocol =
            protocols::create_protocol(protocol_name, transport_box, protocol_config)?;
        protocol.test_connection()
    }

    /// Run end-of-day settlement on a device.
    pub fn settlement(&self, device_id: &str) -> Result<SettlementResult, String> {
        let mut devices = self.devices.lock().map_err(|e| e.to_string())?;
        let dev = devices
            .get_mut(device_id)
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
        dev.protocol.settlement()
    }

    /// Send raw bytes to a device (for "POS sends receipt" mode).
    pub fn send_raw(&self, device_id: &str, data: &[u8]) -> Result<usize, String> {
        let mut devices = self.devices.lock().map_err(|e| e.to_string())?;
        let dev = devices
            .get_mut(device_id)
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
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
