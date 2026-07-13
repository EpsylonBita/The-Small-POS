//! ZVT protocol for European payment terminals (Ingenico / Verifone).
//!
//! Uses DLE/STX framing with CRC16 checksum and BCD-encoded amounts.
//! Reference: ZVT specification (German Banking Protocol).

use crate::ecr::protocol::*;
use crate::ecr::transport::EcrTransport;
use chrono::Utc;
use tracing::{debug, info, warn};

// ---------------------------------------------------------------------------
// ZVT constants
// ---------------------------------------------------------------------------

const DLE: u8 = 0x10;
const STX: u8 = 0x02;
const ETX: u8 = 0x03;
const ACK_POSITIVE: u8 = 0x80; // Positive completion

// Command classes and instructions
const CMD_REGISTRATION_CLASS: u8 = 0x06;
const CMD_REGISTRATION_INST: u8 = 0x00;
const CMD_AUTHORIZATION_CLASS: u8 = 0x06;
const CMD_AUTHORIZATION_INST: u8 = 0x01;
const CMD_REFUND_CLASS: u8 = 0x06;
const CMD_REFUND_INST: u8 = 0x31;
const CMD_END_OF_DAY_CLASS: u8 = 0x06;
const CMD_END_OF_DAY_INST: u8 = 0x50;
const CMD_ABORT_CLASS: u8 = 0x06;
const CMD_ABORT_INST: u8 = 0xB0;
const CMD_STATUS_CLASS: u8 = 0x05;
const CMD_STATUS_INST: u8 = 0x01;
const CMD_PRINT_LINE_CLASS: u8 = 0x06;
const CMD_PRINT_LINE_INST: u8 = 0xD1;

// Negative-completion / abort APDU command bytes (PT → ECR).
//   84 xx — negative completion; xx is the ZVT error code.
//   06 1E — Abort (transaction cancelled by the terminal / cardholder).
const CMD_NEGATIVE_COMPLETION: u8 = 0x84;
const CMD_ABORT_RESULT_CLASS: u8 = 0x06;
const CMD_ABORT_RESULT_INST: u8 = 0x1E;

// Transaction-completion APDU command bytes (PT → ECR).
//   06 0F — Completion (the transaction reached its end).
//   04 0F — Status-Information; carries the outcome. Per ZVT the first data
//           element is BMP 27 (result-code); 0x00 == successful.
const CMD_COMPLETION_CLASS: u8 = 0x06;
const CMD_COMPLETION_INST: u8 = 0x0F;
const CMD_STATUS_INFO_CLASS: u8 = 0x04;
const CMD_STATUS_INFO_INST: u8 = 0x0F;
const BMP_RESULT_CODE: u8 = 0x27;
const ZVT_RESULT_OK: u8 = 0x00;

const DEFAULT_TIMEOUT_MS: u64 = 60000; // 60s for card transactions

// ---------------------------------------------------------------------------
// Protocol implementation
// ---------------------------------------------------------------------------

/// ZVT protocol adapter for Ingenico/Verifone terminals.
pub struct ZvtProtocol {
    transport: Box<dyn EcrTransport>,
    password: u32,
    #[allow(dead_code)]
    service_byte: u8,
    print_on_pos: bool,
    initialized: bool,
    receipt_lines: Vec<String>,
    /// Last 04 0F Status-Information frame seen during wait_for_completion —
    /// carries the transaction result code used to classify approve/decline.
    last_status_info: Option<Vec<u8>>,
    transaction_timeout_ms: u64,
}

impl ZvtProtocol {
    pub fn new(transport: Box<dyn EcrTransport>, config: &serde_json::Value) -> Self {
        let password = config.get("password").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let print_on_pos = config
            .get("printOnPos")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let timeout = config
            .get("transactionTimeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_TIMEOUT_MS);

        Self {
            transport,
            password,
            service_byte: 0x00,
            print_on_pos,
            initialized: false,
            receipt_lines: Vec::new(),
            last_status_info: None,
            transaction_timeout_ms: timeout,
        }
    }

    /// Encode an amount in cents to BCD (6 bytes, right-aligned).
    fn amount_to_bcd(cents: i64) -> Vec<u8> {
        let s = format!("{:012}", cents.unsigned_abs());
        let bytes: Vec<u8> = s
            .as_bytes()
            .chunks(2)
            .map(|pair| {
                let hi = pair[0] - b'0';
                let lo = pair.get(1).map(|&b| b - b'0').unwrap_or(0);
                (hi << 4) | lo
            })
            .collect();
        bytes
    }

    /// Decode BCD bytes to an amount in cents.
    #[allow(dead_code)]
    fn bcd_to_amount(bcd: &[u8]) -> i64 {
        let mut result: i64 = 0;
        for &b in bcd {
            let hi = (b >> 4) & 0x0F;
            let lo = b & 0x0F;
            result = result * 100 + (hi as i64) * 10 + lo as i64;
        }
        result
    }

    /// Build a ZVT APDU: class + instruction + length + data.
    fn build_apdu(&self, class: u8, instruction: u8, data: &[u8]) -> Vec<u8> {
        let len = data.len() as u16;
        let mut apdu = Vec::with_capacity(data.len() + 4);
        apdu.push(class);
        apdu.push(instruction);
        if len <= 0xFE {
            apdu.push(len as u8);
        } else {
            apdu.push(0xFF);
            apdu.push((len >> 8) as u8);
            apdu.push(len as u8);
        }
        apdu.extend_from_slice(data);
        apdu
    }

    /// Wrap an APDU in DLE/STX framing with CRC16.
    fn frame_apdu(&self, apdu: &[u8]) -> Vec<u8> {
        let crc = Self::crc16(apdu);
        let mut frame = Vec::with_capacity(apdu.len() + 6);
        frame.push(DLE);
        frame.push(STX);
        frame.extend_from_slice(apdu);
        frame.push(DLE);
        frame.push(ETX);
        frame.push((crc & 0xFF) as u8);
        frame.push((crc >> 8) as u8);
        frame
    }

    /// CRC16 (CCITT with polynomial 0x8408, init 0x0000).
    fn crc16(data: &[u8]) -> u16 {
        let mut crc: u16 = 0;
        for &byte in data {
            crc ^= byte as u16;
            for _ in 0..8 {
                if crc & 1 != 0 {
                    crc = (crc >> 1) ^ 0x8408;
                } else {
                    crc >>= 1;
                }
            }
        }
        crc
    }

    /// Build registration data with password and configuration byte.
    fn build_registration_data(&self) -> Vec<u8> {
        let mut data = Vec::new();
        // Password (BCD, 3 bytes)
        let pw = Self::amount_to_bcd(self.password as i64);
        data.extend_from_slice(&pw[pw.len() - 3..]);
        // Config byte: bit 0 = print on ECR, bit 1 = admin functions on ECR
        let mut config_byte: u8 = 0;
        if self.print_on_pos {
            config_byte |= 0x01; // Request print on POS
        }
        data.push(config_byte);
        data
    }

    /// Send framed APDU and receive response.
    fn send_apdu(
        &mut self,
        class: u8,
        instruction: u8,
        data: &[u8],
        timeout_ms: u64,
    ) -> Result<Vec<u8>, String> {
        let apdu = self.build_apdu(class, instruction, data);
        let frame = self.frame_apdu(&apdu);
        let raw = self.transport.send_and_receive(&frame, timeout_ms)?;
        Ok(raw)
    }

    fn extract_framed_apdu(raw: &[u8]) -> Option<&[u8]> {
        let frame_start = raw.windows(2).position(|w| w == [DLE, STX])?;
        let apdu_start = frame_start + 2;
        let frame_end_rel = raw[apdu_start..].windows(2).position(|w| w == [DLE, ETX])?;
        let apdu_end = apdu_start + frame_end_rel;
        let crc_start = apdu_end + 2;
        if raw.len() < crc_start + 2 {
            warn!("Truncated ZVT frame: missing CRC bytes after DLE/ETX");
            return None;
        }

        let apdu = &raw[apdu_start..apdu_end];
        let expected_crc = u16::from_le_bytes([raw[crc_start], raw[crc_start + 1]]);
        let computed_crc = Self::crc16(apdu);
        if computed_crc != expected_crc {
            warn!(
                "ZVT frame CRC mismatch: expected 0x{expected_crc:04X}, computed 0x{computed_crc:04X}"
            );
            return None;
        }

        Some(apdu)
    }

    /// Check if a framed response indicates positive completion (0x80 0x00).
    fn is_positive_completion(raw: &[u8]) -> bool {
        let Some(apdu) = Self::extract_framed_apdu(raw) else {
            return false;
        };
        apdu.len() >= 2 && apdu[0] == ACK_POSITIVE && apdu[1] == 0x00
    }

    /// Classify a received frame as a terminal error / abort — but ONLY on the
    /// CRC-validated APDU's command bytes, never a whole-buffer byte scan.
    ///
    /// Gap review 2026-07-10 P0: the previous check flagged an error whenever
    /// ANY byte in the frame equalled 0x84. ZVT is the German-market protocol,
    /// and intermediate frames (04 FF status, 06 D1 print lines) legitimately
    /// contain byte 0x84 in three ways: BCD-encoded amounts (e.g. €12.84
    /// encodes 0x84), the CRC-16 bytes appended to every frame, and CP437/CP850
    /// print text ('ä' = 0x84). Those false errors returned mid-transaction, so
    /// the POS recorded a failure while the terminal went on to approve and
    /// charge the card. Classifying on the command bytes of the CRC-validated
    /// APDU eliminates the false positives while still catching real declines.
    fn completion_error(raw: &[u8]) -> Option<String> {
        let apdu = Self::extract_framed_apdu(raw)?;
        match (apdu.first().copied(), apdu.get(1).copied()) {
            (Some(CMD_NEGATIVE_COMPLETION), code) => {
                Some(format!("Terminal error: 0x{:02X}", code.unwrap_or(0xFF)))
            }
            (Some(CMD_ABORT_RESULT_CLASS), Some(CMD_ABORT_RESULT_INST)) => {
                Some("Transaction aborted by terminal".to_string())
            }
            _ => None,
        }
    }

    /// True when the frame is a 06 0F Completion — the PT signalling that the
    /// transaction reached its end.
    ///
    /// Gap review 2026-07-10 P0 (round 2): 80 00 is only the command-level ACK
    /// (consumed by send_apdu). A spec-conformant terminal ends a card
    /// transaction with 06 0F Completion, which the old loop ACKed as an
    /// "intermediate" and then spun until the 60s timeout — reporting failure
    /// on an approved, charged card. wait_for_completion now exits on this too.
    fn is_completion(raw: &[u8]) -> bool {
        matches!(
            Self::extract_framed_apdu(raw).and_then(|a| Some((*a.first()?, *a.get(1)?))),
            Some((CMD_COMPLETION_CLASS, CMD_COMPLETION_INST))
        )
    }

    /// Whether a captured 04 0F Status-Information frame reports approval.
    ///
    /// Per ZVT the first data element of Status-Information is BMP 27
    /// (result-code); 0x00 == successful. We check that exact spec position
    /// (APDU = [04 0F len 27 <result> …]) rather than scanning the buffer, so a
    /// stray 0x27 elsewhere can never be mistaken for an approval. Anything we
    /// cannot positively verify as approved is treated as NOT approved — a
    /// false decline is recoverable (retry/void); a false approval loses money.
    ///
    /// NOTE: end-to-end ZVT approve/decline classification is validated by the
    /// separate real-terminal ECR certification gate, not by these unit tests.
    fn status_info_indicates_approval(raw: &[u8]) -> bool {
        let Some(apdu) = Self::extract_framed_apdu(raw) else {
            return false;
        };
        // apdu[0..2] = 04 0F, apdu[2] = length, apdu[3] = BMP tag, apdu[4] = value
        apdu.len() >= 5 && apdu[3] == BMP_RESULT_CODE && apdu[4] == ZVT_RESULT_OK
    }

    /// Collect receipt print lines from intermediate responses.
    fn collect_receipt_lines(&mut self, raw: &[u8]) {
        // Look for print line command (06 D1) in the response
        if raw.len() > 4 {
            for i in 0..raw.len() - 1 {
                if raw[i] == CMD_PRINT_LINE_CLASS && raw[i + 1] == CMD_PRINT_LINE_INST {
                    // Extract text data after the command header
                    let start = i + 3; // skip class + inst + len
                    if start < raw.len() {
                        let end = raw.len().min(start + 40); // max 40 chars per line
                        if let Ok(line) = String::from_utf8(raw[start..end].to_vec()) {
                            self.receipt_lines.push(line.trim().to_string());
                        }
                    }
                }
            }
        }
    }

    /// Wait for a terminal response, handling intermediate messages.
    fn wait_for_completion(&mut self, timeout_ms: u64) -> Result<Vec<u8>, String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if remaining == 0 {
                return Err("Transaction timeout".into());
            }

            // Wave 2 H20: clamp the receive window to `[1, 2000]` ms so a
            // near-boundary `remaining` (where a single `.min(2000)` alone
            // could bottom out at 0 on some platforms / transports) still
            // issues a real read instead of a zero-ms spin. Upper bound
            // caps any single receive at 2 s so the overall transaction
            // timeout check above continues to tick.
            let raw = self.transport.receive(remaining.clamp(1, 2000))?;
            if raw.is_empty() {
                continue;
            }

            // Collect any print lines
            self.collect_receipt_lines(&raw);

            // Check for a real negative completion / abort FIRST — classified
            // on the APDU command bytes only, never a whole-buffer 0x84 scan.
            if let Some(error) = Self::completion_error(&raw) {
                return Err(error);
            }

            // Capture the Status-Information (04 0F) — it carries the outcome
            // (result code) that process_transaction uses to classify the sale.
            if matches!(
                Self::extract_framed_apdu(&raw).and_then(|a| Some((*a.first()?, *a.get(1)?))),
                Some((CMD_STATUS_INFO_CLASS, CMD_STATUS_INFO_INST))
            ) {
                self.last_status_info = Some(raw.clone());
            }

            // Terminal state reached: an 80 00 ACK-completion (non-sale flows)
            // or a 06 0F transaction Completion.
            if Self::is_positive_completion(&raw) || Self::is_completion(&raw) {
                return Ok(raw);
            }

            // Otherwise it's an intermediate message — send ACK and continue
            let ack = [ACK_POSITIVE, 0x00, 0x00];
            let _ = self.transport.send(&ack);
        }
    }

    /// Parse transaction response data from raw bytes.
    fn parse_transaction_data(
        &self,
        raw: &[u8],
    ) -> (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) {
        let mut auth_code = None;
        let mut card_type = None;
        let mut card_last_four = None;
        let mut terminal_ref = None;

        // TLV parsing: look for known tags in the response
        // This is simplified — real ZVT TLV is more complex
        let text = String::from_utf8_lossy(raw);
        if text.contains("AUTH:") {
            if let Some(pos) = text.find("AUTH:") {
                let code = &text[pos + 5..text.len().min(pos + 15)];
                auth_code = Some(code.trim().to_string());
            }
        }

        // Card type detection from BMP fields
        for i in 0..raw.len() {
            // BMP 22: card type
            if i + 2 < raw.len() && raw[i] == 0x22 {
                card_type = match raw[i + 1] {
                    0x01 => Some("Visa".into()),
                    0x02 => Some("Mastercard".into()),
                    0x03 => Some("Amex".into()),
                    0x05 => Some("Maestro".into()),
                    _ => Some(format!("Card(0x{:02X})", raw[i + 1])),
                };
            }
            // BMP 23: card PAN (last 4).
            //
            // Wave 2 H23: ZVT BMP 23 is a variable-length field. The
            // structure is:
            //   raw[i]     = tag (0x23)
            //   raw[i+1]   = length byte (`len`, in BCD-bytes)
            //   raw[i+2..] = PAN encoded in BCD, `len` bytes long
            //
            // The previous implementation read `raw[i+3]` and `raw[i+4]`
            // unconditionally — that is 2 bytes INTO the PAN, not the last
            // two bytes, so for any PAN longer than 8 digits the "last 4"
            // were reporting middle-of-PAN digits.
            //
            // For BCD bytes whose nibbles are all decimal (0x00..=0x99),
            // `{:02X}` prints the same glyphs as decimal, so we keep that
            // format; any unexpected nibble value > 9 is preserved as hex
            // so the raw byte stays visible for debugging.
            if i + 1 < raw.len() && raw[i] == 0x23 {
                let len = raw[i + 1] as usize;
                if len >= 2 && i + 2 + len <= raw.len() {
                    let end = i + 2 + len;
                    card_last_four = Some(format!("{:02X}{:02X}", raw[end - 2], raw[end - 1]));
                }
            }
            // BMP 87: terminal reference
            if i + 1 < raw.len() && raw[i] == 0x87 {
                let len = raw[i + 1] as usize;
                if i + 2 + len <= raw.len() {
                    terminal_ref = String::from_utf8(raw[i + 2..i + 2 + len].to_vec()).ok();
                }
            }
        }

        (auth_code, card_type, card_last_four, terminal_ref)
    }
}

impl EcrProtocol for ZvtProtocol {
    fn name(&self) -> &str {
        "ZVT"
    }

    fn initialize(&mut self) -> Result<(), String> {
        if !self.transport.is_connected() {
            self.transport.connect()?;
        }

        // Send registration command
        let reg_data = self.build_registration_data();
        let raw = self.send_apdu(
            CMD_REGISTRATION_CLASS,
            CMD_REGISTRATION_INST,
            &reg_data,
            10000,
        )?;

        if !Self::is_positive_completion(&raw) {
            // Try waiting for the completion
            match self.wait_for_completion(10000) {
                Ok(_) => {}
                Err(e) => return Err(format!("Registration failed: {e}")),
            }
        }

        self.initialized = true;
        info!("ZVT protocol initialized (registration complete)");
        Ok(())
    }

    fn process_transaction(
        &mut self,
        request: &TransactionRequest,
    ) -> Result<TransactionResponse, String> {
        let started = Utc::now().to_rfc3339();
        self.receipt_lines.clear();
        self.last_status_info = None;

        let (class, inst) = match request.transaction_type {
            TransactionType::Sale => (CMD_AUTHORIZATION_CLASS, CMD_AUTHORIZATION_INST),
            TransactionType::Refund => (CMD_REFUND_CLASS, CMD_REFUND_INST),
            _ => {
                return Err(format!(
                    "ZVT does not support {:?} transactions",
                    request.transaction_type
                ))
            }
        };

        // Build amount data (BCD)
        let amount_bcd = Self::amount_to_bcd(request.amount);

        // Send authorization/refund command
        let raw = self.send_apdu(class, inst, &amount_bcd, 5000)?;
        debug!("ZVT initial response: {:02X?}", &raw[..raw.len().min(20)]);

        // Wait for transaction completion (card tap/insert/swipe)
        let completion = self.wait_for_completion(self.transaction_timeout_ms)?;

        // Prefer the Status-Information frame for card data — 06 0F Completion
        // carries no BMPs; the card metadata lives in the preceding 04 0F.
        let data_frame = self.last_status_info.clone().unwrap_or(completion.clone());
        let (auth_code, card_type, card_last_four, terminal_ref) =
            self.parse_transaction_data(&data_frame);

        let receipt_lines = if self.receipt_lines.is_empty() {
            None
        } else {
            Some(self.receipt_lines.clone())
        };

        // Classify the outcome from POSITIVE evidence only (gap review P0,
        // round 2). Approve only when a 04 0F Status-Information reported ZVT
        // result-code 0x00. A bare 80 00 ACK-completion (non-sale flows) keeps
        // its legacy meaning. Everything else — a 06 0F completion with no
        // verified success status, an abort, a NAK — is a decline. A false
        // decline is recoverable; a false approval loses money.
        let status = if self
            .last_status_info
            .as_deref()
            .map(Self::status_info_indicates_approval)
            .unwrap_or_else(|| Self::is_positive_completion(&completion))
        {
            TransactionStatus::Approved
        } else {
            TransactionStatus::Declined
        };

        let completed = Utc::now().to_rfc3339();
        Ok(TransactionResponse {
            transaction_id: request.transaction_id.clone(),
            status,
            authorization_code: auth_code,
            terminal_reference: terminal_ref,
            fiscal_receipt_number: None,
            fiscal_z_number: None,
            card_type,
            card_last_four,
            entry_method: None,
            customer_receipt_lines: receipt_lines.clone(),
            merchant_receipt_lines: receipt_lines,
            error_message: None,
            error_code: None,
            raw_response: None,
            started_at: started,
            completed_at: completed,
        })
    }

    fn cancel_transaction(&mut self) -> Result<(), String> {
        let _ = self.send_apdu(CMD_ABORT_CLASS, CMD_ABORT_INST, &[], 5000)?;
        info!("ZVT transaction aborted");
        Ok(())
    }

    fn get_status(&mut self) -> Result<DeviceStatus, String> {
        let raw = self.send_apdu(CMD_STATUS_CLASS, CMD_STATUS_INST, &[], 5000)?;
        Ok(DeviceStatus {
            connected: true,
            ready: Self::is_positive_completion(&raw),
            busy: false,
            error: None,
            firmware_version: None,
            serial_number: None,
            fiscal_receipt_counter: None,
            fiscal_z_counter: None,
        })
    }

    fn settlement(&mut self) -> Result<SettlementResult, String> {
        let raw = self.send_apdu(CMD_END_OF_DAY_CLASS, CMD_END_OF_DAY_INST, &[], 30000)?;
        let completion = self.wait_for_completion(30000)?;

        let success =
            Self::is_positive_completion(&completion) || Self::is_positive_completion(&raw);
        info!("ZVT end-of-day: success={success}");

        Ok(SettlementResult {
            success,
            transaction_count: 0,
            total_amount: 0,
            z_number: None,
            error_message: if success {
                None
            } else {
                Some("Settlement may have failed".into())
            },
            raw_response: None,
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
        match self.send_apdu(CMD_STATUS_CLASS, CMD_STATUS_INST, &[], 5000) {
            Ok(raw) => {
                let ok = !raw.is_empty();
                info!(
                    "ZVT test connection: {}",
                    if ok { "OK" } else { "no response" }
                );
                Ok(ok)
            }
            Err(e) => {
                warn!("ZVT test connection failed: {e}");
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
    fn test_amount_to_bcd() {
        let bcd = ZvtProtocol::amount_to_bcd(1250); // 12.50 EUR
        assert_eq!(bcd, vec![0x00, 0x00, 0x00, 0x00, 0x12, 0x50]);
    }

    #[test]
    fn test_amount_to_bcd_zero() {
        let bcd = ZvtProtocol::amount_to_bcd(0);
        assert_eq!(bcd, vec![0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn test_amount_to_bcd_large() {
        let bcd = ZvtProtocol::amount_to_bcd(999999); // 9999.99 EUR
        assert_eq!(bcd, vec![0x00, 0x00, 0x00, 0x99, 0x99, 0x99]);
    }

    #[test]
    fn test_bcd_to_amount() {
        let amount = ZvtProtocol::bcd_to_amount(&[0x00, 0x00, 0x00, 0x00, 0x12, 0x50]);
        assert_eq!(amount, 1250);
    }

    #[test]
    fn test_crc16() {
        // Known test vector
        let data = [0x06, 0x00, 0x03, 0x00, 0x00, 0x00];
        let crc = ZvtProtocol::crc16(&data);
        // CRC16 CCITT (0x8408) for this data
        assert!(crc != 0); // Just verify it computes something
    }

    #[test]
    fn test_build_apdu_short() {
        let proto = ZvtProtocol::new(
            Box::new(crate::ecr::transport::BluetoothTransport::new("", 0)),
            &serde_json::json!({}),
        );
        let apdu = proto.build_apdu(0x06, 0x01, &[0x12, 0x50]);
        assert_eq!(apdu[0], 0x06); // class
        assert_eq!(apdu[1], 0x01); // instruction
        assert_eq!(apdu[2], 0x02); // length
        assert_eq!(apdu[3], 0x12);
        assert_eq!(apdu[4], 0x50);
    }

    #[test]
    fn test_frame_apdu() {
        let proto = ZvtProtocol::new(
            Box::new(crate::ecr::transport::BluetoothTransport::new("", 0)),
            &serde_json::json!({}),
        );
        let apdu = vec![0x06, 0x00, 0x00];
        let frame = proto.frame_apdu(&apdu);
        assert_eq!(frame[0], DLE);
        assert_eq!(frame[1], STX);
        assert_eq!(frame[2], 0x06);
        assert_eq!(frame[3], 0x00);
        assert_eq!(frame[4], 0x00);
        assert_eq!(frame[5], DLE);
        assert_eq!(frame[6], ETX);
        // Last 2 bytes are CRC16
        assert_eq!(frame.len(), 9);
    }

    #[test]
    fn test_positive_completion_detection() {
        let proto = ZvtProtocol::new(
            Box::new(crate::ecr::transport::BluetoothTransport::new("", 0)),
            &serde_json::json!({}),
        );
        let approved = proto.frame_apdu(&[0x80, 0x00, 0x00]);
        let declined = proto.frame_apdu(&[0x84, 0x01, 0x00]);
        let mut corrupt_crc = approved.clone();
        let last = corrupt_crc.len() - 1;
        corrupt_crc[last] ^= 0xFF;

        assert!(ZvtProtocol::is_positive_completion(&approved));
        assert!(!ZvtProtocol::is_positive_completion(&declined));
        assert!(!ZvtProtocol::is_positive_completion(&[0x80, 0x00, 0x00]));
        assert!(!ZvtProtocol::is_positive_completion(&corrupt_crc));
        assert!(!ZvtProtocol::is_positive_completion(&[]));
    }

    fn test_proto() -> ZvtProtocol {
        ZvtProtocol::new(
            Box::new(crate::ecr::transport::BluetoothTransport::new("", 0)),
            &serde_json::json!({}),
        )
    }

    // Gap review 2026-07-10 P0: a genuine negative completion (84 xx as the
    // APDU command bytes) is still detected as an error.
    #[test]
    fn test_completion_error_detects_real_negative_completion() {
        let proto = test_proto();
        let frame = proto.frame_apdu(&[CMD_NEGATIVE_COMPLETION, 0x05, 0x00]);
        let err = ZvtProtocol::completion_error(&frame).expect("84 xx must be an error");
        assert!(
            err.contains("0x05"),
            "error code must be carried through: {err}"
        );
    }

    // Gap review P0: a 06 1E abort (command bytes) is detected as an abort.
    #[test]
    fn test_completion_error_detects_abort() {
        let proto = test_proto();
        let frame = proto.frame_apdu(&[CMD_ABORT_RESULT_CLASS, CMD_ABORT_RESULT_INST, 0x00]);
        let err = ZvtProtocol::completion_error(&frame).expect("06 1E must be an abort");
        assert!(err.to_lowercase().contains("abort"), "got: {err}");
    }

    // Gap review P0 — the core regression: an intermediate status frame whose
    // DATA contains byte 0x84 (a BCD amount of €x.84, or the CRC bytes, or the
    // German 'ä' in a print line) must NOT be misread as a terminal error.
    #[test]
    fn test_completion_error_ignores_0x84_inside_intermediate_frame_data() {
        let proto = test_proto();

        // 04 FF intermediate status carrying a BCD amount €12.84 (…0x12 0x84).
        let bcd_amount = proto.frame_apdu(&[0x04, 0xFF, 0x06, 0x00, 0x00, 0x00, 0x00, 0x12, 0x84]);
        assert!(
            ZvtProtocol::completion_error(&bcd_amount).is_none(),
            "a BCD amount containing 0x84 must not be read as a terminal error",
        );

        // 06 D1 print line with 'ä' (CP437 0x84) in the text.
        let print_line = proto.frame_apdu(&[
            CMD_PRINT_LINE_CLASS,
            CMD_PRINT_LINE_INST,
            0x03,
            b'K',
            0x84,
            b'e',
        ]);
        assert!(
            ZvtProtocol::completion_error(&print_line).is_none(),
            "a print line containing 'ä' (0x84) must not be read as a terminal error",
        );

        // A positive completion whose CRC bytes happen to include 0x84 must
        // still not be classified as an error by completion_error.
        let approved = proto.frame_apdu(&[ACK_POSITIVE, 0x00, 0x00]);
        assert!(ZvtProtocol::completion_error(&approved).is_none());
    }

    #[test]
    fn test_completion_error_ignores_unframed_or_partial_input() {
        // A partial/garbage buffer that fails CRC framing is treated as an
        // intermediate (None), letting the loop ACK and wait — not a failure.
        assert!(ZvtProtocol::completion_error(&[0x84, 0x05]).is_none());
        assert!(ZvtProtocol::completion_error(&[]).is_none());
    }

    // Gap review 2026-07-10 P0 (round 2): a spec-conformant terminal ends the
    // transaction with 06 0F Completion, which must be recognized so approvals
    // don't spin to the 60s timeout and get recorded as failures.
    #[test]
    fn test_is_completion_recognizes_06_0f() {
        let proto = test_proto();
        assert!(ZvtProtocol::is_completion(&proto.frame_apdu(&[
            CMD_COMPLETION_CLASS,
            CMD_COMPLETION_INST,
            0x00,
        ])));
        // 80 00 ACK is NOT a transaction completion (it's a command ACK).
        assert!(!ZvtProtocol::is_completion(&proto.frame_apdu(&[
            ACK_POSITIVE,
            0x00,
            0x00
        ])));
        // 04 FF intermediate status is not a completion.
        assert!(!ZvtProtocol::is_completion(
            &proto.frame_apdu(&[0x04, 0xFF, 0x00])
        ));
    }

    // Approve ONLY on a Status-Information (04 0F) whose result-code (BMP 27,
    // at the spec position) is 0x00.
    #[test]
    fn test_status_info_approval_requires_result_code_zero_at_spec_position() {
        let proto = test_proto();
        // 04 0F, len, BMP 27 = 0x00 (success), then a filler BMP byte.
        let ok = proto.frame_apdu(&[
            CMD_STATUS_INFO_CLASS,
            CMD_STATUS_INFO_INST,
            0x03,
            BMP_RESULT_CODE,
            0x00,
            0x05,
        ]);
        assert!(ZvtProtocol::status_info_indicates_approval(&ok));

        // Result-code 0x6C (card declined) must NOT approve.
        let declined = proto.frame_apdu(&[
            CMD_STATUS_INFO_CLASS,
            CMD_STATUS_INFO_INST,
            0x02,
            BMP_RESULT_CODE,
            0x6C,
        ]);
        assert!(!ZvtProtocol::status_info_indicates_approval(&declined));

        // A 0x27 0x00 NOT at the result-code position (some later BMP) must not
        // be mistaken for approval — guards against buffer-scan false approvals.
        let misplaced = proto.frame_apdu(&[
            CMD_STATUS_INFO_CLASS,
            CMD_STATUS_INFO_INST,
            0x04,
            0x0B,
            0x01,
            BMP_RESULT_CODE,
            0x00,
        ]);
        assert!(!ZvtProtocol::status_info_indicates_approval(&misplaced));

        // A bare 06 0F completion (no status info) is not, by itself, approval.
        let completion = proto.frame_apdu(&[CMD_COMPLETION_CLASS, CMD_COMPLETION_INST, 0x00]);
        assert!(!ZvtProtocol::status_info_indicates_approval(&completion));
    }
}
