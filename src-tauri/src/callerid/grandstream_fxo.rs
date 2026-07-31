//! Grandstream FXO event-only connector.
//!
//! This module intentionally implements no SIP registration, authentication,
//! call establishment, media, or organization-wide event channel. The legacy
//! UDP parser is available only for server-authorized founder-pilot sources.
//! Missing, ordinary, or unknown authorization remains fail-closed.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tauri::Manager;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use super::manager::CallerIdManager;
use super::types::CallerIdConnectorFamily;
use super::types::{CallerIdSourceConfig, CallerIdStatusReason};

const MAX_SIP_PACKET_BYTES: usize = 8 * 1024;
const MAX_CALL_ID_BYTES: usize = 255;
const DEFAULT_SIP_PORT: u16 = 5060;
const FXO_DESTINATION_USER: &str = "callerid";
const CONFIG_POLL_INTERVAL: Duration = Duration::from_secs(2);
const RECENT_CALL_TTL: Duration = Duration::from_secs(120);
const RECENT_CALL_CAPACITY: usize = 512;
const EVENT_RATE_LIMIT: usize = 20;
const EVENT_RATE_WINDOW: Duration = Duration::from_secs(60);
const PACKET_RATE_PER_WINDOW: usize = 120;
const PACKET_BURST_CAPACITY: usize = 30;
const PACKET_RATE_WINDOW: Duration = Duration::from_secs(60);
const EVENT_QUEUE_CAPACITY: usize = 32;
const EVENT_POST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrandstreamFxoSourceLine {
    pub source: CallerIdSourceConfig,
    pub name: String,
    pub line_version: u64,
    pub readiness_attempt: Option<ReadinessAttempt>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadinessAttempt {
    pub attempt_id: Uuid,
    pub line_version: u64,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Presentation {
    Allowed,
    Restricted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedInvite {
    pub caller_number: Option<String>,
    pub presentation: Presentation,
    pub provider_event_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceLineWire {
    id: String,
    name: String,
    adapter_type: String,
    source_id: String,
    source_version: u32,
    device_profile_key: String,
    connector_family: CallerIdConnectorFamily,
    source_channel: String,
    version: u64,
    is_receiving_target: bool,
    config: GrandstreamFxoConfigWire,
    credential_version: Option<u64>,
    credentials: Option<Value>,
    readiness_attempt: Option<ReadinessAttemptWire>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrandstreamFxoConfigWire {
    preset_id: String,
    mode: String,
    transport: String,
    trusted_device_ip: String,
    listen_port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadinessAttemptWire {
    attempt_id: String,
    line_version: u64,
    expires_at: String,
}

fn reviewed_profile_capacity(profile_key: &str) -> Option<usize> {
    match profile_key {
        "grandstream_ht813_fxo" => Some(1),
        "grandstream_ht841_fxo" => Some(4),
        "grandstream_ht881_fxo" => Some(8),
        _ => None,
    }
}

fn parse_source_line(value: &Value) -> Result<GrandstreamFxoSourceLine, String> {
    let wire: SourceLineWire = serde_json::from_value(value.clone())
        .map_err(|_| "Caller ID source line has an invalid shape".to_string())?;
    let source_channel = wire.source_channel.trim();
    if wire.adapter_type != "generic_sip"
        || reviewed_profile_capacity(&wire.device_profile_key).is_none()
        || wire.config.preset_id != wire.device_profile_key
        || wire.connector_family != CallerIdConnectorFamily::AnalogFxo
        || wire.config.mode != "pbx_ip_trust"
        || wire.config.transport != "udp"
        || wire.source_version == 0
        || wire.version == 0
        || wire.name.trim().is_empty()
        || wire.name.chars().count() > 120
        || source_channel.is_empty()
        || source_channel.chars().count() > 80
        || wire.credential_version.is_some()
        || wire.credentials.is_some()
    {
        return Err("Caller ID source line is not a reviewed Grandstream FXO configuration".into());
    }

    // Receiving on the source terminal is optional. Reading the server-owned
    // flag here makes the strict wire contract reject omitted/mistyped data
    // without coupling connector activation to the terminal also being a
    // display target.
    let _is_receiving_target = wire.is_receiving_target;
    if !(1024..=u16::MAX).contains(&wire.config.listen_port) {
        return Err("Grandstream FXO listen port must be between 1024 and 65535".into());
    }
    let trusted_device_ip = wire
        .config
        .trusted_device_ip
        .parse::<Ipv4Addr>()
        .map_err(|_| "Grandstream FXO trusted device must be an IPv4 address".to_string())?;
    if !trusted_device_ip.is_private()
        || trusted_device_ip.is_loopback()
        || trusted_device_ip.is_unspecified()
        || trusted_device_ip.is_multicast()
        || trusted_device_ip == Ipv4Addr::BROADCAST
        || matches!(trusted_device_ip.octets()[3], 0 | 255)
    {
        return Err("Grandstream FXO trusted device must be a private RFC1918 IPv4 address".into());
    }
    let readiness_attempt = wire
        .readiness_attempt
        .map(|attempt| {
            if attempt.line_version != wire.version {
                return Err(
                    "Caller ID readiness attempt does not match the line version".to_string(),
                );
            }
            Ok(ReadinessAttempt {
                attempt_id: Uuid::parse_str(&attempt.attempt_id)
                    .map_err(|_| "Caller ID readiness attempt ID must be a UUID".to_string())?,
                line_version: attempt.line_version,
                expires_at: DateTime::parse_from_rfc3339(&attempt.expires_at)
                    .map_err(|_| "Caller ID readiness expiry is invalid".to_string())?
                    .with_timezone(&Utc),
            })
        })
        .transpose()?;

    Ok(GrandstreamFxoSourceLine {
        source: CallerIdSourceConfig {
            source_id: Uuid::parse_str(&wire.source_id)
                .map_err(|_| "Caller ID source ID must be a UUID".to_string())?,
            source_version: wire.source_version,
            device_profile_key: wire.device_profile_key,
            connector_family: wire.connector_family,
            line_id: Uuid::parse_str(&wire.id)
                .map_err(|_| "Caller ID source line ID must be a UUID".to_string())?,
            source_channel: source_channel.to_string(),
            trusted_device_ip: IpAddr::V4(trusted_device_ip),
            listen_port: wire.config.listen_port,
        },
        name: wire.name.trim().to_string(),
        line_version: wire.version,
        readiness_attempt,
    })
}

fn validate_ip_trust_source_lines(value: &Value) -> Result<Vec<GrandstreamFxoSourceLine>, String> {
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Caller ID source configuration is missing enabled state".to_string())?;
    if !enabled {
        return Ok(Vec::new());
    }
    let source_lines = value
        .get("sourceLines")
        .and_then(Value::as_array)
        .ok_or_else(|| "Caller ID source configuration is missing source lines".to_string())?;
    if source_lines.len() > 16 {
        return Err("Caller ID source configuration has too many lines".into());
    }
    let mut parsed = Vec::new();
    let mut ids = HashSet::new();
    let mut ports = HashSet::new();
    let mut source_channels = HashSet::new();
    for value in source_lines {
        let is_generic_sip = value
            .get("adapterType")
            .and_then(Value::as_str)
            .is_some_and(|adapter| adapter == "generic_sip");
        if !is_generic_sip {
            continue;
        }
        let line = parse_source_line(value)?;
        if !ids.insert(line.source.line_id) {
            return Err("Caller ID source configuration repeats a line ID".into());
        }
        if !ports.insert(line.source.listen_port) {
            return Err("Caller ID source lines cannot share a UDP listen port".into());
        }
        if !source_channels.insert((line.source.source_id, line.source.source_channel.clone())) {
            return Err("Caller ID source configuration repeats a source channel".into());
        }
        parsed.push(line);
    }
    for line in &parsed {
        let source_lines = parsed
            .iter()
            .filter(|candidate| candidate.source.source_id == line.source.source_id)
            .collect::<Vec<_>>();
        let capacity = reviewed_profile_capacity(&line.source.device_profile_key)
            .expect("parsed profiles are reviewed");
        if source_lines.len() > capacity
            || source_lines.iter().any(|candidate| {
                candidate.source.source_version != line.source.source_version
                    || candidate.source.device_profile_key != line.source.device_profile_key
                    || candidate.source.connector_family != line.source.connector_family
                    || candidate.source.trusted_device_ip != line.source.trusted_device_ip
            })
        {
            return Err("Caller ID source channels do not match one reviewed FXO source".into());
        }
    }
    Ok(parsed)
}

fn parse_runtime_source_lines(value: &Value) -> Result<Vec<GrandstreamFxoSourceLine>, String> {
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Caller ID source configuration is missing enabled state".to_string())?;
    if !enabled {
        return Ok(Vec::new());
    }
    let source_lines = value
        .get("sourceLines")
        .and_then(Value::as_array)
        .ok_or_else(|| "Caller ID source configuration is missing source lines".to_string())?;
    if source_lines.len() > 16 {
        return Err("Caller ID source configuration has too many lines".into());
    }
    let has_ip_trust_source = source_lines.iter().any(|line| {
        line.get("adapterType")
            .and_then(Value::as_str)
            .is_some_and(|adapter| adapter == "generic_sip")
    });
    if !has_ip_trust_source {
        return Ok(Vec::new());
    }
    if value.get("ipTrustSourcePolicy").and_then(Value::as_str) != Some("founder_pilot") {
        return Err(
            "Caller ID IP-trust sources require an explicit founder-pilot entitlement".into(),
        );
    }
    validate_ip_trust_source_lines(value)
}

fn requires_udp_rebind(
    current: &GrandstreamFxoSourceLine,
    desired: &GrandstreamFxoSourceLine,
) -> bool {
    current.source != desired.source
}

fn build_source_readiness_ack(
    line: &GrandstreamFxoSourceLine,
    now: DateTime<Utc>,
) -> Option<Value> {
    let attempt = line
        .readiness_attempt
        .as_ref()
        .filter(|attempt| attempt.expires_at > now)?;
    Some(serde_json::json!({
        "attemptId": attempt.attempt_id,
        "lineId": line.source.line_id,
        "lineVersion": attempt.line_version,
        "capability": "source_listener",
    }))
}

pub fn parse_invite(
    data: &[u8],
    peer: SocketAddr,
    line: &GrandstreamFxoSourceLine,
) -> Result<ParsedInvite, String> {
    if peer.ip() != line.source.trusted_device_ip {
        return Err("SIP packet did not come from the configured Grandstream FXO source".into());
    }
    if data.is_empty() || data.len() > MAX_SIP_PACKET_BYTES || data.contains(&0) {
        return Err("SIP packet size or encoding is invalid".into());
    }
    let text =
        std::str::from_utf8(data).map_err(|_| "SIP packet is not valid UTF-8".to_string())?;
    let header_end = text.find("\r\n\r\n").unwrap_or(text.len());
    let header_text = &text[..header_end];
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "SIP request line is missing".to_string())?;
    let request_parts = request_line.split_ascii_whitespace().collect::<Vec<_>>();
    if request_parts.len() != 3 || request_parts[0] != "INVITE" || request_parts[2] != "SIP/2.0" {
        return Err("Only SIP INVITE requests are accepted".into());
    }
    if request_uri_port(request_parts[1])? != line.source.listen_port {
        return Err("SIP INVITE Request-URI does not target the configured listen port".into());
    }

    let headers = lines.collect::<Vec<_>>();
    if headers
        .iter()
        .any(|line| line.len() > 2_048 || (!line.is_empty() && !line.contains(':')))
    {
        return Err("SIP header is malformed".into());
    }
    let provider_event_id = header_value(&headers, "Call-ID")
        .or_else(|| header_value(&headers, "i"))
        .ok_or_else(|| "SIP Call-ID is missing".to_string())?;
    if provider_event_id.is_empty()
        || provider_event_id.len() > MAX_CALL_ID_BYTES
        || !provider_event_id
            .bytes()
            .all(|byte| byte.is_ascii_graphic())
    {
        return Err("SIP Call-ID is invalid".into());
    }

    let identity = header_value(&headers, "P-Asserted-Identity")
        .or_else(|| header_value(&headers, "Remote-Party-ID"))
        .or_else(|| header_value(&headers, "From"))
        .or_else(|| header_value(&headers, "f"))
        .ok_or_else(|| "SIP caller identity is missing".to_string())?;
    let privacy_restricted = header_values(&headers, "Privacy")
        .into_iter()
        .any(privacy_header_restricts_identity)
        || ["P-Asserted-Identity", "Remote-Party-ID", "From", "f"]
            .into_iter()
            .flat_map(|name| header_values(&headers, name))
            .any(|value| {
                privacy_parameter_restricts_identity(value) || identity_is_private_sentinel(value)
            });
    let identity_user = identity_user(identity)?;
    let (presentation, caller_number) = if privacy_restricted {
        (Presentation::Restricted, None)
    } else {
        (
            Presentation::Allowed,
            Some(normalize_phone(&identity_user)?),
        )
    };

    Ok(ParsedInvite {
        caller_number,
        presentation,
        provider_event_id: provider_event_id.to_string(),
    })
}

pub fn build_sip_response(data: &[u8], status_code: u16) -> Result<Vec<u8>, String> {
    let reason = match status_code {
        100 => "Trying",
        486 => "Busy Here",
        _ => return Err("Unsupported event-only SIP response status".into()),
    };
    if data.is_empty() || data.len() > MAX_SIP_PACKET_BYTES || data.contains(&0) {
        return Err("SIP packet size or encoding is invalid".into());
    }
    let text =
        std::str::from_utf8(data).map_err(|_| "SIP packet is not valid UTF-8".to_string())?;
    let header_end = text.find("\r\n\r\n").unwrap_or(text.len());
    let mut lines = text[..header_end].split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "SIP request line is missing".to_string())?;
    if !request_line.starts_with("INVITE ") || !request_line.ends_with(" SIP/2.0") {
        return Err("Only SIP INVITE requests receive a response".into());
    }
    let headers = lines.collect::<Vec<_>>();
    let via_values = header_values(&headers, "Via");
    if via_values.is_empty() {
        return Err("SIP Via header is missing".into());
    }
    let from = header_value(&headers, "From")
        .or_else(|| header_value(&headers, "f"))
        .ok_or_else(|| "SIP From header is missing".to_string())?;
    let to = header_value(&headers, "To")
        .or_else(|| header_value(&headers, "t"))
        .ok_or_else(|| "SIP To header is missing".to_string())?;
    let call_id = header_value(&headers, "Call-ID")
        .or_else(|| header_value(&headers, "i"))
        .ok_or_else(|| "SIP Call-ID header is missing".to_string())?;
    let cseq =
        header_value(&headers, "CSeq").ok_or_else(|| "SIP CSeq header is missing".to_string())?;
    for value in via_values.iter().copied().chain([from, to, call_id, cseq]) {
        if value.is_empty()
            || value.len() > 2_048
            || value.bytes().any(|byte| byte == b'\r' || byte == b'\n')
        {
            return Err("SIP response header value is invalid".into());
        }
    }

    let response_to = if status_code >= 200
        && !to
            .split(';')
            .any(|parameter| parameter.trim_start().starts_with("tag="))
    {
        let call_id_digest = format!("{:x}", md5::compute(call_id.as_bytes()));
        format!("{to};tag=cid{call_id_digest}")
    } else {
        to.to_string()
    };
    let mut response = format!("SIP/2.0 {status_code} {reason}\r\n");
    for via in via_values {
        response.push_str("Via: ");
        response.push_str(via);
        response.push_str("\r\n");
    }
    response.push_str("From: ");
    response.push_str(from);
    response.push_str("\r\nTo: ");
    response.push_str(&response_to);
    response.push_str("\r\nCall-ID: ");
    response.push_str(call_id);
    response.push_str("\r\nCSeq: ");
    response.push_str(cseq);
    response.push_str("\r\nServer: TheSmallPOS-CallerID\r\nContent-Length: 0\r\n\r\n");
    Ok(response.into_bytes())
}

fn request_uri_port(uri: &str) -> Result<u16, String> {
    if uri.len() < 5 || !uri[..4].eq_ignore_ascii_case("sip:") {
        return Err("SIP INVITE Request-URI must use the sip scheme".into());
    }
    let address = uri[4..].split([';', '?']).next().unwrap_or_default();
    let (user, authority) = address
        .rsplit_once('@')
        .ok_or_else(|| "SIP INVITE Request-URI user is missing".to_string())?;
    if user != FXO_DESTINATION_USER {
        return Err("SIP INVITE Request-URI user is not the configured FXO destination".into());
    }
    if authority.is_empty() || authority.starts_with('[') {
        return Err("SIP INVITE Request-URI host is invalid".into());
    }
    let Some((host, port)) = authority.rsplit_once(':') else {
        return Ok(DEFAULT_SIP_PORT);
    };
    if host.is_empty() || host.contains(':') {
        return Err("SIP INVITE Request-URI host is invalid".into());
    }
    port.parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| "SIP INVITE Request-URI port is invalid".into())
}

fn header_value<'a>(headers: &[&'a str], name: &str) -> Option<&'a str> {
    headers.iter().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then_some(trimmed)
        } else {
            None
        }
    })
}

fn header_values<'a>(headers: &[&'a str], name: &str) -> Vec<&'a str> {
    headers
        .iter()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            if key.trim().eq_ignore_ascii_case(name) {
                let trimmed = value.trim();
                (!trimmed.is_empty()).then_some(trimmed)
            } else {
                None
            }
        })
        .collect()
}

fn is_restricted_privacy_token(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "id" | "user" | "header" | "full"
    )
}

fn privacy_header_restricts_identity(value: &str) -> bool {
    value.split([',', ';']).any(is_restricted_privacy_token)
}

fn privacy_parameter_restricts_identity(value: &str) -> bool {
    value.split(';').any(|parameter| {
        parameter
            .trim()
            .split_once('=')
            .is_some_and(|(key, value)| {
                key.trim().eq_ignore_ascii_case("privacy") && is_restricted_privacy_token(value)
            })
    })
}

fn identity_is_private_sentinel(value: &str) -> bool {
    identity_user(value).is_ok_and(|user| {
        matches!(
            user.to_ascii_lowercase().as_str(),
            "anonymous" | "restricted" | "unavailable" | "private"
        )
    })
}

fn identity_user(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let uri = if let Some(start) = trimmed.find('<') {
        let end = trimmed[start + 1..]
            .find('>')
            .map(|offset| start + 1 + offset)
            .ok_or_else(|| "SIP caller identity is malformed".to_string())?;
        &trimmed[start + 1..end]
    } else {
        trimmed.split(';').next().unwrap_or(trimmed)
    };
    let scheme_end = uri
        .find(':')
        .ok_or_else(|| "SIP caller identity URI is malformed".to_string())?;
    let scheme = &uri[..scheme_end];
    if !scheme.eq_ignore_ascii_case("sip") && !scheme.eq_ignore_ascii_case("tel") {
        return Err("SIP caller identity URI scheme is unsupported".into());
    }
    let remainder = &uri[scheme_end + 1..];
    let user = remainder
        .split('@')
        .next()
        .unwrap_or(remainder)
        .split(';')
        .next()
        .unwrap_or_default()
        .trim();
    if user.is_empty() || user.len() > 64 {
        return Err("SIP caller identity is invalid".into());
    }
    Ok(user.to_string())
}

fn normalize_phone(value: &str) -> Result<String, String> {
    let mut normalized = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_digit() || (character == '+' && normalized.is_empty()) {
            normalized.push(character);
        } else if !matches!(character, ' ' | '-' | '.' | '(' | ')') {
            return Err("SIP caller identity is not a phone number".into());
        }
    }
    let digit_count = normalized.bytes().filter(u8::is_ascii_digit).count();
    if !(3..=32).contains(&digit_count) {
        return Err("SIP caller phone number has an invalid length".into());
    }
    Ok(normalized)
}

pub struct RecentCallIds {
    capacity: usize,
    ttl: Duration,
    entries: HashMap<String, Instant>,
}

pub struct EventRateLimiter {
    limit: usize,
    window: Duration,
    accepted: VecDeque<Instant>,
}

impl EventRateLimiter {
    pub fn new(limit: usize, window: Duration) -> Self {
        Self {
            limit: limit.max(1),
            window,
            accepted: VecDeque::with_capacity(limit.max(1)),
        }
    }

    pub fn allow(&mut self, now: Instant) -> bool {
        while self
            .accepted
            .front()
            .is_some_and(|accepted| now.saturating_duration_since(*accepted) >= self.window)
        {
            self.accepted.pop_front();
        }
        if self.accepted.len() >= self.limit {
            return false;
        }
        self.accepted.push_back(now);
        true
    }
}

impl RecentCallIds {
    pub fn new(capacity: usize, ttl: Duration) -> Self {
        Self {
            capacity: capacity.max(1),
            ttl,
            entries: HashMap::new(),
        }
    }

    pub fn accept(&mut self, call_id: &str, now: Instant) -> bool {
        self.entries
            .retain(|_, seen_at| now.saturating_duration_since(*seen_at) <= self.ttl);
        if self.entries.contains_key(call_id) {
            return false;
        }
        if self.entries.len() >= self.capacity {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, seen_at)| **seen_at)
                .map(|(call_id, _)| call_id.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(call_id.to_string(), now);
        true
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

pub struct PacketTokenBucket {
    capacity: f64,
    refill_tokens: f64,
    refill_window: Duration,
    tokens: f64,
    last_refill: Instant,
}

impl PacketTokenBucket {
    pub fn new(
        capacity: usize,
        refill_tokens: usize,
        refill_window: Duration,
        now: Instant,
    ) -> Self {
        let capacity = capacity.max(1) as f64;
        Self {
            capacity,
            refill_tokens: refill_tokens.max(1) as f64,
            refill_window: refill_window.max(Duration::from_millis(1)),
            tokens: capacity,
            last_refill: now,
        }
    }

    pub fn allow(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last_refill);
        if !elapsed.is_zero() {
            let refill =
                elapsed.as_secs_f64() / self.refill_window.as_secs_f64() * self.refill_tokens;
            self.tokens = (self.tokens + refill).min(self.capacity);
            self.last_refill = now;
        }
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

#[derive(Debug, PartialEq, Eq)]
struct WorkerReconciliation {
    keep: HashSet<Uuid>,
    start: HashSet<Uuid>,
    stop: HashSet<Uuid>,
}

fn plan_worker_reconciliation(
    active: &[GrandstreamFxoSourceLine],
    desired: &[GrandstreamFxoSourceLine],
) -> Result<WorkerReconciliation, String> {
    for desired_line in desired {
        if active.iter().any(|current| {
            current.source.source_id == desired_line.source.source_id
                && current.source.source_version > desired_line.source.source_version
        }) {
            return Err("Caller ID source configuration is stale".into());
        }
    }

    let mut keep = HashSet::new();
    let mut start = HashSet::new();
    let mut stop = HashSet::new();
    for current in active {
        match desired
            .iter()
            .find(|candidate| candidate.source.line_id == current.source.line_id)
        {
            Some(replacement) if !requires_udp_rebind(current, replacement) => {
                keep.insert(current.source.line_id);
            }
            Some(replacement) => {
                stop.insert(current.source.line_id);
                start.insert(replacement.source.line_id);
            }
            None => {
                stop.insert(current.source.line_id);
            }
        }
    }
    for desired_line in desired {
        if !active
            .iter()
            .any(|current| current.source.line_id == desired_line.source.line_id)
        {
            start.insert(desired_line.source.line_id);
        }
    }

    Ok(WorkerReconciliation { keep, start, stop })
}

fn prepare_worker_reconciliation(
    manager: &CallerIdManager,
    active: &[GrandstreamFxoSourceLine],
    desired: &[GrandstreamFxoSourceLine],
) -> Result<WorkerReconciliation, String> {
    let versions = desired
        .iter()
        .map(|line| (line.source.source_id, line.source.source_version))
        .collect::<Vec<_>>();
    manager
        .accept_source_version_snapshot(&versions, || plan_worker_reconciliation(active, desired))?
        .ok_or_else(|| "Caller ID source configuration is stale".into())
}

async fn await_current_generation<T, F>(
    manager: &CallerIdManager,
    generation: u64,
    cancel: &CancellationToken,
    operation: F,
) -> Option<T>
where
    F: Future<Output = T>,
{
    if cancel.is_cancelled() || !manager.is_generation_current(generation) {
        return None;
    }
    let result = tokio::select! {
        _ = cancel.cancelled() => return None,
        result = operation => result,
    };
    (!cancel.is_cancelled() && manager.is_generation_current(generation)).then_some(result)
}

async fn bind_worker_if_current<T, F>(
    manager: &CallerIdManager,
    generation: u64,
    cancel: &CancellationToken,
    bind: F,
) -> Option<T>
where
    F: Future<Output = T>,
{
    await_current_generation(manager, generation, cancel, bind).await
}

async fn readiness_ack_if_current<F>(
    manager: &CallerIdManager,
    generation: u64,
    cancel: &CancellationToken,
    request: F,
) -> bool
where
    F: Future<Output = bool>,
{
    await_current_generation(manager, generation, cancel, request)
        .await
        .unwrap_or(false)
}

struct ActiveLine {
    config: GrandstreamFxoSourceLine,
    cancel: CancellationToken,
    worker_stopped: CancellationToken,
    listener_task: tauri::async_runtime::JoinHandle<()>,
    publisher_task: tauri::async_runtime::JoinHandle<()>,
    readiness_acknowledged: Option<(Uuid, u64)>,
}

impl ActiveLine {
    fn is_healthy(&self) -> bool {
        !self.worker_stopped.is_cancelled()
            && !self.listener_task.inner().is_finished()
            && !self.publisher_task.inner().is_finished()
    }

    async fn retire(self) {
        self.cancel.cancel();
        let _ = self.listener_task.await;
        let _ = self.publisher_task.await;
    }

    fn pending_readiness_ack(&self, now: DateTime<Utc>) -> Option<((Uuid, u64), Value)> {
        if !self.is_healthy() {
            return None;
        }
        let attempt = self
            .config
            .readiness_attempt
            .as_ref()
            .filter(|attempt| attempt.expires_at > now)?;
        let key = (attempt.attempt_id, attempt.line_version);
        if self.readiness_acknowledged == Some(key) {
            return None;
        }
        build_source_readiness_ack(&self.config, now).map(|body| (key, body))
    }

    fn mark_readiness_acknowledged(&mut self, key: (Uuid, u64)) {
        self.readiness_acknowledged = Some(key);
    }
}

async fn mark_readiness_ack_if_worker_healthy<F>(
    active: &mut ActiveLine,
    key: (Uuid, u64),
    request: F,
) -> bool
where
    F: Future<Output = bool>,
{
    if !active.is_healthy() || !request.await || !active.is_healthy() {
        return false;
    }
    active.mark_readiness_acknowledged(key);
    true
}

async fn retire_lines(lines: Vec<ActiveLine>) {
    for line in &lines {
        line.cancel.cancel();
    }
    for line in lines {
        line.retire().await;
    }
}

fn prepare_runtime_worker_reconciliation(
    manager: &CallerIdManager,
    active: &HashMap<Uuid, ActiveLine>,
    desired: &[GrandstreamFxoSourceLine],
) -> Result<WorkerReconciliation, String> {
    let active_configs = active
        .values()
        .map(|worker| worker.config.clone())
        .collect::<Vec<_>>();
    let mut plan = prepare_worker_reconciliation(manager, &active_configs, desired)?;
    for (line_id, worker) in active {
        if !worker.is_healthy() {
            plan.keep.remove(line_id);
            plan.stop.insert(*line_id);
            if desired.iter().any(|line| line.source.line_id == *line_id) {
                plan.start.insert(*line_id);
            }
        }
    }
    Ok(plan)
}

struct PendingEvent {
    invite: ParsedInvite,
    occurred_at: DateTime<Utc>,
}

fn configuration_error_requires_worker_shutdown(status: Option<u16>) -> bool {
    matches!(status, Some(401 | 403 | 404 | 426))
}

pub fn start_connector_supervisor(
    app_handle: tauri::AppHandle,
    manager: Arc<CallerIdManager>,
    root_cancel: CancellationToken,
) -> impl Future<Output = Option<u64>> + Send + 'static {
    let task_manager = Arc::clone(&manager);
    manager.replace_supervisor(
        root_cancel,
        move |generation, supervisor_cancel| async move {
            run_connector_supervisor(app_handle, task_manager, generation, supervisor_cancel).await;
        },
    )
}

async fn run_connector_supervisor(
    app_handle: tauri::AppHandle,
    manager: Arc<CallerIdManager>,
    generation: u64,
    cancel: CancellationToken,
) {
    let mut active = HashMap::<Uuid, ActiveLine>::new();
    let mut ticker = tokio::time::interval(CONFIG_POLL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                cancel_active_lines(&mut active).await;
                return;
            }
            _ = ticker.tick() => {
                let result = await_current_generation(
                    &manager,
                    generation,
                    &cancel,
                    async {
                        let db_state = app_handle.state::<crate::db::DbState>();
                        crate::admin_fetch_detailed(
                            Some(&db_state),
                            "/api/pos/caller-id/config",
                            "GET",
                            None,
                        ).await
                    },
                ).await;
                let Some(result) = result else {
                    cancel_active_lines(&mut active).await;
                    return;
                };
                match result {
                    Ok(config) => {
                        let desired = match parse_runtime_source_lines(&config) {
                            Ok(lines) => lines,
                            Err(_) => {
                                cancel_active_lines(&mut active).await;
                                manager.set_error(
                                    generation,
                                    "Caller ID source configuration is invalid".into(),
                                    CallerIdStatusReason::InvalidConfig,
                                );
                                continue;
                            }
                        };
                        reconcile_active_lines(
                            &app_handle,
                            &manager,
                            generation,
                            &cancel,
                            &mut active,
                            desired,
                        ).await;
                    }
                    Err(error) => {
                        if configuration_error_requires_worker_shutdown(error.status()) {
                            cancel_active_lines(&mut active).await;
                        }
                        manager.set_error(
                            generation,
                            "Caller ID configuration is unavailable".into(),
                            match error.status() {
                                Some(401 | 403) => CallerIdStatusReason::AuthFailed,
                                Some(426) => CallerIdStatusReason::UnsupportedProvider,
                                _ => CallerIdStatusReason::NetworkError,
                            },
                        );
                    }
                }
            }
        }
    }
}

async fn reconcile_active_lines(
    app_handle: &tauri::AppHandle,
    manager: &Arc<CallerIdManager>,
    generation: u64,
    supervisor_cancel: &CancellationToken,
    active: &mut HashMap<Uuid, ActiveLine>,
    desired: Vec<GrandstreamFxoSourceLine>,
) {
    if supervisor_cancel.is_cancelled() || !manager.is_generation_current(generation) {
        return;
    }
    let plan = match prepare_runtime_worker_reconciliation(manager, active, &desired) {
        Ok(plan) => plan,
        Err(_) => {
            manager.set_error(
                generation,
                "Caller ID source configuration is stale".into(),
                CallerIdStatusReason::InvalidConfig,
            );
            return;
        }
    };
    let retiring = plan
        .stop
        .into_iter()
        .filter_map(|line_id| active.remove(&line_id))
        .collect();
    retire_lines(retiring).await;

    let mut bind_failed = false;
    for line in desired {
        if plan.keep.contains(&line.source.line_id) {
            let current = active
                .get_mut(&line.source.line_id)
                .expect("planned retained worker must remain active");
            current.config = line;
            acknowledge_active_source_readiness(
                app_handle,
                manager,
                generation,
                supervisor_cancel,
                current,
            )
            .await;
            continue;
        }
        if !plan.start.contains(&line.source.line_id) {
            continue;
        }
        let bind_address =
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), line.source.listen_port);
        let Some(bound) = bind_worker_if_current(
            manager,
            generation,
            supervisor_cancel,
            UdpSocket::bind(bind_address),
        )
        .await
        else {
            return;
        };
        let socket = match bound {
            Ok(socket) => socket,
            Err(_) => {
                bind_failed = true;
                warn!(
                    source_id = %line.source.source_id,
                    line_id = %line.source.line_id,
                    source_channel = %line.source.source_channel,
                    listen_port = line.source.listen_port,
                    "Caller ID Grandstream FXO UDP listen port is unavailable"
                );
                continue;
            }
        };
        if supervisor_cancel.is_cancelled() || !manager.is_generation_current(generation) {
            return;
        }
        let line_cancel = supervisor_cancel.child_token();
        let worker_stopped = CancellationToken::new();
        let (event_sender, event_receiver) = mpsc::channel(EVENT_QUEUE_CAPACITY);
        let publisher_stopped = worker_stopped.clone();
        let publisher_app = app_handle.clone();
        let publisher_source = line.source.clone();
        let publisher_cancel = line_cancel.clone();
        let publisher_task = tauri::async_runtime::spawn(async move {
            run_event_publisher(
                publisher_app,
                publisher_source,
                event_receiver,
                publisher_cancel,
            )
            .await;
            publisher_stopped.cancel();
        });
        let listener_stopped = worker_stopped.clone();
        let listener_line = line.clone();
        let listener_manager = Arc::clone(manager);
        let listener_cancel = line_cancel.clone();
        let listener_task = tauri::async_runtime::spawn(async move {
            run_udp_line(
                socket,
                listener_line,
                listener_manager,
                generation,
                event_sender,
                listener_cancel,
            )
            .await;
            listener_stopped.cancel();
        });
        info!(
            source_id = %line.source.source_id,
            line_id = %line.source.line_id,
            source_channel = %line.source.source_channel,
            listen_port = line.source.listen_port,
            "Caller ID Grandstream FXO source listener started"
        );
        let line_id = line.source.line_id;
        active.insert(
            line_id,
            ActiveLine {
                config: line,
                cancel: line_cancel,
                worker_stopped,
                listener_task,
                publisher_task,
                readiness_acknowledged: None,
            },
        );
        if let Some(current) = active.get_mut(&line_id) {
            acknowledge_active_source_readiness(
                app_handle,
                manager,
                generation,
                supervisor_cancel,
                current,
            )
            .await;
        }
    }

    if supervisor_cancel.is_cancelled() || !manager.is_generation_current(generation) {
        return;
    }
    if bind_failed {
        manager.set_error(
            generation,
            "A Caller ID listen port is already in use".into(),
            CallerIdStatusReason::PortInUse,
        );
    } else {
        let healthy_workers = active.values().filter(|worker| worker.is_healthy()).count();
        manager.set_listening(generation, healthy_workers);
    }
}

async fn acknowledge_active_source_readiness(
    app_handle: &tauri::AppHandle,
    manager: &CallerIdManager,
    generation: u64,
    cancel: &CancellationToken,
    active: &mut ActiveLine,
) {
    let has_live_attempt = active
        .config
        .readiness_attempt
        .as_ref()
        .is_some_and(|attempt| attempt.expires_at > Utc::now());
    if !has_live_attempt {
        active.readiness_acknowledged = None;
        return;
    }
    let Some((desired_key, body)) = active.pending_readiness_ack(Utc::now()) else {
        return;
    };
    let request = async {
        let db_state = app_handle.state::<crate::db::DbState>();
        crate::admin_fetch_detailed(
            Some(&db_state),
            "/api/pos/caller-id/readiness",
            "POST",
            Some(body),
        )
        .await
    };
    mark_readiness_ack_if_worker_healthy(active, desired_key, async {
        readiness_ack_if_current(manager, generation, cancel, async {
            matches!(
                tokio::time::timeout(EVENT_POST_TIMEOUT, request).await,
                Ok(Ok(_))
            )
        })
        .await
    })
    .await;
}

async fn cancel_active_lines(active: &mut HashMap<Uuid, ActiveLine>) {
    retire_lines(active.drain().map(|(_, line)| line).collect()).await;
}

async fn run_udp_line(
    socket: UdpSocket,
    line: GrandstreamFxoSourceLine,
    manager: Arc<CallerIdManager>,
    generation: u64,
    event_sender: mpsc::Sender<PendingEvent>,
    cancel: CancellationToken,
) {
    let mut buffer = vec![0_u8; MAX_SIP_PACKET_BYTES + 1];
    let mut recent_calls = RecentCallIds::new(RECENT_CALL_CAPACITY, RECENT_CALL_TTL);
    let mut rate_limiter = EventRateLimiter::new(EVENT_RATE_LIMIT, EVENT_RATE_WINDOW);
    let mut packet_limiter = PacketTokenBucket::new(
        PACKET_BURST_CAPACITY,
        PACKET_RATE_PER_WINDOW,
        PACKET_RATE_WINDOW,
        Instant::now(),
    );

    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            received = socket.recv_from(&mut buffer) => {
                let (length, peer) = match received {
                    Ok(received) => received,
                    Err(_) => {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }
                };
                // The peer boundary is checked before parsing and before any
                // response, preventing the UDP socket from becoming a
                // reflection surface for other LAN or public senders.
                if peer.ip() != line.source.trusted_device_ip {
                    continue;
                }
                let now = Instant::now();
                if !packet_limiter.allow(now) {
                    continue;
                }
                let packet = &buffer[..length];
                let invite = match parse_invite(packet, peer, &line) {
                    Ok(invite) => invite,
                    Err(_) => continue,
                };
                let trying = match build_sip_response(packet, 100) {
                    Ok(response) => response,
                    Err(_) => continue,
                };
                let busy = match build_sip_response(packet, 486) {
                    Ok(response) => response,
                    Err(_) => continue,
                };
                let _ = socket.send_to(&trying, peer).await;
                let _ = socket.send_to(&busy, peer).await;

                if !recent_calls.accept(&invite.provider_event_id, now)
                    || !rate_limiter.allow(now)
                {
                    continue;
                }
                let pending = PendingEvent {
                    invite,
                    occurred_at: Utc::now(),
                };
                if event_sender.try_send(pending).is_ok() {
                    manager.increment_calls(generation);
                } else {
                    warn!(
                        line_id = %line.source.line_id,
                        "Caller ID event queue is full; dropping event without caller data"
                    );
                }
            }
        }
    }
}

async fn run_event_publisher(
    app_handle: tauri::AppHandle,
    source: CallerIdSourceConfig,
    mut events: mpsc::Receiver<PendingEvent>,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            pending = events.recv() => {
                let Some(pending) = pending else {
                    return;
                };
                publish_event(&app_handle, &source, pending, &cancel).await;
            }
        }
    }
}

async fn publish_event(
    app_handle: &tauri::AppHandle,
    source: &CallerIdSourceConfig,
    pending: PendingEvent,
    cancel: &CancellationToken,
) {
    let body = build_event_body(source, &pending);
    let line_id = source.line_id;
    let path = format!("/api/pos/caller-id/lines/{line_id}/events");
    let retry_delays = [
        Duration::ZERO,
        Duration::from_millis(250),
        Duration::from_millis(750),
    ];
    for delay in retry_delays {
        if cancel.is_cancelled() {
            return;
        }
        if !delay.is_zero() {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(delay) => {}
            }
        }
        let request = async {
            let db_state = app_handle.state::<crate::db::DbState>();
            crate::admin_fetch_detailed(Some(&db_state), &path, "POST", Some(body.clone())).await
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => return,
            result = tokio::time::timeout(EVENT_POST_TIMEOUT, request) => result,
        };
        match result {
            Ok(Ok(_)) => return,
            Ok(Err(error)) if matches!(error.status(), Some(400..=499)) => {
                warn!(
                    line_id = %line_id,
                    status = ?error.status(),
                    "Caller ID event publication was rejected"
                );
                return;
            }
            _ => {}
        }
    }
    warn!(
        line_id = %line_id,
        "Caller ID event publication failed after bounded retries"
    );
}

fn build_event_body(source: &CallerIdSourceConfig, pending: &PendingEvent) -> Value {
    let presentation = match pending.invite.presentation {
        Presentation::Allowed => "allowed",
        Presentation::Restricted => "restricted",
    };
    serde_json::json!({
        "sourceId": source.source_id,
        "sourceVersion": source.source_version,
        "sourceChannel": source.source_channel,
        "providerEventId": pending.invite.provider_event_id,
        "callerNumber": pending.invite.caller_number,
        "presentation": presentation,
        "occurredAt": pending.occurred_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::callerid::types::ListenerStatus;
    use serde_json::json;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    const LINE_ID: &str = "018f7684-1436-7d3d-a3f8-58b1bf600dbd";
    const SOURCE_ID: &str = "018f7684-1436-7d3d-a3f8-58b1bf600da0";

    fn source_line() -> serde_json::Value {
        json!({
            "id": LINE_ID,
            "name": "Cosmote line",
            "adapterType": "generic_sip",
            "sourceId": SOURCE_ID,
            "sourceVersion": 7,
            "deviceProfileKey": "grandstream_ht813_fxo",
            "connectorFamily": "analog_fxo",
            "sourceChannel": "fxo-1",
            "version": 4,
            "isReceivingTarget": true,
            "config": {
                "presetId": "grandstream_ht813_fxo",
                "mode": "pbx_ip_trust",
                "transport": "udp",
                "trustedDeviceIp": "192.168.1.70",
                "listenPort": 5060
            },
            "credentialVersion": null,
            "credentials": null
        })
    }

    fn reviewed_source_line(
        profile: &str,
        line_number: u128,
        source_channel: &str,
        listen_port: u16,
    ) -> serde_json::Value {
        json!({
            "id": Uuid::from_u128(0x018f768414367d3da3f858b1bf600000 + line_number),
            "name": format!("FXO line {line_number}"),
            "adapterType": "generic_sip",
            "sourceId": SOURCE_ID,
            "sourceVersion": 7,
            "deviceProfileKey": profile,
            "connectorFamily": "analog_fxo",
            "sourceChannel": source_channel,
            "version": 4,
            "isReceivingTarget": true,
            "config": {
                "presetId": profile,
                "mode": "pbx_ip_trust",
                "transport": "udp",
                "trustedDeviceIp": "192.168.1.70",
                "listenPort": listen_port
            },
            "credentialVersion": null,
            "credentials": null
        })
    }

    fn reviewed_source(profile: &str, channel_count: usize) -> serde_json::Value {
        let source_lines = (1..=channel_count)
            .map(|line_number| {
                reviewed_source_line(
                    profile,
                    line_number as u128,
                    &format!("fxo-{line_number}"),
                    5060 + line_number as u16,
                )
            })
            .collect::<Vec<_>>();
        json!({ "enabled": true, "sourceLines": source_lines })
    }

    fn parse_source_lines(value: &Value) -> Result<Vec<GrandstreamFxoSourceLine>, String> {
        validate_ip_trust_source_lines(value)
    }

    async fn installed_test_generation(manager: &Arc<CallerIdManager>) -> (u64, CancellationToken) {
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let generation = manager
            .replace_supervisor(
                CancellationToken::new(),
                move |_generation, supervisor_cancel| async move {
                    let _ = cancel_tx.send(supervisor_cancel.clone());
                    supervisor_cancel.cancelled().await;
                },
            )
            .await
            .expect("test supervisor generation");
        (
            generation,
            cancel_rx.await.expect("test supervisor cancellation token"),
        )
    }

    #[tokio::test]
    async fn stop_during_reconcile_drops_delayed_bind_before_worker_start() {
        let manager = Arc::new(CallerIdManager::new());
        let (generation, generation_cancel) = installed_test_generation(&manager).await;
        let worker_started = Arc::new(AtomicBool::new(false));
        let worker_started_after_bind = Arc::clone(&worker_started);
        let (bind_entered_tx, bind_entered_rx) = tokio::sync::oneshot::channel();
        let (_release_bind_tx, release_bind_rx) = tokio::sync::oneshot::channel::<()>();
        let operation_manager = Arc::clone(&manager);
        let operation = tokio::spawn(async move {
            let bound = bind_worker_if_current(
                &operation_manager,
                generation,
                &generation_cancel,
                async move {
                    let _ = bind_entered_tx.send(());
                    let _ = release_bind_rx.await;
                },
            )
            .await;
            if bound.is_some() {
                worker_started_after_bind.store(true, Ordering::SeqCst);
            }
        });

        bind_entered_rx.await.expect("bind operation entered");
        manager.stop().await;
        operation.await.expect("reconcile operation exits");

        assert!(!worker_started.load(Ordering::SeqCst));
        assert_eq!(manager.get_status().status, ListenerStatus::Stopped);
    }

    #[tokio::test]
    async fn stop_during_readiness_post_prevents_obsolete_acknowledgement() {
        let manager = Arc::new(CallerIdManager::new());
        let (generation, generation_cancel) = installed_test_generation(&manager).await;
        let acknowledged = Arc::new(AtomicBool::new(false));
        let acknowledged_after_post = Arc::clone(&acknowledged);
        let (post_entered_tx, post_entered_rx) = tokio::sync::oneshot::channel();
        let (_release_post_tx, release_post_rx) = tokio::sync::oneshot::channel::<()>();
        let operation_manager = Arc::clone(&manager);
        let operation = tokio::spawn(async move {
            let posted = readiness_ack_if_current(
                &operation_manager,
                generation,
                &generation_cancel,
                async move {
                    let _ = post_entered_tx.send(());
                    let _ = release_post_rx.await;
                    true
                },
            )
            .await;
            if posted {
                acknowledged_after_post.store(true, Ordering::SeqCst);
            }
        });

        post_entered_rx.await.expect("readiness POST entered");
        manager.stop().await;
        operation.await.expect("readiness operation exits");

        assert!(!acknowledged.load(Ordering::SeqCst));
        assert_eq!(manager.get_status().status, ListenerStatus::Stopped);
    }

    #[test]
    fn release_gate_config_denial_stops_existing_workers() {
        assert!(configuration_error_requires_worker_shutdown(Some(401)));
        assert!(configuration_error_requires_worker_shutdown(Some(403)));
        assert!(configuration_error_requires_worker_shutdown(Some(404)));
        assert!(configuration_error_requires_worker_shutdown(Some(426)));
        assert!(!configuration_error_requires_worker_shutdown(Some(500)));
        assert!(!configuration_error_requires_worker_shutdown(None));
    }

    #[test]
    fn connector_start_wrapper_preserves_manager_install_outcome() {
        fn assert_install_outcome<F, Fut>(_start: F)
        where
            F: FnOnce(tauri::AppHandle, Arc<CallerIdManager>, CancellationToken) -> Fut,
            Fut: Future<Output = Option<u64>>,
        {
        }

        assert_install_outcome(start_connector_supervisor);
    }

    #[test]
    fn accepts_one_reviewed_ht813_fxo_channel() {
        let parsed = parse_source_lines(&reviewed_source("grandstream_ht813_fxo", 1))
            .expect("one reviewed HT813 FXO channel");

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].source.device_profile_key, "grandstream_ht813_fxo");
        assert_eq!(parsed[0].source.source_channel, "fxo-1");
        assert_eq!(parsed[0].source.listen_port, 5061);
    }

    #[test]
    fn accepts_four_independent_ht841_fxo_channels() {
        let parsed = parse_source_lines(&reviewed_source("grandstream_ht841_fxo", 4))
            .expect("four reviewed HT841 FXO channels");

        assert_eq!(parsed.len(), 4);
        assert_eq!(parsed[3].source.source_channel, "fxo-4");
        assert_eq!(parsed[3].source.listen_port, 5064);
    }

    #[test]
    fn accepts_eight_independent_ht881_fxo_channels() {
        let parsed = parse_source_lines(&reviewed_source("grandstream_ht881_fxo", 8))
            .expect("eight reviewed HT881 FXO channels");

        assert_eq!(parsed.len(), 8);
        assert_eq!(parsed[7].source.source_channel, "fxo-8");
        assert_eq!(parsed[7].source.listen_port, 5068);
    }

    #[test]
    fn rejects_profiles_without_reviewed_fxo_input_capability() {
        for profile in [
            "grandstream_ht801_v2_fxs",
            "grandstream_ht802_fxs",
            "zte_h1600_router",
            "unknown_gateway",
        ] {
            assert!(
                parse_source_lines(&reviewed_source(profile, 1)).is_err(),
                "{profile} must not activate the Grandstream FXO connector"
            );
        }

        let mut wrong_family = reviewed_source("grandstream_ht813_fxo", 1);
        wrong_family["sourceLines"][0]["connectorFamily"] = json!("sip_pbx");
        assert!(parse_source_lines(&wrong_family).is_err());
    }

    #[test]
    fn rejects_channels_beyond_each_reviewed_profile_capacity() {
        assert!(parse_source_lines(&reviewed_source("grandstream_ht813_fxo", 2)).is_err());
        assert!(parse_source_lines(&reviewed_source("grandstream_ht841_fxo", 5)).is_err());
        assert!(parse_source_lines(&reviewed_source("grandstream_ht881_fxo", 9)).is_err());
    }

    #[test]
    fn rejects_a_stale_source_version_without_stopping_current_workers() {
        let current = parse_source_lines(&reviewed_source("grandstream_ht841_fxo", 2))
            .expect("current source version");
        let mut stale_value = reviewed_source("grandstream_ht841_fxo", 2);
        for line in stale_value["sourceLines"]
            .as_array_mut()
            .expect("source lines")
        {
            line["sourceVersion"] = json!(6);
        }
        let stale = parse_source_lines(&stale_value).expect("well-formed stale source snapshot");

        let error = plan_worker_reconciliation(&current, &stale)
            .expect_err("source version rollback must fail closed");

        assert_eq!(error, "Caller ID source configuration is stale");
    }

    #[test]
    fn source_watermark_rejects_rollback_after_every_channel_failed_to_bind() {
        let source_a = Uuid::parse_str(SOURCE_ID).unwrap();
        let source_b = Uuid::parse_str("018f7684-1436-7d3d-a3f8-58b1bf600da2").unwrap();
        let accepted_a =
            parse_source_lines(&reviewed_source("grandstream_ht841_fxo", 2)).expect("source A v7");
        let mut source_b_value = reviewed_source("grandstream_ht841_fxo", 1);
        source_b_value["sourceLines"][0]["sourceId"] = json!(source_b);
        source_b_value["sourceLines"][0]["id"] = json!("018f7684-1436-7d3d-a3f8-58b1bf600dc2");
        source_b_value["sourceLines"][0]["config"]["listenPort"] = json!(5071);
        let accepted_b = parse_source_lines(&source_b_value).expect("source B v7");
        let mut accepted_snapshot = accepted_a.clone();
        accepted_snapshot.extend(accepted_b.clone());
        let manager = CallerIdManager::new();

        prepare_worker_reconciliation(&manager, &[], &accepted_snapshot)
            .expect("complete v7 snapshot accepted before any bind");
        assert_eq!(manager.highest_source_version(source_a), Some(7));
        assert_eq!(manager.highest_source_version(source_b), Some(7));

        // Source A has no active workers because every bind failed. Source B is
        // healthy and must not be stopped or altered by A's stale rollback.
        let active = accepted_b;
        let mut stale_a_value = reviewed_source("grandstream_ht841_fxo", 2);
        for line in stale_a_value["sourceLines"]
            .as_array_mut()
            .expect("source A lines")
        {
            line["sourceVersion"] = json!(6);
        }
        let mut stale_snapshot =
            parse_source_lines(&stale_a_value).expect("well-formed source A v6");
        stale_snapshot.extend(active.clone());

        let error = prepare_worker_reconciliation(&manager, &active, &stale_snapshot)
            .expect_err("v7 watermark must survive total bind failure");

        assert_eq!(error, "Caller ID source configuration is stale");
        assert_eq!(active[0].source.source_id, source_b);
        assert_eq!(manager.highest_source_version(source_a), Some(7));
        assert_eq!(manager.highest_source_version(source_b), Some(7));
    }

    #[test]
    fn rejected_snapshot_does_not_partially_advance_other_source_watermarks() {
        let source_a = Uuid::parse_str(SOURCE_ID).unwrap();
        let source_b = Uuid::parse_str("018f7684-1436-7d3d-a3f8-58b1bf600da2").unwrap();
        let manager = CallerIdManager::new();
        manager
            .accept_source_version_snapshot(&[(source_a, 7), (source_b, 7)], || Ok(()))
            .expect("watermark storage available")
            .expect("initial source versions accepted");

        let mut source_a_v8 = reviewed_source("grandstream_ht841_fxo", 1);
        source_a_v8["sourceLines"][0]["sourceVersion"] = json!(8);
        let mut source_b_v6 = reviewed_source("grandstream_ht841_fxo", 1);
        source_b_v6["sourceLines"][0]["sourceId"] = json!(source_b);
        source_b_v6["sourceLines"][0]["id"] = json!("018f7684-1436-7d3d-a3f8-58b1bf600dc2");
        source_b_v6["sourceLines"][0]["sourceVersion"] = json!(6);
        source_b_v6["sourceLines"][0]["config"]["listenPort"] = json!(5071);
        let mut rejected = parse_source_lines(&source_a_v8).expect("source A v8");
        rejected.extend(parse_source_lines(&source_b_v6).expect("source B v6"));

        assert!(prepare_worker_reconciliation(&manager, &[], &rejected).is_err());
        assert_eq!(manager.highest_source_version(source_a), Some(7));
        assert_eq!(manager.highest_source_version(source_b), Some(7));
    }

    #[tokio::test]
    async fn source_watermark_survives_supervisor_generation_replacement() {
        let manager = Arc::new(CallerIdManager::new());
        let source_id = Uuid::parse_str(SOURCE_ID).unwrap();
        let accepted =
            parse_source_lines(&reviewed_source("grandstream_ht841_fxo", 2)).expect("source v7");
        let (_first_generation, _first_cancel) = installed_test_generation(&manager).await;
        prepare_worker_reconciliation(&manager, &[], &accepted)
            .expect("first supervisor accepts v7");

        manager.stop().await;
        let (_replacement_generation, _replacement_cancel) =
            installed_test_generation(&manager).await;
        let mut stale_value = reviewed_source("grandstream_ht841_fxo", 2);
        for line in stale_value["sourceLines"]
            .as_array_mut()
            .expect("source lines")
        {
            line["sourceVersion"] = json!(6);
        }
        let stale = parse_source_lines(&stale_value).expect("well-formed source v6");

        assert_eq!(
            prepare_worker_reconciliation(&manager, &[], &stale)
                .expect_err("replacement supervisor must retain v7 watermark"),
            "Caller ID source configuration is stale"
        );
        assert_eq!(manager.highest_source_version(source_id), Some(7));
        manager.stop().await;
    }

    #[test]
    fn failed_worker_is_retried_without_restarting_its_healthy_sibling() {
        let desired = parse_source_lines(&reviewed_source("grandstream_ht841_fxo", 2))
            .expect("two desired workers");
        let active = vec![desired[0].clone()];

        let first_retry =
            plan_worker_reconciliation(&active, &desired).expect("first recovery plan");
        assert_eq!(first_retry.keep, HashSet::from([desired[0].source.line_id]));
        assert_eq!(
            first_retry.start,
            HashSet::from([desired[1].source.line_id])
        );
        assert!(first_retry.stop.is_empty());

        let next_retry = plan_worker_reconciliation(&active, &desired).expect("next recovery plan");
        assert_eq!(next_retry.keep, first_retry.keep);
        assert_eq!(next_retry.start, first_retry.start);
        assert!(next_retry.stop.is_empty());
    }

    #[tokio::test]
    async fn exited_listener_is_rebound_without_restarting_healthy_sibling() {
        let desired = parse_source_lines(&reviewed_source("grandstream_ht841_fxo", 2))
            .expect("two desired workers");
        let dead_cancel = CancellationToken::new();
        let dead_publisher_cancel = dead_cancel.clone();
        let dead_listener_task = tauri::async_runtime::spawn(async {});
        while !dead_listener_task.inner().is_finished() {
            tokio::task::yield_now().await;
        }
        let dead_publisher_task = tauri::async_runtime::spawn(async move {
            dead_publisher_cancel.cancelled().await;
        });
        let healthy_cancel = CancellationToken::new();
        let healthy_listener_cancel = healthy_cancel.clone();
        let healthy_publisher_cancel = healthy_cancel.clone();
        let healthy_listener_task = tauri::async_runtime::spawn(async move {
            healthy_listener_cancel.cancelled().await;
        });
        let healthy_publisher_task = tauri::async_runtime::spawn(async move {
            healthy_publisher_cancel.cancelled().await;
        });
        let mut active = HashMap::from([
            (
                desired[0].source.line_id,
                ActiveLine {
                    config: desired[0].clone(),
                    cancel: dead_cancel,
                    worker_stopped: CancellationToken::new(),
                    listener_task: dead_listener_task,
                    publisher_task: dead_publisher_task,
                    readiness_acknowledged: None,
                },
            ),
            (
                desired[1].source.line_id,
                ActiveLine {
                    config: desired[1].clone(),
                    cancel: healthy_cancel,
                    worker_stopped: CancellationToken::new(),
                    listener_task: healthy_listener_task,
                    publisher_task: healthy_publisher_task,
                    readiness_acknowledged: None,
                },
            ),
        ]);
        let manager = CallerIdManager::new();

        let plan = prepare_runtime_worker_reconciliation(&manager, &active, &desired)
            .expect("dead runtime worker should be planned for isolated replacement");

        assert_eq!(plan.stop, HashSet::from([desired[0].source.line_id]));
        assert_eq!(plan.start, HashSet::from([desired[0].source.line_id]));
        assert_eq!(plan.keep, HashSet::from([desired[1].source.line_id]));
        assert!(!active[&desired[0].source.line_id].is_healthy());
        assert!(active[&desired[1].source.line_id].is_healthy());
        cancel_active_lines(&mut active).await;
    }

    #[tokio::test]
    async fn worker_that_dies_during_readiness_request_is_not_acknowledged() {
        let line = parse_source_lines(&reviewed_source("grandstream_ht841_fxo", 1))
            .expect("one desired worker")
            .remove(0);
        let cancel = CancellationToken::new();
        let worker_stopped = CancellationToken::new();
        let listener_stopped = worker_stopped.clone();
        let (kill_listener_tx, kill_listener_rx) = tokio::sync::oneshot::channel();
        let listener_exited = Arc::new(AtomicBool::new(false));
        let listener_exited_in_task = Arc::clone(&listener_exited);
        let listener_task = tauri::async_runtime::spawn(async move {
            let _ = kill_listener_rx.await;
            listener_stopped.cancel();
            listener_exited_in_task.store(true, Ordering::SeqCst);
        });
        let publisher_cancel = cancel.clone();
        let publisher_task = tauri::async_runtime::spawn(async move {
            publisher_cancel.cancelled().await;
        });
        let mut active = ActiveLine {
            config: line,
            cancel,
            worker_stopped,
            listener_task,
            publisher_task,
            readiness_acknowledged: None,
        };
        let key = (
            Uuid::parse_str("018f7684-1436-7d3d-a3f8-58b1bf600dc0").unwrap(),
            4,
        );

        let acknowledged = mark_readiness_ack_if_worker_healthy(&mut active, key, async move {
            let _ = kill_listener_tx.send(());
            while !listener_exited.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
            true
        })
        .await;

        assert!(!acknowledged);
        assert_eq!(active.readiness_acknowledged, None);
        active.retire().await;
    }

    #[test]
    fn worker_identity_changes_require_an_isolated_udp_rebind() {
        let current = parse_source_line(&reviewed_source_line(
            "grandstream_ht841_fxo",
            1,
            "fxo-1",
            5061,
        ))
        .unwrap();

        let mut changes = Vec::new();
        let mut source_id = current.clone();
        source_id.source.source_id =
            Uuid::parse_str("018f7684-1436-7d3d-a3f8-58b1bf600da1").unwrap();
        changes.push(source_id);
        let mut source_version = current.clone();
        source_version.source.source_version = 8;
        changes.push(source_version);
        let mut line_id = current.clone();
        line_id.source.line_id = Uuid::parse_str("018f7684-1436-7d3d-a3f8-58b1bf600dbf").unwrap();
        changes.push(line_id);
        let mut source_channel = current.clone();
        source_channel.source.source_channel = "fxo-2".into();
        changes.push(source_channel);
        let mut trusted_address = current.clone();
        trusted_address.source.trusted_device_ip = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 71));
        changes.push(trusted_address);
        let mut listen_port = current.clone();
        listen_port.source.listen_port = 5062;
        changes.push(listen_port);

        assert!(changes
            .iter()
            .all(|desired| requires_udp_rebind(&current, desired)));
    }

    fn invite(request_uri: &str, from: &str, call_id: &str) -> Vec<u8> {
        format!(
            "INVITE {request_uri} SIP/2.0\r\n\
             Via: SIP/2.0/UDP 192.168.1.70:5062;branch=z9hG4bK-test\r\n\
             From: {from};tag=fxo-1\r\n\
             To: <sip:callerid@192.168.1.20:5060>\r\n\
             Call-ID: {call_id}\r\n\
             CSeq: 1 INVITE\r\n\
             Content-Length: 0\r\n\
             \r\n"
        )
        .into_bytes()
    }

    #[test]
    fn rejects_ip_trust_without_an_explicit_founder_pilot_policy() {
        parse_runtime_source_lines(&reviewed_source("grandstream_ht813_fxo", 1))
            .expect_err("missing policy must not produce a runtime listener config");

        let mut unknown_policy = reviewed_source("grandstream_ht813_fxo", 1);
        unknown_policy["ipTrustSourcePolicy"] = json!("unknown");
        parse_runtime_source_lines(&unknown_policy)
            .expect_err("unknown policy must not produce a runtime listener config");
    }

    #[test]
    fn accepts_strict_reviewed_ip_trust_sources_for_the_founder_pilot() {
        let mut config = reviewed_source("grandstream_ht813_fxo", 1);
        config["ipTrustSourcePolicy"] = json!("founder_pilot");

        let parsed = parse_runtime_source_lines(&config)
            .expect("the scoped founder pilot can bind its reviewed HT813 listener");

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].source.device_profile_key, "grandstream_ht813_fxo");
    }

    #[test]
    fn keeps_a_disabled_caller_id_configuration_inert() {
        assert!(parse_runtime_source_lines(&json!({
            "enabled": false,
            "sourceLines": []
        }))
        .expect("disabled Caller ID configuration")
        .is_empty());
    }

    #[test]
    fn parses_only_the_strict_reviewed_fxo_source_contract() {
        let parsed = parse_source_line(&source_line()).expect("valid reviewed FXO source line");

        assert_eq!(parsed.source.line_id.to_string(), LINE_ID);
        assert_eq!(parsed.line_version, 4);
        assert_eq!(
            parsed.source.trusted_device_ip,
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 70))
        );
        assert_eq!(parsed.source.listen_port, 5060);

        let mut with_secret = source_line();
        with_secret["credentials"] = json!({ "present": true });
        assert!(parse_source_line(&with_secret).is_err());

        let mut with_unknown_setting = source_line();
        with_unknown_setting["config"]["outboundProxy"] = json!("attacker.invalid");
        assert!(parse_source_line(&with_unknown_setting).is_err());
    }

    #[test]
    fn accepts_only_a_server_issued_matching_readiness_attempt() {
        let mut value = source_line();
        value["readinessAttempt"] = json!({
            "attemptId": "018f7684-1436-7d3d-a3f8-58b1bf600dc0",
            "lineVersion": 4,
            "expiresAt": "2099-07-28T12:00:00Z"
        });

        let parsed = parse_source_line(&value).expect("server-issued readiness attempt");
        let readiness = parsed.readiness_attempt.expect("readiness attempt");
        assert_eq!(
            readiness.attempt_id.to_string(),
            "018f7684-1436-7d3d-a3f8-58b1bf600dc0"
        );
        assert_eq!(readiness.line_version, parsed.line_version);

        value["readinessAttempt"]["lineVersion"] = json!(3);
        assert!(parse_source_line(&value).is_err());
    }

    #[test]
    fn rejects_non_private_or_non_ipv4_gateway_addresses() {
        for address in [
            "8.8.8.8",
            "127.0.0.1",
            "0.0.0.0",
            "192.168.1.0",
            "192.168.1.255",
            "::1",
            "router.local",
        ] {
            let mut value = source_line();
            value["config"]["trustedDeviceIp"] = json!(address);
            assert!(
                parse_source_line(&value).is_err(),
                "{address} must not be trusted as a Grandstream FXO LAN peer"
            );
        }
    }

    #[test]
    fn accepts_a_valid_invite_only_from_the_exact_gateway_and_listen_port() {
        let line = parse_source_line(&source_line()).unwrap();
        let data = invite(
            "sip:callerid@192.168.1.20:5060",
            "\"COSMOTE\" <sip:2101234567@192.168.1.70>",
            "fxo-call-123@ht813",
        );

        let parsed = parse_invite(
            &data,
            SocketAddr::new(line.source.trusted_device_ip, 5062),
            &line,
        )
        .expect("trusted Grandstream FXO INVITE");

        assert_eq!(parsed.caller_number.as_deref(), Some("2101234567"));
        assert_eq!(parsed.presentation, Presentation::Allowed);
        assert_eq!(parsed.provider_event_id, "fxo-call-123@ht813");

        let wrong_peer = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 71)), 5062);
        assert!(parse_invite(&data, wrong_peer, &line).is_err());

        let wrong_port = invite(
            "sip:callerid@192.168.1.20:5070",
            "<sip:2101234567@192.168.1.70>",
            "fxo-call-124@ht813",
        );
        assert!(parse_invite(
            &wrong_port,
            SocketAddr::new(line.source.trusted_device_ip, 5062),
            &line,
        )
        .is_err());

        let wrong_user = invite(
            "sip:not-callerid@192.168.1.20:5060",
            "<sip:2101234567@192.168.1.70>",
            "fxo-call-125@ht813",
        );
        assert!(parse_invite(
            &wrong_user,
            SocketAddr::new(line.source.trusted_device_ip, 5062),
            &line,
        )
        .is_err());
    }

    #[test]
    fn maps_private_identity_without_publishing_an_attacker_controlled_username() {
        let line = parse_source_line(&source_line()).unwrap();
        let private = invite(
            "sip:callerid@192.168.1.20:5060",
            "\"Anonymous\" <sip:anonymous@192.168.1.70>",
            "private-call@ht813",
        );
        let parsed = parse_invite(
            &private,
            SocketAddr::new(line.source.trusted_device_ip, 5062),
            &line,
        )
        .unwrap();

        assert_eq!(parsed.presentation, Presentation::Restricted);
        assert_eq!(parsed.caller_number, None);

        let asserted_identity_with_private_from = String::from_utf8(invite(
            "sip:callerid@192.168.1.20:5060",
            "\"Anonymous\" <sip:anonymous@192.168.1.70>",
            "from-private@ht813",
        ))
        .unwrap()
        .replace(
            "From: \"Anonymous\" <sip:anonymous@192.168.1.70>",
            "P-Asserted-Identity: <sip:2107777777@192.168.1.70>\r\n\
             From: \"Anonymous\" <sip:anonymous@192.168.1.70>",
        );
        let parsed = parse_invite(
            asserted_identity_with_private_from.as_bytes(),
            SocketAddr::new(line.source.trusted_device_ip, 5062),
            &line,
        )
        .unwrap();
        assert_eq!(parsed.presentation, Presentation::Restricted);
        assert_eq!(parsed.caller_number, None);

        let alphabetic = invite(
            "sip:callerid@192.168.1.20:5060",
            "<sip:not-a-phone@192.168.1.70>",
            "bad-caller@ht813",
        );
        assert!(parse_invite(
            &alphabetic,
            SocketAddr::new(line.source.trusted_device_ip, 5062),
            &line,
        )
        .is_err());

        let remote_party_private = String::from_utf8(invite(
            "sip:callerid@192.168.1.20:5060",
            "<sip:2101234567@192.168.1.70>",
            "rpid-private@ht813",
        ))
        .unwrap()
        .replace(
            "From: <sip:2101234567@192.168.1.70>",
            "Remote-Party-ID: <sip:2109999999@192.168.1.70>;privacy=full\r\n\
             From: <sip:2101234567@192.168.1.70>",
        );
        let parsed = parse_invite(
            remote_party_private.as_bytes(),
            SocketAddr::new(line.source.trusted_device_ip, 5062),
            &line,
        )
        .unwrap();
        assert_eq!(parsed.presentation, Presentation::Restricted);
        assert_eq!(parsed.caller_number, None);

        let asserted_identity_with_private_rpid = remote_party_private.replace(
            "Remote-Party-ID:",
            "P-Asserted-Identity: <sip:2108888888@192.168.1.70>\r\n\
             Remote-Party-ID:",
        );
        let parsed = parse_invite(
            asserted_identity_with_private_rpid.as_bytes(),
            SocketAddr::new(line.source.trusted_device_ip, 5062),
            &line,
        )
        .unwrap();
        assert_eq!(parsed.presentation, Presentation::Restricted);
        assert_eq!(parsed.caller_number, None);
    }

    #[test]
    fn rejects_oversized_or_unsafe_call_ids() {
        let line = parse_source_line(&source_line()).unwrap();
        let peer = SocketAddr::new(line.source.trusted_device_ip, 5062);
        for call_id in [
            "",
            "contains spaces@ht813",
            "x\nInjected: yes",
            &"x".repeat(256),
        ] {
            let data = invite(
                "sip:callerid@192.168.1.20:5060",
                "<sip:2101234567@192.168.1.70>",
                call_id,
            );
            assert!(parse_invite(&data, peer, &line).is_err());
        }
    }

    #[test]
    fn rejects_oversized_datagrams_and_individual_sip_headers() {
        let line = parse_source_line(&source_line()).unwrap();
        let peer = SocketAddr::new(line.source.trusted_device_ip, 5062);
        let oversized_datagram = vec![b'A'; MAX_SIP_PACKET_BYTES + 1];
        assert!(parse_invite(&oversized_datagram, peer, &line).is_err());

        let oversized_header = String::from_utf8(invite(
            "sip:callerid@192.168.1.20:5060",
            "<sip:2101234567@192.168.1.70>",
            "bounded-headers@grandstream",
        ))
        .unwrap()
        .replace(
            "Content-Length: 0",
            &format!("X-Oversized: {}\r\nContent-Length: 0", "a".repeat(2_049)),
        );
        assert!(parse_invite(oversized_header.as_bytes(), peer, &line).is_err());
    }

    #[test]
    fn retransmission_window_is_bounded_and_expires() {
        let now = Instant::now();
        let mut seen = RecentCallIds::new(2, Duration::from_secs(30));

        assert!(seen.accept("call-a", now));
        assert!(!seen.accept("call-a", now + Duration::from_secs(1)));
        assert!(seen.accept("call-b", now + Duration::from_secs(2)));
        assert!(seen.accept("call-c", now + Duration::from_secs(3)));
        assert_eq!(seen.len(), 2);
        assert!(seen.accept("call-a", now + Duration::from_secs(31)));
    }

    #[test]
    fn source_config_supports_multiple_fxo_channels_but_rejects_port_collisions() {
        let mut first = source_line();
        first["deviceProfileKey"] = json!("grandstream_ht841_fxo");
        first["config"]["presetId"] = json!("grandstream_ht841_fxo");
        let mut second = source_line();
        second["id"] = json!("018f7684-1436-7d3d-a3f8-58b1bf600dbe");
        second["name"] = json!("Second line");
        second["deviceProfileKey"] = json!("grandstream_ht841_fxo");
        second["sourceChannel"] = json!("fxo-2");
        second["config"]["presetId"] = json!("grandstream_ht841_fxo");
        second["config"]["listenPort"] = json!(5061);
        let config = json!({
            "enabled": true,
            "sourceLines": [first, second]
        });

        let parsed = parse_source_lines(&config).expect("two independent FXO channels");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].source.listen_port, 5061);

        let mut collision = config;
        collision["sourceLines"][1]["config"]["listenPort"] = json!(5060);
        assert!(parse_source_lines(&collision).is_err());
    }

    #[test]
    fn builds_event_only_trying_and_busy_responses_without_accepting_audio() {
        let data = invite(
            "sip:callerid@192.168.1.20:5060",
            "\"COSMOTE\" <sip:2101234567@192.168.1.70>",
            "response-call@ht813",
        );

        let trying = String::from_utf8(build_sip_response(&data, 100).unwrap()).unwrap();
        assert!(trying.starts_with("SIP/2.0 100 Trying\r\n"));
        assert!(trying.contains("Call-ID: response-call@ht813\r\n"));
        assert!(trying.contains("CSeq: 1 INVITE\r\n"));
        assert!(!trying.contains(";tag=cid"));
        assert!(!trying.contains("Contact:"));

        let busy = String::from_utf8(build_sip_response(&data, 486).unwrap()).unwrap();
        let busy_retransmission =
            String::from_utf8(build_sip_response(&data, 486).unwrap()).unwrap();
        assert_eq!(busy_retransmission, busy);
        assert!(busy.starts_with("SIP/2.0 486 Busy Here\r\n"));
        assert!(busy.contains("To: <sip:callerid@192.168.1.20:5060>;tag="));
        assert!(busy.ends_with("Content-Length: 0\r\n\r\n"));
        assert!(!busy.contains("200 OK"));
    }

    #[test]
    fn limits_unique_call_events_without_blocking_retransmission_responses() {
        let now = Instant::now();
        let mut limiter = EventRateLimiter::new(2, Duration::from_secs(60));

        assert!(limiter.allow(now));
        assert!(limiter.allow(now + Duration::from_secs(1)));
        assert!(!limiter.allow(now + Duration::from_secs(2)));
        assert!(limiter.allow(now + Duration::from_secs(61)));
    }

    #[tokio::test]
    async fn udp_runtime_replies_100_then_486_and_publishes_one_event_per_call_id() {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let listen_port = socket.local_addr().unwrap().port();
        let line = GrandstreamFxoSourceLine {
            source: CallerIdSourceConfig {
                source_id: Uuid::parse_str(SOURCE_ID).unwrap(),
                source_version: 7,
                device_profile_key: "grandstream_ht813_fxo".into(),
                connector_family: CallerIdConnectorFamily::AnalogFxo,
                line_id: Uuid::parse_str(LINE_ID).unwrap(),
                source_channel: "fxo-1".into(),
                trusted_device_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
                listen_port,
            },
            name: "Runtime test".into(),
            line_version: 1,
            readiness_attempt: None,
        };
        let manager = Arc::new(CallerIdManager::new());
        let generation = manager
            .replace_supervisor(
                CancellationToken::new(),
                move |_generation, supervisor_cancel| async move {
                    supervisor_cancel.cancelled().await;
                },
            )
            .await
            .expect("runtime test generation");
        let (sender, mut receiver) = mpsc::channel(4);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(run_udp_line(
            socket,
            line,
            Arc::clone(&manager),
            generation,
            sender,
            cancel.clone(),
        ));
        let client = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let packet = invite(
            &format!("sip:callerid@127.0.0.1:{listen_port}"),
            "<sip:2101234567@127.0.0.1>",
            "runtime-call@ht813",
        );

        client
            .send_to(&packet, (Ipv4Addr::LOCALHOST, listen_port))
            .await
            .unwrap();
        let mut response = vec![0_u8; 2_048];
        let (trying_length, _) =
            tokio::time::timeout(Duration::from_secs(1), client.recv_from(&mut response))
                .await
                .unwrap()
                .unwrap();
        assert!(response[..trying_length].starts_with(b"SIP/2.0 100 Trying\r\n"));
        let (busy_length, _) =
            tokio::time::timeout(Duration::from_secs(1), client.recv_from(&mut response))
                .await
                .unwrap()
                .unwrap();
        assert!(response[..busy_length].starts_with(b"SIP/2.0 486 Busy Here\r\n"));
        let first = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .expect("one queued Caller ID event");
        assert_eq!(first.invite.provider_event_id, "runtime-call@ht813");

        client
            .send_to(&packet, (Ipv4Addr::LOCALHOST, listen_port))
            .await
            .unwrap();
        for expected in [b"SIP/2.0 100".as_slice(), b"SIP/2.0 486".as_slice()] {
            let (length, _) =
                tokio::time::timeout(Duration::from_secs(1), client.recv_from(&mut response))
                    .await
                    .unwrap()
                    .unwrap();
            assert!(response[..length].starts_with(expected));
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), receiver.recv())
                .await
                .is_err(),
            "INVITE retransmission must not enqueue a second server event"
        );
        assert_eq!(manager.get_status().calls_detected, 1);

        cancel.cancel();
        task.await.unwrap();
        manager.stop().await;
    }

    #[test]
    fn event_body_omits_readiness_metadata_resolved_by_the_server() {
        let occurred_at = DateTime::parse_from_rfc3339("2026-07-28T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let pending = PendingEvent {
            invite: ParsedInvite {
                caller_number: Some("2101234567".into()),
                presentation: Presentation::Allowed,
                provider_event_id: "body-call@ht813".into(),
            },
            occurred_at,
        };

        let source = parse_source_line(&source_line()).unwrap().source;
        let body = build_event_body(&source, &pending);
        assert_eq!(body["providerEventId"], "body-call@ht813");
        assert_eq!(body["presentation"], "allowed");
        assert!(body.get("readinessAttemptId").is_none());
    }

    #[test]
    fn event_body_posts_the_exact_current_source_version_and_channel_identity() {
        let line = parse_source_line(&reviewed_source_line(
            "grandstream_ht841_fxo",
            3,
            "fxo-3",
            5063,
        ))
        .unwrap();
        let pending = PendingEvent {
            invite: ParsedInvite {
                caller_number: Some("2101234567".into()),
                presentation: Presentation::Allowed,
                provider_event_id: "source-bound-call@grandstream".into(),
            },
            occurred_at: DateTime::parse_from_rfc3339("2026-07-28T12:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        };

        let body = build_event_body(&line.source, &pending);

        assert_eq!(body["sourceId"], SOURCE_ID);
        assert_eq!(body["sourceVersion"], 7);
        assert_eq!(body["sourceChannel"], "fxo-3");
        assert!(body.get("trustedDeviceIp").is_none());
        assert!(body.get("deviceProfileKey").is_none());
    }

    #[test]
    fn readiness_changes_update_in_place_without_rebinding_udp() {
        let current = parse_source_line(&source_line()).unwrap();
        let mut next_value = source_line();
        next_value["version"] = json!(5);
        next_value["name"] = json!("Renamed line");
        next_value["readinessAttempt"] = json!({
            "attemptId": "018f7684-1436-7d3d-a3f8-58b1bf600dc0",
            "lineVersion": 5,
            "expiresAt": "2099-07-28T12:00:00Z"
        });
        let next = parse_source_line(&next_value).unwrap();

        assert!(!requires_udp_rebind(&current, &next));

        next_value["config"]["listenPort"] = json!(5061);
        let moved = parse_source_line(&next_value).unwrap();
        assert!(requires_udp_rebind(&current, &moved));
    }

    #[test]
    fn source_listener_readiness_ack_body_is_exact_and_server_issued() {
        let mut value = source_line();
        value["readinessAttempt"] = json!({
            "attemptId": "018f7684-1436-7d3d-a3f8-58b1bf600dc0",
            "lineVersion": 4,
            "expiresAt": "2099-07-28T12:00:00Z"
        });
        let line = parse_source_line(&value).unwrap();

        assert_eq!(
            build_source_readiness_ack(&line, Utc::now()),
            Some(json!({
                "attemptId": "018f7684-1436-7d3d-a3f8-58b1bf600dc0",
                "lineId": LINE_ID,
                "lineVersion": 4,
                "capability": "source_listener"
            }))
        );
        assert_eq!(
            build_source_readiness_ack(&parse_source_line(&source_line()).unwrap(), Utc::now(),),
            None
        );
    }

    #[tokio::test]
    async fn source_readiness_stays_pending_until_success_and_retries_new_attempts() {
        let mut value = source_line();
        value["readinessAttempt"] = json!({
            "attemptId": "018f7684-1436-7d3d-a3f8-58b1bf600dc0",
            "lineVersion": 4,
            "expiresAt": "2099-07-28T12:00:00Z"
        });
        let cancel = CancellationToken::new();
        let worker_stopped = CancellationToken::new();
        let listener_cancel = cancel.clone();
        let publisher_cancel = cancel.clone();
        let mut active = ActiveLine {
            config: parse_source_line(&value).unwrap(),
            cancel,
            worker_stopped,
            listener_task: tauri::async_runtime::spawn(async move {
                listener_cancel.cancelled().await;
            }),
            publisher_task: tauri::async_runtime::spawn(async move {
                publisher_cancel.cancelled().await;
            }),
            readiness_acknowledged: None,
        };

        let first = active
            .pending_readiness_ack(Utc::now())
            .expect("first ACK remains pending");
        assert_eq!(
            first.0 .0.to_string(),
            "018f7684-1436-7d3d-a3f8-58b1bf600dc0"
        );
        assert!(active.pending_readiness_ack(Utc::now()).is_some());
        active.mark_readiness_acknowledged(first.0);
        assert!(active.pending_readiness_ack(Utc::now()).is_none());

        value["version"] = json!(5);
        value["readinessAttempt"] = json!({
            "attemptId": "018f7684-1436-7d3d-a3f8-58b1bf600dc1",
            "lineVersion": 5,
            "expiresAt": "2099-07-28T12:01:00Z"
        });
        active.config = parse_source_line(&value).unwrap();
        assert!(active.pending_readiness_ack(Utc::now()).is_some());
        active.retire().await;
    }

    #[test]
    fn packet_token_bucket_bounds_work_before_sip_parsing_or_responses() {
        let now = Instant::now();
        let mut limiter = PacketTokenBucket::new(2, 2, Duration::from_secs(60), now);

        assert!(limiter.allow(now));
        assert!(limiter.allow(now));
        assert!(!limiter.allow(now));
        assert!(limiter.allow(now + Duration::from_secs(30)));
        assert!(!limiter.allow(now + Duration::from_secs(30)));
        assert!(limiter.allow(now + Duration::from_secs(60)));
    }
}
