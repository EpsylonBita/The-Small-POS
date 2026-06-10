//! ECR Device Manager — central lifecycle orchestrator.
//!
//! Manages connected ECR devices (fiscal cash registers and payment terminals),
//! handling transport creation, protocol initialization, and transaction routing.
//! Registered as Tauri managed state.

use crate::ecr::protocol::*;
use crate::ecr::protocols;
use crate::ecr::transport;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, TryLockError};
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
// Locked-exchange helpers
// ---------------------------------------------------------------------------
//
// These free functions own the lock + poison-recovery + protocol-call block
// for a single device handle. They exist so the same semantics are shared
// between the synchronous manager methods and the `_offloaded` variants,
// whose `spawn_blocking` closures cannot capture `&self`.

/// Lock a device handle (recovering from poisoning) and run a transaction.
///
/// Wave 3: a panic inside `process_transaction` for any device used to
/// poison this mutex forever, permanently bricking the device in the
/// manager's view. We recover the guard from the `PoisonError` and
/// continue — the device protocol is expected to be in a recoverable
/// state or surface its own error on the next call. A fresh error is
/// still preferable to a permanent lockout.
fn process_transaction_on_handle(
    handle: &DeviceHandle,
    device_id: &str,
    request: &TransactionRequest,
) -> Result<TransactionResponse, String> {
    let mut dev = handle.lock().unwrap_or_else(|poisoned| {
        warn!(
            device_id = %device_id,
            "ManagedDevice mutex poisoned by prior transaction panic; recovering"
        );
        poisoned.into_inner()
    });
    dev.protocol.process_transaction(request)
}

/// Lock a device handle (recovering from poisoning) and run settlement.
///
/// Wave 2 H24: recover from a poisoned device mutex instead of returning
/// an error. If a prior `process_transaction` on the same device panicked
/// mid-I/O, the mutex is poisoned and the operator would otherwise be
/// blocked from closing out the day. Recovering the inner guard is safe
/// here because the invariants `settlement()` cares about live in the ECR
/// device itself (serial/TCP state), not in Rust-managed poisoning
/// metadata.
fn settlement_on_handle(
    handle: &DeviceHandle,
    device_id: &str,
) -> Result<SettlementResult, String> {
    let mut dev = handle.lock().unwrap_or_else(|poisoned| {
        warn!(
            device_id = %device_id,
            "ECR device mutex was poisoned; recovering for settlement"
        );
        poisoned.into_inner()
    });
    dev.protocol.settlement()
}

/// Lock a device handle (recovering from poisoning) and write raw bytes.
///
/// `send_raw` previously used a plain `.lock().map_err(...)`, so a panic
/// in a prior exchange permanently bricked "POS sends receipt" printing on
/// that device — inconsistent with every other access path in this file.
/// Recovery is safe for the same reason as the transaction path: the
/// invariants live in the device (serial/TCP state), not in Rust-managed
/// poisoning metadata.
fn send_raw_on_handle(
    handle: &DeviceHandle,
    device_id: &str,
    data: &[u8],
) -> Result<usize, String> {
    let mut dev = handle.lock().unwrap_or_else(|poisoned| {
        warn!(
            device_id = %device_id,
            "ManagedDevice mutex poisoned; recovering for send_raw"
        );
        poisoned.into_inner()
    });
    dev.protocol.send_raw(data)
}

/// Lock a device handle (recovering from poisoning) and run a
/// connectivity test through the already-established connection.
fn test_connection_on_handle(handle: &DeviceHandle, device_id: &str) -> Result<bool, String> {
    let mut dev = handle.lock().unwrap_or_else(|poisoned| {
        warn!(
            device_id = %device_id,
            "ManagedDevice mutex poisoned; recovering for test_connection"
        );
        poisoned.into_inner()
    });
    dev.protocol.test_connection()
}

/// Create a temporary transport + protocol (never registered in the map)
/// and run a connectivity test against it.
fn test_connection_unregistered(
    connection_type: &str,
    connection_details: &serde_json::Value,
    protocol_name: &str,
    protocol_config: &serde_json::Value,
) -> Result<bool, String> {
    let transport_box = transport::create_transport(connection_type, connection_details)?;
    let mut protocol = protocols::create_protocol(protocol_name, transport_box, protocol_config)?;
    protocol.test_connection()
}

/// Abort + log a device that has already been removed from the map.
///
/// Wave 3: recover from a poisoned mutex. A panic inside a prior
/// transaction would otherwise block cleanup forever.
fn abort_removed_device(handle: DeviceHandle) {
    let mut dev = handle.lock().unwrap_or_else(|poisoned| {
        warn!("ManagedDevice mutex poisoned during disconnect; recovering guard");
        poisoned.into_inner()
    });
    let _ = dev.protocol.abort();
    info!("Device {} disconnected", dev.device_id);
}

/// A protocol that has completed transport creation + device handshake,
/// plus the metadata the connect log line reports.
struct InitializedProtocol {
    protocol: Box<dyn EcrProtocol>,
    transport_description: String,
    initial_transport_state: transport::TransportState,
    protocol_display_name: String,
}

/// Create transport + protocol and run the device handshake.
///
/// This is the blocking section of device connection: transport creation
/// opens the serial port / TCP socket and `initialize()` performs the
/// device handshake, either of which can stall for seconds on absent or
/// misconfigured hardware. Free function so the `_offloaded` variant can
/// run it on the blocking pool without capturing `&self`.
fn build_initialized_protocol(
    connection_type: &str,
    connection_details: &serde_json::Value,
    protocol_name: &str,
    protocol_config: &serde_json::Value,
) -> Result<InitializedProtocol, String> {
    let transport_box = transport::create_transport(connection_type, connection_details)?;
    let transport_description = transport_box.description();
    let initial_transport_state = transport_box.state();

    let mut protocol = protocols::create_protocol(protocol_name, transport_box, protocol_config)?;

    // Initialize (connects transport + handshake)
    protocol.initialize()?;
    let protocol_display_name = protocol.name().to_string();

    Ok(InitializedProtocol {
        protocol,
        transport_description,
        initial_transport_state,
        protocol_display_name,
    })
}

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

    /// Store an initialized protocol in the device map and log the connect.
    fn register_connected_device(
        &self,
        device_id: &str,
        init: InitializedProtocol,
    ) -> Result<(), String> {
        let InitializedProtocol {
            protocol,
            transport_description,
            initial_transport_state,
            protocol_display_name,
        } = init;

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

    /// Connect a device by creating transport + protocol and initializing.
    ///
    /// Synchronous: blocks the calling thread for the transport connect +
    /// device handshake. Async callers must use
    /// [`connect_device_offloaded`](Self::connect_device_offloaded). All
    /// production call sites use the offloaded variant; this remains the
    /// synchronous reference implementation pinned by tests.
    #[cfg_attr(not(test), allow(dead_code))]
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

        let init = build_initialized_protocol(
            connection_type,
            connection_details,
            protocol_name,
            protocol_config,
        )?;
        self.register_connected_device(device_id, init)
    }

    /// Connect a device, running the blocking section on a dedicated
    /// blocking thread.
    ///
    /// Same rationale as
    /// [`process_transaction_offloaded`](Self::process_transaction_offloaded):
    /// transport connect + `initialize()` handshake are synchronous
    /// serial/TCP I/O that must not park a Tokio worker. The map removal
    /// and insert (which need `&self` and hold the map lock for
    /// microseconds) stay on the async side; the abort of any previously
    /// registered device moves into the blocking section too, because it
    /// writes to the old transport and — if that device is mid-exchange —
    /// waits on its mutex.
    pub async fn connect_device_offloaded(
        &self,
        device_id: &str,
        connection_type: &str,
        connection_details: &serde_json::Value,
        protocol_name: &str,
        protocol_config: &serde_json::Value,
    ) -> Result<(), String> {
        // Remove any existing registration first (short critical section).
        // Lock failure is discarded exactly like the sync variant's
        // `let _ = self.disconnect_device(...)`.
        let removed = self
            .devices
            .lock()
            .ok()
            .and_then(|mut devices| devices.remove(device_id));

        let connection_type = connection_type.to_string();
        let connection_details = connection_details.clone();
        let protocol_name = protocol_name.to_string();
        let protocol_config = protocol_config.clone();
        let init = tokio::task::spawn_blocking(move || {
            if let Some(handle) = removed {
                abort_removed_device(handle);
            }
            build_initialized_protocol(
                &connection_type,
                &connection_details,
                &protocol_name,
                &protocol_config,
            )
        })
        .await
        .map_err(|e| format!("ecr_connect_device join error: {e}"))??;

        self.register_connected_device(device_id, init)
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
            abort_removed_device(handle);
        }
        Ok(())
    }

    /// Process a transaction through a specific device.
    ///
    /// Synchronous: blocks the calling thread for the entire protocol
    /// exchange. Async callers on the Tokio runtime must use
    /// [`process_transaction_offloaded`](Self::process_transaction_offloaded)
    /// instead so the exchange does not park a runtime worker. All
    /// production call sites use the offloaded variant; this remains the
    /// synchronous reference implementation that the envelope-equivalence
    /// tests pin against.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn process_transaction(
        &self,
        device_id: &str,
        request: &TransactionRequest,
    ) -> Result<TransactionResponse, String> {
        let handle = self
            .handle_for(device_id)?
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
        process_transaction_on_handle(&handle, device_id, request)
    }

    /// Process a transaction on a dedicated blocking thread.
    ///
    /// The protocol exchange is synchronous TCP/serial I/O that can span
    /// the whole customer card interaction (ZVT transactions up to 60s).
    /// Tauri commands are async and run on Tokio workers, so calling the
    /// sync variant directly parked a worker for the entire exchange —
    /// on a low-core POS box, concurrent ECR calls could starve the
    /// runtime and freeze unrelated commands. Same offload pattern as the
    /// print worker (print.rs) and serial commands (commands/hardware.rs):
    /// clone the device handle out of the map (microseconds), then move
    /// the lock + exchange onto `spawn_blocking`. A panic inside the
    /// protocol surfaces as a join error (mapped to `Err`) and leaves the
    /// device mutex poisoned; the next access recovers it via the usual
    /// poison-recovery path.
    pub async fn process_transaction_offloaded(
        &self,
        device_id: &str,
        request: TransactionRequest,
    ) -> Result<TransactionResponse, String> {
        let handle = self
            .handle_for(device_id)?
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
        let device_id = device_id.to_string();
        tokio::task::spawn_blocking(move || {
            process_transaction_on_handle(&handle, &device_id, &request)
        })
        .await
        .map_err(|e| format!("ecr_process_transaction join error: {e}"))?
    }

    /// Get status of a connected device.
    ///
    /// Non-blocking by design: while a transaction or settlement holds
    /// the device mutex (offloaded onto a blocking thread for up to ~60s
    /// of customer card interaction), `try_lock` fails fast and we
    /// synthesize a busy/transaction-in-progress status instead of
    /// queueing. Repeated UI status polls would otherwise park one Tokio
    /// worker each on this mutex — and the status command also holds the
    /// SQLite connection lock while calling this, so a queued poll froze
    /// every other DB access in the POS for the exchange duration.
    pub fn get_device_status(&self, device_id: &str) -> Result<DeviceStatus, String> {
        let handle = match self.handle_for(device_id)? {
            Some(h) => h,
            None => return Ok(DeviceStatus::default()),
        };
        let mut dev = match handle.try_lock() {
            Ok(dev) => dev,
            Err(TryLockError::Poisoned(poisoned)) => {
                warn!(
                    device_id = %device_id,
                    "ManagedDevice mutex poisoned; recovering for get_device_status"
                );
                poisoned.into_inner()
            }
            Err(TryLockError::WouldBlock) => {
                // A transaction/settlement is mid-exchange on the blocking
                // thread. Report a synthetic in-progress status: the wire
                // shape already carries `busy` (the renderer's payment
                // modals gate terminal selection on `busy !== true`).
                return Ok(DeviceStatus {
                    connected: true,
                    ready: false,
                    busy: true,
                    ..DeviceStatus::default()
                });
            }
        };
        dev.protocol.get_status()
    }

    /// Test connectivity of a device.
    ///
    /// Synchronous: blocks the calling thread for the status inquiry (and,
    /// when the device is already connected, queues on the per-device mutex
    /// behind any in-flight transaction). Async callers must use
    /// [`test_connection_offloaded`](Self::test_connection_offloaded). All
    /// production call sites use the offloaded variant; this remains the
    /// synchronous reference implementation pinned by tests.
    #[cfg_attr(not(test), allow(dead_code))]
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
            return test_connection_on_handle(&handle, device_id);
        }

        // Otherwise, create a temporary connection for testing
        test_connection_unregistered(
            connection_type,
            connection_details,
            protocol_name,
            protocol_config,
        )
    }

    /// Test connectivity of a device on a dedicated blocking thread.
    ///
    /// Same rationale as
    /// [`process_transaction_offloaded`](Self::process_transaction_offloaded).
    /// Both paths block: the already-connected path runs a synchronous
    /// status inquiry — and queues on the per-device mutex behind any
    /// in-flight transaction (up to ~60s of customer card interaction) —
    /// while the not-connected path opens a temporary transport.
    pub async fn test_connection_offloaded(
        &self,
        device_id: &str,
        connection_type: &str,
        connection_details: &serde_json::Value,
        protocol_name: &str,
        protocol_config: &serde_json::Value,
    ) -> Result<bool, String> {
        // If already connected, test through existing connection
        if let Some(handle) = self.handle_for(device_id)? {
            let device_id = device_id.to_string();
            return tokio::task::spawn_blocking(move || {
                test_connection_on_handle(&handle, &device_id)
            })
            .await
            .map_err(|e| format!("ecr_test_connection join error: {e}"))?;
        }

        // Otherwise, create a temporary connection for testing
        let connection_type = connection_type.to_string();
        let connection_details = connection_details.clone();
        let protocol_name = protocol_name.to_string();
        let protocol_config = protocol_config.clone();
        tokio::task::spawn_blocking(move || {
            test_connection_unregistered(
                &connection_type,
                &connection_details,
                &protocol_name,
                &protocol_config,
            )
        })
        .await
        .map_err(|e| format!("ecr_test_connection join error: {e}"))?
    }

    /// Run end-of-day settlement on a device.
    ///
    /// Synchronous: blocks the calling thread for the entire exchange.
    /// Async callers must use [`settlement_offloaded`](Self::settlement_offloaded).
    /// All production call sites use the offloaded variant; this remains
    /// the synchronous reference implementation pinned by tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn settlement(&self, device_id: &str) -> Result<SettlementResult, String> {
        let handle = self
            .handle_for(device_id)?
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
        settlement_on_handle(&handle, device_id)
    }

    /// Run end-of-day settlement on a dedicated blocking thread.
    ///
    /// Same rationale as
    /// [`process_transaction_offloaded`](Self::process_transaction_offloaded):
    /// settlement is a long synchronous protocol exchange that must not
    /// park a Tokio worker.
    pub async fn settlement_offloaded(&self, device_id: &str) -> Result<SettlementResult, String> {
        let handle = self
            .handle_for(device_id)?
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
        let device_id = device_id.to_string();
        tokio::task::spawn_blocking(move || settlement_on_handle(&handle, &device_id))
            .await
            .map_err(|e| format!("ecr_settlement join error: {e}"))?
    }

    /// Send raw bytes to a device (for "POS sends receipt" mode).
    ///
    /// Synchronous: blocks the calling thread for the entire write (a full
    /// ESC/POS receipt to a serial/TCP printer can take seconds). Async
    /// callers must use [`send_raw_offloaded`](Self::send_raw_offloaded).
    /// All production call sites use the offloaded variant; this remains
    /// the synchronous reference implementation pinned by tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn send_raw(&self, device_id: &str, data: &[u8]) -> Result<usize, String> {
        let handle = self
            .handle_for(device_id)?
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
        send_raw_on_handle(&handle, device_id, data)
    }

    /// Send raw bytes to a device on a dedicated blocking thread.
    ///
    /// Same rationale as
    /// [`process_transaction_offloaded`](Self::process_transaction_offloaded):
    /// the ESC/POS write is synchronous serial/TCP I/O that must not park
    /// a Tokio worker, and in "POS sends receipt" mode it fires per order.
    pub async fn send_raw_offloaded(
        &self,
        device_id: &str,
        data: Vec<u8>,
    ) -> Result<usize, String> {
        let handle = self
            .handle_for(device_id)?
            .ok_or_else(|| format!("Device {device_id} not connected"))?;
        let device_id = device_id.to_string();
        tokio::task::spawn_blocking(move || send_raw_on_handle(&handle, &device_id, &data))
            .await
            .map_err(|e| format!("ecr_send_raw join error: {e}"))?
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
    use std::sync::mpsc;
    use std::time::Duration;

    fn sample_request(id: &str) -> TransactionRequest {
        TransactionRequest {
            transaction_id: id.into(),
            transaction_type: TransactionType::Sale,
            amount: 1000,
            currency: "EUR".into(),
            order_id: None,
            tip_amount: None,
            original_transaction_id: None,
            fiscal_data: None,
        }
    }

    fn stub_response(id: &str) -> TransactionResponse {
        TransactionResponse {
            transaction_id: id.to_string(),
            status: TransactionStatus::Approved,
            authorization_code: Some("AUTH-1".into()),
            terminal_reference: None,
            fiscal_receipt_number: None,
            fiscal_z_number: None,
            card_type: None,
            card_last_four: None,
            entry_method: None,
            customer_receipt_lines: None,
            merchant_receipt_lines: None,
            error_message: None,
            error_code: None,
            raw_response: None,
            started_at: "2026-01-01T00:00:00Z".into(),
            completed_at: "2026-01-01T00:00:01Z".into(),
        }
    }

    /// Minimal in-memory protocol — answers immediately.
    struct StubProtocol;

    impl EcrProtocol for StubProtocol {
        fn name(&self) -> &str {
            "Stub"
        }
        fn initialize(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn process_transaction(
            &mut self,
            request: &TransactionRequest,
        ) -> Result<TransactionResponse, String> {
            Ok(stub_response(&request.transaction_id))
        }
        fn cancel_transaction(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn get_status(&mut self) -> Result<DeviceStatus, String> {
            Ok(DeviceStatus {
                connected: true,
                ready: true,
                ..DeviceStatus::default()
            })
        }
        fn settlement(&mut self) -> Result<SettlementResult, String> {
            Ok(SettlementResult {
                success: true,
                transaction_count: 0,
                total_amount: 0,
                z_number: Some("Z-1".into()),
                error_message: None,
                raw_response: None,
            })
        }
        fn abort(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn test_connection(&mut self) -> Result<bool, String> {
            Ok(true)
        }
        fn send_raw(&mut self, data: &[u8]) -> Result<usize, String> {
            Ok(data.len())
        }
    }

    /// Protocol whose `process_transaction` blocks until the test releases
    /// it — simulates a customer card interaction in progress.
    struct GatedProtocol {
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl EcrProtocol for GatedProtocol {
        fn name(&self) -> &str {
            "Gated"
        }
        fn initialize(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn process_transaction(
            &mut self,
            request: &TransactionRequest,
        ) -> Result<TransactionResponse, String> {
            let _ = self.started.send(());
            let _ = self.release.recv();
            Ok(stub_response(&request.transaction_id))
        }
        fn cancel_transaction(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn get_status(&mut self) -> Result<DeviceStatus, String> {
            Ok(DeviceStatus {
                connected: true,
                ready: true,
                ..DeviceStatus::default()
            })
        }
        fn settlement(&mut self) -> Result<SettlementResult, String> {
            Err("not supported".into())
        }
        fn abort(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn test_connection(&mut self) -> Result<bool, String> {
            Ok(true)
        }
        fn send_raw(&mut self, data: &[u8]) -> Result<usize, String> {
            Ok(data.len())
        }
    }

    /// Register a stub device directly in the manager (bypasses transport
    /// creation, which would require real TCP/serial hardware in tests).
    fn insert_stub(
        mgr: &DeviceManager,
        device_id: &str,
        protocol: Box<dyn EcrProtocol>,
    ) -> DeviceHandle {
        let handle: DeviceHandle = Arc::new(Mutex::new(ManagedDevice {
            device_id: device_id.to_string(),
            protocol,
        }));
        mgr.devices
            .lock()
            .unwrap()
            .insert(device_id.to_string(), handle.clone());
        handle
    }

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

    #[test]
    fn test_get_status_busy_when_device_mutex_held() {
        let mgr = DeviceManager::new();
        let handle = insert_stub(&mgr, "dev-1", Box::new(StubProtocol));

        // Hold the device mutex on another thread, as an in-flight
        // transaction on the blocking pool would.
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _guard = handle.lock().unwrap();
            locked_tx.send(()).unwrap();
            let _ = release_rx.recv();
        });
        locked_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("holder thread never locked the device");

        // The poll must answer immediately with a synthetic busy status
        // instead of queueing on the mutex.
        let status = mgr.get_device_status("dev-1").unwrap();
        assert!(status.connected);
        assert!(status.busy);
        assert!(!status.ready);
        assert!(status.error.is_none());

        release_tx.send(()).unwrap();
        holder.join().unwrap();

        // Once the exchange is over, polls reach the protocol again.
        let status = mgr.get_device_status("dev-1").unwrap();
        assert!(!status.busy);
        assert!(status.ready);
    }

    #[test]
    fn test_get_status_recovers_from_poisoned_mutex() {
        let mgr = DeviceManager::new();
        let handle = insert_stub(&mgr, "dev-1", Box::new(StubProtocol));

        // Poison the device mutex the same way a protocol panic would.
        let _ = std::thread::spawn(move || {
            let _guard = handle.lock().unwrap();
            panic!("poison the device mutex");
        })
        .join();

        // try_lock on a poisoned mutex must recover, not report busy.
        let status = mgr.get_device_status("dev-1").unwrap();
        assert!(status.ready);
        assert!(!status.busy);
    }

    #[tokio::test]
    async fn test_process_transaction_offloaded_matches_sync_envelope() {
        let mgr = DeviceManager::new();
        insert_stub(&mgr, "dev-1", Box::new(StubProtocol));

        let sync_resp = mgr
            .process_transaction("dev-1", &sample_request("tx-1"))
            .unwrap();
        let off_resp = mgr
            .process_transaction_offloaded("dev-1", sample_request("tx-1"))
            .await
            .unwrap();

        // Scheduling change only — the response envelope must be identical.
        assert_eq!(sync_resp.transaction_id, off_resp.transaction_id);
        assert_eq!(sync_resp.status, off_resp.status);
        assert_eq!(sync_resp.authorization_code, off_resp.authorization_code);
    }

    #[tokio::test]
    async fn test_settlement_offloaded_matches_sync_envelope() {
        let mgr = DeviceManager::new();
        insert_stub(&mgr, "dev-1", Box::new(StubProtocol));

        let sync_res = mgr.settlement("dev-1").unwrap();
        let off_res = mgr.settlement_offloaded("dev-1").await.unwrap();

        assert_eq!(sync_res.success, off_res.success);
        assert_eq!(sync_res.transaction_count, off_res.transaction_count);
        assert_eq!(sync_res.total_amount, off_res.total_amount);
        assert_eq!(sync_res.z_number, off_res.z_number);
    }

    #[tokio::test]
    async fn test_process_transaction_offloaded_without_connect_errors() {
        let mgr = DeviceManager::new();
        let result = mgr
            .process_transaction_offloaded("no-device", sample_request("tx-1"))
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not connected"));
    }

    #[tokio::test]
    async fn test_settlement_offloaded_without_connect_errors() {
        let mgr = DeviceManager::new();
        let result = mgr.settlement_offloaded("no-device").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not connected"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_status_poll_not_blocked_during_offloaded_transaction() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let mgr = Arc::new(DeviceManager::new());
        insert_stub(
            &mgr,
            "dev-1",
            Box::new(GatedProtocol {
                started: started_tx,
                release: release_rx,
            }),
        );

        let tx_task = tokio::spawn({
            let mgr = Arc::clone(&mgr);
            async move {
                mgr.process_transaction_offloaded("dev-1", sample_request("tx-live"))
                    .await
            }
        });

        // Wait (off the runtime) until the exchange is provably in flight
        // on the blocking pool.
        tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(5)))
            .await
            .unwrap()
            .expect("offloaded transaction never started");

        // The status poll answers busy immediately while the card
        // interaction is in progress.
        let status = mgr.get_device_status("dev-1").unwrap();
        assert!(status.busy);
        assert!(!status.ready);

        release_tx.send(()).unwrap();
        let resp = tx_task.await.unwrap().unwrap();
        assert_eq!(resp.transaction_id, "tx-live");
        assert_eq!(resp.status, TransactionStatus::Approved);
    }

    #[tokio::test]
    async fn test_send_raw_offloaded_matches_sync_envelope() {
        let mgr = DeviceManager::new();
        insert_stub(&mgr, "dev-1", Box::new(StubProtocol));

        let sync_res = mgr.send_raw("dev-1", &[0x1B, 0x40, 0x0A]).unwrap();
        let off_res = mgr
            .send_raw_offloaded("dev-1", vec![0x1B, 0x40, 0x0A])
            .await
            .unwrap();

        // Scheduling change only — the response envelope must be identical.
        assert_eq!(sync_res, off_res);
        assert_eq!(off_res, 3);
    }

    #[tokio::test]
    async fn test_send_raw_offloaded_without_connect_errors() {
        let mgr = DeviceManager::new();
        let result = mgr.send_raw_offloaded("no-device", vec![0x1B]).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not connected"));
    }

    #[test]
    fn test_send_raw_recovers_from_poisoned_mutex() {
        let mgr = DeviceManager::new();
        let handle = insert_stub(&mgr, "dev-1", Box::new(StubProtocol));

        // Poison the device mutex the same way a protocol panic would.
        let _ = std::thread::spawn(move || {
            let _guard = handle.lock().unwrap();
            panic!("poison the device mutex");
        })
        .join();

        // Previously send_raw used a plain .lock().map_err and a poisoned
        // mutex permanently bricked raw printing on the device. It must
        // recover like every other access path in this file.
        let result = mgr.send_raw("dev-1", &[0x01, 0x02]).unwrap();
        assert_eq!(result, 2);
    }

    #[tokio::test]
    async fn test_test_connection_offloaded_matches_sync_envelope_when_connected() {
        let mgr = DeviceManager::new();
        insert_stub(&mgr, "dev-1", Box::new(StubProtocol));

        let cfg = serde_json::json!({});
        let sync_res = mgr
            .test_connection("dev-1", "serial_usb", &cfg, "generic", &cfg)
            .unwrap();
        let off_res = mgr
            .test_connection_offloaded("dev-1", "serial_usb", &cfg, "generic", &cfg)
            .await
            .unwrap();

        assert_eq!(sync_res, off_res);
        assert!(off_res);
    }

    #[tokio::test]
    async fn test_test_connection_offloaded_unknown_transport_matches_sync_envelope() {
        // Device not registered — both variants take the temporary-
        // connection path, which fails identically on an unknown
        // connection type before any real I/O.
        let mgr = DeviceManager::new();
        let cfg = serde_json::json!({});

        let sync_err = mgr
            .test_connection("no-device", "bogus", &cfg, "generic", &cfg)
            .unwrap_err();
        let off_err = mgr
            .test_connection_offloaded("no-device", "bogus", &cfg, "generic", &cfg)
            .await
            .unwrap_err();

        assert_eq!(sync_err, off_err);
        assert!(off_err.contains("Unknown connection type"));
    }

    #[test]
    fn test_test_connection_recovers_from_poisoned_mutex() {
        let mgr = DeviceManager::new();
        let handle = insert_stub(&mgr, "dev-1", Box::new(StubProtocol));

        let _ = std::thread::spawn(move || {
            let _guard = handle.lock().unwrap();
            panic!("poison the device mutex");
        })
        .join();

        let cfg = serde_json::json!({});
        let result = mgr
            .test_connection("dev-1", "serial_usb", &cfg, "generic", &cfg)
            .unwrap();
        assert!(result);
    }

    #[tokio::test]
    async fn test_connect_device_offloaded_unknown_transport_matches_sync_envelope() {
        // Transport creation happens before any real I/O, so an unknown
        // connection type exercises the offloaded failure path without
        // hardware. The error envelope must match the sync variant's.
        let mgr = DeviceManager::new();
        let cfg = serde_json::json!({});

        let sync_err = mgr
            .connect_device("dev-1", "bogus", &cfg, "generic", &cfg)
            .unwrap_err();
        let off_err = mgr
            .connect_device_offloaded("dev-1", "bogus", &cfg, "generic", &cfg)
            .await
            .unwrap_err();

        assert_eq!(sync_err, off_err);
        assert!(off_err.contains("Unknown connection type"));
        // A failed connect must not leave a registration behind.
        assert!(!mgr.is_connected("dev-1"));
    }

    #[tokio::test]
    async fn test_connect_device_offloaded_replaces_existing_registration() {
        // Re-connecting a device id must abort + drop the old registration
        // even when the new connect fails — same as the sync variant.
        let mgr = DeviceManager::new();
        insert_stub(&mgr, "dev-1", Box::new(StubProtocol));
        assert!(mgr.is_connected("dev-1"));

        let cfg = serde_json::json!({});
        let off_err = mgr
            .connect_device_offloaded("dev-1", "bogus", &cfg, "generic", &cfg)
            .await
            .unwrap_err();

        assert!(off_err.contains("Unknown connection type"));
        assert!(!mgr.is_connected("dev-1"));
    }
}
