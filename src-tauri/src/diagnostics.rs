//! Diagnostics module for The Small POS.
//!
//! Provides:
//! - **About info**: version, build timestamp, git SHA, platform
//! - **System health**: online/offline, sync backlog, printer status, last z-report
//! - **Diagnostics export**: packages logs, DB schema version, sync counts,
//!   last 20 sync errors, and printer profiles into a zip bundle.
//! - **Log rotation helpers**: used by `lib.rs` to configure rolling log files.

use crate::db::DbState;
use rusqlite::params;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use tracing::warn;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum number of log files to retain.
pub const MAX_LOG_FILES: usize = 10;

/// Maximum size per log file in bytes (5 MB).
pub const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct DiagnosticsExportOptions {
    pub include_logs: bool,
    pub redact_sensitive: bool,
}

impl Default for DiagnosticsExportOptions {
    fn default() -> Self {
        Self {
            include_logs: true,
            redact_sensitive: false,
        }
    }
}

// ---------------------------------------------------------------------------
// About info
// ---------------------------------------------------------------------------

/// Returns version, build timestamp, git SHA, and platform info.
pub fn get_about_info() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "buildTimestamp": env!("BUILD_TIMESTAMP"),
        "gitSha": env!("BUILD_GIT_SHA"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "rustVersion": env!("CARGO_PKG_RUST_VERSION"),
    })
}

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

/// Collects system health status for display on the System Health screen.
pub fn get_system_health(db: &DbState) -> Result<Value, String> {
    // Collect all connection-based queries in a scoped block so the lock
    // is released before calling validate_pending_orders (which acquires
    // its own lock — std::sync::Mutex is not reentrant).
    let (
        schema_version,
        sync_backlog,
        last_sync_times,
        mut printer_status,
        last_zreport,
        pending_orders,
        db_size,
    ) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;

        let schema_version: i32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap_or(0);

        let sync_backlog = get_sync_backlog(&conn);
        let last_sync_times = get_last_sync_times(&conn);
        let printer_status = get_printer_status(&conn);
        let last_zreport = get_last_zreport(&conn);

        let pending_orders: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE status IN ('pending', 'syncing')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let db_size = fs::metadata(&db.db_path).map(|m| m.len()).unwrap_or(0);

        (
            schema_version,
            sync_backlog,
            last_sync_times,
            printer_status,
            last_zreport,
            pending_orders,
            db_size,
        )
    }; // lock released here

    // Use the same resolver path as print dispatch for default profile reporting.
    let resolved_default_profile =
        crate::printers::resolve_printer_profile_for_role(db, None, Some("receipt"))
            .ok()
            .flatten();
    if let Some(profile) = resolved_default_profile {
        let display_name = profile
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| profile.get("printerName").and_then(Value::as_str))
            .map(|value| value.to_string());
        printer_status["defaultProfile"] = json!(display_name);
    }

    // Validate pending orders against menu cache (acquires its own lock)
    let invalid_orders = crate::sync::validate_pending_orders(db)
        .ok()
        .and_then(|v| v.get("invalid_orders").cloned())
        .unwrap_or(json!([]));
    let invalid_orders_count = invalid_orders.as_array().map(|arr| arr.len()).unwrap_or(0);

    Ok(json!({
        "schemaVersion": schema_version,
        "syncBacklog": sync_backlog,
        "lastSyncTimes": last_sync_times,
        "printerStatus": printer_status,
        "lastZReport": last_zreport,
        "pendingOrders": pending_orders,
        "dbSizeBytes": db_size,
        "invalidOrders": {
            "count": invalid_orders_count,
            "details": invalid_orders
        }
    }))
}

fn get_sync_backlog(conn: &rusqlite::Connection) -> Value {
    // Counts from sync_queue
    let mut result = json!({});
    if let Ok(mut stmt) = conn.prepare(
        "SELECT entity_type, status, COUNT(*) FROM sync_queue GROUP BY entity_type, status",
    ) {
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .ok();
        if let Some(rows) = rows {
            for row in rows.flatten() {
                let (entity_type, status, count) = row;
                let entry = result
                    .as_object_mut()
                    .unwrap()
                    .entry(&entity_type)
                    .or_insert_with(|| json!({}));
                entry[&status] = json!(count);
            }
        }
    }

    // Also check order_payments and payment_adjustments sync states
    for table in &["order_payments", "payment_adjustments"] {
        let query = format!(
            "SELECT sync_state, COUNT(*) FROM {table} WHERE sync_state != 'applied' GROUP BY sync_state"
        );
        if let Ok(mut stmt) = conn.prepare(&query) {
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .ok();
            if let Some(rows) = rows {
                for row in rows.flatten() {
                    let (state, count) = row;
                    let entry = result
                        .as_object_mut()
                        .unwrap()
                        .entry(*table)
                        .or_insert_with(|| json!({}));
                    entry[&state] = json!(count);
                }
            }
        }
    }

    result
}

fn get_last_sync_times(conn: &rusqlite::Connection) -> Value {
    let mut result = json!({});
    if let Ok(mut stmt) = conn.prepare(
        "SELECT entity_type, MAX(updated_at) FROM sync_queue WHERE status = 'synced' GROUP BY entity_type",
    ) {
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            })
            .ok();
        if let Some(rows) = rows {
            for row in rows.flatten() {
                let (entity_type, ts) = row;
                result[entity_type] = json!(ts);
            }
        }
    }
    result
}

fn get_printer_status(conn: &rusqlite::Connection) -> Value {
    let profile_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM printer_profiles", [], |row| {
            row.get(0)
        })
        .unwrap_or(0);

    // Last 5 print jobs
    let mut recent_jobs = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, entity_type, entity_id, status, created_at, warning_code
         FROM print_jobs ORDER BY created_at DESC LIMIT 5",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "entityType": row.get::<_, String>(1)?,
                "entityId": row.get::<_, String>(2)?,
                "status": row.get::<_, String>(3)?,
                "createdAt": row.get::<_, String>(4)?,
                "warningCode": row.get::<_, Option<String>>(5)?,
            }))
        }) {
            for row in rows.flatten() {
                recent_jobs.push(row);
            }
        }
    }

    json!({
        "configured": profile_count > 0,
        "profileCount": profile_count,
        "defaultProfile": serde_json::Value::Null,
        "recentJobs": recent_jobs,
    })
}

fn get_last_zreport(conn: &rusqlite::Connection) -> Value {
    conn.query_row(
        "SELECT id, shift_id, generated_at, sync_state, total_gross_sales, total_net_sales
         FROM z_reports ORDER BY generated_at DESC LIMIT 1",
        [],
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "shiftId": row.get::<_, String>(1)?,
                "generatedAt": row.get::<_, String>(2)?,
                "syncState": row.get::<_, String>(3)?,
                "totalGrossSales": row.get::<_, f64>(4)?,
                "totalNetSales": row.get::<_, f64>(5)?,
            }))
        },
    )
    .unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Diagnostics export (zip bundle)
// ---------------------------------------------------------------------------

/// Collects diagnostics data and writes a zip file to the given directory.
/// Returns the path to the zip file.
pub fn export_diagnostics(db: &DbState, output_dir: &Path) -> Result<String, String> {
    export_diagnostics_with_options(db, output_dir, DiagnosticsExportOptions::default())
}

/// Collects diagnostics data and writes a zip file to the given directory.
/// Returns the path to the zip file.
pub fn export_diagnostics_with_options(
    db: &DbState,
    output_dir: &Path,
    export_options: DiagnosticsExportOptions,
) -> Result<String, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let zip_name = format!("thesmall-pos-diagnostics-{timestamp}.zip");
    let zip_path = output_dir.join(&zip_name);

    let file = fs::File::create(&zip_path)
        .map_err(|e| format!("Failed to create diagnostics zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);

    let zip_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // 1. About info
    let about = redact_value_for_export(get_about_info(), export_options.redact_sensitive);
    zip.start_file("about.json", zip_options)
        .map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&about).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;

    // 2. System health
    drop(conn); // Release lock temporarily
    let health = redact_value_for_export(get_system_health(db)?, export_options.redact_sensitive);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    zip.start_file("system_health.json", zip_options)
        .map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&health).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;

    // 3. Pending sync counts by entity type
    let backlog = redact_value_for_export(get_sync_backlog(&conn), export_options.redact_sensitive);
    zip.start_file("sync_backlog.json", zip_options)
        .map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&backlog).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;

    // 4. Last 20 sync errors
    let errors = redact_value_for_export(
        json!(get_recent_sync_errors(&conn, 20)),
        export_options.redact_sensitive,
    );
    zip.start_file("sync_errors.json", zip_options)
        .map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&errors).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;

    // 5. Printer profiles + last print job statuses
    let printers = redact_value_for_export(
        get_printer_diagnostics(&conn),
        export_options.redact_sensitive,
    );
    zip.start_file("printer_diagnostics.json", zip_options)
        .map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&printers).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;

    // 6. Include log files
    let log_dir = get_log_dir();
    if export_options.include_logs && !export_options.redact_sensitive && log_dir.exists() {
        if let Ok(entries) = fs::read_dir(&log_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("log")
                    || path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("pos."))
                {
                    let fname = path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    let zip_entry = format!("logs/{fname}");
                    if zip.start_file(&zip_entry, zip_options).is_ok() {
                        if let Ok(f) = fs::File::open(&path) {
                            let mut buf = Vec::new();
                            // Cap at 5MB per file to keep zip manageable
                            let _ = f.take(MAX_LOG_SIZE).read_to_end(&mut buf);
                            let _ = zip.write_all(&buf);
                        }
                    }
                }
            }
        }
    }

    zip.finish().map_err(|e| e.to_string())?;

    Ok(zip_path.to_string_lossy().to_string())
}

fn redact_value_for_export(value: Value, enabled: bool) -> Value {
    if !enabled {
        return value;
    }
    redact_sensitive_fields(value)
}

fn redact_sensitive_fields(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut redacted = serde_json::Map::new();
            for (key, value) in map {
                if should_redact_key(&key) {
                    redacted.insert(key, Value::String("[REDACTED]".to_string()));
                } else {
                    redacted.insert(key, redact_sensitive_fields(value));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(items) => {
            Value::Array(items.into_iter().map(redact_sensitive_fields).collect())
        }
        other => other,
    }
}

fn should_redact_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    let sensitive_markers = [
        "api_key",
        "apikey",
        "secret",
        "password",
        "token",
        "authorization",
        "cookie",
        "pin",
    ];
    sensitive_markers
        .iter()
        .any(|marker| normalized.contains(marker))
}

fn get_recent_sync_errors(conn: &rusqlite::Connection, limit: i64) -> Vec<Value> {
    let mut errors = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, entity_type, status, last_error, retry_count, created_at, updated_at
         FROM sync_queue
         WHERE last_error IS NOT NULL AND last_error != ''
         ORDER BY updated_at DESC LIMIT ?1",
    ) {
        if let Ok(rows) = stmt.query_map(params![limit], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "entityType": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "lastError": row.get::<_, String>(3)?,
                "retryCount": row.get::<_, i64>(4)?,
                "createdAt": row.get::<_, String>(5)?,
                "updatedAt": row.get::<_, Option<String>>(6)?,
            }))
        }) {
            for row in rows.flatten() {
                errors.push(row);
            }
        }
    }
    errors
}

fn get_printer_diagnostics(conn: &rusqlite::Connection) -> Value {
    let mut profiles = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, name, system_printer_name, is_default, drawer_mode, created_at
         FROM printer_profiles ORDER BY is_default DESC, name",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "systemPrinterName": row.get::<_, String>(2)?,
                "isDefault": row.get::<_, bool>(3)?,
                "drawerMode": row.get::<_, Option<String>>(4)?,
                "createdAt": row.get::<_, String>(5)?,
            }))
        }) {
            for row in rows.flatten() {
                profiles.push(row);
            }
        }
    }

    // Last 10 print jobs with their status
    let mut recent_jobs = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, entity_type, entity_id, status, printer_profile_id, retry_count,
                warning_code, warning_message, created_at, last_attempt_at
         FROM print_jobs ORDER BY created_at DESC LIMIT 10",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "entityType": row.get::<_, String>(1)?,
                "entityId": row.get::<_, String>(2)?,
                "status": row.get::<_, String>(3)?,
                "printerProfileId": row.get::<_, Option<String>>(4)?,
                "retryCount": row.get::<_, i64>(5)?,
                "warningCode": row.get::<_, Option<String>>(6)?,
                "warningMessage": row.get::<_, Option<String>>(7)?,
                "createdAt": row.get::<_, String>(8)?,
                "lastAttemptAt": row.get::<_, Option<String>>(9)?,
            }))
        }) {
            for row in rows.flatten() {
                recent_jobs.push(row);
            }
        }
    }

    json!({
        "profiles": profiles,
        "recentJobs": recent_jobs,
    })
}

// ---------------------------------------------------------------------------
// Log rotation
// ---------------------------------------------------------------------------

/// Returns the log directory path (same location used by lib.rs).
pub fn get_log_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("XDG_DATA_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            #[cfg(target_os = "windows")]
            {
                PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()))
                    .join("AppData")
                    .join("Local")
            }
            #[cfg(not(target_os = "windows"))]
            {
                PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
                    .join(".local")
                    .join("share")
            }
        });
    base.join("com.thesmall.pos").join("logs")
}

/// Prune old log files, keeping only the most recent `MAX_LOG_FILES`.
pub fn prune_old_logs() {
    let log_dir = get_log_dir();
    if !log_dir.exists() {
        return;
    }

    let mut log_files: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("pos.") || name == "pos.log" {
                        let modified = entry
                            .metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .unwrap_or(std::time::UNIX_EPOCH);
                        log_files.push((path, modified));
                    }
                }
            }
        }
    }

    // Sort newest first
    log_files.sort_by(|a, b| b.1.cmp(&a.1));

    // Remove files beyond the limit
    for (path, _) in log_files.iter().skip(MAX_LOG_FILES) {
        if let Err(e) = fs::remove_file(path) {
            warn!("Failed to prune log file {}: {e}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_about_info_has_required_fields() {
        let info = get_about_info();
        assert!(info.get("version").is_some());
        assert!(info.get("buildTimestamp").is_some());
        assert!(info.get("gitSha").is_some());
        assert!(info.get("platform").is_some());
        assert!(info.get("arch").is_some());
    }

    #[test]
    fn test_log_dir_is_stable() {
        let d1 = get_log_dir();
        let d2 = get_log_dir();
        assert_eq!(d1, d2);
        assert!(d1.to_string_lossy().contains("com.thesmall.pos"));
    }

    #[test]
    fn test_system_health_with_empty_db() {
        let dir = std::env::temp_dir().join(format!("diag_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let health = get_system_health(&db_state).unwrap();
        assert!(health.get("schemaVersion").is_some());
        assert!(health.get("syncBacklog").is_some());
        assert!(health.get("printerStatus").is_some());
        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_export_diagnostics_creates_zip() {
        let dir = std::env::temp_dir().join(format!("diag_export_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let result = export_diagnostics(&db_state, &dir);
        assert!(result.is_ok());
        let zip_path = result.unwrap();
        assert!(std::path::Path::new(&zip_path).exists());
        // Verify it's a valid zip
        let file = std::fs::File::open(&zip_path).unwrap();
        let archive = zip::ZipArchive::new(file).unwrap();
        assert!(archive.len() >= 4); // at least about, health, backlog, errors
                                     // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_should_redact_key_matches_sensitive_markers() {
        assert!(should_redact_key("api_key"));
        assert!(should_redact_key("Authorization"));
        assert!(should_redact_key("staff_pin"));
        assert!(!should_redact_key("status"));
    }

    #[test]
    fn test_redact_sensitive_fields_recurses_through_objects() {
        let value = json!({
            "token": "tk-val",
            "nested": {
                "api_key": "key-value",
                "status": "ok"
            },
            "items": [
                { "password": "1234" },
                { "name": "safe" }
            ]
        });

        let redacted = redact_sensitive_fields(value);
        assert_eq!(redacted["token"], json!("[REDACTED]"));
        assert_eq!(redacted["nested"]["api_key"], json!("[REDACTED]"));
        assert_eq!(redacted["nested"]["status"], json!("ok"));
        assert_eq!(redacted["items"][0]["password"], json!("[REDACTED]"));
        assert_eq!(redacted["items"][1]["name"], json!("safe"));
    }
}
