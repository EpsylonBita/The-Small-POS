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
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::fs;
#[cfg(test)]
use std::io::Read as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use tracing::warn;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum number of log files to retain.
pub const MAX_LOG_FILES: usize = 10;

#[derive(Debug, Clone, Copy)]
pub struct DiagnosticsExportOptions {
    pub include_logs: bool,
    /// Kept for the IPC contract only: every bundle is redacted, whatever
    /// this says. Review 30/09/2026: it defaulted to false, so an export
    /// asked for without options (`diagnostics:export` with no payload) left
    /// the terminal unredacted. The Android bundle has no unredacted export
    /// either.
    pub redact_sensitive: bool,
}

impl Default for DiagnosticsExportOptions {
    fn default() -> Self {
        Self {
            include_logs: true,
            redact_sensitive: true,
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
        sync_backlog_status,
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

        // A failed read keeps the backlog's shape but says so
        // (syncBacklogStatus): the Health view's backlog card shows
        // "unavailable", never "clear" (review 30/09/2026). The bundle's
        // sync_backlog.json reports the failure itself.
        let (sync_backlog, sync_backlog_status) = match get_sync_backlog(&conn) {
            Ok(backlog) => (backlog, "ok"),
            Err(error) => {
                warn!(error = %error, "Failed to read the sync backlog for system health");
                (json!({}), "unavailable")
            }
        };
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
            sync_backlog_status,
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
    let checkout_payment_blockers = get_checkout_payment_blockers(db).unwrap_or_else(|error| {
        warn!(
            error = %error,
            "Failed to collect checkout payment blockers for system health"
        );
        json!({
            "count": 0,
            "details": [],
            "sourceWindow": "active_shift",
        })
    });

    Ok(json!({
        "schemaVersion": schema_version,
        "syncBacklog": sync_backlog,
        "syncBacklogStatus": sync_backlog_status,
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
        "checkoutPaymentBlockers": checkout_payment_blockers,
        "invalidOrders": {
            "count": invalid_orders_count,
            "details": invalid_orders
        }
    }))
}

/// Unsynced rows by queue entity and status, plus the payment and adjustment
/// sync states. A failed read is an error, never an empty ("clear") backlog
/// (review 30/09/2026: sync_backlog.json recorded `{}` as "ok").
fn get_sync_backlog(conn: &rusqlite::Connection) -> Result<Value, String> {
    let mut result = serde_json::Map::new();
    let mut stmt = conn
        .prepare(
            "SELECT entity_type, status, COUNT(*) FROM sync_queue GROUP BY entity_type, status",
        )
        .map_err(|error| format!("sync_queue backlog: {error}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|error| format!("sync_queue backlog: {error}"))?;
    for (entity_type, status, count) in rows {
        let entry = result.entry(entity_type).or_insert_with(|| json!({}));
        entry[&status] = json!(count);
    }

    // Also check order_payments and payment_adjustments sync states
    for table in ["order_payments", "payment_adjustments"] {
        let query = format!(
            "SELECT sync_state, COUNT(*) FROM {table} WHERE sync_state != 'applied' GROUP BY sync_state"
        );
        let mut stmt = conn
            .prepare(&query)
            .map_err(|error| format!("{table} sync states: {error}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .and_then(Iterator::collect::<Result<Vec<_>, _>>)
            .map_err(|error| format!("{table} sync states: {error}"))?;
        for (state, count) in rows {
            let entry = result.entry(table).or_insert_with(|| json!({}));
            entry[&state] = json!(count);
        }
    }

    Ok(Value::Object(result))
}

fn get_checkout_payment_blockers(db: &DbState) -> Result<Value, String> {
    let terminal_id = crate::storage::get_credential("terminal_id")
        .or_else(|| crate::read_local_setting(db, "terminal", "terminal_id"))
        .unwrap_or_default();
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let load_active_shift = |filter_terminal: bool| -> Result<
        Option<(String, Option<String>, Option<String>)>,
        String,
    > {
        let sql = if filter_terminal {
            "SELECT COALESCE(branch_id, ''), report_date, period_start_at
             FROM staff_shifts
             WHERE status = 'active'
               AND role_type IN ('cashier', 'manager')
               AND COALESCE(terminal_id, '') = ?1
             ORDER BY check_in_time DESC
             LIMIT 1"
        } else {
            "SELECT COALESCE(branch_id, ''), report_date, period_start_at
             FROM staff_shifts
             WHERE status = 'active'
               AND role_type IN ('cashier', 'manager')
             ORDER BY check_in_time DESC
             LIMIT 1"
        };

        if filter_terminal {
            conn.query_row(sql, params![terminal_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .optional()
            .map_err(|e| format!("load active checkout shift for diagnostics: {e}"))
        } else {
            conn.query_row(sql, [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .optional()
                .map_err(|e| format!("load fallback checkout shift for diagnostics: {e}"))
        }
    };

    let active_shift = if terminal_id.trim().is_empty() {
        load_active_shift(false)?
    } else {
        load_active_shift(true)?.or_else(|| load_active_shift(false).ok().flatten())
    };

    let Some((branch_id, stored_report_date, stored_period_start_at)) = active_shift else {
        return Ok(json!({
            "count": 0,
            "details": [],
            "sourceWindow": "active_shift",
        }));
    };

    let shift_business_day = crate::shifts::resolve_shift_business_day_context(
        &conn,
        &branch_id,
        &now,
        stored_report_date.as_deref(),
        stored_period_start_at.as_deref(),
    );
    let blockers = crate::payment_integrity::load_branch_window_payment_blockers(
        &conn,
        &branch_id,
        shift_business_day.period_start_at.as_str(),
        Some(now.as_str()),
        true,
    )?;

    Ok(json!({
        "count": blockers.len(),
        "details": blockers,
        "sourceWindow": "active_shift",
    }))
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

/// The exported blocker list.
///
/// `SyncBlockerDetail` describes the legacy `sync_queue` only, and its integer
/// `queue_id` cannot carry a parity row's UUID. A parity conflict is still a
/// blocker — in practice the hardest kind, because no amount of waiting clears
/// it — so parity rows are appended here as their own shape rather than forced
/// into that struct. Without this, a terminal whose parity queue was jammed
/// exported an empty `sync_blocker_details.json`.
fn get_sync_blocker_details_json(
    details: Vec<SyncBlockerDetail>,
    parity_blockers: Vec<Value>,
) -> Value {
    let mut combined = match serde_json::to_value(details) {
        Ok(Value::Array(items)) => items,
        _ => Vec::new(),
    };
    combined.extend(parity_blockers);
    Value::Array(combined)
}

/// Parity-queue rows an operator has to act on: conflicts, and anything holding
/// a recorded error. Each one names the queue it belongs to so the two shapes in
/// `sync_blocker_details.json` stay tellable apart.
fn get_parity_blocker_details(db: &DbState, limit: i64) -> Vec<Value> {
    let Ok(conn) = db.conn.lock() else {
        return Vec::new();
    };
    // Same ownership boundary as the error list: the accessor decides what a
    // renderer (and therefore a support bundle) may see.
    let Ok(items) = crate::sync_queue::renderer_list_actionable_items(
        &conn,
        &crate::sync_queue::QueueListQuery {
            limit: Some(limit),
            module_type: None,
        },
    ) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter(|item| {
            item.status == "conflict"
                || (item.status == "failed"
                    && item
                        .error_message
                        .as_deref()
                        .is_some_and(|reason| !reason.trim().is_empty()))
        })
        .map(|item| {
            json!({
                "queue": "parity_sync_queue",
                "queueItemId": item.id,
                "moduleType": item.module_type,
                "entityType": item.table_name,
                "entityId": item.record_id,
                "operation": item.operation,
                "queueStatus": item.status,
                "blockerReason": crate::print::safe_operational_error(item.error_message, 1024)
                    .unwrap_or_else(|| "(no reason recorded)".to_string()),
                "conflictStrategy": item.conflict_strategy,
                "attempts": item.attempts,
                "createdAt": item.created_at,
                "lastAttempt": item.last_attempt,
            })
        })
        .collect()
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
    serde_json::to_value(crate::sync_queue::renderer_get_status(&conn)?)
        .map_err(|e| format!("serialize parity queue status: {e}"))
}

fn get_parity_actionable_items(db: &DbState, limit: i64) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let items = crate::sync_queue::renderer_list_actionable_items(
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
    let items = crate::sync_queue::renderer_list_actionable_items(
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

/// The terminal, organization and restaurant settings. A failed read is an
/// error, never an empty snapshot (review 30/09/2026).
fn get_terminal_settings_snapshot(conn: &rusqlite::Connection) -> Result<Value, String> {
    let mut snapshot = serde_json::Map::new();
    let mut stmt = conn
        .prepare(
            "SELECT setting_category, setting_key, setting_value
         FROM local_settings
         WHERE setting_category IN ('terminal', 'organization', 'restaurant')
         ORDER BY setting_category ASC, setting_key ASC",
        )
        .map_err(|error| format!("local_settings: {error}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|error| format!("local_settings: {error}"))?;

    for row in rows {
        let (category, key, value) = row;
        let category_entry = snapshot
            .entry(category)
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Some(category_map) = category_entry.as_object_mut() {
            category_map.insert(key, parse_local_setting_value(&value));
        }
    }

    Ok(Value::Object(snapshot))
}

fn write_json_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    zip_options: &zip::write::SimpleFileOptions,
    file_name: &str,
    value: &Value,
) -> Result<(), String> {
    zip.start_file(file_name, *zip_options)
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
        "SELECT id, entity_type, status, created_at, warning_code
         FROM print_jobs ORDER BY created_at DESC LIMIT 5",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "entityType": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "createdAt": row.get::<_, String>(3)?,
                "warningCode": row.get::<_, Option<String>>(4)?,
            }))
        }) {
            for row in rows.flatten() {
                recent_jobs.push(row);
            }
        }
    }

    // Unrestricted waiting aggregate, deliberately NOT derived from the five-row
    // `recentJobs` window above. On a till with two printers a job can stay stuck
    // on one while newer jobs keep completing through the other, pushing the
    // stalled one out of that window — and with it, any alert that reads only
    // `recentJobs`. The stall detector needs the whole queue, not the newest few.
    // A read that fails is `null` (not read), never `count: 0` (nothing waits).
    let pending_jobs = match read_print_queue_waiting(conn) {
        Ok(waiting) => json!({
            "count": waiting.count,
            "oldestCreatedAt": waiting.oldest_created_at,
            "pausedCount": waiting.paused_count,
        }),
        Err(error) => {
            warn!(error = %error, "Failed to read the print queue for system health");
            Value::Null
        }
    };

    json!({
        "configured": profile_count > 0,
        "profileCount": profile_count,
        "defaultProfile": serde_json::Value::Null,
        "recentJobs": recent_jobs,
        "pendingJobs": pending_jobs,
    })
}

/// The print jobs `printerStatus.pendingJobs` reports (the key keeps its old
/// name so older readers still parse it).
#[derive(Debug, Clone, PartialEq, Eq)]
struct PrintQueueWaiting {
    /// Jobs waiting to print that nothing is holding on purpose.
    count: i64,
    /// When the oldest of them was queued; the Health view and the
    /// `printer.jobs_not_printing` incident age it.
    oldest_created_at: Option<String>,
    /// Jobs held by a pause (evidence only; they never count as stalled).
    paused_count: i64,
}

/// Jobs still waiting to print over the whole queue, for the Health view's
/// "receipts are not printing" rule and the support incident.
///
/// - `pending` and `printing`. The worker marks a job `printing` when it takes
///   it, and `recover_stale_printing_jobs` fails one left there after 30 s
///   unless an attempt still holds it (a spooler job the printer never took),
///   so a `printing` job minutes old is stuck, not slow. Both are aged from
///   `created_at`, like Android's queue (`PrintQueueService.getWaitingJobSummary`):
///   the receipt has been owed since then.
/// - Jobs held by a pause are left out: the whole queue (`queue_paused`) or
///   the job's printer (`queue_paused_profile::<id>`), the rule the dispatcher
///   (`select_ready_pending_jobs`), the stale-job sweep and the print queue
///   screen's `paused` flag use. Someone paused them on purpose, so they are
///   not "not printing"; they are counted in `paused_count`.
fn read_print_queue_waiting(conn: &rusqlite::Connection) -> Result<PrintQueueWaiting, String> {
    const WAITING: &str = "status IN ('pending', 'printing')";
    let waiting_total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM print_jobs WHERE {WAITING}"),
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("count waiting print jobs: {error}"))?;

    if crate::print::is_print_queue_paused_with_conn(conn, None) {
        return Ok(PrintQueueWaiting {
            count: 0,
            oldest_created_at: None,
            paused_count: waiting_total,
        });
    }

    let mut paused_profiles: Vec<String> = crate::print::paused_printer_profiles(conn)
        .into_iter()
        .collect();
    paused_profiles.sort();
    let mut sql = format!("SELECT COUNT(*), MIN(created_at) FROM print_jobs WHERE {WAITING}");
    if !paused_profiles.is_empty() {
        let placeholders = (1..=paused_profiles.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(
            " AND (printer_profile_id IS NULL OR printer_profile_id NOT IN ({placeholders}))"
        ));
    }
    let (count, oldest_created_at) = conn
        .query_row(
            &sql,
            rusqlite::params_from_iter(paused_profiles.iter()),
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .map_err(|error| format!("read waiting print jobs: {error}"))?;

    Ok(PrintQueueWaiting {
        count,
        oldest_created_at,
        paused_count: (waiting_total - count).max(0),
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
    export_diagnostics_bundle(db, output_dir, export_options, None)
}

/// Format name and version written to `diagnostics_manifest.json`, shared
/// with the Android bundle (`thesmall-pos-diagnostics-v2`).
pub const DIAGNOSTICS_FORMAT: &str = "thesmall-pos-diagnostics-v2";
pub const DIAGNOSTICS_FORMAT_VERSION: u32 = 2;
pub const DIAGNOSTICS_MANIFEST_FILE: &str = "diagnostics_manifest.json";
pub const HEALTH_VIEW_FILE: &str = "health_view.json";
/// A Health view snapshot larger than this is not embedded.
const MAX_HEALTH_VIEW_BYTES: usize = 256 * 1024;

/// One collector's outcome, as the manifest records it.
struct CollectorRecord {
    file: &'static str,
    status: &'static str,
    duration_ms: u128,
    error: Option<String>,
}

/// Run one collector. A collector that fails writes `{ status:
/// "unavailable", error }` and the export goes on: an empty value must never
/// stand in for "healthy", and one broken table must not cost support the
/// other files.
fn run_collector(
    records: &mut Vec<CollectorRecord>,
    file: &'static str,
    collect: impl FnOnce() -> Result<Value, String>,
) -> Value {
    let started = std::time::Instant::now();
    let (value, status, error) = match collect() {
        Ok(value) => {
            let status = match value.get("status").and_then(Value::as_str) {
                Some("not_collected") => "not_collected",
                Some("unavailable") => "unavailable",
                _ => "ok",
            };
            (value, status, None)
        }
        Err(error) => {
            let error = crate::print::safe_operational_error(Some(error), 512)
                .unwrap_or_else(|| "collector failed".to_string());
            (
                json!({ "status": "unavailable", "error": error }),
                "unavailable",
                Some(error),
            )
        }
    };
    records.push(CollectorRecord {
        file,
        status,
        duration_ms: started.elapsed().as_millis(),
        error,
    });
    value
}

/// What the operator saw in the Health view when the export was started:
/// the renderer's snapshot (shared `buildHealthView`,
/// `thesmall-pos-health-view-v1`) is the file itself, as in the Android
/// bundle; `not_collected` when it sent none.
fn health_view_document(health_view: Option<Value>) -> Result<Value, String> {
    let Some(view) = health_view.filter(Value::is_object) else {
        return Ok(json!({
            "status": "not_collected",
            "reason": "the export was not started from the Health view",
        }));
    };
    let encoded_len = serde_json::to_vec(&view)
        .map(|bytes| bytes.len())
        .unwrap_or(0);
    if encoded_len > MAX_HEALTH_VIEW_BYTES {
        return Ok(json!({
            "status": "unavailable",
            "reason": "health view snapshot too large",
            "bytes": encoded_len,
        }));
    }
    Ok(view)
}

/// Collects diagnostics data and writes a zip file to the given directory,
/// with the Health view the operator saw (`health_view.json`) when the
/// renderer sends it. Returns the path to the zip file.
pub fn export_diagnostics_bundle(
    db: &DbState,
    output_dir: &Path,
    export_options: DiagnosticsExportOptions,
    health_view: Option<Value>,
) -> Result<String, String> {
    let export_started = std::time::Instant::now();
    let generated_at = chrono::Utc::now();
    let timestamp = generated_at.format("%Y%m%d_%H%M%S").to_string();
    let zip_name = format!("thesmall-pos-diagnostics-{timestamp}.zip");
    let zip_path = output_dir.join(&zip_name);

    let file = fs::File::create(&zip_path)
        .map_err(|e| format!("Failed to create diagnostics zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);

    let zip_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    // Redaction is always on (see DiagnosticsExportOptions::redact_sensitive).
    let _ = export_options.redact_sensitive;
    let source = health_view_source(health_view.as_ref());
    let mut records: Vec<CollectorRecord> = Vec::new();
    let mut documents: Vec<(&'static str, Value)> = Vec::new();

    // 1. About info
    let about = run_collector(&mut records, "about.json", || Ok(get_about_info()));
    documents.push(("about.json", about));

    // 2. System identity + runtime state. Each helper takes the DB mutex
    // itself (std::sync::Mutex is not reentrant).
    let health = run_collector(&mut records, "system_health.json", || get_system_health(db));
    documents.push(("system_health.json", health));
    let terminal_context = run_collector(&mut records, "terminal_context.json", || {
        Ok(get_terminal_context(db))
    });
    // The closeout evidence is about this terminal's branch, as the terminal
    // context names it (local settings first).
    let closeout_payload = match terminal_context
        .get("branchId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|branch_id| !branch_id.is_empty())
    {
        Some(branch_id) => json!({ "branchId": branch_id }),
        None => json!({}),
    };
    documents.push(("terminal_context.json", terminal_context));
    let sync_status = run_collector(&mut records, "sync_status.json", || {
        get_sync_status_summary(db)
    });
    documents.push(("sync_status.json", sync_status));
    let closeout_readiness = run_collector(&mut records, "closeout_readiness.json", || {
        crate::zreport::get_closeout_readiness_snapshot(db, &closeout_payload)
    });
    documents.push(("closeout_readiness.json", closeout_readiness));
    let terminal_settings_snapshot =
        run_collector(&mut records, "terminal_settings_snapshot.json", || {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            get_terminal_settings_snapshot(&conn)
        });
    documents.push((
        "terminal_settings_snapshot.json",
        terminal_settings_snapshot,
    ));
    let parity_queue_status = run_collector(&mut records, "parity_queue_status.json", || {
        get_parity_queue_status(db)
    });
    documents.push(("parity_queue_status.json", parity_queue_status));
    let parity_actionable_items =
        run_collector(&mut records, "parity_actionable_items.json", || {
            get_parity_actionable_items(db, 50)
        });
    documents.push(("parity_actionable_items.json", parity_actionable_items));
    let parity_failure_families =
        run_collector(&mut records, "parity_failure_families.json", || {
            get_parity_failure_families(db)
        });
    documents.push(("parity_failure_families.json", parity_failure_families));
    let financial_queue_status = run_collector(&mut records, "financial_queue_status.json", || {
        get_financial_queue_status(db)
    });
    documents.push(("financial_queue_status.json", financial_queue_status));
    let financial_queue_items = run_collector(&mut records, "financial_queue_items.json", || {
        crate::commands::sync::query_financial_queue_items(50, db)
    });
    documents.push(("financial_queue_items.json", financial_queue_items));
    let financial_integrity = run_collector(&mut records, "financial_integrity.json", || {
        crate::commands::sync::collect_financial_integrity(db)
    });
    documents.push(("financial_integrity.json", financial_integrity));
    let last_parity_sync = run_collector(&mut records, "last_parity_sync.json", || {
        Ok(get_last_parity_sync(db))
    });
    documents.push(("last_parity_sync.json", last_parity_sync));
    let credential_state = run_collector(&mut records, "credential_state.json", || {
        Ok(get_credential_state(db))
    });
    documents.push(("credential_state.json", credential_state));

    // 3. Queue/backlog snapshots
    let backlog = run_collector(&mut records, "sync_backlog.json", || {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        get_sync_backlog(&conn)
    });
    documents.push(("sync_backlog.json", backlog));
    let payment_adjustment_backlog =
        run_collector(&mut records, "payment_adjustment_backlog.json", || {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            Ok(get_payment_adjustment_backlog(&conn))
        });
    documents.push((
        "payment_adjustment_backlog.json",
        payment_adjustment_backlog,
    ));
    let sync_blocker_details = run_collector(&mut records, "sync_blocker_details.json", || {
        Ok(get_sync_blocker_details_json(
            crate::sync::get_sync_blocker_details(db, 25)?,
            get_parity_blocker_details(db, 25),
        ))
    });
    documents.push(("sync_blocker_details.json", sync_blocker_details));

    // 4. Recent operational history
    let errors = run_collector(&mut records, "sync_errors.json", || {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        Ok(json!(get_recent_sync_errors(&conn, 20)?))
    });
    documents.push(("sync_errors.json", errors));
    let printers = run_collector(&mut records, "printer_diagnostics.json", || {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        get_printer_diagnostics(&conn)
    });
    documents.push(("printer_diagnostics.json", printers));

    // 5. What the operator saw in the Health view (bundle v2).
    let health_view = run_collector(&mut records, HEALTH_VIEW_FILE, || {
        health_view_document(health_view)
    });
    documents.push((HEALTH_VIEW_FILE, health_view));

    // Raw runtime logs can contain queue identifiers, tenant context and
    // encrypted repair envelopes emitted before field-level redaction. V1
    // renderer diagnostics therefore fail closed: `include_logs` remains in
    // the compatibility DTO, but no local export embeds raw log files.
    let mut write_errors: Vec<Value> = Vec::new();
    let mut truncated: Vec<String> = Vec::new();
    for (file_name, value) in documents {
        let value = redact_value_for_export(value, file_name, &mut truncated);
        if let Err(error) = write_json_to_zip(&mut zip, &zip_options, file_name, &value) {
            write_errors.push(json!({ "entry": file_name, "error": error }));
        }
    }

    // 6. The manifest last, so it can name every collector and timing. One
    // shape with the Android bundle: shared/pos/health/__fixtures__/
    // diagnostics-manifest-contract.json (the tests read it).
    let collectors: Vec<Value> = records
        .iter()
        .map(|record| {
            let mut collector = json!({
                "entry": record.file,
                "status": record.status,
                "durationMs": record.duration_ms,
            });
            if let Some(error) = &record.error {
                collector["error"] = json!(error);
            }
            collector
        })
        .collect();
    let collector_errors: Vec<Value> = records
        .iter()
        .filter_map(|record| {
            record
                .error
                .as_ref()
                .map(|error| json!({ "entry": record.file, "error": error }))
        })
        .chain(write_errors)
        .collect();
    let mut entries: Vec<&str> = records.iter().map(|record| record.file).collect();
    entries.push(DIAGNOSTICS_MANIFEST_FILE);
    let manifest = json!({
        "format": DIAGNOSTICS_FORMAT,
        "formatVersion": DIAGNOSTICS_FORMAT_VERSION,
        "platform": std::env::consts::OS,
        "source": source,
        "app": {
            "versionName": env!("CARGO_PKG_VERSION"),
            "versionCode": Value::Null,
            "packageName": Value::Null,
            "buildTimestamp": env!("BUILD_TIMESTAMP"),
            "gitSha": env!("BUILD_GIT_SHA"),
        },
        "arch": std::env::consts::ARCH,
        "generatedAt": generated_at.to_rfc3339(),
        "collectedInMs": export_started.elapsed().as_millis(),
        "redaction": {
            "enabled": true,
            "rules": DIAGNOSTICS_REDACTION_RULES,
        },
        "logsIncluded": false,
        "compression": "DEFLATE",
        "limits": {
            "listRows": MAX_EXPORT_LIST_ROWS,
            "stringChars": MAX_EXPORT_STRING_CHARS,
        },
        "entries": entries,
        "collectors": collectors,
        "errors": collector_errors,
        "truncated": truncated,
    });
    let mut manifest_truncated = Vec::new();
    write_json_to_zip(
        &mut zip,
        &zip_options,
        DIAGNOSTICS_MANIFEST_FILE,
        &redact_value_for_export(manifest, DIAGNOSTICS_MANIFEST_FILE, &mut manifest_truncated),
    )?;

    zip.finish().map_err(|e| e.to_string())?;

    Ok(zip_path.to_string_lossy().to_string())
}

/// The redaction rules a bundle names in its manifest, the same text as the
/// Android bundle's (`DIAGNOSTICS_REDACTION_RULES` in
/// shared/pos/health/diagnostics-bundle.ts).
const DIAGNOSTICS_REDACTION_RULES: &str = "desktop key list + email/phone scrub (v3: dates, times, canonical IPv4, versions, UUIDs and presence booleans kept; phone groups joined by any space; staff/customer names redacted; queue payloads summarized)";

/// Lists are capped at 50 rows in the bundle, as on Android
/// (`MAX_EXPORT_LIST_ROWS`).
const MAX_EXPORT_LIST_ROWS: usize = 50;

/// Where the export was started, from the Health view snapshot the renderer
/// sent (`health_modal`, ...); `unknown` without one.
fn health_view_source(health_view: Option<&Value>) -> String {
    health_view
        .and_then(|view| view.get("source"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|source| {
            !source.is_empty()
                && source.len() <= 40
                && source
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        })
        .unwrap_or("unknown")
        .to_string()
}

/// Cut lists to MAX_EXPORT_LIST_ROWS rows, recording `file: path (total N)`
/// for each list cut (the manifest's `truncated`, as on Android).
fn cap_export_lists(value: Value, file: &str, path: &str, truncated: &mut Vec<String>) -> Value {
    match value {
        Value::Array(items) => {
            let total = items.len();
            if total > MAX_EXPORT_LIST_ROWS {
                let shown = if path.is_empty() { "$" } else { path };
                truncated.push(format!("{file}: {shown} (total {total})"));
            }
            Value::Array(
                items
                    .into_iter()
                    .take(MAX_EXPORT_LIST_ROWS)
                    .enumerate()
                    .map(|(index, item)| {
                        cap_export_lists(item, file, &format!("{path}[{index}]"), truncated)
                    })
                    .collect(),
            )
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| {
                    let child = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    };
                    let item = cap_export_lists(item, file, &child, truncated);
                    (key, item)
                })
                .collect(),
        ),
        other => other,
    }
}

/// Every bundle file goes out capped and redacted; there is no unredacted
/// export.
fn redact_value_for_export(value: Value, file: &str, truncated: &mut Vec<String>) -> Value {
    redact_sensitive_fields(cap_export_lists(value, file, "", truncated))
}

pub(crate) fn redact_remote_diagnostics_value(value: Value) -> Value {
    redact_sensitive_fields(value)
}

#[allow(dead_code)]
pub fn export_remote_incident_bundle(db: &DbState, output_dir: &Path) -> Result<String, String> {
    export_diagnostics_with_options(
        db,
        output_dir,
        DiagnosticsExportOptions {
            include_logs: false,
            redact_sensitive: true,
        },
    )
}

// ---------------------------------------------------------------------------
// Redaction (bundle v2)
//
// One rule set with the Android bundle (POSSystemMobile
// `services/diagnostics/redaction.ts`, the TODO'd source of the shared
// `shared/pos/health` rules): the desktop key list and markers, emails and
// phone numbers scrubbed inside free text, with the fixes the health parity
// plan (§5) asks for:
// - ISO dates, times, IPv4 addresses, version strings, UUIDs, amounts and
//   ids stay readable (v1 turned `window.reportDate` and a printer IP into
//   [REDACTED_PHONE]);
// - presence booleans stay readable: a boolean or null can never carry a
//   secret (`apiKeyPresent`, `pin_reset_required: false`);
// - staff and customer names are redacted;
// - `pin` only matches as a whole key word, so `shipping` or `mapping` stay.
// ---------------------------------------------------------------------------

const REDACTED: &str = "[REDACTED]";
const REDACTED_EMAIL: &str = "[REDACTED_EMAIL]";
const REDACTED_PHONE: &str = "[REDACTED_PHONE]";
/// Free text is capped at 1 KB in the bundle, as on Android
/// (`MAX_EXPORT_STRING_CHARS` in `services/diagnostics/redaction.ts`).
const MAX_EXPORT_STRING_CHARS: usize = 1024;

fn digit_count(value: &str) -> usize {
    value.chars().filter(char::is_ascii_digit).count()
}

fn all_digits(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit())
}

fn is_uuid_token(token: &str) -> bool {
    token.len() == 36
        && token.char_indices().all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            _ => ch.is_ascii_hexdigit(),
        })
}

/// `YYYY-MM-DD`.
fn is_iso_date_token(token: &str) -> bool {
    let parts: Vec<&str> = token.split('-').collect();
    parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts.iter().all(|part| all_digits(part))
}

/// `D/M/YY`, `DD.MM.YYYY`, `DD-MM-YYYY` ... (one separator kind or mixed, as
/// the Android rule accepts).
fn is_day_first_date_token(token: &str) -> bool {
    let parts: Vec<&str> = token.split(['/', '.', '-']).collect();
    parts.len() == 3
        && (1..=2).contains(&parts[0].len())
        && (1..=2).contains(&parts[1].len())
        && (2..=4).contains(&parts[2].len())
        && parts.iter().all(|part| all_digits(part))
}

/// `YYYY/M/D`, `YYYY.MM.DD`.
fn is_year_first_date_token(token: &str) -> bool {
    let parts: Vec<&str> = token.split(['/', '.']).collect();
    parts.len() == 3
        && parts[0].len() == 4
        && (1..=2).contains(&parts[1].len())
        && (1..=2).contains(&parts[2].len())
        && parts.iter().all(|part| all_digits(part))
}

/// A dotted quad in canonical form: an octet with a leading zero
/// ("079.123.45.67") makes it a phone number, not an address.
fn is_ipv4_token(token: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            (1..=3).contains(&part.len())
                && all_digits(part)
                && (part.len() == 1 || !part.starts_with('0'))
                && part.parse::<u16>().is_ok_and(|octet| octet <= 255)
        })
}

/// `v1.4.119`, `1.0.13`, `10.0.2622`, `126.0.6478.127` is not (major > 2 digits).
fn is_version_token(token: &str) -> bool {
    let body = token.strip_prefix(['v', 'V']).unwrap_or(token);
    let parts: Vec<&str> = body.split('.').collect();
    if !(3..=4).contains(&parts.len()) || !parts.iter().all(|part| all_digits(part)) {
        return false;
    }
    (1..=2).contains(&parts[0].len())
        && (1..=4).contains(&parts[1].len())
        && (1..=4).contains(&parts[2].len())
        && parts
            .get(3)
            .is_none_or(|part| (1..=9).contains(&part.len()))
}

/// `-12.50`, `221.5`.
fn is_decimal_amount_token(token: &str) -> bool {
    let body = token.strip_prefix('-').unwrap_or(token);
    let Some((whole, fraction)) = body.split_once('.') else {
        return false;
    };
    (1..=9).contains(&whole.len())
        && (1..=2).contains(&fraction.len())
        && all_digits(whole)
        && all_digits(fraction)
}

/// Digit-heavy tokens that are not phone numbers and must stay readable.
fn is_readable_numeric_token(token: &str) -> bool {
    is_uuid_token(token)
        || is_iso_date_token(token)
        || is_day_first_date_token(token)
        || is_year_first_date_token(token)
        || is_ipv4_token(token)
        || is_version_token(token)
        || is_decimal_amount_token(token)
}

fn is_phone_shaped(token: &str) -> bool {
    !token.is_empty()
        && token
            .chars()
            .all(|ch| ch.is_ascii_digit() || matches!(ch, '+' | '-' | '(' | ')' | '.' | '/'))
}

/// `local@domain.tld` anywhere in the token.
fn contains_email(token: &str) -> bool {
    token.match_indices('@').any(|(at, _)| {
        let before_ok = token[..at]
            .chars()
            .next_back()
            .is_some_and(|ch| ch != '@' && !ch.is_whitespace());
        let domain = token[at + 1..].split('@').next().unwrap_or_default();
        let dot_ok = domain
            .char_indices()
            .any(|(index, ch)| ch == '.' && index > 0 && index + 1 < domain.len());
        before_ok && dot_ok
    })
}

/// A URL keeps its origin and path; the query can carry tokens.
fn scrub_url_query(token: &str) -> String {
    match token.find(['?', '#']) {
        Some(index) => format!("{}?{REDACTED}", &token[..index]),
        None => token.to_string(),
    }
}

fn scrub_token(token: &str) -> String {
    // Too short for a URL or 8 digits, and no '@': nothing to find.
    if token.chars().nth(7).is_none() && !token.contains('@') {
        return token.to_string();
    }
    let core_start = token
        .find(|ch: char| !matches!(ch, '(' | '"' | '\'' | '[' | '{' | '<' | ',' | ';'))
        .unwrap_or(token.len());
    let prefix = &token[..core_start];
    let rest = &token[core_start..];
    let core_end = rest
        .rfind(|ch: char| {
            !matches!(
                ch,
                ')' | '"' | '\'' | ']' | '}' | '>' | ',' | ';' | ':' | '!' | '?' | '.'
            )
        })
        .map(|index| index + rest[index..].chars().next().map_or(1, char::len_utf8))
        .unwrap_or(0);
    let core = &rest[..core_end];
    let suffix = &rest[core_end..];
    if core.is_empty() {
        return token.to_string();
    }
    let lower = core.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return format!("{prefix}{}{suffix}", scrub_url_query(core));
    }
    if core.contains('@') && contains_email(core) {
        return format!("{prefix}{REDACTED_EMAIL}{suffix}");
    }
    if is_phone_shaped(core) && digit_count(core) >= 8 && !is_readable_numeric_token(core) {
        return format!("{prefix}{REDACTED_PHONE}{suffix}");
    }
    token.to_string()
}

/// Separator spaces: Unicode White_Space plus the zero-width separators
/// U+200B to U+200D, U+2060 and U+FEFF, the same set as the Android
/// `isSeparatorSpace` (shared/pos/health/diagnostics-redaction.ts). Text is
/// split into tokens on them and phone number groups join across them, so a
/// phone written with non-breaking spaces, narrow spaces, tabs or a
/// byte-order mark between its groups is still one number.
fn is_separator_space(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch as u32, 0x200B..=0x200D | 0x2060 | 0xFEFF)
}

/// Whole tokens (between separator spaces): emails, phone-shaped tokens, URL
/// queries. Separators are kept as they are.
fn scrub_tokens(chars: &[char]) -> String {
    let mut output = String::with_capacity(chars.len());
    let mut token = String::new();
    for &ch in chars {
        if is_separator_space(ch) {
            if !token.is_empty() {
                output.push_str(&scrub_token(&token));
                token.clear();
            }
            output.push(ch);
        } else {
            token.push(ch);
        }
    }
    if !token.is_empty() {
        output.push_str(&scrub_token(&token));
    }
    output
}

// Phone numbers the single-token rule cannot see: split into groups
// ("+41 79 123 45 67", "2310 123456", groups joined by any separator space),
// with a trunk prefix ("+41 (0)79 123 45 67"), or glued to a label
// ("τηλ:6941234567", "phone=6941234567", "tel:+306941234567", Postgres
// "Key (phone)=(...)"). One character scanner, the same rules as the Android
// bundle (shared/pos/health/diagnostics-redaction.ts scrubPhoneRuns); the
// shared vectors pin both.
//
// A run starts at a digit, a '+' before a digit or a "(0)"-style trunk group,
// right after the start of the text, a separator space, one of ([{<"',;=: or
// a '.' that ends a word ("τηλ.6941..."). It is one or more chunks joined by
// single separator spaces; a chunk is digit groups joined by '-', '.' or '/'
// (or a trunk group followed directly by digits), at most 32 characters. It
// must end at the end of the text, a separator space, one of )]}>"',; or
// .!?: before a separator space or the end.
// - one chunk: at least 8 digits and not a readable token (date, IPv4,
//   version, amount, UUID), unless a phone label comes right before it;
// - several chunks: 10 to 15 digits, 2+ digits each (a leading '+' chunk may
//   have 1). After a "+CC" chunk or a phone label, chunks may be dotted and
//   hold up to 12 digits, and nothing is exempt as readable; otherwise every
//   chunk is digits and '-' only, 8 digits at most, and not readable.
// The longest valid run wins; a run that ends inside a longer token (an ISO
// time "03:24:37.5588+00:00", "192.168.1.19:9100") is left alone. Collection
// stops at 8 chunks or once 15 digits are passed, so the scan stays linear.
// When the text was cut (scan_window), a run that reaches the cut is redacted
// up to it: the rest of the number is unknown.

const RUN_LEFT_BOUNDARY: &[char] = &['(', '[', '{', '<', '"', '\'', ',', ';', '=', ':'];
const RUN_RIGHT_BOUNDARY: &[char] = &[')', ']', '}', '>', '"', '\'', ',', ';'];
const RUN_SENTENCE_END: &[char] = &['.', '!', '?', ':'];
const RUN_GROUP_SEPARATOR: &[char] = &['-', '.', '/'];
const MAX_TRUNK_DIGITS: usize = 4;
/// A chunk longer than this is an id or a hash, not a phone number.
const MAX_CHUNK_CHARS: usize = 32;
const MAX_RUN_CHUNKS: usize = 8;
const MAX_RUN_DIGITS: usize = 15;
/// How far past a chunk the scanner looks: a separator and a "(1234)" trunk group.
const RUN_LOOKAHEAD: usize = 8;
/// What may sit between a phone label and its number: "τηλ: ", "(phone)=(".
const LABEL_GAP: &[char] = &[':', '=', '(', ')', '[', ']', '.', '-', '"', '\'', '#'];
const MAX_LABEL_GAP: usize = 4;
const MAX_LABEL_LETTERS: usize = 16;
/// Words that say the number after them is a phone number (lower case).
const PHONE_LABELS: &[&str] = &[
    "phone",
    "phones",
    "telephone",
    "tel",
    "tél",
    "tele",
    "telefon",
    "telefono",
    "teléfono",
    "telefone",
    "téléphone",
    "mobile",
    "mobil",
    "mob",
    "cell",
    "cellphone",
    "cellulare",
    "celular",
    "cel",
    "handy",
    "natel",
    "portable",
    "fax",
    "whatsapp",
    "viber",
    "msisdn",
    "τηλ",
    "τηλέφωνο",
    "τηλεφωνο",
    "κιν",
    "κινητό",
    "κινητο",
    "φαξ",
];

fn digit_at(chars: &[char], index: usize) -> bool {
    chars.get(index).is_some_and(char::is_ascii_digit)
}

/// Length of a "(0)" trunk group at `index`, or 0.
fn trunk_group_len(chars: &[char], index: usize) -> usize {
    if chars.get(index) != Some(&'(') {
        return 0;
    }
    let mut cursor = index + 1;
    while cursor < chars.len()
        && chars[cursor].is_ascii_digit()
        && cursor - index - 1 < MAX_TRUNK_DIGITS
    {
        cursor += 1;
    }
    let digits = cursor - index - 1;
    if digits >= 1 && chars.get(cursor) == Some(&')') {
        digits + 2
    } else {
        0
    }
}

struct PhoneChunk {
    start: usize,
    end: usize,
    digits: usize,
    groups: usize,
    /// Digits, '-' and trunk groups only (no '.' or '/').
    plain: bool,
    /// Nothing but digits: no readable token can look like that.
    digits_only: bool,
    leading_plus: bool,
}

fn parse_phone_chunk(chars: &[char], start: usize, allow_plus: bool) -> Option<PhoneChunk> {
    let mut cursor = start;
    let mut leading_plus = false;
    if allow_plus && chars.get(cursor) == Some(&'+') && digit_at(chars, cursor + 1) {
        leading_plus = true;
        cursor += 1;
    }
    let mut digits = 0;
    let mut groups = 0;
    let mut plain = true;
    let mut digits_only = !leading_plus;
    loop {
        let mut after_trunk = false;
        if digit_at(chars, cursor) {
            while digit_at(chars, cursor) {
                digits += 1;
                cursor += 1;
                if cursor - start > MAX_CHUNK_CHARS {
                    return None;
                }
            }
        } else {
            let trunk = trunk_group_len(chars, cursor);
            if trunk == 0 {
                break;
            }
            digits += trunk - 2;
            cursor += trunk;
            after_trunk = true;
            digits_only = false;
        }
        groups += 1;
        if cursor - start > MAX_CHUNK_CHARS {
            return None;
        }
        // "(0)79": digits straight after a trunk group.
        if after_trunk && digit_at(chars, cursor) {
            continue;
        }
        match chars.get(cursor) {
            Some(separator)
                if RUN_GROUP_SEPARATOR.contains(separator)
                    && (digit_at(chars, cursor + 1) || trunk_group_len(chars, cursor + 1) > 0) =>
            {
                if *separator != '-' {
                    plain = false;
                }
                digits_only = false;
                cursor += 1;
            }
            _ => break,
        }
    }
    (groups > 0).then_some(PhoneChunk {
        start,
        end: cursor,
        digits,
        groups,
        plain,
        digits_only,
        leading_plus,
    })
}

fn phone_run_can_start(chars: &[char], index: usize) -> bool {
    let character = chars[index];
    let starts_run = character.is_ascii_digit()
        || (character == '+' && digit_at(chars, index + 1))
        || trunk_group_len(chars, index) > 0;
    if !starts_run {
        return false;
    }
    if index == 0 {
        return true;
    }
    let previous = chars[index - 1];
    is_separator_space(previous)
        || RUN_LEFT_BOUNDARY.contains(&previous)
        || (previous == '.' && index >= 2 && chars[index - 2].is_alphabetic())
}

fn phone_run_can_end(chars: &[char], end: usize) -> bool {
    let Some(&next) = chars.get(end) else {
        return true;
    };
    if is_separator_space(next) || RUN_RIGHT_BOUNDARY.contains(&next) {
        return true;
    }
    RUN_SENTENCE_END.contains(&next)
        && chars
            .get(end + 1)
            .is_none_or(|&after| is_separator_space(after))
}

/// Whether a phone label ("τηλ:", "phone=", "(phone)=(", "tel ") ends right
/// before `start`.
fn preceded_by_phone_label(chars: &[char], start: usize) -> bool {
    let mut cursor = start;
    let mut gap = 0;
    while cursor > 0
        && gap < MAX_LABEL_GAP
        && (is_separator_space(chars[cursor - 1]) || LABEL_GAP.contains(&chars[cursor - 1]))
    {
        cursor -= 1;
        gap += 1;
    }
    let word_end = cursor;
    while cursor > 0 && word_end - cursor < MAX_LABEL_LETTERS && chars[cursor - 1].is_alphabetic() {
        cursor -= 1;
    }
    if cursor == word_end {
        return false;
    }
    let word = chars[cursor..word_end]
        .iter()
        .collect::<String>()
        .to_lowercase();
    PHONE_LABELS.contains(&word.as_str())
}

/// End (exclusive) of the phone number starting at `start`. `cut`: the text
/// was cut after its last token, so a run that reaches the end is redacted up
/// to it (the number may go on past the cut).
fn match_phone_run(chars: &[char], start: usize, cut: bool) -> Option<usize> {
    let first = parse_phone_chunk(chars, start, true)?;
    // Too few digits to stand alone (8) or to begin a longer number (2, or 1 after '+').
    if first.digits < 2 && !first.leading_plus {
        return None;
    }
    let labelled = preceded_by_phone_label(chars, start);
    // A "+CC" first chunk is a country code: what follows is a phone number.
    let strong = labelled || (first.leading_plus && first.groups == 1 && first.digits <= 4);
    let readable = |chunk: &PhoneChunk| {
        !chunk.digits_only
            && is_readable_numeric_token(&chars[chunk.start..chunk.end].iter().collect::<String>())
    };
    // Whether a chunk can be part of a number of several chunks.
    let joinable = |chunk: &PhoneChunk, index: usize| {
        let minimum = if index == 0 && chunk.leading_plus {
            1
        } else {
            2
        };
        if chunk.digits < minimum {
            return false;
        }
        if strong {
            return chunk.digits <= 12;
        }
        chunk.plain && chunk.digits <= 8 && !readable(chunk)
    };

    // Collect the chunks that can join (every longer run would fail).
    let first_end = first.end;
    let first_digits = first.digits;
    let first_joinable = joinable(&first, 0);
    let mut totals = vec![first.digits];
    let mut chunks = vec![first];
    if first_joinable {
        let mut cursor = first_end;
        while chunks.len() < MAX_RUN_CHUNKS
            && totals[totals.len() - 1] <= MAX_RUN_DIGITS
            && chars.get(cursor).is_some_and(|&ch| is_separator_space(ch))
        {
            let Some(next) = parse_phone_chunk(chars, cursor + 1, false) else {
                break;
            };
            if !joinable(&next, chunks.len()) {
                break;
            }
            cursor = next.end;
            totals.push(totals[totals.len() - 1] + next.digits);
            chunks.push(next);
        }
        if cut && cursor + RUN_LOOKAHEAD >= chars.len() {
            return Some(chars.len());
        }
    }

    for count in (2..=chunks.len()).rev() {
        let total = totals[count - 1];
        let end = chunks[count - 1].end;
        if (10..=MAX_RUN_DIGITS).contains(&total) && phone_run_can_end(chars, end) {
            return Some(end);
        }
    }
    (first_digits >= 8
        && phone_run_can_end(chars, first_end)
        && (labelled || !readable(&chunks[0])))
    .then_some(first_end)
}

fn scrub_phone_runs(value: &str, cut: bool) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if phone_run_can_start(&chars, index) {
            if let Some(end) = match_phone_run(&chars, index, cut) {
                output.push_str(REDACTED_PHONE);
                index = end;
                continue;
            }
        }
        output.push(chars[index]);
        index += 1;
    }
    output
}

/// Characters scanned past the cap. A phone number the scanner collects spans
/// at most 8 chunks of 32 characters (263), so every number that reaches into
/// the first `max_chars` characters is read whole.
const SCAN_MARGIN: usize = 320;
/// A token the scan cap falls in is read to its end (an email anywhere in a
/// token hides the whole token), but no further than `max_chars` times this.
const MAX_TOKEN_READ_FACTOR: usize = 8;

/// The part of the text that is scanned (Android `scanWindow`): the first
/// `max_chars` + SCAN_MARGIN characters, finished to the end of the token the
/// cap falls in. A token longer than the read limit is dropped whole: no rule
/// can judge a token it cannot see the end of. The flag says text was dropped.
fn scan_window(value: &str, max_chars: usize) -> (Vec<char>, bool) {
    let limit = max_chars.saturating_add(SCAN_MARGIN);
    let read_limit = limit.max(max_chars.saturating_mul(MAX_TOKEN_READ_FACTOR));
    let mut all: Vec<char> = value.chars().take(read_limit.saturating_add(1)).collect();
    let more = all.len() > read_limit;
    all.truncate(read_limit);
    if all.len() <= limit && !more {
        return (all, false);
    }
    let mut end = limit.min(all.len());
    if end > 0 && !is_separator_space(all[end - 1]) {
        while end < all.len() && !is_separator_space(all[end]) {
            end += 1;
        }
    }
    if end == all.len() {
        if !more {
            return (all, false);
        }
        while end > 0 && !is_separator_space(all[end - 1]) {
            end -= 1;
        }
    }
    all.truncate(end);
    (all, true)
}

/// At most `max_chars` characters; '…' marks text that was cut.
fn cap_export_text(value: String, max_chars: usize, cut: bool) -> String {
    let mut rest = value.chars();
    let head: String = rest.by_ref().take(max_chars).collect();
    if rest.next().is_none() && !cut {
        return value;
    }
    format!("{head}…")
}

/// Replace emails and phone numbers inside free text: whole tokens first
/// (emails, phone-shaped tokens, URL queries), then phone numbers the tokens
/// hide (spaced groups, trunk prefixes, labels such as "τηλ:" or "phone=").
/// Dates, times, IPv4 addresses, versions, UUIDs, amounts and ids stay
/// readable, whitespace is kept, URL query strings are dropped because they
/// can carry tokens. Capped at 1 KB.
fn scrub_sensitive_string(value: &str) -> String {
    scrub_sensitive_string_with_limit(value, MAX_EXPORT_STRING_CHARS)
}

/// Text bounded for an operator or for support that never keeps part of an
/// email or a phone number (review 30/09/2026: operational errors were cut
/// at 512 or 1024 characters before the export scrubbed them, and a number
/// the cut fell in kept up to nine digits). The text is scrubbed first with
/// the export rules, which read the whole number or email the bound falls in
/// (scan_window), then cut to `max_chars` characters, the last one being '…'
/// when text was dropped. print::safe_operational_error and every other
/// bounded text that reaches the bundle go through here.
pub(crate) fn scrub_and_bound_text(value: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let scrubbed = scrub_sensitive_string_with_limit(value, max_chars);
    if scrubbed.chars().count() <= max_chars {
        return scrubbed;
    }
    // Cut: the '…' takes the last place. What is dropped is already scrubbed.
    let mut bounded: String = scrubbed.chars().take(max_chars - 1).collect();
    bounded.push('…');
    bounded
}

/// `scrub_sensitive_string` with another cap. Only about the first
/// `max_chars` characters are scanned (scan_window): a stored message can be
/// any size and every string of the bundle passes here.
fn scrub_sensitive_string_with_limit(value: &str, max_chars: usize) -> String {
    let (chars, cut) = scan_window(value, max_chars);
    let tokens_scrubbed = scrub_tokens(&chars);
    cap_export_text(scrub_phone_runs(&tokens_scrubbed, cut), max_chars, cut)
}

fn redact_sensitive_fields(value: Value) -> Value {
    redact_value(value, None)
}

fn redact_value(value: Value, parent_key: Option<&str>) -> Value {
    match value {
        Value::Object(map) => {
            let mut redacted = serde_json::Map::new();
            for (key, value) in map {
                if should_redact_key_for(&key, &value, parent_key) {
                    redacted.insert(key, Value::String(REDACTED.to_string()));
                } else {
                    let child = redact_value(value, Some(&key));
                    redacted.insert(key, child);
                }
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| redact_value(item, parent_key))
                .collect(),
        ),
        Value::String(value) => Value::String(scrub_sensitive_string(&value)),
        other => other,
    }
}

/// Whether a key's value is replaced by [REDACTED], whatever it holds.
#[cfg(test)]
fn should_redact_key(key: &str) -> bool {
    should_redact_key_for(key, &Value::String(String::new()), None)
}

const SENSITIVE_EXACT_KEYS: &[&str] = &[
    "auth",
    "access_token",
    "refresh_token",
    "customer_name",
    "customername",
    "customer_phone",
    "customerphone",
    "customer_email",
    "customeremail",
    "phone",
    "email",
    "address",
    "street_address",
    "streetaddress",
    "delivery_address",
    "deliveryaddress",
    "customer_address",
    "customeraddress",
    "billing_address",
    "billingaddress",
    "shipping_address",
    "shippingaddress",
    "delivery_notes",
    "deliverynotes",
    "note",
    "notes",
    "payment_ref",
    "paymentref",
    "payment_reference",
    "transaction_ref",
    "transactionref",
    "payload",
    "raw_payload",
    "rawpayload",
    "raw",
    "data",
    "body",
    "headers",
    "card_number",
    "cardnumber",
    "output_path",
    "outputpath",
    "document_snapshot_zlib",
    "document_snapshot_sha256",
    "render_profile_snapshot_json",
    "logo_data",
    "logodata",
];

/// Substrings that make a key secret (`pin` is matched as a word below).
const SENSITIVE_KEY_MARKERS: &[&str] = &[
    "api_key",
    "apikey",
    "api-key",
    "secret",
    "password",
    "passwd",
    "passcode",
    "private_key",
    "privatekey",
    "token",
    "bearer",
    "authorization",
    "cookie",
    "snapshot",
    "envelope",
    "logo_data",
    "logodata",
    "output_path",
    "outputpath",
];

const PIN_KEY_WORDS: &[&str] = &["pin", "pins", "pincode", "pinhash"];

/// Prefixes of `<prefix>_?name` keys that name a person.
const PERSONAL_NAME_PREFIXES: &[&str] = &[
    "customer",
    "staff",
    "driver",
    "cashier",
    "waiter",
    "guest",
    "contact",
    "first",
    "last",
    "full",
    "given",
    "family",
    "middle",
    "user",
    "employee",
    "recipient",
    "cardholder",
    "holder",
    "member",
    "person",
    "manager",
    "operator",
    "owner",
    "created_by",
    "updated_by",
    "checked_in_by",
];

/// Parent keys whose objects describe a person, so their `name` is personal.
const PERSON_CONTEXT_MARKERS: &[&str] = &[
    "customer",
    "staff",
    "driver",
    "cashier",
    "waiter",
    "guest",
    "contact",
    "employee",
    "recipient",
    "member",
    "person",
    "cardholder",
    "operator",
];

const GENERIC_NAME_KEYS: &[&str] = &[
    "name",
    "full_name",
    "fullname",
    "display_name",
    "displayname",
];

/// `staffPinHash` → [staff, pin, hash]; `pin_reset` → [pin, reset].
fn key_words(key: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(key.len() + 4);
    let mut previous: Option<char> = None;
    for ch in key.chars() {
        if ch.is_ascii_uppercase()
            && previous.is_some_and(|prev| prev.is_ascii_lowercase() || prev.is_ascii_digit())
        {
            spaced.push('_');
        }
        spaced.push(ch.to_ascii_lowercase());
        previous = Some(ch);
    }
    spaced
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(ToString::to_string)
        .collect()
}

/// `hasApiKey`, `is_active`, `apiKeyPresent`.
fn is_presence_key(key: &str) -> bool {
    let prefixed = ["has", "is"].iter().any(|prefix| {
        key.strip_prefix(prefix)
            .and_then(|rest| rest.chars().next())
            .is_some_and(|next| next.is_ascii_uppercase() || next == '_')
    });
    prefixed || key.to_ascii_lowercase().ends_with("present")
}

fn is_personal_name_key(normalized: &str) -> bool {
    let Some(prefix) = normalized.strip_suffix("name") else {
        return false;
    };
    let prefix = prefix.strip_suffix('_').unwrap_or(prefix);
    PERSONAL_NAME_PREFIXES.contains(&prefix)
}

fn should_redact_key_for(key: &str, value: &Value, parent_key: Option<&str>) -> bool {
    if value.is_boolean() || value.is_null() {
        return false;
    }
    let normalized = key.to_ascii_lowercase();
    if is_presence_key(key) || normalized == "payloadsummary" {
        return false;
    }
    if SENSITIVE_EXACT_KEYS.contains(&normalized.as_str())
        || normalized.ends_with("_payload")
        || normalized.ends_with("payload")
        || normalized.ends_with("_raw")
    {
        return true;
    }
    if SENSITIVE_KEY_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return true;
    }
    if key_words(key)
        .iter()
        .any(|word| PIN_KEY_WORDS.contains(&word.as_str()))
    {
        return true;
    }
    if normalized.contains("email") || normalized.contains("phone") {
        return true;
    }
    if is_personal_name_key(&normalized) {
        return true;
    }
    GENERIC_NAME_KEYS.contains(&normalized.as_str())
        && parent_key.is_some_and(|parent| {
            let parent = parent.to_ascii_lowercase();
            PERSON_CONTEXT_MARKERS
                .iter()
                .any(|marker| parent.contains(marker))
        })
}

/// Recent sync failures for the exported support bundle.
///
/// This used to read only the legacy `sync_queue`, so a terminal blocked on the
/// parity queue exported an empty `sync_errors.json` while `syncStatus.syncErrors`
/// counted 1 — the count and the evidence came from different tables. A shop
/// whose whole queue was stuck could therefore hand support a bundle that said
/// nothing was wrong. Both queues are read now, each row tagged with the queue it
/// came from, and parity conflicts are included explicitly: a manual conflict is
/// the one failure an operator cannot clear by waiting, so it is the one support
/// most needs to see.
/// The latest queue rows with an error, from both queues. A failed read is an
/// error, never an empty ("no errors") list (review 30/09/2026).
fn get_recent_sync_errors(conn: &rusqlite::Connection, limit: i64) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, entity_type, status, last_error, retry_count, created_at, updated_at
         FROM sync_queue
         WHERE last_error IS NOT NULL AND last_error != ''
         ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(|error| format!("sync_queue errors: {error}"))?;
    let mut errors = stmt
        .query_map(params![limit], |row| {
            Ok(json!({
                "queue": "sync_queue",
                "id": row.get::<_, String>(0)?,
                "entityType": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "lastError": crate::print::safe_operational_error(row.get(3)?, 1024),
                "retryCount": row.get::<_, i64>(4)?,
                "createdAt": row.get::<_, String>(5)?,
                "updatedAt": row.get::<_, Option<String>>(6)?,
            }))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|error| format!("sync_queue errors: {error}"))?;

    // Parity rows go through `renderer_list_actionable_items`, not raw SQL. That
    // accessor carries the repair-ownership exclusions, and native repair queue
    // data must never reach an exported bundle — a hand-written query here would
    // have to restate those rules and would leak the moment they changed.
    let items = crate::sync_queue::renderer_list_actionable_items(
        conn,
        &crate::sync_queue::QueueListQuery {
            limit: Some(limit),
            module_type: None,
        },
    )
    .map_err(|error| format!("parity queue errors: {error}"))?;
    for item in items
        .into_iter()
        .filter(|item| item.status == "conflict" || item.status == "failed")
    {
        errors.push(json!({
            "queue": "parity_sync_queue",
            "id": item.id,
            "entityType": item.module_type,
            "tableName": item.table_name,
            "status": item.status,
            // A conflict with no reason is itself the finding; say so rather
            // than exporting a null the reader has to interpret.
            "lastError": crate::print::safe_operational_error(item.error_message, 1024)
                .unwrap_or_else(|| "(no reason recorded)".to_string()),
            "retryCount": item.attempts,
            "createdAt": item.created_at,
            "updatedAt": item.last_attempt,
            "conflictStrategy": item.conflict_strategy,
            "operation": item.operation,
        }));
    }

    Ok(errors)
}

/// Printer names, targets and status texts for the bundle: scrubbed, then
/// bounded, so the cut never keeps part of an email or a phone number
/// (scrub_and_bound_text).
fn bounded_diagnostic_text(value: Option<String>, max_chars: usize) -> Option<String> {
    let value = value?;
    let cleaned: String = value
        .trim()
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .collect();
    let bounded = scrub_and_bound_text(&cleaned, max_chars);
    (!bounded.is_empty()).then_some(bounded)
}

fn get_printer_diagnostics(conn: &rusqlite::Connection) -> Result<Value, String> {
    let mut profile_statement = conn
        .prepare(
            "SELECT id, name, printer_name, driver_type, printer_type, role,
                    is_default, enabled, drawer_mode, created_at
             FROM printer_profiles ORDER BY is_default DESC, name",
        )
        .map_err(|error| format!("prepare printer profiles diagnostics: {error}"))?;
    let profiles = profile_statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": bounded_diagnostic_text(row.get(1)?, 160),
                "printerName": bounded_diagnostic_text(row.get(2)?, 256),
                "driverType": row.get::<_, String>(3)?,
                "printerType": row.get::<_, String>(4)?,
                "role": row.get::<_, String>(5)?,
                "isDefault": row.get::<_, bool>(6)?,
                "enabled": row.get::<_, bool>(7)?,
                "drawerMode": row.get::<_, Option<String>>(8)?,
                "createdAt": row.get::<_, String>(9)?,
            }))
        })
        .map_err(|error| format!("query printer profiles diagnostics: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read printer profiles diagnostics: {error}"))?;
    drop(profile_statement);

    // Parent queue history deliberately excludes entity identity/content,
    // immutable snapshot/envelope fields, and output paths.
    let mut jobs_statement = conn
        .prepare(
            "SELECT id, entity_type, status, printer_profile_id, retry_count,
                    warning_code, warning_message, last_error, created_at, last_attempt_at
             FROM print_jobs ORDER BY created_at DESC LIMIT 10",
        )
        .map_err(|error| format!("prepare print history diagnostics: {error}"))?;
    let recent_jobs = jobs_statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "entityType": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "printerProfileId": row.get::<_, Option<String>>(3)?,
                "retryCount": row.get::<_, i64>(4)?,
                "warningCode": row.get::<_, Option<String>>(5)?,
                "warningMessage": crate::print::safe_operational_error(row.get(6)?, 512),
                "lastError": crate::print::safe_operational_error(row.get(7)?, 1024),
                "createdAt": row.get::<_, String>(8)?,
                "lastAttemptAt": row.get::<_, Option<String>>(9)?,
            }))
        })
        .map_err(|error| format!("query print history diagnostics: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read print history diagnostics: {error}"))?;
    drop(jobs_statement);

    let mut attempts_statement = conn
        .prepare(
            "SELECT a.id, a.print_job_id, a.transport, a.resolved_target,
                    a.document_name, a.spool_job_id, a.state,
                    a.native_status_bits, a.native_status_text,
                    a.started_at, a.last_seen_at, a.completed_at,
                    a.cancel_requested_at, a.cancel_confirmed_at, a.last_error
             FROM print_job_attempts a
             WHERE (
                 a.state IN (
                     'created', 'submitting', 'windows_queued', 'windows_printing',
                     'paused', 'cancel_requested', 'unknown', 'cancel_failed'
                 )
                 OR (a.state = 'spool_error' AND a.spool_job_id IS NOT NULL)
             )
               AND a.id = (
                   SELECT latest.id FROM print_job_attempts latest
                   WHERE latest.print_job_id = a.print_job_id
                   ORDER BY latest.attempt_number DESC LIMIT 1
               )
             ORDER BY a.started_at DESC LIMIT 50",
        )
        .map_err(|error| format!("prepare active print attempts diagnostics: {error}"))?;
    let active_attempts = attempts_statement
        .query_map([], |row| {
            let attempt_id = row.get::<_, String>(0)?;
            let job_id = row.get::<_, String>(1)?;
            let transport = row.get::<_, String>(2)?;
            let marker = row.get::<_, String>(4)?;
            let windows_job_id = if transport == "windows" {
                row.get::<_, Option<i64>>(5)?.filter(|job_id| *job_id > 0)
            } else {
                None
            };
            let ownership_marker = if windows_job_id.is_some() {
                match (
                    uuid::Uuid::parse_str(&job_id),
                    uuid::Uuid::parse_str(&attempt_id),
                    crate::windows_spooler::parse_document_marker(&marker),
                ) {
                    (Ok(job_uuid), Ok(attempt_uuid), Ok(parsed))
                        if parsed.local_job_id == job_uuid && parsed.attempt_id == attempt_uuid =>
                    {
                        Some(marker)
                    }
                    _ => None,
                }
            } else {
                None
            };
            Ok(json!({
                "attemptId": attempt_id,
                "jobId": job_id,
                "transport": transport,
                "resolvedTarget": bounded_diagnostic_text(row.get(3)?, 256),
                "ownershipMarker": ownership_marker,
                "windowsJobId": windows_job_id,
                "state": row.get::<_, String>(6)?,
                "nativeStatusBits": row.get::<_, Option<i64>>(7)?,
                "nativeStatusText": bounded_diagnostic_text(row.get(8)?, 256),
                "startedAt": row.get::<_, String>(9)?,
                "lastSeenAt": row.get::<_, Option<String>>(10)?,
                "completedAt": row.get::<_, Option<String>>(11)?,
                "cancelRequestedAt": row.get::<_, Option<String>>(12)?,
                "cancelConfirmedAt": row.get::<_, Option<String>>(13)?,
                "lastError": crate::print::safe_operational_error(row.get(14)?, 1024),
            }))
        })
        .map_err(|error| format!("query active print attempts diagnostics: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read active print attempts diagnostics: {error}"))?;
    drop(attempts_statement);

    let mut circuits_statement = conn
        .prepare(
            "SELECT target_key, transport, circuit_state, blocked_reason, blocked_at, updated_at
             FROM print_target_state
             ORDER BY updated_at DESC LIMIT 50",
        )
        .map_err(|error| format!("prepare print target diagnostics: {error}"))?;
    let target_circuits = circuits_statement
        .query_map([], |row| {
            Ok(json!({
                "targetKey": bounded_diagnostic_text(row.get(0)?, 320),
                "transport": row.get::<_, String>(1)?,
                "circuitState": row.get::<_, String>(2)?,
                "blockedReason": crate::print::safe_operational_error(row.get(3)?, 512),
                "blockedAt": row.get::<_, Option<String>>(4)?,
                "updatedAt": row.get::<_, String>(5)?,
            }))
        })
        .map_err(|error| format!("query print target diagnostics: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read print target diagnostics: {error}"))?;

    Ok(json!({
        "profiles": profiles,
        "recentJobs": recent_jobs,
        "activeAttempts": active_attempts,
        "targetCircuits": target_circuits,
    }))
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
        assert_eq!(health["syncBacklogStatus"], json!("ok"));
        assert!(health.get("paymentAdjustmentBacklog").is_some());
        assert!(health.get("terminalContext").is_some());
        assert!(health.get("syncStatusSummary").is_some());
        assert!(health.get("printerStatus").is_some());
        assert!(health.get("parityQueueStatus").is_some());
        assert!(health.get("financialQueueStatus").is_some());
        assert!(health.get("lastParitySync").is_some());
        assert!(health.get("credentialState").is_some());
        assert!(health.get("checkoutPaymentBlockers").is_some());
        // Nothing waits to print: read, and zero (not "not read").
        assert_eq!(
            health["printerStatus"]["pendingJobs"],
            json!({ "count": 0, "oldestCreatedAt": null, "pausedCount": 0 })
        );
        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn insert_print_job(
        conn: &rusqlite::Connection,
        id: &str,
        profile_id: Option<&str>,
        status: &str,
        created_at: &str,
    ) {
        conn.execute(
            "INSERT INTO print_jobs
             (id, entity_type, entity_id, printer_profile_id, status, created_at, updated_at)
             VALUES (?1, 'order_receipt', ?1, ?2, ?3, ?4, ?4)",
            params![id, profile_id, status, created_at],
        )
        .unwrap();
    }

    fn pending_jobs(db_state: &DbState) -> Value {
        get_system_health(db_state).unwrap()["printerStatus"]["pendingJobs"].clone()
    }

    /// Review 30/09/2026: the aggregate counted only `pending`. A job a worker
    /// took (`printing`) whose send never finished was invisible, so the Health
    /// view's "receipts are not printing" rule (and `printer.jobs_not_printing`)
    /// saw it only through jobs queued behind it. Both states are waiting, aged
    /// from `created_at`; finished, dispatched, failed and cancelled jobs are not.
    #[test]
    fn print_aggregate_counts_jobs_stuck_printing_as_waiting() {
        let dir = std::env::temp_dir().join(format!("diag_print_waiting_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let stuck_printing = (chrono::Utc::now() - chrono::Duration::minutes(90)).to_rfc3339();
        let queued_behind = (chrono::Utc::now() - chrono::Duration::minutes(40)).to_rfc3339();
        let long_ago = (chrono::Utc::now() - chrono::Duration::hours(5)).to_rfc3339();
        {
            let conn = db_state.conn.lock().unwrap();
            // Only a `printing` job: the old aggregate said nothing was waiting.
            insert_print_job(
                &conn,
                "job-printing",
                Some("front"),
                "printing",
                &stuck_printing,
            );
            for (id, status) in [
                ("job-printed", "printed"),
                ("job-dispatched", "dispatched"),
                ("job-failed", "failed"),
                ("job-cancelled", "cancelled"),
            ] {
                insert_print_job(&conn, id, Some("front"), status, &long_ago);
            }
        }
        assert_eq!(
            pending_jobs(&db_state),
            json!({ "count": 1, "oldestCreatedAt": stuck_printing, "pausedCount": 0 })
        );

        {
            let conn = db_state.conn.lock().unwrap();
            insert_print_job(&conn, "job-pending", None, "pending", &queued_behind);
        }
        let aggregate = pending_jobs(&db_state);
        assert_eq!(
            aggregate,
            json!({ "count": 2, "oldestCreatedAt": stuck_printing, "pausedCount": 0 })
        );

        // The support incident reads the same aggregate: a job stuck printing
        // for 90 minutes is a real stall past its 20-minute rule.
        let incidents = crate::incident_reporting::classify_incidents(&json!({
            "terminalContext": { "terminalId": "term-1" },
            "printerStatus": { "configured": true, "recentJobs": [], "pendingJobs": aggregate },
        }));
        assert!(incidents
            .iter()
            .any(|candidate| candidate.issue_code == "printer.jobs_not_printing"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review 30/09/2026: jobs held by a pause are not "not printing". Someone
    /// paused the queue or the printer on purpose; the Health view must not
    /// tell staff that receipts are stuck, nor page support. They are left out
    /// by the rule the dispatcher uses (the global key, or the job's printer)
    /// and counted apart as evidence.
    #[test]
    fn print_aggregate_leaves_out_jobs_held_by_a_pause() {
        let dir = std::env::temp_dir().join(format!("diag_print_paused_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let front_old = (chrono::Utc::now() - chrono::Duration::minutes(60)).to_rfc3339();
        let front_printing = (chrono::Utc::now() - chrono::Duration::minutes(45)).to_rfc3339();
        let kitchen = (chrono::Utc::now() - chrono::Duration::minutes(8)).to_rfc3339();
        let unassigned = (chrono::Utc::now() - chrono::Duration::minutes(6)).to_rfc3339();
        {
            let conn = db_state.conn.lock().unwrap();
            insert_print_job(&conn, "front-1", Some("front"), "pending", &front_old);
            insert_print_job(&conn, "front-2", Some("front"), "printing", &front_printing);
            insert_print_job(&conn, "kitchen-1", Some("kitchen"), "pending", &kitchen);
            insert_print_job(&conn, "default-1", None, "pending", &unassigned);
            crate::db::set_setting(&conn, "printing", "queue_paused_profile::front", "true")
                .unwrap();
            // A resumed printer is not paused.
            crate::db::set_setting(&conn, "printing", "queue_paused_profile::kitchen", "false")
                .unwrap();
        }
        // The paused printer's jobs are out; the others still age, from the
        // oldest of them.
        assert_eq!(
            pending_jobs(&db_state),
            json!({ "count": 2, "oldestCreatedAt": kitchen, "pausedCount": 2 })
        );

        {
            let conn = db_state.conn.lock().unwrap();
            crate::db::set_setting(&conn, "printing", "queue_paused", "true").unwrap();
        }
        let aggregate = pending_jobs(&db_state);
        assert_eq!(
            aggregate,
            json!({ "count": 0, "oldestCreatedAt": null, "pausedCount": 4 })
        );
        // Nothing reports a paused queue to support either — even though the
        // five-row `recentJobs` window still lists the paused pending rows (it
        // is not pause-filtered). Re-review 30/09/2026: the classifier used to
        // fall back to that window whenever `oldestCreatedAt` was null and paged
        // support for a queue paused on purpose.
        let paused_recent_jobs = json!([
            { "id": "front-1", "status": "pending", "createdAt": front_old },
            { "id": "kitchen-1", "status": "pending", "createdAt": kitchen },
        ]);
        let incidents = crate::incident_reporting::classify_incidents(&json!({
            "terminalContext": { "terminalId": "term-1" },
            "printerStatus": {
                "configured": true,
                "recentJobs": paused_recent_jobs,
                "pendingJobs": aggregate,
            },
        }));
        assert!(incidents
            .iter()
            .all(|candidate| candidate.issue_code != "printer.jobs_not_printing"));
        // A failed queue read (null aggregate) is unknown, not a stall: it must
        // not rescan the unfiltered window either.
        let incidents = crate::incident_reporting::classify_incidents(&json!({
            "terminalContext": { "terminalId": "term-1" },
            "printerStatus": {
                "configured": true,
                "recentJobs": paused_recent_jobs,
                "pendingJobs": null,
            },
        }));
        assert!(incidents
            .iter()
            .all(|candidate| candidate.issue_code != "printer.jobs_not_printing"));
        // The older payload shape, with no `pendingJobs` key at all, still ages
        // its pending rows from `recentJobs`.
        let incidents = crate::incident_reporting::classify_incidents(&json!({
            "terminalContext": { "terminalId": "term-1" },
            "printerStatus": { "configured": true, "recentJobs": paused_recent_jobs },
        }));
        assert!(incidents
            .iter()
            .any(|candidate| candidate.issue_code == "printer.jobs_not_printing"));

        {
            let conn = db_state.conn.lock().unwrap();
            crate::db::set_setting(&conn, "printing", "queue_paused", "false").unwrap();
            crate::db::set_setting(&conn, "printing", "queue_paused_profile::front", "false")
                .unwrap();
        }
        assert_eq!(
            pending_jobs(&db_state),
            json!({ "count": 4, "oldestCreatedAt": front_old, "pausedCount": 0 })
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_system_health_includes_active_shift_checkout_payment_blockers() {
        let dir =
            std::env::temp_dir().join(format!("diag_checkout_blockers_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let conn = db_state.conn.lock().unwrap();

        // W4e Step 0: dual-populate (100.0/6.1 → 10000/610).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version,
                report_date, period_start_at, sync_status, created_at, updated_at
             ) VALUES (
                'shift-health-blocked', 'cashier-health', 'cashier', 'branch-health', 'term-health',
                '2026-04-18T06:00:00Z', 100.0, 10000, 'active', 2,
                '2026-04-18', '2026-04-18T06:00:00Z', 'pending', '2026-04-18T06:00:00Z', '2026-04-18T06:00:00Z'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, staff_shift_id, items, total_amount, total_amount_cents, status,
                payment_status, sync_status, created_at, updated_at
             ) VALUES (
                'order-health-blocked', 'ORD-HEALTH-1', 'branch-health', 'shift-health-blocked', '[]', 6.1, 610, 'delivered',
                'pending', 'pending', '2026-04-18T09:10:00Z', '2026-04-18T09:10:00Z'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let health = get_system_health(&db_state).unwrap();
        let blockers = &health["checkoutPaymentBlockers"];
        assert_eq!(blockers["count"], json!(1));
        assert_eq!(blockers["sourceWindow"], json!("active_shift"));
        assert_eq!(blockers["details"][0]["orderNumber"], json!("ORD-HEALTH-1"));
        // W6: the `missing_cash_payment` / `missing_card_payment` /
        // `split_payment_incomplete` reason codes were collapsed into the
        // catch-all `no_persisted_payment` once the stored
        // `orders.payment_method` column was dropped in v55.
        assert_eq!(
            blockers["details"][0]["reasonCode"],
            json!("no_persisted_payment")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_payment_adjustment_backlog_distinguishes_parent_and_canonical_blockers() {
        let dir = std::env::temp_dir().join(format!("diag_adjustments_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let conn = db_state.conn.lock().unwrap();

        // W4e Step 0: dual-populate (10/20/30 dollars → 1000/2000/3000 cents; 1/2/3 → 100/200/300).
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES ('ord-generic', '[]', 10.0, 1000, 'completed', 'synced', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, sync_status, sync_state, remote_payment_id, created_at, updated_at)
             VALUES ('pay-generic', 'ord-generic', 'cash', 10.0, 1000, 'synced', 'applied', ?1, datetime('now'), datetime('now'))",
            params![uuid::Uuid::new_v4().to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, amount_cents, reason, sync_state, created_at, updated_at)
             VALUES ('adj-generic', 'pay-generic', 'ord-generic', 'refund', 1.0, 100, 'Generic', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES ('ord-parent', '[]', 20.0, 2000, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-parent', 'ord-parent', 'cash', 20.0, 2000, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, amount_cents, reason, sync_state, created_at, updated_at)
             VALUES ('adj-parent', 'pay-parent', 'ord-parent', 'refund', 2.0, 200, 'Parent', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES ('ord-canonical', '[]', 30.0, 3000, 'completed', 'synced', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-canonical', 'ord-canonical', 'card', 30.0, 3000, 'synced', 'applied', datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, amount_cents, reason, sync_state, created_at, updated_at)
             VALUES ('adj-canonical', 'pay-canonical', 'ord-canonical', 'refund', 3.0, 300, 'Canonical', 'waiting_parent', datetime('now'), datetime('now'))",
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
    fn diagnostics_export_never_contains_native_repair_queue_data() {
        let dir = std::env::temp_dir().join(format!("diag_repair_seal_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let conn = db_state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status, error_message
             ) VALUES (
                 'repair-diagnostics-operation-secret', 'repairs',
                 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'UPDATE',
                 '{\"ciphertext\":\"repair-diagnostics-ciphertext-secret\"}',
                 'repair-diagnostics-tenant-secret', datetime('now'), 4, 1000, 1,
                 'repairs', 'manual', 7, 'failed', 'repair-diagnostics-error-secret'
             )",
            [],
        )
        .expect("seed native repair queue row");
        drop(conn);

        let export_path = export_diagnostics_with_options(
            &db_state,
            &dir,
            DiagnosticsExportOptions {
                include_logs: false,
                redact_sensitive: false,
            },
        )
        .expect("export diagnostics bundle");

        let file = std::fs::File::open(&export_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut bundle_text = String::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            if entry.is_dir() {
                continue;
            }
            let mut entry_text = String::new();
            entry.read_to_string(&mut entry_text).unwrap();
            bundle_text.push_str(&entry_text);
        }

        for forbidden in [
            "repair-diagnostics-operation-secret",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "repair-diagnostics-ciphertext-secret",
            "repair-diagnostics-tenant-secret",
            "repair-diagnostics-error-secret",
        ] {
            assert!(
                !bundle_text.contains(forbidden),
                "diagnostics leaked native repair marker: {forbidden}"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_diagnostics_export_never_includes_raw_pos_logs() {
        struct RemoveFileOnDrop(std::path::PathBuf);
        impl Drop for RemoveFileOnDrop {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }

        let dir = std::env::temp_dir().join(format!("diag_raw_log_seal_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let sentinel_uuid = "9b36be15-9c2d-4ce1-a61b-c12f487cb2c1";
        let log_dir = get_log_dir();
        std::fs::create_dir_all(&log_dir).unwrap();
        let log_path = log_dir.join(format!("pos.repair-seal-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(
            &log_path,
            format!(
                "WARN queue_id=repair-log-private-op table=repairs record_id={sentinel_uuid} organization_id=repair-log-private-org ciphertext=repair-log-private-ciphertext"
            ),
        )
        .unwrap();
        let _log_cleanup = RemoveFileOnDrop(log_path);

        let export_path = export_diagnostics(&db_state, &dir).expect("default diagnostics export");
        let file = std::fs::File::open(&export_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().to_string();
            assert!(
                !name.starts_with("logs/"),
                "default diagnostics exported raw log entry {name}"
            );
            let mut contents = String::new();
            let _ = entry.read_to_string(&mut contents);
            for sentinel in [
                sentinel_uuid,
                "repair-log-private-op",
                "repair-log-private-org",
                "repair-log-private-ciphertext",
            ] {
                assert!(
                    !contents.contains(sentinel),
                    "bundle entry {name} leaked raw log sentinel {sentinel}"
                );
            }
        }

        drop(archive);
        drop(db_state);
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
        // W4e Step 0: dual-populate (9.7 → 970, 0.25 → 25).
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, payment_status,
                sync_status, created_at, updated_at
             ) VALUES (
                'ord-diag-blocker', 'ORD-DIAG-0070', '[]', 9.7, 970, 'completed', 'partially_paid',
                'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, currency, status, transaction_ref,
                sync_status, sync_state, created_at, updated_at
             ) VALUES (
                'pay-diag-blocker', 'ord-diag-blocker', 'cash', 0.25, 25, 'EUR', 'completed', 'TX-DIAG-1',
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
    fn printer_diagnostics_export_safe_attempt_evidence_without_print_content() {
        let dir = std::env::temp_dir().join(format!("diag_printing_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let (job_id, attempt_id, marker) = {
            let conn = db_state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO printer_profiles
                 (id, name, driver_type, printer_name, created_at, updated_at)
                 VALUES ('diag-profile', 'Front Receipt', 'windows', 'Front Queue',
                         datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
            let job_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO print_jobs
                 (id, entity_type, entity_id, entity_payload_json, printer_profile_id,
                  status, output_path, document_snapshot_version, document_snapshot_zlib,
                  document_snapshot_sha256, render_profile_snapshot_json,
                  created_at, updated_at)
                 VALUES (?1, 'order_receipt', 'DIAG-PRIVATE-CUSTOMER', ?2, 'diag-profile',
                         'dispatched', ?3, 1, ?4, ?5, ?6, datetime('now'), datetime('now'))",
                params![
                    job_id,
                    r#"{"customer":"DIAG-PRIVATE-PAYLOAD","logoData":"DIAG-PRIVATE-LOGO"}"#,
                    r#"C:\private\DIAG-PRIVATE-OUTPUT.html"#,
                    b"DIAG-PRIVATE-SNAPSHOT".as_slice(),
                    "DIAG-PRIVATE-HASH",
                    r#"{"fixturePayload":"DIAG-PRIVATE-ENVELOPE"}"#,
                ],
            )
            .unwrap();
            let identity = crate::print_dispatch::create_attempt(
                &conn,
                crate::print_dispatch::NewAttempt {
                    local_job_id: job_id.clone(),
                    target: crate::print_dispatch::PrinterTargetKey::WindowsQueue(
                        "Front Queue".into(),
                    ),
                    document_kind: "order_receipt".into(),
                    bytes_requested: 64,
                    now: chrono::Utc::now(),
                },
            )
            .unwrap();
            crate::print_dispatch::transition_attempt(
                &conn,
                identity.attempt_id,
                crate::print_dispatch::DispatchState::Submitting,
                crate::print_dispatch::AttemptObservation::default(),
            )
            .unwrap();
            let marker = crate::print_dispatch::read_attempt(&conn, identity.attempt_id)
                .unwrap()
                .unwrap()
                .document_name;
            crate::print_dispatch::persist_spool_started(
                &conn,
                identity.attempt_id,
                &crate::windows_spooler::SpoolStarted {
                    job_id: 73,
                    printer_name: "Front Queue".into(),
                    document_name: marker.clone(),
                    submitted_at: chrono::Utc::now(),
                },
            )
            .unwrap();
            conn.execute(
                "UPDATE print_job_attempts
                 SET state = 'cancel_requested', native_status_bits = 8,
                     native_status_text = 'Spooling',
                     cancel_requested_at = datetime('now'),
                     last_error = 'Native control pending: file:///C:/private/DIAG-FILE-URL/receipt.html token=DIAG-ATTEMPT-SECRET'
                 WHERE id = ?1",
                [identity.attempt_id.to_string()],
            )
            .unwrap();
            conn.execute(
                "UPDATE print_jobs
                 SET warning_message = 'Render warning: https://example.invalid/private?token=DIAG-WARNING-SECRET',
                     last_error = 'Render failed: /srv/private/DIAG-UNIX-PATH/receipt.html'
                 WHERE id = ?1",
                [&job_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO print_target_state
                 (target_key, transport, circuit_state, blocked_reason, blocked_at, updated_at)
                 VALUES ('windows:front queue', 'windows', 'open',
                         'Target blocked: C:\\private\\DIAG-WINDOWS-PATH\\receipt.html api_key=DIAG-CIRCUIT-SECRET',
                         datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
            (job_id, identity.attempt_id, marker)
        };

        let export_path = export_diagnostics_with_options(
            &db_state,
            &dir,
            DiagnosticsExportOptions {
                include_logs: false,
                redact_sensitive: true,
            },
        )
        .unwrap();
        let file = std::fs::File::open(&export_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let diagnostics = read_zip_json(&mut archive, "printer_diagnostics.json");
        let encoded = serde_json::to_string(&diagnostics).unwrap();

        assert_eq!(
            diagnostics["profiles"][0]["printerName"],
            json!("Front Queue")
        );
        assert_eq!(diagnostics["activeAttempts"][0]["jobId"], json!(job_id));
        assert_eq!(
            diagnostics["activeAttempts"][0]["attemptId"],
            json!(attempt_id.to_string())
        );
        assert_eq!(diagnostics["activeAttempts"][0]["windowsJobId"], json!(73));
        assert_eq!(
            diagnostics["activeAttempts"][0]["ownershipMarker"],
            json!(marker)
        );
        assert_eq!(
            diagnostics["activeAttempts"][0]["state"],
            json!("cancel_requested")
        );
        assert_eq!(
            diagnostics["activeAttempts"][0]["nativeStatusBits"],
            json!(8)
        );
        assert_eq!(
            diagnostics["activeAttempts"][0]["nativeStatusText"],
            json!("Spooling")
        );
        assert_eq!(
            diagnostics["activeAttempts"][0]["lastError"],
            json!("Native control pending: [redacted-sensitive-detail]")
        );
        assert_eq!(
            diagnostics["recentJobs"][0]["warningMessage"],
            json!("Render warning: [redacted-sensitive-detail]")
        );
        assert_eq!(
            diagnostics["recentJobs"][0]["lastError"],
            json!("Render failed: [redacted-sensitive-detail]")
        );
        assert_eq!(
            diagnostics["targetCircuits"][0]["blockedReason"],
            json!("Target blocked: [redacted-sensitive-detail]")
        );
        assert!(diagnostics["activeAttempts"][0]["cancelRequestedAt"].is_string());
        for forbidden in [
            "DIAG-PRIVATE-CUSTOMER",
            "DIAG-PRIVATE-PAYLOAD",
            "DIAG-PRIVATE-LOGO",
            "DIAG-PRIVATE-OUTPUT",
            "DIAG-PRIVATE-SNAPSHOT",
            "DIAG-PRIVATE-HASH",
            "DIAG-PRIVATE-ENVELOPE",
            "DIAG-FILE-URL",
            "DIAG-ATTEMPT-SECRET",
            "DIAG-WARNING-SECRET",
            "DIAG-UNIX-PATH",
            "DIAG-WINDOWS-PATH",
            "DIAG-CIRCUIT-SECRET",
            "entityPayloadJson",
            "outputPath",
            "snapshot",
            "envelope",
            "logoData",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "leaked {forbidden}: {encoded}"
            );
        }
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().to_string();
            assert!(
                !name.starts_with("logs/"),
                "logs unexpectedly exported: {name}"
            );
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            let contents = String::from_utf8_lossy(&bytes);
            for sentinel in [
                "DIAG-PRIVATE-CUSTOMER",
                "DIAG-PRIVATE-PAYLOAD",
                "DIAG-PRIVATE-LOGO",
                "DIAG-PRIVATE-OUTPUT",
                "DIAG-PRIVATE-SNAPSHOT",
                "DIAG-PRIVATE-HASH",
                "DIAG-PRIVATE-ENVELOPE",
                "DIAG-FILE-URL",
                "DIAG-ATTEMPT-SECRET",
                "DIAG-WARNING-SECRET",
                "DIAG-UNIX-PATH",
                "DIAG-WINDOWS-PATH",
                "DIAG-CIRCUIT-SECRET",
            ] {
                assert!(
                    !contents.contains(sentinel),
                    "bundle entry {name} leaked {sentinel}"
                );
            }
        }
        drop(archive);
        drop(db_state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_should_redact_key_matches_sensitive_markers() {
        assert!(should_redact_key("api_key"));
        assert!(should_redact_key("Authorization"));
        assert!(should_redact_key("staff_pin"));
        assert!(should_redact_key("output_path"));
        assert!(should_redact_key("document_snapshot_zlib"));
        assert!(should_redact_key("render_profile_snapshot_json"));
        assert!(should_redact_key("logo_data"));
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

/// Diagnostics bundle v2 (health parity plan §5, 29/09/2026 incident): the
/// v1 scrubber turned `window.reportDate` and a printer IP into
/// [REDACTED_PHONE] and redacted `apiKeyPresent`, while names went out in
/// clear; the bundle had no manifest, no Health view and nothing about the
/// fiscal queue that held the Z.
///
/// The shared vectors (`shared/pos/health/__fixtures__/redaction-vectors.json`)
/// are the cases both exporters must agree on: the Android bundle's rules
/// (`shared/pos/health/diagnostics-redaction.ts`) are tested against the
/// same file. The tests below them pin desktop-only details.
#[cfg(test)]
mod bundle_v2_tests {
    use super::*;

    const SHARED_REDACTION_VECTORS: &str =
        include_str!("../../../shared/pos/health/__fixtures__/redaction-vectors.json");

    fn shared_vectors() -> Value {
        serde_json::from_str(SHARED_REDACTION_VECTORS).expect("parse the shared redaction vectors")
    }

    fn string_pairs(value: &Value) -> Vec<(String, String)> {
        value
            .as_array()
            .expect("vector list")
            .iter()
            .map(|pair| {
                (
                    pair[0].as_str().expect("input").to_string(),
                    pair[1].as_str().expect("expected").to_string(),
                )
            })
            .collect()
    }

    /// Review 30/09/2026: `+41 79 123 45 67`, `+41 (0)79 123 45 67`,
    /// `τηλ:6941234567`, `phone=…`, `tel:+30…` and Postgres
    /// `Key (phone)=(…)` went out in clear, `0041 79 123 45 67` half.
    #[test]
    fn scrubs_and_keeps_the_shared_string_vectors() {
        let vectors = shared_vectors();
        for (input, expected) in string_pairs(&vectors["scrubString"]["keepReadable"])
            .into_iter()
            .chain(string_pairs(&vectors["scrubString"]["scrub"]))
        {
            assert_eq!(scrub_sensitive_string(&input), expected, "{input}");
        }
        let max_chars = vectors["scrubString"]["maxChars"]
            .as_u64()
            .expect("maxChars") as usize;
        assert_eq!(max_chars, MAX_EXPORT_STRING_CHARS);
    }

    #[test]
    fn redacts_the_shared_key_vectors() {
        let vectors = shared_vectors();
        let keys = &vectors["keys"];
        for key in keys["redact"].as_array().expect("redact keys") {
            let key = key.as_str().expect("key");
            assert!(should_redact_key(key), "{key} must be redacted");
        }
        for key in keys["keep"].as_array().expect("keep keys") {
            let key = key.as_str().expect("key");
            assert!(!should_redact_key(key), "{key} must stay readable");
        }
        for entry in keys["presenceValues"].as_array().expect("presence values") {
            let key = entry["key"].as_str().expect("key");
            assert_eq!(
                should_redact_key_for(key, &entry["value"], None),
                entry["redacted"].as_bool().expect("redacted"),
                "{key} = {}",
                entry["value"]
            );
        }
        for entry in keys["personContext"].as_array().expect("person context") {
            let key = entry["key"].as_str().expect("key");
            let parent = entry["parent"].as_str().expect("parent");
            assert_eq!(
                should_redact_key_for(key, &json!("value"), Some(parent)),
                entry["redacted"].as_bool().expect("redacted"),
                "{key} inside {parent}"
            );
        }
    }

    #[test]
    fn redacts_the_shared_document_vector() {
        let vectors = shared_vectors();
        assert_eq!(
            redact_sensitive_fields(vectors["document"]["input"].clone()),
            vectors["document"]["expected"]
        );
    }

    fn read_zip_json(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Value {
        let mut file = archive.by_name(name).expect("zip entry should exist");
        let mut contents = String::new();
        file.read_to_string(&mut contents)
            .expect("read zip json contents");
        serde_json::from_str(&contents).expect("parse zip json")
    }

    #[test]
    fn dates_times_ips_versions_ids_and_amounts_stay_readable() {
        for readable in [
            "2026-09-29",
            "29/09/2026",
            "29.09.26",
            "2026/09/29",
            "11:05:13",
            "2026-09-29T11:05:13.140276+00:00",
            "2026-09-30T04:59:59.999Z",
            "192.168.1.100",
            "10.0.0.254",
            "1.4.119",
            "v1.0.13",
            "1.0.13.602015",
            "221.50",
            "-12.5",
            "d28cef2e-bbf2-496a-b922-45b497525715",
            "terminal-d80762ac",
            "cust-9b36be15-9c2d-4ce1-a61b-c12f487cb2c1",
        ] {
            assert_eq!(scrub_sensitive_string(readable), readable, "{readable}");
        }
        // In free text, with punctuation around them.
        assert_eq!(
            scrub_sensitive_string("Z of (2026-09-29), printer 192.168.1.100:9100 offline."),
            "Z of (2026-09-29), printer 192.168.1.100:9100 offline."
        );
        // Whitespace is kept, not collapsed.
        assert_eq!(
            scrub_sensitive_string("line one\n  line two\tend"),
            "line one\n  line two\tend"
        );
    }

    #[test]
    fn emails_and_phone_numbers_are_scrubbed() {
        assert_eq!(
            scrub_sensitive_string("mail maria.p@example.com now"),
            "mail [REDACTED_EMAIL] now"
        );
        assert_eq!(
            scrub_sensitive_string("<maria@example.gr>,"),
            "<[REDACTED_EMAIL]>,"
        );
        for phone in [
            "6912345678",
            "+306912345678",
            "210-123-4567",
            "0030.210.1234567",
        ] {
            assert_eq!(scrub_sensitive_string(phone), "[REDACTED_PHONE]", "{phone}");
        }
        // Surrounding punctuation stays around the marker.
        assert_eq!(scrub_sensitive_string("(210)1234567"), "([REDACTED_PHONE]");
        // Groups that only add up to a phone number together.
        assert_eq!(
            scrub_sensitive_string("call +30 691 234 5678 today"),
            "call [REDACTED_PHONE] today"
        );
        assert_eq!(
            scrub_sensitive_string("tel 2310 123456"),
            "tel [REDACTED_PHONE]"
        );
        // Short digit groups are not phones.
        assert_eq!(scrub_sensitive_string("table 12 seat 4"), "table 12 seat 4");
        // A URL keeps its path; the query can carry a token.
        assert_eq!(
            scrub_sensitive_string("GET https://admin.example.com/api/pos/fiscal/status?token=abc"),
            "GET https://admin.example.com/api/pos/fiscal/status?[REDACTED]"
        );
    }

    #[test]
    fn free_text_is_capped_at_one_kilobyte_like_the_android_bundle() {
        let exact = "a".repeat(1024);
        assert_eq!(scrub_sensitive_string(&exact), exact);

        let long = format!("{}tail", "b".repeat(1024));
        let capped = scrub_sensitive_string(&long);
        assert_eq!(capped.chars().count(), 1025);
        assert!(capped.starts_with(&"b".repeat(1024)));
        assert!(capped.ends_with('…'));
    }

    fn digit_groups(separator: &str, width: usize) -> String {
        let modulo = 10usize.pow(width as u32);
        let mut text = String::new();
        let mut index = 0usize;
        while text.len() < 64 * 1024 {
            if index > 0 {
                text.push_str(separator);
            }
            text.push_str(&format!("{:0width$}", index % modulo, width = width));
            index += 1;
        }
        text
    }

    /// Review 30/09/2026 (F5): the phone scanner was cubic in the number of
    /// digit groups and read the whole string before the 1 KB cap, so one
    /// long stored error could stall the export. It now scans about the
    /// first kilobyte and collects at most 8 chunks or 15 digits per number.
    #[test]
    fn sixty_four_kilobytes_of_digit_groups_scan_in_well_under_100_ms() {
        let nbsp = char::from_u32(0xA0).expect("no-break space").to_string();
        for (label, input) in [
            ("two-digit groups", digit_groups(" ", 2)),
            ("one-digit groups", digit_groups(" ", 1)),
            (
                "three-digit groups joined by no-break spaces",
                digit_groups(&nbsp, 3),
            ),
            ("dashed groups", digit_groups("-", 2)),
            ("dotted groups", digit_groups(".", 3)),
        ] {
            // The export cap, and a cap past the input so all 64 KB are scanned.
            for max_chars in [MAX_EXPORT_STRING_CHARS, 1 << 20] {
                // Fastest of three runs, so a busy test machine is not a failure.
                let fastest = (0..3)
                    .map(|_| {
                        let started = std::time::Instant::now();
                        let scrubbed = scrub_sensitive_string_with_limit(&input, max_chars);
                        assert!(scrubbed.chars().count() <= max_chars + 1, "{label}");
                        started.elapsed()
                    })
                    .min()
                    .expect("three runs");
                assert!(
                    fastest < std::time::Duration::from_millis(100),
                    "{label}, cap {max_chars}: {fastest:?}"
                );
            }
        }
    }

    /// A number or email the scan cap falls in is read whole or redacted up to
    /// the cap, never shown in part, even when an earlier URL query shrinks
    /// the text so the cap region lands inside the first kilobyte.
    #[test]
    fn a_number_at_the_scan_cap_is_never_shown_in_part() {
        let url = format!("https://h.example/p?{}", "q".repeat(1000));
        let tail = "x ".repeat(400);
        for sensitive in [
            "+41 79 123 45 67",
            "6941234567",
            "tel: 694 123 4567",
            "0030 210 1234567",
            "maria.papadopoulou@example.com",
        ] {
            for offset in 0..400 {
                let input = format!("{url} {} {sensitive} done {tail}", "w".repeat(offset));
                let scrubbed = scrub_sensitive_string(&input);
                assert!(
                    !scrubbed.chars().any(|ch| ch.is_ascii_digit()) && !scrubbed.contains("maria"),
                    "{sensitive} at offset {offset}: {scrubbed}"
                );
                assert!(scrubbed.ends_with('…'), "{sensitive} at offset {offset}");
            }
        }
    }

    /// Review 30/09/2026: text bounded before the export scrubbed it (print
    /// safe_operational_error at 512/1024, printer texts, conflict reasons)
    /// kept part of a number or email the bound fell in. Bounded text is now
    /// scrubbed first, whatever the bound, and stays within it.
    #[test]
    fn bounded_text_never_keeps_part_of_a_number_or_an_email() {
        for max_chars in [31usize, 96, 160, 512] {
            for sensitive in [
                "+41 79 123 45 67",
                "6941234567",
                "Key (phone)=(079.123.45.67)",
                "maria.papadopoulou@example.com",
            ] {
                for offset in 0..(max_chars + 40) {
                    let text = format!(
                        "{} {sensitive} done {}",
                        "e".repeat(offset),
                        "w ".repeat(60)
                    );
                    let bounded = scrub_and_bound_text(&text, max_chars);
                    assert!(
                        bounded.chars().count() <= max_chars,
                        "{max_chars} {sensitive} at {offset}: {bounded}"
                    );
                    assert!(
                        !bounded.chars().any(|ch| ch.is_ascii_digit())
                            && !bounded.contains("maria"),
                        "{max_chars} {sensitive} at {offset}: {bounded}"
                    );
                }
            }
        }
        // Short text is only scrubbed; empty bound is empty.
        assert_eq!(
            scrub_and_bound_text("printer 192.168.1.100:9100 offline", 64),
            "printer 192.168.1.100:9100 offline"
        );
        assert_eq!(
            scrub_and_bound_text("call 6941234567", 64),
            "call [REDACTED_PHONE]"
        );
        assert_eq!(scrub_and_bound_text("anything", 0), "");
        // The printer texts of the bundle go through it too.
        let name = format!("{} tel 694 123 4567", "Kitchen".repeat(3));
        let bounded = bounded_diagnostic_text(Some(name), 30).expect("bounded name");
        assert!(!bounded.chars().any(|ch| ch.is_ascii_digit()), "{bounded}");
        assert!(bounded.chars().count() <= 30);
    }

    /// A token longer than the read limit cannot be judged (an email may end
    /// it), so it is dropped whole; a long token that ends inside the limit
    /// is read to its end and capped as before.
    #[test]
    fn a_token_too_long_to_read_whole_is_dropped() {
        let hidden = format!("Error: {}@example.com", "a".repeat(20_000));
        assert_eq!(scrub_sensitive_string(&hidden), "Error: …");

        let readable = format!("Error: {}", "a".repeat(5_000));
        let scrubbed = scrub_sensitive_string(&readable);
        assert_eq!(scrubbed.chars().count(), MAX_EXPORT_STRING_CHARS + 1);
        assert!(scrubbed.starts_with("Error: aaaa"));
    }

    #[test]
    fn presence_booleans_stay_and_secrets_and_payloads_go() {
        let redacted = redact_sensitive_fields(json!({
            "hasApiKey": true,
            "hasAdminUrl": false,
            "apiKeyPresent": true,
            "pin_reset_required": false,
            "api_key": null,
            "isOnline": true,
            "api_key_value": "sk-live-123",
            "authorization": "Bearer abc",
            "staffPinHash": "9f86d081",
            "pin": "1234",
            "data": { "orderId": "x" },
            "raw_payload": "{}",
            "shipping_zone": "north",
            "mapping": "grid",
            "status": "failed",
        }));
        for kept in [
            "hasApiKey",
            "hasAdminUrl",
            "apiKeyPresent",
            "pin_reset_required",
            "api_key",
            "isOnline",
            "shipping_zone",
            "mapping",
            "status",
        ] {
            assert_ne!(redacted[kept], json!(REDACTED), "{kept} must stay readable");
        }
        assert_eq!(redacted["apiKeyPresent"], json!(true));
        assert_eq!(redacted["api_key"], Value::Null);
        for gone in [
            "api_key_value",
            "authorization",
            "staffPinHash",
            "pin",
            "data",
            "raw_payload",
        ] {
            assert_eq!(redacted[gone], json!(REDACTED), "{gone} must be redacted");
        }
    }

    #[test]
    fn staff_and_customer_names_are_redacted_but_places_and_devices_are_not() {
        let redacted = redact_sensitive_fields(json!({
            "customerName": "Maria Papadopoulou",
            "staff_name": "Nikos",
            "driverName": "Kostas",
            "checked_in_by_name": "Eleni",
            "staff": { "name": "Nikos", "role": "cashier" },
            "activeStaffBlockers": { "details": [{ "staffName": "Nikos", "roleType": "cashier" }] },
            "customer": { "full_name": "Maria P" },
            "branchName": "Kifisia Branch",
            "organizationName": "The Small Group",
            "terminalName": "Main POS",
            "profiles": [{ "name": "Kitchen printer", "printerName": "Front Queue" }],
            "customerPhone": "6912345678",
            "phone_country_code": "GR",
            "customer_email": "maria@example.com",
        }));
        for gone in [
            &redacted["customerName"],
            &redacted["staff_name"],
            &redacted["driverName"],
            &redacted["checked_in_by_name"],
            &redacted["staff"]["name"],
            &redacted["activeStaffBlockers"]["details"][0]["staffName"],
            &redacted["customer"]["full_name"],
            &redacted["customerPhone"],
            &redacted["phone_country_code"],
            &redacted["customer_email"],
        ] {
            assert_eq!(gone, &json!(REDACTED));
        }
        assert_eq!(redacted["staff"]["role"], json!("cashier"));
        assert_eq!(redacted["branchName"], json!("Kifisia Branch"));
        assert_eq!(redacted["organizationName"], json!("The Small Group"));
        assert_eq!(redacted["terminalName"], json!("Main POS"));
        assert_eq!(redacted["profiles"][0]["name"], json!("Kitchen printer"));
        assert_eq!(redacted["profiles"][0]["printerName"], json!("Front Queue"));
    }

    /// The two v1 casualties from the incident bundle.
    #[test]
    fn the_report_date_and_printer_ip_survive_redaction() {
        let redacted = redact_sensitive_fields(json!({
            "window": { "reportDate": "2026-09-29", "periodStartAt": "2026-09-29T05:00:00+00:00" },
            "printer": { "ip": "192.168.1.100", "port": 9100 },
            "about": { "version": "1.4.119" },
        }));
        assert_eq!(redacted["window"]["reportDate"], json!("2026-09-29"));
        assert_eq!(
            redacted["window"]["periodStartAt"],
            json!("2026-09-29T05:00:00+00:00")
        );
        assert_eq!(redacted["printer"]["ip"], json!("192.168.1.100"));
        assert_eq!(redacted["about"]["version"], json!("1.4.119"));
    }

    fn export_with(db_state: &DbState, dir: &Path, health_view: Option<Value>) -> String {
        export_diagnostics_bundle(
            db_state,
            dir,
            DiagnosticsExportOptions {
                include_logs: false,
                redact_sensitive: true,
            },
            health_view,
        )
        .expect("export diagnostics bundle")
    }

    #[test]
    #[serial_test::serial]
    fn the_bundle_carries_a_manifest_the_health_view_and_the_fiscal_closeout_evidence() {
        crate::fiscal::active_cache::reset_for_tests();
        let dir = std::env::temp_dir().join(format!("diag_v2_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        {
            let conn = db_state.conn.lock().unwrap();
            crate::db::set_setting(&conn, "terminal", "branch_id", "branch-lpp").unwrap();
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id, created_at,
                     attempts, status, error_message, module_type, conflict_strategy
                 ) VALUES ('fiscal-1', 'fiscal_submission', 'order-2e556433', 'INSERT',
                     '{\"branchId\":\"branch-lpp\",\"receiptNumber\":\"R-1\",\"customerEmail\":\"maria@example.com\"}',
                     'org-1', ?1, 4, 'pending', 'HTTP_400_CLIENT_ERROR: Invalid FiscalReceiptInput',
                     'fiscal', 'last-write-wins')",
                [chrono::Utc::now().to_rfc3339()],
            )
            .unwrap();
            crate::zreport::record_last_closeout_attempt(
                &conn,
                &crate::zreport::CloseoutAttempt {
                    at: "2026-09-29T16:38:14Z".to_string(),
                    stage: "fiscal_guard".to_string(),
                    code: "FISCAL_CLOSE_BLOCKED".to_string(),
                    message: Some(
                        "Cannot close day: 1 fiscal receipt(s) of 2026-09-29 have not been sent"
                            .to_string(),
                    ),
                },
            )
            .unwrap();
        }

        // The renderer's snapshot, in the shared buildHealthView format.
        let view = json!({
            "format": "thesmall-pos-health-view-v1",
            "platform": "windows",
            "source": "health_modal",
            "state": "needs_attention",
            "issues": [{ "code": "fiscal_queue_not_empty", "params": { "count": 1 } }],
            "operatorNote": "call maria@example.com",
        });
        let path = export_with(&db_state, &dir, Some(view));
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();

        let manifest = read_zip_json(&mut archive, DIAGNOSTICS_MANIFEST_FILE);
        assert_eq!(manifest["format"], json!(DIAGNOSTICS_FORMAT));
        assert_eq!(manifest["formatVersion"], json!(2));
        assert_eq!(manifest["platform"], json!(std::env::consts::OS));
        assert_eq!(manifest["source"], json!("health_modal"));
        assert_eq!(manifest["redaction"]["enabled"], json!(true));
        assert_eq!(manifest["logsIncluded"], json!(false));
        let files: Vec<String> = manifest["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file.as_str().unwrap().to_string())
            .collect();
        for expected in [
            "about.json",
            "system_health.json",
            "closeout_readiness.json",
            "sync_errors.json",
            "printer_diagnostics.json",
            HEALTH_VIEW_FILE,
            DIAGNOSTICS_MANIFEST_FILE,
        ] {
            assert!(
                files.contains(&expected.to_string()),
                "manifest lists {expected}"
            );
        }
        assert_eq!(
            archive.len(),
            files.len(),
            "every listed file is in the zip"
        );
        assert!(manifest["collectors"]
            .as_array()
            .unwrap()
            .iter()
            .all(|collector| collector["durationMs"].is_number()));

        // The snapshot is the file itself, as in the Android bundle.
        let health_view = read_zip_json(&mut archive, HEALTH_VIEW_FILE);
        assert_eq!(health_view["format"], json!("thesmall-pos-health-view-v1"));
        assert_eq!(health_view["source"], json!("health_modal"));
        assert_eq!(health_view["state"], json!("needs_attention"));
        assert_eq!(
            health_view["issues"][0]["code"],
            json!("fiscal_queue_not_empty")
        );
        assert!(
            health_view.get("view").is_none(),
            "no wrapper: {health_view}"
        );
        assert_eq!(
            health_view["operatorNote"],
            json!("call [REDACTED_EMAIL]"),
            "the renderer's snapshot is redacted like every other file"
        );
        let health_collector = manifest["collectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|collector| collector["entry"] == json!(HEALTH_VIEW_FILE))
            .cloned()
            .expect("health view collector recorded");
        assert_eq!(health_collector["status"], json!("ok"));

        let closeout = read_zip_json(&mut archive, "closeout_readiness.json");
        let fiscal = &closeout["fiscalQueueBlockers"];
        assert_eq!(fiscal["count"], json!(1));
        assert_eq!(fiscal["activeVerdict"], json!("unknown"));
        assert_eq!(fiscal["wouldBlockClose"], json!(true));
        assert_eq!(fiscal["rows"][0]["orderId"], json!("order-2e556433"));
        assert_eq!(fiscal["rows"][0]["attempts"], json!(4));
        assert_eq!(
            closeout["lastCloseoutAttempt"]["code"],
            json!("FISCAL_CLOSE_BLOCKED")
        );
        assert_eq!(
            closeout["lastCloseoutAttempt"]["stage"],
            json!("fiscal_guard")
        );
        assert_eq!(
            closeout["window"]["reportDate"]
                .as_str()
                .map(|day| day.len()),
            Some(10),
            "the report date stays readable: {closeout}"
        );

        let mut bundle_text = String::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            entry.read_to_string(&mut bundle_text).unwrap();
        }
        assert!(
            !bundle_text.contains("maria@example.com"),
            "no email leaves the terminal"
        );

        drop(archive);
        drop(db_state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_health_view_document_is_the_snapshot_or_says_why_not() {
        let view = json!({
            "format": "thesmall-pos-health-view-v1",
            "state": "attention",
            "counts": { "parityPending": 2 },
        });
        assert_eq!(health_view_document(Some(view.clone())).unwrap(), view);

        for missing in [
            None,
            Some(Value::Null),
            Some(json!("state")),
            Some(json!([1])),
        ] {
            let document = health_view_document(missing).unwrap();
            assert_eq!(document["status"], json!("not_collected"), "{document}");
        }

        let too_large = json!({ "padding": "x".repeat(MAX_HEALTH_VIEW_BYTES) });
        let document = health_view_document(Some(too_large)).unwrap();
        assert_eq!(document["status"], json!("unavailable"));
        assert!(document["bytes"].as_u64().unwrap() > MAX_HEALTH_VIEW_BYTES as u64);
    }

    #[test]
    fn without_a_health_view_the_file_says_not_collected() {
        let dir = std::env::temp_dir().join(format!("diag_v2_nohv_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        let path = export_with(&db_state, &dir, None);
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let health_view = read_zip_json(&mut archive, HEALTH_VIEW_FILE);
        assert_eq!(health_view["status"], json!("not_collected"));
        let manifest = read_zip_json(&mut archive, DIAGNOSTICS_MANIFEST_FILE);
        assert_eq!(manifest["source"], json!("unknown"));
        let health_collector = manifest["collectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|collector| collector["entry"] == json!(HEALTH_VIEW_FILE))
            .cloned()
            .expect("health view collector recorded");
        assert_eq!(health_collector["status"], json!("not_collected"));
        drop(archive);
        drop(db_state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v1 aborted the whole export when one collector failed; support then
    /// had nothing at all. A failing collector is now reported, and the rest
    /// of the bundle still ships.
    #[test]
    fn a_failing_collector_is_reported_unavailable_and_the_rest_still_ships() {
        let dir = std::env::temp_dir().join(format!("diag_v2_fail_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        db_state
            .conn
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE print_target_state;")
            .unwrap();

        let path = export_with(&db_state, &dir, None);
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let printers = read_zip_json(&mut archive, "printer_diagnostics.json");
        assert_eq!(printers["status"], json!("unavailable"));
        assert!(printers["error"].is_string());
        let manifest = read_zip_json(&mut archive, DIAGNOSTICS_MANIFEST_FILE);
        assert!(manifest["errors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|error| error["entry"] == json!("printer_diagnostics.json")));
        // The other files are still there.
        let about = read_zip_json(&mut archive, "about.json");
        assert!(about.get("version").is_some());
        drop(archive);
        drop(db_state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review 30/09/2026: the Health view's backlog card read "clear" when
    /// the backlog read failed. System health now says the backlog is
    /// unavailable, with the same empty shape.
    #[test]
    fn system_health_says_when_the_backlog_could_not_be_read() {
        let dir = std::env::temp_dir().join(format!("diag_backlog_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        db_state
            .conn
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE sync_queue; CREATE TABLE sync_queue (id TEXT PRIMARY KEY);")
            .unwrap();
        let health = get_system_health(&db_state).expect("system health still answers");
        assert_eq!(health["syncBacklogStatus"], json!("unavailable"));
        assert_eq!(health["syncBacklog"], json!({}));
        drop(db_state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review 30/09/2026: sync_errors.json, sync_backlog.json and
    /// terminal_settings_snapshot.json turned a failed read into `[]` or `{}`
    /// recorded "ok", which reads as "no errors, nothing waiting".
    #[test]
    fn unreadable_queue_and_settings_are_reported_unavailable_not_empty() {
        let dir = std::env::temp_dir().join(format!("diag_v2_unreadable_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        db_state
            .conn
            .lock()
            .unwrap()
            .execute_batch(
                "DROP TABLE sync_queue;
                 CREATE TABLE sync_queue (id TEXT PRIMARY KEY);
                 DROP TABLE local_settings;
                 CREATE TABLE local_settings (id TEXT PRIMARY KEY);",
            )
            .unwrap();

        let path = export_with(&db_state, &dir, None);
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let unreadable = [
            "sync_errors.json",
            "sync_backlog.json",
            "terminal_settings_snapshot.json",
        ];
        for file in unreadable {
            let document = read_zip_json(&mut archive, file);
            assert_eq!(
                document["status"],
                json!("unavailable"),
                "{file}: {document}"
            );
            assert!(document["error"].is_string(), "{file}: {document}");
        }
        let manifest = read_zip_json(&mut archive, DIAGNOSTICS_MANIFEST_FILE);
        let errors = manifest["errors"].as_array().expect("manifest errors");
        for file in unreadable {
            assert!(
                errors.iter().any(|error| error["entry"] == json!(file)),
                "{file} missing from {errors:?}"
            );
        }
        drop(archive);
        drop(db_state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    const MANIFEST_CONTRACT: &str =
        include_str!("../../../shared/pos/health/__fixtures__/diagnostics-manifest-contract.json");

    fn keys_of(value: &Value) -> Vec<String> {
        let mut keys: Vec<String> = value
            .as_object()
            .expect("an object")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    fn strings_of(value: &Value) -> Vec<String> {
        let mut strings: Vec<String> = value
            .as_array()
            .expect("a list")
            .iter()
            .map(|item| item.as_str().expect("a string").to_string())
            .collect();
        strings.sort();
        strings
    }

    /// Review 30/09/2026: the desktop wrote files/file/durationMs/
    /// redaction.applied/app.version, Android entries/entry/collectedInMs/
    /// redaction.enabled/app.versionName. One shape now, pinned by the shared
    /// contract both apps' tests read.
    #[test]
    fn the_manifest_has_the_shape_both_apps_share() {
        let contract: Value =
            serde_json::from_str(MANIFEST_CONTRACT).expect("parse the manifest contract");
        let dir = std::env::temp_dir().join(format!("diag_v2_contract_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        db_state
            .conn
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE print_target_state;")
            .unwrap();
        let path = export_with(&db_state, &dir, None);
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let manifest = read_zip_json(&mut archive, DIAGNOSTICS_MANIFEST_FILE);

        let mut expected_keys = strings_of(&contract["requiredKeys"]);
        expected_keys.extend(strings_of(&contract["platformExtras"]["manifest"]));
        expected_keys.sort();
        assert_eq!(keys_of(&manifest), expected_keys);
        for retired in strings_of(&contract["retiredKeys"]) {
            assert!(manifest.get(&retired).is_none(), "retired key {retired}");
        }
        let mut app_keys = strings_of(&contract["appKeys"]);
        app_keys.extend(strings_of(&contract["platformExtras"]["app"]));
        app_keys.sort();
        assert_eq!(keys_of(&manifest["app"]), app_keys);
        assert_eq!(
            manifest["app"]["versionName"],
            json!(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(
            keys_of(&manifest["redaction"]),
            strings_of(&contract["redactionKeys"])
        );
        assert_eq!(
            keys_of(&manifest["limits"]),
            strings_of(&contract["limitsKeys"])
        );
        for (key, value) in contract["values"].as_object().unwrap() {
            assert_eq!(&manifest[key], value, "{key}");
        }
        let statuses = strings_of(&contract["collectorStatuses"]);
        for collector in manifest["collectors"].as_array().unwrap() {
            for key in strings_of(&contract["collectorKeys"]) {
                assert!(
                    collector.get(&key).is_some(),
                    "collector {collector} lacks {key}"
                );
            }
            assert!(statuses.contains(&collector["status"].as_str().unwrap().to_string()));
        }
        let error = manifest["errors"]
            .as_array()
            .unwrap()
            .first()
            .expect("the dropped printer table is reported");
        assert_eq!(keys_of(error), strings_of(&contract["errorKeys"]));
        assert!(manifest["truncated"].is_array());
        drop(archive);
        drop(db_state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review 30/09/2026: `redact_sensitive` defaulted to false, so an export
    /// without options — or one asking for `redactSensitive: false` — left
    /// the terminal with the API key and customer details in clear.
    #[test]
    fn every_export_is_redacted_whatever_the_options_say() {
        let dir = std::env::temp_dir().join(format!("diag_v2_redact_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_state = crate::db::init(&dir).unwrap();
        {
            let conn = db_state.conn.lock().unwrap();
            crate::db::set_setting(&conn, "terminal", "api_key", "super-secret-export-key")
                .unwrap();
        }
        assert!(DiagnosticsExportOptions::default().redact_sensitive);
        let paths = [
            export_diagnostics(&db_state, &dir).expect("default export"),
            export_diagnostics_with_options(
                &db_state,
                &dir,
                DiagnosticsExportOptions {
                    include_logs: false,
                    redact_sensitive: false,
                },
            )
            .expect("export asking for no redaction"),
        ];
        for path in paths {
            let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
            let settings = read_zip_json(&mut archive, "terminal_settings_snapshot.json");
            assert_eq!(settings["terminal"]["api_key"], json!(REDACTED), "{path}");
            let manifest = read_zip_json(&mut archive, DIAGNOSTICS_MANIFEST_FILE);
            assert_eq!(manifest["redaction"]["enabled"], json!(true));
            let mut bundle_text = String::new();
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index).unwrap();
                entry.read_to_string(&mut bundle_text).unwrap();
            }
            assert!(!bundle_text.contains("super-secret-export-key"), "{path}");
        }
        drop(db_state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_are_capped_at_fifty_rows_and_the_cut_is_recorded() {
        let rows: Vec<Value> = (0..60).map(|index| json!({ "index": index })).collect();
        let mut truncated = Vec::new();
        let capped = redact_value_for_export(
            json!({ "rows": rows, "nested": { "items": [1, 2] } }),
            "sync_errors.json",
            &mut truncated,
        );
        assert_eq!(
            capped["rows"].as_array().unwrap().len(),
            MAX_EXPORT_LIST_ROWS
        );
        assert_eq!(capped["nested"]["items"], json!([1, 2]));
        assert_eq!(
            truncated,
            vec!["sync_errors.json: rows (total 60)".to_string()]
        );
    }

    #[test]
    fn the_source_comes_from_the_health_view_or_is_unknown() {
        assert_eq!(
            health_view_source(Some(&json!({ "source": "health_modal" }))),
            "health_modal"
        );
        assert_eq!(
            health_view_source(Some(&json!({ "source": "../../etc" }))),
            "unknown"
        );
        assert_eq!(health_view_source(Some(&json!({}))), "unknown");
        assert_eq!(health_view_source(None), "unknown");
    }
}
