//! Diagnostics module for The Small POS.
//!
//! Provides:
//! - **About info**: version, build timestamp, git SHA, platform
//! - **System health**: online/offline, sync backlog, printer status, last z-report
//! - **Diagnostics export**: packages logs, DB schema version, sync counts,
//!   last 20 sync errors, and printer profiles into a zip bundle.
//! - **Log rotation helpers**: used by `lib.rs` to configure rolling log files.

use crate::db::DbState;
use crate::sync::normalize_optional_uuid_str;
use crate::sync::SyncBlockerDetail;
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
        payment_adjustment_backlog,
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
        let payment_adjustment_backlog = get_payment_adjustment_backlog(&conn);
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
            payment_adjustment_backlog,
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
    let sync_blocker_details = crate::sync::get_sync_blocker_details(db, 10).unwrap_or_default();
    let terminal_context = get_terminal_context(db);
    let sync_status_summary = get_sync_status_summary(db).unwrap_or_else(|_| json!({}));
    let parity_queue_status = get_parity_queue_status(db).unwrap_or(Value::Null);
    let financial_queue_status = get_financial_queue_status(db).unwrap_or(Value::Null);
    let last_parity_sync = get_last_parity_sync(db);
    let credential_state = get_credential_state(db);

    Ok(json!({
        "schemaVersion": schema_version,
        "syncBacklog": sync_backlog,
        "paymentAdjustmentBacklog": payment_adjustment_backlog,
        "syncBlockerDetails": sync_blocker_details,
        "terminalContext": terminal_context,
        "syncStatusSummary": sync_status_summary,
        "lastSyncTimes": last_sync_times,
        "printerStatus": printer_status,
        "lastZReport": last_zreport,
        "pendingOrders": pending_orders,
        "dbSizeBytes": db_size,
        "panicCount": crate::panic_hook::crash_count(),
        "parityQueueStatus": parity_queue_status,
        "financialQueueStatus": financial_queue_status,
        "lastParitySync": last_parity_sync,
        "credentialState": credential_state,
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

fn get_payment_adjustment_backlog(conn: &rusqlite::Connection) -> Value {
    let mut generic_deferred = 0i64;
    let mut waiting_for_parent_payment = 0i64;
    let mut waiting_for_canonical_remote_payment_id = 0i64;

    if let Ok(mut stmt) = conn.prepare(
        "SELECT pa.sync_state,
                op.sync_state,
                op.remote_payment_id
         FROM payment_adjustments pa
         LEFT JOIN order_payments op ON op.id = pa.payment_id
         WHERE pa.sync_state != 'applied'",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        }) {
            for row in rows.flatten() {
                let (adjustment_state, parent_payment_state, remote_payment_id) = row;
                if adjustment_state == "waiting_parent" {
                    if parent_payment_state.as_deref() == Some("applied") {
                        if normalize_optional_uuid_str(remote_payment_id.as_deref()).is_none() {
                            waiting_for_canonical_remote_payment_id += 1;
                        } else {
                            generic_deferred += 1;
                        }
                    } else {
                        waiting_for_parent_payment += 1;
                    }
                } else {
                    generic_deferred += 1;
                }
            }
        }
    }

    json!({
        "genericDeferred": generic_deferred,
        "waitingForParentPayment": waiting_for_parent_payment,
        "waitingForCanonicalRemotePaymentId": waiting_for_canonical_remote_payment_id,
    })
}

fn get_sync_blocker_details_json(details: Vec<SyncBlockerDetail>) -> Value {
    serde_json::to_value(details).unwrap_or_else(|_| json!([]))
}

fn parse_local_setting_value(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Value::Null;
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        return parsed;
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        _ => Value::String(trimmed.to_string()),
    }
}

fn read_local_setting_json(db: &DbState, category: &str, key: &str) -> Option<Value> {
    let conn = db.conn.lock().ok()?;
    crate::db::get_setting(&conn, category, key).map(|value| parse_local_setting_value(&value))
}

fn get_terminal_context(db: &DbState) -> Value {
    let runtime = crate::commands::settings::build_terminal_runtime_config(db);
    let prefer_local = |category: &str, key: &str, runtime_key: &str| {
        read_local_setting_json(db, category, key)
            .unwrap_or_else(|| runtime.get(runtime_key).cloned().unwrap_or(Value::Null))
    };
    let prefer_local_text = |keys: &[(&str, &str)]| -> Value {
        for (category, key) in keys {
            if let Some(value) = read_local_setting_json(db, category, key) {
                match value {
                    Value::String(text) => {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            return Value::String(trimmed.to_string());
                        }
                    }
                    Value::Number(number) => return Value::String(number.to_string()),
                    Value::Bool(flag) => {
                        return Value::String(if flag { "true" } else { "false" }.to_string())
                    }
                    _ => {}
                }
            }
        }
        Value::Null
    };
    json!({
        "terminalId": prefer_local("terminal", "terminal_id", "terminal_id"),
        "branchId": prefer_local("terminal", "branch_id", "branch_id"),
        "branchName": prefer_local_text(&[
            ("restaurant", "name"),
            ("restaurant", "subtitle"),
            ("terminal", "store_name"),
        ]),
        "organizationId": prefer_local("terminal", "organization_id", "organization_id"),
        "organizationName": prefer_local_text(&[
            ("organization", "name"),
            ("general", "company_name"),
        ]),
        "terminalType": prefer_local("terminal", "terminal_type", "terminal_type"),
        "parentTerminalId": prefer_local("terminal", "parent_terminal_id", "parent_terminal_id"),
        "ownerTerminalId": prefer_local("terminal", "owner_terminal_id", "owner_terminal_id"),
        "ownerTerminalDbId": prefer_local("terminal", "owner_terminal_db_id", "owner_terminal_db_id"),
        "sourceTerminalId": prefer_local("terminal", "source_terminal_id", "source_terminal_id"),
        "sourceTerminalDbId": prefer_local("terminal", "source_terminal_db_id", "source_terminal_db_id"),
        "posOperatingMode": prefer_local("terminal", "pos_operating_mode", "pos_operating_mode"),
        "enabledFeatures": prefer_local("terminal", "enabled_features", "enabled_features"),
        "lastConfigSyncAt": prefer_local("terminal", "last_config_sync_at", "last_config_sync_at"),
        "syncHealth": runtime.get("sync_health").cloned().unwrap_or(Value::Null),
        "syncHealthState": runtime.get("sync_health").cloned().unwrap_or(Value::Null),
        "businessType": runtime.get("business_type").cloned().unwrap_or(Value::Null),
        "ghostModeFeatureEnabled": runtime
            .get("ghost_mode_feature_enabled")
            .cloned()
            .unwrap_or(Value::Null),
        "adminDashboardUrl": runtime.get("admin_dashboard_url").cloned().unwrap_or(Value::Null),
    })
}

fn build_diagnostics_sync_state() -> crate::sync::SyncState {
    crate::sync::SyncState::new()
}

fn get_sync_status_summary(db: &DbState) -> Result<Value, String> {
    let sync_state = build_diagnostics_sync_state();
    let mut summary = crate::sync::get_sync_status(db, &sync_state)?;
    if let Some(obj) = summary.as_object_mut() {
        obj.insert("parityQueueStatus".into(), get_parity_queue_status(db)?);
        obj.insert(
            "financialQueueStatus".into(),
            get_financial_queue_status(db)?,
        );
        obj.insert("lastParitySync".into(), get_last_parity_sync(db));
        obj.insert("credentialState".into(), get_credential_state(db));
    }
    Ok(summary)
}

fn get_parity_queue_status(db: &DbState) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    serde_json::to_value(crate::sync_queue::get_status(&conn)?)
        .map_err(|e| format!("serialize parity queue status: {e}"))
}

fn get_parity_actionable_items(db: &DbState, limit: i64) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let items = crate::sync_queue::list_actionable_items(
        &conn,
        &crate::sync_queue::QueueListQuery {
            limit: Some(limit),
            module_type: None,
        },
    )?;
    serde_json::to_value(items).map_err(|e| format!("serialize parity actionable items: {e}"))
}

fn get_parity_failure_families(db: &DbState) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let items = crate::sync_queue::list_actionable_items(
        &conn,
        &crate::sync_queue::QueueListQuery {
            limit: Some(250),
            module_type: None,
        },
    )?;

    let mut families: std::collections::BTreeMap<String, serde_json::Map<String, Value>> =
        std::collections::BTreeMap::new();

    for item in items {
        let key = format!("{}::{}", item.module_type, item.status);
        let entry = families.entry(key).or_insert_with(|| {
            let mut map = serde_json::Map::new();
            map.insert("moduleType".into(), json!(item.module_type));
            map.insert("status".into(), json!(item.status));
            map.insert("count".into(), json!(0));
            map.insert("sampleItemId".into(), json!(item.id.clone()));
            map.insert("sampleTableName".into(), json!(item.table_name.clone()));
            map.insert("sampleRecordId".into(), json!(item.record_id.clone()));
            map.insert("sampleError".into(), json!(item.error_message.clone()));
            map
        });

        let current_count = entry.get("count").and_then(Value::as_i64).unwrap_or(0);
        entry.insert("count".into(), json!(current_count + 1));
    }

    Ok(Value::Array(
        families
            .into_values()
            .map(Value::Object)
            .collect::<Vec<_>>(),
    ))
}

fn get_financial_queue_status(db: &DbState) -> Result<Value, String> {
    crate::sync::get_financial_stats(db)
}

fn get_last_parity_sync(db: &DbState) -> Value {
    read_local_setting_json(db, "diagnostics", "last_parity_sync").unwrap_or(Value::Null)
}

fn value_is_present(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(raw) => !raw.trim().is_empty(),
        Value::Bool(flag) => *flag,
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
        Value::Number(_) => true,
    }
}

fn has_local_setting_value(db: &DbState, category: &str, keys: &[&str]) -> bool {
    keys.iter().any(|key| {
        read_local_setting_json(db, category, key)
            .map(|value| value_is_present(&value))
            .unwrap_or(false)
    })
}

fn has_stored_credential(keys: &[&str]) -> bool {
    keys.iter().any(|key| {
        crate::storage::get_credential(key)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    })
}

fn get_credential_state(db: &DbState) -> Value {
    let has_admin_url = has_stored_credential(&["admin_dashboard_url"])
        || has_local_setting_value(db, "terminal", &["admin_dashboard_url", "admin_url"]);
    let has_api_key = has_stored_credential(&["pos_api_key"])
        || has_local_setting_value(db, "terminal", &["pos_api_key", "api_key"]);

    json!({
        "hasAdminUrl": has_admin_url,
        "hasApiKey": has_api_key,
    })
}

fn get_terminal_settings_snapshot(conn: &rusqlite::Connection) -> Value {
    let mut snapshot = serde_json::Map::new();
    let mut stmt = match conn.prepare(
        "SELECT setting_category, setting_key, setting_value
         FROM local_settings
         WHERE setting_category IN ('terminal', 'organization', 'restaurant')
         ORDER BY setting_category ASC, setting_key ASC",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Value::Object(snapshot),
    };

    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Value::Object(snapshot),
    };

    for row in rows.flatten() {
        let (category, key, value) = row;
        let category_entry = snapshot
            .entry(category)
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Some(category_map) = category_entry.as_object_mut() {
            category_map.insert(key, parse_local_setting_value(&value));
        }
    }

    Value::Object(snapshot)
}

fn write_json_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    zip_options: &zip::write::SimpleFileOptions,
    file_name: &str,
    value: &Value,
) -> Result<(), String> {
    zip.start_file(file_name, zip_options.clone())
        .map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize {file_name}: {e}"))?;
    zip.write_all(json.as_bytes()).map_err(|e| e.to_string())
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
        "SELECT id, shift_id, generated_at, sync_state, gross_sales, net_sales
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
    write_json_to_zip(&mut zip, &zip_options, "about.json", &about)?;

    drop(conn); // Release lock while cross-module helpers acquire the DB mutex.
    let health = redact_value_for_export(get_system_health(db)?, export_options.redact_sensitive);
    let terminal_context =
        redact_value_for_export(get_terminal_context(db), export_options.redact_sensitive);
    let sync_status = redact_value_for_export(
        get_sync_status_summary(db)?,
        export_options.redact_sensitive,
    );
    let closeout_readiness = redact_value_for_export(
        crate::zreport::get_closeout_readiness_snapshot(db, &json!({}))?,
        export_options.redact_sensitive,
    );
    let parity_queue_status = redact_value_for_export(
        get_parity_queue_status(db).unwrap_or(Value::Null),
        export_options.redact_sensitive,
    );
    let parity_actionable_items = redact_value_for_export(
        get_parity_actionable_items(db, 50).unwrap_or(Value::Null),
        export_options.redact_sensitive,
    );
    let parity_failure_families = redact_value_for_export(
        get_parity_failure_families(db).unwrap_or(Value::Null),
        export_options.redact_sensitive,
    );
    let financial_queue_status = redact_value_for_export(
        get_financial_queue_status(db).unwrap_or(Value::Null),
        export_options.redact_sensitive,
    );
    let last_parity_sync =
        redact_value_for_export(get_last_parity_sync(db), export_options.redact_sensitive);
    let credential_state =
        redact_value_for_export(get_credential_state(db), export_options.redact_sensitive);
    let sync_blocker_details = redact_value_for_export(
        get_sync_blocker_details_json(crate::sync::get_sync_blocker_details(db, 25)?),
        export_options.redact_sensitive,
    );
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let terminal_settings_snapshot = redact_value_for_export(
        get_terminal_settings_snapshot(&conn),
        export_options.redact_sensitive,
    );
    let backlog = redact_value_for_export(get_sync_backlog(&conn), export_options.redact_sensitive);
    let payment_adjustment_backlog = redact_value_for_export(
        get_payment_adjustment_backlog(&conn),
        export_options.redact_sensitive,
    );
    let errors = redact_value_for_export(
        json!(get_recent_sync_errors(&conn, 20)),
        export_options.redact_sensitive,
    );
    let printers = redact_value_for_export(
        get_printer_diagnostics(&conn),
        export_options.redact_sensitive,
    );

    // 2. System identity + runtime state
    write_json_to_zip(&mut zip, &zip_options, "system_health.json", &health)?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "terminal_context.json",
        &terminal_context,
    )?;
    write_json_to_zip(&mut zip, &zip_options, "sync_status.json", &sync_status)?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "closeout_readiness.json",
        &closeout_readiness,
    )?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "terminal_settings_snapshot.json",
        &terminal_settings_snapshot,
    )?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "parity_queue_status.json",
        &parity_queue_status,
    )?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "parity_actionable_items.json",
        &parity_actionable_items,
    )?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "parity_failure_families.json",
        &parity_failure_families,
    )?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "financial_queue_status.json",
        &financial_queue_status,
    )?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "last_parity_sync.json",
        &last_parity_sync,
    )?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "credential_state.json",
        &credential_state,
    )?;

    // 3. Queue/backlog snapshots
    write_json_to_zip(&mut zip, &zip_options, "sync_backlog.json", &backlog)?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "payment_adjustment_backlog.json",
        &payment_adjustment_backlog,
    )?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "sync_blocker_details.json",
        &sync_blocker_details,
    )?;

    // 4. Recent operational history
    write_json_to_zip(&mut zip, &zip_options, "sync_errors.json", &errors)?;
    write_json_to_zip(
        &mut zip,
        &zip_options,
        "printer_diagnostics.json",
        &printers,
    )?;

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
                    if zip.start_file(&zip_entry, zip_options.clone()).is_ok() {
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
    let non_secret_presence_markers = ["hasapikey", "hasadminurl"];
    if non_secret_presence_markers.contains(&normalized.as_str()) {
        return false;
    }
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

    fn read_zip_json(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Value {
        let mut file = archive.by_name(name).expect("zip entry should exist");
        let mut contents = String::new();
        file.read_to_string(&mut contents)
            .expect("read zip json contents");
        serde_json::from_str(&contents).expect("parse zip json")
    }

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
        assert!(health.get("paymentAdjustmentBacklog").is_some());
        assert!(health.get("terminalContext").is_some());
        assert!(health.get("syncStatusSummary").is_some());
        assert!(health.get("printerStatus").is_some());
        assert!(health.get("parityQueueStatus").is_some());
        assert!(health.get("financialQueueStatus").is_some());
        assert!(health.get("lastParitySync").is_some());
        assert!(health.get("credentialState").is_some());
        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_payment_adjustment_backlog_distinguishes_parent_and_canonical_blockers() {
        let dir = std::env::temp_dir().join(format!("diag_adjustments_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let conn = db_state.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-generic', '[]', 10.0, 'completed', 'synced', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, remote_payment_id, created_at, updated_at)
             VALUES ('pay-generic', 'ord-generic', 'cash', 10.0, 'synced', 'applied', ?1, datetime('now'), datetime('now'))",
            params![uuid::Uuid::new_v4().to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-generic', 'pay-generic', 'ord-generic', 'refund', 1.0, 'Generic', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-parent', '[]', 20.0, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-parent', 'ord-parent', 'cash', 20.0, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-parent', 'pay-parent', 'ord-parent', 'refund', 2.0, 'Parent', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-canonical', '[]', 30.0, 'completed', 'synced', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-canonical', 'ord-canonical', 'card', 30.0, 'synced', 'applied', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-canonical', 'pay-canonical', 'ord-canonical', 'refund', 3.0, 'Canonical', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        let backlog = get_payment_adjustment_backlog(&conn);
        drop(conn);

        assert_eq!(backlog["genericDeferred"], json!(1));
        assert_eq!(backlog["waitingForParentPayment"], json!(1));
        assert_eq!(backlog["waitingForCanonicalRemotePaymentId"], json!(1));

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
    fn test_export_diagnostics_is_self_describing_and_preserves_ids_when_redacted() {
        let dir = std::env::temp_dir().join(format!("diag_bundle_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let conn = db_state.conn.lock().unwrap();

        crate::db::set_setting(&conn, "terminal", "terminal_id", "terminal-d80762ac").unwrap();
        crate::db::set_setting(
            &conn,
            "terminal",
            "branch_id",
            "d28cef2e-bbf2-496a-b922-45b497525715",
        )
        .unwrap();
        crate::db::set_setting(
            &conn,
            "terminal",
            "organization_id",
            "95e63e0b-5b3a-48f8-9c96-fb9f041a0255",
        )
        .unwrap();
        crate::db::set_setting(&conn, "restaurant", "name", "Kifisia Branch").unwrap();
        crate::db::set_setting(&conn, "organization", "name", "The Small Group").unwrap();
        crate::db::set_setting(
            &conn,
            "terminal",
            "admin_dashboard_url",
            "https://admin.example.com",
        )
        .unwrap();
        crate::db::set_setting(&conn, "terminal", "terminal_type", "secondary").unwrap();
        crate::db::set_setting(&conn, "terminal", "api_key", "super-secret").unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, status, payment_status, payment_method,
                sync_status, created_at, updated_at
             ) VALUES (
                'ord-diag-blocker', 'ORD-DIAG-0070', '[]', 9.7, 'completed', 'partially_paid', 'split',
                'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, currency, status, transaction_ref,
                sync_status, sync_state, created_at, updated_at
             ) VALUES (
                'pay-diag-blocker', 'ord-diag-blocker', 'cash', 0.25, 'EUR', 'completed', 'TX-DIAG-1',
                'failed', 'failed', '2026-04-16T09:39:05Z', '2026-04-16T09:39:05Z'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status, retry_count, max_retries, last_error
             ) VALUES (
                'payment', 'pay-diag-blocker', 'insert', '{}', 'payment:pay-diag-blocker',
                'failed', 5, 5, 'Payment exceeds order total'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let export_path = export_diagnostics_with_options(
            &db_state,
            &dir,
            DiagnosticsExportOptions {
                include_logs: false,
                redact_sensitive: true,
            },
        )
        .expect("export diagnostics bundle");

        let file = std::fs::File::open(&export_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let entry_names: Vec<String> = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect();
        assert!(entry_names.contains(&"terminal_context.json".to_string()));
        assert!(entry_names.contains(&"sync_status.json".to_string()));
        assert!(entry_names.contains(&"closeout_readiness.json".to_string()));
        assert!(entry_names.contains(&"terminal_settings_snapshot.json".to_string()));
        assert!(entry_names.contains(&"parity_queue_status.json".to_string()));
        assert!(entry_names.contains(&"parity_actionable_items.json".to_string()));
        assert!(entry_names.contains(&"parity_failure_families.json".to_string()));
        assert!(entry_names.contains(&"financial_queue_status.json".to_string()));
        assert!(entry_names.contains(&"last_parity_sync.json".to_string()));
        assert!(entry_names.contains(&"credential_state.json".to_string()));

        let terminal_context = read_zip_json(&mut archive, "terminal_context.json");
        assert_eq!(terminal_context["terminalId"], json!("terminal-d80762ac"));
        assert_eq!(
            terminal_context["branchId"],
            json!("d28cef2e-bbf2-496a-b922-45b497525715")
        );
        assert_eq!(
            terminal_context["organizationId"],
            json!("95e63e0b-5b3a-48f8-9c96-fb9f041a0255")
        );
        assert_eq!(terminal_context["branchName"], json!("Kifisia Branch"));
        assert_eq!(
            terminal_context["organizationName"],
            json!("The Small Group")
        );

        let terminal_settings = read_zip_json(&mut archive, "terminal_settings_snapshot.json");
        assert_eq!(
            terminal_settings["terminal"]["terminal_id"],
            json!("terminal-d80762ac")
        );
        assert_eq!(
            terminal_settings["terminal"]["api_key"],
            json!("[REDACTED]")
        );

        let credential_state = read_zip_json(&mut archive, "credential_state.json");
        assert_eq!(credential_state["hasAdminUrl"], json!(true));
        assert_eq!(credential_state["hasApiKey"], json!(true));

        let system_health = read_zip_json(&mut archive, "system_health.json");
        assert_eq!(system_health["credentialState"]["hasAdminUrl"], json!(true));
        assert_eq!(system_health["credentialState"]["hasApiKey"], json!(true));
        assert!(system_health.get("parityQueueStatus").is_some());
        assert!(system_health.get("financialQueueStatus").is_some());
        assert!(system_health.get("lastParitySync").is_some());

        let blocker_details = read_zip_json(&mut archive, "sync_blocker_details.json");
        let first_blocker = blocker_details
            .as_array()
            .and_then(|items| items.first())
            .expect("payment blocker detail should be exported");
        assert_eq!(first_blocker["paymentId"], json!("pay-diag-blocker"));
        assert_eq!(first_blocker["paymentAmount"], json!(0.25));
        assert_eq!(first_blocker["paymentMethod"], json!("cash"));
        assert_eq!(first_blocker["paymentTransactionRef"], json!("TX-DIAG-1"));
        assert_eq!(first_blocker["paymentSyncState"], json!("failed"));
        assert_eq!(first_blocker["paymentSyncStatus"], json!("failed"));
        assert_eq!(first_blocker["remotePaymentIdPresent"], json!(false));
        assert_eq!(first_blocker["orderTotalAmount"], json!(9.7));
        assert_eq!(first_blocker["orderSettledAmount"], json!(0.25));
        assert_eq!(first_blocker["orderOutstandingAmount"], json!(9.45));
        assert_eq!(
            first_blocker["paymentCreatedAt"],
            json!("2026-04-16T09:39:05Z")
        );
        assert_eq!(
            first_blocker["paymentUpdatedAt"],
            json!("2026-04-16T09:39:05Z")
        );

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
