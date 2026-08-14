use rusqlite::OptionalExtension;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::hash::{Hash, Hasher};
use std::time::Duration;
use tauri::Emitter;
use tracing::{info, warn};

use crate::{db, ecr, payload_arg0_as_string, value_str};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct EcrDiscoverCompatPayload {
    #[serde(default, alias = "connection_types", alias = "connectionTypes")]
    types: Vec<String>,
    #[serde(default, alias = "connection_type", alias = "connectionType")]
    connection_type: Option<String>,
    #[serde(default, alias = "timeout_ms", alias = "timeoutMs")]
    timeout: Option<u64>,
}

#[derive(Debug)]
struct EcrUpdateCompatPayload {
    device_id: String,
    updates: serde_json::Value,
}

#[derive(Debug)]
struct AmountOptionsCompatPayload {
    amount: f64,
    options: serde_json::Value,
}

#[derive(Debug)]
struct VoidTransactionCompatPayload {
    transaction_id: String,
    device_id: Option<String>,
}

const DEFAULT_DISCOVERY_TYPES: [&str; 3] = ["serial_usb", "network", "bluetooth"];
const DEFAULT_SERIAL_BAUD_RATE: u32 = 9600;
const DEFAULT_NETWORK_DISCOVERY_TIMEOUT_MS: u64 = 180;
const BLUETOOTH_DISCOVERY_ONLY_WARNING_KEY: &str = "ecr.discovery.warnings.bluetoothDiscoveryOnly";
const BLUETOOTH_WINDOWS_ONLY_WARNING_KEY: &str = "ecr.discovery.warnings.bluetoothWindowsOnly";
const NETWORK_WINDOWS_ONLY_WARNING_KEY: &str = "ecr.discovery.warnings.networkWindowsOnly";
const BLUETOOTH_UNSUPPORTED_REASON_KEY: &str = "ecr.discovery.unsupportedBluetooth";
const NETWORK_DISCOVERY_PORTS: [u16; 2] = [20007, 10009];

#[derive(Default, Clone)]
struct ConfiguredEcrLookup {
    names: HashSet<String>,
    addresses: HashSet<String>,
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

fn value_to_f64(value: serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn value_to_u64(value: serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn value_ref_to_u16(value: &serde_json::Value) -> Option<u16> {
    value
        .as_u64()
        .and_then(|parsed| u16::try_from(parsed).ok())
        .or_else(|| {
            value
                .as_str()
                .and_then(|parsed| parsed.trim().parse::<u16>().ok())
        })
}

fn normalize_lookup_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_ascii_lowercase())
}

fn format_mac_address(hex12: &str) -> String {
    let upper = hex12.to_ascii_uppercase();
    let parts: Vec<String> = upper
        .chars()
        .collect::<Vec<char>>()
        .chunks(2)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect();
    parts.join(":")
}

fn extract_mac_from_instance_id(instance_id: &str) -> Option<String> {
    let upper = instance_id.to_ascii_uppercase();
    if let Some(start) = upper.find("DEV_") {
        let candidate = upper.get(start + 4..start + 16)?;
        if candidate.len() == 12 && candidate.chars().all(|value| value.is_ascii_hexdigit()) {
            return Some(format_mac_address(candidate));
        }
    }

    if upper.contains("BTH") {
        for token in upper.split(|value: char| !value.is_ascii_hexdigit()) {
            if token.len() == 12 && token.chars().all(|value| value.is_ascii_hexdigit()) {
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
        return Some(mac.to_ascii_lowercase());
    }

    Some(trimmed.to_ascii_lowercase())
}

fn normalize_mac_address(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let hex_only: String = trimmed.chars().filter(|c| c.is_ascii_hexdigit()).collect();

    if hex_only.len() == 12
        && hex_only.len()
            == trimmed
                .chars()
                .filter(|c| !matches!(c, ':' | '-' | '.' | ' '))
                .count()
    {
        return Some(hex_only.to_ascii_lowercase());
    }

    None
}

fn connection_detail_string(
    connection_details: &serde_json::Value,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
        let Some(value) = connection_details.get(*key) else {
            continue;
        };
        if let Some(text) = value.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }

        if value.is_number() {
            return Some(value.to_string());
        }
    }

    None
}

fn connection_detail_u16(connection_details: &serde_json::Value, keys: &[&str]) -> Option<u16> {
    for key in keys {
        let Some(value) = connection_details.get(*key) else {
            continue;
        };
        if let Some(parsed) = value_ref_to_u16(value) {
            return Some(parsed);
        }
    }

    None
}

fn normalize_discovery_type(value: &str) -> Option<&'static str> {
    let normalized = value
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' ', '/'], "_");

    match normalized.as_str() {
        "serial_usb" | "serial" | "usb" | "usb_serial" => Some("serial_usb"),
        "bluetooth" | "bt" => Some("bluetooth"),
        "network" | "tcp" | "lan" => Some("network"),
        _ => None,
    }
}

fn resolve_requested_discovery_types(types: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut requested = Vec::new();

    for value in types {
        if let Some(normalized) = normalize_discovery_type(&value) {
            if seen.insert(normalized.to_string()) {
                requested.push(normalized.to_string());
            }
        }
    }

    if requested.is_empty() {
        DEFAULT_DISCOVERY_TYPES
            .iter()
            .map(|value| (*value).to_string())
            .collect()
    } else {
        requested
    }
}

fn build_discovery_warning_keys(requested_types: &[String]) -> Vec<String> {
    let mut warnings = Vec::new();

    if requested_types.iter().any(|value| value == "bluetooth") {
        if cfg!(target_os = "windows") {
            warnings.push(BLUETOOTH_DISCOVERY_ONLY_WARNING_KEY.to_string());
        } else {
            warnings.push(BLUETOOTH_WINDOWS_ONLY_WARNING_KEY.to_string());
        }
    }

    if !cfg!(target_os = "windows") && requested_types.iter().any(|value| value == "network") {
        warnings.push(NETWORK_WINDOWS_ONLY_WARNING_KEY.to_string());
    }

    warnings
}

fn configured_ecr_lookup_from_devices(devices: &[serde_json::Value]) -> ConfiguredEcrLookup {
    let mut lookup = ConfiguredEcrLookup::default();

    for device in devices {
        if let Some(name) = value_str(device, &["name", "terminalName", "terminal_name"]) {
            if let Some(token) = normalize_lookup_token(&name) {
                lookup.names.insert(token);
            }
        }

        let connection_details = device
            .get("connectionDetails")
            .or_else(|| device.get("connection_details"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        for key in [
            "port",
            "serialPort",
            "portName",
            "comPort",
            "path",
            "address",
            "ip",
            "host",
            "hostname",
            "macAddress",
            "mac_address",
        ] {
            if let Some(value) = connection_detail_string(&connection_details, &[key]) {
                if let Some(token) = normalize_address_token(&value) {
                    lookup.addresses.insert(token);
                }
            }
        }

        let connection_type = value_str(device, &["connectionType", "connection_type"])
            .unwrap_or_default()
            .to_ascii_lowercase();
        if connection_type == "network" {
            if let (Some(ip), Some(port)) = (
                connection_detail_string(&connection_details, &["ip", "host", "hostname"]),
                connection_detail_u16(&connection_details, &["port", "tcpPort", "tcp_port"]),
            ) {
                if let Some(token) = normalize_address_token(&format!("{ip}:{port}")) {
                    lookup.addresses.insert(token);
                }
            }
        }
    }

    lookup
}

fn is_configured_terminal(configured: &ConfiguredEcrLookup, name: &str, address: &str) -> bool {
    let normalized_name = normalize_lookup_token(name).unwrap_or_default();
    let normalized_address = normalize_address_token(address).unwrap_or_default();

    (!normalized_name.is_empty() && configured.names.contains(&normalized_name))
        || (!normalized_address.is_empty() && configured.addresses.contains(&normalized_address))
}

fn build_serial_terminal_candidate(
    port_name: &str,
    manufacturer: Option<&str>,
    model: Option<&str>,
    configured: &ConfiguredEcrLookup,
) -> serde_json::Value {
    let manufacturer = manufacturer
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let model = model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let name = model
        .clone()
        .or_else(|| {
            manufacturer
                .clone()
                .map(|value| format!("{value} Terminal"))
        })
        .unwrap_or_else(|| format!("Serial Terminal ({port_name})"));
    let is_configured = is_configured_terminal(configured, &name, port_name);

    serde_json::json!({
        "name": name,
        "deviceType": "payment_terminal",
        "connectionType": "serial_usb",
        "connectionDetails": {
            "type": "serial_usb",
            "port": port_name,
            "baudRate": DEFAULT_SERIAL_BAUD_RATE,
        },
        "manufacturer": manufacturer,
        "model": model,
        "isConfigured": is_configured,
        "isSupported": true,
        "unsupportedReason": serde_json::Value::Null,
        "discoverySource": "serial-enum",
    })
}

fn build_network_terminal_candidate(
    ip: &str,
    port: u16,
    configured: &ConfiguredEcrLookup,
    discovery_source: &str,
) -> serde_json::Value {
    let address = format!("{ip}:{port}");
    let name = format!("Network Terminal ({address})");
    let is_configured = is_configured_terminal(configured, &name, &address);

    serde_json::json!({
        "name": name,
        "deviceType": "payment_terminal",
        "connectionType": "network",
        "connectionDetails": {
            "type": "network",
            "ip": ip,
            "port": port,
        },
        "manufacturer": serde_json::Value::Null,
        "model": serde_json::Value::Null,
        "isConfigured": is_configured,
        "isSupported": true,
        "unsupportedReason": serde_json::Value::Null,
        "discoverySource": discovery_source,
    })
}

fn build_bluetooth_terminal_candidate(
    name: &str,
    address: &str,
    manufacturer: Option<&str>,
    model: Option<&str>,
    configured: &ConfiguredEcrLookup,
    discovery_source: &str,
) -> serde_json::Value {
    let resolved_name = if name.trim().is_empty() {
        format!("Bluetooth Terminal ({address})")
    } else {
        name.trim().to_string()
    };
    let manufacturer = manufacturer
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let model = model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let is_configured = is_configured_terminal(configured, &resolved_name, address);

    serde_json::json!({
        "name": resolved_name,
        "deviceType": "payment_terminal",
        "connectionType": "bluetooth",
        "connectionDetails": {
            "type": "bluetooth",
            "address": address,
            "channel": 1,
        },
        "manufacturer": manufacturer,
        "model": model,
        "isConfigured": is_configured,
        "isSupported": false,
        "unsupportedReason": BLUETOOTH_UNSUPPORTED_REASON_KEY,
        "discoverySource": discovery_source,
    })
}

fn discovery_identity(entry: &serde_json::Value) -> String {
    let connection_type = value_str(entry, &["connectionType", "connection_type"])
        .unwrap_or_else(|| "unknown".to_string())
        .to_ascii_lowercase();
    let connection_details = entry
        .get("connectionDetails")
        .or_else(|| entry.get("connection_details"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let identity = match connection_type.as_str() {
        "serial_usb" => connection_detail_string(
            &connection_details,
            &["port", "serialPort", "portName", "comPort", "path"],
        )
        .and_then(|value| normalize_lookup_token(&value)),
        "network" => match (
            connection_detail_string(&connection_details, &["ip", "host", "hostname"]),
            connection_detail_u16(&connection_details, &["port", "tcpPort", "tcp_port"]),
        ) {
            (Some(ip), Some(port)) => normalize_address_token(&format!("{ip}:{port}")),
            (Some(ip), None) => normalize_address_token(&ip),
            _ => None,
        },
        "bluetooth" => connection_detail_string(
            &connection_details,
            &["address", "macAddress", "mac_address"],
        )
        .and_then(|value| {
            normalize_mac_address(&value).or_else(|| normalize_address_token(&value))
        }),
        _ => None,
    }
    .or_else(|| value_str(entry, &["name"]).and_then(|value| normalize_lookup_token(&value)))
    .unwrap_or_default();

    format!("{connection_type}:{identity}")
}

fn dedupe_discovered_terminals(terminals: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();

    for terminal in terminals {
        if seen.insert(discovery_identity(&terminal)) {
            deduped.push(terminal);
        }
    }

    deduped
}

fn discover_serial_terminals_native(configured: &ConfiguredEcrLookup) -> Vec<serde_json::Value> {
    let mut discovered = Vec::new();

    let ports = match serialport::available_ports() {
        Ok(ports) => ports,
        Err(error) => {
            warn!(error = %error, "ECR serial discovery failed to enumerate ports");
            return discovered;
        }
    };

    for port in ports {
        match &port.port_type {
            serialport::SerialPortType::BluetoothPort => {}
            serialport::SerialPortType::UsbPort(usb) => {
                discovered.push(build_serial_terminal_candidate(
                    &port.port_name,
                    usb.manufacturer.as_deref(),
                    usb.product.as_deref(),
                    configured,
                ));
            }
            _ => {
                discovered.push(build_serial_terminal_candidate(
                    &port.port_name,
                    None,
                    None,
                    configured,
                ));
            }
        }
    }

    dedupe_discovered_terminals(discovered)
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
        serde_json::Value::Object(obj) => obj
            .get("IPAddress")
            .and_then(serde_json::Value::as_str)
            .map(|value| vec![value.to_string()])
            .unwrap_or_default(),
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
            warn!(error = %error, "ECR network discovery failed to enumerate local IPv4 addresses");
            return out;
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        warn!(
            stderr = %stderr,
            "ECR network discovery PowerShell IPv4 enumeration returned a non-success status"
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
                "ECR network discovery PowerShell IPv4 enumeration returned invalid JSON"
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
async fn probe_lan_terminal_host(ip: std::net::Ipv4Addr, timeout_ms: u64) -> Vec<u16> {
    let mut open_ports = Vec::new();

    for port in NETWORK_DISCOVERY_PORTS {
        let addr = std::net::SocketAddr::from((std::net::IpAddr::V4(ip), port));
        if tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            tokio::net::TcpStream::connect(addr),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .is_some()
        {
            open_ports.push(port);
        }
    }

    open_ports
}

#[cfg(target_os = "windows")]
async fn discover_network_terminals_native(
    configured: &ConfiguredEcrLookup,
    timeout_ms: u64,
) -> Vec<serde_json::Value> {
    let local_ips = detect_local_ipv4s();
    if local_ips.is_empty() {
        warn!("ECR network discovery skipped: no private IPv4 address could be detected");
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

    let bounded_timeout_ms = timeout_ms.clamp(80, 1000);
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(48));
    let mut set = tokio::task::JoinSet::new();

    for ip in hosts {
        let semaphore = semaphore.clone();
        set.spawn(async move {
            let _permit = semaphore.acquire_owned().await.ok()?;
            let open_ports = probe_lan_terminal_host(ip, bounded_timeout_ms).await;
            if open_ports.is_empty() {
                None
            } else {
                Some((ip, open_ports))
            }
        });
    }

    let mut discovered = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Some((ip, ports))) = joined {
            let ip_string = ip.to_string();
            for port in ports {
                discovered.push(build_network_terminal_candidate(
                    &ip_string,
                    port,
                    configured,
                    "lan-port-scan",
                ));
            }
        }
    }

    let deduped = dedupe_discovered_terminals(discovered);
    info!(
        local_ips = ?local_ips,
        discovered = deduped.len(),
        "ECR network discovery completed"
    );
    deduped
}

#[cfg(not(target_os = "windows"))]
async fn discover_network_terminals_native(
    _configured: &ConfiguredEcrLookup,
    _timeout_ms: u64,
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
        .map_err(|error| format!("Failed to execute PowerShell command: {error}"))
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

fn is_internal_bluetooth_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
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
    let upper = instance_id.trim().to_ascii_uppercase();
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
            if trimmed.len() == 12 && trimmed.chars().all(|value| value.is_ascii_hexdigit()) {
                return format_mac_address(trimmed);
            }
            return trimmed.to_string();
        }
    }

    extract_mac_from_instance_id(instance_id)
        .unwrap_or_else(|| stable_bt_fallback_address(instance_id, name))
}

fn build_bluetooth_terminals_from_rows(
    rows: Vec<serde_json::Value>,
    configured: &ConfiguredEcrLookup,
) -> Vec<serde_json::Value> {
    let mut discovered = Vec::new();

    for device in rows {
        let instance_id = value_str(&device, &["InstanceId", "instanceId"]).unwrap_or_default();
        if is_internal_bluetooth_instance(&instance_id) {
            continue;
        }

        let name = value_str(&device, &["FriendlyName", "friendlyName", "name"])
            .unwrap_or_else(|| "Bluetooth Terminal".to_string());
        if is_internal_bluetooth_name(&name) {
            continue;
        }

        let address = resolve_bluetooth_address(&device, &instance_id, &name);
        let source =
            value_str(&device, &["Source", "source"]).unwrap_or_else(|| "windows-pnp".to_string());
        let manufacturer = value_str(&device, &["Manufacturer", "manufacturer"]);
        let model = value_str(&device, &["Model", "model"]);

        discovered.push(build_bluetooth_terminal_candidate(
            &name,
            &address,
            manufacturer.as_deref(),
            model.as_deref(),
            configured,
            &source,
        ));
    }

    dedupe_discovered_terminals(discovered)
}

#[cfg(target_os = "windows")]
fn discover_bluetooth_pnp_rows() -> Vec<serde_json::Value> {
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

    run_hidden_powershell_json_rows(script, "ecr-bluetooth-pnp")
}

#[cfg(target_os = "windows")]
fn discover_bluetooth_ble_rows() -> Vec<serde_json::Value> {
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
    $name = \"Bluetooth Terminal ($address)\"
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
  } elseif ($devices[$address].FriendlyName -like 'Bluetooth Terminal*' -and -not [string]::IsNullOrWhiteSpace($args.Advertisement.LocalName)) {
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

    run_hidden_powershell_json_rows(script, "ecr-bluetooth-ble")
}

#[cfg(target_os = "windows")]
fn discover_bluetooth_terminals_native(configured: &ConfiguredEcrLookup) -> Vec<serde_json::Value> {
    let mut candidates = discover_bluetooth_pnp_rows();
    let ble_rows = discover_bluetooth_ble_rows();
    if !ble_rows.is_empty() {
        candidates.extend(ble_rows);
    }

    if candidates.is_empty() {
        info!("ECR bluetooth discovery returned no candidate devices");
        return vec![];
    }

    let deduped = build_bluetooth_terminals_from_rows(candidates, configured);
    info!(
        discovered = deduped.len(),
        "ECR bluetooth discovery completed"
    );
    deduped
}

#[cfg(not(target_os = "windows"))]
fn discover_bluetooth_terminals_native(
    _configured: &ConfiguredEcrLookup,
) -> Vec<serde_json::Value> {
    vec![]
}

fn parse_required_device_id(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(arg0, &["deviceId", "device_id", "id"]).ok_or("Missing deviceId".into())
}

fn parse_optional_device_id(arg0: Option<serde_json::Value>) -> Option<String> {
    payload_arg0_as_string(arg0, &["deviceId", "device_id", "id"])
}

fn parse_required_order_id(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(arg0, &["orderId", "order_id", "id"]).ok_or("Missing orderId".into())
}

fn parse_optional_order_id(arg0: Option<serde_json::Value>) -> Option<String> {
    payload_arg0_as_string(arg0, &["orderId", "order_id", "id"])
}

fn persist_fiscal_receipt_transaction_and_enqueue_backfill(
    conn: &mut rusqlite::Connection,
    insert_payload: &serde_json::Value,
    order_id: &str,
    fiscal_receipt_number: Option<&str>,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin fiscal receipt transaction: {e}"))?;

    db::ecr_insert_transaction(&tx, insert_payload)?;

    if let Some(fiscal_receipt_number) = fiscal_receipt_number
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let status = tx
            .query_row(
                "SELECT COALESCE(NULLIF(TRIM(status), ''), 'completed')
                 FROM orders
                 WHERE id = ?1
                 LIMIT 1",
                rusqlite::params![order_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("load fiscal receipt order status: {e}"))?
            .unwrap_or_else(|| "completed".to_string());

        let backfill_payload = serde_json::json!({
            "orderId": order_id,
            "status": status,
            "fiscalReceiptNumber": fiscal_receipt_number,
            "fiscal_receipt_number": fiscal_receipt_number,
        });

        crate::sync_queue::enqueue_payload_item(
            &tx,
            "orders",
            order_id,
            "UPDATE",
            &backfill_payload,
            Some(1),
            Some("orders"),
            Some("server-wins"),
            Some(1),
        )
        .map_err(|e| format!("enqueue fiscal receipt order backfill: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("commit fiscal receipt transaction: {e}"))
}

fn parse_discover_args(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> (Vec<String>, Option<u64>) {
    let legacy_timeout = arg1.and_then(value_to_u64);
    let mut types: Vec<String> = Vec::new();
    let mut timeout = legacy_timeout;

    match arg0 {
        Some(serde_json::Value::Array(arr)) => {
            types = arr.into_iter().filter_map(value_to_string).collect();
        }
        Some(serde_json::Value::String(value)) => {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                types.push(trimmed.to_string());
            }
        }
        Some(serde_json::Value::Object(obj)) => {
            let payload = serde_json::Value::Object(obj.clone());
            let parsed: EcrDiscoverCompatPayload =
                serde_json::from_value(payload).unwrap_or_default();
            types = parsed.types;
            if let Some(single) = parsed.connection_type {
                types.push(single);
            }
            timeout = parsed.timeout.or(timeout);
            if timeout.is_none() {
                timeout = obj.get("timeout").cloned().and_then(value_to_u64);
            }
        }
        _ => {}
    }

    let normalized_types = types
        .into_iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect();
    (normalized_types, timeout)
}

fn parse_update_device_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<EcrUpdateCompatPayload, String> {
    let device_id = parse_required_device_id(arg0.clone())?;
    let updates = match arg1 {
        Some(v) => v,
        None => match arg0 {
            Some(serde_json::Value::Object(mut obj)) => {
                if let Some(nested) = obj.remove("updates") {
                    nested
                } else {
                    obj.remove("deviceId");
                    obj.remove("device_id");
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

    Ok(EcrUpdateCompatPayload { device_id, updates })
}

fn parse_amount_and_options_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> AmountOptionsCompatPayload {
    let mut amount = arg0.clone().and_then(value_to_f64).unwrap_or(0.0);
    let mut options = arg1.unwrap_or_else(|| serde_json::json!({}));

    if let Some(serde_json::Value::Object(mut obj)) = arg0 {
        if let Some(parsed_amount) = obj
            .get("amount")
            .cloned()
            .and_then(value_to_f64)
            .or_else(|| obj.get("total").cloned().and_then(value_to_f64))
        {
            amount = parsed_amount;
        }

        if let Some(nested) = obj.remove("options") {
            options = nested;
        } else {
            obj.remove("amount");
            obj.remove("total");
            if !obj.is_empty() {
                options = serde_json::Value::Object(obj);
            }
        }
    }

    if options.is_null() {
        options = serde_json::json!({});
    }

    AmountOptionsCompatPayload { amount, options }
}

fn validate_ecr_amount(amount: f64) -> Result<i64, String> {
    if !amount.is_finite() {
        return Err("Invalid ECR amount: amount must be finite".to_string());
    }
    if amount <= 0.0 {
        return Err("Invalid ECR amount: amount must be positive".to_string());
    }

    let amount_cents = (amount * 100.0).round();
    if amount_cents <= 0.0 || amount_cents > 99_999_999.0 {
        return Err("Invalid ECR amount: amount is outside supported bounds".to_string());
    }

    Ok(amount_cents as i64)
}

fn parse_void_transaction_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<VoidTransactionCompatPayload, String> {
    let legacy_device_id = arg1.and_then(value_to_string);
    let payload = arg0.clone().unwrap_or(serde_json::Value::Null);

    let transaction_id = payload_arg0_as_string(
        arg0.clone(),
        &[
            "transactionId",
            "transaction_id",
            "originalTransactionId",
            "original_transaction_id",
            "id",
        ],
    )
    .ok_or("Missing transactionId")?;

    let device_id = if let serde_json::Value::Object(_) = payload {
        value_str(&payload, &["deviceId", "device_id"]).or(legacy_device_id)
    } else {
        legacy_device_id
    };

    Ok(VoidTransactionCompatPayload {
        transaction_id,
        device_id,
    })
}

fn parse_recent_transactions_limit(arg0: Option<serde_json::Value>) -> i64 {
    match arg0 {
        Some(serde_json::Value::Object(obj)) => obj
            .get("limit")
            .and_then(|value| value_to_u64(value.clone()))
            .map(|value| value as i64)
            .unwrap_or(50),
        Some(value) => value_to_u64(value).map(|v| v as i64).unwrap_or(50),
        None => 50,
    }
}

fn parse_query_filters_payload(arg0: Option<serde_json::Value>) -> serde_json::Value {
    match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(device_id)) => serde_json::json!({ "deviceId": device_id }),
        Some(serde_json::Value::Number(limit)) => serde_json::json!({ "limit": limit }),
        _ => serde_json::json!({}),
    }
}

#[tauri::command]
pub async fn ecr_discover_devices(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let (requested_types_raw, timeout) = parse_discover_args(arg0, arg1);
    let requested_types = resolve_requested_discovery_types(requested_types_raw);
    let warnings = build_discovery_warning_keys(&requested_types);

    let configured_devices = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        db::ecr_list_devices(&conn)
    };
    let configured_lookup = configured_ecr_lookup_from_devices(&configured_devices);

    let mut devices = Vec::new();
    if requested_types.iter().any(|value| value == "serial_usb") {
        devices.extend(discover_serial_terminals_native(&configured_lookup));
    }
    if requested_types.iter().any(|value| value == "network") {
        devices.extend(
            discover_network_terminals_native(
                &configured_lookup,
                timeout.unwrap_or(DEFAULT_NETWORK_DISCOVERY_TIMEOUT_MS),
            )
            .await,
        );
    }
    if requested_types.iter().any(|value| value == "bluetooth") {
        devices.extend(discover_bluetooth_terminals_native(&configured_lookup));
    }

    let devices = dedupe_discovered_terminals(devices);
    Ok(serde_json::json!({
        "success": true,
        "devices": devices,
        "warnings": warnings,
    }))
}

#[tauri::command]
pub async fn ecr_get_devices(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let devices = db::ecr_list_devices(&conn);
    Ok(serde_json::json!({
        "success": true,
        "devices": devices
    }))
}

#[tauri::command]
pub async fn ecr_get_device(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let device = db::ecr_get_device(&conn, &device_id);
    Ok(serde_json::json!({
        "success": device.is_some(),
        "device": device,
        "error": if device.is_none() { serde_json::json!("Device not found") } else { serde_json::Value::Null }
    }))
}

#[tauri::command]
pub async fn ecr_add_device(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let mut config = arg0.unwrap_or(serde_json::json!({}));
    let device_id = config
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("ecr-{}", &uuid::Uuid::new_v4().to_string()[..8]));
    if let Some(obj) = config.as_object_mut() {
        obj.insert("id".to_string(), serde_json::json!(device_id));
        obj.entry("status".to_string())
            .or_insert(serde_json::json!("disconnected"));
        obj.entry("enabled".to_string())
            .or_insert(serde_json::json!(true));
    } else {
        config = serde_json::json!({
            "id": device_id,
            "status": "disconnected",
            "enabled": true
        });
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::ecr_insert_device(&conn, &config)?;
    let device = db::ecr_get_device(&conn, &device_id);

    Ok(serde_json::json!({
        "success": true,
        "device": device.unwrap_or(config)
    }))
}

#[tauri::command]
pub async fn ecr_update_device(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_update_device_payload(arg0, arg1)?;
    let device_id = parsed.device_id;
    let updates = parsed.updates;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let existing = db::ecr_get_device(&conn, &device_id);
    if existing.is_none() {
        return Ok(serde_json::json!({
            "success": false,
            "error": "Device not found"
        }));
    }

    db::ecr_update_device(&conn, &device_id, &updates)?;
    let updated_device = db::ecr_get_device(&conn, &device_id);

    let _ = app.emit(
        "ecr_event_device_status_changed",
        serde_json::json!({
            "deviceId": device_id,
            "device": updated_device
        }),
    );

    Ok(serde_json::json!({
        "success": true,
        "device": updated_device
    }))
}

#[tauri::command]
pub async fn ecr_remove_device(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;
    // Disconnect from DeviceManager if connected
    let _ = mgr.disconnect_device(&device_id);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let removed = db::ecr_delete_device(&conn, &device_id)?;
    Ok(serde_json::json!({
        "success": removed,
        "removed": if removed { 1 } else { 0 }
    }))
}

#[tauri::command]
pub async fn ecr_get_default_terminal(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let default_device = db::ecr_get_default_device(&conn, None);
    Ok(serde_json::json!({
        "success": default_device.is_some(),
        "device": default_device
    }))
}

#[tauri::command]
pub async fn ecr_connect_device(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;

    // Load the connection config under the DB lock, then drop the guard
    // before the device handshake below: the transport connect +
    // `initialize()` can stall for seconds on absent hardware, and the
    // guard must not be held across the await (it is not `Send`).
    let (connection_type, connection_details, protocol_name, settings) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let device = db::ecr_get_device(&conn, &device_id)
            .ok_or_else(|| format!("Device {device_id} not found"))?;

        let connection_type = device
            .get("connectionType")
            .and_then(|v| v.as_str())
            .unwrap_or("serial_usb")
            .to_string();
        let connection_details = device
            .get("connectionDetails")
            .cloned()
            .unwrap_or(serde_json::json!({}));
        let protocol_name = device
            .get("protocol")
            .and_then(|v| v.as_str())
            .unwrap_or("generic")
            .to_string();
        let settings = device
            .get("settings")
            .cloned()
            .unwrap_or(serde_json::json!({}));

        (connection_type, connection_details, protocol_name, settings)
        // MutexGuard drops here; DB lock released.
    };

    // Attempt real protocol connection via DeviceManager
    match mgr
        .connect_device_offloaded(
            &device_id,
            &connection_type,
            &connection_details,
            &protocol_name,
            &settings,
        )
        .await
    {
        Ok(()) => {
            let now = chrono::Utc::now().to_rfc3339();
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            db::ecr_update_device(
                &conn,
                &device_id,
                &serde_json::json!({"status": "connected", "lastConnectedAt": now, "lastError": null}),
            )?;
            let _ = app.emit(
                "ecr_event_device_connected",
                serde_json::json!({ "deviceId": device_id }),
            );
            let _ = app.emit(
                "ecr_event_device_status_changed",
                serde_json::json!({
                    "deviceId": device_id,
                    "status": "connected"
                }),
            );
            Ok(serde_json::json!({ "success": true }))
        }
        Err(e) => {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            db::ecr_update_device(
                &conn,
                &device_id,
                &serde_json::json!({"status": "error", "lastError": e}),
            )?;
            let _ = app.emit(
                "ecr_event_device_status_changed",
                serde_json::json!({
                    "deviceId": device_id,
                    "status": "error",
                    "error": e
                }),
            );
            Ok(serde_json::json!({ "success": false, "error": e }))
        }
    }
}

#[tauri::command]
pub async fn ecr_disconnect_device(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;
    let _ = mgr.disconnect_device(&device_id);

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::ecr_update_device(
        &conn,
        &device_id,
        &serde_json::json!({"status": "disconnected"}),
    )?;
    let _ = app.emit(
        "ecr_event_device_disconnected",
        serde_json::json!({ "deviceId": device_id }),
    );
    let _ = app.emit(
        "ecr_event_device_status_changed",
        serde_json::json!({
            "deviceId": device_id,
            "status": "disconnected"
        }),
    );
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn ecr_get_device_status(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let device = db::ecr_get_device(&conn, &device_id);
    let connected = mgr.is_connected(&device_id);
    let db_status = device
        .as_ref()
        .and_then(|d| d.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("disconnected");
    let live_status = if connected {
        Some(mgr.get_device_status(&device_id))
    } else {
        None
    };
    let (
        status,
        ready,
        busy,
        error,
        firmware_version,
        serial_number,
        fiscal_receipt_counter,
        fiscal_z_counter,
    ) = match live_status {
        Some(Ok(status)) => {
            let status_label = if status.error.is_some() {
                "error"
            } else if status.busy {
                "busy"
            } else {
                "connected"
            };
            (
                status_label,
                status.ready,
                status.busy,
                status.error,
                status.firmware_version,
                status.serial_number,
                status.fiscal_receipt_counter,
                status.fiscal_z_counter,
            )
        }
        Some(Err(error)) => ("error", false, false, Some(error), None, None, None, None),
        None => (db_status, false, false, None, None, None, None, None),
    };

    Ok(serde_json::json!({
        "success": device.is_some(),
        "deviceId": device_id,
        "connected": connected,
        "status": status,
        "ready": ready,
        "busy": busy,
        "error": error,
        "firmwareVersion": firmware_version,
        "serialNumber": serial_number,
        "fiscalReceiptCounter": fiscal_receipt_counter,
        "fiscalZCounter": fiscal_z_counter,
    }))
}

#[tauri::command]
pub async fn ecr_get_all_statuses(
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let devices = db::ecr_list_devices(&conn);
    let statuses: Vec<serde_json::Value> = devices
        .iter()
        .map(|d| {
            let device_id = d
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let connected = mgr.is_connected(&device_id);
            let db_status = d
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("disconnected");
            serde_json::json!({
                "deviceId": device_id,
                "connected": connected,
                "status": if connected { "connected" } else { db_status }
            })
        })
        .collect();
    Ok(serde_json::json!({
        "success": true,
        "statuses": statuses
    }))
}

#[tauri::command]
pub async fn ecr_process_payment(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_amount_and_options_payload(arg0, arg1);
    let amount = parsed.amount;
    let amount_cents = validate_ecr_amount(amount)?;
    let options = parsed.options;
    let device_id = options
        .get("deviceId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let order_id = options
        .get("orderId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let currency = options
        .get("currency")
        .and_then(|v| v.as_str())
        .unwrap_or("EUR")
        .to_string();

    let _ = app.emit(
        "ecr_event_transaction_started",
        serde_json::json!({ "type": "payment", "amount": amount }),
    );

    let tx_id = format!("txn-{}", uuid::Uuid::new_v4());
    let started = chrono::Utc::now().to_rfc3339();

    // Resolve device: explicit > default > first connected
    let resolved_device_id = if let Some(ref did) = device_id {
        Some(did.clone())
    } else {
        mgr.connected_device_ids().into_iter().next()
    };

    if let Some(ref did) = resolved_device_id {
        if mgr.is_connected(did) {
            let request = ecr::protocol::TransactionRequest {
                transaction_id: tx_id.clone(),
                transaction_type: ecr::protocol::TransactionType::Sale,
                amount: amount_cents,
                currency: currency.clone(),
                order_id: order_id.clone(),
                tip_amount: options
                    .get("tipAmount")
                    .and_then(|v| v.as_f64())
                    .map(|t| (t * 100.0).round() as i64),
                original_transaction_id: None,
                fiscal_data: None,
            };
            // The card exchange can span the whole customer interaction
            // (up to ~60s) — run it on the blocking pool, not a Tokio
            // worker. Same envelope as the sync call.
            match mgr.process_transaction_offloaded(did, request).await {
                Ok(resp) => {
                    let status_str = format!("{:?}", resp.status).to_lowercase();
                    let transaction = serde_json::json!({
                        "id": resp.transaction_id,
                        "amount": amount,
                        "status": status_str,
                        "authorizationCode": resp.authorization_code,
                        "terminalReference": resp.terminal_reference,
                        "cardType": resp.card_type,
                        "cardLastFour": resp.card_last_four,
                        "entryMethod": resp.entry_method,
                        "errorMessage": resp.error_message,
                        "startedAt": resp.started_at,
                        "completedAt": resp.completed_at,
                    });
                    // Log transaction to DB
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let _ = db::ecr_insert_transaction(
                        &conn,
                        &serde_json::json!({
                            "id": resp.transaction_id,
                            "deviceId": did,
                            "orderId": order_id,
                            "transactionType": "sale",
                            "amount": amount_cents,
                            "currency": currency,
                            "status": status_str,
                            "authorizationCode": resp.authorization_code,
                            "terminalReference": resp.terminal_reference,
                            "cardType": resp.card_type,
                            "cardLastFour": resp.card_last_four,
                            "entryMethod": resp.entry_method,
                            "errorMessage": resp.error_message,
                            "rawResponse": resp.raw_response,
                            "startedAt": resp.started_at,
                            "completedAt": resp.completed_at,
                        }),
                    );

                    let _ = app.emit("ecr_event_transaction_completed", transaction.clone());
                    return Ok(serde_json::json!({
                        "success": status_str == "approved",
                        "transaction": transaction,
                        "options": options
                    }));
                }
                Err(e) => {
                    let _ = app.emit(
                        "ecr_event_error",
                        serde_json::json!({ "error": e, "deviceId": did }),
                    );
                    // Log failed transaction
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let _ = db::ecr_insert_transaction(
                        &conn,
                        &serde_json::json!({
                            "id": tx_id,
                            "deviceId": did,
                            "orderId": order_id,
                            "transactionType": "sale",
                            "amount": amount_cents,
                            "currency": currency,
                            "status": "error",
                            "errorMessage": e,
                            "startedAt": started,
                            "completedAt": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                    return Ok(serde_json::json!({
                        "success": false,
                        "error": e,
                        "options": options
                    }));
                }
            }
        }
    }

    let error = resolved_device_id
        .as_ref()
        .map(|did| format!("ECR device '{did}' is not connected"))
        .unwrap_or_else(|| "No ECR device connected".to_string());
    let _ = app.emit(
        "ecr_event_error",
        serde_json::json!({ "error": error, "deviceId": resolved_device_id }),
    );
    Ok(serde_json::json!({
        "success": false,
        "error": error,
        "options": options
    }))
}

#[tauri::command]
pub async fn ecr_process_refund(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_amount_and_options_payload(arg0, arg1);
    let amount = parsed.amount;
    let amount_cents = validate_ecr_amount(amount)?;
    let options = parsed.options;
    let device_id = options
        .get("deviceId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let order_id = options
        .get("orderId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let original_tx_id = options
        .get("originalTransactionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let currency = options
        .get("currency")
        .and_then(|v| v.as_str())
        .unwrap_or("EUR")
        .to_string();

    let _ = app.emit(
        "ecr_event_transaction_started",
        serde_json::json!({ "type": "refund", "amount": amount }),
    );

    let tx_id = format!("txn-{}", uuid::Uuid::new_v4());
    let started = chrono::Utc::now().to_rfc3339();

    let resolved_device_id = if let Some(ref did) = device_id {
        Some(did.clone())
    } else {
        mgr.connected_device_ids().into_iter().next()
    };

    if let Some(ref did) = resolved_device_id {
        if mgr.is_connected(did) {
            let request = ecr::protocol::TransactionRequest {
                transaction_id: tx_id.clone(),
                transaction_type: ecr::protocol::TransactionType::Refund,
                amount: amount_cents,
                currency: currency.clone(),
                order_id: order_id.clone(),
                tip_amount: None,
                original_transaction_id: original_tx_id,
                fiscal_data: None,
            };
            match mgr.process_transaction_offloaded(did, request).await {
                Ok(resp) => {
                    let status_str = format!("{:?}", resp.status).to_lowercase();
                    let transaction = serde_json::json!({
                        "id": resp.transaction_id,
                        "amount": amount,
                        "status": status_str,
                        "authorizationCode": resp.authorization_code,
                        "terminalReference": resp.terminal_reference,
                        "errorMessage": resp.error_message,
                    });
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let _ = db::ecr_insert_transaction(
                        &conn,
                        &serde_json::json!({
                            "id": resp.transaction_id,
                            "deviceId": did,
                            "orderId": order_id,
                            "transactionType": "refund",
                            "amount": amount_cents,
                            "currency": currency,
                            "status": status_str,
                            "authorizationCode": resp.authorization_code,
                            "terminalReference": resp.terminal_reference,
                            "errorMessage": resp.error_message,
                            "rawResponse": resp.raw_response,
                            "startedAt": resp.started_at,
                            "completedAt": resp.completed_at,
                        }),
                    );
                    let _ = app.emit("ecr_event_transaction_completed", transaction.clone());
                    return Ok(serde_json::json!({
                        "success": status_str == "approved",
                        "transaction": transaction,
                        "options": options
                    }));
                }
                Err(e) => {
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let _ = db::ecr_insert_transaction(
                        &conn,
                        &serde_json::json!({
                            "id": tx_id,
                            "deviceId": did,
                            "orderId": order_id,
                            "transactionType": "refund",
                            "amount": amount_cents,
                            "currency": currency,
                            "status": "error",
                            "errorMessage": e,
                            "startedAt": started,
                            "completedAt": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                    return Ok(serde_json::json!({
                        "success": false,
                        "error": e,
                        "options": options
                    }));
                }
            }
        }
    }

    let error = resolved_device_id
        .as_ref()
        .map(|did| format!("ECR device '{did}' is not connected"))
        .unwrap_or_else(|| "No ECR device connected".to_string());
    let _ = app.emit(
        "ecr_event_error",
        serde_json::json!({ "error": error, "deviceId": resolved_device_id }),
    );
    Ok(serde_json::json!({
        "success": false,
        "error": error,
        "options": options
    }))
}

#[tauri::command]
pub async fn ecr_void_transaction(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_void_transaction_payload(arg0, arg1)?;
    let txid = parsed.transaction_id;
    if txid.trim().is_empty() {
        let _ = app.emit(
            "ecr_event_error",
            serde_json::json!({ "error": "Missing transactionId" }),
        );
        return Err("Missing transactionId".into());
    }
    // If a device is specified and connected, try to void through protocol
    if let Some(ref did) = parsed.device_id {
        if mgr.is_connected(did) {
            let request = ecr::protocol::TransactionRequest {
                transaction_id: format!("void-{}", uuid::Uuid::new_v4()),
                transaction_type: ecr::protocol::TransactionType::Void,
                amount: 0,
                currency: "EUR".into(),
                order_id: None,
                tip_amount: None,
                original_transaction_id: Some(txid.clone()),
                fiscal_data: None,
            };
            if let Err(e) = mgr.process_transaction_offloaded(did, request).await {
                tracing::warn!("ECR void failed: {e}");
            }
        }
    }
    let _ = app.emit(
        "ecr_event_transaction_status",
        serde_json::json!({ "status": "voided", "transactionId": txid }),
    );
    Ok(serde_json::json!({
        "success": true,
        "transactionId": txid,
        "deviceId": parsed.device_id
    }))
}

#[tauri::command]
pub async fn ecr_cancel_transaction(
    arg0: Option<serde_json::Value>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let device_id = parse_optional_device_id(arg0);
    // If a device ID is provided and connected, attempt protocol-level cancel
    if let Some(ref did) = device_id {
        if mgr.is_connected(did) {
            // DeviceManager doesn't have a direct cancel yet; best-effort abort
            let _ = mgr.disconnect_device(did);
        }
    }
    let _ = app.emit(
        "ecr_event_transaction_status",
        serde_json::json!({ "status": "cancelled", "deviceId": device_id.clone() }),
    );
    Ok(serde_json::json!({
        "success": true,
        "deviceId": device_id,
        "cancelled": true
    }))
}

#[tauri::command]
pub async fn ecr_settlement(
    arg0: Option<serde_json::Value>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let device_id = parse_optional_device_id(arg0);
    let _ = app.emit(
        "ecr_event_display_message",
        serde_json::json!({ "message": "Settlement started", "deviceId": device_id.clone() }),
    );
    if let Some(ref did) = device_id {
        if mgr.is_connected(did) {
            match mgr.settlement_offloaded(did).await {
                Ok(result) => {
                    return Ok(serde_json::json!({
                        "success": result.success,
                        "deviceId": did,
                        "transactionCount": result.transaction_count,
                        "totalAmount": result.total_amount,
                        "zNumber": result.z_number,
                        "errorMessage": result.error_message,
                    }));
                }
                Err(e) => {
                    return Ok(serde_json::json!({
                        "success": false,
                        "deviceId": did,
                        "error": e
                    }));
                }
            }
        }
    }
    Ok(serde_json::json!({ "success": true, "deviceId": device_id }))
}

#[tauri::command]
pub async fn ecr_get_recent_transactions(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let limit = parse_recent_transactions_limit(arg0);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let transactions = db::ecr_list_transactions(&conn, None, Some(limit as u32));
    Ok(serde_json::json!({
        "success": true,
        "transactions": transactions
    }))
}

#[tauri::command]
pub async fn ecr_query_transactions(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let filters = parse_query_filters_payload(arg0);
    let device_id = filters
        .get("deviceId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let limit = filters.get("limit").and_then(|v| v.as_u64()).unwrap_or(100) as u32;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let transactions = db::ecr_list_transactions(&conn, device_id.as_deref(), Some(limit));
    Ok(serde_json::json!({
        "success": true,
        "transactions": transactions
    }))
}

#[tauri::command]
pub async fn ecr_get_transaction_stats(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let filters = parse_query_filters_payload(arg0);
    let device_filter = value_str(&filters, &["deviceId", "device_id"]);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let transactions = db::ecr_list_transactions(&conn, device_filter.as_deref(), None);
    let count = transactions.len();
    let total: i64 = transactions
        .iter()
        .filter_map(|t| t.get("amount").and_then(|v| v.as_i64()))
        .sum();
    Ok(serde_json::json!({
        "success": true,
        "count": count,
        "totalAmount": total
    }))
}

#[tauri::command]
pub async fn ecr_get_transaction_for_order(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    if let Some(order_id) = parse_optional_order_id(arg0) {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let all = db::ecr_list_transactions(&conn, None, None);
        let matched = all.into_iter().find(|t| {
            t.get("orderId")
                .and_then(|v| v.as_str())
                .map(|oid| oid == order_id)
                .unwrap_or(false)
        });
        return Ok(serde_json::json!({
            "success": true,
            "transaction": matched
        }));
    }
    Ok(serde_json::json!({
        "success": true,
        "transaction": serde_json::Value::Null
    }))
}

// -- ECR new commands --------------------------------------------------------

#[tauri::command]
pub async fn ecr_test_connection(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;

    // Load the connection config under the DB lock, then drop the guard
    // before the status inquiry below: it is synchronous device I/O (and
    // can queue behind an in-flight transaction on a connected device),
    // and the guard must not be held across the await (it is not `Send`).
    let (connection_type, connection_details, protocol_name, settings) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let device = db::ecr_get_device(&conn, &device_id)
            .ok_or_else(|| format!("Device {device_id} not found"))?;

        let connection_type = device
            .get("connectionType")
            .and_then(|v| v.as_str())
            .unwrap_or("serial_usb")
            .to_string();
        let connection_details = device
            .get("connectionDetails")
            .cloned()
            .unwrap_or(serde_json::json!({}));
        let protocol_name = device
            .get("protocol")
            .and_then(|v| v.as_str())
            .unwrap_or("generic")
            .to_string();
        let settings = device
            .get("settings")
            .cloned()
            .unwrap_or(serde_json::json!({}));

        (connection_type, connection_details, protocol_name, settings)
        // MutexGuard drops here; DB lock released.
    };

    match mgr
        .test_connection_offloaded(
            &device_id,
            &connection_type,
            &connection_details,
            &protocol_name,
            &settings,
        )
        .await
    {
        Ok(ok) => Ok(serde_json::json!({
            "success": true,
            "connected": ok
        })),
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "connected": false,
            "error": e
        })),
    }
}

#[tauri::command]
pub async fn ecr_test_print(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;

    // If connected, send a short test via raw bytes
    if mgr.is_connected(&device_id) {
        // Read the print mode under the DB lock, then drop the guard
        // before the printer write below: the guard must not be held
        // across the await (it is not `Send`).
        let print_mode = {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            let device = db::ecr_get_device(&conn, &device_id)
                .ok_or_else(|| format!("Device {device_id} not found"))?;
            device
                .get("printMode")
                .and_then(|v| v.as_str())
                .unwrap_or("register_prints")
                .to_string()
            // MutexGuard drops here; DB lock released.
        };

        if print_mode == "pos_sends_receipt" {
            // Build a simple ESC/POS test receipt
            let mut b = crate::escpos::EscPosBuilder::new();
            b.init();
            b.center();
            b.bold(true);
            b.text("=== TEST PRINT ===");
            b.bold(false);
            b.feed(1);
            b.text("Cash Register Test OK");
            b.feed(1);
            let now = chrono::Local::now().format("%d/%m/%Y %H:%M").to_string();
            b.text(&now);
            b.feed(3);
            b.cut();
            let data = b.build();
            mgr.send_raw_offloaded(&device_id, data).await?;
        } else {
            // A fiscal cashier must print a real, non-closing test document.
            // The old path sent a Datecs status frame to every protocol,
            // ignored errors, and then falsely reported "printed".
            mgr.x_report_offloaded(&device_id).await?;
        }

        return Ok(serde_json::json!({ "success": true, "printed": true }));
    }

    Ok(serde_json::json!({
        "success": false,
        "error": "Device not connected"
    }))
}

fn find_approved_fiscal_transaction(
    conn: &rusqlite::Connection,
    order_reference: &str,
) -> Result<Option<serde_json::Value>, String> {
    let persisted = conn
        .query_row(
            "SELECT id, device_id, authorization_code, terminal_reference,
                fiscal_receipt_number, card_type, card_last_four, entry_method,
                receipt_data
         FROM ecr_transactions
         WHERE order_id = ?1
           AND transaction_type = 'fiscal_receipt'
           AND status = 'approved'
         ORDER BY created_at DESC
         LIMIT 1",
            rusqlite::params![order_reference],
            |row| {
                let receipt_data = row
                    .get::<_, Option<String>>(8)?
                    .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok());
                Ok(serde_json::json!({
                    "transactionId": row.get::<_, String>(0)?,
                    "deviceId": row.get::<_, String>(1)?,
                    "authorizationCode": row.get::<_, Option<String>>(2)?,
                    "terminalReference": row.get::<_, Option<String>>(3)?,
                    "fiscalReceiptNumber": row.get::<_, Option<String>>(4)?,
                    "cardType": row.get::<_, Option<String>>(5)?,
                    "cardLastFour": row.get::<_, Option<String>>(6)?,
                    "entryMethod": row.get::<_, Option<String>>(7)?,
                    "intendedMethod": receipt_data
                        .as_ref()
                        .and_then(|value| value.get("intendedMethod"))
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                }))
            },
        )
        .optional()
        .map_err(|e| format!("find approved fiscal transaction: {e}"))?;
    if persisted.is_some() {
        return Ok(persisted);
    }

    // If the fiscal device committed but the relational ECR audit INSERT
    // failed, the checkout stores a minimal recovery marker in local_settings.
    // Consult it before contacting hardware again so a retry cannot issue a
    // duplicate fiscal receipt.
    let orphan = db::get_setting(conn, "ecr_orphaned_receipts", order_reference)
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(|value| value.get("status").and_then(|status| status.as_str()) == Some("approved"))
        .map(|value| {
            serde_json::json!({
                "transactionId": value.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "deviceId": value.get("deviceId").cloned().unwrap_or(serde_json::Value::Null),
                "authorizationCode": value.get("authorizationCode").cloned().unwrap_or(serde_json::Value::Null),
                "terminalReference": value.get("terminalReference").cloned().unwrap_or(serde_json::Value::Null),
                "fiscalReceiptNumber": value.get("fiscalReceiptNumber").cloned().unwrap_or(serde_json::Value::Null),
                "cardType": value.get("cardType").cloned().unwrap_or(serde_json::Value::Null),
                "cardLastFour": value.get("cardLastFour").cloned().unwrap_or(serde_json::Value::Null),
                "entryMethod": value.get("entryMethod").cloned().unwrap_or(serde_json::Value::Null),
                "intendedMethod": value
                    .get("receiptData")
                    .and_then(|data| data.get("intendedMethod"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                "orphanedLocally": true,
            })
        });
    Ok(orphan)
}

fn find_ambiguous_fiscal_transaction(
    conn: &rusqlite::Connection,
    order_reference: &str,
) -> Result<Option<serde_json::Value>, String> {
    conn.query_row(
        "SELECT id, device_id, status, terminal_reference, error_message, raw_response
         FROM ecr_transactions
         WHERE order_id = ?1
           AND transaction_type = 'fiscal_receipt'
           AND status IN ('pending', 'processing', 'timeout')
         ORDER BY created_at DESC
         LIMIT 1",
        rusqlite::params![order_reference],
        |row| {
            let raw: Option<String> = row.get(5)?;
            Ok(serde_json::json!({
                "transactionId": row.get::<_, String>(0)?,
                "deviceId": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "terminalReference": row.get::<_, Option<String>>(3)?,
                "errorMessage": row.get::<_, Option<String>>(4)?,
                "rawResponse": raw.and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok()),
            }))
        },
    )
    .optional()
    .map_err(|error| format!("find ambiguous fiscal transaction: {error}"))
}

fn find_definite_failed_fiscal_transaction(
    conn: &rusqlite::Connection,
    order_reference: &str,
) -> Result<Option<serde_json::Value>, String> {
    conn.query_row(
        "SELECT id, device_id, status, error_message, receipt_data
         FROM ecr_transactions
         WHERE order_id = ?1
           AND transaction_type = 'fiscal_receipt'
           AND status IN ('declined', 'error', 'cancelled')
         ORDER BY created_at DESC
         LIMIT 1",
        rusqlite::params![order_reference],
        |row| {
            let receipt_data = row
                .get::<_, Option<String>>(4)?
                .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok());
            Ok(serde_json::json!({
                "transactionId": row.get::<_, String>(0)?,
                "deviceId": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "errorMessage": row.get::<_, Option<String>>(3)?,
                "intendedMethod": receipt_data
                    .as_ref()
                    .and_then(|value| value.get("intendedMethod"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            }))
        },
    )
    .optional()
    .map_err(|error| format!("find definite failed fiscal transaction: {error}"))
}

fn outstanding_definite_failure_retry_response(
    transaction: serde_json::Value,
) -> serde_json::Value {
    let error = transaction
        .get("errorMessage")
        .cloned()
        .filter(|value| !value.is_null())
        .unwrap_or_else(|| serde_json::json!("The prior fiscal attempt was not approved"));
    serde_json::json!({
        "success": false,
        "approved": false,
        "deduplicated": true,
        "requiresReconciliation": false,
        "error": error,
        "transaction": transaction,
    })
}

fn validate_existing_outstanding_approval(
    existing: &serde_json::Value,
    intended_method: &str,
    prior_completed_payments: &[serde_json::Value],
) -> Result<(), String> {
    let approved_method = existing
        .get("intendedMethod")
        .and_then(|value| value.as_str());
    let method_matches = approved_method == Some(intended_method);
    let ledger_already_contains_approval = existing
        .get("transactionId")
        .and_then(|value| value.as_str())
        .is_some_and(|transaction_id| {
            prior_completed_payments.iter().any(|payment| {
                payment.get("status").and_then(|value| value.as_str()) == Some("completed")
                    && payment
                        .get("transactionRef")
                        .and_then(|value| value.as_str())
                        == Some(transaction_id)
            })
        });
    if method_matches && !ledger_already_contains_approval {
        Ok(())
    } else {
        Err(
            "A prior outstanding fiscal approval does not match this collection. Reconcile it before retrying."
                .to_string(),
        )
    }
}

fn outstanding_approval_retry_response(
    existing: &serde_json::Value,
    intended_method: &str,
    prior_completed_payments: &[serde_json::Value],
) -> serde_json::Value {
    match validate_existing_outstanding_approval(
        existing,
        intended_method,
        prior_completed_payments,
    ) {
        Ok(()) => serde_json::json!({
            "success": true,
            "approved": true,
            "deduplicated": true,
            "orphanedLocally": existing
                .get("orphanedLocally")
                .cloned()
                .unwrap_or_else(|| serde_json::json!(false)),
            "transaction": existing,
        }),
        Err(error) => serde_json::json!({
            "success": false,
            "approved": false,
            "requiresReconciliation": true,
            "error": error,
            "transaction": existing,
        }),
    }
}

fn outstanding_fiscal_build_failure(error: String) -> serde_json::Value {
    serde_json::json!({
        "success": false,
        "approved": false,
        "requiresReconciliation": true,
        "error": error,
    })
}

fn find_unreconciled_outstanding_fiscal_attempt(
    conn: &rusqlite::Connection,
    order_id: &str,
    completed_payments: &[serde_json::Value],
    current_reference: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let reference_prefix = format!("{order_id}:collect-outstanding:");
    let completed_refs: std::collections::HashSet<&str> = completed_payments
        .iter()
        .filter(|payment| {
            payment.get("status").and_then(|value| value.as_str()) == Some("completed")
        })
        .filter_map(|payment| {
            payment
                .get("transactionRef")
                .and_then(|value| value.as_str())
        })
        .collect();
    let mut stmt = conn
        .prepare(
            "SELECT id, order_id, status, error_message, raw_response, receipt_data
             FROM ecr_transactions
             WHERE substr(order_id, 1, length(?1)) = ?1
               AND transaction_type = 'fiscal_receipt'
               AND status IN ('approved', 'pending', 'processing', 'timeout')
             ORDER BY created_at DESC",
        )
        .map_err(|error| format!("prepare outstanding fiscal reconciliation guard: {error}"))?;
    let candidates = stmt
        .query_map(rusqlite::params![reference_prefix], |row| {
            let raw_response = row
                .get::<_, Option<String>>(4)?
                .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok());
            let receipt_data = row
                .get::<_, Option<String>>(5)?
                .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok());
            Ok(serde_json::json!({
                "transactionId": row.get::<_, String>(0)?,
                "orderReference": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "errorMessage": row.get::<_, Option<String>>(3)?,
                "rawResponse": raw_response,
                "intendedMethod": receipt_data
                    .as_ref()
                    .and_then(|value| value.get("intendedMethod"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            }))
        })
        .map_err(|error| format!("query outstanding fiscal reconciliation guard: {error}"))?;
    let mut exact_retry_candidate: Option<serde_json::Value> = None;
    for candidate in candidates {
        let candidate = candidate
            .map_err(|error| format!("read outstanding fiscal reconciliation guard: {error}"))?;
        let transaction_id = candidate
            .get("transactionId")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if completed_refs.contains(transaction_id) {
            continue;
        }
        let is_exact_retry = current_reference.is_some_and(|reference| {
            candidate
                .get("orderReference")
                .and_then(|value| value.as_str())
                == Some(reference)
        });
        if is_exact_retry {
            if let Some(existing) = exact_retry_candidate.as_ref() {
                let existing_id = existing
                    .get("transactionId")
                    .and_then(|value| value.as_str());
                let candidate_id = candidate
                    .get("transactionId")
                    .and_then(|value| value.as_str());
                if existing_id != candidate_id {
                    let mut conflict = candidate;
                    conflict["multipleUnreconciledAttempts"] = serde_json::json!(true);
                    return Ok(Some(conflict));
                }
            } else {
                exact_retry_candidate = Some(candidate);
            }
        } else {
            // Any other unreconciled generation/attempt wins over an exact
            // retry candidate. Otherwise a newer exact row could hide an
            // older approved receipt and allow a second hardware charge.
            return Ok(Some(candidate));
        }
    }

    let mut orphan_stmt = conn
        .prepare(
            "SELECT setting_key, setting_value
             FROM local_settings
             WHERE setting_category = 'ecr_orphaned_receipts'
               AND substr(setting_key, 1, length(?1)) = ?1
             ORDER BY updated_at DESC",
        )
        .map_err(|error| format!("prepare outstanding orphan reconciliation guard: {error}"))?;
    let orphans = orphan_stmt
        .query_map(rusqlite::params![reference_prefix], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("query outstanding orphan reconciliation guard: {error}"))?;
    for orphan in orphans {
        let (reference, raw) =
            orphan.map_err(|error| format!("read outstanding orphan guard: {error}"))?;
        let value = serde_json::from_str::<serde_json::Value>(&raw).unwrap_or_default();
        let transaction_id = value
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if completed_refs.contains(transaction_id) {
            continue;
        }
        let candidate = serde_json::json!({
            "transactionId": transaction_id,
            "orderReference": reference,
            "status": value.get("status").cloned().unwrap_or_else(|| serde_json::json!("approved")),
            "intendedMethod": value
                .get("receiptData")
                .and_then(|data| data.get("intendedMethod"))
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            "orphanedLocally": true,
        });
        if current_reference == Some(reference.as_str()) {
            if let Some(existing) = exact_retry_candidate.as_ref() {
                let existing_id = existing
                    .get("transactionId")
                    .and_then(|value| value.as_str());
                let candidate_id = candidate
                    .get("transactionId")
                    .and_then(|value| value.as_str());
                if existing_id != candidate_id {
                    let mut conflict = candidate;
                    conflict["multipleUnreconciledAttempts"] = serde_json::json!(true);
                    return Ok(Some(conflict));
                }
            } else {
                exact_retry_candidate = Some(candidate);
            }
        } else {
            return Ok(Some(candidate));
        }
    }
    Ok(exact_retry_candidate)
}

fn outstanding_fiscal_transaction_id(order_reference: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"the-small/outstanding-fiscal-attempt/v1\0");
    digest.update(order_reference.as_bytes());
    let bytes: [u8; 32] = digest.finalize().into();
    format!(
        "fiscal-outstanding-{}",
        crate::payments::settlement_generation_token(&bytes)
    )
}

fn outstanding_fiscal_payload_fingerprint(order: &serde_json::Value) -> Result<[u8; 32], String> {
    let items = order
        .get("items")
        .and_then(serde_json::Value::as_array)
        .ok_or("Order has no fiscal items array")?;
    let total = order
        .get("total_amount")
        .or_else(|| order.get("totalAmount"))
        .or_else(|| order.get("total"))
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or("Order has no finite fiscal total")?;
    let mut canonical_items = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let name = ["name", "name_en", "product_name", "title"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("Fiscal item {index} has no name"))?;
        let quantity = ["quantity", "qty"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_f64))
            .filter(|value| value.is_finite() && *value > 0.0)
            .ok_or_else(|| format!("Fiscal item {index} has no valid quantity"))?;
        let price = ["price", "unitPrice", "unit_price"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_f64))
            .or_else(|| {
                ["totalPrice", "total_price"]
                    .into_iter()
                    .find_map(|key| item.get(key).and_then(serde_json::Value::as_f64))
                    .map(|value| value / quantity)
            })
            .filter(|value| value.is_finite() && *value > 0.0)
            .ok_or_else(|| format!("Fiscal item {index} has no valid price"))?;
        let tax_rate = item
            .get("taxRate")
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite());
        let discount = ["discount", "discountAmount"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_f64))
            .filter(|value| value.is_finite() && *value >= 0.0);
        canonical_items.push(serde_json::json!({
            "name": name,
            "quantity": quantity,
            "priceCents": crate::money::Cents::round_half_even(price).as_i64(),
            "taxRate": tax_rate,
            "discountCents": discount
                .map(|value| crate::money::Cents::round_half_even(value).as_i64()),
        }));
    }
    let encoded = serde_json::to_vec(&serde_json::json!({
        "items": canonical_items,
        "totalCents": crate::money::Cents::round_half_even(total).as_i64(),
    }))
    .map_err(|error| format!("encode outstanding fiscal order inputs: {error}"))?;
    let mut digest = Sha256::new();
    digest.update(b"the-small/outstanding-fiscal-order/v1\0");
    digest.update(encoded);
    Ok(digest.finalize().into())
}

fn fiscal_receipt_data_fingerprint(
    data: &ecr::protocol::FiscalReceiptData,
) -> Result<[u8; 32], String> {
    let encoded = serde_json::to_vec(data)
        .map_err(|error| format!("encode outstanding fiscal payload: {error}"))?;
    let mut digest = Sha256::new();
    digest.update(b"the-small/outstanding-fiscal-receipt/v1\0");
    digest.update(encoded);
    Ok(digest.finalize().into())
}

fn completed_payment_fingerprint(
    completed_payments: &[serde_json::Value],
) -> Result<[u8; 32], String> {
    let normalized: Vec<serde_json::Value> = completed_payments
        .iter()
        .filter(|payment| {
            payment.get("status").and_then(serde_json::Value::as_str) == Some("completed")
        })
        .map(|payment| {
            serde_json::json!({
                "id": payment.get("id"),
                "method": payment.get("method"),
                "amount": payment.get("amount"),
                "transactionRef": payment.get("transactionRef"),
                "paymentOrigin": payment.get("paymentOrigin"),
                "refundedAmount": payment.get("refundedAmount"),
                "remainingRefundable": payment.get("remainingRefundable"),
            })
        })
        .collect();
    let encoded = serde_json::to_vec(&normalized)
        .map_err(|error| format!("encode outstanding payment generation: {error}"))?;
    let mut digest = Sha256::new();
    digest.update(b"the-small/outstanding-payment-generation/v1\0");
    digest.update(encoded);
    Ok(digest.finalize().into())
}

fn load_authoritative_outstanding_fiscal_order(
    conn: &rusqlite::Connection,
    order_id: &str,
) -> Result<serde_json::Value, String> {
    conn.query_row(
        "SELECT items,
                COALESCE(total_amount_cents, CAST(ROUND(total_amount * 100) AS INTEGER), 0)
         FROM orders WHERE id = ?1",
        rusqlite::params![order_id],
        |row| {
            let items_raw: String = row.get(0)?;
            let items = serde_json::from_str::<serde_json::Value>(&items_raw)
                .unwrap_or_else(|_| serde_json::json!([]));
            let total_cents: i64 = row.get(1)?;
            Ok(serde_json::json!({
                "items": items,
                "totalAmount": crate::money::Cents::new(total_cents).to_f64_dp2(),
            }))
        },
    )
    .map_err(|error| format!("load authoritative outstanding fiscal order: {error}"))
}

fn verify_authoritative_outstanding_fiscal_payload(
    conn: &rusqlite::Connection,
    order_id: &str,
    expected_order_fingerprint: &[u8; 32],
    expected_fiscal: &ecr::protocol::FiscalReceiptData,
    expected_completed_payments: &[serde_json::Value],
    intended_payment: &serde_json::Value,
    tax_rates: &[ecr::protocol::TaxRateConfig],
    operator_id: Option<&str>,
) -> Result<(), String> {
    let current_order = load_authoritative_outstanding_fiscal_order(conn, order_id)?;
    if &outstanding_fiscal_payload_fingerprint(&current_order)? != expected_order_fingerprint {
        return Err(
            "Outstanding fiscal payload changed before reservation; refresh and retry".to_string(),
        );
    }
    let current_settlement = crate::payments::load_order_settlement_snapshot(conn, order_id)?;
    if completed_payment_fingerprint(&current_settlement.completed_payments)?
        != completed_payment_fingerprint(expected_completed_payments)?
    {
        return Err(
            "Outstanding payment ledger changed before fiscal reservation; refresh and retry"
                .to_string(),
        );
    }
    let current_fiscal = ecr::fiscal::build_fiscal_data_for_outstanding_checkout(
        &current_order,
        &current_settlement.completed_payments,
        intended_payment,
        tax_rates,
        operator_id,
    )
    .map_err(|error| format!("Outstanding fiscal payload changed: {error}"))?;
    if fiscal_receipt_data_fingerprint(&current_fiscal)?
        != fiscal_receipt_data_fingerprint(expected_fiscal)?
    {
        return Err(
            "Outstanding fiscal payload changed before reservation; refresh and retry".to_string(),
        );
    }
    Ok(())
}

fn reject_existing_unresolved_outstanding_attempt(
    conn: &rusqlite::Connection,
    attempt: &serde_json::Value,
) -> Result<(), String> {
    let attempt_id = attempt
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("Outstanding fiscal attempt has no durable identity")?;
    let order_reference = attempt
        .get("orderId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("Outstanding fiscal attempt has no order reference")?;
    let (order_id, generation) = order_reference
        .split_once(":collect-outstanding:")
        .ok_or("Outstanding fiscal attempt has an invalid order reference")?;
    if order_id.is_empty() || generation.is_empty() {
        return Err("Outstanding fiscal attempt has an invalid order reference".to_string());
    }
    let reference_prefix = format!("{order_id}:collect-outstanding:");
    let existing_attempt_id = conn
        .query_row(
            "SELECT et.id
             FROM ecr_transactions et
             WHERE et.transaction_type = 'fiscal_receipt'
               AND et.status IN ('processing', 'timeout', 'approved', 'approved_persisting')
               AND substr(et.order_id, 1, length(?1)) = ?1
               AND NOT EXISTS (
                 SELECT 1 FROM order_payments represented
                 WHERE represented.order_id = ?2
                   AND represented.status = 'completed'
                   AND represented.transaction_ref = et.id
                   AND represented.idempotency_key = et.id
               )
             ORDER BY et.created_at ASC, et.id ASC
             LIMIT 1",
            rusqlite::params![reference_prefix, order_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("inspect unresolved outstanding fiscal attempt: {error}"))?;

    if existing_attempt_id.is_some() {
        let same_attempt = existing_attempt_id.as_deref() == Some(attempt_id);
        return Err(if same_attempt {
            "An unresolved outstanding fiscal attempt already exists for this request; reconciliation is required before retrying"
                .to_string()
        } else {
            "An unresolved outstanding fiscal attempt already exists for this order; reconciliation is required before another device request"
                .to_string()
        });
    }
    Ok(())
}

async fn dispatch_after_durable_outstanding_attempt<T, Verify, Dispatch, DispatchFuture>(
    db: &db::DbState,
    attempt: &serde_json::Value,
    verify: Verify,
    dispatch: Dispatch,
) -> Result<T, String>
where
    Verify: FnOnce(&rusqlite::Connection) -> Result<(), String>,
    Dispatch: FnOnce() -> DispatchFuture,
    DispatchFuture: std::future::Future<Output = T>,
{
    {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        db::with_full_sync(&conn, |conn| {
            conn.execute_batch("BEGIN IMMEDIATE")
                .map_err(|error| format!("begin durable outstanding attempt: {error}"))?;
            let result = reject_existing_unresolved_outstanding_attempt(conn, attempt)
                .and_then(|()| verify(conn))
                .and_then(|()| db::ecr_insert_transaction(conn, attempt));
            match result {
                Ok(()) => conn
                    .execute_batch("COMMIT")
                    .map_err(|error| format!("commit durable outstanding attempt: {error}")),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        })
        .map_err(|error| format!("persist outstanding fiscal attempt: {error}"))?;
    }
    Ok(dispatch().await)
}

fn persist_outstanding_attempt_outcome(
    db: &db::DbState,
    transaction: &serde_json::Value,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    db::with_full_sync(&conn, |conn| {
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| format!("begin outstanding outcome: {error}"))?;
        match db::ecr_update_transaction_outcome(conn, transaction) {
            Ok(()) => conn
                .execute_batch("COMMIT")
                .map_err(|error| format!("commit outstanding outcome: {error}")),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

/// Execute the fiscal cashier transaction before a payment is persisted.
///
/// A card payment is therefore only recorded after the cashier's protocol
/// returns `Approved` (which, for an integrated ECR driver, is after its paired
/// EFT POS approves and the fiscal receipt is committed). The stable
/// `order_reference` makes retries idempotent when the device succeeded but
/// local order persistence was interrupted.
pub(crate) async fn fiscal_checkout_for_order_payload(
    db: &db::DbState,
    mgr: &ecr::DeviceManager,
    order_reference: &str,
    order: &serde_json::Value,
    intended_payment: &serde_json::Value,
    prior_completed_payments: Option<&[serde_json::Value]>,
) -> Result<serde_json::Value, String> {
    let intended_method = intended_payment
        .get("method")
        .or_else(|| intended_payment.get("paymentMethod"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if let Some(prior) = prior_completed_payments {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let order_id = order_reference
            .split_once(":collect-outstanding:")
            .map(|(order_id, _)| order_id)
            .unwrap_or(order_reference);
        if let Some(transaction) = find_unreconciled_outstanding_fiscal_attempt(
            &conn,
            order_id,
            prior,
            Some(order_reference),
        )? {
            let is_exact_retry = transaction
                .get("orderReference")
                .and_then(|value| value.as_str())
                == Some(order_reference);
            let has_multiple_unreconciled_attempts = transaction
                .get("multipleUnreconciledAttempts")
                .and_then(|value| value.as_bool())
                == Some(true);
            if !is_exact_retry || has_multiple_unreconciled_attempts {
                return Ok(serde_json::json!({
                    "success": false,
                    "approved": false,
                    "requiresReconciliation": true,
                    "error": "A previous outstanding fiscal collection is not reconciled. Reconcile it before starting another payment.",
                    "transaction": transaction,
                }));
            }
            if transaction
                .get("orphanedLocally")
                .and_then(|value| value.as_bool())
                == Some(true)
            {
                // The cashier already approved this exact attempt, but its
                // ECR audit-row insert failed. Reuse the durable orphan marker
                // as the approval result; contacting hardware again could
                // issue a second receipt/charge.
                return Ok(outstanding_approval_retry_response(
                    &transaction,
                    intended_method.as_str(),
                    prior,
                ));
            }
        }
    }
    let (device, existing_approval, existing_ambiguous, existing_definite_failure) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let device = db::ecr_get_default_device(&conn, Some("cash_register"));
        let existing = find_approved_fiscal_transaction(&conn, order_reference)?;
        let ambiguous = find_ambiguous_fiscal_transaction(&conn, order_reference)?;
        let definite_failure = if prior_completed_payments.is_some() {
            find_definite_failed_fiscal_transaction(&conn, order_reference)?
        } else {
            None
        };
        (device, existing, ambiguous, definite_failure)
    };

    if let Some(existing) = existing_approval {
        if let Some(prior) = prior_completed_payments {
            return Ok(outstanding_approval_retry_response(
                &existing,
                intended_method.as_str(),
                prior,
            ));
        }
        return Ok(serde_json::json!({
            "success": true,
            "approved": true,
            "deduplicated": true,
            "transaction": existing,
        }));
    }

    if let Some(existing) = existing_ambiguous {
        return Ok(serde_json::json!({
            "success": false,
            "approved": false,
            "requiresReconciliation": true,
            "error": "A previous fiscal attempt has an unknown result. Check the cashier/CAP Driver log before retrying.",
            "transaction": existing,
        }));
    }

    if let Some(existing) = existing_definite_failure {
        return Ok(outstanding_definite_failure_retry_response(existing));
    }

    let Some(device) = device else {
        return Ok(serde_json::json!({
            "success": true,
            "approved": true,
            "skipped": true,
        }));
    };

    let device_id = device
        .get("id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or("Fiscal device has no id")?
        .to_string();
    let print_mode = device
        .get("printMode")
        .and_then(|value| value.as_str())
        .unwrap_or("register_prints");
    if print_mode != "register_prints" {
        return Ok(serde_json::json!({
            "success": false,
            "approved": false,
            "error": "Fiscal checkout requires register_prints mode and a verified fiscal protocol"
        }));
    }
    if !mgr.is_connected(&device_id) {
        return Ok(serde_json::json!({
            "success": false,
            "approved": false,
            "error": "Cash register not connected"
        }));
    }

    let tax_rates: Vec<ecr::protocol::TaxRateConfig> = serde_json::from_value(
        device
            .get("taxRates")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .unwrap_or_default();
    let operator_id = device.get("operatorId").and_then(|value| value.as_str());
    let fiscal_data = match prior_completed_payments {
        Some(completed) => match ecr::fiscal::build_fiscal_data_for_outstanding_checkout(
            order,
            completed,
            intended_payment,
            &tax_rates,
            operator_id,
        ) {
            Ok(data) => data,
            Err(error) => return Ok(outstanding_fiscal_build_failure(error)),
        },
        None => ecr::fiscal::build_fiscal_data_for_checkout(
            order,
            intended_payment,
            &tax_rates,
            operator_id,
        )?,
    };
    let amount = fiscal_data
        .payments
        .iter()
        .map(|payment| payment.amount)
        .sum();
    let outstanding_collection = prior_completed_payments.is_some();
    let tx_id = if outstanding_collection {
        outstanding_fiscal_transaction_id(order_reference)
    } else {
        format!("fiscal-{}", uuid::Uuid::new_v4())
    };
    let started = chrono::Utc::now().to_rfc3339();
    let expected_fiscal_data = fiscal_data.clone();
    let request = ecr::protocol::TransactionRequest {
        transaction_id: tx_id.clone(),
        transaction_type: ecr::protocol::TransactionType::FiscalReceipt,
        amount,
        currency: "EUR".into(),
        order_id: Some(order_reference.to_string()),
        tip_amount: None,
        original_transaction_id: None,
        fiscal_data: Some(fiscal_data),
    };

    let device_result = if let Some(expected_completed_payments) = prior_completed_payments {
        let order_id = order_reference
            .split_once(":collect-outstanding:")
            .map(|(order_id, _)| order_id)
            .unwrap_or(order_reference);
        let fiscal_fingerprint = fiscal_receipt_data_fingerprint(&expected_fiscal_data)?;
        let order_fingerprint = outstanding_fiscal_payload_fingerprint(order)?;
        let processing_attempt = serde_json::json!({
            "id": tx_id.clone(),
            "deviceId": device_id.clone(),
            "orderId": order_reference,
            "transactionType": "fiscal_receipt",
            "amount": amount,
            "currency": "EUR",
            "status": "processing",
            "receiptData": {
                "intendedMethod": intended_method.clone(),
                "fiscalPayloadFingerprint": crate::payments::settlement_generation_token(
                    &fiscal_fingerprint,
                ),
            },
            "startedAt": started.clone(),
        });
        dispatch_after_durable_outstanding_attempt(
            db,
            &processing_attempt,
            |conn| {
                verify_authoritative_outstanding_fiscal_payload(
                    conn,
                    order_id,
                    &order_fingerprint,
                    &expected_fiscal_data,
                    expected_completed_payments,
                    intended_payment,
                    &tax_rates,
                    operator_id,
                )
            },
            || mgr.process_transaction_offloaded(&device_id, request),
        )
        .await
    } else {
        Ok(mgr.process_transaction_offloaded(&device_id, request).await)
    };

    let response = match device_result {
        Err(error) => {
            let changed = error.to_ascii_lowercase().contains("changed");
            tracing::warn!(
                target: "ecr.outstanding_reservation",
                order_reference = %order_reference,
                error = %error,
                "Outstanding fiscal collection was not dispatched"
            );
            return Ok(serde_json::json!({
                "success": false,
                "approved": false,
                "errorCode": if changed { "FISCAL_PAYLOAD_CHANGED" } else { "FISCAL_ATTEMPT_NOT_DURABLE" },
                "requiresReconciliation": !changed,
                "error": if changed {
                    "The order changed before fiscal collection was reserved. Refresh the payment details before retrying.".to_string()
                } else {
                    "The fiscal collection could not be durably reserved, so no device request was sent. Reconcile any existing attempt before retrying.".to_string()
                },
            }));
        }
        Ok(Ok(response)) => response,
        Ok(Err(error)) if outstanding_collection => {
            let error_text = error.to_string();
            let timeout_outcome = serde_json::json!({
                "id": tx_id.clone(),
                "status": "timeout",
                "receiptData": { "intendedMethod": intended_method.clone() },
                "errorMessage": error_text.clone(),
                "rawResponse": { "requiresReconciliation": true },
                "completedAt": chrono::Utc::now().to_rfc3339(),
            });
            let persistence_error = persist_outstanding_attempt_outcome(db, &timeout_outcome).err();
            if let Some(persistence_error) = persistence_error.as_deref() {
                tracing::error!(
                    target: "ecr.outstanding_reconciliation",
                    order_reference = %order_reference,
                    transaction_id = %timeout_outcome["id"],
                    error = %persistence_error,
                    "Failed to persist the ambiguous fiscal outcome; durable processing row remains blocking"
                );
            }
            return Ok(serde_json::json!({
                "success": false,
                "approved": false,
                "requiresReconciliation": true,
                "error": "The fiscal device result is unknown. Check the cashier/CAP Driver log before retrying.",
                "transaction": {
                    "transactionId": timeout_outcome["id"],
                    "status": "timeout",
                },
            }));
        }
        Ok(Err(error)) => {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            let _ = db::ecr_insert_transaction(
                &conn,
                &serde_json::json!({
                    "id": tx_id,
                    "deviceId": device_id,
                    "orderId": order_reference,
                    "transactionType": "fiscal_receipt",
                    "amount": amount,
                    "currency": "EUR",
                    "status": "error",
                    "errorMessage": error,
                    "startedAt": started,
                    "completedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            return Ok(serde_json::json!({
                "success": false,
                "approved": false,
                "error": error
            }));
        }
    };

    if outstanding_collection && response.transaction_id != tx_id {
        let mismatch_outcome = serde_json::json!({
            "id": tx_id.clone(),
            "status": "timeout",
            "receiptData": { "intendedMethod": intended_method.clone() },
            "errorMessage": "Fiscal device returned a different transaction identity",
            "rawResponse": {
                "requiresReconciliation": true,
                "deviceTransactionId": response.transaction_id,
            },
            "completedAt": chrono::Utc::now().to_rfc3339(),
        });
        let _ = persist_outstanding_attempt_outcome(db, &mismatch_outcome);
        return Ok(serde_json::json!({
            "success": false,
            "approved": false,
            "requiresReconciliation": true,
            "error": "The fiscal device returned an unexpected transaction identity. Reconcile it before retrying.",
            "transaction": {
                "transactionId": mismatch_outcome["id"],
                "status": "timeout",
            },
        }));
    }

    let approved = response.status == ecr::protocol::TransactionStatus::Approved;
    let status = format!("{:?}", response.status).to_lowercase();
    let persisted_transaction_id = if outstanding_collection {
        tx_id.clone()
    } else {
        response.transaction_id.clone()
    };
    let transaction = serde_json::json!({
        "id": persisted_transaction_id,
        "deviceId": device_id,
        "orderId": order_reference,
        "transactionType": "fiscal_receipt",
        "amount": amount,
        "currency": "EUR",
        "status": status,
        "authorizationCode": response.authorization_code,
        "terminalReference": response.terminal_reference,
        "fiscalReceiptNumber": response.fiscal_receipt_number,
        "cardType": response.card_type,
        "cardLastFour": response.card_last_four,
        "entryMethod": response.entry_method,
        "receiptData": {
            "intendedMethod": intended_method.clone(),
        },
        "errorMessage": response.error_message,
        "rawResponse": response.raw_response,
        "startedAt": response.started_at,
        "completedAt": response.completed_at,
    });
    let persist_error = if outstanding_collection {
        persist_outstanding_attempt_outcome(db, &transaction).err()
    } else {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        match db::ecr_insert_transaction(&conn, &transaction) {
            Ok(()) => {
                let _ = db::delete_setting(&conn, "ecr_orphaned_receipts", order_reference);
                None
            }
            Err(error) => {
                if approved {
                    if let Err(marker_error) = db::set_setting(
                        &conn,
                        "ecr_orphaned_receipts",
                        order_reference,
                        &transaction.to_string(),
                    ) {
                        tracing::error!(
                            target: "ecr.orphaned_receipt",
                            order_reference = %order_reference,
                            transaction_id = %transaction["id"],
                            error = %marker_error,
                            "Failed to persist fiscal orphan recovery marker"
                        );
                    }
                }
                Some(error)
            }
        }
    };

    if !approved {
        if let Some(error) = persist_error.as_deref() {
            tracing::warn!(
                target: "ecr",
                order_reference = %order_reference,
                device_id = %device_id,
                transaction_id = %transaction["id"],
                error = %error,
                "Failed to persist declined fiscal transaction"
            );
        }
        return Ok(serde_json::json!({
            "success": false,
            "approved": false,
            "requiresReconciliation": persist_error.is_some()
                || transaction.get("status").and_then(serde_json::Value::as_str) == Some("timeout"),
            "error": transaction.get("errorMessage").cloned().unwrap_or_else(|| serde_json::json!("Payment was not approved")),
            "transaction": transaction,
        }));
    }

    if let Some(error) = persist_error.as_deref() {
        // The device has already committed the receipt. Treat the checkout as
        // approved so the order/payment can be recorded, but flag the missing
        // audit row. The payment's fiscal-* transaction reference is also
        // persisted and is used by ecr_fiscal_print as a duplicate guard.
        tracing::error!(
            target: "ecr.orphaned_receipt",
            order_reference = %order_reference,
            device_id = %device_id,
            transaction_id = %transaction["id"],
            fiscal_receipt_number = %transaction["fiscalReceiptNumber"],
            error = %error,
            "Fiscal receipt committed at device but local ECR transaction INSERT failed"
        );
    }

    Ok(serde_json::json!({
        "success": true,
        "approved": true,
        "orphanedLocally": persist_error.is_some(),
        "requiresReconciliation": persist_error.is_some(),
        "transaction": {
            "transactionId": transaction["id"],
            "deviceId": transaction["deviceId"],
            "authorizationCode": transaction["authorizationCode"],
            "terminalReference": transaction["terminalReference"],
            "fiscalReceiptNumber": transaction["fiscalReceiptNumber"],
            "cardType": transaction["cardType"],
            "cardLastFour": transaction["cardLastFour"],
            "entryMethod": transaction["entryMethod"],
        }
    }))
}

#[tauri::command]
pub async fn ecr_fiscal_print(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_required_order_id(arg0)?;

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let sandbox_order = conn
            .query_row(
                "SELECT integration_environment = 'sandbox' OR COALESCE(is_test, 0) = 1
                 FROM orders WHERE id = ?1",
                rusqlite::params![order_id],
                |row| row.get::<_, bool>(0),
            )
            .optional()
            .map_err(|e| format!("inspect sandbox order before fiscal print: {e}"))?
            .unwrap_or(false);
        if sandbox_order {
            return Ok(serde_json::json!({
                "success": true,
                "skipped": true,
                "reason": "sandbox_order"
            }));
        }
    }

    // Phase 1 — load device + order + payments under the DB lock.
    //
    // The inner block holds `db.conn` only for the duration of these fast
    // queries and drops it before the (potentially multi-second) device I/O
    // in Phase 3. Previously the lock was held across the entire function,
    // which froze every other SQLite write in the POS for the duration of
    // each fiscal print.
    let (device, client_request_id) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;

        let device = match db::ecr_get_default_device(&conn, Some("cash_register")) {
            Some(d) => d,
            None => {
                // No cash register configured — skip silently
                return Ok(serde_json::json!({ "success": true, "skipped": true }));
            }
        };

        // Check `enabled` before loading the order to avoid a spurious
        // "Order not found" on a disabled terminal.
        let enabled = device
            .get("enabled")
            .and_then(|v| v.as_bool())
            .or_else(|| {
                device
                    .get("enabled")
                    .and_then(|v| v.as_i64())
                    .map(|i| i != 0)
            })
            .unwrap_or(true);
        if !enabled {
            return Ok(serde_json::json!({ "success": true, "skipped": true }));
        }

        let client_request_id: Option<String> = conn
            .query_row(
                "SELECT client_request_id FROM orders WHERE id = ?1",
                rusqlite::params![order_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("load order client request id: {e}"))?
            .flatten();

        (device, client_request_id)
        // MutexGuard drops here; DB lock released.
    };

    // Orders and payments are normalized relational rows; neither table has a
    // `data` JSON column. Use the canonical readers after dropping the device
    // query lock. The old `SELECT data ...` path made every fiscal print report
    // "Order not found" on the production schema.
    let order = crate::sync::get_order_by_id(&db, &order_id)?;
    let payments_value = crate::payments::get_order_payments(&db, &order_id)?;
    let payments = payments_value.as_array().cloned().unwrap_or_default();

    // Phase 2 — derive config + build fiscal data (no DB access).
    let device_id = device
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Device has no id")?
        .to_string();

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let payment_has_fiscal_checkout_reference = payments.iter().any(|payment| {
            payment
                .get("transactionRef")
                .or_else(|| payment.get("transaction_ref"))
                .and_then(|value| value.as_str())
                .is_some_and(|value| value.starts_with("fiscal-"))
                && payment.get("status").and_then(|value| value.as_str()) == Some("completed")
        });
        let already_issued = payment_has_fiscal_checkout_reference
            || find_approved_fiscal_transaction(&conn, &order_id)?.is_some()
            || client_request_id
                .as_deref()
                .map(|reference| find_approved_fiscal_transaction(&conn, reference))
                .transpose()?
                .flatten()
                .is_some();
        if already_issued {
            return Ok(serde_json::json!({
                "success": true,
                "skipped": true,
                "alreadyIssued": true
            }));
        }
    }

    let tax_rates_json = device
        .get("taxRates")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    let tax_rates: Vec<ecr::protocol::TaxRateConfig> =
        serde_json::from_value(tax_rates_json).unwrap_or_default();

    let operator_id = device
        .get("operatorId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let print_mode = device
        .get("printMode")
        .and_then(|v| v.as_str())
        .unwrap_or("register_prints");

    let fiscal_data =
        ecr::fiscal::build_fiscal_data(&order, &payments, &tax_rates, operator_id.as_deref())?;

    if !mgr.is_connected(&device_id) {
        return Ok(serde_json::json!({
            "success": false,
            "error": "Cash register not connected"
        }));
    }

    // Phase 3 — dispatch to the fiscal device. NO DB lock held; this call
    // can block for seconds on slow serial/TCP printers.
    match print_mode {
        "pos_sends_receipt" => {
            // Enable CP737 (Greek) encoding when the device is configured for it.
            // Previously this was hardcoded to `false`, which sent UTF-8 multi-byte
            // Greek characters raw to the printer and produced mojibake on Greek-
            // market deployments. escpos::encode_cp737 passes ASCII through unchanged,
            // so opting in is safe for Greek content and lossless for ASCII.
            let greek_mode = device
                .get("greekMode")
                .and_then(|v| v.as_bool())
                .or_else(|| {
                    device
                        .get("greekMode")
                        .and_then(|v| v.as_i64())
                        .map(|i| i != 0)
                })
                .unwrap_or(false);
            let escpos_bytes = ecr::fiscal::format_fiscal_receipt_escpos(
                &fiscal_data,
                crate::escpos::PaperWidth::Mm80,
                greek_mode,
            );
            mgr.send_raw_offloaded(&device_id, escpos_bytes).await?;
        }
        _ => {
            // register_prints mode: send structured fiscal receipt via protocol.
            let tx_id = format!("fiscal-{}", uuid::Uuid::new_v4());
            let started = chrono::Utc::now().to_rfc3339();
            let request = ecr::protocol::TransactionRequest {
                transaction_id: tx_id.clone(),
                transaction_type: ecr::protocol::TransactionType::FiscalReceipt,
                amount: fiscal_data.payments.iter().map(|p| p.amount).sum(),
                currency: "EUR".into(),
                order_id: Some(order_id.clone()),
                tip_amount: None,
                original_transaction_id: None,
                fiscal_data: Some(fiscal_data),
            };

            // Capture before the request is moved into the offloaded call.
            let request_amount = request.amount;
            let device_result = mgr.process_transaction_offloaded(&device_id, request).await;

            // Phase 4 — persist result and enqueue remote fiscal receipt backfill.
            // Re-acquire DB lock; these writes are fast.
            match device_result {
                Ok(resp) => {
                    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let insert_payload = serde_json::json!({
                        "id": resp.transaction_id,
                        "deviceId": device_id,
                        "orderId": order_id,
                        "transactionType": "fiscal_receipt",
                        "amount": request_amount,
                        "currency": "EUR",
                        "status": format!("{:?}", resp.status).to_lowercase(),
                        "fiscalReceiptNumber": resp.fiscal_receipt_number,
                        "startedAt": resp.started_at,
                        "completedAt": resp.completed_at,
                        "rawResponse": resp.raw_response,
                    });
                    if let Err(insert_err) = persist_fiscal_receipt_transaction_and_enqueue_backfill(
                        &mut conn,
                        &insert_payload,
                        &order_id,
                        resp.fiscal_receipt_number.as_deref(),
                    ) {
                        // The device has ALREADY committed the fiscal receipt to its
                        // hardware fiscal memory. The local DB write failed — this is
                        // a reconciliation event. Log loudly so the diagnostics export
                        // captures it and an operator can manually reconcile. Surface
                        // the orphan flag to the caller so the UI can show a warning
                        // instead of silently treating the situation as normal success.
                        let fiscal_num =
                            resp.fiscal_receipt_number.as_deref().unwrap_or("<unknown>");
                        tracing::error!(
                            target: "ecr.orphaned_receipt",
                            order_id = %order_id,
                            device_id = %device_id,
                            transaction_id = %resp.transaction_id,
                            fiscal_receipt_number = %fiscal_num,
                            error = %insert_err,
                            "Fiscal receipt committed at device but local DB INSERT failed \u{2014} manual reconciliation required"
                        );
                        return Ok(serde_json::json!({
                            "success": true,
                            "orphanedLocally": true,
                            "fiscalReceiptNumber": fiscal_num,
                            "message": "Fiscal receipt issued by device but local DB write failed \u{2014} see ecr.orphaned_receipt logs for reconciliation"
                        }));
                    }
                }
                Err(e) => {
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let insert_payload = serde_json::json!({
                        "id": tx_id,
                        "deviceId": device_id,
                        "orderId": order_id,
                        "transactionType": "fiscal_receipt",
                        "amount": 0,
                        "currency": "EUR",
                        "status": "error",
                        "errorMessage": e,
                        "startedAt": started,
                        "completedAt": chrono::Utc::now().to_rfc3339(),
                    });
                    if let Err(insert_err) = db::ecr_insert_transaction(&conn, &insert_payload) {
                        tracing::warn!(
                            target: "ecr",
                            order_id = %order_id,
                            device_id = %device_id,
                            transaction_id = %tx_id,
                            error = %insert_err,
                            "Failed to record fiscal error transaction"
                        );
                    }
                    tracing::warn!("Fiscal print failed for order {order_id}: {e}");
                    return Ok(serde_json::json!({
                        "success": false,
                        "error": e
                    }));
                }
            }
        }
    }

    Ok(serde_json::json!({ "success": true }))
}

#[cfg(test)]
mod discovery_tests {
    use super::*;

    fn sample_configured_lookup() -> ConfiguredEcrLookup {
        configured_ecr_lookup_from_devices(&[serde_json::json!({
            "name": "Main Counter",
            "connectionType": "serial_usb",
            "connectionDetails": {
                "port": "COM3"
            }
        })])
    }

    #[test]
    fn resolve_requested_discovery_types_normalizes_and_defaults() {
        assert_eq!(
            resolve_requested_discovery_types(vec!["USB".into(), "bt".into(), "lan".into()]),
            vec![
                "serial_usb".to_string(),
                "bluetooth".to_string(),
                "network".to_string()
            ]
        );

        assert_eq!(
            resolve_requested_discovery_types(vec!["unknown".into()]),
            DEFAULT_DISCOVERY_TYPES
                .iter()
                .map(|value| (*value).to_string())
                .collect::<Vec<String>>()
        );
    }

    #[test]
    fn configured_lookup_matches_serial_connection_details() {
        let lookup = configured_ecr_lookup_from_devices(&[serde_json::json!({
            "name": "Till Lane",
            "connectionType": "network",
            "connectionDetails": {
                "ip": "192.168.1.55",
                "port": 20007
            }
        })]);

        assert!(is_configured_terminal(
            &lookup,
            "Network Terminal (192.168.1.55:20007)",
            "192.168.1.55:20007"
        ));
    }

    #[test]
    fn serial_candidate_marks_configured_devices() {
        let candidate = build_serial_terminal_candidate(
            "COM3",
            Some("PAX"),
            Some("A920"),
            &sample_configured_lookup(),
        );

        assert_eq!(
            candidate
                .get("connectionType")
                .and_then(|value| value.as_str()),
            Some("serial_usb")
        );
        assert_eq!(
            candidate
                .pointer("/connectionDetails/port")
                .and_then(|value| value.as_str()),
            Some("COM3")
        );
        assert_eq!(
            candidate
                .get("isConfigured")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            candidate
                .get("isSupported")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn network_candidate_uses_terminal_ports() {
        let candidate = build_network_terminal_candidate(
            "192.168.1.55",
            20007,
            &ConfiguredEcrLookup::default(),
            "lan-port-scan",
        );

        assert_eq!(
            candidate
                .pointer("/connectionDetails/ip")
                .and_then(|value| value.as_str()),
            Some("192.168.1.55")
        );
        assert_eq!(
            candidate
                .pointer("/connectionDetails/port")
                .and_then(|value| value.as_u64()),
            Some(20007)
        );
        assert_eq!(
            candidate
                .get("isSupported")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn bluetooth_candidates_are_marked_discovery_only() {
        let candidates = build_bluetooth_terminals_from_rows(
            vec![serde_json::json!({
                "FriendlyName": "Ingenico Move",
                "InstanceId": "BTHENUM\\DEV_AABBCCDDEEFF\\8&1234",
                "Source": "windows-pnp"
            })],
            &ConfiguredEcrLookup::default(),
        );

        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0]
                .get("connectionType")
                .and_then(|value| value.as_str()),
            Some("bluetooth")
        );
        assert_eq!(
            candidates[0]
                .get("isSupported")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_eq!(
            candidates[0]
                .get("unsupportedReason")
                .and_then(|value| value.as_str()),
            Some(BLUETOOTH_UNSUPPORTED_REASON_KEY)
        );
    }

    #[test]
    fn dedupe_prefers_single_identity_per_connection_target() {
        let configured = ConfiguredEcrLookup::default();
        let deduped = dedupe_discovered_terminals(vec![
            build_network_terminal_candidate("192.168.1.80", 10009, &configured, "lan-port-scan"),
            build_network_terminal_candidate("192.168.1.80", 10009, &configured, "lan-port-scan"),
            build_bluetooth_terminal_candidate(
                "Ingenico",
                "AA:BB:CC:DD:EE:FF",
                None,
                None,
                &configured,
                "windows-pnp",
            ),
            build_bluetooth_terminal_candidate(
                "Ingenico Copy",
                "AABBCCDDEEFF",
                None,
                None,
                &configured,
                "windows-ble",
            ),
        ]);

        assert_eq!(deduped.len(), 2);
    }

    #[test]
    fn parse_powershell_rows_accepts_single_object() {
        let parsed = parse_powershell_device_rows(serde_json::json!({
            "FriendlyName": "Terminal One",
            "InstanceId": "BTHENUM\\DEV_AABBCCDDEEFF\\x"
        }));
        assert_eq!(parsed.len(), 1);
    }

    #[test]
    fn extract_mac_from_instance_id_formats_hex_pairs() {
        assert_eq!(
            extract_mac_from_instance_id("BTHENUM\\DEV_AABBCCDDEEFF\\8&1234"),
            Some("AA:BB:CC:DD:EE:FF".to_string())
        );
    }

    #[test]
    fn normalize_mac_address_collapses_common_formats() {
        assert_eq!(
            normalize_mac_address("AA:BB:CC:DD:EE:FF"),
            Some("aabbccddeeff".to_string())
        );
        assert_eq!(
            normalize_mac_address("AABBCCDDEEFF"),
            Some("aabbccddeeff".to_string())
        );
        assert_eq!(
            normalize_mac_address("aa-bb-cc-dd-ee-ff"),
            Some("aabbccddeeff".to_string())
        );
    }

    #[test]
    fn normalize_mac_address_rejects_non_mac_inputs() {
        assert_eq!(normalize_mac_address("192.168.1.80:10009"), None);
        assert_eq!(normalize_mac_address(""), None);
        assert_eq!(normalize_mac_address("not-a-mac"), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn lan_subnet_hosts_excludes_the_local_host() {
        let hosts = lan_subnet_hosts(std::net::Ipv4Addr::new(192, 168, 1, 42));
        assert_eq!(hosts.len(), 253);
        assert!(!hosts.contains(&std::net::Ipv4Addr::new(192, 168, 1, 42)));
        assert!(hosts.contains(&std::net::Ipv4Addr::new(192, 168, 1, 1)));
        assert!(hosts.contains(&std::net::Ipv4Addr::new(192, 168, 1, 254)));
    }
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    struct TempOutstandingDb(std::path::PathBuf);

    impl Drop for TempOutstandingDb {
        fn drop(&mut self) {
            for path in [
                self.0.clone(),
                self.0.with_extension("db-wal"),
                self.0.with_extension("db-shm"),
            ] {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    fn file_backed_outstanding_attempt_test_dbs(
        order_id: &str,
    ) -> (TempOutstandingDb, db::DbState, db::DbState) {
        let path = std::env::temp_dir().join(format!(
            "pos-outstanding-attempt-race-{}-{}.db",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let first = rusqlite::Connection::open(&path).expect("open first attempt database");
        first
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA busy_timeout = 5000;
                 PRAGMA synchronous = NORMAL;",
            )
            .expect("configure first attempt database");
        crate::db::run_migrations_for_test(&first);
        first
            .execute(
                "INSERT INTO orders (id, items, total_amount, total_amount_cents)
                 VALUES (?1, '[]', 42.00, 4200)",
                rusqlite::params![order_id],
            )
            .expect("seed outstanding race order");
        first
            .execute(
                "INSERT INTO ecr_devices (
                    id, name, device_type, brand, protocol, connection_type,
                    connection_details
                 ) VALUES (
                    'race-attempt-device', 'CAP Cashier', 'cash_register', 'RBS',
                    'cap_driver', 'network', '{}'
                 )",
                [],
            )
            .expect("seed outstanding race device");

        let second = rusqlite::Connection::open(&path).expect("open second attempt database");
        second
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA busy_timeout = 5000;
                 PRAGMA synchronous = NORMAL;",
            )
            .expect("configure second attempt database");

        let first_state = db::DbState {
            conn: std::sync::Mutex::new(first),
            db_path: path.clone(),
        };
        let second_state = db::DbState {
            conn: std::sync::Mutex::new(second),
            db_path: path.clone(),
        };
        (TempOutstandingDb(path), first_state, second_state)
    }

    fn outstanding_processing_attempt(id: &str, order_reference: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "deviceId": "race-attempt-device",
            "orderId": order_reference,
            "transactionType": "fiscal_receipt",
            "amount": 4200,
            "currency": "EUR",
            "status": "processing",
            "receiptData": { "intendedMethod": "card" },
            "startedAt": "2026-08-13T12:00:00Z",
        })
    }

    fn outstanding_attempt_test_db() -> db::DbState {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO ecr_devices (
                id, name, device_type, brand, protocol, connection_type,
                connection_details
             ) VALUES (
                'durable-attempt-device', 'CAP Cashier', 'cash_register', 'RBS',
                'cap_driver', 'network', '{}'
             )",
            [],
        )
        .expect("seed durable-attempt fiscal device");
        db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    #[tokio::test]
    async fn second_connection_cannot_reserve_a_different_key_for_the_same_order() {
        let (_cleanup, first, second) =
            file_backed_outstanding_attempt_test_dbs("order-cross-process-race");
        let first_attempt = outstanding_processing_attempt(
            "race-attempt-first",
            "order-cross-process-race:collect-outstanding:first-key",
        );
        let second_attempt = outstanding_processing_attempt(
            "race-attempt-second",
            "order-cross-process-race:collect-outstanding:second-key",
        );
        let hardware_calls = std::sync::atomic::AtomicUsize::new(0);

        dispatch_after_durable_outstanding_attempt(
            &first,
            &first_attempt,
            |_| Ok(()),
            || async {
                hardware_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
        )
        .await
        .expect("first process reserves and dispatches");

        let error = dispatch_after_durable_outstanding_attempt(
            &second,
            &second_attempt,
            |_| Ok(()),
            || async {
                hardware_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
        )
        .await
        .expect_err("second key must lose the atomic per-order reservation");

        assert!(error.contains("unresolved outstanding fiscal attempt"));
        assert!(
            !error.contains("UNIQUE"),
            "must not expose raw SQLite errors"
        );
        assert_eq!(
            hardware_calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "only the first process may contact hardware",
        );
    }

    #[tokio::test]
    async fn exact_processing_attempt_is_reconciled_without_redispatch_or_unique_error() {
        let (_cleanup, first, second) =
            file_backed_outstanding_attempt_test_dbs("order-exact-process-race");
        let attempt = outstanding_processing_attempt(
            "race-attempt-exact",
            "order-exact-process-race:collect-outstanding:stable-key",
        );
        let hardware_calls = std::sync::atomic::AtomicUsize::new(0);

        dispatch_after_durable_outstanding_attempt(
            &first,
            &attempt,
            |_| Ok(()),
            || async {
                hardware_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
        )
        .await
        .expect("first process reserves and dispatches");

        let error = dispatch_after_durable_outstanding_attempt(
            &second,
            &attempt,
            |_| Ok(()),
            || async {
                hardware_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
        )
        .await
        .expect_err("same processing attempt requires reconciliation");

        assert!(error.contains("unresolved outstanding fiscal attempt"));
        assert!(
            !error.contains("UNIQUE"),
            "must not expose raw SQLite errors"
        );
        assert_eq!(
            hardware_calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "an exact processing retry must never redispatch hardware",
        );
    }

    #[test]
    fn outstanding_attempt_identity_is_stable_and_reference_bound() {
        let first =
            outstanding_fiscal_transaction_id("order-1:collect-outstanding:stable-generation");
        let retry =
            outstanding_fiscal_transaction_id("order-1:collect-outstanding:stable-generation");
        let changed =
            outstanding_fiscal_transaction_id("order-1:collect-outstanding:changed-generation");

        assert_eq!(
            first, retry,
            "a retry must reuse the same hardware identity"
        );
        assert_ne!(
            first, changed,
            "a changed ledger generation needs a new identity"
        );
        assert!(first.starts_with("fiscal-outstanding-"));
        assert_eq!(first.len(), "fiscal-outstanding-".len() + 64);
    }

    #[test]
    fn definite_failure_is_deduplicated_for_the_same_attempt_but_not_a_fresh_one() {
        let state = outstanding_attempt_test_db();
        let conn = state.conn.lock().expect("lock definite failure database");
        conn.execute(
            "INSERT INTO ecr_transactions (
                id, device_id, order_id, transaction_type, amount, currency,
                status, receipt_data, error_message, started_at, completed_at
             ) VALUES (
                'declined-attempt-id', 'durable-attempt-device',
                'order-declined:collect-outstanding:same-key', 'fiscal_receipt',
                4200, 'EUR', 'declined', '{\"intendedMethod\":\"card\"}',
                'Declined', '2026-08-13T12:00:00Z', '2026-08-13T12:00:02Z'
             )",
            [],
        )
        .expect("seed definite declined attempt");

        let retry = find_definite_failed_fiscal_transaction(
            &conn,
            "order-declined:collect-outstanding:same-key",
        )
        .expect("query same-key failure")
        .expect("same-key failure must deduplicate");
        assert_eq!(retry["transactionId"], "declined-attempt-id");
        assert_eq!(retry["status"], "declined");
        assert!(find_definite_failed_fiscal_transaction(
            &conn,
            "order-declined:collect-outstanding:fresh-key",
        )
        .expect("query fresh-key reference")
        .is_none());
        assert!(
            reject_existing_unresolved_outstanding_attempt(
                &conn,
                &outstanding_processing_attempt(
                    "fresh-attempt-after-decline",
                    "order-declined:collect-outstanding:fresh-key",
                ),
            )
            .is_ok(),
            "a definite decline must release the per-order reservation"
        );

        let response = outstanding_definite_failure_retry_response(retry);
        assert_eq!(response["success"], false);
        assert_eq!(response["approved"], false);
        assert_eq!(response["deduplicated"], true);
        assert_eq!(response["requiresReconciliation"], false);
    }

    #[test]
    fn outstanding_fiscal_payload_fingerprint_detects_equal_total_item_edits() {
        let original = serde_json::json!({
            "items": [
                {"name": "Coffee", "quantity": 1, "price": 5.00, "taxRate": 24.0},
                {"name": "Cake", "quantity": 1, "price": 5.00, "taxRate": 13.0}
            ],
            "totalAmount": 10.00,
            "taxAmount": 1.72,
            "subtotal": 8.28,
            "discountAmount": 0.0,
            "tipAmount": 0.0,
            "orderType": "takeaway"
        });
        let equal_total_edit = serde_json::json!({
            "items": [
                {"name": "Tea", "quantity": 1, "price": 5.00, "taxRate": 24.0},
                {"name": "Cake", "quantity": 1, "price": 5.00, "taxRate": 13.0}
            ],
            "totalAmount": 10.00,
            "taxAmount": 1.72,
            "subtotal": 8.28,
            "discountAmount": 0.0,
            "tipAmount": 0.0,
            "orderType": "takeaway"
        });

        assert_ne!(
            outstanding_fiscal_payload_fingerprint(&original)
                .expect("fingerprint original fiscal payload"),
            outstanding_fiscal_payload_fingerprint(&equal_total_edit)
                .expect("fingerprint edited fiscal payload"),
            "equal-total item edits must invalidate a pending fiscal collection",
        );
    }

    #[tokio::test]
    async fn durable_attempt_is_visible_before_dispatch_and_insert_failure_skips_hardware() {
        let state = outstanding_attempt_test_db();
        let attempt_id = outstanding_fiscal_transaction_id(
            "order-durable:collect-outstanding:stable-generation",
        );
        let attempt = serde_json::json!({
            "id": attempt_id.clone(),
            "deviceId": "durable-attempt-device",
            "orderId": "order-durable:collect-outstanding:stable-generation",
            "transactionType": "fiscal_receipt",
            "amount": 4200,
            "currency": "EUR",
            "status": "processing",
            "receiptData": { "intendedMethod": "card" },
            "startedAt": "2026-08-13T12:00:00Z",
        });

        let visible_status = dispatch_after_durable_outstanding_attempt(
            &state,
            &attempt,
            |_| Ok(()),
            || async {
                let conn = state
                    .conn
                    .lock()
                    .expect("lock attempt database during dispatch");
                conn.query_row(
                    "SELECT status FROM ecr_transactions WHERE id = ?1",
                    rusqlite::params![attempt_id],
                    |row| row.get::<_, String>(0),
                )
                .expect("attempt must be committed before hardware dispatch")
            },
        )
        .await
        .expect("persist then dispatch");
        assert_eq!(visible_status, "processing");

        let hardware_calls = std::sync::atomic::AtomicUsize::new(0);
        let error = dispatch_after_durable_outstanding_attempt(
            &state,
            &attempt,
            |_| Ok(()),
            || async {
                hardware_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
        )
        .await
        .expect_err("duplicate durable identity must fail before hardware");
        assert!(error.contains("persist outstanding fiscal attempt"));
        assert_eq!(
            hardware_calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "persistence failure must never reach hardware",
        );
    }

    #[tokio::test]
    async fn equal_total_edit_before_reservation_fails_before_hardware_dispatch() {
        let state = outstanding_attempt_test_db();
        let original = serde_json::json!({
            "items": [{"name": "Coffee", "quantity": 1, "price": 10.00}],
            "totalAmount": 10.00,
        });
        let edited_items = serde_json::json!([
            {"name": "Tea", "quantity": 1, "price": 10.00}
        ]);
        let intended = serde_json::json!({"method": "cash", "amount": 10.00});
        let tax_rates = Vec::<ecr::protocol::TaxRateConfig>::new();
        let expected_order_fingerprint = outstanding_fiscal_payload_fingerprint(&original)
            .expect("fingerprint original fiscal order");
        let expected_fiscal = ecr::fiscal::build_fiscal_data_for_outstanding_checkout(
            &original,
            &[],
            &intended,
            &tax_rates,
            None,
        )
        .expect("build expected fiscal payload");
        {
            let conn = state.conn.lock().expect("lock edit test database");
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, total_amount_cents)
                 VALUES ('edited-before-reserve-order', ?1, 10.00, 1000)",
                rusqlite::params![original["items"].to_string()],
            )
            .expect("seed original order");
            conn.execute(
                "UPDATE orders SET items = ?1 WHERE id = 'edited-before-reserve-order'",
                rusqlite::params![edited_items.to_string()],
            )
            .expect("simulate equal-total edit before reservation");
        }
        let reference = "edited-before-reserve-order:collect-outstanding:generation";
        let attempt = serde_json::json!({
            "id": outstanding_fiscal_transaction_id(reference),
            "deviceId": "durable-attempt-device",
            "orderId": reference,
            "transactionType": "fiscal_receipt",
            "amount": 1000,
            "currency": "EUR",
            "status": "processing",
            "receiptData": { "intendedMethod": "cash" },
            "startedAt": "2026-08-13T12:00:00Z",
        });
        let hardware_calls = std::sync::atomic::AtomicUsize::new(0);
        let error = dispatch_after_durable_outstanding_attempt(
            &state,
            &attempt,
            |conn| {
                verify_authoritative_outstanding_fiscal_payload(
                    conn,
                    "edited-before-reserve-order",
                    &expected_order_fingerprint,
                    &expected_fiscal,
                    &[],
                    &intended,
                    &tax_rates,
                    None,
                )
            },
            || async {
                hardware_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
        )
        .await
        .expect_err("stale fiscal payload must fail reservation");

        assert!(error
            .to_ascii_lowercase()
            .contains("fiscal payload changed"));
        assert_eq!(
            hardware_calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "stale order data must not reach hardware",
        );
        let attempt_count: i64 = state
            .conn
            .lock()
            .expect("lock after rejected reservation")
            .query_row(
                "SELECT COUNT(*) FROM ecr_transactions WHERE order_id = ?1",
                rusqlite::params![reference],
                |row| row.get(0),
            )
            .expect("count rejected attempts");
        assert_eq!(
            attempt_count, 0,
            "failed validation must roll back reservation"
        );
    }

    #[test]
    fn parse_required_device_id_supports_string_and_object() {
        let from_string = parse_required_device_id(Some(serde_json::json!("device-1")))
            .expect("string device id should parse");
        let from_object = parse_required_device_id(Some(serde_json::json!({
            "deviceId": "device-2"
        })))
        .expect("object device id should parse");
        assert_eq!(from_string, "device-1");
        assert_eq!(from_object, "device-2");
    }

    #[test]
    fn parse_discover_args_supports_legacy_tuple_and_object() {
        let (types_from_legacy, timeout_from_legacy) = parse_discover_args(
            Some(serde_json::json!(["USB", "bluetooth"])),
            Some(serde_json::json!(15)),
        );
        assert_eq!(
            types_from_legacy,
            vec!["usb".to_string(), "bluetooth".to_string()]
        );
        assert_eq!(timeout_from_legacy, Some(15));

        let (types_from_object, timeout_from_object) = parse_discover_args(
            Some(serde_json::json!({
                "connectionTypes": ["network"],
                "connectionType": "serial_usb",
                "timeoutMs": 30
            })),
            None,
        );
        assert_eq!(
            types_from_object,
            vec!["network".to_string(), "serial_usb".to_string()]
        );
        assert_eq!(timeout_from_object, Some(30));
    }

    #[test]
    fn parse_update_device_payload_supports_legacy_and_object() {
        let legacy = parse_update_device_payload(
            Some(serde_json::json!("device-a")),
            Some(serde_json::json!({ "enabled": false })),
        )
        .expect("legacy tuple should parse");
        assert_eq!(legacy.device_id, "device-a");
        assert_eq!(
            legacy.updates.get("enabled").and_then(|v| v.as_bool()),
            Some(false)
        );

        let object = parse_update_device_payload(
            Some(serde_json::json!({
                "deviceId": "device-b",
                "updates": { "name": "Counter Terminal" }
            })),
            None,
        )
        .expect("object payload should parse");
        assert_eq!(object.device_id, "device-b");
        assert_eq!(
            object.updates.get("name").and_then(|v| v.as_str()),
            Some("Counter Terminal")
        );
    }

    #[test]
    fn parse_amount_and_options_payload_supports_object_shape() {
        let parsed = parse_amount_and_options_payload(
            Some(serde_json::json!({
                "amount": 12.5,
                "deviceId": "device-9",
                "orderId": "order-1"
            })),
            None,
        );
        assert_eq!(parsed.amount, 12.5);
        assert_eq!(
            parsed.options.get("deviceId").and_then(|v| v.as_str()),
            Some("device-9")
        );
    }

    #[test]
    fn parse_void_transaction_payload_supports_legacy_tuple_and_object() {
        let legacy = parse_void_transaction_payload(
            Some(serde_json::json!("tx-1")),
            Some(serde_json::json!("device-1")),
        )
        .expect("legacy void payload should parse");
        assert_eq!(legacy.transaction_id, "tx-1");
        assert_eq!(legacy.device_id.as_deref(), Some("device-1"));

        let object = parse_void_transaction_payload(
            Some(serde_json::json!({
                "transactionId": "tx-2",
                "deviceId": "device-2"
            })),
            None,
        )
        .expect("object void payload should parse");
        assert_eq!(object.transaction_id, "tx-2");
        assert_eq!(object.device_id.as_deref(), Some("device-2"));
    }

    #[test]
    fn parse_recent_transactions_limit_accepts_number_and_object() {
        let from_number = parse_recent_transactions_limit(Some(serde_json::json!(25)));
        let from_object = parse_recent_transactions_limit(Some(serde_json::json!({ "limit": 40 })));
        assert_eq!(from_number, 25);
        assert_eq!(from_object, 40);
    }

    #[test]
    fn parse_query_filters_payload_supports_device_string() {
        let parsed = parse_query_filters_payload(Some(serde_json::json!("device-11")));
        assert_eq!(
            parsed.get("deviceId").and_then(|v| v.as_str()),
            Some("device-11")
        );
    }

    #[test]
    fn ambiguous_fiscal_timeout_is_found_before_hardware_retry() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO ecr_devices (
                id, name, device_type, brand, protocol, connection_type,
                connection_details
             ) VALUES (
                'device-1', 'CAP Cashier', 'cash_register', 'RBS',
                'cap_driver', 'network', '{}'
             )",
            [],
        )
        .expect("seed fiscal device");
        conn.execute(
            "INSERT INTO ecr_transactions (
                id, device_id, order_id, transaction_type, amount, currency,
                status, terminal_reference, error_message, raw_response,
                started_at, completed_at
             ) VALUES (
                'tx-timeout-1', 'device-1', 'order-stable-1', 'fiscal_receipt',
                1, 'EUR', 'timeout', 'pos-tauri-tx-timeout-1.txt',
                'Completion unknown', '{\"requiresReconciliation\":true}',
                '2026-07-24T12:00:00Z', '2026-07-24T12:02:00Z'
             )",
            [],
        )
        .expect("seed ambiguous transaction");

        let found = find_ambiguous_fiscal_transaction(&conn, "order-stable-1")
            .expect("query ambiguous transaction")
            .expect("timeout must block retry");
        assert_eq!(found["transactionId"], "tx-timeout-1");
        assert_eq!(found["status"], "timeout");
        assert_eq!(found["rawResponse"]["requiresReconciliation"], true);
        assert!(find_ambiguous_fiscal_transaction(&conn, "another-order")
            .expect("query other order")
            .is_none());
    }

    #[test]
    fn outstanding_approval_retry_requires_the_same_method_and_an_unpersisted_reference() {
        let existing = serde_json::json!({
            "transactionId": "fiscal-approved-1",
            "intendedMethod": "card",
        });

        assert!(validate_existing_outstanding_approval(&existing, "card", &[]).is_ok());
        assert!(
            validate_existing_outstanding_approval(&existing, "cash", &[])
                .expect_err("changed tender must require reconciliation")
                .contains("Reconcile")
        );
        assert!(validate_existing_outstanding_approval(
            &existing,
            "card",
            &[serde_json::json!({
                "status": "completed",
                "transactionRef": "fiscal-approved-1",
            })],
        )
        .expect_err("already persisted approval must not be reused")
        .contains("Reconcile"));
        assert!(validate_existing_outstanding_approval(
            &serde_json::json!({
                "transactionId": "legacy-approved-without-method",
            }),
            "card",
            &[],
        )
        .expect_err("unbound legacy approval must fail closed")
        .contains("Reconcile"));
    }

    #[test]
    fn approved_fiscal_lookup_restores_the_bound_intended_method() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO ecr_devices (
                id, name, device_type, brand, protocol, connection_type,
                connection_details
             ) VALUES (
                'device-bound', 'CAP Cashier', 'cash_register', 'RBS',
                'cap_driver', 'network', '{}'
             )",
            [],
        )
        .expect("seed fiscal device");
        conn.execute(
            "INSERT INTO ecr_transactions (
                id, device_id, order_id, transaction_type, amount, currency,
                status, receipt_data, started_at, completed_at
             ) VALUES (
                'tx-bound-card', 'device-bound', 'collection-reference',
                'fiscal_receipt', 5000, 'EUR', 'approved',
                '{\"intendedMethod\":\"card\"}',
                '2026-08-13T12:00:00Z', '2026-08-13T12:00:01Z'
             )",
            [],
        )
        .expect("seed bound approval");

        let found = find_approved_fiscal_transaction(&conn, "collection-reference")
            .expect("query approved transaction")
            .expect("approved transaction");
        assert_eq!(found["transactionId"], "tx-bound-card");
        assert_eq!(found["intendedMethod"], "card");
    }

    #[test]
    fn cross_generation_outstanding_approval_blocks_new_hardware_until_reconciled() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO ecr_devices (
                id, name, device_type, brand, protocol, connection_type,
                connection_details
             ) VALUES (
                'device-cross-generation', 'CAP Cashier', 'cash_register', 'RBS',
                'cap_driver', 'network', '{}'
             )",
            [],
        )
        .expect("seed fiscal device");
        conn.execute(
            "INSERT INTO ecr_transactions (
                id, device_id, order_id, transaction_type, amount, currency,
                status, receipt_data, started_at, completed_at
             ) VALUES (
                'tx-old-generation', 'device-cross-generation',
                'order-cross:collect-outstanding:5000:0:5000:attempt-old',
                'fiscal_receipt', 5000, 'EUR', 'approved',
                '{\"intendedMethod\":\"card\"}',
                '2026-08-13T12:00:00Z', '2026-08-13T12:00:01Z'
             )",
            [],
        )
        .expect("seed unreconciled approval");

        let found = find_unreconciled_outstanding_fiscal_attempt(&conn, "order-cross", &[], None)
            .expect("scan outstanding attempts")
            .expect("old approval must block a new generation");
        assert_eq!(found["transactionId"], "tx-old-generation");
        assert_eq!(found["intendedMethod"], "card");

        let represented = find_unreconciled_outstanding_fiscal_attempt(
            &conn,
            "order-cross",
            &[serde_json::json!({
                "status": "completed",
                "transactionRef": "tx-old-generation",
            })],
            None,
        )
        .expect("scan reconciled attempts");
        assert!(represented.is_none());
    }

    #[test]
    fn cross_generation_orphan_marker_blocks_new_hardware_until_reconciled() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        crate::db::set_setting(
            &conn,
            "ecr_orphaned_receipts",
            "order-orphan:collect-outstanding:4200:0:4200:attempt-old",
            &serde_json::json!({
                "id": "tx-orphan-old",
                "status": "approved",
                "receiptData": { "intendedMethod": "card" },
            })
            .to_string(),
        )
        .expect("seed orphan approval marker");

        let found = find_unreconciled_outstanding_fiscal_attempt(&conn, "order-orphan", &[], None)
            .expect("scan orphaned outstanding attempts")
            .expect("orphan approval must block another charge");
        assert_eq!(found["transactionId"], "tx-orphan-old");
        assert_eq!(found["orphanedLocally"], true);
        assert_eq!(found["intendedMethod"], "card");
    }

    #[test]
    fn older_unreconciled_attempt_wins_over_the_exact_retry_candidate() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO ecr_devices (
                id, name, device_type, brand, protocol, connection_type,
                connection_details
             ) VALUES (
                'device-multiple-attempts', 'CAP Cashier', 'cash_register', 'RBS',
                'cap_driver', 'network', '{}'
             )",
            [],
        )
        .expect("seed fiscal device");
        for (id, reference, started_at) in [
            (
                "tx-old-unreconciled",
                "order-multiple:collect-outstanding:5000:0:5000:attempt-old",
                "2026-08-13T12:00:00Z",
            ),
            (
                "tx-exact-retry",
                "order-multiple:collect-outstanding:4500:500:4000:attempt-current",
                "2026-08-13T12:01:00Z",
            ),
        ] {
            conn.execute(
                "INSERT INTO ecr_transactions (
                    id, device_id, order_id, transaction_type, amount, currency,
                    status, receipt_data, started_at, completed_at
                 ) VALUES (?1, 'device-multiple-attempts', ?2, 'fiscal_receipt',
                    4000, 'EUR', 'approved', '{\"intendedMethod\":\"card\"}',
                    ?3, ?3)",
                rusqlite::params![id, reference, started_at],
            )
            .expect("seed outstanding approval");
        }

        let found = find_unreconciled_outstanding_fiscal_attempt(
            &conn,
            "order-multiple",
            &[],
            Some("order-multiple:collect-outstanding:4500:500:4000:attempt-current"),
        )
        .expect("scan all outstanding attempts")
        .expect("older approval must block the exact retry");

        assert_eq!(found["transactionId"], "tx-old-unreconciled");
    }

    #[test]
    fn outstanding_receipt_build_failure_is_a_reconciliation_result() {
        let result = outstanding_fiscal_build_failure(
            "Outstanding fiscal checkout cannot replay a previously approved card tender"
                .to_string(),
        );

        assert_eq!(result["success"], false);
        assert_eq!(result["approved"], false);
        assert_eq!(result["requiresReconciliation"], true);
        assert!(result["error"]
            .as_str()
            .expect("error message")
            .contains("previously approved card"));
    }

    #[test]
    fn exact_orphaned_approval_retry_is_deduplicated_without_new_hardware() {
        let orphan = serde_json::json!({
            "transactionId": "tx-orphan-exact",
            "orderReference": "order-orphan:collect-outstanding:4200:0:4200:attempt-1",
            "status": "approved",
            "intendedMethod": "card",
            "orphanedLocally": true,
        });

        let response = outstanding_approval_retry_response(&orphan, "card", &[]);

        assert_eq!(response["success"], true);
        assert_eq!(response["approved"], true);
        assert_eq!(response["deduplicated"], true);
        assert_eq!(response["orphanedLocally"], true);
        assert_eq!(response["transaction"]["transactionId"], "tx-orphan-exact");
    }

    #[test]
    fn multiple_exact_approvals_fail_closed_instead_of_choosing_one() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        conn.execute(
            "INSERT INTO ecr_devices (
                id, name, device_type, brand, protocol, connection_type,
                connection_details
             ) VALUES (
                'device-duplicate-exact', 'CAP Cashier', 'cash_register', 'RBS',
                'cap_driver', 'network', '{}'
             )",
            [],
        )
        .expect("seed fiscal device");
        let reference = "order-duplicate:collect-outstanding:4200:0:4200:ledger:attempt";
        for (id, started_at) in [
            ("tx-exact-one", "2026-08-13T12:00:00Z"),
            ("tx-exact-two", "2026-08-13T12:01:00Z"),
        ] {
            conn.execute(
                "INSERT INTO ecr_transactions (
                    id, device_id, order_id, transaction_type, amount, currency,
                    status, receipt_data, started_at, completed_at
                 ) VALUES (?1, 'device-duplicate-exact', ?2, 'fiscal_receipt',
                    4200, 'EUR', 'approved', '{\"intendedMethod\":\"card\"}',
                    ?3, ?3)",
                rusqlite::params![id, reference, started_at],
            )
            .expect("seed exact approval");
        }

        let found = find_unreconciled_outstanding_fiscal_attempt(
            &conn,
            "order-duplicate",
            &[],
            Some(reference),
        )
        .expect("scan duplicate exact approvals")
        .expect("duplicates require reconciliation");

        assert_eq!(found["multipleUnreconciledAttempts"], true);
    }

    #[test]
    fn fiscal_receipt_persistence_enqueues_remote_order_backfill() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        crate::sync_queue::create_tables(&conn).expect("create parity queue tables");
        crate::db::set_setting(
            &conn,
            "terminal",
            "organization_id",
            "22222222-2222-2222-2222-222222222222",
        )
        .expect("seed organization");

        conn.execute(
            "INSERT INTO ecr_devices (
                 id, name, device_type, brand, protocol, connection_type, connection_details
             ) VALUES (
                 'device-1', 'Fiscal Device', 'cash_register', 'generic', 'generic', 'serial_usb', '{}'
             )",
            [],
        )
        .expect("seed ecr device");
        conn.execute(
            "INSERT INTO orders (
                 id, supabase_id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at
             ) VALUES (
                 'order-fiscal-receipt', 'remote-order-fiscal-receipt',
                 '[]', 22.0, 2200, 'completed', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed synced order");

        let insert_payload = serde_json::json!({
            "id": "tx-fiscal-1",
            "deviceId": "device-1",
            "orderId": "order-fiscal-receipt",
            "transactionType": "fiscal_receipt",
            "amount": 2200,
            "currency": "EUR",
            "status": "approved",
            "fiscalReceiptNumber": "FISC-000123",
            "startedAt": "2026-05-21T19:00:00Z",
            "completedAt": "2026-05-21T19:00:01Z",
            "rawResponse": { "receipt": "FISC-000123" }
        });

        persist_fiscal_receipt_transaction_and_enqueue_backfill(
            &mut conn,
            &insert_payload,
            "order-fiscal-receipt",
            Some("FISC-000123"),
        )
        .expect("persist fiscal transaction");

        let local_receipt: String = conn
            .query_row(
                "SELECT fiscal_receipt_number FROM ecr_transactions WHERE id = 'tx-fiscal-1'",
                [],
                |row| row.get(0),
            )
            .expect("local fiscal receipt number");
        assert_eq!(local_receipt, "FISC-000123");

        let queue_payload: String = conn
            .query_row(
                "SELECT data
                 FROM parity_sync_queue
                 WHERE table_name = 'orders' AND record_id = 'order-fiscal-receipt'",
                [],
                |row| row.get(0),
            )
            .expect("queued order backfill");
        let queued = serde_json::from_str::<serde_json::Value>(&queue_payload)
            .expect("parse queued payload");
        assert_eq!(
            queued
                .get("fiscalReceiptNumber")
                .and_then(serde_json::Value::as_str),
            Some("FISC-000123")
        );
        assert_eq!(
            queued.get("status").and_then(serde_json::Value::as_str),
            Some("completed")
        );
    }
}
