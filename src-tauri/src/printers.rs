//! Printer profile management and ESC/POS printing for The Small POS.
//!
//! Provides CRUD operations for printer profiles stored in SQLite, enumerates
//! installed Windows printers via the `winspool` API, and dispatches print
//! jobs either to the Windows print spooler or directly over raw TCP for LAN
//! thermal printers.

use chrono::Utc;
use rusqlite::params;
use serde_json::{Map, Value};
use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::db::{self, DbState};

// ---------------------------------------------------------------------------
// Printer brand detection
// ---------------------------------------------------------------------------

/// Known printer brands for ESC/POS auto-configuration.
///
/// Different brands assign different code page numbers to the same encoding
/// (e.g. CP737 Greek = 14 on Epson, 15 on Star). Auto-detecting the brand
/// from the Windows printer name lets us pick the right number automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrinterBrand {
    Epson,
    Star,
    Citizen,
    Bixolon,
    Custom,
    Sewoo,
    Rongta,
    Xprinter,
    Unknown,
}

impl PrinterBrand {
    /// Human-readable label for logs and UI.
    pub fn label(self) -> &'static str {
        match self {
            Self::Epson => "Epson",
            Self::Star => "Star",
            Self::Citizen => "Citizen",
            Self::Bixolon => "Bixolon",
            Self::Custom => "Custom",
            Self::Sewoo => "Sewoo",
            Self::Rongta => "Rongta",
            Self::Xprinter => "Xprinter",
            Self::Unknown => "Unknown",
        }
    }
}

/// Detect printer brand from the Windows printer name.
///
/// Matches case-insensitively against known brand prefixes and model patterns
/// (e.g. "Star MCP31", "EPSON TM-T88", "CT-S310II").
pub fn detect_printer_brand(printer_name: &str) -> PrinterBrand {
    let lower = printer_name.trim().to_ascii_lowercase();

    // Star: "Star MCP31", "Star TSP143", "Star mC-Print3", "TSP650"
    if lower.starts_with("star ")
        || lower.starts_with("star_")
        || lower.contains("mcprint")
        || lower.contains("mc-print")
        || lower.contains("mcp3")
        || lower.contains("mcp31")
        || lower.contains("mcp30")
        || lower.contains("mcp20")
        || lower.starts_with("tsp")
        || lower.contains("star mc")
    {
        return PrinterBrand::Star;
    }

    // Epson: "EPSON TM-T88VI", "TM-T20III", "TM-m30"
    if lower.starts_with("epson")
        || lower.starts_with("tm-t")
        || lower.starts_with("tm-m")
        || lower.starts_with("tm-u")
        || lower.starts_with("tm-l")
        || lower.starts_with("tm-p")
    {
        return PrinterBrand::Epson;
    }

    // Citizen: "Citizen CT-S310II", "CT-S801", "CT-E351"
    if lower.starts_with("citizen")
        || lower.starts_with("ct-s")
        || lower.starts_with("ct-e")
        || lower.starts_with("ct-d")
    {
        return PrinterBrand::Citizen;
    }

    // Bixolon: "BIXOLON SRP-350III", "SRP-330", "Samsung SRP-"
    if lower.starts_with("bixolon") || lower.starts_with("srp-") || lower.starts_with("samsung srp")
    {
        return PrinterBrand::Bixolon;
    }

    // Custom (Italian brand): "Custom K80", "Custom VKP80"
    if lower.starts_with("custom ") || lower.starts_with("vkp80") {
        return PrinterBrand::Custom;
    }

    // Sewoo: "Sewoo SLK-TS400"
    if lower.starts_with("sewoo") || lower.starts_with("slk-") {
        return PrinterBrand::Sewoo;
    }

    // Rongta: "Rongta RP326"
    if lower.starts_with("rongta") {
        return PrinterBrand::Rongta;
    }

    // Xprinter: "Xprinter XP-Q200", "XP-80C"
    if lower.starts_with("xprinter") || lower.starts_with("xp-") {
        return PrinterBrand::Xprinter;
    }

    PrinterBrand::Unknown
}

static NETWORK_BRAND_CACHE: std::sync::OnceLock<Mutex<HashMap<String, (Instant, PrinterBrand)>>> =
    std::sync::OnceLock::new();

const NETWORK_BRAND_CACHE_TTL_SECS: u64 = 300;
const NETWORK_BRAND_PROBE_TIMEOUT_MS: u64 = 1200;

fn network_brand_cache() -> &'static Mutex<HashMap<String, (Instant, PrinterBrand)>> {
    NETWORK_BRAND_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn parse_network_http_probe_target(host: &str) -> Option<(String, u16, String)> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with("https://") {
        return None;
    }

    let without_scheme = trimmed.strip_prefix("http://").unwrap_or(trimmed);
    let authority = without_scheme
        .split_once('/')
        .map(|(value, _)| value)
        .unwrap_or(without_scheme)
        .trim();
    if authority.is_empty() {
        return None;
    }

    if let Some(stripped) = authority.strip_prefix('[') {
        let (host_part, remainder) = stripped.split_once(']')?;
        let port = remainder
            .strip_prefix(':')
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(80);
        return Some((host_part.to_string(), port, authority.to_string()));
    }

    if let Some((host_part, port_part)) = authority.rsplit_once(':') {
        if let Ok(port) = port_part.parse::<u16>() {
            if !host_part.trim().is_empty() {
                return Some((host_part.trim().to_string(), port, authority.to_string()));
            }
        }
    }

    Some((authority.to_string(), 80, authority.to_string()))
}

fn probe_network_printer_brand_http_target(
    connect_host: &str,
    port: u16,
    host_header: &str,
) -> PrinterBrand {
    use std::io::{Read, Write};

    // Reject any host_header containing control characters (\r, \n, \t,
    // other C0, or DEL). Without this guard the format! below would fold
    // arbitrary headers into the outgoing HTTP request (CRLF injection) if
    // the printer configuration stored a malicious host value.
    if host_header.bytes().any(|b| b < 0x20 || b == 0x7F) || host_header.is_empty() {
        warn!("rejecting printer brand probe: host_header contains control characters or is empty");
        return PrinterBrand::Unknown;
    }

    let mut stream = match connect_tcp_socket(connect_host, port, NETWORK_BRAND_PROBE_TIMEOUT_MS) {
        Ok(stream) => stream,
        Err(_) => return PrinterBrand::Unknown,
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(NETWORK_BRAND_PROBE_TIMEOUT_MS)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(NETWORK_BRAND_PROBE_TIMEOUT_MS)));

    let request = format!(
        "GET / HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: TheSmallPOS/1.0\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return PrinterBrand::Unknown;
    }
    let _ = stream.flush();

    let mut response = Vec::with_capacity(4096);
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&chunk[..read]);
                if response.len() >= 16 * 1024 {
                    break;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                break;
            }
            Err(_) => return PrinterBrand::Unknown,
        }
    }

    if response.is_empty() {
        return PrinterBrand::Unknown;
    }

    let response_text = String::from_utf8_lossy(&response);
    let response_text_ref = response_text.as_ref();
    let (headers, body) = response_text_ref
        .split_once("\r\n\r\n")
        .or_else(|| response_text_ref.split_once("\n\n"))
        .unwrap_or((response_text_ref, ""));

    let mut server_header = String::new();
    for line in headers.lines() {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("server") {
                server_header = value.trim().to_string();
                break;
            }
        }
    }

    let body_excerpt: String = body.chars().take(4096).collect();
    let mut probe = String::with_capacity(server_header.len() + body_excerpt.len() + 1);
    probe.push_str(&server_header);
    probe.push(' ');
    probe.push_str(&body_excerpt);
    detect_printer_brand(&probe)
}

fn probe_network_printer_brand_http(host: &str) -> PrinterBrand {
    let Some((connect_host, port, host_header)) = parse_network_http_probe_target(host) else {
        return PrinterBrand::Unknown;
    };

    let detected = probe_network_printer_brand_http_target(&connect_host, port, &host_header);
    if detected != PrinterBrand::Unknown || port == 80 {
        return detected;
    }

    probe_network_printer_brand_http_target(&connect_host, 80, &connect_host)
}

pub fn detect_network_printer_brand(host: &str) -> PrinterBrand {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return PrinterBrand::Unknown;
    }

    if let Ok(cache) = network_brand_cache().lock() {
        if let Some((cached_at, cached_brand)) = cache.get(trimmed) {
            if cached_at.elapsed().as_secs() < NETWORK_BRAND_CACHE_TTL_SECS {
                return *cached_brand;
            }
        }
    }

    let detected = probe_network_printer_brand_http(trimmed);

    if let Ok(mut cache) = network_brand_cache().lock() {
        cache.insert(trimmed.to_string(), (Instant::now(), detected));
    }

    if detected != PrinterBrand::Unknown {
        info!(host = %trimmed, detected_brand = %detected.label(), "Detected network printer brand");
    }

    detected
}

#[derive(Debug, Clone)]
pub struct RawPrintResult {
    pub bytes_requested: usize,
    pub bytes_written: usize,
    pub doc_name: String,
    pub spool_job_id: Option<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RawTransportFailureKind {
    DefinitelyNotSent,
    AmbiguousAfterWrite,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RawTransportFailure {
    pub kind: RawTransportFailureKind,
    pub bytes_requested: usize,
    pub bytes_written: usize,
    pub message: String,
}

impl RawTransportFailure {
    fn definitely_not_sent(bytes_requested: usize, message: String) -> Self {
        Self {
            kind: RawTransportFailureKind::DefinitelyNotSent,
            bytes_requested,
            bytes_written: 0,
            message,
        }
    }

    fn ambiguous(bytes_requested: usize, bytes_written: usize, message: String) -> Self {
        Self {
            kind: RawTransportFailureKind::AmbiguousAfterWrite,
            bytes_requested,
            bytes_written: bytes_written.min(bytes_requested),
            message,
        }
    }
}

fn raw_transport_result(
    bytes_requested: usize,
    bytes_written: usize,
    doc_name: &str,
) -> RawPrintResult {
    RawPrintResult {
        bytes_requested,
        bytes_written,
        doc_name: doc_name.to_owned(),
        spool_job_id: None,
    }
}

fn windows_spool_result(
    bytes_requested: usize,
    doc_name: &str,
    submission: crate::windows_spooler::SpoolSubmission,
) -> RawPrintResult {
    RawPrintResult {
        bytes_requested,
        bytes_written: bytes_requested,
        doc_name: doc_name.to_owned(),
        spool_job_id: Some(submission.started.job_id),
    }
}

fn windows_spool_error(error: crate::windows_spooler::SpoolerError) -> String {
    error.to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedPrinterTarget {
    WindowsQueue { printer_name: String },
    RawTcp { host: String, port: u16 },
    SerialPort { port_name: String, baud_rate: u32 },
}

impl ResolvedPrinterTarget {
    pub fn label(&self) -> String {
        match self {
            Self::WindowsQueue { printer_name } => printer_name.clone(),
            Self::RawTcp { host, port } => format!("{host}:{port}"),
            Self::SerialPort {
                port_name,
                baud_rate,
            } => format!("{port_name}@{baud_rate}"),
        }
    }

    pub fn transport_name(&self) -> &'static str {
        match self {
            Self::WindowsQueue { .. } => "windows_queue",
            Self::RawTcp { .. } => "raw_tcp",
            Self::SerialPort { .. } => "serial",
        }
    }
}

const RAW_TCP_CONNECT_TIMEOUT_MS: u64 = 3000;
const RAW_TCP_WRITE_TIMEOUT_MS: u64 = 5000;
// Aggregate wall-clock cap on the whole chunked write (kept under the 20s dispatch
// watchdog so the transport returns a clean error before the watchdog abandons it).
const RAW_TCP_TOTAL_WRITE_DEADLINE_MS: u64 = 18000;
const RAW_TCP_PROBE_TIMEOUT_MS: u64 = 1500;
const RAW_SERIAL_TIMEOUT_MS: u64 = 3000;
const DEFAULT_SERIAL_BAUD_RATE: u32 = 9600;

#[derive(Debug, Clone, Default)]
pub struct PrinterCapabilitySnapshot {
    pub status: String,
    pub resolved_transport: Option<String>,
    pub resolved_address: Option<String>,
    pub emulation: Option<String>,
    pub render_mode: Option<String>,
    pub baud_rate: Option<u32>,
    pub supports_cut: bool,
    pub supports_logo: bool,
    pub last_verified_at: Option<String>,
}

fn value_to_trimmed_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn value_to_port(value: Option<&Value>) -> Option<u16> {
    let parsed = match value {
        Some(Value::Number(n)) => n.as_u64().map(|v| v as u16),
        Some(Value::String(s)) => s.trim().parse::<u16>().ok(),
        _ => None,
    }?;
    if parsed == 0 {
        None
    } else {
        Some(parsed)
    }
}

fn value_to_u32(value: Option<&Value>) -> Option<u32> {
    let parsed = match value {
        Some(Value::Number(n)) => n.as_u64().map(|v| v as u32),
        Some(Value::String(s)) => s.trim().parse::<u32>().ok(),
        _ => None,
    }?;
    if parsed == 0 {
        None
    } else {
        Some(parsed)
    }
}

fn capabilities_object(connection: Option<&Map<String, Value>>) -> Option<&Map<String, Value>> {
    connection
        .and_then(|obj| obj.get("capabilities"))
        .and_then(Value::as_object)
}

fn ensure_capabilities_object(connection: &mut Map<String, Value>) -> &mut Map<String, Value> {
    let needs_init = !matches!(connection.get("capabilities"), Some(Value::Object(_)));
    if needs_init {
        connection.insert("capabilities".to_string(), serde_json::json!({}));
    }
    // SAFETY: if `needs_init` was true, the insert above makes `capabilities` an
    // Object; if it was false, `capabilities` was already Some(Value::Object(_))
    // per the `matches!` check. Either branch guarantees `as_object_mut()` is Some.
    connection
        .get_mut("capabilities")
        .and_then(Value::as_object_mut)
        .expect("capabilities object should exist (guarded above)")
}

fn default_capabilities_value() -> Value {
    serde_json::json!({
        "status": "unverified",
        "resolvedTransport": Value::Null,
        "resolvedAddress": Value::Null,
        "emulation": Value::Null,
        "renderMode": Value::Null,
        "baudRate": Value::Null,
        "supportsCut": false,
        "supportsLogo": false,
        "lastVerifiedAt": Value::Null
    })
}

fn capability_reset_fields() -> &'static [&'static str] {
    &[
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
    ]
}

fn capability_reset_required(
    previous: Option<&Map<String, Value>>,
    next: &Map<String, Value>,
) -> bool {
    let Some(previous) = previous else {
        return true;
    };

    capability_reset_fields()
        .iter()
        .any(|field| previous.get(*field) != next.get(*field))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CapabilityEvidenceTrust {
    Untrusted,
    Validated,
}

fn normalize_capabilities_for_connection(
    previous_connection: Option<&Map<String, Value>>,
    next_connection: &mut Map<String, Value>,
    evidence_trust: CapabilityEvidenceTrust,
) {
    let should_reset = capability_reset_required(previous_connection, next_connection);
    let previous_capabilities = capabilities_object(previous_connection).cloned();
    let incoming_capabilities = capabilities_object(Some(next_connection)).cloned();
    let capabilities = ensure_capabilities_object(next_connection);

    if evidence_trust == CapabilityEvidenceTrust::Untrusted {
        let incoming_matches_previous = incoming_capabilities
            .as_ref()
            .zip(previous_capabilities.as_ref())
            .map(|(incoming, previous)| incoming == previous)
            .unwrap_or(false);
        let incoming_is_empty = incoming_capabilities
            .as_ref()
            .map(Map::is_empty)
            .unwrap_or(true);

        if should_reset || (!incoming_is_empty && !incoming_matches_previous) {
            *capabilities = default_capabilities_value()
                .as_object()
                .cloned()
                .unwrap_or_default();
            return;
        }
    }

    if should_reset {
        // A strictly verified/degraded wizard candidate owns its exact resolved
        // target and protocol evidence. Preserve that allowlisted snapshot;
        // unverified/stale capabilities still reset completely.
        let incoming_status = capabilities
            .get("status")
            .and_then(Value::as_str)
            .filter(|s| *s == "verified" || *s == "degraded")
            .map(|s| s.to_string());
        let confirmed_fields = incoming_status.as_ref().map(|_| {
            [
                "resolvedTransport",
                "resolvedAddress",
                "emulation",
                "renderMode",
                "baudRate",
                "escposCodePage",
                "supportsCut",
                "supportsLogo",
                "lastVerifiedAt",
            ]
            .into_iter()
            .filter_map(|key| capabilities.get(key).cloned().map(|value| (key, value)))
            .collect::<Vec<_>>()
        });

        *capabilities = default_capabilities_value()
            .as_object()
            .cloned()
            .unwrap_or_default();

        if let Some(status) = incoming_status {
            capabilities.insert("status".to_string(), Value::String(status));
            for (key, value) in confirmed_fields.unwrap_or_default() {
                capabilities.insert(key.to_string(), value);
            }
        }
        return;
    }

    if capabilities.is_empty() {
        *capabilities = previous_capabilities.unwrap_or_else(|| {
            default_capabilities_value()
                .as_object()
                .cloned()
                .unwrap_or_default()
        });
    }

    if !matches!(
        capabilities.get("status").and_then(Value::as_str),
        Some("verified" | "degraded" | "unverified")
    ) {
        capabilities.insert(
            "status".to_string(),
            Value::String("unverified".to_string()),
        );
    }
}

pub fn read_capability_snapshot(profile: &Value) -> PrinterCapabilitySnapshot {
    let connection_json = profile_connection_json_value(profile);
    let connection = connection_json.as_ref().and_then(Value::as_object);
    let capabilities = capabilities_object(connection);

    PrinterCapabilitySnapshot {
        status: value_to_trimmed_string(capabilities.and_then(|obj| obj.get("status")))
            .unwrap_or_else(|| "unverified".to_string())
            .to_ascii_lowercase(),
        resolved_transport: value_to_trimmed_string(
            capabilities.and_then(|obj| obj.get("resolvedTransport")),
        ),
        resolved_address: value_to_trimmed_string(
            capabilities.and_then(|obj| obj.get("resolvedAddress")),
        ),
        emulation: value_to_trimmed_string(capabilities.and_then(|obj| obj.get("emulation")))
            .map(|value| value.to_ascii_lowercase()),
        render_mode: value_to_trimmed_string(capabilities.and_then(|obj| obj.get("renderMode")))
            .map(|value| value.to_ascii_lowercase()),
        baud_rate: value_to_u32(capabilities.and_then(|obj| obj.get("baudRate"))),
        supports_cut: capabilities
            .and_then(|obj| obj.get("supportsCut"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        supports_logo: capabilities
            .and_then(|obj| obj.get("supportsLogo"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        last_verified_at: value_to_trimmed_string(
            capabilities.and_then(|obj| obj.get("lastVerifiedAt")),
        ),
    }
}

fn capability_status_is_verified(status: &str) -> bool {
    matches!(status, "verified" | "degraded")
}

pub fn capability_status(profile: &Value) -> String {
    read_capability_snapshot(profile).status
}

pub fn capability_verification_status(profile: &Value) -> &'static str {
    match capability_status(profile).as_str() {
        "verified" => "verified",
        "degraded" => "degraded",
        _ => "unverified",
    }
}

fn is_serial_port_name(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let upper = trimmed.to_ascii_uppercase();
    upper.starts_with("COM")
        || trimmed.starts_with("/dev/")
        || trimmed.starts_with("tty")
        || trimmed.starts_with("cu.")
}

fn connection_string(
    connection: Option<&serde_json::Map<String, Value>>,
    key: &str,
) -> Option<String> {
    value_to_trimmed_string(connection.and_then(|obj| obj.get(key)))
}

fn available_serial_ports() -> Vec<serialport::SerialPortInfo> {
    serialport::available_ports().unwrap_or_default()
}

fn resolve_serial_port_name(
    profile: &Value,
    connection: Option<&serde_json::Map<String, Value>>,
    capability_snapshot: &PrinterCapabilitySnapshot,
) -> Option<String> {
    if capability_snapshot
        .resolved_transport
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("serial"))
        .unwrap_or(false)
    {
        if let Some(address) = capability_snapshot.resolved_address.as_deref() {
            if is_serial_port_name(address) {
                return Some(address.to_string());
            }
        }
    }

    let direct_candidates = [
        connection_string(connection, "serialPort"),
        connection_string(connection, "portName"),
        connection_string(connection, "comPort"),
        connection_string(connection, "path"),
        connection_string(connection, "port"),
    ];
    for candidate in direct_candidates.into_iter().flatten() {
        if is_serial_port_name(&candidate) {
            return Some(candidate);
        }
    }

    let ports = available_serial_ports();

    if let (Some(vendor_id), Some(product_id)) = (
        value_to_u32(connection.and_then(|obj| obj.get("vendorId"))),
        value_to_u32(connection.and_then(|obj| obj.get("productId"))),
    ) {
        if let Some(port) = ports.iter().find(|port| match &port.port_type {
            serialport::SerialPortType::UsbPort(usb) => {
                u32::from(usb.vid) == vendor_id && u32::from(usb.pid) == product_id
            }
            _ => false,
        }) {
            return Some(port.port_name.clone());
        }
    }

    let printer_name = value_to_trimmed_string(
        profile
            .get("printerName")
            .or_else(|| profile.get("printer_name")),
    )
    .unwrap_or_default()
    .to_ascii_lowercase();
    let profile_name = value_to_trimmed_string(profile.get("name"))
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut bluetooth_matches = ports
        .iter()
        .filter(|port| matches!(port.port_type, serialport::SerialPortType::BluetoothPort))
        .map(|port| port.port_name.clone())
        .collect::<Vec<String>>();
    bluetooth_matches.sort();
    bluetooth_matches.dedup();
    if bluetooth_matches.len() == 1 {
        return bluetooth_matches.into_iter().next();
    }

    for port in ports {
        let haystack = match &port.port_type {
            serialport::SerialPortType::UsbPort(usb) => format!(
                "{} {} {} {} {}",
                port.port_name,
                usb.manufacturer.clone().unwrap_or_default(),
                usb.product.clone().unwrap_or_default(),
                usb.serial_number.clone().unwrap_or_default(),
                printer_name
            )
            .to_ascii_lowercase(),
            _ => port.port_name.to_ascii_lowercase(),
        };
        if (!printer_name.is_empty() && haystack.contains(&printer_name))
            || (!profile_name.is_empty() && haystack.contains(&profile_name))
        {
            return Some(port.port_name);
        }
    }

    None
}

fn resolved_target_from_capabilities(
    capability_snapshot: &PrinterCapabilitySnapshot,
) -> Option<ResolvedPrinterTarget> {
    if !capability_status_is_verified(&capability_snapshot.status) {
        return None;
    }

    match capability_snapshot.resolved_transport.as_deref() {
        Some("windows_queue") => {
            capability_snapshot
                .resolved_address
                .as_ref()
                .map(|printer_name| ResolvedPrinterTarget::WindowsQueue {
                    printer_name: printer_name.clone(),
                })
        }
        Some("raw_tcp") => capability_snapshot
            .resolved_address
            .as_ref()
            .and_then(|address| {
                let (host, port) = address.rsplit_once(':')?;
                let port = port.parse::<u16>().ok()?;
                Some(ResolvedPrinterTarget::RawTcp {
                    host: host.to_string(),
                    port,
                })
            }),
        Some("serial") => capability_snapshot
            .resolved_address
            .as_ref()
            .map(|port_name| ResolvedPrinterTarget::SerialPort {
                port_name: port_name.clone(),
                baud_rate: capability_snapshot
                    .baud_rate
                    .unwrap_or(DEFAULT_SERIAL_BAUD_RATE),
            }),
        _ => None,
    }
}

fn profile_connection_json_value(profile: &Value) -> Option<Value> {
    match profile
        .get("connectionJson")
        .or_else(|| profile.get("connection_json"))
    {
        Some(Value::String(raw)) => serde_json::from_str::<Value>(raw).ok(),
        Some(Value::Object(obj)) => Some(Value::Object(obj.clone())),
        _ => None,
    }
}

fn profile_connection_json_string(profile: &Value) -> Option<String> {
    match profile
        .get("connectionJson")
        .or_else(|| profile.get("connection_json"))
    {
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(Value::Object(obj)) => Some(Value::Object(obj.clone()).to_string()),
        _ => None,
    }
}

fn role_uses_classic_receipt_defaults(role: &str) -> bool {
    matches!(
        role.trim().to_ascii_lowercase().as_str(),
        "receipt" | "kitchen"
    )
}

fn normalize_connection_json_for_role_with_trust(
    role: &str,
    raw_connection_json: Option<&str>,
    current_connection_json: Option<&str>,
    evidence_trust: CapabilityEvidenceTrust,
) -> Result<Option<String>, String> {
    let uses_receipt_defaults = role_uses_classic_receipt_defaults(role);
    let Some(raw_connection_json) = raw_connection_json
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        if uses_receipt_defaults {
            return Ok(Some(
                serde_json::json!({
                    "render_mode": "text",
                    "emulation": "auto",
                    "capabilities": default_capabilities_value()
                })
                .to_string(),
            ));
        }
        return Ok(None);
    };

    let mut parsed: Value = serde_json::from_str(raw_connection_json)
        .map_err(|e| format!("Invalid connection_json: {e}"))?;
    let object = parsed
        .as_object_mut()
        .ok_or("connection_json must be a JSON object")?;
    let current_connection = current_connection_json
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.as_object().cloned());
    if uses_receipt_defaults {
        object
            .entry("render_mode".to_string())
            .or_insert_with(|| Value::String("text".to_string()));
    }
    object
        .entry("emulation".to_string())
        .or_insert_with(|| Value::String("auto".to_string()));
    normalize_capabilities_for_connection(current_connection.as_ref(), object, evidence_trust);

    Ok(Some(parsed.to_string()))
}

pub(crate) fn normalize_connection_json_for_role(
    role: &str,
    raw_connection_json: Option<&str>,
    current_connection_json: Option<&str>,
) -> Result<Option<String>, String> {
    normalize_connection_json_for_role_with_trust(
        role,
        raw_connection_json,
        current_connection_json,
        CapabilityEvidenceTrust::Untrusted,
    )
}

fn normalized_printer_type(value: Option<&str>) -> &'static str {
    match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "network" | "lan" => "network",
        "wifi" => "wifi",
        "bluetooth" | "bt" => "bluetooth",
        "usb" => "usb",
        "system" => "system",
        _ => "system",
    }
}

pub fn profile_uses_star_line_mode(profile: &Value) -> bool {
    let connection_json = profile_connection_json_value(profile);
    let connection = connection_json.as_ref().and_then(Value::as_object);
    let emulation = value_to_trimmed_string(connection.and_then(|obj| obj.get("emulation")))
        .map(|value| value.to_ascii_lowercase());
    let capability_snapshot = read_capability_snapshot(profile);

    match emulation.as_deref() {
        Some("star_line") => true,
        Some("escpos") => false,
        _ => {
            capability_status_is_verified(&capability_snapshot.status)
                && capability_snapshot.emulation.as_deref() == Some("star_line")
        }
    }
}

pub fn detect_printer_brand_for_profile(profile: &Value) -> PrinterBrand {
    let connection_json = profile_connection_json_value(profile);
    let connection = connection_json.as_ref().and_then(Value::as_object);
    let connection_type = normalized_printer_type(
        value_to_trimmed_string(connection.and_then(|obj| obj.get("type")))
            .or_else(|| {
                value_to_trimmed_string(
                    profile
                        .get("printerType")
                        .or_else(|| profile.get("printer_type")),
                )
            })
            .as_deref(),
    );

    let candidates = [
        value_to_trimmed_string(
            profile
                .get("printerName")
                .or_else(|| profile.get("printer_name")),
        ),
        value_to_trimmed_string(profile.get("name")),
        value_to_trimmed_string(connection.and_then(|obj| obj.get("systemName"))),
        value_to_trimmed_string(connection.and_then(|obj| obj.get("deviceName"))),
        value_to_trimmed_string(connection.and_then(|obj| obj.get("hostname"))),
        value_to_trimmed_string(connection.and_then(|obj| obj.get("address"))),
        value_to_trimmed_string(connection.and_then(|obj| obj.get("ip"))),
    ];

    for candidate in candidates.into_iter().flatten() {
        let detected = detect_printer_brand(&candidate);
        if detected != PrinterBrand::Unknown {
            return detected;
        }
    }

    if matches!(connection_type, "network" | "wifi") {
        let network_host = value_to_trimmed_string(connection.and_then(|obj| obj.get("hostname")))
            .or_else(|| value_to_trimmed_string(connection.and_then(|obj| obj.get("host"))))
            .or_else(|| value_to_trimmed_string(connection.and_then(|obj| obj.get("ip"))))
            .or_else(|| value_to_trimmed_string(connection.and_then(|obj| obj.get("address"))))
            .or_else(|| {
                value_to_trimmed_string(
                    profile
                        .get("printerName")
                        .or_else(|| profile.get("printer_name")),
                )
            });
        if let Some(host) = network_host {
            let detected = detect_network_printer_brand(&host);
            if detected != PrinterBrand::Unknown {
                return detected;
            }
        }
    }

    PrinterBrand::Unknown
}

pub fn resolve_printer_target(profile: &Value) -> Result<ResolvedPrinterTarget, String> {
    let connection_json = profile_connection_json_value(profile);
    let connection = connection_json.as_ref().and_then(Value::as_object);
    let capability_snapshot = read_capability_snapshot(profile);

    if let Some(target) = resolved_target_from_capabilities(&capability_snapshot) {
        return Ok(target);
    }

    let connection_type = normalized_printer_type(
        value_to_trimmed_string(connection.and_then(|obj| obj.get("type")))
            .or_else(|| {
                value_to_trimmed_string(
                    profile
                        .get("printerType")
                        .or_else(|| profile.get("printer_type")),
                )
            })
            .as_deref(),
    );

    match connection_type {
        "network" | "wifi" => {
            let host = value_to_trimmed_string(connection.and_then(|obj| obj.get("ip")))
                .or_else(|| value_to_trimmed_string(connection.and_then(|obj| obj.get("hostname"))))
                .or_else(|| value_to_trimmed_string(connection.and_then(|obj| obj.get("host"))))
                .or_else(|| value_to_trimmed_string(connection.and_then(|obj| obj.get("address"))))
                .or_else(|| {
                    value_to_trimmed_string(
                        profile
                            .get("printerName")
                            .or_else(|| profile.get("printer_name")),
                    )
                })
                .ok_or("Network printer is missing host/IP configuration")?;
            let port = value_to_port(connection.and_then(|obj| obj.get("port"))).unwrap_or(9100);
            Ok(ResolvedPrinterTarget::RawTcp { host, port })
        }
        "usb" | "bluetooth" => {
            let windows_printer_name = value_to_trimmed_string(
                connection.and_then(|obj| obj.get("systemName")),
            )
            .or_else(|| {
                value_to_trimmed_string(
                    profile
                        .get("printerName")
                        .or_else(|| profile.get("printer_name")),
                )
            });

            if let Some(printer_name) = windows_printer_name.as_deref() {
                if list_system_printers()
                    .iter()
                    .any(|name| name == printer_name)
                {
                    return Ok(ResolvedPrinterTarget::WindowsQueue {
                        printer_name: printer_name.to_string(),
                    });
                }
            }

            if let Some(port_name) =
                resolve_serial_port_name(profile, connection, &capability_snapshot)
            {
                let baud_rate = value_to_u32(connection.and_then(|obj| obj.get("baudRate")))
                    .or(capability_snapshot.baud_rate)
                    .unwrap_or(DEFAULT_SERIAL_BAUD_RATE);
                return Ok(ResolvedPrinterTarget::SerialPort {
                    port_name,
                    baud_rate,
                });
            }

            Err(format!(
                "{} printer is discovered but has no printable Windows queue or serial/RFCOMM port",
                connection_type
            ))
        }
        _ => {
            let printer_name =
                value_to_trimmed_string(connection.and_then(|obj| obj.get("systemName")))
                    .or_else(|| {
                        value_to_trimmed_string(
                            profile
                                .get("printerName")
                                .or_else(|| profile.get("printer_name")),
                        )
                    })
                    .ok_or("Printer has no Windows printer name configured")?;
            Ok(ResolvedPrinterTarget::WindowsQueue { printer_name })
        }
    }
}

// ---------------------------------------------------------------------------
// System printer list cache (avoids calling EnumPrintersW on every poll)
// ---------------------------------------------------------------------------

/// Cached system printer list with a 10-second TTL.
///
/// Initialized lazily on first access. Uses `OnceLock` (stable since 1.70)
/// to hold the `Mutex`, avoiding the `LazyLock` MSRV requirement (1.80).
static PRINTER_CACHE: std::sync::OnceLock<Mutex<(Instant, Vec<String>)>> =
    std::sync::OnceLock::new();
static PRINTER_ENUM_LOG_STATE: std::sync::OnceLock<Mutex<Option<u64>>> = std::sync::OnceLock::new();

fn printer_cache() -> &'static Mutex<(Instant, Vec<String>)> {
    PRINTER_CACHE.get_or_init(|| {
        Mutex::new((
            Instant::now() - std::time::Duration::from_secs(60),
            Vec::new(),
        ))
    })
}

fn printer_enum_log_state() -> &'static Mutex<Option<u64>> {
    PRINTER_ENUM_LOG_STATE.get_or_init(|| Mutex::new(None))
}

fn printer_inventory_hash(names: &[String]) -> u64 {
    let mut normalized = names.to_vec();
    normalized.sort_unstable();
    let mut hasher = DefaultHasher::new();
    normalized.hash(&mut hasher);
    hasher.finish()
}

fn log_printer_inventory_if_changed(names: &[String]) {
    let current_hash = printer_inventory_hash(names);
    if let Ok(mut previous_hash) = printer_enum_log_state().lock() {
        if previous_hash
            .map(|value| value != current_hash)
            .unwrap_or(true)
        {
            *previous_hash = Some(current_hash);
            info!(count = names.len(), "Windows printer inventory changed");
        }
    }
}

const PRINTER_CACHE_TTL_SECS: u64 = 10;

// ---------------------------------------------------------------------------
// Windows printer enumeration (compile-time gated)
// ---------------------------------------------------------------------------

/// List the names of printers installed on this Windows system.
///
/// Uses the `winspool.drv` `EnumPrintersW` API (level 2).  Falls back to an
/// empty list if the call fails or if compiled on a non-Windows target.
///
/// Results are cached for [`PRINTER_CACHE_TTL_SECS`] seconds to avoid
/// hammering the Win32 API on frequent status polls.
#[cfg(target_os = "windows")]
pub fn list_system_printers() -> Vec<String> {
    // Check cache first
    if let Ok(cache) = printer_cache().lock() {
        if cache.0.elapsed().as_secs() < PRINTER_CACHE_TTL_SECS {
            return cache.1.clone();
        }
    }

    let names = enumerate_windows_printers();

    // Update cache
    if let Ok(mut cache) = printer_cache().lock() {
        *cache = (Instant::now(), names.clone());
    }

    names
}

#[cfg(target_os = "windows")]
fn enumerate_windows_printers() -> Vec<String> {
    use std::ptr;

    const PRINTER_ENUM_LOCAL: u32 = 0x00000002;
    const PRINTER_ENUM_CONNECTIONS: u32 = 0x00000004;

    #[repr(C)]
    #[allow(non_snake_case, non_camel_case_types)]
    struct PRINTER_INFO_2W {
        pServerName: *mut u16,
        pPrinterName: *mut u16,
        pShareName: *mut u16,
        pPortName: *mut u16,
        pDriverName: *mut u16,
        pComment: *mut u16,
        pLocation: *mut u16,
        pDevMode: *mut u8,
        pSepFile: *mut u16,
        pPrintProcessor: *mut u16,
        pDatatype: *mut u16,
        pParameters: *mut u16,
        pSecurityDescriptor: *mut u8,
        Attributes: u32,
        Priority: u32,
        DefaultPriority: u32,
        StartTime: u32,
        UntilTime: u32,
        Status: u32,
        cJobs: u32,
        AveragePPM: u32,
    }

    #[link(name = "winspool")]
    extern "system" {
        fn EnumPrintersW(
            Flags: u32,
            Name: *mut u16,
            Level: u32,
            pPrinterEnum: *mut u8,
            cbBuf: u32,
            pcbNeeded: *mut u32,
            pcReturned: *mut u32,
        ) -> i32;
    }

    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed: u32 = 0;
    let mut returned: u32 = 0;

    unsafe {
        EnumPrintersW(
            flags,
            ptr::null_mut(),
            2,
            ptr::null_mut(),
            0,
            &mut needed,
            &mut returned,
        );
    }

    if needed == 0 {
        warn!("EnumPrintersW returned 0 bytes needed — no printers found");
        return Vec::new();
    }

    let mut buffer: Vec<u8> = vec![0u8; needed as usize];
    let ok = unsafe {
        EnumPrintersW(
            flags,
            ptr::null_mut(),
            2,
            buffer.as_mut_ptr(),
            needed,
            &mut needed,
            &mut returned,
        )
    };

    if ok == 0 {
        error!("EnumPrintersW failed on second call");
        return Vec::new();
    }

    let infos = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr() as *const PRINTER_INFO_2W, returned as usize)
    };

    let mut names = Vec::with_capacity(returned as usize);
    for info in infos {
        if info.pPrinterName.is_null() {
            continue;
        }
        let name = unsafe {
            let len = (0..)
                .take_while(|&i| *info.pPrinterName.add(i) != 0)
                .count();
            String::from_utf16_lossy(std::slice::from_raw_parts(info.pPrinterName, len))
        };
        names.push(name);
    }

    log_printer_inventory_if_changed(&names);
    names
}

#[cfg(not(target_os = "windows"))]
pub fn list_system_printers() -> Vec<String> {
    warn!("list_system_printers called on non-Windows platform — returning empty");
    Vec::new()
}

// ---------------------------------------------------------------------------
// Print raw bytes to Windows spooler (winspool API)
// ---------------------------------------------------------------------------

/// Send raw binary data (ESC/POS) to a Windows printer via the winspool API.
///
/// Delegates to the single Winspool RAW adapter. Success means Windows
/// accepted and finalized the spool document, not that paper was printed.
#[cfg(target_os = "windows")]
pub fn print_raw_to_windows_cancellable(
    printer_name: &str,
    data: &[u8],
    doc_name: &str,
    cancel: &AtomicBool,
) -> Result<RawPrintResult, String> {
    use crate::windows_spooler::{SystemWindowsSpooler, WindowsRawRequest, WindowsSpooler};

    let submission = SystemWindowsSpooler
        .submit_raw(
            WindowsRawRequest {
                printer_name: printer_name.to_owned(),
                document_name: doc_name.to_owned(),
                bytes: std::sync::Arc::from(data),
            },
            cancel,
            &mut |_| Ok(()),
        )
        .map_err(windows_spool_error)?;

    info!(
        printer = %printer_name,
        bytes = data.len(),
        doc = %doc_name,
        spool_job_id = submission.started.job_id,
        "Windows print spooler accepted and finalized the raw document"
    );
    Ok(windows_spool_result(data.len(), doc_name, submission))
}

#[cfg(not(target_os = "windows"))]
pub fn print_raw_to_windows_cancellable(
    _printer_name: &str,
    _data: &[u8],
    _doc_name: &str,
    _cancel: &AtomicBool,
) -> Result<RawPrintResult, String> {
    Err("Windows raw printing not available on this platform".into())
}

fn connect_tcp_socket(
    host: &str,
    port: u16,
    timeout_ms: u64,
) -> Result<std::net::TcpStream, String> {
    use std::net::ToSocketAddrs;
    use std::time::Duration;

    let mut last_error: Option<String> = None;
    let target = format!("{host}:{port}");
    let addrs: Vec<std::net::SocketAddr> = target
        .to_socket_addrs()
        .map_err(|e| format!("Resolve TCP printer target {target}: {e}"))?
        .collect();

    if addrs.is_empty() {
        return Err(format!("No socket addresses resolved for {target}"));
    }

    for addr in addrs {
        match std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms)) {
            Ok(stream) => return Ok(stream),
            Err(error) => {
                last_error = Some(format!("{addr}: {error}"));
            }
        }
    }

    Err(format!(
        "Failed to connect to network printer {target}: {}",
        last_error.unwrap_or_else(|| "unknown connection error".to_string())
    ))
}

fn write_raw_payload_in_chunks<W: std::io::Write>(
    writer: &mut W,
    data: &[u8],
    chunk_size: usize,
    chunk_delay: Duration,
    deadline: Instant,
    cancel: &AtomicBool,
    target_label: &str,
) -> Result<usize, String> {
    write_raw_payload_in_chunks_with_evidence(
        writer,
        data,
        chunk_size,
        chunk_delay,
        deadline,
        cancel,
        target_label,
    )
    .map_err(|failure| failure.message)
}

fn write_raw_payload_in_chunks_with_evidence<W: std::io::Write>(
    writer: &mut W,
    data: &[u8],
    chunk_size: usize,
    chunk_delay: Duration,
    deadline: Instant,
    cancel: &AtomicBool,
    target_label: &str,
) -> Result<usize, RawTransportFailure> {
    write_raw_payload_in_chunks_with_evidence_and_clock(
        writer,
        data,
        chunk_size,
        chunk_delay,
        deadline,
        cancel,
        target_label,
        Instant::now,
    )
}

fn write_raw_payload_in_chunks_with_evidence_and_clock<W: std::io::Write, F: FnMut() -> Instant>(
    writer: &mut W,
    data: &[u8],
    chunk_size: usize,
    chunk_delay: Duration,
    deadline: Instant,
    cancel: &AtomicBool,
    target_label: &str,
    mut now: F,
) -> Result<usize, RawTransportFailure> {
    let chunk_size = chunk_size.max(1);
    let mut written_total = 0usize;
    let guard = |written_total: usize, observed_now: Instant| {
        let message = if cancel.load(Ordering::Acquire) {
            Some(format!(
                "Print dispatch to {target_label} was stopped by the operator after writing {written_total}/{} bytes; raw print state is unknown. Automatic retry stopped.",
                data.len()
            ))
        } else if observed_now >= deadline {
            Some(format!(
                "{target_label} did not accept the receipt within the write deadline after writing {written_total}/{} bytes; raw print state is unknown. Automatic retry stopped.",
                data.len()
            ))
        } else {
            None
        };
        match message {
            Some(message) if written_total == 0 => Err(RawTransportFailure::definitely_not_sent(
                data.len(),
                message,
            )),
            Some(message) => Err(RawTransportFailure::ambiguous(
                data.len(),
                written_total,
                message,
            )),
            None => Ok(()),
        }
    };

    for chunk in data.chunks(chunk_size) {
        guard(written_total, now())?;

        let mut chunk_offset = 0usize;
        while chunk_offset < chunk.len() {
            guard(written_total, now())?;
            match writer.write(&chunk[chunk_offset..]) {
                Ok(0) => {
                    return Err(RawTransportFailure::ambiguous(
                        data.len(),
                        written_total,
                        format!(
                            "Raw write to {target_label} made no progress after it wrote {written_total}/{} bytes; raw print state is unknown. Automatic retry stopped.",
                            data.len()
                        ),
                    ));
                }
                Ok(written) => {
                    let bounded = written.min(chunk.len() - chunk_offset);
                    chunk_offset += bounded;
                    written_total = written_total.saturating_add(bounded).min(data.len());
                }
                Err(error) => {
                    return Err(RawTransportFailure::ambiguous(
                        data.len(),
                        written_total,
                        format!(
                            "Raw write to {target_label} failed after it wrote {written_total}/{} bytes ({error}); raw print state is unknown. Automatic retry stopped.",
                            data.len()
                        ),
                    ));
                }
            }
        }
        guard(written_total, now())?;
        writer.flush().map_err(|error| {
            RawTransportFailure::ambiguous(
                data.len(),
                written_total,
                format!(
                "Raw flush to {target_label} failed after it wrote {written_total}/{} bytes ({error}); raw print state is unknown. Automatic retry stopped.",
                data.len()
                ),
            )
        })?;

        if !chunk_delay.is_zero() && written_total < data.len() {
            std::thread::sleep(chunk_delay);
        }
    }

    guard(written_total, now())?;

    Ok(written_total)
}

pub fn print_raw_to_tcp_cancellable(
    host: &str,
    port: u16,
    data: &[u8],
    doc_name: &str,
    cancel: &AtomicBool,
) -> Result<RawPrintResult, String> {
    print_raw_to_tcp_cancellable_with_evidence(host, port, data, doc_name, cancel)
        .map_err(|failure| failure.message)
}

pub(crate) fn print_raw_to_tcp_cancellable_with_evidence(
    host: &str,
    port: u16,
    data: &[u8],
    doc_name: &str,
    cancel: &AtomicBool,
) -> Result<RawPrintResult, RawTransportFailure> {
    info!(
        host = %host,
        port,
        payload_bytes = data.len(),
        doc = %doc_name,
        "Sending raw data to network thermal printer"
    );

    let mut stream = connect_tcp_socket(host, port, RAW_TCP_CONNECT_TIMEOUT_MS)
        .map_err(|message| RawTransportFailure::definitely_not_sent(data.len(), message))?;
    stream
        .set_write_timeout(Some(Duration::from_millis(RAW_TCP_WRITE_TIMEOUT_MS)))
        .map_err(|error| {
            RawTransportFailure::definitely_not_sent(
                data.len(),
                format!("Set network printer write timeout for {host}:{port}: {error}"),
            )
        })?;
    let _ = stream.set_nodelay(true);

    // Chunk large payloads to avoid overwhelming the printer's receive buffer.
    // Star mC-Print3 and similar LAN printers can drop data when the full
    // payload (logo raster + receipt body) exceeds the TCP receive window.
    //
    // Wave 6 L: `std::thread::sleep` is correct for this sync function but
    // can block a Tokio worker when called from a `#[tauri::command] async`
    // entry-point. On a large raster (5-10 chunks × 20 ms) that is up to
    // 200 ms of blocked worker. Async callers SHOULD wrap this call in
    // `tokio::task::spawn_blocking(...)`. Converting the whole helper to
    // async would cascade into every printer-dispatch site (serial, USB,
    // Windows spool), which is out of scope for this fix.
    const TCP_CHUNK_SIZE: usize = 4096;
    const TCP_CHUNK_DELAY_MS: u64 = 20;
    // SO_SNDTIMEO bounds each write()'s NO-PROGRESS time, not the aggregate: a
    // half-open peer trickling >=1 byte per <5s window keeps write_all alive
    // indefinitely. Cap the whole write and treat every post-connect failure as
    // physically ambiguous. A partial Star raster stream can leave the printer
    // in raster mode; automatically sending the receipt again compounds that
    // state and is the failure pattern that produces continuous gibberish.
    let write_deadline = Instant::now() + Duration::from_millis(RAW_TCP_TOTAL_WRITE_DEADLINE_MS);
    let chunk_delay = if data.len() > TCP_CHUNK_SIZE {
        Duration::from_millis(TCP_CHUNK_DELAY_MS)
    } else {
        Duration::ZERO
    };
    let target_label = format!("network printer {host}:{port}");
    let written = write_raw_payload_in_chunks_with_evidence(
        &mut stream,
        data,
        TCP_CHUNK_SIZE,
        chunk_delay,
        write_deadline,
        cancel,
        &target_label,
    )?;

    info!(
        host = %host,
        port,
        bytes = data.len(),
        doc = %doc_name,
        "Sent raw data to network thermal printer"
    );

    Ok(raw_transport_result(data.len(), written, doc_name))
}

pub fn probe_printer_tcp(host: &str, port: u16) -> Result<(), String> {
    let stream = connect_tcp_socket(host, port, RAW_TCP_PROBE_TIMEOUT_MS)?;
    let _ = stream.shutdown(std::net::Shutdown::Both);
    Ok(())
}

pub fn print_raw_to_serial_cancellable(
    port_name: &str,
    baud_rate: u32,
    data: &[u8],
    doc_name: &str,
    cancel: &AtomicBool,
) -> Result<RawPrintResult, String> {
    print_raw_to_serial_cancellable_with_evidence(port_name, baud_rate, data, doc_name, cancel)
        .map_err(|failure| failure.message)
}

pub(crate) fn print_raw_to_serial_cancellable_with_evidence(
    port_name: &str,
    baud_rate: u32,
    data: &[u8],
    doc_name: &str,
    cancel: &AtomicBool,
) -> Result<RawPrintResult, RawTransportFailure> {
    let mut port = serialport::new(port_name, baud_rate)
        .timeout(Duration::from_millis(RAW_SERIAL_TIMEOUT_MS))
        .open()
        .map_err(|error| {
            RawTransportFailure::definitely_not_sent(
                data.len(),
                format!("Open serial printer {port_name} @ {baud_rate}: {error}"),
            )
        })?;

    let target_label = format!("serial printer {port_name} @ {baud_rate}");
    let written = write_raw_payload_in_chunks_with_evidence(
        &mut port,
        data,
        4096,
        Duration::ZERO,
        Instant::now() + Duration::from_millis(RAW_TCP_TOTAL_WRITE_DEADLINE_MS),
        cancel,
        &target_label,
    )?;

    info!(
        port = %port_name,
        baud_rate,
        bytes = data.len(),
        doc = %doc_name,
        "Sent raw data to serial thermal printer"
    );

    Ok(raw_transport_result(data.len(), written, doc_name))
}

pub fn probe_printer_serial(port_name: &str, baud_rate: u32) -> Result<(), String> {
    // Wave 3: on HEAD this probe opened the port and immediately dropped
    // it, returning Ok before any I/O. A busy or mis-wired serial port
    // can satisfy `.open()` while not responding to any thermal-printer
    // command, so users would see "probe passed" but real prints would
    // fail. Sending a short ESC/POS initialise sequence and requiring
    // the driver to accept the write is a better health signal with
    // negligible cost on a real printer.
    let mut port = serialport::new(port_name, baud_rate)
        .timeout(Duration::from_millis(RAW_SERIAL_TIMEOUT_MS))
        .open()
        .map_err(|e| format!("Open serial printer {port_name} @ {baud_rate}: {e}"))?;

    // ESC @  — ESC/POS "initialise printer". Universally supported and
    // has no observable side-effect on a healthy device.
    const ESC_AT: &[u8] = &[0x1B, 0x40];
    port.write_all(ESC_AT)
        .map_err(|e| format!("Probe write to serial printer {port_name} @ {baud_rate}: {e}"))?;
    port.flush()
        .map_err(|e| format!("Probe flush on serial printer {port_name} @ {baud_rate}: {e}"))?;
    Ok(())
}

#[allow(dead_code)]
pub fn print_raw_for_profile(
    profile: &Value,
    data: &[u8],
    doc_name: &str,
) -> Result<RawPrintResult, String> {
    let target = resolve_printer_target(profile)?;
    print_raw_for_target(&target, data, doc_name)
}

pub fn print_raw_for_target(
    target: &ResolvedPrinterTarget,
    data: &[u8],
    doc_name: &str,
) -> Result<RawPrintResult, String> {
    let cancel = AtomicBool::new(false);
    print_raw_for_target_cancellable(target, data, doc_name, &cancel)
}

pub fn print_raw_for_target_cancellable(
    target: &ResolvedPrinterTarget,
    data: &[u8],
    doc_name: &str,
    cancel: &AtomicBool,
) -> Result<RawPrintResult, String> {
    match target {
        ResolvedPrinterTarget::WindowsQueue { printer_name } => {
            print_raw_to_windows_cancellable(printer_name, data, doc_name, cancel)
        }
        ResolvedPrinterTarget::RawTcp { host, port } => {
            print_raw_to_tcp_cancellable(host, *port, data, doc_name, cancel)
        }
        ResolvedPrinterTarget::SerialPort {
            port_name,
            baud_rate,
        } => print_raw_to_serial_cancellable(port_name, *baud_rate, data, doc_name, cancel),
    }
}

pub(crate) fn print_raw_for_target_cancellable_with_evidence(
    target: &ResolvedPrinterTarget,
    data: &[u8],
    doc_name: &str,
    cancel: &AtomicBool,
) -> Result<RawPrintResult, RawTransportFailure> {
    match target {
        ResolvedPrinterTarget::RawTcp { host, port } => {
            print_raw_to_tcp_cancellable_with_evidence(host, *port, data, doc_name, cancel)
        }
        ResolvedPrinterTarget::SerialPort {
            port_name,
            baud_rate,
        } => print_raw_to_serial_cancellable_with_evidence(
            port_name, *baud_rate, data, doc_name, cancel,
        ),
        ResolvedPrinterTarget::WindowsQueue { .. } => {
            Err(RawTransportFailure::definitely_not_sent(
                data.len(),
                "Managed Windows printing must use the WindowsSpooler adapter".into(),
            ))
        }
    }
}

#[cfg(target_os = "windows")]
pub fn probe_printer_spool(printer_name: &str) -> Result<(), String> {
    use std::ptr;

    #[allow(clippy::upper_case_acronyms)]
    type HANDLE = *mut std::ffi::c_void;

    #[link(name = "winspool")]
    extern "system" {
        fn OpenPrinterW(
            pPrinterName: *const u16,
            phPrinter: *mut HANDLE,
            pDefault: *const u8,
        ) -> i32;
        fn ClosePrinter(hPrinter: HANDLE) -> i32;
    }

    let wide_name: Vec<u16> = printer_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut h_printer: HANDLE = ptr::null_mut();
    let ok = unsafe { OpenPrinterW(wide_name.as_ptr(), &mut h_printer, ptr::null()) };
    if ok == 0 || h_printer.is_null() {
        return Err(format!(
            "Printer spool is not reachable for \"{printer_name}\""
        ));
    }
    unsafe {
        ClosePrinter(h_printer);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn probe_printer_spool(_printer_name: &str) -> Result<(), String> {
    Err("Printer spool probe is only available on Windows".into())
}

pub fn probe_printer_target(target: &ResolvedPrinterTarget) -> Result<(), String> {
    match target {
        ResolvedPrinterTarget::WindowsQueue { printer_name } => probe_printer_spool(printer_name),
        ResolvedPrinterTarget::RawTcp { host, port } => probe_printer_tcp(host, *port),
        ResolvedPrinterTarget::SerialPort {
            port_name,
            baud_rate,
        } => probe_printer_serial(port_name, *baud_rate),
    }
}

#[allow(dead_code)]
/// Legacy: Send an HTML file to a Windows printer via PowerShell `PrintTo`.
///
/// **Deprecated** — use [`print_raw_to_windows`] with ESC/POS binary instead.
/// Kept for non-thermal printers that accept rendered documents.
#[cfg(target_os = "windows")]
pub fn print_html_to_windows(printer_name: &str, html_path: &str) -> Result<(), String> {
    warn!(
        printer = %printer_name,
        file = %html_path,
        "Blocked legacy HTML PowerShell print path for security. Use raw ESC/POS printing instead."
    );
    Err("Legacy HTML print path is disabled for security; use native/raw printer flow".into())
}

#[cfg(not(target_os = "windows"))]
pub fn print_html_to_windows(_printer_name: &str, _html_path: &str) -> Result<(), String> {
    Err("Windows printing not available on this platform".into())
}

// ---------------------------------------------------------------------------
// Printer profile CRUD
// ---------------------------------------------------------------------------

fn non_empty_str(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

fn set_default_profile_locked(conn: &rusqlite::Connection, profile_id: &str) -> Result<(), String> {
    conn.execute("UPDATE printer_profiles SET is_default = 0", [])
        .map_err(|e| format!("clear existing default printer flags: {e}"))?;
    conn.execute(
        "UPDATE printer_profiles
         SET is_default = 1, updated_at = ?1
         WHERE id = ?2",
        params![Utc::now().to_rfc3339(), profile_id],
    )
    .map_err(|e| format!("set printer default flag: {e}"))?;
    db::set_setting(conn, "printer", "default_printer_profile_id", profile_id)?;
    Ok(())
}

fn clear_default_profile_locked(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute("UPDATE printer_profiles SET is_default = 0", [])
        .map_err(|e| format!("clear default profile flags: {e}"))?;
    conn.execute(
        "DELETE FROM local_settings
         WHERE setting_category = 'printer'
           AND setting_key = 'default_printer_profile_id'",
        [],
    )
    .map_err(|e| format!("clear default printer setting: {e}"))?;
    Ok(())
}

fn get_default_profile_id_from_setting(conn: &rusqlite::Connection) -> Option<String> {
    db::get_setting(conn, "printer", "default_printer_profile_id").and_then(|id| {
        let trimmed = id.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn get_default_profile_id_from_column(conn: &rusqlite::Connection) -> Option<String> {
    conn.query_row(
        "SELECT id FROM printer_profiles
         WHERE is_default = 1
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|id| {
        let trimmed = id.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

/// Create a new printer profile. Returns `{ success, profileId }`.
pub fn create_printer_profile(db: &DbState, profile: &Value) -> Result<Value, String> {
    create_printer_profile_with_capability_trust(db, profile, CapabilityEvidenceTrust::Untrusted)
}

pub(crate) fn create_printer_profile_with_validated_capabilities(
    db: &DbState,
    profile: &Value,
) -> Result<Value, String> {
    create_printer_profile_with_capability_trust(db, profile, CapabilityEvidenceTrust::Validated)
}

fn create_printer_profile_with_capability_trust(
    db: &DbState,
    profile: &Value,
    evidence_trust: CapabilityEvidenceTrust,
) -> Result<Value, String> {
    let name = non_empty_str(profile.get("name").and_then(|v| v.as_str()))
        .ok_or("Missing profile name")?;
    let printer_name = non_empty_str(
        profile
            .get("printerName")
            .or_else(|| profile.get("printer_name"))
            .and_then(|v| v.as_str()),
    )
    .ok_or("Missing printer_name")?;
    let driver_type = profile
        .get("driverType")
        .or_else(|| profile.get("driver_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("windows");
    let paper_width_mm = profile
        .get("paperWidthMm")
        .or_else(|| profile.get("paper_width_mm"))
        .and_then(|v| v.as_i64())
        .unwrap_or(80) as i32;
    let copies_default = profile
        .get("copiesDefault")
        .or_else(|| profile.get("copies_default"))
        .and_then(|v| v.as_i64())
        .unwrap_or(1) as i32;
    let cut_paper = profile
        .get("cutPaper")
        .or_else(|| profile.get("cut_paper"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let open_cash_drawer = profile
        .get("openCashDrawer")
        .or_else(|| profile.get("open_cash_drawer"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let drawer_mode = profile
        .get("drawerMode")
        .or_else(|| profile.get("drawer_mode"))
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    let drawer_host = profile
        .get("drawerHost")
        .or_else(|| profile.get("drawer_host"))
        .and_then(|v| v.as_str());
    let drawer_port = profile
        .get("drawerPort")
        .or_else(|| profile.get("drawer_port"))
        .and_then(|v| v.as_i64())
        .unwrap_or(9100) as i32;
    let drawer_pulse_ms = profile
        .get("drawerPulseMs")
        .or_else(|| profile.get("drawer_pulse_ms"))
        .and_then(|v| v.as_i64())
        .unwrap_or(200) as i32;

    // v15 extended columns
    let printer_type = profile
        .get("printerType")
        .or_else(|| profile.get("printer_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("system");
    let role = profile
        .get("role")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("receipt")
        .to_string();
    let is_default = profile
        .get("isDefault")
        .or_else(|| profile.get("is_default"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let enabled = profile
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let character_set = profile
        .get("characterSet")
        .or_else(|| profile.get("character_set"))
        .and_then(|v| v.as_str())
        .unwrap_or("PC437_USA");
    let greek_render_mode = profile
        .get("greekRenderMode")
        .or_else(|| profile.get("greek_render_mode"))
        .and_then(|v| v.as_str());
    let requested_template = profile
        .get("receiptTemplate")
        .or_else(|| profile.get("receipt_template"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let receipt_template = match requested_template {
        Some("classic") => Some("classic".to_string()),
        Some("modern") => Some("modern".to_string()),
        Some(other) => {
            return Err(format!(
                "Invalid receipt_template: {other}. Must be 'classic' or 'modern'"
            ))
        }
        None => {
            if role_uses_classic_receipt_defaults(&role) {
                Some("classic".to_string())
            } else {
                None
            }
        }
    };
    let fallback_printer_id = profile
        .get("fallbackPrinterId")
        .or_else(|| profile.get("fallback_printer_id"))
        .and_then(|v| v.as_str());
    let connection_json_input = profile_connection_json_string(profile);
    let connection_json = normalize_connection_json_for_role_with_trust(
        &role,
        connection_json_input.as_deref(),
        None,
        evidence_trust,
    )?;
    let escpos_code_page: Option<i32> = profile
        .get("escposCodePage")
        .or_else(|| profile.get("escpos_code_page"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);
    let font_type = profile
        .get("fontType")
        .or_else(|| profile.get("font_type"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("a");
    let layout_density = profile
        .get("layoutDensity")
        .or_else(|| profile.get("layout_density"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("compact");
    let header_emphasis = profile
        .get("headerEmphasis")
        .or_else(|| profile.get("header_emphasis"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("strong");

    if driver_type != "windows" && driver_type != "escpos" {
        return Err(format!(
            "Unsupported driver_type: {driver_type}. Must be 'windows' or 'escpos'"
        ));
    }
    if paper_width_mm != 58 && paper_width_mm != 80 && paper_width_mm != 112 {
        return Err(format!(
            "Invalid paper_width_mm: {paper_width_mm}. Must be 58, 80, or 112"
        ));
    }
    if drawer_mode != "none" && drawer_mode != "escpos_tcp" {
        return Err(format!(
            "Invalid drawer_mode: {drawer_mode}. Must be 'none' or 'escpos_tcp'"
        ));
    }
    if font_type != "a" && font_type != "b" {
        return Err(format!(
            "Invalid font_type: {font_type}. Must be 'a' or 'b'"
        ));
    }
    if layout_density != "compact" && layout_density != "balanced" && layout_density != "spacious" {
        return Err(format!(
            "Invalid layout_density: {layout_density}. Must be 'compact', 'balanced', or 'spacious'"
        ));
    }
    if header_emphasis != "normal" && header_emphasis != "strong" {
        return Err(format!(
            "Invalid header_emphasis: {header_emphasis}. Must be 'normal' or 'strong'"
        ));
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO printer_profiles (id, name, driver_type, printer_name, paper_width_mm,
                                       copies_default, cut_paper, open_cash_drawer,
                                       drawer_mode, drawer_host, drawer_port, drawer_pulse_ms,
                                       printer_type, role, is_default, enabled,
                                       character_set, greek_render_mode, receipt_template,
                                       fallback_printer_id, connection_json,
                                       escpos_code_page,
                                       font_type, layout_density, header_emphasis,
                                       created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?26)",
        params![
            id,
            &name,
            driver_type,
            &printer_name,
            paper_width_mm,
            copies_default,
            cut_paper as i32,
            open_cash_drawer as i32,
            drawer_mode,
            drawer_host,
            drawer_port,
            drawer_pulse_ms,
            printer_type,
            role,
            is_default as i32,
            enabled as i32,
            character_set,
            greek_render_mode,
            receipt_template,
            fallback_printer_id,
            connection_json.as_deref(),
            escpos_code_page,
            font_type,
            layout_density,
            header_emphasis,
            now,
        ],
    )
    .map_err(|e| format!("create printer profile: {e}"))?;

    if is_default {
        set_default_profile_locked(&conn, &id)?;
    }

    info!(id = %id, name = %name, printer = %printer_name, "Printer profile created");

    Ok(serde_json::json!({
        "success": true,
        "profileId": id,
    }))
}

/// Update an existing printer profile. Returns `{ success }`.
pub fn update_printer_profile(db: &DbState, profile: &Value) -> Result<Value, String> {
    update_printer_profile_with_capability_trust(db, profile, CapabilityEvidenceTrust::Untrusted)
}

pub(crate) fn update_printer_profile_with_validated_capabilities(
    db: &DbState,
    profile: &Value,
) -> Result<Value, String> {
    update_printer_profile_with_capability_trust(db, profile, CapabilityEvidenceTrust::Validated)
}

fn update_printer_profile_with_capability_trust(
    db: &DbState,
    profile: &Value,
    evidence_trust: CapabilityEvidenceTrust,
) -> Result<Value, String> {
    let id = profile
        .get("id")
        .or_else(|| profile.get("profileId"))
        .and_then(|v| v.as_str())
        .ok_or("Missing profile id")?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let (current_role, current_connection_json): (String, Option<String>) = conn
        .query_row(
            "SELECT role, connection_json FROM printer_profiles WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("load current printer profile: {e}"))?;

    // Build dynamic SET clause from provided fields
    let mut sets = Vec::new();
    let mut vals: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut requested_default: Option<bool> = None;
    let requested_role = profile
        .get("role")
        .and_then(|v| v.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(raw) = profile.get("name").and_then(|v| v.as_str()) {
        let v = raw.trim();
        if v.is_empty() {
            return Err("Printer profile name cannot be empty".into());
        }
        sets.push("name = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(raw) = profile
        .get("printerName")
        .or_else(|| profile.get("printer_name"))
        .and_then(|v| v.as_str())
    {
        let v = raw.trim();
        if v.is_empty() {
            return Err("printer_name cannot be empty".into());
        }
        sets.push("printer_name = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("paperWidthMm")
        .or_else(|| profile.get("paper_width_mm"))
        .and_then(|v| v.as_i64())
    {
        let w = v as i32;
        if w != 58 && w != 80 && w != 112 {
            return Err(format!("Invalid paper_width_mm: {w}"));
        }
        sets.push("paper_width_mm = ?");
        vals.push(Box::new(w));
    }
    if let Some(v) = profile
        .get("copiesDefault")
        .or_else(|| profile.get("copies_default"))
        .and_then(|v| v.as_i64())
    {
        sets.push("copies_default = ?");
        vals.push(Box::new(v as i32));
    }
    if let Some(v) = profile
        .get("cutPaper")
        .or_else(|| profile.get("cut_paper"))
        .and_then(|v| v.as_bool())
    {
        sets.push("cut_paper = ?");
        vals.push(Box::new(v as i32));
    }
    if let Some(v) = profile
        .get("openCashDrawer")
        .or_else(|| profile.get("open_cash_drawer"))
        .and_then(|v| v.as_bool())
    {
        sets.push("open_cash_drawer = ?");
        vals.push(Box::new(v as i32));
    }
    if let Some(v) = profile
        .get("drawerMode")
        .or_else(|| profile.get("drawer_mode"))
        .and_then(|v| v.as_str())
    {
        if v != "none" && v != "escpos_tcp" {
            return Err(format!("Invalid drawer_mode: {v}"));
        }
        sets.push("drawer_mode = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("drawerHost")
        .or_else(|| profile.get("drawer_host"))
        .and_then(|v| v.as_str())
    {
        sets.push("drawer_host = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("drawerPort")
        .or_else(|| profile.get("drawer_port"))
        .and_then(|v| v.as_i64())
    {
        sets.push("drawer_port = ?");
        vals.push(Box::new(v as i32));
    }
    if let Some(v) = profile
        .get("drawerPulseMs")
        .or_else(|| profile.get("drawer_pulse_ms"))
        .and_then(|v| v.as_i64())
    {
        sets.push("drawer_pulse_ms = ?");
        vals.push(Box::new(v as i32));
    }

    // v15 extended columns
    if let Some(v) = profile
        .get("printerType")
        .or_else(|| profile.get("printer_type"))
        .and_then(|v| v.as_str())
    {
        sets.push("printer_type = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = requested_role.as_deref() {
        sets.push("role = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("isDefault")
        .or_else(|| profile.get("is_default"))
        .and_then(|v| v.as_bool())
    {
        requested_default = Some(v);
    }
    if let Some(v) = profile.get("enabled").and_then(|v| v.as_bool()) {
        sets.push("enabled = ?");
        vals.push(Box::new(v as i32));
    }
    if let Some(v) = profile
        .get("characterSet")
        .or_else(|| profile.get("character_set"))
        .and_then(|v| v.as_str())
    {
        sets.push("character_set = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("greekRenderMode")
        .or_else(|| profile.get("greek_render_mode"))
        .and_then(|v| v.as_str())
    {
        sets.push("greek_render_mode = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("receiptTemplate")
        .or_else(|| profile.get("receipt_template"))
        .and_then(|v| v.as_str())
    {
        if v != "classic" && v != "modern" {
            return Err(format!(
                "Invalid receipt_template: {v}. Must be 'classic' or 'modern'"
            ));
        }
        sets.push("receipt_template = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("fontType")
        .or_else(|| profile.get("font_type"))
        .and_then(|v| v.as_str())
    {
        if v != "a" && v != "b" {
            return Err(format!("Invalid font_type: {v}. Must be 'a' or 'b'"));
        }
        sets.push("font_type = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("layoutDensity")
        .or_else(|| profile.get("layout_density"))
        .and_then(|v| v.as_str())
    {
        if v != "compact" && v != "balanced" && v != "spacious" {
            return Err(format!(
                "Invalid layout_density: {v}. Must be 'compact', 'balanced', or 'spacious'"
            ));
        }
        sets.push("layout_density = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("headerEmphasis")
        .or_else(|| profile.get("header_emphasis"))
        .and_then(|v| v.as_str())
    {
        if v != "normal" && v != "strong" {
            return Err(format!(
                "Invalid header_emphasis: {v}. Must be 'normal' or 'strong'"
            ));
        }
        sets.push("header_emphasis = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = profile
        .get("fallbackPrinterId")
        .or_else(|| profile.get("fallback_printer_id"))
        .and_then(|v| v.as_str())
    {
        sets.push("fallback_printer_id = ?");
        vals.push(Box::new(v.to_string()));
    }
    let connection_json_input = profile_connection_json_string(profile);
    if connection_json_input.is_some() || requested_role.is_some() {
        let effective_role = requested_role.as_deref().unwrap_or(current_role.as_str());
        let normalized_connection_json = normalize_connection_json_for_role_with_trust(
            effective_role,
            connection_json_input
                .as_deref()
                .or(current_connection_json.as_deref()),
            current_connection_json.as_deref(),
            evidence_trust,
        )?;
        if let Some(connection_json) = normalized_connection_json {
            sets.push("connection_json = ?");
            vals.push(Box::new(connection_json));
        } else if connection_json_input.is_some() {
            sets.push("connection_json = NULL");
        }
    }
    // ESC/POS code page override — accept null to clear
    if profile.get("escposCodePage").is_some() || profile.get("escpos_code_page").is_some() {
        let raw = profile
            .get("escposCodePage")
            .or_else(|| profile.get("escpos_code_page"));
        if raw.map(|v| v.is_null()).unwrap_or(false) {
            sets.push("escpos_code_page = NULL");
        } else if let Some(v) = raw.and_then(|v| v.as_i64()) {
            sets.push("escpos_code_page = ?");
            vals.push(Box::new(v as i32));
        }
    }

    if sets.is_empty() && requested_default.is_none() {
        return Err("No fields to update".into());
    }

    if !sets.is_empty() {
        sets.push("updated_at = ?");
        vals.push(Box::new(now.clone()));
        vals.push(Box::new(id.to_string()));

        let sql = format!(
            "UPDATE printer_profiles SET {} WHERE id = ?",
            sets.join(", ")
        );

        let params_refs: Vec<&dyn rusqlite::types::ToSql> =
            vals.iter().map(|v| v.as_ref()).collect();
        let affected = conn
            .execute(&sql, params_refs.as_slice())
            .map_err(|e| format!("update printer profile: {e}"))?;

        if affected == 0 {
            return Err(format!("Printer profile {id} not found"));
        }
    } else {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM printer_profiles WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| format!("lookup printer profile: {e}"))?;
        if !exists {
            return Err(format!("Printer profile {id} not found"));
        }
    }

    match requested_default {
        Some(true) => {
            set_default_profile_locked(&conn, id)?;
        }
        Some(false) => {
            conn.execute(
                "UPDATE printer_profiles SET is_default = 0, updated_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), id],
            )
            .map_err(|e| format!("clear printer default flag: {e}"))?;

            if get_default_profile_id_from_setting(&conn).as_deref() == Some(id) {
                if let Some(other_default) = get_default_profile_id_from_column(&conn) {
                    db::set_setting(
                        &conn,
                        "printer",
                        "default_printer_profile_id",
                        &other_default,
                    )?;
                } else {
                    conn.execute(
                        "DELETE FROM local_settings
                         WHERE setting_category = 'printer'
                           AND setting_key = 'default_printer_profile_id'",
                        [],
                    )
                    .map_err(|e| format!("clear default printer setting: {e}"))?;
                }
            }
        }
        None => {}
    }

    info!(id = %id, "Printer profile updated");
    Ok(serde_json::json!({ "success": true }))
}

/// List all printer profiles.
pub fn list_printer_profiles(db: &DbState) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, name, driver_type, printer_name, paper_width_mm,
                    copies_default, cut_paper, open_cash_drawer,
                    drawer_mode, drawer_host, drawer_port, drawer_pulse_ms,
                    created_at, updated_at,
                    printer_type, role, is_default, enabled,
                    character_set, greek_render_mode, receipt_template,
                    fallback_printer_id, connection_json,
                    escpos_code_page,
                    font_type, layout_density, header_emphasis
             FROM printer_profiles ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "driverType": row.get::<_, String>(2)?,
                "printerName": row.get::<_, String>(3)?,
                "paperWidthMm": row.get::<_, i32>(4)?,
                "copiesDefault": row.get::<_, i32>(5)?,
                "cutPaper": row.get::<_, i32>(6)? != 0,
                "openCashDrawer": row.get::<_, i32>(7)? != 0,
                "drawerMode": row.get::<_, String>(8)?,
                "drawerHost": row.get::<_, Option<String>>(9)?,
                "drawerPort": row.get::<_, i32>(10)?,
                "drawerPulseMs": row.get::<_, i32>(11)?,
                "createdAt": row.get::<_, String>(12)?,
                "updatedAt": row.get::<_, String>(13)?,
                "printerType": row.get::<_, String>(14)?,
                "role": row.get::<_, String>(15)?,
                "isDefault": row.get::<_, i32>(16)? != 0,
                "enabled": row.get::<_, i32>(17)? != 0,
                "characterSet": row.get::<_, String>(18)?,
                "greekRenderMode": row.get::<_, Option<String>>(19)?,
                "receiptTemplate": row.get::<_, Option<String>>(20)?,
                "fallbackPrinterId": row.get::<_, Option<String>>(21)?,
                "connectionJson": row.get::<_, Option<String>>(22)?,
                "escposCodePage": row.get::<_, Option<i32>>(23)?,
                "fontType": row.get::<_, String>(24)?,
                "layoutDensity": row.get::<_, String>(25)?,
                "headerEmphasis": row.get::<_, String>(26)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(serde_json::json!(rows))
}

/// Get a single printer profile by ID.
pub fn get_printer_profile(db: &DbState, profile_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, name, driver_type, printer_name, paper_width_mm,
                copies_default, cut_paper, open_cash_drawer,
                drawer_mode, drawer_host, drawer_port, drawer_pulse_ms,
                created_at, updated_at,
                printer_type, role, is_default, enabled,
                character_set, greek_render_mode, receipt_template,
                fallback_printer_id, connection_json,
                escpos_code_page,
                font_type, layout_density, header_emphasis
         FROM printer_profiles WHERE id = ?1",
        params![profile_id],
        |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "driverType": row.get::<_, String>(2)?,
                "printerName": row.get::<_, String>(3)?,
                "paperWidthMm": row.get::<_, i32>(4)?,
                "copiesDefault": row.get::<_, i32>(5)?,
                "cutPaper": row.get::<_, i32>(6)? != 0,
                "openCashDrawer": row.get::<_, i32>(7)? != 0,
                "drawerMode": row.get::<_, String>(8)?,
                "drawerHost": row.get::<_, Option<String>>(9)?,
                "drawerPort": row.get::<_, i32>(10)?,
                "drawerPulseMs": row.get::<_, i32>(11)?,
                "createdAt": row.get::<_, String>(12)?,
                "updatedAt": row.get::<_, String>(13)?,
                "printerType": row.get::<_, String>(14)?,
                "role": row.get::<_, String>(15)?,
                "isDefault": row.get::<_, i32>(16)? != 0,
                "enabled": row.get::<_, i32>(17)? != 0,
                "characterSet": row.get::<_, String>(18)?,
                "greekRenderMode": row.get::<_, Option<String>>(19)?,
                "receiptTemplate": row.get::<_, Option<String>>(20)?,
                "fallbackPrinterId": row.get::<_, Option<String>>(21)?,
                "connectionJson": row.get::<_, Option<String>>(22)?,
                "escposCodePage": row.get::<_, Option<i32>>(23)?,
                "fontType": row.get::<_, String>(24)?,
                "layoutDensity": row.get::<_, String>(25)?,
                "headerEmphasis": row.get::<_, String>(26)?,
            }))
        },
    )
    .map_err(|e| format!("Printer profile {profile_id} not found: {e}"))
}

/// Delete a printer profile. Also clears the default if it was the default.
pub fn delete_printer_profile(db: &DbState, profile_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let was_default_setting = get_default_profile_id_from_setting(&conn)
        .as_deref()
        .map(|id| id == profile_id)
        .unwrap_or(false);

    let affected = conn
        .execute(
            "DELETE FROM printer_profiles WHERE id = ?1",
            params![profile_id],
        )
        .map_err(|e| format!("delete printer profile: {e}"))?;

    if affected == 0 {
        return Err(format!("Printer profile {profile_id} not found"));
    }

    // Keep local setting and is_default source-of-truth in sync after delete.
    if was_default_setting {
        if let Some(other_default) = get_default_profile_id_from_column(&conn) {
            db::set_setting(
                &conn,
                "printer",
                "default_printer_profile_id",
                &other_default,
            )?;
        } else {
            conn.execute(
                "DELETE FROM local_settings
                 WHERE setting_category = 'printer'
                   AND setting_key = 'default_printer_profile_id'",
                [],
            )
            .map_err(|e| format!("clear default printer setting after delete: {e}"))?;
        }
    }

    info!(id = %profile_id, "Printer profile deleted");
    Ok(serde_json::json!({ "success": true }))
}

/// Set the default printer profile ID in local_settings.
pub fn set_default_printer_profile(db: &DbState, profile_id: &str) -> Result<Value, String> {
    // Verify profile exists
    let _ = get_printer_profile(db, profile_id)?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    set_default_profile_locked(&conn, profile_id)?;

    info!(profile_id = %profile_id, "Default printer profile set");
    Ok(serde_json::json!({ "success": true }))
}

/// Get the default printer profile (full profile object or null).
pub fn get_default_printer_profile(db: &DbState) -> Result<Value, String> {
    let selected_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if let Some(id) = get_default_profile_id_from_setting(&conn) {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM printer_profiles WHERE id = ?1)",
                    params![id.clone()],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if exists {
                let _ = set_default_profile_locked(&conn, &id);
                Some(id)
            } else {
                warn!(id = %id, "Default printer profile setting points to missing profile");
                None
            }
        } else {
            None
        }
        .or_else(|| {
            let column_default = get_default_profile_id_from_column(&conn);
            if let Some(ref id) = column_default {
                let _ = db::set_setting(&conn, "printer", "default_printer_profile_id", id);
            }
            column_default
        })
    };

    if let Some(id) = selected_id {
        get_printer_profile(db, &id)
    } else {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let _ = clear_default_profile_locked(&conn);
        Ok(Value::Null)
    }
}

/// Resolve the printer profile for a print job.
///
/// Priority: job-specific `printer_profile_id` > default profile > None.
pub fn resolve_printer_profile(
    db: &DbState,
    job_profile_id: Option<&str>,
) -> Result<Option<Value>, String> {
    resolve_printer_profile_for_role(db, job_profile_id, None)
}

fn resolve_profile_for_role(db: &DbState, role: &str) -> Result<Option<Value>, String> {
    let role = role.trim();
    if role.is_empty() {
        return Ok(None);
    }

    let selected_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id
             FROM printer_profiles
             WHERE role = ?1 AND enabled = 1
             ORDER BY is_default DESC, updated_at DESC, created_at ASC
             LIMIT 1",
            params![role],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };

    match selected_id {
        Some(id) => get_printer_profile(db, &id).map(Some),
        None => Ok(None),
    }
}

fn resolve_any_enabled_profile(db: &DbState) -> Result<Option<Value>, String> {
    let selected_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id
             FROM printer_profiles
             WHERE enabled = 1
             ORDER BY is_default DESC, updated_at DESC, created_at ASC
             LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };

    match selected_id {
        Some(id) => get_printer_profile(db, &id).map(Some),
        None => Ok(None),
    }
}

/// Resolve a profile for a specific role with fallback to default.
///
/// Priority:
/// 1) explicit job profile id,
/// 2) enabled role profile,
/// 3) enabled default profile,
/// 4) first enabled profile.
pub fn resolve_printer_profile_for_role(
    db: &DbState,
    job_profile_id: Option<&str>,
    role: Option<&str>,
) -> Result<Option<Value>, String> {
    // Try job-specific profile first
    if let Some(id) = job_profile_id {
        if !id.is_empty() {
            return match get_printer_profile(db, id) {
                Ok(p) => Ok(Some(p)),
                Err(e) => Err(format!("Job printer profile not found: {e}")),
            };
        }
    }

    if let Some(role_name) = role {
        if let Some(profile) = resolve_profile_for_role(db, role_name)? {
            return Ok(Some(profile));
        }
    }

    let default_profile = get_default_printer_profile(db)?;
    if !default_profile.is_null() {
        let enabled = default_profile
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if enabled {
            return Ok(Some(default_profile));
        }
    }

    resolve_any_enabled_profile(db)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;
    use std::thread;

    struct FailOnSecondWrite {
        writes: usize,
    }

    impl Write for FailOnSecondWrite {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.writes += 1;
            if self.writes == 1 {
                Ok(buf.len())
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "simulated disconnect",
                ))
            }
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct PartialThenFail {
        wrote: bool,
    }

    impl Write for PartialThenFail {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.wrote {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "simulated post-write failure",
                ))
            } else {
                self.wrote = true;
                Ok(buf.len().min(2))
            }
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct CancelAfterFirstPartial<'a> {
        cancel: &'a AtomicBool,
        writes: usize,
    }

    #[derive(Default)]
    struct OneByteWriter {
        writes: usize,
    }

    impl Write for OneByteWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.writes += 1;
            Ok(buf.len().min(1))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct CancelBeforeFlushWriter<'a> {
        cancel: &'a AtomicBool,
        flushes: usize,
    }

    impl Write for CancelBeforeFlushWriter<'_> {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.cancel.store(true, Ordering::Release);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    #[derive(Default)]
    struct FlushCountingWriter {
        flushes: usize,
    }

    impl Write for FlushCountingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    impl Write for CancelAfterFirstPartial<'_> {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.writes += 1;
            let written = buf.len().min(1);
            if self.writes == 1 {
                self.cancel.store(true, Ordering::Release);
            }
            Ok(written)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

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
    fn partial_raw_stream_failure_reports_unknown_state_instead_of_retryable_error() {
        let mut writer = FailOnSecondWrite { writes: 0 };
        let cancel = AtomicBool::new(false);
        let error = write_raw_payload_in_chunks(
            &mut writer,
            &[1, 2, 3, 4, 5, 6, 7, 8],
            4,
            Duration::ZERO,
            Instant::now() + Duration::from_secs(1),
            &cancel,
            "network printer 192.168.1.19:9100",
        )
        .expect_err("the second chunk must fail");

        assert!(
            error.contains("wrote 4/8 bytes"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("raw print state is unknown"),
            "partial streams must be fail-closed: {error}"
        );
    }

    #[test]
    fn structured_raw_transport_evidence_distinguishes_prewrite_from_ambiguous_failure() {
        let cancel = AtomicBool::new(true);
        let mut untouched = Vec::<u8>::new();
        let prewrite = write_raw_payload_in_chunks_with_evidence(
            &mut untouched,
            &[1, 2, 3, 4],
            4,
            Duration::ZERO,
            Instant::now() + Duration::from_secs(1),
            &cancel,
            "fake target",
        )
        .unwrap_err();
        assert_eq!(prewrite.kind, RawTransportFailureKind::DefinitelyNotSent);
        assert_eq!((prewrite.bytes_written, prewrite.bytes_requested), (0, 4));

        let cancel = AtomicBool::new(false);
        let mut writer = PartialThenFail { wrote: false };
        let ambiguous = write_raw_payload_in_chunks_with_evidence(
            &mut writer,
            &[1, 2, 3, 4],
            4,
            Duration::ZERO,
            Instant::now() + Duration::from_secs(1),
            &cancel,
            "fake target",
        )
        .unwrap_err();
        assert_eq!(ambiguous.kind, RawTransportFailureKind::AmbiguousAfterWrite);
        assert_eq!((ambiguous.bytes_written, ambiguous.bytes_requested), (2, 4));
    }

    #[test]
    fn structured_raw_transport_rechecks_cancel_between_partial_writes() {
        let cancel = AtomicBool::new(false);
        let mut writer = CancelAfterFirstPartial {
            cancel: &cancel,
            writes: 0,
        };

        let failure = write_raw_payload_in_chunks_with_evidence(
            &mut writer,
            &[1, 2, 3, 4],
            4,
            Duration::ZERO,
            Instant::now() + Duration::from_secs(1),
            &cancel,
            "fake target",
        )
        .unwrap_err();

        assert_eq!(failure.kind, RawTransportFailureKind::AmbiguousAfterWrite);
        assert_eq!((failure.bytes_written, failure.bytes_requested), (1, 4));
        assert_eq!(writer.writes, 1);
    }

    #[test]
    fn structured_raw_transport_rechecks_injected_deadline_between_partial_writes() {
        let cancel = AtomicBool::new(false);
        let mut writer = OneByteWriter::default();
        let before = Instant::now();
        let deadline = before + Duration::from_secs(1);
        let mut checks = 0usize;

        let failure = write_raw_payload_in_chunks_with_evidence_and_clock(
            &mut writer,
            &[1, 2, 3, 4],
            4,
            Duration::ZERO,
            deadline,
            &cancel,
            "fake target",
            || {
                checks += 1;
                if checks >= 3 {
                    deadline
                } else {
                    before
                }
            },
        )
        .unwrap_err();

        assert_eq!(failure.kind, RawTransportFailureKind::AmbiguousAfterWrite);
        assert_eq!((failure.bytes_written, failure.bytes_requested), (1, 4));
        assert_eq!(writer.writes, 1);
    }

    #[test]
    fn structured_raw_transport_rechecks_cancel_before_flush() {
        let cancel = AtomicBool::new(false);
        let mut writer = CancelBeforeFlushWriter {
            cancel: &cancel,
            flushes: 0,
        };

        let failure = write_raw_payload_in_chunks_with_evidence(
            &mut writer,
            &[1, 2, 3, 4],
            4,
            Duration::ZERO,
            Instant::now() + Duration::from_secs(1),
            &cancel,
            "fake target",
        )
        .unwrap_err();

        assert_eq!(failure.kind, RawTransportFailureKind::AmbiguousAfterWrite);
        assert_eq!(failure.bytes_written, 4);
        assert_eq!(writer.flushes, 0);
    }

    #[test]
    fn structured_raw_transport_rechecks_injected_deadline_before_success() {
        let cancel = AtomicBool::new(false);
        let mut writer = FlushCountingWriter::default();
        let before = Instant::now();
        let deadline = before + Duration::from_secs(1);
        let mut checks = 0usize;

        let failure = write_raw_payload_in_chunks_with_evidence_and_clock(
            &mut writer,
            &[1, 2, 3, 4],
            4,
            Duration::ZERO,
            deadline,
            &cancel,
            "fake target",
            || {
                checks += 1;
                if checks >= 4 {
                    deadline
                } else {
                    before
                }
            },
        )
        .unwrap_err();

        assert_eq!(failure.kind, RawTransportFailureKind::AmbiguousAfterWrite);
        assert_eq!(failure.bytes_written, 4);
        assert_eq!(writer.flushes, 1);
    }

    #[test]
    fn non_windows_spooler_transport_results_never_claim_a_spool_job_id() {
        let result = raw_transport_result(8, 8, "Receipt");

        assert_eq!(result.bytes_requested, 8);
        assert_eq!(result.bytes_written, 8);
        assert_eq!(result.doc_name, "Receipt");
        assert_eq!(result.spool_job_id, None);
    }

    #[test]
    fn windows_spool_submission_result_carries_the_native_job_id() {
        use crate::windows_spooler::{SpoolStarted, SpoolSubmission};

        let result = windows_spool_result(
            8,
            "Receipt",
            SpoolSubmission {
                started: SpoolStarted {
                    job_id: 73,
                    printer_name: "Kitchen".to_owned(),
                    document_name: "Receipt".to_owned(),
                    submitted_at: Utc::now(),
                },
            },
        );

        assert_eq!(result.bytes_requested, 8);
        assert_eq!(result.bytes_written, 8);
        assert_eq!(result.doc_name, "Receipt");
        assert_eq!(result.spool_job_id, Some(73));
    }

    #[test]
    fn windows_compatibility_error_preserves_input_field_and_partial_counts() {
        use crate::windows_spooler::{
            SpoolerError, SpoolerInputField, SpoolerOperation, SpoolerPrimitive,
        };

        let invalid = windows_spool_error(SpoolerError::InvalidInput {
            operation: SpoolerOperation::SubmitRaw,
            field: SpoolerInputField::DocumentName,
        });
        assert!(invalid.contains("DocumentName"));

        let partial = windows_spool_error(SpoolerError::PartialWrite {
            operation: SpoolerOperation::SubmitRaw,
            primitive: SpoolerPrimitive::WritePrinter,
            expected: 4096,
            written: 1024,
        });
        assert_eq!(
            partial,
            "spooler SubmitRaw WritePrinter wrote 1024 of 4096 bytes"
        );
    }

    #[test]
    fn test_detect_printer_brand_for_profile_uses_profile_name_when_printer_name_is_ip() {
        let profile = serde_json::json!({
            "name": "Star MCP31 Kitchen",
            "printerName": "192.168.1.19",
            "printerType": "network",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\"}"
        });

        assert_eq!(
            detect_printer_brand_for_profile(&profile),
            PrinterBrand::Star
        );
    }

    #[test]
    fn test_detect_printer_brand_recognizes_mc_print3_pattern() {
        assert_eq!(
            detect_printer_brand("mC-Print3 Network Utility"),
            PrinterBrand::Star
        );
    }

    #[test]
    fn test_detect_printer_brand_recognizes_mcp3_queue_alias() {
        assert_eq!(detect_printer_brand("MCP3"), PrinterBrand::Star);
    }

    #[test]
    fn test_detect_network_printer_brand_from_http_title() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback http listener");
        let addr = listener.local_addr().expect("listener addr");
        let body = "<html><head><title>mC-Print3 Network Utility</title></head><body>Star mC-Print3</body></html>";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let handle = thread::spawn(move || {
            let (mut stream, _peer) = listener.accept().expect("accept http probe");
            let mut request = [0u8; 512];
            let _ = stream.read(&mut request);
            stream
                .write_all(response.as_bytes())
                .expect("write http response");
        });

        let detected = detect_network_printer_brand(&format!("127.0.0.1:{}", addr.port()));

        handle.join().expect("listener thread should finish");
        assert_eq!(detected, PrinterBrand::Star);
    }

    #[test]
    fn test_detect_printer_brand_for_profile_uses_network_http_probe() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback http listener");
        let addr = listener.local_addr().expect("listener addr");
        let body = "<html><head><title>mC-Print3 Network Utility</title></head></html>";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let handle = thread::spawn(move || {
            let (mut stream, _peer) = listener.accept().expect("accept http probe");
            let mut request = [0u8; 512];
            let _ = stream.read(&mut request);
            stream
                .write_all(response.as_bytes())
                .expect("write http response");
        });

        let profile = serde_json::json!({
            "name": format!("LAN Printer (127.0.0.1:{})", addr.port()),
            "printerName": format!("127.0.0.1:{}", addr.port()),
            "printerType": "network",
            "connectionJson": format!("{{\"type\":\"network\",\"ip\":\"127.0.0.1:{}\"}}", addr.port())
        });

        let detected = detect_printer_brand_for_profile(&profile);

        handle.join().expect("listener thread should finish");
        assert_eq!(detected, PrinterBrand::Star);
    }

    #[test]
    fn test_resolve_printer_target_system_uses_windows_queue() {
        let profile = serde_json::json!({
            "printerName": "EPSON TM-T88VI",
            "printerType": "system",
            "connectionJson": "{\"type\":\"system\",\"systemName\":\"EPSON TM-T88VI\"}"
        });

        assert_eq!(
            resolve_printer_target(&profile),
            Ok(ResolvedPrinterTarget::WindowsQueue {
                printer_name: "EPSON TM-T88VI".to_string()
            })
        );
    }

    #[test]
    fn test_resolve_printer_target_network_defaults_port_to_9100() {
        let profile = serde_json::json!({
            "printerName": "192.168.1.19",
            "printerType": "network",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\"}"
        });

        assert_eq!(
            resolve_printer_target(&profile),
            Ok(ResolvedPrinterTarget::RawTcp {
                host: "192.168.1.19".to_string(),
                port: 9100
            })
        );
    }

    #[test]
    fn test_resolve_printer_target_network_honors_custom_port() {
        let profile = serde_json::json!({
            "printerName": "kitchen-printer",
            "printerType": "wifi",
            "connectionJson": "{\"type\":\"wifi\",\"hostname\":\"kitchen-printer.local\",\"port\":9200}"
        });

        assert_eq!(
            resolve_printer_target(&profile),
            Ok(ResolvedPrinterTarget::RawTcp {
                host: "kitchen-printer.local".to_string(),
                port: 9200
            })
        );
    }

    #[test]
    fn test_resolve_printer_target_network_falls_back_to_legacy_printer_name() {
        let profile = serde_json::json!({
            "printerName": "192.168.1.88",
            "printerType": "network"
        });

        assert_eq!(
            resolve_printer_target(&profile),
            Ok(ResolvedPrinterTarget::RawTcp {
                host: "192.168.1.88".to_string(),
                port: 9100
            })
        );
    }

    #[test]
    fn test_resolve_printer_target_network_requires_host() {
        let profile = serde_json::json!({
            "printerType": "network",
            "connectionJson": "{\"type\":\"network\"}"
        });

        let error = resolve_printer_target(&profile).expect_err("missing network host should fail");
        assert!(error.contains("missing host/IP"));
    }

    #[test]
    fn test_profile_uses_star_line_mode_from_connection_json() {
        let profile = serde_json::json!({
            "printerType": "network",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\",\"emulation\":\"star_line\"}"
        });

        assert!(profile_uses_star_line_mode(&profile));
    }

    #[test]
    fn test_profile_uses_star_line_mode_respects_escpos_override() {
        let profile = serde_json::json!({
            "printerName": "Star MCP31",
            "printerType": "system",
            "connectionJson": "{\"type\":\"system\",\"systemName\":\"Star MCP31\",\"emulation\":\"escpos\"}"
        });

        assert!(!profile_uses_star_line_mode(&profile));
    }

    #[test]
    fn test_profile_uses_star_line_mode_uses_verified_capability_snapshot() {
        let profile = serde_json::json!({
            "printerName": "Star MCP31",
            "printerType": "network",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\",\"capabilities\":{\"status\":\"verified\",\"resolvedTransport\":\"raw_tcp\",\"resolvedAddress\":\"192.168.1.19:9100\",\"emulation\":\"star_line\",\"renderMode\":\"text\",\"supportsCut\":true,\"supportsLogo\":false}}"
        });

        assert!(profile_uses_star_line_mode(&profile));
    }

    #[test]
    fn test_profile_uses_star_line_mode_does_not_hide_unverified_brand_fallback() {
        let profile = serde_json::json!({
            "printerName": "Star MCP31",
            "printerType": "network",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\",\"emulation\":\"auto\"}"
        });

        assert!(!profile_uses_star_line_mode(&profile));
    }

    #[test]
    fn test_profile_uses_star_line_mode_keeps_unknown_network_on_escpos() {
        let profile = serde_json::json!({
            "printerName": "127.0.0.1",
            "printerType": "network",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"127.0.0.1\",\"port\":9}"
        });

        assert!(!profile_uses_star_line_mode(&profile));
    }

    #[test]
    fn test_resolve_printer_target_usb_prefers_serial_port() {
        let profile = serde_json::json!({
            "printerType": "usb",
            "connectionJson": "{\"type\":\"usb\",\"serialPort\":\"COM7\",\"baudRate\":115200}"
        });

        assert_eq!(
            resolve_printer_target(&profile),
            Ok(ResolvedPrinterTarget::SerialPort {
                port_name: "COM7".to_string(),
                baud_rate: 115200
            })
        );
    }

    #[test]
    fn test_resolve_printer_target_prefers_verified_capability_snapshot() {
        let profile = serde_json::json!({
            "printerType": "network",
            "connectionJson": "{\"type\":\"network\",\"ip\":\"192.168.1.19\",\"port\":9100,\"capabilities\":{\"status\":\"verified\",\"resolvedTransport\":\"serial\",\"resolvedAddress\":\"COM9\",\"baudRate\":38400}}"
        });

        assert_eq!(
            resolve_printer_target(&profile),
            Ok(ResolvedPrinterTarget::SerialPort {
                port_name: "COM9".to_string(),
                baud_rate: 38400
            })
        );
    }

    #[test]
    fn test_probe_printer_target_network_online() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let addr = listener.local_addr().expect("listener addr");
        let handle = thread::spawn(move || {
            let (_stream, _peer) = listener.accept().expect("accept probe connection");
        });

        let target = ResolvedPrinterTarget::RawTcp {
            host: "127.0.0.1".to_string(),
            port: addr.port(),
        };

        probe_printer_target(&target).expect("probe should succeed against local listener");
        handle.join().expect("listener thread should finish");
    }

    #[test]
    fn test_print_raw_for_profile_network_writes_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let addr = listener.local_addr().expect("listener addr");
        let handle = thread::spawn(move || {
            let (mut stream, _peer) = listener.accept().expect("accept print connection");
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf).expect("read print payload");
            buf
        });

        let profile = serde_json::json!({
            "name": "Kitchen LAN",
            "printerName": format!("127.0.0.1:{}", addr.port()),
            "printerType": "network",
            "connectionJson": format!("{{\"type\":\"network\",\"ip\":\"127.0.0.1\",\"port\":{}}}", addr.port())
        });

        let payload = b"\x1b@\nHELLO\n";
        let result = print_raw_for_profile(&profile, payload, "Test TCP Print")
            .expect("direct TCP print should succeed");
        let received = handle.join().expect("listener thread should finish");

        assert_eq!(result.bytes_requested, payload.len());
        assert_eq!(result.bytes_written, payload.len());
        assert_eq!(received, payload);
    }

    #[test]
    fn test_create_and_list_profiles() {
        let db = test_db();

        let profile = serde_json::json!({
            "name": "Main Receipt",
            "printerName": "POS-80 Printer",
            "paperWidthMm": 80,
            "copiesDefault": 1,
            "cutPaper": true,
        });

        let result = create_printer_profile(&db, &profile).unwrap();
        assert_eq!(result["success"], true);
        let profile_id = result["profileId"].as_str().unwrap().to_string();
        assert!(!profile_id.is_empty());

        // List profiles
        let list = list_printer_profiles(&db).unwrap();
        let arr = list.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["name"], "Main Receipt");
        assert_eq!(arr[0]["printerName"], "POS-80 Printer");
        assert_eq!(arr[0]["paperWidthMm"], 80);
        assert_eq!(arr[0]["cutPaper"], true);
        assert_eq!(arr[0]["openCashDrawer"], false);
        assert_eq!(arr[0]["receiptTemplate"], "classic");
        let connection_json = arr[0]["connectionJson"]
            .as_str()
            .expect("connection json should be present");
        let connection: serde_json::Value =
            serde_json::from_str(connection_json).expect("parse connection json");
        assert_eq!(
            connection
                .get("render_mode")
                .and_then(|value| value.as_str()),
            Some("text")
        );
        assert_eq!(
            connection
                .get("capabilities")
                .and_then(|value| value.get("status"))
                .and_then(|value| value.as_str()),
            Some("unverified")
        );
    }

    #[test]
    fn test_update_profile() {
        let db = test_db();

        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Test Printer",
                "printerName": "OldName",
            }),
        )
        .unwrap();
        let id = result["profileId"].as_str().unwrap();

        // Update name and paper width
        let update_result = update_printer_profile(
            &db,
            &serde_json::json!({
                "id": id,
                "name": "Updated Printer",
                "printerName": "NewName",
                "paperWidthMm": 58,
            }),
        )
        .unwrap();
        assert_eq!(update_result["success"], true);

        // Verify update
        let profile = get_printer_profile(&db, id).unwrap();
        assert_eq!(profile["name"], "Updated Printer");
        assert_eq!(profile["printerName"], "NewName");
        assert_eq!(profile["paperWidthMm"], 58);
    }

    #[test]
    fn profile_capability_trust_untrusted_create_cannot_redirect_verified_target() {
        let db = test_db();

        for status in ["verified", "degraded"] {
            let created = create_printer_profile(
                &db,
                &serde_json::json!({
                    "name": format!("Untrusted create {status}"),
                    "printerName": "192.0.2.10",
                    "printerType": "network",
                    "connectionJson": {
                        "type": "network",
                        "ip": "192.0.2.10",
                        "port": 9100,
                        "capabilities": {
                            "status": status,
                            "resolvedTransport": "raw_tcp",
                            "resolvedAddress": "198.51.100.77:9200",
                            "emulation": "escpos",
                            "renderMode": "text",
                            "baudRate": null,
                            "supportsCut": true,
                            "supportsLogo": false,
                            "lastVerifiedAt": "2026-08-12T12:00:00Z"
                        }
                    }
                }),
            )
            .expect("generic profile create should remain usable after fail-closed normalization");
            let profile = get_printer_profile(
                &db,
                created["profileId"].as_str().expect("created profile id"),
            )
            .expect("load created profile");
            let capabilities = read_capability_snapshot(&profile);

            assert_eq!(capabilities.status, "unverified");
            assert_eq!(capabilities.resolved_transport, None);
            assert_eq!(capabilities.resolved_address, None);
            assert_eq!(
                resolve_printer_target(&profile),
                Ok(ResolvedPrinterTarget::RawTcp {
                    host: "192.0.2.10".to_string(),
                    port: 9100,
                })
            );
        }
    }

    #[test]
    fn profile_capability_trust_untrusted_update_cannot_redirect_verified_target() {
        let db = test_db();

        for status in ["verified", "degraded"] {
            let created = create_printer_profile(
                &db,
                &serde_json::json!({
                    "name": format!("Untrusted update {status}"),
                    "printerName": "192.0.2.20",
                    "printerType": "network",
                    "connectionJson": {
                        "type": "network",
                        "ip": "192.0.2.20",
                        "port": 9100
                    }
                }),
            )
            .expect("create profile to update");
            let profile_id = created["profileId"].as_str().expect("created profile id");

            update_printer_profile(
                &db,
                &serde_json::json!({
                    "id": profile_id,
                    "connectionJson": {
                        "type": "network",
                        "ip": "192.0.2.20",
                        "port": 9100,
                        "capabilities": {
                            "status": status,
                            "resolvedTransport": "raw_tcp",
                            "resolvedAddress": "203.0.113.91:9300",
                            "emulation": "star_line",
                            "renderMode": "raster_exact",
                            "baudRate": null,
                            "supportsCut": false,
                            "supportsLogo": true,
                            "lastVerifiedAt": "2026-08-12T12:30:00Z"
                        }
                    }
                }),
            )
            .expect("generic profile update should remain usable after fail-closed normalization");
            let profile = get_printer_profile(&db, profile_id).expect("load updated profile");
            let capabilities = read_capability_snapshot(&profile);

            assert_eq!(capabilities.status, "unverified");
            assert_eq!(capabilities.resolved_transport, None);
            assert_eq!(capabilities.resolved_address, None);
            assert_eq!(
                resolve_printer_target(&profile),
                Ok(ResolvedPrinterTarget::RawTcp {
                    host: "192.0.2.20".to_string(),
                    port: 9100,
                })
            );
        }
    }

    #[test]
    fn profile_capability_trust_validated_create_preserves_exact_evidence() {
        let db = test_db();
        let created = create_printer_profile_with_validated_capabilities(
            &db,
            &serde_json::json!({
                "name": "Validated create",
                "printerName": "192.0.2.30",
                "printerType": "network",
                "connectionJson": {
                    "type": "network",
                    "ip": "192.0.2.30",
                    "port": 9100,
                    "emulation": "star_line",
                    "render_mode": "raster_exact",
                    "capabilities": {
                        "status": "verified",
                        "resolvedTransport": "raw_tcp",
                        "resolvedAddress": "192.0.2.30:9100",
                        "emulation": "star_line",
                        "renderMode": "raster_exact",
                        "baudRate": null,
                        "escposCodePage": 15,
                        "supportsCut": false,
                        "supportsLogo": true,
                        "lastVerifiedAt": "2026-08-12T13:00:00Z"
                    }
                }
            }),
        )
        .expect("validated create should preserve the exact confirmed evidence");
        let profile = get_printer_profile(
            &db,
            created["profileId"].as_str().expect("created profile id"),
        )
        .expect("load validated profile");
        let capabilities = read_capability_snapshot(&profile);

        assert_eq!(capabilities.status, "verified");
        assert_eq!(capabilities.resolved_transport.as_deref(), Some("raw_tcp"));
        assert_eq!(
            capabilities.resolved_address.as_deref(),
            Some("192.0.2.30:9100")
        );
        assert_eq!(capabilities.emulation.as_deref(), Some("star_line"));
        assert_eq!(capabilities.render_mode.as_deref(), Some("raster_exact"));
        assert_eq!(capabilities.supports_cut, false);
        assert_eq!(capabilities.supports_logo, true);
        assert_eq!(
            capabilities.last_verified_at.as_deref(),
            Some("2026-08-12T13:00:00Z")
        );
        assert_eq!(
            resolve_printer_target(&profile),
            Ok(ResolvedPrinterTarget::RawTcp {
                host: "192.0.2.30".to_string(),
                port: 9100,
            })
        );
    }

    #[test]
    fn profile_capability_trust_validated_update_preserves_exact_evidence() {
        let db = test_db();
        let created = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Validated update",
                "printerName": "COM31",
                "printerType": "usb",
                "connectionJson": {
                    "type": "usb",
                    "serialPort": "COM31",
                    "baudRate": 38400
                }
            }),
        )
        .expect("create profile to update through validated path");
        let profile_id = created["profileId"].as_str().expect("created profile id");

        update_printer_profile_with_validated_capabilities(
            &db,
            &serde_json::json!({
                "id": profile_id,
                "connectionJson": {
                    "type": "usb",
                    "serialPort": "COM31",
                    "baudRate": 38400,
                    "emulation": "escpos",
                    "render_mode": "text",
                    "capabilities": {
                        "status": "degraded",
                        "resolvedTransport": "serial",
                        "resolvedAddress": "COM31",
                        "emulation": "escpos",
                        "renderMode": "text",
                        "baudRate": 38400,
                        "escposCodePage": 14,
                        "supportsCut": true,
                        "supportsLogo": false,
                        "lastVerifiedAt": "2026-08-12T13:30:00Z"
                    }
                }
            }),
        )
        .expect("validated update should preserve the exact confirmed evidence");
        let profile = get_printer_profile(&db, profile_id).expect("load validated update");
        let capabilities = read_capability_snapshot(&profile);

        assert_eq!(capabilities.status, "degraded");
        assert_eq!(capabilities.resolved_transport.as_deref(), Some("serial"));
        assert_eq!(capabilities.resolved_address.as_deref(), Some("COM31"));
        assert_eq!(capabilities.emulation.as_deref(), Some("escpos"));
        assert_eq!(capabilities.render_mode.as_deref(), Some("text"));
        assert_eq!(capabilities.baud_rate, Some(38400));
        assert_eq!(capabilities.supports_cut, true);
        assert_eq!(capabilities.supports_logo, false);
        assert_eq!(
            capabilities.last_verified_at.as_deref(),
            Some("2026-08-12T13:30:00Z")
        );
        assert_eq!(
            resolve_printer_target(&profile),
            Ok(ResolvedPrinterTarget::SerialPort {
                port_name: "COM31".to_string(),
                baud_rate: 38400,
            })
        );
    }

    #[test]
    fn test_delete_profile_clears_default() {
        let db = test_db();

        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "ToDelete",
                "printerName": "SomePrinter",
            }),
        )
        .unwrap();
        let id = result["profileId"].as_str().unwrap();

        // Set as default
        set_default_printer_profile(&db, id).unwrap();
        let def = get_default_printer_profile(&db).unwrap();
        assert_eq!(def["id"], id);

        // Delete
        delete_printer_profile(&db, id).unwrap();

        // Default should be cleared
        let def_after = get_default_printer_profile(&db).unwrap();
        assert!(def_after.is_null());
    }

    #[test]
    fn test_default_printer_profile() {
        let db = test_db();

        // Initially no default
        let def = get_default_printer_profile(&db).unwrap();
        assert!(def.is_null());

        // Create and set as default
        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Default Printer",
                "printerName": "MyPrinter",
            }),
        )
        .unwrap();
        let id = result["profileId"].as_str().unwrap();

        set_default_printer_profile(&db, id).unwrap();

        let def = get_default_printer_profile(&db).unwrap();
        assert_eq!(def["id"], id);
        assert_eq!(def["name"], "Default Printer");
    }

    #[test]
    fn test_resolve_printer_profile() {
        let db = test_db();

        // No profiles — resolve returns None
        let resolved = resolve_printer_profile(&db, None).unwrap();
        assert!(resolved.is_none());

        // Create a profile and set as default
        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Default",
                "printerName": "DefaultPrinter",
            }),
        )
        .unwrap();
        let default_id = result["profileId"].as_str().unwrap();
        set_default_printer_profile(&db, default_id).unwrap();

        // Create another profile
        let result2 = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Kitchen",
                "printerName": "KitchenPrinter",
            }),
        )
        .unwrap();
        let kitchen_id = result2["profileId"].as_str().unwrap();

        // Resolve with no job-specific ID -> default
        let resolved = resolve_printer_profile(&db, None).unwrap().unwrap();
        assert_eq!(resolved["printerName"], "DefaultPrinter");

        // Resolve with job-specific ID -> that specific profile
        let resolved = resolve_printer_profile(&db, Some(kitchen_id))
            .unwrap()
            .unwrap();
        assert_eq!(resolved["printerName"], "KitchenPrinter");

        // Resolve with invalid ID -> error
        let err = resolve_printer_profile(&db, Some("nonexistent"));
        assert!(err.is_err());
    }

    #[test]
    fn test_list_system_printers_returns_vec() {
        // Just verify it doesn't panic — actual printers depend on the system
        let printers = list_system_printers();
        // On CI/test environments there may be 0 printers, that's fine.
        // Just verify it returns a Vec without panicking.
        let _ = printers.len();
    }

    #[test]
    fn test_invalid_driver_type_rejected() {
        let db = test_db();
        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Bad",
                "printerName": "Printer",
                "driverType": "bluetooth",
            }),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_escpos_driver_type_accepted() {
        let db = test_db();
        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Thermal",
                "printerName": "ThermalPrinter",
                "driverType": "escpos",
            }),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_invalid_paper_width_rejected() {
        let db = test_db();
        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Bad",
                "printerName": "Printer",
                "paperWidthMm": 72,
            }),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_112mm_paper_width_accepted() {
        let db = test_db();
        let result = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Wide",
                "printerName": "POS-112",
                "paperWidthMm": 112,
            }),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_invalid_receipt_template_rejected() {
        let db = test_db();
        let create_err = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "BadTpl",
                "printerName": "TplPrinter",
                "receiptTemplate": "fancy",
            }),
        );
        assert!(create_err.is_err());

        let created = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "GoodTpl",
                "printerName": "TplPrinter2",
            }),
        )
        .unwrap();
        let id = created["profileId"].as_str().unwrap();
        let update_err = update_printer_profile(
            &db,
            &serde_json::json!({
                "id": id,
                "receiptTemplate": "broken",
            }),
        );
        assert!(update_err.is_err());
    }

    #[test]
    fn test_printer_typography_defaults_are_applied() {
        let db = test_db();
        let created = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Typography Defaults",
                "printerName": "TypoPrinter",
            }),
        )
        .unwrap();
        let id = created["profileId"].as_str().unwrap();
        let profile = get_printer_profile(&db, id).unwrap();

        assert_eq!(profile["fontType"], "a");
        assert_eq!(profile["layoutDensity"], "compact");
        assert_eq!(profile["headerEmphasis"], "strong");
    }

    #[test]
    fn test_receipt_and_kitchen_profiles_default_to_text_connection_mode() {
        let db = test_db();
        let receipt = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Receipt Defaults",
                "printerName": "ReceiptPrinter",
                "role": "receipt",
            }),
        )
        .unwrap();
        let kitchen = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Kitchen Defaults",
                "printerName": "KitchenPrinter",
                "role": "kitchen",
            }),
        )
        .unwrap();

        for id in [
            receipt["profileId"].as_str().unwrap(),
            kitchen["profileId"].as_str().unwrap(),
        ] {
            let profile = get_printer_profile(&db, id).unwrap();
            assert_eq!(profile["receiptTemplate"], "classic");
            let connection_json = profile["connectionJson"]
                .as_str()
                .expect("connection json should exist");
            let connection: serde_json::Value =
                serde_json::from_str(connection_json).expect("parse connection json");
            assert_eq!(
                connection
                    .get("render_mode")
                    .and_then(|value| value.as_str()),
                Some("text")
            );
            assert_eq!(
                connection
                    .get("capabilities")
                    .and_then(|value| value.get("status"))
                    .and_then(|value| value.as_str()),
                Some("unverified")
            );
        }
    }

    #[test]
    fn test_invalid_typography_controls_rejected() {
        let db = test_db();
        let create_err = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Bad Typography",
                "printerName": "BadTypoPrinter",
                "fontType": "c",
            }),
        );
        assert!(create_err.is_err());

        let created = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Good Typography",
                "printerName": "GoodTypoPrinter",
            }),
        )
        .unwrap();
        let id = created["profileId"].as_str().unwrap();

        let bad_density = update_printer_profile(
            &db,
            &serde_json::json!({
                "id": id,
                "layoutDensity": "dense",
            }),
        );
        assert!(bad_density.is_err());

        let bad_emphasis = update_printer_profile(
            &db,
            &serde_json::json!({
                "id": id,
                "headerEmphasis": "loud",
            }),
        );
        assert!(bad_emphasis.is_err());
    }

    #[test]
    fn test_default_flag_and_local_setting_are_synchronized() {
        let db = test_db();

        let p1 = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "P1",
                "printerName": "P1",
                "isDefault": true,
            }),
        )
        .unwrap();
        let p1_id = p1["profileId"].as_str().unwrap().to_string();

        let p2 = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "P2",
                "printerName": "P2",
                "isDefault": true,
            }),
        )
        .unwrap();
        let p2_id = p2["profileId"].as_str().unwrap().to_string();

        let conn = db.conn.lock().unwrap();
        let default_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM printer_profiles WHERE is_default = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(default_count, 1);

        let default_id: String = conn
            .query_row(
                "SELECT id FROM printer_profiles WHERE is_default = 1 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(default_id, p2_id);

        let setting_default = db::get_setting(&conn, "printer", "default_printer_profile_id");
        assert_eq!(setting_default.as_deref(), Some(p2_id.as_str()));
        assert_ne!(p1_id, p2_id);
    }

    #[test]
    fn test_resolve_printer_profile_for_role_prefers_role_then_falls_back() {
        let db = test_db();

        let receipt = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Receipt",
                "printerName": "ReceiptPrinter",
                "role": "receipt",
                "isDefault": true,
                "enabled": true,
            }),
        )
        .unwrap();
        let receipt_id = receipt["profileId"].as_str().unwrap();

        let kitchen = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Kitchen",
                "printerName": "KitchenPrinter",
                "role": "kitchen",
                "enabled": true,
            }),
        )
        .unwrap();
        let kitchen_id = kitchen["profileId"].as_str().unwrap();

        let resolved_kitchen = resolve_printer_profile_for_role(&db, None, Some("kitchen"))
            .unwrap()
            .unwrap();
        assert_eq!(resolved_kitchen["id"], kitchen_id);

        update_printer_profile(
            &db,
            &serde_json::json!({
                "id": kitchen_id,
                "enabled": false,
            }),
        )
        .unwrap();

        let fallback = resolve_printer_profile_for_role(&db, None, Some("kitchen"))
            .unwrap()
            .unwrap();
        assert_eq!(fallback["id"], receipt_id);
    }

    #[test]
    fn test_empty_printer_name_rejected() {
        let db = test_db();
        let create_err = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Bad",
                "printerName": "   ",
            }),
        );
        assert!(create_err.is_err());

        let created = create_printer_profile(
            &db,
            &serde_json::json!({
                "name": "Good",
                "printerName": "Printer",
            }),
        )
        .unwrap();
        let id = created["profileId"].as_str().unwrap();

        let update_err = update_printer_profile(
            &db,
            &serde_json::json!({
                "id": id,
                "printerName": "",
            }),
        );
        assert!(update_err.is_err());
    }

    #[test]
    fn test_detect_printer_brand_star() {
        assert_eq!(detect_printer_brand("Star MCP31"), PrinterBrand::Star);
        assert_eq!(detect_printer_brand("STAR MC-PRINT3"), PrinterBrand::Star);
        assert_eq!(detect_printer_brand("TSP143IIILAN"), PrinterBrand::Star);
        assert_eq!(detect_printer_brand("star mcprint"), PrinterBrand::Star);
        assert_eq!(detect_printer_brand("Star_TSP100"), PrinterBrand::Star);
    }

    #[test]
    fn test_detect_printer_brand_epson() {
        assert_eq!(detect_printer_brand("EPSON TM-T88VI"), PrinterBrand::Epson);
        assert_eq!(detect_printer_brand("TM-T20III"), PrinterBrand::Epson);
        assert_eq!(detect_printer_brand("TM-m30II"), PrinterBrand::Epson);
        assert_eq!(detect_printer_brand("Epson Receipt"), PrinterBrand::Epson);
    }

    #[test]
    fn test_detect_printer_brand_citizen() {
        assert_eq!(
            detect_printer_brand("Citizen CT-S310II"),
            PrinterBrand::Citizen
        );
        assert_eq!(detect_printer_brand("CT-S801"), PrinterBrand::Citizen);
    }

    #[test]
    fn test_detect_printer_brand_others() {
        assert_eq!(
            detect_printer_brand("BIXOLON SRP-350"),
            PrinterBrand::Bixolon
        );
        assert_eq!(
            detect_printer_brand("Xprinter XP-Q200"),
            PrinterBrand::Xprinter
        );
        assert_eq!(detect_printer_brand("XP-80C"), PrinterBrand::Xprinter);
    }

    #[test]
    fn test_detect_printer_brand_unknown() {
        assert_eq!(
            detect_printer_brand("Generic POS-80"),
            PrinterBrand::Unknown
        );
        assert_eq!(
            detect_printer_brand("Some Random Printer"),
            PrinterBrand::Unknown
        );
        assert_eq!(detect_printer_brand("POS-58"), PrinterBrand::Unknown);
    }
}
