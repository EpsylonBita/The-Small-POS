use crate::support::{
    critical_op::{CriticalKind, CriticalOpGate, SupportPermit},
    network::{
        info::{self, Address, Interface},
        scan::{self, Connector, Reply},
        DiscoveryState,
    },
};
use serde_json::json;
use std::{
    net::Ipv4Addr,
    sync::{Arc, Mutex},
    time::Instant,
};
fn interface() -> Interface {
    Interface {
        interface_id: "3".into(),
        name: json!({"value":"Ethernet"}),
        kind: "ethernet".into(),
        ipv4: vec![Address {
            address: "192.168.1.130".parse().unwrap(),
            prefix_length: 25,
        }],
        gateway: None,
        dns: vec![],
        is_vpn_or_virtual: false,
        scan_eligible: true,
    }
}
struct Fake {
    calls: Mutex<Vec<(Ipv4Addr, u16)>>,
    cancel: Option<Arc<CriticalOpGate>>,
}
impl Connector for Fake {
    fn probe(&self, ip: Ipv4Addr, port: u16, _: Instant, _: &SupportPermit) -> Reply {
        self.calls.lock().unwrap().push((ip, port));
        if let Some(gate) = &self.cancel {
            let _sale = gate.begin_critical(CriticalKind::Checkout);
        }
        Reply {
            open: true,
            mat_ecr: port == 80,
        }
    }
}
#[test]
fn refuses_hostile_ranges_ports_and_interfaces_before_any_connection() {
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let fake = Fake {
        calls: Mutex::default(),
        cancel: None,
    };
    for input in [
        json!({"port_groups":["internet"]}),
        json!({"port_groups":["printers"],"ip":"8.8.8.8"}),
        json!({"port_groups":["printers"],"subnet":"::/0"}),
        json!({"port_groups":["printers"],"ports":[22]}),
        json!({"port_groups":["printers"],"interfaces":["vpn"]}),
        json!({"port_groups":["printers","printers"]}),
    ] {
        assert!(scan::sweep(
            &input,
            &[interface()],
            &mut DiscoveryState::default(),
            &permit,
            &fake
        )
        .is_err());
    }
    assert!(fake.calls.lock().unwrap().is_empty());
}
#[test]
fn sweep_keeps_own_narrower_subnet_groups_and_host_cap() {
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let fake = Fake {
        calls: Mutex::default(),
        cancel: None,
    };
    let result = scan::sweep(
        &json!({"port_groups":["printers"]}),
        &[interface()],
        &mut DiscoveryState::default(),
        &permit,
        &fake,
    )
    .unwrap();
    assert_eq!(result["hosts_probed"], 100);
    for (ip, port) in fake.calls.lock().unwrap().iter() {
        assert_eq!(ip.octets()[..3], [192, 168, 1]);
        assert!(ip.octets()[3] > 128 && ip.octets()[3] < 255);
        assert!([9100, 515, 631].contains(port));
    }
    assert_eq!(result["stopped"], "result_cap");
}
#[test]
fn critical_start_stops_connections_and_virtual_filters_are_conservative() {
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let fake = Fake {
        calls: Mutex::default(),
        cancel: Some(gate),
    };
    let result = scan::sweep(
        &json!({"port_groups":["cash_registers"]}),
        &[interface()],
        &mut DiscoveryState::default(),
        &permit,
        &fake,
    )
    .unwrap();
    assert_eq!(result["stopped"], "critical_operation");
    assert!(fake.calls.lock().unwrap().len() <= 32);
    for name in ["VPN", "Docker", "vEthernet", "Tailscale", "Loopback", "WSL"] {
        assert!(info::excluded(name));
    }
    for ip in ["8.8.8.8", "127.0.0.1", "169.254.1.1"] {
        assert!(!info::private(ip.parse().unwrap()));
    }
}
#[test]
fn cap_head_requires_complete_success_header_and_exact_server() {
    assert!(scan::mat_head(
        b"HTTP/1.1 200 OK\r\nServer: MAT_ECR_SERVER\r\n\r\n"
    ));
    for bytes in [
        &b"HTTP/1.1 302 Found\r\nServer: MAT_ECR_SERVER\r\n\r\n"[..],
        &b"HTTP/1.1 200 OK\r\nServer: nginx\r\n\r\n"[..],
        &b"HTTP/1.1 200 OK\r\nServer: MAT_ECR_SERVER-extra\r\n\r\n"[..],
    ] {
        assert!(!scan::mat_head(bytes));
    }
}

#[test]
fn actual_cash_register_request_is_head_only() {
    let bytes = scan::head_request("192.168.1.19".parse().unwrap());
    assert_eq!(
        std::str::from_utf8(&bytes).unwrap(),
        "HEAD / HTTP/1.1\r\nHost: 192.168.1.19\r\nConnection: close\r\n\r\n"
    );
    assert!(!bytes.windows(3).any(|b| b == b"GET"));
}
