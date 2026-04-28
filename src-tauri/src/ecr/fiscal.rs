//! Fiscal receipt data building and ESC/POS formatting.
//!
//! Converts order JSON data into structured fiscal receipt data for cash
//! registers, and can format simplified ESC/POS receipts for "POS sends
//! receipt" mode.

use crate::ecr::protocol::{FiscalLineItem, FiscalPayment, FiscalReceiptData, TaxRateConfig};
use crate::escpos::{EscPosBuilder, PaperWidth};
use tracing::debug;

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
/// Maps each order item to its tax code using the configured tax rates, and
/// aggregates payments by method.
pub fn build_fiscal_data(
    order: &serde_json::Value,
    payments: &[serde_json::Value],
    tax_rates: &[TaxRateConfig],
    operator_id: Option<&str>,
) -> Result<FiscalReceiptData, String> {
    let items_arr = order
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or("Order has no 'items' array")?;
    if items_arr.is_empty() {
        return Err("Order has empty 'items' array".to_string());
    }

    let mut fiscal_items = Vec::with_capacity(items_arr.len());

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

        // Determine tax code: use item's taxRate if present, otherwise default to "A"
        let item_tax_rate = item.get("taxRate").and_then(|v| v.as_f64());

        let tax_code = if let Some(rate) = item_tax_rate {
            // Find matching tax code by rate
            tax_rates
                .iter()
                .find(|tc| (tc.rate - rate).abs() < 0.01)
                .map(|tc| tc.code.clone())
                .unwrap_or_else(|| "A".to_string())
        } else {
            // Default to first tax rate or "A"
            tax_rates
                .first()
                .map(|tc| tc.code.clone())
                .unwrap_or_else(|| "A".to_string())
        };

        // Item-level discount
        let discount = optional_discount_cents(f64_field(item, &["discount", "discountAmount"]))?;

        fiscal_items.push(FiscalLineItem {
            description: name.to_string(),
            quantity: qty,
            unit_price,
            tax_code,
            discount,
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

    fn sample_tax_rates() -> Vec<TaxRateConfig> {
        vec![
            TaxRateConfig {
                code: "A".into(),
                rate: 24.0,
                label: "Standard".into(),
            },
            TaxRateConfig {
                code: "B".into(),
                rate: 13.0,
                label: "Reduced".into(),
            },
            TaxRateConfig {
                code: "C".into(),
                rate: 6.0,
                label: "Super-reduced".into(),
            },
        ]
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

        let data = build_fiscal_data(&order, &payments, &sample_tax_rates(), Some("1")).unwrap();

        assert_eq!(data.items.len(), 2);
        assert_eq!(data.items[0].description, "Coffee");
        assert_eq!(data.items[0].quantity, 2.0);
        assert_eq!(data.items[0].unit_price, 350);
        assert_eq!(data.items[0].tax_code, "A");
        assert_eq!(data.items[1].tax_code, "B");
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
        let data = build_fiscal_data(&order, &[], &sample_tax_rates(), None).unwrap();
        assert_eq!(data.payments.len(), 1);
        assert_eq!(data.payments[0].method, "cash");
        assert_eq!(data.payments[0].amount, 500);
    }

    #[test]
    fn test_build_fiscal_data_discount() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 10.00, "discount": 2.50}],
            "total_amount": 7.50
        });
        let payments = vec![json!({"method": "card", "amount": 7.50})];
        let data = build_fiscal_data(&order, &payments, &sample_tax_rates(), None).unwrap();
        assert_eq!(data.items[0].discount, Some(250));
    }

    #[test]
    fn test_build_fiscal_data_no_items_errors() {
        let order = json!({"total_amount": 5.00});
        let result = build_fiscal_data(&order, &[], &sample_tax_rates(), None);
        assert!(result.is_err());
    }

    #[test]
    fn test_build_fiscal_data_rejects_malformed_item() {
        let order = json!({
            "items": [{"quantity": 1, "price": 5.00}],
            "total_amount": 5.00
        });
        let result = build_fiscal_data(&order, &[], &sample_tax_rates(), None);
        assert!(result.unwrap_err().contains("missing a non-empty name"));
    }

    #[test]
    fn test_build_fiscal_data_rejects_malformed_payment() {
        let order = json!({
            "items": [{"name": "Item", "quantity": 1, "price": 5.00}],
            "total_amount": 5.00
        });
        let payments = vec![json!({"method": "card", "amount": 0.0})];
        let result = build_fiscal_data(&order, &payments, &sample_tax_rates(), None);
        assert!(result.unwrap_err().contains("must be positive"));
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
