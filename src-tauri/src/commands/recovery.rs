use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tauri::Manager;
use tracing::info;
use uuid::Uuid;

use crate::commands::customers;
use crate::database_lock::run_blocking_command;
use crate::terminal_helpers::TerminalEventSink;
use crate::{auth, db, payments, recovery, sync, sync_queue};

/// Recorded on every void this repair makes, so the adjustment says why.
const PLATFORM_MISMATCH_VOID_REASON: &str =
    "Platform-settled order: money is held by the platform, not the till";

fn parse_point_id(arg0: Option<Value>) -> Result<String, String> {
    crate::payload_arg0_as_string(arg0, &["id", "pointId", "point_id", "value"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing recovery point id".to_string())
}

fn parse_open_dir_payload(arg0: Option<Value>) -> Option<String> {
    crate::payload_arg0_as_string(arg0, &["path", "dir", "directory", "value"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
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
        Err("Opening recovery folder is not supported on this platform".into())
    }
}

fn request_field_str<'a>(request: &'a Value, key: &str) -> Option<&'a str> {
    request.get(key).and_then(Value::as_str).map(str::trim)
}

fn request_field_i64(request: &Value, key: &str) -> Option<i64> {
    request.get(key).and_then(|value| match value {
        Value::Number(num) => num.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn request_param<'a>(request: &'a Value, key: &str) -> Option<&'a Value> {
    request.get("params").and_then(Value::as_object)?.get(key)
}

fn request_param_str(request: &Value, key: &str) -> Option<String> {
    request_param(request, key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn request_param_i64(request: &Value, key: &str) -> Option<i64> {
    request_param(request, key).and_then(|value| match value {
        Value::Number(num) => num.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn value_field_str(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn value_field_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|field| match field {
        Value::Number(num) => num.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn nested_field_str(value: &Value, object_key: &str, key: &str) -> Option<String> {
    value
        .get(object_key)
        .and_then(|nested| value_field_str(nested, key))
}

fn recovery_log_entry_from_payload(entry: &Value) -> Value {
    json!({
        "id": value_field_str(entry, "id").unwrap_or_else(|| Uuid::new_v4().to_string()),
        "actionId": value_field_str(entry, "actionId").unwrap_or_default(),
        "issueCode": value_field_str(entry, "issueCode").unwrap_or_default(),
        "success": entry.get("success").and_then(Value::as_bool).unwrap_or(false),
        "timestamp": value_field_str(entry, "timestamp")
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        "recipeId": value_field_str(entry, "recipeId"),
        "recipeVersion": value_field_i64(entry, "recipeVersion"),
        "snapshotPointId": value_field_str(entry, "snapshotPointId"),
        "exportPath": value_field_str(entry, "exportPath"),
        "message": value_field_str(entry, "message"),
        "errorMessage": value_field_str(entry, "errorMessage"),
        "actor": {
            "staffId": nested_field_str(entry, "actor", "staffId"),
            "staffName": nested_field_str(entry, "actor", "staffName"),
        },
        "targetRefs": {
            "entityId": nested_field_str(entry, "targetRefs", "entityId"),
            "orderId": nested_field_str(entry, "targetRefs", "orderId"),
            "orderNumber": nested_field_str(entry, "targetRefs", "orderNumber"),
            "shiftId": nested_field_str(entry, "targetRefs", "shiftId"),
        },
    })
}

async fn guarded_renderer_db_mutation<T>(
    db: &db::DbState,
    sync_state: &sync::SyncState,
    cancellation: &tokio_util::sync::CancellationToken,
    mutation: impl FnOnce(&db::DbState) -> Result<T, String>,
) -> Result<T, String> {
    let context = sync::RendererParityExecutionContext::new(db, sync_state, cancellation).await?;
    let _lease = context.acquire_step_lease()?;
    mutation(db)
}

fn failed_payment_total_conflict_for_payment(
    conn: &rusqlite::Connection,
    payment_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT error_message
         FROM parity_sync_queue
         WHERE table_name = 'payments'
           AND record_id = ?1
           AND COALESCE(module_type, '') <> 'repairs'
           AND table_name NOT IN ('repairs', 'repair_attachments')
           AND status = 'failed'
           AND error_message IS NOT NULL
           AND lower(error_message) LIKE '%payment exceeds order total%'
         ORDER BY COALESCE(last_attempt, created_at) DESC, created_at DESC
         LIMIT 1",
        rusqlite::params![payment_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("load payment total conflict row: {e}"))
}

fn prepare_payment_total_conflict_repair(
    conn: &rusqlite::Connection,
    payment_id: &str,
) -> Result<(String, bool), String> {
    let local_order_id: String = conn
        .query_row(
            "SELECT order_id FROM order_payments WHERE id = ?1",
            rusqlite::params![payment_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("load payment repair context: {e}"))?;

    let queued_parent_order =
        sync::force_requeue_local_order_update_after_lagged_snapshot(conn, &local_order_id)?;
    let now = chrono::Utc::now().to_rfc3339();
    let payload = payments::build_payment_sync_payload_for_payment(conn, payment_id)?;
    sync::upsert_payment_sync_queue_row(
        conn, payment_id, &payload, "pending", 0, None, None, None, &now,
    )
    .map_err(|e| format!("requeue repaired payment parity row: {e}"))?;

    Ok((local_order_id, queued_parent_order))
}

fn format_cents(cents: i64) -> String {
    format!("{:.2}", cents as f64 / 100.0)
}

fn load_payment_settlement_equation(
    conn: &rusqlite::Connection,
    payment_id: &str,
) -> Result<Option<String>, String> {
    let row: Option<(i64, i64, i64)> = conn
        .query_row(
            "SELECT COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0),
                    COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER), 0),
                    COALESCE((
                        SELECT SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER), 0))
                        FROM payment_adjustments pa
                        WHERE pa.payment_id = op.id
                          AND pa.order_id = op.order_id
                          AND pa.adjustment_type = 'refund'
                          AND COALESCE(pa.adjustment_context, '') = 'edit_settlement'
                    ), 0)
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE op.id = ?1",
            rusqlite::params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("load payment settlement equation: {e}"))?;

    let Some((payment_cents, order_total_cents, refund_cents)) = row else {
        return Ok(None);
    };
    if refund_cents <= 0 {
        return Ok(Some(format!(
            "{} - 0.00 = {}; local order total {}",
            format_cents(payment_cents),
            format_cents(payment_cents),
            format_cents(order_total_cents),
        )));
    }
    Ok(Some(format!(
        "{} - {} = {}; local order total {}",
        format_cents(payment_cents),
        format_cents(refund_cents),
        format_cents(payment_cents - refund_cents),
        format_cents(order_total_cents),
    )))
}

fn promote_waiting_settlement_refunds_for_payment(
    conn: &rusqlite::Connection,
    payment_id: &str,
) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "SELECT pa.id
             FROM payment_adjustments pa
             JOIN order_payments op ON op.id = pa.payment_id
             WHERE pa.payment_id = ?1
               AND pa.sync_state = 'waiting_parent'
               AND pa.adjustment_type = 'refund'
               AND COALESCE(pa.adjustment_context, '') = 'edit_settlement'
               AND op.sync_state = 'applied'
               AND NULLIF(TRIM(COALESCE(op.remote_payment_id, '')), '') IS NOT NULL",
        )
        .map_err(|e| format!("prepare waiting settlement refunds: {e}"))?;

    let adjustment_ids: Vec<String> = stmt
        .query_map(rusqlite::params![payment_id], |row| row.get(0))
        .map_err(|e| format!("query waiting settlement refunds: {e}"))?
        .filter_map(Result::ok)
        .collect();
    drop(stmt);

    let now = chrono::Utc::now().to_rfc3339();
    let mut promoted = 0usize;
    for adjustment_id in adjustment_ids {
        let updated = conn
            .execute(
                "UPDATE payment_adjustments
                 SET sync_state = 'pending',
                     sync_retry_count = 0,
                     sync_last_error = NULL,
                     sync_next_retry_at = NULL,
                     updated_at = ?1
                 WHERE id = ?2
                   AND sync_state = 'waiting_parent'",
                rusqlite::params![now, adjustment_id.as_str()],
            )
            .map_err(|e| format!("promote waiting settlement refund: {e}"))?;
        if updated == 0 {
            continue;
        }
        promoted += 1;

        let _ = conn.execute(
            &format!(
                "UPDATE parity_sync_queue
                 SET status = 'pending',
                     attempts = 0,
                     last_attempt = NULL,
                     error_message = NULL,
                     next_retry_at = NULL,
                     retry_delay_ms = 1000,
                     priority = CASE WHEN priority > 1 THEN priority ELSE 1 END,
                     claim_generation = claim_generation + 1
                 WHERE table_name = 'payment_adjustments'
                   AND record_id = ?1
                   AND COALESCE(module_type, '') <> 'repairs'
                   AND table_name NOT IN ('repairs', 'repair_attachments')
                   AND status IN ('pending', 'processing', 'failed', 'conflict')
                   AND {}",
                crate::sync_queue::set_aside_exclusion_sql("parity_sync_queue")
            ),
            rusqlite::params![adjustment_id.as_str()],
        );
    }

    Ok(promoted)
}

fn sanitize_invalid_driver_order_payload(raw: &str) -> Result<String, String> {
    let mut payload: Value =
        serde_json::from_str(raw).map_err(|e| format!("parse order parity payload: {e}"))?;
    let Some(object) = payload.as_object_mut() else {
        return Ok(raw.to_string());
    };

    object.remove("driverId");
    object.remove("driver_id");

    Ok(payload.to_string())
}

fn prepare_invalid_driver_order_repair(
    conn: &rusqlite::Connection,
    item_id: &str,
) -> Result<String, String> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT record_id, data, COALESCE(error_message, '')
             FROM parity_sync_queue
             WHERE id = ?1
               AND table_name = 'orders'
               AND operation = 'UPDATE'
               AND COALESCE(module_type, '') <> 'repairs'
               AND table_name NOT IN ('repairs', 'repair_attachments')",
            rusqlite::params![item_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("load invalid-driver order parity row: {e}"))?;

    let Some((order_id, data, error_message)) = row else {
        return Err("Invalid-driver order parity row was not found".to_string());
    };
    if !error_message
        .to_ascii_lowercase()
        .contains("invalid driver")
    {
        return Err("Selected order parity row is not blocked by an invalid driver".to_string());
    }

    let sanitized = sanitize_invalid_driver_order_payload(&data)?;
    conn.execute(
        &format!(
            "UPDATE parity_sync_queue
             SET data = ?1,
                 status = 'pending',
                 attempts = 0,
                 last_attempt = NULL,
                 error_message = NULL,
                 next_retry_at = NULL,
                 retry_delay_ms = 1000,
                 priority = CASE WHEN priority > 2 THEN priority ELSE 2 END,
                 claim_generation = claim_generation + 1
             WHERE id = ?2
               AND table_name = 'orders'
               AND operation = 'UPDATE'
               AND COALESCE(module_type, '') <> 'repairs'
               AND table_name NOT IN ('repairs', 'repair_attachments')
               AND {}",
            crate::sync_queue::set_aside_exclusion_sql("parity_sync_queue")
        ),
        rusqlite::params![sanitized, item_id],
    )
    .map_err(|e| format!("requeue invalid-driver order parity row: {e}"))?;

    Ok(order_id)
}

#[tauri::command]
pub async fn recovery_list_points(
    app: tauri::AppHandle,
) -> Result<recovery::RecoveryListResponse, String> {
    run_blocking_command("recovery_list_points", move || {
        let db = app.state::<db::DbState>();
        let points = recovery::list_recovery_points(&db)?;
        Ok(recovery::RecoveryListResponse {
            success: true,
            points,
        })
    })
    .await
}

#[tauri::command]
pub async fn recovery_create_snapshot(
    app: tauri::AppHandle,
) -> Result<recovery::RecoveryPointMetadata, String> {
    run_blocking_command("recovery_create_snapshot", move || {
        let db = app.state::<db::DbState>();
        recovery::create_manual_snapshot(&db)
    })
    .await
}

#[tauri::command]
pub async fn recovery_create_pre_action_snapshot(
    app: tauri::AppHandle,
) -> Result<recovery::RecoveryPointMetadata, String> {
    run_blocking_command("recovery_create_pre_action_snapshot", move || {
        let db = app.state::<db::DbState>();
        recovery::create_health_pre_action_snapshot(&db)
    })
    .await
}

#[tauri::command]
pub async fn recovery_record_action_log(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    run_blocking_command("recovery_record_action_log", move || {
        let db = app.state::<db::DbState>();
        let mut raw_entry = arg0.ok_or_else(|| "Missing recovery action log entry".to_string())?;
        if raw_entry.get("nativeOrderCorrection").is_some() || raw_entry.get("automatic").is_some() || raw_entry.get("automaticIntent").is_some() {
            return Err("Native correction evidence cannot be supplied by the renderer".into());
        }
        if raw_entry["issueCode"] == "customer_correction_refused" {
            if raw_entry["outcome"] == "failed" {
                let reason = raw_entry["errorMessage"].as_str().unwrap_or_default();
                let code = crate::order_notice_evidence::machine_code(reason);
                raw_entry["errorMessage"] = json!(
                    crate::support::critical_op::preemption_evidence(reason)
                        .map_or(code.clone(), |kind| format!("{code}: {kind}"))
                );
            } else {
                raw_entry["errorMessage"] = Value::Null;
            }
        }
        let entry = recovery_log_entry_from_payload(&raw_entry);
        let target_refs = entry
            .get("targetRefs")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let actor = entry.get("actor").cloned().unwrap_or_else(|| json!({}));
        let id = value_field_str(&entry, "id").unwrap_or_else(|| Uuid::new_v4().to_string());
        let action_id = value_field_str(&entry, "actionId").unwrap_or_default();
        let issue_code = value_field_str(&entry, "issueCode").unwrap_or_default();
        let timestamp =
            value_field_str(&entry, "timestamp").unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let success = entry
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
        let native: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM recovery_action_log WHERE id=?1 AND (json_extract(payload_json,'$.nativeOrderCorrection')=1 OR json_extract(payload_json,'$.automaticIntent')=1))", [&id], |r|r.get(0)).map_err(|e|e.to_string())?;
        if native { return Err("Native correction evidence cannot be replaced".into()); }
        raw_entry = crate::incident_reporting::recipe_audit_scope(&conn, raw_entry);
        let payload_json = serde_json::to_string(&raw_entry)
            .map_err(|e| format!("serialize recovery log: {e}"))?;
        conn.execute(
            "INSERT OR REPLACE INTO recovery_action_log (
            id, action_id, issue_code, issue_id, recipe_id, recipe_version,
            entity_type, entity_id, order_id, order_number, shift_id, queue_id,
            snapshot_point_id, export_path, success, message, error_message,
            actor_staff_id, actor_staff_name, payload_json, created_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17,
            ?18, ?19, ?20, ?21
         )",
            rusqlite::params![
                id,
                action_id,
                issue_code,
                value_field_str(&raw_entry, "issueId"),
                value_field_str(&entry, "recipeId"),
                value_field_i64(&entry, "recipeVersion"),
                value_field_str(&raw_entry, "entityType"),
                value_field_str(&target_refs, "entityId"),
                value_field_str(&target_refs, "orderId"),
                value_field_str(&target_refs, "orderNumber"),
                value_field_str(&target_refs, "shiftId"),
                value_field_i64(&raw_entry, "queueId"),
                value_field_str(&entry, "snapshotPointId"),
                value_field_str(&entry, "exportPath"),
                if success { 1 } else { 0 },
                value_field_str(&entry, "message"),
                value_field_str(&entry, "errorMessage"),
                value_field_str(&actor, "staffId"),
                value_field_str(&actor, "staffName"),
                payload_json,
                timestamp,
            ],
        )
        .map_err(|e| format!("record recovery action log: {e}"))?;

        Ok(entry)
    })
    .await
}

/// Recovery scheduling is not healing. Expose only the shipped outcome enum;
/// malformed/legacy payloads retain the existing response without an outcome.
fn recovery_action_log_outcome(payload_json: Option<&str>) -> Option<String> {
    let payload: Value = serde_json::from_str(payload_json?).ok()?;
    let outcome = payload.get("outcome")?.as_str()?;
    matches!(outcome, "pending" | "failed" | "unknown" | "resolved").then(|| outcome.to_string())
}

#[tauri::command]
pub async fn recovery_list_action_log(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    run_blocking_command("recovery_list_action_log", move || {
        let db = app.state::<db::DbState>();
        let limit = arg0
            .as_ref()
            .and_then(|value| value_field_i64(value, "limit"))
            .unwrap_or(25)
            .clamp(1, 100);
        let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT
                id, action_id, issue_code, success, created_at, recipe_id,
                recipe_version, snapshot_point_id, export_path, message,
                error_message, actor_staff_id, actor_staff_name, entity_id,
                order_id, order_number, shift_id, payload_json
             FROM recovery_action_log
             ORDER BY created_at DESC
             LIMIT ?1",
            )
            .map_err(|e| format!("prepare recovery action log list: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![limit], |row| {
                let success: i64 = row.get(3)?;
                let mut entry = json!({
                    "id": row.get::<_, String>(0)?,
                    "actionId": row.get::<_, String>(1)?,
                    "issueCode": row.get::<_, String>(2)?,
                    "success": success != 0,
                    "timestamp": row.get::<_, String>(4)?,
                    "recipeId": row.get::<_, Option<String>>(5)?,
                    "recipeVersion": row.get::<_, Option<i64>>(6)?,
                    "snapshotPointId": row.get::<_, Option<String>>(7)?,
                    "exportPath": row.get::<_, Option<String>>(8)?,
                    "message": row.get::<_, Option<String>>(9)?,
                    "errorMessage": row.get::<_, Option<String>>(10)?,
                    "actor": {
                        "staffId": row.get::<_, Option<String>>(11)?,
                        "staffName": row.get::<_, Option<String>>(12)?,
                    },
                    "targetRefs": {
                        "entityId": row.get::<_, Option<String>>(13)?,
                        "orderId": row.get::<_, Option<String>>(14)?,
                        "orderNumber": row.get::<_, Option<String>>(15)?,
                        "shiftId": row.get::<_, Option<String>>(16)?,
                    },
                });
                let payload_json: Option<String> = row.get(17)?;
                if let Some(outcome) = recovery_action_log_outcome(payload_json.as_deref()) {
                    entry["outcome"] = Value::String(outcome);
                }
                Ok(entry)
            })
            .map_err(|e| format!("query recovery action log: {e}"))?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| format!("read recovery action log row: {e}"))?);
        }

        Ok(Value::Array(entries))
    })
    .await
}

#[tauri::command]
pub async fn recovery_export_current(
    app: tauri::AppHandle,
) -> Result<recovery::RecoveryExportResponse, auth::GuardedCommandError> {
    run_blocking_command("recovery_export_current", move || {
        let db = app.state::<db::DbState>();
        let auth_state = app.state::<auth::AuthState>();
        auth::authorize_privileged_action(
            auth::PrivilegedActionScope::SystemControl,
            &db,
            &auth_state,
        )?;
        recovery::export_current_bundle(&db).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn recovery_export_point(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<recovery::RecoveryExportResponse, auth::GuardedCommandError> {
    run_blocking_command("recovery_export_point", move || {
        let db = app.state::<db::DbState>();
        let auth_state = app.state::<auth::AuthState>();
        auth::authorize_privileged_action(
            auth::PrivilegedActionScope::SystemControl,
            &db,
            &auth_state,
        )?;
        let point_id = parse_point_id(arg0)?;
        recovery::export_recovery_point(&db, &point_id).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn recovery_restore_point(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<recovery::RecoveryRestoreResponse, auth::GuardedCommandError> {
    run_blocking_command("recovery_restore_point", move || {
        let db = app.state::<db::DbState>();
        let auth_state = app.state::<auth::AuthState>();
        auth::authorize_privileged_action(
            auth::PrivilegedActionScope::SystemControl,
            &db,
            &auth_state,
        )?;
        let point_id = parse_point_id(arg0)?;
        recovery::stage_restore_from_point(&db, &point_id).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn recovery_open_dir(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    run_blocking_command("recovery_open_dir", move || {
        let db = app.state::<db::DbState>();
        let app_data_dir = db
            .db_path
            .parent()
            .ok_or_else(|| "database path does not have a parent directory".to_string())?;
        let recovery_root = recovery::recovery_root_for_app_data(app_data_dir);
        let requested_path = parse_open_dir_payload(arg0);
        let target = if let Some(requested_path) = requested_path {
            let candidate = std::path::PathBuf::from(&requested_path);
            let normalized = if candidate.is_file() {
                candidate
                    .parent()
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| recovery_root.clone())
            } else {
                candidate
            };
            if !normalized.starts_with(&recovery_root) {
                return Err("Recovery path must stay inside the recovery directory".into());
            }
            normalized
        } else {
            recovery_root.clone()
        };

        if !target.exists() {
            return Err(format!(
                "Recovery directory does not exist: {}",
                target.display()
            ));
        }

        open_directory(&target)?;
        Ok(serde_json::json!({
            "success": true,
            "path": target.to_string_lossy().to_string(),
        }))
    })
    .await
}

#[tauri::command]
pub async fn recovery_execute_action(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
    sync_state: tauri::State<'_, std::sync::Arc<sync::SyncState>>,
    cancellation: tauri::State<'_, tokio_util::sync::CancellationToken>,
    app: tauri::AppHandle,
) -> Result<Value, auth::GuardedCommandError> {
    let _action = crate::support::remedies::action_gate().try_begin()?;
    let support_authorized = if let Some(request) =
        arg0.as_ref().filter(|r| r["source"] == "remote_support")
    {
        let native = app.clone();
        let request = request.clone();
        crate::database_lock::run_blocking_command("recovery_health_action_admission", move || {
            crate::support::remedy_run::authorize_execution(&native, &request)
        })
        .await?;
        true
    } else {
        false
    };
    if let Some(request) = arg0
        .as_ref()
        .filter(|r| r["actionId"] == "restoreLastKnownPrinterBrand")
    {
        let request = request.clone();
        return run_blocking_command("recovery_restore_printer_brand", move || {
            let db = app.state::<db::DbState>();
            if request["recipeId"] != crate::printers::restore_brand::RECIPE_ID
                || request["recipeVersion"] != crate::printers::restore_brand::RECIPE_VERSION
            {
                return Err(auth::GuardedCommandError::from("PAYLOAD_MISMATCH"));
            }
            let reference: crate::support::catalogue::contract::ConfiguredPrinterRef =
                serde_json::from_value(request["params"]["configuredPrinterRef"].clone())
                    .map_err(|_| "REMEDY_NOT_APPLICABLE")?;
            if request["entityId"] != reference.id {
                return Err("PAYLOAD_MISMATCH".into());
            }
            crate::printers::restore_brand::restore_last_known_brand(&db, &reference)
                .map_err(Into::into)
        })
        .await;
    }
    if let Some(request) = arg0
        .as_ref()
        .filter(|r| matches!(r["actionId"].as_str(), Some("printerReprobe" | "testPrint")))
    {
        // Admission takes the database lock, so it runs on the blocking pool
        // with state re-acquired from the AppHandle, never on a runtime worker.
        let admission_app = app.clone();
        let admission_request = request.clone();
        let id = crate::database_lock::run_blocking_command(
            "recovery_health_action_admission",
            move || -> Result<String, auth::GuardedCommandError> {
                let db = admission_app.state::<db::DbState>();
                let auth_state = admission_app.state::<auth::AuthState>();
                {
                    let conn = db.conn.lock().map_err(|_| "REMEDY_NOT_APPLICABLE")?;
                    let health = crate::support::collectors::health::collect(&conn)?;
                    health_action_admission(
                        &conn,
                        &admission_request,
                        chrono::Utc::now().timestamp_millis(),
                        health["last_observation_ok"] != true,
                        crate::support::critical_op::global().active(),
                    )?;
                }
                if admission_request["source"] == "remote_support" {
                    crate::support::remedy_run::authorize_recovery_cash_drawer(
                        &admission_app,
                        admission_request["sessionId"]
                            .as_str()
                            .ok_or("PAYLOAD_MISMATCH")?,
                    )?;
                } else {
                    auth::authorize_privileged_action(
                        auth::PrivilegedActionScope::CashDrawerControl,
                        &db,
                        &auth_state,
                    )?;
                }
                // Health's defaultProfile is a display name, not a database identifier.
                // Resolve it through the same receipt-profile owner as manual printing.
                let profile =
                    crate::printers::resolve_printer_profile_for_role(&db, None, Some("receipt"))?
                        .ok_or("REMEDY_NOT_APPLICABLE")?;
                Ok(profile["id"]
                    .as_str()
                    .ok_or("REMEDY_NOT_APPLICABLE")?
                    .to_string())
            },
        )
        .await?;
        return match request["actionId"].as_str() {
            Some("printerReprobe") => {
                let status =
                    super::print::printer_get_status(Some(json!({"printerId":id})), db, app)
                        .await?;
                Ok(
                    json!({"success":status["connected"] == true,"requiresRefresh":true,"verification":{"status":"pending"}}),
                )
            }
            Some("testPrint") => {
                // printer_test always builds its own fixed TransportText sample.
                let response =
                    super::print::printer_test(Some(json!({"printerId":id})), db, app).await?;
                let response =
                    serde_json::to_value(response).map_err(|_| "REMEDY_NOT_APPLICABLE")?;
                Ok(
                    json!({"success":response["success"] == true,"requiresRefresh":true,"verification":{"status":"pending"}}),
                )
            }
            _ => unreachable!(),
        };
    }
    if arg0.as_ref().is_some_and(|request| {
        matches!(
            request["actionId"].as_str(),
            Some(
                "nativeCustomerAddressDefaultRetry"
                    | "resendOrderCustomerCorrection"
                    | "keepServerOrderCustomerDetails"
            )
        )
    }) {
        // The address owner takes business locks, including its local-mutation
        // fence. Keep the whole local action on the blocking pool.
        return run_blocking_command("recovery_address_retry", move || {
            let db = app.state::<db::DbState>();
            let auth = app.state::<auth::AuthState>();
            let sync = app.state::<std::sync::Arc<sync::SyncState>>();
            let cancellation = app.state::<tokio_util::sync::CancellationToken>();
            recovery_execute_action_on_blocking_worker(
                arg0,
                support_authorized,
                &db,
                &auth,
                &sync,
                &cancellation,
                &app,
            )
        })
        .await;
    }
    recovery_execute_action_core(
        arg0,
        false,
        db.inner(),
        auth_state.inner(),
        sync_state.inner(),
        cancellation.inner(),
        &app,
    )
    .await
}

fn recovery_execute_action_on_blocking_worker(
    request: Option<Value>,
    support_authorized: bool,
    db: &db::DbState,
    auth: &auth::AuthState,
    sync: &std::sync::Arc<sync::SyncState>,
    cancellation: &tokio_util::sync::CancellationToken,
    app: &impl TerminalEventSink,
) -> Result<Value, auth::GuardedCommandError> {
    tauri::async_runtime::block_on(recovery_execute_action_core(
        request,
        support_authorized,
        db,
        auth,
        sync,
        cancellation,
        app,
    ))
}

/// The server's refusal to force-close a phone (child terminal) shift: it
/// must be closed through remote checkout, which counts its cash.
const PHONE_SHIFT_REMOTE_CHECKOUT_REQUIRED: &str = "PHONE_SHIFT_REMOTE_CHECKOUT_REQUIRED";

/// Both entry points use the shipped policy and the native recipe owner's
/// persisted guard; source/session attribution never grants eligibility.
pub(crate) fn health_action_admission(
    conn: &rusqlite::Connection,
    request: &Value,
    now: i64,
    stale: bool,
    busy: bool,
) -> Result<&'static crate::support::remedies::Remedy, String> {
    use crate::support::remedies::{self, Match};
    let action = request["actionId"].as_str().ok_or("INVALID_INPUT")?;
    let id = match (request["recipeId"].as_str(), action) {
        (Some(id), _) => id,
        (None, "nativeCustomerAddressDefaultRetry") => "customer-address-default.retry",
        (None, "printerReprobe") => "printerReprobe",
        (None, "testPrint") => "testPrint",
        _ => return Err("REMEDY_NOT_APPLICABLE".into()),
    };
    let r = remedies::recipe(id, request["recipeVersion"].as_u64().unwrap_or(1))?;
    if r.action_id != action {
        return Err("PAYLOAD_MISMATCH".into());
    }
    let m = Match {
        matches_now: json!(true),
        target_count: 1,
        ..Default::default()
    };
    let target = if action == "nativeCustomerAddressDefaultRetry" {
        request["params"]["sampleItemId"]
            .as_str()
            .or_else(|| request["entityId"].as_str())
    } else {
        request["entityId"].as_str()
    };
    remedies::eligible(r, &m, &remedies::budget(conn, r, target)?, now, stale, busy)?;
    Ok(r)
}

fn require_pre_action_snapshot(db: &db::DbState, request: &Value) -> Result<(), String> {
    let id = request["snapshotPointId"]
        .as_str()
        .ok_or("SNAPSHOT_FAILED")?;
    if !recovery::list_recovery_points(db)
        .map_err(|_| "SNAPSHOT_FAILED")?
        .iter()
        .any(|point| {
            point.id == id
                && point.kind == recovery::RecoveryPointKind::PreRecoveryAction
                && std::path::Path::new(&point.snapshot_path).is_file()
        })
    {
        return Err("SNAPSHOT_FAILED".into());
    }
    Ok(())
}

fn correct_platform_drawer_rows(
    tx: &rusqlite::Connection,
    order_id: &str,
) -> Result<Value, String> {
    let drawer_rows = payments::platform_held_drawer_payment_ids(tx, order_id)?;
    if drawer_rows.is_empty() {
        return Err("PLATFORM_MISMATCH_NOT_ELIGIBLE".into());
    }
    let mut changed_ids = Vec::with_capacity(drawer_rows.len() * 2);
    for payment_id in &drawer_rows {
        let result = crate::refunds::void_payment_with_adjustment_in_transaction(
            tx,
            payment_id,
            PLATFORM_MISMATCH_VOID_REASON,
            None,
            None,
        )?;
        let adjustment_id = result["adjustmentId"]
            .as_str()
            .ok_or("PLATFORM_VOID_NOT_VERIFIED")?;
        let verified: bool = tx
            .query_row(
                "SELECT EXISTS (
                SELECT 1 FROM order_payments p JOIN payment_adjustments a ON a.payment_id = p.id
                WHERE p.id = ?1 AND p.order_id = ?2 AND p.status = 'voided'
                  AND a.id = ?3 AND a.adjustment_type = 'void' AND a.reason = ?4
            )",
                rusqlite::params![
                    payment_id,
                    order_id,
                    adjustment_id,
                    PLATFORM_MISMATCH_VOID_REASON
                ],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !verified {
            return Err("PLATFORM_VOID_NOT_VERIFIED".into());
        }
        changed_ids.push(payment_id.clone());
        changed_ids.push(adjustment_id.to_owned());
    }
    let settled = payments::auto_settle_platform_order(tx, order_id)?;
    let settlement_ids = payments::verified_platform_settlement_ids(tx, order_id)?;
    if !payments::platform_held_drawer_payment_ids(tx, order_id)?.is_empty() {
        return Err("PLATFORM_VOID_NOT_VERIFIED".into());
    }
    if settled {
        changed_ids.extend(settlement_ids);
    }
    Ok(json!({
        "success": true, "requiresRefresh": true, "changedIds": changed_ids,
        "voidedPaymentIds": drawer_rows, "settlementRecorded": settled,
        "verification": {"status": "passed"}
    }))
}

fn requeue_legacy_sync_rows(conn: &rusqlite::Connection, request: &Value) -> Result<(), String> {
    if request["params"]["queueStatus"] == "conflict" {
        return Err("PARITY_ROWS_PARKED".into());
    }
    if request["params"]["queueOwner"]
        .as_str()
        .is_some_and(|owner| owner != "sync_queue")
    {
        return Err("PARITY_WRONG_QUEUE_OWNER".into());
    }
    let id = request["queueId"].as_i64().ok_or_else(|| {
        if request["issueCode"] == "UNKNOWN_CONFLICT_REVIEW" {
            "PARITY_ROWS_PARKED"
        } else {
            "PARITY_EXACT_QUEUE_ID_REQUIRED"
        }
    })?;
    let entity = request["entityId"].as_str();
    let entity_type = request["entityType"].as_str();
    let count = conn
        .execute(
            "UPDATE sync_queue SET status='pending', retry_count=0, updated_at=datetime('now')
         WHERE id=?1 AND entity_type IN ('order','z_report')
           AND status IN ('failed','blocked','deferred')
           AND (?2 IS NULL OR entity_id=?2) AND (?3 IS NULL OR entity_type=?3)",
            rusqlite::params![id, entity, entity_type],
        )
        .map_err(|_| "PARITY_LEGACY_REQUEUE_FAILED")?;
    if count != 1 {
        return Err("PARITY_NO_ROWS_REQUEUED".into());
    }
    let status: String = conn
        .query_row("SELECT status FROM sync_queue WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(|_| "PARITY_STATUS_UNAVAILABLE")?;
    if status != "pending" {
        return Err("PARITY_NO_ROWS_REQUEUED".into());
    }
    Ok(())
}

async fn recovery_execute_action_core(
    arg0: Option<Value>,
    support_authorized: bool,
    db: &db::DbState,
    auth_state: &auth::AuthState,
    sync_state: &std::sync::Arc<sync::SyncState>,
    cancellation: &tokio_util::sync::CancellationToken,
    app: &impl TerminalEventSink,
) -> Result<Value, auth::GuardedCommandError> {
    let request = arg0.ok_or_else(|| "Missing recovery action request".to_string())?;
    let action_id = request
        .get("actionId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match action_id {
        "resendOrderCustomerCorrection" | "keepServerOrderCustomerDetails" => {
            use crate::order_notice_recovery as owner;
            if !support_authorized {
                auth::authorize_health_drawer_action(db, auth_state)?;
            }
            require_pre_action_snapshot(db, &request)?;
            let snapshot = request["snapshotPointId"]
                .as_str()
                .ok_or("SNAPSHOT_FAILED")?;
            let permit = crate::support::critical_op::global()
                .try_begin_support_attributed(true, None)
                .map_err(crate::support::critical_op::attributed_refusal)?;
            let isolated = db::DbState {
                conn: std::sync::Mutex::new(owner::observer_connection(&db.db_path, true)?),
                db_path: db.db_path.clone(),
            };
            let db = &isolated;
            let (row, before) = {
                let conn = db.conn.lock().map_err(|_| "REMEDY_NOT_APPLICABLE")?;
                health_action_admission(
                    &conn,
                    &request,
                    chrono::Utc::now().timestamp_millis(),
                    false,
                    false,
                )?;
                let id = request["params"]["queueId"]
                    .as_str()
                    .or_else(|| request["entityId"].as_str())
                    .ok_or("REMEDY_NOT_APPLICABLE")?;
                let Some(row) = owner::refused(&conn, id)? else {
                    return Ok(
                        json!({"success":true,"requiresRefresh":true,"verification":{"status":"pending"}}),
                    );
                };
                let before = owner::capture(&conn, &row)?;
                (row, before)
            };
            let answer = owner::fetch_canonical(db, &before).await?;
            owner::verify(&before, &answer)?;
            let result = sync::guarded_renderer_local_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                |conn| {
                    let result = (|| {
                        let tx = permit.begin_write_nowait(conn)?;
                        let value = owner::apply(&tx, &row, &before, &answer, action_id, snapshot)?;
                        if permit.is_cancelled() {
                            return Err("CONCURRENT_OPERATION".into());
                        }
                        tx.commit().map_err(|e| e.to_string())?;
                        Ok(value)
                    })();
                    conn.progress_handler(0, None::<fn() -> bool>);
                    result
                },
            )
            .await;
            let result = result.map_err(|error| {
                if let Some(kind) = permit.preempted_by() {
                    kind.preemption_error()
                } else if error == "PREEMPTED_BY_CRITICAL_OPERATION" {
                    // SQLite admission also uses the generic error for a
                    // non-busy failure with no observed critical operation.
                    "ORDER_CORRECTION_WRITE_FAILED".to_string()
                } else {
                    error
                }
            })?;
            if let Ok(order) = sync::get_order_by_id(db, &row.order) {
                app.emit_json("order_realtime_update", order);
            }
            app.emit_json("order_sync_notices_changed", json!({}));
            Ok(result)
        }
        "nativeCustomerAddressDefaultRetry" => {
            {
                let conn = db.conn.lock().map_err(|_| "REMEDY_NOT_APPLICABLE")?;
                let health = crate::support::collectors::health::collect(&conn)?;
                health_action_admission(
                    &conn,
                    &request,
                    chrono::Utc::now().timestamp_millis(),
                    health["last_observation_ok"] != true,
                    crate::support::critical_op::global().active(),
                )?;
            }
            if !support_authorized {
                auth::authorize_health_drawer_action(db, auth_state)?;
            }
            let target = request["params"]["sampleItemId"]
                .as_str()
                .or_else(|| request["entityId"].as_str())
                .ok_or("REMEDY_NOT_APPLICABLE")?;
            let result = sync::guarded_renderer_local_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                |conn| sync_queue::schedule_customer_address_default_retry(conn, target),
            )
            .await?;
            if result.retried == 0 {
                return Err("REMEDY_NOT_APPLICABLE".into());
            }
            Ok(json!({"success":true,"requiresRefresh":true,"verification":{"status":"pending"}}))
        }
        "openConnectionSettings" => Ok(json!({
            "success": true,
            "requiresRefresh": false,
            "routeTarget": {
                "screen": "connectionSettings",
            },
        })),
        "openOrderPaymentFix" => {
            let order_id = request_field_str(&request, "orderId")
                .map(ToOwned::to_owned)
                .or_else(|| request_param_str(&request, "orderId"))
                .or_else(|| request_param_str(&request, "order_id"));
            let order_number = request_field_str(&request, "orderNumber")
                .map(ToOwned::to_owned)
                .or_else(|| request_param_str(&request, "orderNumber"))
                .or_else(|| request_param_str(&request, "order_number"));
            let reason_code = request_field_str(&request, "issueCode")
                .map(ToOwned::to_owned)
                .or_else(|| request_param_str(&request, "reasonCode"))
                .or_else(|| request_param_str(&request, "reason_code"));

            Ok(json!({
                "success": true,
                "requiresRefresh": false,
                "routeTarget": {
                    "screen": "orderPayment",
                    "orderId": order_id,
                    "orderNumber": order_number,
                    "params": {
                        "openPayment": true,
                        "reasonCode": reason_code,
                        "paymentMethod": request["routeTarget"]["params"]["paymentMethod"],
                    },
                },
                "message": "Opening the blocked order payment screen.",
            }))
        }
        "contactDev" | "contactOperator" => Err("INCIDENT_SENDER_REQUIRED".into()),
        "clearLegacyFinancialOrphan" => {
            let entity_type = request_field_str(&request, "entityType")
                .map(ToOwned::to_owned)
                .or_else(|| request_param_str(&request, "entityType"))
                .or_else(|| request_param_str(&request, "entity_type"))
                .ok_or("Missing entityType for legacy orphan cleanup")?;
            let entity_id = request_field_str(&request, "entityId")
                .map(ToOwned::to_owned)
                .or_else(|| request_param_str(&request, "entityId"))
                .or_else(|| request_param_str(&request, "entity_id"))
                .or_else(|| request_field_str(&request, "paymentId").map(ToOwned::to_owned))
                .or_else(|| request_param_str(&request, "paymentId"))
                .or_else(|| request_field_str(&request, "adjustmentId").map(ToOwned::to_owned))
                .or_else(|| request_param_str(&request, "adjustmentId"))
                .ok_or("Missing entityId for legacy orphan cleanup")?;

            info!(
                entity_type = %entity_type,
                entity_id = %entity_id,
                "Running local legacy financial parity orphan cleanup"
            );

            let orphan_rows =
                sync::count_legacy_financial_parity_orphan_rows(db, &entity_type, &entity_id)
                    .map_err(auth::GuardedCommandError::from)?;
            if orphan_rows == 0 {
                return Ok(json!({
                    "success": true,
                    "requiresRefresh": true,
                    "message": "No stale legacy financial rows remained for this issue.",
                }));
            }

            let result = sync::clear_legacy_financial_parity_orphan(db, &entity_type, &entity_id)
                .map_err(auth::GuardedCommandError::from)?;

            info!(
                entity_type = %entity_type,
                entity_id = %entity_id,
                cleared = result.cleared,
                "Completed local legacy financial parity orphan cleanup"
            );

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Cleared {} stale legacy financial parity row(s).",
                    result.cleared,
                ),
            }))
        }
        "clearAllLegacyFinancialOrphans" => {
            info!("Running bulk local legacy financial parity orphan cleanup");

            let result = sync::clear_all_legacy_financial_parity_orphans(db)
                .map_err(auth::GuardedCommandError::from)?;

            info!(
                scanned = result.scanned,
                cleared = result.cleared,
                skipped = result.skipped,
                "Completed bulk local legacy financial parity orphan cleanup"
            );

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Cleared {} stale legacy financial parity row(s). Skipped {} row(s) that still have local records.",
                    result.cleared,
                    result.skipped,
                ),
            }))
        }
        "openShiftRepair" | "forceCloseShift" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let shift_id = request
                .get("shiftId")
                .and_then(|v| v.as_str())
                .ok_or("Missing shiftId for shift repair action")?;

            let reason = request
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("Stuck shift recovery via POS");

            let body = json!({
                "shift_id": shift_id,
                "reason": reason,
            });

            let api_result = crate::admin_fetch_detailed(
                Some(db),
                "/api/pos/shifts/force-close",
                "POST",
                Some(body),
            )
            .await
            .map_err(|e| {
                // Phones hand over to the Main (founder rule 13/10/2026): the
                // server never force-closes a phone shift, which would zero
                // its cash. The code tells the operator to close it from
                // Staff on this register (remote checkout) instead.
                if e.status() == Some(409) && e.code() == Some(PHONE_SHIFT_REMOTE_CHECKOUT_REQUIRED)
                {
                    PHONE_SHIFT_REMOTE_CHECKOUT_REQUIRED.to_string()
                } else {
                    format!("Force-close API call failed: {e}")
                }
            })?;

            let api_success = api_result
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if !api_success {
                let api_error = api_result
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown server error");
                return Err(format!("Server rejected force-close: {api_error}").into());
            }

            // Update local SQLite to match
            let now = chrono::Utc::now().to_rfc3339();
            if let Ok(conn) = db.conn.lock() {
                let _ = conn.execute(
                    "UPDATE staff_shifts
                     SET status = 'abandoned',
                         check_out_time = ?1,
                         closing_cash_amount = 0,
                         expected_cash_amount = 0,
                         cash_variance = 0,
                         sync_status = 'synced',
                         updated_at = ?1
                     WHERE id = ?2",
                    rusqlite::params![now, shift_id],
                );

                // Close associated cash_drawer_sessions
                let _ = conn.execute(
                    "UPDATE cash_drawer_sessions
                     SET closed_at = ?1,
                         closing_amount = 0,
                         updated_at = ?1
                     WHERE staff_shift_id = ?2 AND closed_at IS NULL",
                    rusqlite::params![now, shift_id],
                );
            }

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": "Shift force-closed successfully",
            }))
        }

        "retrySync" => {
            if request["queueId"].as_i64().is_some() {
                require_pre_action_snapshot(db, &request)?;
            }
            let conn = db
                .conn
                .lock()
                .map_err(|_| "PARITY_LOCAL_STEP_UNAVAILABLE")?;
            requeue_legacy_sync_rows(&conn, &request)?;
            Ok(json!({
                "success": true, "requiresRefresh": true,
                "changedIds": [request["queueId"].to_string()],
                "targetOutcome": "untouched",
                "verification": {"status":"pending"}
            }))
        }
        "runParitySyncNow" => {
            let targets: Vec<String> = request["params"]["queueRowIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .take(sync_queue::MAX_ITEMS_BY_ID)
                .map(str::to_owned)
                .collect();
            if !targets.is_empty() {
                let context =
                    sync::RendererParityExecutionContext::new(db, sync_state, cancellation).await?;
                let before = context
                    .run_local_step(|conn| sync_queue::renderer_items_by_id(conn, &targets))?;
                let result = context
                    .process_queue(app, "recovery:run_parity_sync_now", true)
                    .await?;
                let target_outcomes = context.run_local_step(|conn| {
                    let after = sync_queue::renderer_items_by_id(conn, &targets)?;
                    targets
                        .iter()
                        .map(|id| {
                            let current = after.iter().find(|row| &row.id == id);
                            let previous = before.iter().find(|row| &row.id == id);
                            let outcome = if sync_queue::queue_row_is_set_aside(conn, id)? {
                                "set_aside"
                            } else {
                                match (previous, current) {
                                    (Some(_), None) if result.acknowledged_ids.contains(id) => {
                                        "sent"
                                    }
                                    (None, _) | (_, None) => "unknown",
                                    (_, Some(row))
                                        if row.status == "deferred"
                                            || row.error_message.as_deref().is_some_and(
                                                |text| {
                                                    text.to_ascii_lowercase()
                                                        .contains("waiting for")
                                                },
                                            ) =>
                                    {
                                        "waiting"
                                    }
                                    (Some(old), Some(row))
                                        if old.last_attempt != row.last_attempt
                                            && matches!(
                                                row.status.as_str(),
                                                "failed" | "conflict" | "dead_letter"
                                            ) =>
                                    {
                                        "refused"
                                    }
                                    _ => "untouched",
                                }
                            };
                            Ok(json!({"id":id, "outcome":outcome}))
                        })
                        .collect::<Result<Vec<_>, String>>()
                })?;
                let changed: Vec<_> = targets
                    .iter()
                    .filter(|id| result.acknowledged_ids.contains(id))
                    .collect();
                let sent = target_outcomes
                    .iter()
                    .all(|target| target["outcome"] == "sent");
                return Ok(json!({
                    "success":sent, "requiresRefresh":true, "changedIds":changed,
                    "targetOutcomes":target_outcomes,
                    "verification":{"status":if sent {"passed"} else {"pending"}}
                }));
            }
            let result = sync::process_renderer_parity_queue_guarded(
                db,
                sync_state.as_ref(),
                app,
                cancellation,
                "recovery:run_parity_sync_now",
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            let status = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                sync_queue::renderer_get_status(&conn)
            }
            .map_err(auth::GuardedCommandError::from)?;
            // Run normal queue maintenance, including payment mirrors, before
            // reporting that a parked-only pass had no rows to send.
            if result.processed == 0 && status.conflicts > 0 && status.total == status.conflicts {
                return Err("PARITY_ROWS_PARKED".into());
            }

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Parity sync processed {} item(s), failed {}, conflicts {}, remaining {}.",
                    result.processed,
                    result.failed,
                    result.conflicts,
                    status.total,
                ),
            }))
        }
        "repairPaymentTotalConflict" => {
            // Safe recovery only: this requeues the parent order update and the
            // known payment parity row. It does not void, delete, or mutate
            // drawer cash, so it must be available from Recovery Center even
            // when no staff shift session is active.
            let payment_id = request_field_str(&request, "paymentId")
                .map(ToOwned::to_owned)
                .or_else(|| request_param_str(&request, "paymentId"))
                .or_else(|| request_param_str(&request, "sampleRecordId"))
                .or_else(|| request_param_str(&request, "payment_id"))
                .or_else(|| request_field_str(&request, "entityId").map(ToOwned::to_owned))
                .ok_or_else(|| {
                    "Missing payment id for payment/order mismatch repair".to_string()
                })?;

            let (order_id, queued_parent_order) = sync::guarded_renderer_local_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                |conn| prepare_payment_total_conflict_repair(conn, payment_id.as_str()),
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;

            let result = sync::process_renderer_parity_queue_guarded(
                db,
                sync_state.as_ref(),
                app,
                cancellation,
                "recovery:repair_payment_total_conflict",
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            let promoted_adjustments = sync::guarded_renderer_local_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                |conn| promote_waiting_settlement_refunds_for_payment(conn, payment_id.as_str()),
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            let adjustment_result = if promoted_adjustments > 0 {
                Some(
                    sync::process_renderer_parity_queue_guarded(
                        db,
                        sync_state.as_ref(),
                        app,
                        cancellation,
                        "recovery:repair_payment_total_conflict_adjustment",
                    )
                    .await
                    .map_err(auth::GuardedCommandError::from)?,
                )
            } else {
                None
            };
            let remaining_conflict = {
                let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
                failed_payment_total_conflict_for_payment(&conn, payment_id.as_str())
                    .map_err(auth::GuardedCommandError::from)?
            };

            if let Some(error) = remaining_conflict {
                let equation = {
                    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
                    load_payment_settlement_equation(&conn, payment_id.as_str())
                        .map_err(auth::GuardedCommandError::from)?
                };
                return Err(format!(
                    "Payment/order mismatch still exists for payment {payment_id}: {error}. {}",
                    equation
                        .map(|value| format!("Settlement math: {value}."))
                        .unwrap_or_else(|| "Settlement math unavailable.".to_string())
                )
                .into());
            }

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Payment/order mismatch repair retried payment {payment_id} for order {order_id}. Parent order update queued: {}. Processed {}, failed {}, conflicts {}. Promoted refund adjustments: {}. Adjustment pass processed {}, failed {}, conflicts {}.",
                    if queued_parent_order { "yes" } else { "no" },
                    result.processed,
                    result.failed,
                    result.conflicts,
                    promoted_adjustments,
                    adjustment_result.as_ref().map(|value| value.processed).unwrap_or(0),
                    adjustment_result.as_ref().map(|value| value.failed).unwrap_or(0),
                    adjustment_result.as_ref().map(|value| value.conflicts).unwrap_or(0),
                ),
            }))
        }
        "repairInvalidDriverOrderUpdate" => {
            let item_id = request_param_str(&request, "sampleItemId")
                .or_else(|| request_field_str(&request, "queueId").map(ToOwned::to_owned))
                .ok_or_else(|| "Missing invalid-driver parity item id".to_string())?;
            let order_id = sync::guarded_renderer_local_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                |conn| prepare_invalid_driver_order_repair(conn, item_id.as_str()),
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;

            let result = sync::process_renderer_parity_queue_guarded(
                db,
                sync_state.as_ref(),
                app,
                cancellation,
                "recovery:repair_invalid_driver_order_update",
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            let status = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                sync_queue::renderer_get_status(&conn)
            }
            .map_err(auth::GuardedCommandError::from)?;

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Retried order {order_id} without replaying the stale driver id. Processed {}, failed {}, conflicts {}, remaining {}.",
                    result.processed,
                    result.failed,
                    result.conflicts,
                    status.total,
                ),
            }))
        }
        "repairOrderUpdateReplayBlockers" => {
            // Safe recovery only: this retries requests that provably never
            // left the POS because of the historical `https://https/...` URL,
            // then repairs failed order replays and their dependent payments.
            // It does not delete, void, or mutate local order/payment rows.
            let stats = sync::repair_order_update_replay_blockers(
                db,
                sync_state.as_ref(),
                app,
                cancellation,
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;

            if stats.remaining_parent_order_inserts > 0
                || stats.remaining_order_blockers > 0
                || stats.remaining_parent_wait_blockers > 0
            {
                return Err(format!(
                    "Order replay repair retried {} malformed-URL row(s), {} parent insert row(s), {} update row(s), repaired {} parent link(s), quarantined {} stale parent-wait row(s), and force-requeued {} settled table close row(s), but {} parent insert row(s) still fail, {} order update row(s) still fail, and {} row(s) still wait for a parent remote order. Last parent insert error: {} Last order error: {}{}",
                    stats.requeued_malformed_admin_url_failures,
                    stats.requeued_parent_order_inserts,
                    stats.requeued_orders,
                    stats.repaired_parent_orders,
                    stats.quarantined_stale_parent_wait_orders,
                    stats.forced_table_session_closes,
                    stats.remaining_parent_order_inserts,
                    stats.remaining_order_blockers,
                    stats.remaining_parent_wait_blockers,
                    stats
                        .last_parent_order_insert_error
                        .as_deref()
                        .unwrap_or("unknown"),
                    stats
                        .last_order_error
                        .as_deref()
                        .unwrap_or("unknown"),
                    stats
                        .last_parent_wait_error
                        .as_deref()
                        .map(|value| format!(" Last parent-wait error: {value}"))
                        .unwrap_or_default()
                )
                .into());
            }

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Order replay repair requeued {} malformed-URL row(s), requeued {} parent insert row(s), attached {} parent remote order link(s), requeued {} parent-wait row(s), quarantined {} stale parent-wait row(s), retried {} order update row(s), force-requeued {} settled table close row(s). Malformed-URL pass processed {}, failed {}, conflicts {}. Parent pass processed {}, failed {}, conflicts {}. Update pass processed {}, failed {}, conflicts {}. Promoted {} waiting payment(s). Payment pass processed {}, failed {}, conflicts {}. Table-close pass processed {}, failed {}, conflicts {}.",
                    stats.requeued_malformed_admin_url_failures,
                    stats.requeued_parent_order_inserts,
                    stats.repaired_parent_orders,
                    stats.requeued_parent_wait_orders,
                    stats.quarantined_stale_parent_wait_orders,
                    stats.requeued_orders,
                    stats.forced_table_session_closes,
                    stats.malformed_admin_url_pass.as_ref().map(|value| value.processed).unwrap_or(0),
                    stats.malformed_admin_url_pass.as_ref().map(|value| value.failed).unwrap_or(0),
                    stats.malformed_admin_url_pass.as_ref().map(|value| value.conflicts).unwrap_or(0),
                    stats.parent_insert_pass.as_ref().map(|value| value.processed).unwrap_or(0),
                    stats.parent_insert_pass.as_ref().map(|value| value.failed).unwrap_or(0),
                    stats.parent_insert_pass.as_ref().map(|value| value.conflicts).unwrap_or(0),
                    stats.first_pass.processed,
                    stats.first_pass.failed,
                    stats.first_pass.conflicts,
                    stats.promoted_payments,
                    stats.second_pass.as_ref().map(|value| value.processed).unwrap_or(0),
                    stats.second_pass.as_ref().map(|value| value.failed).unwrap_or(0),
                    stats.second_pass.as_ref().map(|value| value.conflicts).unwrap_or(0),
                    stats.table_session_pass.as_ref().map(|value| value.processed).unwrap_or(0),
                    stats.table_session_pass.as_ref().map(|value| value.failed).unwrap_or(0),
                    stats.table_session_pass.as_ref().map(|value| value.conflicts).unwrap_or(0),
                ),
            }))
        }
        "retryParityItem" => {
            let item_id = request_param_str(&request, "sampleItemId")
                .ok_or("PARITY_EXACT_QUEUE_ID_REQUIRED")?;
            if crate::table_close_recovery::confirm_selected_close(
                db,
                sync_state.as_ref(),
                cancellation,
                &item_id,
            )
            .await
            .map_err(auth::GuardedCommandError::from)?
            {
                return Ok(json!({"success":true,"requiresRefresh":true,
                    "verification":{"status":"passed"},
                    "message":"The original table close was confirmed as already completed. No payment or table was changed."}));
            }
            let result = sync::guarded_renderer_retry_item(
                db,
                sync_state.as_ref(),
                app,
                cancellation,
                "recovery:retry_parity_item",
                &item_id,
            )
            .await;
            let conn = db.conn.lock().map_err(|_| "PARITY_STATUS_UNAVAILABLE")?;
            if let Err(code) = &result {
                if code != "PARITY_SYNC_PARTIAL" && code != "PARITY_SYNC_FAILED" {
                    return Err(code.clone().into());
                }
            }
            let current: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT status, error_message FROM parity_sync_queue WHERE id=?1",
                    [&item_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|_| "PARITY_STATUS_UNAVAILABLE")?;
            let set_aside = sync_queue::queue_row_is_set_aside(&conn, &item_id)?;
            let target_outcome = if set_aside {
                "set_aside"
            } else {
                match current
                    .as_ref()
                    .map(|(status, error)| (status.as_str(), error.as_deref()))
                {
                    None if result
                        .as_ref()
                        .is_ok_and(|r| r.acknowledged_ids.contains(&item_id)) =>
                    {
                        "sent"
                    }
                    Some(("deferred", _)) => "waiting",
                    Some(("pending", Some(reason)))
                        if reason.to_ascii_lowercase().contains("waiting for") =>
                    {
                        "waiting"
                    }
                    Some(("conflict" | "failed" | "dead_letter", _)) => "refused",
                    _ if result.is_ok() => "untouched",
                    _ => return Err(result.err().unwrap().into()),
                }
            };
            let sent = target_outcome == "sent";
            Ok(json!({
                "success": sent, "requiresRefresh": true, "targetOutcome":target_outcome,
                "changedIds": if sent { vec![item_id] } else { vec![] },
                "verification": {"status": if sent {"passed"} else {"pending"}}
            }))
        }
        "repairPlatformSettlementMismatch" | "settlePlatformOrder" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            require_pre_action_snapshot(db, &request)?;
            let order_id = request_field_str(&request, "orderId")
                .map(ToOwned::to_owned)
                .or_else(|| request_param_str(&request, "orderId"))
                .ok_or("PLATFORM_ORDER_REQUIRED")?;
            let context =
                sync::RendererParityExecutionContext::new(db, sync_state, cancellation).await?;
            let _binding = context.acquire_step_lease()?;
            let permit = crate::support::critical_op::global()
                .try_begin_support(true, None)
                .map_err(|_| "CONCURRENT_OPERATION")?;
            let conn = crate::order_notice_recovery::observer_connection(&db.db_path, true)?;
            let tx = permit.begin_write_nowait(&conn)?;
            let result = if action_id == "repairPlatformSettlementMismatch" {
                correct_platform_drawer_rows(&tx, &order_id)?
            } else {
                if !payments::platform_held_drawer_payment_ids(&tx, &order_id)?.is_empty()
                    || !payments::auto_settle_platform_order(&tx, &order_id)?
                {
                    return Err("PLATFORM_SETTLEMENT_NOT_ELIGIBLE".into());
                }
                let ids = payments::verified_platform_settlement_ids(&tx, &order_id)?;
                json!({
                    "success": true, "requiresRefresh": true, "changedIds": ids,
                    "verification": {"status": "passed"}
                })
            };
            if permit.is_cancelled() || cancellation.is_cancelled() {
                return Err("CONCURRENT_OPERATION".into());
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok(result)
        }
        "resolveDuplicateCustomerConflict" => {
            // The office rejected this customer INSERT because it already holds
            // the phone, and told the operator to select that record
            // explicitly. Retry cannot do that — it is the same INSERT — so
            // this action makes the selection instead: one read of the office's
            // own record by phone, then the local copy adopts it and the dead
            // row leaves the queue. Nothing is written to the office.
            let item_id = request_param_str(&request, "sampleItemId")
                .or_else(|| request_param_str(&request, "queueItemId"))
                .or_else(|| request_field_str(&request, "entityId").map(ToOwned::to_owned))
                .ok_or_else(|| "Missing parity item id".to_string())?;
            let adoption = customers::resolve_duplicate_customer_conflict(
                db,
                sync_state.as_ref(),
                cancellation,
                item_id.as_str(),
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            let status = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                sync_queue::renderer_get_status(&conn)
            }
            .map_err(auth::GuardedCommandError::from)?;
            info!(
                item_id = %item_id,
                remote_customer_id = %adoption.remote_customer_id,
                local_record_id = %adoption.local_record_id,
                relinked_orders = adoption.relinked_orders,
                relinked_queue_rows = adoption.relinked_queue_rows,
                "Duplicate customer conflict resolved by adopting the office record"
            );
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "adoption": adoption,
                "message": format!(
                    "Linked this terminal to the existing customer {}: {} order(s) and {} queued row(s) now point at it, remaining {}.",
                    adoption.remote_customer_id,
                    adoption.relinked_orders,
                    adoption.relinked_queue_rows,
                    status.total,
                ),
            }))
        }
        "retryParityModule" => {
            let module_type = request_param_str(&request, "moduleType")
                .or_else(|| request_field_str(&request, "entityId").map(ToOwned::to_owned))
                .ok_or_else(|| "Missing parity module type".to_string())?;
            if module_type.eq_ignore_ascii_case("orders") {
                let stats = sync::repair_order_update_replay_blockers(
                    db,
                    sync_state.as_ref(),
                    app,
                    cancellation,
                )
                .await
                .map_err(auth::GuardedCommandError::from)?;
                let status = {
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    sync_queue::renderer_get_status(&conn)
                }
                .map_err(auth::GuardedCommandError::from)?;
                return Ok(json!({
                    "success": true,
                    "requiresRefresh": true,
                    "message": format!(
                        "Orders recovery retried {} parent insert row(s), {} update row(s), requeued {} parent-wait row(s), promoted {} payment(s). Processed {}, failed {}, conflicts {}, remaining {}.",
                        stats.requeued_parent_order_inserts,
                        stats.requeued_orders,
                        stats.requeued_parent_wait_orders,
                        stats.promoted_payments,
                        stats.parent_insert_pass.as_ref().map(|value| value.processed).unwrap_or(0)
                            + stats.first_pass.processed
                            + stats.second_pass.as_ref().map(|value| value.processed).unwrap_or(0),
                        stats.parent_insert_pass.as_ref().map(|value| value.failed).unwrap_or(0)
                            + stats.first_pass.failed
                            + stats.second_pass.as_ref().map(|value| value.failed).unwrap_or(0),
                        stats.parent_insert_pass.as_ref().map(|value| value.conflicts).unwrap_or(0)
                            + stats.first_pass.conflicts
                            + stats.second_pass.as_ref().map(|value| value.conflicts).unwrap_or(0),
                        status.total,
                    ),
                }));
            }
            let item_results = sync::guarded_renderer_retry_module(
                db,
                sync_state.as_ref(),
                app,
                cancellation,
                "recovery:retry_parity_module",
                module_type.as_str(),
                usize::MAX,
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            let retried = item_results.len();
            let processed: i64 = item_results.iter().map(|result| result.processed).sum();
            let failed: i64 = item_results.iter().map(|result| result.failed).sum();
            let conflicts: i64 = item_results.iter().map(|result| result.conflicts).sum();
            let status = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                sync_queue::renderer_get_status(&conn)
            }
            .map_err(auth::GuardedCommandError::from)?;

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Parity module {} retried {} item(s) now: processed {}, failed {}, conflicts {}, remaining {}.",
                    module_type,
                    retried,
                    processed,
                    failed,
                    conflicts,
                    status.total,
                ),
            }))
        }
        "validatePendingOrders" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let result =
                sync::validate_pending_orders(db).map_err(auth::GuardedCommandError::from)?;
            let total_pending = result
                .get("total_pending")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let invalid = result.get("invalid").and_then(Value::as_i64).unwrap_or(0);
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Validated {total_pending} pending order(s); {invalid} invalid row(s) still need removal.",
                ),
            }))
        }
        "removeInvalidOrders" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            require_pre_action_snapshot(db, &request)?;
            let snapshot_id = request["snapshotPointId"]
                .as_str()
                .ok_or("SNAPSHOT_FAILED")?;
            let rows: Vec<(i64, String)> =
                serde_json::from_value(request["params"]["invalidRows"].clone())
                    .map_err(|_| "INVALID_ORDER_PREVIEW_REQUIRED")?;
            if rows.is_empty() {
                return Err("INVALID_ORDER_PREVIEW_REQUIRED".into());
            }
            let permit = crate::support::critical_op::global()
                .try_begin_support(true, None)
                .map_err(|_| "CONCURRENT_OPERATION")?;
            let conn = crate::order_notice_recovery::observer_connection(&db.db_path, true)?;
            let tx = permit.begin_write_nowait(&conn)?;
            let ids = sync::remove_exact_invalid_order_rows(&tx, &rows, snapshot_id)?;
            for id in &ids {
                let exists: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sync_queue WHERE id=?1)",
                        [id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if exists {
                    return Err("INVALID_ORDER_REMOVAL_NOT_VERIFIED".into());
                }
            }
            if permit.is_cancelled() || cancellation.is_cancelled() {
                return Err("CONCURRENT_OPERATION".into());
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok(json!({"success":true, "requiresRefresh":true,
                "changedIds":ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
                "verification":{"status":"passed"}}))
        }
        "retryFinancialItem" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let queue_id = request_field_i64(&request, "queueId")
                .or_else(|| request_param_i64(&request, "queueId"))
                .ok_or_else(|| "Missing financial queue id".to_string())?;
            require_pre_action_snapshot(db, &request)?;
            let (selected_id, status) = sync::retry_financial_queue_item(db, queue_id)?;
            Ok(json!({
                "success": true, "requiresRefresh": true,
                "changedIds": [selected_id.to_string()],
                "targetOutcome": if status == "deferred" { "waiting" } else { "untouched" },
                "verification": {"status":"pending"}
            }))
        }
        "retryAllFailedFinancial" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let count: usize = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                let now = chrono::Utc::now().to_rfc3339();
                let count = conn.execute(
                    "UPDATE sync_queue
                     SET status = 'pending',
                         retry_count = 0,
                         last_error = NULL,
                         next_retry_at = NULL,
                         updated_at = ?1
                     WHERE status = 'failed'
                       AND entity_type IN ('payment_adjustment', 'shift_expense', 'staff_payment', 'driver_earning', 'driver_earnings')",
                    rusqlite::params![now],
                )
                .map_err(|e| e.to_string())?;
                if count > 0 {
                    let _ = conn.execute(
                        "UPDATE payment_adjustments
                         SET sync_state = 'pending',
                             sync_retry_count = 0,
                             sync_last_error = NULL,
                             sync_next_retry_at = NULL,
                             updated_at = ?1
                         WHERE id IN (
                             SELECT entity_id
                             FROM sync_queue
                             WHERE entity_type = 'payment_adjustment'
                               AND status = 'pending'
                               AND updated_at = ?1
                        )",
                        rusqlite::params![now],
                    );
                }
                count
            };

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {count} failed financial sync item(s)."),
            }))
        }
        "resolveCheckoutPaymentBlocker" => {
            auth::authorize_health_drawer_action(db, auth_state)?;

            let order_id = request_field_str(&request, "orderId")
                .map(ToOwned::to_owned)
                .ok_or_else(|| "Missing orderId for checkout payment repair".to_string())?;
            let preferred_method = request_param_str(&request, "preferredMethod")
                .or_else(|| request_param_str(&request, "paymentMethod"))
                .or_else(
                    || match request_param_str(&request, "reasonCode").as_deref() {
                        Some("missing_cash_payment") | Some("partial_cash_payment") => {
                            Some("cash".to_string())
                        }
                        Some("missing_card_payment") | Some("partial_card_payment") => {
                            Some("card".to_string())
                        }
                        _ => None,
                    },
                )
                .unwrap_or_else(|| "card".to_string());

            // Item F: the audit entry names who recorded it (`charged: false`).
            let session = auth::get_session_json(auth_state);
            let recorded_by = ["databaseStaffId", "staffId"].iter().find_map(|key| {
                session
                    .get(*key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            });
            let result = payments::resolve_unsettled_payment_blocker_payment(
                db,
                &json!({
                    "orderId": order_id,
                    "method": preferred_method,
                    "recordedBy": recorded_by,
                }),
            )
            .map_err(auth::GuardedCommandError::from)?;

            let success = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !success {
                let message = result
                    .get("error")
                    .and_then(Value::as_str)
                    .or_else(|| result.get("message").and_then(Value::as_str))
                    .unwrap_or("Failed to repair the missing payment record");
                return Err(message.to_string().into());
            }

            let order_number = request_field_str(&request, "orderNumber")
                .unwrap_or("the order")
                .to_string();
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Recorded the missing {} payment for {}.",
                    preferred_method,
                    order_number,
                ),
            }))
        }
        "repairOrphanedFinancial" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            Err("RECOVERY_ORPHANED_FINANCIAL_GUARDED_AUDIT_REQUIRED".into())
        }
        "repairWaitingParentPayments" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let repaired = guarded_renderer_db_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                sync::reconcile_deferred_payments,
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Promoted {repaired} waiting-parent payment(s) for retry."),
            }))
        }
        "repairWaitingParentAdjustments" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let repaired = guarded_renderer_db_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                sync::reconcile_deferred_adjustments,
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Promoted {repaired} waiting-parent adjustment(s) for retry."),
            }))
        }
        "requeueFailedOrderValidationRows" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let repaired = guarded_renderer_db_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                sync::requeue_failed_order_validation_rows,
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} failed order validation row(s)."),
            }))
        }
        "requeueRetryableFailedShiftRows" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let repaired = guarded_renderer_db_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                sync::requeue_retryable_failed_shift_rows,
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} retryable failed shift row(s)."),
            }))
        }
        "requeueFailedFinancialShiftRows" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let repaired = guarded_renderer_db_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                sync::requeue_failed_financial_shift_rows,
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} failed shift-bound financial row(s)."),
            }))
        }
        "requeueFailedShiftCashierReferenceRows" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let repaired = guarded_renderer_db_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                sync::requeue_failed_shift_cashier_reference_rows,
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} failed cashier-reference shift row(s)."),
            }))
        }
        "requeueFailedAdjustmentMissingEndpointRows" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let repaired = guarded_renderer_db_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                sync::requeue_failed_adjustment_missing_endpoint_rows,
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} adjustment row(s) blocked by the legacy endpoint error."),
            }))
        }
        "requeueFailedAdjustmentLegacyValidationRows" => {
            auth::authorize_health_drawer_action(db, auth_state)?;
            let repaired = guarded_renderer_db_mutation(
                db,
                sync_state.as_ref(),
                cancellation,
                sync::requeue_failed_adjustment_legacy_validation_rows,
            )
            .await
            .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} adjustment row(s) blocked by legacy validation."),
            }))
        }

        _ => Err(format!("Unknown recovery action: {action_id}").into()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use rusqlite::{types::ValueRef, Connection};
    use serde_json::json;

    #[test]
    fn recovery_action_log_outcome_preserves_pending_and_rejects_unrecognized_payloads() {
        for outcome in ["pending", "failed", "unknown", "resolved"] {
            let payload = json!({"outcome": outcome, "success": false}).to_string();
            assert_eq!(
                recovery_action_log_outcome(Some(&payload)).as_deref(),
                Some(outcome)
            );
        }
        for payload in [
            None,
            Some("bad-json"),
            Some("{}"),
            Some(r#"{"outcome":"scheduled"}"#),
            Some(r#"{"outcome":true}"#),
        ] {
            assert_eq!(recovery_action_log_outcome(payload), None);
        }
    }

    fn test_db() -> db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    #[derive(Default)]
    struct NoopTerminalEventSink;

    impl TerminalEventSink for NoopTerminalEventSink {
        fn emit_json(&self, _event: &str, _payload: serde_json::Value) {}
    }

    pub(crate) const TOMIKRO_ORDER: &str = "66666666-6666-4666-8666-666666666666";
    pub(crate) const TOMIKRO_QUEUE: &str = "77777777-7777-4777-8777-777777777777";
    const REMOTE_ORDER: &str = "5f0e3c1a-7a8d-4c3e-9a51-2d7c1f5e6b01";
    const TERMINAL: &str = "terminal-tomikro-fixture";

    pub(crate) fn order_notice_tomikro_fixture() -> (crate::tests::harness::TestDb, Value) {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        for (key, value) in [
            ("organization_id", "fixture-org"),
            ("branch_id", "fixture-branch"),
            ("terminal_id", TERMINAL),
        ] {
            db::set_setting(&conn, "terminal", key, value).unwrap();
        }
        let local_items = json!([{
            "id":"manual-1794879583843-z0t3gg2w0","isManual":true,"is_manual":true,
            "menuItemId":null,"menu_item_id":null,"name":"Manual line","menuItemName":"Manual line",
            "menu_item_name":"Manual line","quantity":1,"price":14.5,"unitPrice":14.5,"unit_price":14.5,
            "totalPrice":14.5,"total_price":14.5,"originalUnitPrice":14.5,"original_unit_price":14.5,
            "isPriceOverridden":false,"is_price_overridden":false,"customizations":[],
            "priceIncludesVat":true,"vatClass":"standard","fiscalDocumentProfile":"manual_item",
            "categoryPath":"Manual category","service_id":null,"appointment_id":null
        }]);
        let payload = json!({"client_event_id":"original-correction-event","customer_id":"33333333-3333-4333-8333-333333333333",
            "customer_name":"Corrected customer","customer_phone":"Corrected phone","delivery_address":"Corrected address",
            "delivery_floor":"2","delivery_notes":null,"expected_version":1,"name_on_ringer":"Corrected bell",
            "orderId":TOMIKRO_ORDER,"organization_id":"fixture-org","status":"pending"});
        conn.execute(
            "INSERT INTO orders(id,supabase_id,organization_id,branch_id,terminal_id,order_type,status,payment_status,
                sync_status,version,remote_version,total_amount,total_amount_cents,items,customer_id,customer_name,
                customer_phone,delivery_address,delivery_floor,delivery_notes,name_on_ringer,created_at,updated_at)
             VALUES(?1,?2,'fixture-org','fixture-branch',?3,'delivery','delivered','paid','synced',1,NULL,
                14.5,1450,?4,'33333333-3333-4333-8333-333333333333','Corrected customer','Corrected phone','Corrected address','2',NULL,
                'Corrected bell','2026-11-18T03:58:00Z','2026-11-18T04:13:12Z')",
            rusqlite::params![TOMIKRO_ORDER, REMOTE_ORDER, TERMINAL, local_items.to_string()]
        ).unwrap();
        conn.execute(
            "INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,sync_state,sync_status,remote_payment_id,created_at,updated_at)
             VALUES('fixture-payment',?1,'cash',14.50,1450,'EUR','completed','applied','synced','remote-fixture-payment',
                '2026-11-18T04:13:12Z','2026-11-18T04:13:12Z')", [TOMIKRO_ORDER]
        ).unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,status,
                error_message,attempts,created_at,conflict_strategy,version,module_type)
             VALUES(?1,'orders',?2,'UPDATE',?3,'fixture-org','conflict','UNKNOWN_CONFLICT_REVIEW',0,
                '2026-11-18T04:13:13Z','server-wins',1,'orders')",
            rusqlite::params![TOMIKRO_QUEUE, TOMIKRO_ORDER, payload.to_string()]
        ).unwrap();
        let mut order =
            crate::edit_settlement_recovery::capture_order_headers(&conn, TOMIKRO_ORDER).unwrap();
        // GET exact-order lookup returns the embedded rows and a normalized
        // items projection. The projection carries metadata but omits the
        // raw line's original_unit_price and is_price_overridden fields.
        let customizations = json!({"_meta":{"line_kind":"manual_item","category_id":null,
            "product_name":"Manual line","category_name":null}});
        let line_id = "22222222-2222-4222-8222-222222222222";
        let raw_line = json!({"id":line_id,"order_id":REMOTE_ORDER,"menu_item_id":null,"menu_item_name":"Manual line",
            "quantity":1,"unit_price":14.5,"total_price":14.5,"original_unit_price":14.5,"is_price_overridden":false,
            "notes":null,"customizations":customizations,"service_id":null,"appointment_id":null});
        let hydrated = json!({"id":line_id,"menu_item_id":null,"menuItemId":null,"menu_item_name":"Manual line",
            "menuItemName":"Manual line","name":"Manual line","quantity":1,"unit_price":14.5,"unitPrice":14.5,
            "price":14.5,"total_price":14.5,"totalPrice":14.5,"notes":null,"special_instructions":null,
            "customizations":customizations,"category_name":null,"categoryName":null,"category_path":null,"categoryPath":null});
        order.as_object_mut().unwrap().extend(json!({
            "id":REMOTE_ORDER,"client_order_id":TOMIKRO_ORDER,"organization_id":"fixture-org","branch_id":"fixture-branch",
            "status":"delivered","payment_status":"paid","version":4,"total_amount":14.5,"total_amount_cents":1450,
            "customer_name":"Earlier customer","customer_phone":"Earlier phone","delivery_address":"Earlier address",
            "name_on_ringer":"Earlier bell","notes":null,"special_instructions":null,"order_items":[raw_line],"items":[hydrated]
        }).as_object().unwrap().clone());
        drop(conn);
        (
            db,
            json!({"success":true,"orders":[order],"total_count":1,"has_more":false,"exact_order_lookup":true}),
        )
    }

    pub(crate) fn order_notice_tomikro_endpoint(url: &str) {
        use crate::tests::fake_keyring::set;
        set("terminal_id", TERMINAL);
        set("admin_dashboard_url", url);
        set(
            "pos_api_key",
            &json!({"key":"fixture-key","tid":TERMINAL,"url":url}).to_string(),
        );
    }

    fn order_notice_legacy_audit(conn: &Connection) {
        // Installed 1.4.153 wrote its automatic claim against the order ID,
        // its pre-PIN failures against the queue, and no attempts to parity.
        for (index, (time, action, target, reason)) in [
            (
                "04:13:15",
                "resendOrderCustomerCorrection",
                TOMIKRO_ORDER,
                None,
            ),
            (
                "06:59:50",
                "runParitySyncNow",
                "processor",
                Some("PARITY_SYNC_PARTIAL"),
            ),
            (
                "07:00:00",
                "resendOrderCustomerCorrection",
                TOMIKRO_QUEUE,
                Some("Active cashier or manager shift required on this terminal"),
            ),
            (
                "07:00:07",
                "resendOrderCustomerCorrection",
                TOMIKRO_QUEUE,
                Some("Active cashier or manager shift required on this terminal"),
            ),
            (
                "07:00:11",
                "retrySync",
                TOMIKRO_ORDER,
                Some("Sync rows were requeued."),
            ),
            (
                "07:00:14",
                "keepServerOrderCustomerDetails",
                TOMIKRO_QUEUE,
                Some("Active cashier or manager shift required on this terminal"),
            ),
            (
                "07:00:18",
                "resendOrderCustomerCorrection",
                TOMIKRO_QUEUE,
                Some("Active cashier or manager shift required on this terminal"),
            ),
            (
                "07:00:23",
                "resendOrderCustomerCorrection",
                TOMIKRO_QUEUE,
                Some("Active cashier or manager shift required on this terminal"),
            ),
            (
                "08:02:10",
                "runParitySyncNow",
                "processor",
                Some("PARITY_SYNC_PARTIAL"),
            ),
            (
                "08:02:15",
                "retrySync",
                TOMIKRO_ORDER,
                Some("Sync rows were requeued."),
            ),
            (
                "08:02:23",
                "resendOrderCustomerCorrection",
                TOMIKRO_QUEUE,
                Some("Active session required"),
            ),
            (
                "08:02:39",
                "retrySync",
                TOMIKRO_ORDER,
                Some("Sync rows were requeued."),
            ),
            (
                "08:02:47",
                "keepServerOrderCustomerDetails",
                TOMIKRO_QUEUE,
                Some("Active session required"),
            ),
            (
                "08:03:38",
                "runParitySyncNow",
                "processor",
                Some("PARITY_SYNC_PARTIAL"),
            ),
            (
                "08:20:26",
                "resendOrderCustomerCorrection",
                TOMIKRO_QUEUE,
                Some("Active session required"),
            ),
            (
                "08:20:42",
                "keepServerOrderCustomerDetails",
                TOMIKRO_QUEUE,
                Some("Active session required"),
            ),
            (
                "08:31:00",
                "employeeOrderAttempt",
                TOMIKRO_QUEUE,
                Some("REMEDY_NOT_APPLICABLE"),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let automatic = reason.is_none();
            let recipe = match action {
                "resendOrderCustomerCorrection" => Some("order-customer-correction.resend"),
                "keepServerOrderCustomerDetails" => Some("order-customer-correction.keep-server"),
                _ => None,
            };
            let id = if automatic {
                format!("automatic-order-header:{TOMIKRO_QUEUE}")
            } else {
                format!("legacy-audit-{index}")
            };
            conn.execute(
                "INSERT INTO recovery_action_log(id,action_id,issue_code,issue_id,recipe_id,recipe_version,
                  entity_type,entity_id,order_id,success,created_at,error_message,payload_json)
                 VALUES(?1,?2,?3,?4,?5,1,'order',?6,?7,0,?8,?9,?10)",
                rusqlite::params![id, action, if recipe.is_some() {"customer_correction_refused"} else {"UNKNOWN_CONFLICT_REVIEW"},
                    TOMIKRO_QUEUE,recipe,target,TOMIKRO_ORDER,format!("2026-11-18T{time}Z"),reason,
                    json!({"automatic":automatic,"automaticIntent":automatic,"outcome":"failed",
                        "machineReason": if automatic { Some("AUTOMATIC_ATTEMPT_INTERRUPTED") } else { None },
                        "noticeQueueId":TOMIKRO_QUEUE,"organizationId":"fixture-org","errorMessage":reason}).to_string()]
            ).unwrap();
        }
    }

    pub(crate) fn assert_order_notice_tomikro_outcome(conn: &Connection, resend: bool) {
        let result: (i64, String, String, String, Option<i64>) = conn.query_row(
            "SELECT total_amount_cents,status,payment_status,customer_name,remote_version FROM orders WHERE id=?1",
            [TOMIKRO_ORDER], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))
        ).unwrap();
        assert_eq!(
            (result.0, result.1.as_str(), result.2.as_str()),
            (1450, "delivered", "paid")
        );
        assert_eq!(
            result.3,
            if resend {
                "Corrected customer"
            } else {
                "Earlier customer"
            }
        );
        assert_eq!(result.4, if resend { None } else { Some(4) });
        let payment: (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),SUM(amount_cents) FROM order_payments WHERE order_id=?1",
                [TOMIKRO_ORDER],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(payment, (1, 1450));
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id=?1",
                [TOMIKRO_QUEUE],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        let audit: (String, Option<String>) = conn.query_row(
            "SELECT json_extract(payload_json,'$.retiredRequest'),json_extract(payload_json,'$.replacementQueueId')
             FROM recovery_action_log WHERE issue_id=?1 AND json_extract(payload_json,'$.nativeOrderCorrection')=1",
            [TOMIKRO_QUEUE], |r| Ok((r.get(0)?,r.get(1)?))
        ).unwrap();
        let retired: Value = serde_json::from_str(&audit.0).unwrap();
        assert_eq!(retired["expected_version"], 1);
        assert_eq!(retired["status"], "pending");
        if resend {
            let pending: String = conn.query_row(
                "SELECT data FROM parity_sync_queue WHERE id=?1 AND status='pending' AND attempts=0",
                [audit.1.unwrap()], |r| r.get(0),
            ).unwrap();
            let replacement: Value = serde_json::from_str(&pending).unwrap();
            assert_eq!(replacement["expected_version"], 4);
            assert_eq!(replacement["status"], "delivered");
            assert_ne!(replacement["client_event_id"], retired["client_event_id"]);
            assert_eq!(replacement["delivery_notes"], Value::Null);
        } else {
            assert_eq!(audit.1, None);
        }
    }

    async fn acknowledge_order_notice_tomikro_resend(
        db: &db::DbState,
        state: &sync::SyncState,
        cancel: &tokio_util::sync::CancellationToken,
        mut lookup: Value,
    ) {
        let mut canonical = lookup["orders"][0].take();
        canonical["version"] = json!(5);
        canonical["customer_name"] = json!("Corrected customer");
        canonical["customer_phone"] = json!("Corrected phone");
        canonical["delivery_address"] = json!("Corrected address");
        canonical["name_on_ringer"] = json!("Corrected bell");
        let ack = crate::tests::fake_http::MockServer::new(
            json!({"success":true,"data":canonical,"processing_time_ms":1}).to_string(),
        );
        order_notice_tomikro_endpoint(&ack.url);
        let result = sync::process_renderer_parity_queue_guarded(
            db,
            state,
            &NoopTerminalEventSink,
            cancel,
            "recovery:test_tomikro",
        )
        .await
        .unwrap();
        assert_eq!(
            (result.processed, result.failed, result.conflicts),
            (1, 0, 0)
        );
        let requests = ack.recorded();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            (requests[0].method.as_str(), requests[0].path.as_str()),
            ("PATCH", "/api/pos/orders")
        );
        let body = requests[0].json_body().unwrap();
        assert_eq!(body["id"], REMOTE_ORDER);
        assert_eq!(body["expected_version"], 4);
        assert_eq!(body["status"], "delivered");
        assert_eq!(body["delivery_notes"], Value::Null);
        for key in [
            "payment_status",
            "payment_method",
            "items",
            "total_amount",
            "header_edit_original",
        ] {
            assert!(body.get(key).is_none(), "unexpected PATCH field {key}");
        }
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            crate::order_notice_evidence::collect(&conn).unwrap(),
            json!([])
        );
        let order: (String, i64) = conn
            .query_row(
                "SELECT payment_status, remote_version FROM orders WHERE id=?1",
                [TOMIKRO_ORDER],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(order, ("paid".into(), 5));
        let observed: (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),SUM(amount_cents) FROM order_payments WHERE order_id=?1",
                [TOMIKRO_ORDER],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(observed, (1, 1450));
    }

    #[test]
    fn order_notice_tomikro_manual_actions_admit_real_history_and_exact_snapshot() {
        use crate::order_notice_recovery as owner;
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        for (action, recipe) in [
            (owner::KEEP, "order-customer-correction.keep-server"),
            (owner::RESEND, "order-customer-correction.resend"),
        ] {
            let (db, answer) = order_notice_tomikro_fixture();
            let server = crate::tests::fake_http::MockServer::new(answer.to_string());
            order_notice_tomikro_endpoint(&server.url);
            {
                let conn = db.state.conn.lock().unwrap();
                order_notice_legacy_audit(&conn);
                assert!(!crate::order_notice_auto::eligible(
                    &conn,
                    &owner::refused(&conn, TOMIKRO_QUEUE).unwrap().unwrap()
                )
                .unwrap());
            }
            let auth = auth::AuthState::new();
            auth::tests::login_as_staff(&db.state, &auth);
            auth::tests::insert_active_shift(&db.state, TERMINAL, "cashier");
            auth::confirm_privileged_action(
                Some(json!({"scope":"cash_drawer_control","pin":"4321"})),
                &db.state,
                &auth,
            )
            .unwrap();
            let snapshot = recovery::create_pre_recovery_action_snapshot(&db.state).unwrap();
            let state = std::sync::Arc::new(sync::SyncState::new());
            let cancel = tokio_util::sync::CancellationToken::new();
            let request = json!({"actionId":action,"issueCode":"customer_correction_refused",
                "recipeId":recipe,"recipeVersion":1,"entityType":"order","entityId":TOMIKRO_QUEUE,
                "params":{"queueId":TOMIKRO_QUEUE},"snapshotPointId":snapshot.id});
            let _action = crate::support::remedies::action_gate().try_begin().unwrap();
            let result = recovery_execute_action_on_blocking_worker(
                Some(request),
                false,
                &db.state,
                &auth,
                &state,
                &cancel,
                &NoopTerminalEventSink,
            )
            .unwrap();
            assert_eq!(result["success"], true);
            assert_eq!(
                result["verification"]["status"],
                if action == owner::RESEND {
                    "pending"
                } else {
                    "passed"
                }
            );
            let requests = server.recorded();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].method, "GET");
            assert_eq!(
                requests[0].path,
                format!("/api/pos/orders/sync?order_id={REMOTE_ORDER}")
            );
            assert_order_notice_tomikro_outcome(
                &db.state.conn.lock().unwrap(),
                action == owner::RESEND,
            );
            if action == owner::RESEND {
                tauri::async_runtime::block_on(acknowledge_order_notice_tomikro_resend(
                    &db.state, &state, &cancel, answer,
                ));
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn order_notice_tomikro_automatic_retries_busy_writer_and_keeps_real_reason() {
        use crate::order_notice_auto as automatic;
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        crate::order_notice_recovery::set_test_reachable(true);
        let (db, answer) = order_notice_tomikro_fixture();
        let state = sync::SyncState::new();
        let cancel = tokio_util::sync::CancellationToken::new();
        let writer = std::sync::Arc::new(std::sync::Mutex::new(None));
        let server =
            crate::tests::fake_http::MockServer::new_with_request_hook(answer.to_string(), {
                let path = db.state.db_path.clone();
                let writer = writer.clone();
                move || {
                    let conn = Connection::open(&path).unwrap();
                    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
                    *writer.lock().unwrap() = Some(conn);
                }
            });
        order_notice_tomikro_endpoint(&server.url);
        let failure = automatic::attempt(&db.state, &state, &cancel, TOMIKRO_QUEUE)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            automatic::persist_failure(&db.state.db_path, TOMIKRO_QUEUE, &failure),
            Err("NOTICE_DATABASE_BUSY".into())
        );
        drop(writer.lock().unwrap().take());
        automatic::persist_failure(&db.state.db_path, TOMIKRO_QUEUE, &failure).unwrap();
        let db = db.restart();
        {
            let conn = db.state.conn.lock().unwrap();
            let evidence = crate::order_notice_evidence::collect(&conn).unwrap();
            assert_eq!(
                evidence[0]["automatic_attempt"],
                json!({"ran":true,"outcome":"failed","reason":"NOTICE_DATABASE_BUSY"})
            );
            let row = crate::order_notice_recovery::refused(&conn, TOMIKRO_QUEUE)
                .unwrap()
                .unwrap();
            assert!(!automatic::eligible(&conn, &row).unwrap());
            conn.execute("UPDATE recovery_action_log SET payload_json=json_set(payload_json,'$.retryAtMs',0) WHERE id=?1",
                [format!("automatic-order-header:{TOMIKRO_QUEUE}")]).unwrap();
            assert!(automatic::eligible(&conn, &row).unwrap());
        }
        let server = crate::tests::fake_http::MockServer::new(answer.to_string());
        order_notice_tomikro_endpoint(&server.url);
        assert!(
            automatic::attempt(&db.state, &state, &cancel, TOMIKRO_QUEUE)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            automatic::attempt(&db.state, &state, &cancel, TOMIKRO_QUEUE)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(server.count(), 1);
        let conn = db.state.conn.lock().unwrap();
        assert_order_notice_tomikro_outcome(&conn, true);
        let count: i64 = conn.query_row("SELECT json_extract(payload_json,'$.attemptCount') FROM recovery_action_log WHERE id=?1",
            [format!("automatic-order-header:{TOMIKRO_QUEUE}")], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
        drop(conn);
        acknowledge_order_notice_tomikro_resend(&db.state, &state, &cancel, answer).await;
    }

    #[test]
    fn order_notice_tomikro_manual_metadata_preserves_real_line_drift() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let (db, answer) = order_notice_tomikro_fixture();
        let conn = db.state.conn.lock().unwrap();
        use crate::order_notice_recovery as owner;
        let row = owner::refused(&conn, TOMIKRO_QUEUE).unwrap().unwrap();
        let before = owner::capture(&conn, &row).unwrap();
        owner::verify(&before, &answer).unwrap();
        for (field, value) in [
            ("original_unit_price", json!(12.00)),
            ("is_price_overridden", json!(true)),
            (
                "customizations",
                json!({"_meta":{"line_kind":"manual_item"},"actual_option":true}),
            ),
        ] {
            let mut changed = answer.clone();
            changed["orders"][0]["order_items"][0][field] = value.clone();
            if field == "customizations" {
                changed["orders"][0]["items"][0][field] = value;
            }
            assert_eq!(
                owner::verify(&before, &changed),
                Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into())
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn order_notice_tomikro_parked_rows_refuse_both_generic_retries() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let (db, _) = order_notice_tomikro_fixture();
        let server = crate::tests::fake_http::MockServer::new("{}");
        order_notice_tomikro_endpoint(&server.url);
        let auth = auth::AuthState::new();
        let state = std::sync::Arc::new(sync::SyncState::new());
        let cancel = tokio_util::sync::CancellationToken::new();
        for action in ["retrySync", "runParitySyncNow"] {
            let request = json!({"actionId":action,"issueCode":"UNKNOWN_CONFLICT_REVIEW","entityType":"orders","entityId":TOMIKRO_ORDER});
            let error = recovery_execute_action_core(
                Some(request),
                false,
                &db.state,
                &auth,
                &state,
                &cancel,
                &NoopTerminalEventSink,
            )
            .await
            .unwrap_err();
            assert_eq!(error.to_string(), "PARITY_ROWS_PARKED");
        }
        assert_eq!(server.count(), 0);
        let conn = db.state.conn.lock().unwrap();
        let row: (String, i64) = conn
            .query_row(
                "SELECT status,attempts FROM parity_sync_queue WHERE id=?1",
                [TOMIKRO_QUEUE],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("conflict".into(), 0));
        conn.execute(
            "INSERT INTO sync_queue(entity_type,entity_id,operation,payload,idempotency_key,status,retry_count)
             VALUES('order','unrelated-legacy','UPDATE','{}','legacy-fixture','deferred',2)",
            [],
        )
        .unwrap();
        let legacy_id = conn.last_insert_rowid();
        requeue_legacy_sync_rows(&conn, &json!({"queueId":legacy_id})).unwrap();
        let resumed: (String, i64) = conn
            .query_row(
                "SELECT status,retry_count FROM sync_queue WHERE id=?1",
                [legacy_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(resumed, ("pending".into(), 0));
    }

    #[test]
    #[serial_test::serial]
    fn health_snapshot_does_not_take_the_business_mutex() {
        let _gate = crate::support::critical_op::install_test_gate();
        let db = crate::tests::harness::TestDb::open();
        let _business = db.state.conn.lock().unwrap();
        let snapshot = recovery::create_health_pre_action_snapshot(&db.state).unwrap();
        assert!(std::path::Path::new(&snapshot.snapshot_path).is_file());
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn health_platform_correction_rolls_back_if_settlement_insert_fails_and_retries_after_reopen(
    ) {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let (db, _) = order_notice_tomikro_fixture();
        order_notice_tomikro_endpoint("http://127.0.0.1:15401");
        let auth = auth::AuthState::new();
        auth::tests::login_as_admin(&db.state, &auth);
        auth::tests::insert_active_shift(&db.state, TERMINAL, "cashier");
        auth::tests::grant_cash_drawer_for_test(&auth);
        {
            let conn = db.state.conn.lock().unwrap();
            db::set_setting(&conn, "restaurant", "currency", "EUR").unwrap();
            conn.execute(
                "UPDATE orders SET plugin='efood', external_plugin_order_id='ext-platform',
                   currency='EUR', ghost_metadata=?1,
                   staff_shift_id=(SELECT id FROM staff_shifts WHERE terminal_id=?2 AND status='active' LIMIT 1)
                 WHERE id=?3",
                rusqlite::params![json!({"food_delivery":{"payment_method":"cash","prepaid":false,"delivery_provider":"platform_delivery"}}).to_string(), TERMINAL, TOMIKRO_ORDER],
            ).unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions
                   (id, staff_shift_id, cashier_id, branch_id, terminal_id, currency, opening_amount, opening_amount_cents, total_cash_sales, total_cash_sales_cents, opened_at, created_at, updated_at)
                 SELECT 'platform-drawer', id, staff_id, 'fixture-branch', ?1, 'EUR', 100, 10000, 14.50, 1450, datetime('now'), datetime('now'), datetime('now')
                 FROM staff_shifts WHERE terminal_id=?1 AND status='active' LIMIT 1",
                [TERMINAL],
            ).unwrap();
            conn.execute_batch(
                "CREATE TRIGGER fail_platform_settlement BEFORE INSERT ON order_payments
                 WHEN NEW.method = 'other'
                   AND (SELECT status FROM order_payments WHERE id='fixture-payment') = 'voided'
                   AND (SELECT COUNT(*) FROM payment_adjustments) = 1
                 BEGIN SELECT RAISE(ABORT,'settlement write interrupted'); END;",
            )
            .unwrap();
        }
        let state = std::sync::Arc::new(sync::SyncState::new());
        let cancellation = tokio_util::sync::CancellationToken::new();
        let request = |snapshot: &str| {
            json!({
                "actionId":"repairPlatformSettlementMismatch", "issueCode":"platform_settlement_mismatch",
                "entityType":"order", "entityId":TOMIKRO_ORDER, "orderId":TOMIKRO_ORDER,
                "snapshotPointId":snapshot, "routeTarget":{"screen":"orderPayment","orderId":TOMIKRO_ORDER}
            })
        };
        let snapshot = recovery::create_pre_recovery_action_snapshot(&db.state).unwrap();
        let error = recovery_execute_action_core(
            Some(request(&snapshot.id)),
            false,
            &db.state,
            &auth,
            &state,
            &cancellation,
            &NoopTerminalEventSink,
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "EDIT_LOCAL_STORAGE_CONSTRAINT");

        let reopened = db::DbState {
            conn: std::sync::Mutex::new(Connection::open(&db.state.db_path).unwrap()),
            db_path: db.state.db_path.clone(),
        };
        let read = |conn: &Connection| {
            conn.query_row(
            "SELECT (SELECT status FROM order_payments WHERE id='fixture-payment'),
                    (SELECT total_cash_sales_cents FROM cash_drawer_sessions WHERE id='platform-drawer'),
                    (SELECT COUNT(*) FROM payment_adjustments),
                    (SELECT COUNT(*) FROM order_payments WHERE method='other')",
            [], |row| Ok((row.get::<_,String>(0)?, row.get::<_,i64>(1)?, row.get::<_,i64>(2)?, row.get::<_,i64>(3)?)),
        ).unwrap()
        };
        {
            let conn = reopened.conn.lock().unwrap();
            assert_eq!(read(&conn), ("completed".into(), 1450, 0, 0));
            conn.execute_batch("DROP TRIGGER fail_platform_settlement;")
                .unwrap();
        }
        let snapshot = recovery::create_pre_recovery_action_snapshot(&reopened).unwrap();
        let result = recovery_execute_action_core(
            Some(request(&snapshot.id)),
            false,
            &reopened,
            &auth,
            &state,
            &cancellation,
            &NoopTerminalEventSink,
        )
        .await
        .unwrap();
        assert_eq!(result["verification"]["status"], "passed");
        assert_eq!(result["changedIds"].as_array().unwrap().len(), 3);
        assert!(recovery_execute_action_core(
            Some(request(&snapshot.id)),
            false,
            &reopened,
            &auth,
            &state,
            &cancellation,
            &NoopTerminalEventSink
        )
        .await
        .is_err());
        assert_eq!(
            read(&reopened.conn.lock().unwrap()),
            ("voided".into(), 0, 1, 1)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn health_invalid_removal_rechecks_preview_and_preserves_an_unselected_sibling() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let db = crate::tests::harness::TestDb::open();
        {
            let conn = db.state.conn.lock().unwrap();
            db::set_setting(&conn, "terminal", "terminal_id", TERMINAL).unwrap();
        }
        let auth = auth::AuthState::new();
        auth::tests::login_as_admin(&db.state, &auth);
        auth::tests::insert_active_shift(&db.state, TERMINAL, "cashier");
        auth::tests::grant_cash_drawer_for_test(&auth);
        let ids = {
            let conn = db.state.conn.lock().unwrap();
            let insert = |key: &str| {
                conn.execute("INSERT INTO sync_queue(entity_type, entity_id, operation, payload, idempotency_key, status)
                              VALUES ('order','missing-order','UPDATE','{}',?1,'pending')", [key]).unwrap();
                conn.last_insert_rowid()
            };
            [insert("preview-row"), insert("sibling-row")]
        };
        let preview = sync::validate_pending_orders(&db.state).unwrap();
        assert_eq!(preview["invalid_orders"][0]["queue_id"], ids[0]);
        let snapshot = recovery::create_pre_recovery_action_snapshot(&db.state).unwrap();
        let request = json!({"actionId":"removeInvalidOrders", "issueCode":"invalid_orders_pending",
            "snapshotPointId":snapshot.id, "params":{"invalidRows":[[ids[0],"missing-order"]]}});
        {
            let conn = db.state.conn.lock().unwrap();
            conn.execute("INSERT INTO orders(id,items,created_at,updated_at) VALUES('missing-order','[]',datetime('now'),datetime('now'))", []).unwrap();
        }
        let state = std::sync::Arc::new(sync::SyncState::new());
        let cancellation = tokio_util::sync::CancellationToken::new();
        let failed = recovery_execute_action_core(
            Some(request.clone()),
            false,
            &db.state,
            &auth,
            &state,
            &cancellation,
            &NoopTerminalEventSink,
        )
        .await
        .unwrap_err();
        assert_eq!(failed.to_string(), "INVALID_ORDER_PREVIEW_CHANGED");
        {
            let conn = db.state.conn.lock().unwrap();
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sync_queue WHERE entity_id='missing-order'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 2);
            conn.execute("DELETE FROM orders WHERE id='missing-order'", [])
                .unwrap();
        }
        let result = recovery_execute_action_core(
            Some(request),
            false,
            &db.state,
            &auth,
            &state,
            &cancellation,
            &NoopTerminalEventSink,
        )
        .await
        .unwrap();
        assert_eq!(result["changedIds"], json!([ids[0].to_string()]));
        let conn = db.state.conn.lock().unwrap();
        let remaining: i64 = conn
            .query_row(
                "SELECT id FROM sync_queue WHERE entity_id='missing-order'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, ids[1]);
        let (archived_id, payload, snapshot_id): (i64, String, String) = conn.query_row(
            "SELECT json_extract(discarded_payload,'$.queue_id'), json_extract(discarded_payload,'$.payload'),
                    json_extract(discarded_payload,'$.snapshot_point_id')
             FROM conflict_audit_log WHERE resolution='invalid_order_send_removed'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(
            (archived_id, payload, snapshot_id),
            (ids[0], "{}".into(), snapshot.id)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn health_exact_parity_retry_keeps_parked_and_legacy_siblings() {
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let server = crate::tests::fake_http::MockServer::new(r#"{"success":true}"#);
        let _keys = crate::tests::fake_keyring::install_seeded([
            (
                "pos_api_key",
                json!({"key":"PRIVATE_KEY","tid":"terminal-recovery","url":server.url.clone()})
                    .to_string(),
            ),
            ("terminal_id", "terminal-recovery".to_string()),
            ("admin_dashboard_url", server.url.clone()),
        ]);
        let db = crate::tests::harness::TestDb::open();
        let selected = {
            let conn = db.state.conn.lock().unwrap();
            seed_failed_recovery_row(&conn, "same-customer", "customers", 100);
            let selected: String = conn
                .query_row(
                    "SELECT id FROM parity_sync_queue WHERE record_id='same-customer'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            conn.execute(
                "INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,created_at,status,error_message,module_type)
                   SELECT 'parked-sibling',table_name,record_id,'UPDATE',data,organization_id,created_at,'conflict','UNKNOWN_CONFLICT_REVIEW',module_type
                     FROM parity_sync_queue WHERE id=?1",
                [&selected],
            ).unwrap();
            conn.execute(
                "INSERT INTO sync_queue(entity_type,entity_id,operation,payload,idempotency_key,status,retry_count)
                 VALUES('customer','same-customer','UPDATE','{}','legacy-sibling','failed',6)",
                [],
            ).unwrap();
            selected
        };
        let health = crate::diagnostics::get_system_health(&db.state).unwrap();
        let blockers = health["syncBlockerDetails"].as_array().unwrap();
        let selected_blocker = blockers
            .iter()
            .find(|row| row["queueItemId"] == selected)
            .unwrap();
        let parked = blockers
            .iter()
            .find(|row| row["queueItemId"] == "parked-sibling")
            .unwrap();
        assert_eq!(selected_blocker["queue"], "parity_sync_queue");
        assert_eq!(parked["entityId"], selected_blocker["entityId"]);
        let snapshot = recovery::create_pre_recovery_action_snapshot(&db.state).unwrap();
        let request = |blocker: &Value| {
            json!({
                "actionId":"retryParityItem", "issueId":format!("sync-blocker-parity_sync_queue:{}", blocker["queueItemId"].as_str().unwrap()),
                "entityType":blocker["entityType"], "entityId":blocker["entityId"], "snapshotPointId":snapshot.id,
                "params":{"queueOwner":blocker["queue"],"sampleItemId":blocker["queueItemId"],"queueStatus":blocker["queueStatus"]}
            })
        };
        let auth = auth::AuthState::new();
        let state = std::sync::Arc::new(sync::SyncState::new());
        let cancellation = tokio_util::sync::CancellationToken::new();
        let refused = recovery_execute_action_core(
            Some(request(parked)),
            false,
            &db.state,
            &auth,
            &state,
            &cancellation,
            &NoopTerminalEventSink,
        )
        .await
        .unwrap();
        assert_eq!(refused["success"], false);
        assert_eq!(refused["targetOutcome"], "refused");
        assert_eq!(server.count(), 0);
        let sent = recovery_execute_action_core(
            Some(request(selected_blocker)),
            false,
            &db.state,
            &auth,
            &state,
            &cancellation,
            &NoopTerminalEventSink,
        )
        .await
        .unwrap();
        assert_eq!(sent["changedIds"], json!([selected]));
        assert_eq!(sent["targetOutcome"], "sent");
        assert_eq!(server.count(), 1);
        let conn = db.state.conn.lock().unwrap();
        let (parked, legacy): (String, i64) = conn
            .query_row(
                "SELECT (SELECT status FROM parity_sync_queue WHERE id='parked-sibling'),
                    (SELECT retry_count FROM sync_queue WHERE idempotency_key='legacy-sibling')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((parked, legacy), ("conflict".into(), 6));
    }

    const CORRECTION_ORDER: &str = "11111111-1111-4111-8111-111111111111";
    const CORRECTION_QUEUE: &str = "44444444-4444-4444-8444-444444444444";
    const CORRECTION_REMOTE_ORDER: &str = "55555555-5555-4555-8555-555555555555";
    const CORRECTION_TERMINAL: &str = "terminal-correction-fixture";

    /// The shape of the row that held a store's Z on 18/11/2026 (desktop
    /// 1.4.153): a delivered, paid delivery order with one manual line, whose
    /// customer correction the server answered with an unknown 409, parked as
    /// a conflict. Returns the till and the server's exact-order answer.
    fn refused_customer_correction_fixture() -> (crate::tests::harness::TestDb, Value) {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        for (key, value) in [
            ("organization_id", "fixture-org"),
            ("branch_id", "fixture-branch"),
            ("terminal_id", CORRECTION_TERMINAL),
        ] {
            db::set_setting(&conn, "terminal", key, value).unwrap();
        }
        let local_items = json!([{
            "id":"manual-fixture-line","isManual":true,"is_manual":true,
            "menuItemId":null,"menu_item_id":null,"name":"Manual line","menuItemName":"Manual line",
            "menu_item_name":"Manual line","quantity":1,"price":14.5,"unitPrice":14.5,"unit_price":14.5,
            "totalPrice":14.5,"total_price":14.5,"originalUnitPrice":14.5,"original_unit_price":14.5,
            "isPriceOverridden":false,"is_price_overridden":false,"customizations":[],
            "priceIncludesVat":true,"vatClass":"standard","fiscalDocumentProfile":"manual_item",
            "categoryPath":"Manual category","service_id":null,"appointment_id":null
        }]);
        let payload = json!({"client_event_id":"original-correction-event",
            "customer_id":"33333333-3333-4333-8333-333333333333",
            "customer_name":"Corrected customer","customer_phone":"Corrected phone",
            "delivery_address":"Corrected address","delivery_floor":"2","delivery_notes":null,
            "expected_version":1,"name_on_ringer":"Corrected bell",
            "orderId":CORRECTION_ORDER,"organization_id":"fixture-org","status":"pending"});
        conn.execute(
            "INSERT INTO orders(id,supabase_id,organization_id,branch_id,terminal_id,order_type,status,payment_status,
                sync_status,version,remote_version,total_amount,total_amount_cents,items,customer_id,customer_name,
                customer_phone,delivery_address,delivery_floor,delivery_notes,name_on_ringer,created_at,updated_at)
             VALUES(?1,?2,'fixture-org','fixture-branch',?3,'delivery','delivered','paid','synced',1,NULL,
                14.5,1450,?4,'33333333-3333-4333-8333-333333333333','Corrected customer','Corrected phone',
                'Corrected address','2',NULL,'Corrected bell','2026-11-18T03:58:00Z','2026-11-18T04:13:12Z')",
            rusqlite::params![
                CORRECTION_ORDER,
                CORRECTION_REMOTE_ORDER,
                CORRECTION_TERMINAL,
                local_items.to_string()
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,sync_state,sync_status,
                remote_payment_id,created_at,updated_at)
             VALUES('fixture-payment',?1,'cash',14.50,1450,'EUR','completed','applied','synced','remote-fixture-payment',
                '2026-11-18T04:13:12Z','2026-11-18T04:13:12Z')",
            [CORRECTION_ORDER],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,status,
                error_message,attempts,created_at,conflict_strategy,version,module_type)
             VALUES(?1,'orders',?2,'UPDATE',?3,'fixture-org','conflict','UNKNOWN_CONFLICT_REVIEW',0,
                '2026-11-18T04:13:13Z','server-wins',1,'orders')",
            rusqlite::params![CORRECTION_QUEUE, CORRECTION_ORDER, payload.to_string()],
        )
        .unwrap();
        let mut order =
            crate::edit_settlement_recovery::capture_order_headers(&conn, CORRECTION_ORDER)
                .unwrap();
        // The exact-order lookup answers the stored rows and a display
        // projection of them. The projection carries display metadata and
        // leaves out the line's original price and override.
        let customizations = json!({"_meta":{"line_kind":"manual_item","category_id":null,
            "product_name":"Manual line","category_name":null}});
        let line_id = "22222222-2222-4222-8222-222222222222";
        let raw_line = json!({"id":line_id,"order_id":CORRECTION_REMOTE_ORDER,"menu_item_id":null,
            "menu_item_name":"Manual line","quantity":1,"unit_price":14.5,"total_price":14.5,
            "original_unit_price":14.5,"is_price_overridden":false,"notes":null,
            "customizations":customizations,"service_id":null,"appointment_id":null});
        let hydrated = json!({"id":line_id,"menu_item_id":null,"menuItemId":null,
            "menu_item_name":"Manual line","menuItemName":"Manual line","name":"Manual line","quantity":1,
            "unit_price":14.5,"unitPrice":14.5,"price":14.5,"total_price":14.5,"totalPrice":14.5,
            "notes":null,"special_instructions":null,"customizations":customizations,
            "category_name":null,"categoryName":null,"category_path":null,"categoryPath":null});
        order.as_object_mut().unwrap().extend(
            json!({
                "id":CORRECTION_REMOTE_ORDER,"client_order_id":CORRECTION_ORDER,
                "organization_id":"fixture-org","branch_id":"fixture-branch",
                "status":"delivered","payment_status":"paid","version":4,
                "total_amount":14.5,"total_amount_cents":1450,
                "customer_name":"Earlier customer","customer_phone":"Earlier phone",
                "delivery_address":"Earlier address","name_on_ringer":"Earlier bell","notes":null,
                "special_instructions":null,"order_items":[raw_line],"items":[hydrated]
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        drop(conn);
        (
            db,
            json!({"success":true,"orders":[order],"total_count":1,"has_more":false,"exact_order_lookup":true}),
        )
    }

    /// What 1.4.153 had written by the time staff gave up: its one automatic
    /// claim, left interrupted, and the staff presses refused before and at
    /// admission. None of it may keep a later press from working.
    fn refused_customer_correction_history(conn: &Connection) {
        for (index, (time, action, reason)) in [
            ("04:13:15", "resendOrderCustomerCorrection", None),
            (
                "07:00:00",
                "resendOrderCustomerCorrection",
                Some("Active cashier or manager shift required on this terminal"),
            ),
            (
                "07:00:14",
                "keepServerOrderCustomerDetails",
                Some("Active cashier or manager shift required on this terminal"),
            ),
            (
                "08:02:23",
                "resendOrderCustomerCorrection",
                Some("Active session required"),
            ),
            (
                "08:02:47",
                "keepServerOrderCustomerDetails",
                Some("Active session required"),
            ),
            (
                "08:31:00",
                "employeeOrderAttempt",
                Some("REMEDY_NOT_APPLICABLE"),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let automatic = reason.is_none();
            let recipe = match action {
                "resendOrderCustomerCorrection" => Some("order-customer-correction.resend"),
                "keepServerOrderCustomerDetails" => Some("order-customer-correction.keep-server"),
                _ => None,
            };
            let id = if automatic {
                format!("automatic-order-header:{CORRECTION_QUEUE}")
            } else {
                format!("legacy-audit-{index}")
            };
            let target = if automatic {
                CORRECTION_ORDER
            } else {
                CORRECTION_QUEUE
            };
            conn.execute(
                "INSERT INTO recovery_action_log(id,action_id,issue_code,issue_id,recipe_id,recipe_version,
                  entity_type,entity_id,order_id,success,created_at,error_message,payload_json)
                 VALUES(?1,?2,'customer_correction_refused',?3,?4,1,'order',?5,?6,0,?7,?8,?9)",
                rusqlite::params![
                    id,
                    action,
                    CORRECTION_QUEUE,
                    recipe,
                    target,
                    CORRECTION_ORDER,
                    format!("2026-11-18T{time}Z"),
                    reason,
                    json!({"automatic":automatic,"automaticIntent":automatic,"outcome":"failed",
                        "noticeQueueId":CORRECTION_QUEUE,"organizationId":"fixture-org",
                        "errorMessage":reason})
                    .to_string()
                ],
            )
            .unwrap();
        }
    }

    /// Regression for 18/11/2026: on desktop 1.4.153 both customer-correction
    /// buttons answered REMEDY_NOT_APPLICABLE after the PIN, because the
    /// admission evaluated its no-recipe fallback even for a request that
    /// named its recipe. The parked row then held the store's Z with no way
    /// out. Each button is driven through the dispatcher the screen calls,
    /// with the history that till had recorded, and must leave nothing of the
    /// row for the day close to count.
    #[test]
    #[serial_test::serial]
    fn customer_correction_buttons_pass_admission_and_free_the_day_close() {
        use crate::order_notice_recovery as owner;
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        for (action, recipe) in [
            (owner::KEEP, "order-customer-correction.keep-server"),
            (owner::RESEND, "order-customer-correction.resend"),
        ] {
            let (db, answer) = refused_customer_correction_fixture();
            let server = crate::tests::fake_http::MockServer::new(answer.to_string());
            crate::tests::fake_keyring::set("terminal_id", CORRECTION_TERMINAL);
            crate::tests::fake_keyring::set("admin_dashboard_url", &server.url);
            crate::tests::fake_keyring::set(
                "pos_api_key",
                &json!({"key":"your-test-key","tid":CORRECTION_TERMINAL,"url":&server.url})
                    .to_string(),
            );
            {
                let conn = db.state.conn.lock().unwrap();
                refused_customer_correction_history(&conn);
                assert_eq!(
                    sync_queue::get_closeout_blocking_status(&conn)
                        .unwrap()
                        .conflicts,
                    1,
                    "{action}: the parked correction holds the day close"
                );
                // A request that names no recipe keeps its closed fallback.
                assert_eq!(
                    health_action_admission(&conn, &json!({"actionId":action}), 0, false, false)
                        .err()
                        .as_deref(),
                    Some("REMEDY_NOT_APPLICABLE")
                );
            }
            let auth = auth::AuthState::new();
            auth::tests::login_as_admin(&db.state, &auth);
            auth::tests::insert_active_shift(&db.state, CORRECTION_TERMINAL, "manager");
            auth::tests::grant_cash_drawer_for_test(&auth);
            let snapshot = recovery::create_pre_recovery_action_snapshot(&db.state).unwrap();
            let request = json!({"actionId":action,"issueCode":"customer_correction_refused",
                "recipeId":recipe,"recipeVersion":1,"entityType":"order","entityId":CORRECTION_QUEUE,
                "params":{"queueId":CORRECTION_QUEUE},"snapshotPointId":snapshot.id});
            let result = tauri::async_runtime::block_on(recovery_execute_action_core(
                Some(request),
                false,
                &db.state,
                &auth,
                &std::sync::Arc::new(sync::SyncState::new()),
                &tokio_util::sync::CancellationToken::new(),
                &NoopTerminalEventSink,
            ))
            .unwrap_or_else(|error| panic!("{action}: {error:?}"));
            assert_eq!(result["success"], true, "{action}: {result}");
            let requests = server.recorded();
            assert_eq!(requests.len(), 1, "{action}");
            assert_eq!(requests[0].method, "GET");
            assert_eq!(
                requests[0].path,
                format!("/api/pos/orders/sync?order_id={CORRECTION_REMOTE_ORDER}")
            );
            let conn = db.state.conn.lock().unwrap();
            assert!(
                owner::refused(&conn, CORRECTION_QUEUE).unwrap().is_none(),
                "{action}: the refused correction is resolved"
            );
            let closeout = sync_queue::get_closeout_blocking_status(&conn).unwrap();
            assert_eq!(
                (closeout.conflicts, closeout.failed),
                (0, 0),
                "{action}: nothing refused is left to hold the day close"
            );
            // Keeping the server's details leaves nothing queued; saving again
            // queues exactly the one replacement, to be sent like any edit.
            assert_eq!(
                closeout.pending,
                i64::from(action == owner::RESEND),
                "{action}"
            );
            let order: (i64, String, String) = conn
                .query_row(
                    "SELECT total_amount_cents,status,payment_status FROM orders WHERE id=?1",
                    [CORRECTION_ORDER],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(
                (order.0, order.1.as_str(), order.2.as_str()),
                (1450, "delivered", "paid"),
                "{action}"
            );
            let payment: (i64, i64) = conn
                .query_row(
                    "SELECT COUNT(*),SUM(amount_cents) FROM order_payments WHERE order_id=?1",
                    [CORRECTION_ORDER],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(payment, (1, 1450), "{action}");
        }
    }

    fn address_retry_fixture() -> (
        crate::tests::harness::TestDb,
        auth::AuthState,
        String,
        String,
    ) {
        let db = crate::tests::harness::TestDb::open();
        let (target, other) = {
            let conn = db.state.conn.lock().unwrap();
            sync_queue::tests::seed_terminal_context(&conn);
            let seed = sync_queue::tests::seed_failed_customer_address_default_conflict_row;
            let target = seed(&conn, "your-target", "CUSTOMER_ADDRESS_DEFAULT_CONFLICT");
            let other = seed(&conn, "your-other", "CUSTOMER_ADDRESS_DEFAULT_CONFLICT");
            (target, other)
        };
        let auth = auth::AuthState::new();
        auth::tests::login_as_admin(&db.state, &auth);
        auth::tests::insert_active_shift(&db.state, "terminal-test", "manager");
        auth::tests::grant_cash_drawer_for_test(&auth);
        crate::diagnostics::get_system_health(&db.state).unwrap();
        (db, auth, target, other)
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn address_retry_success_parity_and_keyring_free_remote_admission() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let mut responses = Vec::new();
        let mut queue_states = Vec::new();
        let mut guards = Vec::new();
        for support_authorized in [false, true] {
            let _keys = crate::tests::fake_keyring::install_empty();
            let (db, auth, target, other) = address_retry_fixture();
            let source = if support_authorized {
                "remote_support"
            } else {
                "manual"
            };
            let mut request = json!({"actionId":"nativeCustomerAddressDefaultRetry",
                "recipeId":"customer-address-default.retry","recipeVersion":1,
                "entityId":target,"source":source,"sessionId":"your-support-session"});
            if support_authorized {
                // Support admission checks the CashDrawer grant against the
                // bound, non-secret identity and reads the keyring zero times.
                crate::tests::fake_keyring::before_each_read(|key| {
                    panic!("remote address retry admission read keyring: {key}")
                });
                request = crate::support::remedy_run::tests::authorize_address_retry_for_test(
                    &db.state, &auth, &target,
                );
                crate::tests::fake_keyring::before_each_read(|_| {});
                // Without the grant the manual check would refuse, so success
                // proves the core does not repeat it for an admitted run.
                auth::tests::clear_grants_for_test(&auth);
            }
            // The owner runs as for the manual Health button, with the till's
            // own credentials, exactly as `syncNow` does (decision A, 02/11).
            let url = "http://127.0.0.1:9";
            crate::tests::fake_keyring::set("terminal_id", "terminal-test");
            crate::tests::fake_keyring::set("admin_dashboard_url", url);
            crate::tests::fake_keyring::set(
                "pos_api_key",
                &json!({"key":"your-test-key","tid":"terminal-test","url":url}).to_string(),
            );
            let request_session = request["sessionId"].clone();
            let before = chrono::Utc::now();
            responses.push(
                recovery_execute_action_core(
                    Some(request),
                    support_authorized,
                    &db.state,
                    &auth,
                    &std::sync::Arc::new(sync::SyncState::new()),
                    &tokio_util::sync::CancellationToken::new(),
                    &NoopTerminalEventSink,
                )
                .await
                .unwrap(),
            );
            let after = chrono::Utc::now();
            let conn = db.state.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT record_id,status,attempts,data,error_message FROM parity_sync_queue ORDER BY record_id").unwrap();
            queue_states.push(
                stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap(),
            );
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM parity_sync_queue WHERE id=?1",
                    [&target],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                "pending"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM parity_sync_queue WHERE id=?1",
                    [&other],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                "failed"
            );
            let guard: Value = serde_json::from_str(
                &db::get_setting(
                    &conn,
                    "recovery_probe",
                    &format!("customer-address-default.retry.v1:{target}"),
                )
                .unwrap(),
            )
            .unwrap();
            let probe =
                chrono::DateTime::parse_from_rfc3339(guard["lastProbeAt"].as_str().unwrap())
                    .unwrap()
                    .with_timezone(&chrono::Utc);
            assert!((before..=after).contains(&probe));
            let mut guard = guard;
            guard["lastProbeAt"] = json!("fresh");
            guards.push(guard);
            assert!(db::get_setting(
                &conn,
                "recovery_probe",
                &format!("customer-address-default.retry.v1:{other}")
            )
            .is_none());
            if support_authorized {
                let payload: String = conn.query_row("SELECT payload_json FROM recovery_action_log WHERE entity_id=?1 AND action_id='nativeCustomerAddressDefaultRetry'", [&target], |r|r.get(0)).unwrap();
                let audit: Value = serde_json::from_str(&payload).unwrap();
                assert_eq!(audit["source"], "remote_support");
                assert_eq!(audit["sessionId"], request_session);
            }
        }
        assert_eq!(responses[0], responses[1]);
        assert_eq!(
            responses[0],
            json!({"success":true,"requiresRefresh":true,"verification":{"status":"pending"}})
        );
        assert_eq!(queue_states[0], queue_states[1]);
        assert_eq!(guards[0], guards[1]);
        assert_eq!(guards[0]["attempts"], 1);
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn address_retry_remote_source_text_cannot_bypass_manual_privileged_check() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let (db, _auth, target, _) = address_retry_fixture();
        let before = recovery_boundary_fingerprint(&db.state.conn.lock().unwrap());
        let error = recovery_execute_action_core(
            Some(json!({"actionId":"nativeCustomerAddressDefaultRetry","entityId":target,"source":"remote_support"})),
            false, &db.state, &auth::AuthState::new(),
            &std::sync::Arc::new(sync::SyncState::new()),
            &tokio_util::sync::CancellationToken::new(), &NoopTerminalEventSink,
        ).await.unwrap_err();
        assert!(
            matches!(error, auth::GuardedCommandError::Structured(ref error) if error.code == "AUTH_SESSION_REQUIRED")
        );
        assert_eq!(
            before,
            recovery_boundary_fingerprint(&db.state.conn.lock().unwrap())
        );
    }

    fn recovery_test_state(
        cancelled: bool,
    ) -> (
        db::DbState,
        auth::AuthState,
        std::sync::Arc<sync::SyncState>,
        tokio_util::sync::CancellationToken,
    ) {
        let cancellation = tokio_util::sync::CancellationToken::new();
        if cancelled {
            cancellation.cancel();
        }
        (
            test_db(),
            auth::AuthState::new(),
            std::sync::Arc::new(sync::SyncState::new()),
            cancellation,
        )
    }

    fn recovery_boundary_fingerprint(conn: &Connection) -> String {
        fn bytes(value: &[u8]) -> String {
            value.iter().map(|byte| format!("{byte:02x}")).collect()
        }
        let mut output = String::new();
        for table in [
            "parity_sync_queue",
            "orders",
            "order_payments",
            "payment_adjustments",
            "conflict_audit_log",
        ] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                    [table],
                    |row| row.get(0),
                )
                .expect("inspect recovery boundary table");
            output.push_str(table);
            output.push(':');
            if !exists {
                output.push_str("<absent>\n");
                continue;
            }
            let sql = format!("SELECT * FROM {table} ORDER BY rowid");
            let mut statement = conn.prepare(&sql).expect("prepare recovery fingerprint");
            let column_count = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    let mut values = Vec::with_capacity(column_count);
                    for index in 0..column_count {
                        values.push(match row.get_ref(index)? {
                            ValueRef::Null => "n".to_string(),
                            ValueRef::Integer(value) => format!("i:{value}"),
                            ValueRef::Real(value) => format!("r:{:016x}", value.to_bits()),
                            ValueRef::Text(value) => format!("t:{}", bytes(value)),
                            ValueRef::Blob(value) => format!("b:{}", bytes(value)),
                        });
                    }
                    Ok(values.join("|"))
                })
                .expect("query recovery fingerprint");
            for row in rows {
                output.push_str(&row.expect("read recovery fingerprint"));
                output.push('\n');
            }
        }
        output
    }

    fn seed_failed_recovery_row(conn: &Connection, id: &str, module: &str, priority: i64) {
        for (key, value) in [
            (
                "group_organization_id",
                "00000000-0000-4000-8000-000000000001",
            ),
            ("group_terminal_id", "terminal-recovery"),
            ("group_branch_id", "branch-recovery"),
        ] {
            db::set_setting(conn, "terminal", key, value).unwrap();
        }
        sync_queue::enqueue_payload_item(
            conn,
            "customers",
            id,
            "INSERT",
            &json!({
                "id": id,
                "organization_id": "00000000-0000-4000-8000-000000000001",
                "name": "recovery-boundary-probe"
            }),
            Some(priority),
            Some(module),
            None,
            Some(1),
        )
        .expect("enqueue recovery boundary row");
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed', attempts = 4, error_message = 'bounded failure'
             WHERE record_id = ?1",
            [id],
        )
        .expect("mark recovery row failed");
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn blocked_recovery_retry_item_and_module_do_not_prepare_or_mutate_rows() {
        let lifecycle = crate::repairs::isolate_lifecycle_for_test();
        for (action_id, params) in [
            (
                "retryParityItem",
                json!({ "sampleItemId": "blocked-retry-item" }),
            ),
            ("retryParityModule", json!({ "moduleType": "customers" })),
        ] {
            lifecycle.reset();
            let server = crate::tests::fake_http::MockServer::new(r#"{"success":true}"#);
            let _keyring = crate::tests::fake_keyring::install_seeded([
                (
                    "pos_api_key",
                    json!({
                        "key": "PRIVATE_KEY",
                        "tid": "terminal-recovery",
                        "url": server.url.clone(),
                    })
                    .to_string(),
                ),
                ("terminal_id", "terminal-recovery".to_string()),
                ("admin_dashboard_url", server.url.clone()),
            ]);
            let (db, auth_state, sync_state, cancellation) = recovery_test_state(true);
            let events = NoopTerminalEventSink;
            {
                let conn = db.conn.lock().expect("lock recovery seed db");
                seed_failed_recovery_row(&conn, "blocked-retry-item", "customers", 100);
                seed_failed_recovery_row(&conn, "blocked-retry-second", "customers", 1);
            }
            let before = {
                let conn = db.conn.lock().expect("lock recovery before db");
                recovery_boundary_fingerprint(&conn)
            };
            let request = json!({ "actionId": action_id, "params": params });

            let error = recovery_execute_action_core(
                Some(request),
                false,
                &db,
                &auth_state,
                &sync_state,
                &cancellation,
                &events,
            )
            .await
            .expect_err("blocked recovery must fail before preparation");

            assert!(
                error.to_string().contains("SYNC_CANCELLED"),
                "unexpected bounded error for {action_id}: {error}"
            );
            let after = {
                let conn = db.conn.lock().expect("lock recovery after db");
                recovery_boundary_fingerprint(&conn)
            };
            assert_eq!(after, before, "{action_id} mutated before lifecycle gate");
            assert_eq!(server.count(), 0, "{action_id} reached HTTP while blocked");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn module_recovery_blocked_after_first_item_sends_once_and_preserves_second_row() {
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let cancellation_for_server = cancellation.clone();
        let server = crate::tests::fake_http::MockServer::new_with_request_hook(
            r#"{"success":true}"#,
            move || cancellation_for_server.cancel(),
        );
        let _keyring = crate::tests::fake_keyring::install_seeded([
            (
                "pos_api_key",
                json!({
                    "key": "PRIVATE_KEY",
                    "tid": "terminal-recovery",
                    "url": server.url.clone(),
                })
                .to_string(),
            ),
            ("terminal_id", "terminal-recovery".to_string()),
            ("admin_dashboard_url", server.url.clone()),
        ]);
        let db = test_db();
        let auth_state = auth::AuthState::new();
        let sync_state = std::sync::Arc::new(sync::SyncState::new());
        let events = NoopTerminalEventSink;
        {
            let conn = db.conn.lock().expect("lock recovery interleaving seed db");
            seed_failed_recovery_row(&conn, "module-first", "customers", 100);
            seed_failed_recovery_row(&conn, "module-second", "customers", 1);
        }
        let second_before = {
            let conn = db.conn.lock().expect("lock second-row before db");
            conn.query_row(
                "SELECT * FROM parity_sync_queue WHERE record_id = 'module-second'",
                [],
                |row| {
                    let mut values = Vec::new();
                    for index in 0..row.as_ref().column_count() {
                        values.push(format!("{:?}", row.get_ref(index)?));
                    }
                    Ok(values)
                },
            )
            .expect("fingerprint second row before")
        };

        let error = recovery_execute_action_core(
            Some(json!({
                "actionId": "retryParityModule",
                "params": { "moduleType": "customers" }
            })),
            false,
            &db,
            &auth_state,
            &sync_state,
            &cancellation,
            &events,
        )
        .await
        .expect_err("second claim must observe cancellation");

        assert!(
            error.to_string().contains("SYNC_CANCELLED"),
            "unexpected bounded error after first module item: {error}"
        );
        assert_eq!(server.count(), 1, "recovery crossed the cancellation fence");
        let second_after = {
            let conn = db.conn.lock().expect("lock second-row after db");
            conn.query_row(
                "SELECT * FROM parity_sync_queue WHERE record_id = 'module-second'",
                [],
                |row| {
                    let mut values = Vec::new();
                    for index in 0..row.as_ref().column_count() {
                        values.push(format!("{:?}", row.get_ref(index)?));
                    }
                    Ok(values)
                },
            )
            .expect("fingerprint second row after")
        };
        assert_eq!(
            second_after, second_before,
            "bulk preparation touched item two"
        );
    }

    #[test]
    fn generic_recovery_cannot_read_or_mutate_repair_shaped_order_rows() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status, error_message
             ) VALUES (
                 'repair-recovery-order-op', 'orders',
                 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'UPDATE',
                 '{\"driverId\":\"repair-private-driver\",\"note\":\"repair-private-note\"}',
                 'repair-private-org', datetime('now'), 4, 1000, 1,
                 'repairs', 'manual', 7, 'conflict', 'Invalid driver id'
             )",
            [],
        )
        .expect("seed repair-shaped order row");

        let before: (String, i64, Option<String>, String, String) = conn
            .query_row(
                "SELECT status, attempts, error_message, data, organization_id
                 FROM parity_sync_queue WHERE id = 'repair-recovery-order-op'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();

        let error = prepare_invalid_driver_order_repair(&conn, "repair-recovery-order-op")
            .expect_err("generic Recovery Center must reject native repair rows");
        assert!(
            error.contains("not found") || error.contains("REPAIR_TYPED_CONFLICT_REQUIRED"),
            "unexpected repair guard error: {error}"
        );

        let after: (String, i64, Option<String>, String, String) = conn
            .query_row(
                "SELECT status, attempts, error_message, data, organization_id
                 FROM parity_sync_queue WHERE id = 'repair-recovery-order-op'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn generic_recovery_does_not_surface_repair_shaped_payment_conflicts() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status, error_message
             ) VALUES (
                 'repair-recovery-payment-op', 'payments', 'repair-private-payment',
                 'INSERT', '{\"ciphertext\":\"repair-private-ciphertext\"}',
                 'repair-private-org', datetime('now'), 4, 1000, 1,
                 'repairs', 'manual', 7, 'failed', 'Payment exceeds order total: repair-private-equation'
             )",
            [],
        )
        .expect("seed repair-shaped payment row");

        assert_eq!(
            failed_payment_total_conflict_for_payment(&conn, "repair-private-payment")
                .expect("query conflict"),
            None
        );
    }

    #[test]
    fn payment_total_conflict_repair_promotes_waiting_settlement_refund_parity_row() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-recovery-settlement', 'remote-order-recovery-settlement', '[]', 4.89, 489, 'completed', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, sync_status, sync_state, remote_payment_id, created_at, updated_at
             ) VALUES (
                 'pay-recovery-settlement', 'order-recovery-settlement', 'card', 15.19, 1519, 'completed', 'synced', 'applied',
                 '42d3701a-6b2f-4fbb-b803-36216bf2df44', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed payment");
        conn.execute(
            "INSERT INTO payment_adjustments (
                 id, payment_id, order_id, adjustment_type, amount, amount_cents, reason,
                 adjustment_context, idempotency_key, sync_state, created_at, updated_at
             ) VALUES (
                 'adj-recovery-settlement', 'pay-recovery-settlement', 'order-recovery-settlement',
                 'refund', 10.30, 1030, 'Order edit settlement',
                 'edit_settlement', 'adjustment:adj-recovery-settlement',
                 'waiting_parent', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed adjustment");
        crate::sync_queue::enqueue_payload_item(
            &conn,
            "payment_adjustments",
            "adj-recovery-settlement",
            "INSERT",
            &json!({
                "paymentId": "pay-recovery-settlement",
                "orderId": "order-recovery-settlement",
                "adjustmentType": "refund",
                "adjustmentContext": "edit_settlement",
                "amount": 10.30,
            }),
            Some(1),
            Some("payment"),
            Some("manual"),
            Some(1),
        )
        .expect("enqueue adjustment");
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 error_message = 'Waiting for parent payment sync'
             WHERE table_name = 'payment_adjustments'
               AND record_id = 'adj-recovery-settlement'",
            [],
        )
        .expect("defer adjustment parity row");

        let promoted =
            promote_waiting_settlement_refunds_for_payment(&conn, "pay-recovery-settlement")
                .expect("promote waiting refund");
        assert_eq!(promoted, 1);

        let sync_state: String = conn
            .query_row(
                "SELECT sync_state FROM payment_adjustments WHERE id = 'adj-recovery-settlement'",
                [],
                |row| row.get(0),
            )
            .expect("load adjustment state");
        assert_eq!(sync_state, "pending");

        let queue_state: (String, Option<String>) = conn
            .query_row(
                "SELECT status, error_message
                 FROM parity_sync_queue
                 WHERE table_name = 'payment_adjustments'
                   AND record_id = 'adj-recovery-settlement'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load parity row state");
        assert_eq!(queue_state, ("pending".to_string(), None));

        let equation = load_payment_settlement_equation(&conn, "pay-recovery-settlement")
            .expect("load settlement equation")
            .expect("settlement equation");
        assert_eq!(equation, "15.19 - 10.30 = 4.89; local order total 4.89");
    }

    #[test]
    fn invalid_driver_order_repair_strips_driver_id_and_requeues_row() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, error_message, status, module_type
             ) VALUES (
                 'queue-invalid-driver', 'orders', 'order-invalid-driver', 'UPDATE', ?1,
                 'org-recovery', datetime('now'), 4,
                 'HTTP 400: {\"success\":false,\"error\":\"Invalid driver\"}',
                 'failed', 'orders'
             )",
            [json!({
                "orderId": "order-invalid-driver",
                "status": "delivered",
                "driverId": "b96b6236-8164-4881-b45f-b75c1c79859c",
                "driver_id": "b96b6236-8164-4881-b45f-b75c1c79859c",
                "driverName": "Driver Name",
            })
            .to_string()],
        )
        .expect("seed invalid-driver parity row");

        let order_id = prepare_invalid_driver_order_repair(&conn, "queue-invalid-driver")
            .expect("prepare invalid driver repair");
        assert_eq!(order_id, "order-invalid-driver");

        let (status, attempts, error_message, data): (String, i64, Option<String>, String) = conn
            .query_row(
                "SELECT status, attempts, error_message, data
                 FROM parity_sync_queue
                 WHERE id = 'queue-invalid-driver'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("load repaired row");
        assert_eq!(status, "pending");
        assert_eq!(attempts, 0);
        assert_eq!(error_message, None);

        let payload: Value = serde_json::from_str(&data).expect("parse repaired payload");
        assert!(payload.get("driverId").is_none());
        assert!(payload.get("driver_id").is_none());
        assert_eq!(
            payload.get("driverName").and_then(Value::as_str),
            Some("Driver Name")
        );
    }
}
