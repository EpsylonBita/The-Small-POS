use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tracing::{info, warn};

use crate::{
    auth, db, drawer, escpos, payload_arg0_as_string, print, print_history, printers,
    read_local_json_array, receipt_renderer, resolve_order_id, value_str, write_local_json,
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
    supports_cut: bool,
    supports_logo: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WizardSampleKind {
    TransportText,
    Encoding,
    Branding,
}

impl WizardSampleKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::TransportText => "transport_text",
            Self::Encoding => "encoding",
            Self::Branding => "branding",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrinterTestDraftPayload {
    profile_draft: serde_json::Value,
    sample_kind: WizardSampleKind,
    #[serde(default)]
    probe_attempt: usize,
    wizard_session_id: String,
    #[serde(default)]
    confirmed_candidate_connection_details: Option<serde_json::Value>,
}

#[derive(Debug)]
struct WizardSampleBuild {
    bytes: Vec<u8>,
    logo_configured: bool,
    logo_included: bool,
}

#[derive(Debug)]
struct WizardSampleBuildError {
    code: &'static str,
    message: String,
    logo_configured: bool,
    logo_included: bool,
}

impl WizardSampleBuildError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            logo_configured: false,
            logo_included: false,
        }
    }

    fn with_logo_state(mut self, logo_configured: bool, logo_included: bool) -> Self {
        self.logo_configured = logo_configured;
        self.logo_included = logo_included;
        self
    }

    fn code(&self) -> &'static str {
        self.code
    }

    fn logo_configured(&self) -> bool {
        self.logo_configured
    }

    fn logo_included(&self) -> bool {
        self.logo_included
    }
}

impl std::fmt::Display for WizardSampleBuildError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum WizardPrintResponse {
    Queued(WizardPrintQueuedResponse),
    Rejected(WizardPrintRejectedResponse),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WizardPrintQueuedResponse {
    success: bool,
    queued: bool,
    duplicate: bool,
    job_id: String,
    queue_state: String,
    sample_kind: String,
    candidate_connection_details: serde_json::Value,
    candidate_capabilities: serde_json::Value,
    logo_configured: bool,
    logo_included: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WizardPrintRejectedResponse {
    success: bool,
    queued: bool,
    printer_name: String,
    sample_kind: String,
    error_code: String,
    error: String,
    resolved_transport: String,
    resolved_address: String,
    verification_status: String,
    logo_configured: bool,
    logo_included: bool,
}

impl WizardPrintResponse {
    fn queued(outcome: print::PreRenderedTestPrintOutcome) -> Self {
        Self::Queued(WizardPrintQueuedResponse {
            success: true,
            queued: true,
            duplicate: outcome.duplicate,
            job_id: outcome.job_id,
            queue_state: outcome.queue_state,
            sample_kind: outcome.sample_kind,
            candidate_connection_details: outcome.candidate_connection_details,
            candidate_capabilities: outcome.candidate_capabilities,
            logo_configured: outcome.logo_configured,
            logo_included: outcome.logo_included,
        })
    }

    fn rejected(
        printer_name: String,
        sample_kind: WizardSampleKind,
        target: &printers::ResolvedPrinterTarget,
        error: WizardSampleBuildError,
    ) -> Self {
        Self::Rejected(WizardPrintRejectedResponse {
            success: false,
            queued: false,
            printer_name,
            sample_kind: sample_kind.as_str().to_string(),
            error_code: error.code().to_string(),
            error: error.to_string(),
            resolved_transport: resolved_transport_name(target).to_string(),
            resolved_address: target.label(),
            verification_status: "unverified".to_string(),
            logo_configured: error.logo_configured(),
            logo_included: error.logo_included(),
        })
    }
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

fn parse_printer_profile_id_payload(
    arg0: Option<&serde_json::Value>,
    arg1: Option<&serde_json::Value>,
) -> Option<String> {
    arg0.and_then(|value| value_str(value, &["printerProfileId", "printer_profile_id"]))
        .or_else(|| {
            arg1.and_then(|value| value_str(value, &["printerProfileId", "printer_profile_id"]))
        })
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrintListJobsPayload {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default, alias = "printer_profile_id")]
    printer_profile_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    offset: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct PrintQueueControlPayload {
    #[serde(default, alias = "printer_profile_id")]
    printer_profile_id: Option<String>,
    #[serde(default)]
    statuses: Vec<String>,
}

fn parse_print_list_jobs_payload(
    arg0: Option<serde_json::Value>,
) -> (Option<String>, Option<String>, usize, usize) {
    match arg0 {
        Some(serde_json::Value::Object(obj)) => {
            let payload = serde_json::Value::Object(obj.clone());
            let parsed: PrintListJobsPayload = serde_json::from_value(payload).unwrap_or_default();
            (
                parsed.status.or(parsed.state),
                parsed
                    .printer_profile_id
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                parsed.limit.unwrap_or(50),
                parsed.offset.unwrap_or(0),
            )
        }
        other => (parse_print_list_jobs_status(other), None, 50, 0),
    }
}

fn parse_print_queue_control_payload(
    arg0: Option<serde_json::Value>,
) -> Result<PrintQueueControlPayload, String> {
    match arg0 {
        Some(serde_json::Value::Object(obj)) => {
            let profile_was_explicit =
                obj.contains_key("printerProfileId") || obj.contains_key("printer_profile_id");
            let mut parsed: PrintQueueControlPayload =
                serde_json::from_value(serde_json::Value::Object(obj))
                    .map_err(|error| format!("Invalid print queue control payload: {error}"))?;
            parsed.printer_profile_id = match parsed.printer_profile_id {
                Some(value) => {
                    let value = value.trim();
                    if value.is_empty() {
                        return Err("Printer profile scope cannot be empty".into());
                    }
                    Some(value.to_string())
                }
                None if profile_was_explicit => {
                    return Err("Printer profile scope must be a non-empty string".into());
                }
                None => None,
            };
            for status in &mut parsed.statuses {
                let normalized = status.trim().to_ascii_lowercase();
                if !matches!(normalized.as_str(), "pending" | "printing" | "dispatched") {
                    return Err(format!("Unsupported print queue status: {status}"));
                }
                *status = normalized;
            }
            Ok(parsed)
        }
        Some(serde_json::Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                return Err("Printer profile scope cannot be empty".into());
            }
            Ok(PrintQueueControlPayload {
                printer_profile_id: Some(value.to_string()),
                statuses: Vec::new(),
            })
        }
        Some(_) => Err("Print queue control payload must be an object or profile ID".into()),
        None => Ok(PrintQueueControlPayload::default()),
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
    let printer_profile_id = parse_printer_profile_id_payload(arg0.as_ref(), arg1.as_ref());
    let order_id_raw = parse_order_id_payload(arg0)?;
    // Wave 11 Item 8: scope the `MutexGuard` to a block so the borrow
    // checker can prove the (non-Send) guard is dropped before the
    // `.await` below. An explicit `drop(conn)` is insufficient — the
    // future-Send analysis ignores explicit drops and only respects
    // lexical scope ends.
    let order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?
    };

    if !crate::print::is_print_action_enabled(&db, "payment_receipt") {
        return Ok(serde_json::json!({ "success": true, "skipped": true }));
    }

    let enqueue_result = print::enqueue_print_job(
        &db,
        entity_type,
        &order_id,
        printer_profile_id.as_deref(),
        &app,
    )?;

    // Process the job immediately instead of waiting for the background worker.
    // Wave 11 Item 8 deferred follow-up: offload to `spawn_blocking` so the
    // sync SQLite + TCP I/O does not park the Tokio runtime worker. Clone
    // AppHandle so the inner closure can re-acquire `DbState` independently.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    print::spawn_pending_job_processing(
        app.clone(),
        data_dir,
        format!("payment receipt for order {order_id}"),
    );

    Ok(enqueue_result)
}

#[tauri::command]
pub async fn kitchen_print_ticket(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let printer_profile_id = parse_printer_profile_id_payload(arg0.as_ref(), None);
    let order_id = parse_order_id_payload(arg0)?;
    if !crate::print::is_print_action_enabled(&db, "kitchen_ticket") {
        return Ok(serde_json::json!({ "success": true, "skipped": true }));
    }
    let enqueue_result = print::enqueue_print_job(
        &db,
        "kitchen_ticket",
        &order_id,
        printer_profile_id.as_deref(),
        &app,
    )?;

    // Process the job immediately instead of waiting for the background worker.
    // Wave 11 Item 8 deferred follow-up: offload to `spawn_blocking` so the
    // sync SQLite + TCP I/O does not park the Tokio runtime worker. Clone
    // AppHandle so the inner closure can re-acquire `DbState` independently.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    print::spawn_pending_job_processing(
        app.clone(),
        data_dir,
        format!("kitchen ticket for order {order_id}"),
    );

    Ok(enqueue_result)
}

async fn run_print_list_jobs_blocking<F>(work: F) -> Result<serde_json::Value, String>
where
    F: FnOnce() -> Result<serde_json::Value, String> + Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => Err("Print queue snapshot worker panicked".to_string()),
        Err(_) => Err("Print queue snapshot worker was cancelled".to_string()),
    }
}

async fn run_printer_ipc_blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => Err("Printer command worker panicked".to_string()),
        Err(_) => Err("Printer command worker was cancelled".to_string()),
    }
}

async fn run_guarded_printer_ipc_blocking<F>(
    work: F,
) -> Result<serde_json::Value, auth::GuardedCommandError>
where
    F: FnOnce() -> Result<serde_json::Value, String> + Send + 'static,
{
    run_printer_ipc_blocking(work)
        .await
        .map_err(auth::GuardedCommandError::from)
}

#[tauri::command]
pub async fn print_list_jobs(
    arg0: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let (status, printer_profile_id, limit, offset) = parse_print_list_jobs_payload(arg0);
    run_print_list_jobs_blocking(move || {
        let db = app.state::<db::DbState>();
        serde_json::to_value(print::print_queue_snapshot(
            &db,
            status.as_deref(),
            printer_profile_id.as_deref(),
            limit,
            offset,
        )?)
        .map_err(|error| error.to_string())
    })
    .await
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
    run_printer_ipc_blocking(|| Ok(system_printers_response(printers::list_system_printers())))
        .await
}

#[tauri::command]
pub async fn printer_create_profile(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing printer profile payload")?;
    let has_confirmed_candidate = payload_has_confirmed_candidate(&payload);
    let payload = if has_confirmed_candidate {
        profile_payload_with_confirmed_candidate(payload)?
    } else {
        payload
    };
    if has_confirmed_candidate {
        printers::create_printer_profile_with_validated_capabilities(&db, &payload)
    } else {
        printers::create_printer_profile(&db, &payload)
    }
}

#[tauri::command]
pub async fn printer_update_profile(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing printer profile payload")?;
    let has_confirmed_candidate = payload_has_confirmed_candidate(&payload);
    let payload = if has_confirmed_candidate {
        profile_payload_with_confirmed_candidate(payload)?
    } else {
        payload
    };
    if has_confirmed_candidate {
        printers::update_printer_profile_with_validated_capabilities(&db, &payload)
    } else {
        printers::update_printer_profile(&db, &payload)
    }
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
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let job_id = parse_job_id_payload(arg0)?;
    run_print_queue_mutation_with_kick(
        app,
        move |db| execute_print_reprint_job(db, &job_id, Utc::now()),
        reprint_kick_job_id,
    )
    .await
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

fn profile_payload_with_confirmed_candidate(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let confirmed = payload
        .get("confirmedCandidateConnectionDetails")
        .or_else(|| payload.get("confirmed_candidate_connection_details"))
        .cloned();
    let is_frontend_payload = payload.get("connectionDetails").is_some()
        || payload.get("paperSize").is_some()
        || payload.get("type").is_some();
    let mut mapped = if is_frontend_payload {
        electron_to_profile_input(None, payload)
    } else {
        let mut flat = payload;
        if let Some(object) = flat.as_object_mut() {
            object.remove("confirmedCandidateConnectionDetails");
            object.remove("confirmed_candidate_connection_details");
        }
        flat
    };
    let Some(confirmed) = confirmed else {
        return Ok(mapped);
    };
    let confirmed = safe_confirmed_candidate_connection(&confirmed)?;
    let selected_target = printers::resolve_printer_target(&mapped)
        .map_err(|error| format!("Resolve selected printer candidate: {error}"))?;
    let confirmed_profile = profile_with_exact_connection(&mapped, &confirmed);
    let confirmed_target = printers::resolve_printer_target(&confirmed_profile)
        .map_err(|error| format!("Resolve confirmed printer candidate: {error}"))?;
    if !same_physical_candidate_target(&selected_target, &confirmed_target) {
        return Err(
            "confirmedCandidateConnectionDetails does not match the selected physical printer"
                .into(),
        );
    }
    if let Some(object) = mapped.as_object_mut() {
        object.insert(
            "connectionJson".to_string(),
            serde_json::json!(confirmed.to_string()),
        );
        if let Some(cut_paper) = confirmed
            .get("cutPaper")
            .and_then(serde_json::Value::as_bool)
        {
            object.insert("cutPaper".to_string(), serde_json::json!(cut_paper));
        }
        if let Some(code_page) = confirmed
            .get("escposCodePage")
            .and_then(serde_json::Value::as_u64)
        {
            object.insert("escposCodePage".to_string(), serde_json::json!(code_page));
        }
        if let Some(name) = confirmed
            .get("systemName")
            .or_else(|| confirmed.get("hostname"))
            .or_else(|| confirmed.get("ip"))
            .or_else(|| confirmed.get("address"))
            .or_else(|| confirmed.get("serialPort"))
            .and_then(serde_json::Value::as_str)
        {
            object.insert("printerName".to_string(), serde_json::json!(name));
        }
    }
    Ok(mapped)
}

fn payload_has_confirmed_candidate(payload: &serde_json::Value) -> bool {
    payload.get("confirmedCandidateConnectionDetails").is_some()
        || payload
            .get("confirmed_candidate_connection_details")
            .is_some()
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
    supports_cut: bool,
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

    let mut candidate = serde_json::json!({
        "status": "verified",
        "resolvedTransport": resolved_transport,
        "resolvedAddress": resolved_address,
        "emulation": emulation_mode_key(layout.emulation_mode),
        "renderMode": render_mode_key(layout.classic_customer_render_mode),
        "baudRate": baud_rate,
        "supportsCut": supports_cut,
        "supportsLogo": supports_logo,
        "lastVerifiedAt": chrono::Utc::now().to_rfc3339()
    });
    if let (Some(object), Some(code_page)) = (candidate.as_object_mut(), layout.escpos_code_page) {
        object.insert("escposCodePage".to_string(), serde_json::json!(code_page));
    }
    candidate
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
        if let Some(emulation) = candidate_capabilities.get("emulation").cloned() {
            connection_object.insert("emulation".to_string(), emulation);
        }
        if let Some(render_mode) = candidate_capabilities.get("renderMode").cloned() {
            connection_object.insert("render_mode".to_string(), render_mode);
        }
        if let Some(baud_rate) = candidate_capabilities.get("baudRate").cloned() {
            if !baud_rate.is_null() {
                connection_object.insert("baudRate".to_string(), baud_rate);
            }
        }
        if let Some(code_page) = candidate_capabilities
            .get("escposCodePage")
            .filter(|value| !value.is_null())
            .cloned()
        {
            connection_object.insert("escposCodePage".to_string(), code_page);
        }
        if let Some(supports_cut) = candidate_capabilities.get("supportsCut").cloned() {
            connection_object.insert("cutPaper".to_string(), supports_cut);
        }
        match candidate_capabilities
            .get("resolvedTransport")
            .and_then(serde_json::Value::as_str)
        {
            Some("windows_queue") => {
                connection_object.insert("type".to_string(), serde_json::json!("system"));
                if let Some(address) = candidate_capabilities.get("resolvedAddress").cloned() {
                    connection_object.insert("systemName".to_string(), address);
                }
            }
            Some("raw_tcp") => {
                connection_object.insert("type".to_string(), serde_json::json!("network"));
                if let Some(address) = candidate_capabilities
                    .get("resolvedAddress")
                    .and_then(serde_json::Value::as_str)
                {
                    if let Some((host, port)) = address.rsplit_once(':') {
                        connection_object.insert("ip".to_string(), serde_json::json!(host));
                        if let Ok(port) = port.parse::<u16>() {
                            connection_object.insert("port".to_string(), serde_json::json!(port));
                        }
                    }
                }
            }
            Some("serial") => {
                if let Some(address) = candidate_capabilities.get("resolvedAddress").cloned() {
                    connection_object.insert("serialPort".to_string(), address.clone());
                    connection_object.insert("path".to_string(), address);
                }
            }
            _ => {}
        }
        connection_object.insert("capabilities".to_string(), candidate_capabilities);
    }

    connection_details
}

fn validate_candidate_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    max_len: usize,
    required: bool,
) -> Result<Option<String>, String> {
    let Some(value) = object.get(key) else {
        return if required {
            Err(format!("confirmed candidate is missing {key}"))
        } else {
            Ok(None)
        };
    };
    let text = value
        .as_str()
        .ok_or_else(|| format!("confirmed candidate {key} must be a string"))?
        .trim();
    if text.is_empty() || text.len() > max_len {
        return Err(format!(
            "confirmed candidate {key} must contain 1 to {max_len} bytes"
        ));
    }
    Ok(Some(text.to_string()))
}

fn validate_candidate_enum(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    allowed: &[&str],
    required: bool,
) -> Result<Option<String>, String> {
    let value = validate_candidate_string(object, key, 64, required)?;
    if let Some(value) = value.as_deref() {
        if !allowed.contains(&value) {
            return Err(format!("confirmed candidate {key} is unsupported"));
        }
    }
    Ok(value)
}

fn candidate_bounded_integer(
    value: &serde_json::Value,
    key: &str,
    minimum: u64,
    maximum: u64,
) -> Result<u64, String> {
    let parsed = value.as_u64().or_else(|| {
        value
            .as_str()
            .and_then(|text| text.trim().parse::<u64>().ok())
    });
    let parsed = parsed.ok_or_else(|| {
        format!("confirmed candidate {key} must be an integer between {minimum} and {maximum}")
    })?;
    if !(minimum..=maximum).contains(&parsed) {
        return Err(format!(
            "confirmed candidate {key} must be between {minimum} and {maximum}"
        ));
    }
    Ok(parsed)
}

fn candidate_optional_bounded_integer(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    minimum: u64,
    maximum: u64,
) -> Result<Option<u64>, String> {
    object
        .get(key)
        .map(|value| candidate_bounded_integer(value, key, minimum, maximum))
        .transpose()
}

fn candidate_target_component_matches(left: &str, right: &str) -> bool {
    left.trim().to_lowercase() == right.trim().to_lowercase()
}

fn validate_candidate_target_evidence(
    connection: &serde_json::Map<String, serde_json::Value>,
    capabilities: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let transport = capabilities
        .get("resolvedTransport")
        .and_then(serde_json::Value::as_str)
        .ok_or("confirmed candidate is missing resolvedTransport")?;
    let resolved_address = capabilities
        .get("resolvedAddress")
        .and_then(serde_json::Value::as_str)
        .ok_or("confirmed candidate is missing resolvedAddress")?
        .trim();
    let connection_string = |keys: &[&str]| {
        keys.iter().find_map(|key| {
            connection
                .get(*key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
    };
    let connection_type = connection
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or("confirmed candidate is missing type")?;
    match transport {
        "windows_queue" => {
            if !matches!(connection_type, "system" | "usb" | "bluetooth" | "bt") {
                return Err("confirmed Windows candidate has an incompatible type".into());
            }
            let configured = connection_string(&["systemName"])
                .ok_or("confirmed Windows candidate is missing systemName")?;
            if !candidate_target_component_matches(configured, resolved_address) {
                return Err("confirmed Windows candidate target evidence does not match".into());
            }
            if !capabilities
                .get("baudRate")
                .is_some_and(serde_json::Value::is_null)
            {
                return Err("confirmed Windows candidate baudRate must be null".into());
            }
        }
        "raw_tcp" => {
            if !matches!(connection_type, "network" | "lan" | "wifi") {
                return Err("confirmed raw TCP candidate has an incompatible type".into());
            }
            let configured_host = connection_string(&["ip", "hostname", "host", "address"])
                .ok_or("confirmed network candidate is missing host/IP")?;
            let configured_port = connection
                .get("port")
                .ok_or_else(|| "confirmed network candidate is missing port".to_string())
                .and_then(|value| candidate_bounded_integer(value, "port", 1, 65_535))?;
            let (resolved_host, resolved_port) = resolved_address
                .rsplit_once(':')
                .ok_or("confirmed raw TCP address must include a port")?;
            let resolved_port = resolved_port
                .parse::<u64>()
                .map_err(|_| "confirmed raw TCP address has an invalid port")?;
            if !candidate_target_component_matches(configured_host, resolved_host)
                || configured_port != resolved_port
            {
                return Err("confirmed raw TCP candidate target evidence does not match".into());
            }
            if !capabilities
                .get("baudRate")
                .is_some_and(serde_json::Value::is_null)
            {
                return Err("confirmed raw TCP candidate baudRate must be null".into());
            }
        }
        "serial" => {
            if !matches!(connection_type, "usb" | "bluetooth" | "bt") {
                return Err("confirmed serial candidate has an incompatible type".into());
            }
            let configured =
                connection_string(&["serialPort", "path", "portName", "comPort", "address"])
                    .ok_or("confirmed serial candidate is missing a port")?;
            if !candidate_target_component_matches(configured, resolved_address) {
                return Err("confirmed serial candidate target evidence does not match".into());
            }
            let connection_baud = connection
                .get("baudRate")
                .ok_or_else(|| "confirmed serial candidate is missing baudRate".to_string())
                .and_then(|value| candidate_bounded_integer(value, "baudRate", 300, 4_000_000))?;
            let capability_baud = capabilities
                .get("baudRate")
                .filter(|value| !value.is_null())
                .ok_or_else(|| {
                    "confirmed serial candidate capabilities.baudRate must be non-null".to_string()
                })
                .and_then(|value| {
                    candidate_bounded_integer(value, "capabilities.baudRate", 300, 4_000_000)
                })?;
            if connection_baud != capability_baud {
                return Err("confirmed serial candidate baud evidence does not match".into());
            }
        }
        _ => return Err("confirmed candidate resolvedTransport is unsupported".into()),
    }
    Ok(())
}

fn validate_candidate_cross_field_evidence(
    connection: &serde_json::Map<String, serde_json::Value>,
    capabilities: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    for (connection_key, capability_key) in
        [("emulation", "emulation"), ("render_mode", "renderMode")]
    {
        let connection_value = connection
            .get(connection_key)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("confirmed candidate is missing {connection_key}"))?;
        let capability_value = capabilities
            .get(capability_key)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                format!("confirmed candidate is missing capabilities.{capability_key}")
            })?;
        if connection_value != capability_value {
            return Err(format!(
                "confirmed candidate {connection_key} contradicts capabilities.{capability_key}"
            ));
        }
    }

    let cut_paper = connection
        .get("cutPaper")
        .and_then(serde_json::Value::as_bool)
        .ok_or("confirmed candidate is missing cutPaper")?;
    let supports_cut = capabilities
        .get("supportsCut")
        .and_then(serde_json::Value::as_bool)
        .ok_or("confirmed candidate is missing capabilities.supportsCut")?;
    if cut_paper != supports_cut {
        return Err("confirmed candidate cutPaper contradicts capabilities.supportsCut".into());
    }

    let connection_code_page =
        candidate_optional_bounded_integer(connection, "escposCodePage", 0, 255)?;
    let capability_code_page =
        candidate_optional_bounded_integer(capabilities, "escposCodePage", 0, 255)?;
    if connection_code_page != capability_code_page {
        return Err(
            "confirmed candidate escposCodePage contradicts capabilities.escposCodePage".into(),
        );
    }
    Ok(())
}

fn safe_confirmed_candidate_connection(
    value: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let object = value
        .as_object()
        .ok_or("confirmedCandidateConnectionDetails must be an object")?;
    validate_candidate_enum(
        object,
        "type",
        &["system", "network", "lan", "wifi", "bluetooth", "bt", "usb"],
        true,
    )?;
    for key in [
        "systemName",
        "ip",
        "hostname",
        "host",
        "address",
        "path",
        "serialPort",
        "portName",
        "comPort",
    ] {
        validate_candidate_string(object, key, 1_024, false)?;
    }
    for key in ["vendorId", "productId"] {
        if let Some(value) = object.get(key) {
            match value {
                serde_json::Value::String(text) if !text.trim().is_empty() && text.len() <= 64 => {}
                serde_json::Value::Number(_) => {
                    candidate_bounded_integer(value, key, 0, 65_535)?;
                }
                _ => return Err(format!("confirmed candidate {key} is invalid")),
            }
        }
    }
    if let Some(value) = object.get("port") {
        candidate_bounded_integer(value, "port", 1, 65_535)?;
    }
    if let Some(value) = object.get("baudRate") {
        candidate_bounded_integer(value, "baudRate", 300, 4_000_000)?;
    }
    if let Some(value) = object.get("escposCodePage") {
        candidate_bounded_integer(value, "escposCodePage", 0, 255)?;
    }
    validate_candidate_enum(object, "emulation", &["auto", "escpos", "star_line"], true)?;
    validate_candidate_enum(object, "render_mode", &["text", "raster_exact"], true)?;
    if !object
        .get("cutPaper")
        .is_some_and(serde_json::Value::is_boolean)
    {
        return Err("confirmed candidate cutPaper must be a boolean".into());
    }

    let capabilities = object
        .get("capabilities")
        .and_then(serde_json::Value::as_object)
        .ok_or("confirmed candidate requires verified capabilities")?;
    validate_candidate_enum(capabilities, "status", &["verified", "degraded"], true)?;
    validate_candidate_enum(
        capabilities,
        "resolvedTransport",
        &["windows_queue", "raw_tcp", "serial"],
        true,
    )?;
    validate_candidate_string(capabilities, "resolvedAddress", 1_024, true)?;
    validate_candidate_enum(
        capabilities,
        "emulation",
        &["auto", "escpos", "star_line"],
        true,
    )?;
    validate_candidate_enum(capabilities, "renderMode", &["text", "raster_exact"], true)?;
    match capabilities.get("baudRate") {
        Some(value) if value.is_null() => {}
        Some(value) => {
            candidate_bounded_integer(value, "capabilities.baudRate", 300, 4_000_000)?;
        }
        None => return Err("confirmed candidate is missing capabilities.baudRate".into()),
    }
    if let Some(value) = capabilities.get("escposCodePage") {
        candidate_bounded_integer(value, "capabilities.escposCodePage", 0, 255)?;
    }
    for key in ["supportsCut", "supportsLogo"] {
        if !capabilities
            .get(key)
            .is_some_and(serde_json::Value::is_boolean)
        {
            return Err(format!(
                "confirmed candidate capabilities.{key} must be a boolean"
            ));
        }
    }
    let verified_at = validate_candidate_string(capabilities, "lastVerifiedAt", 64, true)?
        .expect("required timestamp was validated");
    DateTime::parse_from_rfc3339(&verified_at)
        .map_err(|_| "confirmed candidate lastVerifiedAt must be RFC 3339")?;
    validate_candidate_target_evidence(object, capabilities)?;
    validate_candidate_cross_field_evidence(object, capabilities)?;

    let mut safe = serde_json::Map::new();
    for key in [
        "type",
        "systemName",
        "ip",
        "hostname",
        "host",
        "port",
        "address",
        "path",
        "serialPort",
        "portName",
        "comPort",
        "vendorId",
        "productId",
        "render_mode",
        "emulation",
        "baudRate",
        "cutPaper",
        "escposCodePage",
    ] {
        if let Some(field) = object.get(key) {
            safe.insert(key.to_string(), field.clone());
        }
    }
    let mut safe_capabilities = serde_json::Map::new();
    for key in [
        "status",
        "resolvedTransport",
        "resolvedAddress",
        "emulation",
        "renderMode",
        "baudRate",
        "escposCodePage",
        "supportsCut",
        "supportsLogo",
        "lastVerifiedAt",
    ] {
        if let Some(field) = capabilities.get(key) {
            safe_capabilities.insert(key.to_string(), field.clone());
        }
    }
    safe.insert(
        "capabilities".to_string(),
        serde_json::Value::Object(safe_capabilities),
    );
    Ok(serde_json::Value::Object(safe))
}

fn profile_with_exact_connection(
    profile: &serde_json::Value,
    connection: &serde_json::Value,
) -> serde_json::Value {
    let mut updated = profile.clone();
    if let Some(object) = updated.as_object_mut() {
        object.insert(
            "connectionJson".to_string(),
            serde_json::json!(connection.to_string()),
        );
        if let Some(name) = connection
            .get("systemName")
            .or_else(|| connection.get("hostname"))
            .or_else(|| connection.get("ip"))
            .or_else(|| connection.get("address"))
            .or_else(|| connection.get("serialPort"))
            .and_then(serde_json::Value::as_str)
        {
            object.insert("printerName".to_string(), serde_json::json!(name));
        }
    }
    updated
}

fn same_physical_candidate_target(
    selected: &printers::ResolvedPrinterTarget,
    confirmed: &printers::ResolvedPrinterTarget,
) -> bool {
    print::wizard_physical_target_key(selected) == print::wizard_physical_target_key(confirmed)
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
    supports_cut: bool,
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
        "supportsCut": supports_cut,
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

fn profile_supports_cut(profile: &serde_json::Value) -> bool {
    let connection = profile_connection_details(profile);
    profile
        .get("cutPaper")
        .or_else(|| profile.get("cut_paper"))
        .and_then(serde_json::Value::as_bool)
        .or_else(|| {
            connection
                .get("cutPaper")
                .and_then(serde_json::Value::as_bool)
        })
        .or_else(|| {
            connection
                .get("capabilities")
                .and_then(|value| value.get("supportsCut"))
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(true)
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
    let supports_cut = profile_supports_cut(profile);

    let mut out = Vec::new();
    for target_candidate in target_candidates {
        for emulation in &emulations {
            for render_mode in &render_modes {
                out.push(VerificationCandidate {
                    target: target_candidate.clone(),
                    emulation: emulation.clone(),
                    render_mode: render_mode.clone(),
                    supports_cut,
                    supports_logo: sample_kind == "branding",
                });
            }
        }
    }
    out
}

fn build_sample_bytes(
    sample_kind: &WizardSampleKind,
    printer_label: &str,
    layout: &receipt_renderer::LayoutConfig,
    cut_paper: bool,
) -> Result<WizardSampleBuild, WizardSampleBuildError> {
    let logo_configured = layout.show_logo
        && layout
            .logo_url
            .as_deref()
            .map(str::trim)
            .is_some_and(|source| !source.is_empty());
    let mut sample = match sample_kind {
        WizardSampleKind::Encoding => Ok(WizardSampleBuild {
            bytes: build_encoding_sample(layout),
            logo_configured,
            logo_included: false,
        }),
        WizardSampleKind::Branding => build_branding_sample(printer_label, layout),
        WizardSampleKind::TransportText => Ok(WizardSampleBuild {
            bytes: build_transport_text_sample(printer_label, layout),
            logo_configured,
            logo_included: false,
        }),
    }?;
    if !cut_paper {
        remove_terminal_sample_cut(&mut sample.bytes);
    }
    Ok(sample)
}

fn remove_terminal_sample_cut(bytes: &mut Vec<u8>) {
    const ESCPOS_CUT: [u8; 4] = [0x1d, 0x56, 0x41, 0x10];
    const STAR_CUT: [u8; 3] = [0x1b, 0x64, 0x01];
    if bytes.ends_with(&ESCPOS_CUT) {
        bytes.truncate(bytes.len() - ESCPOS_CUT.len());
    } else if bytes.ends_with(&STAR_CUT) {
        bytes.truncate(bytes.len() - STAR_CUT.len());
    }
}

#[derive(Default)]
struct ConfiguredPrinterLookup {
    names: HashSet<String>,
    addresses: HashSet<String>,
}

struct BlockingDiscoverySnapshot {
    configured: ConfiguredPrinterLookup,
    system_printer_names: Vec<String>,
    usb_serial: Vec<serde_json::Value>,
    bluetooth: Vec<serde_json::Value>,
    local_ips: Vec<std::net::Ipv4Addr>,
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

fn resolve_profile_connection_state_with_probe<P>(
    profile: &serde_json::Value,
    probe: &P,
) -> (Option<printers::ResolvedPrinterTarget>, bool, &'static str)
where
    P: Fn(&printers::ResolvedPrinterTarget) -> Result<(), String>,
{
    match printers::resolve_printer_target(profile) {
        Ok(target) => {
            let connected = probe(&target).is_ok();
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

#[cfg(test)]
fn resolve_profile_connection_state(
    profile: &serde_json::Value,
) -> (Option<printers::ResolvedPrinterTarget>, bool, &'static str) {
    resolve_profile_connection_state_with_probe(profile, &printers::probe_printer_target)
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

#[cfg(not(target_os = "windows"))]
fn detect_local_ipv4s() -> Vec<std::net::Ipv4Addr> {
    vec![]
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
async fn discover_lan_printers_from_local_ips(
    configured: &ConfiguredPrinterLookup,
    local_ips: Vec<std::net::Ipv4Addr>,
) -> Vec<serde_json::Value> {
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
async fn discover_lan_printers_from_local_ips(
    _configured: &ConfiguredPrinterLookup,
    _local_ips: Vec<std::net::Ipv4Addr>,
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

fn collect_printer_status_map_with_probe<P>(
    db: &db::DbState,
    probe: P,
) -> Result<serde_json::Map<String, serde_json::Value>, String>
where
    P: Fn(&printers::ResolvedPrinterTarget) -> Result<(), String>,
{
    let profiles = printers::list_printer_profiles(db)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut status_map = serde_json::Map::new();
    if let Some(arr) = profiles.as_array() {
        for profile in arr {
            let printer_id = value_str(profile, &["id"]).unwrap_or_default();
            let (target, connected, state) =
                resolve_profile_connection_state_with_probe(profile, &probe);
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

fn collect_printer_status_map(
    db: &db::DbState,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    collect_printer_status_map_with_probe(db, printers::probe_printer_target)
}

fn hash_status_map(status_map: &serde_json::Map<String, serde_json::Value>) -> u64 {
    let mut hasher = DefaultHasher::new();
    // JSON object key order is deterministic for Map insertion sequence,
    // but we hash a canonicalized string payload to avoid accidental drift.
    let serialized = serde_json::to_string(status_map).unwrap_or_default();
    serialized.hash(&mut hasher);
    hasher.finish()
}

fn printer_status_snapshot_event(
    statuses: serde_json::Map<String, serde_json::Value>,
    updated_at: &str,
) -> serde_json::Value {
    serde_json::json!({
        "status": "snapshot",
        "statuses": statuses,
        "updatedAt": updated_at
    })
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
            let db_for_snapshot = Arc::clone(&db);
            match run_printer_ipc_blocking(move || {
                collect_printer_status_map(db_for_snapshot.as_ref())
            })
            .await
            {
                Ok(statuses) => {
                    let current_hash = hash_status_map(&statuses);
                    if last_hash != Some(current_hash) {
                        last_hash = Some(current_hash);
                        let _ = app.emit(
                            "printer_status_changed",
                            printer_status_snapshot_event(
                                statuses,
                                &chrono::Utc::now().to_rfc3339(),
                            ),
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

fn collect_discovery_blocking_with_sources<S, U, B, R, L>(
    db: &db::DbState,
    wants_system_like: bool,
    wants_bluetooth: bool,
    list_system: S,
    list_usb_serial: U,
    discover_bluetooth: B,
    list_bluetooth_serial: R,
    detect_local_ips: L,
) -> Result<BlockingDiscoverySnapshot, String>
where
    S: FnOnce() -> Vec<String>,
    U: FnOnce(&ConfiguredPrinterLookup) -> Vec<serde_json::Value>,
    B: FnOnce(&ConfiguredPrinterLookup) -> Result<Vec<serde_json::Value>, String>,
    R: FnOnce(&ConfiguredPrinterLookup) -> Vec<serde_json::Value>,
    L: FnOnce() -> Vec<std::net::Ipv4Addr>,
{
    let configured = configured_printer_lookup(db);
    let (system_printer_names, usb_serial, local_ips) = if wants_system_like {
        (
            list_system(),
            list_usb_serial(&configured),
            detect_local_ips(),
        )
    } else {
        (vec![], vec![], vec![])
    };
    let bluetooth = if wants_bluetooth {
        let mut discovered = discover_bluetooth(&configured)?;
        discovered.extend(list_bluetooth_serial(&configured));
        dedupe_discovered_printers(discovered)
    } else {
        vec![]
    };

    Ok(BlockingDiscoverySnapshot {
        configured,
        system_printer_names,
        usb_serial,
        bluetooth,
        local_ips,
    })
}

fn collect_discovery_blocking(
    db: &db::DbState,
    wants_system_like: bool,
    wants_bluetooth: bool,
) -> Result<BlockingDiscoverySnapshot, String> {
    collect_discovery_blocking_with_sources(
        db,
        wants_system_like,
        wants_bluetooth,
        printers::list_system_printers,
        |configured| discover_serial_printers_native(configured, true, false),
        discover_bluetooth_printers_native,
        |configured| discover_serial_printers_native(configured, false, true),
        detect_local_ipv4s,
    )
}

fn system_printers_response(names: Vec<String>) -> serde_json::Value {
    serde_json::json!({
        "success": true,
        "printers": names,
    })
}

fn system_discovery_entries(
    names: Vec<String>,
    configured: &ConfiguredPrinterLookup,
    include_port: bool,
) -> Vec<serde_json::Value> {
    names
        .into_iter()
        .map(|name| {
            let address = name.clone();
            let mut row = serde_json::json!({
                "name": name,
                "type": "system",
                "address": address,
                "model": serde_json::Value::Null,
                "manufacturer": "system",
                "isConfigured": is_configured_discovery_entry(configured, &name, &address)
            });
            if include_port {
                row.as_object_mut()
                    .expect("system discovery row must be an object")
                    .insert("port".into(), serde_json::Value::Null);
            }
            row
        })
        .collect()
}

fn network_scan_response(
    snapshot: BlockingDiscoverySnapshot,
    lan_printers: Vec<serde_json::Value>,
) -> serde_json::Value {
    let mut discovered =
        system_discovery_entries(snapshot.system_printer_names, &snapshot.configured, false);
    discovered.extend(snapshot.usb_serial);
    discovered.extend(lan_printers);
    serde_json::json!({
        "success": true,
        "printers": dedupe_discovered_printers(discovered),
        "type": "network"
    })
}

fn bluetooth_scan_response(snapshot: BlockingDiscoverySnapshot) -> serde_json::Value {
    let printers = dedupe_discovered_printers(snapshot.bluetooth);
    let message = if cfg!(target_os = "windows") {
        if printers.is_empty() {
            "No paired Bluetooth devices found".to_string()
        } else {
            format!("Discovered {} Bluetooth device(s)", printers.len())
        }
    } else {
        "Bluetooth native scan is currently supported on Windows only".to_string()
    };
    serde_json::json!({
        "success": true,
        "printers": printers,
        "type": "bluetooth",
        "message": message
    })
}

fn printer_discover_response(
    snapshot: BlockingDiscoverySnapshot,
    lan_printers: Vec<serde_json::Value>,
    wants_system_like: bool,
    wants_bluetooth: bool,
) -> serde_json::Value {
    let mut out = Vec::new();
    if wants_system_like {
        out.extend(system_discovery_entries(
            snapshot.system_printer_names,
            &snapshot.configured,
            true,
        ));
        out.extend(snapshot.usb_serial);
        out.extend(lan_printers);
    }
    if wants_bluetooth {
        info!(
            bluetooth_candidates = snapshot.bluetooth.len(),
            "printer_discover native bluetooth scan result"
        );
        out.extend(snapshot.bluetooth);
    }
    let deduped = dedupe_discovered_printers(out);
    info!(result_count = deduped.len(), "printer_discover completed");
    serde_json::json!({ "success": true, "printers": deduped })
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
    _db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let worker_app = app.clone();
    let mut snapshot = run_printer_ipc_blocking(move || {
        let db = worker_app.state::<db::DbState>();
        collect_discovery_blocking(&db, true, false)
    })
    .await?;
    let local_ips = std::mem::take(&mut snapshot.local_ips);
    let lan_printers = discover_lan_printers_from_local_ips(&snapshot.configured, local_ips).await;
    Ok(network_scan_response(snapshot, lan_printers))
}

#[tauri::command]
pub async fn printer_scan_bluetooth(
    _db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let worker_app = app.clone();
    let snapshot = run_printer_ipc_blocking(move || {
        let db = worker_app.state::<db::DbState>();
        collect_discovery_blocking(&db, false, true)
    })
    .await?;
    Ok(bluetooth_scan_response(snapshot))
}

#[tauri::command]
pub async fn printer_discover(
    arg0: Option<serde_json::Value>,
    _db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let requested = parse_printer_discover_types(arg0);
    info!(
        requested_types = ?requested,
        "printer_discover requested"
    );
    let wants_system_like = should_discover_system_like(&requested);
    let wants_bluetooth = should_discover_bluetooth(&requested);

    let worker_app = app.clone();
    let mut snapshot = run_printer_ipc_blocking(move || {
        let db = worker_app.state::<db::DbState>();
        collect_discovery_blocking(&db, wants_system_like, wants_bluetooth)
    })
    .await?;
    let lan_printers = if wants_system_like {
        let local_ips = std::mem::take(&mut snapshot.local_ips);
        discover_lan_printers_from_local_ips(&snapshot.configured, local_ips).await
    } else {
        vec![]
    };
    Ok(printer_discover_response(
        snapshot,
        lan_printers,
        wants_system_like,
        wants_bluetooth,
    ))
}

#[tauri::command]
pub async fn printer_add(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let has_confirmed_candidate = payload_has_confirmed_candidate(&payload);
    let payload = profile_payload_with_confirmed_candidate(payload)?;
    let created = if has_confirmed_candidate {
        printers::create_printer_profile_with_validated_capabilities(&db, &payload)?
    } else {
        printers::create_printer_profile(&db, &payload)?
    };
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
    let has_confirmed_candidate = payload_has_confirmed_candidate(&parsed.updates);
    let mut payload = if has_confirmed_candidate {
        profile_payload_with_confirmed_candidate(parsed.updates)?
    } else {
        electron_to_profile_input(Some(printer_id.clone()), parsed.updates)
    };
    if let Some(object) = payload.as_object_mut() {
        object.insert("id".to_string(), serde_json::json!(printer_id.clone()));
    }
    if has_confirmed_candidate {
        let _ = printers::update_printer_profile_with_validated_capabilities(&db, &payload)?;
    } else {
        let _ = printers::update_printer_profile(&db, &payload)?;
    }
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

fn execute_printer_get_status_with_probe<P>(
    db: &db::DbState,
    printer_id: &str,
    probe: P,
) -> Result<serde_json::Value, String>
where
    P: Fn(&printers::ResolvedPrinterTarget) -> Result<(), String>,
{
    let profile = printers::get_printer_profile(db, printer_id)?;
    let printer_name = value_str(&profile, &["printerName", "printer_name"]).unwrap_or_default();
    let (target, connected, state) = resolve_profile_connection_state_with_probe(&profile, &probe);
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

fn execute_printer_get_status(
    db: &db::DbState,
    printer_id: &str,
) -> Result<serde_json::Value, String> {
    execute_printer_get_status_with_probe(db, printer_id, printers::probe_printer_target)
}

#[tauri::command]
pub async fn printer_get_status(
    arg0: Option<serde_json::Value>,
    _db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let worker_app = app.clone();
    run_printer_ipc_blocking(move || {
        let db = worker_app.state::<db::DbState>();
        execute_printer_get_status(&db, &printer_id)
    })
    .await
}

#[tauri::command]
pub async fn printer_get_all_statuses(
    _db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let worker_app = app.clone();
    run_printer_ipc_blocking(move || {
        let db = worker_app.state::<db::DbState>();
        let status_map = collect_printer_status_map(&db)?;
        Ok(serde_json::json!({ "success": true, "statuses": status_map }))
    })
    .await
}

#[tauri::command]
pub async fn printer_submit_job(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
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
            &app,
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

fn take_print_queue_durable_changed(result: &mut serde_json::Value) -> bool {
    result
        .as_object_mut()
        .and_then(|object| object.remove("durableChanged"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn serialize_print_history_mutation(
    result: Result<print_history::PrintHistoryMutationResult, String>,
) -> Result<serde_json::Value, String> {
    let result = result?;
    let mut value = serde_json::to_value(result)
        .map_err(|error| format!("Serialize print history mutation result: {error}"))?;
    let _ = value
        .as_object_mut()
        .ok_or_else(|| "Print history mutation result did not serialize as an object".to_string())?
        .insert("success".into(), serde_json::Value::Bool(true));
    Ok(value)
}

fn execute_print_reprint_job(
    db: &db::DbState,
    job_id: &str,
    now: DateTime<Utc>,
) -> Result<serde_json::Value, String> {
    serialize_print_history_mutation(print_history::clone_reprint_job(db, job_id, now))
}

fn execute_printer_retry_job(
    db: &db::DbState,
    job_id: &str,
    now: DateTime<Utc>,
) -> Result<serde_json::Value, String> {
    serialize_print_history_mutation(print_history::retry_failed_print_job(db, job_id, now))
}

fn retry_kick_job_id(result: &serde_json::Value) -> Option<String> {
    result
        .get("jobId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn reprint_kick_job_id(result: &serde_json::Value) -> Option<String> {
    result
        .get("newJobId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn finish_print_queue_mutation<S, I, K>(
    mutation_result: Result<serde_json::Value, String>,
    select_kick_job: S,
    invalidate: I,
    kick: K,
) -> Result<serde_json::Value, String>
where
    S: FnOnce(&serde_json::Value) -> Option<String>,
    I: FnOnce(),
    K: FnOnce(&str),
{
    let mut result = mutation_result?;
    let affected = result.get("affected").and_then(serde_json::Value::as_u64) == Some(1);
    let kick_job_id = select_kick_job(&result);
    let durable_changed = take_print_queue_durable_changed(&mut result);
    if durable_changed {
        invalidate();
    }
    if durable_changed && affected {
        if let Some(job_id) = kick_job_id.as_deref() {
            kick(job_id);
        }
    }
    Ok(result)
}

fn spawn_print_history_job_processing(app: &tauri::AppHandle, job_id: &str) {
    match app.path().app_data_dir() {
        Ok(data_dir) => print::spawn_pending_job_processing(
            app.clone(),
            data_dir,
            format!("print history job {job_id}"),
        ),
        Err(error) => warn!(
            job_id = %job_id,
            error = %error,
            "Unable to kick managed processing for print history job"
        ),
    }
}

async fn run_print_queue_mutation_with_kick<F, S>(
    app: tauri::AppHandle,
    mutation: F,
    select_kick_job: S,
) -> Result<serde_json::Value, String>
where
    F: FnOnce(&db::DbState) -> Result<serde_json::Value, String> + Send + 'static,
    S: FnOnce(&serde_json::Value) -> Option<String> + Send + 'static,
{
    let worker_app = app.clone();
    let mutation_result = tokio::task::spawn_blocking(move || {
        let db = worker_app.state::<db::DbState>();
        mutation(&db)
    })
    .await
    .map_err(|error| format!("Print queue mutation worker failed: {error}"))?;

    finish_print_queue_mutation(
        mutation_result,
        select_kick_job,
        || {
            // Invalidation only: consumers must reload the typed SQLite snapshot.
            print::notify_print_queue_changed(&app);
        },
        |job_id| spawn_print_history_job_processing(&app, job_id),
    )
}

async fn run_print_queue_mutation<F>(
    app: tauri::AppHandle,
    mutation: F,
) -> Result<serde_json::Value, String>
where
    F: FnOnce(&db::DbState) -> Result<serde_json::Value, String> + Send + 'static,
{
    run_print_queue_mutation_with_kick(app, mutation, |_| None).await
}

#[tauri::command]
pub async fn printer_cancel_job(
    arg0: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let job_id = parse_job_id_payload(arg0)?;
    run_print_queue_mutation(app, move |db| print::cancel_print_job(db, &job_id)).await
}

#[tauri::command]
pub async fn printer_pause_queue(
    arg0: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_print_queue_control_payload(arg0)?;
    run_print_queue_mutation(app, move |db| {
        print::set_print_queue_paused(db, payload.printer_profile_id.as_deref(), true)
    })
    .await
}

#[tauri::command]
pub async fn printer_resume_queue(
    arg0: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_print_queue_control_payload(arg0)?;
    run_print_queue_mutation(app, move |db| {
        print::set_print_queue_paused(db, payload.printer_profile_id.as_deref(), false)
    })
    .await
}

#[tauri::command]
pub async fn printer_cancel_all_jobs(
    arg0: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_print_queue_control_payload(arg0)?;
    run_print_queue_mutation(app, move |db| {
        print::pause_and_cancel_pos_jobs(
            db,
            payload.printer_profile_id.as_deref(),
            Some(payload.statuses.as_slice()),
        )
    })
    .await
}

#[tauri::command]
pub async fn printer_retry_job(
    arg0: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let job_id = parse_job_id_payload(arg0)?;
    run_print_queue_mutation_with_kick(
        app,
        move |db| execute_printer_retry_job(db, &job_id, Utc::now()),
        retry_kick_job_id,
    )
    .await
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
) -> Result<WizardSampleBuild, WizardSampleBuildError> {
    if !layout.show_logo
        || !layout
            .logo_url
            .as_deref()
            .map(str::trim)
            .is_some_and(|source| !source.is_empty())
    {
        return Err(WizardSampleBuildError::new(
            "logo_not_configured",
            "A configured and enabled logo is required for the branding sample",
        ));
    }
    let prefix = crate::print::build_logo_prefix_for_layout(layout)
        .map_err(|error| {
            WizardSampleBuildError::new("logo_render_failed", error).with_logo_state(true, false)
        })?
        .filter(|prefix| !prefix.is_empty())
        .ok_or_else(|| {
            WizardSampleBuildError::new(
                "logo_render_failed",
                "Logo rendering returned no raster bytes",
            )
            .with_logo_state(true, false)
        })?;
    let body = build_transport_text_sample(printer_label, layout);
    let mut bytes = Vec::with_capacity(prefix.len() + body.len() + 1);
    bytes.extend_from_slice(&prefix);
    bytes.push(0x0A);
    bytes.extend_from_slice(&body);
    Ok(WizardSampleBuild {
        bytes,
        logo_configured: true,
        logo_included: true,
    })
}

struct PreparedWizardSample {
    target: printers::ResolvedPrinterTarget,
    layout: receipt_renderer::LayoutConfig,
    sample: WizardSampleBuild,
    candidate_capabilities: serde_json::Value,
    candidate_connection_details: serde_json::Value,
}

fn prepare_wizard_sample(
    db: &db::DbState,
    base_profile: &serde_json::Value,
    base_target: &printers::ResolvedPrinterTarget,
    printer_label: &str,
    sample_kind: &WizardSampleKind,
    probe_attempt: usize,
    confirmed_connection: Option<&serde_json::Value>,
) -> Result<PreparedWizardSample, WizardSampleBuildError> {
    let candidate = if let Some(confirmed_connection) = confirmed_connection {
        let confirmed_connection = safe_confirmed_candidate_connection(confirmed_connection)
            .map_err(|error| WizardSampleBuildError::new("candidate_invalid", error))?;
        let confirmed_profile = profile_with_exact_connection(base_profile, &confirmed_connection);
        let confirmed_target = printers::resolve_printer_target(&confirmed_profile)
            .map_err(|error| WizardSampleBuildError::new("candidate_invalid", error))?;
        if !same_physical_candidate_target(base_target, &confirmed_target) {
            return Err(WizardSampleBuildError::new(
                "candidate_mismatch",
                "The confirmed candidate does not match the selected physical printer",
            ));
        }
        VerificationCandidate {
            target: confirmed_target,
            emulation: value_str(&confirmed_connection, &["emulation"])
                .unwrap_or_else(|| "auto".to_string()),
            render_mode: value_str(&confirmed_connection, &["render_mode", "renderMode"])
                .unwrap_or_else(|| "text".to_string()),
            supports_cut: confirmed_connection
                .get("capabilities")
                .and_then(|value| value.get("supportsCut"))
                .and_then(serde_json::Value::as_bool)
                .or_else(|| {
                    confirmed_connection
                        .get("cutPaper")
                        .and_then(serde_json::Value::as_bool)
                })
                .unwrap_or_else(|| profile_supports_cut(base_profile)),
            supports_logo: confirmed_connection
                .get("capabilities")
                .and_then(|value| value.get("supportsLogo"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        }
    } else {
        let candidates =
            verification_candidates_for_profile(base_profile, base_target, sample_kind.as_str());
        if candidates.is_empty() {
            return Err(WizardSampleBuildError::new(
                "candidate_unavailable",
                "No verification candidates available for this printer",
            ));
        }
        candidates.get(probe_attempt).cloned().ok_or_else(|| {
            WizardSampleBuildError::new(
                "candidate_exhausted",
                "No additional protocol candidates remain. Open Expert Settings to adjust transport or emulation manually.",
            )
        })?
    };
    let mut candidate_profile = profile_with_candidate_capabilities(
        base_profile,
        &candidate.target,
        &candidate.emulation,
        &candidate.render_mode,
        candidate.supports_cut,
        candidate.supports_logo,
    );
    let mut layout = print::resolve_layout_config(db, &candidate_profile, "order_receipt")
        .map_err(|error| WizardSampleBuildError::new("sample_prepare_failed", error))?;
    if matches!(sample_kind, WizardSampleKind::Encoding)
        && layout.character_set.eq_ignore_ascii_case("PC737_GREEK")
    {
        let code_page =
            if receipt_renderer::uses_star_commands(layout.detected_brand, layout.emulation_mode) {
                15
            } else {
                14
            };
        if let Some(profile) = candidate_profile.as_object_mut() {
            profile.insert("escposCodePage".to_string(), serde_json::json!(code_page));
        }
        layout = print::resolve_layout_config(db, &candidate_profile, "order_receipt")
            .map_err(|error| WizardSampleBuildError::new("sample_prepare_failed", error))?;
    }
    let sample = build_sample_bytes(sample_kind, printer_label, &layout, candidate.supports_cut)?;
    let candidate_capabilities = capability_candidate_json(
        &candidate.target,
        &layout,
        candidate.supports_cut,
        sample.logo_included,
    );
    let candidate_connection_details =
        safe_confirmed_candidate_connection(&merge_candidate_capabilities_into_connection(
            &candidate_profile,
            candidate_capabilities.clone(),
        ))
        .map_err(|error| WizardSampleBuildError::new("candidate_invalid", error))?;
    Ok(PreparedWizardSample {
        target: candidate.target,
        layout,
        sample,
        candidate_capabilities,
        candidate_connection_details,
    })
}

fn managed_test_print_request(
    profile: &serde_json::Value,
    prepared: PreparedWizardSample,
    sample_kind: &WizardSampleKind,
    wizard_session_id: &str,
    saved_profile_id: Option<&str>,
) -> print::PreRenderedTestPrint {
    let profile_name = value_str(profile, &["name", "printerName", "printer_name"])
        .unwrap_or_else(|| prepared.target.label());
    let effective_profile_id = saved_profile_id
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("wizard-draft-{wizard_session_id}"));
    let driver_type = value_str(profile, &["driverType", "driver_type"]).unwrap_or_else(|| {
        if matches!(
            prepared.target,
            printers::ResolvedPrinterTarget::WindowsQueue { .. }
        ) {
            "windows".to_string()
        } else {
            "escpos".to_string()
        }
    });
    let cut_paper = prepared
        .candidate_capabilities
        .get("supportsCut")
        .and_then(serde_json::Value::as_bool)
        .or_else(|| {
            prepared
                .candidate_connection_details
                .get("cutPaper")
                .and_then(serde_json::Value::as_bool)
        })
        .or_else(|| {
            profile
                .get("cutPaper")
                .or_else(|| profile.get("cut_paper"))
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(true);
    print::PreRenderedTestPrint {
        wizard_session_id: wizard_session_id.to_string(),
        sample_kind: sample_kind.as_str().to_string(),
        effective_profile_id,
        effective_profile_name: profile_name,
        saved_profile_id: saved_profile_id.map(ToString::to_string),
        target: prepared.target,
        bytes: prepared.sample.bytes,
        layout: prepared.layout,
        candidate_connection_details: prepared.candidate_connection_details,
        candidate_capabilities: prepared.candidate_capabilities,
        driver_type,
        cut_paper,
        logo_configured: prepared.sample.logo_configured,
        logo_included: prepared.sample.logo_included,
    }
}

fn finish_wizard_print_enqueue<N, K>(
    result: Result<print::PreRenderedTestPrintOutcome, String>,
    notify: N,
    kick: K,
) -> Result<WizardPrintResponse, String>
where
    N: FnOnce(),
    K: FnOnce(&str),
{
    let outcome = result?;
    if !outcome.duplicate {
        notify();
        kick(&outcome.job_id);
    }
    Ok(WizardPrintResponse::queued(outcome))
}

fn execute_saved_profile_test_enqueue(
    db: &db::DbState,
    printer_id: &str,
    sample_kind: WizardSampleKind,
    wizard_session_id: &str,
) -> Result<print::PreRenderedTestPrintOutcome, String> {
    let profile = printers::get_printer_profile(db, printer_id)?;
    let target = printers::resolve_printer_target(&profile)?;
    let printer_label =
        value_str(&profile, &["printerName", "printer_name"]).unwrap_or_else(|| target.label());
    let prepared =
        prepare_wizard_sample(db, &profile, &target, &printer_label, &sample_kind, 0, None)
            .map_err(|error| format!("{}: {error}", error.code()))?;
    print::enqueue_pre_rendered_test_print(
        db,
        managed_test_print_request(
            &profile,
            prepared,
            &sample_kind,
            wizard_session_id,
            Some(printer_id),
        ),
    )
}

fn execute_greek_compatibility_enqueue(
    db: &db::DbState,
    printer_id: &str,
    wizard_session_id: &str,
) -> Result<print::PreRenderedTestPrintOutcome, String> {
    execute_saved_profile_test_enqueue(
        db,
        printer_id,
        WizardSampleKind::Encoding,
        wizard_session_id,
    )
}

enum DraftWizardEnqueue {
    Queued(print::PreRenderedTestPrintOutcome),
    Rejected(WizardPrintResponse),
}

fn execute_draft_profile_test_enqueue(
    db: &db::DbState,
    payload: PrinterTestDraftPayload,
) -> Result<DraftWizardEnqueue, String> {
    let profile = normalize_draft_profile_payload(payload.profile_draft)?;
    let printer_name = value_str(&profile, &["printerName", "printer_name"]).unwrap_or_default();
    let target = printers::resolve_printer_target(&profile)?;
    let printer_label = if printer_name.is_empty() {
        target.label()
    } else {
        printer_name
    };
    let prepared = match prepare_wizard_sample(
        db,
        &profile,
        &target,
        &printer_label,
        &payload.sample_kind,
        payload.probe_attempt,
        payload.confirmed_candidate_connection_details.as_ref(),
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            return Ok(DraftWizardEnqueue::Rejected(WizardPrintResponse::rejected(
                printer_label,
                payload.sample_kind,
                &target,
                error,
            )));
        }
    };
    let request = managed_test_print_request(
        &profile,
        prepared,
        &payload.sample_kind,
        payload.wizard_session_id.trim(),
        None,
    );
    print::enqueue_pre_rendered_test_print(db, request).map(DraftWizardEnqueue::Queued)
}

#[tauri::command]
pub async fn printer_test_draft(
    arg0: Option<serde_json::Value>,
    _db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<WizardPrintResponse, String> {
    let payload: PrinterTestDraftPayload =
        serde_json::from_value(arg0.ok_or("Missing printer wizard sample payload")?)
            .map_err(|error| format!("Invalid printer wizard sample payload: {error}"))?;
    if payload.wizard_session_id.trim().is_empty() || payload.wizard_session_id.len() > 128 {
        return Err("wizardSessionId must contain 1 to 128 bytes".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data dir: {error}"))?;
    let worker_app = app.clone();
    let result = run_printer_ipc_blocking(move || {
        let db = worker_app.state::<db::DbState>();
        execute_draft_profile_test_enqueue(&db, payload)
    })
    .await?;
    let result = match result {
        DraftWizardEnqueue::Queued(result) => result,
        DraftWizardEnqueue::Rejected(response) => return Ok(response),
    };
    let app_for_notify = app.clone();
    let app_for_kick = app.clone();
    finish_wizard_print_enqueue(
        Ok(result),
        move || print::notify_print_queue_changed(&app_for_notify),
        move |job_id| {
            print::spawn_pending_job_processing(
                app_for_kick,
                data_dir,
                format!("printer wizard sample {job_id}"),
            )
        },
    )
}

#[tauri::command]
pub async fn printer_test(
    arg0: Option<serde_json::Value>,
    _db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<WizardPrintResponse, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data dir: {error}"))?;
    let wizard_session_id = format!("saved-profile-{}", uuid::Uuid::new_v4());
    let worker_app = app.clone();
    let result = run_printer_ipc_blocking(move || {
        let db = worker_app.state::<db::DbState>();
        execute_saved_profile_test_enqueue(
            &db,
            &printer_id,
            WizardSampleKind::TransportText,
            &wizard_session_id,
        )
    })
    .await;
    let app_for_notify = app.clone();
    let app_for_kick = app.clone();
    finish_wizard_print_enqueue(
        result,
        move || print::notify_print_queue_changed(&app_for_notify),
        move |job_id| {
            print::spawn_pending_job_processing(
                app_for_kick,
                data_dir,
                format!("saved printer test {job_id}"),
            )
        },
    )
}

#[tauri::command]
pub async fn printer_test_greek_direct(
    arg0: Option<serde_json::Value>,
    _db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<WizardPrintResponse, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data dir: {error}"))?;
    let wizard_session_id = format!("greek-direct-{}", uuid::Uuid::new_v4());
    let worker_app = app.clone();
    let result = run_printer_ipc_blocking(move || {
        let db = worker_app.state::<db::DbState>();
        execute_greek_compatibility_enqueue(&db, &printer_id, &wizard_session_id)
    })
    .await;
    let app_for_notify = app.clone();
    let app_for_kick = app.clone();
    finish_wizard_print_enqueue(
        result,
        move || print::notify_print_queue_changed(&app_for_notify),
        move |job_id| {
            print::spawn_pending_job_processing(
                app_for_kick,
                data_dir,
                format!("Greek printer compatibility sample {job_id}"),
            )
        },
    )
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

fn execute_printer_diagnostics_with_probe<P>(
    db: &db::DbState,
    printer_id: &str,
    probe: P,
) -> Result<serde_json::Value, String>
where
    P: Fn(&printers::ResolvedPrinterTarget) -> Result<(), String>,
{
    let profile = printers::get_printer_profile(db, printer_id)?;
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
    let (target, connected, state) = resolve_profile_connection_state_with_probe(&profile, &probe);
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

fn execute_printer_diagnostics(
    db: &db::DbState,
    printer_id: &str,
) -> Result<serde_json::Value, String> {
    execute_printer_diagnostics_with_probe(db, printer_id, printers::probe_printer_target)
}

#[tauri::command]
pub async fn printer_diagnostics(
    arg0: Option<serde_json::Value>,
    _db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let worker_app = app.clone();
    run_printer_ipc_blocking(move || {
        let db = worker_app.state::<db::DbState>();
        execute_printer_diagnostics(&db, &printer_id)
    })
    .await
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
    let worker_app = app.clone();
    let worker_printer_id = printer_id.clone();
    let result = run_guarded_printer_ipc_blocking(move || {
        let db = worker_app.state::<db::DbState>();
        drawer::open_cash_drawer(&db, worker_printer_id.as_deref())
    })
    .await?;
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
        platform_slip: None,
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

fn preview_u32_field(value: &serde_json::Value, keys: &[&str]) -> Option<u32> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|entry| {
            entry
                .as_u64()
                .or_else(|| {
                    entry
                        .as_str()
                        .and_then(|text| text.trim().parse::<u64>().ok())
                })
                .map(|number| number as u32)
        })
}

fn preview_body_font_weight(level: u32) -> u32 {
    match level.clamp(1, 5) {
        2 => 500,
        3 => 600,
        4 => 700,
        5 => 800,
        _ => 400,
    }
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
    if let Some(layout_density_scale_override) =
        preview_f32_field(settings, &["layoutDensityScale", "layout_density_scale"])
            .or_else(|| preview_f32_field(payload, &["layoutDensityScale", "layout_density_scale"]))
    {
        layout.layout_density_scale = layout_density_scale_override.clamp(0.7, 1.35);
    }
    if let Some(body_boldness_override) =
        preview_u32_field(settings, &["bodyBoldness", "body_boldness"])
            .or_else(|| preview_u32_field(payload, &["bodyBoldness", "body_boldness"]))
    {
        layout.body_font_weight = preview_body_font_weight(body_boldness_override);
    }

    let logo_supported = printers::read_capability_snapshot(profile).supports_logo
        || matches!(
            layout.detected_brand,
            crate::printers::PrinterBrand::Star | crate::printers::PrinterBrand::Epson
        );
    let raster_exact_receipt_logo = layout.template == receipt_renderer::ReceiptTemplate::Classic
        && layout.classic_customer_render_mode
            == receipt_renderer::ClassicCustomerRenderMode::RasterExact;
    if let Some(show_logo_override) = preview_bool_field(settings, &["showLogo", "show_logo"])
        .or_else(|| preview_bool_field(payload, &["showLogo", "show_logo"]))
    {
        layout.show_logo = show_logo_override && (logo_supported || raster_exact_receipt_logo);
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
        let (data_url, warnings) =
            receipt_renderer::render_classic_raster_exact_preview_data_url(&document, &layout)?;
        return Ok(serde_json::json!({
            "success": true,
            "kind": "image",
            "dataUrl": data_url,
            "warnings": warnings.iter().map(|warning| warning.message.clone()).collect::<Vec<_>>(),
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
        "warnings": Vec::<String>::new(),
        "effectiveTemplate": effective_template,
        "effectiveRenderMode": effective_render_mode,
        "supportsTextScale": supports_text_scale,
        "isExactPreview": false,
    }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;
    use base64::Engine as _;
    use chrono::Duration as ChronoDuration;
    use rusqlite::Connection;
    use std::cell::{Cell, RefCell};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Barrier, Mutex};
    use std::thread;

    fn test_db() -> db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        db::run_migrations_for_test(&conn);
        db::DbState {
            conn: Mutex::new(conn),
            db_path: std::env::temp_dir().join("receipt-sample-preview-tests.sqlite"),
        }
    }

    fn wizard_print_request(
        session: &str,
        sample_kind: WizardSampleKind,
        target: printers::ResolvedPrinterTarget,
        bytes: Vec<u8>,
    ) -> print::PreRenderedTestPrint {
        let mut layout = receipt_renderer::LayoutConfig::default();
        layout.organization_name = "Wizard test".to_string();
        layout.character_set = "PC737_GREEK".to_string();
        layout.escpos_code_page = Some(14);
        let (candidate_connection_details, candidate_capabilities, driver_type) = match &target {
            printers::ResolvedPrinterTarget::WindowsQueue { printer_name } => (
                serde_json::json!({
                    "type": "system",
                    "systemName": printer_name,
                    "emulation": "escpos",
                    "render_mode": "text",
                    "escposCodePage": 14,
                    "capabilities": {
                        "status": "verified",
                        "resolvedTransport": "windows_queue",
                        "resolvedAddress": printer_name,
                        "emulation": "escpos",
                        "renderMode": "text",
                        "baudRate": null,
                        "escposCodePage": 14,
                        "supportsCut": true,
                        "supportsLogo": false,
                        "lastVerifiedAt": "2026-08-12T00:00:00Z"
                    }
                }),
                serde_json::json!({
                    "status": "verified",
                    "resolvedTransport": "windows_queue",
                    "resolvedAddress": printer_name,
                    "emulation": "escpos",
                    "renderMode": "text",
                    "baudRate": null,
                    "escposCodePage": 14,
                    "supportsCut": true,
                    "supportsLogo": false,
                    "lastVerifiedAt": "2026-08-12T00:00:00Z"
                }),
                "windows".to_string(),
            ),
            printers::ResolvedPrinterTarget::RawTcp { host, port } => (
                serde_json::json!({
                    "type": "network",
                    "ip": host,
                    "port": port,
                    "emulation": "escpos",
                    "render_mode": "text",
                    "escposCodePage": 14,
                    "capabilities": {
                        "status": "verified",
                        "resolvedTransport": "raw_tcp",
                        "resolvedAddress": format!("{host}:{port}"),
                        "emulation": "escpos",
                        "renderMode": "text",
                        "baudRate": null,
                        "escposCodePage": 14,
                        "supportsCut": true,
                        "supportsLogo": false,
                        "lastVerifiedAt": "2026-08-12T00:00:00Z"
                    }
                }),
                serde_json::json!({
                    "status": "verified",
                    "resolvedTransport": "raw_tcp",
                    "resolvedAddress": format!("{host}:{port}"),
                    "emulation": "escpos",
                    "renderMode": "text",
                    "baudRate": null,
                    "escposCodePage": 14,
                    "supportsCut": true,
                    "supportsLogo": false,
                    "lastVerifiedAt": "2026-08-12T00:00:00Z"
                }),
                "escpos".to_string(),
            ),
            printers::ResolvedPrinterTarget::SerialPort {
                port_name,
                baud_rate,
            } => (
                serde_json::json!({
                    "type": "bluetooth",
                    "serialPort": port_name,
                    "baudRate": baud_rate,
                    "emulation": "escpos",
                    "render_mode": "text",
                    "escposCodePage": 14,
                    "capabilities": {
                        "status": "verified",
                        "resolvedTransport": "serial",
                        "resolvedAddress": port_name,
                        "emulation": "escpos",
                        "renderMode": "text",
                        "baudRate": baud_rate,
                        "escposCodePage": 14,
                        "supportsCut": true,
                        "supportsLogo": false,
                        "lastVerifiedAt": "2026-08-12T00:00:00Z"
                    }
                }),
                serde_json::json!({
                    "status": "verified",
                    "resolvedTransport": "serial",
                    "resolvedAddress": port_name,
                    "emulation": "escpos",
                    "renderMode": "text",
                    "baudRate": baud_rate,
                    "escposCodePage": 14,
                    "supportsCut": true,
                    "supportsLogo": false,
                    "lastVerifiedAt": "2026-08-12T00:00:00Z"
                }),
                "escpos".to_string(),
            ),
        };
        print::PreRenderedTestPrint {
            wizard_session_id: session.to_string(),
            sample_kind: sample_kind.as_str().to_string(),
            effective_profile_id: format!("wizard-draft-{session}"),
            effective_profile_name: "Wizard test".to_string(),
            saved_profile_id: None,
            target,
            bytes,
            layout,
            candidate_connection_details,
            candidate_capabilities,
            driver_type,
            cut_paper: true,
            logo_configured: false,
            logo_included: false,
        }
    }

    #[test]
    fn wizard_print_all_sample_kinds_are_durable_before_invalidation_and_kick() {
        let db = test_db();
        for (index, kind) in [
            WizardSampleKind::TransportText,
            WizardSampleKind::Encoding,
            WizardSampleKind::Branding,
        ]
        .into_iter()
        .enumerate()
        {
            let target = printers::ResolvedPrinterTarget::RawTcp {
                host: format!("192.0.2.{}", index + 10),
                port: 9100,
            };
            let request = wizard_print_request(
                &format!("session-{index}"),
                kind.clone(),
                target,
                vec![0x1b, 0x40, index as u8, 0x0a],
            );
            let outcome = print::enqueue_pre_rendered_test_print(&db, request)
                .expect("wizard sample enqueues");
            assert!(!outcome.duplicate);
            let observed = RefCell::new(Vec::<String>::new());
            finish_wizard_print_enqueue(
                Ok(outcome.clone()),
                || {
                    let conn = db.conn.lock().unwrap();
                    let row: (String, i64, i64, i64, i64) = conn
                        .query_row(
                            "SELECT status,
                                    document_snapshot_version IS NOT NULL,
                                    document_snapshot_zlib IS NOT NULL,
                                    document_snapshot_sha256 IS NOT NULL,
                                    render_profile_snapshot_json IS NOT NULL
                             FROM print_jobs WHERE id = ?1",
                            [&outcome.job_id],
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
                    assert_eq!(row, ("pending".into(), 1, 1, 1, 1));
                    observed.borrow_mut().push("invalidate".into());
                },
                |job_id| observed.borrow_mut().push(format!("kick:{job_id}")),
            )
            .expect("finish wizard enqueue");
            assert_eq!(
                observed.borrow().as_slice(),
                ["invalidate", &format!("kick:{}", outcome.job_id)]
            );
        }
    }

    #[test]
    fn wizard_print_frozen_bytes_target_and_safe_evidence_survive_profile_changes() {
        let db = test_db();
        let bytes = vec![0x1b, 0x40, 0x1b, 0x74, 14, 0x80, 0x0a];
        let target = printers::ResolvedPrinterTarget::RawTcp {
            host: "192.0.2.10".into(),
            port: 9100,
        };
        let outcome = print::enqueue_pre_rendered_test_print(
            &db,
            wizard_print_request(
                "frozen-session",
                WizardSampleKind::Encoding,
                target.clone(),
                bytes.clone(),
            ),
        )
        .expect("enqueue frozen sample");

        let conn = db.conn.lock().unwrap();
        let stored = crate::print_snapshot::load_snapshot(&conn, &outcome.job_id)
            .expect("load snapshot")
            .expect("snapshot present");
        let (envelope, evidence): (serde_json::Value, serde_json::Value) = conn
            .query_row(
                "SELECT render_profile_snapshot_json, entity_payload_json
                 FROM print_jobs WHERE id = ?1",
                [&outcome.job_id],
                |row| {
                    let envelope: String = row.get(0)?;
                    let evidence: String = row.get(1)?;
                    Ok((
                        serde_json::from_str(&envelope).unwrap(),
                        serde_json::from_str(&evidence).unwrap(),
                    ))
                },
            )
            .unwrap();
        assert_eq!(stored, bytes);
        assert_eq!(envelope["transport"]["kind"], "raw_tcp");
        assert_eq!(envelope["transport"]["host"], "192.0.2.10");
        assert_eq!(envelope["transport"]["port"], 9100);
        assert_eq!(evidence["candidateConnectionDetails"]["ip"], "192.0.2.10");
        assert!(evidence.to_string().len() < 4096);
        assert!(!evidence
            .to_string()
            .to_ascii_lowercase()
            .contains("password"));
        drop(conn);

        // No mutable draft/profile is consulted after enqueue: the immutable
        // payload and target remain the values above.
        assert_eq!(outcome.sample_kind, "encoding");
        assert_eq!(outcome.queue_state, "pending");
    }

    #[test]
    fn wizard_print_draft_queue_snapshot_uses_frozen_effective_profile_display_name() {
        let db_path = std::env::temp_dir().join(format!(
            "wizard-display-name-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&db_path).unwrap();
        db::run_migrations_for_test(&conn);
        let db = db::DbState {
            conn: Mutex::new(conn),
            db_path: db_path.clone(),
        };
        let mut request = wizard_print_request(
            "display-name-session",
            WizardSampleKind::TransportText,
            printers::ResolvedPrinterTarget::RawTcp {
                host: "192.0.2.93".into(),
                port: 9100,
            },
            b"display-name".to_vec(),
        );
        request.effective_profile_name = "Draft Receipt Printer".to_string();
        let outcome = print::enqueue_pre_rendered_test_print(&db, request).unwrap();

        let snapshot =
            serde_json::to_value(print::print_queue_snapshot(&db, None, None, 20, 0).unwrap())
                .unwrap();
        let job = snapshot["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|job| job["id"] == outcome.job_id)
            .unwrap();
        assert_eq!(job["printerProfileId"], serde_json::Value::Null);
        assert_eq!(job["printerProfileName"], serde_json::Value::Null);
        assert_eq!(job["printerDisplayName"], "Draft Receipt Printer");
        assert!(!job.to_string().contains("renderProfileSnapshot"));
        drop(snapshot);
        drop(db);
        std::fs::remove_file(db_path).unwrap();
    }

    #[test]
    fn wizard_print_same_target_coalesces_globally_but_terminal_history_does_not_block() {
        let db = test_db();
        let target = printers::ResolvedPrinterTarget::RawTcp {
            host: "192.0.2.30".into(),
            port: 9100,
        };
        let first = print::enqueue_pre_rendered_test_print(
            &db,
            wizard_print_request(
                "session-a",
                WizardSampleKind::TransportText,
                target.clone(),
                b"first".to_vec(),
            ),
        )
        .unwrap();
        let same_session = print::enqueue_pre_rendered_test_print(
            &db,
            wizard_print_request(
                "session-a",
                WizardSampleKind::TransportText,
                target.clone(),
                b"second".to_vec(),
            ),
        )
        .unwrap();
        let other_session = print::enqueue_pre_rendered_test_print(
            &db,
            wizard_print_request(
                "session-b",
                WizardSampleKind::Encoding,
                target.clone(),
                b"third".to_vec(),
            ),
        )
        .unwrap();
        assert_eq!(same_session.job_id, first.job_id);
        assert_eq!(other_session.job_id, first.job_id);
        assert!(same_session.duplicate && other_session.duplicate);

        let invalidations = Cell::new(0usize);
        let kicks = Cell::new(0usize);
        let duplicate_response = finish_wizard_print_enqueue(
            Ok(other_session),
            || invalidations.set(invalidations.get() + 1),
            |_| kicks.set(kicks.get() + 1),
        )
        .unwrap();
        assert_eq!(invalidations.get(), 0);
        assert_eq!(kicks.get(), 0);
        let duplicate_response = serde_json::to_value(duplicate_response).unwrap();
        assert_eq!(
            duplicate_response["candidateConnectionDetails"]["ip"], "192.0.2.30",
            "duplicate response must use the first persisted evidence"
        );

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE print_jobs
                 SET status = 'failed', completed_at = datetime('now'),
                     history_expires_at = datetime('now', '+30 days')
                 WHERE id = ?1",
                [&first.job_id],
            )
            .unwrap();
        }
        let later = print::enqueue_pre_rendered_test_print(
            &db,
            wizard_print_request(
                "session-c",
                WizardSampleKind::Encoding,
                target,
                b"later".to_vec(),
            ),
        )
        .unwrap();
        assert_ne!(later.job_id, first.job_id);
        assert!(!later.duplicate);

        let independent = print::enqueue_pre_rendered_test_print(
            &db,
            wizard_print_request(
                "session-c",
                WizardSampleKind::Encoding,
                printers::ResolvedPrinterTarget::RawTcp {
                    host: "192.0.2.31".into(),
                    port: 9100,
                },
                b"independent".to_vec(),
            ),
        )
        .unwrap();
        assert_ne!(independent.job_id, later.job_id);
    }

    #[test]
    fn wizard_print_serial_samples_coalesce_by_physical_port_not_baud() {
        let db = test_db();
        let first = print::enqueue_pre_rendered_test_print(
            &db,
            wizard_print_request(
                "serial-9600",
                WizardSampleKind::TransportText,
                printers::ResolvedPrinterTarget::SerialPort {
                    port_name: "COM17".into(),
                    baud_rate: 9_600,
                },
                b"serial-first".to_vec(),
            ),
        )
        .unwrap();
        let second = print::enqueue_pre_rendered_test_print(
            &db,
            wizard_print_request(
                "serial-38400",
                WizardSampleKind::Encoding,
                printers::ResolvedPrinterTarget::SerialPort {
                    port_name: "com17".into(),
                    baud_rate: 38_400,
                },
                b"serial-second".to_vec(),
            ),
        )
        .unwrap();

        assert!(
            second.duplicate,
            "one serial port is one physical sample lane"
        );
        assert_eq!(second.job_id, first.job_id);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE entity_type = 'test_print'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn wizard_print_unicode_case_equivalent_queue_callers_share_one_lane() {
        let path = std::env::temp_dir().join(format!(
            "wizard-unicode-lane-{}-{}.sqlite",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let bootstrap = Connection::open(&path).unwrap();
        bootstrap
            .busy_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        db::run_migrations_for_test(&bootstrap);
        drop(bootstrap);
        let states = (0..2)
            .map(|_| {
                let conn = Connection::open(&path).unwrap();
                conn.busy_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                Arc::new(db::DbState {
                    conn: Mutex::new(conn),
                    db_path: path.clone(),
                })
            })
            .collect::<Vec<_>>();
        let barrier = Arc::new(Barrier::new(2));
        let queue_names = ["FRONT Α", "front α"];
        let handles = states
            .into_iter()
            .zip(queue_names)
            .enumerate()
            .map(|(index, (state, queue_name))| {
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    print::enqueue_pre_rendered_test_print(
                        &state,
                        wizard_print_request(
                            &format!("unicode-{index}"),
                            WizardSampleKind::TransportText,
                            printers::ResolvedPrinterTarget::WindowsQueue {
                                printer_name: queue_name.into(),
                            },
                            vec![index as u8 + 1],
                        ),
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(outcomes[0].job_id, outcomes[1].job_id);
        assert_eq!(
            outcomes.iter().filter(|outcome| !outcome.duplicate).count(),
            1
        );
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE entity_type = 'test_print'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn wizard_print_malformed_legacy_payload_is_ignored_during_coalescing() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO print_jobs (
                    id, entity_type, entity_id, entity_payload_json, status,
                    created_at, updated_at
                 ) VALUES (
                    ?1, 'test_print', 'legacy-bad-json', '{not-json', 'failed',
                    datetime('now'), datetime('now')
                 )",
                [uuid::Uuid::new_v4().to_string()],
            )
            .unwrap();
        }
        let outcome = print::enqueue_pre_rendered_test_print(
            &db,
            wizard_print_request(
                "after-malformed",
                WizardSampleKind::TransportText,
                printers::ResolvedPrinterTarget::RawTcp {
                    host: "192.0.2.32".into(),
                    port: 9100,
                },
                b"safe enqueue".to_vec(),
            ),
        )
        .expect("malformed unrelated legacy evidence must not break enqueue");
        assert!(!outcome.duplicate);
    }

    #[test]
    fn wizard_print_dispatched_parent_with_active_native_attempt_blocks_overlap() {
        let db = test_db();
        let target = printers::ResolvedPrinterTarget::WindowsQueue {
            printer_name: "Wizard Queue".into(),
        };
        let mut request = wizard_print_request(
            "native-a",
            WizardSampleKind::TransportText,
            target.clone(),
            b"native-first".to_vec(),
        );
        request.candidate_connection_details = serde_json::json!({
            "type": "system",
            "systemName": "Wizard Queue",
            "emulation": "escpos",
            "render_mode": "text"
        });
        request.candidate_capabilities = serde_json::json!({
            "status": "verified",
            "resolvedTransport": "windows_queue",
            "resolvedAddress": "Wizard Queue",
            "emulation": "escpos",
            "renderMode": "text",
            "baudRate": null,
            "supportsCut": true,
            "supportsLogo": false,
            "lastVerifiedAt": "2026-08-12T00:00:00Z"
        });
        let first = print::enqueue_pre_rendered_test_print(&db, request).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE print_jobs SET status = 'dispatched' WHERE id = ?1",
                [&first.job_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO print_job_attempts (
                    id, print_job_id, attempt_number, transport, resolved_target,
                    document_name, spool_job_id, state, bytes_requested, bytes_written,
                    started_at, last_seen_at
                 ) VALUES (
                    ?1, ?2, 1, 'windows', 'windows:Wizard Queue',
                    'TheSmallPOS/test', 77, 'windows_queued', 12, 12,
                    datetime('now'), datetime('now')
                 )",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), &first.job_id],
            )
            .unwrap();
        }
        let duplicate = print::enqueue_pre_rendered_test_print(
            &db,
            wizard_print_request(
                "native-b",
                WizardSampleKind::Encoding,
                target,
                b"must-not-overlap".to_vec(),
            ),
        )
        .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.job_id, first.job_id);
        assert_eq!(duplicate.queue_state, "dispatched");
    }

    #[test]
    fn wizard_print_cancel_failed_and_identity_valid_spool_error_block_overlap() {
        for (index, state) in ["cancel_failed", "spool_error"].into_iter().enumerate() {
            let db = test_db();
            let target = printers::ResolvedPrinterTarget::WindowsQueue {
                printer_name: format!("Blocked Queue {index}"),
            };
            let first = print::enqueue_pre_rendered_test_print(
                &db,
                wizard_print_request(
                    &format!("blocker-a-{index}"),
                    WizardSampleKind::TransportText,
                    target.clone(),
                    b"first".to_vec(),
                ),
            )
            .unwrap();
            {
                let conn = db.conn.lock().unwrap();
                conn.execute(
                    "UPDATE print_jobs SET status = 'dispatched' WHERE id = ?1",
                    [&first.job_id],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO print_job_attempts (
                        id, print_job_id, attempt_number, transport, resolved_target,
                        document_name, spool_job_id, state, bytes_requested, bytes_written,
                        started_at, last_seen_at
                     ) VALUES (?1, ?2, 1, 'windows', ?3,
                        'TheSmallPOS/test', 88, ?4, 5, 5, datetime('now'), datetime('now'))",
                    rusqlite::params![
                        uuid::Uuid::new_v4().to_string(),
                        &first.job_id,
                        format!("windows:Blocked Queue {index}"),
                        state
                    ],
                )
                .unwrap();
            }
            let duplicate = print::enqueue_pre_rendered_test_print(
                &db,
                wizard_print_request(
                    &format!("blocker-b-{index}"),
                    WizardSampleKind::Encoding,
                    target,
                    b"second".to_vec(),
                ),
            )
            .unwrap();
            assert!(duplicate.duplicate, "{state} must block overlap");
            assert_eq!(duplicate.job_id, first.job_id);
        }
    }

    #[test]
    fn wizard_print_concurrent_file_db_enqueues_at_most_one_active_target() {
        let path = std::env::temp_dir().join(format!(
            "wizard-print-concurrency-{}-{}.sqlite",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let bootstrap = Connection::open(&path).unwrap();
        bootstrap
            .busy_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        db::run_migrations_for_test(&bootstrap);
        drop(bootstrap);

        let states = (0..2)
            .map(|_| {
                let conn = Connection::open(&path).unwrap();
                conn.busy_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                Arc::new(db::DbState {
                    conn: Mutex::new(conn),
                    db_path: path.clone(),
                })
            })
            .collect::<Vec<_>>();
        let barrier = Arc::new(Barrier::new(2));
        let handles = states
            .into_iter()
            .enumerate()
            .map(|(index, state)| {
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    print::enqueue_pre_rendered_test_print(
                        &state,
                        wizard_print_request(
                            &format!("concurrent-{index}"),
                            WizardSampleKind::TransportText,
                            printers::ResolvedPrinterTarget::RawTcp {
                                host: "192.0.2.60".into(),
                                port: 9100,
                            },
                            vec![index as u8 + 1],
                        ),
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes[0].job_id, outcomes[1].job_id);
        assert_eq!(
            outcomes.iter().filter(|outcome| !outcome.duplicate).count(),
            1
        );
        let conn = Connection::open(&path).unwrap();
        let active: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs
                 WHERE entity_type = 'test_print' AND status IN ('pending', 'printing')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active, 1);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    struct CapturingWizardTransport {
        calls: Mutex<Vec<(printers::ResolvedPrinterTarget, Vec<u8>)>>,
    }

    impl print::ManagedRawTransport for CapturingWizardTransport {
        fn send(
            &self,
            _db: &db::DbState,
            target: &printers::ResolvedPrinterTarget,
            bytes: &[u8],
            document_name: &str,
            _cancel: &AtomicBool,
        ) -> Result<printers::RawPrintResult, printers::RawTransportFailure> {
            self.calls
                .lock()
                .unwrap()
                .push((target.clone(), bytes.to_vec()));
            Ok(printers::RawPrintResult {
                bytes_requested: bytes.len(),
                bytes_written: bytes.len(),
                doc_name: document_name.to_string(),
                spool_job_id: None,
            })
        }
    }

    #[test]
    fn wizard_print_worker_replays_frozen_bytes_and_target_without_profile_lookup() {
        let db = test_db();
        let target = printers::ResolvedPrinterTarget::RawTcp {
            host: "192.0.2.70".into(),
            port: 19100,
        };
        let bytes = b"frozen-wizard-sample".to_vec();
        let outcome = print::enqueue_pre_rendered_test_print(
            &db,
            wizard_print_request(
                "worker-replay",
                WizardSampleKind::Encoding,
                target.clone(),
                bytes.clone(),
            ),
        )
        .unwrap();
        let transport = CapturingWizardTransport {
            calls: Mutex::new(Vec::new()),
        };
        let output_dir =
            std::env::temp_dir().join(format!("wizard-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&output_dir).unwrap();
        print::process_pre_rendered_test_print_with_transport(&db, &output_dir, &transport)
            .expect("process frozen wizard job");
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.as_slice(), [(target, bytes)]);
        drop(calls);
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&outcome.job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "dispatched"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[test]
    fn wizard_print_saved_command_enqueues_a_managed_sample() {
        let db = test_db();
        let profile = printers::create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Saved wizard printer",
                "printerName": "192.0.2.80",
                "driverType": "escpos",
                "printerType": "network",
                "role": "receipt",
                "characterSet": "PC737_GREEK",
                "connectionJson": serde_json::json!({
                    "type": "network",
                    "ip": "192.0.2.80",
                    "port": 9100,
                    "emulation": "escpos",
                    "render_mode": "text"
                }).to_string()
            }),
        )
        .unwrap();
        let profile_id = profile["profileId"].as_str().unwrap();
        let saved = execute_saved_profile_test_enqueue(
            &db,
            profile_id,
            WizardSampleKind::TransportText,
            "saved-command",
        )
        .unwrap();
        assert!(!saved.duplicate);
        let conn = db.conn.lock().unwrap();
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs
                 WHERE entity_type = 'test_print'
                   AND status = 'pending'
                   AND document_snapshot_zlib IS NOT NULL
                   AND render_profile_snapshot_json IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!(saved.sample_kind, "transport_text");
    }

    #[test]
    fn wizard_print_confirmed_candidate_save_round_trip_preserves_exact_fields() {
        let db = test_db();
        let confirmed = serde_json::json!({
            "type": "bluetooth",
            "systemName": "Star MCP31 - Ethernet:TCP;",
            "address": "Star MCP31 - Ethernet:TCP;",
            "serialPort": "COM17",
            "baudRate": 38400,
            "emulation": "star_line",
            "render_mode": "raster_exact",
            "cutPaper": false,
            "escposCodePage": 15,
            "customerName": "must not persist",
            "privateReceiptPayload": { "phone": "6900000000" },
            "capabilities": {
                "status": "verified",
                "resolvedTransport": "serial",
                "resolvedAddress": "COM17",
                "emulation": "star_line",
                "renderMode": "raster_exact",
                "baudRate": 38400,
                "escposCodePage": 15,
                "supportsCut": false,
                "supportsLogo": true,
                "lastVerifiedAt": "2026-08-12T10:00:00Z"
            }
        });
        let mapped = profile_payload_with_confirmed_candidate(serde_json::json!({
            "name": "Exact candidate",
            "type": "bluetooth",
            "connectionDetails": {
                "type": "bluetooth",
                "systemName": "Star MCP31 - Ethernet:TCP;",
                "serialPort": "COM17",
                "baudRate": 38400
            },
            "confirmedCandidateConnectionDetails": confirmed,
            "paperSize": "80mm",
            "role": "receipt",
            "enabled": true
        }))
        .unwrap();
        let created =
            printers::create_printer_profile_with_validated_capabilities(&db, &mapped).unwrap();
        let stored =
            printers::get_printer_profile(&db, created["profileId"].as_str().unwrap()).unwrap();
        let connection: serde_json::Value = serde_json::from_str(
            stored["connectionJson"]
                .as_str()
                .expect("stored connection JSON"),
        )
        .unwrap();
        assert_eq!(connection["type"], "bluetooth");
        assert_eq!(connection["systemName"], "Star MCP31 - Ethernet:TCP;");
        assert_eq!(connection["serialPort"], "COM17");
        assert_eq!(connection["baudRate"], 38400);
        assert_eq!(connection["emulation"], "star_line");
        assert_eq!(connection["render_mode"], "raster_exact");
        assert_eq!(connection["cutPaper"], false);
        assert_eq!(connection["escposCodePage"], 15);
        assert!(connection.get("customerName").is_none());
        assert!(connection.get("privateReceiptPayload").is_none());
        assert_eq!(connection["capabilities"]["resolvedTransport"], "serial");
        assert_eq!(connection["capabilities"]["resolvedAddress"], "COM17");
        assert_eq!(connection["capabilities"]["supportsCut"], false);
        assert_eq!(stored["cutPaper"], false);
        assert_eq!(stored["escposCodePage"], 15);
    }

    #[test]
    fn wizard_print_candidate_evidence_is_allowlisted_before_persistence() {
        let db = test_db();
        let base = serde_json::json!({
            "paperWidthMm": 80,
            "printerName": "192.0.2.91",
            "printerType": "network",
            "characterSet": "PC737_GREEK",
            "connectionJson": serde_json::json!({
                "type": "network",
                "ip": "192.0.2.91",
                "port": 9100,
                "emulation": "escpos",
                "render_mode": "text",
                "customerName": "Private Customer",
                "receiptPayload": { "phone": "6900000000" }
            }).to_string()
        });
        let target = printers::resolve_printer_target(&base).unwrap();
        let prepared = prepare_wizard_sample(
            &db,
            &base,
            &target,
            "Private evidence printer",
            &WizardSampleKind::Encoding,
            0,
            None,
        )
        .unwrap();
        assert!(prepared
            .candidate_connection_details
            .get("customerName")
            .is_none());
        assert!(prepared
            .candidate_connection_details
            .get("receiptPayload")
            .is_none());
        let outcome = print::enqueue_pre_rendered_test_print(
            &db,
            managed_test_print_request(
                &base,
                prepared,
                &WizardSampleKind::Encoding,
                "allowlisted-evidence",
                None,
            ),
        )
        .unwrap();
        let conn = db.conn.lock().unwrap();
        let evidence: String = conn
            .query_row(
                "SELECT entity_payload_json FROM print_jobs WHERE id = ?1",
                [&outcome.job_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!evidence.contains("Private Customer"));
        assert!(!evidence.contains("6900000000"));
    }

    #[test]
    fn wizard_print_candidate_validator_rejects_invalid_enums_and_bounds() {
        let valid = serde_json::json!({
            "type": "network",
            "ip": "192.0.2.92",
            "port": 9100,
            "emulation": "escpos",
            "render_mode": "text",
            "cutPaper": true,
            "escposCodePage": 14,
            "capabilities": {
                "status": "verified",
                "resolvedTransport": "raw_tcp",
                "resolvedAddress": "192.0.2.92:9100",
                "emulation": "escpos",
                "renderMode": "text",
                "baudRate": null,
                "escposCodePage": 14,
                "supportsCut": true,
                "supportsLogo": false,
                "lastVerifiedAt": "2026-08-12T10:00:00Z"
            }
        });
        assert!(safe_confirmed_candidate_connection(&valid).is_ok());
        for (path, invalid) in [
            ("status", serde_json::json!("unverified")),
            ("transport", serde_json::json!("cloud")),
            ("emulation", serde_json::json!("vendor_magic")),
            ("render", serde_json::json!("html")),
            ("port", serde_json::json!(70000)),
            ("baud", serde_json::json!(99)),
            ("code_page", serde_json::json!(300)),
        ] {
            let mut candidate = valid.clone();
            match path {
                "status" => candidate["capabilities"]["status"] = invalid,
                "transport" => candidate["capabilities"]["resolvedTransport"] = invalid,
                "emulation" => candidate["capabilities"]["emulation"] = invalid,
                "render" => candidate["capabilities"]["renderMode"] = invalid,
                "port" => candidate["port"] = invalid,
                "baud" => candidate["baudRate"] = invalid,
                "code_page" => candidate["escposCodePage"] = invalid,
                _ => unreachable!(),
            }
            assert!(
                safe_confirmed_candidate_connection(&candidate).is_err(),
                "{path} must be rejected"
            );
        }
    }

    #[test]
    fn wizard_print_candidate_validator_rejects_cross_field_contradictions() {
        let valid = serde_json::json!({
            "type": "bluetooth",
            "serialPort": "COM17",
            "baudRate": 38400,
            "emulation": "star_line",
            "render_mode": "raster_exact",
            "cutPaper": false,
            "escposCodePage": 15,
            "capabilities": {
                "status": "verified",
                "resolvedTransport": "serial",
                "resolvedAddress": "COM17",
                "emulation": "star_line",
                "renderMode": "raster_exact",
                "baudRate": 38400,
                "escposCodePage": 15,
                "supportsCut": false,
                "supportsLogo": true,
                "lastVerifiedAt": "2026-08-12T10:00:00Z"
            }
        });
        assert!(safe_confirmed_candidate_connection(&valid).is_ok());

        let mut contradictions = Vec::new();
        for (name, candidate) in [
            ("serial capability baud null", {
                let mut value = valid.clone();
                value["capabilities"]["baudRate"] = serde_json::Value::Null;
                value
            }),
            ("serial capability baud differs", {
                let mut value = valid.clone();
                value["capabilities"]["baudRate"] = serde_json::json!(9600);
                value
            }),
            ("emulation differs", {
                let mut value = valid.clone();
                value["capabilities"]["emulation"] = serde_json::json!("escpos");
                value
            }),
            ("render mode differs", {
                let mut value = valid.clone();
                value["capabilities"]["renderMode"] = serde_json::json!("text");
                value
            }),
            ("cut support differs", {
                let mut value = valid.clone();
                value["capabilities"]["supportsCut"] = serde_json::json!(true);
                value
            }),
            ("code page differs", {
                let mut value = valid.clone();
                value["capabilities"]["escposCodePage"] = serde_json::json!(14);
                value
            }),
            ("capability code page missing", {
                let mut value = valid.clone();
                value["capabilities"]
                    .as_object_mut()
                    .unwrap()
                    .remove("escposCodePage");
                value
            }),
        ] {
            if safe_confirmed_candidate_connection(&candidate).is_ok() {
                contradictions.push(name);
            }
        }
        assert!(
            contradictions.is_empty(),
            "contradictory candidate evidence was accepted: {contradictions:?}"
        );
    }

    #[test]
    fn wizard_print_confirmed_candidate_requires_transport_specific_fields() {
        let serial = serde_json::json!({
            "type": "bluetooth",
            "serialPort": "COM17",
            "baudRate": 38400,
            "emulation": "star_line",
            "render_mode": "text",
            "cutPaper": true,
            "escposCodePage": 15,
            "capabilities": {
                "status": "verified",
                "resolvedTransport": "serial",
                "resolvedAddress": "COM17",
                "emulation": "star_line",
                "renderMode": "text",
                "baudRate": 38400,
                "escposCodePage": 15,
                "supportsCut": true,
                "supportsLogo": false,
                "lastVerifiedAt": "2026-08-12T10:00:00Z"
            }
        });
        let network = serde_json::json!({
            "type": "network",
            "ip": "192.0.2.94",
            "port": 9100,
            "emulation": "escpos",
            "render_mode": "text",
            "cutPaper": true,
            "escposCodePage": 14,
            "capabilities": {
                "status": "verified",
                "resolvedTransport": "raw_tcp",
                "resolvedAddress": "192.0.2.94:9100",
                "emulation": "escpos",
                "renderMode": "text",
                "baudRate": null,
                "escposCodePage": 14,
                "supportsCut": true,
                "supportsLogo": false,
                "lastVerifiedAt": "2026-08-12T10:00:00Z"
            }
        });
        let mut missing_serial_baud = serial.clone();
        missing_serial_baud
            .as_object_mut()
            .unwrap()
            .remove("baudRate");
        let mut missing_network_port = network.clone();
        missing_network_port.as_object_mut().unwrap().remove("port");

        let unexpectedly_accepted = [
            ("serial baudRate", missing_serial_baud),
            ("network port", missing_network_port),
        ]
        .into_iter()
        .filter_map(|(name, candidate)| {
            safe_confirmed_candidate_connection(&candidate)
                .is_ok()
                .then_some(name)
        })
        .collect::<Vec<_>>();
        assert!(
            unexpectedly_accepted.is_empty(),
            "transport-specific confirmed fields were optional: {unexpectedly_accepted:?}"
        );
    }

    #[test]
    fn wizard_print_rollback_and_rejection_have_no_row_invalidation_or_kick() {
        let db = test_db();
        let invalidations = Cell::new(0usize);
        let kicks = RefCell::new(Vec::<String>::new());
        let result = print::enqueue_pre_rendered_test_print_with_hook(
            &db,
            wizard_print_request(
                "rollback-session",
                WizardSampleKind::TransportText,
                printers::ResolvedPrinterTarget::RawTcp {
                    host: "192.0.2.40".into(),
                    port: 9100,
                },
                b"rollback".to_vec(),
            ),
            || Err("forced rollback".to_string()),
        );
        assert!(finish_wizard_print_enqueue(
            result,
            || invalidations.set(invalidations.get() + 1),
            |job_id| kicks.borrow_mut().push(job_id.to_string()),
        )
        .is_err());
        let conn = db.conn.lock().unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM print_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        assert_eq!(invalidations.get(), 0);
        assert!(kicks.borrow().is_empty());
    }

    #[test]
    fn wizard_print_encoding_uses_star_page_15_and_epson_page_14() {
        let mut star = receipt_renderer::LayoutConfig::default();
        star.character_set = "PC737_GREEK".into();
        star.detected_brand = printers::PrinterBrand::Star;
        star.emulation_mode = receipt_renderer::ReceiptEmulationMode::StarLine;
        star.escpos_code_page = None;
        let star_bytes = build_encoding_sample(&star);
        assert!(star_bytes
            .windows(4)
            .any(|window| window == [0x1b, 0x1d, 0x74, 15]));

        let mut epson = receipt_renderer::LayoutConfig::default();
        epson.character_set = "PC737_GREEK".into();
        epson.detected_brand = printers::PrinterBrand::Epson;
        epson.emulation_mode = receipt_renderer::ReceiptEmulationMode::Escpos;
        epson.escpos_code_page = None;
        let epson_bytes = build_encoding_sample(&epson);
        assert!(epson_bytes
            .windows(3)
            .any(|window| window == [0x1b, 0x74, 14]));
    }

    #[test]
    fn wizard_print_encoding_candidate_overrides_opposite_manual_cp737_page() {
        let db = test_db();
        let star_profile = serde_json::json!({
            "name": "Star MCP31",
            "printerName": "192.0.2.95",
            "printerType": "network",
            "paperWidthMm": 80,
            "characterSet": "PC737_GREEK",
            "escposCodePage": 14,
            "cutPaper": true,
            "connectionJson": serde_json::json!({
                "type": "network",
                "ip": "192.0.2.95",
                "port": 9100,
                "emulation": "auto",
                "render_mode": "text"
            }).to_string()
        });
        let star_target = printers::resolve_printer_target(&star_profile).unwrap();
        let star = prepare_wizard_sample(
            &db,
            &star_profile,
            &star_target,
            "Star MCP31",
            &WizardSampleKind::Encoding,
            0,
            None,
        )
        .unwrap();
        let star_observed = (
            star.layout.escpos_code_page,
            star.candidate_capabilities["escposCodePage"].as_u64(),
            star.sample
                .bytes
                .windows(4)
                .any(|window| window == [0x1b, 0x1d, 0x74, 15]),
        );

        let epson_profile = serde_json::json!({
            "name": "Epson TM-T88",
            "printerName": "192.0.2.96",
            "printerType": "network",
            "paperWidthMm": 80,
            "characterSet": "PC737_GREEK",
            "escposCodePage": 15,
            "cutPaper": true,
            "connectionJson": serde_json::json!({
                "type": "network",
                "ip": "192.0.2.96",
                "port": 9100,
                "emulation": "auto",
                "render_mode": "text"
            }).to_string()
        });
        let epson_target = printers::resolve_printer_target(&epson_profile).unwrap();
        let confirmed_epson = serde_json::json!({
            "type": "network",
            "ip": "192.0.2.96",
            "port": 9100,
            "emulation": "escpos",
            "render_mode": "text",
            "cutPaper": true,
            "escposCodePage": 14,
            "capabilities": {
                "status": "verified",
                "resolvedTransport": "raw_tcp",
                "resolvedAddress": "192.0.2.96:9100",
                "emulation": "escpos",
                "renderMode": "text",
                "baudRate": null,
                "escposCodePage": 14,
                "supportsCut": true,
                "supportsLogo": false,
                "lastVerifiedAt": "2026-08-12T10:00:00Z"
            }
        });
        let epson = prepare_wizard_sample(
            &db,
            &epson_profile,
            &epson_target,
            "Epson TM-T88",
            &WizardSampleKind::Encoding,
            0,
            Some(&confirmed_epson),
        )
        .unwrap();
        let epson_observed = (
            epson.layout.escpos_code_page,
            epson.candidate_capabilities["escposCodePage"].as_u64(),
            epson
                .sample
                .bytes
                .windows(3)
                .any(|window| window == [0x1b, 0x74, 14]),
        );

        assert_eq!(
            [star_observed, epson_observed],
            [(Some(15), Some(15), true), (Some(14), Some(14), true)]
        );
    }

    #[test]
    fn wizard_print_confirmed_cut_false_freezes_and_emits_no_cut_command() {
        let db = test_db();
        let profile = serde_json::json!({
            "name": "Epson no-cut candidate",
            "printerName": "192.0.2.97",
            "printerType": "network",
            "driverType": "escpos",
            "paperWidthMm": 80,
            "characterSet": "PC737_GREEK",
            "escposCodePage": 14,
            "cutPaper": true,
            "connectionJson": serde_json::json!({
                "type": "network",
                "ip": "192.0.2.97",
                "port": 9100,
                "emulation": "escpos",
                "render_mode": "text"
            }).to_string()
        });
        let target = printers::resolve_printer_target(&profile).unwrap();
        let confirmed = serde_json::json!({
            "type": "network",
            "ip": "192.0.2.97",
            "port": 9100,
            "emulation": "escpos",
            "render_mode": "text",
            "cutPaper": false,
            "escposCodePage": 14,
            "capabilities": {
                "status": "verified",
                "resolvedTransport": "raw_tcp",
                "resolvedAddress": "192.0.2.97:9100",
                "emulation": "escpos",
                "renderMode": "text",
                "baudRate": null,
                "escposCodePage": 14,
                "supportsCut": false,
                "supportsLogo": false,
                "lastVerifiedAt": "2026-08-12T10:00:00Z"
            }
        });
        let prepared = prepare_wizard_sample(
            &db,
            &profile,
            &target,
            "Epson no-cut candidate",
            &WizardSampleKind::TransportText,
            0,
            Some(&confirmed),
        )
        .unwrap();
        let request = managed_test_print_request(
            &profile,
            prepared,
            &WizardSampleKind::TransportText,
            "confirmed-no-cut",
            None,
        );
        let outcome = print::enqueue_pre_rendered_test_print(&db, request).unwrap();
        let conn = db.conn.lock().unwrap();
        let bytes = crate::print_snapshot::load_snapshot(&conn, &outcome.job_id)
            .unwrap()
            .unwrap();
        let envelope_json: String = conn
            .query_row(
                "SELECT render_profile_snapshot_json FROM print_jobs WHERE id = ?1",
                [&outcome.job_id],
                |row| row.get(0),
            )
            .unwrap();
        let envelope: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
        let has_escpos_cut = bytes
            .windows(4)
            .any(|window| window == [0x1d, 0x56, 0x41, 0x10]);
        let has_star_cut = bytes.windows(3).any(|window| window == [0x1b, 0x64, 0x01]);

        assert_eq!(
            (
                envelope["cut_paper"].as_bool(),
                has_escpos_cut,
                has_star_cut
            ),
            (Some(false), false, false)
        );
    }

    #[test]
    fn wizard_print_branding_requires_real_non_empty_raster_prefix() {
        let mut disabled = receipt_renderer::LayoutConfig::default();
        disabled.show_logo = false;
        disabled.logo_url = Some("data:image/png;base64,AA==".into());
        assert_eq!(
            build_branding_sample("Printer", &disabled)
                .unwrap_err()
                .code(),
            "logo_not_configured"
        );

        let mut missing = receipt_renderer::LayoutConfig::default();
        missing.show_logo = true;
        missing.logo_url = Some("   ".into());
        assert_eq!(
            build_branding_sample("Printer", &missing)
                .unwrap_err()
                .code(),
            "logo_not_configured"
        );

        let mut broken = receipt_renderer::LayoutConfig::default();
        broken.show_logo = true;
        broken.logo_url = Some("data:image/png;base64,not-valid".into());
        let broken_error = build_branding_sample("Printer", &broken).unwrap_err();
        assert_eq!(
            (
                broken_error.code(),
                broken_error.logo_configured(),
                broken_error.logo_included()
            ),
            ("logo_render_failed", true, false)
        );

        let mut encoded = Vec::new();
        image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(2, 2, image::Luma([0])))
            .write_to(
                &mut std::io::Cursor::new(&mut encoded),
                image::ImageFormat::Png,
            )
            .unwrap();
        let mut real = receipt_renderer::LayoutConfig::default();
        real.show_logo = true;
        real.logo_url = Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded)
        ));
        let sample = build_branding_sample("Printer", &real).unwrap();
        assert!(sample.logo_included);
        assert!(!sample.bytes.is_empty());
        assert!(sample
            .bytes
            .windows(3)
            .any(|window| window == [0x1b, b'*', 33]));
    }

    #[test]
    fn wizard_print_response_dto_serializes_exact_success_and_failure_shapes() {
        let queued = WizardPrintResponse::queued(print::PreRenderedTestPrintOutcome {
            job_id: "11111111-1111-4111-8111-111111111111".into(),
            duplicate: false,
            queue_state: "pending".into(),
            sample_kind: "encoding".into(),
            candidate_connection_details: serde_json::json!({"type": "network"}),
            candidate_capabilities: serde_json::json!({"status": "verified"}),
            logo_configured: false,
            logo_included: false,
        });
        assert_eq!(
            serde_json::to_value(queued).unwrap(),
            serde_json::json!({
                "success": true,
                "queued": true,
                "duplicate": false,
                "jobId": "11111111-1111-4111-8111-111111111111",
                "queueState": "pending",
                "sampleKind": "encoding",
                "candidateConnectionDetails": {"type": "network"},
                "candidateCapabilities": {"status": "verified"},
                "logoConfigured": false,
                "logoIncluded": false
            })
        );

        let mut broken = receipt_renderer::LayoutConfig::default();
        broken.show_logo = true;
        broken.logo_url = Some("data:image/png;base64,not-valid".into());
        let error = build_branding_sample("Brand Printer", &broken).unwrap_err();
        let error_message = error.to_string();
        let rejected = WizardPrintResponse::rejected(
            "Brand Printer".into(),
            WizardSampleKind::Branding,
            &printers::ResolvedPrinterTarget::RawTcp {
                host: "192.0.2.98".into(),
                port: 9100,
            },
            error,
        );
        assert_eq!(
            serde_json::to_value(rejected).unwrap(),
            serde_json::json!({
                "success": false,
                "queued": false,
                "printerName": "Brand Printer",
                "sampleKind": "branding",
                "errorCode": "logo_render_failed",
                "error": error_message,
                "resolvedTransport": "raw_tcp",
                "resolvedAddress": "192.0.2.98:9100",
                "verificationStatus": "unverified",
                "logoConfigured": true,
                "logoIncluded": false
            })
        );
    }

    fn preview_profile_from_frontend(payload: serde_json::Value) -> serde_json::Value {
        normalize_draft_profile_payload(payload).expect("frontend profile payload should normalize")
    }

    fn insert_history_command_job(db: &db::DbState, job_id: &str, status: &str) {
        let conn = db.conn.lock().expect("lock test database");
        let order_id = format!("order-{job_id}");
        conn.execute("INSERT INTO orders (id) VALUES (?1)", [&order_id])
            .expect("insert safe legacy order source");
        conn.execute(
            "INSERT INTO print_jobs (
                 id, entity_type, entity_id, status, retry_count, max_retries,
                 last_error, warning_code, warning_message, last_attempt_at,
                 completed_at, history_expires_at, created_at, updated_at
             ) VALUES (
                 ?1, 'order_receipt', ?2, ?3, 3, 3,
                 'printer offline', 'paper_out', 'Load paper', datetime('now'),
                 datetime('now'), ?4, datetime('now'), datetime('now')
             )",
            rusqlite::params![
                job_id,
                order_id,
                status,
                (Utc::now() + ChronoDuration::days(1)).to_rfc3339()
            ],
        )
        .expect("insert print history command source");
    }

    #[test]
    fn print_history_command_retry_continues_same_job_and_emits_once_before_kick() {
        let db = test_db();
        insert_history_command_job(&db, "retry-command-source", "failed");
        let invalidations = Cell::new(0usize);
        let kicks = RefCell::new(Vec::<String>::new());

        let result = finish_print_queue_mutation(
            execute_printer_retry_job(&db, "retry-command-source", Utc::now()),
            retry_kick_job_id,
            || invalidations.set(invalidations.get() + 1),
            |job_id| kicks.borrow_mut().push(job_id.to_string()),
        )
        .expect("Retry command succeeds");

        assert_eq!(
            result,
            serde_json::json!({
                "success": true,
                "jobId": "retry-command-source",
                "newJobId": null,
                "affected": 1,
                "unchanged": false,
                "duplicate": false
            })
        );
        assert_eq!(invalidations.get(), 1);
        assert_eq!(kicks.borrow().as_slice(), ["retry-command-source"]);
        let conn = db.conn.lock().expect("lock test database");
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE id = 'retry-command-source' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("read retried row");
        assert_eq!(rows, 1);
    }

    #[test]
    fn print_history_command_reprint_clones_and_kicks_the_new_job() {
        let db = test_db();
        insert_history_command_job(&db, "reprint-command-source", "cancelled");
        let invalidations = Cell::new(0usize);
        let kicks = RefCell::new(Vec::<String>::new());

        let result = finish_print_queue_mutation(
            execute_print_reprint_job(&db, "reprint-command-source", Utc::now()),
            reprint_kick_job_id,
            || invalidations.set(invalidations.get() + 1),
            |job_id| kicks.borrow_mut().push(job_id.to_string()),
        )
        .expect("Reprint command succeeds");

        let child_id = result["newJobId"]
            .as_str()
            .expect("Reprint exposes its new job ID")
            .to_string();
        assert_ne!(child_id, "reprint-command-source");
        assert_eq!(
            result,
            serde_json::json!({
                "success": true,
                "jobId": "reprint-command-source",
                "newJobId": child_id,
                "affected": 1,
                "unchanged": false,
                "duplicate": false
            })
        );
        assert_eq!(invalidations.get(), 1);
        assert_eq!(kicks.borrow().as_slice(), [child_id.as_str()]);

        let conn = db.conn.lock().expect("lock test database");
        let source_status: String = conn
            .query_row(
                "SELECT status FROM print_jobs WHERE id = 'reprint-command-source'",
                [],
                |row| row.get(0),
            )
            .expect("read source status");
        let child: (String, String) = conn
            .query_row(
                "SELECT status, reprint_of_job_id FROM print_jobs WHERE id = ?1",
                [&child_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read Reprint child");
        assert_eq!(source_status, "cancelled");
        assert_eq!(child, ("pending".into(), "reprint-command-source".into()));
    }

    #[test]
    fn print_history_command_coalesced_reprint_has_no_invalidation_or_kick() {
        let db = test_db();
        insert_history_command_job(&db, "coalesced-command-source", "printed");
        let first =
            crate::print_history::clone_reprint_job(&db, "coalesced-command-source", Utc::now())
                .expect("create active child");
        let active_child = first.new_job_id.expect("active child ID");
        let invalidations = Cell::new(0usize);
        let kicks = RefCell::new(Vec::<String>::new());

        let result = finish_print_queue_mutation(
            execute_print_reprint_job(&db, "coalesced-command-source", Utc::now()),
            reprint_kick_job_id,
            || invalidations.set(invalidations.get() + 1),
            |job_id| kicks.borrow_mut().push(job_id.to_string()),
        )
        .expect("coalesced Reprint succeeds");

        assert_eq!(result["newJobId"], active_child);
        assert_eq!(result["affected"], 0);
        assert_eq!(result["unchanged"], true);
        assert_eq!(result["duplicate"], true);
        assert_eq!(invalidations.get(), 0);
        assert!(kicks.borrow().is_empty());
    }

    #[test]
    fn print_history_command_rejection_has_no_invalidation_or_kick() {
        let db = test_db();
        insert_history_command_job(&db, "rejected-retry-source", "pending");
        let invalidations = Cell::new(0usize);
        let kicks = RefCell::new(Vec::<String>::new());

        let result = finish_print_queue_mutation(
            execute_printer_retry_job(&db, "rejected-retry-source", Utc::now()),
            retry_kick_job_id,
            || invalidations.set(invalidations.get() + 1),
            |job_id| kicks.borrow_mut().push(job_id.to_string()),
        );

        assert!(result.is_err());
        assert_eq!(invalidations.get(), 0);
        assert!(kicks.borrow().is_empty());
    }

    #[test]
    fn print_history_command_rollback_has_no_invalidation_or_kick() {
        let db = test_db();
        insert_history_command_job(&db, "rollback-command-source", "failed");
        {
            let conn = db.conn.lock().expect("lock test database");
            conn.execute_batch(
                "CREATE TRIGGER reject_command_reprint
                 BEFORE INSERT ON print_jobs
                 WHEN NEW.reprint_of_job_id = 'rollback-command-source'
                 BEGIN
                   SELECT RAISE(ABORT, 'forced command rollback');
                 END;",
            )
            .expect("install rollback trigger");
        }
        let invalidations = Cell::new(0usize);
        let kicks = RefCell::new(Vec::<String>::new());

        let result = finish_print_queue_mutation(
            execute_print_reprint_job(&db, "rollback-command-source", Utc::now()),
            reprint_kick_job_id,
            || invalidations.set(invalidations.get() + 1),
            |job_id| kicks.borrow_mut().push(job_id.to_string()),
        );

        assert!(result.is_err());
        assert_eq!(invalidations.get(), 0);
        assert!(kicks.borrow().is_empty());
        let conn = db.conn.lock().expect("lock test database");
        let children: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE reprint_of_job_id = 'rollback-command-source'",
                [],
                |row| row.get(0),
            )
            .expect("count rolled-back children");
        assert_eq!(children, 0);
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
    fn parse_printer_profile_id_payload_accepts_object_shape() {
        let profile_id = parse_printer_profile_id_payload(
            Some(&serde_json::json!({
                "orderId": "order-1",
                "printerProfileId": "receipt-profile-1"
            })),
            None,
        );

        assert_eq!(profile_id.as_deref(), Some("receipt-profile-1"));
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
    fn parse_print_list_jobs_payload_preserves_filters_and_pagination_defaults() {
        let parsed = parse_print_list_jobs_payload(Some(serde_json::json!({
            "state": "dispatched",
            "printerProfileId": "  profile-a  ",
            "limit": 25,
            "offset": 50
        })));
        assert_eq!(
            parsed,
            (Some("dispatched".into()), Some("profile-a".into()), 25, 50)
        );
        assert_eq!(
            parse_print_list_jobs_payload(Some(serde_json::json!("pending"))),
            (Some("pending".into()), None, 50, 0)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn print_list_jobs_blocking_runs_off_runtime_thread_and_preserves_json_or_inner_error() {
        let runtime_thread = thread::current().id();
        let (worker_thread_tx, worker_thread_rx) = std::sync::mpsc::channel();
        let expected = serde_json::json!({
            "success": true,
            "jobs": [{ "id": "safe-job-id", "capabilities": { "retryable": true } }]
        });
        let closure_value = expected.clone();

        let actual = run_print_list_jobs_blocking(move || {
            worker_thread_tx
                .send(thread::current().id())
                .expect("record blocking worker thread");
            Ok(closure_value)
        })
        .await
        .expect("blocking queue snapshot result");

        assert_eq!(actual, expected);
        assert_ne!(
            worker_thread_rx.recv().expect("blocking worker thread id"),
            runtime_thread,
            "SQLite snapshot/serialization must leave the current-thread runtime"
        );
        assert_eq!(
            run_print_list_jobs_blocking(|| Err("queue-read-error".to_string())).await,
            Err("queue-read-error".to_string()),
            "domain errors must remain byte-for-byte unchanged"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn print_list_jobs_blocking_maps_worker_panic_to_fixed_private_error() {
        let panic_error = run_print_list_jobs_blocking(|| -> Result<serde_json::Value, String> {
            panic!("PRIVATE-QUEUE-PANIC-PAYLOAD")
        })
        .await
        .expect_err("worker panic must become an IPC error");

        assert_eq!(panic_error, "Print queue snapshot worker panicked");
        assert!(!panic_error.contains("PRIVATE-QUEUE-PANIC-PAYLOAD"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn printer_ipc_blocking_runner_leaves_runtime_and_preserves_domain_errors() {
        let runtime_thread = thread::current().id();
        let (worker_thread_tx, worker_thread_rx) = std::sync::mpsc::channel();
        let expected = serde_json::json!({
            "success": true,
            "message": "compatible printer command response"
        });
        let closure_value = expected.clone();

        let actual = run_printer_ipc_blocking(move || {
            worker_thread_tx
                .send(thread::current().id())
                .expect("record printer worker thread");
            Ok(closure_value)
        })
        .await
        .expect("blocking printer result");

        assert_eq!(actual, expected);
        assert_ne!(
            worker_thread_rx.recv().expect("printer worker thread id"),
            runtime_thread,
            "printer command work must leave the current-thread Tokio runtime"
        );
        assert_eq!(
            run_printer_ipc_blocking(|| Err::<serde_json::Value, _>("printer-domain-error".into()))
                .await,
            Err("printer-domain-error".to_string()),
            "domain errors must remain byte-for-byte unchanged"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn printer_ipc_blocking_runner_maps_panics_to_fixed_private_error() {
        let panic_error = run_printer_ipc_blocking(|| -> Result<serde_json::Value, String> {
            panic!("PRIVATE-PRINTER-PANIC-PAYLOAD")
        })
        .await
        .expect_err("printer worker panic must become a fixed IPC error");

        assert_eq!(panic_error, "Printer command worker panicked");
        assert!(!panic_error.contains("PRIVATE-PRINTER-PANIC-PAYLOAD"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn printer_ipc_blocking_status_probe_preserves_snapshot_off_runtime_thread() {
        let db = Arc::new(test_db());
        let profile = printers::create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Status blocking probe",
                "printerName": "192.0.2.179",
                "driverType": "escpos",
                "printerType": "network",
                "role": "receipt",
                "connectionJson": serde_json::json!({
                    "type": "network",
                    "ip": "192.0.2.179",
                    "port": 9100,
                    "emulation": "escpos",
                    "render_mode": "text"
                }).to_string()
            }),
        )
        .expect("create status printer profile");
        let profile_id = profile["profileId"]
            .as_str()
            .expect("status profile id")
            .to_string();
        let runtime_thread = thread::current().id();
        let (worker_thread_tx, worker_thread_rx) = std::sync::mpsc::channel();
        let worker_db = Arc::clone(&db);

        let statuses = run_printer_ipc_blocking(move || {
            worker_thread_tx
                .send(thread::current().id())
                .expect("record status worker thread");
            collect_printer_status_map_with_probe(&worker_db, |_| Ok(()))
        })
        .await
        .expect("collect status snapshot");

        assert_ne!(
            worker_thread_rx.recv().expect("status worker thread id"),
            runtime_thread
        );
        assert_eq!(statuses[&profile_id]["printerId"], profile_id);
        assert_eq!(statuses[&profile_id]["state"], "unverified");
        assert_eq!(statuses[&profile_id]["connected"], true);
        assert_eq!(statuses[&profile_id]["transportReachable"], true);
        assert_eq!(statuses[&profile_id]["resolvedTransport"], "raw_tcp");
        assert_eq!(statuses[&profile_id]["resolvedAddress"], "192.0.2.179:9100");
        assert!(statuses[&profile_id]["lastSeen"].is_string());
    }

    #[test]
    fn printer_ipc_status_and_diagnostics_preserve_command_response_contracts() {
        let db = test_db();
        let profile = printers::create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Status contract printer",
                "printerName": "192.0.2.178",
                "driverType": "escpos",
                "printerType": "network",
                "role": "receipt",
                "connectionJson": serde_json::json!({
                    "type": "network",
                    "ip": "192.0.2.178",
                    "port": 9100,
                    "emulation": "escpos",
                    "render_mode": "text"
                }).to_string()
            }),
        )
        .expect("create status contract profile");
        let profile_id = profile["profileId"]
            .as_str()
            .expect("status contract profile id");

        let status = execute_printer_get_status_with_probe(&db, profile_id, |_| Ok(()))
            .expect("status response");
        assert_eq!(status["success"], true);
        assert_eq!(status["printerId"], profile_id);
        assert_eq!(status["state"], "unverified");
        assert_eq!(status["connected"], true);
        assert_eq!(status["transportReachable"], true);
        assert_eq!(status["verificationStatus"], "unverified");
        assert_eq!(status["resolvedTransport"], "raw_tcp");
        assert_eq!(status["resolvedAddress"], "192.0.2.178:9100");
        assert_eq!(status["queueLength"], 0);
        assert_eq!(status["printerName"], "192.0.2.178");
        assert!(status["lastSeen"].is_string());

        let diagnostics =
            execute_printer_diagnostics_with_probe(&db, profile_id, |_| Err("offline".into()))
                .expect("diagnostics response");
        assert_eq!(diagnostics["success"], true);
        assert_eq!(diagnostics["diagnostics"]["printerId"], profile_id);
        assert_eq!(diagnostics["diagnostics"]["connectionType"], "network");
        assert_eq!(diagnostics["diagnostics"]["model"], "192.0.2.178");
        assert_eq!(diagnostics["diagnostics"]["isOnline"], false);
        assert_eq!(diagnostics["diagnostics"]["state"], "offline");
        assert_eq!(
            diagnostics["diagnostics"]["verificationStatus"],
            "unverified"
        );
        assert_eq!(
            diagnostics["diagnostics"]["recentJobs"],
            serde_json::json!({"total": 0, "successful": 0, "failed": 0})
        );
    }

    #[test]
    fn printer_ipc_status_monitor_preserves_invalidation_event_contract() {
        let mut statuses = serde_json::Map::new();
        statuses.insert(
            "printer-contract".into(),
            serde_json::json!({"printerId": "printer-contract", "state": "offline"}),
        );

        assert_eq!(
            printer_status_snapshot_event(statuses, "2026-08-13T10:15:30Z"),
            serde_json::json!({
                "status": "snapshot",
                "statuses": {
                    "printer-contract": {
                        "printerId": "printer-contract",
                        "state": "offline"
                    }
                },
                "updatedAt": "2026-08-13T10:15:30Z"
            })
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn printer_ipc_blocking_saved_sample_prepares_and_enqueues_off_runtime_thread() {
        let db = Arc::new(test_db());
        let profile = printers::create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Saved blocking sample",
                "printerName": "192.0.2.180",
                "driverType": "escpos",
                "printerType": "network",
                "role": "receipt",
                "characterSet": "PC737_GREEK",
                "connectionJson": serde_json::json!({
                    "type": "network",
                    "ip": "192.0.2.180",
                    "port": 9100,
                    "emulation": "escpos",
                    "render_mode": "text"
                }).to_string()
            }),
        )
        .expect("create saved printer profile");
        let profile_id = profile["profileId"]
            .as_str()
            .expect("saved profile id")
            .to_string();
        let runtime_thread = thread::current().id();
        let (worker_thread_tx, worker_thread_rx) = std::sync::mpsc::channel();
        let worker_db = Arc::clone(&db);

        let outcome = run_printer_ipc_blocking(move || {
            worker_thread_tx
                .send(thread::current().id())
                .expect("record saved sample worker thread");
            execute_saved_profile_test_enqueue(
                &worker_db,
                &profile_id,
                WizardSampleKind::TransportText,
                "saved-blocking-command",
            )
        })
        .await
        .expect("enqueue saved sample");

        assert_ne!(
            worker_thread_rx
                .recv()
                .expect("saved sample worker thread id"),
            runtime_thread
        );
        assert_eq!(outcome.sample_kind, "transport_text");
        let conn = db.conn.lock().expect("lock saved sample database");
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE id = ?1 AND status = 'pending'",
                [&outcome.job_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("count saved sample row"),
            1
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn printer_ipc_blocking_draft_sample_prepares_and_enqueues_off_runtime_thread() {
        let db = Arc::new(test_db());
        let payload = PrinterTestDraftPayload {
            profile_draft: serde_json::json!({
                "name": "Draft blocking sample",
                "type": "network",
                "connectionDetails": {
                    "type": "network",
                    "ip": "192.0.2.181",
                    "port": 9100,
                    "emulation": "escpos",
                    "render_mode": "text"
                },
                "paperSize": "80mm",
                "role": "receipt",
                "characterSet": "PC737_GREEK",
                "enabled": true
            }),
            sample_kind: WizardSampleKind::Encoding,
            probe_attempt: 0,
            wizard_session_id: "draft-blocking-command".into(),
            confirmed_candidate_connection_details: None,
        };
        let runtime_thread = thread::current().id();
        let (worker_thread_tx, worker_thread_rx) = std::sync::mpsc::channel();
        let worker_db = Arc::clone(&db);

        let outcome = run_printer_ipc_blocking(move || {
            worker_thread_tx
                .send(thread::current().id())
                .expect("record draft sample worker thread");
            execute_draft_profile_test_enqueue(&worker_db, payload)
        })
        .await
        .expect("prepare draft sample");

        assert_ne!(
            worker_thread_rx
                .recv()
                .expect("draft sample worker thread id"),
            runtime_thread
        );
        let DraftWizardEnqueue::Queued(outcome) = outcome else {
            panic!("encoding draft should enqueue")
        };
        assert_eq!(outcome.sample_kind, "encoding");
        let conn = db.conn.lock().expect("lock draft sample database");
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE id = ?1 AND status = 'pending'",
                [&outcome.job_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("count draft sample row"),
            1
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn printer_test_greek_direct_alias_enqueues_encoding_before_notify_and_kick() {
        let db = Arc::new(test_db());
        let profile = printers::create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Greek direct compatibility",
                "printerName": "192.0.2.182",
                "driverType": "escpos",
                "printerType": "network",
                "role": "receipt",
                "characterSet": "PC737_GREEK",
                "connectionJson": serde_json::json!({
                    "type": "network",
                    "ip": "192.0.2.182",
                    "port": 9100,
                    "emulation": "escpos",
                    "render_mode": "text"
                }).to_string()
            }),
        )
        .expect("create Greek direct printer profile");
        let profile_id = profile["profileId"]
            .as_str()
            .expect("Greek direct profile id")
            .to_string();
        let worker_db = Arc::clone(&db);

        let outcome = run_printer_ipc_blocking(move || {
            execute_greek_compatibility_enqueue(&worker_db, &profile_id, "greek-managed-alias")
        })
        .await
        .expect("Greek compatibility sample enqueue");

        assert_eq!(outcome.sample_kind, "encoding");
        assert!(!outcome.duplicate);
        let job_id = outcome.job_id.clone();
        let assert_pending_snapshot = || {
            let conn = db.conn.lock().expect("lock Greek queue database");
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM print_jobs WHERE id = ?1",
                    [&job_id],
                    |row| row.get::<_, String>(0),
                )
                .expect("Greek queue row exists"),
                "pending"
            );
            let bytes = crate::print_snapshot::load_snapshot(&conn, &job_id)
                .expect("load Greek snapshot")
                .expect("Greek snapshot is durable");
            assert!(bytes.windows(3).any(|window| window == [0x1b, 0x74, 14]));
        };
        let order = RefCell::new(Vec::new());
        let response = finish_wizard_print_enqueue(
            Ok(outcome),
            || {
                assert_pending_snapshot();
                order.borrow_mut().push("notify");
            },
            |kicked_job_id| {
                assert_eq!(kicked_job_id, job_id);
                assert_pending_snapshot();
                order.borrow_mut().push("kick");
            },
        )
        .expect("finish Greek managed enqueue");
        assert_eq!(order.into_inner(), vec!["notify", "kick"]);

        let response = serde_json::to_value(response).expect("serialize Greek queued response");
        assert_eq!(response["success"], true);
        assert_eq!(response["queued"], true);
        assert_eq!(response["sampleKind"], "encoding");
        assert_eq!(response["queueState"], "pending");
        assert!(response.get("latencyMs").is_none());
        assert!(response.get("bytesWritten").is_none());

        let duplicate = execute_greek_compatibility_enqueue(
            &db,
            profile["profileId"].as_str().expect("profile id"),
            "different-session-same-target",
        )
        .expect("coalesce Greek duplicate");
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.job_id, job_id);
        let notifications = Cell::new(0);
        let kicks = Cell::new(0);
        finish_wizard_print_enqueue(
            Ok(duplicate),
            || notifications.set(notifications.get() + 1),
            |_| kicks.set(kicks.get() + 1),
        )
        .expect("finish duplicate Greek enqueue");
        assert_eq!((notifications.get(), kicks.get()), (0, 0));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn printer_discovery_blocking_sources_leave_runtime_before_async_lan_merge() {
        let db = Arc::new(test_db());
        let runtime_thread = thread::current().id();
        let (worker_thread_tx, worker_thread_rx) = std::sync::mpsc::channel();
        let worker_db = Arc::clone(&db);
        let sender = worker_thread_tx.clone();
        let usb_sender = worker_thread_tx.clone();
        let bluetooth_sender = worker_thread_tx.clone();
        let bluetooth_serial_sender = worker_thread_tx.clone();

        let snapshot = run_printer_ipc_blocking(move || {
            collect_discovery_blocking_with_sources(
                &worker_db,
                true,
                true,
                move || {
                    sender
                        .send(thread::current().id())
                        .expect("system source thread");
                    vec!["System Queue".to_string()]
                },
                move |_| {
                    usb_sender
                        .send(thread::current().id())
                        .expect("USB source thread");
                    vec![serde_json::json!({
                        "name": "USB Printer",
                        "type": "usb",
                        "address": "COM7"
                    })]
                },
                move |_| {
                    bluetooth_sender
                        .send(thread::current().id())
                        .expect("Bluetooth source thread");
                    Ok(vec![serde_json::json!({
                        "name": "Bluetooth Printer",
                        "type": "bluetooth",
                        "address": "AA:BB:CC:DD:EE:FF"
                    })])
                },
                move |_| {
                    bluetooth_serial_sender
                        .send(thread::current().id())
                        .expect("Bluetooth serial source thread");
                    vec![]
                },
                move || {
                    worker_thread_tx
                        .send(thread::current().id())
                        .expect("local IP source thread");
                    vec![std::net::Ipv4Addr::new(192, 168, 1, 42)]
                },
            )
        })
        .await
        .expect("collect blocking discovery sources");

        for _ in 0..5 {
            assert_ne!(
                worker_thread_rx.recv().expect("blocking discovery thread"),
                runtime_thread
            );
        }
        assert_eq!(snapshot.system_printer_names, vec!["System Queue"]);
        assert_eq!(
            snapshot.local_ips,
            vec![std::net::Ipv4Addr::new(192, 168, 1, 42)]
        );

        let lan = vec![serde_json::json!({
            "name": "LAN Printer (192.168.1.19)",
            "type": "network",
            "address": "192.168.1.19",
            "port": 9100
        })];
        let response = network_scan_response(snapshot, lan);
        assert_eq!(response["success"], true);
        assert_eq!(response["type"], "network");
        assert_eq!(response["printers"][0]["name"], "System Queue");
        assert_eq!(response["printers"][1]["name"], "USB Printer");
        assert_eq!(
            response["printers"][2]["name"],
            "LAN Printer (192.168.1.19)"
        );
    }

    #[test]
    fn printer_discovery_response_helpers_preserve_bluetooth_and_combined_shapes() {
        assert_eq!(
            system_printers_response(vec!["Receipt Queue".into(), "Kitchen Queue".into()]),
            serde_json::json!({
                "success": true,
                "printers": ["Receipt Queue", "Kitchen Queue"]
            })
        );

        let bluetooth_snapshot = BlockingDiscoverySnapshot {
            configured: ConfiguredPrinterLookup::default(),
            system_printer_names: vec![],
            usb_serial: vec![],
            bluetooth: vec![serde_json::json!({
                "name": "Star Bluetooth",
                "type": "bluetooth",
                "address": "AA:BB:CC:DD:EE:FF"
            })],
            local_ips: vec![],
        };
        let bluetooth = bluetooth_scan_response(bluetooth_snapshot);
        assert_eq!(bluetooth["success"], true);
        assert_eq!(bluetooth["type"], "bluetooth");
        assert_eq!(bluetooth["message"], "Discovered 1 Bluetooth device(s)");
        assert_eq!(bluetooth["printers"][0]["name"], "Star Bluetooth");

        let combined_snapshot = BlockingDiscoverySnapshot {
            configured: ConfiguredPrinterLookup::default(),
            system_printer_names: vec!["Windows Queue".into()],
            usb_serial: vec![],
            bluetooth: vec![serde_json::json!({
                "name": "Star Bluetooth",
                "type": "bluetooth",
                "address": "AA:BB:CC:DD:EE:FF"
            })],
            local_ips: vec![],
        };
        let combined = printer_discover_response(
            combined_snapshot,
            vec![serde_json::json!({
                "name": "LAN Printer",
                "type": "network",
                "address": "192.168.1.19"
            })],
            true,
            true,
        );
        assert_eq!(combined["success"], true);
        assert_eq!(combined["printers"].as_array().map(Vec::len), Some(3));
        assert_eq!(combined["printers"][0]["name"], "Windows Queue");
        assert_eq!(combined["printers"][1]["name"], "LAN Printer");
        assert_eq!(combined["printers"][2]["name"], "Star Bluetooth");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn printer_ipc_blocking_drawer_preserves_guarded_errors_and_hides_panics() {
        let runtime_thread = thread::current().id();
        let (worker_thread_tx, worker_thread_rx) = std::sync::mpsc::channel();
        let response = run_guarded_printer_ipc_blocking(move || {
            worker_thread_tx
                .send(thread::current().id())
                .expect("record drawer worker thread");
            Ok(serde_json::json!({"success": true, "message": "drawer opened"}))
        })
        .await
        .expect("guarded drawer response");
        assert_eq!(response["success"], true);
        assert_ne!(
            worker_thread_rx.recv().expect("drawer worker thread id"),
            runtime_thread
        );

        let domain_error = run_guarded_printer_ipc_blocking(|| {
            Err::<serde_json::Value, _>("drawer-domain-error".to_string())
        })
        .await
        .expect_err("drawer domain error");
        assert!(matches!(
            domain_error,
            auth::GuardedCommandError::Message(ref message) if message == "drawer-domain-error"
        ));

        let panic_error =
            run_guarded_printer_ipc_blocking(|| -> Result<serde_json::Value, String> {
                panic!("PRIVATE-DRAWER-PANIC-PAYLOAD")
            })
            .await
            .expect_err("drawer worker panic");
        assert!(matches!(
            panic_error,
            auth::GuardedCommandError::Message(ref message)
                if message == "Printer command worker panicked"
                    && !message.contains("PRIVATE-DRAWER-PANIC-PAYLOAD")
        ));
    }

    #[test]
    fn print_queue_event_gate_rejects_token_only_non_durable_result() {
        let mut token_only = serde_json::json!({
            "success": true,
            "durableChanged": false,
            "activeStopsRequested": 1
        });
        assert!(!take_print_queue_durable_changed(&mut token_only));
        assert!(token_only.get("durableChanged").is_none());

        let mut committed = serde_json::json!({
            "success": true,
            "durableChanged": true
        });
        assert!(take_print_queue_durable_changed(&mut committed));
        assert!(committed.get("durableChanged").is_none());
    }

    #[test]
    fn print_queue_control_payload_rejects_malformed_or_ambiguous_scope() {
        assert!(parse_print_queue_control_payload(Some(serde_json::json!({
            "printerProfileId": "profile-a",
            "statuses": "pending"
        })))
        .is_err());
        assert!(parse_print_queue_control_payload(Some(serde_json::json!({
            "printerProfileId": "   "
        })))
        .is_err());
        assert!(parse_print_queue_control_payload(Some(serde_json::json!({
            "printerProfileID": "profile-a"
        })))
        .is_err());
        assert!(parse_print_queue_control_payload(Some(serde_json::json!(42))).is_err());
    }

    #[test]
    fn print_queue_control_payload_preserves_only_explicit_scopes() {
        let global = parse_print_queue_control_payload(None).unwrap();
        assert_eq!(global.printer_profile_id, None);
        assert!(global.statuses.is_empty());

        let object_global = parse_print_queue_control_payload(Some(serde_json::json!({}))).unwrap();
        assert_eq!(object_global.printer_profile_id, None);

        let profile =
            parse_print_queue_control_payload(Some(serde_json::json!("  profile-a  "))).unwrap();
        assert_eq!(profile.printer_profile_id.as_deref(), Some("profile-a"));
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
    fn apply_receipt_preview_overrides_applies_density_and_boldness_settings() {
        let profile = serde_json::json!({});
        let payload = serde_json::json!({
            "receiptSettings": {
                "layoutDensityScale": 1.2,
                "bodyBoldness": 5
            }
        });
        let mut layout = receipt_renderer::LayoutConfig::default();

        apply_receipt_preview_overrides(&profile, &payload, &mut layout);

        assert!((layout.layout_density_scale - 1.2).abs() < f32::EPSILON);
        assert_eq!(layout.body_font_weight, 800);
    }

    #[test]
    fn parse_profile_id_payload_requires_value() {
        let err = parse_profile_id_payload(Some(serde_json::json!({})))
            .expect_err("missing id should fail");
        assert!(err.contains("Missing profileId"));
    }
}
