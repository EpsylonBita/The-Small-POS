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
    fn parse_response(raw: &[u8]) -> Result<Vec<String>, String> {
        if raw.is_empty() {
            return Err("Empty response from PAX terminal".into());
        }

        // Find STX..ETX boundaries
        let stx_pos = raw.iter().position(|&b| b == STX);
        let etx_pos = raw.iter().rposition(|&b| b == ETX);

        match (stx_pos, etx_pos) {
            (Some(s), Some(e)) if e > s => {
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
        let status = match fields.first().map(|s| s.as_str()) {
            Some("000000") | Some("00") => TransactionStatus::Approved,
            Some(code) if code.starts_with("00") => TransactionStatus::Approved,
            _ => TransactionStatus::Declined,
        };

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
            raw_response: Some(serde_json::json!({"fields": fields})),
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
            raw_response: Some(serde_json::json!({"fields": fields})),
        })
    }

    fn abort(&mut self) -> Result<(), String> {
        self.cancel_transaction()
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

    #[test]
    fn test_parse_response_fields() {
        let mut raw = vec![STX];
        raw.extend_from_slice(b"000000");
        raw.push(FS);
        raw.extend_from_slice(b"AUTH123");
        raw.push(FS);
        raw.extend_from_slice(b"REF456");
        raw.push(ETX);
        raw.push(0x00); // dummy LRC

        let fields = PaxProtocol::parse_response(&raw).unwrap();
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[0], "000000");
        assert_eq!(fields[1], "AUTH123");
        assert_eq!(fields[2], "REF456");
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
}
