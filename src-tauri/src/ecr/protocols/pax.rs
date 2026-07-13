//! PAX protocol for PAX Android-based payment terminals.
//!
//! Uses STX/ETX framing with field separators and LRC checksum.
//! Supported models: A80, A920, S300, D210.

use crate::ecr::protocol::*;
use crate::ecr::transport::EcrTransport;
use chrono::Utc;
use tracing::{debug, info, warn};

// ---------------------------------------------------------------------------
// PAX constants
// ---------------------------------------------------------------------------

const STX: u8 = 0x02;
const ETX: u8 = 0x03;
const FS: u8 = 0x1C; // Field separator

// Transaction types
const PAX_SALE: &str = "01";
const PAX_REFUND: &str = "02";
const PAX_VOID: &str = "16";
const PAX_SETTLE: &str = "50";

const DEFAULT_TIMEOUT_MS: u64 = 60000;

/// Wave 2 C14: build the `raw_response` JSON attached to a PAX
/// `TransactionResponse` / `SettlementResult`.
///
/// The PAX terminal returns a vector of fields that includes the response
/// code, authorization code, card last-4, card brand, and arbitrary TLV
/// data that can embed expiry or BIN. Emitting the full vector to the
/// frontend (where every renderer log, Tauri event inspector, or
/// screenshot tool can read it) is a PCI-adjacent leak.
///
/// In release builds we strip to the single field the renderer actually
/// needs for error-surfacing — the response code — and drop the rest.
/// Debug builds keep the full dump so protocol work stays debuggable.
#[inline]
fn redacted_raw_response(fields: &[String]) -> serde_json::Value {
    if cfg!(debug_assertions) {
        serde_json::json!({ "fields": fields })
    } else {
        serde_json::json!({
            "responseCode": fields.first().cloned().unwrap_or_default(),
        })
    }
}

// ---------------------------------------------------------------------------
// Protocol implementation
// ---------------------------------------------------------------------------

/// PAX protocol adapter.
pub struct PaxProtocol {
    transport: Box<dyn EcrTransport>,
    initialized: bool,
    transaction_timeout_ms: u64,
}

impl PaxProtocol {
    pub fn new(transport: Box<dyn EcrTransport>, config: &serde_json::Value) -> Self {
        let timeout = config
            .get("transactionTimeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        Self {
            transport,
            initialized: false,
            transaction_timeout_ms: timeout,
        }
    }

    /// Build a PAX command frame.
    /// Format: STX + Command + FS + Field1 + FS + Field2 + ... + ETX + LRC
    fn build_frame(command: &str, fields: &[&str]) -> Vec<u8> {
        let mut frame = Vec::new();
        frame.push(STX);
        frame.extend_from_slice(command.as_bytes());
        for field in fields {
            frame.push(FS);
            frame.extend_from_slice(field.as_bytes());
        }
        frame.push(ETX);
        // LRC: XOR of all bytes between STX (exclusive) and ETX (inclusive)
        let lrc = frame[1..].iter().fold(0u8, |acc, &b| acc ^ b);
        frame.push(lrc);
        frame
    }

    /// Parse a PAX response frame. Returns list of fields.
    ///
    /// Wave 11 L: also verifies the trailing LRC byte. PAX response
    /// frames are `STX | <payload> | ETX | LRC` where the LRC is the
    /// XOR of every byte from the byte AFTER STX through ETX
    /// inclusive (matching the symmetric `build_frame` rule above).
    /// A corrupted frame in transit (cable noise, partial read,
    /// terminal misbehaviour) used to be parsed as if intact —
    /// silently returning whatever fields the corrupted bytes split
    /// into. The check is cheap (one XOR pass) and the alternative
    /// is downstream parsing of garbage as a payment status.
    fn parse_response(raw: &[u8]) -> Result<Vec<String>, String> {
        if raw.is_empty() {
            return Err("Empty response from PAX terminal".into());
        }

        // Find STX..ETX boundaries
        let stx_pos = raw.iter().position(|&b| b == STX);
        let etx_pos = raw.iter().rposition(|&b| b == ETX);

        match (stx_pos, etx_pos) {
            (Some(s), Some(e)) if e > s => {
                // LRC byte must follow ETX. If the buffer was truncated
                // mid-frame the byte simply isn't present — flag as
                // invalid rather than parsing the maybe-payload bytes.
                let lrc_pos = e + 1;
                if lrc_pos >= raw.len() {
                    return Err(format!(
                        "Truncated PAX frame: missing LRC after ETX at offset {e}"
                    ));
                }
                let received_lrc = raw[lrc_pos];
                // LRC is XOR over (STX, ETX] — bytes after STX through
                // ETX inclusive — matching `build_frame`.
                let computed_lrc = raw[s + 1..=e].iter().fold(0u8, |acc, &b| acc ^ b);
                if received_lrc != computed_lrc {
                    return Err(format!(
                        "PAX frame LRC mismatch: expected {computed_lrc:02X}, got {received_lrc:02X}"
                    ));
                }

                let payload = &raw[s + 1..e];
                let fields: Vec<String> = payload
                    .split(|&b| b == FS)
                    .map(|chunk| String::from_utf8_lossy(chunk).to_string())
                    .collect();
                Ok(fields)
            }
            _ => Err(format!(
                "Invalid PAX frame: {:02X?}",
                &raw[..raw.len().min(20)]
            )),
        }
    }

    /// Send a command and receive parsed response fields.
    fn send_command(&mut self, command: &str, fields: &[&str]) -> Result<Vec<String>, String> {
        let frame = Self::build_frame(command, fields);
        let raw = self
            .transport
            .send_and_receive(&frame, self.transaction_timeout_ms)?;
        Self::parse_response(&raw)
    }

    /// Format amount in cents to PAX amount string (no decimal point).
    fn format_amount(cents: i64) -> String {
        format!("{}", cents.unsigned_abs())
    }

    /// Classify a PAX POSLink T00 response code as approved or declined.
    ///
    /// Gap review 2026-07-10 P0: the success code is exactly "000000" (some
    /// device families abbreviate it "00"). The previous logic ALSO approved
    /// any code with the prefix "00" via `code.starts_with("00")` — but
    /// decline/error codes such as "000100" (DECLINE) share that prefix, so
    /// real declines were recorded as approvals and the customer's order was
    /// marked paid without a charge. Only the exact success codes approve;
    /// everything else (including any other "00…" code) is a decline.
    fn classify_response_code(code: Option<&str>) -> TransactionStatus {
        match code {
            Some("000000") | Some("00") => TransactionStatus::Approved,
            _ => TransactionStatus::Declined,
        }
    }
}

impl EcrProtocol for PaxProtocol {
    fn name(&self) -> &str {
        "PAX"
    }

    fn initialize(&mut self) -> Result<(), String> {
        if !self.transport.is_connected() {
            self.transport.connect()?;
        }

        // PAX: send initialization / get info
        let fields = self.send_command("A00", &["1.28"])?;
        debug!("PAX init response: {fields:?}");

        self.initialized = true;
        info!("PAX protocol initialized");
        Ok(())
    }

    fn process_transaction(
        &mut self,
        request: &TransactionRequest,
    ) -> Result<TransactionResponse, String> {
        let started = Utc::now().to_rfc3339();

        let trans_type = match request.transaction_type {
            TransactionType::Sale => PAX_SALE,
            TransactionType::Refund => PAX_REFUND,
            TransactionType::Void => PAX_VOID,
            _ => {
                return Err(format!(
                    "PAX does not support {:?}",
                    request.transaction_type
                ))
            }
        };

        let amount_str = Self::format_amount(request.amount);

        // Build T00 DoCredit command
        // Fields: TransType, Amount, TipAmount, CashBack, FuelAmount, TaxAmount,
        //         ECRRefNum, OrigRefNum
        let tip = request
            .tip_amount
            .map(Self::format_amount)
            .unwrap_or_default();
        let ecr_ref = request.order_id.as_deref().unwrap_or("");
        let orig_ref = request.original_transaction_id.as_deref().unwrap_or("");

        let fields = self.send_command(
            "T00",
            &[
                trans_type,
                &amount_str,
                &tip,
                "", // cash back
                "", // fuel
                "", // tax
                ecr_ref,
                orig_ref,
            ],
        )?;

        // Parse response fields
        // Expected: ResponseCode, AuthCode, HostRefNum, CardType, CardLastFour, EntryMode, ...
        let status = Self::classify_response_code(fields.first().map(|s| s.as_str()));

        let completed = Utc::now().to_rfc3339();
        Ok(TransactionResponse {
            transaction_id: request.transaction_id.clone(),
            status,
            authorization_code: fields.get(1).cloned(),
            terminal_reference: fields.get(2).cloned(),
            fiscal_receipt_number: None,
            fiscal_z_number: None,
            card_type: fields.get(3).cloned(),
            card_last_four: fields.get(4).cloned(),
            entry_method: fields.get(5).cloned(),
            customer_receipt_lines: None,
            merchant_receipt_lines: None,
            error_message: if status == TransactionStatus::Declined {
                fields.first().cloned()
            } else {
                None
            },
            error_code: if status == TransactionStatus::Declined {
                fields.first().cloned()
            } else {
                None
            },
            raw_response: Some(redacted_raw_response(&fields)),
            started_at: started,
            completed_at: completed,
        })
    }

    fn cancel_transaction(&mut self) -> Result<(), String> {
        let _ = self.send_command("A14", &[])?;
        info!("PAX transaction cancelled");
        Ok(())
    }

    fn get_status(&mut self) -> Result<DeviceStatus, String> {
        let fields = self.send_command("A00", &["1.28"])?;
        Ok(DeviceStatus {
            connected: true,
            ready: fields
                .first()
                .map(|s| s == "000000" || s == "00")
                .unwrap_or(false),
            busy: false,
            error: None,
            firmware_version: fields.get(1).cloned(),
            serial_number: fields.get(2).cloned(),
            fiscal_receipt_counter: None,
            fiscal_z_counter: None,
        })
    }

    fn settlement(&mut self) -> Result<SettlementResult, String> {
        let fields = self.send_command("T00", &[PAX_SETTLE, "0", "", "", "", "", "", ""])?;

        let success = fields
            .first()
            .map(|s| s == "000000" || s == "00")
            .unwrap_or(false);

        info!("PAX settlement: success={success}");
        Ok(SettlementResult {
            success,
            transaction_count: fields.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
            total_amount: fields
                .get(2)
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0),
            z_number: None,
            error_message: if success {
                None
            } else {
                fields.first().cloned()
            },
            raw_response: Some(redacted_raw_response(&fields)),
        })
    }

    fn abort(&mut self) -> Result<(), String> {
        let cancel_result = self.cancel_transaction();
        let disconnect_result = self.transport.disconnect();
        self.initialized = false;
        cancel_result.and(disconnect_result)
    }

    fn test_connection(&mut self) -> Result<bool, String> {
        if !self.transport.is_connected() {
            self.transport.connect()?;
        }
        match self.send_command("A00", &["1.28"]) {
            Ok(fields) => {
                let ok = !fields.is_empty();
                info!(
                    "PAX test connection: {}",
                    if ok { "OK" } else { "no response" }
                );
                Ok(ok)
            }
            Err(e) => {
                warn!("PAX test connection failed: {e}");
                Ok(false)
            }
        }
    }

    fn send_raw(&mut self, data: &[u8]) -> Result<usize, String> {
        self.transport.send(data)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_frame_structure() {
        let frame = PaxProtocol::build_frame("T00", &["01", "1250"]);
        assert_eq!(frame[0], STX);
        // T00 + FS + 01 + FS + 1250 + ETX + LRC
        assert_eq!(frame[1], b'T');
        assert_eq!(frame[2], b'0');
        assert_eq!(frame[3], b'0');
        assert_eq!(frame[4], FS);
        // Find ETX
        let etx_pos = frame.iter().rposition(|&b| b == ETX).unwrap();
        assert!(etx_pos > 4);
        // LRC is last byte
        assert_eq!(frame.len(), etx_pos + 2);
    }

    #[test]
    fn test_lrc_calculation() {
        let frame = PaxProtocol::build_frame("T00", &["01"]);
        let etx_pos = frame.iter().rposition(|&b| b == ETX).unwrap();
        let computed_lrc = frame[1..=etx_pos].iter().fold(0u8, |acc, &b| acc ^ b);
        assert_eq!(frame[etx_pos + 1], computed_lrc);
    }

    /// Helper: build a `STX | <fields joined by FS> | ETX | LRC` frame
    /// using the real LRC formula. Mirrors what a PAX terminal would
    /// emit on the wire.
    fn build_response_frame(fields: &[&[u8]]) -> Vec<u8> {
        let mut raw = vec![STX];
        for (i, f) in fields.iter().enumerate() {
            if i > 0 {
                raw.push(FS);
            }
            raw.extend_from_slice(f);
        }
        raw.push(ETX);
        let lrc = raw[1..].iter().fold(0u8, |acc, &b| acc ^ b);
        raw.push(lrc);
        raw
    }

    #[test]
    fn test_parse_response_fields() {
        let raw = build_response_frame(&[b"000000", b"AUTH123", b"REF456"]);
        let fields = PaxProtocol::parse_response(&raw).unwrap();
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[0], "000000");
        assert_eq!(fields[1], "AUTH123");
        assert_eq!(fields[2], "REF456");
    }

    /// Wave 11 L: a frame with a corrupted LRC must be rejected, not
    /// silently parsed. Without this guard, a transit error would
    /// produce a "valid" parse of garbage bytes — including possibly
    /// reporting a payment as approved when the terminal actually
    /// declined.
    #[test]
    fn test_parse_response_rejects_corrupt_lrc() {
        let mut raw = build_response_frame(&[b"000000", b"AUTH123"]);
        // Flip the LRC byte's bottom bit to corrupt it.
        let last = raw.len() - 1;
        raw[last] ^= 0x01;

        let result = PaxProtocol::parse_response(&raw);
        assert!(
            result.is_err(),
            "parse_response must reject a frame with corrupted LRC"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("LRC mismatch"),
            "error must mention LRC mismatch; got: {err}"
        );
    }

    /// Wave 11 L: a frame truncated at ETX (no LRC byte present) is
    /// also rejected. The buffer-shape guard prevents a panic on
    /// `raw[lrc_pos]` and surfaces the truncation explicitly.
    #[test]
    fn test_parse_response_rejects_truncated_frame() {
        let raw = vec![STX, b'0', b'0', b'0', ETX]; // no LRC after ETX

        let result = PaxProtocol::parse_response(&raw);
        assert!(
            result.is_err(),
            "parse_response must reject a frame missing LRC"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("Truncated"),
            "error must mention truncation; got: {err}"
        );
    }

    #[test]
    fn test_format_amount() {
        assert_eq!(PaxProtocol::format_amount(1250), "1250");
        assert_eq!(PaxProtocol::format_amount(0), "0");
        assert_eq!(PaxProtocol::format_amount(99999), "99999");
    }

    #[test]
    fn test_parse_empty_response_errors() {
        assert!(PaxProtocol::parse_response(&[]).is_err());
    }

    // Gap review 2026-07-10 P0: only the exact PAX success code approves.
    #[test]
    fn test_classify_response_code_approves_only_exact_success() {
        assert_eq!(
            PaxProtocol::classify_response_code(Some("000000")),
            TransactionStatus::Approved
        );
        assert_eq!(
            PaxProtocol::classify_response_code(Some("00")),
            TransactionStatus::Approved
        );
    }

    #[test]
    fn test_classify_response_code_declines_00_prefixed_error_codes() {
        // These all begin with "00" and were WRONGLY approved by the old
        // `starts_with("00")` arm. Each is a decline/error in the PAX code space.
        for code in ["000100", "000200", "001000", "000001", "0099", "00A1"] {
            assert_eq!(
                PaxProtocol::classify_response_code(Some(code)),
                TransactionStatus::Declined,
                "code {code} shares the 00 prefix but is NOT a success — must decline",
            );
        }
    }

    #[test]
    fn test_classify_response_code_declines_non_success() {
        assert_eq!(
            PaxProtocol::classify_response_code(Some("100000")),
            TransactionStatus::Declined
        );
        assert_eq!(
            PaxProtocol::classify_response_code(Some("")),
            TransactionStatus::Declined
        );
        assert_eq!(
            PaxProtocol::classify_response_code(None),
            TransactionStatus::Declined
        );
    }
}
