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

/// Protocol adapter trait — all ECR protocols implement this.
///
/// Implementations handle the byte-level protocol encoding/decoding while
/// the [`DeviceManager`] handles lifecycle and persistence.
pub trait EcrProtocol: Send {
    /// Protocol name (for logging/display).
    fn name(&self) -> &str;

    /// Initialize the protocol (registration, login, handshake, etc.).
    fn initialize(&mut self) -> Result<(), String>;

    /// Process a transaction (payment, refund, fiscal receipt, etc.).
    fn process_transaction(
        &mut self,
        request: &TransactionRequest,
    ) -> Result<TransactionResponse, String>;

    /// Cancel the current in-flight transaction.
    fn cancel_transaction(&mut self) -> Result<(), String>;

    /// Query device status.
    fn get_status(&mut self) -> Result<DeviceStatus, String>;

    /// End-of-day settlement or fiscal Z-close.
    fn settlement(&mut self) -> Result<SettlementResult, String>;

    /// Fiscal X-report (intermediate report, no close). Optional.
    fn x_report(&mut self) -> Result<Option<String>, String> {
        Err(format!("{}: X-report not supported", self.name()))
    }

    /// Abort any ongoing operation.
    fn abort(&mut self) -> Result<(), String>;

    /// Test connectivity (send a status inquiry and check for a response).
    fn test_connection(&mut self) -> Result<bool, String>;

    /// Send raw bytes directly through the transport (for "POS sends receipt" mode).
    fn send_raw(&mut self, data: &[u8]) -> Result<usize, String>;
}
