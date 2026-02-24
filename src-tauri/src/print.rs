//! Print spooler for The Small POS.
//!
//! Provides an offline-safe print job queue backed by the `print_jobs` SQLite
//! table.  UI "Print" actions enqueue a job; a background worker generates
//! receipt output files and dispatches them to the configured Windows printer
//! via the `printers` module. Missing/unavailable hardware profile resolution
//! is treated as a non-retryable failure.

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
        && entity_type != "shift_checkout"
    {
        return Err(format!(
            "Invalid entity_type: {entity_type}. Must be order_receipt, kitchen_ticket, shift_checkout, or z_report"
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

/// Mark a print job as permanently failed (no retry).
pub fn mark_print_job_failed_non_retryable(
    db: &DbState,
    job_id: &str,
    error_msg: &str,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE print_jobs SET
            status = 'failed',
            retry_count = retry_count + 1,
            last_error = ?1,
            last_attempt_at = ?2,
            next_retry_at = NULL,
            updated_at = ?2
         WHERE id = ?3",
        params![error_msg, now, job_id],
    )
    .map_err(|e| format!("mark failed non-retryable: {e}"))?;

    warn!(
        job_id = %job_id,
        error = %error_msg,
        "Print job failed (non-retryable)"
    );
    Ok(())
}

fn is_non_retryable_print_error(error_msg: &str) -> bool {
    let normalized = error_msg.to_ascii_lowercase();
    normalized.contains("no hardware printer profile resolved")
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

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn generate_kitchen_ticket_file(
    db: &DbState,
    order_id: &str,
    data_dir: &Path,
) -> Result<String, String> {
    let (
        order_number,
        order_type,
        table_number,
        delivery_address,
        delivery_notes,
        special_instructions,
        created_at,
        items_json,
    ) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT
                COALESCE(order_number, ''),
                COALESCE(order_type, ''),
                COALESCE(table_number, ''),
                COALESCE(delivery_address, ''),
                COALESCE(delivery_notes, ''),
                COALESCE(special_instructions, ''),
                COALESCE(created_at, ''),
                COALESCE(items, '[]')
             FROM orders
             WHERE id = ?1",
            params![order_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .map_err(|_| format!("Order not found: {order_id}"))?
    };

    let parsed_items: Vec<Value> = serde_json::from_str::<Value>(&items_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let mut items_html = String::new();
    for item in parsed_items {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Item")
            .trim();
        let qty = item.get("quantity").and_then(Value::as_f64).unwrap_or(1.0);
        let notes = item
            .get("notes")
            .or_else(|| item.get("special_instructions"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        items_html.push_str(&format!(
            "<li><strong>{:.0}x {}</strong>{}</li>",
            qty,
            escape_html(name),
            if notes.is_empty() {
                String::new()
            } else {
                format!("<br/><small>Note: {}</small>", escape_html(notes))
            }
        ));
    }
    if items_html.is_empty() {
        items_html.push_str("<li>No items</li>");
    }

    let ticket_html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Kitchen Ticket - {order_id}</title>
<style>
  body {{ margin: 0; padding: 10px; background: #fff; font-family: monospace; font-size: 13px; }}
  h1 {{ margin: 0 0 6px 0; font-size: 18px; }}
  hr {{ border: none; border-top: 1px dashed #000; margin: 8px 0; }}
  ul {{ margin: 0; padding-left: 18px; }}
  li {{ margin: 4px 0; }}
  .meta {{ line-height: 1.35; white-space: pre-wrap; }}
</style>
</head>
<body>
<h1>KITCHEN TICKET</h1>
<div class="meta">
Order: {order_number}
Type: {order_type}
Table: {table_number}
Created: {created_at}
Address: {delivery_address}
Delivery Notes: {delivery_notes}
Order Notes: {special_instructions}
</div>
<hr/>
<ul>{items_html}</ul>
<hr/>
<div>-- End Ticket --</div>
</body>
</html>"#,
        order_id = escape_html(order_id),
        order_number = escape_html(&order_number),
        order_type = escape_html(&order_type),
        table_number = escape_html(&table_number),
        created_at = escape_html(&created_at),
        delivery_address = escape_html(&delivery_address),
        delivery_notes = escape_html(&delivery_notes),
        special_instructions = escape_html(&special_instructions),
        items_html = items_html,
    );

    let receipts_dir = data_dir.join(RECEIPTS_DIR);
    fs::create_dir_all(&receipts_dir).map_err(|e| format!("create receipts dir: {e}"))?;
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
    let filename = format!("kitchen_ticket_{order_id}_{timestamp}.html");
    let file_path = receipts_dir.join(&filename);
    fs::write(&file_path, ticket_html).map_err(|e| format!("write kitchen ticket file: {e}"))?;
    let path_str = file_path.to_string_lossy().to_string();
    info!(order_id = %order_id, path = %path_str, "Kitchen ticket file generated");
    Ok(path_str)
}

fn generate_shift_checkout_file(
    db: &DbState,
    shift_id: &str,
    data_dir: &Path,
) -> Result<String, String> {
    let summary = crate::shifts::get_shift_summary(db, shift_id)?;
    let shift = summary
        .get("shift")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let cash_drawer = summary
        .get("cashDrawer")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let role_type = shift
        .get("role_type")
        .or_else(|| shift.get("roleType"))
        .and_then(Value::as_str)
        .unwrap_or("staff");
    let staff_name = shift
        .get("staff_name")
        .or_else(|| shift.get("staffName"))
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Unknown");
    let terminal_name = shift
        .get("terminal_id")
        .or_else(|| shift.get("terminalId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let check_in = shift
        .get("check_in_time")
        .or_else(|| shift.get("checkInTime"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let check_out = shift
        .get("check_out_time")
        .or_else(|| shift.get("checkOutTime"))
        .and_then(Value::as_str)
        .unwrap_or("");

    let orders_count = summary
        .get("ordersCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let sales_amount = summary
        .get("salesAmount")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let total_expenses = summary
        .get("totalExpenses")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let cash_refunds = summary
        .get("cashRefunds")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    let opening = cash_drawer
        .get("opening_amount")
        .or_else(|| cash_drawer.get("openingAmount"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let expected = cash_drawer
        .get("expected_amount")
        .or_else(|| cash_drawer.get("expectedAmount"))
        .and_then(Value::as_f64);
    let closing = cash_drawer
        .get("closing_amount")
        .or_else(|| cash_drawer.get("closingAmount"))
        .and_then(Value::as_f64);
    let variance = cash_drawer
        .get("variance_amount")
        .or_else(|| cash_drawer.get("varianceAmount"))
        .and_then(Value::as_f64);

    let receipt_html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Shift Checkout - {shift_id}</title>
<style>
  body {{ margin: 0; padding: 16px; background: #fff; font-family: monospace; }}
  h1 {{ margin: 0 0 10px 0; font-size: 18px; }}
  .line {{ display: flex; justify-content: space-between; }}
  hr {{ border: none; border-top: 1px dashed #000; margin: 8px 0; }}
</style>
</head>
<body>
<h1>SHIFT CHECKOUT</h1>
<div class="line"><span>Shift</span><span>{shift_id_short}</span></div>
<div class="line"><span>Role</span><span>{role_type}</span></div>
<div class="line"><span>Staff</span><span>{staff_name}</span></div>
<div class="line"><span>Terminal</span><span>{terminal_name}</span></div>
<div class="line"><span>Check-in</span><span>{check_in}</span></div>
<div class="line"><span>Check-out</span><span>{check_out}</span></div>
<hr/>
<div class="line"><span>Orders</span><span>{orders_count}</span></div>
<div class="line"><span>Sales</span><span>{sales_amount:.2}</span></div>
<div class="line"><span>Expenses</span><span>{total_expenses:.2}</span></div>
<div class="line"><span>Refunds</span><span>{cash_refunds:.2}</span></div>
<hr/>
<div class="line"><span>Opening</span><span>{opening:.2}</span></div>
<div class="line"><span>Expected</span><span>{expected}</span></div>
<div class="line"><span>Closing</span><span>{closing}</span></div>
<div class="line"><span>Variance</span><span>{variance}</span></div>
<hr/>
<div>End of Checkout</div>
</body>
</html>"#,
        shift_id = escape_html(shift_id),
        shift_id_short = escape_html(shift_id.get(..8).unwrap_or(shift_id)),
        role_type = escape_html(role_type),
        staff_name = escape_html(staff_name),
        terminal_name = escape_html(terminal_name),
        check_in = escape_html(check_in),
        check_out = escape_html(check_out),
        orders_count = orders_count,
        sales_amount = sales_amount,
        total_expenses = total_expenses,
        cash_refunds = cash_refunds,
        opening = opening,
        expected = expected
            .map(|value| format!("{value:.2}"))
            .unwrap_or_else(|| "N/A".to_string()),
        closing = closing
            .map(|value| format!("{value:.2}"))
            .unwrap_or_else(|| "N/A".to_string()),
        variance = variance
            .map(|value| format!("{value:.2}"))
            .unwrap_or_else(|| "N/A".to_string()),
    );

    let receipts_dir = data_dir.join(RECEIPTS_DIR);
    fs::create_dir_all(&receipts_dir).map_err(|e| format!("create receipts dir: {e}"))?;
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
    let filename = format!("shift_checkout_{shift_id}_{timestamp}.html");
    let file_path = receipts_dir.join(filename);
    fs::write(&file_path, receipt_html).map_err(|e| format!("write shift checkout file: {e}"))?;
    Ok(file_path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Hardware dispatch
// ---------------------------------------------------------------------------

/// Attempt to send a receipt file to a hardware printer.
///
/// Returns the resolved profile (if any) so the caller can pass it to the
/// drawer kick logic.
fn dispatch_to_printer(
    db: &DbState,
    entity_type: &str,
    job_profile_id: Option<&str>,
    html_path: &str,
) -> Result<Option<Value>, String> {
    use crate::escpos;

    let role = match entity_type {
        "kitchen_ticket" => "kitchen",
        "order_receipt" | "shift_checkout" | "z_report" => "receipt",
        _ => "receipt",
    };
    let profile = printers::resolve_printer_profile_for_role(db, job_profile_id, Some(role))?;

    let profile = match profile {
        Some(p) => p,
        None => {
            return Err(format!(
                "No hardware printer profile resolved for entity type {entity_type}"
            ));
        }
    };

    let driver_type = profile["driverType"].as_str().unwrap_or("windows");
    let printer_name = profile["printerName"]
        .as_str()
        .ok_or("Printer profile missing printerName")?;
    if printer_name.trim().is_empty() {
        return Err("Resolved printer profile has empty printerName".into());
    }
    let paper_mm = profile
        .get("paperWidthMm")
        .and_then(|v| v.as_i64())
        .unwrap_or(80) as i32;
    let should_cut = profile
        .get("cutPaper")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    match driver_type {
        // Raw ESC/POS dispatch (default for thermal printers)
        "windows" | "escpos" => {
            // Read the HTML receipt and strip to plain text for ESC/POS
            let html_content = fs::read_to_string(html_path)
                .map_err(|e| format!("Failed to read receipt file: {e}"))?;
            let plain_text = strip_html_to_text(&html_content);

            let paper = escpos::PaperWidth::from_mm(paper_mm);
            let mut builder = escpos::EscPosBuilder::new().with_paper(paper);
            builder.init();

            // Emit each line of plain text
            for line in plain_text.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    builder.lf();
                } else {
                    builder.text(trimmed).lf();
                }
            }

            builder.feed(3);
            if should_cut {
                builder.cut();
            }

            let data = builder.build();
            let doc_name = match entity_type {
                "kitchen_ticket" => "POS Kitchen Ticket",
                "shift_checkout" => "POS Shift Checkout",
                "z_report" => "POS Z Report",
                _ => "POS Receipt",
            };
            let _dispatch = printers::print_raw_to_windows(printer_name, &data, doc_name)?;
            Ok(Some(profile))
        }
        other => Err(format!("Unsupported driver_type: {other}")),
    }
}

/// Strip HTML tags from a string and normalize whitespace to produce readable
/// plain text for ESC/POS printing. This is a lightweight tag stripper, not a
/// full HTML parser.
fn strip_html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut last_was_space = false;

    // Insert a newline for block-level tags
    let block_tags = [
        "<br", "<p", "<div", "<tr", "<li", "<h1", "<h2", "<h3", "<hr",
    ];

    let lower = html.to_lowercase();
    let chars: Vec<char> = html.chars().collect();
    let lower_chars: Vec<char> = lower.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == '<' {
            // Check for block-level tag to insert newline
            let remaining: String = lower_chars[i..].iter().collect();
            for tag in &block_tags {
                if remaining.starts_with(tag) && !last_was_space {
                    out.push('\n');
                    last_was_space = true;
                    break;
                }
            }
            in_tag = true;
            i += 1;
            continue;
        }

        if chars[i] == '>' {
            in_tag = false;
            i += 1;
            continue;
        }

        if !in_tag {
            // Decode common HTML entities
            if chars[i] == '&' {
                let remaining: String = chars[i..].iter().take(10).collect();
                if remaining.starts_with("&amp;") {
                    out.push('&');
                    i += 5;
                } else if remaining.starts_with("&lt;") {
                    out.push('<');
                    i += 4;
                } else if remaining.starts_with("&gt;") {
                    out.push('>');
                    i += 4;
                } else if remaining.starts_with("&nbsp;") {
                    out.push(' ');
                    i += 6;
                } else if remaining.starts_with("&#8364;") || remaining.starts_with("&euro;") {
                    out.push('€');
                    i += if remaining.starts_with("&#") { 7 } else { 6 };
                } else {
                    out.push(chars[i]);
                    i += 1;
                }
                last_was_space = false;
                continue;
            }

            if chars[i] == '\n' || chars[i] == '\r' {
                if !last_was_space {
                    out.push('\n');
                    last_was_space = true;
                }
            } else {
                out.push(chars[i]);
                last_was_space = chars[i] == ' ';
            }
        }

        i += 1;
    }

    out
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
               AND (next_retry_at IS NULL OR julianday(next_retry_at) <= julianday(?1))
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

        // Generate the receipt/ticket file first, then attempt hardware dispatch.
        let file_result = match entity_type.as_str() {
            "order_receipt" => generate_receipt_file(db, &entity_id, data_dir),
            "kitchen_ticket" => generate_kitchen_ticket_file(db, &entity_id, data_dir),
            "shift_checkout" => generate_shift_checkout_file(db, &entity_id, data_dir),
            "z_report" => crate::zreport::generate_z_report_file(db, &entity_id, data_dir),
            _ => {
                mark_print_job_failed(db, &job_id, &format!("Unknown entity_type: {entity_type}"))?;
                continue;
            }
        };

        match file_result {
            Ok(path) => {
                // Try to dispatch to hardware printer
                match dispatch_to_printer(db, &entity_type, profile_id.as_deref(), &path) {
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
                        if is_non_retryable_print_error(&e) {
                            mark_print_job_failed_non_retryable(db, &job_id, &e)?;
                        } else {
                            mark_print_job_failed(db, &job_id, &e)?;
                        }
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
    fn test_non_retryable_error_classifier() {
        assert!(is_non_retryable_print_error(
            "No hardware printer profile resolved for entity type order_receipt"
        ));
        assert!(!is_non_retryable_print_error("printer offline"));
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

        // No hardware profile configured -> non-retryable failure.
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["status"], "failed");
        assert_eq!(arr[0]["retryCount"], 1);
        assert!(arr[0]["lastError"]
            .as_str()
            .unwrap_or_default()
            .contains("No hardware printer profile resolved"));
        assert!(arr[0]["nextRetryAt"].is_null());

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

    #[test]
    fn test_enqueue_shift_checkout_job() {
        let db = test_db();
        let result = enqueue_print_job(&db, "shift_checkout", "shift-42", None).unwrap();
        assert_eq!(result["success"], true);
        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["entityType"], "shift_checkout");
    }
}
