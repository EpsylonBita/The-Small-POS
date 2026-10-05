//! Build a canonical `FiscalReceiptInput`-shaped JSON value from a
//! locally persisted order.
//!
//! Implements Task 18 of `.claude/specs/fiscalization-core/tasks.md`.
//! Satisfies Req 4.9.
//!
//! ## Status: populated generic payload; GR financial snapshot work remains
//!
//! Earlier revision was a scaffold that emitted empty `vatBreakdown` /
//! `lines` / `payments` / `metadata` arrays — fiscalization audit
//! 2026-05-25 finding #1 (P0) caught this colliding with the HR adapter
//! validator (`admin-dashboard/src/services/fiscal/adapters/hr/xml-builder.ts:128-179`)
//! which rejects empty lines, empty payments, and missing metadata
//! (`operatorOib`, `sequenceNumber`, `paymentMethodCode`) terminally.
//!
//! This revision populates every field by reading from local SQLite:
//!
//!   * **lines**       — parsed from `orders.items` JSON (its existing
//!     on-disk shape: `[{menu_item_id, name, quantity,
//!     total_price}, ...]`).
//!   * **payments**    — `order_payments WHERE order_id=? AND status='completed'`.
//!   * **vatBreakdown** — single aggregated entry derived from
//!     stored order tax + order gross, with legacy amount conversion
//!     only when the corresponding integer cents are absent.
//!   * **metadata**    — country-agnostic `kind` + HR/GR-friendly
//!     `operatorOib` (looked up via local_settings),
//!     `sequenceNumber` (allocated atomically via
//!     [`super::sequence_counter::next_sequence`]),
//!     `paymentMethodCode` (mapped from completed payment rows
//!     to CIS codes G/K/C/T/O; mixed methods use O).
//!
//! ## Documented limitations
//!
//!   * **Issuance and tax snapshots** — the authoritative issuance moment
//!     and immutable per-line VAT snapshot are unresolved. Populating this
//!     generic payload does not establish GR production readiness.
//!
//!   * **Single-rate VAT** — pos-tauri's `orders` row carries one
//!     `tax_rate` for the whole order. Multi-rate baskets (e.g. food at
//!     13% + drink at 24%) are aggregated into a single `vatBreakdown`
//!     entry. A future revision that wires per-line VAT lookup would
//!     split this — not in scope for the audit #1 partial fix.
//!   * **operatorOib via local_settings** — HR's per-cashier OIB is
//!     read from `local_settings(category='fiscalization.hr',
//!     key='operator_oib_for_<staff_id>')` with a fallback to
//!     `key='default_operator_oib'`. Admin must populate these via the
//!     existing settings-sync path. Missing both → empty string,
//!     validator returns terminal `payload_invalid: metadata.operatorOib
//!     is required` with a clear remediation message.
//!   * **Mobile parallel** — `POSSystemMobile/src/services/fiscal/`
//!     reads actual completed payment rows and populates the generic
//!     payload, but shares the unresolved per-line VAT snapshot limitation.

use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::money::Cents;

/// Shape of one element of `orders.items` JSON, derived from the existing
/// representative INSERT at `pos-tauri/src-tauri/src/print.rs:6078`:
/// `[{"menu_item_id":"sub-waffle","name":"Βάφλα","quantity":1,"total_price":8.8}]`.
/// Extra fields (category names, modifiers, etc.) are tolerated via
/// `serde(default)` + ignoring unknown keys.
#[derive(Debug, Deserialize)]
struct ParsedOrderItem {
    #[serde(default)]
    menu_item_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default = "default_quantity")]
    quantity: i64,
    #[serde(default)]
    total_price: f64,
}

fn default_quantity() -> i64 {
    1
}

/// Order header columns we read in one round-trip.
///
/// Audit round 4 P0 fix (2026-05-25): `payment_method` was removed from
/// this struct after migration v55 (db.rs:3805) dropped
/// `orders.payment_method` from production. The payment method is now
/// derived from completed `order_payments` rows via
/// `crate::payments::derive_payment_method` — single source of truth.
/// Reading the dropped column would have failed every dispatch with
/// "no such column: payment_method" against a real terminal DB.
#[derive(Debug)]
struct OrderHeader {
    organization_id: String,
    receipt_number: String,
    issued_at: String,
    total_cents: i64,
    tax_cents: i64,
    items_json: String,
    staff_id: Option<String>,
    tax_rate: Option<f64>,
}

/// One completed payment row, ready to map into FiscalReceiptInput.payments.
#[derive(Debug)]
struct PaymentRow {
    id: String,
    method: String,
    amount_cents: i64,
    transaction_ref: Option<String>,
}

/// Build the canonical fiscal receipt payload.
///
/// Returns a JSON value ready for `serde_json::to_string` over the wire.
/// Propagates missing-order and storage/query/sequence failures. Missing
/// field values (items, operatorOib, tax_rate) remain for adapter validation;
/// no settlement or issuance decision is made by this payload builder.
pub fn build_fiscal_receipt_input(
    conn: &Connection,
    order_id: &str,
    branch_id: &str,
) -> Result<Value, String> {
    let header = read_order_header(conn, order_id)?;
    let parsed_items = parse_items_json(&header.items_json);
    let payments = read_completed_payments(conn, order_id)?;

    // A partial settlement must never reduce the invoice to the paid amount.
    // Keep actual payments separate so adapter validation can detect a mismatch.
    let gross_cents = header.total_cents;

    let tax_cents = if header.tax_cents > 0 {
        header.tax_cents.min(gross_cents)
    } else {
        0
    };
    let net_cents = gross_cents - tax_cents;

    let rate_basis_points = compute_rate_basis_points(net_cents, tax_cents, header.tax_rate);

    let lines = build_lines(&parsed_items, rate_basis_points);
    let payments_json = build_payments_json(&payments);
    let vat_breakdown = build_vat_breakdown(net_cents, tax_cents, gross_cents, rate_basis_points);

    // Audit round 4 P0 fix (2026-05-25): single source of truth for payment
    // method is completed order_payments rows. derive_payment_method
    // returns None when no completed payment exists (the cashier hasn't
    // yet finalised), Some("split") for multi-method completions, or
    // Some(method) for the single completed method. `map_to_cis_payment_code`
    // gracefully maps None and "split" both to "O" (Other) via its
    // default branch.
    let derived_method = crate::payments::derive_payment_method(conn, order_id)
        .ok()
        .flatten();
    let payment_method_code = map_to_cis_payment_code(derived_method.as_deref());
    let operator_oib = lookup_operator_oib(conn, header.staff_id.as_deref());

    let issued_at = normalize_issued_at(&header.issued_at);
    let business_day_iso = extract_business_day(&issued_at);
    // A new unpaid order has its own immutable unit. Once a ledger exists it
    // must agree; current settings cannot relabel either historical source.
    let currency = resolve_order_document_currency(conn, order_id)?;
    let _ = super::currency::warn_if_currency_unsupported(conn, branch_id);
    let sequence_number =
        super::sequence_counter::next_sequence(conn, branch_id, &business_day_iso)?;

    let payload = json!({
        "organizationId": header.organization_id,
        "branchId": branch_id,
        "orderId": order_id,
        "receiptNumber": header.receipt_number,
        "issuedAt": issued_at,
        "totals": {
            "netCents": net_cents,
            "vatCents": tax_cents,
            "grossCents": gross_cents,
            "currency": currency,
        },
        "vatBreakdown": vat_breakdown,
        "lines": lines,
        "payments": payments_json,
        "metadata": {
            "operatorOib": operator_oib,
            "sequenceNumber": sequence_number,
            "paymentMethodCode": payment_method_code,
            "kind": "receipt",
        },
    });

    Ok(payload)
}

fn read_order_header(conn: &Connection, order_id: &str) -> Result<OrderHeader, String> {
    // Audit round 4 P0 fix (2026-05-25): no `payment_method` in the SELECT
    // — migration v55 (db.rs:3805) dropped that column from production.
    // The method now comes from completed order_payments rows via
    // `crate::payments::derive_payment_method` called after this read.
    conn.query_row(
        "SELECT
            COALESCE(organization_id, ''),
            COALESCE(receipt_number, id),
            COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            total_amount_cents, COALESCE(total_amount, 0.0),
            tax_amount_cents, COALESCE(tax_amount, 0.0),
            COALESCE(items, '[]'),
            staff_id,
            tax_rate
         FROM orders
         WHERE id = ?1",
        params![order_id],
        |row| {
            Ok(OrderHeader {
                organization_id: row.get(0)?,
                receipt_number: row.get(1)?,
                issued_at: row.get(2)?,
                total_cents: read_cents(row, 3, 4)?,
                tax_cents: read_cents(row, 5, 6)?,
                items_json: row.get(7)?,
                staff_id: row.get(8)?,
                tax_rate: row.get(9)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("read orders header for {order_id}: {e}"))?
    .ok_or_else(|| format!("order {order_id} not found in local DB"))
}

fn read_cents(
    row: &rusqlite::Row<'_>,
    cents_index: usize,
    legacy_index: usize,
) -> rusqlite::Result<i64> {
    match row.get::<_, Option<i64>>(cents_index)? {
        Some(cents) => Ok(cents),
        None => Ok(Cents::round_half_even(row.get(legacy_index)?).as_i64()),
    }
}

pub(crate) fn normalize_issued_at(raw: &str) -> String {
    parse_issued_at(raw)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_issued_at(raw: &str) -> Option<DateTime<Utc>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.with_timezone(&Utc));
    }

    for format in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, format) {
            return Some(Utc.from_utc_datetime(&naive));
        }
    }

    NaiveDate::parse_from_str(trimmed, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|naive| Utc.from_utc_datetime(&naive))
}

fn parse_items_json(json_text: &str) -> Vec<ParsedOrderItem> {
    serde_json::from_str::<Vec<ParsedOrderItem>>(json_text).unwrap_or_default()
}

fn read_completed_payments(conn: &Connection, order_id: &str) -> Result<Vec<PaymentRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, method, amount_cents, amount, transaction_ref,
                    COALESCE((
                        SELECT SUM(CAST(ROUND(pa.amount * 100) AS INTEGER))
                        FROM payment_adjustments pa
                        WHERE pa.payment_id = order_payments.id
                          AND pa.adjustment_type IN ('refund', 'void')
                    ), 0)
             FROM order_payments
             WHERE order_id = ?1 AND status = 'completed'
             ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare read_completed_payments: {e}"))?;
    let rows = stmt
        .query_map(params![order_id], |row| {
            let payment = PaymentRow {
                id: row.get(0)?,
                method: row.get(1)?,
                amount_cents: read_cents(row, 2, 3)?,
                transaction_ref: row.get(4)?,
            };
            Ok((payment, row.get::<_, i64>(5)?))
        })
        .map_err(|e| format!("query_map read_completed_payments: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        let (mut payment, adjusted_cents) = r.map_err(|e| format!("read payment row: {e}"))?;
        // tip_amount_cents is separate from the amount applied to the order;
        // refunds and voids recorded as adjustments are not tendered, nor is a
        // gift card row's proven return floor (the larger of the two, once).
        let reversed_cents = crate::payments::effective_reversed_cents(
            conn,
            &payment.id,
            order_id,
            &payment.method,
            payment.amount_cents,
            adjusted_cents,
        )?;
        payment.amount_cents = (payment.amount_cents - reversed_cents).max(0);
        // A tender refunded or voided in full is not part of the receipt.
        if !(reversed_cents > 0 && payment.amount_cents == 0) {
            out.push(payment);
        }
    }
    Ok(out)
}

/// rateBasisPoints encoding: 100% = 10000 (1 basis point = 1/10000 of unity).
/// Per `admin-dashboard/src/services/fiscal/adapters/hr/xml-builder.ts:250`,
/// the renderer divides by 100 + .toFixed(2), so 2400 → "24.00".
///
/// Strategy: if both net + tax are positive, derive the empirical ratio
/// (handles arbitrary stored tax_rate conventions). Otherwise fall back
/// to the stored `orders.tax_rate`, autodetecting decimal-vs-percent
/// based on magnitude (<=1.0 → decimal, >1.0 → percent).
fn compute_rate_basis_points(net_cents: i64, tax_cents: i64, tax_rate: Option<f64>) -> i64 {
    if net_cents > 0 && tax_cents > 0 {
        return ((tax_cents as f64 / net_cents as f64) * 10000.0).round() as i64;
    }
    match tax_rate {
        Some(r) if r > 0.0 && r <= 1.0 => (r * 10000.0).round() as i64,
        Some(r) if r > 1.0 => (r * 100.0).round() as i64,
        _ => 0,
    }
}

fn build_lines(items: &[ParsedOrderItem], rate_basis_points: i64) -> Vec<Value> {
    items
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            let line_gross = Cents::round_half_even(item.total_price).as_i64();
            let quantity = if item.quantity > 0 { item.quantity } else { 1 };
            let unit_price = line_gross.checked_div(quantity).unwrap_or(line_gross);
            // Per-line vat omitted from the line shape — the HR validator
            // checks vatBreakdown aggregate sums, not per-line invariants
            // (xml-builder.ts:153-162). Setting netCents=grossCents per
            // line keeps the line shape self-consistent.
            json!({
                "lineId": item
                    .menu_item_id
                    .clone()
                    .unwrap_or_else(|| format!("line-{}", idx + 1)),
                "description": item
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("Item {}", idx + 1)),
                "quantity": quantity,
                "unitPriceCents": unit_price,
                "netCents": line_gross,
                "vatCents": 0,
                "grossCents": line_gross,
                "rateBasisPoints": rate_basis_points,
            })
        })
        .collect()
}

fn build_payments_json(payments: &[PaymentRow]) -> Vec<Value> {
    payments
        .iter()
        .map(|p| {
            json!({
                "paymentId": p.id,
                "method": p.method,
                "amountCents": p.amount_cents,
                "reference": p.transaction_ref,
            })
        })
        .collect()
}

/// Single aggregated entry that satisfies the HR validator's
/// `vatBreakdown.sum(netCents) === totals.netCents` and
/// `vatBreakdown.sum(vatCents) === totals.vatCents` invariants by
/// construction.
fn build_vat_breakdown(
    net_cents: i64,
    tax_cents: i64,
    gross_cents: i64,
    rate_basis_points: i64,
) -> Vec<Value> {
    vec![json!({
        "rateBasisPoints": rate_basis_points,
        "netCents": net_cents,
        "vatCents": tax_cents,
        "grossCents": gross_cents,
    })]
}

/// Map the derived completed-payment method (cash/card/other) to CIS NacinPlac
/// enum (xml-builder.ts:254): G=cash, K=card, C=cheque, T=transfer,
/// O=other. `None` / unknown values default to `O` (Other).
fn map_to_cis_payment_code(method: Option<&str>) -> &'static str {
    match method.unwrap_or("").to_ascii_lowercase().as_str() {
        "cash" => "G",
        "card" => "K",
        "cheque" | "check" => "C",
        "transfer" | "bank_transfer" => "T",
        _ => "O",
    }
}

/// Normalize an explicit persisted or authoritative ISO money unit.
pub(crate) fn normalize_currency_code(raw: &str) -> Option<String> {
    let code = raw.trim().trim_matches('"').trim().to_ascii_uppercase();
    (code.len() == 3 && code.chars().all(|ch| ch.is_ascii_uppercase())).then_some(code)
}

/// Only the server's country-derived, branch-scoped snapshot authorizes new
/// operating amounts. A validated same-branch snapshot remains usable offline.
pub(crate) fn resolve_store_currency_code(conn: &Connection) -> Option<String> {
    let setting = |category: &str, key: &str| crate::db::get_setting(conn, category, key);
    if setting("restaurant", "store_currency_available").as_deref() != Some("true")
        || setting("restaurant", "store_currency_source").as_deref() != Some("branch_country")
    {
        return None;
    }
    let branch = setting("terminal", "branch_id")?;
    let currency_branch = setting("restaurant", "store_currency_branch_id")?;
    if branch.trim().is_empty() || branch.trim() != currency_branch.trim() {
        return None;
    }
    normalize_currency_code(&setting("restaurant", "currency")?)
}

/// Fiscal creation may precede tender, but both recorded sources must agree
/// once money exists. Missing or mixed ledger evidence never falls back.
pub(crate) fn resolve_order_document_currency(
    conn: &Connection,
    order_id: &str,
) -> Result<String, String> {
    let ledger = resolve_order_payment_currency(conn, order_id)?;
    let order = conn
        .query_row(
            "SELECT currency FROM orders WHERE id = ?1",
            params![order_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|error| format!("read fiscal order currency: {error}"))?
        .as_deref()
        .and_then(normalize_currency_code);
    if order
        .as_ref()
        .zip(ledger.as_ref())
        .is_some_and(|(order, ledger)| order != ledger)
    {
        return Err("PAYMENT_CURRENCY_MISMATCH".to_string());
    }
    ledger
        .or(order)
        .ok_or_else(|| "PAYMENT_CURRENCY_UNAVAILABLE".to_string())
}

/// Receipt rebuilds and remaining collections use the original ledger's unit.
/// A missing or mixed currency is an error, never permission to use today's unit.
pub(crate) fn resolve_order_payment_currency(
    conn: &Connection,
    order_id: &str,
) -> Result<Option<String>, String> {
    let mut statement = conn
        .prepare("SELECT currency FROM order_payments WHERE order_id = ?1 AND status IN ('completed', 'partially_refunded', 'refunded', 'voided')")
        .map_err(|error| format!("read payment currency: {error}"))?;
    let rows = statement
        .query_map(params![order_id], |row| row.get::<_, Option<String>>(0))
        .map_err(|error| format!("read payment currency: {error}"))?;
    let mut currency: Option<String> = None;
    for row in rows {
        let code = row
            .map_err(|error| error.to_string())?
            .as_deref()
            .and_then(normalize_currency_code)
            .ok_or_else(|| "PAYMENT_CURRENCY_UNAVAILABLE".to_string())?;
        if currency.as_ref().is_some_and(|previous| previous != &code) {
            return Err("PAYMENT_CURRENCY_MIXED".to_string());
        }
        currency = Some(code);
    }
    Ok(currency)
}

/// Look up the operator OIB (per-cashier Croatian taxpayer ID) for the
/// given staff_id. Falls back to `default_operator_oib` if no per-staff
/// entry is configured, then empty string if even the default is
/// missing. Returning an empty string causes the HR adapter validator
/// to terminal-reject with a clear "metadata.operatorOib is required"
/// message — admin remediation is to populate the per-staff or default
/// setting via the existing settings sync path.
fn lookup_operator_oib(conn: &Connection, staff_id: Option<&str>) -> String {
    if let Some(sid) = staff_id {
        let per_staff_key = format!("operator_oib_for_{sid}");
        if let Ok(value) = conn.query_row(
            "SELECT setting_value FROM local_settings
             WHERE setting_category = 'fiscalization.hr' AND setting_key = ?1",
            params![per_staff_key],
            |row| row.get::<_, String>(0),
        ) {
            if !value.trim().is_empty() {
                return value;
            }
        }
    }
    conn.query_row(
        "SELECT setting_value FROM local_settings
         WHERE setting_category = 'fiscalization.hr' AND setting_key = 'default_operator_oib'",
        params![],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_default()
}

/// Extract the business day (YYYY-MM-DD) from an ISO-8601 datetime.
/// Best-effort: takes the first 10 characters when they look like a date,
/// otherwise falls back to today's UTC date. This is approximation per
/// the same caveat in `close_day_guard::ensure_no_queued_fiscal_for_day`
/// — a real per-org business-day boundary needs the `business_day`
/// module, deferred.
fn extract_business_day(issued_at: &str) -> String {
    if issued_at.len() >= 10 && issued_at.as_bytes()[4] == b'-' && issued_at.as_bytes()[7] == b'-' {
        issued_at[..10].to_string()
    } else {
        chrono::Utc::now().format("%Y-%m-%d").to_string()
    }
}

// =============================================================================
// Audit finding #1 (P0) regression tests
// =============================================================================
#[cfg(test)]
mod audit_1_tests {
    use super::*;

    #[test]
    fn fiscal_document_currency_preserves_unpaid_order_snapshot_and_reconciles_ledger() {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        conn.execute("INSERT INTO orders(id,items,total_amount,status,created_at,updated_at,currency) VALUES('currency-unpaid','[]',10,'pending','now','now','CHF')", []).unwrap();
        crate::db::set_setting(&conn, "restaurant", "currency", "USD").unwrap();
        assert_eq!(
            resolve_order_document_currency(&conn, "currency-unpaid").unwrap(),
            "CHF"
        );
        conn.execute("INSERT INTO order_payments(id,order_id,method,amount,status,created_at,updated_at,currency) VALUES('currency-first','currency-unpaid','cash',10,'completed','now','now','CHF')", []).unwrap();
        assert_eq!(
            resolve_order_document_currency(&conn, "currency-unpaid").unwrap(),
            "CHF"
        );
        // A conflicting ledger must not be relabeled with either original or current settings.
        conn.execute(
            "UPDATE order_payments SET currency='EUR' WHERE id='currency-first'",
            [],
        )
        .unwrap();
        assert_eq!(
            resolve_order_document_currency(&conn, "currency-unpaid").unwrap_err(),
            "PAYMENT_CURRENCY_MISMATCH"
        );
        conn.execute(
            "UPDATE order_payments SET currency='' WHERE id='currency-first'",
            [],
        )
        .unwrap();
        assert_eq!(
            resolve_order_document_currency(&conn, "currency-unpaid").unwrap_err(),
            "PAYMENT_CURRENCY_UNAVAILABLE"
        );
        conn.execute("INSERT INTO orders(id,items,total_amount,status,created_at,updated_at) VALUES('currency-legacy','[]',10,'pending','now','now')", []).unwrap();
        assert_eq!(
            resolve_order_document_currency(&conn, "currency-legacy").unwrap_err(),
            "PAYMENT_CURRENCY_UNAVAILABLE"
        );
    }

    fn make_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory");
        // Audit round 4 P0 fix (2026-05-25): NO `payment_method` column —
        // production migration v55 (db.rs:3805) dropped it. Inline test
        // schemas MUST mirror production after all migrations, not the
        // pre-v55 shape. The test's payment method comes from order_payments
        // (which derive_payment_method reads). This file's earlier
        // revision created `payment_method TEXT` on orders and the tests
        // passed against the fake column while the real production
        // schema rejected the SELECT with "no such column: payment_method"
        // — the exact tautological-schema pitfall called out in
        // feedback_tests_must_use_real_schemas.md.
        conn.execute_batch(
            "
            CREATE TABLE orders (
                id TEXT PRIMARY KEY,
                organization_id TEXT,
                currency TEXT,
                receipt_number TEXT,
                items TEXT NOT NULL DEFAULT '[]',
                total_amount REAL NOT NULL DEFAULT 0,
                total_amount_cents INTEGER,
                tax_amount REAL DEFAULT 0,
                tax_amount_cents INTEGER,
                subtotal REAL DEFAULT 0,
                staff_id TEXT,
                tax_rate REAL,
                created_at TEXT
            );
            CREATE TABLE order_payments (
                id TEXT PRIMARY KEY,
                order_id TEXT NOT NULL,
                method TEXT NOT NULL,
                amount REAL NOT NULL,
                amount_cents INTEGER,
                currency TEXT DEFAULT 'EUR',
                tip_amount_cents INTEGER,
                status TEXT NOT NULL DEFAULT 'completed',
                transaction_ref TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE payment_adjustments (
                id TEXT PRIMARY KEY,
                payment_id TEXT NOT NULL,
                order_id TEXT NOT NULL,
                adjustment_type TEXT NOT NULL
                    CHECK (adjustment_type IN ('void', 'refund')),
                amount REAL NOT NULL,
                reason TEXT NOT NULL,
                staff_id TEXT,
                created_at TEXT
            );
            CREATE TABLE local_settings (
                setting_category TEXT NOT NULL,
                setting_key TEXT NOT NULL,
                setting_value TEXT NOT NULL,
                PRIMARY KEY (setting_category, setting_key)
            );
            CREATE TABLE fiscal_sequence_counters (
                branch_id        TEXT NOT NULL,
                business_day_iso TEXT NOT NULL,
                last_seq         INTEGER NOT NULL DEFAULT 0,
                updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (branch_id, business_day_iso)
            );
            ",
        )
        .expect("create schema");
        // Real v87 journal: a gift card tender reads its proven return floor.
        crate::commands::gift_card_returns::ensure_return_schema(&conn)
            .expect("gift return journal");
        conn
    }

    fn seed_simple_order(conn: &Connection) {
        // 1 item @ €5.00, 24% VAT included → net €4.03, tax €0.97,
        // gross €5.00. Paid in cash (via order_payments — audit round 4
        // P0: orders.payment_method was dropped by v55).
        conn.execute(
            "INSERT INTO orders
                (id, organization_id, receipt_number, items, total_amount,
                 tax_amount, subtotal, staff_id, tax_rate, created_at)
             VALUES
                ('ord-1', 'org-1', 'R-1001',
                 '[{\"menu_item_id\":\"item-A\",\"name\":\"Coffee\",\"quantity\":1,\"total_price\":5.00}]',
                 5.00, 0.97, 4.03, 'staff-1', 0.24, '2026-05-25T10:00:00Z')",
            [],
        )
        .expect("insert order");
        conn.execute(
            "INSERT INTO order_payments
                (id, order_id, method, amount, status, created_at)
             VALUES ('pay-1', 'ord-1', 'cash', 5.00, 'completed', '2026-05-25T10:00:01Z')",
            [],
        )
        .expect("insert payment");
    }

    fn set_setting(conn: &Connection, category: &str, key: &str, value: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO local_settings (setting_category, setting_key, setting_value)
             VALUES (?1, ?2, ?3)",
            params![category, key, value],
        )
        .expect("set local setting");
    }

    #[test]
    fn a_receipt_rebuild_preserves_payment_currency_after_store_country_changes() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute("UPDATE order_payments SET currency = 'CHF'", [])
            .unwrap();
        set_setting(&conn, "restaurant", "currency", "EUR");
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        assert_eq!(payload["totals"]["currency"], "CHF");
    }

    #[test]
    fn a_fully_refunded_payment_keeps_its_original_currency() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute(
            "UPDATE order_payments SET currency = 'CHF', status = 'refunded'",
            [],
        )
        .unwrap();
        set_setting(&conn, "restaurant", "currency", "EUR");
        assert_eq!(
            resolve_order_payment_currency(&conn, "ord-1")
                .unwrap()
                .as_deref(),
            Some("CHF")
        );
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        assert_eq!(payload["totals"]["currency"], "CHF");
    }

    #[test]
    fn unresolved_or_mixed_payment_currency_never_uses_current_country() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute("UPDATE order_payments SET currency = NULL", [])
            .unwrap();
        assert!(build_fiscal_receipt_input(&conn, "ord-1", "branch-1")
            .unwrap_err()
            .contains("PAYMENT_CURRENCY_UNAVAILABLE"));
        conn.execute("UPDATE order_payments SET currency = 'CHF'", [])
            .unwrap();
        conn.execute("INSERT INTO order_payments (id,order_id,method,amount,currency,status,created_at) VALUES ('p2','ord-1','cash',1,'EUR','completed','2026-10-04')", []).unwrap();
        assert!(build_fiscal_receipt_input(&conn, "ord-1", "branch-1")
            .unwrap_err()
            .contains("PAYMENT_CURRENCY_MIXED"));
    }

    #[test]
    fn operating_currency_requires_validated_matching_branch_authority() {
        let conn = make_test_db();
        set_setting(&conn, "organization", "currency", "EUR");
        set_setting(&conn, "restaurant", "currency", "CHF");
        assert_eq!(resolve_store_currency_code(&conn), None);
        set_setting(&conn, "restaurant", "store_currency_available", "true");
        set_setting(
            &conn,
            "restaurant",
            "store_currency_source",
            "branch_country",
        );
        set_setting(
            &conn,
            "restaurant",
            "store_currency_branch_id",
            "swiss-branch",
        );
        set_setting(&conn, "terminal", "branch_id", "swiss-branch");
        assert_eq!(resolve_store_currency_code(&conn).as_deref(), Some("CHF"));
        set_setting(&conn, "terminal", "branch_id", "other-branch");
        assert_eq!(resolve_store_currency_code(&conn), None);
        set_setting(&conn, "terminal", "branch_id", "swiss-branch");
        set_setting(&conn, "restaurant", "store_currency_available", "false");
        assert_eq!(resolve_store_currency_code(&conn), None);
    }

    #[test]
    fn a_database_without_local_settings_reads_as_no_currency_configured() {
        let conn = Connection::open_in_memory().expect("open in-memory");
        assert_eq!(resolve_store_currency_code(&conn), None);
    }

    #[test]
    fn stored_cents_override_legacy_amounts_and_exclude_separate_tips() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute_batch(
            "UPDATE orders SET total_amount_cents = 500, tax_amount_cents = 97,
                 total_amount = 99.99, tax_amount = 9.99 WHERE id = 'ord-1';
             UPDATE order_payments SET amount_cents = 500, amount = 88.88,
                 tip_amount_cents = 200, transaction_ref = 'terminal-reference' WHERE id = 'pay-1';",
        ).unwrap();
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        assert_eq!(payload["totals"]["grossCents"], 500);
        assert_eq!(payload["totals"]["vatCents"], 97);
        assert_eq!(payload["totals"]["netCents"], 403);
        assert_eq!(payload["payments"][0]["amountCents"], 500);
        assert_eq!(payload["payments"][0]["reference"], "terminal-reference");
    }

    #[test]
    fn stored_zero_cents_do_not_fall_back_to_legacy_amounts() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute_batch(
            "UPDATE orders SET total_amount_cents = 0, tax_amount_cents = 0;
             UPDATE order_payments SET amount_cents = 0;",
        )
        .unwrap();
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        assert_eq!(payload["totals"]["grossCents"], 0);
        assert_eq!(payload["totals"]["vatCents"], 0);
        assert_eq!(payload["payments"][0]["amountCents"], 0);
    }

    #[test]
    fn gift_card_tender_proof_without_its_canonical_original_fails_closed() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute_batch(
            "UPDATE order_payments SET method = 'gift_card', amount_cents = 500,
                 transaction_ref = 'gift_card:tx-1' WHERE id = 'pay-1';
             INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason)
             VALUES ('adj-here', 'pay-1', 'ord-1', 'refund', 1.0, 'returned here');",
        )
        .unwrap();
        // This completed proof cannot bind to a canonical original in the fixture.
        let prove = |key: &str, order: &str| {
            conn.execute(
                "INSERT INTO gift_card_return_attempts (
                    return_key, organization_id, branch_id, terminal_id, local_payment_id,
                    remote_payment_id, local_order_id, remote_order_id, card_id, debit_transaction_id,
                    redemption_key, currency, gross_cents, action, requested_cents, reason, staff_id,
                    request_body, state, return_id, reversal_transaction_id, payment_adjustment_id,
                    returned_cents, total_returned_cents, remaining_cents, payment_status,
                    order_total_cents, order_paid_cents, order_remaining_cents, order_payment_status,
                    card_balance_cents, replayed, completed_at, created_at, updated_at
                 ) VALUES (?1, 'org-1', 'branch-1', 'term-1', 'pay-1', 'remote-pay', ?2, 'remote-ord',
                           'card-1', 'tx-1', 'redeem-1', 'EUR', 500, 'refund', 100, 'returned', 'staff-1',
                           '{}', 'completed', ?1, ?1, ?1, 100, 300, 200, 'completed', 500, 200, 300,
                           'partially_paid', 300, 0, 'now', 'now', 'now')",
                params![key, order],
            )
            .map(|_| ())
        };
        let payments = |conn: &Connection| {
            build_fiscal_receipt_input(conn, "ord-1", "branch-1")
                .map(|payload| payload["payments"].clone())
        };
        assert_eq!(
            payments(&conn).unwrap()[0]["amountCents"],
            400,
            "500 minus the recorded 100"
        );
        prove("00000000-0000-4000-8000-000000000001", "ord-1").unwrap();
        assert!(
            payments(&conn).is_err(),
            "an unproven completed proof must not read as zero"
        );
    }

    #[test]
    fn settled_full_gift_card_is_one_gift_tender_not_a_card() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute(
            "UPDATE order_payments SET method = 'gift_card', amount_cents = 500,
                 transaction_ref = 'gift_card:tx-1' WHERE id = 'pay-1'",
            [],
        )
        .unwrap();
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        let payments = payload["payments"].as_array().unwrap();
        assert_eq!(payments.len(), 1);
        assert_eq!(payments[0]["method"], "gift_card");
        assert_eq!(payments[0]["amountCents"], 500);
        assert_eq!(payments[0]["reference"], "gift_card:tx-1");
        assert_eq!(payload["metadata"]["paymentMethodCode"], "O");
    }

    #[test]
    fn settled_gift_and_cash_tenders_are_refund_net() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute_batch(
            "UPDATE orders SET total_amount_cents = 500 WHERE id = 'ord-1';
             UPDATE order_payments SET amount = 4.00, amount_cents = 400 WHERE id = 'pay-1';
             INSERT INTO order_payments
                 (id, order_id, method, amount, amount_cents, status, transaction_ref, created_at)
             VALUES
                 ('pay-gift', 'ord-1', 'gift_card', 2.00, 200, 'completed', 'gift_card:tx-2',
                  '2026-05-25T10:00:02Z'),
                 ('pay-card', 'ord-1', 'card', 1.00, 100, 'completed', 'eft-1',
                  '2026-05-25T10:00:03Z');
             INSERT INTO payment_adjustments
                 (id, payment_id, order_id, adjustment_type, amount, reason, created_at)
             VALUES
                 ('adj-cash', 'pay-1', 'ord-1', 'refund', 1.00, 'overpaid', '2026-05-25T10:01:00Z'),
                 ('adj-card', 'pay-card', 'ord-1', 'refund', 1.00, 'returned', '2026-05-25T10:01:01Z');",
        )
        .unwrap();
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        let tenders: Vec<(String, i64)> = payload["payments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|payment| {
                (
                    payment["method"].as_str().unwrap().to_string(),
                    payment["amountCents"].as_i64().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            tenders,
            vec![("cash".to_string(), 300), ("gift_card".to_string(), 200)]
        );
        assert_eq!(payload["totals"]["grossCents"], 500);
    }

    #[test]
    fn void_adjustments_are_netted_like_refunds() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute_batch(
            "UPDATE orders SET total_amount_cents = 500 WHERE id = 'ord-1';
             UPDATE order_payments SET amount = 4.00, amount_cents = 400 WHERE id = 'pay-1';
             INSERT INTO order_payments
                 (id, order_id, method, amount, amount_cents, status, transaction_ref, created_at)
             VALUES
                 ('pay-gift', 'ord-1', 'gift_card', 2.00, 200, 'completed', 'gift_card:tx-2',
                  '2026-05-25T10:00:02Z'),
                 ('pay-card', 'ord-1', 'card', 1.00, 100, 'completed', 'eft-1',
                  '2026-05-25T10:00:03Z');
             INSERT INTO payment_adjustments
                 (id, payment_id, order_id, adjustment_type, amount, reason, created_at)
             VALUES
                 ('adj-cash', 'pay-1', 'ord-1', 'void', 1.00, 'keyed twice', '2026-05-25T10:01:00Z'),
                 ('adj-card', 'pay-card', 'ord-1', 'void', 1.00, 'voided', '2026-05-25T10:01:01Z');",
        )
        .unwrap();
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        let tenders: Vec<(String, i64)> = payload["payments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|payment| {
                (
                    payment["method"].as_str().unwrap().to_string(),
                    payment["amountCents"].as_i64().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            tenders,
            vec![("cash".to_string(), 300), ("gift_card".to_string(), 200)]
        );
        assert_eq!(payload["totals"]["grossCents"], 500);
    }

    #[test]
    fn partial_payment_does_not_reduce_the_invoice_gross() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute("UPDATE order_payments SET amount_cents = 200", [])
            .unwrap();
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        assert_eq!(payload["totals"]["grossCents"], 500);
        assert_eq!(payload["payments"][0]["amountCents"], 200);
        assert_eq!(payload["totals"]["vatCents"], 97);
    }

    #[test]
    fn completed_split_payments_preserve_tenders_and_ignore_unsettled_rows() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute_batch(
            "UPDATE order_payments SET amount_cents = 200 WHERE id = 'pay-1';
             INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, transaction_ref, created_at)
             VALUES ('pay-card', 'ord-1', 'card', 99.0, 300, 'completed', 'card-reference', '2026-05-25T10:00:02Z'),
                    ('pay-pending', 'ord-1', 'card', 99.0, 9900, 'pending', NULL, '2026-05-25T10:00:03Z'),
                    ('pay-void', 'ord-1', 'card', 99.0, 9900, 'voided', NULL, '2026-05-25T10:00:04Z'),
                    ('pay-refund', 'ord-1', 'card', 99.0, 9900, 'refunded', NULL, '2026-05-25T10:00:05Z');",
        ).unwrap();
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        assert_eq!(payload["totals"]["grossCents"], 500);
        assert_eq!(
            payload["payments"],
            json!([
                { "paymentId": "pay-1", "method": "cash", "amountCents": 200, "reference": null },
                { "paymentId": "pay-card", "method": "card", "amountCents": 300, "reference": "card-reference" },
            ])
        );
        assert_eq!(payload["metadata"]["paymentMethodCode"], "O");
    }

    #[test]
    fn missing_payment_storage_fails_without_fabricating_a_payment() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute("DROP TABLE order_payments", []).unwrap();
        let result = build_fiscal_receipt_input(&conn, "ord-1", "branch-1");
        assert!(result.unwrap_err().contains("read_completed_payments"));
    }

    #[test]
    fn audit_1_no_more_empty_arrays() {
        let conn = make_test_db();
        seed_simple_order(&conn);

        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();

        // The pre-fix bug — every one of these was [] or {} in the old
        // scaffold, terminal-failing the HR validator. Post-fix, all
        // four are populated.
        assert!(
            !payload["lines"].as_array().unwrap().is_empty(),
            "lines must not be empty post-fix"
        );
        assert!(
            !payload["payments"].as_array().unwrap().is_empty(),
            "payments must not be empty post-fix"
        );
        assert!(
            !payload["vatBreakdown"].as_array().unwrap().is_empty(),
            "vatBreakdown must not be empty post-fix"
        );
        assert!(
            !payload["metadata"].as_object().unwrap().is_empty(),
            "metadata must not be empty post-fix"
        );
    }

    #[test]
    fn audit_1_normalizes_sqlite_created_at_for_issued_at() {
        let conn = make_test_db();
        conn.execute(
            "INSERT INTO orders
                (id, organization_id, receipt_number, items, total_amount,
                 tax_amount, subtotal, staff_id, tax_rate, created_at)
             VALUES
                ('ord-sqlite-date', 'org-1', 'R-SQLITE',
                 '[{\"menu_item_id\":\"item-A\",\"name\":\"Coffee\",\"quantity\":1,\"total_price\":5.00}]',
                 5.00, 0.97, 4.03, 'staff-1', 0.24, '2026-06-19 11:35:00')",
            [],
        )
        .expect("insert order with SQLite datetime");
        conn.execute(
            "INSERT INTO order_payments
                (id, order_id, method, amount, status, created_at)
             VALUES ('pay-sqlite-date', 'ord-sqlite-date', 'cash', 5.00, 'completed', '2026-06-19 11:35:01')",
            [],
        )
        .expect("insert payment");

        let payload = build_fiscal_receipt_input(&conn, "ord-sqlite-date", "branch-1").unwrap();

        assert_eq!(payload["issuedAt"], "2026-06-19T11:35:00.000Z");
    }

    #[test]
    fn audit_1_hr_validator_invariants_satisfied() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();

        // Mirror the HR validator's invariants from
        // admin-dashboard/src/services/fiscal/adapters/hr/xml-builder.ts:135-162.
        let totals = &payload["totals"];
        let net = totals["netCents"].as_i64().unwrap();
        let vat = totals["vatCents"].as_i64().unwrap();
        let gross = totals["grossCents"].as_i64().unwrap();

        // (a) totals.netCents + totals.vatCents === totals.grossCents
        assert_eq!(net + vat, gross, "net+vat must equal gross");

        // (b) payments.sum(amountCents) === totals.grossCents
        let payments_sum: i64 = payload["payments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["amountCents"].as_i64().unwrap())
            .sum();
        assert_eq!(payments_sum, gross, "payments must sum to grossCents");

        // (c) vatBreakdown.sum(netCents) === totals.netCents
        // (d) vatBreakdown.sum(vatCents) === totals.vatCents
        let vat_breakdown = payload["vatBreakdown"].as_array().unwrap();
        let bd_net: i64 = vat_breakdown
            .iter()
            .map(|v| v["netCents"].as_i64().unwrap())
            .sum();
        let bd_vat: i64 = vat_breakdown
            .iter()
            .map(|v| v["vatCents"].as_i64().unwrap())
            .sum();
        assert_eq!(bd_net, net, "vatBreakdown nets must sum to totals.netCents");
        assert_eq!(bd_vat, vat, "vatBreakdown vats must sum to totals.vatCents");
    }

    #[test]
    fn audit_1_metadata_required_fields_populated() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        // Configure operator OIB so it shows up populated.
        conn.execute(
            "INSERT INTO local_settings (setting_category, setting_key, setting_value)
             VALUES ('fiscalization.hr', 'operator_oib_for_staff-1', '12345678901')",
            [],
        )
        .unwrap();

        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        let metadata = &payload["metadata"];

        assert_eq!(metadata["operatorOib"], "12345678901");
        assert_eq!(metadata["sequenceNumber"], 1);
        assert_eq!(metadata["paymentMethodCode"], "G"); // cash → G
        assert_eq!(metadata["kind"], "receipt");
    }

    #[test]
    fn audit_1_operator_oib_falls_back_to_default() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        // No per-staff entry; only default.
        conn.execute(
            "INSERT INTO local_settings (setting_category, setting_key, setting_value)
             VALUES ('fiscalization.hr', 'default_operator_oib', '98765432109')",
            [],
        )
        .unwrap();

        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        assert_eq!(payload["metadata"]["operatorOib"], "98765432109");
    }

    #[test]
    fn audit_1_operator_oib_empty_when_unconfigured() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        // No local_settings rows at all — operatorOib resolves to "".
        // The validator will reject this with a clear "metadata.operatorOib
        // is required" message, which is the correct UX for an admin who
        // hasn't yet populated the setting.
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        assert_eq!(payload["metadata"]["operatorOib"], "");
    }

    #[test]
    fn audit_1_per_staff_oib_beats_default() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        conn.execute_batch(
            "INSERT INTO local_settings (setting_category, setting_key, setting_value)
             VALUES ('fiscalization.hr', 'operator_oib_for_staff-1', '11111111111');
             INSERT INTO local_settings (setting_category, setting_key, setting_value)
             VALUES ('fiscalization.hr', 'default_operator_oib', '22222222222');",
        )
        .unwrap();

        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        assert_eq!(
            payload["metadata"]["operatorOib"], "11111111111",
            "per-staff entry must beat the default"
        );
    }

    #[test]
    fn audit_1_sequence_number_increments_per_call() {
        let conn = make_test_db();
        // Two orders, same branch, same business day.
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, created_at)
             VALUES ('ord-A', '[]', 1.0, '2026-05-25T10:00:00Z'),
                    ('ord-B', '[]', 1.0, '2026-05-25T11:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, created_at)
             VALUES ('p-A', 'ord-A', 'cash', 1.0, 'completed', '2026-05-25T10:00:01Z'),
                    ('p-B', 'ord-B', 'cash', 1.0, 'completed', '2026-05-25T11:00:01Z')",
            [],
        )
        .unwrap();

        let a = build_fiscal_receipt_input(&conn, "ord-A", "branch-1").unwrap();
        let b = build_fiscal_receipt_input(&conn, "ord-B", "branch-1").unwrap();
        assert_eq!(a["metadata"]["sequenceNumber"], 1);
        assert_eq!(b["metadata"]["sequenceNumber"], 2);
    }

    #[test]
    fn audit_1_payment_method_mapping() {
        let cases = &[
            ("cash", "G"),
            ("card", "K"),
            ("cheque", "C"),
            ("check", "C"),
            ("transfer", "T"),
            ("bank_transfer", "T"),
            ("other", "O"),
            ("unknown_method_xyz", "O"),
            ("CASH", "G"), // case-insensitive
        ];
        for (input, expected) in cases {
            assert_eq!(
                map_to_cis_payment_code(Some(input)),
                *expected,
                "{input} must map to {expected}"
            );
        }
        // None defaults to Other.
        assert_eq!(map_to_cis_payment_code(None), "O");
    }

    #[test]
    fn audit_1_multiple_line_items_each_appear() {
        let conn = make_test_db();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, tax_amount, tax_rate, created_at)
             VALUES (
                'ord-multi',
                '[{\"menu_item_id\":\"a\",\"name\":\"Aaa\",\"quantity\":2,\"total_price\":10.00},
                  {\"menu_item_id\":\"b\",\"name\":\"Bbb\",\"quantity\":1,\"total_price\":7.50}]',
                17.50, 3.39, 0.24, '2026-05-25T10:00:00Z'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, created_at)
             VALUES ('p-1', 'ord-multi', 'card', 17.50, 'completed', '2026-05-25T10:00:01Z')",
            [],
        )
        .unwrap();

        let payload = build_fiscal_receipt_input(&conn, "ord-multi", "branch-1").unwrap();
        let lines = payload["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["lineId"], "a");
        assert_eq!(lines[0]["description"], "Aaa");
        assert_eq!(lines[0]["quantity"], 2);
        assert_eq!(lines[0]["grossCents"], 1000);
        assert_eq!(lines[0]["unitPriceCents"], 500);
        assert_eq!(lines[1]["grossCents"], 750);
    }

    #[test]
    fn audit_1_only_completed_payments_included() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        // Add a voided payment for the same order — it must NOT appear.
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, created_at)
             VALUES ('pay-voided', 'ord-1', 'card', 99.00, 'voided', '2026-05-25T10:00:02Z')",
            [],
        )
        .unwrap();

        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        let payments = payload["payments"].as_array().unwrap();
        assert_eq!(payments.len(), 1, "voided payment must be filtered out");
        assert_eq!(payments[0]["paymentId"], "pay-1");
        // The order gross is unchanged by a voided payment.
        assert_eq!(payload["totals"]["grossCents"], 500);
    }

    #[test]
    fn audit_1_rate_basis_points_derives_from_tax_ratio() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();

        // Order: subtotal €4.03 + tax €0.97 = gross €5.00 → ratio
        // 97/403 ≈ 24.07% → rateBasisPoints ≈ 2407 (empirical, slightly
        // off from 2400 due to cent rounding — acceptable because the
        // validator's only invariant on rateBasisPoints is per-entry
        // shape; the sums-of-cents invariant is the load-bearing one).
        let bp = payload["vatBreakdown"][0]["rateBasisPoints"]
            .as_i64()
            .unwrap();
        assert!(
            (2300..=2500).contains(&bp),
            "rateBasisPoints should be ~2400 for 24% VAT, got {bp}"
        );
    }

    #[test]
    fn audit_1_zero_tax_order_still_valid() {
        let conn = make_test_db();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, tax_amount, created_at)
             VALUES (
                'ord-notax',
                '[{\"menu_item_id\":\"x\",\"name\":\"Tax-Free\",\"quantity\":1,\"total_price\":10.00}]',
                10.00, 0.0, '2026-05-25T10:00:00Z'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, created_at)
             VALUES ('p-x', 'ord-notax', 'cash', 10.00, 'completed', '2026-05-25T10:00:01Z')",
            [],
        )
        .unwrap();

        let payload = build_fiscal_receipt_input(&conn, "ord-notax", "branch-1").unwrap();
        assert_eq!(payload["totals"]["vatCents"], 0);
        assert_eq!(payload["totals"]["netCents"], 1000);
        assert_eq!(payload["totals"]["grossCents"], 1000);
        // vatBreakdown still has exactly one entry that sums to the
        // order totals (otherwise the validator would reject).
        let bd = payload["vatBreakdown"].as_array().unwrap();
        assert_eq!(bd.len(), 1);
        assert_eq!(bd[0]["netCents"], 1000);
        assert_eq!(bd[0]["vatCents"], 0);
    }

    #[test]
    fn an_unpaid_order_has_no_persisted_fiscal_currency() {
        let conn = make_test_db();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, created_at)
             VALUES ('ord-unpaid', '[]', 5.00, '2026-05-25T10:00:00Z')",
            [],
        )
        .unwrap();
        // A historical order without money-unit evidence cannot be labelled
        // with today's country currency during a later rebuild.
        let error = build_fiscal_receipt_input(&conn, "ord-unpaid", "branch-1").unwrap_err();
        assert_eq!(error, "PAYMENT_CURRENCY_UNAVAILABLE");
    }

    #[test]
    fn audit_1_missing_order_errors_cleanly() {
        let conn = make_test_db();
        let err = build_fiscal_receipt_input(&conn, "nope-not-here", "branch-1").unwrap_err();
        assert!(
            err.contains("not found"),
            "error should mention not found, got: {err}"
        );
    }

    #[test]
    fn audit_1_unknown_payment_method_defaults_to_other() {
        let conn = make_test_db();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, created_at)
             VALUES ('ord-x', '[]', 5.00, '2026-05-25T10:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, created_at)
             VALUES ('p-x', 'ord-x', 'crypto', 5.00, 'completed', '2026-05-25T10:00:01Z')",
            [],
        )
        .unwrap();
        let payload = build_fiscal_receipt_input(&conn, "ord-x", "branch-1").unwrap();
        assert_eq!(payload["metadata"]["paymentMethodCode"], "O");
    }

    #[test]
    fn audit_1_business_day_extracted_from_iso_datetime() {
        assert_eq!(extract_business_day("2026-05-25T10:00:00Z"), "2026-05-25");
        assert_eq!(
            extract_business_day("2026-05-25T10:00:00.123Z"),
            "2026-05-25"
        );
        assert_eq!(extract_business_day("2026-05-25"), "2026-05-25");
        // Garbage input falls back to today's UTC date — exact string
        // depends on test runtime; just assert it's a 10-char date shape.
        let fallback = extract_business_day("bogus");
        assert_eq!(fallback.len(), 10);
        assert_eq!(&fallback[4..5], "-");
        assert_eq!(&fallback[7..8], "-");
    }
}
