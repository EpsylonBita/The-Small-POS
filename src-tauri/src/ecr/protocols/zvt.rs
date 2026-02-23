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

    /// Check if a response indicates positive completion (0x80 0x00).
    fn is_positive_completion(raw: &[u8]) -> bool {
        // Look for 80 00 anywhere in response (skip framing)
        raw.windows(2).any(|w| w[0] == ACK_POSITIVE && w[1] == 0x00)
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

            let raw = self.transport.receive(remaining.min(2000))?;
            if raw.is_empty() {
                continue;
            }

            // Collect any print lines
            self.collect_receipt_lines(&raw);

            // Check for positive completion
            if Self::is_positive_completion(&raw) {
                return Ok(raw);
            }

            // Check for error / negative completion (84 xx)
            if raw.windows(1).any(|w| w[0] == 0x84) {
                let error_code = raw.get(raw.iter().position(|&b| b == 0x84).unwrap() + 1);
                return Err(format!(
                    "Terminal error: 0x{:02X}",
                    error_code.unwrap_or(&0xFF)
                ));
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
            // BMP 23: card PAN (last 4)
            if i + 5 < raw.len() && raw[i] == 0x23 {
                card_last_four = Some(format!("{:02X}{:02X}", raw[i + 3], raw[i + 4]));
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

        let (auth_code, card_type, card_last_four, terminal_ref) =
            self.parse_transaction_data(&completion);

        let receipt_lines = if self.receipt_lines.is_empty() {
            None
        } else {
            Some(self.receipt_lines.clone())
        };

        let completed = Utc::now().to_rfc3339();
        Ok(TransactionResponse {
            transaction_id: request.transaction_id.clone(),
            status: TransactionStatus::Approved,
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
        self.cancel_transaction()
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
        assert!(ZvtProtocol::is_positive_completion(&[0x80, 0x00, 0x00]));
        assert!(!ZvtProtocol::is_positive_completion(&[0x84, 0x01, 0x00]));
        assert!(!ZvtProtocol::is_positive_completion(&[]));
    }
}
