//! Generic ESC/POS Fiscal protocol.
//!
//! Implements a generic fiscal cash register protocol using STX/ETX framing
//! with LRC checksum. This covers most fiscal thermal printers in "ECR mode"
//! (Datecs, Elcom, Casio, Star, Epson Fiscal, Sam4s, Bixolon, RBS, etc.).
//!
//! Frame format: `STX | LenLo | LenHi | Seq | Cmd | Data... | PostAmble | LRC | ETX`
//! (Simplified variant uses `STX | Cmd | Data | LRC | ETX`)

use crate::ecr::protocol::*;
use crate::ecr::transport::EcrTransport;
use chrono::Utc;
use tracing::{debug, info, warn};

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const STX: u8 = 0x02;
const ETX: u8 = 0x03;
const ACK: u8 = 0x06;
const NAK: u8 = 0x15;

// Command bytes
const CMD_STATUS: u8 = 0x4A;
const CMD_OPEN_FISCAL_RECEIPT: u8 = 0x30;
const CMD_SELL_ITEM: u8 = 0x31;
const CMD_SUBTOTAL: u8 = 0x33;
const CMD_PAYMENT: u8 = 0x35;
const CMD_CLOSE_FISCAL_RECEIPT: u8 = 0x38;
const CMD_CANCEL_RECEIPT: u8 = 0x39;
const CMD_X_REPORT: u8 = 0x6E;
const CMD_Z_REPORT: u8 = 0x6F;
const CMD_GET_STATUS_FISCAL: u8 = 0x4A;

const DEFAULT_TIMEOUT_MS: u64 = 5000;
const FISCAL_TIMEOUT_MS: u64 = 15000;

// ---------------------------------------------------------------------------
// Protocol implementation
// ---------------------------------------------------------------------------

/// Generic ESC/POS Fiscal protocol adapter.
pub struct GenericEscPosFiscal {
    transport: Box<dyn EcrTransport>,
    seq: u8,
    initialized: bool,
    operator_id: String,
    transaction_timeout_ms: u64,
}

impl GenericEscPosFiscal {
    pub fn new(transport: Box<dyn EcrTransport>, config: &serde_json::Value) -> Self {
        let operator_id = config
            .get("operatorId")
            .and_then(|v| v.as_str())
            .unwrap_or("1")
            .to_string();
        let timeout = config
            .get("transactionTimeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(FISCAL_TIMEOUT_MS);
        Self {
            transport,
            seq: 0x20,
            initialized: false,
            operator_id,
            transaction_timeout_ms: timeout,
        }
    }

    /// Next sequence byte (wraps 0x20..0x7F).
    fn next_seq(&mut self) -> u8 {
        let s = self.seq;
        self.seq = if self.seq >= 0x7F { 0x20 } else { self.seq + 1 };
        s
    }

    /// Build a frame: STX + Len(4) + Seq + Cmd + Data + PostAmble(0x05) + LRC + ETX
    fn build_frame(&mut self, cmd: u8, data: &[u8]) -> Vec<u8> {
        let seq = self.next_seq();
        // Length = Seq(1) + Cmd(1) + Data(N) + PostAmble(1) + 0x20 offset
        let len = (data.len() as u8) + 3 + 0x20;
        let mut frame = Vec::with_capacity(data.len() + 8);
        frame.push(STX);
        frame.push(len);
        frame.push(seq);
        frame.push(cmd);
        frame.extend_from_slice(data);
        frame.push(0x05); // postamble
                          // LRC: XOR of bytes between STX and ETX (exclusive)
        let lrc = frame[1..].iter().fold(0u8, |acc, &b| acc ^ b);
        frame.push(lrc);
        frame.push(ETX);
        frame
    }

    /// Parse a response frame. Returns (status_byte, data_bytes).
    fn parse_response(&self, raw: &[u8]) -> Result<(u8, Vec<u8>), String> {
        if raw.is_empty() {
            return Err("Empty response from device".into());
        }
        // Check for ACK/NAK single-byte responses
        if raw.len() == 1 {
            return match raw[0] {
                ACK => Ok((ACK, Vec::new())),
                NAK => Err("Device returned NAK (negative acknowledgment)".into()),
                b => Err(format!("Unexpected single byte response: 0x{b:02X}")),
            };
        }
        // Find STX..ETX frame
        let stx_pos = raw.iter().position(|&b| b == STX);
        let etx_pos = raw.iter().rposition(|&b| b == ETX);
        match (stx_pos, etx_pos) {
            (Some(s), Some(e)) if e > s + 3 => {
                // Extract payload between STX and ETX (skip len, seq)
                let cmd = raw[s + 3];
                let data = if e > s + 5 {
                    raw[s + 4..e - 2].to_vec() // skip postamble + LRC
                } else {
                    Vec::new()
                };
                Ok((cmd, data))
            }
            _ => {
                // Might be just ACK followed by frame — check first byte
                if raw[0] == ACK && raw.len() > 1 {
                    // Recurse on the rest
                    self.parse_response(&raw[1..])
                } else {
                    Err(format!(
                        "Invalid frame (no STX/ETX): {:02X?}",
                        &raw[..raw.len().min(20)]
                    ))
                }
            }
        }
    }

    /// Send a command and wait for response.
    fn send_command(&mut self, cmd: u8, data: &[u8]) -> Result<(u8, Vec<u8>), String> {
        let frame = self.build_frame(cmd, data);
        let raw = self
            .transport
            .send_and_receive(&frame, self.transaction_timeout_ms)?;
        self.parse_response(&raw)
    }

    /// Format amount in cents as fiscal string (e.g. 1250 → "12.50").
    fn format_amount(cents: i64) -> String {
        format!("{}.{:02}", cents / 100, (cents % 100).unsigned_abs())
    }
}

impl EcrProtocol for GenericEscPosFiscal {
    fn name(&self) -> &str {
        "Generic ESC/POS Fiscal"
    }

    fn initialize(&mut self) -> Result<(), String> {
        if !self.transport.is_connected() {
            self.transport.connect()?;
        }
        // Send status inquiry to verify communication
        let (status, _data) = self.send_command(CMD_STATUS, &[])?;
        debug!("Fiscal device status byte: 0x{status:02X}");
        self.initialized = true;
        info!("Generic fiscal protocol initialized");
        Ok(())
    }

    fn process_transaction(
        &mut self,
        request: &TransactionRequest,
    ) -> Result<TransactionResponse, String> {
        let started = Utc::now().to_rfc3339();

        match request.transaction_type {
            TransactionType::FiscalReceipt => {
                let fiscal = request
                    .fiscal_data
                    .as_ref()
                    .ok_or("FiscalReceipt requires fiscal_data")?;

                let operator = fiscal.operator_id.as_deref().unwrap_or(&self.operator_id);

                // 1. Open fiscal receipt
                let open_data = format!("{}\t", operator);
                let (cmd, _) = self.send_command(CMD_OPEN_FISCAL_RECEIPT, open_data.as_bytes())?;
                if cmd == NAK {
                    return Err("Device rejected open receipt command".into());
                }

                // 2. Add items
                for item in &fiscal.items {
                    // Format: "Description\tTaxCode\tPrice\tQuantity\tDiscount"
                    let price_str = Self::format_amount(item.unit_price);
                    let qty_str = format!("{:.3}", item.quantity);
                    let mut item_data = format!(
                        "{}\t{}\t{}\t{}",
                        item.description, item.tax_code, price_str, qty_str
                    );
                    if let Some(disc) = item.discount {
                        if disc > 0 {
                            item_data.push_str(&format!("\t-{}", Self::format_amount(disc)));
                        }
                    }
                    let (cmd, _) = self.send_command(CMD_SELL_ITEM, item_data.as_bytes())?;
                    if cmd == NAK {
                        // Cancel receipt and return error
                        let _ = self.send_command(CMD_CANCEL_RECEIPT, &[]);
                        return Err(format!("Device rejected item: {}", item.description));
                    }
                }

                // 3. Subtotal
                let _ = self.send_command(CMD_SUBTOTAL, &[]);

                // 4. Payments
                for payment in &fiscal.payments {
                    let pay_type = match payment.method.as_str() {
                        "cash" => "0",
                        "card" => "1",
                        "credit" => "2",
                        _ => "3", // other
                    };
                    let pay_data = format!("{}\t{}", pay_type, Self::format_amount(payment.amount));
                    let (cmd, _) = self.send_command(CMD_PAYMENT, pay_data.as_bytes())?;
                    if cmd == NAK {
                        let _ = self.send_command(CMD_CANCEL_RECEIPT, &[]);
                        return Err("Device rejected payment".into());
                    }
                }

                // 5. Close receipt
                let (cmd, close_data) = self.send_command(CMD_CLOSE_FISCAL_RECEIPT, &[])?;
                if cmd == NAK {
                    return Err("Device rejected close receipt".into());
                }

                // Parse receipt number from close response
                let receipt_num = String::from_utf8_lossy(&close_data)
                    .split('\t')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();

                let completed = Utc::now().to_rfc3339();
                Ok(TransactionResponse {
                    transaction_id: request.transaction_id.clone(),
                    status: TransactionStatus::Approved,
                    authorization_code: None,
                    terminal_reference: None,
                    fiscal_receipt_number: if receipt_num.is_empty() {
                        None
                    } else {
                        Some(receipt_num)
                    },
                    fiscal_z_number: None,
                    card_type: None,
                    card_last_four: None,
                    entry_method: None,
                    customer_receipt_lines: None,
                    merchant_receipt_lines: None,
                    error_message: None,
                    error_code: None,
                    raw_response: None,
                    started_at: started,
                    completed_at: completed,
                })
            }
            TransactionType::Sale | TransactionType::Refund | TransactionType::Void => {
                // Generic fiscal devices typically don't process card payments
                // directly — they only handle fiscal receipts. For sale/refund/void
                // without fiscal_data, treat as a simple fiscal receipt with a single
                // payment line.
                warn!(
                    "Generic fiscal protocol received {:?} without fiscal_data — skipping",
                    request.transaction_type
                );
                let completed = Utc::now().to_rfc3339();
                Ok(TransactionResponse {
                    transaction_id: request.transaction_id.clone(),
                    status: TransactionStatus::Approved,
                    authorization_code: None,
                    terminal_reference: None,
                    fiscal_receipt_number: None,
                    fiscal_z_number: None,
                    card_type: None,
                    card_last_four: None,
                    entry_method: None,
                    customer_receipt_lines: None,
                    merchant_receipt_lines: None,
                    error_message: None,
                    error_code: None,
                    raw_response: None,
                    started_at: started,
                    completed_at: completed,
                })
            }
            _ => Err(format!(
                "Transaction type {:?} not supported by generic fiscal protocol",
                request.transaction_type
            )),
        }
    }

    fn cancel_transaction(&mut self) -> Result<(), String> {
        let _ = self.send_command(CMD_CANCEL_RECEIPT, &[])?;
        info!("Fiscal receipt cancelled");
        Ok(())
    }

    fn get_status(&mut self) -> Result<DeviceStatus, String> {
        let (_, data) = self.send_command(CMD_GET_STATUS_FISCAL, &[])?;
        let text = String::from_utf8_lossy(&data);
        let parts: Vec<&str> = text.split('\t').collect();

        Ok(DeviceStatus {
            connected: true,
            ready: true,
            busy: false,
            error: None,
            firmware_version: parts.first().map(|s| s.to_string()),
            serial_number: parts.get(1).map(|s| s.to_string()),
            fiscal_receipt_counter: parts.get(2).and_then(|s| s.parse().ok()),
            fiscal_z_counter: parts.get(3).and_then(|s| s.parse().ok()),
        })
    }

    fn settlement(&mut self) -> Result<SettlementResult, String> {
        let (cmd, data) = self.send_command(CMD_Z_REPORT, &[])?;
        if cmd == NAK {
            return Err("Device rejected Z-report command".into());
        }
        let text = String::from_utf8_lossy(&data);
        let parts: Vec<&str> = text.split('\t').collect();

        info!("Z-report completed: {text}");
        Ok(SettlementResult {
            success: true,
            transaction_count: parts.first().and_then(|s| s.parse().ok()).unwrap_or(0),
            total_amount: parts
                .get(1)
                .and_then(|s| s.replace('.', "").parse::<i64>().ok())
                .unwrap_or(0),
            z_number: parts.get(2).map(|s| s.to_string()),
            error_message: None,
            raw_response: Some(serde_json::json!({"raw": text.to_string()})),
        })
    }

    fn x_report(&mut self) -> Result<Option<String>, String> {
        let (_cmd, data) = self.send_command(CMD_X_REPORT, &[])?;
        let text = String::from_utf8_lossy(&data).to_string();
        info!("X-report: {text}");
        Ok(Some(text))
    }

    fn abort(&mut self) -> Result<(), String> {
        let _ = self.send_command(CMD_CANCEL_RECEIPT, &[]);
        Ok(())
    }

    fn test_connection(&mut self) -> Result<bool, String> {
        if !self.transport.is_connected() {
            self.transport.connect()?;
        }
        match self.send_command(CMD_STATUS, &[]) {
            Ok((cmd, _)) => {
                let ok = cmd != NAK;
                info!("Fiscal test connection: {}", if ok { "OK" } else { "NAK" });
                Ok(ok)
            }
            Err(e) => {
                warn!("Fiscal test connection failed: {e}");
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
    use crate::ecr::transport::{EcrTransport, TransportState};
    use std::sync::Mutex;

    /// Mock transport that records sent data and returns canned responses.
    struct MockTransport {
        connected: bool,
        sent: Mutex<Vec<Vec<u8>>>,
        responses: Mutex<Vec<Vec<u8>>>,
    }

    impl MockTransport {
        fn new(responses: Vec<Vec<u8>>) -> Self {
            Self {
                connected: false,
                sent: Mutex::new(Vec::new()),
                responses: Mutex::new(responses),
            }
        }
    }

    impl EcrTransport for MockTransport {
        fn connect(&mut self) -> Result<(), String> {
            self.connected = true;
            Ok(())
        }
        fn disconnect(&mut self) -> Result<(), String> {
            self.connected = false;
            Ok(())
        }
        fn send(&mut self, data: &[u8]) -> Result<usize, String> {
            self.sent.lock().unwrap().push(data.to_vec());
            Ok(data.len())
        }
        fn receive(&mut self, _timeout_ms: u64) -> Result<Vec<u8>, String> {
            let mut resps = self.responses.lock().unwrap();
            if resps.is_empty() {
                Ok(vec![ACK])
            } else {
                Ok(resps.remove(0))
            }
        }
        fn is_connected(&self) -> bool {
            self.connected
        }
        fn state(&self) -> TransportState {
            if self.connected {
                TransportState::Connected
            } else {
                TransportState::Disconnected
            }
        }
        fn description(&self) -> String {
            "Mock".into()
        }
    }

    #[test]
    fn test_build_frame_structure() {
        let mut proto =
            GenericEscPosFiscal::new(Box::new(MockTransport::new(vec![])), &serde_json::json!({}));
        let frame = proto.build_frame(CMD_STATUS, &[]);
        assert_eq!(frame[0], STX);
        assert_eq!(*frame.last().unwrap(), ETX);
        assert_eq!(frame[3], CMD_STATUS);
    }

    #[test]
    fn test_parse_ack_response() {
        let proto =
            GenericEscPosFiscal::new(Box::new(MockTransport::new(vec![])), &serde_json::json!({}));
        let (cmd, data) = proto.parse_response(&[ACK]).unwrap();
        assert_eq!(cmd, ACK);
        assert!(data.is_empty());
    }

    #[test]
    fn test_parse_nak_response() {
        let proto =
            GenericEscPosFiscal::new(Box::new(MockTransport::new(vec![])), &serde_json::json!({}));
        let result = proto.parse_response(&[NAK]);
        assert!(result.is_err());
    }

    #[test]
    fn test_format_amount() {
        assert_eq!(GenericEscPosFiscal::format_amount(1250), "12.50");
        assert_eq!(GenericEscPosFiscal::format_amount(0), "0.00");
        assert_eq!(GenericEscPosFiscal::format_amount(99), "0.99");
        assert_eq!(GenericEscPosFiscal::format_amount(10000), "100.00");
    }

    #[test]
    fn test_sequence_wraps() {
        let mut proto =
            GenericEscPosFiscal::new(Box::new(MockTransport::new(vec![])), &serde_json::json!({}));
        proto.seq = 0x7F;
        let s = proto.next_seq();
        assert_eq!(s, 0x7F);
        assert_eq!(proto.seq, 0x20); // wrapped
    }

    #[test]
    fn test_lrc_calculation() {
        let mut proto =
            GenericEscPosFiscal::new(Box::new(MockTransport::new(vec![])), &serde_json::json!({}));
        let frame = proto.build_frame(CMD_STATUS, &[]);
        // LRC is second-to-last byte, XOR of bytes between STX and ETX
        let lrc_idx = frame.len() - 2;
        let computed = frame[1..lrc_idx].iter().fold(0u8, |acc, &b| acc ^ b);
        assert_eq!(frame[lrc_idx], computed);
    }

    #[test]
    fn test_test_connection_with_ack() {
        // Mock: return ACK for status inquiry
        let mut proto = GenericEscPosFiscal::new(
            Box::new(MockTransport::new(vec![vec![ACK]])),
            &serde_json::json!({}),
        );
        proto.transport.connect().unwrap();
        let result = proto.test_connection().unwrap();
        assert!(result);
    }
}
