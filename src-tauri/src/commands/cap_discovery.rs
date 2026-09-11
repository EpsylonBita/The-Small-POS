//! Read-only LAN discovery for RBS/MAT CAP terminals.
//!
//! Scope: locate a candidate host on the local network whose HTTP `Server`
//! header identifies it as a MAT ECR unit, so the desktop UI can offer it to
//! the user instead of requiring a manually typed IP address. This module
//! never performs the CAP handshake itself; the actual pairing still happens
//! through the existing CAP setup flow once the user picks a candidate.

use serde::Serialize;
use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
#[cfg(target_os = "windows")]
use tracing::warn;

/// Up to two physical LAN interfaces are scanned per discovery run.
const MAX_PHYSICAL_INTERFACES: usize = 2;
/// Hard cap on the number of hosts probed across all scanned interfaces.
const MAX_HOSTS: usize = 512;
/// Maximum number of concurrent per-host probes in flight.
const MAX_CONCURRENT_PROBES: usize = 32;
/// Per-host connect+request budget for the HEAD probe.
const PER_HOST_TIMEOUT_MS: u64 = 400;
/// Overall wall-clock budget for a single discovery run.
const TOTAL_SCAN_TIMEOUT: Duration = Duration::from_secs(10);
/// The only `Server` header value that qualifies as a MAT ECR candidate.
const EXPECTED_SERVER_HEADER: &str = "MAT_ECR_SERVER";

/// Guards against overlapping scans triggered by repeated button presses.
static SCAN_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapDiscoveryCandidate {
    pub host: String,
    pub detected_family: &'static str,
    pub label: &'static str,
    pub verification: &'static str,
}

impl CapDiscoveryCandidate {
    fn rbs_mat(host: String) -> Self {
        Self {
            host,
            detected_family: "rbs_mat",
            label: "MAT ECR",
            verification: "network_only",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CapDiscoveryResult {
    pub success: bool,
    pub candidates: Vec<CapDiscoveryCandidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl CapDiscoveryResult {
    fn ok(candidates: Vec<CapDiscoveryCandidate>) -> Self {
        Self {
            success: true,
            candidates,
            code: None,
        }
    }

    fn failure(code: &str) -> Self {
        Self {
            success: false,
            candidates: Vec::new(),
            code: Some(code.to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PhysicalInterface {
    ip: Ipv4Addr,
    prefix_len: u8,
}

/// A `_permit`-style RAII guard that clears the in-flight flag on drop,
/// including on early return or panic, so a stuck scan can't wedge the
/// button forever.
struct ScanGuard;

impl Drop for ScanGuard {
    fn drop(&mut self) {
        SCAN_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

fn try_acquire_scan_guard() -> Option<ScanGuard> {
    if SCAN_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        Some(ScanGuard)
    } else {
        None
    }
}

/// Probes a single host and returns the raw `Server` header value, if any
/// HTTP response was received. Header-value matching is left to the caller
/// so the match logic stays testable independent of the transport.
trait HeadProbe {
    fn probe_head(&self, ip: Ipv4Addr) -> impl std::future::Future<Output = Option<String>> + Send;
}

#[cfg(target_os = "windows")]
struct ReqwestHeadProbe {
    client: reqwest::Client,
}

#[cfg(target_os = "windows")]
impl ReqwestHeadProbe {
    fn new(timeout_ms: u64) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_millis(timeout_ms))
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .map_err(|error| format!("Failed to build CAP discovery HTTP client: {error}"))?;
        Ok(Self { client })
    }
}

#[cfg(target_os = "windows")]
impl HeadProbe for ReqwestHeadProbe {
    async fn probe_head(&self, ip: Ipv4Addr) -> Option<String> {
        let url = format!("http://{ip}/");
        let response = self.client.head(&url).send().await.ok()?;
        if !is_eligible_head_response(response.status()) {
            return None;
        }
        response
            .headers()
            .get(reqwest::header::SERVER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    }
}

/// Only a plain successful (2xx) response is eligible for header matching.
/// Redirects are never followed (`redirect::Policy::none()`), but a 3xx (or
/// any non-2xx) response body/headers must still be explicitly rejected here
/// rather than trusted just because a `Server` header happened to match.
fn is_eligible_head_response(status: reqwest::StatusCode) -> bool {
    status.is_success() && !status.is_redirection()
}

fn is_scannable_physical_ip(ip: Ipv4Addr) -> bool {
    ip.is_private() && !ip.is_loopback() && !ip.is_link_local()
}

/// Alias-name heuristics used to exclude VPN, tunnel, and virtual adapters
/// when a live `Virtual`/`Status` flag from `Get-NetAdapter` is unavailable
/// or ambiguous.
fn is_excluded_interface_alias(alias: &str) -> bool {
    const EXCLUDED_TOKENS: [&str; 13] = [
        "loopback",
        "vpn",
        "tailscale",
        "docker",
        "virtual",
        "vmware",
        "virtualbox",
        "hyper-v",
        "vethernet",
        "tap",
        "tun",
        "wsl",
        "utun",
    ];
    let lower = alias.to_ascii_lowercase();
    EXCLUDED_TOKENS.iter().any(|token| lower.contains(token))
}

/// Parses the PowerShell interface enumeration rows into scannable physical
/// interfaces, filtering out loopback/link-local/VPN/virtual/Docker/
/// Tailscale adapters as practical, and capping the result at
/// [`MAX_PHYSICAL_INTERFACES`].
fn parse_interface_rows(parsed: &serde_json::Value) -> Vec<PhysicalInterface> {
    let rows: Vec<serde_json::Value> = match parsed {
        serde_json::Value::Array(arr) => arr.clone(),
        serde_json::Value::Object(_) => vec![parsed.clone()],
        _ => vec![],
    };

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let ip = match row
            .get("IPAddress")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| value.trim().parse::<Ipv4Addr>().ok())
        {
            Some(ip) if is_scannable_physical_ip(ip) => ip,
            _ => continue,
        };

        let alias = row
            .get("InterfaceAlias")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if is_excluded_interface_alias(alias) {
            continue;
        }

        let is_virtual = row
            .get("Virtual")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        if is_virtual {
            continue;
        }

        let status_is_up = row
            .get("Status")
            .and_then(serde_json::Value::as_str)
            .map(|status| status.eq_ignore_ascii_case("Up"))
            .unwrap_or(false);
        if !status_is_up {
            continue;
        }

        // Malformed or missing PrefixLength must never fall back to an
        // assumed /24: a bad /25+ assignment could otherwise scan outside
        // the interface's actual subnet. Reject the row instead.
        let prefix_len = match row
            .get("PrefixLength")
            .and_then(serde_json::Value::as_u64)
            .filter(|value| (1..=32).contains(value))
        {
            Some(value) => value as u8,
            None => continue,
        };

        if seen.insert(ip) {
            out.push(PhysicalInterface { ip, prefix_len });
        }
        if out.len() >= MAX_PHYSICAL_INTERFACES {
            break;
        }
    }

    out
}

/// Computes the host addresses to probe for a given interface, respecting
/// the interface's own prefix for `/25` and narrower assignments, and
/// capping broader assignments (`/24` and wider) to the local `/24` slice
/// containing the interface address so discovery never wanders outside the
/// interface's own subnet.
fn subnet_hosts(interface: PhysicalInterface) -> Vec<Ipv4Addr> {
    let effective_prefix = interface.prefix_len.max(24);
    if effective_prefix >= 31 {
        // Point-to-point or host route: no broadcast-domain neighbors to scan.
        return vec![];
    }

    let host_bits = 32 - effective_prefix;
    let mask: u32 = u32::MAX << host_bits;
    let network = u32::from(interface.ip) & mask;
    let self_addr = u32::from(interface.ip);
    let usable_hosts = (1u32 << host_bits).saturating_sub(2);

    let mut hosts = Vec::with_capacity(usable_hosts as usize);
    for offset in 1..=usable_hosts {
        let candidate = network + offset;
        if candidate == self_addr {
            continue;
        }
        hosts.push(Ipv4Addr::from(candidate));
        if hosts.len() >= MAX_HOSTS {
            break;
        }
    }
    hosts
}

/// Merges the per-interface host lists, deduplicating and enforcing the
/// overall [`MAX_HOSTS`] cap across all scanned interfaces combined.
fn bounded_scan_hosts(interfaces: &[PhysicalInterface]) -> Vec<Ipv4Addr> {
    let mut seen = HashSet::new();
    let mut hosts = Vec::new();
    for interface in interfaces {
        for host in subnet_hosts(*interface) {
            if seen.insert(host) {
                hosts.push(host);
            }
            if hosts.len() >= MAX_HOSTS {
                return hosts;
            }
        }
    }
    hosts
}

/// Runs the bounded, concurrency-limited HEAD probe sweep over `hosts` and
/// returns only the hosts whose `Server` header exactly (case-insensitively)
/// matched [`EXPECTED_SERVER_HEADER`]. Generic over [`HeadProbe`] so tests
/// can inject a fake transport instead of touching the live LAN.
///
/// `deadline` is shared with the rest of the discovery run (interface
/// enumeration included) so probing never gets a fresh budget on top of
/// time already spent elsewhere.
async fn run_lan_discovery<P>(
    hosts: Vec<Ipv4Addr>,
    probe: std::sync::Arc<P>,
    deadline: tokio::time::Instant,
) -> Vec<CapDiscoveryCandidate>
where
    P: HeadProbe + Send + Sync + 'static,
{
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PROBES));
    let mut set = tokio::task::JoinSet::new();

    for ip in hosts {
        let semaphore = semaphore.clone();
        let probe = probe.clone();
        set.spawn(async move {
            let _permit = semaphore.acquire_owned().await.ok()?;
            probe
                .probe_head(ip)
                .await
                .map(|server_header| (ip, server_header))
        });
    }

    let mut candidates = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            set.abort_all();
            break;
        }
        match tokio::time::timeout(remaining, set.join_next()).await {
            Ok(Some(Ok(Some((ip, server_header))))) => {
                if server_header
                    .trim()
                    .eq_ignore_ascii_case(EXPECTED_SERVER_HEADER)
                {
                    candidates.push(CapDiscoveryCandidate::rbs_mat(ip.to_string()));
                }
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {
                set.abort_all();
                break;
            }
        }
    }

    candidates
}

/// Actionable enumeration outcomes distinct from "the scan ran fine but
/// found nothing" (`no_lan_interface`, returned separately by the caller).
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnumerationError {
    /// The helper process failed to start, exited non-zero, or its output
    /// could not be parsed.
    Failed,
    /// The bounded whole-operation deadline was reached before the helper
    /// process produced output.
    Timeout,
}

#[cfg(target_os = "windows")]
impl EnumerationError {
    fn code(self) -> &'static str {
        match self {
            EnumerationError::Failed => "interface_enumeration_failed",
            EnumerationError::Timeout => "interface_enumeration_timeout",
        }
    }
}

/// Awaits `future`, bounded by whatever time remains until `deadline`.
/// Returns `Err(())` immediately if the deadline has already passed, or if
/// it is reached before `future` resolves. Kept generic (not Windows- or
/// process-specific) so the deadline arithmetic is directly unit-testable
/// with a fake future instead of a real subprocess.
async fn bounded_by_deadline<F, T>(future: F, deadline: tokio::time::Instant) -> Result<T, ()>
where
    F: std::future::Future<Output = T>,
{
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err(());
    }
    tokio::time::timeout(remaining, future)
        .await
        .map_err(|_| ())
}

#[cfg(target_os = "windows")]
fn powershell_executable_path() -> std::path::PathBuf {
    // Fixed system executable path (not a PATH-resolved lookup) so the
    // helper process identity can't be influenced by the environment.
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    std::path::Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

#[cfg(target_os = "windows")]
async fn run_hidden_powershell_bounded(
    script: &str,
    deadline: tokio::time::Instant,
) -> Result<std::process::Output, EnumerationError> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut command = tokio::process::Command::new(powershell_executable_path());
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let child = command.spawn().map_err(|_| EnumerationError::Failed)?;

    bounded_by_deadline(child.wait_with_output(), deadline)
        .await
        .map_err(|_| EnumerationError::Timeout)?
        .map_err(|_| EnumerationError::Failed)
}

#[cfg(target_os = "windows")]
async fn enumerate_physical_lan_interfaces(
    deadline: tokio::time::Instant,
) -> Result<Vec<PhysicalInterface>, EnumerationError> {
    let script = r#"
$ErrorActionPreference = 'Stop'
$rows = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
  $_.IPAddress -and
  $_.IPAddress -notlike '127.*' -and
  $_.IPAddress -notlike '169.254.*' -and
  $_.SkipAsSource -ne $true
}
$result = foreach ($row in $rows) {
  $adapter = Get-NetAdapter -InterfaceIndex $row.InterfaceIndex -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    IPAddress = $row.IPAddress
    PrefixLength = $row.PrefixLength
    InterfaceAlias = $row.InterfaceAlias
    Virtual = if ($adapter) { [bool]$adapter.Virtual } else { $true }
    Status = if ($adapter) { $adapter.Status.ToString() } else { 'Unknown' }
  }
}
$result | ConvertTo-Json -Compress
"#;

    let output = run_hidden_powershell_bounded(script, deadline).await?;

    if !output.status.success() {
        // Deliberately not logging raw stdout/stderr: it may echo
        // unrelated local network/device details beyond scan scope.
        warn!("CAP discovery PowerShell interface enumeration returned a non-success status");
        return Err(EnumerationError::Failed);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() || stdout == "null" {
        return Ok(vec![]);
    }

    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(parsed) => Ok(parse_interface_rows(&parsed)),
        Err(_) => {
            warn!("CAP discovery PowerShell interface enumeration returned invalid JSON");
            Err(EnumerationError::Failed)
        }
    }
}

/// Read-only LAN discovery for RBS/MAT CAP terminals.
///
/// Registration signature (for the CAP setup worker to wire into
/// `mod.rs`/`lib.rs`):
///
/// ```ignore
/// #[tauri::command]
/// pub async fn ecr_cap_discover() -> Result<serde_json::Value, String>
/// ```
///
/// Invoke handler entry: `commands::cap_discovery::ecr_cap_discover`.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn ecr_cap_discover() -> Result<serde_json::Value, String> {
    let Some(_guard) = try_acquire_scan_guard() else {
        return Ok(serde_json::to_value(CapDiscoveryResult::failure("scan_in_progress")).unwrap());
    };

    // Shared across enumeration and probing so a slow helper process eats
    // into the same 10s budget instead of granting probing a fresh window.
    let deadline = tokio::time::Instant::now() + TOTAL_SCAN_TIMEOUT;

    let interfaces = match enumerate_physical_lan_interfaces(deadline).await {
        Ok(interfaces) => interfaces,
        Err(error) => {
            return Ok(serde_json::to_value(CapDiscoveryResult::failure(error.code())).unwrap());
        }
    };
    if interfaces.is_empty() {
        return Ok(serde_json::to_value(CapDiscoveryResult::failure("no_lan_interface")).unwrap());
    }

    let hosts = bounded_scan_hosts(&interfaces);
    if hosts.is_empty() {
        return Ok(serde_json::to_value(CapDiscoveryResult::ok(vec![])).unwrap());
    }

    let probe = match ReqwestHeadProbe::new(PER_HOST_TIMEOUT_MS) {
        Ok(probe) => std::sync::Arc::new(probe),
        Err(error) => {
            warn!(error = %error, "CAP discovery could not build the HTTP probe client");
            return Ok(
                serde_json::to_value(CapDiscoveryResult::failure("probe_unavailable")).unwrap(),
            );
        }
    };

    let candidates = run_lan_discovery(hosts, probe, deadline).await;
    Ok(serde_json::to_value(CapDiscoveryResult::ok(candidates)).unwrap())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn ecr_cap_discover() -> Result<serde_json::Value, String> {
    Ok(serde_json::to_value(CapDiscoveryResult::failure("unsupported_platform")).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeProbe {
        responses: std::collections::HashMap<Ipv4Addr, Option<String>>,
    }

    impl HeadProbe for FakeProbe {
        async fn probe_head(&self, ip: Ipv4Addr) -> Option<String> {
            self.responses.get(&ip).cloned().flatten()
        }
    }

    fn interface(ip: [u8; 4], prefix_len: u8) -> PhysicalInterface {
        PhysicalInterface {
            ip: Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3]),
            prefix_len,
        }
    }

    #[test]
    fn subnet_hosts_respects_slash_24_bounds() {
        let hosts = subnet_hosts(interface([192, 168, 1, 42], 24));
        assert_eq!(hosts.len(), 253);
        assert!(hosts.contains(&Ipv4Addr::new(192, 168, 1, 1)));
        assert!(hosts.contains(&Ipv4Addr::new(192, 168, 1, 254)));
        assert!(!hosts.contains(&Ipv4Addr::new(192, 168, 1, 42)));
        assert!(!hosts.contains(&Ipv4Addr::new(192, 168, 1, 0)));
        assert!(!hosts.contains(&Ipv4Addr::new(192, 168, 1, 255)));
    }

    #[test]
    fn subnet_hosts_respects_slash_25_bounds_and_never_crosses_into_the_other_half() {
        let hosts = subnet_hosts(interface([10, 0, 0, 10], 25));
        assert_eq!(hosts.len(), 125);
        assert!(hosts.iter().all(|ip| ip.octets()[3] < 128));
        assert!(!hosts.contains(&Ipv4Addr::new(10, 0, 0, 130)));
    }

    #[test]
    fn subnet_hosts_caps_broader_subnets_to_the_local_slash_24_slice() {
        let hosts = subnet_hosts(interface([10, 5, 6, 7], 16));
        assert_eq!(hosts.len(), 253);
        assert!(hosts
            .iter()
            .all(|ip| ip.octets()[0] == 10 && ip.octets()[1] == 5 && ip.octets()[2] == 6));
    }

    #[test]
    fn subnet_hosts_returns_empty_for_point_to_point_prefixes() {
        assert!(subnet_hosts(interface([10, 0, 0, 1], 31)).is_empty());
        assert!(subnet_hosts(interface([10, 0, 0, 1], 32)).is_empty());
    }

    #[test]
    fn bounded_scan_hosts_dedupes_and_caps_across_interfaces() {
        let interfaces = vec![
            interface([192, 168, 1, 1], 24),
            interface([192, 168, 1, 2], 24),
        ];
        let hosts = bounded_scan_hosts(&interfaces);
        assert!(hosts.len() <= MAX_HOSTS);
        let mut seen = HashSet::new();
        assert!(hosts.iter().all(|ip| seen.insert(*ip)));
    }

    #[test]
    fn parse_interface_rows_excludes_loopback_link_local_vpn_virtual_docker_and_tailscale() {
        let parsed = serde_json::json!([
            {"IPAddress": "127.0.0.1", "PrefixLength": 8, "InterfaceAlias": "Loopback", "Virtual": false, "Status": "Up"},
            {"IPAddress": "169.254.1.5", "PrefixLength": 16, "InterfaceAlias": "Ethernet", "Virtual": false, "Status": "Up"},
            {"IPAddress": "10.8.0.5", "PrefixLength": 24, "InterfaceAlias": "TAP-Windows VPN", "Virtual": false, "Status": "Up"},
            {"IPAddress": "10.9.0.5", "PrefixLength": 24, "InterfaceAlias": "Tailscale", "Virtual": false, "Status": "Up"},
            {"IPAddress": "172.17.0.1", "PrefixLength": 16, "InterfaceAlias": "vEthernet (Docker)", "Virtual": false, "Status": "Up"},
            {"IPAddress": "192.168.56.1", "PrefixLength": 24, "InterfaceAlias": "VirtualBox Host-Only Network", "Virtual": true, "Status": "Up"},
            {"IPAddress": "192.168.1.42", "PrefixLength": 24, "InterfaceAlias": "Ethernet", "Virtual": false, "Status": "Up"},
        ]);
        let interfaces = parse_interface_rows(&parsed);
        assert_eq!(interfaces, vec![interface([192, 168, 1, 42], 24)]);
    }

    #[test]
    fn parse_interface_rows_excludes_down_and_public_addresses() {
        let parsed = serde_json::json!([
            {"IPAddress": "192.168.1.5", "PrefixLength": 24, "InterfaceAlias": "Ethernet", "Virtual": false, "Status": "Disconnected"},
            {"IPAddress": "8.8.8.8", "PrefixLength": 24, "InterfaceAlias": "Ethernet", "Virtual": false, "Status": "Up"},
        ]);
        assert!(parse_interface_rows(&parsed).is_empty());
    }

    #[test]
    fn parse_interface_rows_caps_at_max_physical_interfaces() {
        let parsed = serde_json::json!([
            {"IPAddress": "192.168.1.10", "PrefixLength": 24, "InterfaceAlias": "Ethernet", "Virtual": false, "Status": "Up"},
            {"IPAddress": "192.168.2.10", "PrefixLength": 24, "InterfaceAlias": "Ethernet 2", "Virtual": false, "Status": "Up"},
            {"IPAddress": "192.168.3.10", "PrefixLength": 24, "InterfaceAlias": "Ethernet 3", "Virtual": false, "Status": "Up"},
        ]);
        let interfaces = parse_interface_rows(&parsed);
        assert_eq!(interfaces.len(), MAX_PHYSICAL_INTERFACES);
    }

    #[tokio::test]
    async fn run_lan_discovery_accepts_only_the_exact_case_insensitive_server_header() {
        let matching = Ipv4Addr::new(192, 168, 1, 169);
        let wrong_header = Ipv4Addr::new(192, 168, 1, 5);
        let no_response = Ipv4Addr::new(192, 168, 1, 6);
        let lowercase_match = Ipv4Addr::new(192, 168, 1, 7);

        let mut responses = std::collections::HashMap::new();
        responses.insert(matching, Some("MAT_ECR_SERVER".to_string()));
        responses.insert(wrong_header, Some("Apache/2.4".to_string()));
        responses.insert(no_response, None);
        responses.insert(lowercase_match, Some("mat_ecr_server".to_string()));

        let probe = std::sync::Arc::new(FakeProbe { responses });
        let hosts = vec![matching, wrong_header, no_response, lowercase_match];
        let deadline = tokio::time::Instant::now() + TOTAL_SCAN_TIMEOUT;
        let candidates = run_lan_discovery(hosts, probe, deadline).await;

        let hosts_found: HashSet<String> = candidates.into_iter().map(|c| c.host).collect();
        assert_eq!(
            hosts_found,
            HashSet::from([matching.to_string(), lowercase_match.to_string()])
        );
    }

    #[tokio::test]
    async fn run_lan_discovery_marks_candidates_as_network_only_rbs_mat() {
        let host = Ipv4Addr::new(10, 0, 0, 9);
        let mut responses = std::collections::HashMap::new();
        responses.insert(host, Some("MAT_ECR_SERVER".to_string()));
        let probe = std::sync::Arc::new(FakeProbe { responses });
        let deadline = tokio::time::Instant::now() + TOTAL_SCAN_TIMEOUT;

        let candidates = run_lan_discovery(vec![host], probe, deadline).await;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].detected_family, "rbs_mat");
        assert_eq!(candidates[0].label, "MAT ECR");
        assert_eq!(candidates[0].verification, "network_only");
    }

    #[tokio::test]
    async fn run_lan_discovery_completes_well_within_the_total_scan_budget_for_a_bounded_host_set()
    {
        let hosts: Vec<Ipv4Addr> = (1u8..=50).map(|n| Ipv4Addr::new(192, 168, 1, n)).collect();
        let responses = hosts.iter().map(|ip| (*ip, None)).collect();
        let probe = std::sync::Arc::new(FakeProbe { responses });
        let deadline = tokio::time::Instant::now() + TOTAL_SCAN_TIMEOUT;

        let started = std::time::Instant::now();
        let candidates = run_lan_discovery(hosts, probe, deadline).await;
        assert!(candidates.is_empty());
        assert!(
            started.elapsed() < TOTAL_SCAN_TIMEOUT,
            "bounded fake-probe scan must not approach the total scan timeout"
        );
    }

    #[tokio::test]
    async fn run_lan_discovery_stops_at_an_already_expired_shared_deadline() {
        let host = Ipv4Addr::new(192, 168, 1, 200);
        let mut responses = std::collections::HashMap::new();
        responses.insert(host, Some("MAT_ECR_SERVER".to_string()));
        let probe = std::sync::Arc::new(FakeProbe { responses });

        // A deadline in the past must not run an unbounded/extra scan.
        let expired_deadline = tokio::time::Instant::now() - Duration::from_millis(50);
        let started = std::time::Instant::now();
        let candidates = run_lan_discovery(vec![host], probe, expired_deadline).await;

        assert!(candidates.is_empty());
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    #[tokio::test]
    async fn bounded_by_deadline_times_out_at_the_deadline_instead_of_hanging() {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(50);
        let started = std::time::Instant::now();

        let result = bounded_by_deadline(
            async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                "never"
            },
            deadline,
        )
        .await;

        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "bounded_by_deadline must not wait anywhere near the unbounded future's duration"
        );
    }

    #[tokio::test]
    async fn bounded_by_deadline_rejects_an_already_expired_deadline_immediately() {
        let deadline = tokio::time::Instant::now() - Duration::from_millis(10);
        let started = std::time::Instant::now();

        let result = bounded_by_deadline(async { "unreachable" }, deadline).await;

        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn is_eligible_head_response_requires_success_and_rejects_redirects_and_errors() {
        use reqwest::StatusCode;

        assert!(is_eligible_head_response(StatusCode::OK));
        assert!(is_eligible_head_response(StatusCode::NO_CONTENT));
        assert!(!is_eligible_head_response(StatusCode::MOVED_PERMANENTLY));
        assert!(!is_eligible_head_response(StatusCode::FOUND));
        assert!(!is_eligible_head_response(StatusCode::TEMPORARY_REDIRECT));
        assert!(!is_eligible_head_response(StatusCode::NOT_FOUND));
        assert!(!is_eligible_head_response(
            StatusCode::INTERNAL_SERVER_ERROR
        ));
    }

    #[test]
    fn parse_interface_rows_rejects_missing_or_invalid_prefix_length_instead_of_defaulting() {
        let parsed = serde_json::json!([
            {"IPAddress": "192.168.1.10", "InterfaceAlias": "Ethernet", "Virtual": false, "Status": "Up"},
            {"IPAddress": "192.168.1.11", "PrefixLength": 0, "InterfaceAlias": "Ethernet", "Virtual": false, "Status": "Up"},
            {"IPAddress": "192.168.1.12", "PrefixLength": 33, "InterfaceAlias": "Ethernet", "Virtual": false, "Status": "Up"},
            {"IPAddress": "192.168.1.13", "PrefixLength": "25", "InterfaceAlias": "Ethernet", "Virtual": false, "Status": "Up"},
            {"IPAddress": "192.168.1.14", "PrefixLength": null, "InterfaceAlias": "Ethernet", "Virtual": false, "Status": "Up"},
            {"IPAddress": "192.168.1.15", "PrefixLength": 25, "InterfaceAlias": "Ethernet", "Virtual": false, "Status": "Up"},
        ]);
        let interfaces = parse_interface_rows(&parsed);
        assert_eq!(interfaces, vec![interface([192, 168, 1, 15], 25)]);
    }

    #[test]
    fn scan_guard_prevents_overlapping_acquisition_until_dropped() {
        // Serialize with other tests touching the shared static guard.
        static GUARD_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _lock = GUARD_TEST_LOCK.lock().unwrap();
        SCAN_IN_PROGRESS.store(false, Ordering::SeqCst);

        let first = try_acquire_scan_guard();
        assert!(first.is_some());
        assert!(try_acquire_scan_guard().is_none());
        drop(first);
        assert!(try_acquire_scan_guard().is_some());
        SCAN_IN_PROGRESS.store(false, Ordering::SeqCst);
    }

    #[test]
    fn failure_result_never_carries_candidates() {
        let result = CapDiscoveryResult::failure("no_lan_interface");
        assert!(!result.success);
        assert!(result.candidates.is_empty());
        assert_eq!(result.code.as_deref(), Some("no_lan_interface"));
    }
}
