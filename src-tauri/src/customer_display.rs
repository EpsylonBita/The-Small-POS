//! Customer-facing display driver for POS.
//!
//! Supports common VFD (vacuum fluorescent display) and LCD pole displays:
//! - **ESC/POS VFD**: 2×20 character display using ESC/POS commands
//! - **Serial LCD**: Raw text to 2×20 or 4×20 LCD via COM port
//! - **Network**: TCP to display controller (same pattern as drawer.rs)
//!
//! Key design goals:
//! - **Non-blocking**: display updates never block checkout flow
//! - **Fail-safe**: errors logged but never propagated to callers
//! - **Auto-format**: text truncated/padded to fit display width

use serde_json::Value;
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tracing::info;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Standard display width (characters per line).
const DISPLAY_WIDTH: usize = 20;

/// Standard display lines.
#[allow(dead_code)]
const DISPLAY_LINES: usize = 2;

/// TCP connect timeout for network displays.
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// TCP write timeout.
const TCP_WRITE_TIMEOUT: Duration = Duration::from_secs(2);

// ---------------------------------------------------------------------------
// ESC/POS VFD commands
// ---------------------------------------------------------------------------

/// Clear display and move cursor to home position.
const VFD_CLEAR: &[u8] = &[0x0C];

/// Move cursor to position (col, row): 0x1F 0x24 col row
fn vfd_cursor_pos(col: u8, row: u8) -> [u8; 4] {
    [0x1F, 0x24, col, row]
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum DisplayConnection {
    Serial { handle: String },
    Network { host: String, port: u16 },
}

static DISPLAY_CONNECTED: AtomicBool = AtomicBool::new(false);
static DISPLAY_CONN: Mutex<Option<DisplayConnection>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Pad or truncate a string to exactly `width` characters.
fn fit_line(text: &str, width: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() >= width {
        trimmed[..width].to_string()
    } else {
        format!("{:<width$}", trimmed, width = width)
    }
}

/// Right-align text within `width` characters.
fn right_align(text: &str, width: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() >= width {
        trimmed[..width].to_string()
    } else {
        format!("{:>width$}", trimmed, width = width)
    }
}

/// Send raw bytes to the display via serial or network.
fn send_bytes(data: &[u8]) -> Result<(), String> {
    let guard = DISPLAY_CONN.lock().unwrap_or_else(|e| e.into_inner());
    let conn = guard.as_ref().ok_or("Customer display not connected")?;

    match conn {
        DisplayConnection::Serial { handle } => {
            crate::serial::write_port(handle, data)?;
        }
        DisplayConnection::Network { host, port } => {
            let addr_str = format!("{host}:{port}");
            let addr: SocketAddr = addr_str
                .parse()
                .map_err(|e| format!("Invalid display address {addr_str}: {e}"))?;

            let stream = TcpStream::connect_timeout(&addr, TCP_CONNECT_TIMEOUT)
                .map_err(|e| format!("TCP connect to display {addr_str}: {e}"))?;

            stream
                .set_write_timeout(Some(TCP_WRITE_TIMEOUT))
                .map_err(|e| format!("set_write_timeout: {e}"))?;

            let mut writer = std::io::BufWriter::new(stream);
            writer
                .write_all(data)
                .map_err(|e| format!("TCP write to display: {e}"))?;
            writer
                .flush()
                .map_err(|e| format!("TCP flush to display: {e}"))?;
        }
    }

    Ok(())
}

/// Write text to display (clear + write lines).
fn write_display(line1: &str, line2: &str) -> Result<(), String> {
    let l1 = fit_line(line1, DISPLAY_WIDTH);
    let l2 = fit_line(line2, DISPLAY_WIDTH);

    let mut cmd: Vec<u8> = Vec::with_capacity(64);

    // Clear display
    cmd.extend_from_slice(VFD_CLEAR);

    // Line 1
    cmd.extend_from_slice(&vfd_cursor_pos(0, 0));
    cmd.extend_from_slice(l1.as_bytes());

    // Line 2
    cmd.extend_from_slice(&vfd_cursor_pos(0, 1));
    cmd.extend_from_slice(l2.as_bytes());

    send_bytes(&cmd)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Connect to a customer display.
///
/// # Arguments
/// - `connection_type` — "serial" or "network"
/// - `port_or_ip` — COM port name or IP address
/// - `port_number` — TCP port (for network displays, default 9100)
/// - `baud_rate` — for serial displays (default 9600)
pub fn connect(
    connection_type: &str,
    port_or_ip: &str,
    port_number: Option<u16>,
    baud_rate: Option<u32>,
) -> Result<Value, String> {
    if DISPLAY_CONNECTED.load(Ordering::SeqCst) {
        let _ = disconnect();
    }

    let conn = match connection_type {
        "network" | "tcp" => {
            let port = port_number.unwrap_or(9100);
            DisplayConnection::Network {
                host: port_or_ip.to_string(),
                port,
            }
        }
        _ => {
            // Serial connection
            let baud = baud_rate.unwrap_or(9600);
            let result = crate::serial::open_port(port_or_ip, baud, Some(500))?;
            let handle = result["handle"]
                .as_str()
                .ok_or("No serial handle returned")?
                .to_string();
            DisplayConnection::Serial { handle }
        }
    };

    {
        let mut guard = DISPLAY_CONN.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(conn);
    }
    DISPLAY_CONNECTED.store(true, Ordering::SeqCst);

    // Clear and show welcome
    let _ = write_display("   THE SMALL POS", "    Welcome!");

    info!(
        connection = connection_type,
        target = port_or_ip,
        "Customer display connected"
    );

    Ok(serde_json::json!({
        "success": true,
        "connectionType": connection_type,
        "target": port_or_ip,
    }))
}

/// Disconnect the customer display.
pub fn disconnect() -> Result<Value, String> {
    if !DISPLAY_CONNECTED.load(Ordering::SeqCst) {
        return Ok(serde_json::json!({
            "success": true,
            "message": "Display was not connected",
        }));
    }

    // Clear display before disconnecting
    let _ = send_bytes(VFD_CLEAR);

    // Close serial port if applicable
    {
        let mut guard = DISPLAY_CONN.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(DisplayConnection::Serial { ref handle }) = *guard {
            let _ = crate::serial::close_port(handle);
        }
        *guard = None;
    }

    DISPLAY_CONNECTED.store(false, Ordering::SeqCst);
    info!("Customer display disconnected");

    Ok(serde_json::json!({ "success": true }))
}

/// Show two lines of text on the display.
pub fn show_line(line1: &str, line2: &str) -> Result<Value, String> {
    if !DISPLAY_CONNECTED.load(Ordering::SeqCst) {
        return Ok(serde_json::json!({
            "success": false,
            "message": "Display not connected",
        }));
    }

    write_display(line1, line2)?;

    Ok(serde_json::json!({ "success": true }))
}

/// Show an item being added to the order.
///
/// Line 1: item name (left-aligned)
/// Line 2: qty × price (right-aligned)
pub fn show_item(name: &str, price: f64, qty: i32, currency: &str) -> Result<Value, String> {
    if !DISPLAY_CONNECTED.load(Ordering::SeqCst) {
        return Ok(serde_json::json!({
            "success": false,
            "message": "Display not connected",
        }));
    }

    let line1 = fit_line(name, DISPLAY_WIDTH);
    let price_str = if qty > 1 {
        format!("{qty}x {currency}{price:.2}")
    } else {
        format!("{currency}{price:.2}")
    };
    let line2 = right_align(&price_str, DISPLAY_WIDTH);

    write_display(&line1, &line2)?;

    Ok(serde_json::json!({ "success": true }))
}

/// Show the order total on the display.
///
/// Line 1: "TOTAL:"
/// Line 2: currency + total (right-aligned)
pub fn show_total(subtotal: f64, tax: f64, total: f64, currency: &str) -> Result<Value, String> {
    if !DISPLAY_CONNECTED.load(Ordering::SeqCst) {
        return Ok(serde_json::json!({
            "success": false,
            "message": "Display not connected",
        }));
    }

    let line1 = if tax > 0.0 {
        format!("TAX: {currency}{tax:.2}")
    } else {
        "TOTAL".to_string()
    };
    let total_str = format!("{currency}{total:.2}");
    let line2 = right_align(&total_str, DISPLAY_WIDTH);

    let _ = subtotal; // available for future use
    write_display(&line1, &line2)?;

    Ok(serde_json::json!({ "success": true }))
}

/// Clear the display.
pub fn clear() -> Result<Value, String> {
    if !DISPLAY_CONNECTED.load(Ordering::SeqCst) {
        return Ok(serde_json::json!({
            "success": false,
            "message": "Display not connected",
        }));
    }

    send_bytes(VFD_CLEAR)?;

    Ok(serde_json::json!({ "success": true }))
}

/// Get display connection status.
pub fn get_status() -> Result<Value, String> {
    let connected = DISPLAY_CONNECTED.load(Ordering::SeqCst);
    let guard = DISPLAY_CONN.lock().unwrap_or_else(|e| e.into_inner());

    let (conn_type, target) = match guard.as_ref() {
        Some(DisplayConnection::Serial { handle }) => ("serial", handle.clone()),
        Some(DisplayConnection::Network { host, port }) => ("network", format!("{host}:{port}")),
        None => ("none", String::new()),
    };

    Ok(serde_json::json!({
        "connected": connected,
        "connectionType": conn_type,
        "target": target,
    }))
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fit_line_short() {
        let result = fit_line("Hello", 20);
        assert_eq!(result.len(), 20);
        assert!(result.starts_with("Hello"));
    }

    #[test]
    fn test_fit_line_long() {
        let result = fit_line("This is a very long text that exceeds twenty chars", 20);
        assert_eq!(result.len(), 20);
    }

    #[test]
    fn test_fit_line_exact() {
        let result = fit_line("12345678901234567890", 20);
        assert_eq!(result.len(), 20);
        assert_eq!(result, "12345678901234567890");
    }

    #[test]
    fn test_right_align() {
        let result = right_align("$5.00", 20);
        assert_eq!(result.len(), 20);
        assert!(result.ends_with("$5.00"));
    }

    #[test]
    fn test_vfd_cursor_pos() {
        let cmd = vfd_cursor_pos(0, 1);
        assert_eq!(cmd, [0x1F, 0x24, 0, 1]);
    }

    #[test]
    fn test_disconnect_when_not_connected() {
        DISPLAY_CONNECTED.store(false, Ordering::SeqCst);
        let result = disconnect().unwrap();
        assert_eq!(result["success"], true);
    }

    #[test]
    fn test_show_line_not_connected() {
        DISPLAY_CONNECTED.store(false, Ordering::SeqCst);
        let result = show_line("Hello", "World").unwrap();
        assert_eq!(result["success"], false);
    }

    #[test]
    fn test_show_item_not_connected() {
        DISPLAY_CONNECTED.store(false, Ordering::SeqCst);
        let result = show_item("Coffee", 3.50, 1, "$").unwrap();
        assert_eq!(result["success"], false);
    }

    #[test]
    fn test_show_total_not_connected() {
        DISPLAY_CONNECTED.store(false, Ordering::SeqCst);
        let result = show_total(10.0, 2.4, 12.4, "$").unwrap();
        assert_eq!(result["success"], false);
    }

    #[test]
    fn test_clear_not_connected() {
        DISPLAY_CONNECTED.store(false, Ordering::SeqCst);
        let result = clear().unwrap();
        assert_eq!(result["success"], false);
    }

    #[test]
    fn test_get_status_not_connected() {
        DISPLAY_CONNECTED.store(false, Ordering::SeqCst);
        {
            let mut g = DISPLAY_CONN.lock().unwrap();
            *g = None;
        }
        let result = get_status().unwrap();
        assert_eq!(result["connected"], false);
    }
}
