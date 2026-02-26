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
use std::time::Duration;

use base64::Engine as _;
use chrono::Utc;
use image::imageops::FilterType;
use rusqlite::params;
use serde_json::Value;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::db::DbState;
use crate::drawer;
use crate::printers;
use crate::receipt_renderer::{
    self, AdjustmentLine, KitchenTicketDoc, LayoutConfig, OrderReceiptDoc, PaymentLine,
    ReceiptCustomizationLine, ReceiptDocument, ReceiptItem, ReceiptTemplate, ShiftCheckoutDoc,
    TotalsLine, ZReportDoc,
};

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
    enqueue_print_job_with_payload(db, entity_type, entity_id, printer_profile_id, None)
}

/// Create a new print job and optionally persist payload snapshot JSON.
pub fn enqueue_print_job_with_payload(
    db: &DbState,
    entity_type: &str,
    entity_id: &str,
    printer_profile_id: Option<&str>,
    entity_payload_json: Option<&Value>,
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
    let payload_string =
        entity_payload_json.and_then(|payload| serde_json::to_string(payload).ok());

    conn.execute(
        "INSERT INTO print_jobs (id, entity_type, entity_id, entity_payload_json, printer_profile_id,
                                 status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)",
        params![
            job_id,
            entity_type,
            entity_id,
            payload_string,
            printer_profile_id,
            now
        ],
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
            "entityPayloadJson": row.get::<_, Option<String>>(3)?,
            "printerProfileId": row.get::<_, Option<String>>(4)?,
            "status": row.get::<_, String>(5)?,
            "outputPath": row.get::<_, Option<String>>(6)?,
            "retryCount": row.get::<_, i32>(7)?,
            "maxRetries": row.get::<_, i32>(8)?,
            "nextRetryAt": row.get::<_, Option<String>>(9)?,
            "lastError": row.get::<_, Option<String>>(10)?,
            "warningCode": row.get::<_, Option<String>>(11)?,
            "warningMessage": row.get::<_, Option<String>>(12)?,
            "lastAttemptAt": row.get::<_, Option<String>>(13)?,
            "createdAt": row.get::<_, String>(14)?,
            "updatedAt": row.get::<_, String>(15)?,
        }))
    };

    let cols = "id, entity_type, entity_id, entity_payload_json, printer_profile_id, status,
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

fn setting_text(conn: &rusqlite::Connection, category: &str, key: &str) -> Option<String> {
    crate::db::get_setting(conn, category, key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn setting_bool(conn: &rusqlite::Connection, category: &str, key: &str) -> bool {
    let raw = setting_text(conn, category, key).unwrap_or_default();
    matches!(
        raw.to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn parse_number(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return Some(number);
    }
    if let Some(number) = value.as_i64() {
        return Some(number as f64);
    }
    if let Some(text) = value.as_str() {
        return text.trim().parse::<f64>().ok();
    }
    None
}

fn parse_bool(value: &Value) -> Option<bool> {
    if let Some(flag) = value.as_bool() {
        return Some(flag);
    }
    if let Some(number) = value.as_i64() {
        return Some(number != 0);
    }
    if let Some(text) = value.as_str() {
        let normalized = text.trim().to_ascii_lowercase();
        if matches!(normalized.as_str(), "1" | "true" | "yes" | "on") {
            return Some(true);
        }
        if matches!(normalized.as_str(), "0" | "false" | "no" | "off") {
            return Some(false);
        }
    }
    None
}

fn value_from_keys<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        if let Some(found) = value.get(*key) {
            return Some(found);
        }
    }
    None
}

fn text_from_keys(value: &Value, keys: &[&str]) -> Option<String> {
    value_from_keys(value, keys)
        .and_then(Value::as_str)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn number_from_keys(value: &Value, keys: &[&str]) -> Option<f64> {
    value_from_keys(value, keys).and_then(parse_number)
}

fn bool_from_keys(value: &Value, keys: &[&str]) -> bool {
    value_from_keys(value, keys)
        .and_then(parse_bool)
        .unwrap_or(false)
}

fn looks_like_customization_object(value: &Value) -> bool {
    if !value.is_object() {
        return false;
    }
    value.get("ingredient").is_some()
        || value.get("name").is_some()
        || value.get("name_en").is_some()
        || value.get("name_el").is_some()
        || value.get("label").is_some()
        || value.get("optionName").is_some()
        || value.get("isWithout").is_some()
        || value.get("is_without").is_some()
        || value.get("without").is_some()
        || value.get("price").is_some()
}

fn flatten_customization_values(value: &Value) -> Vec<Value> {
    if let Some(array) = value.as_array() {
        return array.clone();
    }
    if value.is_object() {
        if looks_like_customization_object(value) {
            return vec![value.clone()];
        }
        if let Some(object) = value.as_object() {
            return object.values().cloned().collect();
        }
    }
    if let Some(raw) = value.as_str() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            return flatten_customization_values(&parsed);
        }
    }
    Vec::new()
}

fn extract_customization_name(entry: &Value) -> Option<String> {
    if let Some(ingredient) = entry.get("ingredient") {
        if let Some(name) = text_from_keys(ingredient, &["name", "name_en", "name_el"]) {
            return Some(name);
        }
    }
    text_from_keys(
        entry,
        &["name", "name_en", "name_el", "label", "optionName"],
    )
}

fn extract_customization_price(entry: &Value, is_without: bool) -> Option<f64> {
    if is_without {
        return None;
    }

    if let Some(ingredient) = entry.get("ingredient") {
        if let Some(price) = number_from_keys(
            ingredient,
            &[
                "price",
                "pickup_price",
                "delivery_price",
                "base_price",
                "additionalPrice",
                "extra_price",
            ],
        )
        .filter(|value| *value > 0.0)
        {
            return Some(price);
        }
    }

    number_from_keys(
        entry,
        &[
            "price",
            "pickup_price",
            "delivery_price",
            "base_price",
            "additionalPrice",
            "extra_price",
        ],
    )
    .filter(|value| *value > 0.0)
}

fn parse_customization_entries(raw: &Value) -> Vec<ReceiptCustomizationLine> {
    flatten_customization_values(raw)
        .into_iter()
        .filter_map(|entry| {
            let name = extract_customization_name(&entry)?;
            let is_without = bool_from_keys(&entry, &["isWithout", "is_without", "without"]);
            let quantity = number_from_keys(&entry, &["quantity", "qty"])
                .filter(|value| *value > 0.0)
                .unwrap_or(1.0);
            let is_little = bool_from_keys(&entry, &["isLittle", "is_little", "little"]);
            let price = extract_customization_price(&entry, is_without);
            Some(ReceiptCustomizationLine {
                name,
                quantity,
                is_without,
                is_little,
                price,
            })
        })
        .collect()
}

fn parse_item_customizations(item: &Value) -> Vec<ReceiptCustomizationLine> {
    for key in [
        "customizations",
        "modifiers",
        "ingredients",
        "selectedIngredients",
    ] {
        if let Some(raw) = item.get(key) {
            let parsed = parse_customization_entries(raw);
            if !parsed.is_empty() {
                return parsed;
            }
        }
    }
    Vec::new()
}

fn parse_item_total(item: &Value) -> f64 {
    item.get("totalPrice")
        .or_else(|| item.get("total_price"))
        .or_else(|| item.get("price"))
        .or_else(|| item.get("unitPrice"))
        .and_then(parse_number)
        .unwrap_or(0.0)
}

fn extract_last4_digits(input: &str) -> Option<String> {
    let digits: String = input.chars().filter(|ch| ch.is_ascii_digit()).collect();
    if digits.len() >= 4 {
        digits.get(digits.len() - 4..).map(ToString::to_string)
    } else {
        None
    }
}

fn resolve_layout_config(
    db: &DbState,
    profile: &Value,
    entity_type: &str,
) -> Result<LayoutConfig, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let paper_mm = profile
        .get("paperWidthMm")
        .or_else(|| profile.get("paper_width_mm"))
        .and_then(Value::as_i64)
        .unwrap_or(80) as i32;
    let template = ReceiptTemplate::from_value(
        profile
            .get("receiptTemplate")
            .or_else(|| profile.get("receipt_template"))
            .and_then(Value::as_str),
    );
    let organization_name = setting_text(&conn, "organization", "name")
        .or_else(|| setting_text(&conn, "restaurant", "name"))
        .or_else(|| setting_text(&conn, "terminal", "store_name"))
        .unwrap_or_else(|| "The Small".to_string());
    let store_address = setting_text(&conn, "restaurant", "address")
        .or_else(|| setting_text(&conn, "terminal", "store_address"));
    let store_phone = setting_text(&conn, "restaurant", "phone")
        .or_else(|| setting_text(&conn, "terminal", "store_phone"));
    let footer_text = setting_text(&conn, "receipt", "footer_text")
        .or_else(|| setting_text(&conn, "restaurant", "receipt_footer"))
        .or(Some("Thank you".to_string()));
    let qr_data = setting_text(&conn, "receipt", "qr_url")
        .or_else(|| setting_text(&conn, "restaurant", "website"));
    let show_qr_code = setting_bool(&conn, "receipt", "show_qr_code");
    let show_logo = setting_bool(&conn, "receipt", "show_logo");
    let logo_url = setting_text(&conn, "receipt", "logo_source")
        .or_else(|| setting_text(&conn, "organization", "logo_url"));
    let copy_label = setting_text(&conn, "receipt", "copy_label").or_else(|| {
        if entity_type == "kitchen_ticket" {
            None
        } else {
            setting_text(&conn, "receipt", "copy_type").map(|value| value.to_ascii_uppercase())
        }
    });
    let character_set = profile
        .get("characterSet")
        .or_else(|| profile.get("character_set"))
        .and_then(Value::as_str)
        .unwrap_or("PC437_USA")
        .to_string();
    let greek_render_mode = profile
        .get("greekRenderMode")
        .or_else(|| profile.get("greek_render_mode"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    Ok(LayoutConfig {
        paper_width: crate::escpos::PaperWidth::from_mm(paper_mm),
        template,
        organization_name,
        store_address,
        store_phone,
        footer_text,
        show_qr_code,
        qr_data,
        show_logo,
        logo_url,
        copy_label,
        character_set,
        greek_render_mode,
    })
}

fn paper_logo_max_width_dots(paper: crate::escpos::PaperWidth) -> u32 {
    match paper {
        crate::escpos::PaperWidth::Mm58 => 384,
        crate::escpos::PaperWidth::Mm80 => 576,
        crate::escpos::PaperWidth::Mm112 => 832,
    }
}

fn parse_data_url_image(source: &str) -> Option<Vec<u8>> {
    let trimmed = source.trim();
    if !trimmed.starts_with("data:image/") {
        return None;
    }
    let (_, payload) = trimmed.split_once(',')?;
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()
}

fn read_logo_source_bytes(source: &str) -> Result<Vec<u8>, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Logo source is empty".to_string());
    }

    if let Some(bytes) = parse_data_url_image(trimmed) {
        return Ok(bytes);
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let url = trimmed.to_string();
        return tauri::async_runtime::block_on(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(8))
                .build()
                .map_err(|e| format!("logo HTTP client: {e}"))?;
            let response = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("logo fetch failed: {e}"))?;
            if !response.status().is_success() {
                return Err(format!("logo fetch failed with HTTP {}", response.status()));
            }
            response
                .bytes()
                .await
                .map(|bytes| bytes.to_vec())
                .map_err(|e| format!("logo fetch bytes failed: {e}"))
        });
    }

    let path_value = if trimmed.starts_with("file://") {
        let raw = trimmed.trim_start_matches("file://");
        if cfg!(windows) && raw.starts_with('/') {
            let bytes = raw.as_bytes();
            if bytes.len() >= 3 && bytes[2] == b':' {
                raw[1..].to_string()
            } else {
                raw.to_string()
            }
        } else {
            raw.to_string()
        }
    } else {
        trimmed.to_string()
    };

    fs::read(&path_value).map_err(|e| format!("logo file read failed ({path_value}): {e}"))
}

fn rasterize_logo_to_escpos_prefix(
    image_bytes: &[u8],
    paper: crate::escpos::PaperWidth,
) -> Result<Vec<u8>, String> {
    let decoded = image::load_from_memory(image_bytes).map_err(|e| format!("logo decode: {e}"))?;
    let gray = decoded.to_luma8();
    let (src_w, src_h) = gray.dimensions();
    if src_w == 0 || src_h == 0 {
        return Err("logo image has invalid dimensions".to_string());
    }

    let max_width = paper_logo_max_width_dots(paper).max(8);
    let mut target_w = src_w.min(max_width);
    if target_w == 0 {
        target_w = 1;
    }
    let mut target_h = ((src_h as f32 * (target_w as f32 / src_w as f32)).round() as u32).max(1);
    // Keep logos compact on thermal paper.
    if target_h > 220 {
        target_h = 220;
        target_w = ((src_w as f32 * (target_h as f32 / src_h as f32)).round() as u32).max(1);
    }

    let resized = if target_w != src_w || target_h != src_h {
        image::imageops::resize(&gray, target_w, target_h, FilterType::Triangle)
    } else {
        gray
    };

    let width = resized.width();
    let height = resized.height();
    let width_bytes = width.div_ceil(8);
    let mut packed = Vec::with_capacity((width_bytes * height) as usize);
    for y in 0..height {
        for xb in 0..width_bytes {
            let mut byte = 0u8;
            for bit in 0..8u32 {
                let x = xb * 8 + bit;
                if x >= width {
                    continue;
                }
                let luma = resized.get_pixel(x, y).0[0];
                if luma < 160 {
                    byte |= 0x80 >> bit;
                }
            }
            packed.push(byte);
        }
    }

    let mut builder = crate::escpos::EscPosBuilder::new();
    builder
        .center()
        .raster_image(width_bytes as u16, height as u16, &packed)
        .lf()
        .left();
    Ok(builder.build())
}

fn build_logo_prefix_for_layout(layout: &LayoutConfig) -> Result<Option<Vec<u8>>, String> {
    if !layout.show_logo {
        return Ok(None);
    }
    let Some(source) = layout
        .logo_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let bytes = read_logo_source_bytes(source)?;
    let prefix = rasterize_logo_to_escpos_prefix(&bytes, layout.paper_width)?;
    Ok(Some(prefix))
}

fn resolve_driver_name_from_shifts(conn: &rusqlite::Connection, staff_id: &str) -> Option<String> {
    let staff_id = staff_id.trim();
    if staff_id.is_empty() {
        return None;
    }

    conn.query_row(
        "SELECT staff_name
         FROM staff_shifts
         WHERE staff_id = ?1
           AND TRIM(COALESCE(staff_name, '')) <> ''
         ORDER BY COALESCE(check_in_time, created_at, updated_at) DESC, updated_at DESC
         LIMIT 1",
        params![staff_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .map(|name| name.trim().to_string())
    .filter(|name| !name.is_empty())
}

fn non_empty_field(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn build_order_receipt_doc(db: &DbState, order_id: &str) -> Result<OrderReceiptDoc, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order = conn
        .query_row(
            "SELECT COALESCE(order_number, ''), COALESCE(order_type, ''), COALESCE(status, ''),
                    COALESCE(created_at, ''), COALESCE(table_number, ''), COALESCE(customer_name, ''),
                    COALESCE(items, '[]'), COALESCE(total_amount, 0), COALESCE(subtotal, 0),
                    COALESCE(tax_amount, 0), COALESCE(discount_amount, 0), COALESCE(delivery_fee, 0),
                    COALESCE(tip_amount, 0), COALESCE(delivery_address, ''),
                    COALESCE(delivery_city, ''), COALESCE(delivery_postal_code, ''),
                    COALESCE(delivery_floor, ''), COALESCE(name_on_ringer, ''),
                    COALESCE(driver_id, ''), COALESCE(driver_name, ''), COALESCE(staff_id, '')
             FROM orders WHERE id = ?1",
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
                    row.get::<_, f64>(7)?,
                    row.get::<_, f64>(8)?,
                    row.get::<_, f64>(9)?,
                    row.get::<_, f64>(10)?,
                    row.get::<_, f64>(11)?,
                    row.get::<_, f64>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                    row.get::<_, String>(15)?,
                    row.get::<_, String>(16)?,
                    row.get::<_, String>(17)?,
                    row.get::<_, String>(18)?,
                    row.get::<_, String>(19)?,
                    row.get::<_, String>(20)?,
                ))
            },
        )
        .map_err(|_| format!("Order not found: {order_id}"))?;
    let (
        order_number,
        order_type,
        status,
        created_at,
        table_number,
        customer_name,
        items_json,
        total_amount,
        subtotal,
        tax_amount,
        discount_amount,
        delivery_fee,
        tip_amount,
        delivery_address,
        delivery_city,
        delivery_postal_code,
        delivery_floor,
        name_on_ringer,
        driver_id,
        driver_name,
        staff_id,
    ) = order;

    let items: Vec<ReceiptItem> = serde_json::from_str::<Value>(&items_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|item| ReceiptItem {
            name: item
                .get("name")
                .or_else(|| item.get("itemName"))
                .or_else(|| item.get("menu_item_name"))
                .or_else(|| item.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("Item")
                .to_string(),
            quantity: item.get("quantity").and_then(parse_number).unwrap_or(1.0),
            total: parse_item_total(&item),
            note: item
                .get("notes")
                .or_else(|| item.get("special_instructions"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            customizations: parse_item_customizations(&item),
        })
        .collect();

    let mut totals = Vec::new();
    totals.push(TotalsLine {
        label: "Subtotal".to_string(),
        amount: subtotal,
        emphasize: false,
    });
    if discount_amount > 0.0 {
        totals.push(TotalsLine {
            label: "Discount".to_string(),
            amount: -discount_amount,
            emphasize: false,
        });
    }
    if tax_amount > 0.0 {
        totals.push(TotalsLine {
            label: "Tax".to_string(),
            amount: tax_amount,
            emphasize: false,
        });
    }
    if delivery_fee > 0.0 {
        totals.push(TotalsLine {
            label: "Delivery".to_string(),
            amount: delivery_fee,
            emphasize: false,
        });
    }
    if tip_amount > 0.0 {
        totals.push(TotalsLine {
            label: "Tip".to_string(),
            amount: tip_amount,
            emphasize: false,
        });
    }
    totals.push(TotalsLine {
        label: "TOTAL".to_string(),
        amount: total_amount,
        emphasize: true,
    });

    let mut payments_stmt = conn
        .prepare(
            "SELECT COALESCE(method, ''), COALESCE(amount, 0), cash_received, change_given, COALESCE(transaction_ref, '')
             FROM order_payments
             WHERE order_id = ?1 AND status = 'completed'
             ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare payments: {e}"))?;

    type PaymentRow = (String, f64, Option<f64>, Option<f64>, String);
    let payment_rows: Vec<PaymentRow> = payments_stmt
        .query_map(params![order_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| format!("query payments: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut payments = Vec::new();
    let mut masked_card = None;
    for (method, amount, cash_received, change_given, transaction_ref) in payment_rows {
        let label = match method.as_str() {
            "cash" => "Cash",
            "card" => "Card",
            _ => "Other",
        };
        payments.push(PaymentLine {
            label: label.to_string(),
            amount,
            detail: None,
        });
        if let Some(received) = cash_received {
            if received > 0.0 {
                payments.push(PaymentLine {
                    label: "Received".to_string(),
                    amount: received,
                    detail: None,
                });
            }
        }
        if let Some(change) = change_given {
            if change > 0.0 {
                payments.push(PaymentLine {
                    label: "Change".to_string(),
                    amount: change,
                    detail: None,
                });
            }
        }
        if masked_card.is_none() && method == "card" {
            masked_card =
                extract_last4_digits(&transaction_ref).map(|last4| format!("****{last4}"));
        }
    }

    let mut adjustments_stmt = conn
        .prepare(
            "SELECT COALESCE(adjustment_type, ''), COALESCE(amount, 0), COALESCE(reason, '')
             FROM payment_adjustments WHERE order_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare adjustments: {e}"))?;
    let adjustments: Vec<AdjustmentLine> = adjustments_stmt
        .query_map(params![order_id], |row| {
            let kind: String = row.get(0)?;
            let label = match kind.as_str() {
                "void" => "Void",
                "refund" => "Refund",
                _ => "Adjustment",
            };
            Ok(AdjustmentLine {
                label: label.to_string(),
                amount: row.get::<_, f64>(1)?,
                reason: row
                    .get::<_, String>(2)
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
            })
        })
        .map_err(|e| format!("query adjustments: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let resolved_driver_name = non_empty_field(driver_name)
        .or_else(|| resolve_driver_name_from_shifts(&conn, &driver_id))
        .or_else(|| resolve_driver_name_from_shifts(&conn, &staff_id));

    Ok(OrderReceiptDoc {
        order_id: order_id.to_string(),
        order_number: if order_number.is_empty() {
            order_id.to_string()
        } else {
            order_number
        },
        order_type,
        status,
        created_at,
        table_number: non_empty_field(table_number),
        customer_name: non_empty_field(customer_name),
        delivery_address: non_empty_field(delivery_address),
        delivery_city: non_empty_field(delivery_city),
        delivery_postal_code: non_empty_field(delivery_postal_code),
        delivery_floor: non_empty_field(delivery_floor),
        name_on_ringer: non_empty_field(name_on_ringer),
        driver_name: resolved_driver_name,
        items,
        totals,
        payments,
        adjustments,
        masked_card,
    })
}

fn build_kitchen_ticket_doc(db: &DbState, order_id: &str) -> Result<KitchenTicketDoc, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (
        order_number,
        order_type,
        created_at,
        table_number,
        delivery_address,
        delivery_notes,
        special_instructions,
        items_json,
    ) = conn
        .query_row(
            "SELECT COALESCE(order_number, ''), COALESCE(order_type, ''), COALESCE(created_at, ''),
                    COALESCE(table_number, ''), COALESCE(delivery_address, ''), COALESCE(delivery_notes, ''),
                    COALESCE(special_instructions, ''), COALESCE(items, '[]')
             FROM orders WHERE id = ?1",
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
        .map_err(|_| format!("Order not found: {order_id}"))?;

    let items: Vec<ReceiptItem> = serde_json::from_str::<Value>(&items_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|item| ReceiptItem {
            name: item
                .get("name")
                .or_else(|| item.get("itemName"))
                .or_else(|| item.get("menu_item_name"))
                .or_else(|| item.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("Item")
                .to_string(),
            quantity: item.get("quantity").and_then(parse_number).unwrap_or(1.0),
            total: parse_item_total(&item),
            note: item
                .get("notes")
                .or_else(|| item.get("special_instructions"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            customizations: parse_item_customizations(&item),
        })
        .collect();

    Ok(KitchenTicketDoc {
        order_id: order_id.to_string(),
        order_number: if order_number.is_empty() {
            order_id.to_string()
        } else {
            order_number
        },
        order_type,
        created_at,
        table_number: if table_number.is_empty() {
            None
        } else {
            Some(table_number)
        },
        delivery_address: if delivery_address.is_empty() {
            None
        } else {
            Some(delivery_address)
        },
        delivery_notes: if delivery_notes.is_empty() {
            None
        } else {
            Some(delivery_notes)
        },
        special_instructions: if special_instructions.is_empty() {
            None
        } else {
            Some(special_instructions)
        },
        items,
    })
}

fn build_shift_checkout_doc(db: &DbState, shift_id: &str) -> Result<ShiftCheckoutDoc, String> {
    let summary = crate::shifts::get_shift_summary(db, shift_id)?;
    let shift = summary
        .get("shift")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let cash_drawer = summary
        .get("cashDrawer")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    Ok(ShiftCheckoutDoc {
        shift_id: shift_id.to_string(),
        role_type: shift
            .get("role_type")
            .or_else(|| shift.get("roleType"))
            .and_then(Value::as_str)
            .unwrap_or("staff")
            .to_string(),
        staff_name: shift
            .get("staff_name")
            .or_else(|| shift.get("staffName"))
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or("Unknown")
            .to_string(),
        terminal_name: shift
            .get("terminal_id")
            .or_else(|| shift.get("terminalId"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        check_in: shift
            .get("check_in_time")
            .or_else(|| shift.get("checkInTime"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        check_out: shift
            .get("check_out_time")
            .or_else(|| shift.get("checkOutTime"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        orders_count: summary
            .get("ordersCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        sales_amount: summary
            .get("salesAmount")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        total_expenses: summary
            .get("totalExpenses")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        cash_refunds: summary
            .get("cashRefunds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        opening_amount: cash_drawer
            .get("opening_amount")
            .or_else(|| cash_drawer.get("openingAmount"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        expected_amount: cash_drawer
            .get("expected_amount")
            .or_else(|| cash_drawer.get("expectedAmount"))
            .and_then(Value::as_f64),
        closing_amount: cash_drawer
            .get("closing_amount")
            .or_else(|| cash_drawer.get("closingAmount"))
            .and_then(Value::as_f64),
        variance_amount: cash_drawer
            .get("variance_amount")
            .or_else(|| cash_drawer.get("varianceAmount"))
            .and_then(Value::as_f64),
    })
}

fn number_from_paths(payload: &Value, paths: &[&str]) -> Option<f64> {
    for path in paths {
        if let Some(value) = payload.pointer(path) {
            if let Some(number) = value.as_f64() {
                return Some(number);
            }
            if let Some(number) = value.as_i64() {
                return Some(number as f64);
            }
            if let Some(text) = value.as_str() {
                if let Ok(number) = text.trim().parse::<f64>() {
                    return Some(number);
                }
            }
        }
    }
    None
}

fn text_from_paths(payload: &Value, paths: &[&str]) -> Option<String> {
    for path in paths {
        if let Some(text) = payload.pointer(path).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn build_z_report_doc_from_payload(payload: &Value, entity_id: &str) -> ZReportDoc {
    let report_date = text_from_paths(payload, &["/date", "/reportDate", "/report_date"])
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
    let total_orders = number_from_paths(
        payload,
        &[
            "/sales/totalOrders",
            "/sales/total_orders",
            "/daySummary/totalOrders",
            "/totalOrders",
        ],
    )
    .unwrap_or(0.0)
    .round() as i64;
    let gross_sales = number_from_paths(
        payload,
        &[
            "/sales/totalSales",
            "/sales/total_sales",
            "/daySummary/total",
            "/daySummary/totalAmount",
        ],
    )
    .unwrap_or(0.0);
    let cash_sales = number_from_paths(
        payload,
        &[
            "/sales/cashSales",
            "/sales/cash_sales",
            "/daySummary/cashTotal",
        ],
    )
    .unwrap_or(0.0);
    let card_sales = number_from_paths(
        payload,
        &[
            "/sales/cardSales",
            "/sales/card_sales",
            "/daySummary/cardTotal",
        ],
    )
    .unwrap_or(0.0);
    let refunds_total = number_from_paths(
        payload,
        &["/refunds/total", "/refundsTotal", "/refunds_total"],
    )
    .unwrap_or(0.0);
    let voids_total =
        number_from_paths(payload, &["/voids/total", "/voidsTotal", "/voids_total"]).unwrap_or(0.0);
    let discounts_total = number_from_paths(
        payload,
        &["/discounts/total", "/discountsTotal", "/discounts_total"],
    )
    .unwrap_or(0.0);
    let expenses_total = number_from_paths(
        payload,
        &["/expenses/total", "/expensesTotal", "/expenses_total"],
    )
    .unwrap_or(0.0);
    let cash_variance = number_from_paths(
        payload,
        &[
            "/cashDrawer/totalVariance",
            "/cashDrawer/cashVariance",
            "/cashVariance",
        ],
    )
    .unwrap_or(0.0);
    let net_sales = gross_sales - discounts_total - refunds_total - voids_total;

    ZReportDoc {
        report_id: entity_id.to_string(),
        report_date,
        generated_at: Utc::now().to_rfc3339(),
        shift_ref: text_from_paths(payload, &["/shiftId", "/shift_id", "/id"])
            .unwrap_or_else(|| "snapshot".to_string()),
        terminal_name: text_from_paths(
            payload,
            &[
                "/terminalName",
                "/terminal_name",
                "/terminalId",
                "/terminal_id",
            ],
        )
        .unwrap_or_default(),
        total_orders,
        gross_sales,
        net_sales,
        cash_sales,
        card_sales,
        refunds_total,
        voids_total,
        discounts_total,
        expenses_total,
        cash_variance,
    }
}

fn build_z_report_doc(db: &DbState, z_report_id: &str) -> Result<ZReportDoc, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, shift_id, terminal_id, report_date, generated_at,
                gross_sales, net_sales, total_orders, cash_sales, card_sales,
                refunds_total, voids_total, discounts_total, expenses_total,
                cash_variance
         FROM z_reports WHERE id = ?1",
        params![z_report_id],
        |row| {
            Ok(ZReportDoc {
                report_id: row.get(0)?,
                shift_ref: row.get(1)?,
                terminal_name: row.get(2)?,
                report_date: row.get(3)?,
                generated_at: row.get(4)?,
                gross_sales: row.get(5)?,
                net_sales: row.get(6)?,
                total_orders: row.get(7)?,
                cash_sales: row.get(8)?,
                card_sales: row.get(9)?,
                refunds_total: row.get(10)?,
                voids_total: row.get(11)?,
                discounts_total: row.get(12)?,
                expenses_total: row.get(13)?,
                cash_variance: row.get(14)?,
            })
        },
    )
    .map_err(|_| format!("Z-report not found: {z_report_id}"))
}

fn build_document_for_job(
    db: &DbState,
    entity_type: &str,
    entity_id: &str,
    payload_json: Option<&str>,
) -> Result<ReceiptDocument, String> {
    match entity_type {
        "order_receipt" => Ok(ReceiptDocument::OrderReceipt(build_order_receipt_doc(
            db, entity_id,
        )?)),
        "kitchen_ticket" => Ok(ReceiptDocument::KitchenTicket(build_kitchen_ticket_doc(
            db, entity_id,
        )?)),
        "shift_checkout" => Ok(ReceiptDocument::ShiftCheckout(build_shift_checkout_doc(
            db, entity_id,
        )?)),
        "z_report" => {
            if let Some(raw_payload) = payload_json {
                if let Ok(payload) = serde_json::from_str::<Value>(raw_payload) {
                    return Ok(ReceiptDocument::ZReport(build_z_report_doc_from_payload(
                        &payload, entity_id,
                    )));
                }
            }
            Ok(ReceiptDocument::ZReport(build_z_report_doc(db, entity_id)?))
        }
        _ => Err(format!("Unknown entity_type: {entity_type}")),
    }
}

fn write_print_html_file(
    data_dir: &Path,
    entity_type: &str,
    entity_id: &str,
    html: &str,
) -> Result<String, String> {
    let receipts_dir = data_dir.join(RECEIPTS_DIR);
    fs::create_dir_all(&receipts_dir).map_err(|e| format!("create receipts dir: {e}"))?;
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
    let filename = format!("{entity_type}_{entity_id}_{timestamp}.html");
    let file_path = receipts_dir.join(filename);
    fs::write(&file_path, html).map_err(|e| format!("write print artifact: {e}"))?;
    Ok(file_path.to_string_lossy().to_string())
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
    let document = ReceiptDocument::OrderReceipt(build_order_receipt_doc(db, order_id)?);
    let profile = printers::resolve_printer_profile_for_role(db, None, Some("receipt"))?
        .unwrap_or_else(|| serde_json::json!({}));
    let layout = resolve_layout_config(db, &profile, "order_receipt")?;
    let html = receipt_renderer::render_html(&document, &layout);
    let path_str = write_print_html_file(data_dir, "receipt", order_id, &html)?;
    info!(order_id = %order_id, path = %path_str, "Receipt file generated");
    Ok(path_str)
}

#[allow(dead_code)]
fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[allow(dead_code)]
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

#[allow(dead_code)]
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
    document: &ReceiptDocument,
) -> Result<(Value, Vec<receipt_renderer::RenderWarning>), String> {
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
    let should_cut = profile
        .get("cutPaper")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let layout = resolve_layout_config(db, &profile, entity_type)?;
    let mut rendered = receipt_renderer::render_escpos(document, &layout);
    match build_logo_prefix_for_layout(&layout) {
        Ok(Some(prefix)) => {
            if rendered.bytes.starts_with(&[0x1B, 0x40]) {
                let mut combined = Vec::with_capacity(rendered.bytes.len() + prefix.len());
                combined.extend_from_slice(&rendered.bytes[..2]);
                combined.extend_from_slice(&prefix);
                combined.extend_from_slice(&rendered.bytes[2..]);
                rendered.bytes = combined;
            } else {
                let mut combined = Vec::with_capacity(rendered.bytes.len() + prefix.len());
                combined.extend_from_slice(&prefix);
                combined.extend_from_slice(&rendered.bytes);
                rendered.bytes = combined;
            }
        }
        Ok(None) => {}
        Err(err) => {
            rendered.warnings.push(receipt_renderer::RenderWarning {
                code: "logo_text_fallback".to_string(),
                message: format!("Logo rendering failed; using text header fallback ({err})"),
            });
        }
    }

    match driver_type {
        // Raw ESC/POS dispatch (default for thermal printers)
        "windows" | "escpos" => {
            if should_cut {
                // Renderer already includes cut command by default.
            } else {
                // If profile opts out of cutting, drop the trailing cut command.
                let len = rendered.bytes.len();
                if len >= 4 && rendered.bytes[len - 4..] == [0x1D, 0x56, 0x41, 0x10] {
                    rendered.bytes.truncate(len - 4);
                }
            }
            let doc_name = match entity_type {
                "kitchen_ticket" => "POS Kitchen Ticket",
                "shift_checkout" => "POS Shift Checkout",
                "z_report" => "POS Z Report",
                _ => "POS Receipt",
            };
            let _dispatch =
                printers::print_raw_to_windows(printer_name, &rendered.bytes, doc_name)?;
            Ok((profile, rendered.warnings))
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
            "SELECT id, entity_type, entity_id, entity_payload_json, printer_profile_id FROM print_jobs
             WHERE status = 'pending'
               AND (next_retry_at IS NULL OR julianday(next_retry_at) <= julianday(?1))
             ORDER BY created_at ASC
             LIMIT 10",
        )
        .map_err(|e| e.to_string())?;

    type PrintJob = (String, String, String, Option<String>, Option<String>);
    let jobs: Vec<PrintJob> = stmt
        .query_map(params![now_str], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    drop(stmt);
    drop(conn);

    let count = jobs.len();

    for (job_id, entity_type, entity_id, payload_json, profile_id) in jobs {
        // Mark as printing
        {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            let _ = conn.execute(
                "UPDATE print_jobs SET status = 'printing', updated_at = ?1 WHERE id = ?2",
                params![now_str, job_id],
            );
        }

        let document =
            match build_document_for_job(db, &entity_type, &entity_id, payload_json.as_deref()) {
                Ok(document) => document,
                Err(error) => {
                    mark_print_job_failed(db, &job_id, &error)?;
                    continue;
                }
            };

        let role = if entity_type == "kitchen_ticket" {
            "kitchen"
        } else {
            "receipt"
        };
        let html_profile =
            printers::resolve_printer_profile_for_role(db, profile_id.as_deref(), Some(role))
                .ok()
                .flatten()
                .unwrap_or_else(|| serde_json::json!({}));
        let html_layout =
            resolve_layout_config(db, &html_profile, &entity_type).unwrap_or_default();
        let html = receipt_renderer::render_html(&document, &html_layout);
        let path = match write_print_html_file(data_dir, &entity_type, &entity_id, &html) {
            Ok(path) => path,
            Err(error) => {
                mark_print_job_failed(db, &job_id, &error)?;
                continue;
            }
        };

        // Try to dispatch to hardware printer from structured render path.
        match dispatch_to_printer(db, &entity_type, profile_id.as_deref(), &document) {
            Ok((resolved_profile, render_warnings)) => {
                mark_print_job_printed(db, &job_id, &path)?;

                if !render_warnings.is_empty() {
                    let combined = render_warnings
                        .iter()
                        .map(|warning| warning.message.clone())
                        .collect::<Vec<String>>()
                        .join(" | ");
                    let _ = set_print_job_warning(db, &job_id, "render_warning", &combined);
                }

                // Non-fatal drawer kick: if profile has open_cash_drawer enabled,
                // attempt to open the drawer. Failures are warnings only.
                if let Err(error) = drawer::try_drawer_kick_after_print(db, &resolved_profile) {
                    let _ = set_print_job_warning(db, &job_id, "drawer_kick_failed", &error);
                }
            }
            Err(error) => {
                warn!(job_id = %job_id, error = %error, "Hardware print failed, file generated at {path}");
                if is_non_retryable_print_error(&error) {
                    mark_print_job_failed_non_retryable(db, &job_id, &error)?;
                } else {
                    mark_print_job_failed(db, &job_id, &error)?;
                }
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
    fn test_parse_item_customizations_from_array() {
        let item = serde_json::json!({
            "customizations": [
                {
                    "ingredient": { "name": "Feta", "price": 0.5 },
                    "quantity": 2
                },
                {
                    "name": "Onion",
                    "isWithout": true
                }
            ]
        });

        let parsed = parse_item_customizations(&item);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "Feta");
        assert_eq!(parsed[0].quantity, 2.0);
        assert_eq!(parsed[0].price, Some(0.5));
        assert!(!parsed[0].is_without);
        assert_eq!(parsed[1].name, "Onion");
        assert!(parsed[1].is_without);
        assert!(parsed[1].price.is_none());
    }

    #[test]
    fn test_parse_item_customizations_from_json_string_map() {
        let item = serde_json::json!({
            "modifiers": "{\"a\":{\"ingredient\":{\"name_en\":\"Olives\",\"pickup_price\":\"0.20\"},\"quantity\":\"2\"},\"b\":{\"label\":\"Tomato\",\"without\":true}}"
        });

        let parsed = parse_item_customizations(&item);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "Olives");
        assert_eq!(parsed[0].quantity, 2.0);
        assert_eq!(parsed[0].price, Some(0.2));
        assert_eq!(parsed[1].name, "Tomato");
        assert!(parsed[1].is_without);
    }

    #[test]
    fn test_parse_item_customizations_handles_malformed_json() {
        let item = serde_json::json!({
            "customizations": "{bad json",
            "ingredients": "[]"
        });

        let parsed = parse_item_customizations(&item);
        assert!(parsed.is_empty());
    }

    #[test]
    fn test_parse_data_url_image_png() {
        let mut encoded = Vec::new();
        let logo =
            image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(2, 2, image::Luma([0])));
        logo.write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Png,
        )
        .expect("encode png");
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded)
        );
        let bytes = parse_data_url_image(&data_url).expect("data url should decode");
        assert!(!bytes.is_empty());
    }

    #[test]
    fn test_build_logo_prefix_for_layout_from_data_url() {
        let mut encoded = Vec::new();
        let logo =
            image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(2, 2, image::Luma([0])));
        logo.write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Png,
        )
        .expect("encode png");
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded)
        );
        let layout = LayoutConfig {
            show_logo: true,
            logo_url: Some(data_url),
            ..LayoutConfig::default()
        };
        let prefix = build_logo_prefix_for_layout(&layout)
            .expect("logo prefix result")
            .expect("logo prefix present");
        assert!(prefix
            .windows(4)
            .any(|window| window == [0x1D, b'v', b'0', 0x00]));
    }

    #[test]
    fn test_build_order_receipt_doc_includes_delivery_fields() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, subtotal, status, order_type,
                    delivery_address, delivery_city, delivery_postal_code, delivery_floor,
                    name_on_ringer, driver_name, sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-delivery', 'ORD-DEL-1', '[]', 10.0, 10.0, 'delivered', 'delivery',
                    'Main St 42', 'Athens', '10558', '2', 'Papadopoulos', 'Nikos Driver',
                    'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-delivery").unwrap();
        assert_eq!(doc.status, "delivered");
        assert_eq!(doc.delivery_address.as_deref(), Some("Main St 42"));
        assert_eq!(doc.delivery_city.as_deref(), Some("Athens"));
        assert_eq!(doc.delivery_postal_code.as_deref(), Some("10558"));
        assert_eq!(doc.delivery_floor.as_deref(), Some("2"));
        assert_eq!(doc.name_on_ringer.as_deref(), Some("Papadopoulos"));
        assert_eq!(doc.driver_name.as_deref(), Some("Nikos Driver"));
    }

    #[test]
    fn test_build_order_receipt_doc_resolves_driver_name_from_shift() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, role_type, check_in_time, status, sync_status, created_at, updated_at
                 ) VALUES (
                    'shift-driver', 'driver-1', 'Shift Driver', 'driver', datetime('now'), 'active', 'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, subtotal, status, order_type,
                    driver_id, sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-delivery-fallback', 'ORD-DEL-2', '[]', 8.0, 8.0, 'completed', 'delivery',
                    'driver-1', 'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-delivery-fallback").unwrap();
        assert_eq!(doc.driver_name.as_deref(), Some("Shift Driver"));
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
    fn test_enqueue_with_payload_persists_snapshot_json() {
        let db = test_db();
        let payload = serde_json::json!({
            "date": "2026-02-24",
            "sales": { "totalSales": 123.45 }
        });
        let result = enqueue_print_job_with_payload(
            &db,
            "z_report",
            "snapshot-20260224",
            None,
            Some(&payload),
        )
        .unwrap();
        assert_eq!(result["success"], true);
        let job_id = result["jobId"].as_str().unwrap().to_string();

        let jobs = list_print_jobs(&db, None).unwrap();
        let arr = jobs.as_array().unwrap();
        let job = arr.iter().find(|value| value["id"] == job_id).unwrap();
        assert!(job["entityPayloadJson"]
            .as_str()
            .unwrap_or_default()
            .contains("\"date\""));
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
