//! CAP Driver file-queue protocol adapter.
//!
//! RBS/MAT CAP Driver is a Windows service supplied by the fiscal-device
//! vendor. POS applications place UTF-8 command files in its capture folder;
//! the service owns the authenticated TCP/UDP/serial connection to the
//! cashier. This adapter deliberately does not write CAP commands directly to
//! the device socket and never stores the cashier serial number or unlock key.
//! Those credentials remain in the vendor service configuration on the POS PC.

use crate::ecr::protocol::*;
use crate::ecr::transport::EcrTransport;
use chrono::Utc;
use serde_json::json;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tracing::info;

const DEFAULT_CAPTURE_PATH: &str = r"C:\Capture";
const DEFAULT_SERVICE_NAME: &str = "CapDriverSVC";
const DEFAULT_TRANSACTION_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 3_000;
const OUTPUT_SETTLE_MS: u64 = 500;
const POLL_INTERVAL_MS: u64 = 100;

struct DriverCompletion {
    status: TransactionStatus,
    error: Option<String>,
    output: Option<String>,
    consumed: bool,
}

/// Vendor-supplied CAP Driver adapter. The boxed transport is retained only to
/// satisfy the shared protocol lifecycle; CAP Driver itself owns the wire.
pub struct CapDriverProtocol {
    _transport: Box<dyn EcrTransport>,
    capture_path: PathBuf,
    output_path: PathBuf,
    service_name: String,
    host: Option<String>,
    port: Option<u16>,
    transaction_timeout_ms: u64,
    connect_timeout_ms: u64,
    cash_payment_code: u8,
    card_payment_code: u8,
    eft_pos_index: u8,
    require_service: bool,
    initialized: bool,
}

impl CapDriverProtocol {
    pub fn new(
        transport: Box<dyn EcrTransport>,
        config: &serde_json::Value,
        connection_details: &serde_json::Value,
    ) -> Self {
        let capture_path = string_setting(config, &["capturePath", "capture_path"])
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CAPTURE_PATH));
        let output_path = string_setting(config, &["outputPath", "output_path"])
            .map(PathBuf::from)
            .unwrap_or_else(|| capture_path.join("Output"));
        let service_name = string_setting(config, &["serviceName", "service_name"])
            .unwrap_or_else(|| DEFAULT_SERVICE_NAME.to_string());
        let host = string_setting(connection_details, &["ip", "host", "hostname"]);
        let port = u64_setting(connection_details, &["port", "tcpPort", "tcp_port"])
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0);

        Self {
            _transport: transport,
            capture_path,
            output_path,
            service_name,
            host,
            port,
            transaction_timeout_ms: u64_setting(
                config,
                &["transactionTimeoutMs", "transaction_timeout_ms"],
            )
            .unwrap_or(DEFAULT_TRANSACTION_TIMEOUT_MS)
            .clamp(5_000, 300_000),
            connect_timeout_ms: u64_setting(config, &["connectTimeoutMs", "connect_timeout_ms"])
                .unwrap_or(DEFAULT_CONNECT_TIMEOUT_MS)
                .clamp(250, 30_000),
            cash_payment_code: bounded_u8_setting(
                config,
                &["cashPaymentCode", "cash_payment_code"],
                1,
                1,
                20,
            ),
            card_payment_code: bounded_u8_setting(
                config,
                &["cardPaymentCode", "card_payment_code"],
                2,
                1,
                20,
            ),
            eft_pos_index: bounded_u8_setting(config, &["eftPosIndex", "eft_pos_index"], 1, 1, 99),
            require_service: bool_setting(config, &["requireService", "require_service"])
                .unwrap_or(true),
            initialized: false,
        }
    }

    fn check_readiness(&self) -> Result<(), String> {
        if !self.capture_path.is_dir() {
            return Err(format!(
                "CAP Driver capture folder does not exist: {}",
                self.capture_path.display()
            ));
        }
        if !self.output_path.is_dir() {
            return Err(format!(
                "CAP Driver output folder does not exist: {}",
                self.output_path.display()
            ));
        }
        if self.require_service && !service_is_running(&self.service_name)? {
            return Err(format!(
                "Windows service '{}' is not running",
                self.service_name
            ));
        }

        if let (Some(host), Some(port)) = (&self.host, self.port) {
            let target = format!("{host}:{port}");
            let addresses = target
                .to_socket_addrs()
                .map_err(|error| format!("Cannot resolve fiscal device {target}: {error}"))?;
            let timeout = Duration::from_millis(self.connect_timeout_ms);
            let mut last_error = None;
            for address in addresses {
                match TcpStream::connect_timeout(&address, timeout) {
                    Ok(stream) => {
                        drop(stream);
                        return Ok(());
                    }
                    Err(error) => last_error = Some(error.to_string()),
                }
            }
            return Err(format!(
                "Fiscal device {target} is not reachable: {}",
                last_error.unwrap_or_else(|| "no resolved address".to_string())
            ));
        }

        Ok(())
    }

    fn build_receipt_commands(&self, request: &TransactionRequest) -> Result<Vec<String>, String> {
        if request.transaction_type != TransactionType::FiscalReceipt {
            return Err("CAP Driver receipt builder requires fiscal_receipt".to_string());
        }
        if request.currency.to_uppercase() != "EUR" {
            return Err("CAP Driver supports EUR fiscal receipts only".to_string());
        }
        let fiscal = request
            .fiscal_data
            .as_ref()
            .ok_or("Fiscal receipt data is required")?;
        if fiscal.items.is_empty() {
            return Err("Fiscal receipt must contain at least one item".to_string());
        }
        if fiscal.payments.is_empty() {
            return Err("Fiscal receipt must contain at least one payment".to_string());
        }

        let mut commands = Vec::with_capacity(fiscal.items.len() * 2 + 4);
        let mut receipt_total = 0i64;

        for (index, item) in fiscal.items.iter().enumerate() {
            if !item.quantity.is_finite() || item.quantity <= 0.0 || item.quantity > 99_999.999 {
                return Err(format!("CAP item {index} has an invalid quantity"));
            }
            if item.unit_price <= 0 || item.unit_price > 99_999_999 {
                return Err(format!("CAP item {index} has an invalid unit price"));
            }
            if !item.tax_rate.is_finite() || !(0.0..=100.0).contains(&item.tax_rate) {
                return Err(format!("CAP item {index} has an invalid VAT rate"));
            }
            let department = item.department.ok_or_else(|| {
                format!(
                    "CAP item {index} tax code '{}' has no fiscal department mapping",
                    item.tax_code
                )
            })?;
            if department == 0 || department > 99 {
                return Err(format!("CAP item {index} has an invalid department"));
            }

            let discount = item.discount.unwrap_or(0);
            let gross = (item.quantity * item.unit_price as f64).round() as i64;
            if discount < 0 || discount >= gross {
                return Err(format!("CAP item {index} has an invalid discount"));
            }
            receipt_total = receipt_total
                .checked_add(gross - discount)
                .ok_or("Fiscal receipt total overflow")?;

            commands.push(format!(
                "SL/{}//{:.3}/{}/{}/{}",
                sanitize_field(&item.description, 40),
                item.quantity,
                cents_to_money(item.unit_price),
                department,
                format_decimal(item.tax_rate)
            ));
            if discount > 0 {
                commands.push(format!("DE/{}", cents_to_money(discount)));
            }
        }

        if let Some(comment) = request
            .order_id
            .as_deref()
            .or(fiscal.receipt_comment.as_deref())
        {
            commands.push(format!("CM/{}/", sanitize_field(comment, 40)));
        }

        let payment_total = fiscal.payments.iter().try_fold(0i64, |total, payment| {
            if payment.amount <= 0 {
                return Err("CAP payment amount must be positive".to_string());
            }
            total
                .checked_add(payment.amount)
                .ok_or_else(|| "Fiscal payment total overflow".to_string())
        })?;
        if payment_total != request.amount || payment_total != receipt_total {
            return Err(format!(
                "CAP totals do not balance (items {receipt_total} cents, payments {payment_total} cents, request {} cents)",
                request.amount
            ));
        }

        let mut cash = None;
        let mut card = None;
        for payment in &fiscal.payments {
            match normalize_payment_method(&payment.method) {
                "cash" => {
                    if cash.replace(payment.amount).is_some() {
                        return Err("CAP Driver supports one cash payment entry".to_string());
                    }
                }
                "card" => {
                    if card.replace(payment.amount).is_some() {
                        return Err("CAP Driver supports one card payment entry".to_string());
                    }
                }
                _ => {
                    return Err(format!(
                        "CAP Driver does not support fiscal payment method '{}'",
                        payment.method
                    ))
                }
            }
        }

        if let Some(amount) = card {
            commands.push(format!(
                "LR/{}/{}/ΚΑΡΤΑ///{}/1/",
                self.card_payment_code,
                cents_to_money(amount),
                self.eft_pos_index
            ));
        }
        if cash.is_some() {
            commands.push(format!("CR/{}/0/ΜΕΤΡΗΤΑ", self.cash_payment_code));
        }

        Ok(commands)
    }

    fn submit_commands(
        &self,
        transaction_id: &str,
        commands: &[String],
        timeout_ms: u64,
    ) -> Result<DriverCompletion, String> {
        if commands.is_empty() {
            return Err("CAP command file cannot be empty".to_string());
        }
        let safe_id = sanitize_filename(transaction_id);
        let file_name = format!("pos-tauri-{safe_id}.txt");
        let pending_name = format!("pos-tauri-{safe_id}.pending");
        let command_path = self.capture_path.join(&file_name);
        let pending_path = self.capture_path.join(&pending_name);
        if command_path.exists() || pending_path.exists() {
            return Err(format!(
                "CAP command already exists for transaction {transaction_id}"
            ));
        }

        let log_path = self.capture_path.join("CapDriverSVC_log.txt");
        let log_offset = fs::metadata(&log_path).map(|meta| meta.len()).unwrap_or(0);
        let submitted_at = SystemTime::now();
        let body = format!("{}\r\n", commands.join("\r\n"));

        let mut file = File::create(&pending_path)
            .map_err(|error| format!("Create CAP command file: {error}"))?;
        file.write_all(body.as_bytes())
            .map_err(|error| format!("Write CAP command file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Flush CAP command file: {error}"))?;
        drop(file);
        fs::rename(&pending_path, &command_path)
            .map_err(|error| format!("Publish CAP command file: {error}"))?;

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        while Instant::now() < deadline {
            if !command_path.exists() {
                thread::sleep(Duration::from_millis(OUTPUT_SETTLE_MS));
                let output = find_driver_output(&self.output_path, &file_name, submitted_at)
                    .and_then(|path| fs::read_to_string(path).ok());
                let log_delta = read_log_delta(&log_path, log_offset);
                let combined = [output.as_deref(), log_delta.as_deref()]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join("\n");
                let error = classify_driver_error(&combined);
                return Ok(DriverCompletion {
                    status: if error.is_some() {
                        TransactionStatus::Error
                    } else {
                        TransactionStatus::Approved
                    },
                    error,
                    output,
                    consumed: true,
                });
            }
            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }

        // The service may consume the file on the timeout boundary. Check once
        // more, but never delete or resubmit an ambiguous command: it may still
        // commit on the cashier after the POS stops waiting.
        let consumed = !command_path.exists();
        let output = find_driver_output(&self.output_path, &file_name, submitted_at)
            .and_then(|path| fs::read_to_string(path).ok());
        let log_delta = read_log_delta(&log_path, log_offset);
        let combined = [output.as_deref(), log_delta.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
        let error = classify_driver_error(&combined);
        Ok(DriverCompletion {
            status: if error.is_some() {
                TransactionStatus::Error
            } else {
                TransactionStatus::Timeout
            },
            error: error.or_else(|| {
                Some(
                    "CAP Driver completion is unknown; inspect the cashier and CAP log before retrying"
                        .to_string(),
                )
            }),
            output,
            consumed,
        })
    }

    fn response_from_completion(
        &self,
        request: &TransactionRequest,
        started_at: String,
        completion: DriverCompletion,
    ) -> TransactionResponse {
        let ambiguous = completion.status == TransactionStatus::Timeout;
        TransactionResponse {
            transaction_id: request.transaction_id.clone(),
            status: completion.status,
            authorization_code: None,
            terminal_reference: Some(format!(
                "pos-tauri-{}.txt",
                sanitize_filename(&request.transaction_id)
            )),
            fiscal_receipt_number: None,
            fiscal_z_number: None,
            card_type: None,
            card_last_four: None,
            entry_method: None,
            customer_receipt_lines: None,
            merchant_receipt_lines: None,
            error_message: completion.error,
            error_code: ambiguous.then(|| "CAP_COMPLETION_UNKNOWN".to_string()),
            raw_response: Some(json!({
                "adapter": "cap_driver",
                "commandConsumed": completion.consumed,
                "requiresReconciliation": ambiguous,
                "output": completion.output,
            })),
            started_at,
            completed_at: Utc::now().to_rfc3339(),
        }
    }
}

impl EcrProtocol for CapDriverProtocol {
    fn name(&self) -> &str {
        "CAP Driver"
    }

    fn initialize(&mut self) -> Result<(), String> {
        self.check_readiness()?;
        self.initialized = true;
        info!(
            capture_path = %self.capture_path.display(),
            "CAP Driver fiscal adapter initialized"
        );
        Ok(())
    }

    fn process_transaction(
        &mut self,
        request: &TransactionRequest,
    ) -> Result<TransactionResponse, String> {
        if !self.initialized {
            return Err("CAP Driver adapter is not initialized".to_string());
        }
        let started_at = Utc::now().to_rfc3339();
        match request.transaction_type {
            TransactionType::FiscalReceipt => {
                let commands = self.build_receipt_commands(request)?;
                let completion = self.submit_commands(
                    &request.transaction_id,
                    &commands,
                    self.transaction_timeout_ms,
                )?;
                Ok(self.response_from_completion(request, started_at, completion))
            }
            TransactionType::FiscalZClose => {
                let completion = self.submit_commands(
                    &request.transaction_id,
                    &["ZZ/".to_string()],
                    self.transaction_timeout_ms,
                )?;
                Ok(self.response_from_completion(request, started_at, completion))
            }
            _ => Err(format!(
                "CAP Driver does not support {:?} through the fiscal-cashier adapter",
                request.transaction_type
            )),
        }
    }

    fn cancel_transaction(&mut self) -> Result<(), String> {
        let id = format!("cancel-{}", uuid::Uuid::new_v4());
        let completion =
            self.submit_commands(&id, &["CL/".to_string()], self.transaction_timeout_ms)?;
        if completion.status == TransactionStatus::Approved {
            Ok(())
        } else {
            Err(completion
                .error
                .unwrap_or_else(|| "CAP receipt cancellation failed".to_string()))
        }
    }

    fn get_status(&mut self) -> Result<DeviceStatus, String> {
        match self.check_readiness() {
            Ok(()) => Ok(DeviceStatus {
                connected: true,
                ready: true,
                busy: false,
                error: None,
                firmware_version: None,
                serial_number: None,
                fiscal_receipt_counter: None,
                fiscal_z_counter: None,
            }),
            Err(error) => Ok(DeviceStatus {
                connected: false,
                ready: false,
                busy: false,
                error: Some(error),
                ..DeviceStatus::default()
            }),
        }
    }

    fn settlement(&mut self) -> Result<SettlementResult, String> {
        let id = format!("z-{}", uuid::Uuid::new_v4());
        let completion =
            self.submit_commands(&id, &["ZZ/".to_string()], self.transaction_timeout_ms)?;
        Ok(SettlementResult {
            success: completion.status == TransactionStatus::Approved,
            transaction_count: 0,
            total_amount: 0,
            z_number: None,
            error_message: completion.error,
            raw_response: Some(json!({
                "adapter": "cap_driver",
                "commandConsumed": completion.consumed,
                "output": completion.output,
            })),
        })
    }

    fn x_report(&mut self) -> Result<Option<String>, String> {
        let id = format!("x-{}", uuid::Uuid::new_v4());
        let completion =
            self.submit_commands(&id, &["XX/".to_string()], self.transaction_timeout_ms)?;
        if completion.status == TransactionStatus::Approved {
            Ok(completion.output)
        } else {
            Err(completion
                .error
                .unwrap_or_else(|| "CAP X-report failed".to_string()))
        }
    }

    fn abort(&mut self) -> Result<(), String> {
        // Do not delete an already-published command file: CAP Driver may have
        // consumed it and committed a fiscal receipt. The reconciliation guard
        // in checkout prevents blind retries after an ambiguous timeout.
        self.initialized = false;
        Ok(())
    }

    fn test_connection(&mut self) -> Result<bool, String> {
        self.check_readiness()?;
        // CAP Driver has no documented read-only status command. XX prints a
        // non-closing X report and is the least invasive documented command
        // that proves the service credentials, file queue, wire protocol, and
        // cashier all work. UI copy warns operators about this paper output.
        let id = format!("connection-test-{}", uuid::Uuid::new_v4());
        let completion =
            self.submit_commands(&id, &["XX/".to_string()], self.transaction_timeout_ms)?;
        match completion.status {
            TransactionStatus::Approved => Ok(true),
            _ => Err(completion
                .error
                .unwrap_or_else(|| "CAP Driver X-report handshake failed".to_string())),
        }
    }

    fn send_raw(&mut self, _data: &[u8]) -> Result<usize, String> {
        Err("CAP Driver accepts fiscal command files, not raw ESC/POS bytes".to_string())
    }
}

fn string_setting(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|entry| entry.as_str())
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
}

fn u64_setting(value: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|entry| {
            entry
                .as_u64()
                .or_else(|| entry.as_str().and_then(|text| text.parse().ok()))
        })
}

fn bool_setting(value: &serde_json::Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(serde_json::Value::as_bool)
}

fn bounded_u8_setting(
    value: &serde_json::Value,
    keys: &[&str],
    fallback: u8,
    min: u8,
    max: u8,
) -> u8 {
    u64_setting(value, keys)
        .and_then(|entry| u8::try_from(entry).ok())
        .filter(|entry| (*entry >= min) && (*entry <= max))
        .unwrap_or(fallback)
}

fn service_is_running(service_name: &str) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("sc.exe")
            .args(["query", service_name])
            .output()
            .map_err(|error| format!("Query CAP Driver service: {error}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_uppercase();
        let stderr = String::from_utf8_lossy(&output.stderr).to_uppercase();
        Ok(output.status.success() && (stdout.contains("RUNNING") || stderr.contains("RUNNING")))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = service_name;
        Err("CAP Driver service integration is supported on Windows only".to_string())
    }
}

fn sanitize_field(value: &str, max_chars: usize) -> String {
    let replaced = value
        .chars()
        .map(|ch| {
            if ch == '/' || ch == '\r' || ch == '\n' || ch.is_control() {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated = collapsed.chars().take(max_chars).collect::<String>();
    if truncated.is_empty() {
        "ITEM".to_string()
    } else {
        truncated
    }
}

fn sanitize_filename(value: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .take(80)
        .collect::<String>();
    if sanitized.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        sanitized
    }
}

fn cents_to_money(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents.unsigned_abs() % 100)
}

fn format_decimal(value: f64) -> String {
    let formatted = format!("{value:.3}");
    formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn normalize_payment_method(method: &str) -> &'static str {
    match method.trim().to_ascii_lowercase().as_str() {
        "cash" | "μετρητά" | "metrita" => "cash",
        "card" | "credit_card" | "debit_card" | "pos" | "eftpos" | "κάρτα" => "card",
        _ => "unsupported",
    }
}

fn find_driver_output(
    output_path: &Path,
    file_name: &str,
    submitted_at: SystemTime,
) -> Option<PathBuf> {
    let exact = output_path.join(file_name);
    if exact.is_file() {
        return Some(exact);
    }
    let stem = Path::new(file_name).file_stem()?.to_string_lossy();
    fs::read_dir(output_path)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(stem.as_ref())
        })
        .filter(|entry| {
            entry
                .metadata()
                .and_then(|meta| meta.modified())
                .map(|modified| modified >= submitted_at)
                .unwrap_or(false)
        })
        .max_by_key(|entry| {
            entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        })
        .map(|entry| entry.path())
}

fn read_log_delta(path: &Path, offset: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    if length <= offset {
        return None;
    }
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(offset)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn classify_driver_error(text: &str) -> Option<String> {
    let normalized = text.to_ascii_lowercase();
    for marker in ["error 0x", "error: 0x"] {
        let mut remainder = normalized.as_str();
        while let Some(index) = remainder.find(marker) {
            let code_start = index + marker.len();
            let code = remainder
                .get(code_start..code_start + 2)
                .unwrap_or_default();
            if code != "00" {
                return Some(format!("CAP Driver reported device error 0x{code}"));
            }
            remainder = &remainder[code_start.saturating_add(2)..];
        }
    }
    if normalized.contains("receipt is canceled")
        || normalized.contains("payment failed")
        || normalized.contains("abort by user")
        || normalized.contains("fatal error")
    {
        return Some("CAP Driver rejected or cancelled the fiscal transaction".to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ecr::transport::TransportState;

    struct NoopTransport;

    impl EcrTransport for NoopTransport {
        fn connect(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn disconnect(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn send(&mut self, _data: &[u8]) -> Result<usize, String> {
            Ok(0)
        }
        fn receive(&mut self, _timeout_ms: u64) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn is_connected(&self) -> bool {
            false
        }
        fn state(&self) -> TransportState {
            TransportState::Disconnected
        }
        fn description(&self) -> String {
            "noop".to_string()
        }
    }

    fn adapter() -> CapDriverProtocol {
        CapDriverProtocol::new(
            Box::new(NoopTransport),
            &json!({
                "cashPaymentCode": 1,
                "cardPaymentCode": 2,
                "eftPosIndex": 1,
                "requireService": false,
            }),
            &json!({}),
        )
    }

    fn request(method: &str) -> TransactionRequest {
        TransactionRequest {
            transaction_id: "tx-1".to_string(),
            transaction_type: TransactionType::FiscalReceipt,
            amount: 1,
            currency: "EUR".to_string(),
            order_id: Some("ORDER/1".to_string()),
            tip_amount: None,
            original_transaction_id: None,
            fiscal_data: Some(FiscalReceiptData {
                items: vec![FiscalLineItem {
                    description: "POS/TAURI\nTEST".to_string(),
                    quantity: 1.0,
                    unit_price: 1,
                    tax_code: "A".to_string(),
                    tax_rate: 24.0,
                    department: Some(3),
                    discount: None,
                }],
                payments: vec![FiscalPayment {
                    method: method.to_string(),
                    amount: 1,
                }],
                operator_id: None,
                receipt_comment: None,
            }),
        }
    }

    #[test]
    fn builds_official_cap_cash_example_shape() {
        let commands = adapter().build_receipt_commands(&request("cash")).unwrap();
        assert_eq!(
            commands,
            vec![
                "SL/POS TAURI TEST//1.000/0.01/3/24",
                "CM/ORDER 1/",
                "CR/1/0/ΜΕΤΡΗΤΑ",
            ]
        );
    }

    #[test]
    fn builds_official_cap_eft_sale_shape() {
        let commands = adapter().build_receipt_commands(&request("card")).unwrap();
        assert_eq!(
            commands,
            vec![
                "SL/POS TAURI TEST//1.000/0.01/3/24",
                "CM/ORDER 1/",
                "LR/2/0.01/ΚΑΡΤΑ///1/1/",
            ]
        );
    }

    #[test]
    fn rejects_missing_department_mapping() {
        let mut request = request("cash");
        request.fiscal_data.as_mut().unwrap().items[0].department = None;
        let error = adapter().build_receipt_commands(&request).unwrap_err();
        assert!(error.contains("no fiscal department mapping"));
    }

    #[test]
    fn rejects_unbalanced_totals_before_publishing_file() {
        let mut request = request("cash");
        request.amount = 2;
        let error = adapter().build_receipt_commands(&request).unwrap_err();
        assert!(error.contains("totals do not balance"));
    }

    #[test]
    fn only_nonzero_driver_error_codes_fail() {
        assert_eq!(classify_driver_error("(SL)Error 0x00: OK"), None);
        assert_eq!(
            classify_driver_error("(LR)Error 0x42: EFTPOS Payment Failed"),
            Some("CAP Driver reported device error 0x42".to_string())
        );
    }
}
