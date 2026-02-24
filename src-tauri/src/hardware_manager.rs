//! Hardware manager — peripheral orchestrator for POS.
//!
//! Central coordinator that initializes, monitors, and reconfigures
//! POS peripherals based on terminal settings synced from the admin dashboard.
//!
//! Responsibilities:
//! - On startup: read terminal settings, initialize enabled peripherals
//! - On settings change: reconfigure peripherals (connect/disconnect)
//! - Aggregate status: provide a single status view of all peripherals
//! - Graceful shutdown: close all hardware connections on app exit

use serde_json::Value;
use tracing::{info, warn};

use crate::{customer_display, loyalty, scale, scanner, serial};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Get aggregate status of all connected peripherals.
pub fn get_status() -> Result<Value, String> {
    let scale_status = scale::get_status().unwrap_or_default();
    let display_status = customer_display::get_status().unwrap_or_default();
    let scanner_status = scanner::get_status().unwrap_or_default();
    let loyalty_status = loyalty::get_status().unwrap_or_default();

    Ok(serde_json::json!({
        "scale": scale_status,
        "customerDisplay": display_status,
        "serialScanner": scanner_status,
        "loyaltyReader": loyalty_status,
    }))
}

/// Reconnect a specific peripheral device.
///
/// `device_type` must be one of: "scale", "display", "scanner", "loyalty"
pub fn reconnect(
    device_type: &str,
    settings: &Value,
    app: &tauri::AppHandle,
) -> Result<Value, String> {
    match device_type {
        "scale" => {
            let _ = scale::disconnect();
            let port = settings["scale_port"].as_str().unwrap_or("COM3");
            let baud = settings["scale_baud_rate"].as_u64().unwrap_or(9600) as u32;
            let protocol = settings["scale_protocol"].as_str().unwrap_or("generic");
            scale::connect(port, baud, protocol, app.clone())
        }
        "display" => {
            let _ = customer_display::disconnect();
            let conn_type = settings["display_connection_type"]
                .as_str()
                .unwrap_or("serial");
            let target = settings["display_port"].as_str().unwrap_or("COM4");
            let port = settings["display_tcp_port"].as_u64().map(|p| p as u16);
            let baud = settings["display_baud_rate"].as_u64().map(|b| b as u32);
            customer_display::connect(conn_type, target, port, baud)
        }
        "scanner" => {
            let _ = scanner::stop();
            let port = settings["barcode_scanner_port"].as_str().unwrap_or("COM2");
            let baud = settings["scanner_baud_rate"].as_u64().unwrap_or(9600) as u32;
            scanner::start(port, baud, app.clone())
        }
        "loyalty" => {
            let _ = loyalty::stop();
            loyalty::start(app.clone())
        }
        other => Err(format!("Unknown device type: {other}")),
    }
}

/// Initialize peripherals based on terminal settings.
///
/// Called on app startup and when terminal settings are updated.
#[allow(dead_code)]
pub fn apply_settings(settings: &Value, app: &tauri::AppHandle) {
    // Scale
    let scale_enabled = settings["scale_enabled"]
        .as_bool()
        .or_else(|| {
            settings
                .get("hardware.scale_enabled")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false);

    if scale_enabled {
        let port = settings["scale_port"]
            .as_str()
            .or_else(|| settings.get("hardware.scale_port").and_then(|v| v.as_str()))
            .unwrap_or("COM3");
        let baud = settings["scale_baud_rate"].as_u64().unwrap_or(9600) as u32;
        let protocol = settings["scale_protocol"].as_str().unwrap_or("generic");

        match scale::connect(port, baud, protocol, app.clone()) {
            Ok(_) => info!("Scale initialized on {port}"),
            Err(e) => warn!(error = %e, "Failed to initialize scale"),
        }
    } else {
        let _ = scale::disconnect();
    }

    // Customer display
    let display_enabled = settings["customer_display_enabled"]
        .as_bool()
        .or_else(|| {
            settings
                .get("hardware.customer_display_enabled")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false);

    if display_enabled {
        let conn_type = settings["display_connection_type"]
            .as_str()
            .unwrap_or("serial");
        let target = settings["display_port"].as_str().unwrap_or("COM4");

        match customer_display::connect(conn_type, target, None, None) {
            Ok(_) => info!("Customer display initialized"),
            Err(e) => warn!(error = %e, "Failed to initialize customer display"),
        }
    } else {
        let _ = customer_display::disconnect();
    }

    // Serial barcode scanner
    let scanner_enabled = settings["barcode_scanner_enabled"]
        .as_bool()
        .or_else(|| {
            settings
                .get("hardware.barcode_scanner_enabled")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false);
    let scanner_port = settings["barcode_scanner_port"].as_str().or_else(|| {
        settings
            .get("hardware.barcode_scanner_port")
            .and_then(|v| v.as_str())
    });

    // Only start serial scanner if a port is explicitly configured
    // (keyboard-wedge scanners don't need this)
    if let Some(port) = scanner_port.filter(|_| scanner_enabled) {
        let baud = settings["scanner_baud_rate"].as_u64().unwrap_or(9600) as u32;

        match scanner::start(port, baud, app.clone()) {
            Ok(_) => info!("Serial scanner initialized on {port}"),
            Err(e) => warn!(error = %e, "Failed to initialize serial scanner"),
        }
    } else {
        let _ = scanner::stop();
    }

    // Loyalty card reader
    let loyalty_enabled = settings["loyalty_card_reader"]
        .as_bool()
        .or_else(|| {
            settings
                .get("hardware.loyalty_card_reader")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false);

    if loyalty_enabled {
        match loyalty::start(app.clone()) {
            Ok(_) => info!("Loyalty card reader initialized"),
            Err(e) => warn!(error = %e, "Failed to initialize loyalty reader"),
        }
    } else {
        let _ = loyalty::stop();
    }
}

/// Disconnect all peripherals (called on app exit).
#[allow(dead_code)]
pub fn shutdown() {
    info!("Hardware manager: shutting down all peripherals");
    let _ = scale::disconnect();
    let _ = customer_display::disconnect();
    let _ = scanner::stop();
    let _ = loyalty::stop();
    serial::close_all();
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_status() {
        let result = get_status().unwrap();
        assert!(result["scale"].is_object());
        assert!(result["customerDisplay"].is_object());
        assert!(result["serialScanner"].is_object());
        assert!(result["loyaltyReader"].is_object());
    }

    #[test]
    fn test_reconnect_unknown_device() {
        // Can't test with real AppHandle, but we can verify error for unknown type
        // This would need an AppHandle mock — just verify the match arm
        // Placeholder — real tests require Tauri test harness
    }
}
