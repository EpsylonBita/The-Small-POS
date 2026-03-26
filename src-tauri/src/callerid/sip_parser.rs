//! Manual SIP parsing and request building for Caller ID.
//!
//! The module intentionally stays lightweight and focused on the subset needed
//! for Caller ID detection:
//! - SIP INVITE parsing
//! - REGISTER request building
//! - Digest-auth challenge parsing for 401/407
//! - Minimal SIP response helpers

use md5::compute as md5_compute;

use super::types::CallerIdTransport;

/// Result of parsing a SIP INVITE message.
#[derive(Debug, Clone, PartialEq)]
pub struct SipInviteInfo {
    pub caller_number: String,
    pub caller_name: Option<String>,
    pub call_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SipDigestChallenge {
    pub realm: String,
    pub nonce: String,
    pub opaque: Option<String>,
    pub algorithm: Option<String>,
    pub qop: Option<String>,
    pub is_proxy: bool,
}

pub struct RegisterRequestParams<'a> {
    pub server: &'a str,
    pub port: u16,
    pub transport: CallerIdTransport,
    pub username: &'a str,
    pub contact_host: &'a str,
    pub contact_port: u16,
    pub call_id: &'a str,
    pub cseq: u32,
    pub expires: u32,
    pub authorization_header: Option<&'a str>,
}

pub fn parse_sip_invite(data: &[u8]) -> Option<SipInviteInfo> {
    let text = std::str::from_utf8(data).ok()?;
    if !text.starts_with("INVITE ") {
        return None;
    }

    let headers_section = text.split("\r\n\r\n").next().unwrap_or(text);
    let headers: Vec<&str> = headers_section.split("\r\n").collect();

    let call_id =
        find_header_value(&headers, "Call-ID").or_else(|| find_header_value(&headers, "i"))?;

    let (caller_number, caller_name) =
        if let Some(pai) = find_header_value(&headers, "P-Asserted-Identity") {
            parse_name_addr(pai)
        } else if let Some(from) =
            find_header_value(&headers, "From").or_else(|| find_header_value(&headers, "f"))
        {
            parse_name_addr(from)
        } else {
            return None;
        };

    if caller_number.is_empty() {
        return None;
    }

    Some(SipInviteInfo {
        caller_number,
        caller_name,
        call_id: call_id.to_string(),
    })
}

pub fn build_register_request(params: &RegisterRequestParams<'_>) -> Vec<u8> {
    let transport = match params.transport {
        CallerIdTransport::Udp => "UDP",
        CallerIdTransport::Tcp => "TCP",
    };
    let authorization = params
        .authorization_header
        .map(|value| format!("{value}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "REGISTER sip:{server}:{port} SIP/2.0\r\n\
         Via: SIP/2.0/{transport} {contact_host}:{contact_port};branch=z9hG4bK{cseq:08x}\r\n\
         From: <sip:{username}@{server}>;tag=pos{cseq:06x}\r\n\
         To: <sip:{username}@{server}>\r\n\
         Call-ID: {call_id}\r\n\
         CSeq: {cseq} REGISTER\r\n\
         Contact: <sip:{username}@{contact_host}:{contact_port};transport={transport_lower}>\r\n\
         Max-Forwards: 70\r\n\
         Expires: {expires}\r\n\
         User-Agent: TheSmallPOS/1.0\r\n\
         {authorization}\
         Content-Length: 0\r\n\
         \r\n",
        server = params.server,
        port = params.port,
        username = params.username,
        contact_host = params.contact_host,
        contact_port = params.contact_port,
        call_id = params.call_id,
        cseq = params.cseq,
        expires = params.expires,
        authorization = authorization,
        transport = transport,
        transport_lower = transport.to_ascii_lowercase(),
    );
    request.into_bytes()
}

pub fn parse_digest_challenge(data: &[u8]) -> Option<SipDigestChallenge> {
    let text = std::str::from_utf8(data).ok()?;
    if !(text.starts_with("SIP/2.0 401") || text.starts_with("SIP/2.0 407")) {
        return None;
    }

    let headers_section = text.split("\r\n\r\n").next().unwrap_or(text);
    let headers: Vec<&str> = headers_section.split("\r\n").collect();

    let header = find_header_value(&headers, "WWW-Authenticate")
        .map(|value| (false, value))
        .or_else(|| find_header_value(&headers, "Proxy-Authenticate").map(|value| (true, value)))?;

    let digest_payload = header.1.strip_prefix("Digest ").unwrap_or(header.1).trim();
    let params = parse_comma_params(digest_payload);
    let realm = params.get("realm")?.to_string();
    let nonce = params.get("nonce")?.to_string();

    Some(SipDigestChallenge {
        realm,
        nonce,
        opaque: params.get("opaque").cloned(),
        algorithm: params.get("algorithm").cloned(),
        qop: params.get("qop").and_then(|value| select_qop(value)),
        is_proxy: header.0,
    })
}

pub fn build_digest_authorization(
    challenge: &SipDigestChallenge,
    username: &str,
    password: &str,
    method: &str,
    uri: &str,
    cnonce: &str,
    nc: u32,
) -> Option<String> {
    if let Some(algorithm) = &challenge.algorithm {
        if !algorithm.eq_ignore_ascii_case("MD5") {
            return None;
        }
    }

    let ha1 = md5_hex(&format!("{username}:{}:{password}", challenge.realm));
    let ha2 = md5_hex(&format!("{method}:{uri}"));
    let response = if let Some(qop) = &challenge.qop {
        md5_hex(&format!(
            "{ha1}:{}:{:08x}:{cnonce}:{qop}:{ha2}",
            challenge.nonce, nc
        ))
    } else {
        md5_hex(&format!("{ha1}:{}:{ha2}", challenge.nonce))
    };

    let header_name = if challenge.is_proxy {
        "Proxy-Authorization"
    } else {
        "Authorization"
    };

    let mut parts = vec![
        format!(r#"username="{username}""#),
        format!(r#"realm="{}""#, challenge.realm),
        format!(r#"nonce="{}""#, challenge.nonce),
        format!(r#"uri="{uri}""#),
        format!(r#"response="{response}""#),
        "algorithm=MD5".to_string(),
    ];

    if let Some(opaque) = &challenge.opaque {
        parts.push(format!(r#"opaque="{opaque}""#));
    }

    if let Some(qop) = &challenge.qop {
        parts.push(format!("qop={qop}"));
        parts.push(format!("nc={nc:08x}"));
        parts.push(format!(r#"cnonce="{cnonce}""#));
    }

    Some(format!("{header_name}: Digest {}", parts.join(", ")))
}

pub fn is_register_ok(data: &[u8]) -> bool {
    parse_status_code(data) == Some(200)
}

pub fn is_auth_challenge(data: &[u8]) -> bool {
    matches!(parse_status_code(data), Some(401 | 407))
}

pub fn parse_status_code(data: &[u8]) -> Option<u16> {
    let text = std::str::from_utf8(data).ok()?;
    let mut parts = text.lines().next()?.split_whitespace();
    if parts.next()? != "SIP/2.0" {
        return None;
    }
    parts.next()?.parse().ok()
}

pub fn content_length(data: &[u8]) -> usize {
    let text = match std::str::from_utf8(data) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    let headers_section = text.split("\r\n\r\n").next().unwrap_or(text);
    let headers: Vec<&str> = headers_section.split("\r\n").collect();
    find_header_value(&headers, "Content-Length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn find_header_value<'a>(headers: &[&'a str], name: &str) -> Option<&'a str> {
    let prefix_lower = format!("{}:", name.to_lowercase());
    for line in headers {
        let line_lower = line.to_lowercase();
        if line_lower.starts_with(&prefix_lower) {
            let value = &line[name.len() + 1..];
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

fn parse_name_addr(value: &str) -> (String, Option<String>) {
    let value = value.trim();
    let display_name = extract_display_name(value);

    let uri = if let Some(start) = value.find('<') {
        if let Some(end) = value[start..].find('>') {
            &value[start + 1..start + end]
        } else {
            value
        }
    } else {
        value.split(';').next().unwrap_or(value).trim()
    };

    let user = extract_user_from_uri(uri);
    let phone = normalize_sip_phone(&user);
    (phone, display_name)
}

fn extract_display_name(value: &str) -> Option<String> {
    let angle = value.find('<')?;
    let before_angle = value[..angle].trim();

    if before_angle.is_empty() {
        return None;
    }

    if before_angle.starts_with('"') && before_angle.ends_with('"') && before_angle.len() > 2 {
        let unquoted = &before_angle[1..before_angle.len() - 1];
        let trimmed = unquoted.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    } else if let Some(stripped) = before_angle.strip_prefix('"') {
        if let Some(end_quote) = stripped.find('"') {
            let unquoted = &stripped[..end_quote];
            let trimmed = unquoted.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        } else {
            None
        }
    } else {
        let trimmed = before_angle.trim();
        if trimmed.is_empty() || trimmed.starts_with("sip:") || trimmed.starts_with("tel:") {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

fn extract_user_from_uri(uri: &str) -> String {
    let uri = uri.trim();

    let without_scheme = if let Some(rest) = uri.strip_prefix("sip:") {
        rest
    } else if let Some(rest) = uri.strip_prefix("sips:") {
        rest
    } else if let Some(rest) = uri.strip_prefix("tel:") {
        return rest.split(';').next().unwrap_or(rest).trim().to_string();
    } else {
        uri
    };

    let user = if let Some(at_pos) = without_scheme.find('@') {
        &without_scheme[..at_pos]
    } else {
        without_scheme.split(';').next().unwrap_or(without_scheme)
    };

    user.split(';').next().unwrap_or(user).trim().to_string()
}

fn normalize_sip_phone(user: &str) -> String {
    let trimmed = user.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let is_phone_like = trimmed.chars().all(|c| {
        c.is_ascii_digit() || c == '+' || c == '-' || c == '.' || c == ' ' || c == '(' || c == ')'
    });

    if is_phone_like {
        let cleaned: String = trimmed
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '+')
            .collect();
        if cleaned.is_empty() {
            trimmed.to_string()
        } else {
            cleaned
        }
    } else {
        trimmed.to_string()
    }
}

fn parse_comma_params(input: &str) -> std::collections::HashMap<String, String> {
    let mut params = std::collections::HashMap::new();
    let mut current = String::new();
    let mut in_quotes = false;

    for ch in input.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                current.push(ch);
            }
            ',' if !in_quotes => {
                insert_auth_param(&mut params, &current);
                current.clear();
            }
            _ => current.push(ch),
        }
    }

    insert_auth_param(&mut params, &current);
    params
}

fn insert_auth_param(params: &mut std::collections::HashMap<String, String>, raw: &str) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    let Some((key, value)) = trimmed.split_once('=') else {
        return;
    };

    let normalized_value = value.trim().trim_matches('"').to_string();
    params.insert(key.trim().to_ascii_lowercase(), normalized_value);
}

fn select_qop(value: &str) -> Option<String> {
    let mut first = None;
    for token in value.split(',') {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            continue;
        }
        if first.is_none() {
            first = Some(trimmed.to_string());
        }
        if trimmed.eq_ignore_ascii_case("auth") {
            return Some("auth".into());
        }
    }
    first
}

fn md5_hex(value: &str) -> String {
    format!("{:x}", md5_compute(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_invite(from: &str, call_id: &str) -> Vec<u8> {
        format!(
            "INVITE sip:100@192.168.1.1 SIP/2.0\r\n\
             Via: SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK776asdhds\r\n\
             From: {from};tag=1928301774\r\n\
             To: <sip:100@192.168.1.1>\r\n\
             Call-ID: {call_id}\r\n\
             CSeq: 314159 INVITE\r\n\
             Max-Forwards: 70\r\n\
             Content-Length: 0\r\n\
             \r\n"
        )
        .into_bytes()
    }

    #[test]
    fn test_parse_invite_with_display_name_and_phone() {
        let data = make_invite(
            "\"John Doe\" <sip:+306912345678@10.0.0.5>",
            "abc123@10.0.0.5",
        );
        let info = parse_sip_invite(&data).unwrap();
        assert_eq!(info.caller_number, "+306912345678");
        assert_eq!(info.caller_name, Some("John Doe".into()));
        assert_eq!(info.call_id, "abc123@10.0.0.5");
    }

    #[test]
    fn test_parse_invite_with_p_asserted_identity() {
        let data = format!(
            "INVITE sip:100@192.168.1.1 SIP/2.0\r\n\
             Via: SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK776\r\n\
             From: \"PBX\" <sip:pbx@10.0.0.5>;tag=abc\r\n\
             P-Asserted-Identity: \"Real Caller\" <sip:+306999888777@10.0.0.5>\r\n\
             To: <sip:100@192.168.1.1>\r\n\
             Call-ID: pai-test@10.0.0.5\r\n\
             CSeq: 1 INVITE\r\n\
             Content-Length: 0\r\n\
             \r\n"
        )
        .into_bytes();
        let info = parse_sip_invite(&data).unwrap();
        assert_eq!(info.caller_number, "+306999888777");
        assert_eq!(info.caller_name, Some("Real Caller".into()));
    }

    #[test]
    fn test_parse_digest_challenge() {
        let data = b"SIP/2.0 401 Unauthorized\r\nWWW-Authenticate: Digest realm=\"sip.example.com\", nonce=\"abc123\", opaque=\"opaque\", qop=\"auth,auth-int\"\r\n\r\n";
        let challenge = parse_digest_challenge(data).unwrap();
        assert_eq!(challenge.realm, "sip.example.com");
        assert_eq!(challenge.nonce, "abc123");
        assert_eq!(challenge.opaque.as_deref(), Some("opaque"));
        assert_eq!(challenge.qop.as_deref(), Some("auth"));
        assert!(!challenge.is_proxy);
    }

    #[test]
    fn test_build_digest_authorization() {
        let challenge = SipDigestChallenge {
            realm: "sip.example.com".into(),
            nonce: "abc123".into(),
            opaque: Some("opaque".into()),
            algorithm: Some("MD5".into()),
            qop: Some("auth".into()),
            is_proxy: false,
        };

        let header = build_digest_authorization(
            &challenge,
            "alice",
            "secret",
            "REGISTER",
            "sip:sip.example.com:5060",
            "cnonce123",
            1,
        )
        .unwrap();

        assert!(header.starts_with("Authorization: Digest "));
        assert!(header.contains("username=\"alice\""));
        assert!(header.contains("qop=auth"));
        assert!(header.contains("cnonce=\"cnonce123\""));
    }

    #[test]
    fn test_build_register_request_with_tcp_and_auth() {
        let request = build_register_request(&RegisterRequestParams {
            server: "sip.example.com",
            port: 5060,
            transport: CallerIdTransport::Tcp,
            username: "200",
            contact_host: "10.0.0.5",
            contact_port: 5070,
            call_id: "call-1",
            cseq: 2,
            expires: 300,
            authorization_header: Some("Authorization: Digest username=\"200\""),
        });
        let text = String::from_utf8(request).unwrap();
        assert!(text.contains("Via: SIP/2.0/TCP 10.0.0.5:5070"));
        assert!(text.contains("Authorization: Digest username=\"200\""));
        assert!(text.contains("transport=tcp"));
    }

    #[test]
    fn test_content_length_defaults_zero() {
        assert_eq!(content_length(b"SIP/2.0 200 OK\r\n\r\n"), 0);
        assert_eq!(
            content_length(b"SIP/2.0 200 OK\r\nContent-Length: 42\r\n\r\n"),
            42
        );
    }
}
