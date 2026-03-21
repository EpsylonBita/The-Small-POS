//! Print spooler for The Small POS.
//!
//! Provides an offline-safe print job queue backed by the `print_jobs` SQLite
//! table.  UI "Print" actions enqueue a job; a background worker generates
//! receipt output files and dispatches them to the configured Windows printer
//! via the `printers` module. Missing/unavailable hardware profile resolution
//! is treated as a non-retryable failure.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use chrono::Utc;

use rusqlite::params;
use serde_json::Value;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::db::{self, DbState};
use crate::drawer;
use crate::printers;
use crate::receipt_renderer::{
    self, AdjustmentLine, ClassicCustomerRenderMode, CommandProfile, DeliverySlipMode, FontType,
    HeaderEmphasis, KitchenTicketDoc, LayoutConfig, LayoutDensity, OrderReceiptDoc, PaymentLine,
    ReceiptCustomizationLine, ReceiptDocument, ReceiptEmulationMode, ReceiptItem, ReceiptTemplate,
    ShiftCheckoutDoc, TotalsLine, ZReportDoc,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Directory name under the app data dir where receipt files are written.
const RECEIPTS_DIR: &str = "receipts";
const AUTO_PRINT_RECEIPT_ONLY: &[&str] = &["order_receipt"];
const AUTO_PRINT_DELIVERY_ONLY: &[&str] = &["delivery_slip"];

fn is_receipt_like_entity_type(entity_type: &str) -> bool {
    matches!(
        entity_type,
        "order_receipt"
            | "delivery_slip"
            | "kitchen_ticket"
            | "shift_checkout"
            | "z_report"
            | "order_completed_receipt"
            | "order_canceled_receipt"
    )
}

fn non_empty_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn looks_like_raw_terminal_id(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }

    lower.starts_with("terminal-")
        || lower.starts_with("terminal_")
        || lower.starts_with("pos-terminal-")
        || lower.starts_with("pos_terminal_")
        || lower.starts_with("term-")
}

fn sanitize_terminal_display_name(value: &str) -> Option<String> {
    let trimmed = non_empty_text(value)?;
    if looks_like_raw_terminal_id(&trimmed) {
        None
    } else {
        Some(trimmed)
    }
}

fn resolve_terminal_display_name_from_settings(conn: &rusqlite::Connection) -> Option<String> {
    ["name", "display_name", "displayName"]
        .iter()
        .find_map(|key| db::get_setting(conn, "terminal", key))
        .and_then(|value| sanitize_terminal_display_name(&value))
}

fn resolve_printed_terminal_name_with_conn(
    conn: &rusqlite::Connection,
    explicit: Option<&str>,
) -> Option<String> {
    explicit
        .and_then(sanitize_terminal_display_name)
        .or_else(|| resolve_terminal_display_name_from_settings(conn))
}

pub fn auto_print_entity_types_for_order_type(order_type: &str) -> &'static [&'static str] {
    if order_type.eq_ignore_ascii_case("delivery") {
        AUTO_PRINT_DELIVERY_ONLY
    } else {
        AUTO_PRINT_RECEIPT_ONLY
    }
}

/// Returns whether the given receipt action is enabled.
/// Reads from local_settings("receipt_actions", key).
/// Acquires and releases the DB lock internally — safe to call without holding the lock.
/// Existing triggers default to true when absent; new triggers default to false.
pub fn is_print_action_enabled(db: &DbState, key: &str) -> bool {
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(_) => return true, // fail open — don't suppress print if lock poisoned
    };
    let raw = crate::db::get_setting(&conn, "receipt_actions", key);
    drop(conn);
    match raw.as_deref() {
        None => matches!(
            key,
            "after_order"
                | "payment_receipt"
                | "split_receipt"
                | "shift_close"
                | "driver_assigned"
                | "z_report"
                | "kitchen_ticket"
        ),
        Some(v) => matches!(v.trim(), "true" | "1" | "yes" | "on"),
    }
}

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
        && entity_type != "delivery_slip"
        && entity_type != "test_print"
        && entity_type != "split_receipt"
        && entity_type != "order_completed_receipt"
        && entity_type != "order_canceled_receipt"
    {
        return Err(format!(
            "Invalid entity_type: {entity_type}. Must be order_receipt, kitchen_ticket, shift_checkout, z_report, delivery_slip, test_print, split_receipt, order_completed_receipt, or order_canceled_receipt"
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

    // SAFETY: `cols` is a hardcoded constant string — no user input reaches
    // the SQL format string.
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

/// Mark a print job as dispatched to a printer transport.
pub fn mark_print_job_dispatched(
    db: &DbState,
    job_id: &str,
    output_path: &str,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let affected = conn
        .execute(
            "UPDATE print_jobs SET status = 'dispatched', output_path = ?1,
                    last_attempt_at = ?2, updated_at = ?2
             WHERE id = ?3 AND status IN ('pending', 'printing')",
            params![output_path, now, job_id],
        )
        .map_err(|e| format!("mark dispatched: {e}"))?;

    if affected == 0 {
        return Err(format!(
            "Print job {job_id} not found or not in printable state"
        ));
    }

    info!(job_id = %job_id, "Print job marked dispatched");
    Ok(())
}

/// Set a non-fatal warning on a print job (e.g. drawer kick failed).
///
/// This does NOT change the job's status — it stays in its current successful state.
/// Warnings are
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
        || normalized.contains("not found")
        || normalized.contains("unknown entity_type")
}

fn setting_text(conn: &rusqlite::Connection, category: &str, key: &str) -> Option<String> {
    crate::db::get_setting(conn, category, key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn setting_bool(conn: &rusqlite::Connection, category: &str, key: &str) -> bool {
    let raw = setting_text(conn, category, key).unwrap_or_default();
    matches!(
        raw.to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn resolve_header_sources(conn: &rusqlite::Connection) -> (String, String, String, String) {
    let brand_source = if setting_text(conn, "organization", "name").is_some() {
        "organization.name"
    } else if setting_text(conn, "restaurant", "name").is_some() {
        "restaurant.name"
    } else if setting_text(conn, "terminal", "store_name").is_some() {
        "terminal.store_name"
    } else {
        "default"
    };

    let branch_source = if setting_text(conn, "restaurant", "subtitle").is_some() {
        "restaurant.subtitle"
    } else if setting_text(conn, "restaurant", "name").is_some() {
        "restaurant.name"
    } else if setting_text(conn, "organization", "subtitle").is_some() {
        "organization.subtitle"
    } else {
        "none"
    };

    let address_source = if setting_text(conn, "restaurant", "address").is_some() {
        "restaurant.address"
    } else if setting_text(conn, "terminal", "store_address").is_some() {
        "terminal.store_address"
    } else {
        "none"
    };

    let phone_source = if setting_text(conn, "restaurant", "phone").is_some() {
        "restaurant.phone"
    } else if setting_text(conn, "terminal", "store_phone").is_some() {
        "terminal.store_phone"
    } else {
        "none"
    };

    (
        brand_source.to_string(),
        branch_source.to_string(),
        address_source.to_string(),
        phone_source.to_string(),
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

#[derive(Debug, Default, Clone)]
struct MenuSubcategoryEntry {
    name: String,
    category_id: Option<String>,
    category_name: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct MenuCategoryLookup {
    categories_by_id: HashMap<String, String>,
    subcategories_by_id: HashMap<String, MenuSubcategoryEntry>,
}

#[derive(Debug, Default, Clone)]
struct ReceiptItemCategoryFields {
    category_name: Option<String>,
    subcategory_name: Option<String>,
    category_path: Option<String>,
}

fn normalized_lookup_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_ascii_lowercase())
    }
}

fn parse_cached_menu_section(conn: &rusqlite::Connection, key: &str) -> Vec<Value> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT data FROM menu_cache WHERE cache_key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok();
    raw.and_then(|data| serde_json::from_str::<Value>(&data).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn build_menu_category_lookup(conn: &rusqlite::Connection) -> MenuCategoryLookup {
    let mut lookup = MenuCategoryLookup::default();

    for category in parse_cached_menu_section(conn, "categories") {
        let id = text_from_keys(&category, &["id", "category_id", "categoryId"]);
        let name = text_from_keys(&category, &["name", "name_el", "name_en", "title", "label"]);
        if let (Some(id), Some(name)) = (id, name) {
            if let Some(key) = normalized_lookup_key(&id) {
                lookup.categories_by_id.insert(key, name);
            }
        }
    }

    for subcategory in parse_cached_menu_section(conn, "subcategories") {
        let id = text_from_keys(
            &subcategory,
            &["id", "subcategory_id", "subcategoryId", "menu_item_id"],
        );
        let name = text_from_keys(
            &subcategory,
            &[
                "name",
                "name_el",
                "name_en",
                "title",
                "label",
                "menu_item_name",
            ],
        );
        let category_id = text_from_keys(
            &subcategory,
            &[
                "category_id",
                "categoryId",
                "parent_category_id",
                "menu_category_id",
            ],
        );
        let category_name = text_from_keys(&subcategory, &["category_name", "categoryName"]);
        if let (Some(id), Some(name)) = (id, name) {
            if let Some(key) = normalized_lookup_key(&id) {
                lookup.subcategories_by_id.insert(
                    key,
                    MenuSubcategoryEntry {
                        name,
                        category_id,
                        category_name,
                    },
                );
            }
        }
    }

    lookup
}

fn compose_category_path(
    category_name: Option<&str>,
    subcategory_name: Option<&str>,
) -> Option<String> {
    let category = category_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let subcategory = subcategory_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match (category, subcategory) {
        (Some(category), Some(subcategory)) => {
            if category.eq_ignore_ascii_case(subcategory) {
                Some(category.to_string())
            } else {
                Some(format!("{category} > {subcategory}"))
            }
        }
        (Some(category), None) => Some(category.to_string()),
        (None, Some(subcategory)) => Some(subcategory.to_string()),
        (None, None) => None,
    }
}

fn resolve_item_category_fields(
    item: &Value,
    lookup: &MenuCategoryLookup,
) -> ReceiptItemCategoryFields {
    let mut category_name = text_from_keys(item, &["category_name", "categoryName"]);
    let mut subcategory_name = text_from_keys(
        item,
        &[
            "subcategory_name",
            "subcategoryName",
            "sub_category_name",
            "subCategoryName",
            "menu_item_name",
            "menuItemName",
        ],
    );
    let mut category_path = text_from_keys(item, &["category_path", "categoryPath"]);

    let menu_item_id = text_from_keys(item, &["menu_item_id", "menuItemId"]);
    if let Some(id) = menu_item_id.and_then(|value| normalized_lookup_key(&value)) {
        if let Some(entry) = lookup.subcategories_by_id.get(&id) {
            if subcategory_name.is_none() {
                subcategory_name = Some(entry.name.clone());
            }
            if category_name.is_none() {
                category_name = entry.category_name.clone();
            }
            if category_name.is_none() {
                if let Some(category_id) =
                    entry.category_id.as_deref().and_then(normalized_lookup_key)
                {
                    category_name = lookup.categories_by_id.get(&category_id).cloned();
                }
            }
        }
    }

    if category_path.is_none() {
        category_path =
            compose_category_path(category_name.as_deref(), subcategory_name.as_deref());
    }

    ReceiptItemCategoryFields {
        category_name,
        subcategory_name,
        category_path,
    }
}

fn extract_last4_digits(input: &str) -> Option<String> {
    let digits: String = input.chars().filter(|ch| ch.is_ascii_digit()).collect();
    if digits.len() >= 4 {
        digits.get(digits.len() - 4..).map(ToString::to_string)
    } else {
        None
    }
}

fn extract_masked_card_reference(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let has_mask_marker = trimmed.chars().any(|ch| matches!(ch, '*' | 'x' | 'X'));
    let has_last4_marker = trimmed.to_ascii_lowercase().contains("last4");
    if !has_mask_marker && !has_last4_marker {
        return None;
    }

    extract_last4_digits(trimmed).map(|last4| format!("****{last4}"))
}

fn push_unique_trimmed_note(target: &mut Vec<String>, value: Option<&str>) {
    let Some(trimmed) = value.map(str::trim).filter(|entry| !entry.is_empty()) else {
        return;
    };
    if target
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(trimmed))
    {
        return;
    }
    target.push(trimmed.to_string());
}

fn build_item_note_text(item: &Value) -> Option<String> {
    let mut notes: Vec<String> = Vec::new();
    push_unique_trimmed_note(
        &mut notes,
        item.get("notes")
            .or_else(|| item.get("note"))
            .and_then(Value::as_str),
    );
    push_unique_trimmed_note(
        &mut notes,
        item.get("special_instructions")
            .or_else(|| item.get("specialInstructions"))
            .and_then(Value::as_str),
    );
    push_unique_trimmed_note(
        &mut notes,
        item.get("instructions")
            .or_else(|| item.get("instruction"))
            .and_then(Value::as_str),
    );
    if notes.is_empty() {
        None
    } else {
        Some(notes.join(" | "))
    }
}

pub fn resolve_layout_config(
    db: &DbState,
    profile: &Value,
    entity_type: &str,
) -> Result<LayoutConfig, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let receipt_like_entity = is_receipt_like_entity_type(entity_type);
    let paper_mm = profile
        .get("paperWidthMm")
        .or_else(|| profile.get("paper_width_mm"))
        .and_then(Value::as_i64)
        .unwrap_or(80) as i32;
    let profile_template = profile
        .get("receiptTemplate")
        .or_else(|| profile.get("receipt_template"))
        .and_then(Value::as_str);
    let template_override = setting_text(&conn, "receipt", "template_override");
    let template = if let Some(value) = template_override.as_deref() {
        ReceiptTemplate::from_value(Some(value))
    } else if receipt_like_entity && profile_template.is_none() {
        ReceiptTemplate::Classic
    } else {
        ReceiptTemplate::from_value(profile_template)
    };
    if let Some(override_value) = template_override.as_deref() {
        info!(
            entity_type = %entity_type,
            template_override = %override_value,
            profile_template = ?profile_template,
            "Using explicit receipt template override from local settings"
        );
    }

    let organization_name_setting = setting_text(&conn, "organization", "name");
    let restaurant_name_setting = setting_text(&conn, "restaurant", "name");
    let terminal_store_name_setting = setting_text(&conn, "terminal", "store_name");
    let organization_name = organization_name_setting
        .clone()
        .or_else(|| restaurant_name_setting.clone())
        .or_else(|| terminal_store_name_setting.clone())
        .unwrap_or_else(|| "The Small".to_string());

    let restaurant_subtitle_setting = setting_text(&conn, "restaurant", "subtitle");
    let organization_subtitle_setting = setting_text(&conn, "organization", "subtitle");
    let store_subtitle = restaurant_subtitle_setting
        .clone()
        .or_else(|| {
            restaurant_name_setting.clone().and_then(|name| {
                if name.trim() != organization_name.trim() {
                    Some(name)
                } else {
                    None
                }
            })
        })
        .or_else(|| organization_subtitle_setting.clone());
    let store_address = setting_text(&conn, "restaurant", "address")
        .or_else(|| setting_text(&conn, "terminal", "store_address"));
    let store_phone = setting_text(&conn, "restaurant", "phone")
        .or_else(|| setting_text(&conn, "terminal", "store_phone"));
    let currency_symbol = setting_text(&conn, "receipt", "currency_symbol")
        .or_else(|| setting_text(&conn, "organization", "currency_symbol"))
        .or_else(|| {
            // Default currency symbol based on language when not explicitly set
            let lang = setting_text(&conn, "general", "language").unwrap_or_default();
            match lang.as_str() {
                "el" | "de" | "fr" | "it" | "es" | "pt" | "nl" => Some(" \u{20AC}".to_string()),
                _ => None,
            }
        })
        .unwrap_or_default();
    let vat_number = setting_text(&conn, "organization", "vat_number")
        .or_else(|| setting_text(&conn, "restaurant", "vat_number"));
    let tax_office = setting_text(&conn, "organization", "tax_office");
    let footer_text = setting_text(&conn, "receipt", "footer_text")
        .or_else(|| setting_text(&conn, "restaurant", "receipt_footer"))
        .or(Some("Thank you".to_string()));
    let qr_data = setting_text(&conn, "receipt", "qr_url")
        .or_else(|| setting_text(&conn, "restaurant", "website"));
    let show_qr_code = setting_bool(&conn, "receipt", "show_qr_code");
    let mut show_logo = setting_bool(&conn, "receipt", "show_logo");
    let logo_url = setting_text(&conn, "receipt", "logo_source")
        .or_else(|| setting_text(&conn, "organization", "logo_url"));
    let copy_label = setting_text(&conn, "receipt", "copy_label").or_else(|| {
        if entity_type == "kitchen_ticket" {
            None
        } else {
            setting_text(&conn, "receipt", "copy_type").map(|value| value.to_ascii_uppercase())
        }
    });
    // --- Auto-detection: brand, character set, code page ---
    let printer_name = profile
        .get("printerName")
        .or_else(|| profile.get("printer_name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let detected_brand = printers::detect_printer_brand_for_profile(profile);
    let capability_snapshot = printers::read_capability_snapshot(profile);
    let verification_status = printers::capability_verification_status(profile);

    let connection_json_value = profile
        .get("connectionJson")
        .or_else(|| profile.get("connection_json"))
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let connection = connection_json_value.as_ref().and_then(Value::as_object);
    let connection_type = connection
        .and_then(|obj| obj.get("type"))
        .and_then(Value::as_str)
        .or_else(|| {
            profile
                .get("printerType")
                .or_else(|| profile.get("printer_type"))
                .and_then(Value::as_str)
        })
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "system".to_string());
    let raw_transport_printer = matches!(
        connection_type.as_str(),
        "network" | "wifi" | "usb" | "bluetooth"
    );

    let parse_u16 = |value: Option<&Value>| -> Option<u16> {
        match value {
            Some(Value::Number(n)) => n.as_u64().map(|v| v as u16),
            Some(Value::String(s)) => s.trim().parse::<u16>().ok(),
            _ => None,
        }
    };
    let parse_u8 = |value: Option<&Value>| -> Option<u8> {
        match value {
            Some(Value::Number(n)) => n.as_u64().map(|v| v as u8),
            Some(Value::String(s)) => s.trim().parse::<u8>().ok(),
            _ => None,
        }
    };

    let setting_render_mode = setting_text(&conn, "receipt", "classic_customer_render_mode");
    let profile_render_mode = connection
        .and_then(|obj| obj.get("render_mode"))
        .and_then(Value::as_str);
    let capability_override_active = matches!(
        capability_snapshot.status.as_str(),
        "verified" | "degraded" | "candidate"
    );
    let verified_render_mode = if capability_override_active {
        capability_snapshot.render_mode.as_deref()
    } else {
        None
    };
    let classic_customer_render_mode = if let Some(value) = verified_render_mode {
        ClassicCustomerRenderMode::from_value(Some(value))
    } else if let Some(value) = setting_render_mode.as_deref() {
        ClassicCustomerRenderMode::from_value(Some(value))
    } else if let Some(value) = profile_render_mode {
        ClassicCustomerRenderMode::from_value(Some(value))
    } else if receipt_like_entity && raw_transport_printer && !capability_override_active {
        ClassicCustomerRenderMode::Text
    } else if receipt_like_entity {
        ClassicCustomerRenderMode::RasterExact
    } else {
        ClassicCustomerRenderMode::Text
    };
    let emulation_setting = connection
        .and_then(|obj| obj.get("emulation"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let emulation_mode = if capability_override_active {
        capability_snapshot
            .emulation
            .as_deref()
            .map(|value| ReceiptEmulationMode::from_value(Some(value)))
            .unwrap_or_else(|| {
                if raw_transport_printer {
                    // Star printers need Auto so is_star_line_mode() returns
                    // true based on detected brand.  Standard ESC/POS commands
                    // (GS !, GS V, ESC t) produce garbled output on Star.
                    if detected_brand == crate::printers::PrinterBrand::Star {
                        ReceiptEmulationMode::Auto
                    } else {
                        ReceiptEmulationMode::Escpos
                    }
                } else {
                    ReceiptEmulationMode::from_value(emulation_setting)
                }
            })
    } else if raw_transport_printer {
        // Star printers need Auto so is_star_line_mode() returns true based
        // on detected brand, even when the profile is not yet verified.
        if detected_brand == crate::printers::PrinterBrand::Star {
            ReceiptEmulationMode::Auto
        } else {
            ReceiptEmulationMode::Escpos
        }
    } else {
        ReceiptEmulationMode::from_value(emulation_setting)
    };

    let physical_width_dots = match paper_mm {
        w if w <= 58 => 384u16,
        w if w >= 100 => 832u16,
        _ => 576u16,
    };
    let mut printable_width_dots = physical_width_dots;
    printable_width_dots = parse_u16(connection.and_then(|obj| obj.get("printable_width_dots")))
        .unwrap_or(printable_width_dots)
        .clamp(64, physical_width_dots.max(64));
    let requested_left_margin = parse_u16(connection.and_then(|obj| obj.get("left_margin_dots")))
        .unwrap_or(0)
        .min(200);
    let max_left_margin = physical_width_dots.saturating_sub(printable_width_dots);
    let left_margin_dots = requested_left_margin.min(max_left_margin);
    let raster_threshold = parse_u8(connection.and_then(|obj| obj.get("threshold")))
        .unwrap_or(160)
        .clamp(40, 240);

    let profile_command_profile = profile
        .get("commandProfile")
        .or_else(|| profile.get("command_profile"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let configured_command_profile =
        setting_text(&conn, "receipt", "command_profile").or(profile_command_profile);
    let command_profile = configured_command_profile
        .as_deref()
        .map(|value| CommandProfile::from_value(Some(value)))
        .unwrap_or(CommandProfile::FullStyle);

    let requested_font_type = profile
        .get("fontType")
        .or_else(|| profile.get("font_type"))
        .and_then(Value::as_str)
        .map(|value| FontType::from_value(Some(value)))
        .unwrap_or(FontType::A);
    let requested_layout_density = profile
        .get("layoutDensity")
        .or_else(|| profile.get("layout_density"))
        .and_then(Value::as_str)
        .map(|value| LayoutDensity::from_value(Some(value)))
        .unwrap_or(LayoutDensity::Compact);
    let requested_header_emphasis = profile
        .get("headerEmphasis")
        .or_else(|| profile.get("header_emphasis"))
        .and_then(Value::as_str)
        .map(|value| HeaderEmphasis::from_value(Some(value)))
        .unwrap_or(HeaderEmphasis::Strong);
    let lock_classic_ticket_typography =
        entity_type == "kitchen_ticket" && template == ReceiptTemplate::Classic;
    let font_type = if lock_classic_ticket_typography {
        FontType::A
    } else {
        requested_font_type
    };
    let layout_density = if lock_classic_ticket_typography {
        LayoutDensity::Compact
    } else {
        requested_layout_density
    };
    let header_emphasis = if lock_classic_ticket_typography {
        HeaderEmphasis::Strong
    } else {
        requested_header_emphasis
    };

    let app_language = setting_text(&conn, "general", "language").unwrap_or_default();
    // Known brands (Star, Epson) support logo raster even if the profile
    // hasn't been verified yet.  Only suppress logo for truly unknown printers
    // where we can't be sure the firmware handles raster images.
    let brand_supports_logo = matches!(
        detected_brand,
        crate::printers::PrinterBrand::Star | crate::printers::PrinterBrand::Epson
    );
    if receipt_like_entity && !capability_snapshot.supports_logo && !brand_supports_logo {
        show_logo = false;
    }
    info!(
        printer_name = %printer_name,
        detected_brand = %detected_brand.label(),
        verification_status = %verification_status,
        app_language = %app_language,
        "Auto-detection: brand and language"
    );

    // Profile character set (manual override)
    let profile_character_set = profile
        .get("characterSet")
        .or_else(|| profile.get("character_set"))
        .and_then(Value::as_str)
        .unwrap_or("PC437_USA");

    // Auto-upgrade: if profile uses the default PC437_USA and app language is not English,
    // use the language-appropriate character set instead.
    let character_set =
        if profile_character_set == "PC437_USA" && !app_language.is_empty() && app_language != "en"
        {
            let auto_cs = receipt_renderer::language_to_character_set(&app_language);
            info!(
                language = %app_language,
                auto_character_set = %auto_cs,
                "Auto-detected character set from app language"
            );
            auto_cs.to_string()
        } else {
            profile_character_set.to_string()
        };

    let greek_render_mode = profile
        .get("greekRenderMode")
        .or_else(|| profile.get("greek_render_mode"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    // Manual code page override takes priority
    let manual_code_page = profile
        .get("escposCodePage")
        .or_else(|| profile.get("escpos_code_page"))
        .and_then(Value::as_u64)
        .map(|v| v as u8);
    let code_page_brand =
        receipt_renderer::effective_code_page_brand(detected_brand, emulation_mode);

    let escpos_code_page = if manual_code_page.is_some() {
        info!(
            manual_code_page = ?manual_code_page,
            "Using manual code page override"
        );
        manual_code_page
    } else {
        let auto_cp = receipt_renderer::resolve_auto_code_page(code_page_brand, &character_set);
        if auto_cp.is_some() {
            info!(
                detected_brand = %detected_brand.label(),
                code_page_brand = %code_page_brand.label(),
                character_set = %character_set,
                auto_code_page = ?auto_cp,
                "Auto-resolved code page for brand"
            );
        }
        auto_cp
    };

    let currency_symbol = if template == ReceiptTemplate::Classic
        && matches!(entity_type, "order_receipt" | "delivery_slip")
    {
        receipt_renderer::normalize_currency_symbol_for_layout(
            &currency_symbol,
            &character_set,
            escpos_code_page,
            detected_brand,
        )
    } else {
        currency_symbol
    };

    let text_scale = setting_text(&conn, "receipt", "text_scale")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(1.25)
        .clamp(0.8, 2.0);
    let logo_scale = setting_text(&conn, "receipt", "logo_scale")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(1.0)
        .clamp(0.5, 2.0);
    let body_font_weight: u32 = match setting_text(&conn, "receipt", "body_boldness").as_deref() {
        Some("2") => 500,
        Some("3") => 600,
        Some("4") => 700,
        Some("5") => 800,
        _ => 400,
    };

    Ok(LayoutConfig {
        paper_width: crate::escpos::PaperWidth::from_mm(paper_mm),
        template,
        command_profile,
        organization_name,
        store_address,
        store_phone,
        vat_number,
        tax_office,
        footer_text,
        show_qr_code,
        qr_data,
        show_logo,
        logo_url,
        copy_label,
        character_set,
        greek_render_mode,
        escpos_code_page,
        detected_brand,
        language: app_language.clone(),
        store_subtitle,
        currency_symbol,
        font_type,
        layout_density,
        header_emphasis,
        decimal_comma: matches!(
            app_language.as_str(),
            "el" | "de" | "fr" | "it" | "es" | "pt" | "nl"
        ),
        classic_customer_render_mode,
        emulation_mode,
        printable_width_dots,
        left_margin_dots,
        raster_threshold,
        text_scale,
        logo_scale,
        body_font_weight,
    })
}

fn paper_logo_max_width_dots(paper: crate::escpos::PaperWidth) -> u32 {
    match paper {
        crate::escpos::PaperWidth::Mm58 => 384,
        crate::escpos::PaperWidth::Mm80 => 576,
        crate::escpos::PaperWidth::Mm112 => 832,
    }
}

fn paper_logo_max_height_dots(paper: crate::escpos::PaperWidth) -> u32 {
    match paper {
        crate::escpos::PaperWidth::Mm58 => 160,
        crate::escpos::PaperWidth::Mm80 => 220,
        crate::escpos::PaperWidth::Mm112 => 280,
    }
}

fn paper_logo_max_height_dots_for_brand(
    paper: crate::escpos::PaperWidth,
    brand: crate::printers::PrinterBrand,
) -> u32 {
    if brand == crate::printers::PrinterBrand::Star {
        match paper {
            crate::escpos::PaperWidth::Mm58 => 384,
            crate::escpos::PaperWidth::Mm80 => 480,
            crate::escpos::PaperWidth::Mm112 => 640,
        }
    } else {
        paper_logo_max_height_dots(paper)
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
        // Check for cached logo (avoids repeated HTTP fetches)
        let cache_path = std::env::temp_dir().join("thesmall_logo_cache.bin");
        let cache_url_path = std::env::temp_dir().join("thesmall_logo_cache_url.txt");
        if cache_path.exists() {
            if let Ok(cached_url) = fs::read_to_string(&cache_url_path) {
                if cached_url.trim() == trimmed {
                    if let Ok(metadata) = fs::metadata(&cache_path) {
                        if let Ok(modified) = metadata.modified() {
                            if modified.elapsed().unwrap_or(Duration::from_secs(86401))
                                < Duration::from_secs(86400)
                            {
                                return fs::read(&cache_path)
                                    .map_err(|e| format!("logo cache read: {e}"));
                            }
                        }
                    }
                }
            }
        }

        // Must run on a dedicated OS thread — reqwest::blocking panics
        // if called from within a Tokio async runtime.
        let url = trimmed.to_string();
        let handle = std::thread::spawn(move || -> Result<Vec<u8>, String> {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(8))
                .build()
                .map_err(|e| format!("logo HTTP client: {e}"))?;
            let response = client
                .get(&url)
                .send()
                .map_err(|e| format!("logo fetch failed: {e}"))?;
            if !response.status().is_success() {
                return Err(format!("logo fetch failed with HTTP {}", response.status()));
            }
            // Reject non-image responses (e.g. HTML error pages from CDN)
            if let Some(ct) = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
            {
                if !ct.starts_with("image/") {
                    return Err(format!(
                        "logo URL returned content-type '{ct}', expected image/*"
                    ));
                }
            }
            response
                .bytes()
                .map(|b| b.to_vec())
                .map_err(|e| format!("logo fetch bytes failed: {e}"))
        });
        let bytes = handle
            .join()
            .map_err(|_| "logo fetch thread panicked".to_string())??;

        // Cache the fetched logo for subsequent prints
        let _ = fs::write(&cache_path, &bytes);
        let _ = fs::write(&cache_url_path, trimmed);

        return Ok(bytes);
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

fn decode_logo_to_grayscale(image_bytes: &[u8]) -> Result<image::GrayImage, String> {
    if image_bytes.len() > 4 {
        let head = &image_bytes[..4];
        if head.starts_with(b"<!DO")
            || head.starts_with(b"<htm")
            || head.starts_with(b"<HTM")
            || head.starts_with(b"<?xm")
        {
            return Err("Logo URL returned HTML/XML instead of an image".to_string());
        }
    }

    let decoded = image::load_from_memory(image_bytes).map_err(|e| format!("logo decode: {e}"))?;
    let rgba = decoded.to_rgba8();
    let (src_w, src_h) = rgba.dimensions();
    if src_w == 0 || src_h == 0 {
        return Err("logo image has invalid dimensions".to_string());
    }

    let mut white_bg =
        image::RgbaImage::from_pixel(src_w, src_h, image::Rgba([255, 255, 255, 255]));
    image::imageops::overlay(&mut white_bg, &rgba, 0, 0);
    Ok(image::DynamicImage::ImageRgba8(white_bg).to_luma8())
}

fn receipt_like_logo_max_width_dots(paper: crate::escpos::PaperWidth) -> u32 {
    match paper {
        crate::escpos::PaperWidth::Mm58 => 176,
        crate::escpos::PaperWidth::Mm80 => 260,
        crate::escpos::PaperWidth::Mm112 => 360,
    }
}

fn receipt_like_logo_max_height_dots(paper: crate::escpos::PaperWidth) -> u32 {
    match paper {
        crate::escpos::PaperWidth::Mm58 => 110,
        crate::escpos::PaperWidth::Mm80 => 160,
        crate::escpos::PaperWidth::Mm112 => 210,
    }
}

pub(crate) fn load_receipt_like_logo_image(
    cfg: &LayoutConfig,
) -> Result<Option<image::GrayImage>, String> {
    if !cfg.show_logo {
        return Ok(None);
    }

    let Some(source) = cfg
        .logo_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    // Check in-memory GrayImage cache to skip expensive decode + resize.
    let cache_key = format!(
        "img|{}|{:?}|{}|{:.2}",
        source, cfg.paper_width, cfg.printable_width_dots, cfg.logo_scale
    );
    if let Ok(cache) = logo_image_cache().lock() {
        if let Some(cached) = cache.get(&cache_key) {
            info!(
                cache_key = %cache_key,
                w = cached.width(),
                h = cached.height(),
                "Receipt-like logo image cache hit"
            );
            return Ok(Some(cached.clone()));
        }
    }

    let image_bytes = read_logo_source_bytes(source)?;
    let gray = decode_logo_to_grayscale(&image_bytes)?;
    let (src_w, src_h) = gray.dimensions();

    let content_cap = u32::from(cfg.printable_width_dots)
        .saturating_sub(32)
        .max(64);
    let max_width = ((receipt_like_logo_max_width_dots(cfg.paper_width) as f32 * cfg.logo_scale)
        as u32)
        .min(content_cap);
    let max_height =
        (receipt_like_logo_max_height_dots(cfg.paper_width) as f32 * cfg.logo_scale) as u32;

    let mut target_w = src_w.min(max_width).max(1);
    let mut target_h = ((src_h as f32 * (target_w as f32 / src_w as f32)).round() as u32).max(1);
    if target_h > max_height {
        target_h = max_height;
        target_w = ((src_w as f32 * (target_h as f32 / src_h as f32)).round() as u32).max(1);
    }

    let resized = if target_w != src_w || target_h != src_h {
        image::DynamicImage::ImageLuma8(gray)
            .thumbnail(target_w, target_h)
            .to_luma8()
    } else {
        gray
    };

    // Store in GrayImage cache for subsequent prints.
    if let Ok(mut cache) = logo_image_cache().lock() {
        cache.insert(cache_key, resized.clone());
    }

    Ok(Some(resized))
}

fn rasterize_logo_to_escpos_prefix(
    image_bytes: &[u8],
    paper: crate::escpos::PaperWidth,
) -> Result<Vec<u8>, String> {
    // Validate that the bytes look like an image, not HTML or other text
    if image_bytes.len() > 4 {
        let head = &image_bytes[..4];
        if head.starts_with(b"<!DO")
            || head.starts_with(b"<htm")
            || head.starts_with(b"<HTM")
            || head.starts_with(b"<?xm")
        {
            return Err("Logo URL returned HTML/XML instead of an image".to_string());
        }
    }

    let gray = decode_logo_to_grayscale(image_bytes)?;
    let (src_w, src_h) = gray.dimensions();

    let max_width = paper_logo_max_width_dots(paper).max(8);
    let mut target_w = src_w.min(max_width);
    if target_w == 0 {
        target_w = 1;
    }
    let mut target_h = ((src_h as f32 * (target_w as f32 / src_w as f32)).round() as u32).max(1);
    // Keep logos compact on thermal paper.
    let max_h = paper_logo_max_height_dots(paper);
    if target_h > max_h {
        target_h = max_h;
        target_w = ((src_w as f32 * (target_h as f32 / src_h as f32)).round() as u32).max(1);
    }

    info!(
        src_w = src_w,
        src_h = src_h,
        target_w = target_w,
        target_h = target_h,
        paper = ?paper,
        "Rasterizing logo for ESC/POS"
    );

    let resized = if target_w != src_w || target_h != src_h {
        image::DynamicImage::ImageLuma8(gray)
            .thumbnail(target_w, target_h)
            .to_luma8()
    } else {
        gray
    };

    let width = resized.width();
    let height = resized.height();

    // Use ESC * column-format bit image (m=33, 24-dot double-density) for
    // maximum printer compatibility.  GS v 0 raster images are not reliably
    // supported by all Star, Citizen, and older Epson firmware.
    //
    // ESC * sends the image in horizontal strips of 24 rows each.  Each strip
    // is a single ESC * command:  ESC * 33 nL nH [column data…]
    // For each column, 3 bytes encode 24 vertical pixels (MSB at top).
    let strips = height.div_ceil(24);
    let mut builder = crate::escpos::EscPosBuilder::new();
    builder.center();
    for strip in 0..strips {
        let y_start = strip * 24;
        // ESC * m nL nH — select bit-image mode
        //   m = 33 (24-dot double-density)
        //   nL/nH = number of columns (little-endian)
        let n_l = (width & 0xFF) as u8;
        let n_h = ((width >> 8) & 0xFF) as u8;
        builder.raw(&[0x1B, b'*', 33, n_l, n_h]);
        for x in 0..width {
            let mut col = [0u8; 3];
            for dy in 0..24u32 {
                let y = y_start + dy;
                if y >= height {
                    break;
                }
                let luma = resized.get_pixel(x, y).0[0];
                if luma < 160 {
                    col[(dy / 8) as usize] |= 0x80 >> (dy % 8);
                }
            }
            builder.raw(&col);
        }
        builder.lf();
    }
    builder.left();

    let result = builder.build();
    info!(
        strips = strips,
        total_bytes = result.len(),
        "Logo ESC/POS prefix generated"
    );
    Ok(result)
}

/// Rasterize a logo image to raster format — Star raster (`ESC * r`) for Star
/// printers, GS v 0 for everything else.  Unlike the column-format ESC * 33
/// used by `rasterize_logo_to_escpos_prefix`, raster mode sends a single block
/// of image data which Star mC-Print3 (and similar) handles correctly.
fn rasterize_logo_to_escpos_raster(
    image_bytes: &[u8],
    paper: crate::escpos::PaperWidth,
    brand: crate::printers::PrinterBrand,
) -> Result<Vec<u8>, String> {
    if image_bytes.len() > 4 {
        let head = &image_bytes[..4];
        if head.starts_with(b"<!DO")
            || head.starts_with(b"<htm")
            || head.starts_with(b"<HTM")
            || head.starts_with(b"<?xm")
        {
            return Err("Logo URL returned HTML/XML instead of an image".to_string());
        }
    }

    let gray = decode_logo_to_grayscale(image_bytes)?;
    let (src_w, src_h) = gray.dimensions();
    if src_w > 1200 || src_h > 1200 {
        warn!(
            src_w, src_h,
            "Logo source image is very large — consider resizing to \u{2264}600\u{00D7}600 for faster first-print"
        );
    }

    let max_width = paper_logo_max_width_dots(paper).max(8);
    let use_star_raster = brand == crate::printers::PrinterBrand::Star;

    // Scale to a reasonable size: max paper width and a compact height cap per paper size.
    let mut target_w = src_w.min(max_width);
    if target_w == 0 {
        target_w = 1;
    }
    let mut target_h = ((src_h as f32 * (target_w as f32 / src_w as f32)).round() as u32).max(1);
    let max_h = paper_logo_max_height_dots_for_brand(paper, brand);
    if target_h > max_h {
        target_h = max_h;
        target_w = ((src_w as f32 * (target_h as f32 / src_h as f32)).round() as u32).max(1);
    }

    // For Star raster: use full paper width and center the image data in each row.
    // Star raster mode ignores ESC alignment commands.
    let paper_width_bytes = (max_width.div_ceil(8)) as u16;
    let image_width_bytes = target_w.div_ceil(8) as u16;
    let left_pad_bytes = if use_star_raster {
        paper_width_bytes.saturating_sub(image_width_bytes) / 2
    } else {
        0
    };
    // Star raster protocol requires each row to be exactly the full paper
    // width.  Using a partial width causes the printer to misalign subsequent
    // rows, producing garbled output and meters of wasted paper.
    let width_bytes = if use_star_raster {
        paper_width_bytes
    } else {
        image_width_bytes
    };
    let raster_w = width_bytes as u32 * 8;

    info!(
        src_w, src_h, target_w, target_h, raster_w,
        star_mode = use_star_raster,
        paper = ?paper,
        "Rasterizing logo for raster format"
    );

    let resized = if target_w != src_w || target_h != src_h {
        // Use thumbnail() for large downscale ratios (e.g. 5905→400) — it picks
        // the fastest filter automatically and is orders of magnitude quicker
        // than resize() with Triangle for big images.
        image::DynamicImage::ImageLuma8(gray)
            .thumbnail(target_w, target_h)
            .to_luma8()
    } else {
        gray
    };

    let width = resized.width();
    let height = resized.height();

    // Build raster data: each row is width_bytes bytes, MSB first
    let mut raster_data = Vec::with_capacity((width_bytes as u32 * height) as usize);
    for y in 0..height {
        for bx in 0..width_bytes {
            // Check if this byte falls within the centered image area
            let img_bx = bx as i32 - left_pad_bytes as i32;
            if img_bx < 0 || (img_bx as u32) * 8 >= target_w.div_ceil(8) * 8 {
                raster_data.push(0u8); // padding byte
                continue;
            }
            let mut byte_val = 0u8;
            for bit in 0..8u32 {
                let x = img_bx as u32 * 8 + bit;
                if x < width {
                    let luma = resized.get_pixel(x, y).0[0];
                    if luma < 160 {
                        byte_val |= 0x80 >> bit;
                    }
                }
            }
            raster_data.push(byte_val);
        }
    }

    // Trim leading blank rows (white space at top of image)
    let wb = width_bytes as usize;
    let mut leading_blank = 0usize;
    for row in 0..height as usize {
        let row_start = row * wb;
        let row_end = row_start + wb;
        if raster_data[row_start..row_end].iter().all(|&b| b == 0) {
            leading_blank += 1;
        } else {
            break;
        }
    }

    // Trim trailing blank rows (white space at bottom of image)
    let mut effective_height = height as usize;
    while effective_height > leading_blank {
        let row_start = (effective_height - 1) * wb;
        let row_end = row_start + wb;
        if raster_data[row_start..row_end].iter().all(|&b| b == 0) {
            effective_height -= 1;
        } else {
            break;
        }
    }

    // Apply trimming: remove leading and trailing blank rows
    if leading_blank > 0 || effective_height < height as usize {
        let trimmed_data = raster_data[leading_blank * wb..effective_height * wb].to_vec();
        raster_data = trimmed_data;
        let trimmed_height = effective_height - leading_blank;
        info!(
            original_height = height,
            leading_blank,
            trailing_blank = height as usize - effective_height,
            trimmed_height,
            "Trimmed blank rows from logo raster"
        );
        effective_height = trimmed_height;
    } else {
        effective_height = height as usize;
    }

    let mut builder = crate::escpos::EscPosBuilder::new();
    if !use_star_raster {
        builder.center();
    }
    if use_star_raster {
        builder.star_raster_image(width_bytes, effective_height as u16, &raster_data);
    } else {
        builder.raster_image(width_bytes, effective_height as u16, &raster_data);
    }
    if !use_star_raster {
        builder.left();
    }

    let result = builder.build();
    let format_label = if use_star_raster {
        "Star Line Mode raster"
    } else {
        "GS v 0 raster"
    };
    info!(
        raster_data_bytes = raster_data.len(),
        total_bytes = result.len(),
        width_bytes,
        effective_height,
        format = format_label,
        "Logo raster prefix generated"
    );

    // Safety guard: reject absurdly large raster data that would produce
    // meters of paper output.  60 KB is generous for a logo on 80 mm paper.
    const MAX_LOGO_RASTER_BYTES: usize = 60_000;
    if result.len() > MAX_LOGO_RASTER_BYTES {
        warn!(
            bytes = result.len(),
            max = MAX_LOGO_RASTER_BYTES,
            "Logo raster exceeds safety limit — skipping logo to prevent runaway output"
        );
        return Err(format!(
            "Logo raster too large ({} bytes, max {})",
            result.len(),
            MAX_LOGO_RASTER_BYTES
        ));
    }

    Ok(result)
}

/// In-memory cache for rasterized logo ESC/POS bytes.
///
/// Keyed on `"{logo_url}|{paper_width:?}|{brand:?}"`.  Decoding + compositing
/// + resizing a 5905×5905 source image takes ~8 s; caching makes subsequent
///   prints near-instant.
fn logo_cache() -> &'static Mutex<HashMap<String, Vec<u8>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// In-memory cache for decoded + resized logo GrayImages (used by raster-exact path).
/// Avoids the expensive image decode + resize (~2-5 s for large logos) on every print.
fn logo_image_cache() -> &'static Mutex<HashMap<String, image::GrayImage>> {
    static CACHE: OnceLock<Mutex<HashMap<String, image::GrayImage>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Clear the logo raster cache (e.g. after printer profile or logo URL change).
#[allow(dead_code)]
pub fn clear_logo_cache() {
    if let Ok(mut cache) = logo_cache().lock() {
        cache.clear();
    }
    if let Ok(mut cache) = logo_image_cache().lock() {
        cache.clear();
    }
    // Also remove disk-cached raster files.
    if let Ok(entries) = fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("thesmall_logo_raster_") && name.ends_with(".bin") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
    info!("Logo raster cache cleared (memory + disk)");
}

/// Return a stable path for the on-disk raster cache file.
/// The filename is a simple hash of the cache key so different logo URLs /
/// paper widths / brands get separate files.
fn raster_cache_path(cache_key: &str) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    cache_key.hash(&mut h);
    std::env::temp_dir().join(format!("thesmall_logo_raster_{:016x}.bin", h.finish()))
}

pub(crate) fn build_logo_prefix_for_layout(
    layout: &LayoutConfig,
) -> Result<Option<Vec<u8>>, String> {
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

    info!(
        brand = ?layout.detected_brand,
        paper = ?layout.paper_width,
        "Building logo prefix"
    );

    // Check cache first — avoids re-decoding + rasterizing the same logo.
    let cache_key = format!(
        "v9|{}|{:?}|{:?}|{:.2}",
        source, layout.paper_width, layout.detected_brand, layout.logo_scale
    );
    if let Ok(cache) = logo_cache().lock() {
        if let Some(cached) = cache.get(&cache_key) {
            info!(
                cache_key = %cache_key,
                bytes = cached.len(),
                "Logo raster cache hit (memory)"
            );
            return Ok(Some(cached.clone()));
        }
    }

    // Check persistent disk cache — survives app restarts, avoids the
    // expensive image-decode + rasterize step (~5 s for very large logos).
    let disk_path = raster_cache_path(&cache_key);
    if disk_path.exists() {
        if let Ok(metadata) = fs::metadata(&disk_path) {
            // Disk cache valid for 7 days.
            if metadata
                .modified()
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age < Duration::from_secs(7 * 86400))
            {
                if let Ok(cached) = fs::read(&disk_path) {
                    if !cached.is_empty() {
                        info!(
                            bytes = cached.len(),
                            path = %disk_path.display(),
                            "Logo raster cache hit (disk)"
                        );
                        // Populate in-memory cache too.
                        if let Ok(mut mem) = logo_cache().lock() {
                            mem.insert(cache_key.clone(), cached.clone());
                        }
                        return Ok(Some(cached));
                    }
                }
            }
        }
    }

    let bytes = read_logo_source_bytes(source)?;

    // Star printers can't handle ESC * 33 column bit-image.  Use the
    // Star-specific ESC * r raster protocol instead (Star Line Mode).
    // GS v 0 is NOT supported by Star mC-Print3 and similar models.
    let prefix = if layout.detected_brand == crate::printers::PrinterBrand::Star {
        info!("Using Star raster (ESC * r) for Star printer logo");
        rasterize_logo_to_escpos_raster(
            &bytes,
            layout.paper_width,
            crate::printers::PrinterBrand::Star,
        )?
    } else {
        rasterize_logo_to_escpos_prefix(&bytes, layout.paper_width)?
    };

    // Store in memory cache for subsequent prints within this session.
    if let Ok(mut cache) = logo_cache().lock() {
        cache.insert(cache_key, prefix.clone());
    }

    // Persist to disk so next app start skips the decode+rasterize step.
    if let Err(e) = fs::write(&disk_path, &prefix) {
        warn!(path = %disk_path.display(), error = %e, "Failed to write logo raster disk cache");
    } else {
        info!(
            bytes = prefix.len(),
            path = %disk_path.display(),
            "Logo raster saved to disk cache"
        );
    }

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

pub fn build_order_receipt_doc(db: &DbState, order_id: &str) -> Result<OrderReceiptDoc, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order = conn
        .query_row(
            "SELECT COALESCE(order_number, ''), COALESCE(order_type, ''), COALESCE(status, ''),
                    COALESCE(created_at, ''), COALESCE(table_number, ''), COALESCE(customer_name, ''),
                    COALESCE(customer_phone, ''), COALESCE(items, '[]'), COALESCE(total_amount, 0),
                    COALESCE(subtotal, 0), COALESCE(tax_amount, 0), COALESCE(discount_amount, 0),
                    COALESCE(discount_percentage, 0), COALESCE(delivery_fee, 0), COALESCE(tip_amount, 0), COALESCE(delivery_address, ''),
                    COALESCE(delivery_city, ''), COALESCE(delivery_postal_code, ''),
                    COALESCE(delivery_floor, ''), COALESCE(name_on_ringer, ''),
                    COALESCE(driver_id, ''), COALESCE(driver_name, ''), COALESCE(staff_id, ''),
                    COALESCE(delivery_notes, ''), COALESCE(special_instructions, '')
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
                    row.get::<_, f64>(8)?,
                    row.get::<_, f64>(9)?,
                    row.get::<_, f64>(10)?,
                    row.get::<_, f64>(11)?,
                    row.get::<_, f64>(12)?,
                    row.get::<_, f64>(13)?,
                    row.get::<_, f64>(14)?,
                    row.get::<_, String>(15)?,
                    row.get::<_, String>(16)?,
                    row.get::<_, String>(17)?,
                    row.get::<_, String>(18)?,
                    row.get::<_, String>(19)?,
                    row.get::<_, String>(20)?,
                    row.get::<_, String>(21)?,
                    row.get::<_, String>(22)?,
                    row.get::<_, String>(23)?,
                    row.get::<_, String>(24)?,
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
        customer_phone,
        items_json,
        total_amount,
        subtotal,
        tax_amount,
        discount_amount,
        discount_percentage,
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
        delivery_notes,
        special_instructions,
    ) = order;
    let menu_lookup = build_menu_category_lookup(&conn);

    let items: Vec<ReceiptItem> = serde_json::from_str::<Value>(&items_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            let category_fields = resolve_item_category_fields(&item, &menu_lookup);
            ReceiptItem {
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
                category_name: category_fields.category_name,
                subcategory_name: category_fields.subcategory_name,
                category_path: category_fields.category_path,
                note: build_item_note_text(&item),
                customizations: parse_item_customizations(&item),
            }
        })
        .collect();

    let mut order_notes: Vec<String> = Vec::new();
    push_unique_trimmed_note(&mut order_notes, Some(&delivery_notes));
    push_unique_trimmed_note(&mut order_notes, Some(&special_instructions));

    let effective_discount = discount_amount.max(0.0);
    let computed_subtotal =
        total_amount - tax_amount - delivery_fee - tip_amount + effective_discount;
    let display_subtotal = if computed_subtotal.is_finite() && computed_subtotal > 0.0 {
        computed_subtotal
    } else {
        subtotal.max(0.0)
    };

    let mut totals = Vec::new();
    totals.push(TotalsLine {
        label: "Subtotal".to_string(),
        amount: display_subtotal,
        emphasize: false,
        discount_percent: None,
    });
    if discount_amount > 0.0 {
        totals.push(TotalsLine {
            label: "Discount".to_string(),
            amount: -discount_amount,
            emphasize: false,
            discount_percent: if discount_percentage > 0.0 {
                Some(discount_percentage)
            } else {
                None
            },
        });
    }
    if tax_amount > 0.0 {
        totals.push(TotalsLine {
            label: "Tax".to_string(),
            amount: tax_amount,
            emphasize: false,
            discount_percent: None,
        });
    }
    if delivery_fee > 0.0 {
        totals.push(TotalsLine {
            label: "Delivery".to_string(),
            amount: delivery_fee,
            emphasize: false,
            discount_percent: None,
        });
    }
    if tip_amount > 0.0 {
        totals.push(TotalsLine {
            label: "Tip".to_string(),
            amount: tip_amount,
            emphasize: false,
            discount_percent: None,
        });
    }
    totals.push(TotalsLine {
        label: "TOTAL".to_string(),
        amount: total_amount,
        emphasize: true,
        discount_percent: None,
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
        let normalized_amount = if method == "cash" {
            cash_received
                .filter(|received| *received > 0.0)
                .unwrap_or(amount)
        } else {
            amount
        };
        payments.push(PaymentLine {
            label: label.to_string(),
            amount: normalized_amount,
            detail: None,
        });
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
            masked_card = extract_masked_card_reference(&transaction_ref);
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
        customer_phone: non_empty_field(customer_phone),
        delivery_address: non_empty_field(delivery_address),
        delivery_city: non_empty_field(delivery_city),
        delivery_postal_code: non_empty_field(delivery_postal_code),
        delivery_floor: non_empty_field(delivery_floor),
        name_on_ringer: non_empty_field(name_on_ringer),
        driver_id: non_empty_field(driver_id),
        driver_name: resolved_driver_name,
        delivery_slip_mode: DeliverySlipMode::DeliveryOrder,
        items,
        totals,
        payments,
        adjustments,
        masked_card,
        order_notes,
        status_label: None,
        cancellation_reason: None,
    })
}

/// Build a receipt document for a single split payment.
///
/// The `payment_id` identifies which payment to print. If payment_items
/// exist for this payment, only those items are shown. Otherwise all order
/// items are included with a "Split Payment" header. Only the single
/// payment line is shown.
fn build_split_receipt_doc(db: &DbState, payment_id: &str) -> Result<OrderReceiptDoc, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Load the payment record
    let (
        order_id,
        method,
        amount,
        cash_received,
        change_given,
        transaction_ref,
        discount_amount,
    ): (
        String,
        String,
        f64,
        Option<f64>,
        Option<f64>,
        String,
        f64,
    ) = conn
        .query_row(
            "SELECT order_id, COALESCE(method, ''), COALESCE(amount, 0),
                    cash_received, change_given, COALESCE(transaction_ref, ''),
                    COALESCE(discount_amount, 0)
             FROM order_payments WHERE id = ?1 AND status = 'completed'",
            params![payment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(|_| format!("Payment not found or not completed: {payment_id}"))?;

    // Load order header
    let (
        order_number,
        order_type,
        status,
        created_at,
        table_number,
        customer_name,
        customer_phone,
        items_json,
        total_amount,
    ): (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        f64,
    ) = conn
        .query_row(
            "SELECT COALESCE(order_number, ''), COALESCE(order_type, ''), COALESCE(status, ''),
                    COALESCE(created_at, ''), COALESCE(table_number, ''), COALESCE(customer_name, ''),
                    COALESCE(customer_phone, ''), COALESCE(items, '[]'), COALESCE(total_amount, 0)
             FROM orders WHERE id = ?1",
            params![order_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .map_err(|_| format!("Order not found for payment: {payment_id}"))?;

    // Check for payment_items (split-by-items mode)
    let mut pi_stmt = conn
        .prepare(
            "SELECT item_index, item_name, item_quantity, item_amount
             FROM payment_items WHERE payment_id = ?1
             ORDER BY item_index ASC",
        )
        .map_err(|e| format!("prepare payment_items: {e}"))?;

    let payment_items: Vec<(i32, String, i32, f64)> = pi_stmt
        .query_map(params![payment_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| format!("query payment_items: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let menu_lookup = build_menu_category_lookup(&conn);

    // Build items list: payment_items if present, otherwise all order items
    let items: Vec<ReceiptItem> = if !payment_items.is_empty() {
        payment_items
            .iter()
            .map(|(_idx, name, qty, amt)| ReceiptItem {
                name: name.clone(),
                quantity: *qty as f64,
                total: *amt,
                category_name: None,
                subcategory_name: None,
                category_path: None,
                note: None,
                customizations: Vec::new(),
            })
            .collect()
    } else {
        // No payment_items — show all order items
        serde_json::from_str::<Value>(&items_json)
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .map(|item| {
                let category_fields = resolve_item_category_fields(&item, &menu_lookup);
                ReceiptItem {
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
                    category_name: category_fields.category_name,
                    subcategory_name: category_fields.subcategory_name,
                    category_path: category_fields.category_path,
                    note: build_item_note_text(&item),
                    customizations: parse_item_customizations(&item),
                }
            })
            .collect()
    };

    // Build totals: show gross subtotal, optional discount, and the net paid amount.
    let inferred_gross_subtotal = if !payment_items.is_empty() {
        items.iter().map(|i| i.total).sum()
    } else {
        amount + discount_amount.max(0.0)
    };
    let mut totals = vec![TotalsLine {
        label: "Subtotal".to_string(),
        amount: inferred_gross_subtotal,
        emphasize: false,
        discount_percent: None,
    }];
    if discount_amount > 0.0 {
        totals.push(TotalsLine {
            label: "Discount".to_string(),
            amount: -discount_amount,
            emphasize: false,
            discount_percent: None,
        });
    }
    totals.push(TotalsLine {
        label: "Split Payment".to_string(),
        amount,
        emphasize: true,
        discount_percent: None,
    });

    // Build the single payment line
    let label = match method.as_str() {
        "cash" => "Cash",
        "card" => "Card",
        _ => "Other",
    };
    let normalized_amount = if method == "cash" {
        cash_received.filter(|r| *r > 0.0).unwrap_or(amount)
    } else {
        amount
    };
    let mut payments = vec![PaymentLine {
        label: label.to_string(),
        amount: normalized_amount,
        detail: None,
    }];
    if let Some(change) = change_given {
        if change > 0.0 {
            payments.push(PaymentLine {
                label: "Change".to_string(),
                amount: change,
                detail: None,
            });
        }
    }

    let masked_card = if method == "card" {
        extract_masked_card_reference(&transaction_ref)
    } else {
        None
    };

    // Add a note indicating this is a split payment receipt
    let mut order_notes = Vec::new();
    let split_note = format!("Split Payment ({:.2} of {:.2} total)", amount, total_amount);
    order_notes.push(split_note);
    if discount_amount > 0.0 {
        order_notes.push(format!("Includes split discount of {:.2}", discount_amount));
    }

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
        customer_phone: non_empty_field(customer_phone),
        delivery_address: None,
        delivery_city: None,
        delivery_postal_code: None,
        delivery_floor: None,
        name_on_ringer: None,
        driver_id: None,
        driver_name: None,
        delivery_slip_mode: DeliverySlipMode::DeliveryOrder,
        items,
        totals,
        payments,
        adjustments: Vec::new(),
        masked_card,
        order_notes,
        status_label: None,
        cancellation_reason: None,
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
        delivery_city,
        delivery_postal_code,
        delivery_floor,
        name_on_ringer,
        driver_name,
        customer_name,
        customer_phone,
    ) = conn
        .query_row(
            "SELECT COALESCE(order_number, ''), COALESCE(order_type, ''), COALESCE(created_at, ''),
                    COALESCE(table_number, ''), COALESCE(delivery_address, ''), COALESCE(delivery_notes, ''),
                    COALESCE(special_instructions, ''), COALESCE(items, '[]'),
                    COALESCE(delivery_city, ''), COALESCE(delivery_postal_code, ''),
                    COALESCE(delivery_floor, ''), COALESCE(name_on_ringer, ''),
                    COALESCE(driver_name, ''), COALESCE(customer_name, ''),
                    COALESCE(customer_phone, '')
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
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                ))
            },
        )
        .map_err(|_| format!("Order not found: {order_id}"))?;
    let menu_lookup = build_menu_category_lookup(&conn);

    let items: Vec<ReceiptItem> = serde_json::from_str::<Value>(&items_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            let category_fields = resolve_item_category_fields(&item, &menu_lookup);
            ReceiptItem {
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
                category_name: category_fields.category_name,
                subcategory_name: category_fields.subcategory_name,
                category_path: category_fields.category_path,
                note: build_item_note_text(&item),
                customizations: parse_item_customizations(&item),
            }
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
        delivery_city: if delivery_city.is_empty() {
            None
        } else {
            Some(delivery_city)
        },
        delivery_postal_code: if delivery_postal_code.is_empty() {
            None
        } else {
            Some(delivery_postal_code)
        },
        delivery_floor: if delivery_floor.is_empty() {
            None
        } else {
            Some(delivery_floor)
        },
        name_on_ringer: if name_on_ringer.is_empty() {
            None
        } else {
            Some(name_on_ringer)
        },
        driver_name: if driver_name.is_empty() {
            None
        } else {
            Some(driver_name)
        },
        customer_name: if customer_name.is_empty() {
            None
        } else {
            Some(customer_name)
        },
        customer_phone: if customer_phone.is_empty() {
            None
        } else {
            Some(customer_phone)
        },
        items,
    })
}

fn object_text_field(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .and_then(non_empty_text)
}

fn build_shift_checkout_doc(
    db: &DbState,
    shift_id: &str,
    payload: Option<&Value>,
) -> Result<ShiftCheckoutDoc, String> {
    let summary = crate::shifts::get_shift_summary(db, shift_id)?;
    let shift = summary
        .get("shift")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let cash_drawer = summary
        .get("cashDrawer")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let explicit_terminal_name =
        payload.and_then(|value| object_text_field(value, &["terminalName", "terminal_name"]));
    let terminal_name = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        resolve_printed_terminal_name_with_conn(&conn, explicit_terminal_name.as_deref())
            .unwrap_or_default()
    };
    let transferred_staff_groups = [
        summary.get("transferredDrivers").and_then(Value::as_array),
        summary.get("transferredWaiters").and_then(Value::as_array),
    ];
    let mut transferred_staff_count = 0_i64;
    let mut transferred_staff_returns = 0.0_f64;
    for group in transferred_staff_groups.into_iter().flatten() {
        transferred_staff_count += group.len() as i64;
        transferred_staff_returns += group
            .iter()
            .map(|entry| {
                entry
                    .get("net_cash_amount")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            })
            .sum::<f64>();
    }

    let mut doc = Ok(ShiftCheckoutDoc {
        shift_id: shift_id.to_string(),
        role_type: payload
            .and_then(|value| object_text_field(value, &["roleType", "role_type"]))
            .or_else(|| {
                shift
                    .get("role_type")
                    .or_else(|| shift.get("roleType"))
                    .and_then(Value::as_str)
                    .and_then(non_empty_text)
            })
            .unwrap_or_else(|| "staff".to_string()),
        staff_name: shift
            .get("staff_name")
            .or_else(|| shift.get("staffName"))
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or("Unknown")
            .to_string(),
        terminal_name,
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
        opening_amount: number_from_paths(&cash_drawer, &["/opening_amount", "/openingAmount"])
            .or_else(|| number_from_paths(&shift, &["/opening_cash_amount", "/openingCashAmount"]))
            .unwrap_or(0.0),
        transferred_staff_count,
        transferred_staff_returns,
        expected_amount: number_from_paths(&cash_drawer, &["/expected_amount", "/expectedAmount"])
            .or_else(|| {
                number_from_paths(&shift, &["/expected_cash_amount", "/expectedCashAmount"])
            }),
        closing_amount: number_from_paths(&cash_drawer, &["/closing_amount", "/closingAmount"])
            .or_else(|| number_from_paths(&shift, &["/closing_cash_amount", "/closingCashAmount"])),
        variance_amount: number_from_paths(&cash_drawer, &["/variance_amount", "/varianceAmount"])
            .or_else(|| number_from_paths(&shift, &["/cash_variance", "/cashVariance"])),
        driver_deliveries: Vec::new(),
        total_cash_collected: 0.0,
        total_card_collected: 0.0,
        total_delivery_fees: 0.0,
        total_tips: 0.0,
        amount_to_return: 0.0,
    });

    // Populate driver-specific fields
    let role = doc.as_ref().map(|d| d.role_type.as_str()).unwrap_or("");
    if role == "driver" {
        let mut cash_total = number_from_paths(
            &summary,
            &[
                "/breakdown/delivery/cashTotal",
                "/breakdown/overall/cashTotal",
            ],
        )
        .unwrap_or(0.0);
        let mut card_total = number_from_paths(
            &summary,
            &[
                "/breakdown/delivery/cardTotal",
                "/breakdown/overall/cardTotal",
            ],
        )
        .unwrap_or(0.0);
        let mut lines = Vec::new();
        let mut fees_total = 0.0_f64;
        let mut tips_total = 0.0_f64;

        if let Some(deliveries) = summary.get("driverDeliveries").and_then(Value::as_array) {
            let mut delivery_cash_total = 0.0_f64;
            let mut delivery_card_total = 0.0_f64;

            for d in deliveries {
                let cash = d
                    .get("cash_collected")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let card = d.get("card_amount").and_then(Value::as_f64).unwrap_or(0.0);
                let fee = d.get("delivery_fee").and_then(Value::as_f64).unwrap_or(0.0);
                let tip = d.get("tip_amount").and_then(Value::as_f64).unwrap_or(0.0);
                let total = d.get("total_amount").and_then(Value::as_f64).unwrap_or(0.0);

                delivery_cash_total += cash;
                delivery_card_total += card;
                fees_total += fee;
                tips_total += tip;

                lines.push(crate::receipt_renderer::DriverDeliveryLine {
                    order_number: d
                        .get("order_number")
                        .and_then(Value::as_str)
                        .unwrap_or("N/A")
                        .to_string(),
                    total_amount: total,
                    payment_method: d
                        .get("payment_method")
                        .and_then(Value::as_str)
                        .unwrap_or("cash")
                        .to_string(),
                    cash_collected: cash,
                    delivery_fee: fee,
                    tip_amount: tip,
                    status: d
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                });
            }
            if !lines.is_empty() {
                cash_total = delivery_cash_total;
                card_total = delivery_card_total;
            }
        }

        if let Ok(ref mut doc) = doc {
            let opening = doc.opening_amount;
            let expenses = doc.total_expenses;
            doc.driver_deliveries = lines;
            doc.total_cash_collected = cash_total;
            doc.total_card_collected = card_total;
            doc.total_delivery_fees = fees_total;
            doc.total_tips = tips_total;
            doc.amount_to_return = doc
                .expected_amount
                .unwrap_or(opening + cash_total - expenses);
        }
    }

    doc
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
            if let Some(trimmed) = non_empty_text(text) {
                return Some(trimmed);
            }
        }
    }
    None
}

fn build_z_report_doc_from_payload(db: &DbState, payload: &Value, entity_id: &str) -> ZReportDoc {
    let report_date = text_from_paths(payload, &["/date", "/reportDate", "/report_date"])
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
    let generated_at = text_from_paths(payload, &["/generatedAt", "/generated_at"])
        .unwrap_or_else(|| Utc::now().to_rfc3339());
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
    let tips_total =
        number_from_paths(payload, &["/tips/total", "/tipsTotal", "/tips_total"]).unwrap_or(0.0);
    let opening_cash = number_from_paths(
        payload,
        &["/cashDrawer/openingTotal", "/openingCash", "/opening_cash"],
    )
    .unwrap_or(0.0);
    let closing_cash = number_from_paths(
        payload,
        &["/cashDrawer/closing", "/closingCash", "/closing_cash"],
    )
    .unwrap_or(0.0);
    let expected_cash = number_from_paths(
        payload,
        &["/cashDrawer/expected", "/expectedCash", "/expected_cash"],
    )
    .unwrap_or(0.0);
    let cash_drops =
        number_from_paths(payload, &["/cashDrawer/totalCashDrops", "/cashDrops"]).unwrap_or(0.0);
    let driver_cash_given = number_from_paths(
        payload,
        &["/cashDrawer/driverCashGiven", "/driverCashGiven"],
    )
    .unwrap_or(0.0);
    let driver_cash_returned = number_from_paths(
        payload,
        &["/cashDrawer/driverCashReturned", "/driverCashReturned"],
    )
    .unwrap_or(0.0);
    let staff_payments_total = number_from_paths(
        payload,
        &[
            "/staffPayments/total",
            "/cashDrawer/staffPaymentsTotal",
            "/staffPaymentsTotal",
        ],
    )
    .unwrap_or(0.0);
    let dine_in_orders = number_from_paths(payload, &["/sales/dineInOrders", "/dineInOrders"])
        .unwrap_or(0.0)
        .round() as i64;
    let dine_in_sales =
        number_from_paths(payload, &["/sales/dineInSales", "/dineInSales"]).unwrap_or(0.0);
    let takeaway_orders = number_from_paths(payload, &["/sales/takeawayOrders", "/takeawayOrders"])
        .unwrap_or(0.0)
        .round() as i64;
    let takeaway_sales =
        number_from_paths(payload, &["/sales/takeawaySales", "/takeawaySales"]).unwrap_or(0.0);
    let delivery_orders = number_from_paths(payload, &["/sales/deliveryOrders", "/deliveryOrders"])
        .unwrap_or(0.0)
        .round() as i64;
    let delivery_sales =
        number_from_paths(payload, &["/sales/deliverySales", "/deliverySales"]).unwrap_or(0.0);
    let shift_count = number_from_paths(payload, &["/shiftCount", "/shift_count", "/shifts/total"])
        .map(|value| value.round() as i64)
        .filter(|count| *count > 0);
    let mut shift_ref = text_from_paths(payload, &["/shiftId", "/shift_id"]).unwrap_or_default();
    if shift_count.unwrap_or(0) > 1 {
        shift_ref.clear();
    }
    let explicit_terminal_name = text_from_paths(payload, &["/terminalName", "/terminal_name"]);
    let terminal_name = db
        .conn
        .lock()
        .ok()
        .and_then(|conn| {
            resolve_printed_terminal_name_with_conn(&conn, explicit_terminal_name.as_deref())
        })
        .unwrap_or_default();

    ZReportDoc {
        report_id: entity_id.to_string(),
        report_date,
        generated_at,
        shift_ref,
        shift_count,
        terminal_name,
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
        tips_total,
        opening_cash,
        closing_cash,
        expected_cash,
        cash_drops,
        driver_cash_given,
        driver_cash_returned,
        staff_payments_total,
        dine_in_orders,
        dine_in_sales,
        takeaway_orders,
        takeaway_sales,
        delivery_orders,
        delivery_sales,
        staff_reports: payload
            .get("staffReports")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|s| receipt_renderer::ZReportStaffEntry {
                        name: s
                            .get("staffName")
                            .and_then(Value::as_str)
                            .unwrap_or("—")
                            .to_string(),
                        role: s
                            .get("role")
                            .and_then(Value::as_str)
                            .unwrap_or("cashier")
                            .to_string(),
                        check_in: s
                            .get("checkIn")
                            .and_then(Value::as_str)
                            .map(|v| v.to_string()),
                        check_out: s
                            .get("checkOut")
                            .and_then(Value::as_str)
                            .map(|v| v.to_string()),
                        order_count: s
                            .pointer("/orders/count")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        cash_amount: s
                            .pointer("/orders/cashAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        card_amount: s
                            .pointer("/orders/cardAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        total_amount: s
                            .pointer("/orders/totalAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        opening_cash: s
                            .pointer("/drawer/opening")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        staff_payment: s
                            .pointer("/payments/staffPayments")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn build_z_report_doc(db: &DbState, z_report_id: &str) -> Result<ZReportDoc, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let report = conn.query_row(
        "SELECT id, shift_id, terminal_id, report_date, generated_at,
                gross_sales, net_sales, total_orders, cash_sales, card_sales,
                refunds_total, voids_total, discounts_total, expenses_total,
                cash_variance, tips_total, opening_cash, closing_cash, expected_cash,
                report_json
         FROM z_reports WHERE id = ?1",
        params![z_report_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, f64>(5)?,
                row.get::<_, f64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, f64>(8)?,
                row.get::<_, f64>(9)?,
                row.get::<_, f64>(10)?,
                row.get::<_, f64>(11)?,
                row.get::<_, f64>(12)?,
                row.get::<_, f64>(13)?,
                row.get::<_, f64>(14)?,
                row.get::<_, f64>(15).unwrap_or(0.0),
                row.get::<_, f64>(16).unwrap_or(0.0),
                row.get::<_, f64>(17).unwrap_or(0.0),
                row.get::<_, f64>(18).unwrap_or(0.0),
                row.get::<_, String>(19)?,
            ))
        },
    );

    let (
        report_id,
        raw_shift_ref,
        _terminal_id,
        report_date,
        generated_at,
        gross_sales,
        net_sales,
        total_orders,
        cash_sales,
        card_sales,
        refunds_total,
        voids_total,
        discounts_total,
        expenses_total,
        cash_variance,
        tips_total,
        opening_cash,
        closing_cash,
        expected_cash,
        report_json_str,
    ) = report.map_err(|_| format!("Z-report not found: {z_report_id}"))?;

    let rj: Value = serde_json::from_str(&report_json_str).unwrap_or_default();
    let shift_count = rj
        .pointer("/shifts/total")
        .and_then(Value::as_i64)
        .filter(|count| *count > 0);
    let shift_ref = if shift_count.unwrap_or(0) > 1 {
        String::new()
    } else {
        raw_shift_ref.unwrap_or_default()
    };
    let explicit_terminal_name = text_from_paths(&rj, &["/terminalName", "/terminal_name"]);
    let terminal_name =
        resolve_printed_terminal_name_with_conn(&conn, explicit_terminal_name.as_deref())
            .unwrap_or_default();

    Ok(ZReportDoc {
        report_id,
        report_date,
        generated_at,
        shift_ref,
        shift_count,
        terminal_name,
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
        tips_total,
        opening_cash,
        closing_cash,
        expected_cash,
        cash_drops: rj
            .pointer("/cashDrawer/totalCashDrops")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        driver_cash_given: rj
            .pointer("/cashDrawer/driverCashGiven")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        driver_cash_returned: rj
            .pointer("/cashDrawer/driverCashReturned")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        staff_payments_total: rj
            .pointer("/staffPayments/total")
            .or_else(|| rj.pointer("/cashDrawer/staffPaymentsTotal"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        dine_in_orders: rj
            .pointer("/sales/dineInOrders")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        dine_in_sales: rj
            .pointer("/sales/dineInSales")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        takeaway_orders: rj
            .pointer("/sales/takeawayOrders")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        takeaway_sales: rj
            .pointer("/sales/takeawaySales")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        delivery_orders: rj
            .pointer("/sales/deliveryOrders")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        delivery_sales: rj
            .pointer("/sales/deliverySales")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        staff_reports: rj
            .get("staffReports")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|s| receipt_renderer::ZReportStaffEntry {
                        name: s
                            .get("staffName")
                            .and_then(Value::as_str)
                            .unwrap_or("—")
                            .to_string(),
                        role: s
                            .get("role")
                            .and_then(Value::as_str)
                            .unwrap_or("cashier")
                            .to_string(),
                        check_in: s
                            .get("checkIn")
                            .and_then(Value::as_str)
                            .map(|v| v.to_string()),
                        check_out: s
                            .get("checkOut")
                            .and_then(Value::as_str)
                            .map(|v| v.to_string()),
                        order_count: s
                            .pointer("/orders/count")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        cash_amount: s
                            .pointer("/orders/cashAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        card_amount: s
                            .pointer("/orders/cardAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        total_amount: s
                            .pointer("/orders/totalAmount")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        opening_cash: s
                            .pointer("/drawer/opening")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        staff_payment: s
                            .pointer("/payments/staffPayments")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn build_document_for_job(
    db: &DbState,
    entity_type: &str,
    entity_id: &str,
    payload_json: Option<&str>,
) -> Result<ReceiptDocument, String> {
    let payload =
        payload_json.and_then(|raw_payload| serde_json::from_str::<Value>(raw_payload).ok());

    match entity_type {
        "order_receipt" => Ok(ReceiptDocument::OrderReceipt(build_order_receipt_doc(
            db, entity_id,
        )?)),
        "kitchen_ticket" => Ok(ReceiptDocument::KitchenTicket(build_kitchen_ticket_doc(
            db, entity_id,
        )?)),
        "shift_checkout" => Ok(ReceiptDocument::ShiftCheckout(build_shift_checkout_doc(
            db,
            entity_id,
            payload.as_ref(),
        )?)),
        "z_report" => {
            if let Some(payload) = payload.as_ref() {
                return Ok(ReceiptDocument::ZReport(build_z_report_doc_from_payload(
                    db, payload, entity_id,
                )));
            }
            Ok(ReceiptDocument::ZReport(build_z_report_doc(db, entity_id)?))
        }
        "delivery_slip" => {
            let mut doc = build_order_receipt_doc(db, entity_id)?;
            if let Some(payload) = payload.as_ref() {
                if let Some(mode) = object_text_field(payload, &["slip_mode", "slipMode"]) {
                    doc.delivery_slip_mode = if mode.eq_ignore_ascii_case("assign_driver") {
                        DeliverySlipMode::AssignDriver
                    } else {
                        DeliverySlipMode::DeliveryOrder
                    };
                }
                if doc.driver_id.is_none() {
                    doc.driver_id =
                        object_text_field(payload, &["driverId", "driver_id", "staff_id"]);
                }
                if doc.driver_name.is_none() {
                    doc.driver_name = object_text_field(payload, &["driverName", "driver_name"]);
                }
            }
            Ok(ReceiptDocument::DeliverySlip(doc))
        }
        "split_receipt" => {
            // entity_id is the payment_id for split receipts
            let doc = build_split_receipt_doc(db, entity_id)?;
            Ok(ReceiptDocument::OrderReceipt(doc))
        }
        "order_completed_receipt" => {
            let mut doc = build_order_receipt_doc(db, entity_id)?;
            doc.status_label = Some("\u{2713} COMPLETED".to_string());
            Ok(ReceiptDocument::OrderReceipt(doc))
        }
        "order_canceled_receipt" => {
            let mut doc = build_order_receipt_doc(db, entity_id)?;
            doc.status_label = Some("\u{2717} CANCELED".to_string());
            if let Some(payload) = payload.as_ref() {
                doc.cancellation_reason = payload
                    .get("cancellationReason")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
            }
            Ok(ReceiptDocument::OrderReceipt(doc))
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
        let notes = build_item_note_text(&item).unwrap_or_default();
        items_html.push_str(&format!(
            "<li><strong>{:.0}x {}</strong>{}</li>",
            qty,
            escape_html(name),
            if notes.is_empty() {
                String::new()
            } else {
                format!("<br/><small>Note: {}</small>", escape_html(&notes))
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
    let layout = resolve_layout_config(db, &serde_json::json!({}), "shift_checkout")?;
    let document = ReceiptDocument::ShiftCheckout(build_shift_checkout_doc(db, shift_id, None)?);
    let html = receipt_renderer::render_html(&document, &layout);
    let path_str = write_print_html_file(data_dir, "shift_checkout", shift_id, &html)?;
    info!(shift_id = %shift_id, path = %path_str, "Shift checkout file generated");
    Ok(path_str)
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
    let (brand_source, branch_source, address_source, phone_source) = match db.conn.lock() {
        Ok(conn) => resolve_header_sources(&conn),
        Err(_) => (
            "unknown".to_string(),
            "unknown".to_string(),
            "unknown".to_string(),
            "unknown".to_string(),
        ),
    };
    let layout_revision = receipt_renderer::layout_revision();
    info!(
        entity_type = %entity_type,
        printer = %printer_name,
        character_set = %layout.character_set,
        escpos_code_page = ?layout.escpos_code_page,
        show_logo = layout.show_logo,
        template = ?layout.template,
        layout_revision = %layout_revision,
        command_profile = ?layout.command_profile,
        font_type = ?layout.font_type,
        layout_density = ?layout.layout_density,
        header_emphasis = ?layout.header_emphasis,
        classic_customer_render_mode = ?layout.classic_customer_render_mode,
        emulation_mode = ?layout.emulation_mode,
        printable_width_dots = layout.printable_width_dots,
        left_margin_dots = layout.left_margin_dots,
        raster_threshold = layout.raster_threshold,
        organization_name = %layout.organization_name,
        store_subtitle = ?layout.store_subtitle,
        store_address = ?layout.store_address,
        store_phone = ?layout.store_phone,
        vat_number = ?layout.vat_number,
        tax_office = ?layout.tax_office,
        brand_source = %brand_source,
        branch_source = %branch_source,
        address_source = %address_source,
        phone_source = %phone_source,
        "Dispatch: resolved layout config"
    );
    let mut rendered = receipt_renderer::render_escpos(document, &layout);
    info!(
        escpos_bytes = rendered.bytes.len(),
        warnings = rendered.warnings.len(),
        "Dispatch: ESC/POS rendered (before logo)"
    );
    let embed_logo_in_body = rendered.body_mode == receipt_renderer::EscPosBodyMode::RasterExact
        && is_receipt_like_entity_type(entity_type);
    if embed_logo_in_body {
        info!("Dispatch: receipt-like raster job uses embedded logo composition");
    } else {
        match build_logo_prefix_for_layout(&layout) {
            Ok(Some(prefix)) => {
                info!(
                    logo_prefix_bytes = prefix.len(),
                    "Dispatch: logo prefix generated"
                );
                // Prepend logo raster before the receipt body.
                // The receipt body already starts with ESC @ (init) which resets
                // all formatting. For Star printers, add an extra LF after raster
                // exit to ensure the printer fully transitions back to text mode.
                let mut combined = Vec::with_capacity(rendered.bytes.len() + prefix.len() + 1);
                combined.extend_from_slice(&prefix); // logo raster (includes raster enter/exit)
                if rendered.body_mode != receipt_renderer::EscPosBodyMode::RasterExact {
                    combined.push(0x0A); // LF — flush raster exit, ensure text mode
                }
                combined.extend_from_slice(&rendered.bytes); // full receipt (ESC @ + body)
                rendered.bytes = combined;
                info!(
                    total_bytes = rendered.bytes.len(),
                    "Dispatch: total bytes after logo"
                );
            }
            Ok(None) => {
                info!("Dispatch: no logo configured");
            }
            Err(err) => {
                rendered.warnings.push(receipt_renderer::RenderWarning {
                    code: "logo_text_fallback".to_string(),
                    message: format!("Logo rendering failed; using text header fallback ({err})"),
                });
            }
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
                    // Epson: GS V A 16
                    rendered.bytes.truncate(len - 4);
                } else if len >= 3 && rendered.bytes[len - 3..] == [0x1B, 0x64, 0x01] {
                    // Star: ESC d 1
                    rendered.bytes.truncate(len - 3);
                }
            }
            let doc_name = match entity_type {
                "kitchen_ticket" => "POS Kitchen Ticket",
                "shift_checkout" => "POS Shift Checkout",
                "z_report" => "POS Z Report",
                "delivery_slip" => "POS Delivery Slip",
                _ => "POS Receipt",
            };
            let _dispatch = printers::print_raw_for_profile(&profile, &rendered.bytes, doc_name)?;
            Ok((profile, rendered.warnings))
        }
        other => Err(format!("Unsupported driver_type: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Background print worker
// ---------------------------------------------------------------------------

/// Recover stale `printing` jobs that were left behind by a crash or error.
///
/// Any job in `printing` status for more than 30 seconds is presumed stale and
/// reset to `pending` so the worker can re-attempt it.
pub fn recover_stale_printing_jobs(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let affected = conn
        .execute(
            "UPDATE print_jobs
             SET status = 'pending', updated_at = ?1
             WHERE status = 'printing'
               AND julianday(?1) - julianday(updated_at) > (30.0 / 86400.0)",
            params![now],
        )
        .map_err(|e| format!("recover stale printing jobs: {e}"))?;

    if affected > 0 {
        warn!(
            count = affected,
            "Recovered stale print jobs from 'printing' back to 'pending'"
        );
    }

    // Purge old failed/completed jobs (older than 24 hours) to prevent queue bloat
    let purged = conn
        .execute(
            "DELETE FROM print_jobs
             WHERE status IN ('failed', 'printed', 'dispatched')
               AND julianday(?1) - julianday(updated_at) > 1.0",
            params![now],
        )
        .unwrap_or(0);

    if purged > 0 {
        info!(
            count = purged,
            "Purged old completed/failed print jobs (>24h)"
        );
    }

    Ok(affected)
}

/// Process pending print jobs: generate receipt files and dispatch them.
///
/// This is called by the background worker loop.  It processes one batch of
/// pending jobs each tick.  Returns the number of jobs processed.
pub fn process_pending_jobs(db: &DbState, data_dir: &Path) -> Result<usize, String> {
    // Recover any stale 'printing' jobs from previous crashes/errors
    let _ = recover_stale_printing_jobs(db);

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
        let process_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || -> Result<(), String> {
                // Mark as printing
                {
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let _ = conn.execute(
                        "UPDATE print_jobs SET status = 'printing', updated_at = ?1 WHERE id = ?2",
                        params![now_str, job_id],
                    );
                }

                let document = match build_document_for_job(
                    db,
                    &entity_type,
                    &entity_id,
                    payload_json.as_deref(),
                ) {
                    Ok(document) => document,
                    Err(error) => {
                        // Document build errors (e.g. "Order not found") are non-retryable:
                        // the entity data is missing and won't reappear.
                        let mark_fn = if is_non_retryable_print_error(&error) {
                            mark_print_job_failed_non_retryable
                        } else {
                            mark_print_job_failed
                        };
                        if let Err(e) = mark_fn(db, &job_id, &error) {
                            error!(job_id = %job_id, error = %e, "Failed to mark print job as failed");
                        }
                        return Ok(());
                    }
                };

                let role = if entity_type == "kitchen_ticket" {
                    "kitchen"
                } else {
                    "receipt"
                };
                let html_profile = printers::resolve_printer_profile_for_role(
                    db,
                    profile_id.as_deref(),
                    Some(role),
                )
                .ok()
                .flatten()
                .unwrap_or_else(|| serde_json::json!({}));
                let html_layout =
                    resolve_layout_config(db, &html_profile, &entity_type).unwrap_or_default();
                let html = receipt_renderer::render_html(&document, &html_layout);
                let path = match write_print_html_file(data_dir, &entity_type, &entity_id, &html) {
                    Ok(path) => path,
                    Err(error) => {
                        if let Err(e) = mark_print_job_failed(db, &job_id, &error) {
                            error!(job_id = %job_id, error = %e, "Failed to mark print job as failed");
                        }
                        return Ok(());
                    }
                };

                // Try to dispatch to hardware printer from structured render path.
                match dispatch_to_printer(db, &entity_type, profile_id.as_deref(), &document) {
                    Ok((resolved_profile, render_warnings)) => {
                        if let Err(e) = mark_print_job_dispatched(db, &job_id, &path) {
                            error!(job_id = %job_id, error = %e, "Failed to mark print job as dispatched");
                            return Ok(());
                        }

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
                        if let Err(error) =
                            drawer::try_drawer_kick_after_print(db, &resolved_profile)
                        {
                            let _ =
                                set_print_job_warning(db, &job_id, "drawer_kick_failed", &error);
                        }
                    }
                    Err(error) => {
                        warn!(job_id = %job_id, error = %error, "Hardware print failed, file generated at {path}");
                        let mark_result = if is_non_retryable_print_error(&error) {
                            mark_print_job_failed_non_retryable(db, &job_id, &error)
                        } else {
                            mark_print_job_failed(db, &job_id, &error)
                        };
                        if let Err(e) = mark_result {
                            error!(job_id = %job_id, error = %e, "Failed to mark print job as failed");
                        }
                    }
                }
                Ok(())
            },
        ));

        match process_result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                error!(job_id = %job_id, error = %e, "Print job processing error");
            }
            Err(_panic) => {
                error!(job_id = %job_id, "Print job processing panicked unexpectedly");
                let _ = mark_print_job_failed_non_retryable(
                    db,
                    &job_id,
                    "Internal error: job processing panicked",
                );
            }
        }
    }

    if count > 0 {
        info!(processed = count, "Print worker processed jobs");
    }

    Ok(count)
}

/// Threshold of consecutive failures before emitting an alert event.
const PRINT_WORKER_FAILURE_ALERT_THRESHOLD: u32 = 10;

/// Start the background print worker loop.
///
/// Runs every `interval_secs` seconds, processes pending print jobs.
/// Emits a `print-worker-alert` Tauri event when consecutive failures exceed
/// the threshold, and resets the counter on any successful tick.
pub fn start_print_worker(
    db: Arc<DbState>,
    app_handle: tauri::AppHandle,
    data_dir: PathBuf,
    interval_secs: u64,
    cancel: tokio_util::sync::CancellationToken,
) {
    use tauri::Emitter;

    tauri::async_runtime::spawn(async move {
        let interval = tokio::time::Duration::from_secs(interval_secs);
        let mut consecutive_failures: u32 = 0;
        loop {
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = cancel.cancelled() => {
                    info!("Print worker cancelled");
                    break;
                }
            }
            if cancel.is_cancelled() {
                break;
            }
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                process_pending_jobs(&db, &data_dir)
            }));
            match result {
                Ok(Ok(processed)) => {
                    if processed > 0 {
                        consecutive_failures = 0;
                    }
                }
                Ok(Err(e)) => {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    error!(
                        consecutive_failures = consecutive_failures,
                        "Print worker error: {e}"
                    );
                }
                Err(_) => {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    error!(
                        consecutive_failures = consecutive_failures,
                        "Print worker panicked, will retry next tick"
                    );
                }
            }
            if consecutive_failures >= PRINT_WORKER_FAILURE_ALERT_THRESHOLD
                && consecutive_failures % PRINT_WORKER_FAILURE_ALERT_THRESHOLD == 0
            {
                warn!(
                    consecutive_failures = consecutive_failures,
                    "Print worker has failed {} consecutive times", consecutive_failures
                );
                let _ = app_handle.emit(
                    "print-worker-alert",
                    serde_json::json!({
                        "type": "consecutive_failures",
                        "count": consecutive_failures,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    }),
                );
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
    use rusqlite::{params, Connection};
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

    fn insert_receipt_order(conn: &Connection, order_id: &str, order_number: &str, total: f64) {
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, subtotal, status, order_type,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, ?2, '[]', ?3, ?3, 'completed', 'pickup',
                'pending', datetime('now'), datetime('now')
             )",
            params![order_id, order_number, total],
        )
        .expect("insert test order");
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_order_payment(
        conn: &Connection,
        payment_id: &str,
        order_id: &str,
        method: &str,
        amount: f64,
        cash_received: Option<f64>,
        change_given: Option<f64>,
        transaction_ref: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, cash_received, change_given,
                transaction_ref, sync_status, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, 'completed', ?5, ?6,
                ?7, 'pending', datetime('now'), datetime('now')
             )",
            params![
                payment_id,
                order_id,
                method,
                amount,
                cash_received,
                change_given,
                transaction_ref
            ],
        )
        .expect("insert test payment");
    }

    fn insert_shift_checkout_fixture(conn: &Connection, shift_id: &str, terminal_id: &str) {
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, status,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, total_orders_count, total_sales_amount,
                total_cash_sales, total_card_sales, branch_id, terminal_id, calculation_version,
                payment_amount, sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'staff-1', 'Alice', 'cashier', 'closed',
                100.0, 125.0, 125.0, 0.0,
                '2026-03-15T08:00:00Z', '2026-03-15T16:00:00Z', 3, 25.0,
                15.0, 10.0, 'branch-1', ?2, 2,
                0.0, 'pending', '2026-03-15T16:00:00Z', '2026-03-15T16:00:00Z'
             )",
            params![shift_id, terminal_id],
        )
        .expect("insert shift checkout fixture");
    }

    fn insert_active_cashier_fixture(conn: &Connection, shift_id: &str, drawer_id: &str) {
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, opening_cash_amount, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                '2026-03-18T08:00:00Z', 200.0, 'active', 2,
                'pending', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
             )",
            params![shift_id],
        )
        .expect("insert active cashier fixture");
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, driver_cash_given, opened_at, created_at, updated_at
             ) VALUES (
                ?1, ?2, 'cashier-1', 'branch-1', 'term-1',
                200.0, 0.0, '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
             )",
            params![drawer_id, shift_id],
        )
        .expect("insert active cashier drawer fixture");
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
        // ESC * 33 (24-dot double-density column-format bit image)
        assert!(prefix.windows(3).any(|window| window == [0x1B, b'*', 33]));
    }

    #[test]
    fn test_build_logo_prefix_for_star_layout_keeps_logo_compact() {
        let mut encoded = Vec::new();
        let logo = image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(
            400,
            400,
            image::Luma([0]),
        ));
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
            paper_width: crate::escpos::PaperWidth::Mm80,
            detected_brand: crate::printers::PrinterBrand::Star,
            ..LayoutConfig::default()
        };
        let prefix = build_logo_prefix_for_layout(&layout)
            .expect("logo prefix result")
            .expect("logo prefix present");

        // Star logos use Star raster mode (ESC * r A).
        // GS v 0 is NOT supported by Star printers.
        assert!(
            prefix
                .windows(4)
                .any(|window| window == [0x1B, b'*', b'r', b'A']),
            "expected Star raster header (ESC * r A) for Star printer logo"
        );
        assert!(
            !prefix
                .windows(4)
                .any(|window| window == [0x1D, b'v', b'0', 0x00]),
            "GS v 0 raster should NOT be used for Star printer logo"
        );
        assert!(
            prefix.len() < 60_000,
            "expected compact Star logo raster, got {} bytes",
            prefix.len()
        );
    }

    #[test]
    fn test_load_receipt_like_logo_image_from_data_url() {
        let mut encoded = Vec::new();
        let logo = image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(
            240,
            180,
            image::Luma([0]),
        ));
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
            paper_width: crate::escpos::PaperWidth::Mm80,
            printable_width_dots: 576,
            ..LayoutConfig::default()
        };

        let image = load_receipt_like_logo_image(&layout)
            .expect("load logo image")
            .expect("logo image should be present");

        assert!(image.width() <= 260);
        assert!(image.height() <= 160);
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
                    name_on_ringer, driver_name, delivery_notes, sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-delivery', 'ORD-DEL-1', '[]', 10.0, 10.0, 'delivered', 'delivery',
                    'Main St 42', 'Athens', '10558', '2', 'Papadopoulos', 'Nikos Driver', 'Leave at the gate',
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
        assert!(doc
            .order_notes
            .iter()
            .any(|note| note == "Leave at the gate"));
        assert_eq!(doc.driver_id, None);
        assert_eq!(doc.delivery_slip_mode, DeliverySlipMode::DeliveryOrder);
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
        assert_eq!(doc.driver_id.as_deref(), Some("driver-1"));
        assert_eq!(doc.delivery_slip_mode, DeliverySlipMode::DeliveryOrder);
    }

    #[test]
    fn test_build_document_for_job_delivery_slip_defaults_to_delivery_order_mode() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, subtotal, status, order_type,
                    customer_name, customer_phone, delivery_address, delivery_city,
                    delivery_postal_code, delivery_floor, name_on_ringer, driver_id,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-slip-default', 'ORD-DSL-1', '[]', 10.0, 10.0, 'pending', 'delivery',
                    'Customer One', '2100000000', 'Main St 42', 'Athens', '10558', '2', 'Papadopoulos',
                    'drv-22', 'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }

        let doc = build_document_for_job(&db, "delivery_slip", "ord-slip-default", None).unwrap();
        match doc {
            ReceiptDocument::DeliverySlip(doc) => {
                assert_eq!(doc.delivery_slip_mode, DeliverySlipMode::DeliveryOrder);
                assert_eq!(doc.driver_id.as_deref(), Some("drv-22"));
            }
            _ => panic!("expected delivery slip document"),
        }
    }

    #[test]
    fn test_build_document_for_job_delivery_slip_applies_assign_payload_and_driver_fallbacks() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, subtotal, status, order_type,
                    customer_name, customer_phone, delivery_address, delivery_city,
                    delivery_postal_code, delivery_floor, name_on_ringer,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-slip-assign', 'ORD-DSL-2', '[]', 12.0, 12.0, 'pending', 'delivery',
                    'Customer Two', '2100000001', 'Second St 10', 'Athens', '10559', '1', 'Kostas',
                    'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }
        let payload = serde_json::json!({
            "slip_mode": "assign_driver",
            "driverId": "drv-99",
            "driverName": "Assigned Driver"
        });
        let raw_payload = payload.to_string();
        let doc = build_document_for_job(
            &db,
            "delivery_slip",
            "ord-slip-assign",
            Some(raw_payload.as_str()),
        )
        .unwrap();
        match doc {
            ReceiptDocument::DeliverySlip(doc) => {
                assert_eq!(doc.delivery_slip_mode, DeliverySlipMode::AssignDriver);
                assert_eq!(doc.driver_id.as_deref(), Some("drv-99"));
                assert_eq!(doc.driver_name.as_deref(), Some("Assigned Driver"));
            }
            _ => panic!("expected delivery slip document"),
        }
    }

    #[test]
    fn test_build_document_for_job_shift_checkout_uses_display_terminal_name() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_shift_checkout_fixture(&conn, "shift-checkout-1", "terminal-9bf9dfce");
            db::set_setting(&conn, "terminal", "name", "Front Counter")
                .expect("set terminal display name");
        }

        let doc = build_document_for_job(&db, "shift_checkout", "shift-checkout-1", None).unwrap();
        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.terminal_name, "Front Counter");
                assert_eq!(doc.role_type, "cashier");
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_build_document_for_job_cashier_shift_checkout_includes_transferred_staff_returns() {
        let db = test_db();

        let cashier_one = crate::shifts::open_shift(
            &db,
            &serde_json::json!({
                "staffId": "cashier-1",
                "staffName": "Cashier One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "cashier",
                "openingCash": 500.0,
            }),
        )
        .expect("open cashier one");
        let cashier_one_shift_id = cashier_one["shiftId"]
            .as_str()
            .expect("cashier one shift id")
            .to_string();

        crate::shifts::open_shift(
            &db,
            &serde_json::json!({
                "staffId": "driver-1",
                "staffName": "Driver One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "driver",
                "openingCash": 60.0,
            }),
        )
        .expect("open driver");

        crate::shifts::close_shift(
            &db,
            &serde_json::json!({
                "shiftId": cashier_one_shift_id,
                "closingCash": 440.0,
            }),
        )
        .expect("close cashier one");

        let cashier_two = crate::shifts::open_shift(
            &db,
            &serde_json::json!({
                "staffId": "cashier-2",
                "staffName": "Cashier Two",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "cashier",
                "openingCash": 300.0,
            }),
        )
        .expect("open cashier two");
        let cashier_two_shift_id = cashier_two["shiftId"]
            .as_str()
            .expect("cashier two shift id")
            .to_string();

        let doc =
            build_document_for_job(&db, "shift_checkout", cashier_two_shift_id.as_str(), None)
                .expect("build shift checkout doc");

        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.transferred_staff_count, 1);
                assert_eq!(doc.transferred_staff_returns, 60.0);
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_build_document_for_job_driver_shift_checkout_keeps_amount_to_return_without_delivery_rows(
    ) {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_active_cashier_fixture(&conn, "cashier-shift-1", "drawer-shift-1");
            db::set_setting(&conn, "terminal", "name", "Front Counter")
                .expect("set terminal display name");
        }

        let open_result = crate::shifts::open_shift(
            &db,
            &serde_json::json!({
                "staffId": "driver-1",
                "staffName": "Driver One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "driver",
                "openingCash": 25.0,
            }),
        )
        .expect("open driver shift");
        let driver_shift_id = open_result["shiftId"]
            .as_str()
            .expect("driver shift id")
            .to_string();

        crate::shifts::close_shift(
            &db,
            &serde_json::json!({
                "shiftId": driver_shift_id.as_str(),
                "closingCash": 20.0,
            }),
        )
        .expect("close driver shift");

        let doc = build_document_for_job(&db, "shift_checkout", &driver_shift_id, None).unwrap();
        match doc {
            ReceiptDocument::ShiftCheckout(doc) => {
                assert_eq!(doc.role_type, "driver");
                assert_eq!(doc.terminal_name, "Front Counter");
                assert!(doc.driver_deliveries.is_empty());
                assert_eq!(doc.opening_amount, 25.0);
                assert_eq!(doc.total_cash_collected, 0.0);
                assert_eq!(doc.expected_amount, Some(25.0));
                assert_eq!(doc.amount_to_return, 25.0);
                assert_eq!(doc.closing_amount, Some(20.0));
                assert_eq!(doc.variance_amount, Some(-5.0));
            }
            _ => panic!("expected shift checkout document"),
        }
    }

    #[test]
    fn test_build_document_for_job_z_report_payload_prefers_shift_count_and_terminal_name() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "terminal", "name", "Fallback Counter")
                .expect("set fallback terminal display name");
        }

        let payload = serde_json::json!({
            "date": "2026-03-15",
            "generatedAt": "2026-03-15T23:59:00Z",
            "shiftId": "shift-aggregate-1",
            "shiftCount": 4,
            "terminalId": "terminal-9bf9dfce",
            "terminalName": "Main POS",
            "sales": {
                "totalOrders": 11,
                "totalSales": 245.0,
                "cashSales": 120.0,
                "cardSales": 125.0
            },
            "cashDrawer": {
                "totalVariance": 0.0
            }
        });
        let raw_payload = payload.to_string();

        let doc = build_document_for_job(
            &db,
            "z_report",
            "snapshot-20260315",
            Some(raw_payload.as_str()),
        )
        .unwrap();
        match doc {
            ReceiptDocument::ZReport(doc) => {
                assert_eq!(doc.shift_ref, "");
                assert_eq!(doc.shift_count, Some(4));
                assert_eq!(doc.terminal_name, "Main POS");
                assert_eq!(doc.generated_at, "2026-03-15T23:59:00Z");
            }
            _ => panic!("expected z-report document"),
        }
    }

    #[test]
    fn test_receipt_like_entity_type_includes_shift_checkout_and_z_report() {
        assert!(is_receipt_like_entity_type("shift_checkout"));
        assert!(is_receipt_like_entity_type("z_report"));
    }

    #[test]
    fn test_build_order_receipt_doc_cash_uses_received_amount_and_change_only() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-cash-received", "ORD-CASH-1", 17.70);
            insert_order_payment(
                &conn,
                "pay-cash-received",
                "ord-cash-received",
                "cash",
                17.70,
                Some(20.00),
                Some(2.30),
                None,
            );
        }

        let doc = build_order_receipt_doc(&db, "ord-cash-received").unwrap();
        assert_eq!(doc.payments.len(), 2);
        assert_eq!(doc.payments[0].label, "Cash");
        assert!((doc.payments[0].amount - 20.00).abs() < 0.001);
        assert_eq!(doc.payments[1].label, "Change");
        assert!((doc.payments[1].amount - 2.30).abs() < 0.001);
        assert!(!doc.payments.iter().any(|line| line.label == "Received"));
    }

    #[test]
    fn test_build_order_receipt_doc_cash_falls_back_to_amount_without_received() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-cash-fallback", "ORD-CASH-2", 17.70);
            insert_order_payment(
                &conn,
                "pay-cash-fallback",
                "ord-cash-fallback",
                "cash",
                17.70,
                None,
                None,
                None,
            );
        }

        let doc = build_order_receipt_doc(&db, "ord-cash-fallback").unwrap();
        assert_eq!(doc.payments.len(), 1);
        assert_eq!(doc.payments[0].label, "Cash");
        assert!((doc.payments[0].amount - 17.70).abs() < 0.001);
        assert!(!doc.payments.iter().any(|line| line.label == "Received"));
    }

    #[test]
    fn test_build_order_receipt_doc_card_keeps_amount_and_masked_card() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-card", "ORD-CARD-1", 17.70);
            insert_order_payment(
                &conn,
                "pay-card",
                "ord-card",
                "card",
                17.70,
                None,
                None,
                Some("txn-auth-****1234"),
            );
        }

        let doc = build_order_receipt_doc(&db, "ord-card").unwrap();
        assert_eq!(doc.payments.len(), 1);
        assert_eq!(doc.payments[0].label, "Card");
        assert!((doc.payments[0].amount - 17.70).abs() < 0.001);
        assert_eq!(doc.masked_card.as_deref(), Some("****1234"));
    }

    #[test]
    fn test_build_order_receipt_doc_card_skips_mock_transaction_ref() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_receipt_order(&conn, "ord-card-mock", "ORD-CARD-2", 12.60);
            insert_order_payment(
                &conn,
                "pay-card-mock",
                "ord-card-mock",
                "card",
                12.60,
                None,
                None,
                Some("mock-0215"),
            );
        }

        let doc = build_order_receipt_doc(&db, "ord-card-mock").unwrap();
        assert_eq!(doc.payments.len(), 1);
        assert_eq!(doc.payments[0].label, "Card");
        assert!(doc.masked_card.is_none());
    }

    #[test]
    fn test_build_order_receipt_doc_includes_discount_percentage_metadata() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, subtotal, status, order_type,
                    discount_amount, discount_percentage, sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-discount-percent', 'ORD-DISC-1', '[]', 12.60, 14.00, 'completed', 'pickup',
                    1.40, 10.0, 'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-discount-percent").unwrap();
        let subtotal_line = doc
            .totals
            .iter()
            .find(|line| line.label == "Subtotal")
            .expect("subtotal line");
        assert!((subtotal_line.amount - 14.00).abs() < 0.001);
        let discount_line = doc
            .totals
            .iter()
            .find(|line| line.label == "Discount")
            .expect("discount total line");
        assert!((discount_line.amount + 1.40).abs() < 0.001);
        assert_eq!(discount_line.discount_percent, Some(10.0));
    }

    #[test]
    fn test_build_order_receipt_doc_collects_item_and_order_notes() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, subtotal, status, order_type,
                    delivery_notes, special_instructions, sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-notes', 'ORD-NOTES-1',
                    '[{\"name\":\"Waffle\",\"quantity\":1,\"total\":8.8,\"notes\":\"Well done\",\"special_instructions\":\"No sugar\"}]',
                    8.80, 8.80, 'completed', 'pickup',
                    'Use side door', 'Call on arrival', 'pending', datetime('now'), datetime('now')
                 )",
                [],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-notes").unwrap();
        assert_eq!(doc.order_notes, vec!["Use side door", "Call on arrival"]);
        assert_eq!(
            doc.items.first().and_then(|item| item.note.as_deref()),
            Some("Well done | No sugar")
        );
    }

    #[test]
    fn test_build_order_receipt_doc_backfills_category_path_from_menu_cache() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO menu_cache (cache_key, data, updated_at) VALUES (?1, ?2, datetime('now'))",
                params![
                    "categories",
                    r#"[{"id":"cat-sweet","name":"ΓΛΥΚΑ"}]"#
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO menu_cache (cache_key, data, updated_at) VALUES (?1, ?2, datetime('now'))",
                params![
                    "subcategories",
                    r#"[{"id":"sub-waffle","name":"Βάφλα","category_id":"cat-sweet"}]"#
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, subtotal, status, order_type,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-category-backfill', 'ORD-CAT-1', ?1, 8.80, 8.80, 'completed', 'pickup',
                    'pending', datetime('now'), datetime('now')
                 )",
                params![r#"[{"menu_item_id":"sub-waffle","name":"Βάφλα","quantity":1,"total_price":8.8}]"#],
            )
            .unwrap();
        }

        let doc = build_order_receipt_doc(&db, "ord-category-backfill").unwrap();
        let first_item = doc.items.first().expect("order should include item");
        assert_eq!(first_item.category_name.as_deref(), Some("ΓΛΥΚΑ"));
        assert_eq!(first_item.subcategory_name.as_deref(), Some("Βάφλα"));
        assert_eq!(first_item.category_path.as_deref(), Some("ΓΛΥΚΑ > Βάφλα"));
    }

    #[test]
    fn test_resolve_layout_config_uses_restaurant_name_as_branch_subtitle_fallback() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "organization", "name", "The Small Group").unwrap();
            db::set_setting(&conn, "restaurant", "name", "Kifisia Branch").unwrap();
        }

        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "modern"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.organization_name, "The Small Group");
        assert_eq!(layout.store_subtitle.as_deref(), Some("Kifisia Branch"));
    }

    #[test]
    fn test_resolve_layout_config_skips_duplicate_branch_name_and_uses_org_subtitle() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "organization", "name", "The Small Group").unwrap();
            db::set_setting(&conn, "organization", "subtitle", "Head Office").unwrap();
            db::set_setting(&conn, "restaurant", "name", "The Small Group").unwrap();
        }

        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "modern"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.organization_name, "The Small Group");
        assert_eq!(layout.store_subtitle.as_deref(), Some("Head Office"));
    }

    #[test]
    fn test_resolve_layout_config_respects_profile_template() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.template, ReceiptTemplate::Classic);
    }

    #[test]
    fn test_resolve_layout_config_defaults_receipt_like_docs_to_classic_raster_exact() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80
        });

        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.template, ReceiptTemplate::Classic);
        assert_eq!(
            layout.classic_customer_render_mode,
            ClassicCustomerRenderMode::RasterExact
        );
        assert_eq!(layout.font_type, FontType::A);
        assert_eq!(layout.layout_density, LayoutDensity::Compact);
        assert_eq!(layout.header_emphasis, HeaderEmphasis::Strong);
    }

    #[test]
    fn test_resolve_layout_config_kitchen_ticket_classic_locks_typography() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "fontType": "b",
            "layoutDensity": "spacious",
            "headerEmphasis": "normal"
        });

        let layout =
            resolve_layout_config(&db, &profile, "kitchen_ticket").expect("resolve layout config");

        assert_eq!(layout.template, ReceiptTemplate::Classic);
        assert_eq!(layout.font_type, FontType::A);
        assert_eq!(layout.layout_density, LayoutDensity::Compact);
        assert_eq!(layout.header_emphasis, HeaderEmphasis::Strong);
    }

    #[test]
    fn test_resolve_layout_config_classic_order_receipt_honors_typography_settings() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "fontType": "b",
            "layoutDensity": "spacious",
            "headerEmphasis": "normal"
        });

        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.template, ReceiptTemplate::Classic);
        assert_eq!(layout.font_type, FontType::B);
        assert_eq!(layout.layout_density, LayoutDensity::Spacious);
        assert_eq!(layout.header_emphasis, HeaderEmphasis::Normal);
    }

    #[test]
    fn test_resolve_layout_config_honors_template_override_setting() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "receipt", "template_override", "classic").unwrap();
        }

        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "modern"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.template, ReceiptTemplate::Classic);
    }

    #[test]
    fn test_resolve_layout_config_defaults_to_full_style_for_star() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "printerName": "Star MCP31"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.command_profile, CommandProfile::FullStyle);
    }

    #[test]
    fn test_resolve_layout_config_honors_command_profile_override() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "receipt", "command_profile", "full_style").unwrap();
        }

        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "modern",
            "printerName": "Star MCP31"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.command_profile, CommandProfile::FullStyle);
    }

    #[test]
    fn test_resolve_layout_config_reads_printer_typography_settings() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "modern",
            "fontType": "b",
            "layoutDensity": "spacious",
            "headerEmphasis": "normal",
            "printerName": "Star MCP31"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.font_type, FontType::B);
        assert_eq!(layout.layout_density, LayoutDensity::Spacious);
        assert_eq!(layout.header_emphasis, HeaderEmphasis::Normal);
    }

    #[test]
    fn test_resolve_layout_config_classic_receipt_normalizes_unsupported_euro_symbol() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "general", "language", "el").unwrap();
        }

        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "characterSet": "CP66_GREEK",
            "escposCodePage": 66,
            "printerName": "Generic Thermal Printer"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.currency_symbol, " EUR");
    }

    #[test]
    fn test_resolve_layout_config_reads_exact_mode_and_calibration_from_connection_json() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "printerName": "Star MCP31",
            "connectionJson": "{\"render_mode\":\"raster_exact\",\"emulation\":\"star_line\",\"printable_width_dots\":510,\"left_margin_dots\":12,\"threshold\":150}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(
            layout.classic_customer_render_mode,
            ClassicCustomerRenderMode::RasterExact
        );
        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::StarLine);
        assert_eq!(layout.printable_width_dots, 510);
        assert_eq!(layout.left_margin_dots, 12);
        assert_eq!(layout.raster_threshold, 150);
    }

    #[test]
    fn test_resolve_layout_config_uses_star_code_page_when_star_line_is_forced() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "192.168.1.19",
            "characterSet": "PC737_GREEK",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\",\"emulation\":\"star_line\",\"capabilities\":{\"status\":\"verified\",\"resolvedTransport\":\"raw_tcp\",\"resolvedAddress\":\"192.168.1.19:9100\",\"emulation\":\"star_line\",\"renderMode\":\"text\",\"supportsCut\":true,\"supportsLogo\":false}}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::StarLine);
        assert_eq!(layout.escpos_code_page, Some(15));
    }

    #[test]
    fn test_resolve_layout_config_defaults_unverified_raw_network_to_escpos_text() {
        let db = test_db();
        // Star brand detected from printer name → should use Auto (not Escpos)
        // so that is_star_line_mode() returns true for Star printers.
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "Star MCP31 LAN",
            "printerType": "network",
            "characterSet": "PC737_GREEK",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\"}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::Auto);
        assert_eq!(layout.detected_brand, crate::printers::PrinterBrand::Star);
        assert_eq!(
            layout.classic_customer_render_mode,
            ClassicCustomerRenderMode::Text
        );
        // Star code page 15 (PC737 Greek) instead of ESC/POS code page 14
        assert_eq!(layout.escpos_code_page, Some(15));
    }

    #[test]
    fn test_resolve_layout_config_honors_candidate_capability_snapshot_for_draft_tests() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "192.168.1.19",
            "printerType": "network",
            "characterSet": "PC737_GREEK",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\",\"emulation\":\"auto\",\"render_mode\":\"raster_exact\",\"capabilities\":{\"status\":\"candidate\",\"resolvedTransport\":\"raw_tcp\",\"resolvedAddress\":\"192.168.1.19:9100\",\"emulation\":\"star_line\",\"renderMode\":\"text\",\"supportsCut\":true,\"supportsLogo\":false}}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::StarLine);
        assert_eq!(
            layout.classic_customer_render_mode,
            ClassicCustomerRenderMode::Text
        );
        assert_eq!(layout.escpos_code_page, Some(15));
    }

    #[test]
    fn test_resolve_layout_config_keeps_unknown_network_on_escpos() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "127.0.0.1",
            "printerType": "network",
            "characterSet": "PC737_GREEK",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"127.0.0.1\",\"port\":9}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::Escpos);
        assert_eq!(
            layout.classic_customer_render_mode,
            ClassicCustomerRenderMode::Text
        );
        assert_eq!(layout.escpos_code_page, Some(14));
    }

    #[test]
    fn test_resolve_layout_config_uses_standard_code_page_when_star_printer_forces_escpos() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "Star MCP31",
            "characterSet": "PC737_GREEK",
            "connectionJson": "{\"type\":\"system\",\"systemName\":\"Star MCP31\",\"emulation\":\"escpos\"}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");

        assert_eq!(layout.emulation_mode, ReceiptEmulationMode::Escpos);
        assert_eq!(layout.escpos_code_page, Some(14));
    }

    #[test]
    fn test_resolve_layout_config_uses_full_80mm_width_for_mcp31_by_default() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "printerName": "Star MCP31L"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");
        assert_eq!(layout.printable_width_dots, 576);
    }

    #[test]
    fn test_resolve_layout_config_clamps_left_margin_when_width_is_full() {
        let db = test_db();
        let profile = serde_json::json!({
            "paperWidthMm": 80,
            "receiptTemplate": "classic",
            "connectionJson": "{\"render_mode\":\"raster_exact\",\"printable_width_dots\":576,\"left_margin_dots\":12}"
        });
        let layout =
            resolve_layout_config(&db, &profile, "order_receipt").expect("resolve layout config");
        assert_eq!(layout.printable_width_dots, 576);
        assert_eq!(layout.left_margin_dots, 0);
    }

    #[test]
    fn test_body_boldness_default() {
        let db = test_db();
        let profile = serde_json::json!({});
        let layout = resolve_layout_config(&db, &profile, "order_receipt").unwrap();
        assert_eq!(layout.body_font_weight, 400);
    }

    #[test]
    fn test_body_boldness_level_3() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value) VALUES (?1, ?2, ?3)",
                rusqlite::params!["receipt", "body_boldness", "3"],
            ).unwrap();
        }
        let profile = serde_json::json!({});
        let layout = resolve_layout_config(&db, &profile, "order_receipt").unwrap();
        assert_eq!(layout.body_font_weight, 600);
    }

    #[test]
    fn test_body_boldness_in_html() {
        use crate::receipt_renderer::{
            render_html, LayoutConfig, OrderReceiptDoc, ReceiptDocument,
        };
        let cfg = LayoutConfig {
            body_font_weight: 700,
            ..Default::default()
        };
        let html = render_html(
            &ReceiptDocument::OrderReceipt(OrderReceiptDoc {
                order_id: "t".into(),
                order_number: "1".into(),
                order_type: "pickup".into(),
                status: "completed".into(),
                created_at: "2026-01-01".into(),
                ..Default::default()
            }),
            &cfg,
        );
        assert!(
            html.contains("font-weight: 700"),
            "HTML should contain body font-weight 700, got snippet: {}",
            &html[..500.min(html.len())]
        );
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
    fn test_mark_dispatched() {
        let db = test_db();

        let result = enqueue_print_job(&db, "order_receipt", "ord-2", None).unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        mark_print_job_dispatched(&db, job_id, "/tmp/receipt.html").unwrap();

        let jobs = list_print_jobs(&db, Some("dispatched")).unwrap();
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

        // Mark as dispatched first (warnings apply to successful jobs)
        mark_print_job_dispatched(&db, job_id, "/tmp/receipt.html").unwrap();

        // Set a warning
        set_print_job_warning(
            &db,
            job_id,
            "drawer_kick_failed",
            "TCP connect failed: timeout",
        )
        .unwrap();

        // Verify warning is visible in the job list
        let jobs = list_print_jobs(&db, Some("dispatched")).unwrap();
        let arr = jobs.as_array().unwrap();
        let job = arr.iter().find(|j| j["id"] == job_id).unwrap();
        assert_eq!(job["warningCode"], "drawer_kick_failed");
        assert_eq!(job["warningMessage"], "TCP connect failed: timeout");
        assert_eq!(job["status"], "dispatched"); // status unchanged
    }

    #[test]
    fn test_print_job_last_attempt_at_set() {
        let db = test_db();

        let result = enqueue_print_job(&db, "order_receipt", "ord-ts", None).unwrap();
        let job_id = result["jobId"].as_str().unwrap();

        // Mark as dispatched
        mark_print_job_dispatched(&db, job_id, "/tmp/receipt.html").unwrap();

        // Verify last_attempt_at is set
        let jobs = list_print_jobs(&db, Some("dispatched")).unwrap();
        let arr = jobs.as_array().unwrap();
        let job = arr.iter().find(|j| j["id"] == job_id).unwrap();
        assert!(
            job["lastAttemptAt"].as_str().is_some(),
            "lastAttemptAt should be set after dispatch"
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

    #[test]
    fn test_recover_stale_printing_jobs() {
        let db = test_db();

        // Enqueue a job then manually set it to 'printing' with an old timestamp
        enqueue_print_job(&db, "order_receipt", "ord-stale", None).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE print_jobs SET status = 'printing', updated_at = datetime('now', '-2 minutes')",
                [],
            )
            .unwrap();
        }

        // Verify it's stuck in 'printing'
        let jobs = list_print_jobs(&db, Some("printing")).unwrap();
        assert_eq!(jobs.as_array().unwrap().len(), 1);

        // Recovery should reset it back to 'pending'
        let recovered = recover_stale_printing_jobs(&db).unwrap();
        assert_eq!(recovered, 1);

        // Now it should be 'pending' again
        let pending = list_print_jobs(&db, Some("pending")).unwrap();
        assert_eq!(pending.as_array().unwrap().len(), 1);
        let printing = list_print_jobs(&db, Some("printing")).unwrap();
        assert_eq!(printing.as_array().unwrap().len(), 0);
    }

    #[test]
    fn test_recent_printing_job_not_recovered() {
        let db = test_db();

        // Enqueue a job and set it to 'printing' with a recent timestamp (now)
        enqueue_print_job(&db, "order_receipt", "ord-recent", None).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE print_jobs SET status = 'printing', updated_at = datetime('now')",
                [],
            )
            .unwrap();
        }

        // Recovery should NOT touch it — it's only been 'printing' for 0 seconds
        let recovered = recover_stale_printing_jobs(&db).unwrap();
        assert_eq!(recovered, 0);

        // Still in 'printing'
        let printing = list_print_jobs(&db, Some("printing")).unwrap();
        assert_eq!(printing.as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_stuck_printing_job_blocks_reenqueue_then_recovery_unblocks() {
        let db = test_db();

        // Enqueue and simulate a stuck 'printing' job
        enqueue_print_job(&db, "order_receipt", "ord-block", None).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE print_jobs SET status = 'printing', updated_at = datetime('now', '-5 minutes')",
                [],
            )
            .unwrap();
        }

        // Trying to enqueue again returns duplicate
        let dup = enqueue_print_job(&db, "order_receipt", "ord-block", None).unwrap();
        assert_eq!(dup["duplicate"], true);

        // Recover the stale job
        recover_stale_printing_jobs(&db).unwrap();

        // After recovery it's 'pending', so re-enqueue still sees the existing pending job
        let dup2 = enqueue_print_job(&db, "order_receipt", "ord-block", None).unwrap();
        assert_eq!(dup2["duplicate"], true);
        // But the job is now 'pending' and will actually be processed
        let pending = list_print_jobs(&db, Some("pending")).unwrap();
        assert_eq!(pending.as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_is_print_action_enabled_defaults() {
        let db = test_db();
        for key in &[
            "after_order",
            "payment_receipt",
            "split_receipt",
            "shift_close",
            "driver_assigned",
            "z_report",
            "kitchen_ticket",
        ] {
            assert!(
                is_print_action_enabled(&db, key),
                "key {key} should default true"
            );
        }
        assert!(!is_print_action_enabled(&db, "on_complete"));
        assert!(!is_print_action_enabled(&db, "on_cancel"));
    }

    #[test]
    fn test_is_print_action_enabled_explicit_false() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value) VALUES (?1, ?2, ?3)",
            rusqlite::params!["receipt_actions", "after_order", "false"],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value) VALUES (?1, ?2, ?3)",
            rusqlite::params!["receipt_actions", "on_complete", "true"],
        )
        .unwrap();
        drop(conn);
        assert!(!is_print_action_enabled(&db, "after_order"));
        assert!(is_print_action_enabled(&db, "on_complete"));
    }

    #[test]
    fn test_new_entity_types_accepted() {
        let db = test_db();
        let r1 = enqueue_print_job(&db, "order_completed_receipt", "ord-c1", None);
        assert!(r1.is_ok(), "order_completed_receipt should be accepted");
        let r2 = enqueue_print_job(&db, "order_canceled_receipt", "ord-x1", None);
        assert!(r2.is_ok(), "order_canceled_receipt should be accepted");
    }

    #[test]
    fn test_new_entity_types_use_receipt_layout() {
        assert!(
            is_receipt_like_entity_type("order_completed_receipt"),
            "order_completed_receipt must be receipt-like for proper LayoutConfig"
        );
        assert!(
            is_receipt_like_entity_type("order_canceled_receipt"),
            "order_canceled_receipt must be receipt-like for proper LayoutConfig"
        );
    }

    #[test]
    fn test_completed_receipt_sets_status_label() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, subtotal, status, order_type, sync_status, created_at, updated_at)
                 VALUES ('ord-done', 'ORD-DONE', '[]', 10.0, 10.0, 'completed', 'dine-in', 'pending', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }
        let doc = match build_document_for_job(&db, "order_completed_receipt", "ord-done", None)
            .unwrap()
        {
            ReceiptDocument::OrderReceipt(d) => d,
            _ => panic!("expected OrderReceipt"),
        };
        assert!(
            doc.status_label
                .as_deref()
                .unwrap_or("")
                .contains("COMPLETED"),
            "status_label should contain COMPLETED"
        );
    }

    #[test]
    fn test_canceled_receipt_includes_reason() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, subtotal, status, order_type, sync_status, created_at, updated_at)
                 VALUES ('ord-x', 'ORD-X', '[]', 5.0, 5.0, 'canceled', 'takeaway', 'pending', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }
        let payload = serde_json::json!({ "cancellationReason": "Out of stock" }).to_string();
        let doc =
            match build_document_for_job(&db, "order_canceled_receipt", "ord-x", Some(&payload))
                .unwrap()
            {
                ReceiptDocument::OrderReceipt(d) => d,
                _ => panic!("expected OrderReceipt"),
            };
        assert_eq!(
            doc.cancellation_reason.as_deref(),
            Some("Out of stock"),
            "cancellation_reason should be 'Out of stock'"
        );
    }

    #[test]
    fn test_canceled_receipt_null_reason() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, subtotal, status, order_type, sync_status, created_at, updated_at)
                 VALUES ('ord-x2', 'ORD-X2', '[]', 5.0, 5.0, 'canceled', 'takeaway', 'pending', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }
        let payload = serde_json::json!({ "cancellationReason": null }).to_string();
        let doc =
            match build_document_for_job(&db, "order_canceled_receipt", "ord-x2", Some(&payload))
                .unwrap()
            {
                ReceiptDocument::OrderReceipt(d) => d,
                _ => panic!("expected OrderReceipt"),
            };
        assert!(
            doc.cancellation_reason.is_none(),
            "cancellation_reason should be None when payload has null"
        );
    }
}
