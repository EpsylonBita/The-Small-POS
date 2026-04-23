use serde::Deserialize;
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
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let device = db::ecr_get_device(&conn, &device_id)
        .ok_or_else(|| format!("Device {device_id} not found"))?;

    let connection_type = device
        .get("connectionType")
        .and_then(|v| v.as_str())
        .unwrap_or("serial_usb");
    let connection_details = device
        .get("connectionDetails")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let protocol_name = device
        .get("protocol")
        .and_then(|v| v.as_str())
        .unwrap_or("generic");
    let settings = device
        .get("settings")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    // Attempt real protocol connection via DeviceManager
    match mgr.connect_device(
        &device_id,
        connection_type,
        &connection_details,
        protocol_name,
        &settings,
    ) {
        Ok(()) => {
            let now = chrono::Utc::now().to_rfc3339();
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
    let amount_cents = (amount * 100.0).round() as i64;
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
            match mgr.process_transaction(did, &request) {
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

    // No device connected — return mock-approved for backward compat
    let transaction = serde_json::json!({
        "id": tx_id,
        "amount": amount,
        "status": "approved"
    });
    let _ = app.emit("ecr_event_transaction_completed", transaction.clone());
    Ok(serde_json::json!({
        "success": true,
        "transaction": transaction,
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
    let amount_cents = (amount * 100.0).round() as i64;
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
            match mgr.process_transaction(did, &request) {
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

    // No device connected — mock-approved for backward compat
    let transaction = serde_json::json!({
        "id": tx_id,
        "amount": amount,
        "status": "approved"
    });
    let _ = app.emit("ecr_event_transaction_completed", transaction.clone());
    Ok(serde_json::json!({
        "success": true,
        "transaction": transaction,
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
            if let Err(e) = mgr.process_transaction(did, &request) {
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
            match mgr.settlement(did) {
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
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let device = db::ecr_get_device(&conn, &device_id)
        .ok_or_else(|| format!("Device {device_id} not found"))?;

    let connection_type = device
        .get("connectionType")
        .and_then(|v| v.as_str())
        .unwrap_or("serial_usb");
    let connection_details = device
        .get("connectionDetails")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let protocol_name = device
        .get("protocol")
        .and_then(|v| v.as_str())
        .unwrap_or("generic");
    let settings = device
        .get("settings")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    match mgr.test_connection(
        &device_id,
        connection_type,
        &connection_details,
        protocol_name,
        &settings,
    ) {
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
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let device = db::ecr_get_device(&conn, &device_id)
            .ok_or_else(|| format!("Device {device_id} not found"))?;
        let print_mode = device
            .get("printMode")
            .and_then(|v| v.as_str())
            .unwrap_or("register_prints");

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
            mgr.send_raw(&device_id, &data)?;
        } else {
            // For register_prints mode, send a status inquiry
            let _ = mgr.send_raw(
                &device_id,
                &[0x02, 0x01, 0x21, 0x4A, 0x05, 0x6A, 0x03], // STATUS frame
            );
        }

        return Ok(serde_json::json!({ "success": true, "printed": true }));
    }

    Ok(serde_json::json!({
        "success": false,
        "error": "Device not connected"
    }))
}

#[tauri::command]
pub async fn ecr_fiscal_print(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_required_order_id(arg0)?;

    // Phase 1 — load device + order + payments under the DB lock.
    //
    // The inner block holds `db.conn` only for the duration of these fast
    // queries and drops it before the (potentially multi-second) device I/O
    // in Phase 3. Previously the lock was held across the entire function,
    // which froze every other SQLite write in the POS for the duration of
    // each fiscal print.
    let (device, order, payments) = {
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

        let order_json_str: Option<String> = conn
            .prepare("SELECT data FROM orders WHERE id = ?1")
            .ok()
            .and_then(|mut stmt| {
                stmt.query_row(rusqlite::params![order_id], |row| row.get(0))
                    .ok()
            });
        let order: serde_json::Value = match order_json_str {
            Some(s) => serde_json::from_str(&s).unwrap_or(serde_json::json!({})),
            None => return Err(format!("Order {order_id} not found")),
        };

        let payments: Vec<serde_json::Value> = conn
            .prepare("SELECT data FROM order_payments WHERE order_id = ?1")
            .ok()
            .map(|mut stmt| {
                stmt.query_map(rusqlite::params![order_id], |row| {
                    let s: String = row.get(0)?;
                    Ok(serde_json::from_str::<serde_json::Value>(&s).unwrap_or_default())
                })
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default()
            })
            .unwrap_or_default();

        (device, order, payments)
        // MutexGuard drops here; DB lock released.
    };

    // Phase 2 — derive config + build fiscal data (no DB access).
    let device_id = device
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Device has no id")?
        .to_string();

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
            mgr.send_raw(&device_id, &escpos_bytes)?;
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

            let device_result = mgr.process_transaction(&device_id, &request);

            // Phase 4 — persist result. Re-acquire DB lock; these writes are fast.
            //
            // TODO(F4c): fiscal_receipt_number currently lands only in the local
            // `ecr_transactions` table and is never enqueued to sync_queue, so
            // the admin-dashboard / AADE path never learns it. Needs team
            // decision: if backend reconciliation requires the number, add a
            // sync_queue enqueue here in the same SQLite transaction as the
            // INSERT. See planning/claude/deep-dive-ecr-aade-fiscal.md.
            match device_result {
                Ok(resp) => {
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let insert_payload = serde_json::json!({
                        "id": resp.transaction_id,
                        "deviceId": device_id,
                        "orderId": order_id,
                        "transactionType": "fiscal_receipt",
                        "amount": request.amount,
                        "currency": "EUR",
                        "status": format!("{:?}", resp.status).to_lowercase(),
                        "fiscalReceiptNumber": resp.fiscal_receipt_number,
                        "startedAt": resp.started_at,
                        "completedAt": resp.completed_at,
                        "rawResponse": resp.raw_response,
                    });
                    if let Err(insert_err) = db::ecr_insert_transaction(&conn, &insert_payload) {
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
}
