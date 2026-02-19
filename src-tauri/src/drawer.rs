//! Cash drawer kick via ESC/POS over TCP.
//!
//! Sends the standard ESC/POS pulse command to open a cash drawer connected
//! to a thermal receipt printer's DK (drawer kick) port.  Uses a simple TCP
//! socket to port 9100 (configurable per printer profile).
//!
//! Key design goals:
//! - **Non-blocking**: drawer kick never blocks checkout or print jobs.
//! - **Rate-limited**: max 1 kick per 2 seconds to prevent accidental spam.
//! - **Fail-safe**: errors are logged but never propagated to callers that
//!   would otherwise block the POS flow.

use std::collections::HashMap;
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tracing::{info, warn};

use crate::db::DbState;
use crate::printers;

// ---------------------------------------------------------------------------
// ESC/POS drawer kick command
// ---------------------------------------------------------------------------

/// Standard ESC/POS pulse command: ESC p m t1 t2
///
/// - `0x1B` (ESC)
/// - `0x70` (p) — generate pulse
/// - `0x00` — pin 2 (connector pin)
/// - `0x19` — on time  (25 × 2ms = 50ms)
/// - `0xFA` — off time (250 × 2ms = 500ms)
const ESCPOS_DRAWER_KICK: [u8; 5] = [0x1B, 0x70, 0x00, 0x19, 0xFA];

/// Timeout for TCP connection to the printer.
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// Timeout for writing the drawer kick command.
const TCP_WRITE_TIMEOUT: Duration = Duration::from_secs(2);

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

/// Minimum interval between drawer kicks (prevents spam).
const MIN_KICK_INTERVAL: Duration = Duration::from_secs(2);

/// Per-profile rate-limiter — tracks the last successful kick time per profile.
/// Key is the printer profile ID; value is the instant of the last kick.
static KICK_TIMES: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// Check whether a kick is allowed for the given profile and, if so, record it.
///
/// `profile_id` identifies the printer profile. Pass `"__default__"` for the
/// fallback / unknown-profile path.
fn rate_limit_check(profile_id: &str) -> Result<(), String> {
    let mut guard = KICK_TIMES.lock().map_err(|e| e.to_string())?;
    let map = guard.get_or_insert_with(HashMap::new);

    if let Some(last) = map.get(profile_id) {
        let elapsed = last.elapsed();
        if elapsed < MIN_KICK_INTERVAL {
            let remaining = MIN_KICK_INTERVAL - elapsed;
            return Err(format!(
                "Drawer kick rate-limited — wait {}ms",
                remaining.as_millis()
            ));
        }
    }
    map.insert(profile_id.to_string(), Instant::now());
    Ok(())
}

// ---------------------------------------------------------------------------
// TCP transport
// ---------------------------------------------------------------------------

/// Send the ESC/POS drawer kick pulse via TCP to the given host:port.
pub fn send_escpos_pulse_tcp(host: &str, port: u16) -> Result<(), String> {
    let addr_str = format!("{host}:{port}");
    let addr: SocketAddr = addr_str
        .parse()
        .map_err(|e| format!("Invalid drawer address {addr_str}: {e}"))?;

    let stream = TcpStream::connect_timeout(&addr, TCP_CONNECT_TIMEOUT)
        .map_err(|e| format!("TCP connect to {addr_str} failed: {e}"))?;

    stream
        .set_write_timeout(Some(TCP_WRITE_TIMEOUT))
        .map_err(|e| format!("set_write_timeout: {e}"))?;

    let mut writer = std::io::BufWriter::new(stream);
    writer
        .write_all(&ESCPOS_DRAWER_KICK)
        .map_err(|e| format!("TCP write drawer kick to {addr_str}: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("TCP flush to {addr_str}: {e}"))?;

    info!(addr = %addr_str, "ESC/POS drawer kick sent");
    Ok(())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Open the cash drawer using the given printer profile (or the default).
///
/// 1. Resolves the printer profile (explicit ID > default > none).
/// 2. Checks `open_cash_drawer` flag + `drawer_mode`.
/// 3. Rate-limits to prevent spam.
/// 4. Sends the ESC/POS pulse via TCP.
///
/// Returns `{ success, message }`.  On failure, returns an error string but
/// callers should treat it as non-fatal.
pub fn open_cash_drawer(db: &DbState, profile_id: Option<&str>) -> Result<Value, String> {
    let profile = printers::resolve_printer_profile(db, profile_id)?;

    let profile = match profile {
        Some(p) => p,
        None => {
            return Ok(serde_json::json!({
                "success": false,
                "message": "No printer profile configured",
            }));
        }
    };

    // Check open_cash_drawer flag
    let drawer_enabled = profile["openCashDrawer"].as_bool().unwrap_or(false);
    if !drawer_enabled {
        return Ok(serde_json::json!({
            "success": false,
            "message": "Cash drawer is disabled on this printer profile",
        }));
    }

    // Check drawer_mode
    let drawer_mode = profile
        .get("drawerMode")
        .and_then(|v| v.as_str())
        .unwrap_or("none");

    if drawer_mode == "none" {
        return Ok(serde_json::json!({
            "success": false,
            "message": "Drawer mode is 'none' — no drawer hardware configured",
        }));
    }

    // Rate limit per profile
    let pid = profile
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("__default__");
    rate_limit_check(pid)?;

    match drawer_mode {
        "escpos_tcp" => {
            let host = profile
                .get("drawerHost")
                .and_then(|v| v.as_str())
                .ok_or("Drawer mode is escpos_tcp but drawer_host is not set")?;
            let port = profile
                .get("drawerPort")
                .and_then(|v| v.as_u64())
                .unwrap_or(9100) as u16;

            send_escpos_pulse_tcp(host, port)?;

            Ok(serde_json::json!({
                "success": true,
                "message": format!("Drawer opened via ESC/POS TCP {host}:{port}"),
            }))
        }
        other => Err(format!("Unsupported drawer_mode: {other}")),
    }
}

/// Attempt a non-fatal drawer kick after a print job succeeds.
///
/// Called by the print worker.  Returns `Ok(())` on success or skip (disabled,
/// mode "none", rate-limited), and `Err(message)` when the kick was attempted
/// but failed (e.g. TCP connect error).  The caller should treat errors as
/// **non-fatal** — the print job remains "printed".
pub fn try_drawer_kick_after_print(db: &DbState, profile: &Value) -> Result<(), String> {
    let drawer_enabled = profile["openCashDrawer"].as_bool().unwrap_or(false);
    if !drawer_enabled {
        return Ok(());
    }

    let drawer_mode = profile
        .get("drawerMode")
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    if drawer_mode == "none" {
        return Ok(());
    }

    // Per-profile rate limit (silently skip if too soon)
    let pid = profile
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("__default__");
    if rate_limit_check(pid).is_err() {
        return Ok(());
    }

    if drawer_mode == "escpos_tcp" {
        let host = match profile.get("drawerHost").and_then(|v| v.as_str()) {
            Some(h) => h,
            None => {
                warn!("Drawer mode is escpos_tcp but drawer_host is missing — skipping kick");
                return Ok(());
            }
        };
        let port = profile
            .get("drawerPort")
            .and_then(|v| v.as_u64())
            .unwrap_or(9100) as u16;

        if let Err(e) = send_escpos_pulse_tcp(host, port) {
            warn!(error = %e, "Non-fatal drawer kick failed after print");
            return Err(e);
        }
    }

    // Ignore unknown drawer_mode silently in the worker path
    let _ = db; // ensure db is "used" for future extensions
    Ok(())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::Mutex as StdMutex;

    fn test_db() -> DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        DbState {
            conn: StdMutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    #[test]
    fn test_open_drawer_no_profile() {
        let db = test_db();
        let result = open_cash_drawer(&db, None).unwrap();
        assert_eq!(result["success"], false);
        assert!(result["message"]
            .as_str()
            .unwrap()
            .contains("No printer profile"));
    }

    #[test]
    fn test_open_drawer_disabled() {
        let db = test_db();

        // Create a profile with open_cash_drawer = false
        let profile = serde_json::json!({
            "name": "No Drawer",
            "printerName": "TestPrinter",
            "openCashDrawer": false,
        });
        let res = printers::create_printer_profile(&db, &profile).unwrap();
        let id = res["profileId"].as_str().unwrap();
        printers::set_default_printer_profile(&db, id).unwrap();

        let result = open_cash_drawer(&db, None).unwrap();
        assert_eq!(result["success"], false);
        assert!(result["message"].as_str().unwrap().contains("disabled"));
    }

    #[test]
    fn test_open_drawer_mode_none() {
        let db = test_db();

        // Create a profile with open_cash_drawer = true but drawer_mode = none (default)
        let profile = serde_json::json!({
            "name": "Drawer None Mode",
            "printerName": "TestPrinter",
            "openCashDrawer": true,
        });
        let res = printers::create_printer_profile(&db, &profile).unwrap();
        let id = res["profileId"].as_str().unwrap();
        printers::set_default_printer_profile(&db, id).unwrap();

        let result = open_cash_drawer(&db, None).unwrap();
        assert_eq!(result["success"], false);
        assert!(result["message"].as_str().unwrap().contains("none"));
    }

    #[test]
    fn test_open_drawer_invalid_host() {
        let db = test_db();

        // Create profile with escpos_tcp mode but invalid host
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO printer_profiles (id, name, driver_type, printer_name,
                                               open_cash_drawer, drawer_mode, drawer_host, drawer_port,
                                               created_at, updated_at)
                 VALUES ('pp-tcp', 'TCP Drawer', 'windows', 'POS-80',
                         1, 'escpos_tcp', '192.0.2.1', 9100,
                         datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
            db::set_setting(&conn, "printer", "default_printer_profile_id", "pp-tcp").unwrap();
        }

        // Reset rate limiter for test isolation
        {
            let mut guard = KICK_TIMES.lock().unwrap();
            *guard = None;
        }

        // Should fail to connect (192.0.2.1 is TEST-NET, unreachable)
        // but the error should be descriptive, not a panic
        let result = open_cash_drawer(&db, None);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("TCP connect") || err.contains("failed"),
            "Expected TCP connect error, got: {err}"
        );
    }

    #[test]
    fn test_rate_limiter_per_profile() {
        // Reset rate limiter
        {
            let mut guard = KICK_TIMES.lock().unwrap();
            let map = guard.get_or_insert_with(HashMap::new);
            map.insert("profile-a".to_string(), Instant::now());
        }

        // Same profile — should be rate-limited
        let result = rate_limit_check("profile-a");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("rate-limited"));

        // Different profile — should be allowed
        let result_b = rate_limit_check("profile-b");
        assert!(result_b.is_ok());
    }

    #[test]
    fn test_rate_limiter_allows_after_interval() {
        // Set last kick to well in the past
        {
            let mut guard = KICK_TIMES.lock().unwrap();
            let map = guard.get_or_insert_with(HashMap::new);
            map.insert(
                "profile-old".to_string(),
                Instant::now() - Duration::from_secs(10),
            );
        }

        let result = rate_limit_check("profile-old");
        assert!(result.is_ok());
    }

    #[test]
    fn test_try_drawer_kick_disabled_is_noop() {
        let db = test_db();
        let profile = serde_json::json!({
            "openCashDrawer": false,
            "drawerMode": "escpos_tcp",
            "drawerHost": "192.168.1.100",
        });
        // Should return Ok (skip) without error
        assert!(try_drawer_kick_after_print(&db, &profile).is_ok());
    }

    #[test]
    fn test_try_drawer_kick_mode_none_is_noop() {
        let db = test_db();
        let profile = serde_json::json!({
            "openCashDrawer": true,
            "drawerMode": "none",
        });
        assert!(try_drawer_kick_after_print(&db, &profile).is_ok());
    }

    #[test]
    fn test_escpos_command_bytes() {
        // Verify the ESC/POS drawer kick command is exactly 5 bytes
        assert_eq!(ESCPOS_DRAWER_KICK.len(), 5);
        assert_eq!(ESCPOS_DRAWER_KICK[0], 0x1B); // ESC
        assert_eq!(ESCPOS_DRAWER_KICK[1], 0x70); // p
        assert_eq!(ESCPOS_DRAWER_KICK[2], 0x00); // pin 2
    }

    #[test]
    fn test_send_escpos_pulse_invalid_address() {
        // Invalid address format
        let result = send_escpos_pulse_tcp("not-an-ip", 9100);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid drawer address"));
    }

    // ---------------------------------------------------------------
    // Deterministic TCP test server tests
    // ---------------------------------------------------------------

    use std::net::TcpListener;

    /// Spin up a TCP listener on an ephemeral port and return (listener, port).
    fn tcp_test_server() -> (TcpListener, u16) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral TCP port for test");
        let port = listener.local_addr().unwrap().port();
        (listener, port)
    }

    #[test]
    fn test_tcp_pulse_receives_exact_bytes() {
        let (listener, port) = tcp_test_server();

        // Spawn a thread that accepts one connection and reads bytes
        let handle = std::thread::spawn(move || {
            use std::io::Read;
            let (mut stream, _addr) = listener.accept().expect("accept TCP connection");
            let mut buf = [0u8; 16];
            let n = stream.read(&mut buf).expect("read from TCP connection");
            buf[..n].to_vec()
        });

        // Reset rate limiter for test isolation
        {
            let mut guard = KICK_TIMES.lock().unwrap();
            let map = guard.get_or_insert_with(HashMap::new);
            map.remove("__tcp_test__");
        }

        // Send the pulse
        let result = send_escpos_pulse_tcp("127.0.0.1", port);
        assert!(result.is_ok(), "TCP pulse failed: {:?}", result);

        // Verify the server received exactly the ESC/POS drawer kick bytes
        let received = handle.join().expect("TCP server thread panicked");
        assert_eq!(received, ESCPOS_DRAWER_KICK.to_vec());
    }

    #[test]
    fn test_tcp_pulse_failure_returns_error() {
        // Bind a port but don't accept — let the listener drop immediately
        let (listener, port) = tcp_test_server();
        drop(listener); // Close the port so connect will be refused

        let result = send_escpos_pulse_tcp("127.0.0.1", port);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("TCP connect") || err.contains("failed"),
            "Expected TCP error, got: {err}"
        );
    }

    #[test]
    fn test_try_drawer_kick_failure_returns_err() {
        let db = test_db();

        // Bind a port and immediately close it so the kick fails
        let (listener, port) = tcp_test_server();
        drop(listener);

        // Reset rate limiter for a unique profile ID
        {
            let mut guard = KICK_TIMES.lock().unwrap();
            let map = guard.get_or_insert_with(HashMap::new);
            map.remove("pp-kick-fail");
        }

        let profile = serde_json::json!({
            "id": "pp-kick-fail",
            "openCashDrawer": true,
            "drawerMode": "escpos_tcp",
            "drawerHost": "127.0.0.1",
            "drawerPort": port,
        });

        let result = try_drawer_kick_after_print(&db, &profile);
        assert!(result.is_err(), "Expected drawer kick failure");
        let err = result.unwrap_err();
        assert!(
            err.contains("TCP connect") || err.contains("failed"),
            "Expected TCP error, got: {err}"
        );
    }
}
