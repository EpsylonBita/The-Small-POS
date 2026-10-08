//! Fiscal receipt data building and ESC/POS formatting.
//!
//! Converts order JSON data into structured fiscal receipt data for cash
//! registers, and can format simplified ESC/POS receipts for "POS sends
//! receipt" mode.

use crate::ecr::protocol::{FiscalLineItem, FiscalPayment, FiscalReceiptData, TaxRateConfig};
use crate::escpos::{EscPosBuilder, PaperWidth};
use crate::fiscal::greece_vat::{
    calculate_greece_order_vat, FiscalLineKind, GreeceOrderVatInput, GreeceOrderVatItem,
    GreeceVatSettings,
};
use tracing::debug;

/// What the cash register's lines need beyond the order JSON: the branch VAT
/// settings that give every line its rate, and the receipt language for the
/// delivery-fee line's description.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FiscalLineContext {
    pub vat_settings: GreeceVatSettings,
    pub language: String,
}

impl FiscalLineContext {
    /// Read the context under the caller's database lock.
    pub fn load(conn: &rusqlite::Connection) -> Self {
        Self {
            vat_settings: crate::fiscal::greece_vat::branch_vat_settings(conn),
            language: crate::db::get_setting(conn, "general", "language").unwrap_or_default(),
        }
    }
}

/// The device tax code of a VAT rate: the configured code of that rate, else
/// an unmapped code at that rate, which a register that needs a department
/// for it refuses (never another rate's code).
fn tax_code_for_rate(tax_rates: &[TaxRateConfig], rate: f64) -> TaxRateConfig {
    tax_rates
        .iter()
        .find(|tc| (tc.rate - rate).abs() < 0.01)
        .cloned()
        .unwrap_or(TaxRateConfig {
            code: "A".to_string(),
            rate,
            label: "Default".to_string(),
            department: None,
        })
}

fn str_field<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn f64_field(value: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(|v| v.as_f64()))
}

fn positive_cents(value: f64, field: &str) -> Result<i64, String> {
    if !value.is_finite() {
        return Err(format!("Invalid fiscal {field}: value must be finite"));
    }
    if value <= 0.0 {
        return Err(format!("Invalid fiscal {field}: value must be positive"));
    }
    Ok((value * 100.0).round() as i64)
}

fn optional_discount_cents(value: Option<f64>) -> Result<Option<i64>, String> {
    let Some(discount) = value else {
        return Ok(None);
    };
    if !discount.is_finite() {
        return Err("Invalid fiscal item discount: value must be finite".to_string());
    }
    if discount < 0.0 {
        return Err("Invalid fiscal item discount: value cannot be negative".to_string());
    }
    let cents = (discount * 100.0).round() as i64;
    Ok((cents > 0).then_some(cents))
}

/// Build fiscal receipt data from an order and its payments.
///
/// Every line carries its computed VAT rate (07/10/2026): the items at their
/// category rate (the branch default, as the server computes the order), the
/// order discount shared across the items as the server allocates it, and the
/// delivery fee as its own 13% line, described in the receipt language. The
/// tip carries no VAT and is no line. Each rate maps to the device code of
/// that rate; a register without that rate refuses the line rather than book
/// it at another rate. Payments are aggregated by method.
pub fn build_fiscal_data(
    order: &serde_json::Value,
    payments: &[serde_json::Value],
    tax_rates: &[TaxRateConfig],
    operator_id: Option<&str>,
    context: &FiscalLineContext,
) -> Result<FiscalReceiptData, String> {
    let items_arr = order
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or("Order has no 'items' array")?;
    if items_arr.is_empty() {
        return Err("Order has empty 'items' array".to_string());
    }

    struct RegisterItem {
        name: String,
        quantity: f64,
        unit_price: i64,
        own_discount: Option<i64>,
        menu_item_id: Option<String>,
    }
    let mut register_items = Vec::with_capacity(items_arr.len());
    for (index, item) in items_arr.iter().enumerate() {
        let name = str_field(item, &["name", "name_en", "product_name", "title"])
            .ok_or_else(|| format!("Fiscal item {index} is missing a non-empty name"))?;
        let qty = f64_field(item, &["quantity", "qty"])
            .ok_or_else(|| format!("Fiscal item {index} is missing quantity"))?;
        if !qty.is_finite() || qty <= 0.0 {
            return Err(format!(
                "Invalid fiscal item {index} quantity: value must be positive"
            ));
        }
        let price_f = f64_field(item, &["price", "unitPrice", "unit_price"])
            .or_else(|| f64_field(item, &["totalPrice", "total_price"]).map(|total| total / qty))
            .ok_or_else(|| format!("Fiscal item {index} is missing unit price"))?;
        let unit_price = positive_cents(price_f, &format!("item {index} unit price"))?;
        // Item-level discount
        let own_discount =
            optional_discount_cents(f64_field(item, &["discount", "discountAmount"]))?;
        register_items.push(RegisterItem {
            name: name.to_string(),
            quantity: qty,
            unit_price,
            own_discount,
            menu_item_id: str_field(item, &["menu_item_id", "menuItemId"]).map(str::to_string),
        });
    }

    // The order discount and delivery fee exactly as the server reads them
    // from this till's order body.
    let order_vat = crate::sync_queue::order_json_vat(order, &context.vat_settings).ok();
    let order_discount_cents = order_vat
        .as_ref()
        .map(|vat| vat.breakdown.total_discount_cents)
        .unwrap_or(0);
    let delivery_fee_cents: i64 = order_vat
        .as_ref()
        .map(|vat| {
            vat.breakdown
                .lines
                .iter()
                .filter(|line| line.line_kind == FiscalLineKind::DeliveryFee)
                .map(|line| line.gross_cents)
                .sum()
        })
        .unwrap_or(0);
    // The computed rate and discount share of each register line.
    let register_vat = calculate_greece_order_vat(&GreeceOrderVatInput {
        settings: context.vat_settings.clone(),
        items: register_items
            .iter()
            .map(|item| GreeceOrderVatItem {
                menu_item_id: item.menu_item_id.clone(),
                name: Some(item.name.clone()),
                quantity: item.quantity,
                unit_price: item.unit_price as f64 / 100.0,
                ..Default::default()
            })
            .collect(),
        discount_amount: Some(order_discount_cents as f64 / 100.0),
        delivery_fee: Some(delivery_fee_cents as f64 / 100.0),
        service_fee: None,
        tip_amount: None,
    });

    let mut fiscal_items = Vec::with_capacity(register_items.len() + 1);
    for (index, item) in register_items.into_iter().enumerate() {
        let line = &register_vat.breakdown.lines[index];
        let tax = tax_code_for_rate(tax_rates, line.vat_rate);
        let discount_cents = item.own_discount.unwrap_or(0) + line.discount_cents;
        fiscal_items.push(FiscalLineItem {
            description: item.name,
            quantity: item.quantity,
            unit_price: item.unit_price,
            tax_code: tax.code,
            tax_rate: tax.rate,
            department: tax.department,
            discount: (discount_cents > 0).then_some(discount_cents),
        });
    }
    for line in register_vat
        .breakdown
        .lines
        .iter()
        .filter(|line| line.line_kind == FiscalLineKind::DeliveryFee && line.gross_cents > 0)
    {
        let tax = tax_code_for_rate(tax_rates, line.vat_rate);
        fiscal_items.push(FiscalLineItem {
            description: crate::receipt_renderer::receipt_label(&context.language, "Delivery")
                .to_string(),
            quantity: 1.0,
            unit_price: line.gross_cents,
            tax_code: tax.code,
            tax_rate: tax.rate,
            department: tax.department,
            discount: None,
        });
    }

    // Build payment entries
    let mut fiscal_payments = Vec::new();
    for (index, payment) in payments.iter().enumerate() {
        let method = str_field(payment, &["method", "paymentMethod", "payment_method"])
            .ok_or_else(|| format!("Fiscal payment {index} is missing a method"))?
            .to_string();
        let amount_f = f64_field(payment, &["amount", "amountPaid", "amount_paid", "total"])
            .ok_or_else(|| format!("Fiscal payment {index} is missing amount"))?;
        let amount = positive_cents(amount_f, &format!("payment {index} amount"))?;

        fiscal_payments.push(FiscalPayment { method, amount });
    }

    // If no payments recorded, create a single "cash" payment for the total
    if fiscal_payments.is_empty() {
        let total_f = order
            .get("total_amount")
            .or_else(|| order.get("totalAmount"))
            .or_else(|| order.get("total"))
            .and_then(|v| v.as_f64())
            .ok_or("Order total is required when fiscal payments are empty")?;
        fiscal_payments.push(FiscalPayment {
            method: "cash".into(),
            amount: positive_cents(total_f, "fallback payment total")?,
        });
    }

    debug!(
        "Built fiscal data: {} items, {} payments",
        fiscal_items.len(),
        fiscal_payments.len()
    );

    Ok(FiscalReceiptData {
        items: fiscal_items,
        payments: fiscal_payments,
        operator_id: operator_id.map(|s| s.to_string()),
        receipt_comment: None,
    })
}

/// Build a fiscal receipt for an atomic checkout before the payment row exists.
///
/// The intended payment is explicit so a card checkout can never silently
/// fall back to cash while the fiscal device is waiting on its paired EFT POS.
pub fn build_fiscal_data_for_checkout(
    order: &serde_json::Value,
    intended_payment: &serde_json::Value,
    tax_rates: &[TaxRateConfig],
    operator_id: Option<&str>,
    context: &FiscalLineContext,
) -> Result<FiscalReceiptData, String> {
    build_fiscal_data(
        order,
        std::slice::from_ref(intended_payment),
        tax_rates,
        operator_id,
        context,
    )
}

fn normalize_fiscal_payment_method(raw: &str) -> Result<&'static str, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "cash" => Ok("cash"),
        "card" | "credit" | "debit" => Ok("card"),
        other => Err(format!(
            "Unsupported fiscal payment method for outstanding checkout: {other}"
        )),
    }
}

/// Stored prior tenders may include canonical gift card payments. They stay a
/// typed `gift_card` tender that the fiscal adapter maps to the register's
/// voucher payment, never cash or card. A gift card is never the intended
/// tender collected by a checkout.
fn normalize_prior_fiscal_payment_method(raw: &str) -> Result<&'static str, String> {
    if raw.trim().eq_ignore_ascii_case("gift_card") {
        return Ok("gift_card");
    }
    normalize_fiscal_payment_method(raw)
}

/// Build the final fiscal receipt when one or more earlier split tenders are
/// already stored. Prior rows contribute their refund-net tender amounts, and
/// the new intended payment remains explicit so only that outstanding card
/// amount is sent through paired EFT processing.
pub fn build_fiscal_data_for_outstanding_checkout(
    order: &serde_json::Value,
    completed_payments: &[serde_json::Value],
    intended_payment: &serde_json::Value,
    tax_rates: &[TaxRateConfig],
    operator_id: Option<&str>,
    context: &FiscalLineContext,
) -> Result<FiscalReceiptData, String> {
    let mut prior_cash_cents = 0_i64;
    let mut prior_card_cents = 0_i64;
    let mut prior_gift_cents = 0_i64;
    for (index, payment) in completed_payments.iter().enumerate() {
        if payment.get("status").and_then(|value| value.as_str()) != Some("completed") {
            continue;
        }
        let raw_method = str_field(payment, &["method", "paymentMethod", "payment_method"])
            .ok_or_else(|| format!("Fiscal payment {index} is missing a method"))?;
        let method = normalize_prior_fiscal_payment_method(raw_method)?;
        let amount = f64_field(payment, &["remainingRefundable", "remaining_refundable"])
            .or_else(|| {
                let gross = f64_field(payment, &["amount", "amountPaid", "amount_paid"])?;
                let refunded =
                    f64_field(payment, &["refundedAmount", "refunded_amount"]).unwrap_or(0.0);
                Some((gross - refunded).max(0.0))
            })
            .ok_or_else(|| format!("Fiscal payment {index} is missing amount"))?;
        if !amount.is_finite() || amount < 0.0 {
            return Err(format!("Fiscal payment {index} has an invalid net amount"));
        }
        let amount_cents = (amount * 100.0).round() as i64;
        match method {
            "cash" => prior_cash_cents += amount_cents,
            "card" => prior_card_cents += amount_cents,
            "gift_card" => prior_gift_cents += amount_cents,
            _ => unreachable!("normalized fiscal method"),
        }
    }

    // CAP Driver uses every card tender in the fiscal receipt to initiate its
    // paired EFT sale. A previously approved card must therefore never be
    // replayed through this final outstanding collection.
    if prior_card_cents > 0 {
        return Err(
            "Outstanding fiscal checkout cannot replay a previously approved card tender"
                .to_string(),
        );
    }

    let intended_method = str_field(
        intended_payment,
        &["method", "paymentMethod", "payment_method"],
    )
    .ok_or("Intended outstanding payment is missing a method")?;
    let intended_amount = f64_field(
        intended_payment,
        &["amount", "amountPaid", "amount_paid", "total"],
    )
    .ok_or("Intended outstanding payment is missing amount")?;
    let intended_method = normalize_fiscal_payment_method(intended_method)?;
    let intended_amount_cents = positive_cents(intended_amount, "intended outstanding payment")?;
    let mut cash_cents = prior_cash_cents;
    let mut card_cents = 0_i64;
    match intended_method {
        "cash" => cash_cents += intended_amount_cents,
        "card" => card_cents = intended_amount_cents,
        _ => unreachable!("normalized fiscal method"),
    }

    let mut tenders = Vec::with_capacity(3);
    if cash_cents > 0 {
        tenders.push(serde_json::json!({
            "method": "cash",
            "amount": cash_cents as f64 / 100.0,
        }));
    }
    if card_cents > 0 {
        tenders.push(serde_json::json!({
            "method": "card",
            "amount": card_cents as f64 / 100.0,
        }));
    }
    if prior_gift_cents > 0 {
        tenders.push(serde_json::json!({
            "method": "gift_card",
            "amount": prior_gift_cents as f64 / 100.0,
        }));
    }

    let order_total = f64_field(order, &["total_amount", "totalAmount", "total"])
        .ok_or("Order total is required for outstanding fiscal checkout")?;
    let order_total_cents = positive_cents(order_total, "order total")?;
    let tender_total_cents = tenders.iter().try_fold(0_i64, |sum, tender| {
        let amount = f64_field(tender, &["amount"]).ok_or("Fiscal tender is missing amount")?;
        positive_cents(amount, "outstanding tender").map(|cents| sum + cents)
    })?;
    if tender_total_cents != order_total_cents {
        return Err(format!(
            "Outstanding fiscal tenders {}.{:02} do not match order total {}.{:02}",
            tender_total_cents / 100,
            tender_total_cents.unsigned_abs() % 100,
            order_total_cents / 100,
            order_total_cents.unsigned_abs() % 100,
        ));
    }

    build_fiscal_data(order, &tenders, tax_rates, operator_id, context)
}

/// Build the one fiscal receipt of an order whose tenders are all already
/// settled: the canonical gift card payment plus any cash already booked.
/// Nothing is collected here. Every row contributes its refund-net amount, a
/// positive-net card tender is refused (CAP would start a second EFT sale for
/// it), and net cash plus net gift must cover the whole order total exactly.
pub fn build_fiscal_data_for_settled_gift_checkout(
    order: &serde_json::Value,
    completed_payments: &[serde_json::Value],
    tax_rates: &[TaxRateConfig],
    operator_id: Option<&str>,
    context: &FiscalLineContext,
) -> Result<FiscalReceiptData, String> {
    let mut cash_cents = 0_i64;
    let mut gift_cents = 0_i64;
    for (index, payment) in completed_payments.iter().enumerate() {
        if payment.get("status").and_then(|value| value.as_str()) != Some("completed") {
            continue;
        }
        let raw_method = str_field(payment, &["method", "paymentMethod", "payment_method"])
            .ok_or_else(|| format!("Fiscal payment {index} is missing a method"))?;
        let method = normalize_prior_fiscal_payment_method(raw_method)?;
        let net = f64_field(payment, &["remainingRefundable", "remaining_refundable"])
            .or_else(|| {
                let gross = f64_field(payment, &["amount", "amountPaid", "amount_paid"])?;
                let refunded =
                    f64_field(payment, &["refundedAmount", "refunded_amount"]).unwrap_or(0.0);
                Some(gross - refunded)
            })
            .ok_or_else(|| format!("Fiscal payment {index} is missing amount"))?;
        let scaled = net * 100.0;
        if !scaled.is_finite() || scaled < -0.000_001 || (scaled - scaled.round()).abs() > 0.000_001
        {
            return Err(format!(
                "Fiscal payment {index} has no whole-cent net amount"
            ));
        }
        let cents = scaled.round() as i64;
        match method {
            "cash" => cash_cents += cents,
            "gift_card" => gift_cents += cents,
            "card" if cents > 0 => {
                return Err(
                    "A settled gift card receipt cannot carry an already approved card tender"
                        .to_string(),
                )
            }
            "card" => {}
            other => {
                return Err(format!(
                    "A {other} tender cannot be carried by a settled gift card receipt"
                ))
            }
        }
    }
    if gift_cents <= 0 {
        return Err("The order has no settled gift card tender".to_string());
    }
    let order_total = f64_field(order, &["total_amount", "totalAmount", "total"])
        .ok_or("Order total is required for a settled gift card receipt")?;
    let order_total_cents = positive_cents(order_total, "order total")?;
    let covered_cents = cash_cents + gift_cents;
    if covered_cents != order_total_cents {
        return Err(format!(
            "Settled tenders {}.{:02} do not match order total {}.{:02}; a fiscal receipt needs full coverage",
            covered_cents / 100,
            covered_cents.unsigned_abs() % 100,
            order_total_cents / 100,
            order_total_cents.unsigned_abs() % 100,
        ));
    }
    let mut tenders = Vec::with_capacity(2);
    if cash_cents > 0 {
        tenders.push(serde_json::json!({
            "method": "cash",
            "amount": cash_cents as f64 / 100.0,
        }));
    }
    tenders.push(serde_json::json!({
        "method": "gift_card",
        "amount": gift_cents as f64 / 100.0,
    }));
    build_fiscal_data(order, &tenders, tax_rates, operator_id, context)
}

/// Format fiscal receipt data as ESC/POS binary for direct printing.
///
/// Used when `print_mode` is `"pos_sends_receipt"` — the POS builds and sends
/// the complete receipt to the cash register's printer.
pub fn format_fiscal_receipt_escpos(
    data: &FiscalReceiptData,
    paper_width: PaperWidth,
    greek: bool,
) -> Vec<u8> {
    let mut b = EscPosBuilder::new().with_paper(paper_width);
    if greek {
        b = b.with_greek();
    }

    b.init();
    b.center();
    b.bold(true);
    b.text_size(2, 2);
    b.text("RECEIPT");
    b.text_size(1, 1);
    b.bold(false);
    b.feed(1);
    b.left();
    b.separator();
    b.feed(1);

    // Items
    let mut subtotal: i64 = 0;
    for item in &data.items {
        let total = (item.unit_price as f64 * item.quantity).round() as i64;
        let name = if item.quantity != 1.0 {
            format!("{} x{:.0}", item.description, item.quantity)
        } else {
            item.description.clone()
        };
        let price = format_price(total);
        b.line_pair(&name, &price);

        if let Some(disc) = item.discount {
            let disc_str = format!("  Discount: -{}", format_price(disc));
            b.text(&disc_str);
            subtotal += total - disc;
        } else {
            subtotal += total;
        }
    }

    b.separator();

    // Subtotal
    b.bold(true);
    b.line_pair("SUBTOTAL", &format_price(subtotal));
    b.bold(false);
    b.feed(1);

    // Payments
    for payment in &data.payments {
        let label = match payment.method.as_str() {
            "cash" => "Cash",
            "card" => "Card",
            "credit" => "Credit",
            _ => &payment.method,
        };
        b.line_pair(label, &format_price(payment.amount));
    }

    // Change (if cash exceeds subtotal)
    let total_paid: i64 = data.payments.iter().map(|p| p.amount).sum();
    if total_paid > subtotal {
        let change = total_paid - subtotal;
        b.line_pair("Change", &format_price(change));
    }

    b.separator();

    // Operator
    if let Some(ref op) = data.operator_id {
        b.text(&format!("Operator: {op}"));
    }

    // Timestamp
    let now = chrono::Local::now().format("%d/%m/%Y %H:%M").to_string();
    b.text(&now);

    b.feed(3);
    b.cut();

    b.build()
}

/// Format cents as a price string (e.g. 1250 → "12.50").
fn format_price(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> FiscalLineContext {
        FiscalLineContext::default()
    }

    fn sample_tax_rates() -> Vec<TaxRateConfig> {
        vec![
            TaxRateConfig {
                code: "A".into(),
                rate: 24.0,
                label: "Standard".into(),
                department: Some(3),
            },
            TaxRateConfig {
                code: "B".into(),
                rate: 13.0,
                label: "Reduced".into(),
                department: Some(2),
            },
            TaxRateConfig {
                code: "C".into(),
                rate: 6.0,
                label: "Super-reduced".into(),
                department: Some(1),
            },
        ]
    }

    #[test]
    fn settled_gift_checkout_uses_actual_net_rows_and_full_coverage_only() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 20.00, "taxRate": 24.0}],
            "total_amount": 20.00
        });
        let tenders = |data: &FiscalReceiptData| {
            data.payments
                .iter()
                .map(|payment| (payment.method.clone(), payment.amount))
                .collect::<Vec<_>>()
        };
        let build = |rows: &[serde_json::Value]| {
            build_fiscal_data_for_settled_gift_checkout(
                &order,
                rows,
                &sample_tax_rates(),
                None,
                &ctx(),
            )
        };

        let full = build(&[json!({"method": "gift_card", "amount": 20.00, "status": "completed"})])
            .unwrap();
        assert_eq!(tenders(&full), vec![("gift_card".to_string(), 2000)]);

        let mixed = build(&[
            json!({"method": "gift_card", "amount": 10.00, "status": "completed"}),
            json!({"method": "cash", "amount": 15.00, "refundedAmount": 5.00, "status": "completed"}),
            json!({"method": "cash", "amount": 9.00, "status": "voided"}),
        ])
        .unwrap();
        assert_eq!(
            tenders(&mixed),
            vec![("cash".to_string(), 1000), ("gift_card".to_string(), 1000)]
        );

        // A fully refunded card is not a tender; a live card is refused.
        assert!(build(&[
            json!({"method": "gift_card", "amount": 20.00, "status": "completed"}),
            json!({"method": "card", "amount": 5.00, "refundedAmount": 5.00, "status": "completed"}),
        ])
        .is_ok());
        let card = build(&[
            json!({"method": "gift_card", "amount": 10.00, "status": "completed"}),
            json!({"method": "card", "amount": 10.00, "status": "completed"}),
        ])
        .unwrap_err();
        assert!(card.contains("card tender"), "{card}");

        // Partial coverage, no gift and fractional cents invent nothing.
        let partial =
            build(&[json!({"method": "gift_card", "amount": 10.00, "status": "completed"})])
                .unwrap_err();
        assert!(partial.contains("full coverage"), "{partial}");
        assert!(
            build(&[json!({"method": "cash", "amount": 20.00, "status": "completed"})])
                .unwrap_err()
                .contains("no settled gift")
        );
        assert!(
            build(&[json!({"method": "gift_card", "amount": 19.995, "status": "completed"})])
                .unwrap_err()
                .contains("whole-cent")
        );
    }

    #[test]
    fn test_build_fiscal_data_basic() {
        let order = json!({
            "items": [
                {"name": "Coffee", "quantity": 2, "price": 3.50, "taxRate": 24.0},
                {"name": "Croissant", "quantity": 1, "price": 2.00, "taxRate": 13.0}
            ],
            "total_amount": 9.00
        });
        let payments = vec![json!({"method": "cash", "amount": 9.00})];

        let data =
            build_fiscal_data(&order, &payments, &sample_tax_rates(), Some("1"), &ctx()).unwrap();

        assert_eq!(data.items.len(), 2);
        assert_eq!(data.items[0].description, "Coffee");
        assert_eq!(data.items[0].quantity, 2.0);
        assert_eq!(data.items[0].unit_price, 350);
        // Every line carries its computed rate: the branch default category
        // (24% mainland), as the server computes the order. A renderer
        // `taxRate` on an item is no VAT source.
        assert_eq!(data.items[0].tax_code, "A");
        assert_eq!(data.items[1].tax_code, "A");
        assert_eq!(data.items[1].tax_rate, 24.0);
        assert_eq!(data.payments.len(), 1);
        assert_eq!(data.payments[0].amount, 900);
        assert_eq!(data.operator_id, Some("1".into()));
    }

    #[test]
    fn test_build_fiscal_data_no_payments_uses_total() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 5.00}],
            "total_amount": 5.00
        });
        let data = build_fiscal_data(&order, &[], &sample_tax_rates(), None, &ctx()).unwrap();
        assert_eq!(data.payments.len(), 1);
        assert_eq!(data.payments[0].method, "cash");
        assert_eq!(data.payments[0].amount, 500);
    }

    #[test]
    fn checkout_builder_uses_the_intended_card_payment_before_it_is_persisted() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 5.00}],
            "total_amount": 5.00
        });
        let intended_payment = json!({"method": "card", "amount": 5.00});

        let data = build_fiscal_data_for_checkout(
            &order,
            &intended_payment,
            &sample_tax_rates(),
            None,
            &ctx(),
        )
        .unwrap();

        assert_eq!(data.payments.len(), 1);
        assert_eq!(data.payments[0].method, "card");
        assert_eq!(data.payments[0].amount, 500);
    }

    #[test]
    fn outstanding_checkout_carries_a_prior_gift_card_as_its_own_tender() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 50.00}],
            "total_amount": 50.00
        });
        let prior = vec![json!({"method": "gift_card", "amount": 20.00, "status": "completed"})];
        let data = build_fiscal_data_for_outstanding_checkout(
            &order,
            &prior,
            &json!({"method": "cash", "amount": 30.00}),
            &sample_tax_rates(),
            None,
            &ctx(),
        )
        .unwrap();
        let tenders: Vec<(String, i64)> = data
            .payments
            .iter()
            .map(|payment| (payment.method.clone(), payment.amount as i64))
            .collect();
        assert_eq!(
            tenders,
            vec![("cash".to_string(), 3000), ("gift_card".to_string(), 2000)]
        );

        // A gift card is never the tender a checkout collects.
        assert!(build_fiscal_data_for_outstanding_checkout(
            &order,
            &[],
            &json!({"method": "gift_card", "amount": 50.00}),
            &sample_tax_rates(),
            None,
            &ctx(),
        )
        .is_err());
    }

    #[test]
    fn outstanding_card_remainder_after_a_partial_gift_charges_only_the_remainder() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 50.00}],
            "total_amount": 50.00
        });
        let prior = vec![json!({"method": "gift_card", "amount": 20.00, "status": "completed"})];
        let data = build_fiscal_data_for_outstanding_checkout(
            &order,
            &prior,
            &json!({"method": "card", "amount": 30.00}),
            &sample_tax_rates(),
            None,
            &ctx(),
        )
        .unwrap();
        let mut tenders: Vec<(String, i64)> = data
            .payments
            .iter()
            .map(|payment| (payment.method.clone(), payment.amount as i64))
            .collect();
        tenders.sort();
        assert_eq!(
            tenders,
            vec![("card".to_string(), 3000), ("gift_card".to_string(), 2000)]
        );
    }

    #[test]
    fn outstanding_checkout_builder_combines_prior_net_tenders_with_the_new_card() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 50.00}],
            "total_amount": 50.00
        });
        let prior_payments = vec![json!({
            "method": "cash",
            "amount": 20.00,
            "refundedAmount": 0.00,
            "status": "completed"
        })];
        let intended_payment = json!({"method": "card", "amount": 30.00});

        let data = build_fiscal_data_for_outstanding_checkout(
            &order,
            &prior_payments,
            &intended_payment,
            &sample_tax_rates(),
            None,
            &ctx(),
        )
        .expect("build final split tender fiscal data");

        assert_eq!(data.payments.len(), 2);
        assert_eq!(data.payments[0].method, "cash");
        assert_eq!(data.payments[0].amount, 2000);
        assert_eq!(data.payments[1].method, "card");
        assert_eq!(data.payments[1].amount, 3000);
    }

    #[test]
    fn outstanding_checkout_builder_uses_refund_net_and_rejects_tender_mismatch() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 50.00}],
            "total_amount": 50.00
        });
        let prior_payments = vec![json!({
            "method": "cash",
            "amount": 25.00,
            "refundedAmount": 5.00,
            "remainingRefundable": 20.00,
            "status": "completed"
        })];

        let data = build_fiscal_data_for_outstanding_checkout(
            &order,
            &prior_payments,
            &json!({"method": "card", "amount": 30.00}),
            &sample_tax_rates(),
            None,
            &ctx(),
        )
        .expect("net prior tender plus new tender matches total");
        assert_eq!(data.payments[0].amount, 2000);
        assert_eq!(data.payments[1].amount, 3000);

        let error = build_fiscal_data_for_outstanding_checkout(
            &order,
            &prior_payments,
            &json!({"method": "card", "amount": 29.00}),
            &sample_tax_rates(),
            None,
            &ctx(),
        )
        .expect_err("combined tenders must equal the order total exactly");
        assert_eq!(
            error,
            "Outstanding fiscal tenders 49.00 do not match order total 50.00"
        );
    }

    #[test]
    fn outstanding_checkout_builder_aggregates_repeated_prior_tender_methods() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 50.00}],
            "total_amount": 50.00
        });
        let prior_payments = vec![
            json!({"method": "cash", "amount": 10.00, "status": "completed"}),
            json!({"method": "cash", "amount": 10.00, "status": "completed"}),
        ];

        let data = build_fiscal_data_for_outstanding_checkout(
            &order,
            &prior_payments,
            &json!({"method": "card", "amount": 30.00}),
            &sample_tax_rates(),
            None,
            &ctx(),
        )
        .expect("repeated prior cash rows must collapse into one fiscal tender");

        assert_eq!(data.payments.len(), 2);
        assert_eq!(data.payments[0].method, "cash");
        assert_eq!(data.payments[0].amount, 2000);
        assert_eq!(data.payments[1].method, "card");
        assert_eq!(data.payments[1].amount, 3000);
    }

    #[test]
    fn outstanding_checkout_rejects_prior_card_that_the_cashier_would_charge_again() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 50.00}],
            "total_amount": 50.00
        });
        let error = build_fiscal_data_for_outstanding_checkout(
            &order,
            &[json!({"method": "card", "amount": 20.00, "status": "completed"})],
            &json!({"method": "cash", "amount": 30.00}),
            &sample_tax_rates(),
            None,
            &ctx(),
        )
        .expect_err("a prior approved card must never be sent to paired EFT again");

        assert_eq!(
            error,
            "Outstanding fiscal checkout cannot replay a previously approved card tender"
        );
    }

    #[test]
    fn test_build_fiscal_data_discount() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 10.00, "discount": 2.50}],
            "total_amount": 7.50
        });
        let payments = vec![json!({"method": "card", "amount": 7.50})];
        let data = build_fiscal_data(&order, &payments, &sample_tax_rates(), None, &ctx()).unwrap();
        assert_eq!(data.items[0].discount, Some(250));
    }

    #[test]
    fn test_build_fiscal_data_no_items_errors() {
        let order = json!({"total_amount": 5.00});
        let result = build_fiscal_data(&order, &[], &sample_tax_rates(), None, &ctx());
        assert!(result.is_err());
    }

    #[test]
    fn test_build_fiscal_data_rejects_malformed_item() {
        let order = json!({
            "items": [{"quantity": 1, "price": 5.00}],
            "total_amount": 5.00
        });
        let result = build_fiscal_data(&order, &[], &sample_tax_rates(), None, &ctx());
        assert!(result.unwrap_err().contains("missing a non-empty name"));
    }

    #[test]
    fn test_build_fiscal_data_rejects_malformed_payment() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 5.00}],
            "total_amount": 5.00
        });
        let payments = vec![json!({"method": "card", "amount": 0.0})];
        let result = build_fiscal_data(&order, &payments, &sample_tax_rates(), None, &ctx());
        assert!(result.unwrap_err().contains("must be positive"));
    }

    #[test]
    fn every_line_carries_its_computed_rate_and_the_delivery_fee_is_a_13_percent_line() {
        let order = json!({
            "items": [
                {"name": "Crepe", "quantity": 1, "price": 8.50},
                {"name": "Waffle", "quantity": 1, "price": 9.40},
                {"name": "Juice", "quantity": 2, "price": 2.35}
            ],
            "discount_amount": 0.75,
            "delivery_fee": 1.80,
            "tip_amount": 1.00,
            "total_amount": 24.65
        });
        let context = FiscalLineContext {
            vat_settings: GreeceVatSettings::default(),
            language: "el".into(),
        };
        // The register is paid what it lists (the tip stays off the receipt).
        let payments = vec![json!({"method": "cash", "amount": 23.65})];
        let data =
            build_fiscal_data(&order, &payments, &sample_tax_rates(), None, &context).unwrap();

        assert_eq!(
            data.items.len(),
            4,
            "three items and the delivery fee, no tip"
        );
        for item in &data.items[..3] {
            assert_eq!((item.tax_code.as_str(), item.tax_rate), ("A", 24.0));
            assert_eq!(item.department, Some(3));
        }
        let fee = &data.items[3];
        assert_eq!(
            fee.description,
            "\u{039C}\u{03B5}\u{03C4}\u{03B1}\u{03C6}\u{03BF}\u{03C1}\u{03B9}\u{03BA}\u{03AC}"
        );
        assert_eq!((fee.tax_code.as_str(), fee.tax_rate), ("B", 13.0));
        assert_eq!(
            (fee.quantity, fee.unit_price, fee.discount),
            (1.0, 180, None)
        );
        // The 0.75 discount is shared as the server allocates it (the shared
        // vector `delivery_order_full`: 28/31/16 cents).
        let shares: Vec<Option<i64>> = data.items[..3].iter().map(|item| item.discount).collect();
        assert_eq!(shares, vec![Some(28), Some(31), Some(16)]);
        let receipt_total: i64 = data
            .items
            .iter()
            .map(|item| {
                (item.quantity * item.unit_price as f64).round() as i64 - item.discount.unwrap_or(0)
            })
            .sum();
        assert_eq!(
            receipt_total, 2365,
            "items - discount + fee, the total without its tip"
        );
        assert_eq!(data.payments[0].amount, 2365);
    }

    #[test]
    fn delivery_fee_description_follows_the_receipt_language() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 10.00}],
            "deliveryFee": 2.00,
            "totalAmount": 12.00
        });
        for (language, expected) in [
            ("en", "Delivery"),
            ("de", "Lieferung"),
            ("fr", "Livraison"),
            ("it", "Consegna"),
            ("sq", "D\u{00EB}rgesa"),
        ] {
            let context = FiscalLineContext {
                vat_settings: GreeceVatSettings::default(),
                language: language.into(),
            };
            let data = build_fiscal_data(&order, &[], &sample_tax_rates(), None, &context).unwrap();
            assert_eq!(data.items[1].description, expected, "{language}");
        }
    }

    #[test]
    fn island_branch_lines_carry_the_island_rate_and_an_unprogrammed_rate_is_refused() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 11.70}],
            "total_amount": 11.70
        });
        let context = FiscalLineContext {
            vat_settings: GreeceVatSettings {
                default_vat_category_code: Some("gr_island_reduced_17".into()),
                vat_region_profile: Some("islands_reduced".into()),
            },
            language: "el".into(),
        };
        let data = build_fiscal_data(&order, &[], &sample_tax_rates(), None, &context).unwrap();
        // The register has no 17% code: the line keeps its 17% and no
        // department, which a department register refuses, rather than
        // being booked at the first configured rate as before.
        assert_eq!(data.items[0].tax_rate, 17.0);
        assert_eq!(data.items[0].department, None);
        let mut rates = sample_tax_rates();
        rates.push(TaxRateConfig {
            code: "E".into(),
            rate: 17.0,
            label: "Island".into(),
            department: Some(5),
        });
        let data = build_fiscal_data(&order, &[], &rates, None, &context).unwrap();
        assert_eq!(
            (data.items[0].tax_code.as_str(), data.items[0].department),
            ("E", Some(5))
        );
    }

    #[test]
    fn a_pickup_order_without_fee_or_discount_keeps_its_lines() {
        // Tomikro-like pickup: one line per item, nothing added.
        let order = json!({
            "items": [{"name": "Crepe", "quantity": 2, "price": 6.50}],
            "totalAmount": 13.00,
            "taxAmount": 2.52
        });
        let data = build_fiscal_data(&order, &[], &sample_tax_rates(), None, &ctx()).unwrap();
        assert_eq!(data.items.len(), 1);
        assert_eq!(data.items[0].discount, None);
        assert_eq!(data.payments[0].amount, 1300);
    }

    #[test]
    fn test_format_price() {
        assert_eq!(format_price(1250), "12.50");
        assert_eq!(format_price(0), "0.00");
        assert_eq!(format_price(99), "0.99");
        assert_eq!(format_price(-500), "-5.00");
    }

    #[test]
    fn test_format_fiscal_receipt_escpos() {
        let data = FiscalReceiptData {
            items: vec![FiscalLineItem {
                description: "Test Item".into(),
                quantity: 1.0,
                unit_price: 500,
                tax_code: "A".into(),
                tax_rate: 24.0,
                department: Some(3),
                discount: None,
            }],
            payments: vec![FiscalPayment {
                method: "cash".into(),
                amount: 500,
            }],
            operator_id: Some("1".into()),
            receipt_comment: None,
        };

        let bytes = format_fiscal_receipt_escpos(&data, PaperWidth::Mm80, false);
        assert!(!bytes.is_empty());
        // Should contain ESC/POS init command (ESC @)
        assert!(bytes.windows(2).any(|w| w == [0x1B, 0x40]));
        // Should contain cut command
        assert!(bytes.windows(3).any(|w| w[0] == 0x1D && w[1] == 0x56));
    }
}
