use super::super::{contracts, critical_op::SupportPermit};
use super::{
    info::{self, Interface},
    DiscoveryState,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    net::Ipv4Addr,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
pub const PORTS: &[u16] = &[9100, 515, 631, 20007, 10009, 9101, 80];
#[derive(Default)]
pub struct Reply {
    pub open: bool,
    pub mat_ecr: bool,
}
pub trait Connector: Sync {
    fn arp_vendors(
        &self,
        _deadline: Instant,
        _permit: &SupportPermit,
    ) -> BTreeMap<Ipv4Addr, String> {
        BTreeMap::new()
    }
    fn mdns_name(
        &self,
        _ip: Ipv4Addr,
        _deadline: Instant,
        _permit: &SupportPermit,
    ) -> Option<Value> {
        None
    }

    fn probe(&self, ip: Ipv4Addr, port: u16, deadline: Instant, permit: &SupportPermit) -> Reply;
}
pub struct TcpConnector;
pub fn head_request(ip: Ipv4Addr) -> Vec<u8> {
    format!("HEAD / HTTP/1.1\r\nHost: {ip}\r\nConnection: close\r\n\r\n").into_bytes()
}
impl Connector for TcpConnector {
    fn arp_vendors(&self, deadline: Instant, permit: &SupportPermit) -> BTreeMap<Ipv4Addr, String> {
        super::observations::arp_vendors(deadline, permit)
    }
    fn mdns_name(&self, ip: Ipv4Addr, deadline: Instant, permit: &SupportPermit) -> Option<Value> {
        super::observations::mdns_name(ip, deadline, permit)
    }

    fn probe(&self, ip: Ipv4Addr, port: u16, deadline: Instant, permit: &SupportPermit) -> Reply {
        if permit.is_cancelled() || Instant::now() >= deadline {
            return Reply::default();
        }
        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(50));
        if port == 80 {
            let matched = crate::commands::cap_discovery::support_head_probe(ip, timeout);
            return Reply {
                open: matched,
                mat_ecr: matched,
            };
        }
        let open = if matches!(port, 10009 | 20007 | 9101) {
            crate::commands::cap_discovery::support_ecr_tcp_probe(ip, port, timeout)
        } else {
            crate::printers::support_tcp_probe(ip, port, timeout)
        };
        Reply {
            open,
            mat_ecr: false,
        }
    }
}
pub fn mat_head(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    if !text.ends_with("\r\n\r\n") {
        return false;
    }
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|v| v.parse::<u16>().ok());
    status.is_some_and(|n| (200..300).contains(&n))
        && lines.any(|l| {
            l.split_once(':').is_some_and(|(k, v)| {
                k.eq_ignore_ascii_case("server") && v.trim() == "MAT_ECR_SERVER"
            })
        })
}
pub fn hosts(interface: &Interface) -> Vec<Ipv4Addr> {
    if !interface.scan_eligible || interface.is_vpn_or_virtual {
        return vec![];
    }
    let Some(a) = interface
        .ipv4
        .iter()
        .find(|a| info::private(a.address) && a.prefix_length <= 30)
    else {
        return vec![];
    };
    let prefix = a.prefix_length.max(24);
    let mask = u32::MAX << (32 - prefix);
    let start = u32::from(a.address) & mask;
    let end = start | !mask;
    (start + 1..end)
        .filter(|ip| *ip != u32::from(a.address))
        .map(Ipv4Addr::from)
        .collect()
}
pub fn parameters(
    input: &Value,
    interfaces: &[Interface],
) -> Result<(Vec<Interface>, Vec<u16>), String> {
    let obj = input.as_object().ok_or("INVALID_INPUT")?;
    if obj
        .keys()
        .any(|k| !matches!(k.as_str(), "interfaces" | "port_groups" | "include_mdns"))
    {
        return Err("POLICY_REFUSED".into());
    }
    let requested = input
        .get("interfaces")
        .map(|v| v.as_array().ok_or("INVALID_INPUT"))
        .transpose()?;
    if requested.is_some_and(|r| r.len() > 2 || r.is_empty()) {
        return Err("POLICY_REFUSED".into());
    }
    let mut selected = Vec::new();
    if let Some(ids) = requested {
        let mut seen = BTreeSet::new();
        for id in ids {
            let id = id.as_str().ok_or("INVALID_INPUT")?;
            if !seen.insert(id) {
                return Err("POLICY_REFUSED".into());
            }
            let i = interfaces
                .iter()
                .find(|i| i.interface_id == id && i.scan_eligible && !i.is_vpn_or_virtual)
                .ok_or("POLICY_REFUSED")?;
            selected.push(i.clone());
        }
    } else {
        selected.extend(
            interfaces
                .iter()
                .filter(|i| i.scan_eligible && !i.is_vpn_or_virtual)
                .take(2)
                .cloned(),
        );
    }
    let groups = input["port_groups"].as_array().ok_or("INVALID_INPUT")?;
    if groups.is_empty() || groups.len() > 3 {
        return Err("POLICY_REFUSED".into());
    }
    let mut unique = BTreeSet::new();
    let mut ports = BTreeSet::new();
    for group in groups {
        let name = group.as_str().ok_or("INVALID_INPUT")?;
        if !unique.insert(name) {
            return Err("POLICY_REFUSED".into());
        }
        let allowed = contracts::shared().network["port_groups"][name]
            .as_array()
            .ok_or("POLICY_REFUSED")?;
        for p in allowed {
            let p = p.as_u64().ok_or("POLICY_REFUSED")? as u16;
            if !PORTS.contains(&p) {
                return Err("POLICY_REFUSED".into());
            }
            ports.insert(p);
        }
    }
    Ok((selected, ports.into_iter().collect()))
}
pub fn sweep<C: Connector>(
    input: &Value,
    interfaces: &[Interface],
    state: &mut DiscoveryState,
    permit: &SupportPermit,
    connector: &C,
) -> Result<Value, String> {
    let (selected, ports) = parameters(input, interfaces)?;
    if state.scans >= 5
        || state
            .last_scan
            .is_some_and(|t| t.elapsed() < Duration::from_secs(120))
    {
        return Err("RATE_LIMITED".into());
    }
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    state.scans += 1;
    state.last_scan = Some(Instant::now());
    let deadline = Instant::now() + Duration::from_secs(15);
    let vendors = connector.arp_vendors(deadline, permit);
    let all = selected.iter().flat_map(hosts).collect::<BTreeSet<_>>();
    let cap = all.len() > 100;
    let targets = all.into_iter().take(100).collect::<Vec<_>>();
    let next = AtomicUsize::new(0);
    let started = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..32.min(targets.len()) {
            let targets = &targets;
            let ports = &ports;
            let next = &next;
            let started = &started;
            let results = &results;
            let vendors = &vendors;
            scope.spawn(move || loop {
                if permit.is_cancelled() || Instant::now() >= deadline { break; }
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(ip) = targets.get(index).copied() else { break; };
                if permit.is_cancelled() { break; }
                started.fetch_add(1, Ordering::Relaxed);
                let at = Instant::now();
                let host_deadline = (at + Duration::from_millis(500)).min(deadline);
                let mut open = Vec::new();
                let mut mat = false;
                for port in ports {
                    if permit.is_cancelled() || Instant::now() >= host_deadline { break; }
                    let reply = connector.probe(ip, *port, host_deadline, permit);
                    if reply.open { open.push(*port); mat |= reply.mat_ecr; }
                }
                if !open.is_empty() {
                    let name = if input["include_mdns"] == true && !permit.is_cancelled() && Instant::now() < host_deadline {
                        connector.mdns_name(ip, host_deadline, permit)
                    } else { None };
                    let device = json!({"ip":ip.to_string(),"open_ports":open,"rtt_ms":at.elapsed().as_millis(),"mdns_name":name,"mdns_service":null,"mac_vendor":vendors.get(&ip),"protocol_guess":if mat {"mat_ecr"} else {guess(open[0])},"matches_configured_device":null});
                    results.lock().unwrap_or_else(|e| e.into_inner()).push(device);
                }
            });
        }
    });
    let mut devices = results.into_inner().map_err(|_| "INTERNAL_ERROR")?;
    devices.sort_by(|a, b| a["ip"].as_str().cmp(&b["ip"].as_str()));
    for d in &devices {
        for port in d["open_ports"].as_array().ok_or("INTERNAL_ERROR")? {
            state.scanned.insert((
                d["ip"].as_str().ok_or("INTERNAL_ERROR")?.into(),
                port.as_u64().ok_or("INTERNAL_ERROR")? as u16,
            ));
        }
    }
    let subnets = selected
        .iter()
        .filter_map(|i| {
            i.ipv4
                .iter()
                .find(|a| info::private(a.address) && a.prefix_length <= 30)
        })
        .map(|a| {
            let prefix = a.prefix_length.max(24);
            format!(
                "{}/{}",
                Ipv4Addr::from(u32::from(a.address) & (u32::MAX << (32 - prefix))),
                prefix
            )
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"scan_id":uuid::Uuid::new_v4().to_string(),"parameters":{"interfaces":selected.iter().map(|i|&i.interface_id).collect::<Vec<_>>(),"subnets":subnets,"ports":ports,"per_host_timeout_ms":500,"concurrency":32,"deadline_ms":15000,"result_cap":100,"port_allowlist_version":1,"include_mdns":input["include_mdns"]==true},"devices":devices,"hosts_probed":started.load(Ordering::Relaxed),"stopped":if permit.is_cancelled(){Some("critical_operation")}else if Instant::now()>=deadline{Some("deadline")}else if cap{Some("result_cap")}else{None},"interfaces_note":"Optional mDNS host labels are fully redacted; vendors use only cached ARP entries and the offline OUI set. Missing evidence remains null."}),
    )
}
pub fn guess(port: u16) -> &'static str {
    match port {
        9100 => "raw_9100",
        515 => "lpd",
        631 => "ipp",
        20007 => "zvt",
        10009 => "pax",
        9101 => "rbs_elio",
        _ => "unknown",
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    struct Evidence {
        names: AtomicUsize,
    }
    impl Connector for Evidence {
        fn probe(
            &self,
            _ip: Ipv4Addr,
            _port: u16,
            _deadline: Instant,
            _permit: &SupportPermit,
        ) -> Reply {
            Reply {
                open: true,
                mat_ecr: false,
            }
        }
        fn arp_vendors(
            &self,
            _deadline: Instant,
            _permit: &SupportPermit,
        ) -> BTreeMap<Ipv4Addr, String> {
            [(Ipv4Addr::new(192, 168, 1, 2), "Star Micronics".into())]
                .into_iter()
                .collect()
        }
        fn mdns_name(
            &self,
            _ip: Ipv4Addr,
            deadline: Instant,
            permit: &SupportPermit,
        ) -> Option<Value> {
            assert!(!permit.is_cancelled());
            assert!(
                deadline.saturating_duration_since(Instant::now()) <= Duration::from_millis(500)
            );
            self.names.fetch_add(1, Ordering::Relaxed);
            Some(crate::support::redaction::text(
                crate::support::redaction::MARKER,
            ))
        }
    }
    #[test]
    fn optional_names_and_arp_vendors_are_inside_the_scan_bounds() {
        let _test_gate = crate::support::critical_op::install_test_gate();
        let interface = Interface {
            interface_id: "3".into(),
            name: json!({}),
            kind: "ethernet".into(),
            ipv4: vec![info::Address {
                address: Ipv4Addr::new(192, 168, 1, 1),
                prefix_length: 30,
            }],
            gateway: None,
            dns: vec![],
            is_vpn_or_virtual: false,
            scan_eligible: true,
        };
        for include in [false, true] {
            let gate = crate::support::critical_op::CriticalOpGate::new();
            let permit = gate.try_begin_support(false, None).unwrap();
            let evidence = Evidence {
                names: AtomicUsize::new(0),
            };
            let result = sweep(
                &json!({"port_groups":["printers"],"include_mdns":include}),
                &[interface.clone()],
                &mut DiscoveryState::default(),
                &permit,
                &evidence,
            )
            .unwrap();
            assert_eq!(result["hosts_probed"], 1);
            assert_eq!(result["devices"][0]["mac_vendor"], "Star Micronics");
            assert_eq!(
                evidence.names.load(Ordering::Relaxed),
                if include { 1 } else { 0 }
            );
            assert_eq!(result["devices"][0]["mdns_name"].is_null(), !include);
            assert_eq!(result["parameters"]["include_mdns"], include);
        }
    }
}
