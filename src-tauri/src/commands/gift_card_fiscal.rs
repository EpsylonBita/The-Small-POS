//! Fiscal receipt for an order settled by an atomic gift card redemption.
//!
//! The redemption imports a tender the server already completed, so nothing is
//! left to collect and the outstanding-checkout receipt (which expects a new
//! collection) cannot be used. This module issues the order's one fiscal
//! receipt from its canonical completed rows — the gift card plus any cash
//! already booked — on the default CAP cash register: gift value on the
//! cashier's voucher payment number (`CR`), never `LR` (an EFT sale). It never
//! adds a payment, debits the card again, books cash or charges a card.
//!
//! Every dispatch is reserved first in `gift_card_fiscal_operations` (v84) with
//! the order, ledger, payload and register fingerprints and the CAP file
//! correlation. A lost response, a failed acknowledgement or a restart is
//! recovered from those files by a read-only probe, never by another receipt.
//! An outcome nothing proves stays unknown and keeps the order's ledger locked.

use std::future::Future;
use std::sync::MutexGuard;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::commands::ecr as ecr_commands;
use crate::ecr::protocol::{
    FiscalReceiptData, GiftTenderCodes, SettledDispatch, TaxRateConfig, TransactionRequest,
    TransactionResponse, TransactionStatus, TransactionType,
};
use crate::ecr::protocols::cap_driver::{self, SettledProbe};
use crate::ecr::DeviceManager;
use crate::{db, payments};

const CAP_PROTOCOL: &str = "cap_driver";
/// The only currency the settled gift card receipt route prints.
const RECEIPT_CURRENCY: &str = "EUR";

// ---------------------------------------------------------------------------
// Register access
// ---------------------------------------------------------------------------

/// What a settled receipt needs from the live register handle. Implemented by
/// the device manager; tests use a controlled fake.
pub(crate) trait RegisterAccess: Send + Sync {
    /// Fingerprint of the configuration the connected handle consumed; `None`
    /// when the register is not connected.
    fn consumed_config_fingerprint(&self, device_id: &str) -> Result<Option<String>, String>;
    /// Payment codes the connected adapter emits for a settled gift receipt.
    fn gift_tender_codes(&self, device_id: &str) -> Result<Option<GiftTenderCodes>, String>;
    /// Restart-proof correlation, captured before a dispatch with this id.
    fn dispatch_correlation(&self, device_id: &str, transaction_id: &str) -> Result<Value, String>;
}

impl RegisterAccess for DeviceManager {
    fn consumed_config_fingerprint(&self, device_id: &str) -> Result<Option<String>, String> {
        self.connected_config_fingerprint(device_id)
    }

    fn gift_tender_codes(&self, device_id: &str) -> Result<Option<GiftTenderCodes>, String> {
        DeviceManager::gift_tender_codes(self, device_id)
    }

    fn dispatch_correlation(&self, device_id: &str, transaction_id: &str) -> Result<Value, String> {
        self.fiscal_dispatch_correlation(device_id, transaction_id)
    }
}

// ---------------------------------------------------------------------------
// Branch cloud fiscal route
// ---------------------------------------------------------------------------

/// Branch fiscalization route, read from the terminal-auth integrations list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CloudRoute {
    /// No active cloud route that refuses gift card tenders.
    Allowed,
    /// Direct Greek AADE (myDATA) API: no verified gift card route.
    DirectAade,
    /// The read failed: the route is unknown, never "not configured".
    Unavailable(String),
}

impl CloudRoute {
    fn label(&self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::DirectAade => "direct_aade",
            Self::Unavailable(_) => "unavailable",
        }
    }
}

fn flag(entry: &Value, key: &str) -> bool {
    entry.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Classify a `GET /api/pos/integrations` body. A body without a list is an
/// unknown route, not an unconfigured one.
pub(crate) fn classify_integrations(payload: &Value) -> CloudRoute {
    if payload.get("success").and_then(Value::as_bool) == Some(false) {
        return CloudRoute::Unavailable("The integrations read was refused".to_string());
    }
    let Some(entries) = ["integrations", "data", "plugins"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_array))
        .or_else(|| payload.as_array())
    else {
        return CloudRoute::Unavailable(
            "The integrations response has no integrations list".to_string(),
        );
    };
    let direct_aade = entries.iter().any(|entry| {
        let plugin = entry
            .get("plugin_id")
            .or_else(|| entry.get("provider"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let in_use = flag(entry, "is_active")
            || (flag(entry, "is_enabled")
                && entry
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| status != "inactive"));
        let mode = entry
            .pointer("/settings/mode")
            .and_then(Value::as_str)
            .unwrap_or_default();
        plugin == "fiscalization_gr" && in_use && mode.eq_ignore_ascii_case("direct_api")
    });
    if direct_aade {
        CloudRoute::DirectAade
    } else {
        CloudRoute::Allowed
    }
}

/// Read the branch route through the terminal-auth POS integrations list.
pub(crate) async fn fetch_cloud_route(db: &db::DbState) -> CloudRoute {
    match crate::admin_fetch_detailed(Some(db), "/api/pos/integrations", "GET", None).await {
        Ok(payload) => classify_integrations(&payload),
        // A refusal such as 403 MODULE_REQUIRED does not show which fiscal
        // route the branch uses, so it stays unavailable like any failed read.
        // Only the bounded status and code: the free-form message may carry
        // endpoint details.
        Err(error) => CloudRoute::Unavailable(match (error.status(), error.code()) {
            (_, Some(code)) => format!("integrations read refused: {code}"),
            (Some(status), None) => format!("integrations read failed with HTTP {status}"),
            (None, None) => "integrations read failed".to_string(),
        }),
    }
}

type Refused = (&'static str, &'static str, String);

fn cloud_refusal(cloud: &CloudRoute) -> Option<Refused> {
    match cloud {
        CloudRoute::Allowed => None,
        CloudRoute::DirectAade => Some((
            "unsupported",
            "GIFT_CARD_FISCAL_DIRECT_AADE_UNSUPPORTED",
            "This branch reports receipts directly to AADE, which has no verified gift card route; gift cards cannot be accepted here"
                .to_string(),
        )),
        CloudRoute::Unavailable(reason) => Some((
            "unavailable",
            "GIFT_CARD_FISCAL_ROUTE_UNAVAILABLE",
            format!("The branch fiscal route could not be verified ({reason}); try again when online"),
        )),
    }
}

// ---------------------------------------------------------------------------
// Register readiness
// ---------------------------------------------------------------------------

/// The default cash register, verified for a settled gift card receipt.
#[derive(Debug, Clone)]
pub(crate) struct ReadyRegister {
    pub device_id: String,
    pub config_fingerprint: String,
    pub voucher_code: u8,
    pub tax_rates: Vec<TaxRateConfig>,
    pub operator_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum RegisterGate {
    /// No enabled cash register: this module issues no register receipt.
    NoRegister,
    Ready(ReadyRegister),
    Refused {
        status: &'static str,
        code: &'static str,
        message: String,
    },
}

fn refused(status: &'static str, code: &'static str, message: impl Into<String>) -> RegisterGate {
    RegisterGate::Refused {
        status,
        code,
        message: message.into(),
    }
}

fn register_receipt_config(device: Option<&Value>) -> (Vec<TaxRateConfig>, Option<String>) {
    let tax_rates = device
        .and_then(|device| device.get("taxRates"))
        .cloned()
        .and_then(|rates| serde_json::from_value::<Vec<TaxRateConfig>>(rates).ok())
        .unwrap_or_default();
    let operator_id = device
        .and_then(|device| device.get("operatorId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    (tax_rates, operator_id)
}

/// Verify the enabled default cash register real checkout prints on (the same
/// selection as `ecr_fiscal_print`): a register-printed CAP Driver, a voucher
/// number read from the exact settings the adapter consumes, a connected
/// handle whose consumed configuration still matches the stored row, and live
/// cash and card codes distinct from the voucher.
pub(crate) fn evaluate_register_gate(
    conn: &Connection,
    access: &dyn RegisterAccess,
) -> RegisterGate {
    let device = match db::ecr_try_get_default_device(conn, Some("cash_register")) {
        Ok(Some(device)) => device,
        Ok(None) => return RegisterGate::NoRegister,
        Err(error) => {
            return refused(
                "unavailable",
                "GIFT_CARD_FISCAL_REGISTER_UNAVAILABLE",
                format!("The cash register settings could not be read: {error}"),
            )
        }
    };
    let Some(device_id) = device.get("id").and_then(Value::as_str).map(str::to_string) else {
        return refused(
            "unavailable",
            "GIFT_CARD_FISCAL_REGISTER_UNAVAILABLE",
            "The default cash register has no id",
        );
    };
    let print_mode = device
        .get("printMode")
        .and_then(Value::as_str)
        .unwrap_or("register_prints");
    if print_mode != "register_prints" {
        return refused(
            "unsupported",
            "GIFT_CARD_FISCAL_TENDER_UNSUPPORTED",
            "Gift card receipts need a cash register that prints its own fiscal receipt",
        );
    }
    // The same defaults as `ecr_connect_device`, so the fingerprint compares
    // exactly what the connected handle loaded.
    let connection_type = device
        .get("connectionType")
        .and_then(Value::as_str)
        .unwrap_or("serial_usb");
    let connection_details = device
        .get("connectionDetails")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let protocol = device
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or("generic");
    let settings = device.get("settings").cloned().unwrap_or_else(|| json!({}));
    if protocol != CAP_PROTOCOL {
        return refused(
            "unsupported",
            "GIFT_CARD_FISCAL_TENDER_UNSUPPORTED",
            "Gift card receipts are verified only on CAP Driver cash registers",
        );
    }
    let voucher_code = match cap_driver::settled_gift_voucher_code(&settings) {
        Ok(code) => code,
        Err(message) => {
            return refused(
                "unsupported",
                "GIFT_CARD_FISCAL_VOUCHER_NOT_CONFIGURED",
                message,
            )
        }
    };
    let expected = DeviceManager::config_fingerprint_for(
        connection_type,
        &connection_details,
        protocol,
        &settings,
    );
    match access.consumed_config_fingerprint(&device_id) {
        Ok(Some(consumed)) if consumed == expected => {}
        Ok(Some(_)) => {
            return refused(
                "unavailable",
                "GIFT_CARD_FISCAL_REGISTER_CONFIG_CHANGED",
                "The cash register settings changed after it connected; reconnect it before accepting gift cards",
            )
        }
        Ok(None) => {
            return refused(
                "unavailable",
                "GIFT_CARD_FISCAL_REGISTER_DISCONNECTED",
                "Connect the fiscal cash register before accepting gift cards",
            )
        }
        Err(error) => return refused("unavailable", "GIFT_CARD_FISCAL_REGISTER_BUSY", error),
    }
    let codes = match access.gift_tender_codes(&device_id) {
        Ok(Some(codes)) => codes,
        Ok(None) => {
            return refused(
                "unsupported",
                "GIFT_CARD_FISCAL_TENDER_UNSUPPORTED",
                "The connected cash register has no verified gift card tender",
            )
        }
        Err(error) => return refused("unavailable", "GIFT_CARD_FISCAL_REGISTER_BUSY", error),
    };
    if codes.voucher != Some(voucher_code)
        || voucher_code == codes.cash
        || voucher_code == codes.card
    {
        return refused(
            "unsupported",
            "GIFT_CARD_FISCAL_VOUCHER_NOT_CONFIGURED",
            "The gift card voucher payment number must differ from the register's cash and card payment numbers",
        );
    }
    let (tax_rates, operator_id) = register_receipt_config(Some(&device));
    RegisterGate::Ready(ReadyRegister {
        device_id,
        config_fingerprint: expected,
        voucher_code,
        tax_rates,
        operator_id,
    })
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/// Refund-net whole cents of one completed payment row.
fn net_cents(payment: &Value) -> Option<i64> {
    let number = |key: &str| payment.get(key).and_then(Value::as_f64);
    let net = number("remainingRefundable")
        .or_else(|| Some(number("amount")? - number("refundedAmount").unwrap_or(0.0)))?;
    net.is_finite().then(|| (net * 100.0).round() as i64)
}

fn method_of(payment: &Value) -> String {
    payment
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn completed_rows(snapshot: &payments::OrderSettlementSnapshot) -> impl Iterator<Item = &Value> {
    snapshot
        .completed_payments
        .iter()
        .filter(|payment| payment.get("status").and_then(Value::as_str) == Some("completed"))
}

/// Older ordinary receipt evidence for the order, under any of its ids.
enum PriorReceipt {
    None,
    /// Checkout or `ecr_fiscal_print` already issued the order's receipt.
    Approved,
    /// An ordinary receipt that may still print; never released by age.
    Unresolved(String),
}

/// Receipts issued, or possibly issued, for the order by checkout,
/// `ecr_fiscal_print` or an outstanding-balance collection, under the local
/// id, the cloud id or the client request id. A pending, processing, timed-out
/// or unknown one, or an approved remainder receipt not yet recorded as a
/// payment, may still print or awaits its own ordinary reconciliation.
fn prior_ordinary_receipt(conn: &Connection, local_order_id: &str) -> Result<PriorReceipt, String> {
    let read = |error: rusqlite::Error| format!("read ordinary fiscal receipts: {error}");
    let mut stmt = conn
        .prepare(
            "SELECT transaction_ref FROM order_payments
             WHERE order_id = ?1 AND status = 'completed' AND transaction_ref IS NOT NULL",
        )
        .map_err(read)?;
    let recorded = stmt
        .query_map(params![local_order_id], |row| row.get::<_, String>(0))
        .map_err(read)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read)?;
    if recorded
        .iter()
        .any(|reference| reference.starts_with("fiscal-"))
    {
        return Ok(PriorReceipt::Approved);
    }
    let (cloud_id, client_request_id): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT supabase_id, client_request_id FROM orders WHERE id = ?1",
            params![local_order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(read)?
        .unwrap_or_default();
    let mut aliases = vec![local_order_id.to_string()];
    for alias in [cloud_id, client_request_id].into_iter().flatten() {
        let alias = alias.trim();
        if !alias.is_empty() && !aliases.iter().any(|known| known == alias) {
            aliases.push(alias.to_string());
        }
    }
    let mut unresolved = None;
    for alias in &aliases {
        if ecr_commands::find_approved_fiscal_transaction(conn, alias)?.is_some() {
            return Ok(PriorReceipt::Approved);
        }
        let outstanding = format!("{alias}:collect-outstanding:");
        let mut stmt = conn
            .prepare(
                "SELECT id, order_id, status FROM ecr_transactions
                 WHERE transaction_type = 'fiscal_receipt'
                   AND status IN ('pending', 'processing', 'timeout', 'unknown', 'approved')
                   AND (order_id = ?1 OR substr(order_id, 1, length(?2)) = ?2)",
            )
            .map_err(read)?;
        let receipts = stmt
            .query_map(params![alias, outstanding], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(read)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(read)?;
        for (id, order_id, status) in receipts {
            if recorded.contains(&id) || (status == "approved" && order_id == *alias) {
                return Ok(PriorReceipt::Approved);
            }
            unresolved.get_or_insert(format!("receipt {id} for {order_id} is {status}"));
        }
        let orphaned: Option<String> = conn
            .query_row(
                "SELECT setting_key FROM local_settings
                 WHERE setting_category = 'ecr_orphaned_receipts'
                   AND substr(setting_key, 1, length(?1)) = ?1
                 LIMIT 1",
                params![outstanding],
                |row| row.get(0),
            )
            .optional()
            .map_err(read)?;
        if let Some(key) = orphaned {
            unresolved.get_or_insert(format!("orphaned remainder receipt {key} is unreconciled"));
        }
    }
    Ok(unresolved.map_or(PriorReceipt::None, PriorReceipt::Unresolved))
}

/// An older ordinary receipt of the order may still print: nothing new is
/// debited or reserved until its own reconciliation resolves it.
fn prior_receipt_unresolved(detail: &str, local_order_id: &str) -> Value {
    with_fields(
        disposition(
            "pending",
            Some("GIFT_CARD_FISCAL_PRIOR_RECEIPT_UNRESOLVED"),
            Some(&format!(
                "An earlier receipt of this order has an unresolved outcome ({detail}); reconcile it first"
            )),
        ),
        vec![
            ("orderId", json!(local_order_id)),
            ("requiresReconciliation", json!(true)),
            ("requiresFinalize", json!(false)),
        ],
    )
}

/// The order's completed payments read strictly for the receipt. A row that
/// cannot be read is refused rather than dropped, and a payment in any other,
/// or no, currency is never printed as EUR; nothing is converted.
fn settled_tenders(
    conn: &Connection,
    local_order_id: &str,
) -> Result<Vec<payments::SettledFiscalTender>, Refused> {
    let tenders = payments::load_settled_fiscal_tenders(conn, local_order_id).map_err(|error| {
        (
            "unavailable",
            "GIFT_CARD_FISCAL_LEDGER_UNREADABLE",
            format!("A payment of this order could not be read for the receipt: {error}"),
        )
    })?;
    if let Some(tender) = tenders.iter().find(|tender| {
        !tender
            .currency
            .as_deref()
            .is_some_and(|currency| currency.trim().eq_ignore_ascii_case(RECEIPT_CURRENCY))
    }) {
        return Err((
            "unsupported",
            "GIFT_CARD_FISCAL_CURRENCY_UNSUPPORTED",
            format!(
                "Payment {} is recorded in '{}'; the fiscal cash register issues {RECEIPT_CURRENCY} receipts only",
                tender.id,
                tender.currency.as_deref().unwrap_or("no currency"),
            ),
        ));
    }
    Ok(tenders)
}

/// Whether the order carries a completed canonical gift card payment.
pub(crate) fn order_has_completed_gift_payment(
    conn: &Connection,
    local_order_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS (
             SELECT 1 FROM order_payments
             WHERE order_id = ?1 AND status = 'completed' AND method = 'gift_card'
         )",
        params![local_order_id],
        |row| row.get(0),
    )
    .map_err(|error| format!("read gift card payments: {error}"))
}

// ---------------------------------------------------------------------------
// Pre-debit capability
// ---------------------------------------------------------------------------

/// What native checkout checks before a fresh gift card debit: the live
/// register handle and the branch cloud route.
pub(crate) struct FreshDebitGate<'a> {
    pub access: &'a dyn RegisterAccess,
    pub cloud: CloudRoute,
}

/// Refuse, before any fresh debit, every settled receipt route already known to
/// be unsupported or unavailable, so no balance is taken that the register
/// could not fiscalise afterwards.
pub(crate) fn check_fresh_gift_debit(
    conn: &Connection,
    access: &dyn RegisterAccess,
    cloud: &CloudRoute,
    local_order_id: &str,
    currency: &str,
) -> Result<(), (&'static str, String)> {
    if let Some((_, code, message)) = cloud_refusal(cloud) {
        return Err((code, message));
    }
    crate::commands::ecr::direct_sale_admission(conn, local_order_id, None).map_err(|error| {
        (
            "GIFT_CARD_FISCAL_DIRECT_SALE_UNRESOLVED",
            format!(
                "An earlier direct card SALE needs reconciliation before a new gift debit: {error}"
            ),
        )
    })?;
    match live_operation(conn, local_order_id) {
        Ok(None) => {}
        Ok(Some(_)) => {
            return Err((
                "GIFT_CARD_FISCAL_ALREADY_STARTED",
                "This order's gift card fiscal receipt is already issued or in progress"
                    .to_string(),
            ))
        }
        Err(error) => return Err(("GIFT_CARD_LOCAL_STATE_UNAVAILABLE", error)),
    }
    match prior_ordinary_receipt(conn, local_order_id) {
        Ok(PriorReceipt::None) => {}
        // No new receipt follows: finalize replays the issued one.
        Ok(PriorReceipt::Approved) => return Ok(()),
        Ok(PriorReceipt::Unresolved(detail)) => {
            return Err((
                "GIFT_CARD_FISCAL_PRIOR_RECEIPT_UNRESOLVED",
                format!(
                    "An earlier receipt of this order has an unresolved outcome ({detail}); reconcile it before a gift card payment"
                ),
            ))
        }
        Err(error) => return Err(("GIFT_CARD_LOCAL_STATE_UNAVAILABLE", error)),
    }
    let ready = match evaluate_register_gate(conn, access) {
        RegisterGate::NoRegister => return Ok(()),
        RegisterGate::Refused { code, message, .. } => return Err((code, message)),
        RegisterGate::Ready(ready) => ready,
    };
    if !currency.trim().eq_ignore_ascii_case("EUR") {
        return Err((
            "GIFT_CARD_FISCAL_CURRENCY_UNSUPPORTED",
            "The fiscal cash register issues EUR receipts only".to_string(),
        ));
    }
    let tenders =
        settled_tenders(conn, local_order_id).map_err(|(_, code, message)| (code, message))?;
    for tender in &tenders {
        let method = tender.method.trim().to_ascii_lowercase();
        if tender.net_cents <= 0 || method == "cash" || method == "gift_card" {
            continue;
        }
        return Err(if method == "card" {
            (
                "GIFT_CARD_FISCAL_PRIOR_CARD_UNSUPPORTED",
                "This order already has an approved card payment; one fiscal receipt cannot carry it with a gift card"
                    .to_string(),
            )
        } else {
            (
                "GIFT_CARD_FISCAL_PRIOR_TENDER_UNSUPPORTED",
                format!("A {method} payment cannot share the fiscal receipt with a gift card"),
            )
        });
    }
    let order = ecr_commands::load_authoritative_outstanding_fiscal_order(conn, local_order_id)
        .map_err(|error| ("GIFT_CARD_LOCAL_STATE_UNAVAILABLE", error))?;
    let total = order
        .get("totalAmount")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    crate::ecr::fiscal::build_fiscal_data_for_settled_gift_checkout(
        &order,
        &[json!({ "method": "gift_card", "amount": total, "status": "completed" })],
        &ready.tax_rates,
        ready.operator_id.as_deref(),
        &crate::ecr::fiscal::FiscalLineContext::load(conn),
    )
    .map_err(|error| {
        (
            "GIFT_CARD_FISCAL_TAX_UNSUPPORTED",
            format!("The order cannot be printed on the fiscal register: {error}"),
        )
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Durable operations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Operation {
    operation_id: String,
    device_id: String,
    status: String,
    correlation: Value,
    order_fingerprint: String,
    payload_fingerprint: String,
    ledger_fingerprint: String,
}

fn live_operation(conn: &Connection, local_order_id: &str) -> Result<Option<Operation>, String> {
    conn.query_row(
        "SELECT operation_id, device_id, status, correlation, order_fingerprint,
                payload_fingerprint, ledger_fingerprint
         FROM gift_card_fiscal_operations
         WHERE local_order_id = ?1 AND status IN ('processing', 'unknown', 'approved')",
        params![local_order_id],
        |row| {
            let correlation: String = row.get(3)?;
            Ok(Operation {
                operation_id: row.get(0)?,
                device_id: row.get(1)?,
                status: row.get(2)?,
                correlation: serde_json::from_str(&correlation).unwrap_or(Value::Null),
                order_fingerprint: row.get(4)?,
                payload_fingerprint: row.get(5)?,
                ledger_fingerprint: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("read gift card fiscal operation: {error}"))
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

struct Fingerprints {
    order: String,
    payload: String,
    ledger: String,
    generation: String,
}

/// The order's settled receipt as stored now.
struct SettledReceipt {
    fiscal: FiscalReceiptData,
    amount_cents: i64,
    gift_cents: i64,
    cash_cents: i64,
    fingerprints: Fingerprints,
}

fn current_receipt(
    conn: &Connection,
    local_order_id: &str,
    tax_rates: &[TaxRateConfig],
    operator_id: Option<&str>,
) -> Result<SettledReceipt, Refused> {
    let local = |error: String| ("error", "GIFT_CARD_LOCAL_STATE_UNAVAILABLE", error);
    let snapshot = payments::load_order_settlement_snapshot(conn, local_order_id).map_err(local)?;
    // The receipt is built from the settlement snapshot, so every completed
    // payment must also read strictly, in EUR and with the same net once
    // refunds and voids are subtracted; otherwise it is refused, not printed.
    let tenders = settled_tenders(conn, local_order_id)?;
    let snapshot_rows: Vec<&Value> = completed_rows(&snapshot).collect();
    let missing = || {
        (
            "unavailable",
            "GIFT_CARD_FISCAL_LEDGER_UNREADABLE",
            "A completed payment of this order is missing from its settlement".to_string(),
        )
    };
    if snapshot_rows.len() != tenders.len() {
        return Err(missing());
    }
    for payment in snapshot_rows {
        let id = payment.get("id").and_then(Value::as_str);
        let Some(tender) = tenders.iter().find(|tender| Some(tender.id.as_str()) == id) else {
            return Err(missing());
        };
        if net_cents(payment) != Some(tender.net_cents) {
            return Err((
                "unsupported",
                "GIFT_CARD_FISCAL_ADJUSTMENT_UNSUPPORTED",
                format!(
                    "Payment {} has an adjustment the fiscal receipt cannot represent",
                    tender.id
                ),
            ));
        }
    }
    let gift_net: i64 = completed_rows(&snapshot)
        .filter(|payment| method_of(payment) == "gift_card")
        .map(|payment| net_cents(payment).unwrap_or(0).max(0))
        .sum();
    if gift_net <= 0 {
        return Err((
            "not_required",
            "GIFT_CARD_FISCAL_NO_GIFT_TENDER",
            "The order has no settled gift card tender".to_string(),
        ));
    }
    if (snapshot.outstanding_amount * 100.0).round() as i64 > 0 {
        return Err((
            "partial",
            "GIFT_CARD_FISCAL_PARTIAL_SETTLEMENT",
            "The order still has a balance; its final cash or card checkout issues the fiscal receipt"
                .to_string(),
        ));
    }
    let order = ecr_commands::load_authoritative_outstanding_fiscal_order(conn, local_order_id)
        .map_err(local)?;
    let fiscal = crate::ecr::fiscal::build_fiscal_data_for_settled_gift_checkout(
        &order,
        &snapshot.completed_payments,
        tax_rates,
        operator_id,
        &crate::ecr::fiscal::FiscalLineContext::load(conn),
    )
    .map_err(|error| ("unsupported", "GIFT_CARD_FISCAL_TENDER_UNSUPPORTED", error))?;
    let fingerprint =
        |digest: Result<[u8; 32], String>| digest.map(|bytes| hex(&bytes)).map_err(local);
    let fingerprints = Fingerprints {
        order: fingerprint(ecr_commands::outstanding_fiscal_payload_fingerprint(&order))?,
        payload: fingerprint(ecr_commands::fiscal_receipt_data_fingerprint(&fiscal))?,
        ledger: fingerprint(ecr_commands::completed_payment_fingerprint(
            &snapshot.completed_payments,
        ))?,
        generation: payments::settlement_generation_token(&snapshot.ledger_generation),
    };
    let amount_cents: i64 = fiscal.payments.iter().map(|payment| payment.amount).sum();
    let gift_cents: i64 = fiscal
        .payments
        .iter()
        .filter(|payment| payment.method == "gift_card")
        .map(|payment| payment.amount)
        .sum();
    Ok(SettledReceipt {
        cash_cents: amount_cents - gift_cents,
        fiscal,
        amount_cents,
        gift_cents,
        fingerprints,
    })
}

// ---------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------

/// Fiscal disposition, always separate from any financial success. A printed
/// CAP receipt is not a certified fiscal acceptance and carries no fiscal
/// receipt number from the adapter.
fn disposition(status: &str, code: Option<&str>, message: Option<&str>) -> Value {
    json!({
        "status": status,
        "code": code,
        "error": message,
        "certified": false,
        "fiscalReceiptNumber": Value::Null,
    })
}

fn with_fields(mut value: Value, fields: Vec<(&str, Value)>) -> Value {
    for (key, field) in fields {
        value[key] = field;
    }
    value
}

fn refusal_disposition((status, code, message): Refused, local_order_id: &str) -> Value {
    with_fields(
        disposition(status, Some(code), Some(&message)),
        vec![("orderId", json!(local_order_id))],
    )
}

fn operation_disposition(operation: &Operation, local_order_id: &str) -> Value {
    let approved = operation.status == "approved";
    let base = if approved {
        disposition("approved", None, None)
    } else {
        disposition(
            "pending",
            Some("GIFT_CARD_FISCAL_RECONCILIATION_REQUIRED"),
            Some("The gift card fiscal receipt outcome is not proven yet; reconcile it before any other receipt"),
        )
    };
    with_fields(
        base,
        vec![
            ("orderId", json!(local_order_id)),
            ("operationId", json!(operation.operation_id)),
            ("alreadyIssued", json!(approved)),
            ("requiresReconciliation", json!(!approved)),
        ],
    )
}

/// Fiscal state of an order after a gift card redemption. Read-only: it never
/// dispatches, so it is safe inside the redemption result.
pub(crate) fn fiscal_disposition_for_order(conn: &Connection, local_order_id: &str) -> Value {
    let unavailable = |error: String| {
        refusal_disposition(
            ("unavailable", "GIFT_CARD_LOCAL_STATE_UNAVAILABLE", error),
            local_order_id,
        )
    };
    match live_operation(conn, local_order_id) {
        Ok(Some(operation)) => return operation_disposition(&operation, local_order_id),
        Ok(None) => {}
        Err(error) => return unavailable(error),
    }
    match prior_ordinary_receipt(conn, local_order_id) {
        Ok(PriorReceipt::Approved) => {
            return with_fields(
                disposition(
                    "not_required",
                    Some("GIFT_CARD_FISCAL_ALREADY_ISSUED"),
                    None,
                ),
                vec![
                    ("orderId", json!(local_order_id)),
                    ("alreadyIssued", json!(true)),
                ],
            )
        }
        Ok(PriorReceipt::Unresolved(detail)) => {
            return prior_receipt_unresolved(&detail, local_order_id)
        }
        Ok(PriorReceipt::None) => {}
        Err(error) => return unavailable(error),
    }
    match db::ecr_try_get_default_device(conn, Some("cash_register")) {
        Ok(Some(_)) => {}
        Ok(None) => {
            return with_fields(
                disposition("not_required", None, None),
                vec![
                    ("orderId", json!(local_order_id)),
                    ("requiresFinalize", json!(false)),
                ],
            )
        }
        Err(error) => return unavailable(format!("read cash register settings: {error}")),
    }
    match payments::load_order_settlement_snapshot(conn, local_order_id) {
        Ok(balance) if (balance.outstanding_amount * 100.0).round() as i64 > 0 => with_fields(
            disposition(
                "partial",
                Some("GIFT_CARD_FISCAL_PARTIAL_SETTLEMENT"),
                Some("The final cash or card checkout issues the fiscal receipt"),
            ),
            vec![
                ("orderId", json!(local_order_id)),
                ("requiresFinalize", json!(false)),
            ],
        ),
        Ok(_) => with_fields(
            disposition("ready", None, None),
            vec![
                ("orderId", json!(local_order_id)),
                ("requiresFinalize", json!(true)),
            ],
        ),
        Err(error) => unavailable(error),
    }
}

/// `ecr_fiscal_print` guard: an issued settled receipt is never printed again
/// and an unresolved one blocks every other receipt of the order.
pub(crate) fn settled_gift_print_guard(
    conn: &Connection,
    local_order_id: &str,
) -> Result<Option<Value>, String> {
    match live_operation(conn, local_order_id)? {
        None => Ok(None),
        Some(operation) if operation.status == "approved" => Ok(Some(json!({
            "success": true,
            "skipped": true,
            "alreadyIssued": true,
            "giftFiscalOperationId": operation.operation_id,
        }))),
        Some(_) => Err(
            "GIFT_CARD_FISCAL_RECONCILIATION_REQUIRED: this order's gift card fiscal receipt has an unresolved outcome; reconcile it before printing"
                .to_string(),
        ),
    }
}

/// Readiness of the settled gift card receipt route, optionally for an order.
pub(crate) fn readiness(
    conn: &Connection,
    access: &dyn RegisterAccess,
    cloud: &CloudRoute,
    local_order_id: Option<&str>,
) -> Value {
    let mut value = match cloud_refusal(cloud) {
        Some((status, code, message)) => disposition(status, Some(code), Some(&message)),
        None => match evaluate_register_gate(conn, access) {
            RegisterGate::NoRegister => disposition("not_required", None, None),
            RegisterGate::Refused {
                status,
                code,
                message,
            } => disposition(status, Some(code), Some(&message)),
            RegisterGate::Ready(ready) => with_fields(
                disposition("ready", None, None),
                vec![(
                    "register",
                    json!({
                        "deviceId": ready.device_id,
                        "protocol": CAP_PROTOCOL,
                        "voucherPaymentCode": ready.voucher_code,
                    }),
                )],
            ),
        },
    };
    value["cloudRoute"] = json!(cloud.label());
    if let Some(order_id) = local_order_id {
        value["orderId"] = json!(order_id);
        if matches!(value["status"].as_str(), Some("ready" | "not_required")) {
            if let Err((code, message)) =
                check_fresh_gift_debit(conn, access, cloud, order_id, RECEIPT_CURRENCY)
            {
                let status = if code == "GIFT_CARD_FISCAL_PRIOR_RECEIPT_UNRESOLVED" {
                    "pending"
                } else if code.contains("UNAVAILABLE") || code.contains("UNREADABLE") {
                    "unavailable"
                } else {
                    "unsupported"
                };
                value["status"] = json!(status);
                value["code"] = json!(code);
                value["error"] = json!(message);
            }
        }
        value["order"] = fiscal_disposition_for_order(conn, order_id);
    }
    value
}

// ---------------------------------------------------------------------------
// Finalize and reconcile
// ---------------------------------------------------------------------------

enum Plan {
    Done(Value),
    Resume(Operation),
    Dispatch {
        operation: Operation,
        request: TransactionRequest,
    },
}

fn lock(db: &db::DbState) -> Result<MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|error| error.to_string())
}

fn immediate<T>(
    conn: &Connection,
    work: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| format!("begin gift card fiscal transaction: {error}"))?;
    match work(conn) {
        Ok(value) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(value),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(format!("commit gift card fiscal transaction: {error}"))
            }
        },
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// An issued receipt is reported again only while its order, ledger and
/// payload are unchanged; anything else is stale and never printed again.
fn verify_issued(conn: &Connection, operation: &Operation, local_order_id: &str) -> Value {
    let device = db::ecr_get_device(conn, &operation.device_id);
    let (tax_rates, operator_id) = register_receipt_config(device.as_ref());
    let unchanged = current_receipt(conn, local_order_id, &tax_rates, operator_id.as_deref())
        .map(|receipt| {
            receipt.fingerprints.order == operation.order_fingerprint
                && receipt.fingerprints.ledger == operation.ledger_fingerprint
                && (device.is_none()
                    || receipt.fingerprints.payload == operation.payload_fingerprint)
        })
        .unwrap_or(false);
    let base = if unchanged {
        disposition("approved", None, None)
    } else {
        disposition(
            "error",
            Some("GIFT_CARD_FISCAL_RECEIPT_STALE"),
            Some("The order or its payments changed after its gift card fiscal receipt was issued; no second receipt is printed"),
        )
    };
    with_fields(
        base,
        vec![
            ("orderId", json!(local_order_id)),
            ("operationId", json!(operation.operation_id)),
            ("alreadyIssued", json!(true)),
        ],
    )
}

fn plan_finalize(
    conn: &Connection,
    access: &dyn RegisterAccess,
    route: Option<&CloudRoute>,
    local_order_id: &str,
) -> Result<Plan, String> {
    if let Some(operation) = live_operation(conn, local_order_id)? {
        if operation.status == "approved" {
            return Ok(Plan::Done(verify_issued(conn, &operation, local_order_id)));
        }
        return Ok(Plan::Resume(operation));
    }
    match prior_ordinary_receipt(conn, local_order_id)? {
        PriorReceipt::None => {}
        PriorReceipt::Approved => {
            return Ok(Plan::Done(with_fields(
                disposition(
                    "not_required",
                    Some("GIFT_CARD_FISCAL_ALREADY_ISSUED"),
                    Some("A fiscal receipt was already issued for this order"),
                ),
                vec![
                    ("orderId", json!(local_order_id)),
                    ("alreadyIssued", json!(true)),
                ],
            )))
        }
        PriorReceipt::Unresolved(detail) => {
            return Ok(Plan::Done(prior_receipt_unresolved(
                &detail,
                local_order_id,
            )))
        }
    }
    let ready = match evaluate_register_gate(conn, access) {
        RegisterGate::NoRegister => {
            return Ok(Plan::Done(with_fields(
                disposition("not_required", None, None),
                vec![("orderId", json!(local_order_id))],
            )))
        }
        RegisterGate::Refused {
            status,
            code,
            message,
        } => {
            return Ok(Plan::Done(refusal_disposition(
                (status, code, message),
                local_order_id,
            )))
        }
        RegisterGate::Ready(ready) => ready,
    };
    // New work only on a route read for this finalize that allows it; an
    // existing receipt was already resolved above without one.
    let unread =
        CloudRoute::Unavailable("The fiscal route was not read for this receipt".to_string());
    if let Some(refusal) = cloud_refusal(route.unwrap_or(&unread)) {
        return Ok(Plan::Done(refusal_disposition(refusal, local_order_id)));
    }
    let receipt = match current_receipt(
        conn,
        local_order_id,
        &ready.tax_rates,
        ready.operator_id.as_deref(),
    ) {
        Ok(receipt) => receipt,
        Err(refusal) => return Ok(Plan::Done(refusal_disposition(refusal, local_order_id))),
    };
    let Some(scope) = crate::commands::gift_cards::resolve_trusted_scope(conn) else {
        return Ok(Plan::Done(refusal_disposition(
            (
                "unavailable",
                "GIFT_CARD_TERMINAL_SCOPE_UNAVAILABLE",
                "This terminal is not paired with an organization, branch and terminal id"
                    .to_string(),
            ),
            local_order_id,
        )));
    };
    let operation_id = format!("gift-fiscal-{}", uuid::Uuid::new_v4().simple());
    let correlation = match access.dispatch_correlation(&ready.device_id, &operation_id) {
        Ok(correlation) => correlation,
        Err(error) => {
            return Ok(Plan::Done(refusal_disposition(
                (
                    "unavailable",
                    "GIFT_CARD_FISCAL_CORRELATION_UNAVAILABLE",
                    error,
                ),
                local_order_id,
            )))
        }
    };
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO gift_card_fiscal_operations (
             operation_id, organization_id, branch_id, terminal_id, local_order_id, device_id,
             protocol, config_fingerprint, order_fingerprint, payload_fingerprint,
             ledger_fingerprint, ledger_generation, currency, amount_cents, gift_cents,
             cash_cents, correlation, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'EUR', ?13, ?14, ?15, ?16,
             'processing', ?17, ?17)",
        params![
            operation_id,
            scope.organization_id,
            scope.branch_id,
            scope.terminal_id,
            local_order_id,
            ready.device_id,
            CAP_PROTOCOL,
            ready.config_fingerprint,
            receipt.fingerprints.order,
            receipt.fingerprints.payload,
            receipt.fingerprints.ledger,
            receipt.fingerprints.generation,
            receipt.amount_cents,
            receipt.gift_cents,
            receipt.cash_cents,
            correlation.to_string(),
            now,
        ],
    )
    .map_err(|error| format!("reserve gift card fiscal receipt: {error}"))?;
    let operation = Operation {
        operation_id: operation_id.clone(),
        device_id: ready.device_id,
        status: "processing".to_string(),
        correlation,
        order_fingerprint: receipt.fingerprints.order,
        payload_fingerprint: receipt.fingerprints.payload,
        ledger_fingerprint: receipt.fingerprints.ledger,
    };
    let request = TransactionRequest {
        transaction_id: operation_id,
        transaction_type: TransactionType::FiscalReceipt,
        amount: receipt.amount_cents,
        currency: RECEIPT_CURRENCY.to_string(),
        order_id: Some(local_order_id.to_string()),
        tip_amount: None,
        original_transaction_id: None,
        fiscal_data: Some(receipt.fiscal),
    };
    Ok(Plan::Dispatch { operation, request })
}

/// Reserve a new receipt, or find the one to recover, inside one durable
/// IMMEDIATE transaction. Nothing is dispatched unless the reservation is
/// committed first.
fn reserve_or_resume(
    db: &db::DbState,
    access: &dyn RegisterAccess,
    route: Option<&CloudRoute>,
    local_order_id: &str,
) -> Result<Plan, String> {
    let conn = lock(db)?;
    db::with_full_sync(&conn, |conn| {
        immediate(conn, |conn| {
            plan_finalize(conn, access, route, local_order_id)
        })
    })
}

struct Outcome {
    status: &'static str,
    code: Option<&'static str>,
    message: Option<String>,
    evidence: Value,
}

fn unknown_outcome(reason: String, evidence: Value) -> Outcome {
    Outcome {
        status: "unknown",
        code: Some("GIFT_CARD_FISCAL_OUTCOME_UNKNOWN"),
        message: Some(reason),
        evidence,
    }
}

/// `before_publication` is true only when the adapter proved it refused
/// before publishing its command file; then no trace at all proves nothing
/// was sent. A manager, join or panic error proves nothing, so no trace after
/// one stays unknown.
fn outcome_from_probe(probe: SettledProbe, before_publication: bool) -> Outcome {
    match probe {
        SettledProbe::Approved { output } => Outcome {
            status: "approved",
            code: None,
            message: None,
            evidence: json!({ "source": "probe", "output": output }),
        },
        SettledProbe::Failed { message } => Outcome {
            status: "failed",
            code: Some("GIFT_CARD_FISCAL_REGISTER_ERROR"),
            evidence: json!({ "source": "probe", "error": message }),
            message: Some(message),
        },
        SettledProbe::NoTrace if before_publication => Outcome {
            status: "failed",
            code: Some("GIFT_CARD_FISCAL_NOT_SUBMITTED"),
            message: Some("The receipt was not sent to the register".to_string()),
            evidence: json!({ "source": "probe", "trace": "none" }),
        },
        SettledProbe::NoTrace => unknown_outcome(
            "No register file or log line proves this receipt either way".to_string(),
            json!({ "source": "probe", "trace": "none" }),
        ),
        SettledProbe::Pending => unknown_outcome(
            "The register has not picked up the receipt yet".to_string(),
            json!({ "source": "probe", "trace": "pending" }),
        ),
        SettledProbe::Unknown { reason } => {
            unknown_outcome(reason, json!({ "source": "probe", "trace": "unknown" }))
        }
    }
}

fn outcome_from_response(response: &TransactionResponse) -> Outcome {
    let raw = response.raw_response.clone().unwrap_or(Value::Null);
    let reconcile = raw
        .get("requiresReconciliation")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let consumed = raw
        .get("commandConsumed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // Only an error tied to this command's own Output file or log lines is a
    // definite register refusal; one elsewhere in the shared log is not.
    let correlated = raw
        .get("errorCorrelated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let evidence = json!({
        "source": "dispatch",
        "status": response.status,
        "errorCode": response.error_code,
        "terminalReference": response.terminal_reference,
        "raw": raw,
    });
    if response.status == TransactionStatus::Approved && !reconcile {
        return Outcome {
            status: "approved",
            code: None,
            message: None,
            evidence,
        };
    }
    if response.status == TransactionStatus::Error && consumed && correlated && !reconcile {
        return Outcome {
            status: "failed",
            code: Some("GIFT_CARD_FISCAL_REGISTER_ERROR"),
            message: response.error_message.clone(),
            evidence,
        };
    }
    unknown_outcome(
        response
            .error_message
            .clone()
            .unwrap_or_else(|| "The register did not confirm the receipt".to_string()),
        evidence,
    )
}

fn store_outcome(conn: &Connection, operation_id: &str, outcome: &Outcome) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let changed = conn
        .execute(
            "UPDATE gift_card_fiscal_operations
             SET status = ?2, evidence = ?3, error_code = ?4, error_message = ?5, updated_at = ?6,
                 acknowledged_at = CASE WHEN ?2 = 'approved' THEN ?6 ELSE acknowledged_at END
             WHERE operation_id = ?1 AND status IN ('processing', 'unknown')",
            params![
                operation_id,
                outcome.status,
                outcome.evidence.to_string(),
                outcome.code,
                outcome.message,
                now,
            ],
        )
        .map_err(|error| format!("persist gift card fiscal outcome: {error}"))?;
    if changed == 1 {
        Ok(())
    } else {
        Err("The gift card fiscal receipt was already resolved elsewhere".to_string())
    }
}

fn persist_outcome(
    db: &db::DbState,
    operation: &Operation,
    outcome: Outcome,
    local_order_id: &str,
) -> Value {
    let stored = lock(db).and_then(|conn| {
        db::with_full_sync(&conn, |conn| {
            store_outcome(conn, &operation.operation_id, &outcome)
        })
    });
    let mut fields = vec![
        ("orderId", json!(local_order_id)),
        ("operationId", json!(operation.operation_id)),
    ];
    if let Err(error) = stored {
        // The row stays reserved: a later finalize or reconcile only probes.
        fields.push(("observedStatus", json!(outcome.status)));
        fields.push(("requiresReconciliation", json!(true)));
        return with_fields(
            disposition(
                "pending",
                Some("GIFT_CARD_FISCAL_ACK_PERSIST_FAILED"),
                Some(&error),
            ),
            fields,
        );
    }
    match outcome.status {
        "approved" => {
            fields.push(("alreadyIssued", json!(false)));
            with_fields(disposition("approved", None, None), fields)
        }
        "failed" => {
            fields.push(("retryable", json!(true)));
            with_fields(
                disposition("error", outcome.code, outcome.message.as_deref()),
                fields,
            )
        }
        _ => {
            fields.push(("requiresReconciliation", json!(true)));
            with_fields(
                disposition(
                    "pending",
                    Some("GIFT_CARD_FISCAL_RECONCILIATION_REQUIRED"),
                    outcome.message.as_deref(),
                ),
                fields,
            )
        }
    }
}

/// Issue, or recover, the one fiscal receipt of a settled gift card order.
async fn finalize_with<D, F>(
    db: &db::DbState,
    access: &dyn RegisterAccess,
    route: Option<&CloudRoute>,
    local_order_id: &str,
    dispatch: D,
    probe: fn(&Value) -> SettledProbe,
) -> Value
where
    D: FnOnce(String, TransactionRequest) -> F,
    F: Future<Output = Result<SettledDispatch, String>>,
{
    let plan = match reserve_or_resume(db, access, route, local_order_id) {
        Ok(plan) => plan,
        Err(error) => {
            return refusal_disposition(
                ("error", "GIFT_CARD_FISCAL_RESERVE_FAILED", error),
                local_order_id,
            )
        }
    };
    let (operation, outcome) = match plan {
        Plan::Done(value) => return value,
        // Never re-sent: its command may already be printing.
        Plan::Resume(operation) => {
            let outcome = outcome_from_probe(probe(&operation.correlation), false);
            (operation, outcome)
        }
        Plan::Dispatch { operation, request } => {
            let outcome = match dispatch(operation.device_id.clone(), request).await {
                Ok(SettledDispatch::Completed(response)) => outcome_from_response(&response),
                // Only the adapter's proof that nothing was published lets an
                // untraced receipt fail cleanly and be tried afresh.
                Ok(SettledDispatch::NotPublished(error)) => {
                    let mut outcome = outcome_from_probe(probe(&operation.correlation), true);
                    outcome.message = Some(error);
                    outcome
                }
                // A manager, join or panic error proves nothing: the receipt
                // stays with its operation, payload and correlation.
                Err(error) => {
                    let mut outcome = outcome_from_probe(probe(&operation.correlation), false);
                    outcome.evidence["dispatchError"] = json!(error);
                    outcome
                }
            };
            (operation, outcome)
        }
    };
    persist_outcome(db, &operation, outcome, local_order_id)
}

/// Resolve an unproven settled receipt from its files only.
fn reconcile_with(
    db: &db::DbState,
    local_order_id: &str,
    probe: fn(&Value) -> SettledProbe,
) -> Value {
    let unavailable = |error: String| {
        refusal_disposition(
            ("unavailable", "GIFT_CARD_LOCAL_STATE_UNAVAILABLE", error),
            local_order_id,
        )
    };
    let operation = match lock(db).and_then(|conn| live_operation(&conn, local_order_id)) {
        Ok(operation) => operation,
        Err(error) => return unavailable(error),
    };
    match operation {
        Some(operation) if operation.status != "approved" => {
            let outcome = outcome_from_probe(probe(&operation.correlation), false);
            persist_outcome(db, &operation, outcome, local_order_id)
        }
        operation => match lock(db) {
            Ok(conn) => match operation {
                Some(operation) => verify_issued(&conn, &operation, local_order_id),
                None => fiscal_disposition_for_order(&conn, local_order_id),
            },
            Err(error) => unavailable(error),
        },
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn command_result(mut value: Value) -> Value {
    let success = matches!(value["status"].as_str(), Some("approved" | "not_required"));
    value["success"] = json!(success);
    value
}

fn order_ref(arg0: &Option<Value>) -> Option<String> {
    let payload = arg0.as_ref()?;
    ["orderId", "order_id"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Resolve the order and take the per-order payment reservation shared with
/// every payment collection.
fn resolve_order(db: &db::DbState, arg0: &Option<Value>) -> Result<Result<String, Value>, String> {
    let Some(reference) = order_ref(arg0) else {
        return Ok(Err(command_result(disposition(
            "error",
            Some("GIFT_CARD_ORDER_REQUIRED"),
            Some("An order is required"),
        ))));
    };
    let resolved = {
        let conn = lock(db)?;
        crate::resolve_order_id(&conn, &reference)
    };
    Ok(resolved.ok_or_else(|| {
        command_result(disposition(
            "error",
            Some("GIFT_CARD_ORDER_NOT_FOUND"),
            Some("Order not found on this terminal"),
        ))
    }))
}

/// Readiness of the settled gift card receipt route. Payload: `{ orderId? }`.
/// Read-only: nothing is printed and no state changes.
#[tauri::command]
pub async fn gift_card_fiscal_readiness(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, DeviceManager>,
) -> Result<Value, String> {
    crate::hydrate_terminal_credentials_from_local_settings(&db);
    let local_order_id = match order_ref(&arg0) {
        None => None,
        Some(_) => match resolve_order(&db, &arg0)? {
            Ok(local_order_id) => Some(local_order_id),
            Err(refusal) => return Ok(refusal),
        },
    };
    let cloud = fetch_cloud_route(&db).await;
    let value = {
        let conn = lock(&db)?;
        readiness(&conn, &*mgr, &cloud, local_order_id.as_deref())
    };
    Ok(command_result(value))
}

/// Issue the one fiscal receipt of an order already settled by gift card (and
/// any cash). Payload: `{ orderId }`. Collects nothing and adds no payment; an
/// earlier unproven receipt of the order is only probed, never sent again.
#[tauri::command]
pub async fn gift_card_fiscal_finalize(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, DeviceManager>,
) -> Result<Value, String> {
    let local_order_id = match resolve_order(&db, &arg0)? {
        Ok(local_order_id) => local_order_id,
        Err(refusal) => return Ok(refusal),
    };
    let _reservation = match crate::commands::payments::reserve_payment_record(&local_order_id) {
        Ok(reservation) => reservation,
        Err(error) => {
            return Ok(command_result(refusal_disposition(
                ("unavailable", "GIFT_CARD_ORDER_BUSY", error),
                &local_order_id,
            )))
        }
    };
    // An existing receipt is only resolved from its own files; the fiscal
    // route is read, and must allow printing, only before new work.
    let route = match lock(&db).and_then(|conn| live_operation(&conn, &local_order_id)) {
        Ok(Some(_)) => None,
        Ok(None) => {
            crate::hydrate_terminal_credentials_from_local_settings(&db);
            Some(fetch_cloud_route(&db).await)
        }
        Err(error) => {
            return Ok(command_result(refusal_disposition(
                ("unavailable", "GIFT_CARD_LOCAL_STATE_UNAVAILABLE", error),
                &local_order_id,
            )))
        }
    };
    let manager: &DeviceManager = &mgr;
    let value = finalize_with(
        &db,
        manager,
        route.as_ref(),
        &local_order_id,
        move |device_id: String, request: TransactionRequest| async move {
            manager
                .process_settled_receipt_offloaded(&device_id, request)
                .await
        },
        cap_driver::probe_settled_receipt,
    )
    .await;
    Ok(command_result(value))
}

/// Resolve an unproven settled gift card receipt from its register files only.
/// Payload: `{ orderId }`. Never prints, resubmits or sends a status command.
#[tauri::command]
pub async fn gift_card_fiscal_reconcile(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let local_order_id = match resolve_order(&db, &arg0)? {
        Ok(local_order_id) => local_order_id,
        Err(refusal) => return Ok(refusal),
    };
    let _reservation = match crate::commands::payments::reserve_payment_record(&local_order_id) {
        Ok(reservation) => reservation,
        Err(error) => {
            return Ok(command_result(refusal_disposition(
                ("unavailable", "GIFT_CARD_ORDER_BUSY", error),
                &local_order_id,
            )))
        }
    };
    Ok(command_result(reconcile_with(
        &db,
        &local_order_id,
        cap_driver::probe_settled_receipt,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const ORDER: &str = "order-gift-1";
    const DEVICE: &str = "register-1";

    struct FakeRegister {
        fingerprint: Option<String>,
        codes: Option<GiftTenderCodes>,
    }

    impl FakeRegister {
        /// A handle connected with exactly the stored row's configuration.
        fn connected(settings: &Value) -> Self {
            Self {
                fingerprint: Some(DeviceManager::config_fingerprint_for(
                    "network",
                    &json!({}),
                    CAP_PROTOCOL,
                    settings,
                )),
                codes: Some(GiftTenderCodes {
                    cash: 1,
                    card: 2,
                    voucher: cap_driver::gift_voucher_payment_code(settings)
                        .ok()
                        .flatten(),
                }),
            }
        }
    }

    impl RegisterAccess for FakeRegister {
        fn consumed_config_fingerprint(&self, _: &str) -> Result<Option<String>, String> {
            Ok(self.fingerprint.clone())
        }

        fn gift_tender_codes(&self, _: &str) -> Result<Option<GiftTenderCodes>, String> {
            Ok(self.codes)
        }

        fn dispatch_correlation(&self, _: &str, transaction_id: &str) -> Result<Value, String> {
            Ok(
                json!({ "adapter": "fake", "commandFile": format!("pos-tauri-{transaction_id}.txt") }),
            )
        }
    }

    fn voucher() -> Value {
        json!({ "voucherPaymentCode": 7 })
    }

    fn migrated(conn: Connection) -> Connection {
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
            .unwrap();
        db::run_migrations_for_test(&conn);
        for (key, value) in [
            ("organization_id", "org-1"),
            ("branch_id", "branch-1"),
            ("terminal_id", "terminal-1"),
        ] {
            db::set_setting(&conn, "terminal", key, value).unwrap();
        }
        conn
    }

    fn state(conn: Connection) -> db::DbState {
        db::DbState {
            conn: Mutex::new(conn),
            db_path: ":memory:".into(),
        }
    }

    fn seed_register(conn: &Connection, settings: &Value) {
        conn.execute(
            "INSERT INTO ecr_devices (
                 id, name, device_type, brand, protocol, connection_type, connection_details,
                 print_mode, tax_rates, is_default, enabled, settings
             ) VALUES (?1, 'CAP Cashier', 'cash_register', 'RBS', 'cap_driver', 'network', '{}',
                 'register_prints', ?2, 1, 1, ?3)",
            params![
                DEVICE,
                json!([{ "code": "A", "rate": 24.0, "label": "Standard", "department": 3 }])
                    .to_string(),
                settings.to_string(),
            ],
        )
        .unwrap();
        // The register acts only with its MyData plugin finished (founder
        // rule 08/10/2026).
        crate::device_admission::admit_for_test(conn, &[crate::device_admission::CASH_REGISTER]);
    }

    fn seed_order(conn: &Connection, total_cents: i64) {
        let items = json!([{
            "name": "Coffee",
            "quantity": 2,
            "price": total_cents as f64 / 200.0,
            "taxRate": 24
        }]);
        conn.execute(
            "INSERT INTO orders (
                 id, items, total_amount, total_amount_cents, status, order_type,
                 payment_status, sync_status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'completed', 'takeaway', 'pending', 'synced', ?5, ?5)",
            params![
                ORDER,
                items.to_string(),
                total_cents as f64 / 100.0,
                total_cents,
                "2026-09-29T10:00:00Z"
            ],
        )
        .unwrap();
    }

    fn insert_payment(
        conn: &Connection,
        id: &str,
        method: &str,
        cents: i64,
    ) -> rusqlite::Result<usize> {
        let reference = if method == "gift_card" {
            format!("gift_card:tx-{id}")
        } else {
            format!("ref-{id}")
        };
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status, transaction_ref,
                 created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6, ?7, ?7)",
            params![
                id,
                ORDER,
                method,
                cents as f64 / 100.0,
                cents,
                reference,
                "2026-09-29T10:01:00Z"
            ],
        )
    }

    fn settled(payments: &[(&str, &str, i64)]) -> db::DbState {
        let conn = migrated(Connection::open_in_memory().unwrap());
        seed_register(&conn, &voucher());
        seed_order(&conn, 2000);
        for (id, method, cents) in payments {
            insert_payment(&conn, id, method, *cents).unwrap();
        }
        state(conn)
    }

    #[derive(Default, Clone)]
    struct Dispatches(Arc<Mutex<Vec<TransactionRequest>>>);

    type Reply = std::future::Ready<Result<SettledDispatch, String>>;

    impl Dispatches {
        fn count(&self) -> usize {
            self.0.lock().unwrap().len()
        }

        fn tenders(&self, index: usize) -> Vec<(String, i64)> {
            self.0.lock().unwrap()[index]
                .fiscal_data
                .as_ref()
                .unwrap()
                .payments
                .iter()
                .map(|payment| (payment.method.clone(), payment.amount))
                .collect()
        }

        fn replying(
            &self,
            status: TransactionStatus,
            raw: Value,
        ) -> impl FnOnce(String, TransactionRequest) -> Reply {
            let log = self.0.clone();
            move |_device, request| {
                let reply = response(&request.transaction_id, status, raw);
                log.lock().unwrap().push(request);
                std::future::ready(Ok(SettledDispatch::Completed(reply)))
            }
        }

        fn failing(&self, error: &'static str) -> impl FnOnce(String, TransactionRequest) -> Reply {
            let log = self.0.clone();
            move |_device, request| {
                log.lock().unwrap().push(request);
                std::future::ready(Err(error.to_string()))
            }
        }

        /// The adapter proves it refused before publishing anything.
        fn refusing(
            &self,
            error: &'static str,
        ) -> impl FnOnce(String, TransactionRequest) -> Reply {
            let log = self.0.clone();
            move |_device, request| {
                log.lock().unwrap().push(request);
                std::future::ready(Ok(SettledDispatch::NotPublished(error.to_string())))
            }
        }
    }

    fn response(
        transaction_id: &str,
        status: TransactionStatus,
        raw: Value,
    ) -> TransactionResponse {
        TransactionResponse {
            transaction_id: transaction_id.to_string(),
            status,
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
            raw_response: Some(raw),
            started_at: String::new(),
            completed_at: String::new(),
        }
    }

    fn approved_raw() -> Value {
        json!({ "adapter": "cap_driver", "commandConsumed": true, "requiresReconciliation": false })
    }

    fn probe_never(_: &Value) -> SettledProbe {
        panic!("this path must not probe")
    }

    fn probe_approved(_: &Value) -> SettledProbe {
        SettledProbe::Approved {
            output: "OK".to_string(),
        }
    }

    fn probe_unknown(_: &Value) -> SettledProbe {
        SettledProbe::Unknown {
            reason: "no Output file".to_string(),
        }
    }

    fn probe_no_trace(_: &Value) -> SettledProbe {
        SettledProbe::NoTrace
    }

    fn count(state: &db::DbState, sql: &str) -> i64 {
        state
            .conn
            .lock()
            .unwrap()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn full_gift_issues_one_voucher_receipt_and_adds_no_payment() {
        let state = settled(&[("gift", "gift_card", 2000)]);
        let register = FakeRegister::connected(&voucher());
        let dispatches = Dispatches::default();
        let first = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_never,
        )
        .await;
        assert_eq!(first["status"], "approved", "{first}");
        assert_eq!(first["certified"], false);
        assert!(first["fiscalReceiptNumber"].is_null());
        assert_eq!(dispatches.count(), 1);
        assert_eq!(dispatches.tenders(0), vec![("gift_card".to_string(), 2000)]);
        {
            let log = dispatches.0.lock().unwrap();
            assert!(matches!(
                log[0].transaction_type,
                TransactionType::FiscalReceipt
            ));
            assert_eq!(log[0].amount, 2000);
            assert_eq!(log[0].currency, "EUR");
            assert!(log[0].transaction_id.starts_with("gift-fiscal-"));
            assert_eq!(first["operationId"], log[0].transaction_id.as_str());
        }
        assert_eq!(count(&state, "SELECT COUNT(*) FROM order_payments"), 1);
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM order_payments
                 WHERE method = 'gift_card' AND transaction_ref = 'gift_card:tx-gift'"
            ),
            1,
            "the canonical gift payment keeps its identity"
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM gift_card_fiscal_operations
                 WHERE status = 'approved' AND acknowledged_at IS NOT NULL
                   AND gift_cents = 2000 AND cash_cents = 0"
            ),
            1
        );

        let again = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_never,
        )
        .await;
        assert_eq!(again["status"], "approved", "{again}");
        assert_eq!(again["alreadyIssued"], true);
        assert_eq!(dispatches.count(), 1, "never a second receipt");
        let conn = state.conn.lock().unwrap();
        assert!(settled_gift_print_guard(&conn, ORDER).unwrap().is_some());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn gift_and_cash_balance_on_one_receipt_and_partial_is_refused() {
        let state = settled(&[("cash", "cash", 1000), ("gift", "gift_card", 1000)]);
        let register = FakeRegister::connected(&voucher());
        let dispatches = Dispatches::default();
        let result = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_never,
        )
        .await;
        assert_eq!(result["status"], "approved", "{result}");
        assert_eq!(
            dispatches.tenders(0),
            vec![("cash".to_string(), 1000), ("gift_card".to_string(), 1000)]
        );
        assert_eq!(count(&state, "SELECT COUNT(*) FROM order_payments"), 2);

        let partial = settled(&[("gift", "gift_card", 1000)]);
        let refused = finalize_with(
            &partial,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_never,
        )
        .await;
        assert_eq!(refused["status"], "partial", "{refused}");
        assert_eq!(refused["code"], "GIFT_CARD_FISCAL_PARTIAL_SETTLEMENT");
        assert_eq!(dispatches.count(), 1);
        assert_eq!(
            count(&partial, "SELECT COUNT(*) FROM gift_card_fiscal_operations"),
            0
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn durable_reservation_failure_prevents_dispatch() {
        let state = settled(&[("gift", "gift_card", 2000)]);
        state
            .conn
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TEMP TRIGGER fail_reserve BEFORE INSERT ON gift_card_fiscal_operations
                 BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
            )
            .unwrap();
        let dispatches = Dispatches::default();
        let result = finalize_with(
            &state,
            &FakeRegister::connected(&voucher()),
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_never,
        )
        .await;
        assert_eq!(
            result["code"], "GIFT_CARD_FISCAL_RESERVE_FAILED",
            "{result}"
        );
        assert_eq!(dispatches.count(), 0);
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM gift_card_fiscal_operations"),
            0
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn lost_acknowledgement_recovers_the_same_receipt_without_resending() {
        let state = settled(&[("gift", "gift_card", 2000)]);
        let register = FakeRegister::connected(&voucher());
        let dispatches = Dispatches::default();
        state
            .conn
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TEMP TRIGGER fail_ack BEFORE UPDATE ON gift_card_fiscal_operations
                 BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;",
            )
            .unwrap();
        let first = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_never,
        )
        .await;
        assert_eq!(first["status"], "pending", "{first}");
        assert_eq!(first["code"], "GIFT_CARD_FISCAL_ACK_PERSIST_FAILED");
        assert_eq!(first["observedStatus"], "approved");
        state
            .conn
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER temp.fail_ack;")
            .unwrap();

        // A restart finds the reservation and only reads the register files.
        let resumed = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_approved,
        )
        .await;
        assert_eq!(resumed["status"], "approved", "{resumed}");
        assert_eq!(resumed["operationId"], first["operationId"]);
        assert_eq!(dispatches.count(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unknown_timeout_is_probed_only_and_locks_ledger_order_and_register() {
        let state = settled(&[("gift", "gift_card", 2000)]);
        let register = FakeRegister::connected(&voucher());
        let dispatches = Dispatches::default();
        let first = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(
                TransactionStatus::Timeout,
                json!({ "adapter": "cap_driver", "commandConsumed": false, "requiresReconciliation": true }),
            ),
            probe_never,
        )
        .await;
        assert_eq!(first["status"], "pending", "{first}");
        assert_eq!(first["code"], "GIFT_CARD_FISCAL_RECONCILIATION_REQUIRED");

        let again = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_unknown,
        )
        .await;
        assert_eq!(again["status"], "pending", "{again}");
        assert_eq!(
            dispatches.count(),
            1,
            "an unknown receipt is never sent again"
        );
        {
            let conn = state.conn.lock().unwrap();
            let payment = insert_payment(&conn, "cash-late", "cash", 100)
                .unwrap_err()
                .to_string();
            assert!(
                payment.contains("GIFT_FISCAL_OPERATION_LEDGER_LOCKED"),
                "{payment}"
            );
            let items = conn
                .execute(
                    "UPDATE orders SET items = '[]' WHERE id = ?1",
                    params![ORDER],
                )
                .unwrap_err()
                .to_string();
            assert!(
                items.contains("GIFT_FISCAL_OPERATION_LEDGER_LOCKED"),
                "{items}"
            );
            let device = conn
                .execute("DELETE FROM ecr_devices WHERE id = ?1", params![DEVICE])
                .unwrap_err()
                .to_string();
            assert!(
                device.contains("GIFT_FISCAL_OPERATION_DEVICE_RETAINED"),
                "{device}"
            );
            let erase = conn
                .execute("DELETE FROM gift_card_fiscal_operations", [])
                .unwrap_err()
                .to_string();
            assert!(erase.contains("GIFT_FISCAL_OPERATION_RETAINED"), "{erase}");
            let identity = conn
                .execute(
                    "UPDATE gift_card_fiscal_operations SET amount_cents = 1 WHERE local_order_id = ?1",
                    params![ORDER],
                )
                .unwrap_err()
                .to_string();
            assert!(
                identity.contains("GIFT_FISCAL_OPERATION_IDENTITY_IMMUTABLE"),
                "{identity}"
            );
            let print = settled_gift_print_guard(&conn, ORDER).unwrap_err();
            assert!(print.starts_with("GIFT_CARD_FISCAL_RECONCILIATION_REQUIRED"));
            assert_eq!(
                check_fresh_gift_debit(&conn, &register, &CloudRoute::Allowed, ORDER, "EUR")
                    .unwrap_err()
                    .0,
                "GIFT_CARD_FISCAL_ALREADY_STARTED"
            );
        }

        let reconciled = reconcile_with(&state, ORDER, probe_approved);
        assert_eq!(reconciled["status"], "approved", "{reconciled}");
        assert_eq!(dispatches.count(), 1);
        let conn = state.conn.lock().unwrap();
        let reopen = conn
            .execute(
                "UPDATE gift_card_fiscal_operations SET status = 'unknown' WHERE local_order_id = ?1",
                params![ORDER],
            )
            .unwrap_err()
            .to_string();
        assert!(
            reopen.contains("GIFT_FISCAL_OPERATION_TERMINAL"),
            "{reopen}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn adapter_refusal_without_any_trace_fails_cleanly_and_allows_a_fresh_intent() {
        let state = settled(&[("gift", "gift_card", 2000)]);
        let register = FakeRegister::connected(&voucher());
        let dispatches = Dispatches::default();
        let failed = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.refusing("Device register-1 not connected"),
            probe_no_trace,
        )
        .await;
        assert_eq!(failed["status"], "error", "{failed}");
        assert_eq!(failed["code"], "GIFT_CARD_FISCAL_NOT_SUBMITTED");
        let retried = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_never,
        )
        .await;
        assert_eq!(retried["status"], "approved", "{retried}");
        assert_ne!(retried["operationId"], failed["operationId"]);
        assert_eq!(dispatches.count(), 2);
    }

    fn operations(state: &db::DbState, status: Option<&str>) -> i64 {
        state
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM gift_card_fiscal_operations
                 WHERE ?1 IS NULL OR status = ?1",
                params![status],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn manager_error_without_any_trace_stays_unknown_and_is_never_resent() {
        let state = settled(&[("gift", "gift_card", 2000)]);
        let register = FakeRegister::connected(&voucher());
        let dispatches = Dispatches::default();
        let first = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.failing("ecr_process_transaction join error: task panicked"),
            probe_no_trace,
        )
        .await;
        assert_eq!(first["status"], "pending", "{first}");
        assert_eq!(first["code"], "GIFT_CARD_FISCAL_RECONCILIATION_REQUIRED");
        // Resolved from its own files even where new work is refused.
        let again = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::DirectAade),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_no_trace,
        )
        .await;
        assert_eq!(again["status"], "pending", "{again}");
        assert_eq!(again["operationId"], first["operationId"]);
        assert_eq!(dispatches.count(), 1);
        assert_eq!(operations(&state, Some("unknown")), 1);
        assert_eq!(operations(&state, None), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn register_error_is_final_only_when_it_names_this_command() {
        let raw = |correlated: bool| {
            json!({
                "adapter": "cap_driver",
                "commandConsumed": true,
                "requiresReconciliation": false,
                "errorCorrelated": correlated,
            })
        };
        let register = FakeRegister::connected(&voucher());
        let dispatches = Dispatches::default();
        let state = settled(&[("gift", "gift_card", 2000)]);
        let shared = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Error, raw(false)),
            probe_never,
        )
        .await;
        assert_eq!(shared["status"], "pending", "{shared}");
        assert_eq!(shared["code"], "GIFT_CARD_FISCAL_RECONCILIATION_REQUIRED");
        let state = settled(&[("gift", "gift_card", 2000)]);
        let own = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Error, raw(true)),
            probe_never,
        )
        .await;
        assert_eq!(own["code"], "GIFT_CARD_FISCAL_REGISTER_ERROR", "{own}");
        assert_eq!(operations(&state, Some("failed")), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn new_receipt_needs_a_route_read_now_that_allows_it() {
        for route in [
            None,
            Some(CloudRoute::DirectAade),
            Some(CloudRoute::Unavailable("offline".to_string())),
        ] {
            let state = settled(&[("gift", "gift_card", 2000)]);
            let register = FakeRegister::connected(&voucher());
            let dispatches = Dispatches::default();
            let refused = finalize_with(
                &state,
                &register,
                route.as_ref(),
                ORDER,
                dispatches.replying(TransactionStatus::Approved, approved_raw()),
                probe_never,
            )
            .await;
            assert!(
                matches!(
                    refused["code"].as_str(),
                    Some(
                        "GIFT_CARD_FISCAL_DIRECT_AADE_UNSUPPORTED"
                            | "GIFT_CARD_FISCAL_ROUTE_UNAVAILABLE"
                    )
                ),
                "{refused}"
            );
            assert_eq!(dispatches.count(), 0);
            assert_eq!(operations(&state, None), 0);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unreadable_register_settings_are_unavailable_not_no_register() {
        let state = settled(&[("gift", "gift_card", 2000)]);
        let register = FakeRegister::connected(&voucher());
        {
            let conn = state.conn.lock().unwrap();
            conn.execute_batch("ALTER TABLE ecr_devices RENAME TO ecr_devices_unreadable;")
                .unwrap();
            let gate = check_fresh_gift_debit(&conn, &register, &CloudRoute::Allowed, ORDER, "EUR");
            assert_eq!(gate.unwrap_err().0, "GIFT_CARD_FISCAL_REGISTER_UNAVAILABLE");
            assert_eq!(
                fiscal_disposition_for_order(&conn, ORDER)["status"],
                "unavailable"
            );
            let ready = readiness(&conn, &register, &CloudRoute::Allowed, None);
            assert_eq!(ready["status"], "unavailable", "{ready}");
        }
        let dispatches = Dispatches::default();
        let refused = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_never,
        )
        .await;
        assert_eq!(
            refused["code"], "GIFT_CARD_FISCAL_REGISTER_UNAVAILABLE",
            "{refused}"
        );
        assert_eq!(dispatches.count(), 0);
        assert_eq!(operations(&state, None), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn non_eur_missing_or_unreadable_payments_never_become_an_eur_receipt() {
        let register = FakeRegister::connected(&voucher());
        let mut exercised = 0;
        for (currency, raw_cents) in [
            (Some("USD"), None),
            (Some(" "), None),
            (None, None),
            (Some("EUR"), Some("abc")),
        ] {
            let state = settled(&[("gift", "gift_card", 1200), ("cash", "cash", 800)]);
            let applied = {
                let conn = state.conn.lock().unwrap();
                conn.execute(
                    "UPDATE order_payments SET currency = ?1 WHERE id = 'cash'",
                    params![currency],
                )
                .is_ok()
                    && raw_cents.map_or(true, |raw| {
                        conn.execute(
                            "UPDATE order_payments SET amount_cents = ?1 WHERE id = 'cash'",
                            params![raw],
                        )
                        .is_ok()
                    })
            };
            if !applied {
                // The schema itself refuses this shape.
                continue;
            }
            exercised += 1;
            // Finalize reads the settlement snapshot first, so a malformed amount
            // is refused there as unreadable local state; the fresh-debit guard
            // reads the strict fiscal tenders first. Neither reserves or sends.
            let (status, expected, guard) = if raw_cents.is_some() {
                (
                    "error",
                    "GIFT_CARD_LOCAL_STATE_UNAVAILABLE",
                    "GIFT_CARD_FISCAL_LEDGER_UNREADABLE",
                )
            } else {
                (
                    "unsupported",
                    "GIFT_CARD_FISCAL_CURRENCY_UNSUPPORTED",
                    "GIFT_CARD_FISCAL_CURRENCY_UNSUPPORTED",
                )
            };
            let dispatches = Dispatches::default();
            let refused = finalize_with(
                &state,
                &register,
                Some(&CloudRoute::Allowed),
                ORDER,
                dispatches.replying(TransactionStatus::Approved, approved_raw()),
                probe_never,
            )
            .await;
            assert_eq!(refused["status"], status, "{currency:?} {refused}");
            assert_eq!(refused["code"], expected, "{currency:?} {refused}");
            if raw_cents.is_some() {
                let error = refused["error"].as_str().unwrap_or_default();
                assert!(error.contains("ledger generation"), "{refused}");
            }
            assert_eq!(dispatches.count(), 0);
            assert_eq!(operations(&state, None), 0);
            let conn = state.conn.lock().unwrap();
            let gate = check_fresh_gift_debit(&conn, &register, &CloudRoute::Allowed, ORDER, "EUR");
            assert_eq!(gate.unwrap_err().0, guard, "{currency:?}");
            let stored: Option<String> = conn
                .query_row(
                    "SELECT currency FROM order_payments WHERE id = 'cash'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(stored.as_deref(), currency, "the mirror is never converted");
        }
        assert!(
            exercised >= 2,
            "only {exercised} ledger shapes were exercised"
        );
    }

    fn insert_receipt(conn: &Connection, id: &str, reference: &str, status: &str) {
        conn.execute(
            "INSERT INTO ecr_transactions (
                 id, device_id, order_id, transaction_type, amount, currency, status, started_at
             ) VALUES (?1, ?2, ?3, 'fiscal_receipt', 2000, 'EUR', ?4, '2020-01-01T00:00:00Z')",
            params![id, DEVICE, reference, status],
        )
        .unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn older_ordinary_receipt_evidence_blocks_new_gift_work_without_aging_out() {
        let outstanding = format!("{ORDER}:collect-outstanding:tok-1");
        for (id, reference, status, cloud_alias) in [
            ("fiscal-old", ORDER, "timeout", None),
            (
                "fiscal-outstanding-tok-1",
                outstanding.as_str(),
                "processing",
                None,
            ),
            (
                "fiscal-cloud",
                "cloud-order-1",
                "pending",
                Some("cloud-order-1"),
            ),
        ] {
            let state = settled(&[("gift", "gift_card", 2000)]);
            let register = FakeRegister::connected(&voucher());
            {
                let conn = state.conn.lock().unwrap();
                if let Some(alias) = cloud_alias {
                    conn.execute(
                        "UPDATE orders SET supabase_id = ?2 WHERE id = ?1",
                        params![ORDER, alias],
                    )
                    .unwrap();
                }
                insert_receipt(&conn, id, reference, status);
                let gate =
                    check_fresh_gift_debit(&conn, &register, &CloudRoute::Allowed, ORDER, "EUR");
                assert_eq!(
                    gate.unwrap_err().0,
                    "GIFT_CARD_FISCAL_PRIOR_RECEIPT_UNRESOLVED",
                    "{id}"
                );
                let order = fiscal_disposition_for_order(&conn, ORDER);
                assert_eq!(
                    order["code"], "GIFT_CARD_FISCAL_PRIOR_RECEIPT_UNRESOLVED",
                    "{order}"
                );
                let ready = readiness(&conn, &register, &CloudRoute::Allowed, Some(ORDER));
                assert_eq!(ready["status"], "pending", "{ready}");
            }
            let dispatches = Dispatches::default();
            let blocked = finalize_with(
                &state,
                &register,
                Some(&CloudRoute::Allowed),
                ORDER,
                dispatches.replying(TransactionStatus::Approved, approved_raw()),
                probe_never,
            )
            .await;
            assert_eq!(blocked["status"], "pending", "{blocked}");
            assert_eq!(blocked["code"], "GIFT_CARD_FISCAL_PRIOR_RECEIPT_UNRESOLVED");
            assert_eq!(blocked["requiresReconciliation"], true);
            assert_eq!(dispatches.count(), 0);
            assert_eq!(operations(&state, None), 0);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn approved_remainder_receipt_is_replayed_and_suppresses_a_second_receipt() {
        let state = settled(&[("gift", "gift_card", 1200)]);
        let register = FakeRegister::connected(&voucher());
        {
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO order_payments (
                     id, order_id, method, amount, amount_cents, status, transaction_ref,
                     created_at, updated_at
                 ) VALUES ('card', ?1, 'card', 8.0, 800, 'completed', 'fiscal-outstanding-tok-1',
                     ?2, ?2)",
                params![ORDER, "2026-09-29T10:02:00Z"],
            )
            .unwrap();
            insert_receipt(
                &conn,
                "fiscal-outstanding-tok-1",
                &format!("{ORDER}:collect-outstanding:tok-1"),
                "approved",
            );
            let gate = check_fresh_gift_debit(&conn, &register, &CloudRoute::Allowed, ORDER, "EUR");
            assert!(gate.is_ok(), "{gate:?}");
            let order = fiscal_disposition_for_order(&conn, ORDER);
            assert_eq!(order["code"], "GIFT_CARD_FISCAL_ALREADY_ISSUED", "{order}");
        }
        let dispatches = Dispatches::default();
        let replayed = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_never,
        )
        .await;
        assert_eq!(replayed["status"], "not_required", "{replayed}");
        assert_eq!(replayed["code"], "GIFT_CARD_FISCAL_ALREADY_ISSUED");
        assert_eq!(replayed["alreadyIssued"], true);
        assert_eq!(dispatches.count(), 0);
        assert_eq!(operations(&state, None), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn changed_items_after_issue_are_stale_and_never_print_again() {
        let state = settled(&[("gift", "gift_card", 2000)]);
        let register = FakeRegister::connected(&voucher());
        let dispatches = Dispatches::default();
        let first = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_never,
        )
        .await;
        assert_eq!(first["status"], "approved", "{first}");
        state
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE orders SET items = ?2 WHERE id = ?1",
                params![
                    ORDER,
                    json!([{ "name": "Tea", "quantity": 2, "price": 10.0, "taxRate": 24 }])
                        .to_string()
                ],
            )
            .unwrap();
        let stale = finalize_with(
            &state,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            dispatches.replying(TransactionStatus::Approved, approved_raw()),
            probe_never,
        )
        .await;
        assert_eq!(stale["code"], "GIFT_CARD_FISCAL_RECEIPT_STALE", "{stale}");
        assert_eq!(dispatches.count(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn second_connection_sees_the_reservation_before_dispatch() {
        let path = std::env::temp_dir().join(format!("gift-fiscal-{}.db", uuid::Uuid::new_v4()));
        let first = state(migrated(Connection::open(&path).unwrap()));
        {
            let conn = first.conn.lock().unwrap();
            seed_register(&conn, &voucher());
            seed_order(&conn, 2000);
            insert_payment(&conn, "gift", "gift_card", 2000).unwrap();
        }
        let second_conn = Connection::open(&path).unwrap();
        second_conn
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
            .unwrap();
        let second = state(second_conn);
        let register = FakeRegister::connected(&voucher());
        let observed = Arc::new(Mutex::new(None));
        let seen = observed.clone();
        let (second_ref, register_ref) = (&second, &register);
        let result = finalize_with(
            &first,
            &register,
            Some(&CloudRoute::Allowed),
            ORDER,
            move |_device, request: TransactionRequest| {
                let plan =
                    reserve_or_resume(second_ref, register_ref, Some(&CloudRoute::Allowed), ORDER)
                        .unwrap();
                *seen.lock().unwrap() = Some(matches!(
                    plan,
                    Plan::Resume(ref operation)
                        if operation.status == "processing"
                            && operation.operation_id == request.transaction_id
                ));
                std::future::ready(Ok(SettledDispatch::Completed(response(
                    &request.transaction_id,
                    TransactionStatus::Approved,
                    approved_raw(),
                ))))
            },
            probe_never,
        )
        .await;
        assert_eq!(result["status"], "approved", "{result}");
        assert_eq!(*observed.lock().unwrap(), Some(true));
        drop(first);
        drop(second);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn fresh_debit_gate_refuses_known_unsupported_routes_before_any_debit() {
        let conn = migrated(Connection::open_in_memory().unwrap());
        seed_order(&conn, 2000);
        let ready = FakeRegister::connected(&voucher());
        let gate = |access: &dyn RegisterAccess, cloud: &CloudRoute, currency: &str| {
            check_fresh_gift_debit(&conn, access, cloud, ORDER, currency).map_err(|error| error.0)
        };
        // Without a register only the branch cloud route matters.
        assert_eq!(gate(&ready, &CloudRoute::Allowed, "EUR"), Ok(()));
        assert_eq!(
            gate(&ready, &CloudRoute::DirectAade, "EUR"),
            Err("GIFT_CARD_FISCAL_DIRECT_AADE_UNSUPPORTED")
        );
        assert_eq!(
            gate(&ready, &CloudRoute::Unavailable("offline".into()), "EUR"),
            Err("GIFT_CARD_FISCAL_ROUTE_UNAVAILABLE")
        );

        seed_register(&conn, &voucher());
        assert_eq!(gate(&ready, &CloudRoute::Allowed, "EUR"), Ok(()));
        let disconnected = FakeRegister {
            fingerprint: None,
            codes: ready.codes,
        };
        assert_eq!(
            gate(&disconnected, &CloudRoute::Allowed, "EUR"),
            Err("GIFT_CARD_FISCAL_REGISTER_DISCONNECTED")
        );
        let reconfigured = FakeRegister::connected(&json!({ "voucherPaymentCode": 8 }));
        assert_eq!(
            gate(&reconfigured, &CloudRoute::Allowed, "EUR"),
            Err("GIFT_CARD_FISCAL_REGISTER_CONFIG_CHANGED")
        );
        let cash_clash = FakeRegister {
            fingerprint: ready.fingerprint.clone(),
            codes: Some(GiftTenderCodes {
                cash: 7,
                card: 2,
                voucher: Some(7),
            }),
        };
        assert_eq!(
            gate(&cash_clash, &CloudRoute::Allowed, "EUR"),
            Err("GIFT_CARD_FISCAL_VOUCHER_NOT_CONFIGURED")
        );
        assert_eq!(
            gate(&ready, &CloudRoute::Allowed, "USD"),
            Err("GIFT_CARD_FISCAL_CURRENCY_UNSUPPORTED")
        );

        // An already approved bank card cannot share the gift receipt.
        insert_payment(&conn, "card", "card", 500).unwrap();
        assert_eq!(
            gate(&ready, &CloudRoute::Allowed, "EUR"),
            Err("GIFT_CARD_FISCAL_PRIOR_CARD_UNSUPPORTED")
        );
    }

    #[test]
    fn unconfigured_fixed_cash_or_details_only_voucher_is_refused() {
        for (settings, details) in [
            (json!({}), "{}"),
            (json!({ "voucherPaymentCode": 1 }), "{}"),
            (
                json!({ "cashPaymentCode": 3, "voucherPaymentCode": 1 }),
                "{}",
            ),
            (json!({}), r#"{"voucherPaymentCode":7}"#),
        ] {
            let conn = migrated(Connection::open_in_memory().unwrap());
            seed_order(&conn, 2000);
            seed_register(&conn, &settings);
            conn.execute(
                "UPDATE ecr_devices SET connection_details = ?2 WHERE id = ?1",
                params![DEVICE, details],
            )
            .unwrap();
            let register = FakeRegister::connected(&settings);
            assert_eq!(
                check_fresh_gift_debit(&conn, &register, &CloudRoute::Allowed, ORDER, "EUR")
                    .map_err(|error| error.0),
                Err("GIFT_CARD_FISCAL_VOUCHER_NOT_CONFIGURED"),
                "{settings} / {details}"
            );
        }
    }

    #[test]
    fn integrations_route_classifies_direct_aade_and_unreadable_lists() {
        let entry = |mode: &str, active: bool| {
            json!({
                "plugin_id": "fiscalization_gr",
                "is_purchased": true,
                "is_enabled": active,
                "is_active": active,
                "status": if active { "active" } else { "inactive" },
                "settings": { "mode": mode, "environment": "production" }
            })
        };
        let list = |entries: Vec<Value>| json!({ "success": true, "integrations": entries });
        assert_eq!(
            classify_integrations(&list(vec![entry("direct_api", true)])),
            CloudRoute::DirectAade
        );
        assert_eq!(
            classify_integrations(&list(vec![entry("provider", true)])),
            CloudRoute::Allowed
        );
        assert_eq!(
            classify_integrations(&list(vec![entry("direct_api", false)])),
            CloudRoute::Allowed
        );
        assert_eq!(classify_integrations(&list(vec![])), CloudRoute::Allowed);
        assert!(matches!(
            classify_integrations(&json!({ "success": false, "error": "TERMINAL_REQUIRED" })),
            CloudRoute::Unavailable(_)
        ));
        assert!(matches!(
            classify_integrations(&json!({ "success": true })),
            CloudRoute::Unavailable(_)
        ));
    }

    #[test]
    fn redemption_disposition_is_separate_from_financial_success() {
        let conn = migrated(Connection::open_in_memory().unwrap());
        seed_order(&conn, 2000);
        insert_payment(&conn, "gift", "gift_card", 1000).unwrap();
        assert_eq!(
            fiscal_disposition_for_order(&conn, ORDER)["status"],
            "not_required"
        );
        seed_register(&conn, &voucher());
        let partial = fiscal_disposition_for_order(&conn, ORDER);
        assert_eq!(partial["status"], "partial", "{partial}");
        insert_payment(&conn, "gift-2", "gift_card", 1000).unwrap();
        let ready = fiscal_disposition_for_order(&conn, ORDER);
        assert_eq!(ready["status"], "ready", "{ready}");
        assert_eq!(ready["requiresFinalize"], true);
        assert_eq!(ready["certified"], false);
        assert!(order_has_completed_gift_payment(&conn, ORDER).unwrap());
        assert_eq!(settled_gift_print_guard(&conn, ORDER), Ok(None));
    }
}
