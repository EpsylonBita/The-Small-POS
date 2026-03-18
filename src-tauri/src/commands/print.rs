use chrono::Utc;
use serde::Deserialize;
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tracing::{info, warn};

use crate::{
    auth, db, drawer, escpos, payload_arg0_as_string, print, printers, read_local_json_array,
    receipt_renderer, resolve_order_id, value_str, write_local_json,
};

// -- Print -------------------------------------------------------------------

#[derive(Debug)]
struct PrinterUpdateArgs {
    printer_id: String,
    updates: serde_json::Value,
}

#[derive(Debug)]
struct LabelPrintArgs {
    request: serde_json::Value,
    printer_id: Option<String>,
}

#[derive(Debug)]
struct LabelPrintBatchArgs {
    items: serde_json::Value,
    label_type: String,
    printer_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PrinterDiscoverPayload {
    #[serde(default)]
    types: Vec<String>,
    #[serde(default, alias = "type", alias = "printer_type")]
    printer_type: Option<String>,
}

#[derive(Debug, Clone)]
struct PrinterRecommendationInput {
    name: String,
    printer_type: String,
    address: String,
    paper_size_hint: Option<String>,
}

#[derive(Debug, Clone)]
struct PrinterRecommendation {
    detected_brand: String,
    recommended: serde_json::Value,
    probe_hints: serde_json::Value,
    confidence: u8,
    reasons: Vec<String>,
}

#[derive(Debug, Clone)]
struct VerificationCandidate {
    target: printers::ResolvedPrinterTarget,
    emulation: String,
    render_mode: String,
    supports_logo: bool,
}

fn parse_order_id_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .ok_or("Missing orderId".into())
}

fn parse_requested_receipt_entity_type(
    arg0: Option<&serde_json::Value>,
    arg1: Option<&serde_json::Value>,
) -> &'static str {
    let candidate = arg1
        .and_then(receipt_type_value)
        .or_else(|| arg0.and_then(receipt_type_value))
        .unwrap_or_else(|| "order_receipt".to_string());

    match candidate.trim().to_ascii_lowercase().as_str() {
        "delivery" | "delivery_slip" | "delivery-slip" | "delivery slip" | "slip" | "courier" => {
            "delivery_slip"
        }
        _ => "order_receipt",
    }
}

fn receipt_type_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Object(_) => {
            value_str(value, &["type", "receiptType", "receipt_type", "mode"])
        }
        _ => None,
    }
}

fn parse_profile_id_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(arg0, &["profileId", "profile_id", "id"])
        .ok_or("Missing profileId".into())
}

fn parse_printer_id_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(
        arg0,
        &["printerId", "printer_id", "profileId", "profile_id", "id"],
    )
    .ok_or("Missing printerId".into())
}

fn parse_optional_printer_id_payload(arg0: Option<serde_json::Value>) -> Option<String> {
    payload_arg0_as_string(arg0, &["printerId", "printer_id", "id"])
}

fn parse_job_id_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(arg0, &["jobId", "job_id", "id"]).ok_or("Missing jobId".into())
}

fn value_to_string(value: serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn parse_print_list_jobs_status(arg0: Option<serde_json::Value>) -> Option<String> {
    match arg0 {
        Some(serde_json::Value::Object(obj)) => {
            let payload = serde_json::Value::Object(obj);
            value_str(&payload, &["status", "state"])
        }
        Some(v) => value_to_string(v),
        None => None,
    }
}

fn parse_printer_discover_types(arg0: Option<serde_json::Value>) -> Vec<String> {
    let values: Vec<String> = match arg0 {
        Some(serde_json::Value::Array(arr)) => {
            arr.into_iter().filter_map(value_to_string).collect()
        }
        Some(serde_json::Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                vec![]
            } else {
                vec![trimmed.to_string()]
            }
        }
        Some(serde_json::Value::Object(obj)) => {
            let payload_value = serde_json::Value::Object(obj.clone());
            let parsed: PrinterDiscoverPayload =
                serde_json::from_value(payload_value).unwrap_or_default();
            let mut out = parsed.types;
            if let Some(single) = parsed.printer_type {
                out.push(single);
            }
            out
        }
        _ => vec![],
    };

    values
        .into_iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

fn normalize_recommend_printer_type(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "system" => "system".to_string(),
        "network" | "lan" => "network".to_string(),
        "wifi" => "wifi".to_string(),
        "bluetooth" | "bt" => "bluetooth".to_string(),
        "usb" => "usb".to_string(),
        _ => "system".to_string(),
    }
}

fn normalize_paper_size_hint(value: &str) -> Option<String> {
    let lower = value.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }
    if lower.contains("112") || lower.contains("4in") || lower.contains("4\"") {
        return Some("112mm".to_string());
    }
    if lower.contains("58") || lower.contains("2in") || lower.contains("2\"") {
        return Some("58mm".to_string());
    }
    if lower.contains("80") || lower.contains("3in") || lower.contains("3\"") {
        return Some("80mm".to_string());
    }
    None
}

fn parse_printer_recommendation_input(
    arg0: Option<serde_json::Value>,
) -> PrinterRecommendationInput {
    match arg0 {
        Some(serde_json::Value::String(name)) => PrinterRecommendationInput {
            name: name.trim().to_string(),
            printer_type: "system".to_string(),
            address: String::new(),
            paper_size_hint: None,
        },
        Some(serde_json::Value::Object(obj)) => {
            let payload = serde_json::Value::Object(obj);
            PrinterRecommendationInput {
                name: value_str(&payload, &["name", "printerName", "printer_name"])
                    .unwrap_or_default(),
                printer_type: normalize_recommend_printer_type(
                    value_str(&payload, &["type", "printerType", "printer_type"])
                        .unwrap_or_else(|| "system".to_string())
                        .as_str(),
                ),
                address: value_str(
                    &payload,
                    &[
                        "address",
                        "ip",
                        "hostname",
                        "host",
                        "systemName",
                        "system_name",
                        "deviceName",
                        "device_name",
                    ],
                )
                .unwrap_or_default(),
                paper_size_hint: value_str(
                    &payload,
                    &[
                        "paperSizeHint",
                        "paper_size_hint",
                        "paperSize",
                        "paper_size",
                        "paperWidth",
                        "paper_width",
                    ],
                ),
            }
        }
        _ => PrinterRecommendationInput {
            name: String::new(),
            printer_type: "system".to_string(),
            address: String::new(),
            paper_size_hint: None,
        },
    }
}

fn infer_recommended_paper_size(input: &PrinterRecommendationInput) -> (String, bool) {
    if let Some(ref hint) = input.paper_size_hint {
        if let Some(normalized) = normalize_paper_size_hint(hint) {
            return (normalized, true);
        }
    }

    let probe = format!("{} {}", input.name, input.address);
    if let Some(normalized) = normalize_paper_size_hint(&probe) {
        return (normalized, false);
    }

    ("80mm".to_string(), false)
}

fn is_star_mcp31_family(probe: &str) -> bool {
    let lower = probe.to_ascii_lowercase();
    lower.contains("mcp31")
        || lower.contains("mcp31l")
        || lower.contains("mcp31lb")
        || lower.contains("mc-print3")
        || lower.contains("mcprint3")
}

fn build_printer_recommendation(
    input: &PrinterRecommendationInput,
    app_language: &str,
) -> PrinterRecommendation {
    let detected_from_network = if matches!(input.printer_type.as_str(), "network" | "wifi") {
        printers::detect_network_printer_brand(&input.address)
    } else {
        printers::PrinterBrand::Unknown
    };
    let detected_from_name = printers::detect_printer_brand(&input.name);
    let detected_from_address = printers::detect_printer_brand(&input.address);
    let combined_probe = format!("{} {}", input.name, input.address);
    let detected_from_combined = printers::detect_printer_brand(&combined_probe);
    let detected_brand = [
        detected_from_network,
        detected_from_name,
        detected_from_address,
        detected_from_combined,
    ]
    .into_iter()
    .find(|brand| *brand != printers::PrinterBrand::Unknown)
    .unwrap_or(printers::PrinterBrand::Unknown);

    let character_set = receipt_renderer::language_to_character_set(app_language).to_string();
    let escpos_code_page =
        receipt_renderer::resolve_auto_code_page(detected_brand, &character_set).map(u16::from);
    let (paper_size, paper_from_hint) = infer_recommended_paper_size(input);
    let star_mcp31 = is_star_mcp31_family(&combined_probe);

    let receipt_template = "classic";
    let font_type = "a";
    let layout_density = "compact";
    let header_emphasis = "strong";

    let emulation = "auto";
    let render_mode = "text";

    let connection_details = serde_json::json!({
        "type": input.printer_type.clone(),
        "render_mode": render_mode,
        "emulation": emulation,
        "capabilities": {
            "status": "unverified",
            "resolvedTransport": serde_json::Value::Null,
            "resolvedAddress": serde_json::Value::Null,
            "emulation": serde_json::Value::Null,
            "renderMode": serde_json::Value::Null,
            "baudRate": serde_json::Value::Null,
            "supportsCut": false,
            "supportsLogo": false,
            "lastVerifiedAt": serde_json::Value::Null
        }
    });
    let preferred_emulation_order = if detected_brand == printers::PrinterBrand::Star || star_mcp31
    {
        vec!["star_line", "escpos"]
    } else {
        vec!["escpos", "star_line"]
    };
    let probe_hints = serde_json::json!({
        "preferredEmulationOrder": preferred_emulation_order,
        "preferredRenderOrder": ["text", "raster_exact"],
        "preferredBaudRates": [115200, 9600, 19200, 38400]
    });

    let mut confidence: i32 = 30;
    let mut reasons: Vec<String> = Vec::new();

    if !input.name.is_empty() {
        confidence += 10;
        reasons.push("Printer name provided".to_string());
    }
    if !input.address.is_empty() {
        confidence += 5;
        reasons.push("Connection address provided".to_string());
    }
    if input.printer_type == "system" {
        confidence += 15;
        reasons.push("Windows queue printer type selected".to_string());
    }
    if paper_from_hint {
        confidence += 5;
        reasons.push("Paper size taken from explicit hint".to_string());
    }
    if detected_brand != printers::PrinterBrand::Unknown {
        confidence += 25;
        reasons.push(format!(
            "Detected printer brand: {}",
            detected_brand.label()
        ));
    } else {
        reasons.push("Printer brand unknown, using generic defaults".to_string());
    }
    if star_mcp31 {
        confidence += 20;
        reasons.push("Detected Star MCP31/mC-Print3 family".to_string());
    }

    PrinterRecommendation {
        detected_brand: detected_brand.label().to_string(),
        recommended: serde_json::json!({
            "printerType": input.printer_type.clone(),
            "paperSize": paper_size,
            "characterSet": character_set,
            "escposCodePage": escpos_code_page,
            "receiptTemplate": receipt_template,
            "fontType": font_type,
            "layoutDensity": layout_density,
            "headerEmphasis": header_emphasis,
            "connectionDetails": connection_details
        }),
        probe_hints,
        confidence: confidence.clamp(10, 99) as u8,
        reasons,
    }
}

fn should_discover_system_like(requested: &[String]) -> bool {
    requested.is_empty()
        || requested
            .iter()
            .any(|t| matches!(t.as_str(), "system" | "network" | "wifi" | "usb"))
}

fn should_discover_bluetooth(requested: &[String]) -> bool {
    requested.is_empty() || requested.iter().any(|t| t == "bluetooth")
}

fn parse_printer_update_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<PrinterUpdateArgs, String> {
    let printer_id = parse_printer_id_payload(arg0.clone())?;
    let updates = match arg1 {
        Some(v) => v,
        None => match arg0 {
            Some(serde_json::Value::Object(mut obj)) => {
                if let Some(nested) = obj.remove("updates") {
                    nested
                } else {
                    obj.remove("printerId");
                    obj.remove("printer_id");
                    obj.remove("id");
                    serde_json::Value::Object(obj)
                }
            }
            _ => serde_json::json!({}),
        },
    };

    let updates = if updates.is_null() {
        serde_json::json!({})
    } else {
        updates
    };

    Ok(PrinterUpdateArgs {
        printer_id,
        updates,
    })
}

fn parse_label_print_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> LabelPrintArgs {
    let arg1_printer_id = arg1.and_then(value_to_string);
    match arg0 {
        Some(serde_json::Value::Object(mut obj)) => {
            let payload = serde_json::Value::Object(obj.clone());
            let mut printer_id = value_str(&payload, &["printerId", "printer_id"]);
            if let Some(from_arg1) = arg1_printer_id {
                printer_id = Some(from_arg1);
            }

            if let Some(request) = obj.remove("request") {
                return LabelPrintArgs {
                    request,
                    printer_id,
                };
            }

            obj.remove("printerId");
            obj.remove("printer_id");
            LabelPrintArgs {
                request: serde_json::Value::Object(obj),
                printer_id,
            }
        }
        Some(request) => LabelPrintArgs {
            request,
            printer_id: arg1_printer_id,
        },
        None => LabelPrintArgs {
            request: serde_json::json!({}),
            printer_id: arg1_printer_id,
        },
    }
}

fn parse_label_print_batch_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
) -> LabelPrintBatchArgs {
    let arg1_label_type = arg1.clone().and_then(value_to_string);
    let arg1_payload = arg1.unwrap_or(serde_json::Value::Null);
    let arg1_label_type_from_object = if arg1_payload.is_object() {
        value_str(&arg1_payload, &["labelType", "label_type", "type"])
    } else {
        None
    };
    let arg1_printer_id_from_object = if arg1_payload.is_object() {
        value_str(&arg1_payload, &["printerId", "printer_id"])
    } else {
        None
    };
    let arg2_printer_id = arg2.and_then(value_to_string);

    match arg0 {
        Some(serde_json::Value::Object(mut obj)) => {
            let payload = serde_json::Value::Object(obj.clone());
            let items = obj.remove("items").unwrap_or_else(|| serde_json::json!([]));
            let label_type = value_str(&payload, &["labelType", "label_type", "type"])
                .or(arg1_label_type)
                .or(arg1_label_type_from_object.clone())
                .unwrap_or_else(|| "barcode".to_string());
            let printer_id = value_str(&payload, &["printerId", "printer_id"])
                .or(arg1_printer_id_from_object.clone())
                .or(arg2_printer_id);

            LabelPrintBatchArgs {
                items,
                label_type,
                printer_id,
            }
        }
        Some(items) => LabelPrintBatchArgs {
            items,
            label_type: arg1_label_type
                .or(arg1_label_type_from_object.clone())
                .unwrap_or_else(|| "barcode".to_string()),
            printer_id: arg2_printer_id.or(arg1_printer_id_from_object.clone()),
        },
        None => LabelPrintBatchArgs {
            items: serde_json::json!([]),
            label_type: arg1_label_type
                .or(arg1_label_type_from_object)
                .unwrap_or_else(|| "barcode".to_string()),
            printer_id: arg2_printer_id.or(arg1_printer_id_from_object),
        },
    }
}

#[tauri::command]
pub async fn payment_print_receipt(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let entity_type = parse_requested_receipt_entity_type(arg0.as_ref(), arg1.as_ref());
    let order_id_raw = parse_order_id_payload(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    drop(conn);

    if !crate::print::is_print_action_enabled(&db, "payment_receipt") {
        return Ok(serde_json::json!({ "success": true, "skipped": true }));
    }

    let enqueue_result = print::enqueue_print_job(&db, entity_type, &order_id, None)?;

    // Process the job immediately instead of waiting for the background worker
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    if let Err(e) = print::process_pending_jobs(&db, &data_dir) {
        warn!(order_id = %order_id, error = %e, "Immediate print processing failed, worker will retry");
    }

    Ok(enqueue_result)
}

#[tauri::command]
pub async fn kitchen_print_ticket(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id = parse_order_id_payload(arg0)?;
    if !crate::print::is_print_action_enabled(&db, "kitchen_ticket") {
        return Ok(serde_json::json!({ "success": true, "skipped": true }));
    }
    let enqueue_result = print::enqueue_print_job(&db, "kitchen_ticket", &order_id, None)?;

    // Process the job immediately instead of waiting for the background worker
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    if let Err(e) = print::process_pending_jobs(&db, &data_dir) {
        warn!(order_id = %order_id, error = %e, "Immediate kitchen ticket processing failed, worker will retry");
    }

    Ok(enqueue_result)
}

#[tauri::command]
pub async fn print_list_jobs(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let status = parse_print_list_jobs_status(arg0);
    print::list_print_jobs(&db, status.as_deref())
}

#[tauri::command]
pub async fn print_get_receipt_file(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let order_id = parse_order_id_payload(arg0)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let path = print::generate_receipt_file(&db, &order_id, &data_dir)?;
    Ok(serde_json::json!({
        "success": true,
        "path": path,
    }))
}

// -- Printer profiles --------------------------------------------------------

#[tauri::command]
pub async fn printer_list_system_printers() -> Result<serde_json::Value, String> {
    let names = printers::list_system_printers();
    Ok(serde_json::json!({
        "success": true,
        "printers": names,
    }))
}

#[tauri::command]
pub async fn printer_create_profile(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing printer profile payload")?;
    printers::create_printer_profile(&db, &payload)
}

#[tauri::command]
pub async fn printer_update_profile(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing printer profile payload")?;
    printers::update_printer_profile(&db, &payload)
}

#[tauri::command]
pub async fn printer_delete_profile(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let id = parse_profile_id_payload(arg0)?;
    printers::delete_printer_profile(&db, &id)
}

#[tauri::command]
pub async fn printer_list_profiles(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    printers::list_printer_profiles(&db)
}

#[tauri::command]
pub async fn printer_get_profile(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let id = parse_profile_id_payload(arg0)?;
    printers::get_printer_profile(&db, &id)
}

#[tauri::command]
pub async fn printer_set_default_profile(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let id = parse_profile_id_payload(arg0)?;
    printers::set_default_printer_profile(&db, &id)
}

#[tauri::command]
pub async fn printer_get_default_profile(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    printers::get_default_printer_profile(&db)
}

#[tauri::command]
pub async fn print_reprint_job(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let job_id = parse_job_id_payload(arg0)?;
    printers::reprint_job(&db, &job_id)
}

/// Transform a flat Rust printer profile (from DB) into Electron-compatible format.
///
/// Maps DB columns → frontend PrinterConfig shape:
/// - `printerType` → `type`
/// - `paperWidthMm` (80) → `paperSize` ("80mm")
/// - `connectionJson` (parsed) or fallback → `connectionDetails`
/// - `isDefault` / `enabled` kept as booleans
fn profile_to_electron_format(profile: &serde_json::Value) -> serde_json::Value {
    let printer_type = value_str(profile, &["printerType", "printer_type"])
        .unwrap_or_else(|| "system".to_string());

    let paper_width = profile
        .get("paperWidthMm")
        .or_else(|| profile.get("paper_width_mm"))
        .and_then(|v| v.as_i64())
        .unwrap_or(80);
    let paper_size = format!("{paper_width}mm");

    // Parse connectionJson or build default from printerName
    let conn_details = profile
        .get("connectionJson")
        .or_else(|| profile.get("connection_json"))
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .unwrap_or_else(|| {
            let printer_name =
                value_str(profile, &["printerName", "printer_name"]).unwrap_or_default();
            match printer_type.as_str() {
                "network" | "wifi" => serde_json::json!({
                    "type": printer_type,
                    "ip": printer_name,
                    "port": 9100
                }),
                "bluetooth" => serde_json::json!({
                    "type": printer_type,
                    "address": printer_name
                }),
                "usb" => serde_json::json!({
                    "type": printer_type,
                    "path": printer_name
                }),
                _ => serde_json::json!({
                    "type": printer_type,
                    "systemName": printer_name
                }),
            }
        });

    let is_default = profile
        .get("isDefault")
        .or_else(|| profile.get("is_default"))
        .map(|v| v.as_bool().unwrap_or(false) || v.as_i64().unwrap_or(0) != 0)
        .unwrap_or(false);

    let enabled = profile
        .get("enabled")
        .map(|v| v.as_bool().unwrap_or(true) || v.as_i64().unwrap_or(1) != 0)
        .unwrap_or(true);

    serde_json::json!({
        "id": value_str(profile, &["id"]).unwrap_or_default(),
        "name": value_str(profile, &["name"]).unwrap_or_default(),
        "type": printer_type,
        "connectionDetails": conn_details,
        "paperSize": paper_size,
        "characterSet": value_str(profile, &["characterSet", "character_set"]).unwrap_or_else(|| "PC437_USA".to_string()),
        "greekRenderMode": value_str(profile, &["greekRenderMode", "greek_render_mode"]),
        "receiptTemplate": value_str(profile, &["receiptTemplate", "receipt_template"]),
        "fontType": value_str(profile, &["fontType", "font_type"]).unwrap_or_else(|| "a".to_string()),
        "layoutDensity": value_str(profile, &["layoutDensity", "layout_density"]).unwrap_or_else(|| "compact".to_string()),
        "headerEmphasis": value_str(profile, &["headerEmphasis", "header_emphasis"]).unwrap_or_else(|| "strong".to_string()),
        "escposCodePage": profile.get("escposCodePage").or_else(|| profile.get("escpos_code_page")).and_then(|v| v.as_i64()),
        "role": value_str(profile, &["role"]).unwrap_or_else(|| "receipt".to_string()),
        "isDefault": is_default,
        "fallbackPrinterId": value_str(profile, &["fallbackPrinterId", "fallback_printer_id"]),
        "enabled": enabled,
        "createdAt": value_str(profile, &["createdAt", "created_at"]),
        "updatedAt": value_str(profile, &["updatedAt", "updated_at"]),
    })
}

/// Transform an Electron-compatible printer config (from frontend) into flat Rust profile format.
///
/// Maps frontend PrinterConfig → DB columns:
/// - `type` → `printerType`
/// - `connectionDetails.systemName` → `printerName`
/// - `connectionDetails` (serialized) → `connectionJson`
/// - `paperSize` ("80mm") → `paperWidthMm` (80)
fn electron_to_profile_input(id: Option<String>, payload: serde_json::Value) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    let obj = payload.as_object();

    // Pass through id
    if let Some(id) = id {
        out.insert("id".to_string(), serde_json::json!(id));
    }

    // name
    if let Some(name) = obj.and_then(|o| o.get("name")).and_then(|v| v.as_str()) {
        out.insert("name".to_string(), serde_json::json!(name));
    }

    // type → printerType
    let printer_type = obj
        .and_then(|o| o.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("system");
    out.insert("printerType".to_string(), serde_json::json!(printer_type));

    // connectionDetails → printerName + connectionJson
    if let Some(conn) = obj.and_then(|o| o.get("connectionDetails")) {
        // Serialize full connectionDetails as JSON
        if let Ok(json_str) = serde_json::to_string(conn) {
            out.insert("connectionJson".to_string(), serde_json::json!(json_str));
        }

        // Extract printerName from connectionDetails based on type
        let conn_string = |key: &str| -> Option<String> {
            conn.get(key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        };

        let printer_name = conn_string("systemName")
            .or_else(|| conn_string("hostname"))
            .or_else(|| conn_string("ip"))
            .or_else(|| conn_string("address"))
            .or_else(|| conn_string("deviceName"))
            .or_else(|| {
                obj.and_then(|o| o.get("name"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| "Printer".to_string());
        out.insert("printerName".to_string(), serde_json::json!(printer_name));
    } else if !out.contains_key("printerName") {
        // Fallback: use name as printerName
        let fallback = out
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Printer")
            .to_string();
        out.insert("printerName".to_string(), serde_json::json!(fallback));
    }

    // paperSize ("80mm") → paperWidthMm (80)
    if let Some(ps) = obj
        .and_then(|o| o.get("paperSize"))
        .and_then(|v| v.as_str())
    {
        let mm = ps.trim_end_matches("mm").parse::<i64>().unwrap_or(80);
        out.insert("paperWidthMm".to_string(), serde_json::json!(mm));
    }

    // Direct pass-through fields
    let pass_fields = [
        ("role", "role"),
        ("characterSet", "characterSet"),
        ("greekRenderMode", "greekRenderMode"),
        ("receiptTemplate", "receiptTemplate"),
        ("fontType", "fontType"),
        ("layoutDensity", "layoutDensity"),
        ("headerEmphasis", "headerEmphasis"),
        ("fallbackPrinterId", "fallbackPrinterId"),
        ("escposCodePage", "escposCodePage"),
    ];
    for (src, dst) in pass_fields {
        if let Some(v) = obj.and_then(|o| o.get(src)) {
            out.insert(dst.to_string(), v.clone());
        }
    }

    // Bool fields
    if let Some(v) = obj
        .and_then(|o| o.get("isDefault"))
        .and_then(|v| v.as_bool())
    {
        out.insert("isDefault".to_string(), serde_json::json!(v));
    }
    if let Some(v) = obj.and_then(|o| o.get("enabled")).and_then(|v| v.as_bool()) {
        out.insert("enabled".to_string(), serde_json::json!(v));
    }

    serde_json::Value::Object(out)
}

fn normalize_draft_profile_payload(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut mapped = electron_to_profile_input(None, payload);
    let object = mapped
        .as_object_mut()
        .ok_or("Draft printer payload must be an object")?;

    let role = object
        .get("role")
        .and_then(|value| value.as_str())
        .unwrap_or("receipt")
        .to_string();
    if !object.contains_key("receiptTemplate") && matches!(role.as_str(), "receipt" | "kitchen") {
        object.insert("receiptTemplate".to_string(), serde_json::json!("classic"));
    }

    let normalized_connection_json = printers::normalize_connection_json_for_role(
        &role,
        object
            .get("connectionJson")
            .and_then(|value| value.as_str()),
        None,
    )?;
    if let Some(connection_json) = normalized_connection_json {
        object.insert(
            "connectionJson".to_string(),
            serde_json::json!(connection_json),
        );
    }

    Ok(mapped)
}

fn emulation_mode_key(mode: receipt_renderer::ReceiptEmulationMode) -> &'static str {
    match mode {
        receipt_renderer::ReceiptEmulationMode::Auto => "auto",
        receipt_renderer::ReceiptEmulationMode::Escpos => "escpos",
        receipt_renderer::ReceiptEmulationMode::StarLine => "star_line",
    }
}

fn render_mode_key(mode: receipt_renderer::ClassicCustomerRenderMode) -> &'static str {
    match mode {
        receipt_renderer::ClassicCustomerRenderMode::Text => "text",
        receipt_renderer::ClassicCustomerRenderMode::RasterExact => "raster_exact",
    }
}

fn capability_candidate_json(
    target: &printers::ResolvedPrinterTarget,
    layout: &receipt_renderer::LayoutConfig,
    supports_logo: bool,
) -> serde_json::Value {
    let (resolved_transport, resolved_address, baud_rate) = match target {
        printers::ResolvedPrinterTarget::WindowsQueue { printer_name } => (
            "windows_queue",
            printer_name.clone(),
            serde_json::Value::Null,
        ),
        printers::ResolvedPrinterTarget::RawTcp { host, port } => {
            ("raw_tcp", format!("{host}:{port}"), serde_json::Value::Null)
        }
        printers::ResolvedPrinterTarget::SerialPort {
            port_name,
            baud_rate,
        } => ("serial", port_name.clone(), serde_json::json!(baud_rate)),
    };

    serde_json::json!({
        "status": "verified",
        "resolvedTransport": resolved_transport,
        "resolvedAddress": resolved_address,
        "emulation": emulation_mode_key(layout.emulation_mode),
        "renderMode": render_mode_key(layout.classic_customer_render_mode),
        "baudRate": baud_rate,
        "supportsCut": true,
        "supportsLogo": supports_logo,
        "lastVerifiedAt": chrono::Utc::now().to_rfc3339()
    })
}

fn merge_candidate_capabilities_into_connection(
    profile: &serde_json::Value,
    candidate_capabilities: serde_json::Value,
) -> serde_json::Value {
    let mut connection_details = profile
        .get("connectionJson")
        .or_else(|| profile.get("connection_json"))
        .and_then(|value| value.as_str())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    if let Some(connection_object) = connection_details.as_object_mut() {
        connection_object.insert("capabilities".to_string(), candidate_capabilities);
    }

    connection_details
}

fn target_capability_fields(
    target: &printers::ResolvedPrinterTarget,
) -> (&'static str, String, serde_json::Value) {
    match target {
        printers::ResolvedPrinterTarget::WindowsQueue { printer_name } => (
            "windows_queue",
            printer_name.clone(),
            serde_json::Value::Null,
        ),
        printers::ResolvedPrinterTarget::RawTcp { host, port } => {
            ("raw_tcp", format!("{host}:{port}"), serde_json::Value::Null)
        }
        printers::ResolvedPrinterTarget::SerialPort {
            port_name,
            baud_rate,
        } => ("serial", port_name.clone(), serde_json::json!(baud_rate)),
    }
}

fn profile_with_candidate_capabilities(
    profile: &serde_json::Value,
    target: &printers::ResolvedPrinterTarget,
    emulation: &str,
    render_mode: &str,
    supports_logo: bool,
) -> serde_json::Value {
    let (resolved_transport, resolved_address, baud_rate) = target_capability_fields(target);
    let candidate_capabilities = serde_json::json!({
        "status": "verified",
        "resolvedTransport": resolved_transport,
        "resolvedAddress": resolved_address,
        "emulation": emulation,
        "renderMode": render_mode,
        "baudRate": baud_rate,
        "supportsCut": true,
        "supportsLogo": supports_logo,
        "lastVerifiedAt": chrono::Utc::now().to_rfc3339()
    });

    let merged_connection =
        merge_candidate_capabilities_into_connection(profile, candidate_capabilities);
    let mut updated = profile.clone();
    if let Some(object) = updated.as_object_mut() {
        object.insert(
            "connectionJson".to_string(),
            serde_json::json!(merged_connection.to_string()),
        );
    }
    updated
}

fn profile_connection_details(profile: &serde_json::Value) -> serde_json::Value {
    profile
        .get("connectionJson")
        .or_else(|| profile.get("connection_json"))
        .and_then(|value| value.as_str())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn verification_emulation_candidates(profile: &serde_json::Value) -> Vec<String> {
    let connection = profile_connection_details(profile);
    let explicit = value_str(&connection, &["emulation"])
        .unwrap_or_else(|| "auto".to_string())
        .to_ascii_lowercase();

    if matches!(explicit.as_str(), "escpos" | "star_line") {
        return vec![explicit];
    }

    if printers::detect_printer_brand_for_profile(profile) == printers::PrinterBrand::Star {
        vec!["star_line".to_string(), "escpos".to_string()]
    } else {
        vec!["escpos".to_string(), "star_line".to_string()]
    }
}

fn verification_render_mode_candidates(
    profile: &serde_json::Value,
    sample_kind: &str,
) -> Vec<String> {
    if sample_kind != "branding" {
        return vec!["text".to_string()];
    }

    let connection = profile_connection_details(profile);
    let explicit = value_str(&connection, &["render_mode"])
        .unwrap_or_else(|| "text".to_string())
        .to_ascii_lowercase();

    if explicit == "raster_exact" {
        vec!["raster_exact".to_string(), "text".to_string()]
    } else {
        vec!["text".to_string(), "raster_exact".to_string()]
    }
}

fn verification_target_candidates(
    profile: &serde_json::Value,
    target: &printers::ResolvedPrinterTarget,
) -> Vec<printers::ResolvedPrinterTarget> {
    match target {
        printers::ResolvedPrinterTarget::SerialPort {
            port_name,
            baud_rate,
        } => {
            let connection = profile_connection_details(profile);
            let explicit_baud = value_str(&connection, &["baudRate"])
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(*baud_rate);
            let preferred = [explicit_baud, 115200, 9600, 19200, 38400];
            let mut out = Vec::new();
            for baud in preferred {
                let candidate = printers::ResolvedPrinterTarget::SerialPort {
                    port_name: port_name.clone(),
                    baud_rate: baud,
                };
                if !out.contains(&candidate) {
                    out.push(candidate);
                }
            }
            out
        }
        other => vec![other.clone()],
    }
}

fn verification_candidates_for_profile(
    profile: &serde_json::Value,
    target: &printers::ResolvedPrinterTarget,
    sample_kind: &str,
) -> Vec<VerificationCandidate> {
    let target_candidates = verification_target_candidates(profile, target);
    let emulations = verification_emulation_candidates(profile);
    let render_modes = verification_render_mode_candidates(profile, sample_kind);

    let mut out = Vec::new();
    for target_candidate in target_candidates {
        for emulation in &emulations {
            for render_mode in &render_modes {
                out.push(VerificationCandidate {
                    target: target_candidate.clone(),
                    emulation: emulation.clone(),
                    render_mode: render_mode.clone(),
                    supports_logo: sample_kind == "branding",
                });
            }
        }
    }
    out
}

fn build_sample_bytes(
    sample_kind: &str,
    printer_label: &str,
    layout: &receipt_renderer::LayoutConfig,
) -> Result<(Vec<u8>, bool, &'static str), String> {
    match sample_kind {
        "encoding" => Ok((build_encoding_sample(layout), false, "POS Encoding Test")),
        "branding" => {
            let (bytes, supports_logo) = build_branding_sample(printer_label, layout)?;
            Ok((bytes, supports_logo, "POS Branding Test"))
        }
        _ => Ok((
            build_transport_text_sample(printer_label, layout),
            false,
            "POS Draft Test",
        )),
    }
}

#[derive(Default)]
struct ConfiguredPrinterLookup {
    names: HashSet<String>,
    addresses: HashSet<String>,
}

fn normalize_lookup_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_lowercase())
}

fn format_mac_address(hex12: &str) -> String {
    let upper = hex12.to_uppercase();
    let parts: Vec<String> = upper
        .chars()
        .collect::<Vec<char>>()
        .chunks(2)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect();
    parts.join(":")
}

fn extract_mac_from_instance_id(instance_id: &str) -> Option<String> {
    let upper = instance_id.to_uppercase();
    if let Some(start) = upper.find("DEV_") {
        let candidate = upper.get(start + 4..start + 16)?;
        if candidate.len() == 12 && candidate.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(format_mac_address(candidate));
        }
    }

    if upper.contains("BTH") {
        for token in upper.split(|c: char| !c.is_ascii_hexdigit()) {
            if token.len() == 12 && token.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(format_mac_address(token));
            }
        }
    }

    None
}

fn stable_bt_fallback_address(instance_id: &str, name: &str) -> String {
    let seed = if !instance_id.trim().is_empty() {
        instance_id
    } else if !name.trim().is_empty() {
        name
    } else {
        "unknown"
    };
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    format!("bt-instance-{:016x}", hasher.finish())
}

fn normalize_address_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(mac) = extract_mac_from_instance_id(trimmed) {
        return Some(mac.to_lowercase());
    }
    Some(trimmed.to_lowercase())
}

fn is_internal_bluetooth_name(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    if lower.is_empty() {
        return true;
    }
    [
        "adapter",
        "enumerator",
        "protocol",
        "transport",
        "radio",
        "personal area network",
        "wireless bluetooth",
        "host controller",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn is_internal_bluetooth_instance(instance_id: &str) -> bool {
    let upper = instance_id.trim().to_uppercase();
    if upper.is_empty() {
        return false;
    }

    [
        "BTH\\MS_BTHBRB",
        "BTH\\MS_BTHLE",
        "BTH\\MS_RFCOMM",
        "BTH\\MS_BTHPAN",
        "SWD\\RADIO\\",
    ]
    .iter()
    .any(|needle| upper.starts_with(needle))
}

fn is_printer_like_bluetooth_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    [
        "printer", "thermal", "receipt", "pos", "epson", "star", "bixolon", "citizen", "zebra",
        "brother", "tm-", "tsp", "srp-", "ct-",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn dedupe_discovered_printers(printers: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut deduped: Vec<serde_json::Value> = Vec::new();

    for entry in printers {
        let printer_type = value_str(&entry, &["type"])
            .unwrap_or_else(|| "unknown".to_string())
            .to_lowercase();
        let address = value_str(&entry, &["address"]).unwrap_or_default();
        let normalized_address = normalize_address_token(&address).unwrap_or_default();
        let name = value_str(&entry, &["name"])
            .unwrap_or_default()
            .to_lowercase();

        let key = if !normalized_address.is_empty() {
            format!("{printer_type}:{normalized_address}")
        } else {
            format!("{printer_type}:name:{name}")
        };

        if seen.insert(key) {
            deduped.push(entry);
        }
    }

    deduped
}

fn configured_printer_lookup(db: &db::DbState) -> ConfiguredPrinterLookup {
    let mut lookup = ConfiguredPrinterLookup::default();

    if let Ok(profiles) = printers::list_printer_profiles(db) {
        if let Some(arr) = profiles.as_array() {
            for profile in arr {
                if let Some(name) = value_str(profile, &["printerName", "printer_name", "name"]) {
                    if let Some(token) = normalize_lookup_token(&name) {
                        lookup.names.insert(token);
                    }
                    if let Some(address_token) = normalize_address_token(&name) {
                        lookup.addresses.insert(address_token);
                    }
                }
                if let Some(address) = value_str(
                    profile,
                    &["address", "ip", "host", "drawerHost", "drawer_host"],
                ) {
                    if let Some(address_token) = normalize_address_token(&address) {
                        lookup.addresses.insert(address_token);
                    }
                }
                if let Some(connection_json) =
                    value_str(profile, &["connectionJson", "connection_json"])
                {
                    if let Ok(connection) =
                        serde_json::from_str::<serde_json::Value>(&connection_json)
                    {
                        for key in [
                            "systemName",
                            "deviceName",
                            "hostname",
                            "host",
                            "ip",
                            "address",
                            "path",
                            "serialPort",
                            "portName",
                            "comPort",
                        ] {
                            if let Some(value) = value_str(&connection, &[key]) {
                                if let Some(token) = normalize_lookup_token(&value) {
                                    lookup.names.insert(token);
                                }
                                if let Some(address_token) = normalize_address_token(&value) {
                                    lookup.addresses.insert(address_token);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    lookup
}

fn resolved_transport_name(target: &printers::ResolvedPrinterTarget) -> &'static str {
    target.transport_name()
}

fn resolve_profile_connection_state(
    profile: &serde_json::Value,
) -> (Option<printers::ResolvedPrinterTarget>, bool, &'static str) {
    match printers::resolve_printer_target(profile) {
        Ok(target) => {
            let connected = printers::probe_printer_target(&target).is_ok();
            let verification_status = printers::capability_verification_status(profile);
            let state = if connected {
                match verification_status {
                    "verified" => "online",
                    "degraded" => "degraded",
                    _ => "unverified",
                }
            } else {
                "offline"
            };
            (Some(target), connected, state)
        }
        Err(error) => {
            warn!(error = %error, "Unable to resolve printer connection target");
            (None, false, "unresolved")
        }
    }
}

fn is_configured_discovery_entry(
    configured: &ConfiguredPrinterLookup,
    name: &str,
    address: &str,
) -> bool {
    let name_token = normalize_lookup_token(name).unwrap_or_default();
    let address_token = normalize_address_token(address).unwrap_or_default();
    (!name_token.is_empty() && configured.names.contains(&name_token))
        || (!address_token.is_empty() && configured.addresses.contains(&address_token))
}

fn discover_serial_printers_native(
    configured: &ConfiguredPrinterLookup,
    include_usb: bool,
    include_bluetooth: bool,
) -> Vec<serde_json::Value> {
    let mut discovered = Vec::new();

    for port in serialport::available_ports().unwrap_or_default() {
        match &port.port_type {
            serialport::SerialPortType::UsbPort(usb) if include_usb => {
                let port_name = port.port_name.clone();
                let manufacturer = usb.manufacturer.clone();
                let model = usb.product.clone();
                let name = model
                    .clone()
                    .or_else(|| {
                        manufacturer
                            .clone()
                            .map(|value| format!("{value} Serial Printer"))
                    })
                    .unwrap_or_else(|| format!("USB Serial Printer ({port_name})"));
                let is_configured = is_configured_discovery_entry(configured, &name, &port_name);
                discovered.push(serde_json::json!({
                    "name": name,
                    "type": "usb",
                    "address": port_name,
                    "path": port.port_name,
                    "serialPort": port.port_name,
                    "portName": port.port_name,
                    "port": serde_json::Value::Null,
                    "model": model,
                    "manufacturer": manufacturer,
                    "vendorId": usb.vid,
                    "productId": usb.pid,
                    "isConfigured": is_configured,
                    "source": "serial-enum"
                }));
            }
            serialport::SerialPortType::BluetoothPort if include_bluetooth => {
                let port_name = port.port_name.clone();
                let name = format!("Bluetooth Serial Printer ({port_name})");
                let is_configured = is_configured_discovery_entry(configured, &name, &port_name);
                discovered.push(serde_json::json!({
                    "name": name,
                    "type": "bluetooth",
                    "address": port_name,
                    "path": port.port_name,
                    "serialPort": port.port_name,
                    "portName": port.port_name,
                    "port": serde_json::Value::Null,
                    "model": serde_json::Value::Null,
                    "manufacturer": "bluetooth-serial",
                    "isConfigured": is_configured,
                    "source": "serial-enum"
                }));
            }
            _ => {}
        }
    }

    dedupe_discovered_printers(discovered)
}

fn parse_powershell_device_rows(parsed: serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(arr) = parsed.as_array() {
        arr.clone()
    } else if parsed.is_object() {
        vec![parsed]
    } else {
        vec![]
    }
}

#[cfg(target_os = "windows")]
fn detect_primary_ipv4() -> Option<std::net::Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("1.1.1.1:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if ip.is_private() && !ip.is_loopback() && !ip.is_link_local() => {
            Some(ip)
        }
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn parse_lan_ipv4_values(parsed: &serde_json::Value) -> Vec<std::net::Ipv4Addr> {
    let values: Vec<String> = match parsed {
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|value| value_to_string(value.clone()))
            .collect(),
        serde_json::Value::String(value) => vec![value.clone()],
        serde_json::Value::Object(obj) => {
            let mut out = Vec::new();
            if let Some(value) = obj.get("IPAddress").and_then(serde_json::Value::as_str) {
                out.push(value.to_string());
            }
            out
        }
        _ => vec![],
    };

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        let parsed_ip = match value.trim().parse::<std::net::Ipv4Addr>() {
            Ok(ip) if ip.is_private() && !ip.is_loopback() && !ip.is_link_local() => ip,
            _ => continue,
        };
        if seen.insert(parsed_ip) {
            out.push(parsed_ip);
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn detect_local_ipv4s() -> Vec<std::net::Ipv4Addr> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    if let Some(primary) = detect_primary_ipv4() {
        seen.insert(primary);
        out.push(primary);
    }

    let script = r#"
$ErrorActionPreference = 'Stop'
$rows = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
  $_.IPAddress -and
  $_.IPAddress -notlike '127.*' -and
  $_.IPAddress -notlike '169.254.*' -and
  $_.SkipAsSource -ne $true
} | Sort-Object -Property InterfaceMetric | Select-Object -ExpandProperty IPAddress
$rows | ConvertTo-Json -Compress
"#;

    let output = match run_hidden_powershell(script) {
        Ok(output) => output,
        Err(error) => {
            warn!(error = %error, "LAN printer discovery failed to enumerate local IPv4 addresses");
            return out;
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        warn!(
            stderr = %stderr,
            "LAN printer discovery PowerShell IPv4 enumeration returned a non-success status"
        );
        return out;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() || stdout == "null" {
        return out;
    }

    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(parsed) => {
            for ip in parse_lan_ipv4_values(&parsed) {
                if seen.insert(ip) {
                    out.push(ip);
                }
            }
        }
        Err(error) => {
            warn!(
                error = %error,
                output = %stdout,
                "LAN printer discovery PowerShell IPv4 enumeration returned invalid JSON"
            );
        }
    }

    out
}

#[cfg(target_os = "windows")]
fn lan_subnet_hosts(primary_ip: std::net::Ipv4Addr) -> Vec<std::net::Ipv4Addr> {
    let [a, b, c, host] = primary_ip.octets();
    (1u8..=254u8)
        .filter(|candidate| *candidate != host)
        .map(|candidate| std::net::Ipv4Addr::new(a, b, c, candidate))
        .collect()
}

#[cfg(target_os = "windows")]
async fn probe_lan_printer_host(ip: std::net::Ipv4Addr) -> Option<u16> {
    const PRINTER_PORTS: [u16; 3] = [9100, 515, 631];
    for port in PRINTER_PORTS {
        let addr = std::net::SocketAddr::from((std::net::IpAddr::V4(ip), port));
        if tokio::time::timeout(
            std::time::Duration::from_millis(180),
            tokio::net::TcpStream::connect(addr),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .is_some()
        {
            return Some(port);
        }
    }
    None
}

#[cfg(target_os = "windows")]
async fn discover_lan_printers_native(
    configured: &ConfiguredPrinterLookup,
) -> Vec<serde_json::Value> {
    let local_ips = detect_local_ipv4s();
    if local_ips.is_empty() {
        warn!("LAN printer discovery skipped: unable to detect any local private IPv4 address");
        return vec![];
    }

    let mut hosts = Vec::new();
    let mut seen_hosts = HashSet::new();
    for local_ip in &local_ips {
        for host in lan_subnet_hosts(*local_ip) {
            if seen_hosts.insert(host) {
                hosts.push(host);
            }
        }
    }

    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(48));
    let mut set = tokio::task::JoinSet::new();

    for ip in hosts {
        let semaphore = semaphore.clone();
        set.spawn(async move {
            let _permit = semaphore.acquire_owned().await.ok()?;
            let port = probe_lan_printer_host(ip).await?;
            Some((ip, port))
        });
    }

    let mut discovered = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Some((ip, port))) = joined {
            let address = ip.to_string();
            let name = format!("LAN Printer ({address})");
            let is_configured = is_configured_discovery_entry(configured, &name, &address);
            discovered.push(serde_json::json!({
                "name": name,
                "type": "network",
                "address": address,
                "port": port,
                "model": serde_json::Value::Null,
                "manufacturer": serde_json::Value::Null,
                "isConfigured": is_configured,
                "source": "lan-port-scan"
            }));
        }
    }

    let deduped = dedupe_discovered_printers(discovered);
    info!(
        local_ips = ?local_ips,
        discovered = deduped.len(),
        "LAN printer discovery completed"
    );
    deduped
}

#[cfg(not(target_os = "windows"))]
async fn discover_lan_printers_native(
    _configured: &ConfiguredPrinterLookup,
) -> Vec<serde_json::Value> {
    vec![]
}

#[cfg(target_os = "windows")]
fn run_hidden_powershell(script: &str) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to execute PowerShell command: {e}"))
}

#[cfg(target_os = "windows")]
fn run_hidden_powershell_json_rows(script: &str, context: &str) -> Vec<serde_json::Value> {
    let output = match run_hidden_powershell(script) {
        Ok(output) => output,
        Err(error) => {
            warn!(error = %error, context = %context, "PowerShell discovery command failed to start");
            return vec![];
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        warn!(
            stderr = %stderr,
            context = %context,
            "PowerShell discovery command returned a non-success status"
        );
        return vec![];
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() || stdout == "null" {
        return vec![];
    }

    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(parsed) => parse_powershell_device_rows(parsed),
        Err(error) => {
            warn!(
                error = %error,
                output = %stdout,
                context = %context,
                "PowerShell discovery output was not valid JSON"
            );
            vec![]
        }
    }
}

fn resolve_bluetooth_address(device: &serde_json::Value, instance_id: &str, name: &str) -> String {
    let explicit = value_str(
        device,
        &[
            "Address",
            "address",
            "MacAddress",
            "macAddress",
            "BluetoothAddress",
            "bluetoothAddress",
        ],
    );
    if let Some(raw) = explicit {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            if let Some(mac) = extract_mac_from_instance_id(trimmed) {
                return mac;
            }
            if trimmed.len() == 12 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
                return format_mac_address(trimmed);
            }
            return trimmed.to_string();
        }
    }

    extract_mac_from_instance_id(instance_id)
        .unwrap_or_else(|| stable_bt_fallback_address(instance_id, name))
}

#[cfg(target_os = "windows")]
fn discover_bluetooth_pnp_rows() -> Vec<serde_json::Value> {
    // Use a broad paired-device query so classic Bluetooth printers remain visible even when
    // Windows does not currently mark them as "present".
    let script = r#"
$ErrorActionPreference = 'Stop'
$devices = Get-PnpDevice | Where-Object {
  (
    ($_.Class -like '*Bluetooth*') -or
    ($_.InstanceId -like 'BTH*') -or
    ($_.InstanceId -like 'SWD\RADIO\*')
  ) -and
  ($_.FriendlyName -notlike '*Adapter*') -and
  ($_.FriendlyName -notlike '*Enumerator*') -and
  ($_.FriendlyName -notlike '*Protocol*') -and
  ($_.FriendlyName -notlike '*Transport*')
}
$devices |
  Select-Object `
    @{Name='FriendlyName';Expression={ if ($_.FriendlyName) { $_.FriendlyName } elseif ($_.Name) { $_.Name } else { 'Bluetooth Device' } }}, `
    InstanceId, Class, Status, @{Name='Source';Expression={'windows-pnp'}} |
  ConvertTo-Json -Depth 6 -Compress
"#;

    run_hidden_powershell_json_rows(script, "bluetooth-pnp")
}

#[cfg(target_os = "windows")]
fn discover_bluetooth_ble_rows() -> Vec<serde_json::Value> {
    // Passive BLE advertisement scan without opening a browser pairing chooser.
    let script = r#"
$ErrorActionPreference = 'Stop'
$watcher = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher, Windows, ContentType=WindowsRuntime]::new()
$watcher.ScanningMode = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEScanningMode, Windows, ContentType=WindowsRuntime]::Active
$devices = [hashtable]::Synchronized(@{})
$handler = [Windows.Foundation.TypedEventHandler[Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher, Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementReceivedEventArgs]] {
  param($sender, $args)
  $hex = ('{0:X12}' -f $args.BluetoothAddress)
  if ([string]::IsNullOrWhiteSpace($hex)) { return }
  $address = ($hex -replace '(..)(?=.)', '$1:')
  $name = $args.Advertisement.LocalName
  if ([string]::IsNullOrWhiteSpace($name)) {
    $name = \"Unknown or unsupported device ($address)\"
  }

  if (-not $devices.ContainsKey($address)) {
    $devices[$address] = [pscustomobject]@{
      FriendlyName = $name
      InstanceId = \"BLE::$address\"
      Address = $address
      Class = 'BluetoothLE'
      Status = 'Discovered'
      Source = 'windows-ble'
    }
  } elseif ($devices[$address].FriendlyName -like 'Unknown or unsupported device*' -and -not [string]::IsNullOrWhiteSpace($args.Advertisement.LocalName)) {
    $devices[$address].FriendlyName = $args.Advertisement.LocalName
  }
}

$token = $watcher.add_Received($handler)
try {
  $watcher.Start()
  Start-Sleep -Milliseconds 4500
} finally {
  try { $watcher.Stop() } catch {}
  $watcher.remove_Received($token)
}

$devices.Values | ConvertTo-Json -Depth 6 -Compress
"#;

    run_hidden_powershell_json_rows(script, "bluetooth-ble")
}

fn collect_printer_status_map(
    db: &db::DbState,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let profiles = printers::list_printer_profiles(db)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut status_map = serde_json::Map::new();
    if let Some(arr) = profiles.as_array() {
        for profile in arr {
            let printer_id = value_str(profile, &["id"]).unwrap_or_default();
            let (target, connected, state) = resolve_profile_connection_state(profile);
            let capabilities = printers::read_capability_snapshot(profile);

            let queue_len: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM print_jobs WHERE status IN ('pending', 'printing') AND printer_profile_id = ?1",
                    rusqlite::params![printer_id],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            status_map.insert(
                printer_id.clone(),
                serde_json::json!({
                    "printerId": printer_id,
                    "state": state,
                    "connected": connected,
                    "transportReachable": connected,
                    "verificationStatus": printers::capability_verification_status(profile),
                    "resolvedTransport": target.as_ref().map(resolved_transport_name),
                    "resolvedAddress": target.as_ref().map(|value| value.label()),
                    "supportsLogo": capabilities.supports_logo,
                    "supportsCut": capabilities.supports_cut,
                    "lastVerifiedAt": capabilities.last_verified_at,
                    "queueLength": queue_len,
                    "lastSeen": chrono::Utc::now().to_rfc3339()
                }),
            );
        }
    }

    Ok(status_map)
}

fn hash_status_map(status_map: &serde_json::Map<String, serde_json::Value>) -> u64 {
    let mut hasher = DefaultHasher::new();
    // JSON object key order is deterministic for Map insertion sequence,
    // but we hash a canonicalized string payload to avoid accidental drift.
    let serialized = serde_json::to_string(status_map).unwrap_or_default();
    serialized.hash(&mut hasher);
    hasher.finish()
}

pub fn start_printer_status_monitor(
    app: tauri::AppHandle,
    db: Arc<db::DbState>,
    interval_secs: u64,
    cancel: tokio_util::sync::CancellationToken,
) {
    let cadence = std::time::Duration::from_secs(interval_secs.max(5));
    tauri::async_runtime::spawn(async move {
        let mut last_hash: Option<u64> = None;
        loop {
            match collect_printer_status_map(db.as_ref()) {
                Ok(statuses) => {
                    let current_hash = hash_status_map(&statuses);
                    if last_hash != Some(current_hash) {
                        last_hash = Some(current_hash);
                        let _ = app.emit(
                            "printer_status_changed",
                            serde_json::json!({
                                "status": "snapshot",
                                "statuses": statuses,
                                "updatedAt": chrono::Utc::now().to_rfc3339()
                            }),
                        );
                    }
                }
                Err(error) => {
                    warn!(error = %error, "Printer status monitor iteration failed");
                }
            }

            tokio::select! {
                _ = tokio::time::sleep(cadence) => {}
                _ = cancel.cancelled() => {
                    tracing::info!("Printer status monitor cancelled");
                    break;
                }
            }
        }
    });

    info!(
        interval_secs = interval_secs.max(5),
        "Printer status monitor started"
    );
}

#[cfg(target_os = "windows")]
fn discover_bluetooth_printers_native(
    configured: &ConfiguredPrinterLookup,
) -> Result<Vec<serde_json::Value>, String> {
    let mut candidates = discover_bluetooth_pnp_rows();
    let ble = discover_bluetooth_ble_rows();

    if !ble.is_empty() {
        candidates.extend(ble);
    }

    if candidates.is_empty() {
        info!("Bluetooth discovery returned no candidate devices");
        return Ok(vec![]);
    }

    let mut printer_like: Vec<serde_json::Value> = Vec::new();
    let mut others: Vec<serde_json::Value> = Vec::new();

    for device in candidates {
        let instance_id = value_str(&device, &["InstanceId", "instanceId"]).unwrap_or_default();
        if is_internal_bluetooth_instance(&instance_id) {
            continue;
        }

        let name = value_str(&device, &["FriendlyName", "friendlyName", "name"])
            .unwrap_or_else(|| "Bluetooth Device".to_string());
        if is_internal_bluetooth_name(&name) {
            continue;
        }

        let address = resolve_bluetooth_address(&device, &instance_id, &name);
        let is_configured = is_configured_discovery_entry(configured, &name, &address);
        let source =
            value_str(&device, &["Source", "source"]).unwrap_or_else(|| "windows-pnp".to_string());

        let row = serde_json::json!({
            "name": name,
            "type": "bluetooth",
            "address": address,
            "port": 1,
            "model": serde_json::Value::Null,
            "manufacturer": serde_json::Value::Null,
            "isConfigured": is_configured,
            "source": source
        });

        if is_printer_like_bluetooth_name(
            row.get("name").and_then(|v| v.as_str()).unwrap_or_default(),
        ) {
            printer_like.push(row);
        } else {
            others.push(row);
        }
    }

    printer_like.extend(others);
    let deduped = dedupe_discovered_printers(printer_like);
    info!(
        discovered = deduped.len(),
        "Bluetooth discovery completed from native Windows paired-device scan"
    );
    Ok(deduped)
}

#[cfg(not(target_os = "windows"))]
fn discover_bluetooth_printers_native(
    _configured: &ConfiguredPrinterLookup,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![])
}

#[cfg(test)]
mod bluetooth_discovery_tests {
    use super::*;

    #[test]
    fn extract_mac_from_dev_token() {
        let mac = extract_mac_from_instance_id("BTHENUM\\DEV_AABBCCDDEEFF\\8&1234");
        assert_eq!(mac, Some("AA:BB:CC:DD:EE:FF".to_string()));
    }

    #[test]
    fn extract_mac_from_bth_hex_token() {
        let mac = extract_mac_from_instance_id("BTHLEDEVICE\\{GUID}\\A1B2C3D4E5F6");
        assert_eq!(mac, Some("A1:B2:C3:D4:E5:F6".to_string()));
    }

    #[test]
    fn fallback_bt_address_is_stable() {
        let a = stable_bt_fallback_address("INSTANCE-1", "Printer");
        let b = stable_bt_fallback_address("INSTANCE-1", "Printer");
        assert_eq!(a, b);
        assert!(a.starts_with("bt-instance-"));
    }

    #[test]
    fn parse_rows_accepts_single_object() {
        let parsed = serde_json::json!({
            "FriendlyName": "Printer One",
            "InstanceId": "BTHENUM\\DEV_AABBCCDDEEFF\\x"
        });
        let rows = parse_powershell_device_rows(parsed);
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn parse_rows_accepts_array() {
        let parsed = serde_json::json!([
            { "FriendlyName": "One", "InstanceId": "A" },
            { "FriendlyName": "Two", "InstanceId": "B" }
        ]);
        let rows = parse_powershell_device_rows(parsed);
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn resolve_address_prefers_explicit_mac() {
        let row = serde_json::json!({
            "Address": "AABBCCDDEEFF",
            "InstanceId": "BTHENUM\\DEV_112233445566\\x"
        });
        let resolved = resolve_bluetooth_address(&row, "BTHENUM\\DEV_112233445566\\x", "Printer");
        assert_eq!(resolved, "AA:BB:CC:DD:EE:FF");
    }

    #[test]
    fn resolve_address_falls_back_to_instance_id() {
        let row = serde_json::json!({
            "FriendlyName": "Printer"
        });
        let resolved = resolve_bluetooth_address(&row, "BTHENUM\\DEV_112233445566\\x", "Printer");
        assert_eq!(resolved, "11:22:33:44:55:66");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn lan_subnet_hosts_excludes_primary_host() {
        let hosts = lan_subnet_hosts(std::net::Ipv4Addr::new(192, 168, 1, 42));
        assert_eq!(hosts.len(), 253);
        assert!(!hosts.contains(&std::net::Ipv4Addr::new(192, 168, 1, 42)));
        assert!(hosts.contains(&std::net::Ipv4Addr::new(192, 168, 1, 1)));
        assert!(hosts.contains(&std::net::Ipv4Addr::new(192, 168, 1, 254)));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_lan_ipv4_values_filters_non_private_addresses() {
        let parsed = serde_json::json!([
            "192.168.1.19",
            "10.0.0.7",
            "127.0.0.1",
            "169.254.1.20",
            "8.8.8.8"
        ]);

        let values = parse_lan_ipv4_values(&parsed);

        assert_eq!(
            values,
            vec![
                std::net::Ipv4Addr::new(192, 168, 1, 19),
                std::net::Ipv4Addr::new(10, 0, 0, 7)
            ]
        );
    }
}

#[tauri::command]
pub async fn printer_scan_network(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let configured = configured_printer_lookup(&db);
    let printers = printers::list_system_printers();
    let mut discovered: Vec<serde_json::Value> = printers
        .into_iter()
        .map(|name| {
            let address = name.clone();
            serde_json::json!({
                "name": name,
                "type": "system",
                "address": address,
                "model": serde_json::Value::Null,
                "manufacturer": "system",
                "isConfigured": is_configured_discovery_entry(&configured, &name, &address)
            })
        })
        .collect();
    discovered.extend(discover_serial_printers_native(&configured, true, false));
    discovered.extend(discover_lan_printers_native(&configured).await);
    let deduped = dedupe_discovered_printers(discovered);
    Ok(serde_json::json!({
        "success": true,
        "printers": deduped,
        "type": "network"
    }))
}

#[tauri::command]
pub async fn printer_scan_bluetooth(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let configured = configured_printer_lookup(&db);
    let mut printers = discover_bluetooth_printers_native(&configured)?;
    printers.extend(discover_serial_printers_native(&configured, false, true));
    let printers = dedupe_discovered_printers(printers);
    let message = if cfg!(target_os = "windows") {
        if printers.is_empty() {
            "No paired Bluetooth devices found".to_string()
        } else {
            format!("Discovered {} Bluetooth device(s)", printers.len())
        }
    } else {
        "Bluetooth native scan is currently supported on Windows only".to_string()
    };
    Ok(serde_json::json!({
        "success": true,
        "printers": printers,
        "type": "bluetooth",
        "message": message
    }))
}

#[tauri::command]
pub async fn printer_discover(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let requested = parse_printer_discover_types(arg0);
    info!(
        requested_types = ?requested,
        "printer_discover requested"
    );
    let wants_system_like = should_discover_system_like(&requested);
    let wants_bluetooth = should_discover_bluetooth(&requested);

    let configured = configured_printer_lookup(&db);
    let mut out: Vec<serde_json::Value> = Vec::new();

    if wants_system_like {
        for printer_name in printers::list_system_printers() {
            let address = printer_name.clone();
            out.push(serde_json::json!({
                "name": printer_name,
                "type": "system",
                "address": address,
                "port": serde_json::Value::Null,
                "model": serde_json::Value::Null,
                "manufacturer": "system",
                "isConfigured": is_configured_discovery_entry(&configured, &printer_name, &address)
            }));
        }
        out.extend(discover_serial_printers_native(&configured, true, false));
        out.extend(discover_lan_printers_native(&configured).await);
    }

    if wants_bluetooth {
        let mut bluetooth = discover_bluetooth_printers_native(&configured)?;
        bluetooth.extend(discover_serial_printers_native(&configured, false, true));
        let bluetooth = dedupe_discovered_printers(bluetooth);
        info!(
            bluetooth_candidates = bluetooth.len(),
            "printer_discover native bluetooth scan result"
        );
        out.extend(bluetooth);
    }

    let deduped = dedupe_discovered_printers(out);
    info!(result_count = deduped.len(), "printer_discover completed");

    Ok(serde_json::json!({ "success": true, "printers": deduped }))
}

#[tauri::command]
pub async fn printer_add(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = electron_to_profile_input(None, arg0.unwrap_or(serde_json::json!({})));
    let created = printers::create_printer_profile(&db, &payload)?;
    let profile_id = value_str(&created, &["profileId"]).unwrap_or_default();
    let profile = if profile_id.is_empty() {
        serde_json::Value::Null
    } else {
        let raw =
            printers::get_printer_profile(&db, &profile_id).unwrap_or(serde_json::Value::Null);
        profile_to_electron_format(&raw)
    };
    let _ = app.emit(
        "printer_status_changed",
        serde_json::json!({
            "printerId": profile_id,
            "status": "configured"
        }),
    );
    Ok(serde_json::json!({ "success": true, "printer": profile }))
}

#[tauri::command]
pub async fn printer_update(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_printer_update_payload(arg0, arg1)?;
    let printer_id = parsed.printer_id;
    let payload = electron_to_profile_input(Some(printer_id.clone()), parsed.updates);
    let _ = printers::update_printer_profile(&db, &payload)?;
    let raw = printers::get_printer_profile(&db, &printer_id)?;
    let profile = profile_to_electron_format(&raw);
    let _ = app.emit(
        "printer_status_changed",
        serde_json::json!({
            "printerId": printer_id,
            "status": "updated"
        }),
    );
    Ok(serde_json::json!({ "success": true, "printer": profile }))
}

#[tauri::command]
pub async fn printer_remove(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let result = printers::delete_printer_profile(&db, &printer_id)?;
    let _ = app.emit(
        "printer_status_changed",
        serde_json::json!({
            "printerId": printer_id,
            "status": "removed"
        }),
    );
    Ok(result)
}

#[tauri::command]
pub async fn printer_get_all(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let profiles = printers::list_printer_profiles(&db)?;
    let electron_profiles: Vec<serde_json::Value> = profiles
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(profile_to_electron_format)
        .collect();
    Ok(serde_json::json!({ "success": true, "printers": electron_profiles }))
}

#[tauri::command]
pub async fn printer_get(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let raw = printers::get_printer_profile(&db, &printer_id)?;
    let profile = profile_to_electron_format(&raw);
    Ok(serde_json::json!({ "success": true, "printer": profile }))
}

#[tauri::command]
pub async fn printer_get_status(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let profile = printers::get_printer_profile(&db, &printer_id)?;
    let printer_name = value_str(&profile, &["printerName", "printer_name"]).unwrap_or_default();
    let (target, connected, state) = resolve_profile_connection_state(&profile);
    let capabilities = printers::read_capability_snapshot(&profile);

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let queue_len: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE status IN ('pending', 'printing') AND printer_profile_id = ?1",
            rusqlite::params![printer_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    Ok(serde_json::json!({
        "success": true,
        "printerId": printer_id,
        "state": state,
        "connected": connected,
        "transportReachable": connected,
        "verificationStatus": printers::capability_verification_status(&profile),
        "resolvedTransport": target.as_ref().map(resolved_transport_name),
        "resolvedAddress": target.as_ref().map(|value| value.label()),
        "supportsLogo": capabilities.supports_logo,
        "supportsCut": capabilities.supports_cut,
        "lastVerifiedAt": capabilities.last_verified_at,
        "queueLength": queue_len,
        "printerName": printer_name,
        "lastSeen": chrono::Utc::now().to_rfc3339()
    }))
}

#[tauri::command]
pub async fn printer_get_all_statuses(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let status_map = collect_printer_status_map(&db)?;
    Ok(serde_json::json!({ "success": true, "statuses": status_map }))
}

#[tauri::command]
pub async fn printer_submit_job(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let entity_type = value_str(&payload, &["entityType", "entity_type"])
        .unwrap_or_else(|| "order_receipt".to_string());
    let entity_id = value_str(&payload, &["entityId", "entity_id", "orderId", "order_id"])
        .unwrap_or_else(|| format!("entity-{}", uuid::Uuid::new_v4()));
    let printer_profile_id = value_str(&payload, &["printerProfileId", "printer_profile_id"]);

    let allowed = matches!(
        entity_type.as_str(),
        "order_receipt" | "kitchen_ticket" | "z_report" | "shift_checkout"
    );
    if allowed {
        return print::enqueue_print_job(
            &db,
            &entity_type,
            &entity_id,
            printer_profile_id.as_deref(),
        );
    }

    let mut jobs = read_local_json_array(&db, "virtual_print_jobs_v1")?;
    let job_id = format!("vjob-{}", uuid::Uuid::new_v4());
    jobs.push(serde_json::json!({
        "id": job_id,
        "payload": payload,
        "status": "queued",
        "createdAt": Utc::now().to_rfc3339()
    }));
    write_local_json(
        &db,
        "virtual_print_jobs_v1",
        &serde_json::Value::Array(jobs),
    )?;
    Ok(serde_json::json!({ "success": true, "jobId": job_id }))
}

#[tauri::command]
pub async fn printer_cancel_job(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let job_id = parse_job_id_payload(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let affected = conn
        .execute(
            "UPDATE print_jobs SET status = 'cancelled', updated_at = datetime('now')
             WHERE id = ?1 AND status IN ('pending', 'printing')",
            rusqlite::params![job_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": affected > 0, "affected": affected }))
}

#[tauri::command]
pub async fn printer_retry_job(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let job_id = parse_job_id_payload(arg0)?;
    printers::reprint_job(&db, &job_id)
}

fn ensure_target_ready(
    target: &printers::ResolvedPrinterTarget,
) -> Result<Option<Vec<String>>, String> {
    if let printers::ResolvedPrinterTarget::WindowsQueue {
        printer_name: windows_printer_name,
    } = target
    {
        let known_printers = printers::list_system_printers();
        let printer_known = known_printers
            .iter()
            .any(|name| name == windows_printer_name);
        if !printer_known {
            return Err(format!(
                "Printer \"{}\" is not installed in Windows Printers",
                windows_printer_name
            ));
        }
        return Ok(Some(known_printers));
    }

    Ok(None)
}

fn build_transport_text_sample(
    printer_label: &str,
    layout: &receipt_renderer::LayoutConfig,
) -> Vec<u8> {
    let use_star_line_mode =
        receipt_renderer::uses_star_commands(layout.detected_brand, layout.emulation_mode);
    let now_str = chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S UTC")
        .to_string();

    let mut builder = if use_star_line_mode {
        escpos::EscPosBuilder::new()
            .with_paper(layout.paper_width)
            .with_star_line_mode()
    } else {
        escpos::EscPosBuilder::new().with_paper(layout.paper_width)
    };
    builder.init();
    let _warnings = receipt_renderer::apply_character_set_for_test(
        &mut builder,
        &layout.character_set,
        layout.greek_render_mode.as_deref(),
        layout.escpos_code_page,
        layout.detected_brand,
        layout.emulation_mode,
    );
    builder
        .center()
        .bold(true)
        .text("THERMAL PRINTER TEST\n")
        .bold(false)
        .separator()
        .left()
        .text(&format!("Printer: {}\n", printer_label))
        .text(&format!("Date: {}\n", now_str))
        .text(&format!(
            "Transport: {}\n",
            emulation_mode_key(layout.emulation_mode)
        ))
        .text(&format!(
            "Render: {}\n",
            render_mode_key(layout.classic_customer_render_mode)
        ))
        .separator()
        .text("ABCDEFGHIJKLMNOPQRSTUVWXYZ\n")
        .text("abcdefghijklmnopqrstuvwxyz\n")
        .text("0123456789 !@#$%^&*()\n")
        .separator()
        .center()
        .text("-- End of Test --\n");
    if use_star_line_mode {
        builder.feed(3).star_cut();
    } else {
        builder.feed(4).cut();
    }
    builder.build()
}

fn build_encoding_sample(layout: &receipt_renderer::LayoutConfig) -> Vec<u8> {
    let use_star_line_mode =
        receipt_renderer::uses_star_commands(layout.detected_brand, layout.emulation_mode);
    let mut builder = if use_star_line_mode {
        escpos::EscPosBuilder::new()
            .with_paper(layout.paper_width)
            .with_star_line_mode()
    } else {
        escpos::EscPosBuilder::new().with_paper(layout.paper_width)
    };
    builder.init();
    let _warnings = receipt_renderer::apply_character_set_for_test(
        &mut builder,
        &layout.character_set,
        layout.greek_render_mode.as_deref(),
        layout.escpos_code_page,
        layout.detected_brand,
        layout.emulation_mode,
    );
    builder
        .center()
        .bold(true)
        .text("ENCODING TEST\n")
        .bold(false)
        .separator()
        .left()
        .text("English: Receipt Printer\n")
        .text("\u{0395}\u{03BB}\u{03BB}\u{03B7}\u{03BD}\u{03B9}\u{03BA}\u{03AC}: \u{0394}\u{03BF}\u{03BA}\u{03B9}\u{03BC}\u{03AE} \u{0395}\u{03BA}\u{03C4}\u{03CD}\u{03C0}\u{03C9}\u{03C3}\u{03B7}\u{03C2}\n")
        .text("\u{039A}\u{03B1}\u{03C6}\u{03AD}\u{03C2} 3,50\n")
        .text("\u{03A3}\u{03CD}\u{03BD}\u{03BF}\u{03BB}\u{03BF} 9,50\n")
        .separator()
        .center()
        .text("Encoding OK?\n");
    if use_star_line_mode {
        builder.feed(3).star_cut();
    } else {
        builder.feed(4).cut();
    }
    builder.build()
}

fn build_branding_sample(
    printer_label: &str,
    layout: &receipt_renderer::LayoutConfig,
) -> Result<(Vec<u8>, bool), String> {
    let mut bytes = build_transport_text_sample(printer_label, layout);
    let mut supports_logo = false;
    if let Some(prefix) = crate::print::build_logo_prefix_for_layout(layout)? {
        let mut combined = Vec::with_capacity(prefix.len() + bytes.len() + 1);
        combined.extend_from_slice(&prefix);
        combined.push(0x0A);
        combined.extend_from_slice(&bytes);
        bytes = combined;
        supports_logo = true;
    }
    Ok((bytes, supports_logo))
}

fn run_verification_dispatch(
    db: &db::DbState,
    base_profile: &serde_json::Value,
    base_target: &printers::ResolvedPrinterTarget,
    printer_label: &str,
    sample_kind: &str,
    probe_attempt: usize,
) -> Result<
    (
        VerificationCandidate,
        receipt_renderer::LayoutConfig,
        printers::RawPrintResult,
        bool,
    ),
    String,
> {
    let candidates = verification_candidates_for_profile(base_profile, base_target, sample_kind);
    if candidates.is_empty() {
        return Err("No verification candidates available for this printer".to_string());
    }
    if probe_attempt >= candidates.len() {
        return Err("No additional protocol candidates remain. Open Expert Settings to adjust transport or emulation manually.".to_string());
    }

    let candidate = candidates[probe_attempt].clone();
    let candidate_profile = profile_with_candidate_capabilities(
        base_profile,
        &candidate.target,
        &candidate.emulation,
        &candidate.render_mode,
        candidate.supports_logo,
    );
    let layout = print::resolve_layout_config(db, &candidate_profile, "order_receipt")?;
    let (test_data, supports_logo, doc_name) =
        build_sample_bytes(sample_kind, printer_label, &layout)?;
    let dispatch = printers::print_raw_for_target(&candidate.target, &test_data, doc_name)?;

    Ok((candidate, layout, dispatch, supports_logo))
}

#[tauri::command]
pub async fn printer_test_draft(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or_else(|| serde_json::json!({}));
    let sample_kind = value_str(&payload, &["sampleKind", "sample_kind"])
        .unwrap_or_else(|| "transport_text".to_string())
        .to_ascii_lowercase();
    let probe_attempt = payload
        .get("probeAttempt")
        .or_else(|| payload.get("probe_attempt"))
        .and_then(|value| {
            value.as_u64().or_else(|| {
                value
                    .as_str()
                    .and_then(|raw| raw.trim().parse::<u64>().ok())
            })
        })
        .unwrap_or(0) as usize;
    let draft_payload = payload
        .get("profileDraft")
        .cloned()
        .or_else(|| payload.get("draft").cloned())
        .or_else(|| payload.get("printer").cloned())
        .unwrap_or_else(|| payload.clone());

    let profile = normalize_draft_profile_payload(draft_payload)?;
    let printer_name = value_str(&profile, &["printerName", "printer_name"]).unwrap_or_default();
    let target = match printers::resolve_printer_target(&profile) {
        Ok(target) => target,
        Err(error) => {
            return Ok(serde_json::json!({
                "success": false,
                "printerName": printer_name,
                "sampleKind": sample_kind,
                "verificationStatus": "unverified",
                "transportReachable": false,
                "error": error,
            }));
        }
    };
    let printer_label = if printer_name.is_empty() {
        target.label()
    } else {
        printer_name.clone()
    };

    let known_printers = match ensure_target_ready(&target) {
        Ok(value) => value,
        Err(error) => {
            return Ok(serde_json::json!({
                "success": false,
                "printerName": printer_label,
                "sampleKind": sample_kind,
                "verificationStatus": "unverified",
                "transportReachable": false,
                "resolvedTransport": resolved_transport_name(&target),
                "resolvedAddress": target.label(),
                "error": error,
            }));
        }
    };

    let start = std::time::Instant::now();
    match run_verification_dispatch(
        &db,
        &profile,
        &target,
        &printer_label,
        &sample_kind,
        probe_attempt,
    ) {
        Ok((candidate, layout, dispatch, supports_logo)) => {
            let latency_ms = start.elapsed().as_millis() as u64;
            let candidate_capabilities =
                capability_candidate_json(&candidate.target, &layout, supports_logo);
            let candidate_connection = merge_candidate_capabilities_into_connection(
                &profile,
                candidate_capabilities.clone(),
            );
            Ok(serde_json::json!({
                "success": true,
                "printerName": printer_label,
                "sampleKind": sample_kind,
                "message": "Draft test print dispatched",
                "latencyMs": latency_ms,
                "bytesRequested": dispatch.bytes_requested,
                "bytesWritten": dispatch.bytes_written,
                "resolvedTransport": resolved_transport_name(&candidate.target),
                "resolvedAddress": candidate.target.label(),
                "transportReachable": true,
                "verificationStatus": "candidate",
                "emulationMode": emulation_mode_key(layout.emulation_mode),
                "renderMode": render_mode_key(layout.classic_customer_render_mode),
                "characterSet": layout.character_set,
                "escposCodePage": layout.escpos_code_page,
                "probeAttempt": probe_attempt,
                "candidateCapabilities": candidate_capabilities,
                "candidateConnectionDetails": candidate_connection,
                "knownPrinters": known_printers
            }))
        }
        Err(error) => {
            warn!(printer = %printer_label, error = %error, sample_kind = %sample_kind, probe_attempt, "Draft print test failed");
            Ok(serde_json::json!({
                "success": false,
                "printerName": printer_label,
                "sampleKind": sample_kind,
                "error": error,
                "latencyMs": start.elapsed().as_millis() as u64,
                "probeAttempt": probe_attempt,
                "bytesWritten": 0,
                "resolvedTransport": resolved_transport_name(&target),
                "resolvedAddress": target.label(),
                "transportReachable": false,
                "verificationStatus": "unverified",
                "knownPrinters": known_printers
            }))
        }
    }
}

#[tauri::command]
pub async fn printer_test(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let profile = printers::get_printer_profile(&db, &printer_id)?;
    let printer_name = value_str(&profile, &["printerName", "printer_name"]).unwrap_or_default();
    let target = match printers::resolve_printer_target(&profile) {
        Ok(target) => target,
        Err(error) => {
            return Ok(serde_json::json!({
                "success": false,
                "printerId": printer_id,
                "printerName": printer_name,
                "error": error,
            }));
        }
    };
    let printer_label = if printer_name.is_empty() {
        target.label()
    } else {
        printer_name.clone()
    };
    let known_printers = match ensure_target_ready(&target) {
        Ok(value) => value,
        Err(error) => {
            return Ok(serde_json::json!({
                "success": false,
                "printerId": printer_id,
                "printerName": printer_label,
                "resolvedTransport": resolved_transport_name(&target),
                "resolvedAddress": target.label(),
                "error": error,
            }));
        }
    };

    let start = std::time::Instant::now();
    let verification_status = printers::capability_verification_status(&profile);
    let dispatch_result = if verification_status == "unverified" {
        run_verification_dispatch(&db, &profile, &target, &printer_label, "transport_text", 0).map(
            |(candidate, layout, dispatch, supports_logo)| {
                let dispatch_target = candidate.target.clone();
                let candidate_capabilities =
                    capability_candidate_json(&dispatch_target, &layout, supports_logo);
                (
                    dispatch_target,
                    layout,
                    dispatch,
                    supports_logo,
                    Some(candidate_capabilities),
                )
            },
        )
    } else {
        let layout = print::resolve_layout_config(&db, &profile, "order_receipt")?;
        let test_data = build_transport_text_sample(&printer_label, &layout);
        let dispatch = printers::print_raw_for_target(&target, &test_data, "POS Test Print")?;
        Ok((target.clone(), layout, dispatch, false, None))
    };

    match dispatch_result {
        Ok((dispatch_target, layout, dispatch, supports_logo, candidate_capabilities)) => {
            if matches!(
                dispatch_target,
                printers::ResolvedPrinterTarget::WindowsQueue { .. }
            ) {
                if let Err(probe_error) = printers::probe_printer_target(&dispatch_target) {
                    warn!(
                        printer = %printer_label,
                        error = %probe_error,
                        "Printer spool probe failed after test print dispatch"
                    );
                    return Ok(serde_json::json!({
                        "success": false,
                        "printerId": printer_id,
                        "printerName": printer_label,
                        "error": format!("Print data was sent but spool status probe failed: {probe_error}"),
                        "bytesRequested": dispatch.bytes_requested,
                        "bytesWritten": dispatch.bytes_written,
                        "docName": dispatch.doc_name,
                        "latencyMs": start.elapsed().as_millis() as u64,
                        "resolvedTransport": resolved_transport_name(&dispatch_target),
                        "resolvedAddress": dispatch_target.label(),
                        "emulationMode": emulation_mode_key(layout.emulation_mode),
                        "renderMode": render_mode_key(layout.classic_customer_render_mode),
                        "characterSet": layout.character_set,
                        "escposCodePage": layout.escpos_code_page,
                        "candidateCapabilities": candidate_capabilities,
                        "knownPrinters": known_printers
                    }));
                }
            }

            let latency_ms = start.elapsed().as_millis() as u64;
            info!(
                printer = %printer_label,
                latency_ms = latency_ms,
                bytes = dispatch.bytes_requested,
                emulation_mode = ?layout.emulation_mode,
                render_mode = ?layout.classic_customer_render_mode,
                verification_status = %verification_status,
                "Test print dispatched"
            );

            // Record test print in print_jobs for diagnostics tracking
            {
                let job_id = uuid::Uuid::new_v4().to_string();
                let now = chrono::Utc::now().to_rfc3339();
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.execute(
                        "INSERT INTO print_jobs (id, entity_type, entity_id, printer_profile_id,
                                                 status, created_at, updated_at, printed_at)
                         VALUES (?1, 'test_print', ?2, ?3, 'printed', ?4, ?4, ?4)",
                        rusqlite::params![job_id, job_id, printer_id, now],
                    );
                }
            }

            Ok(serde_json::json!({
                "success": true,
                "printerId": printer_id,
                "printerName": printer_label,
                "latencyMs": latency_ms,
                "message": "Test print dispatched",
                "bytesRequested": dispatch.bytes_requested,
                "bytesWritten": dispatch.bytes_written,
                "docName": dispatch.doc_name,
                "resolvedTransport": resolved_transport_name(&dispatch_target),
                "resolvedAddress": dispatch_target.label(),
                "verificationStatus": verification_status,
                "emulationMode": emulation_mode_key(layout.emulation_mode),
                "renderMode": render_mode_key(layout.classic_customer_render_mode),
                "characterSet": layout.character_set,
                "escposCodePage": layout.escpos_code_page,
                "candidateCapabilities": candidate_capabilities,
                "candidateConnectionDetails": candidate_capabilities
                    .clone()
                    .map(|value| merge_candidate_capabilities_into_connection(&profile, value)),
                "supportsLogo": supports_logo,
                "knownPrinters": known_printers
            }))
        }
        Err(e) => {
            warn!(printer = %printer_label, error = %e, "Test print failed");

            // Record failed test print in print_jobs for diagnostics tracking
            {
                let job_id = uuid::Uuid::new_v4().to_string();
                let now = chrono::Utc::now().to_rfc3339();
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.execute(
                        "INSERT INTO print_jobs (id, entity_type, entity_id, printer_profile_id,
                                                 status, created_at, updated_at)
                         VALUES (?1, 'test_print', ?2, ?3, 'failed', ?4, ?4)",
                        rusqlite::params![job_id, job_id, printer_id, now],
                    );
                }
            }

            Ok(serde_json::json!({
                "success": false,
                "printerId": printer_id,
                "printerName": printer_label,
                "error": e,
                "latencyMs": start.elapsed().as_millis() as u64,
                "bytesWritten": 0,
                "docName": "POS Test Print",
                "resolvedTransport": resolved_transport_name(&target),
                "resolvedAddress": target.label(),
                "knownPrinters": known_printers
            }))
        }
    }
}

#[tauri::command]
pub async fn printer_test_greek_direct(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let profile = printers::get_printer_profile(&db, &printer_id)?;
    let printer_name = value_str(&profile, &["printerName", "printer_name"]).unwrap_or_default();
    let target = match printers::resolve_printer_target(&profile) {
        Ok(target) => target,
        Err(error) => {
            return Ok(serde_json::json!({
                "success": false,
                "printerId": printer_id,
                "printerName": printer_name,
                "error": error,
            }));
        }
    };
    let printer_label = if printer_name.is_empty() {
        target.label()
    } else {
        printer_name.clone()
    };
    let known_printers = ensure_target_ready(&target).ok().flatten();
    let verification_status = printers::capability_verification_status(&profile);
    let (dispatch_target, layout) = if verification_status == "unverified" {
        let candidates = verification_candidates_for_profile(&profile, &target, "encoding");
        let Some(candidate) = candidates.into_iter().next() else {
            return Ok(serde_json::json!({
                "success": false,
                "printerId": printer_id,
                "printerName": printer_label,
                "error": "No verification candidates available for this printer",
                "resolvedTransport": resolved_transport_name(&target),
                "resolvedAddress": target.label(),
                "knownPrinters": known_printers
            }));
        };
        let candidate_profile = profile_with_candidate_capabilities(
            &profile,
            &candidate.target,
            &candidate.emulation,
            &candidate.render_mode,
            candidate.supports_logo,
        );
        (
            candidate.target,
            print::resolve_layout_config(&db, &candidate_profile, "order_receipt")?,
        )
    } else {
        (
            target.clone(),
            print::resolve_layout_config(&db, &profile, "order_receipt")?,
        )
    };
    let use_star_line_mode =
        receipt_renderer::uses_star_commands(layout.detected_brand, layout.emulation_mode);

    let start = std::time::Instant::now();

    let mut builder = if use_star_line_mode {
        escpos::EscPosBuilder::new()
            .with_paper(layout.paper_width)
            .with_star_line_mode()
    } else {
        escpos::EscPosBuilder::new().with_paper(layout.paper_width)
    };
    builder.init();

    // Apply character set using the same logic as receipts
    let _warnings = receipt_renderer::apply_character_set_for_test(
        &mut builder,
        &layout.character_set,
        layout.greek_render_mode.as_deref(),
        layout.escpos_code_page,
        layout.detected_brand,
        layout.emulation_mode,
    );

    builder
        .center()
        .bold(true)
        .text("GREEK TEST PRINT\n")
        .bold(false)
        .separator()
        .left()
        .text(&format!("Character Set: {}\n", layout.character_set))
        .text(&format!(
            "Code Page Override: {}\n",
            layout
                .escpos_code_page
                .map(|v| v.to_string())
                .unwrap_or_else(|| "Auto".to_string())
        ))
        .separator()
        .bold(true)
        .text("Greek Uppercase:\n")
        .bold(false)
        .text("\u{0391}\u{0392}\u{0393}\u{0394}\u{0395}\u{0396}\u{0397}\u{0398}\u{0399}\u{039A}\u{039B}\u{039C}\u{039D}\u{039E}\u{039F}\u{03A0}\u{03A1}\u{03A3}\u{03A4}\u{03A5}\u{03A6}\u{03A7}\u{03A8}\u{03A9}\n")
        .bold(true)
        .text("Greek Lowercase:\n")
        .bold(false)
        .text("\u{03B1}\u{03B2}\u{03B3}\u{03B4}\u{03B5}\u{03B6}\u{03B7}\u{03B8}\u{03B9}\u{03BA}\u{03BB}\u{03BC}\u{03BD}\u{03BE}\u{03BF}\u{03C0}\u{03C1}\u{03C3}\u{03C2}\u{03C4}\u{03C5}\u{03C6}\u{03C7}\u{03C8}\u{03C9}\n")
        .separator()
        .bold(true)
        .text("Sample Receipt Line:\n")
        .bold(false);
    builder
        .line_pair("\u{039A}\u{03B1}\u{03C6}\u{03AD}\u{03C2} \u{0395}\u{03BB}\u{03BB}\u{03B7}\u{03BD}\u{03B9}\u{03BA}\u{03CC}\u{03C2}", "3.50")
        .line_pair("\u{03A3}\u{03BF}\u{03C5}\u{03B2}\u{03BB}\u{03AC}\u{03BA}\u{03B9}", "6.00")
        .line_pair("\u{03A3}\u{03CD}\u{03BD}\u{03BF}\u{03BB}\u{03BF}", "9.50");
    builder.separator().center();
    builder
        .text("\u{0395}\u{03C5}\u{03C7}\u{03B1}\u{03C1}\u{03B9}\u{03C3}\u{03C4}\u{03BF}\u{03CD}\u{03BC}\u{03B5}!\n");
    if use_star_line_mode {
        builder.feed(3).star_cut();
    } else {
        builder.feed(4).cut();
    }

    let test_data = builder.build();
    let byte_count = test_data.len();

    info!(
        printer = %printer_label,
        character_set = %layout.character_set,
        code_page_override = ?layout.escpos_code_page,
        emulation_mode = ?layout.emulation_mode,
        bytes = byte_count,
        "Greek test print dispatching"
    );

    match printers::print_raw_for_target(&dispatch_target, &test_data, "POS Greek Test") {
        Ok(dispatch) => {
            let latency_ms = start.elapsed().as_millis() as u64;
            Ok(serde_json::json!({
                "success": true,
                "printerId": printer_id,
                "printerName": printer_label,
                "characterSet": layout.character_set,
                "escposCodePage": layout.escpos_code_page,
                "latencyMs": latency_ms,
                "bytesRequested": dispatch.bytes_requested,
                "bytesWritten": dispatch.bytes_written,
                "message": "Greek test print dispatched",
                "resolvedTransport": resolved_transport_name(&dispatch_target),
                "resolvedAddress": dispatch_target.label(),
                "verificationStatus": verification_status,
                "emulationMode": emulation_mode_key(layout.emulation_mode),
                "renderMode": render_mode_key(layout.classic_customer_render_mode),
                "knownPrinters": known_printers
            }))
        }
        Err(e) => {
            warn!(printer = %printer_label, error = %e, "Greek test print failed");
            Ok(serde_json::json!({
                "success": false,
                "printerId": printer_id,
                "printerName": printer_label,
                "error": e,
                "resolvedTransport": resolved_transport_name(&dispatch_target),
                "resolvedAddress": dispatch_target.label(),
                "emulationMode": emulation_mode_key(layout.emulation_mode),
                "renderMode": render_mode_key(layout.classic_customer_render_mode),
                "knownPrinters": known_printers
            }))
        }
    }
}

/// Returns auto-detected printer configuration based on the printer name and
/// the app's current language setting.  Used by the UI to show what auto-config
/// would resolve for a given printer profile.
#[tauri::command]
pub async fn printer_get_auto_config(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let profile = printers::get_printer_profile(&db, &printer_id)?;

    let printer_name = profile
        .get("printerName")
        .or_else(|| profile.get("printer_name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");

    let brand = printers::detect_printer_brand_for_profile(&profile);

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let app_language = db::get_setting(&conn, "general", "language")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "en".to_string());

    let auto_character_set = receipt_renderer::language_to_character_set(&app_language);
    let code_page_brand = if printers::profile_uses_star_line_mode(&profile) {
        printers::PrinterBrand::Star
    } else if brand == printers::PrinterBrand::Star {
        printers::PrinterBrand::Unknown
    } else {
        brand
    };
    let auto_code_page =
        receipt_renderer::resolve_auto_code_page(code_page_brand, auto_character_set);

    Ok(serde_json::json!({
        "printerId": printer_id,
        "printerName": printer_name,
        "detectedBrand": brand.label(),
        "appLanguage": app_language,
        "autoCharacterSet": auto_character_set,
        "autoCodePage": auto_code_page,
    }))
}

#[tauri::command]
pub async fn printer_recommend_profile(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let input = parse_printer_recommendation_input(arg0);

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let app_language = db::get_setting(&conn, "general", "language")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "en".to_string());

    let recommendation = build_printer_recommendation(&input, &app_language);
    Ok(serde_json::json!({
        "detectedBrand": recommendation.detected_brand,
        "recommended": recommendation.recommended,
        "probeHints": recommendation.probe_hints,
        "confidence": recommendation.confidence,
        "reasons": recommendation.reasons,
        "appLanguage": app_language
    }))
}

#[tauri::command]
pub async fn printer_diagnostics(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let profile = printers::get_printer_profile(&db, &printer_id)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let total_jobs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE printer_profile_id = ?1",
            rusqlite::params![printer_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let failed_jobs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE status = 'failed' AND printer_profile_id = ?1",
            rusqlite::params![printer_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let successful_jobs = total_jobs - failed_jobs;

    let printer_type = value_str(&profile, &["printerType", "printer_type"])
        .unwrap_or_else(|| "system".to_string());
    let printer_name = value_str(&profile, &["printerName", "printer_name"]).unwrap_or_default();
    let (target, connected, state) = resolve_profile_connection_state(&profile);
    let capabilities = printers::read_capability_snapshot(&profile);

    Ok(serde_json::json!({
        "success": true,
        "diagnostics": {
            "printerId": printer_id,
            "connectionType": printer_type,
            "model": printer_name,
            "isOnline": connected,
            "state": state,
            "verificationStatus": printers::capability_verification_status(&profile),
            "resolvedTransport": target.as_ref().map(resolved_transport_name),
            "resolvedAddress": target.as_ref().map(|value| value.label()),
            "supportsLogo": capabilities.supports_logo,
            "supportsCut": capabilities.supports_cut,
            "lastVerifiedAt": capabilities.last_verified_at,
            "recentJobs": {
                "total": total_jobs,
                "successful": successful_jobs,
                "failed": failed_jobs
            }
        }
    }))
}

#[tauri::command]
pub async fn printer_bluetooth_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "available": cfg!(target_os = "windows"),
        "message": if cfg!(target_os = "windows") {
            "Bluetooth thermal printing is available when Windows exposes a printer queue or RFCOMM/serial port"
        } else {
            "Bluetooth thermal printing is currently supported on Windows only"
        }
    }))
}

#[tauri::command]
pub async fn printer_open_cash_drawer(
    arg0: Option<serde_json::Value>,
    _arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<serde_json::Value, auth::GuardedCommandError> {
    auth::authorize_privileged_action(
        auth::PrivilegedActionScope::CashDrawerControl,
        &db,
        &auth_state,
    )?;
    let printer_id = parse_optional_printer_id_payload(arg0);
    let result = drawer::open_cash_drawer(&db, printer_id.as_deref())?;
    let _ = app.emit(
        "printer_status_changed",
        serde_json::json!({
            "printerId": printer_id,
            "status": "drawer_opened"
        }),
    );
    Ok(result)
}

#[tauri::command]
pub async fn label_print(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let parsed = parse_label_print_payload(arg0, arg1);
    let mut jobs = read_local_json_array(&db, "label_print_jobs_v1")?;
    let job_id = format!("label-{}", uuid::Uuid::new_v4());
    jobs.push(serde_json::json!({
        "id": job_id,
        "request": parsed.request,
        "printerId": parsed.printer_id,
        "createdAt": Utc::now().to_rfc3339()
    }));
    write_local_json(&db, "label_print_jobs_v1", &serde_json::Value::Array(jobs))?;
    Ok(serde_json::json!({ "success": true, "jobId": job_id }))
}

#[tauri::command]
pub async fn label_print_batch(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let parsed = parse_label_print_batch_payload(arg0, arg1, arg2);
    let mut jobs = read_local_json_array(&db, "label_print_jobs_v1")?;
    let job_id = format!("label-batch-{}", uuid::Uuid::new_v4());
    jobs.push(serde_json::json!({
        "id": job_id,
        "items": parsed.items,
        "labelType": parsed.label_type,
        "printerId": parsed.printer_id,
        "createdAt": Utc::now().to_rfc3339()
    }));
    write_local_json(&db, "label_print_jobs_v1", &serde_json::Value::Array(jobs))?;
    Ok(serde_json::json!({ "success": true, "jobId": job_id }))
}

// ---------------------------------------------------------------------------
// Receipt sample preview (for live printer settings UI)
// ---------------------------------------------------------------------------

fn build_sample_receipt_doc() -> receipt_renderer::OrderReceiptDoc {
    let now = Utc::now().format("%Y-%m-%d %H:%M").to_string();
    receipt_renderer::OrderReceiptDoc {
        order_id: "preview-000".to_string(),
        order_number: "ORD-0042".to_string(),
        order_type: "dine_in".to_string(),
        status: "completed".to_string(),
        created_at: now,
        table_number: Some("5".to_string()),
        customer_name: Some("John D.".to_string()),
        items: vec![
            receipt_renderer::ReceiptItem {
                name: "Espresso".to_string(),
                quantity: 2.0,
                total: 7.00,
                customizations: vec![receipt_renderer::ReceiptCustomizationLine {
                    name: "Extra shot".to_string(),
                    quantity: 1.0,
                    ..Default::default()
                }],
                ..Default::default()
            },
            receipt_renderer::ReceiptItem {
                name: "Club Sandwich".to_string(),
                quantity: 1.0,
                total: 12.50,
                note: Some("No onions".to_string()),
                ..Default::default()
            },
            receipt_renderer::ReceiptItem {
                name: "Caesar Salad".to_string(),
                quantity: 1.0,
                total: 9.80,
                ..Default::default()
            },
        ],
        totals: vec![
            receipt_renderer::TotalsLine {
                label: "Subtotal".to_string(),
                amount: 29.30,
                emphasize: false,
                ..Default::default()
            },
            receipt_renderer::TotalsLine {
                label: "VAT 13%".to_string(),
                amount: 3.81,
                emphasize: false,
                ..Default::default()
            },
            receipt_renderer::TotalsLine {
                label: "Total".to_string(),
                amount: 33.11,
                emphasize: true,
                ..Default::default()
            },
        ],
        payments: vec![receipt_renderer::PaymentLine {
            label: "Cash".to_string(),
            amount: 40.00,
            ..Default::default()
        }],
        order_notes: vec![],
        adjustments: vec![],
        masked_card: None,
        customer_phone: None,
        delivery_address: None,
        delivery_city: None,
        delivery_postal_code: None,
        delivery_floor: None,
        name_on_ringer: None,
        driver_id: None,
        driver_name: None,
        delivery_slip_mode: Default::default(),
        status_label: None,
        cancellation_reason: None,
    }
}

#[tauri::command]
pub async fn receipt_sample_preview(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or_else(|| serde_json::json!({}));
    build_receipt_sample_preview_response(&db, &payload)
}

fn preview_string_field(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|entry| {
            entry.as_str().and_then(|text| {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            })
        })
}

fn preview_f32_field(value: &serde_json::Value, keys: &[&str]) -> Option<f32> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|entry| {
            entry
                .as_f64()
                .or_else(|| {
                    entry
                        .as_str()
                        .and_then(|text| text.trim().parse::<f64>().ok())
                })
                .map(|number| number as f32)
        })
}

fn preview_bool_field(value: &serde_json::Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|entry| match entry {
            serde_json::Value::Bool(flag) => Some(*flag),
            serde_json::Value::Number(number) => number.as_i64().map(|value| value != 0),
            serde_json::Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => Some(true),
                "false" | "0" | "no" | "off" => Some(false),
                _ => None,
            },
            _ => None,
        })
}

fn receipt_preview_template_key(template: receipt_renderer::ReceiptTemplate) -> &'static str {
    match template {
        receipt_renderer::ReceiptTemplate::Classic => "classic",
        receipt_renderer::ReceiptTemplate::Modern => "modern",
    }
}

fn receipt_preview_render_mode_key(
    mode: receipt_renderer::ClassicCustomerRenderMode,
) -> &'static str {
    match mode {
        receipt_renderer::ClassicCustomerRenderMode::Text => "text",
        receipt_renderer::ClassicCustomerRenderMode::RasterExact => "raster_exact",
    }
}

fn receipt_preview_supports_text_scale(layout: &receipt_renderer::LayoutConfig) -> bool {
    layout.template == receipt_renderer::ReceiptTemplate::Classic
        && layout.classic_customer_render_mode
            == receipt_renderer::ClassicCustomerRenderMode::RasterExact
}

fn resolve_receipt_preview_profile(
    db: &db::DbState,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let draft_payload = payload
        .get("profileDraft")
        .cloned()
        .or_else(|| payload.get("draft").cloned())
        .or_else(|| payload.get("printer").cloned())
        .or_else(|| {
            if payload.get("connectionDetails").is_some()
                || payload.get("paperSize").is_some()
                || payload.get("receiptTemplate").is_some()
            {
                Some(payload.clone())
            } else {
                None
            }
        });

    if let Some(draft_payload) = draft_payload {
        return normalize_draft_profile_payload(draft_payload);
    }

    Ok(
        printers::resolve_printer_profile_for_role(db, None, Some("receipt"))?
            .unwrap_or_else(|| serde_json::json!({})),
    )
}

fn apply_receipt_preview_overrides(
    profile: &serde_json::Value,
    payload: &serde_json::Value,
    layout: &mut receipt_renderer::LayoutConfig,
) {
    let settings = payload
        .get("receiptSettings")
        .or_else(|| payload.get("receipt_settings"))
        .unwrap_or(payload);

    if let Some(text_scale_override) = preview_f32_field(settings, &["textScale", "text_scale"])
        .or_else(|| preview_f32_field(payload, &["textScale", "text_scale"]))
    {
        layout.text_scale = text_scale_override.clamp(0.8, 2.0);
    }
    if let Some(logo_scale_override) = preview_f32_field(settings, &["logoScale", "logo_scale"])
        .or_else(|| preview_f32_field(payload, &["logoScale", "logo_scale"]))
    {
        layout.logo_scale = logo_scale_override.clamp(0.5, 2.0);
    }

    let logo_supported = printers::read_capability_snapshot(profile).supports_logo
        || matches!(
            layout.detected_brand,
            crate::printers::PrinterBrand::Star | crate::printers::PrinterBrand::Epson
        );
    if let Some(show_logo_override) = preview_bool_field(settings, &["showLogo", "show_logo"])
        .or_else(|| preview_bool_field(payload, &["showLogo", "show_logo"]))
    {
        layout.show_logo = show_logo_override && logo_supported;
        if !layout.show_logo {
            layout.logo_url = None;
        }
    }

    let has_logo_source_field = settings.get("logoSource").is_some()
        || settings.get("logo_source").is_some()
        || payload.get("logoSource").is_some()
        || payload.get("logo_source").is_some();
    if has_logo_source_field {
        let logo_source_override = preview_string_field(settings, &["logoSource", "logo_source"])
            .or_else(|| preview_string_field(payload, &["logoSource", "logo_source"]));
        layout.logo_url = logo_source_override;
    }
}

fn build_receipt_sample_preview_response(
    db: &db::DbState,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let profile = resolve_receipt_preview_profile(db, payload)?;
    let mut layout = print::resolve_layout_config(db, &profile, "order_receipt")?;
    apply_receipt_preview_overrides(&profile, payload, &mut layout);
    let sample_doc = build_sample_receipt_doc();
    let document = receipt_renderer::ReceiptDocument::OrderReceipt(sample_doc);
    let is_exact_preview = layout.template == receipt_renderer::ReceiptTemplate::Classic
        && layout.classic_customer_render_mode
            == receipt_renderer::ClassicCustomerRenderMode::RasterExact;
    let supports_text_scale = receipt_preview_supports_text_scale(&layout);
    let effective_template = receipt_preview_template_key(layout.template);
    let effective_render_mode =
        receipt_preview_render_mode_key(layout.classic_customer_render_mode);

    if !supports_text_scale {
        layout.text_scale = receipt_renderer::LayoutConfig::default().text_scale;
    }

    if is_exact_preview {
        let data_url =
            receipt_renderer::render_classic_raster_exact_preview_data_url(&document, &layout)?;
        return Ok(serde_json::json!({
            "success": true,
            "kind": "image",
            "dataUrl": data_url,
            "effectiveTemplate": effective_template,
            "effectiveRenderMode": effective_render_mode,
            "supportsTextScale": supports_text_scale,
            "isExactPreview": true,
        }));
    }

    let html = receipt_renderer::render_html(&document, &layout);
    Ok(serde_json::json!({
        "success": true,
        "kind": "html",
        "html": html,
        "effectiveTemplate": effective_template,
        "effectiveRenderMode": effective_render_mode,
        "supportsTextScale": supports_text_scale,
        "isExactPreview": false,
    }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;
    use rusqlite::Connection;
    use std::net::TcpListener;
    use std::sync::Mutex;
    use std::thread;

    fn test_db() -> db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        db::run_migrations_for_test(&conn);
        db::DbState {
            conn: Mutex::new(conn),
            db_path: std::env::temp_dir().join("receipt-sample-preview-tests.sqlite"),
        }
    }

    fn preview_profile_from_frontend(payload: serde_json::Value) -> serde_json::Value {
        normalize_draft_profile_payload(payload).expect("frontend profile payload should normalize")
    }

    #[test]
    fn parse_order_id_payload_accepts_string_and_object() {
        let from_string = parse_order_id_payload(Some(serde_json::json!("order-1")))
            .expect("string payload should parse");
        let from_object = parse_order_id_payload(Some(serde_json::json!({
            "order_id": "order-2"
        })))
        .expect("object payload should parse");
        assert_eq!(from_string, "order-1");
        assert_eq!(from_object, "order-2");
    }

    #[test]
    fn parse_requested_receipt_entity_type_defaults_to_customer_receipt() {
        assert_eq!(
            parse_requested_receipt_entity_type(None, None),
            "order_receipt"
        );
        assert_eq!(
            parse_requested_receipt_entity_type(
                Some(&serde_json::json!({"type": "customer"})),
                None
            ),
            "order_receipt"
        );
    }

    #[test]
    fn parse_requested_receipt_entity_type_accepts_delivery_aliases() {
        assert_eq!(
            parse_requested_receipt_entity_type(None, Some(&serde_json::json!("delivery"))),
            "delivery_slip"
        );
        assert_eq!(
            parse_requested_receipt_entity_type(
                Some(&serde_json::json!({"receiptType": "delivery_slip"})),
                None
            ),
            "delivery_slip"
        );
    }

    #[test]
    fn parse_print_list_jobs_status_accepts_string_and_object() {
        let from_string = parse_print_list_jobs_status(Some(serde_json::json!("pending")));
        let from_object = parse_print_list_jobs_status(Some(serde_json::json!({
            "status": "failed"
        })));
        assert_eq!(from_string.as_deref(), Some("pending"));
        assert_eq!(from_object.as_deref(), Some("failed"));
    }

    #[test]
    fn parse_printer_discover_types_supports_legacy_and_object_shapes() {
        let from_legacy_array =
            parse_printer_discover_types(Some(serde_json::json!([" System ", "BLUETOOTH"])));
        let from_object = parse_printer_discover_types(Some(serde_json::json!({
            "types": ["wifi"],
            "type": "usb"
        })));
        assert_eq!(
            from_legacy_array,
            vec!["system".to_string(), "bluetooth".to_string()]
        );
        assert_eq!(from_object, vec!["wifi".to_string(), "usb".to_string()]);
    }

    #[test]
    fn printer_discover_defaults_include_bluetooth() {
        let requested = parse_printer_discover_types(None);
        assert!(should_discover_system_like(&requested));
        assert!(should_discover_bluetooth(&requested));
    }

    #[test]
    fn printer_discover_includes_bluetooth_only_when_requested() {
        let requested = parse_printer_discover_types(Some(serde_json::json!(["bluetooth"])));
        assert!(should_discover_bluetooth(&requested));
    }

    #[test]
    fn resolve_profile_connection_state_reports_network_online() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let addr = listener.local_addr().expect("listener addr");
        let handle = thread::spawn(move || {
            let (_stream, _peer) = listener.accept().expect("accept probe connection");
        });

        let profile = serde_json::json!({
            "printerType": "network",
            "connectionJson": format!("{{\"type\":\"network\",\"ip\":\"127.0.0.1\",\"port\":{}}}", addr.port())
        });

        let (target, connected, state) = resolve_profile_connection_state(&profile);
        handle.join().expect("listener thread should finish");

        assert_eq!(
            target.as_ref().map(resolved_transport_name),
            Some("raw_tcp")
        );
        assert!(connected);
        assert_eq!(state, "unverified");
    }

    #[test]
    fn resolve_profile_connection_state_reports_network_offline() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind temporary listener");
        let port = listener.local_addr().expect("listener addr").port();
        drop(listener);

        let profile = serde_json::json!({
            "printerType": "network",
            "connectionJson": format!("{{\"type\":\"network\",\"ip\":\"127.0.0.1\",\"port\":{}}}", port)
        });

        let (target, connected, state) = resolve_profile_connection_state(&profile);

        assert_eq!(
            target.as_ref().map(resolved_transport_name),
            Some("raw_tcp")
        );
        assert!(!connected);
        assert_eq!(state, "offline");
    }

    #[test]
    fn recommendation_prefers_unverified_compatible_defaults() {
        let input = PrinterRecommendationInput {
            name: "Star MCP31LB".to_string(),
            printer_type: "system".to_string(),
            address: "Star MCP31LB".to_string(),
            paper_size_hint: Some("80mm".to_string()),
        };

        let recommendation = build_printer_recommendation(&input, "el");
        let connection = recommendation
            .recommended
            .get("connectionDetails")
            .and_then(|v| v.as_object())
            .expect("connectionDetails object");

        assert_eq!(recommendation.detected_brand, "Star");
        assert_eq!(
            recommendation
                .recommended
                .get("characterSet")
                .and_then(|v| v.as_str()),
            Some("PC737_GREEK")
        );
        assert_eq!(
            connection.get("render_mode").and_then(|v| v.as_str()),
            Some("text")
        );
        assert_eq!(
            connection.get("emulation").and_then(|v| v.as_str()),
            Some("auto")
        );
        assert_eq!(
            recommendation.probe_hints["preferredEmulationOrder"][0].as_str(),
            Some("star_line")
        );
        assert_eq!(
            connection["capabilities"]["status"].as_str(),
            Some("unverified")
        );
        assert!(recommendation.confidence >= 80);
    }

    #[test]
    fn recommendation_falls_back_to_generic_for_unknown_models() {
        let input = PrinterRecommendationInput {
            name: "Generic POS Printer".to_string(),
            printer_type: "network".to_string(),
            address: "192.168.1.44".to_string(),
            paper_size_hint: None,
        };

        let recommendation = build_printer_recommendation(&input, "en");
        let connection = recommendation
            .recommended
            .get("connectionDetails")
            .and_then(|v| v.as_object())
            .expect("connectionDetails object");

        assert_eq!(recommendation.detected_brand, "Unknown");
        assert_eq!(
            recommendation
                .recommended
                .get("paperSize")
                .and_then(|v| v.as_str()),
            Some("80mm")
        );
        assert_eq!(
            recommendation
                .recommended
                .get("receiptTemplate")
                .and_then(|v| v.as_str()),
            Some("classic")
        );
        assert_eq!(
            connection.get("render_mode").and_then(|v| v.as_str()),
            Some("text")
        );
        assert_eq!(
            connection.get("emulation").and_then(|v| v.as_str()),
            Some("auto")
        );
        assert_eq!(
            recommendation.probe_hints["preferredEmulationOrder"][0].as_str(),
            Some("escpos")
        );
        assert_eq!(
            recommendation.probe_hints["preferredBaudRates"][0].as_i64(),
            Some(115200)
        );
    }

    #[test]
    fn recommendation_confidence_is_higher_for_known_models() {
        let known = PrinterRecommendationInput {
            name: "Star MCP31".to_string(),
            printer_type: "system".to_string(),
            address: "Star MCP31".to_string(),
            paper_size_hint: None,
        };
        let unknown = PrinterRecommendationInput {
            name: "Printer Queue".to_string(),
            printer_type: "system".to_string(),
            address: "Printer Queue".to_string(),
            paper_size_hint: None,
        };
        let known_recommendation = build_printer_recommendation(&known, "en");
        let unknown_recommendation = build_printer_recommendation(&unknown, "en");
        assert!(known_recommendation.confidence > unknown_recommendation.confidence);
    }

    #[test]
    fn parse_printer_update_payload_supports_legacy_tuple_and_object() {
        let legacy = parse_printer_update_payload(
            Some(serde_json::json!("printer-1")),
            Some(serde_json::json!({ "name": "Front POS" })),
        )
        .expect("legacy tuple should parse");
        assert_eq!(legacy.printer_id, "printer-1");
        assert_eq!(
            legacy.updates.get("name").and_then(|v| v.as_str()),
            Some("Front POS")
        );

        let object = parse_printer_update_payload(
            Some(serde_json::json!({
                "printerId": "printer-2",
                "updates": { "paperSize": "58mm" }
            })),
            None,
        )
        .expect("object payload should parse");
        assert_eq!(object.printer_id, "printer-2");
        assert_eq!(
            object.updates.get("paperSize").and_then(|v| v.as_str()),
            Some("58mm")
        );
    }

    #[test]
    fn electron_to_profile_input_ignores_empty_system_name() {
        let mapped = electron_to_profile_input(
            None,
            serde_json::json!({
                "name": "Front Desk",
                "type": "system",
                "connectionDetails": {
                    "systemName": "   ",
                    "address": ""
                }
            }),
        );
        assert_eq!(
            mapped.get("printerName").and_then(|v| v.as_str()),
            Some("Front Desk")
        );
    }

    #[test]
    fn printer_profile_mapping_preserves_typography_fields() {
        let mapped = electron_to_profile_input(
            None,
            serde_json::json!({
                "name": "Receipt Printer",
                "type": "system",
                "connectionDetails": { "systemName": "Star MCP31" },
                "fontType": "b",
                "layoutDensity": "balanced",
                "headerEmphasis": "normal"
            }),
        );
        assert_eq!(mapped.get("fontType").and_then(|v| v.as_str()), Some("b"));
        assert_eq!(
            mapped.get("layoutDensity").and_then(|v| v.as_str()),
            Some("balanced")
        );
        assert_eq!(
            mapped.get("headerEmphasis").and_then(|v| v.as_str()),
            Some("normal")
        );

        let electron = profile_to_electron_format(&serde_json::json!({
            "id": "p-1",
            "name": "Receipt Printer",
            "printerType": "system",
            "printerName": "Star MCP31",
            "paperWidthMm": 80,
            "font_type": "b",
            "layout_density": "balanced",
            "header_emphasis": "normal",
        }));
        assert_eq!(electron["fontType"], "b");
        assert_eq!(electron["layoutDensity"], "balanced");
        assert_eq!(electron["headerEmphasis"], "normal");
    }

    #[test]
    fn profile_to_electron_format_builds_network_connection_details_without_connection_json() {
        let electron = profile_to_electron_format(&serde_json::json!({
            "id": "p-net",
            "name": "LAN Printer",
            "printerType": "network",
            "printerName": "192.168.1.19",
            "paperWidthMm": 80,
        }));

        assert_eq!(electron["type"], "network");
        assert_eq!(electron["connectionDetails"]["type"], "network");
        assert_eq!(electron["connectionDetails"]["ip"], "192.168.1.19");
        assert_eq!(electron["connectionDetails"]["port"], 9100);
    }

    #[test]
    fn parse_label_print_payload_supports_request_object_shape() {
        let parsed = parse_label_print_payload(
            Some(serde_json::json!({
                "request": { "type": "barcode", "productName": "Tea" },
                "printerId": "printer-1"
            })),
            None,
        );
        assert_eq!(
            parsed.request.get("productName").and_then(|v| v.as_str()),
            Some("Tea")
        );
        assert_eq!(parsed.printer_id.as_deref(), Some("printer-1"));
    }

    #[test]
    fn parse_label_print_batch_payload_supports_legacy_tuple() {
        let parsed = parse_label_print_batch_payload(
            Some(serde_json::json!([{ "sku": "A-1", "quantity": 2 }])),
            Some(serde_json::json!("price")),
            Some(serde_json::json!("printer-9")),
        );
        assert_eq!(parsed.items.as_array().map(|v| v.len()), Some(1));
        assert_eq!(parsed.label_type, "price");
        assert_eq!(parsed.printer_id.as_deref(), Some("printer-9"));
    }

    #[test]
    fn parse_label_print_batch_payload_supports_object_shape() {
        let parsed = parse_label_print_batch_payload(
            Some(serde_json::json!({
                "items": [{ "sku": "B-2", "quantity": 1 }],
                "labelType": "barcode",
                "printerId": "printer-7"
            })),
            None,
            None,
        );
        assert_eq!(parsed.items.as_array().map(|v| v.len()), Some(1));
        assert_eq!(parsed.label_type, "barcode");
        assert_eq!(parsed.printer_id.as_deref(), Some("printer-7"));
    }

    #[test]
    fn receipt_sample_preview_prefers_profile_draft_over_saved_default_profile() {
        let db = test_db();
        let saved_default = preview_profile_from_frontend(serde_json::json!({
            "name": "Saved default receipt",
            "type": "system",
            "connectionDetails": {
                "type": "system",
                "systemName": "Default Receipt",
                "render_mode": "text",
                "emulation": "auto"
            },
            "paperSize": "80mm",
            "receiptTemplate": "modern",
            "characterSet": "PC437_USA",
            "fontType": "a",
            "layoutDensity": "compact",
            "headerEmphasis": "strong",
            "role": "receipt",
            "isDefault": true,
            "enabled": true
        }));
        printers::create_printer_profile(&db, &saved_default).expect("saved default profile");

        let preview = build_receipt_sample_preview_response(
            &db,
            &serde_json::json!({
                "profileDraft": {
                    "name": "Edited draft receipt",
                    "type": "network",
                    "connectionDetails": {
                        "type": "network",
                        "ip": "192.168.1.19",
                        "port": 9100,
                        "render_mode": "raster_exact",
                        "emulation": "escpos",
                        "capabilities": {
                            "status": "unverified",
                            "supportsLogo": true
                        }
                    },
                    "paperSize": "58mm",
                    "receiptTemplate": "classic",
                    "characterSet": "PC437_USA",
                    "fontType": "a",
                    "layoutDensity": "compact",
                    "headerEmphasis": "strong",
                    "role": "receipt",
                    "isDefault": false,
                    "enabled": true
                },
                "receiptSettings": {
                    "showLogo": false,
                    "logoSource": "",
                    "textScale": 1.4,
                    "logoScale": 1.0
                }
            }),
        )
        .expect("preview response");

        assert_eq!(preview["success"], true);
        assert_eq!(preview["kind"], "image");
        assert_eq!(preview["effectiveTemplate"], "classic");
        assert_eq!(preview["effectiveRenderMode"], "raster_exact");
        assert_eq!(preview["supportsTextScale"], true);
        assert_eq!(preview["isExactPreview"], true);
        assert!(preview["dataUrl"]
            .as_str()
            .expect("data url")
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn receipt_sample_preview_reports_approximate_modes_truthfully() {
        let db = test_db();
        let preview = build_receipt_sample_preview_response(
            &db,
            &serde_json::json!({
                "profileDraft": {
                    "name": "Modern receipt draft",
                    "type": "system",
                    "connectionDetails": {
                        "type": "system",
                        "systemName": "Modern Preview Printer",
                        "render_mode": "text",
                        "emulation": "auto"
                    },
                    "paperSize": "80mm",
                    "receiptTemplate": "modern",
                    "characterSet": "PC437_USA",
                    "fontType": "a",
                    "layoutDensity": "compact",
                    "headerEmphasis": "strong",
                    "role": "receipt",
                    "isDefault": false,
                    "enabled": true
                },
                "receiptSettings": {
                    "showLogo": false,
                    "logoSource": "",
                    "textScale": 1.9,
                    "logoScale": 1.0
                }
            }),
        )
        .expect("preview response");

        assert_eq!(preview["success"], true);
        assert_eq!(preview["kind"], "html");
        assert_eq!(preview["effectiveTemplate"], "modern");
        assert_eq!(preview["effectiveRenderMode"], "text");
        assert_eq!(preview["supportsTextScale"], false);
        assert_eq!(preview["isExactPreview"], false);
        assert!(preview["html"]
            .as_str()
            .expect("html preview")
            .contains("<!DOCTYPE html>"));
    }

    #[test]
    fn parse_profile_id_payload_requires_value() {
        let err = parse_profile_id_payload(Some(serde_json::json!({})))
            .expect_err("missing id should fail");
        assert!(err.contains("Missing profileId"));
    }
}
