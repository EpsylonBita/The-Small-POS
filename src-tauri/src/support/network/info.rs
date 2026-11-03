use super::super::{critical_op::SupportPermit, redaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    net::Ipv4Addr,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Interface {
    pub interface_id: String,
    pub name: Value,
    pub kind: String,
    pub ipv4: Vec<Address>,
    pub gateway: Option<String>,
    pub dns: Vec<String>,
    pub is_vpn_or_virtual: bool,
    pub scan_eligible: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Address {
    pub address: Ipv4Addr,
    pub prefix_length: u8,
}
pub fn excluded(name: &str) -> bool {
    crate::commands::cap_discovery::is_excluded_interface_alias(name)
}
pub fn private(ip: Ipv4Addr) -> bool {
    ip.is_private() && !ip.is_loopback() && !ip.is_link_local()
}
pub fn parse(value: Value) -> Vec<Interface> {
    let rows = match value {
        Value::Array(v) => v,
        Value::Object(_) => vec![value],
        _ => vec![],
    };
    let mut interfaces = rows
        .into_iter()
        .filter_map(|r| {
            let id = r["id"].as_i64()?.to_string();
            let name = r["name"].as_str()?;
            let virtual_ = r["virtual"].as_bool().unwrap_or(true) || excluded(name);
            let addresses = r["ipv4"]
                .as_array()?
                .iter()
                .filter_map(|a| {
                    Some(Address {
                        address: a["address"].as_str()?.parse().ok()?,
                        prefix_length: u8::try_from(a["prefix"].as_u64()?).ok()?,
                    })
                })
                .collect::<Vec<_>>();
            let eligible = !virtual_
                && r["up"] == true
                && addresses
                    .iter()
                    .any(|a| private(a.address) && a.prefix_length <= 30);
            Some((
                r["default_route"].as_bool().unwrap_or(false),
                Interface {
                    interface_id: id,
                    name: redaction::text(name),
                    kind: r["kind"].as_str().unwrap_or("other").into(),
                    ipv4: addresses,
                    gateway: r["gateway"].as_str().map(str::to_string),
                    dns: r["dns"]
                        .as_array()
                        .map(|d| {
                            d.iter()
                                .filter_map(|v| v.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    is_vpn_or_virtual: virtual_,
                    scan_eligible: eligible,
                },
            ))
        })
        .collect::<Vec<_>>();
    interfaces.sort_by_key(|(default_route, i)| {
        (
            !*default_route,
            i.interface_id.parse::<i64>().unwrap_or(i64::MAX),
        )
    });
    interfaces.into_iter().take(2).map(|(_, i)| i).collect()
}
pub fn interfaces(permit: &SupportPermit) -> Result<Vec<Interface>, String> {
    #[cfg(not(windows))]
    {
        let _ = permit;
        return Err("FEATURE_DISABLED".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Static script: no server text, SSID, BSSID, key or command interpolation.
        let script = r#"$ErrorActionPreference='Stop'; $routes=@(Get-NetRoute -PolicyStore ActiveStore -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Where-Object {$_.State -eq 'Alive'} | Select-Object -ExpandProperty InterfaceIndex); $result=@(Get-NetIPConfiguration | ForEach-Object { $c=$_; $a=Get-NetAdapter -InterfaceIndex $c.InterfaceIndex -ErrorAction SilentlyContinue; [PSCustomObject]@{id=$c.InterfaceIndex;default_route=($routes -contains $c.InterfaceIndex);name=$c.InterfaceAlias;virtual=if($a){[bool]$a.Virtual}else{$true};up=if($a){$a.Status -eq 'Up'}else{$false};kind=if($a.PhysicalMediaType -eq '802.3'){'ethernet'}elseif($a.PhysicalMediaType -eq 'Native 802.11'){'wifi'}else{'other'};ipv4=@($c.IPv4Address | ForEach-Object {[PSCustomObject]@{address=$_.IPAddress;prefix=$_.PrefixLength}});gateway=$c.IPv4DefaultGateway.NextHop;dns=@($c.DNSServer.ServerAddresses)}}); ConvertTo-Json -InputObject $result -Depth 5 -Compress"#;
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(0x08000000)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "INTERNAL_ERROR")?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if permit.is_cancelled() || Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if permit.is_cancelled() {
                    "PREEMPTED_BY_CRITICAL_OPERATION"
                } else {
                    "QUERY_TIMEOUT"
                }
                .into());
            }
            if child.try_wait().map_err(|_| "INTERNAL_ERROR")?.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().map_err(|_| "INTERNAL_ERROR")?;
        if !output.status.success() || output.stdout.len() > 128 * 1024 {
            return Err("INTERNAL_ERROR".into());
        }
        Ok(parse(
            serde_json::from_slice(&output.stdout).map_err(|_| "INTERNAL_ERROR")?,
        ))
    }
}
pub fn collect(permit: &SupportPermit, base: Option<String>) -> Result<Value, String> {
    collect_with(
        permit,
        || interfaces(permit),
        || {
            base.and_then(|s| url::Url::parse(&s).ok())
                .filter(|u| {
                    u.scheme() == "https"
                        && u.username().is_empty()
                        && u.password().is_none()
                        && u.query().is_none()
                        && u.fragment().is_none()
                })
                .and_then(|url| {
                    let at = Instant::now();
                    let client = reqwest::blocking::Client::builder()
                        .timeout(Duration::from_millis(500))
                        .connect_timeout(Duration::from_millis(250))
                        .redirect(reqwest::redirect::Policy::none())
                        .no_proxy()
                        .build()
                        .ok()?;
                    client
                        .head(url)
                        .send()
                        .ok()
                        .map(|_| at.elapsed().as_millis())
                })
        },
    )
}

pub(crate) fn collect_with(
    permit: &SupportPermit,
    adapters: impl FnOnce() -> Result<Vec<Interface>, String>,
    server: impl FnOnce() -> Option<u128>,
) -> Result<Value, String> {
    let interfaces = adapters()?;
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    let status = server();
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    Ok(
        json!({"interfaces":interfaces,"network_name":"not_collected","support_server":{"reachable":status.is_some(),"rtt_ms":status}}),
    )
}
