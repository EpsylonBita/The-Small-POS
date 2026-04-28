//! Serial port abstraction for POS peripherals.
//!
//! Provides a managed connection pool for COM/serial ports used by scales,
//! serial barcode scanners, and customer displays.  Each opened port gets a
//! UUID handle; callers reference ports by handle rather than raw COM name.
//!
//! Key design goals:
//! - **Managed pool**: ports tracked in a `HashMap<handle, Box<dyn SerialPort>>`
//! - **Safe close**: closing a handle removes it from the pool
//! - **Enumeration**: `list_ports()` wraps `serialport::available_ports()`

use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{info, warn};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

/// Handle to a single open serial port.
///
/// Wave 2 H21: each port lives behind its OWN `Mutex`, wrapped in `Arc` so
/// the pool lock can be released after a cheap clone. The previous design
/// held the pool lock for the entire duration of every `read`/`write`
/// call, serialising all serial I/O across every peripheral through one
/// global lock — a 200 ms scale poll could block a barcode-scanner read,
/// an ECR status query, or a customer-display update.
///
/// The new ownership chain is:
///   1. Lock `PORT_POOL` briefly → clone the `PortHandle` for the key.
///   2. Release `PORT_POOL` lock.
///   3. Lock that port's own `Mutex` → perform I/O.
///
/// Step 3 still serialises access to the SAME port (correct — a half-read
/// followed by another read on the same serial handle would corrupt the
/// stream), but now allows I/O on OTHER ports to run in parallel.
type PortHandle = Arc<Mutex<Box<dyn serialport::SerialPort>>>;

/// Global pool of open serial ports. Key is a UUID handle string.
static PORT_POOL: Mutex<Option<HashMap<String, PortHandle>>> = Mutex::new(None);

fn pool() -> std::sync::MutexGuard<'static, Option<HashMap<String, PortHandle>>> {
    PORT_POOL.lock().unwrap_or_else(|e| e.into_inner())
}

/// Look up a port handle by its UUID, returning an `Arc` clone so callers
/// can do I/O without holding the pool lock. Returns `None` if the handle
/// is unknown (never opened, or already closed).
fn get_port_handle(handle: &str) -> Option<PortHandle> {
    pool().as_ref()?.get(handle).cloned()
}

/// Lock a single port's mutex, recovering from poisoning by taking the
/// inner guard — consistent with how `pool()` handles a poisoned pool
/// lock above. A poisoned port mutex means a prior I/O call panicked;
/// the underlying OS handle is still valid, so accepting the guard is
/// the pragmatic recovery.
fn lock_port(port: &PortHandle) -> std::sync::MutexGuard<'_, Box<dyn serialport::SerialPort>> {
    port.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// List available serial/COM ports on this system.
pub fn list_ports() -> Result<Value, String> {
    let ports = serialport::available_ports().map_err(|e| format!("Failed to list ports: {e}"))?;

    let list: Vec<Value> = ports
        .iter()
        .map(|p| {
            let mut obj = serde_json::json!({
                "name": p.port_name,
            });
            match &p.port_type {
                serialport::SerialPortType::UsbPort(usb) => {
                    obj["portType"] = "usb".into();
                    obj["vid"] = usb.vid.into();
                    obj["pid"] = usb.pid.into();
                    if let Some(ref m) = usb.manufacturer {
                        obj["manufacturer"] = m.clone().into();
                    }
                    if let Some(ref p) = usb.product {
                        obj["product"] = p.clone().into();
                    }
                    if let Some(ref s) = usb.serial_number {
                        obj["serialNumber"] = s.clone().into();
                    }
                }
                serialport::SerialPortType::BluetoothPort => {
                    obj["portType"] = "bluetooth".into();
                }
                serialport::SerialPortType::PciPort => {
                    obj["portType"] = "pci".into();
                }
                serialport::SerialPortType::Unknown => {
                    obj["portType"] = "unknown".into();
                }
            }
            obj
        })
        .collect();

    Ok(serde_json::json!({
        "success": true,
        "ports": list,
    }))
}

/// Open a serial port and return a handle ID.
///
/// # Arguments
/// - `port` — COM port name (e.g. "COM3", "/dev/ttyUSB0")
/// - `baud_rate` — baud rate (e.g. 9600, 115200)
/// - `timeout_ms` — read timeout in milliseconds (default 1000)
pub fn open_port(port: &str, baud_rate: u32, timeout_ms: Option<u64>) -> Result<Value, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(1000));

    let serial = serialport::new(port, baud_rate)
        .timeout(timeout)
        .open()
        .map_err(|e| format!("Failed to open {port} @ {baud_rate}: {e}"))?;

    let handle = Uuid::new_v4().to_string();
    {
        let mut guard = pool();
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(handle.clone(), Arc::new(Mutex::new(serial)));
    }

    info!(port = port, baud = baud_rate, handle = %handle, "Serial port opened");

    Ok(serde_json::json!({
        "success": true,
        "handle": handle,
        "port": port,
        "baudRate": baud_rate,
    }))
}

/// Write data to an open serial port.
///
/// Wave 2 H21: the pool lock is released before the blocking `write` /
/// `flush` so other ports' I/O can proceed in parallel. Per-port
/// serialisation is preserved via the port's own mutex.
pub fn write_port(handle: &str, data: &[u8]) -> Result<Value, String> {
    let port_handle =
        get_port_handle(handle).ok_or_else(|| format!("No open port with handle {handle}"))?;
    let mut port = lock_port(&port_handle);

    let written = port
        .write(data)
        .map_err(|e| format!("Serial write failed: {e}"))?;
    port.flush()
        .map_err(|e| format!("Serial flush failed: {e}"))?;

    Ok(serde_json::json!({
        "success": true,
        "bytesWritten": written,
    }))
}

/// Read data from an open serial port.
///
/// Returns up to `max_bytes` bytes. Returns empty if timeout expires with no data.
///
/// Wave 2 H21: the pool lock is released before the blocking `read` so a
/// slow 200 ms scale poll no longer blocks reads on other peripherals.
pub fn read_port(handle: &str, max_bytes: usize) -> Result<Value, String> {
    let port_handle =
        get_port_handle(handle).ok_or_else(|| format!("No open port with handle {handle}"))?;
    let mut port = lock_port(&port_handle);

    let mut buf = vec![0u8; max_bytes.min(4096)];
    match port.read(&mut buf) {
        Ok(n) => {
            buf.truncate(n);
            // Try to interpret as UTF-8, fallback to hex
            let text = String::from_utf8_lossy(&buf).to_string();
            Ok(serde_json::json!({
                "success": true,
                "bytesRead": n,
                "data": text,
                "raw": buf,
            }))
        }
        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(serde_json::json!({
            "success": true,
            "bytesRead": 0,
            "data": "",
            "raw": [],
        })),
        Err(e) => Err(format!("Serial read failed: {e}")),
    }
}

/// Close an open serial port and remove it from the pool.
///
/// Removing the `PortHandle` (the `Arc`) from the pool drops the
/// `Arc`-local reference. Any background thread still holding the
/// `Arc` from a previous `get_port_handle` call keeps the port alive
/// until its guard drops — correct, because an in-flight I/O call
/// must finish before the port is actually destroyed.
pub fn close_port(handle: &str) -> Result<Value, String> {
    let mut guard = pool();
    let map = guard.get_or_insert_with(HashMap::new);
    if map.remove(handle).is_some() {
        info!(handle = handle, "Serial port closed");
        Ok(serde_json::json!({ "success": true }))
    } else {
        warn!(handle = handle, "Close called on unknown handle");
        Ok(serde_json::json!({
            "success": false,
            "message": format!("No open port with handle {handle}"),
        }))
    }
}

/// Close all open serial ports (cleanup on app exit).
#[allow(dead_code)]
pub fn close_all() {
    let mut guard = pool();
    if let Some(map) = guard.as_mut() {
        let count = map.len();
        map.clear();
        if count > 0 {
            info!(count = count, "Closed all serial ports");
        }
    }
}

/// Check if a handle is still open.
#[allow(dead_code)]
pub fn is_open(handle: &str) -> bool {
    let guard = pool();
    guard
        .as_ref()
        .map(|m| m.contains_key(handle))
        .unwrap_or(false)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_ports_returns_array() {
        let result = list_ports().unwrap();
        assert_eq!(result["success"], true);
        assert!(result["ports"].is_array());
    }

    #[test]
    fn test_open_nonexistent_port_fails() {
        let result = open_port("COM999", 9600, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_read_unknown_handle_fails() {
        let result = read_port("no-such-handle", 256);
        assert!(result.is_err());
    }

    #[test]
    fn test_write_unknown_handle_fails() {
        let result = write_port("no-such-handle", b"hello");
        assert!(result.is_err());
    }

    #[test]
    fn test_close_unknown_handle() {
        let result = close_port("no-such-handle").unwrap();
        assert_eq!(result["success"], false);
    }

    #[test]
    fn test_is_open_false_for_unknown() {
        assert!(!is_open("no-such-handle"));
    }
}
