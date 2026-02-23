use chrono::Utc;
use serde::Deserialize;
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use tauri::Emitter;
use tracing::{info, warn};

use crate::{
    db, drawer, escpos, payload_arg0_as_string, print, printers, read_local_json_array, value_str,
    write_local_json,
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

fn parse_order_id_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .ok_or("Missing orderId".into())
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

fn should_discover_system_like(requested: &[String]) -> bool {
    requested.is_empty()
        || requested
            .iter()
            .any(|t| matches!(t.as_str(), "system" | "network" | "wifi" | "usb"))
}

fn should_discover_bluetooth(requested: &[String]) -> bool {
    requested.iter().any(|t| t == "bluetooth")
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
    _arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_order_id_payload(arg0)?;
    print::enqueue_print_job(&db, "order_receipt", &order_id, None)
}

#[tauri::command]
pub async fn kitchen_print_ticket(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_order_id_payload(arg0)?;
    print::enqueue_print_job(&db, "kitchen_ticket", &order_id, None)
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
            serde_json::json!({
                "type": printer_type,
                "systemName": printer_name
            })
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
        ("fallbackPrinterId", "fallbackPrinterId"),
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
            }
        }
    }

    lookup
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
        std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() => Some(ip),
        _ => None,
    }
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
    let primary_ip = match detect_primary_ipv4() {
        Some(ip) => ip,
        None => {
            warn!("LAN printer discovery skipped: unable to detect primary IPv4 address");
            return vec![];
        }
    };
    let hosts = lan_subnet_hosts(primary_ip);
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
        primary_ip = %primary_ip,
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
    // Use a broad present-device query so printer modules that are not yet in fully "OK" state
    // are still visible in the discovery modal.
    let script = r#"
$ErrorActionPreference = 'Stop'
$devices = Get-PnpDevice -PresentOnly | Where-Object {
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
    let system = printers::list_system_printers();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut status_map = serde_json::Map::new();
    if let Some(arr) = profiles.as_array() {
        for profile in arr {
            let printer_id = value_str(profile, &["id"]).unwrap_or_default();
            let printer_name =
                value_str(profile, &["printerName", "printer_name"]).unwrap_or_default();
            let connected = system.iter().any(|name| name == &printer_name);

            let queue_len: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM print_jobs WHERE status IN ('pending', 'printing') AND printer_profile_id = ?1",
                    rusqlite::params![printer_id],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            let state = if connected { "online" } else { "offline" };
            status_map.insert(
                printer_id.clone(),
                serde_json::json!({
                    "printerId": printer_id,
                    "state": state,
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

            tokio::time::sleep(cadence).await;
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
    let printers = discover_bluetooth_printers_native(&configured)?;
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
        out.extend(discover_lan_printers_native(&configured).await);
    }

    if wants_bluetooth {
        let bluetooth = discover_bluetooth_printers_native(&configured)?;
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
    let system = printers::list_system_printers();
    let connected = system.iter().any(|name| name == &printer_name);
    let state = if connected { "online" } else { "offline" };

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

#[tauri::command]
pub async fn printer_test(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let printer_id = parse_printer_id_payload(arg0)?;
    let profile = printers::get_printer_profile(&db, &printer_id)?;
    let printer_name = value_str(&profile, &["printerName", "printer_name"]).unwrap_or_default();

    if printer_name.is_empty() {
        return Err("Printer has no system printer name configured".into());
    }

    let known_printers = printers::list_system_printers();
    let printer_known = known_printers.iter().any(|name| name == &printer_name);
    if !printer_known {
        return Ok(serde_json::json!({
            "success": false,
            "printerId": printer_id,
            "error": format!("Printer \"{}\" is not installed in Windows Printers", printer_name),
            "printerName": printer_name,
            "knownPrinters": known_printers,
        }));
    }

    let start = std::time::Instant::now();

    // Determine paper width from profile
    let paper_mm = profile
        .get("paperWidthMm")
        .or_else(|| profile.get("paper_width_mm"))
        .and_then(|v| v.as_i64())
        .unwrap_or(80) as i32;
    let paper = escpos::PaperWidth::from_mm(paper_mm);

    let now_str = chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S UTC")
        .to_string();

    // Generate ESC/POS binary test page
    let mut builder = escpos::EscPosBuilder::new().with_paper(paper);
    builder
        .init()
        .center()
        .bold(true)
        .text("TEST PRINT\n")
        .bold(false)
        .separator()
        .left()
        .text(&format!("Printer: {}\n", printer_name))
        .text(&format!("Date: {}\n", now_str))
        .separator()
        .text("ABCDEFGHIJKLMNOPQRSTUVWXYZ\n")
        .text("abcdefghijklmnopqrstuvwxyz\n")
        .text("0123456789 !@#$%^&*()\n")
        .separator()
        .center()
        .text("-- End of Test --\n")
        .feed(4)
        .cut();
    let test_data = builder.build();

    let doc_name = "POS Test Print";
    // Send raw ESC/POS bytes to Windows printer
    match printers::print_raw_to_windows(&printer_name, &test_data, doc_name) {
        Ok(dispatch) => {
            if let Err(probe_error) = printers::probe_printer_spool(&printer_name) {
                warn!(
                    printer = %printer_name,
                    error = %probe_error,
                    "Printer spool probe failed after test print dispatch"
                );
                return Ok(serde_json::json!({
                    "success": false,
                    "printerId": printer_id,
                    "printerName": printer_name,
                    "error": format!("Print data was sent but spool status probe failed: {probe_error}"),
                    "bytesRequested": dispatch.bytes_requested,
                    "bytesWritten": dispatch.bytes_written,
                    "docName": dispatch.doc_name,
                    "latencyMs": start.elapsed().as_millis() as u64
                }));
            }

            let latency_ms = start.elapsed().as_millis() as u64;
            info!(
                printer = %printer_name,
                latency_ms = latency_ms,
                bytes = test_data.len(),
                "Test print dispatched (ESC/POS raw)"
            );
            Ok(serde_json::json!({
                "success": true,
                "printerId": printer_id,
                "printerName": printer_name,
                "latencyMs": latency_ms,
                "message": "Test print dispatched",
                "bytesRequested": dispatch.bytes_requested,
                "bytesWritten": dispatch.bytes_written,
                "docName": dispatch.doc_name
            }))
        }
        Err(e) => {
            warn!(printer = %printer_name, error = %e, "Test print failed");
            Ok(serde_json::json!({
                "success": false,
                "printerId": printer_id,
                "printerName": printer_name,
                "error": e,
                "latencyMs": start.elapsed().as_millis() as u64,
                "bytesRequested": test_data.len(),
                "bytesWritten": 0,
                "docName": doc_name
            }))
        }
    }
}

#[tauri::command]
pub async fn printer_test_greek_direct(
    arg0: Option<String>,
    arg1: Option<String>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": true,
        "mode": arg0.unwrap_or_else(|| "ascii".to_string()),
        "printerName": arg1.unwrap_or_else(|| "POS-80".to_string())
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
    let system = printers::list_system_printers();
    let connected = system.iter().any(|name| name == &printer_name);

    Ok(serde_json::json!({
        "success": true,
        "diagnostics": {
            "printerId": printer_id,
            "connectionType": printer_type,
            "model": printer_name,
            "isOnline": connected,
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
        "available": false,
        "message": "Bluetooth printer transport is not implemented in Tauri backend yet"
    }))
}

#[tauri::command]
pub async fn printer_open_cash_drawer(
    arg0: Option<serde_json::Value>,
    _arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
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

#[cfg(test)]
mod dto_tests {
    use super::*;

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
    fn printer_discover_defaults_exclude_bluetooth() {
        let requested = parse_printer_discover_types(None);
        assert!(should_discover_system_like(&requested));
        assert!(!should_discover_bluetooth(&requested));
    }

    #[test]
    fn printer_discover_includes_bluetooth_only_when_requested() {
        let requested = parse_printer_discover_types(Some(serde_json::json!(["bluetooth"])));
        assert!(should_discover_bluetooth(&requested));
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
    fn parse_profile_id_payload_requires_value() {
        let err = parse_profile_id_payload(Some(serde_json::json!({})))
            .expect_err("missing id should fail");
        assert!(err.contains("Missing profileId"));
    }
}
