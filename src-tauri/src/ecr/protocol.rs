//! ECR protocol trait and shared types.
//!
//! Defines the `EcrProtocol` trait that all protocol adapters implement, along
//! with the unified request/response types used across fiscal cash registers
//! and payment terminals.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Transaction types
// ---------------------------------------------------------------------------

/// Type of ECR transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionType {
    Sale,
    Refund,
    Void,
    PreAuth,
    PreAuthCompletion,
    /// Fiscal receipt (cash register only — sends item-level data).
    FiscalReceipt,
    /// Fiscal Z-close (end-of-day).
    FiscalZClose,
    /// Fiscal X-report (intermediate, no close).
    FiscalXReport,
}

/// Transaction outcome status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionStatus {
    Pending,
    Processing,
    Approved,
    Declined,
    Error,
    Timeout,
    Cancelled,
}

// ---------------------------------------------------------------------------
// Fiscal data (item-level receipt data for cash registers)
// ---------------------------------------------------------------------------

/// A single line item on a fiscal receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FiscalLineItem {
    pub description: String,
    pub quantity: f64,
    /// Unit price in cents.
    pub unit_price: i64,
    /// Tax rate code (e.g. "A", "B", "C", "D").
    pub tax_code: String,
    /// Optional discount in cents.
    pub discount: Option<i64>,
}

/// A payment entry on a fiscal receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FiscalPayment {
    /// Payment method: "cash", "card", "credit", etc.
    pub method: String,
    /// Amount in cents.
    pub amount: i64,
}

/// Complete fiscal receipt data sent to a cash register.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FiscalReceiptData {
    pub items: Vec<FiscalLineItem>,
    pub payments: Vec<FiscalPayment>,
    pub operator_id: Option<String>,
    pub receipt_comment: Option<String>,
}

// ---------------------------------------------------------------------------
// Tax rate configuration
// ---------------------------------------------------------------------------

/// A configured VAT tax rate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaxRateConfig {
    /// Tax code letter ("A", "B", "C", "D", etc.)
    pub code: String,
    /// Tax rate percentage (e.g. 24.0)
    pub rate: f64,
    /// Human-readable label (e.g. "Standard", "Reduced").
    pub label: String,
}

// ---------------------------------------------------------------------------
// Transaction request / response
// ---------------------------------------------------------------------------

/// Unified transaction request sent to a protocol adapter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionRequest {
    pub transaction_id: String,
    pub transaction_type: TransactionType,
    /// Amount in cents.
    pub amount: i64,
    pub currency: String,
    pub order_id: Option<String>,
    /// Tip in cents.
    pub tip_amount: Option<i64>,
    /// For refunds/voids: reference to the original transaction.
    pub original_transaction_id: Option<String>,
    /// Fiscal item-level data (for cash registers).
    pub fiscal_data: Option<FiscalReceiptData>,
}

/// Unified transaction response from a protocol adapter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionResponse {
    pub transaction_id: String,
    pub status: TransactionStatus,
    pub authorization_code: Option<String>,
    pub terminal_reference: Option<String>,
    pub fiscal_receipt_number: Option<String>,
    pub fiscal_z_number: Option<String>,
    pub card_type: Option<String>,
    pub card_last_four: Option<String>,
    pub entry_method: Option<String>,
    pub customer_receipt_lines: Option<Vec<String>>,
    pub merchant_receipt_lines: Option<Vec<String>>,
    pub error_message: Option<String>,
    pub error_code: Option<String>,
    pub raw_response: Option<serde_json::Value>,
    pub started_at: String,
    pub completed_at: String,
}

// ---------------------------------------------------------------------------
// Device status
// ---------------------------------------------------------------------------

/// Current status of a connected ECR device.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeviceStatus {
    pub connected: bool,
    pub ready: bool,
    pub busy: bool,
    pub error: Option<String>,
    pub firmware_version: Option<String>,
    pub serial_number: Option<String>,
    pub fiscal_receipt_counter: Option<u64>,
    pub fiscal_z_counter: Option<u64>,
}

// ---------------------------------------------------------------------------
// Settlement result
// ---------------------------------------------------------------------------

/// End-of-day settlement / Z-close result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettlementResult {
    pub success: bool,
    pub transaction_count: u32,
    pub total_amount: i64,
    pub z_number: Option<String>,
    pub error_message: Option<String>,
    pub raw_response: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Protocol trait
// ---------------------------------------------------------------------------

/// Protocol adapter trait for ECR (Electronic Cash Register) devices.
///
/// Each supported wire protocol (Generic Fiscal STX/ETX, ZVT DLE/STX, PAX
/// STX/ETX) implements this trait. The trait abstracts the byte-level
/// encoding/decoding so that higher-level code (commands, UI) can work with
/// any cash register or payment terminal uniformly.
///
/// # Lifecycle
///
/// 1. The [`DeviceManager`] creates a protocol instance with a transport.
/// 2. [`initialize`](EcrProtocol::initialize) performs the device handshake.
/// 3. The device is ready for [`process_transaction`](EcrProtocol::process_transaction) calls.
/// 4. [`abort`](EcrProtocol::abort) or [`cancel_transaction`](EcrProtocol::cancel_transaction)
///    can interrupt in-flight operations.
/// 5. [`settlement`](EcrProtocol::settlement) performs end-of-day Z-close.
///
/// # Thread Safety
///
/// Requires `Send` so instances can be held behind `Mutex` in the
/// `DeviceManager` managed state. `&mut self` on all methods ensures
/// exclusive access during protocol exchanges.
pub trait EcrProtocol: Send {
    /// Returns the protocol name (e.g. `"GenericFiscal"`, `"ZVT"`, `"PAX"`).
    /// Used in log messages, error formatting, and UI display.
    fn name(&self) -> &str;

    /// Perform device initialization (registration, login, or handshake).
    ///
    /// Called once after transport connection. Should configure the device
    /// for transaction processing. Returns `Err` if the handshake fails.
    fn initialize(&mut self) -> Result<(), String>;

    /// Submit a transaction to the device.
    ///
    /// Handles all [`TransactionType`] variants: card payments, refunds,
    /// voids, pre-auths, fiscal receipts, and fiscal Z/X reports.
    /// The response includes authorization codes, receipt lines, and
    /// fiscal counters as applicable.
    fn process_transaction(
        &mut self,
        request: &TransactionRequest,
    ) -> Result<TransactionResponse, String>;

    /// Cancel the current in-flight transaction, if the device supports it.
    ///
    /// Sends a protocol-level cancel/abort and waits for acknowledgment.
    fn cancel_transaction(&mut self) -> Result<(), String>;

    /// Query the device for its current operational status.
    ///
    /// Returns connectivity, readiness, firmware version, and fiscal
    /// counters. Useful for health checks and diagnostics.
    fn get_status(&mut self) -> Result<DeviceStatus, String>;

    /// Perform end-of-day settlement or fiscal Z-close.
    ///
    /// Finalizes all pending transactions, resets daily counters, and
    /// returns a summary with transaction count, total amount, and Z-number.
    fn settlement(&mut self) -> Result<SettlementResult, String>;

    /// Generate a fiscal X-report (intermediate totals, no counter reset).
    ///
    /// Returns the report text if supported, or `Err` for devices that
    /// do not implement X-reports. The default implementation returns
    /// an error.
    #[allow(dead_code)]
    fn x_report(&mut self) -> Result<Option<String>, String> {
        Err(format!("{}: X-report not supported", self.name()))
    }

    /// Abort any ongoing operation immediately.
    ///
    /// Unlike [`cancel_transaction`](EcrProtocol::cancel_transaction), this
    /// is a forceful interrupt that does not wait for a clean response.
    fn abort(&mut self) -> Result<(), String>;

    /// Test connectivity by sending a status inquiry to the device.
    ///
    /// Returns `Ok(true)` if the device responds, `Ok(false)` if it does
    /// not respond within the timeout, or `Err` on transport failure.
    fn test_connection(&mut self) -> Result<bool, String>;

    /// Send raw ESC/POS bytes directly through the transport.
    ///
    /// Used in "POS sends receipt" mode where the POS application
    /// generates the receipt data and the cash register acts as a
    /// pass-through printer. Returns the number of bytes written.
    fn send_raw(&mut self, data: &[u8]) -> Result<usize, String>;
}
