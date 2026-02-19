//! Print spooler for The Small POS.
//!
//! Provides an offline-safe print job queue backed by the `print_jobs` SQLite
//! table.  UI "Print" actions enqueue a job; a background worker generates
//! receipt output files and dispatches them to the configured Windows printer
//! via the `printers` module.  If no printer profile is configured, the worker
//! still generates the receipt file (file-only mode).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use rusqlite::params;
use serde_json::Value;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::db::DbState;
use crate::drawer;
use crate::payments;
use crate::printers;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Directory name under the app data dir where receipt files are written.
const RECEIPTS_DIR: &str = "receipts";

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/// Create a new print job for the given entity.
///
/// Returns `{ success, jobId }` or an error.  Rejects duplicates for the same
/// `(entity_type, entity_id)` that are still pending or printing.
pub fn enqueue_print_job(
    db: &DbState,
    entity_type: &str,
    entity_id: &str,
    printer_profile_id: Option<&str>,
) -> Result<Value, String> {
    if entity_type != "order_receipt"
        && entity_type != "kitchen_ticket"
        && entity_type != "z_report"
    {
        return Err(format!(
            "Invalid entity_type: {entity_type}. Must be order_receipt, kitchen_ticket, or z_report"
        ));
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Idempotency: reject if a pending/printing job already exists for this entity
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM print_jobs
             WHERE entity_type = ?1 AND entity_id = ?2
               AND status IN ('pending', 'printing')",
            params![entity_type, entity_id],
            |row| row.get(0),
        )
        .ok();

    if let Some(existing_id) = existing {
        return Ok(serde_json::json!({
            "success": true,
            "jobId": existing_id,
            "message": "Print job already queued",
            "duplicate": true,
        }));
    }

    let job_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO print_jobs (id, entity_type, entity_id, printer_profile_id,
                                 status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)",
        params![job_id, entity_type, entity_id, printer_profile_id, now],
    )
    .map_err(|e| format!("enqueue print job: {e}"))?;

    info!(job_id = %job_id, entity_type = %entity_type, entity_id = %entity_id, "Print job enqueued");

    Ok(serde_json::json!({
        "success": true,
        "jobId": job_id,
        "message": "Print job enqueued",
    }))
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/// List print jobs, optionally filtered by status.
pub fn list_print_jobs(db: &DbState, status_filter: Option<&str>) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let row_mapper = |row: &rusqlite::Row<'_>| {
        Ok(serde_json::json!({
            "id": row.get::<_, String>(0)?,
            "entityType": row.get::<_, String>(1)?,
            "entityId": row.get::<_, String>(2)?,
            "printerProfileId": row.get::<_, Option<String>>(3)?,
            "status": row.get::<_, String>(4)?,
            "outputPath": row.get::<_, Option<String>>(5)?,
            "retryCount": row.get::<_, i32>(6)?,
            "maxRetries": row.get::<_, i32>(7)?,
            "nextRetryAt": row.get::<_, Option<String>>(8)?,
            "lastError": row.get::<_, Option<String>>(9)?,
            "warningCode": row.get::<_, Option<String>>(10)?,
            "warningMessage": row.get::<_, Option<String>>(11)?,
            "lastAttemptAt": row.get::<_, Option<String>>(12)?,
            "createdAt": row.get::<_, String>(13)?,
            "updatedAt": row.get::<_, String>(14)?,
        }))
    };

    let cols = "id, entity_type, entity_id, printer_profile_id, status,
                output_path, retry_count, max_retries, next_retry_at,
                last_error, warning_code, warning_message, last_attempt_at,
                created_at, updated_at";

    let collect_rows = |rows: rusqlite::MappedRows<'_, _>| -> Vec<Value> {
        rows.filter_map(|r| match r {
            Ok(j) => Some(j),
            Err(e) => {
                warn!("skipping malformed print job row: {e}");
                None
            }
        })
        .collect()
    };

    let jobs: Vec<Value> = if let Some(s) = status_filter {
        let sql =
            format!("SELECT {cols} FROM print_jobs WHERE status = ?1 ORDER BY created_at ASC");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![s], row_mapper)
            .map_err(|e| e.to_string())?;
        collect_rows(rows)
    } else {
        let sql = format!("SELECT {cols} FROM print_jobs ORDER BY created_at ASC");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], row_mapper).map_err(|e| e.to_string())?;
        collect_rows(rows)
    };

    Ok(serde_json::json!(jobs))
}

// ---------------------------------------------------------------------------
// Status updates
// ---------------------------------------------------------------------------

/// Mark a print job as printed with an output path.
pub fn mark_print_job_printed(db: &DbState, job_id: &str, output_path: &str) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let affected = conn
        .execute(
            "UPDATE print_jobs SET status = 'printed', output_path = ?1,
                    last_attempt_at = ?2, updated_at = ?2
             WHERE id = ?3 AND status IN ('pending', 'printing')",
            params![output_path, now, job_id],
        )
        .map_err(|e| format!("mark printed: {e}"))?;

    if affected == 0 {
        return Err(format!(
            "Print job {job_id} not found or not in printable state"
        ));
    }

    info!(job_id = %job_id, "Print job marked printed");
    Ok(())
}

/// Set a non-fatal warning on a print job (e.g. drawer kick failed).
///
/// This does NOT change the job's status — it stays "printed".  Warnings are
/// surfaced in the job list for operational visibility.
pub fn set_print_job_warning(
    db: &DbState,
    job_id: &str,
    warning_code: &str,
    warning_message: &str,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE print_jobs SET warning_code = ?1, warning_message = ?2, updated_at = ?3
         WHERE id = ?4",
        params![warning_code, warning_message, now, job_id],
    )
    .map_err(|e| format!("set warning: {e}"))?;

    warn!(
        job_id = %job_id,
        code = %warning_code,
        "Print job warning set"
    );
    Ok(())
}

/// Mark a print job as failed with an error message.
pub fn mark_print_job_failed(db: &DbState, job_id: &str, error_msg: &str) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE print_jobs SET
            status = CASE
                WHEN retry_count + 1 >= max_retries THEN 'failed'
                ELSE 'pending'
            END,
            retry_count = retry_count + 1,
            last_error = ?1,
            last_attempt_at = ?2,
            next_retry_at = CASE
                WHEN retry_count + 1 >= max_retries THEN NULL
                ELSE datetime('now', '+' || (5 * (1 << MIN(retry_count, 4))) || ' seconds')
            END,
            updated_at = ?2
         WHERE id = ?3",
        params![error_msg, now, job_id],
    )
    .map_err(|e| format!("mark failed: {e}"))?;

    warn!(job_id = %job_id, error = %error_msg, "Print job failed");
    Ok(())
}

// ---------------------------------------------------------------------------
// Receipt file generation
// ---------------------------------------------------------------------------

/// Generate a receipt HTML file for an order and write it to disk.
///
/// Returns the absolute path to the generated file.
pub fn generate_receipt_file(
    db: &DbState,
    order_id: &str,
    data_dir: &Path,
) -> Result<String, String> {
    // Use the existing receipt preview generator
    let preview = payments::get_receipt_preview(db, order_id)?;
    let html = preview["html"]
        .as_str()
        .ok_or("Receipt preview did not return HTML")?;

    // Wrap in a full HTML document for standalone viewing
    let full_html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Receipt - {order_id}</title>
<style>
  body {{ margin: 0; padding: 16px; background: #fff; font-family: monospace; }}
  @media print {{ body {{ padding: 0; }} }}
</style>
</head>
<body>
{html}
</body>
</html>"#
    );

    // Write to receipts directory
    let receipts_dir = data_dir.join(RECEIPTS_DIR);
    fs::create_dir_all(&receipts_dir).map_err(|e| format!("create receipts dir: {e}"))?;

    let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
    let filename = format!("receipt_{order_id}_{timestamp}.html");
    let file_path = receipts_dir.join(&filename);

    fs::write(&file_path, full_html).map_err(|e| format!("write receipt file: {e}"))?;

    let path_str = file_path.to_string_lossy().to_string();
    info!(order_id = %order_id, path = %path_str, "Receipt file generated");
    Ok(path_str)
}

// ---------------------------------------------------------------------------
// Hardware dispatch
// ---------------------------------------------------------------------------

/// Attempt to send a receipt file to a hardware printer.
///
/// If no printer profile is resolved (none configured and none on the job),
/// this is a no-op success — the job is considered "printed" (file-only mode).
///
/// Returns the resolved profile (if any) so the caller can pass it to the
/// drawer kick logic.
fn dispatch_to_printer(
    db: &DbState,
    job_profile_id: Option<&str>,
    html_path: &str,
) -> Result<Option<Value>, String> {
    let profile = printers::resolve_printer_profile(db, job_profile_id)?;

    let profile = match profile {
        Some(p) => p,
        None => {
            // No printer configured — file-only mode, that's fine
            info!("No printer profile configured — file-only mode");
            return Ok(None);
        }
    };

    let driver_type = profile["driverType"].as_str().unwrap_or("windows");
    let printer_name = profile["printerName"]
        .as_str()
        .ok_or("Printer profile missing printerName")?;

    match driver_type {
        "windows" => {
            printers::print_to_windows(printer_name, html_path)?;
            Ok(Some(profile))
        }
        other => Err(format!("Unsupported driver_type: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Background print worker
// ---------------------------------------------------------------------------

/// Process pending print jobs: generate receipt files and mark as printed.
///
/// This is called by the background worker loop.  It processes one batch of
/// pending jobs each tick.  Returns the number of jobs processed.
pub fn process_pending_jobs(db: &DbState, data_dir: &Path) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now_str = Utc::now().to_rfc3339();

    // Fetch pending jobs that are ready (no next_retry_at or it's in the past)
    let mut stmt = conn
        .prepare(
            "SELECT id, entity_type, entity_id, printer_profile_id FROM print_jobs
             WHERE status = 'pending'
               AND (next_retry_at IS NULL OR next_retry_at <= ?1)
             ORDER BY created_at ASC
             LIMIT 10",
        )
        .map_err(|e| e.to_string())?;

    let jobs: Vec<(String, String, String, Option<String>)> = stmt
        .query_map(params![now_str], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    drop(stmt);
    drop(conn);

    let count = jobs.len();

    for (job_id, entity_type, entity_id, profile_id) in jobs {
        // Mark as printing
        {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            let _ = conn.execute(
                "UPDATE print_jobs SET status = 'printing', updated_at = ?1 WHERE id = ?2",
                params![now_str, job_id],
            );
        }

        // Generate the receipt file first (always needed, whether or not a
        // hardware printer is configured)
        let file_result = match entity_type.as_str() {
            "order_receipt" | "kitchen_ticket" => generate_receipt_file(db, &entity_id, data_dir),
            "z_report" => crate::zreport::generate_z_report_file(db, &entity_id, data_dir),
            _ => {
                mark_print_job_failed(db, &job_id, &format!("Unknown entity_type: {entity_type}"))?;
                continue;
            }
        };

        match file_result {
            Ok(path) => {
                // Try to dispatch to hardware printer
                match dispatch_to_printer(db, profile_id.as_deref(), &path) {
                    Ok(resolved_profile) => {
                        mark_print_job_printed(db, &job_id, &path)?;

                        // Non-fatal drawer kick: if profile has open_cash_drawer
                        // enabled, attempt to open the drawer. Failures are logged
                        // and recorded as a warning but do NOT change the job status.
                        if let Some(ref prof) = resolved_profile {
                            if let Err(e) = drawer::try_drawer_kick_after_print(db, prof) {
                                let _ =
                                    set_print_job_warning(db, &job_id, "drawer_kick_failed", &e);
                            }
                        }
                    }
                    Err(e) => {
                        // Receipt file exists, but hardware print failed
                        warn!(job_id = %job_id, error = %e, "Hardware print failed, file generated at {path}");
                        mark_print_job_failed(db, &job_id, &e)?;
                    }
                }
            }
            Err(e) => {
                mark_print_job_failed(db, &job_id, &e)?;
            }
        }
    }

    if count > 0 {
        info!(processed = count, "Print worker processed jobs");
    }

    Ok(count)
}

/// Start the background print worker loop.
///
/// Runs every `interval_secs` seconds, processes pending print jobs.
pub fn start_print_worker(db: Arc<DbState>, data_dir: PathBuf, interval_secs: u64) {
    tauri::async_runtime::spawn(async move {
        let interval = tokio::time::Duration::from_secs(interval_secs);
        loop {
            tokio::time::sleep(interval).await;
            match process_pending_jobs(&db, &data_dir) {
                Ok(_) => {}
                Err(e) => error!("Print worker error: {e}"),
            }
        }
    });

    info!(interval_secs = interval_secs, "Print worker started");
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;
    use std::sync::Mutex;

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
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    #[test]
    fn test_enqueue_and_list() {
        let db = test_db();

        // Enqueue a job
        let result = enqueue_print_job(&db, "order_receipt", "ord-1", None).unwrap();
        assert_eq!(result["success"], true);
        let job_id = result["jobId"].as_str().unwrap().to_string();

        // List all jobs
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["entityId"], "ord-1");
        assert_eq!(arr[0]["status"], "pending");

        // List pending jobs
        let pending = list_print_jobs(&db, Some("pending")).unwrap();
        assert_eq!(pending.as_array().unwrap().len(), 1);

        // List printed jobs (should be empty)
        let printed = list_print_jobs(&db, Some("printed")).unwrap();
        assert_eq!(printed.as_array().unwrap().len(), 0);

        // Verify idempotency — enqueue same entity again
        let dup = enqueue_print_job(&db, "order_receipt", "ord-1", None).unwrap();
        assert_eq!(dup["success"], true);
        assert_eq!(dup["duplicate"], true);
        assert_eq!(dup["jobId"], job_id);

        // Total jobs should still be 1
        let jobs2 = list_print_jobs(&db, None).unwrap();
        assert_eq!(jobs2.as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_mark_printed() {
        let db = test_db();

        let result = enqueue_print_job(&db, "order_receipt", "ord-2", None).unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        mark_print_job_printed(&db, job_id, "/tmp/receipt.html").unwrap();

        let jobs = list_print_jobs(&db, Some("printed")).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["outputPath"], "/tmp/receipt.html");
    }

    #[test]
    fn test_mark_failed_with_retry() {
        let db = test_db();

        let result = enqueue_print_job(&db, "order_receipt", "ord-3", None).unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        // First failure — should stay pending (retry_count < max_retries)
        mark_print_job_failed(&db, job_id, "printer offline").unwrap();

        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr[0]["retryCount"], 1);
        assert_eq!(arr[0]["status"], "pending");
        assert_eq!(arr[0]["lastError"], "printer offline");

        // Second failure
        mark_print_job_failed(&db, job_id, "still offline").unwrap();
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr[0]["retryCount"], 2);
        assert_eq!(arr[0]["status"], "pending");

        // Third failure — should move to failed (max_retries=3)
        mark_print_job_failed(&db, job_id, "gave up").unwrap();
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr[0]["retryCount"], 3);
        assert_eq!(arr[0]["status"], "failed");
    }

    #[test]
    fn test_idempotency_allows_retry_after_failure() {
        let db = test_db();

        // Enqueue
        let result = enqueue_print_job(&db, "order_receipt", "ord-4", None).unwrap();
        let job_id = result["jobId"].as_str().unwrap().to_string();

        // Fail it 3 times to exhaust retries
        for _ in 0..3 {
            mark_print_job_failed(&db, &job_id, "error").unwrap();
        }

        // Now the job is "failed" — a new enqueue for same entity should create a new job
        let result2 = enqueue_print_job(&db, "order_receipt", "ord-4", None).unwrap();
        assert_eq!(result2["success"], true);
        assert_eq!(result2.get("duplicate"), None);
        let new_job_id = result2["jobId"].as_str().unwrap();
        assert_ne!(new_job_id, job_id);
    }

    #[test]
    fn test_generate_receipt_file() {
        let db = test_db();

        // Insert an order so receipt generation works
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, subtotal, status, order_type, sync_status, created_at, updated_at)
                 VALUES ('ord-gen', 'ORD-999', '[{\"name\":\"Test Item\",\"quantity\":1,\"totalPrice\":10.0}]', 10.0, 10.0, 'completed', 'dine-in', 'pending', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }

        let dir = std::env::temp_dir().join("pos_tauri_test_print");
        let _ = fs::create_dir_all(&dir);

        let path = generate_receipt_file(&db, "ord-gen", &dir).unwrap();
        assert!(path.contains("receipt_ord-gen_"));
        assert!(path.ends_with(".html"));

        // Verify file exists and contains expected content
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("ORD-999"));
        assert!(content.contains("Test Item"));
        assert!(content.contains("10.00"));

        // Cleanup
        let _ = fs::remove_dir_all(dir.join(RECEIPTS_DIR));
    }

    #[test]
    fn test_process_pending_jobs() {
        let db = test_db();

        // Insert an order
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, subtotal, status, order_type, sync_status, created_at, updated_at)
                 VALUES ('ord-proc', 'ORD-100', '[{\"name\":\"Coffee\",\"quantity\":2,\"totalPrice\":6.0}]', 6.0, 6.0, 'completed', 'takeaway', 'pending', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }

        // Enqueue a print job
        enqueue_print_job(&db, "order_receipt", "ord-proc", None).unwrap();

        let dir = std::env::temp_dir().join("pos_tauri_test_worker");
        let _ = fs::create_dir_all(&dir);

        // Process
        let count = process_pending_jobs(&db, &dir).unwrap();
        assert_eq!(count, 1);

        // Verify job is now printed
        let jobs = list_print_jobs(&db, Some("printed")).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert!(arr[0]["outputPath"]
            .as_str()
            .unwrap()
            .contains("receipt_ord-proc_"));

        // Process again — should be no-op
        let count2 = process_pending_jobs(&db, &dir).unwrap();
        assert_eq!(count2, 0);

        // Cleanup
        let _ = fs::remove_dir_all(dir.join(RECEIPTS_DIR));
    }

    #[test]
    fn test_set_print_job_warning() {
        let db = test_db();

        let result = enqueue_print_job(&db, "order_receipt", "ord-warn", None).unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        // Mark as printed first (warnings apply to printed jobs)
        mark_print_job_printed(&db, job_id, "/tmp/receipt.html").unwrap();

        // Set a warning
        set_print_job_warning(
            &db,
            job_id,
            "drawer_kick_failed",
            "TCP connect failed: timeout",
        )
        .unwrap();

        // Verify warning is visible in the job list
        let jobs = list_print_jobs(&db, Some("printed")).unwrap();
        let arr = jobs.as_array().unwrap();
        let job = arr.iter().find(|j| j["id"] == job_id).unwrap();
        assert_eq!(job["warningCode"], "drawer_kick_failed");
        assert_eq!(job["warningMessage"], "TCP connect failed: timeout");
        assert_eq!(job["status"], "printed"); // status unchanged
    }

    #[test]
    fn test_print_job_last_attempt_at_set() {
        let db = test_db();

        let result = enqueue_print_job(&db, "order_receipt", "ord-ts", None).unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        // Mark as printed
        mark_print_job_printed(&db, job_id, "/tmp/receipt.html").unwrap();

        // Verify last_attempt_at is set
        let jobs = list_print_jobs(&db, Some("printed")).unwrap();
        let arr = jobs.as_array().unwrap();
        let job = arr.iter().find(|j| j["id"] == job_id).unwrap();
        assert!(
            job["lastAttemptAt"].as_str().is_some(),
            "lastAttemptAt should be set after printing"
        );
    }

    #[test]
    fn test_process_job_for_missing_order() {
        let db = test_db();

        // Enqueue a job for a non-existent order
        enqueue_print_job(&db, "order_receipt", "ord-nonexistent", None).unwrap();

        let dir = std::env::temp_dir().join("pos_tauri_test_missing");
        let _ = fs::create_dir_all(&dir);

        // Process — should fail the job gracefully
        let count = process_pending_jobs(&db, &dir).unwrap();
        assert_eq!(count, 1);

        // Job should have retry_count incremented
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr[0]["retryCount"], 1);
        assert!(arr[0]["lastError"].as_str().unwrap().contains("not found"));
    }
}
