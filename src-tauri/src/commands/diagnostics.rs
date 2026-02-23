use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tracing::{info, warn};

use crate::{db, diagnostics, sync};

fn parse_diagnostics_export_payload(arg0: Option<Value>) -> diagnostics::DiagnosticsExportOptions {
    let mut options = diagnostics::DiagnosticsExportOptions::default();

    match arg0 {
        Some(Value::Bool(include_logs)) => {
            options.include_logs = include_logs;
        }
        Some(Value::Object(obj)) => {
            if let Some(include_logs) = obj
                .get("includeLogs")
                .or_else(|| obj.get("include_logs"))
                .or_else(|| obj.get("logs"))
                .and_then(|v| v.as_bool())
            {
                options.include_logs = include_logs;
            }
            if let Some(redact_sensitive) = obj
                .get("redactSensitive")
                .or_else(|| obj.get("redact_sensitive"))
                .or_else(|| obj.get("redacted"))
                .and_then(|v| v.as_bool())
            {
                options.redact_sensitive = redact_sensitive;
            }
        }
        _ => {}
    }

    options
}

fn parse_diagnostics_open_export_dir_payload(arg0: Option<Value>) -> Result<String, String> {
    crate::payload_arg0_as_string(arg0, &["path", "exportPath", "export_path", "value"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing diagnostics export path".to_string())
}

fn open_directory(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = dir;
        Err("Opening diagnostics folder is not supported on this platform".into())
    }
}

fn parse_diagnostic_fix_driver_payload(arg0: Option<Value>) -> Result<String, String> {
    crate::payload_arg0_as_string(arg0, &["driverId", "driver_id", "id", "value"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing driverId".to_string())
}

async fn build_system_health_payload(
    db: &db::DbState,
    sync_state: &sync::SyncState,
) -> Result<Value, String> {
    let mut health = diagnostics::get_system_health(db)?;

    // Augment with live online/offline status
    let network = sync::check_network_status().await;
    let is_online = network
        .get("isOnline")
        .or_else(|| network.get("online"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Last sync time from sync state
    let last_sync = sync_state.last_sync.lock().ok().and_then(|g| g.clone());

    if let Some(obj) = health.as_object_mut() {
        obj.insert("isOnline".into(), serde_json::json!(is_online));
        obj.insert("lastSyncTime".into(), serde_json::json!(last_sync));
    }

    Ok(health)
}

pub fn start_system_health_monitor(
    app: tauri::AppHandle,
    db: Arc<db::DbState>,
    sync_state: Arc<sync::SyncState>,
    interval_secs: u64,
) {
    let cadence = Duration::from_secs(interval_secs.max(10));
    tauri::async_runtime::spawn(async move {
        info!(
            interval_secs = cadence.as_secs(),
            "System health monitor started"
        );
        loop {
            match build_system_health_payload(db.as_ref(), sync_state.as_ref()).await {
                Ok(payload) => {
                    let _ = app.emit("database_health_update", payload);
                }
                Err(error) => {
                    warn!(error = %error, "System health monitor iteration failed");
                }
            }

            tokio::time::sleep(cadence).await;
        }
    });
}

#[tauri::command]
pub async fn database_health_check(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    // Verify core tables exist
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let tables: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let payload = serde_json::json!({
        "success": true,
        "data": { "status": "ok", "tables": tables }
    });
    let _ = app.emit("database_health_update", payload.clone());
    Ok(payload)
}

#[tauri::command]
pub async fn database_get_stats(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let total_orders: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
        .unwrap_or(0);
    let pending_sync: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let active_sessions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM staff_sessions WHERE is_active = 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(serde_json::json!({
        "totalOrders": total_orders,
        "pendingSync": pending_sync,
        "activeSessions": active_sessions,
    }))
}

#[tauri::command]
pub async fn database_reset(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    crate::clear_operational_data_inner(&db)
}

#[tauri::command]
pub async fn database_clear_operational_data(
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    crate::clear_operational_data_inner(&db)
}

#[tauri::command]
pub async fn diagnostic_check_delivered_orders(
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut delivered_stmt = conn
        .prepare(
            "SELECT id, order_number, status, driver_id, created_at
             FROM orders
             WHERE LOWER(COALESCE(order_type, '')) = 'delivery'
               AND LOWER(COALESCE(status, '')) IN ('delivered', 'completed')
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let delivered_rows = delivered_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let delivered: Vec<(String, Option<String>, Option<String>, Option<String>, Option<String>)> =
        delivered_rows.filter_map(|r| r.ok()).collect();

    let mut with_driver = 0usize;
    let mut orders_without_driver = Vec::new();
    for (id, order_number, status, driver_id, created_at) in &delivered {
        let has_driver = driver_id
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if has_driver {
            with_driver += 1;
        } else {
            orders_without_driver.push(serde_json::json!({
                "id": id,
                "orderNumber": order_number.clone().unwrap_or_default(),
                "status": status.clone().unwrap_or_default(),
                "createdAt": created_at.clone().unwrap_or_default(),
            }));
        }
    }

    let earnings_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM driver_earnings", [], |row| row.get(0))
        .unwrap_or(0);

    let mut shifts_stmt = conn
        .prepare(
            "SELECT id, staff_id, status, check_in_time, check_out_time
             FROM staff_shifts
             WHERE role_type = 'driver'
             ORDER BY check_in_time DESC
             LIMIT 5",
        )
        .map_err(|e| e.to_string())?;
    let shifts_rows = shifts_stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "staff_id": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "check_in_time": row.get::<_, String>(3)?,
                "check_out_time": row.get::<_, Option<String>>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let recent_driver_shifts: Vec<serde_json::Value> = shifts_rows.filter_map(|r| r.ok()).collect();

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "total": delivered.len(),
            "withDriver": with_driver,
            "withoutDriver": delivered.len().saturating_sub(with_driver),
            "earningsCount": earnings_count,
            "ordersWithoutDriver": orders_without_driver,
            "recentDriverShifts": recent_driver_shifts,
        }
    }))
}

#[tauri::command]
pub async fn diagnostic_fix_missing_driver_ids(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let driver_id = parse_diagnostic_fix_driver_payload(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let driver_shift_id: Option<String> = conn
        .query_row(
            "SELECT id FROM staff_shifts
             WHERE staff_id = ?1 AND role_type = 'driver'
             ORDER BY check_in_time DESC
             LIMIT 1",
            rusqlite::params![driver_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some(driver_shift_id) = driver_shift_id else {
        return Ok(serde_json::json!({
            "success": false,
            "error": "Driver not found or has no shifts",
        }));
    };

    let mut orders_stmt = conn
        .prepare(
            "SELECT id, COALESCE(payment_method, ''), COALESCE(total_amount, 0), COALESCE(tip_amount, 0), COALESCE(branch_id, '')
             FROM orders
             WHERE LOWER(COALESCE(order_type, '')) = 'delivery'
               AND LOWER(COALESCE(status, '')) IN ('delivered', 'completed')
               AND (driver_id IS NULL OR TRIM(driver_id) = '')",
        )
        .map_err(|e| e.to_string())?;
    let orders_rows = orders_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let orders: Vec<(String, String, f64, f64, String)> = orders_rows.filter_map(|r| r.ok()).collect();

    if orders.is_empty() {
        return Ok(serde_json::json!({
            "success": true,
            "fixed": 0,
            "earningsCreated": 0,
            "message": "No orders to fix",
        }));
    }

    let mut fixed = 0i64;
    let mut earnings_created = 0i64;

    for (order_id, payment_method, total_amount, tip_amount, branch_id) in orders {
        let now = Utc::now().to_rfc3339();
        let updated = conn
            .execute(
                "UPDATE orders SET driver_id = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![driver_id, now, order_id],
            )
            .unwrap_or(0);
        if updated > 0 {
            fixed += 1;
        }

        let pm_lower = payment_method.to_ascii_lowercase();
        let mut earning_payment_method = "mixed".to_string();
        let mut cash_collected = 0.0f64;
        let mut card_amount = 0.0f64;

        if pm_lower.contains("card") {
            earning_payment_method = "card".to_string();
            card_amount = total_amount;
        } else if pm_lower.contains("cash") {
            earning_payment_method = "cash".to_string();
            cash_collected = total_amount;
        }

        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO driver_earnings (
                    id, driver_id, staff_shift_id, order_id, branch_id,
                    delivery_fee, tip_amount, total_earning,
                    payment_method, cash_collected, card_amount, cash_to_return,
                    order_details, settled, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?15)",
                rusqlite::params![
                    format!("de-fix-{}", uuid::Uuid::new_v4()),
                    driver_id,
                    driver_shift_id,
                    order_id,
                    branch_id,
                    0.0f64,
                    tip_amount,
                    tip_amount,
                    earning_payment_method,
                    cash_collected,
                    card_amount,
                    cash_collected - card_amount,
                    Option::<String>::None,
                    now,
                    now,
                ],
            )
            .unwrap_or(0);

        if inserted > 0 {
            earnings_created += 1;
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "fixed": fixed,
        "earningsCreated": earnings_created,
        "message": format!("Updated {fixed} orders and created {earnings_created} driver earnings"),
    }))
}

#[tauri::command]
pub async fn diagnostics_get_about() -> Result<Value, String> {
    Ok(diagnostics::get_about_info())
}

#[tauri::command]
pub async fn diagnostics_get_system_health(
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
) -> Result<Value, String> {
    build_system_health_payload(&db, &sync_state).await
}

#[tauri::command]
pub async fn diagnostics_export(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    use tauri::Manager;
    let options = parse_diagnostics_export_payload(arg0.clone());
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let zip_path = if arg0.is_none() {
        diagnostics::export_diagnostics(&db, &data_dir)?
    } else {
        diagnostics::export_diagnostics_with_options(&db, &data_dir, options)?
    };
    Ok(serde_json::json!({
        "success": true,
        "path": zip_path,
        "options": {
            "includeLogs": options.include_logs,
            "redactSensitive": options.redact_sensitive,
        }
    }))
}

#[tauri::command]
pub async fn diagnostics_open_export_dir(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    use tauri::Manager;

    let export_path = parse_diagnostics_open_export_dir_payload(arg0)?;
    let canonical_export_path = std::fs::canonicalize(&export_path)
        .map_err(|e| format!("Invalid diagnostics export path: {e}"))?;

    let export_parent = canonical_export_path
        .parent()
        .ok_or_else(|| "Diagnostics export directory could not be resolved".to_string())?;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let canonical_app_data_dir = std::fs::canonicalize(&app_data_dir).unwrap_or(app_data_dir);

    if !export_parent.starts_with(&canonical_app_data_dir) {
        return Err("Diagnostics export path is outside the app data directory".into());
    }

    open_directory(export_parent)?;

    Ok(serde_json::json!({
        "success": true,
        "path": export_parent.to_string_lossy(),
    }))
}

#[cfg(test)]
mod dto_tests {
    use super::{
        parse_diagnostic_fix_driver_payload, parse_diagnostics_export_payload,
        parse_diagnostics_open_export_dir_payload,
    };

    #[test]
    fn parse_diagnostics_export_payload_supports_defaults_and_bool_legacy_form() {
        let defaults = parse_diagnostics_export_payload(None);
        let from_bool = parse_diagnostics_export_payload(Some(serde_json::json!(false)));

        assert!(defaults.include_logs);
        assert!(!defaults.redact_sensitive);
        assert!(!from_bool.include_logs);
        assert!(!from_bool.redact_sensitive);
    }

    #[test]
    fn parse_diagnostics_export_payload_supports_object_aliases() {
        let parsed = parse_diagnostics_export_payload(Some(serde_json::json!({
            "includeLogs": false,
            "redactSensitive": true
        })));

        assert!(!parsed.include_logs);
        assert!(parsed.redact_sensitive);
    }

    #[test]
    fn parse_diagnostics_open_export_dir_payload_supports_string_and_object() {
        let from_string = parse_diagnostics_open_export_dir_payload(Some(serde_json::json!(
            "C:/app/diag/bundle.zip"
        )))
        .expect("string path should parse");
        let from_object = parse_diagnostics_open_export_dir_payload(Some(serde_json::json!({
            "path": "C:/app/diag/bundle.zip"
        })))
        .expect("object path should parse");

        assert_eq!(from_string, "C:/app/diag/bundle.zip");
        assert_eq!(from_object, "C:/app/diag/bundle.zip");
    }

    #[test]
    fn parse_diagnostics_open_export_dir_payload_rejects_missing() {
        let err = parse_diagnostics_open_export_dir_payload(Some(serde_json::json!({})))
            .expect_err("missing path should fail");
        assert!(err.contains("Missing diagnostics export path"));
    }

    #[test]
    fn parse_diagnostic_fix_driver_payload_supports_string_and_object() {
        let from_string = parse_diagnostic_fix_driver_payload(Some(serde_json::json!("driver-1")))
            .expect("string payload should parse");
        let from_object = parse_diagnostic_fix_driver_payload(Some(serde_json::json!({
            "driverId": "driver-2"
        })))
        .expect("object payload should parse");

        assert_eq!(from_string, "driver-1");
        assert_eq!(from_object, "driver-2");
    }
}
