use super::super::{contracts, critical_op::SupportPermit, redaction};
use super::{info, scan, DiscoveryState};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};
pub fn request(
    input: &Value,
    state: &DiscoveryState,
    configured: &[(String, u16)],
) -> Result<(Ipv4Addr, u16, String, Vec<u8>), String> {
    let ip: Ipv4Addr = input["ip"]
        .as_str()
        .ok_or("INVALID_INPUT")?
        .parse()
        .map_err(|_| "POLICY_REFUSED")?;
    let port = u16::try_from(input["port"].as_u64().ok_or("INVALID_INPUT")?)
        .map_err(|_| "POLICY_REFUSED")?;
    if !info::private(ip)
        || !scan::PORTS.contains(&port)
        || !(state
            .scanned
            .iter()
            .any(|(known, _)| known == &ip.to_string())
            || configured.iter().any(|(known, _)| known == &ip.to_string()))
    {
        return Err("POLICY_REFUSED".into());
    }
    let probe = input["probe"].as_str().unwrap_or(match port {
        80 => "cap_mat_ecr_head",
        10009 => "pax_a00",
        20007 => "zvt_status_enquiry",
        9101 => "datecs_status",
        _ => return Err("POLICY_REFUSED".into()),
    });
    let catalogue = &contracts::shared().probes["catalogue"][probe];
    if catalogue.is_null() {
        return Err("POLICY_REFUSED".into());
    }
    if catalogue["port"]
        .as_u64()
        .is_some_and(|p| p != u64::from(port))
        || probe == "datecs_status" && port != 9101
    {
        return Err("POLICY_REFUSED".into());
    }
    let bytes = if probe == "cap_mat_ecr_head" {
        scan::head_request(ip)
    } else if probe == "printer_web_brand" {
        catalogue["requestTemplate"]
            .as_str()
            .ok_or("POLICY_REFUSED")?
            .replace("{host}", &ip.to_string())
            .into_bytes()
    } else {
        catalogue["messageBytes"]
            .as_array()
            .ok_or("POLICY_REFUSED")?
            .iter()
            .map(|n| {
                n.as_u64()
                    .and_then(|n| u8::try_from(n).ok())
                    .ok_or("POLICY_REFUSED")
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok((ip, port, probe.into(), bytes))
}
pub fn identify(
    input: &Value,
    state: &mut DiscoveryState,
    configured: &[(String, u16)],
    permit: &SupportPermit,
) -> Result<Value, String> {
    identify_with(input, state, configured, permit, exchange)
}

#[derive(Default)]
pub(crate) struct ProbeReply {
    pub reachable: bool,
    pub response_ms: Option<u128>,
    pub timed_out: bool,
    pub bytes: Vec<u8>,
}

/// Runs catalogue validation, rate/cancellation checks and the real projection;
/// an injected exchange never bypasses the read-only probe policy.
pub(crate) fn identify_with(
    input: &Value,
    state: &mut DiscoveryState,
    configured: &[(String, u16)],
    permit: &SupportPermit,
    transport: impl FnOnce(
        Ipv4Addr,
        u16,
        &str,
        &[u8],
        Instant,
        &SupportPermit,
    ) -> Result<ProbeReply, String>,
) -> Result<Value, String> {
    let (ip, port, probe, bytes) = request(input, state, configured)?;
    let now = Instant::now();
    if state.probes.len() >= 50
        || state
            .probes
            .iter()
            .filter(|t| now.duration_since(**t) < Duration::from_secs(60))
            .count()
            >= 10
    {
        return Err("RATE_LIMITED".into());
    }
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    state.probes.push(now);
    let deadline = now + Duration::from_secs(3);
    let mut output = json!({"probe":probe,"probe_status":"no_answer","reachable":false,"response_ms":null,"device_kind_guess":"unknown","brand":null,"model":null,"firmware":null,"serial":null,"protocol_guess":null});
    let reply = transport(ip, port, &probe, &bytes, deadline, permit)?;
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    if reply.bytes.len() > 12288 {
        return Err("RESULT_TOO_LARGE".into());
    }
    output["reachable"] = json!(reply.reachable);
    output["response_ms"] = json!(reply.response_ms);
    if reply.timed_out {
        output["probe_status"] = json!("timeout");
    }
    let response = reply.bytes;
    let header_end = response.windows(4).position(|b| b == b"\r\n\r\n");
    if probe == "cap_mat_ecr_head" && scan::mat_head(&response) {
        output["probe_status"] = json!("ok");
        output["device_kind_guess"] = json!("cash_register");
        output["protocol_guess"] = json!("mat_ecr");
    } else if probe == "printer_web_brand" && header_end.is_some() {
        let text = String::from_utf8_lossy(&response).to_ascii_lowercase();
        let brand = if text.contains("star") || text.contains("mc-print") {
            Some("Star")
        } else if text.contains("epson") {
            Some("Epson")
        } else if text.contains("bixolon") {
            Some("Bixolon")
        } else {
            None
        };
        if let Some(brand) = brand {
            output["brand"] = redaction::text(brand);
            output["probe_status"] = json!("ok");
            output["device_kind_guess"] = json!("printer");
            output["protocol_guess"] = json!("http");
        }
    }
    if let Some(fields) = parse_binary(&probe, &bytes, &response) {
        for (key, value) in fields.as_object().ok_or("INTERNAL_ERROR")? {
            output[key] = value.clone();
        }
    }
    Ok(output)
}

fn exchange(
    ip: Ipv4Addr,
    port: u16,
    probe: &str,
    bytes: &[u8],
    deadline: Instant,
    permit: &SupportPermit,
) -> Result<ProbeReply, String> {
    let now = Instant::now();
    // Short connect/read slices make cancellation observable during a probe;
    // no protocol's connect/login/test-payment routines are called.
    let mut socket = loop {
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        match TcpStream::connect_timeout(
            &SocketAddr::from((ip, port)),
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(50))
                .max(Duration::from_millis(1)),
        ) {
            Ok(s) => break s,
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut && Instant::now() < deadline => {
                continue
            }
            Err(_) => return Ok(ProbeReply::default()),
        }
    };
    let _ = socket.set_write_timeout(Some(Duration::from_millis(50)));
    let _ = socket.set_read_timeout(Some(Duration::from_millis(50)));
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    if socket.write_all(&bytes).is_err() {
        return Ok(ProbeReply {
            reachable: true,
            ..ProbeReply::default()
        });
    }
    let mut response = Vec::new();
    let mut header_end = None;
    while Instant::now() < deadline && response.len() < 12288 {
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let _ = socket.set_read_timeout(Some(remaining.min(Duration::from_millis(50))));
        let mut byte = [0];
        match socket.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => response.push(byte[0]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => break,
        }
        if response.ends_with(b"\r\n\r\n") {
            header_end = Some(response.len());
            if probe == "cap_mat_ecr_head" {
                break;
            }
        }
        if header_end.is_some_and(|n| response.len() >= n + 4096)
            || (header_end.is_none() && response.len() >= 8192)
        {
            break;
        }
        if port != 80 && response.len() >= 4096 {
            break;
        }
        let complete = match probe {
            "pax_a00" => response
                .iter()
                .rposition(|b| *b == 3)
                .is_some_and(|end| end + 1 < response.len()),
            "datecs_status" => response.len() >= 7 && response.last() == Some(&3),
            "zvt_status_enquiry" => response
                .windows(2)
                .position(|b| b == [16, 3])
                .is_some_and(|end| end + 4 <= response.len()),
            _ => false,
        };
        if complete {
            break;
        }
    }
    Ok(ProbeReply {
        reachable: true,
        response_ms: Some(now.elapsed().as_millis()),
        timed_out: Instant::now() >= deadline,
        bytes: response,
    })
}

// Reuse installed protocol parsers without allowing them to access a device.
// The transport below only returns already received bytes; even an accidental
// login/payment/settlement call fails unless its request equals the catalogue.
struct ResponseOnly {
    expected: Vec<u8>,
    response: Option<Vec<u8>>,
    sent: bool,
}
impl crate::ecr::transport::EcrTransport for ResponseOnly {
    fn connect(&mut self) -> Result<(), String> {
        Err("POLICY_REFUSED".into())
    }
    fn disconnect(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn send(&mut self, data: &[u8]) -> Result<usize, String> {
        if self.sent || data != self.expected {
            return Err("POLICY_REFUSED".into());
        }
        self.sent = true;
        Ok(data.len())
    }
    fn receive(&mut self, _: u64) -> Result<Vec<u8>, String> {
        if !self.sent {
            return Err("POLICY_REFUSED".into());
        }
        self.response.take().ok_or("POLICY_REFUSED".into())
    }
    fn is_connected(&self) -> bool {
        false
    }
    fn state(&self) -> crate::ecr::transport::TransportState {
        crate::ecr::transport::TransportState::Disconnected
    }
    fn description(&self) -> String {
        "support response parser".into()
    }
}
pub fn parse_binary(probe: &str, expected: &[u8], response: &[u8]) -> Option<Value> {
    use crate::ecr::{
        protocol::EcrProtocol,
        protocols::{generic_fiscal::GenericEscPosFiscal, pax::PaxProtocol, zvt::ZvtProtocol},
    };
    if response.is_empty() || response.len() > 4096 {
        return None;
    }
    let transport = Box::new(ResponseOnly {
        expected: expected.to_vec(),
        response: Some(response.to_vec()),
        sent: false,
    });
    let config = json!({});
    let (mut protocol, kind, brand, guess): (Box<dyn EcrProtocol>, &str, Option<&str>, &str) =
        match probe {
            "pax_a00" => (
                Box::new(PaxProtocol::new(transport, &config)),
                "card_terminal",
                Some("PAX"),
                "pax",
            ),
            "datecs_status" => (
                Box::new(GenericEscPosFiscal::new(transport, &config)),
                "cash_register",
                None,
                "rbs_elio",
            ),
            "zvt_status_enquiry" => (
                Box::new(ZvtProtocol::new(transport, &config)),
                "card_terminal",
                None,
                "zvt",
            ),
            _ => return None,
        };
    let status = protocol.get_status().ok()?;
    if !status.ready {
        return None;
    }
    let field = |text: String| {
        let text: String = text.chars().filter(|c| !c.is_control()).take(64).collect();
        redaction::text(&text)
    };
    Some(
        json!({"probe_status":"ok","device_kind_guess":kind,"brand":brand.map(redaction::text),"firmware":status.firmware_version.filter(|s|!s.is_empty()).map(field),"serial":status.serial_number.filter(|s|!s.is_empty()).map(field),"protocol_guess":guess}),
    )
}
