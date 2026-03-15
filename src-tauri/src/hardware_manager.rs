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

fn read_value<'a>(settings: &'a Value, path: &str) -> Option<&'a Value> {
    if let Some(value) = settings.get(path) {
        return Some(value);
    }

    let mut current = settings;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
}

fn read_bool(settings: &Value, paths: &[&str]) -> Option<bool> {
    for path in paths {
        if let Some(value) = read_value(settings, path) {
            if let Some(flag) = value.as_bool() {
                return Some(flag);
            }
            if let Some(flag) = value.as_i64() {
                return Some(flag == 1);
            }
            if let Some(flag) = value.as_str() {
                match flag.trim().to_ascii_lowercase().as_str() {
                    "true" | "1" | "yes" | "on" => return Some(true),
                    "false" | "0" | "no" | "off" => return Some(false),
                    _ => {}
                }
            }
        }
    }
    None
}

fn read_str<'a>(settings: &'a Value, paths: &[&str]) -> Option<&'a str> {
    for path in paths {
        if let Some(value) = read_value(settings, path).and_then(|value| value.as_str()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

fn read_u64(settings: &Value, paths: &[&str]) -> Option<u64> {
    for path in paths {
        if let Some(value) = read_value(settings, path) {
            if let Some(number) = value.as_u64() {
                return Some(number);
            }
            if let Some(number) = value.as_i64() {
                if number >= 0 {
                    return Some(number as u64);
                }
            }
            if let Some(number) = value.as_str().and_then(|value| value.trim().parse::<u64>().ok())
            {
                return Some(number);
            }
        }
    }
    None
}

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
            let port = read_str(settings, &["scale.port", "scale_port", "hardware.scale_port"])
                .unwrap_or("COM3");
            let baud = read_u64(
                settings,
                &["scale.baud_rate", "scale_baud_rate", "hardware.scale_baud_rate"],
            )
            .unwrap_or(9600) as u32;
            let protocol = read_str(
                settings,
                &["scale.protocol", "scale_protocol", "hardware.scale_protocol"],
            )
            .unwrap_or("generic");
            scale::connect(port, baud, protocol, app.clone())
        }
        "display" => {
            let _ = customer_display::disconnect();
            let conn_type = read_str(
                settings,
                &[
                    "display.connection_type",
                    "display_connection_type",
                    "hardware.display_connection_type",
                ],
            )
            .unwrap_or("serial");
            let target = read_str(settings, &["display.port", "display_port", "hardware.display_port"])
                .unwrap_or("COM4");
            let port = read_u64(
                settings,
                &["display.tcp_port", "display_tcp_port", "hardware.display_tcp_port"],
            )
            .map(|value| value as u16);
            let baud = read_u64(
                settings,
                &["display.baud_rate", "display_baud_rate", "hardware.display_baud_rate"],
            )
            .map(|value| value as u32);
            customer_display::connect(conn_type, target, port, baud)
        }
        "scanner" => {
            let _ = scanner::stop();
            let port = read_str(
                settings,
                &["scanner.port", "barcode_scanner_port", "hardware.barcode_scanner_port"],
            )
            .unwrap_or("COM2");
            let baud = read_u64(
                settings,
                &["scanner.baud_rate", "scanner_baud_rate", "hardware.scanner_baud_rate"],
            )
            .unwrap_or(9600) as u32;
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
    let scale_enabled = read_bool(
        settings,
        &["scale.enabled", "scale_enabled", "hardware.scale_enabled"],
    )
        .unwrap_or(false);

    if scale_enabled {
        let port = read_str(settings, &["scale.port", "scale_port", "hardware.scale_port"])
            .unwrap_or("COM3");
        let baud = read_u64(
            settings,
            &["scale.baud_rate", "scale_baud_rate", "hardware.scale_baud_rate"],
        )
        .unwrap_or(9600) as u32;
        let protocol = read_str(
            settings,
            &["scale.protocol", "scale_protocol", "hardware.scale_protocol"],
        )
        .unwrap_or("generic");

        match scale::connect(port, baud, protocol, app.clone()) {
            Ok(_) => info!("Scale initialized on {port}"),
            Err(e) => warn!(error = %e, "Failed to initialize scale"),
        }
    } else {
        let _ = scale::disconnect();
    }

    // Customer display
    let display_enabled = read_bool(
        settings,
        &[
            "display.enabled",
            "customer_display_enabled",
            "hardware.customer_display_enabled",
        ],
    )
        .unwrap_or(false);

    if display_enabled {
        let conn_type = read_str(
            settings,
            &[
                "display.connection_type",
                "display_connection_type",
                "hardware.display_connection_type",
            ],
        )
        .unwrap_or("serial");
        let target = read_str(settings, &["display.port", "display_port", "hardware.display_port"])
            .unwrap_or("COM4");
        let tcp_port = read_u64(
            settings,
            &["display.tcp_port", "display_tcp_port", "hardware.display_tcp_port"],
        )
        .map(|value| value as u16);
        let baud_rate = read_u64(
            settings,
            &["display.baud_rate", "display_baud_rate", "hardware.display_baud_rate"],
        )
        .map(|value| value as u32);

        match customer_display::connect(conn_type, target, tcp_port, baud_rate) {
            Ok(_) => info!("Customer display initialized"),
            Err(e) => warn!(error = %e, "Failed to initialize customer display"),
        }
    } else {
        let _ = customer_display::disconnect();
    }

    // Serial barcode scanner
    let scanner_enabled = read_bool(
        settings,
        &[
            "scanner.enabled",
            "barcode_scanner_enabled",
            "hardware.barcode_scanner_enabled",
        ],
    )
        .unwrap_or(false);
    let scanner_port = read_str(
        settings,
        &[
            "scanner.port",
            "barcode_scanner_port",
            "hardware.barcode_scanner_port",
        ],
    );

    // Only start serial scanner if a port is explicitly configured
    // (keyboard-wedge scanners don't need this)
    if let Some(port) = scanner_port.filter(|_| scanner_enabled) {
        let baud = read_u64(
            settings,
            &["scanner.baud_rate", "scanner_baud_rate", "hardware.scanner_baud_rate"],
        )
        .unwrap_or(9600) as u32;

        match scanner::start(port, baud, app.clone()) {
            Ok(_) => info!("Serial scanner initialized on {port}"),
            Err(e) => warn!(error = %e, "Failed to initialize serial scanner"),
        }
    } else {
        let _ = scanner::stop();
    }

    // Loyalty card reader
    let loyalty_enabled = read_bool(
        settings,
        &[
            "peripherals.loyalty_card_reader",
            "loyalty_card_reader",
            "hardware.loyalty_card_reader",
        ],
    )
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
