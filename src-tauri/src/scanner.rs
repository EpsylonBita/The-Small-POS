//! Serial barcode scanner driver for COM port scanners.
//!
//! Complements the keyboard-wedge barcode scanner (frontend `useBarcodeScanner`)
//! with support for scanners connected via serial/COM port.
//!
//! Key design goals:
//! - **Background reader**: tokio task reads serial port, emits Tauri events
//! - **Same event shape**: `barcode_scanned_serial` event is compatible with
//!   the keyboard-wedge scanner context
//! - **Auto-reconnect**: on read failure, retries after backoff

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

static SCANNER_RUNNING: AtomicBool = AtomicBool::new(false);
static SCANNER_HANDLE: Mutex<Option<String>> = Mutex::new(None);
static SCANNER_PORT: Mutex<Option<String>> = Mutex::new(None);
static LAST_SCAN: Mutex<Option<String>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Start the serial barcode scanner background reader.
///
/// Opens the COM port and spawns a tokio task that reads newline-terminated
/// barcodes and emits `barcode_scanned_serial` Tauri events.
pub fn start(port: &str, baud_rate: u32, app: tauri::AppHandle) -> Result<Value, String> {
    if SCANNER_RUNNING.load(Ordering::SeqCst) {
        return Err("Serial scanner already running — stop first".to_string());
    }

    let result = crate::serial::open_port(port, baud_rate, Some(200))?;
    let handle = result["handle"]
        .as_str()
        .ok_or("No handle returned")?
        .to_string();

    {
        let mut h = SCANNER_HANDLE.lock().unwrap_or_else(|e| e.into_inner());
        *h = Some(handle.clone());
    }
    {
        let mut p = SCANNER_PORT.lock().unwrap_or_else(|e| e.into_inner());
        *p = Some(port.to_string());
    }

    SCANNER_RUNNING.store(true, Ordering::SeqCst);

    let port_name = port.to_string();
    let handle_clone = handle.clone();

    tokio::spawn(async move {
        info!(port = %port_name, "Serial scanner background reader started");
        let mut line_buf = String::new();

        while SCANNER_RUNNING.load(Ordering::SeqCst) {
            match crate::serial::read_port(&handle_clone, 256) {
                Ok(result) => {
                    if let Some(data) = result["data"].as_str() {
                        if !data.is_empty() {
                            line_buf.push_str(data);

                            // Process complete lines (barcodes end with \r\n or \n)
                            while let Some(pos) = line_buf.find('\n') {
                                let barcode = line_buf[..pos].trim().to_string();
                                line_buf = line_buf[pos + 1..].to_string();

                                if barcode.len() >= 3 && barcode.len() <= 50 {
                                    info!(barcode = %barcode, "Serial scanner: barcode detected");

                                    // Store last scan
                                    if let Ok(mut ls) = LAST_SCAN.lock() {
                                        *ls = Some(barcode.clone());
                                    }

                                    // Emit Tauri event
                                    use tauri::Emitter;
                                    let _ = app.emit(
                                        "barcode_scanned_serial",
                                        serde_json::json!({
                                            "barcode": barcode,
                                            "source": "serial",
                                            "timestamp": chrono::Utc::now().to_rfc3339(),
                                        }),
                                    );
                                }
                            }

                            // Prevent unbounded growth
                            if line_buf.len() > 512 {
                                line_buf.clear();
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!(error = %e, "Serial scanner read error");
                    // Brief backoff before retry
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }

            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let _ = crate::serial::close_port(&handle_clone);
        info!(port = %port_name, "Serial scanner background reader stopped");
    });

    Ok(serde_json::json!({
        "success": true,
        "port": port,
        "baudRate": baud_rate,
    }))
}

/// Stop the serial barcode scanner.
pub fn stop() -> Result<Value, String> {
    if !SCANNER_RUNNING.load(Ordering::SeqCst) {
        return Ok(serde_json::json!({
            "success": true,
            "message": "Scanner was not running",
        }));
    }

    SCANNER_RUNNING.store(false, Ordering::SeqCst);

    if let Ok(mut h) = SCANNER_HANDLE.lock() {
        if let Some(handle) = h.take() {
            let _ = crate::serial::close_port(&handle);
        }
    }

    info!("Serial scanner stopped");
    Ok(serde_json::json!({ "success": true }))
}

/// Get the serial scanner status.
pub fn get_status() -> Result<Value, String> {
    let running = SCANNER_RUNNING.load(Ordering::SeqCst);
    let port = SCANNER_PORT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let last = LAST_SCAN.lock().unwrap_or_else(|e| e.into_inner()).clone();

    Ok(serde_json::json!({
        "connected": running,
        "port": port,
        "lastScan": last,
    }))
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stop_when_not_running() {
        SCANNER_RUNNING.store(false, Ordering::SeqCst);
        let result = stop().unwrap();
        assert_eq!(result["success"], true);
    }

    #[test]
    fn test_get_status_not_running() {
        SCANNER_RUNNING.store(false, Ordering::SeqCst);
        {
            let mut p = SCANNER_PORT.lock().unwrap();
            *p = None;
        }
        let result = get_status().unwrap();
        assert_eq!(result["connected"], false);
    }
}
