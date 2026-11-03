//! Optional LAN evidence, confined to the scan's deadline. No name service or
//! vendor service on the internet is contacted; full MACs never leave here.
use super::super::{critical_op::SupportPermit, redaction};
use std::{
    collections::BTreeMap,
    net::{Ipv4Addr, SocketAddr, UdpSocket},
    time::{Duration, Instant},
};

fn dns_name(bytes: &[u8], cursor: &mut usize, depth: usize) -> Option<String> {
    if depth > 16 {
        return None;
    }
    let mut labels = Vec::new();
    for _ in 0..64 {
        let size = *bytes.get(*cursor)? as usize;
        *cursor += 1;
        if size == 0 {
            return Some(labels.join("."));
        }
        if size & 0xc0 == 0xc0 {
            let offset = ((size & 0x3f) << 8) | *bytes.get(*cursor)? as usize;
            *cursor += 1;
            let mut pointed = offset;
            labels.push(dns_name(bytes, &mut pointed, depth + 1)?);
            return Some(labels.join("."));
        }
        if size > 63 {
            return None;
        }
        let label = std::str::from_utf8(bytes.get(*cursor..*cursor + size)?).ok()?;
        if !label.chars().all(|c| c.is_ascii_graphic()) {
            return None;
        }
        labels.push(label.to_string());
        *cursor += size;
    }
    None
}
fn reverse(ip: Ipv4Addr) -> String {
    let [a, b, c, d] = ip.octets();
    format!("{d}.{c}.{b}.{a}.in-addr.arpa")
}
fn mdns_query(ip: Ipv4Addr) -> Vec<u8> {
    let mut bytes = vec![0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in reverse(ip).split('.') {
        bytes.push(label.len() as u8);
        bytes.extend_from_slice(label.as_bytes());
    }
    // PTR, IN with QU (reply by unicast to this ephemeral socket).
    bytes.extend_from_slice(&[0, 0, 12, 0x80, 1]);
    bytes
}
fn mdns_reply(bytes: &[u8], ip: Ipv4Addr) -> Option<serde_json::Value> {
    if bytes.len() < 12 || bytes[2] & 0x80 == 0 {
        return None;
    }
    let number = |at| u16::from_be_bytes([bytes[at], bytes[at + 1]]) as usize;
    let questions = number(4);
    let records = number(6) + number(8) + number(10);
    if questions > 16 || records > 128 {
        return None;
    }
    let mut at = 12;
    for _ in 0..questions {
        dns_name(bytes, &mut at, 0)?;
        at = at.checked_add(4)?;
    }
    for _ in 0..records {
        let owner = dns_name(bytes, &mut at, 0)?;
        let header = bytes.get(at..at + 10)?;
        let kind = u16::from_be_bytes([header[0], header[1]]);
        let len = u16::from_be_bytes([header[8], header[9]]) as usize;
        at += 10;
        let end = at.checked_add(len)?;
        bytes.get(at..end)?;
        if kind == 12 && owner.eq_ignore_ascii_case(&reverse(ip)) {
            let mut name_at = at;
            let name = dns_name(bytes, &mut name_at, 0)?;
            if name_at > end || !name.to_ascii_lowercase().ends_with(".local") {
                return None;
            }
            // Host labels may contain a person's name; retain only a redacted
            // presence marker. Even unrecognised personal names stay private.
            return Some(redaction::text(redaction::MARKER));
        }
        at = end;
    }
    None
}
pub(super) fn mdns_name(
    ip: Ipv4Addr,
    deadline: Instant,
    permit: &SupportPermit,
) -> Option<serde_json::Value> {
    if !super::info::private(ip) || permit.is_cancelled() || Instant::now() >= deadline {
        return None;
    }
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(SocketAddr::from((ip, 5353))).ok()?;
    socket
        .set_write_timeout(Some(Duration::from_millis(10)))
        .ok()?;
    if permit.is_cancelled() || Instant::now() >= deadline {
        return None;
    }
    socket.send(&mdns_query(ip)).ok()?;
    let deadline = deadline.min(Instant::now() + Duration::from_millis(50));
    let mut bytes = [0u8; 4096];
    while !permit.is_cancelled() && Instant::now() < deadline {
        socket
            .set_read_timeout(Some(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(10))
                    .max(Duration::from_millis(1)),
            ))
            .ok()?;
        match socket.recv(&mut bytes) {
            Ok(n) => return mdns_reply(&bytes[..n], ip),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(_) => return None,
        }
    }
    None
}

fn vendor(mac: &str) -> Option<&'static str> {
    let mac = mac.replace('-', ":").to_ascii_uppercase();
    // Small offline OUI set. Unknown or locally administered addresses have no
    // vendor claim. Never infer a vendor from a hostname or a protocol reply.
    let parts = mac.split(':').collect::<Vec<_>>();
    if parts.len() != 6
        || parts
            .iter()
            .any(|p| p.len() != 2 || u8::from_str_radix(p, 16).is_err())
    {
        return None;
    }
    let first = u8::from_str_radix(mac.get(..2)?, 16).ok()?;
    if first & 3 != 0 {
        return None;
    }
    match mac.get(..8)? {
        "00:11:62" => Some("Star Micronics"),
        "00:26:AB" => Some("Seiko Epson"),
        "B8:27:EB" => Some("Raspberry Pi Foundation"),
        "DC:A6:32" => Some("Raspberry Pi Trading"),
        _ => None,
    }
}
fn arp_rows(output: &str) -> BTreeMap<Ipv4Addr, String> {
    output
        .lines()
        .take(2048)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let ip = fields.next()?.parse::<Ipv4Addr>().ok()?;
            if !super::info::private(ip) {
                return None;
            }
            let mac = fields.next()?;
            if mac.len() != 17 {
                return None;
            }
            Some((ip, vendor(mac)?.to_string()))
        })
        .collect()
}
pub(super) fn arp_vendors(deadline: Instant, permit: &SupportPermit) -> BTreeMap<Ipv4Addr, String> {
    #[cfg(not(windows))]
    {
        let _ = (deadline, permit);
        BTreeMap::new()
    }
    #[cfg(windows)]
    {
        use std::{
            io::Read,
            os::windows::process::CommandExt,
            process::{Command, Stdio},
        };
        if permit.is_cancelled() || Instant::now() >= deadline {
            return BTreeMap::new();
        }
        let executable = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| r"C:\Windows".into())
            .join("System32/arp.exe");
        let Ok(mut child) = Command::new(executable)
            .arg("-a")
            .creation_flags(0x08000000)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            return BTreeMap::new();
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return BTreeMap::new();
        };
        let read = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stdout.take(64 * 1024).read_to_end(&mut bytes);
            bytes
        });
        let deadline = deadline.min(Instant::now() + Duration::from_millis(250));
        let mut success = false;
        loop {
            if permit.is_cancelled() || Instant::now() >= deadline {
                let _ = child.kill();
                break;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    success = status.success();
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(_) => {
                    let _ = child.kill();
                    break;
                }
            }
        }
        let _ = child.wait();
        let bytes = read.join().unwrap_or_default();
        if !success || bytes.len() == 64 * 1024 {
            return BTreeMap::new();
        }
        arp_rows(&String::from_utf8_lossy(&bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arp_only_recognises_vendor_without_exporting_mac_or_hostnames() {
        let rows = arp_rows("192.168.1.2 00-11-62-12-34-56 dynamic\n192.168.1.3 02-11-62-12-34-56 dynamic\n8.8.8.8 00-11-62-12-34-56 dynamic");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[&"192.168.1.2".parse::<Ipv4Addr>().unwrap()],
            "Star Micronics"
        );
        assert!(!serde_json::to_string(&rows).unwrap().contains("12-34-56"));
    }
    #[test]
    fn mdns_reverse_ptr_is_redacted_and_pointer_cycles_are_rejected() {
        let ip = Ipv4Addr::new(192, 168, 1, 2);
        let mut reply = mdns_query(ip);
        reply[2] = 0x84;
        reply[7] = 1;
        reply.extend_from_slice(&[0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 1, 0, 21]);
        reply.extend_from_slice(b"\x0dPrivatePerson\x05local\0");
        let result = mdns_reply(&reply, ip).unwrap();
        assert!(!result.to_string().contains("PrivatePerson"));
        let mut at = 0;
        assert!(dns_name(&[0xc0, 0], &mut at, 0).is_none());
        assert!(mdns_reply(&reply[..16], ip).is_none());
    }
}
