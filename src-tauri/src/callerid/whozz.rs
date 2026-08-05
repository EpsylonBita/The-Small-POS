//! Passive parser for CallerID.com Ethernet Link / Whozz Calling? UDP data.
//!
//! The parser deliberately implements only the documented inbound-start
//! record. It never sends discovery, setup, acknowledgement, or call-control
//! packets to the device, so the analogue voice path remains untouched.

const HEADER_LEN: usize = 21;
const MAX_PACKET_BYTES: usize = 256;
const MIN_CALL_RECORD_BYTES: usize = 46;
const MAX_CALL_RECORD_BYTES: usize = 61;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WhozzUnitSerial {
    Serial([u8; 6]),
    UnitAndSerial { unit: [u8; 6], serial: [u8; 6] },
}

impl WhozzUnitSerial {
    /// Accepts the device serial as 12 hexadecimal digits, or the unit and
    /// serial concatenated as 24 hexadecimal digits. Common visual separators
    /// are ignored so values copied from the vendor utility remain usable.
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        let compact = value
            .trim()
            .chars()
            .filter(|character| !matches!(character, ':' | '-' | ' '))
            .collect::<String>();
        if compact.len() != 12 && compact.len() != 24 {
            return Err(
                "Whozz unitSerial must contain 12 serial hex digits or 24 unit-and-serial hex digits"
                    .into(),
            );
        }
        if !compact.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Whozz unitSerial must contain hexadecimal digits only".into());
        }

        let decoded = compact
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair)
                    .map_err(|_| "Whozz unitSerial is not valid ASCII".to_string())?;
                u8::from_str_radix(pair, 16)
                    .map_err(|_| "Whozz unitSerial is not valid hexadecimal".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;

        if decoded.len() == 6 {
            let serial: [u8; 6] = decoded
                .try_into()
                .map_err(|_| "Whozz unitSerial has an invalid serial length".to_string())?;
            return Ok(Self::Serial(serial));
        }

        let unit: [u8; 6] = decoded[..6]
            .try_into()
            .map_err(|_| "Whozz unitSerial has an invalid unit length".to_string())?;
        let serial: [u8; 6] = decoded[6..]
            .try_into()
            .map_err(|_| "Whozz unitSerial has an invalid serial length".to_string())?;
        Ok(Self::UnitAndSerial { unit, serial })
    }

    fn matches_header(&self, packet: &[u8]) -> bool {
        match self {
            Self::Serial(serial) => packet.get(14..20) == Some(serial.as_slice()),
            Self::UnitAndSerial { unit, serial } => {
                packet.get(5..11) == Some(unit.as_slice())
                    && packet.get(14..20) == Some(serial.as_slice())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WhozzParseError {
    Empty,
    Oversized,
    NonAsciiRecord,
    Envelope,
    Identity,
    Channel,
    Record,
    CallerNumber,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WhozzIncomingCall {
    pub caller_number: Option<String>,
    pub restricted: bool,
    /// Deterministic content fingerprint of the canonical vendor frame.
    ///
    /// This is only a bounded local retransmission key, not a durable event ID
    /// or authentication primitive. MD5 is used because it is already a direct
    /// dependency and provides a compact, stable 128-bit digest. Caller data is
    /// never embedded in the emitted provider event ID.
    pub packet_fingerprint: String,
}

pub(crate) fn configured_channel(value: &str) -> Result<u8, String> {
    let trimmed = value.trim();
    let digits = trimmed
        .strip_prefix("line-")
        .or_else(|| trimmed.strip_prefix("fxo-"))
        .unwrap_or(trimmed);
    let channel = digits
        .parse::<u8>()
        .map_err(|_| "Whozz sourceChannel must identify one numeric line".to_string())?;
    if !(1..=99).contains(&channel) {
        return Err("Whozz sourceChannel must be between line 1 and line 99".into());
    }
    Ok(channel)
}

/// Cheap framing check used before counting a UDP datagram as a Caller ID
/// candidate. The full parser still validates every byte and bound.
pub(crate) fn is_call_candidate(packet: &[u8]) -> bool {
    packet.len() >= HEADER_LEN + 7
        && packet.get(..5) == Some(b"^^<U>")
        && packet.get(11..14) == Some(b"<S>")
        && packet.get(20) == Some(&b'$')
        && packet.get(21).is_some_and(u8::is_ascii_digit)
        && packet.get(22).is_some_and(u8::is_ascii_digit)
        && packet.get(23) == Some(&b' ')
}

/// Parses one official byte-21 framed packet. `Ok(None)` means a valid packet
/// that is intentionally ignored because it is not an inbound call start.
pub(crate) fn parse_incoming_start(
    packet: &[u8],
    expected_channel: u8,
    expected_identity: Option<&WhozzUnitSerial>,
) -> Result<Option<WhozzIncomingCall>, WhozzParseError> {
    if packet.is_empty() {
        return Err(WhozzParseError::Empty);
    }
    if packet.len() > MAX_PACKET_BYTES {
        return Err(WhozzParseError::Oversized);
    }
    if packet.len() < HEADER_LEN
        || packet.get(..5) != Some(b"^^<U>")
        || packet.get(11..14) != Some(b"<S>")
        || packet.get(20) != Some(&b'$')
    {
        return Err(WhozzParseError::Envelope);
    }
    if expected_identity.is_some_and(|identity| !identity.matches_header(packet)) {
        return Err(WhozzParseError::Identity);
    }

    let mut record = packet.get(HEADER_LEN..).ok_or(WhozzParseError::Envelope)?;
    if record.ends_with(b"\r\n") {
        record = &record[..record.len() - 2];
    } else if record.ends_with(b"\r") || record.ends_with(b"\n") {
        return Err(WhozzParseError::Record);
    }
    if !(MIN_CALL_RECORD_BYTES..=MAX_CALL_RECORD_BYTES).contains(&record.len()) {
        return Err(WhozzParseError::Record);
    }
    if !record.is_ascii() {
        return Err(WhozzParseError::NonAsciiRecord);
    }
    if record.iter().any(|byte| byte.is_ascii_control()) {
        return Err(WhozzParseError::Record);
    }

    for separator in [2, 4, 6, 11, 13, 16, 22, 31] {
        if record.get(separator) != Some(&b' ') {
            return Err(WhozzParseError::Record);
        }
    }
    if !record[..2].iter().all(u8::is_ascii_digit)
        || !record[7..11].iter().all(u8::is_ascii_digit)
        || !record[17..19].iter().all(u8::is_ascii_digit)
        || record.get(19) != Some(&b'/')
        || !record[20..22].iter().all(u8::is_ascii_digit)
        || !record[23..25].iter().all(u8::is_ascii_digit)
        || record.get(25) != Some(&b':')
        || !record[26..28].iter().all(u8::is_ascii_digit)
        || record.get(28) != Some(&b' ')
        || !matches!(record.get(29), Some(b'A' | b'P'))
        || record.get(30) != Some(&b'M')
    {
        return Err(WhozzParseError::Record);
    }

    let channel = std::str::from_utf8(&record[..2])
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
        .ok_or(WhozzParseError::Channel)?;
    if channel != expected_channel {
        return Err(WhozzParseError::Channel);
    }

    // Other direction/state records are valid CallerID.com traffic but are
    // outside this passive inbound-start contract.
    if record[3] != b'I' || record[5] != b'S' {
        return Ok(None);
    }
    if record[12] != b'G' {
        return Err(WhozzParseError::Record);
    }

    let raw_number = std::str::from_utf8(&record[32..46])
        .map_err(|_| WhozzParseError::NonAsciiRecord)?
        .trim();
    let marker = raw_number.to_ascii_uppercase();
    let (caller_number, restricted) = match marker.as_str() {
        "PRIVATE" | "ANONYMOUS" | "RESTRICTED" => (None, true),
        "OUT-OF-AREA" | "OUT OF AREA" | "UNKNOWN" | "UNAVAILABLE" => (None, false),
        "" => return Err(WhozzParseError::CallerNumber),
        _ => (
            Some(normalize_phone(raw_number).ok_or(WhozzParseError::CallerNumber)?),
            false,
        ),
    };

    // Hash the canonical record after its optional CRLF has been removed. A
    // vendor retransmission must retain the same idempotency key even when
    // transport framing differs, and the digest must remain stable after a
    // POS process restart (unlike randomized/runtime-defined hashers).
    let mut canonical = Vec::with_capacity(HEADER_LEN + record.len());
    canonical.extend_from_slice(&packet[..HEADER_LEN]);
    canonical.extend_from_slice(record);
    Ok(Some(WhozzIncomingCall {
        caller_number,
        restricted,
        packet_fingerprint: format!("{:x}", md5::compute(canonical)),
    }))
}

fn normalize_phone(value: &str) -> Option<String> {
    let mut normalized = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_digit() || (character == '+' && normalized.is_empty()) {
            normalized.push(character);
        } else if !matches!(character, ' ' | '-' | '.' | '(' | ')') {
            return None;
        }
    }
    let digit_count = normalized.bytes().filter(u8::is_ascii_digit).count();
    (3..=32).contains(&digit_count).then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(record: &str) -> Vec<u8> {
        // The unit bytes deliberately contain '$'. Parsing must still begin at
        // official byte 21 rather than searching for the first dollar sign.
        let mut packet = b"^^<U>\x00\x00$\x00\x89\x79<S>\x00\x00\x00\x84\x48\x84$".to_vec();
        packet.extend_from_slice(record.as_bytes());
        packet
    }

    #[test]
    fn parses_official_byte_21_inbound_start_without_exposing_header_dollars() {
        let parsed = parse_incoming_start(
            &packet("01 I S 0000 G A0 03/26 02:47 PM 555-867-5309  JOHN DOE"),
            1,
            Some(&WhozzUnitSerial::parse("000000844884").expect("documented Whozz serial bytes")),
        )
        .expect("valid Whozz packet")
        .expect("inbound start");

        assert_eq!(parsed.caller_number.as_deref(), Some("5558675309"));
        assert!(!parsed.restricted);
    }

    #[test]
    fn accepts_full_unit_and_serial_identity_and_terminal_crlf() {
        let value = packet("01 I S 0000 G A0 03/26 02:47 PM 555-867-5309  JOHN DOE");
        let without_crlf = parse_incoming_start(
            &value,
            1,
            Some(
                &WhozzUnitSerial::parse("000024008979:000000844884")
                    .expect("unit and serial identity"),
            ),
        )
        .expect("valid packet without CRLF")
        .expect("inbound start");

        let mut with_crlf = value;
        with_crlf.extend_from_slice(b"\r\n");
        let with_crlf = parse_incoming_start(
            &with_crlf,
            1,
            Some(
                &WhozzUnitSerial::parse("000024008979:000000844884")
                    .expect("unit and serial identity"),
            ),
        )
        .expect("valid packet with CRLF")
        .expect("inbound start");

        assert_eq!(
            without_crlf.packet_fingerprint, with_crlf.packet_fingerprint,
            "transport-only CRLF framing must not change the event idempotency key"
        );
        assert_eq!(without_crlf.packet_fingerprint.len(), 32);
        assert!(without_crlf
            .packet_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn ignores_non_start_records_and_rejects_wrong_channel_or_checksum() {
        assert_eq!(
            parse_incoming_start(
                &packet("01 I E 0000 G A0 03/26 02:47 PM 555-867-5309  JOHN DOE"),
                1,
                None,
            )
            .unwrap(),
            None,
        );
        assert_eq!(
            parse_incoming_start(
                &packet("02 I S 0000 G A0 03/26 02:47 PM 555-867-5309  JOHN DOE"),
                1,
                None,
            ),
            Err(WhozzParseError::Channel),
        );
        assert_eq!(
            parse_incoming_start(
                &packet("01 I S 0000 B A0 03/26 02:47 PM 555-867-5309  JOHN DOE"),
                1,
                None,
            ),
            Err(WhozzParseError::Record),
        );
    }

    #[test]
    fn keeps_private_callers_private_and_fails_closed_on_identity_or_size() {
        let private = parse_incoming_start(
            &packet("01 I S 0000 G A0 03/26 02:47 PM PRIVATE       PRIVATE"),
            1,
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(private.caller_number, None);
        assert!(private.restricted);

        assert_eq!(
            parse_incoming_start(
                &packet("01 I S 0000 G A0 03/26 02:47 PM 555-867-5309  JOHN DOE"),
                1,
                Some(&WhozzUnitSerial::parse("000000000001").unwrap()),
            ),
            Err(WhozzParseError::Identity),
        );
        assert_eq!(
            parse_incoming_start(&vec![b'A'; MAX_PACKET_BYTES + 1], 1, None),
            Err(WhozzParseError::Oversized),
        );
    }

    #[test]
    fn parses_only_explicit_numeric_channel_forms() {
        assert_eq!(configured_channel("01").unwrap(), 1);
        assert_eq!(configured_channel("line-8").unwrap(), 8);
        assert_eq!(configured_channel("fxo-4").unwrap(), 4);
        assert!(configured_channel("primary-1").is_err());
        assert!(configured_channel("0").is_err());
    }
}
