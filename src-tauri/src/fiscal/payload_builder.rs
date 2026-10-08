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
//!   * **lines**       — the order's Greek VAT computation
//!     ([`super::greece_vat`], the server's `computeOrderTotals`) over the
//!     items, discount and delivery fee of the local order row, normalized as
//!     the create request sends them: one line per item (its share of the
//!     order discount already deducted) plus a delivery-fee and a service-fee
//!     line, each with its real net, VAT and gross (07/10/2026). The tip is
//!     outside VAT and is no line.
//!   * **totals**      — the sums of the lines: the order total without its
//!     tip.
//!   * **payments**    — `order_payments WHERE order_id=? AND status='completed'`,
//!     each tender without its tip (a tender's amount includes its tip, the
//!     `payments.rs` principal rule), so the payments settle the totals.
//!   * **vatBreakdown** — one entry per rate (`rateBasisPoints` = rate * 100),
//!     each the sum of its lines.
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
//!   * **Item categories** — the create request carries no per-item VAT
//!     category, so every item is at the branch default category, exactly as
//!     the server computes the order. A zero-rate line would also need an
//!     AADE exemption category, which no line carries yet.
//!   * **operatorOib via local_settings** — HR's per-cashier OIB is
//!     read from `local_settings(category='fiscalization.hr',
//!     key='operator_oib_for_<staff_id>')` with a fallback to
//!     `key='default_operator_oib'`. Admin must populate these via the
//!     existing settings-sync path. Missing both → empty string,
//!     validator returns terminal `payload_invalid: metadata.operatorOib
//!     is required` with a clear remediation message.
//!   * **Mobile parallel** — `POSSystemMobile/src/services/fiscal/`
//!     reads actual completed payment rows and populates the generic
//!     payload; its lines follow the same shared VAT computation.

use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::fiscal::greece_vat::{FiscalLineKind, GreeceOrderVatResult};
use crate::money::Cents;

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
    tip_cents: i64,
    items_json: String,
    staff_id: Option<String>,
    discount_amount: f64,
    discount_percentage: f64,
    delivery_fee: f64,
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
    let ReceiptTenders {
        rows: mut payments,
        carried_tip_cents,
    } = read_completed_payments(conn, order_id)?;

    // A partial settlement must never reduce the invoice to the paid amount.
    // Keep actual payments separate so adapter validation can detect a mismatch.
    let order_vat = order_vat_for_receipt(conn, &header);
    let lines = build_lines(order_vat.as_ref());
    let (net_cents, tax_cents, gross_cents) = match order_vat.as_ref() {
        Some(_) => lines
            .iter()
            .fold((0_i64, 0_i64, 0_i64), |(net, vat, gross), line| {
                (
                    net + line["netCents"].as_i64().unwrap_or(0),
                    vat + line["vatCents"].as_i64().unwrap_or(0),
                    gross + line["grossCents"].as_i64().unwrap_or(0),
                )
            }),
        // No lines to compute: the order total without its tip, VAT unknown.
        None => {
            let gross = (header.total_cents - header.tip_cents).max(0);
            (gross, 0, gross)
        }
    };
    let expected_gross_cents = (header.total_cents - header.tip_cents).max(0);
    if gross_cents != expected_gross_cents {
        tracing::warn!(
            order_id = %order_id,
            lines_gross_cents = gross_cents,
            order_gross_cents = expected_gross_cents,
            "[fiscal.payload] the computed lines differ from the order total without its tip"
        );
    }
    exclude_uncarried_order_tip(
        &mut payments,
        expected_gross_cents,
        header.tip_cents - carried_tip_cents,
    );

    let payments_json = build_payments_json(&payments);
    let vat_breakdown = build_vat_breakdown(&lines);

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
            tip_amount_cents, COALESCE(tip_amount, 0.0),
            COALESCE(items, '[]'),
            staff_id,
            discount_amount_cents, COALESCE(discount_amount, 0.0),
            COALESCE(discount_percentage, 0.0),
            delivery_fee_cents, COALESCE(delivery_fee, 0.0)
         FROM orders
         WHERE id = ?1",
        params![order_id],
        |row| {
            Ok(OrderHeader {
                organization_id: row.get(0)?,
                receipt_number: row.get(1)?,
                issued_at: row.get(2)?,
                total_cents: read_cents(row, 3, 4)?,
                tip_cents: read_cents(row, 5, 6)?,
                items_json: row.get(7)?,
                staff_id: row.get(8)?,
                discount_amount: Cents::new(read_cents(row, 9, 10)?).to_f64_dp2(),
                discount_percentage: row.get(11)?,
                delivery_fee: Cents::new(read_cents(row, 12, 13)?).to_f64_dp2(),
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

/// The order's VAT computation for its receipt: the local row's items,
/// discount and delivery fee as the create request sends them, with the
/// branch VAT settings the till holds. `None` when the order has no lines.
fn order_vat_for_receipt(conn: &Connection, header: &OrderHeader) -> Option<GreeceOrderVatResult> {
    let order = json!({
        "items": header.items_json,
        "discount_amount": header.discount_amount,
        "discount_percentage": header.discount_percentage,
        "delivery_fee": header.delivery_fee,
    });
    let settings = super::greece_vat::branch_vat_settings(conn);
    crate::sync_queue::order_json_vat(&order, &settings).ok()
}

/// The completed tenders as the receipt reads them.
struct ReceiptTenders {
    rows: Vec<PaymentRow>,
    /// The tips the tenders still carry, taken out of their amounts.
    carried_tip_cents: i64,
}

fn read_completed_payments(conn: &Connection, order_id: &str) -> Result<ReceiptTenders, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, method, amount_cents, amount, transaction_ref,
                    COALESCE((
                        SELECT SUM(CAST(ROUND(pa.amount * 100) AS INTEGER))
                        FROM payment_adjustments pa
                        WHERE pa.payment_id = order_payments.id
                          AND pa.adjustment_type IN ('refund', 'void')
                    ), 0),
                    MAX(COALESCE(tip_amount_cents, CAST(ROUND(tip_amount * 100) AS INTEGER), 0), 0)
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
            Ok((payment, row.get::<_, i64>(5)?, row.get::<_, i64>(6)?))
        })
        .map_err(|e| format!("query_map read_completed_payments: {e}"))?;

    let mut out = Vec::new();
    let mut carried_tip_cents = 0;
    for r in rows {
        let (mut payment, adjusted_cents, tip_cents) =
            r.map_err(|e| format!("read payment row: {e}"))?;
        // Refunds and voids recorded as adjustments are not tendered, nor is a
        // gift card row's proven return floor (the larger of the two, once).
        let reversed_cents = crate::payments::effective_reversed_cents(
            conn,
            &payment.id,
            order_id,
            &payment.method,
            payment.amount_cents,
            adjusted_cents,
        )?;
        let kept_cents = (payment.amount_cents - reversed_cents).max(0);
        // A tender's amount includes its tip (the principal rule of
        // `payments.rs`, a refund coming off the principal first). The tip is
        // no line and outside the totals, so the tender pays only its
        // principal (07/10/2026): the AADE and HR validators want the
        // payments equal to the receipt total.
        let tip_cents = tip_cents.min(kept_cents);
        carried_tip_cents += tip_cents;
        payment.amount_cents = kept_cents - tip_cents;
        // A tender refunded or voided in full, or all tip, is not part of the
        // receipt.
        if !((reversed_cents > 0 || tip_cents > 0) && payment.amount_cents == 0) {
            out.push(payment);
        }
    }
    Ok(ReceiptTenders {
        rows: out,
        carried_tip_cents,
    })
}

/// The part of the order's tip no tender carries (a tip recorded on the order
/// alone) is outside the receipt too: it comes off the latest tenders, never
/// below the order total without its tip.
fn exclude_uncarried_order_tip(
    payments: &mut Vec<PaymentRow>,
    receipt_total_cents: i64,
    uncarried_tip_cents: i64,
) {
    let paid_cents: i64 = payments.iter().map(|payment| payment.amount_cents).sum();
    let mut excess_cents = (paid_cents - receipt_total_cents)
        .min(uncarried_tip_cents)
        .max(0);
    let mut index = payments.len();
    while excess_cents > 0 && index > 0 {
        index -= 1;
        let taken_cents = excess_cents.min(payments[index].amount_cents);
        if taken_cents == 0 {
            continue;
        }
        payments[index].amount_cents -= taken_cents;
        excess_cents -= taken_cents;
        if payments[index].amount_cents == 0 {
            payments.remove(index);
        }
    }
}

/// rateBasisPoints encoding: 100% = 10000 (1 basis point = 1/10000 of unity).
/// Per `admin-dashboard/src/services/fiscal/adapters/hr/xml-builder.ts:250`,
/// the renderer divides by 100 + .toFixed(2), so 2400 → "24.00".
fn rate_basis_points(rate_percent: f64) -> i64 {
    (rate_percent * 100.0).round() as i64
}

/// One receipt line per item and per delivery or service fee, from the
/// order's VAT computation: net + VAT = gross on every line, and the VAT is
/// the line's own rate applied to its net (the AADE invoice validator's
/// per-line checks). The tip is outside VAT and is no line. Line ids are the
/// computation's (menu item, `manual-item-N`, `delivery-fee`), made unique
/// when one product appears on two lines.
fn build_lines(order_vat: Option<&GreeceOrderVatResult>) -> Vec<Value> {
    let Some(order_vat) = order_vat else {
        return Vec::new();
    };
    let mut seen_ids: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    order_vat
        .breakdown
        .lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.line_kind != FiscalLineKind::Tip)
        .map(|(index, line)| {
            let occurrence = seen_ids.entry(line.id.clone()).or_insert(0);
            *occurrence += 1;
            let line_id = if *occurrence == 1 {
                line.id.clone()
            } else {
                format!("{}#{}", line.id, occurrence)
            };
            let quantity = if line.quantity.fract() == 0.0 {
                json!(line.quantity as i64)
            } else {
                json!(line.quantity)
            };
            let unit_price_cents = if line.quantity > 0.0 {
                (line.gross_cents as f64 / line.quantity).round() as i64
            } else {
                line.gross_cents
            };
            json!({
                "lineId": line_id,
                "description": line
                    .description
                    .clone()
                    .unwrap_or_else(|| format!("Item {}", index + 1)),
                "quantity": quantity,
                "unitPriceCents": unit_price_cents,
                "netCents": line.net_cents,
                "vatCents": line.vat_cents,
                "grossCents": line.gross_cents,
                "rateBasisPoints": rate_basis_points(line.vat_rate),
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

/// One entry per rate, each the sum of its lines, highest rate first: the
/// AADE validator wants exactly the rates of the lines with their totals, and
/// the HR validator the entry sums equal to the receipt totals.
fn build_vat_breakdown(lines: &[Value]) -> Vec<Value> {
    let mut buckets: Vec<(i64, i64, i64, i64)> = Vec::new();
    for line in lines {
        let rate = line["rateBasisPoints"].as_i64().unwrap_or(0);
        let net = line["netCents"].as_i64().unwrap_or(0);
        let vat = line["vatCents"].as_i64().unwrap_or(0);
        let gross = line["grossCents"].as_i64().unwrap_or(0);
        match buckets.iter_mut().find(|bucket| bucket.0 == rate) {
            Some(bucket) => {
                bucket.1 += net;
                bucket.2 += vat;
                bucket.3 += gross;
            }
            None => buckets.push((rate, net, vat, gross)),
        }
    }
    buckets.sort_by(|left, right| right.0.cmp(&left.0));
    buckets
        .into_iter()
        .map(|(rate, net, vat, gross)| {
            json!({
                "rateBasisPoints": rate,
                "netCents": net,
                "vatCents": vat,
                "grossCents": gross,
            })
        })
        .collect()
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
                discount_percentage REAL DEFAULT 0,
                discount_amount REAL DEFAULT 0,
                discount_amount_cents INTEGER,
                tip_amount REAL DEFAULT 0,
                tip_amount_cents INTEGER,
                delivery_fee REAL DEFAULT 0,
                delivery_fee_cents INTEGER,
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
                tip_amount REAL DEFAULT 0,
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
        // A 7.00 tender with a 2.00 tip on top of the 5.00 order (a table
        // check keeps the order's tip at 0): the tender's amount includes its
        // tip, and the receipt tender is its 5.00 principal.
        conn.execute_batch(
            "UPDATE orders SET total_amount_cents = 500, tax_amount_cents = 97,
                 total_amount = 99.99, tax_amount = 9.99 WHERE id = 'ord-1';
             UPDATE order_payments SET amount_cents = 700, amount = 88.88,
                 tip_amount_cents = 200, transaction_ref = 'terminal-reference' WHERE id = 'pay-1';",
        ).unwrap();
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        assert_eq!(payload["totals"]["grossCents"], 500);
        assert_eq!(payload["totals"]["vatCents"], 97);
        assert_eq!(payload["totals"]["netCents"], 403);
        assert_eq!(payload["payments"][0]["amountCents"], 500);
        assert_eq!(payload["payments"][0]["reference"], "terminal-reference");
    }

    /// The shared vector `delivery_order_full`: three items, a 0.75 discount,
    /// a 1.80 delivery fee and a 1.00 tip inside the 24.65 total.
    fn seed_tipped_delivery(conn: &Connection) {
        conn.execute(
            "INSERT INTO orders
                (id, organization_id, receipt_number, items, total_amount, total_amount_cents,
                 tax_amount, tax_amount_cents, subtotal, discount_amount, discount_amount_cents,
                 delivery_fee, delivery_fee_cents, tip_amount, tip_amount_cents, staff_id,
                 created_at)
             VALUES
                ('ord-del', 'org-1', 'R-2001',
                 '[{\"menu_item_id\":\"a\",\"name\":\"Item a\",\"quantity\":1,\"unit_price\":8.5,\"total_price\":8.5},
                   {\"menu_item_id\":\"b\",\"name\":\"Item b\",\"quantity\":1,\"unit_price\":9.4,\"total_price\":9.4},
                   {\"menu_item_id\":\"c\",\"name\":\"Item c\",\"quantity\":2,\"unit_price\":2.35,\"total_price\":4.7}]',
                 24.65, 2465, 4.44, 444, 22.6, 0.75, 75, 1.8, 180, 1.0, 100, 'staff-1',
                 '2026-10-07T10:00:00Z')",
            [],
        )
        .expect("insert tipped delivery");
    }

    fn insert_tender(
        conn: &Connection,
        id: &str,
        method: &str,
        amount_cents: i64,
        tip_cents: i64,
        second: u32,
    ) {
        conn.execute(
            "INSERT INTO order_payments
                (id, order_id, method, amount, amount_cents, tip_amount, tip_amount_cents,
                 status, created_at)
             VALUES (?1, 'ord-del', ?2, ?3, ?4, ?5, ?6, 'completed', ?7)",
            params![
                id,
                method,
                amount_cents as f64 / 100.0,
                amount_cents,
                tip_cents as f64 / 100.0,
                tip_cents,
                format!("2026-10-07T10:00:{second:02}Z"),
            ],
        )
        .expect("insert tender");
    }

    /// The AADE invoice validator's checks
    /// (admin-dashboard/src/services/fiscal/adapters/gr/aade-invoice.ts).
    fn assert_aade_invariants(payload: &Value) {
        let lines = payload["lines"].as_array().unwrap();
        let (mut net, mut vat, mut gross) = (0, 0, 0);
        for line in lines {
            let (line_net, line_vat, line_gross, bps) = (
                line["netCents"].as_i64().unwrap(),
                line["vatCents"].as_i64().unwrap(),
                line["grossCents"].as_i64().unwrap(),
                line["rateBasisPoints"].as_i64().unwrap(),
            );
            assert_eq!(line_net + line_vat, line_gross, "{line}");
            let at_rate = (line_net as f64 * bps as f64 / 10_000.0).round() as i64;
            assert!((at_rate - line_vat).abs() <= 1, "{line}");
            net += line_net;
            vat += line_vat;
            gross += line_gross;
        }
        let totals = &payload["totals"];
        assert_eq!(
            (net, vat, gross),
            (
                totals["netCents"].as_i64().unwrap(),
                totals["vatCents"].as_i64().unwrap(),
                totals["grossCents"].as_i64().unwrap()
            )
        );
        for bucket in payload["vatBreakdown"].as_array().unwrap() {
            let rate = bucket["rateBasisPoints"].as_i64().unwrap();
            let of_rate = |key: &str| -> i64 {
                lines
                    .iter()
                    .filter(|line| line["rateBasisPoints"] == rate)
                    .map(|line| line[key].as_i64().unwrap())
                    .sum()
            };
            assert_eq!(bucket["netCents"], of_rate("netCents"));
            assert_eq!(bucket["vatCents"], of_rate("vatCents"));
            assert_eq!(bucket["grossCents"], of_rate("grossCents"));
        }
        let paid: i64 = payload["payments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|payment| {
                let amount = payment["amountCents"].as_i64().unwrap();
                assert!(amount > 0, "{payment}");
                amount
            })
            .sum();
        assert_eq!(paid, gross, "the payments equal the receipt total");
    }

    #[test]
    fn a_tipped_delivery_receipt_has_its_fee_line_and_settles_without_the_tip() {
        let conn = make_test_db();
        seed_tipped_delivery(&conn);
        // A desktop checkout: one card tender of the whole total, its tip inside.
        insert_tender(&conn, "card-1", "card", 2465, 100, 1);
        let payload = build_fiscal_receipt_input(&conn, "ord-del", "branch-1").unwrap();

        let lines = payload["lines"].as_array().unwrap();
        assert_eq!(
            lines.len(),
            4,
            "three items and the delivery fee, no tip line"
        );
        let fee = &lines[3];
        assert_eq!(fee["lineId"], "delivery-fee");
        assert_eq!(fee["rateBasisPoints"], 1300);
        assert_eq!(
            (&fee["netCents"], &fee["vatCents"], &fee["grossCents"]),
            (&json!(159), &json!(21), &json!(180))
        );
        assert_eq!(payload["totals"]["grossCents"], 2365);
        assert_eq!(payload["totals"]["vatCents"], 444);
        assert_eq!(payload["totals"]["netCents"], 1921);
        let rates: Vec<i64> = payload["vatBreakdown"]
            .as_array()
            .unwrap()
            .iter()
            .map(|bucket| bucket["rateBasisPoints"].as_i64().unwrap())
            .collect();
        assert_eq!(rates, vec![2400, 1300]);
        assert_eq!(payload["payments"][0]["amountCents"], 2365);
        assert_aade_invariants(&payload);
    }

    #[test]
    fn split_tenders_and_an_order_only_tip_still_settle_the_receipt_total() {
        // Cash without a tip, then the card carrying the tip.
        let conn = make_test_db();
        seed_tipped_delivery(&conn);
        insert_tender(&conn, "cash-1", "cash", 1000, 0, 1);
        insert_tender(&conn, "card-2", "card", 1465, 100, 2);
        let payload = build_fiscal_receipt_input(&conn, "ord-del", "branch-1").unwrap();
        let amounts: Vec<i64> = payload["payments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|payment| payment["amountCents"].as_i64().unwrap())
            .collect();
        assert_eq!(amounts, vec![1000, 1365]);
        assert_aade_invariants(&payload);

        // The tip recorded on the order alone: it comes off the latest tender.
        let conn = make_test_db();
        seed_tipped_delivery(&conn);
        insert_tender(&conn, "cash-1", "cash", 1000, 0, 1);
        insert_tender(&conn, "card-2", "card", 1465, 0, 2);
        let payload = build_fiscal_receipt_input(&conn, "ord-del", "branch-1").unwrap();
        let amounts: Vec<i64> = payload["payments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|payment| payment["amountCents"].as_i64().unwrap())
            .collect();
        assert_eq!(amounts, vec![1000, 1365]);
        assert_aade_invariants(&payload);

        // A tender that was all tip is no tender of the receipt.
        let conn = make_test_db();
        seed_tipped_delivery(&conn);
        insert_tender(&conn, "card-1", "card", 2365, 0, 1);
        insert_tender(&conn, "tip-2", "cash", 100, 100, 2);
        let payload = build_fiscal_receipt_input(&conn, "ord-del", "branch-1").unwrap();
        let amounts: Vec<i64> = payload["payments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|payment| payment["amountCents"].as_i64().unwrap())
            .collect();
        assert_eq!(amounts, vec![2365]);
        assert_aade_invariants(&payload);
    }

    #[test]
    fn stored_zero_cents_do_not_fall_back_to_legacy_amounts() {
        let conn = make_test_db();
        seed_simple_order(&conn);
        // A stale REAL discount, fee and tip behind zero cents: the cents win.
        conn.execute_batch(
            "UPDATE orders SET discount_amount = 2.0, discount_amount_cents = 0,
                 delivery_fee = 3.0, delivery_fee_cents = 0,
                 tip_amount = 1.0, tip_amount_cents = 0,
                 total_amount_cents = 500;
             UPDATE order_payments SET amount_cents = 0;",
        )
        .unwrap();
        let payload = build_fiscal_receipt_input(&conn, "ord-1", "branch-1").unwrap();
        assert_eq!(payload["totals"]["grossCents"], 500);
        assert_eq!(payload["totals"]["vatCents"], 97);
        assert_eq!(payload["lines"].as_array().unwrap().len(), 1, "no fee line");
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
                '[{\"menu_item_id\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"name\":\"Aaa\",\"quantity\":2,\"total_price\":10.00},
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
        // The server line ids: the menu item, else a manual line (a stale,
        // non-UUID reference is sent as no menu item).
        assert_eq!(lines[0]["lineId"], "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert_eq!(lines[1]["lineId"], "manual-item-2");
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

        // The computed rate itself, not the ratio of rounded cents
        // (97/403 used to give 2407): the AADE validator maps 2400 to its
        // VAT category 1 and refuses any other value.
        assert_eq!(payload["vatBreakdown"][0]["rateBasisPoints"], 2400);
        assert_eq!(payload["lines"][0]["rateBasisPoints"], 2400);
    }

    #[test]
    fn audit_1_zero_tax_order_still_valid() {
        let conn = make_test_db();
        // A branch whose default category carries no VAT.
        set_setting(&conn, "tax", "vat_default_category_code", "gr_exempt");
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
