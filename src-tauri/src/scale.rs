//! Weighing scale driver for POS by-weight items.
//!
//! Supports common POS scale protocols over serial (COM) ports:
//! - **Toledo/Mettler-Toledo**: `ST,GS,+  0.500kg\r\n` continuous output
//! - **CAS**: `S  S     0.500 kg\r\n`
//! - **Generic**: configurable line-based protocol with regex parsing
//!
//! Key design goals:
//! - **Background reader**: tokio task reads weight continuously, emits Tauri events
//! - **Debounced**: only emits `scale_weight_changed` on actual value changes
//! - **Non-blocking**: weight reads never block POS checkout flow
//! - **Tare**: sends tare command for supported scale protocols

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Supported scale protocols.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ScaleProtocol {
    /// Toledo/Mettler-Toledo continuous output
    Toledo,
    /// CAS scale protocol
    Cas,
    /// Generic line-based (custom regex)
    Generic,
}

/// A single weight reading from the scale.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeightReading {
    pub weight: f64,
    pub unit: String,
    pub stable: bool,
    pub raw: String,
}

/// Scale connection state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScaleStatus {
    pub connected: bool,
    pub port: Option<String>,
    pub protocol: Option<String>,
    pub last_reading: Option<WeightReading>,
    pub last_read_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

static SCALE_RUNNING: AtomicBool = AtomicBool::new(false);
static SCALE_STATUS: Mutex<Option<ScaleStatus>> = Mutex::new(None);
static SCALE_HANDLE: Mutex<Option<String>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Protocol parsing
// ---------------------------------------------------------------------------

/// Parse a Toledo/Mettler-Toledo weight line.
///
/// Format: `ST,GS,+  0.500kg\r\n` or `ST,GS,-  0.500kg`
///   - ST = stable, US = unstable
///   - GS = gross weight, NT = net weight
///   - Sign + weight + unit
fn parse_toledo(line: &str) -> Option<WeightReading> {
    let trimmed = line.trim();
    if trimmed.len() < 8 {
        return None;
    }

    // Check stability
    let stable = trimmed.starts_with("ST");

    // Find the numeric part — scan for first digit or sign after comma
    let parts: Vec<&str> = trimmed.splitn(3, ',').collect();
    if parts.len() < 3 {
        return None;
    }

    let weight_part = parts[2].trim();

    // Extract numeric value and unit
    let (num_str, unit) = extract_number_and_unit(weight_part);
    let weight: f64 = num_str.parse().ok()?;

    Some(WeightReading {
        weight,
        unit: unit.to_lowercase(),
        stable,
        raw: trimmed.to_string(),
    })
}

/// Parse a CAS scale weight line.
///
/// Format: `S  S     0.500 kg\r\n`
///   - First char S = stable, U = unstable
fn parse_cas(line: &str) -> Option<WeightReading> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let stable = trimmed.starts_with('S');

    // CAS format: skip status chars, find the number
    let (num_str, unit) = extract_number_and_unit(trimmed);
    let weight: f64 = num_str.parse().ok()?;

    Some(WeightReading {
        weight,
        unit: unit.to_lowercase(),
        stable,
        raw: trimmed.to_string(),
    })
}

/// Parse a generic weight line — tries to find a decimal number followed by a unit.
fn parse_generic(line: &str) -> Option<WeightReading> {
    let trimmed = line.trim();
    let (num_str, unit) = extract_number_and_unit(trimmed);
    let weight: f64 = num_str.parse().ok()?;

    Some(WeightReading {
        weight,
        unit: if unit.is_empty() {
            "kg".to_string()
        } else {
            unit.to_lowercase()
        },
        stable: true, // generic protocol doesn't report stability
        raw: trimmed.to_string(),
    })
}

/// Extract a numeric value and unit suffix from a string.
///
/// Scans for the first sequence of digits/decimal/sign, then takes the
/// remaining alphabetic chars as the unit.
fn extract_number_and_unit(s: &str) -> (String, String) {
    let mut num = String::new();
    let mut unit = String::new();
    let mut found_sign = false;
    let mut found_digit = false;
    let mut past_number = false;

    for ch in s.chars() {
        if past_number {
            if ch.is_alphabetic() {
                unit.push(ch);
            }
            continue;
        }

        if ch == '+' && !found_digit && !found_sign {
            // Leading '+' — note it but don't add to num
            found_sign = true;
        } else if ch == '-' && !found_digit && !found_sign {
            // Leading '-' — add to num
            found_sign = true;
            num.push(ch);
        } else if ch.is_ascii_digit() || ch == '.' {
            found_digit = true;
            num.push(ch);
        } else if ch == ' ' && !found_digit {
            // Spaces before digits (after sign) — skip
        } else if found_digit {
            // Non-digit after we've started the number — number is done
            past_number = true;
            if ch.is_alphabetic() {
                unit.push(ch);
            }
        }
        // Skip any other characters before the number starts
    }

    (num, unit)
}

/// Parse a weight line using the specified protocol.
pub fn parse_weight_line(line: &str, protocol: &ScaleProtocol) -> Option<WeightReading> {
    match protocol {
        ScaleProtocol::Toledo => parse_toledo(line),
        ScaleProtocol::Cas => parse_cas(line),
        ScaleProtocol::Generic => parse_generic(line),
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Connect to a scale and start the background reader.
///
/// The reader emits `scale_weight_changed` Tauri events when the weight changes.
pub fn connect(
    port: &str,
    baud_rate: u32,
    protocol: &str,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    if SCALE_RUNNING.load(Ordering::SeqCst) {
        return Err("Scale already connected — disconnect first".to_string());
    }

    let protocol_enum = match protocol {
        "toledo" => ScaleProtocol::Toledo,
        "cas" => ScaleProtocol::Cas,
        _ => ScaleProtocol::Generic,
    };

    // Open the serial port
    let result = crate::serial::open_port(port, baud_rate, Some(200))?;
    let handle = result["handle"]
        .as_str()
        .ok_or("No handle returned")?
        .to_string();

    // Store handle
    {
        let mut h = SCALE_HANDLE.lock().unwrap_or_else(|e| e.into_inner());
        *h = Some(handle.clone());
    }

    // Update status
    {
        let mut s = SCALE_STATUS.lock().unwrap_or_else(|e| e.into_inner());
        *s = Some(ScaleStatus {
            connected: true,
            port: Some(port.to_string()),
            protocol: Some(protocol.to_string()),
            last_reading: None,
            last_read_at: None,
        });
    }

    SCALE_RUNNING.store(true, Ordering::SeqCst);

    // Start background reader
    let port_name = port.to_string();
    let handle_clone = handle.clone();
    let protocol_clone = protocol_enum.clone();

    tokio::spawn(async move {
        info!(port = %port_name, "Scale background reader started");
        let mut last_weight: Option<f64> = None;
        let mut line_buf = String::new();

        while SCALE_RUNNING.load(Ordering::SeqCst) {
            // Read from serial port
            match crate::serial::read_port(&handle_clone, 256) {
                Ok(result) => {
                    if let Some(data) = result["data"].as_str() {
                        if !data.is_empty() {
                            line_buf.push_str(data);

                            // Process complete lines
                            while let Some(pos) = line_buf.find('\n') {
                                let line = line_buf[..pos].to_string();
                                line_buf = line_buf[pos + 1..].to_string();

                                if let Some(reading) = parse_weight_line(&line, &protocol_clone) {
                                    // Only emit if weight actually changed (debounce)
                                    let changed = last_weight
                                        .map(|lw| (lw - reading.weight).abs() > 0.001)
                                        .unwrap_or(true);

                                    if changed {
                                        last_weight = Some(reading.weight);
                                        let now = chrono::Utc::now().to_rfc3339();

                                        // Update status
                                        if let Ok(mut s) = SCALE_STATUS.lock() {
                                            if let Some(ref mut status) = *s {
                                                status.last_reading = Some(reading.clone());
                                                status.last_read_at = Some(now.clone());
                                            }
                                        }

                                        // Emit Tauri event
                                        use tauri::Emitter;
                                        let _ = app.emit(
                                            "scale_weight_changed",
                                            serde_json::json!({
                                                "weight": reading.weight,
                                                "unit": reading.unit,
                                                "stable": reading.stable,
                                                "raw": reading.raw,
                                                "timestamp": now,
                                            }),
                                        );
                                    }
                                }
                            }

                            // Prevent line_buf from growing unbounded
                            if line_buf.len() > 1024 {
                                line_buf.clear();
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!(error = %e, "Scale read error");
                }
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // Cleanup
        let _ = crate::serial::close_port(&handle_clone);
        info!(port = %port_name, "Scale background reader stopped");
    });

    Ok(serde_json::json!({
        "success": true,
        "port": port,
        "baudRate": baud_rate,
        "protocol": protocol,
    }))
}

/// Disconnect the scale and stop the background reader.
pub fn disconnect() -> Result<Value, String> {
    if !SCALE_RUNNING.load(Ordering::SeqCst) {
        return Ok(serde_json::json!({
            "success": true,
            "message": "Scale was not connected",
        }));
    }

    SCALE_RUNNING.store(false, Ordering::SeqCst);

    // Close the serial port handle
    if let Ok(mut h) = SCALE_HANDLE.lock() {
        if let Some(handle) = h.take() {
            let _ = crate::serial::close_port(&handle);
        }
    }

    // Clear status
    if let Ok(mut s) = SCALE_STATUS.lock() {
        *s = Some(ScaleStatus {
            connected: false,
            port: None,
            protocol: None,
            last_reading: None,
            last_read_at: None,
        });
    }

    info!("Scale disconnected");
    Ok(serde_json::json!({ "success": true }))
}

/// Read the current weight (one-shot, from last cached reading).
pub fn read_weight() -> Result<Value, String> {
    let guard = SCALE_STATUS.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(status) if status.connected => match &status.last_reading {
            Some(reading) => Ok(serde_json::json!({
                "success": true,
                "weight": reading.weight,
                "unit": reading.unit,
                "stable": reading.stable,
                "raw": reading.raw,
                "readAt": status.last_read_at,
            })),
            None => Ok(serde_json::json!({
                "success": true,
                "weight": 0.0,
                "unit": "kg",
                "stable": false,
                "message": "No reading yet",
            })),
        },
        _ => Ok(serde_json::json!({
            "success": false,
            "message": "Scale not connected",
        })),
    }
}

/// Send tare (zero) command to the scale.
///
/// Sends "T\r\n" for Toledo and "Z\r\n" for CAS. Generic scales use "T\r\n".
pub fn tare() -> Result<Value, String> {
    let handle_guard = SCALE_HANDLE.lock().unwrap_or_else(|e| e.into_inner());
    let handle = handle_guard.as_ref().ok_or("Scale not connected")?;

    let status_guard = SCALE_STATUS.lock().unwrap_or_else(|e| e.into_inner());
    let protocol = status_guard
        .as_ref()
        .and_then(|s| s.protocol.as_deref())
        .unwrap_or("generic");

    let cmd = match protocol {
        "cas" => b"Z\r\n".as_slice(),
        _ => b"T\r\n".as_slice(),
    };

    crate::serial::write_port(handle, cmd)?;
    info!("Scale tare command sent");

    Ok(serde_json::json!({ "success": true }))
}

/// Get the current scale status.
pub fn get_status() -> Result<Value, String> {
    let guard = SCALE_STATUS.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(status) => Ok(serde_json::to_value(status).unwrap_or_default()),
        None => Ok(serde_json::json!({
            "connected": false,
        })),
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_toledo_stable() {
        let line = "ST,GS,+  0.500kg";
        let reading = parse_toledo(line).unwrap();
        assert!((reading.weight - 0.5).abs() < 0.001);
        assert_eq!(reading.unit, "kg");
        assert!(reading.stable);
    }

    #[test]
    fn test_parse_toledo_unstable() {
        let line = "US,GS,+  1.234kg";
        let reading = parse_toledo(line).unwrap();
        assert!((reading.weight - 1.234).abs() < 0.001);
        assert!(!reading.stable);
    }

    #[test]
    fn test_parse_toledo_negative() {
        let line = "ST,GS,-  0.100kg";
        let reading = parse_toledo(line).unwrap();
        assert!((reading.weight - (-0.1)).abs() < 0.001);
        assert!(reading.stable);
    }

    #[test]
    fn test_parse_toledo_pounds() {
        let line = "ST,GS,+  2.500lb";
        let reading = parse_toledo(line).unwrap();
        assert!((reading.weight - 2.5).abs() < 0.001);
        assert_eq!(reading.unit, "lb");
    }

    #[test]
    fn test_parse_cas() {
        let line = "S  S     0.500 kg";
        let reading = parse_cas(line).unwrap();
        assert!((reading.weight - 0.5).abs() < 0.001);
        assert_eq!(reading.unit, "kg");
        assert!(reading.stable);
    }

    #[test]
    fn test_parse_cas_unstable() {
        let line = "U  S     1.000 kg";
        let reading = parse_cas(line).unwrap();
        assert!((reading.weight - 1.0).abs() < 0.001);
        assert!(!reading.stable);
    }

    #[test]
    fn test_parse_generic() {
        let line = "  +0.750 kg  ";
        let reading = parse_generic(line).unwrap();
        assert!((reading.weight - 0.75).abs() < 0.001);
        assert_eq!(reading.unit, "kg");
    }

    #[test]
    fn test_parse_generic_no_unit() {
        let line = "1.234";
        let reading = parse_generic(line).unwrap();
        assert!((reading.weight - 1.234).abs() < 0.001);
        assert_eq!(reading.unit, "kg"); // default
    }

    #[test]
    fn test_extract_number_and_unit() {
        let (num, unit) = extract_number_and_unit("+  0.500kg");
        assert_eq!(num, "0.500");
        assert_eq!(unit, "kg");
    }

    #[test]
    fn test_extract_number_and_unit_negative() {
        let (num, unit) = extract_number_and_unit("-  1.234lb");
        assert_eq!(num, "-1.234");
        assert_eq!(unit, "lb");
    }

    #[test]
    fn test_parse_weight_line_dispatch() {
        let reading = parse_weight_line("ST,GS,+  0.500kg", &ScaleProtocol::Toledo).unwrap();
        assert!((reading.weight - 0.5).abs() < 0.001);

        let reading = parse_weight_line("S  S     0.500 kg", &ScaleProtocol::Cas).unwrap();
        assert!((reading.weight - 0.5).abs() < 0.001);

        let reading = parse_weight_line("0.500 kg", &ScaleProtocol::Generic).unwrap();
        assert!((reading.weight - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_disconnect_when_not_connected() {
        SCALE_RUNNING.store(false, Ordering::SeqCst);
        let result = disconnect().unwrap();
        assert_eq!(result["success"], true);
    }

    #[test]
    fn test_read_weight_not_connected() {
        // Ensure scale is not connected
        {
            let mut s = SCALE_STATUS.lock().unwrap();
            *s = None;
        }
        let result = read_weight().unwrap();
        assert_eq!(result["success"], false);
    }

    #[test]
    fn test_get_status_not_connected() {
        {
            let mut s = SCALE_STATUS.lock().unwrap();
            *s = None;
        }
        let result = get_status().unwrap();
        assert_eq!(result["connected"], false);
    }
}
