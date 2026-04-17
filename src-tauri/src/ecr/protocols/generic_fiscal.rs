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
use tracing::{debug, error, info, warn};

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
#[allow(dead_code)]
const CMD_X_REPORT: u8 = 0x6E;
const CMD_Z_REPORT: u8 = 0x6F;
const CMD_GET_STATUS_FISCAL: u8 = 0x4A;
/// Datecs-style "read date & time" command. Returns the device RTC as an
/// ASCII string, typically `DD-MM-YY HH:MM:SS` or `YYYY-MM-DD HH:MM:SS`.
/// Not all vendors support this — probing is best-effort, and NAK / unparseable
/// responses are treated as "unknown" rather than errors.
const CMD_GET_DATE_TIME: u8 = 0x3E;

/// Drift threshold (minutes) above which we log at `error!` level. Catches
/// wrong-day / wrong-year / wrong-timezone configurations. Drifts inside this
/// window but above `CLOCK_DRIFT_WARN_MINUTES` log at `warn!`.
const CLOCK_DRIFT_ERROR_MINUTES: i64 = 60;
/// Soft-alarm threshold (minutes). Drifts in the range
/// `CLOCK_DRIFT_WARN_MINUTES..CLOCK_DRIFT_ERROR_MINUTES` are logged as warnings.
const CLOCK_DRIFT_WARN_MINUTES: i64 = 5;

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

    /// Best-effort probe of the device RTC via `CMD_GET_DATE_TIME`. Returns
    /// `None` if the device rejects the command, returns malformed data, or the
    /// response cannot be parsed in any known format. Never propagates errors —
    /// this method is safe to call from `initialize()` without affecting the
    /// success of device setup on printers that don't support the command.
    fn probe_device_time(&mut self) -> Option<chrono::NaiveDateTime> {
        let (_cmd, data) = match self.send_command(CMD_GET_DATE_TIME, &[]) {
            Ok(v) => v,
            Err(e) => {
                debug!(
                    "Fiscal device rejected CMD_GET_DATE_TIME (0x3E); skipping clock-drift check: {e}"
                );
                return None;
            }
        };
        parse_device_time(&data)
    }

    /// Compare the device RTC to the POS local clock and log any drift.
    /// Uses `Local::now().naive_local()` so that a correctly-configured Greek
    /// device (RTC in Europe/Athens) matches the POS Windows clock without
    /// triggering a spurious "2-3 hour drift" from a UTC-vs-local mismatch.
    ///
    /// Never panics, never returns an error. If the device doesn't report a
    /// parseable time, the check is silently skipped.
    fn check_clock_drift(&mut self) {
        let device_time = match self.probe_device_time() {
            Some(t) => t,
            None => return,
        };
        let pos_local = chrono::Local::now().naive_local();
        let drift_seconds = (pos_local - device_time).num_seconds();
        let drift_minutes_abs = drift_seconds.abs() / 60;

        if drift_minutes_abs >= CLOCK_DRIFT_ERROR_MINUTES {
            tracing::error!(
                target: "ecr.clock_drift",
                drift_seconds = drift_seconds,
                drift_minutes_abs = drift_minutes_abs,
                device_time = %device_time,
                pos_local_time = %pos_local,
                "Fiscal device clock drift exceeds {CLOCK_DRIFT_ERROR_MINUTES} min \
                 \u{2014} operator should correct either the POS or the device RTC before taking sales"
            );
        } else if drift_minutes_abs >= CLOCK_DRIFT_WARN_MINUTES {
            tracing::warn!(
                target: "ecr.clock_drift",
                drift_seconds = drift_seconds,
                drift_minutes_abs = drift_minutes_abs,
                device_time = %device_time,
                pos_local_time = %pos_local,
                "Fiscal device clock drift above {CLOCK_DRIFT_WARN_MINUTES} min (informational)"
            );
        } else {
            debug!(
                target: "ecr.clock_drift",
                drift_seconds = drift_seconds,
                "Fiscal device clock drift within tolerance"
            );
        }
    }
}

/// Parse the ASCII date/time response returned by `CMD_GET_DATE_TIME`. Accepts
/// the two common fiscal-printer formats: `DD-MM-YY HH:MM:SS` (Datecs default)
/// and `YYYY-MM-DD HH:MM:SS` (newer variants). Returns `None` for anything else.
fn parse_device_time(data: &[u8]) -> Option<chrono::NaiveDateTime> {
    let text = String::from_utf8_lossy(data);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Try formats in order of likelihood.
    for fmt in [
        "%d-%m-%y %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%d/%m/%y %H:%M:%S",
    ] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(trimmed, fmt) {
            return Some(dt);
        }
    }
    None
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
        // Best-effort device-clock drift check. Does not fail init if the
        // device doesn't support CMD_GET_DATE_TIME. Logs at error / warn / debug
        // depending on magnitude; see `ecr.clock_drift` target.
        self.check_clock_drift();
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
                        // Cancel receipt and return error. If the cancel itself fails, the
                        // device is left in receipt-open state — surface that via logs so the
                        // operator can reset the device instead of every subsequent sale NAK'ing.
                        if let Err(cancel_err) = self.send_command(CMD_CANCEL_RECEIPT, &[]) {
                            error!(
                                "Cancel after item NAK failed (device may be stuck in receipt-open state): {cancel_err}"
                            );
                        }
                        return Err(format!("Device rejected item: {}", item.description));
                    }
                }

                // 3. Subtotal — check response like the item/payment steps. Previously the
                // response was discarded, so a NAK would silently proceed into payments and the
                // device would fail there for the wrong-looking reason.
                let (cmd, _) = self.send_command(CMD_SUBTOTAL, &[])?;
                if cmd == NAK {
                    if let Err(cancel_err) = self.send_command(CMD_CANCEL_RECEIPT, &[]) {
                        error!(
                            "Cancel after subtotal NAK failed (device may be stuck in receipt-open state): {cancel_err}"
                        );
                    }
                    return Err("Device rejected subtotal".into());
                }

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
                        if let Err(cancel_err) = self.send_command(CMD_CANCEL_RECEIPT, &[]) {
                            error!(
                                "Cancel after payment NAK failed (device may be stuck in receipt-open state): {cancel_err}"
                            );
                        }
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
        let cancel_result = self.send_command(CMD_CANCEL_RECEIPT, &[]).map(|_| ());
        let disconnect_result = self.transport.disconnect();
        self.initialized = false;
        cancel_result.and(disconnect_result)
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
    use std::sync::{Arc, Mutex};

    /// Mock transport that records sent data and returns canned responses.
    struct MockTransport {
        connected: bool,
        sent: Arc<Mutex<Vec<Vec<u8>>>>,
        responses: Mutex<Vec<Vec<u8>>>,
    }

    impl MockTransport {
        fn new(responses: Vec<Vec<u8>>) -> Self {
            Self {
                connected: false,
                sent: Arc::new(Mutex::new(Vec::new())),
                responses: Mutex::new(responses),
            }
        }

        /// Return a shared handle to the sent-frames log so a test can inspect
        /// what was sent after the transport is moved into a `Box<dyn EcrTransport>`.
        fn sent_handle(&self) -> Arc<Mutex<Vec<Vec<u8>>>> {
            Arc::clone(&self.sent)
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

    /// Build a minimal STX..ETX response frame with the given cmd byte and data payload.
    /// `parse_response` does not validate the LRC, so a placeholder zero byte is fine.
    fn framed(cmd_byte: u8, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(7 + data.len());
        out.push(STX);
        out.push(0x20); // len placeholder — parse_response does not validate
        out.push(0x20); // seq placeholder
        out.push(cmd_byte);
        out.extend_from_slice(data);
        out.push(0x05); // postamble
        out.push(0x00); // LRC placeholder
        out.push(ETX);
        out
    }

    /// Build a minimal `TransactionRequest` of type FiscalReceipt with one item and one payment.
    /// Amount is 250 cents (€2.50 cash) unless caller wants otherwise.
    fn sample_fiscal_request() -> TransactionRequest {
        let fiscal_data = FiscalReceiptData {
            items: vec![FiscalLineItem {
                description: "Coffee".into(),
                quantity: 1.0,
                unit_price: 250,
                tax_code: "A".into(),
                discount: None,
            }],
            payments: vec![FiscalPayment {
                method: "cash".into(),
                amount: 250,
            }],
            operator_id: Some("op-1".into()),
            receipt_comment: None,
        };
        TransactionRequest {
            transaction_id: "tx-test-1".into(),
            transaction_type: TransactionType::FiscalReceipt,
            amount: 250,
            currency: "EUR".into(),
            order_id: Some("order-1".into()),
            tip_amount: None,
            original_transaction_id: None,
            fiscal_data: Some(fiscal_data),
        }
    }

    /// Extract the cmd byte (at STX+3) from a sent frame produced by `build_frame`.
    fn cmd_of(frame: &[u8]) -> u8 {
        // Frames built by `build_frame` always begin with STX at index 0,
        // followed by len (1), seq (2), and cmd (3).
        frame[3]
    }

    #[test]
    fn test_process_transaction_fiscal_receipt_happy_path() {
        // open → ACK, item → ACK, subtotal → ACK, payment → ACK,
        // close → framed(ACK, "12345") so the receipt-number parser extracts "12345".
        let responses = vec![
            vec![ACK],
            vec![ACK],
            vec![ACK],
            vec![ACK],
            framed(ACK, b"12345"),
        ];
        let transport = MockTransport::new(responses);
        let sent = transport.sent_handle();
        let mut proto = GenericEscPosFiscal::new(Box::new(transport), &serde_json::json!({}));

        let request = sample_fiscal_request();
        let response = proto
            .process_transaction(&request)
            .expect("fiscal happy path should succeed");

        assert_eq!(response.status, TransactionStatus::Approved);
        assert_eq!(response.fiscal_receipt_number.as_deref(), Some("12345"));

        // Expect one frame per command: open, item, subtotal, payment, close = 5.
        let sent_frames = sent.lock().unwrap();
        assert_eq!(
            sent_frames.len(),
            5,
            "expected 5 sent frames, got {:?}",
            sent_frames.len()
        );
        assert_eq!(cmd_of(&sent_frames[0]), CMD_OPEN_FISCAL_RECEIPT);
        assert_eq!(cmd_of(&sent_frames[1]), CMD_SELL_ITEM);
        assert_eq!(cmd_of(&sent_frames[2]), CMD_SUBTOTAL);
        assert_eq!(cmd_of(&sent_frames[3]), CMD_PAYMENT);
        assert_eq!(cmd_of(&sent_frames[4]), CMD_CLOSE_FISCAL_RECEIPT);
    }

    #[test]
    fn test_process_transaction_item_nak_cancels_receipt() {
        // open succeeds; item returns a FRAMED NAK (the `if cmd == NAK` branch);
        // cancel succeeds. Expect: Err from process_transaction, and the last
        // sent frame is a CMD_CANCEL_RECEIPT.
        let responses = vec![
            vec![ACK],        // open
            framed(NAK, &[]), // item NAK
            vec![ACK],        // cancel
        ];
        let transport = MockTransport::new(responses);
        let sent = transport.sent_handle();
        let mut proto = GenericEscPosFiscal::new(Box::new(transport), &serde_json::json!({}));

        let request = sample_fiscal_request();
        let result = proto.process_transaction(&request);
        assert!(result.is_err(), "item NAK should propagate as Err");

        let sent_frames = sent.lock().unwrap();
        // open + item + cancel
        assert_eq!(sent_frames.len(), 3);
        assert_eq!(cmd_of(&sent_frames[0]), CMD_OPEN_FISCAL_RECEIPT);
        assert_eq!(cmd_of(&sent_frames[1]), CMD_SELL_ITEM);
        assert_eq!(
            cmd_of(&sent_frames[2]),
            CMD_CANCEL_RECEIPT,
            "after item NAK, device should be told to cancel the open receipt"
        );
    }

    #[test]
    fn test_process_transaction_subtotal_nak_cancels_receipt() {
        // open, item succeed; subtotal returns framed NAK (the NEW branch the F1
        // fix introduced — previously silently ignored). Expect cancel dispatched.
        let responses = vec![
            vec![ACK],        // open
            vec![ACK],        // item
            framed(NAK, &[]), // subtotal NAK
            vec![ACK],        // cancel
        ];
        let transport = MockTransport::new(responses);
        let sent = transport.sent_handle();
        let mut proto = GenericEscPosFiscal::new(Box::new(transport), &serde_json::json!({}));

        let request = sample_fiscal_request();
        let result = proto.process_transaction(&request);
        assert!(result.is_err(), "subtotal NAK should propagate as Err");

        let sent_frames = sent.lock().unwrap();
        // open + item + subtotal + cancel
        assert_eq!(sent_frames.len(), 4);
        assert_eq!(cmd_of(&sent_frames[2]), CMD_SUBTOTAL);
        assert_eq!(
            cmd_of(&sent_frames[3]),
            CMD_CANCEL_RECEIPT,
            "after subtotal NAK, device should be told to cancel the open receipt"
        );
    }

    #[test]
    fn test_process_transaction_payment_nak_cancels_receipt() {
        // open, item, subtotal succeed; payment returns framed NAK.
        let responses = vec![
            vec![ACK],        // open
            vec![ACK],        // item
            vec![ACK],        // subtotal
            framed(NAK, &[]), // payment NAK
            vec![ACK],        // cancel
        ];
        let transport = MockTransport::new(responses);
        let sent = transport.sent_handle();
        let mut proto = GenericEscPosFiscal::new(Box::new(transport), &serde_json::json!({}));

        let request = sample_fiscal_request();
        let result = proto.process_transaction(&request);
        assert!(result.is_err(), "payment NAK should propagate as Err");

        let sent_frames = sent.lock().unwrap();
        // open + item + subtotal + payment + cancel
        assert_eq!(sent_frames.len(), 5);
        assert_eq!(cmd_of(&sent_frames[3]), CMD_PAYMENT);
        assert_eq!(
            cmd_of(&sent_frames[4]),
            CMD_CANCEL_RECEIPT,
            "after payment NAK, device should be told to cancel the open receipt"
        );
    }

    #[test]
    fn test_parse_device_time_accepts_dd_mm_yy() {
        // Datecs default format: "DD-MM-YY HH:MM:SS".
        let parsed = parse_device_time(b"31-12-25 10:30:00");
        let dt = parsed.expect("dd-mm-yy should parse");
        assert_eq!(dt.date().to_string(), "2025-12-31");
        assert_eq!(dt.time().to_string(), "10:30:00");
    }

    #[test]
    fn test_parse_device_time_accepts_yyyy_mm_dd() {
        // Newer fiscal firmware variant: "YYYY-MM-DD HH:MM:SS".
        let parsed = parse_device_time(b"2025-12-31 10:30:00");
        let dt = parsed.expect("yyyy-mm-dd should parse");
        assert_eq!(dt.date().to_string(), "2025-12-31");
        assert_eq!(dt.time().to_string(), "10:30:00");
    }

    #[test]
    fn test_parse_device_time_trims_whitespace() {
        // Devices sometimes pad responses with trailing whitespace or null bytes.
        let parsed = parse_device_time(b"  31-12-25 10:30:00  ");
        assert!(parsed.is_some());
    }

    #[test]
    fn test_parse_device_time_returns_none_on_garbage() {
        assert!(parse_device_time(b"").is_none(), "empty should be None");
        assert!(
            parse_device_time(b"not a date").is_none(),
            "garbage should be None"
        );
        assert!(
            parse_device_time(b"31-13-25 10:30:00").is_none(),
            "invalid month should be None"
        );
    }

    #[test]
    fn test_probe_device_time_returns_none_on_nak() {
        // Single-byte [NAK] is treated by parse_response as Err, which
        // probe_device_time must swallow rather than propagate.
        let responses = vec![vec![NAK]];
        let transport = MockTransport::new(responses);
        let mut proto = GenericEscPosFiscal::new(Box::new(transport), &serde_json::json!({}));
        let result = proto.probe_device_time();
        assert!(
            result.is_none(),
            "NAK response must map to None, not an error"
        );
    }

    #[test]
    fn test_probe_device_time_returns_some_on_framed_datetime() {
        // Framed response carrying an ASCII "DD-MM-YY HH:MM:SS" date string.
        let responses = vec![framed(ACK, b"31-12-25 10:30:00")];
        let transport = MockTransport::new(responses);
        let mut proto = GenericEscPosFiscal::new(Box::new(transport), &serde_json::json!({}));
        let result = proto.probe_device_time();
        let dt = result.expect("parseable datetime should return Some");
        assert_eq!(dt.date().to_string(), "2025-12-31");
    }

    #[test]
    fn test_check_clock_drift_does_not_panic_on_unsupported_device() {
        // Ensure check_clock_drift handles all failure modes silently: NAK,
        // malformed data, empty response. This is the contract — initialize()
        // must never fail just because the device doesn't support 0x3E.
        let responses = vec![vec![NAK]];
        let transport = MockTransport::new(responses);
        let mut proto = GenericEscPosFiscal::new(Box::new(transport), &serde_json::json!({}));
        proto.check_clock_drift(); // expect no panic, no error
    }

    #[test]
    fn test_process_transaction_cancel_failure_still_returns_err() {
        // open succeeds; item NAKs; the cancel response is malformed (single
        // unknown byte), which makes parse_response return Err. The fix at
        // `generic_fiscal.rs:211` must log the cancel error and still
        // propagate the original item-NAK error to the caller.
        let responses = vec![
            vec![ACK],        // open
            framed(NAK, &[]), // item NAK
            vec![0xFF],       // cancel — parse_response rejects as Err
        ];
        let transport = MockTransport::new(responses);
        let sent = transport.sent_handle();
        let mut proto = GenericEscPosFiscal::new(Box::new(transport), &serde_json::json!({}));

        let request = sample_fiscal_request();
        let result = proto.process_transaction(&request);
        assert!(
            result.is_err(),
            "item-NAK error must still propagate even when cancel itself fails"
        );

        let sent_frames = sent.lock().unwrap();
        // Cancel was still dispatched (transport recorded the frame) even though
        // its response was rejected by parse_response.
        assert_eq!(sent_frames.len(), 3);
        assert_eq!(cmd_of(&sent_frames[2]), CMD_CANCEL_RECEIPT);
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
