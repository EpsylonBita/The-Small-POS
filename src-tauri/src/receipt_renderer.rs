use serde::{Deserialize, Serialize};

use crate::escpos::{EscPosBuilder, PaperWidth};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReceiptTemplate {
    Classic,
    Modern,
}

impl ReceiptTemplate {
    pub fn from_value(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("classic") => Self::Classic,
            _ => Self::Modern,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReceiptCustomizationLine {
    pub name: String,
    #[serde(default)]
    pub quantity: f64,
    #[serde(default)]
    pub is_without: bool,
    #[serde(default)]
    pub is_little: bool,
    #[serde(default)]
    pub price: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReceiptItem {
    pub name: String,
    pub quantity: f64,
    pub total: f64,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub customizations: Vec<ReceiptCustomizationLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TotalsLine {
    pub label: String,
    pub amount: f64,
    #[serde(default)]
    pub emphasize: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PaymentLine {
    pub label: String,
    pub amount: f64,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AdjustmentLine {
    pub label: String,
    pub amount: f64,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OrderReceiptDoc {
    pub order_id: String,
    pub order_number: String,
    pub order_type: String,
    #[serde(default)]
    pub status: String,
    pub created_at: String,
    #[serde(default)]
    pub table_number: Option<String>,
    #[serde(default)]
    pub customer_name: Option<String>,
    #[serde(default)]
    pub delivery_address: Option<String>,
    #[serde(default)]
    pub delivery_city: Option<String>,
    #[serde(default)]
    pub delivery_postal_code: Option<String>,
    #[serde(default)]
    pub delivery_floor: Option<String>,
    #[serde(default)]
    pub name_on_ringer: Option<String>,
    #[serde(default)]
    pub driver_name: Option<String>,
    #[serde(default)]
    pub items: Vec<ReceiptItem>,
    #[serde(default)]
    pub totals: Vec<TotalsLine>,
    #[serde(default)]
    pub payments: Vec<PaymentLine>,
    #[serde(default)]
    pub adjustments: Vec<AdjustmentLine>,
    #[serde(default)]
    pub masked_card: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KitchenTicketDoc {
    pub order_id: String,
    pub order_number: String,
    pub order_type: String,
    pub created_at: String,
    #[serde(default)]
    pub table_number: Option<String>,
    #[serde(default)]
    pub delivery_address: Option<String>,
    #[serde(default)]
    pub delivery_notes: Option<String>,
    #[serde(default)]
    pub special_instructions: Option<String>,
    #[serde(default)]
    pub items: Vec<ReceiptItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ShiftCheckoutDoc {
    pub shift_id: String,
    pub role_type: String,
    pub staff_name: String,
    pub terminal_name: String,
    pub check_in: String,
    pub check_out: String,
    pub orders_count: i64,
    pub sales_amount: f64,
    pub total_expenses: f64,
    pub cash_refunds: f64,
    pub opening_amount: f64,
    #[serde(default)]
    pub expected_amount: Option<f64>,
    #[serde(default)]
    pub closing_amount: Option<f64>,
    #[serde(default)]
    pub variance_amount: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ZReportDoc {
    pub report_id: String,
    pub report_date: String,
    pub generated_at: String,
    pub shift_ref: String,
    pub terminal_name: String,
    pub total_orders: i64,
    pub gross_sales: f64,
    pub net_sales: f64,
    pub cash_sales: f64,
    pub card_sales: f64,
    pub refunds_total: f64,
    pub voids_total: f64,
    pub discounts_total: f64,
    pub expenses_total: f64,
    pub cash_variance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "doc", rename_all = "snake_case")]
pub enum ReceiptDocument {
    OrderReceipt(OrderReceiptDoc),
    KitchenTicket(KitchenTicketDoc),
    ShiftCheckout(ShiftCheckoutDoc),
    ZReport(ZReportDoc),
}

#[derive(Debug, Clone)]
pub struct LayoutConfig {
    pub paper_width: PaperWidth,
    pub template: ReceiptTemplate,
    pub organization_name: String,
    pub store_address: Option<String>,
    pub store_phone: Option<String>,
    pub footer_text: Option<String>,
    pub show_qr_code: bool,
    pub qr_data: Option<String>,
    pub show_logo: bool,
    pub logo_url: Option<String>,
    pub copy_label: Option<String>,
    pub character_set: String,
    pub greek_render_mode: Option<String>,
}

impl Default for LayoutConfig {
    fn default() -> Self {
        Self {
            paper_width: PaperWidth::Mm80,
            template: ReceiptTemplate::Modern,
            organization_name: "The Small".to_string(),
            store_address: None,
            store_phone: None,
            footer_text: Some("Thank you".to_string()),
            show_qr_code: false,
            qr_data: None,
            show_logo: false,
            logo_url: None,
            copy_label: None,
            character_set: "PC437_USA".to_string(),
            greek_render_mode: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct EscPosRender {
    pub bytes: Vec<u8>,
    pub warnings: Vec<RenderWarning>,
}

fn esc(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn money(value: f64) -> String {
    format!("{value:.2}")
}

fn qty(value: f64) -> String {
    if (value.round() - value).abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
    }
}

fn customization_qty(value: f64) -> String {
    if value <= 0.0 {
        return "1".to_string();
    }
    qty(value)
}

fn customization_display(customization: &ReceiptCustomizationLine, include_price: bool) -> String {
    let mut line = customization.name.trim().to_string();
    let quantity = customization_qty(customization.quantity);
    if quantity != "1" {
        line.push_str(&format!(" x{quantity}"));
    }
    if customization.is_little {
        line.push_str(" (little)");
    }
    if include_price {
        if let Some(price) = customization.price.filter(|value| *value > 0.0) {
            line.push_str(&format!(" (+{})", money(price)));
        }
    }
    line
}

fn split_customizations(
    item: &ReceiptItem,
) -> (
    Vec<&ReceiptCustomizationLine>,
    Vec<&ReceiptCustomizationLine>,
) {
    let mut with_items = Vec::new();
    let mut without_items = Vec::new();
    for customization in &item.customizations {
        if customization.name.trim().is_empty() {
            continue;
        }
        if customization.is_without {
            without_items.push(customization);
        } else {
            with_items.push(customization);
        }
    }
    (with_items, without_items)
}

fn append_customizations_html(body: &mut String, item: &ReceiptItem) {
    let (with_items, without_items) = split_customizations(item);
    if with_items.is_empty() && without_items.is_empty() {
        return;
    }

    if !with_items.is_empty() {
        body.push_str("<div class=\"note\">+ Ingredients</div>");
        for customization in with_items {
            body.push_str(&format!(
                "<div class=\"note\">&nbsp;&nbsp;+ {}</div>",
                esc(&customization_display(customization, true))
            ));
        }
    }

    if !without_items.is_empty() {
        body.push_str("<div class=\"note\">- Without</div>");
        for customization in without_items {
            body.push_str(&format!(
                "<div class=\"note\">&nbsp;&nbsp;- {}</div>",
                esc(&customization_display(customization, false))
            ));
        }
    }
}

fn is_completed_delivery_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "completed" | "delivered"
    )
}

fn should_render_delivery_block(doc: &OrderReceiptDoc) -> bool {
    doc.order_type.trim().eq_ignore_ascii_case("delivery")
        && is_completed_delivery_status(&doc.status)
        && doc
            .driver_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
}

fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut line = String::new();
    for token in text.split_whitespace() {
        if line.is_empty() {
            line.push_str(token);
            continue;
        }
        let next_len = line.chars().count() + 1 + token.chars().count();
        if next_len > width.max(8) {
            out.push(line);
            line = token.to_string();
        } else {
            line.push(' ');
            line.push_str(token);
        }
    }
    if !line.is_empty() {
        out.push(line);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

fn apply_character_set(
    builder: &mut EscPosBuilder,
    character_set: &str,
    greek_render_mode: Option<&str>,
) -> Vec<RenderWarning> {
    let mut warnings = Vec::new();
    let cs = character_set.trim().to_ascii_uppercase();
    match cs.as_str() {
        "PC437_USA" => builder.code_page(0),
        "PC850_MULTILINGUAL" => builder.code_page(2),
        "PC852_LATIN2" => builder.code_page(18),
        "PC866_CYRILLIC" => builder.code_page(17),
        "PC1252_LATIN1" => builder.code_page(16),
        "PC737_GREEK" | "CP66_GREEK" | "PC851_GREEK" | "PC869_GREEK" | "PC1253_GREEK" => {
            builder.greek_mode()
        }
        _ => {
            builder.code_page(0);
            warnings.push(RenderWarning {
                code: "character_set_fallback".to_string(),
                message: format!("Unsupported character set {cs}. Using PC437 fallback"),
            });
            builder
        }
    };
    if greek_render_mode
        .map(|v| v.trim().eq_ignore_ascii_case("bitmap"))
        .unwrap_or(false)
    {
        warnings.push(RenderWarning {
            code: "greek_bitmap_fallback".to_string(),
            message: "Greek bitmap mode is not available; using text mode".to_string(),
        });
    }
    warnings
}

fn html_shell(title: &str, body: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>{}</title>
<style>
body {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 12px; background: #fff; color: #111; }}
.line {{ display: flex; justify-content: space-between; gap: 8px; font-size: 10px; }}
.line strong {{ font-size: 11px; }}
.section {{ margin-top: 8px; border-top: 1px dashed #111; padding-top: 6px; }}
.section h3 {{ margin: 0 0 4px 0; font-size: 11px; text-transform: uppercase; }}
.pill h3 {{ display: inline-block; background: #111; color: #fff; border-radius: 999px; padding: 2px 8px; }}
.note {{ color: #666; font-size: 9px; }}
.center {{ text-align: center; }}
</style>
</head>
<body>{}</body>
</html>"#,
        esc(title),
        body
    )
}

pub fn render_html(document: &ReceiptDocument, cfg: &LayoutConfig) -> String {
    let section_cls = if cfg.template == ReceiptTemplate::Modern {
        "section pill"
    } else {
        "section"
    };
    match document {
        ReceiptDocument::OrderReceipt(doc) => {
            let mut body = format!(
                "<div class=\"center\">{}</div><div class=\"center\">{}</div>",
                esc(&cfg.organization_name),
                cfg.copy_label.clone().map(|v| esc(&v)).unwrap_or_default()
            );
            body.push_str(&format!(
                "<div class=\"section\"><div class=\"line\"><span>Order</span><span>#{}\
                 </span></div><div class=\"line\"><span>Type</span><span>{}</span></div>\
                 <div class=\"line\"><span>Date</span><span>{}</span></div></div>",
                esc(&doc.order_number),
                esc(&doc.order_type),
                esc(&doc.created_at)
            ));
            if should_render_delivery_block(doc) {
                body.push_str(&format!("<div class=\"{}\"><h3>Delivery</h3>", section_cls));
                if let Some(driver_name) = doc
                    .driver_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>Driver</span><span>{}</span></div>",
                        esc(driver_name)
                    ));
                }
                if let Some(address) = doc
                    .delivery_address
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>Address</span><span>{}</span></div>",
                        esc(address)
                    ));
                }
                if let Some(city) = doc
                    .delivery_city
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>City</span><span>{}</span></div>",
                        esc(city)
                    ));
                }
                if let Some(postal_code) = doc
                    .delivery_postal_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>Postal Code</span><span>{}</span></div>",
                        esc(postal_code)
                    ));
                }
                if let Some(floor) = doc
                    .delivery_floor
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>Floor</span><span>{}</span></div>",
                        esc(floor)
                    ));
                }
                if let Some(name_on_ringer) = doc
                    .name_on_ringer
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>Name on ringer</span><span>{}</span></div>",
                        esc(name_on_ringer)
                    ));
                }
                body.push_str("</div>");
            }
            body.push_str(&format!("<div class=\"{}\"><h3>Items</h3>", section_cls));
            if doc.items.is_empty() {
                body.push_str("<div class=\"note\">No items</div>");
            } else {
                for item in &doc.items {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}x {}</span><span>{}</span></div>",
                        qty(item.quantity),
                        esc(&item.name),
                        money(item.total)
                    ));
                    append_customizations_html(&mut body, item);
                    if let Some(note) = item
                        .note
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        body.push_str(&format!("<div class=\"note\">{}</div>", esc(note)));
                    }
                }
            }
            body.push_str("</div>");
            body.push_str(&format!("<div class=\"{}\"><h3>Totals</h3>", section_cls));
            for line in &doc.totals {
                if line.emphasize {
                    body.push_str(&format!(
                        "<div class=\"line\"><strong>{}</strong><strong>{}</strong></div>",
                        esc(&line.label),
                        money(line.amount)
                    ));
                } else {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(&line.label),
                        money(line.amount)
                    ));
                }
            }
            body.push_str("</div>");
            body.push_str(&format!("<div class=\"{}\"><h3>Payment</h3>", section_cls));
            if doc.payments.is_empty() {
                body.push_str("<div class=\"note\">No payment recorded</div>");
            } else {
                for payment in &doc.payments {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(&payment.label),
                        money(payment.amount)
                    ));
                }
            }
            if let Some(masked) = doc
                .masked_card
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                body.push_str(&format!("<div class=\"note\">Card: {}</div>", esc(masked)));
            }
            body.push_str("</div>");
            if !doc.adjustments.is_empty() {
                body.push_str(&format!(
                    "<div class=\"{}\"><h3>Adjustments</h3>",
                    section_cls
                ));
                for adjustment in &doc.adjustments {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                        esc(&adjustment.label),
                        money(adjustment.amount)
                    ));
                }
                body.push_str("</div>");
            }
            if cfg.show_qr_code {
                if let Some(qr) = cfg
                    .qr_data
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"section center note\">QR: {}</div>",
                        esc(qr)
                    ));
                }
            }
            body.push_str(&format!(
                "<div class=\"section center note\">{}</div>",
                esc(cfg.footer_text.as_deref().unwrap_or("Thank you"))
            ));
            html_shell("Order Receipt", &body)
        }
        ReceiptDocument::KitchenTicket(doc) => {
            let mut body = format!(
                "<div class=\"center\"><strong>KITCHEN TICKET</strong></div>\
                 <div class=\"section\"><div class=\"line\"><span>Order</span><span>#{}</span></div>\
                 <div class=\"line\"><span>Type</span><span>{}</span></div>\
                 <div class=\"line\"><span>Date</span><span>{}</span></div></div>\
                 <div class=\"{}\"><h3>Items</h3>",
                esc(&doc.order_number),
                esc(&doc.order_type),
                esc(&doc.created_at),
                section_cls
            );
            if doc.items.is_empty() {
                body.push_str("<div class=\"note\">No items</div>");
            } else {
                for item in &doc.items {
                    body.push_str(&format!(
                        "<div><strong>{}x {}</strong></div>",
                        qty(item.quantity),
                        esc(&item.name)
                    ));
                    append_customizations_html(&mut body, item);
                    if let Some(note) = item
                        .note
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        body.push_str(&format!("<div class=\"note\">{}</div>", esc(note)));
                    }
                }
            }
            body.push_str("</div>");
            html_shell("Kitchen Ticket", &body)
        }
        ReceiptDocument::ShiftCheckout(doc) => {
            let expected = doc
                .expected_amount
                .map(money)
                .unwrap_or_else(|| "N/A".to_string());
            let closing = doc
                .closing_amount
                .map(money)
                .unwrap_or_else(|| "N/A".to_string());
            let variance = doc
                .variance_amount
                .map(money)
                .unwrap_or_else(|| "N/A".to_string());
            let body = format!(
                "<div class=\"center\"><strong>SHIFT CHECKOUT</strong></div>\
                 <div class=\"section\"><div class=\"line\"><span>Shift</span><span>{}</span></div>\
                 <div class=\"line\"><span>Role</span><span>{}</span></div>\
                 <div class=\"line\"><span>Staff</span><span>{}</span></div>\
                 <div class=\"line\"><span>Terminal</span><span>{}</span></div>\
                 <div class=\"line\"><span>Orders</span><span>{}</span></div>\
                 <div class=\"line\"><span>Sales</span><span>{}</span></div>\
                 <div class=\"line\"><span>Expenses</span><span>{}</span></div>\
                 <div class=\"line\"><span>Refunds</span><span>{}</span></div>\
                 <div class=\"line\"><span>Opening</span><span>{}</span></div>\
                 <div class=\"line\"><span>Expected</span><span>{}</span></div>\
                 <div class=\"line\"><span>Closing</span><span>{}</span></div>\
                 <div class=\"line\"><span>Variance</span><span>{}</span></div></div>",
                esc(&doc.shift_id),
                esc(&doc.role_type),
                esc(&doc.staff_name),
                esc(&doc.terminal_name),
                doc.orders_count,
                money(doc.sales_amount),
                money(doc.total_expenses),
                money(doc.cash_refunds),
                money(doc.opening_amount),
                expected,
                closing,
                variance
            );
            html_shell("Shift Checkout", &body)
        }
        ReceiptDocument::ZReport(doc) => {
            let body = format!(
                "<div class=\"center\"><strong>Z REPORT</strong></div>\
                 <div class=\"section\"><div class=\"line\"><span>Date</span><span>{}</span></div>\
                 <div class=\"line\"><span>Generated</span><span>{}</span></div>\
                 <div class=\"line\"><span>Shift</span><span>{}</span></div>\
                 <div class=\"line\"><span>Terminal</span><span>{}</span></div></div>\
                 <div class=\"section\"><div class=\"line\"><span>Orders</span><span>{}</span></div>\
                 <div class=\"line\"><span>Gross</span><span>{}</span></div>\
                 <div class=\"line\"><span>Discounts</span><span>-{}</span></div>\
                 <div class=\"line\"><span>Net</span><span>{}</span></div>\
                 <div class=\"line\"><span>Cash</span><span>{}</span></div>\
                 <div class=\"line\"><span>Card</span><span>{}</span></div>\
                 <div class=\"line\"><span>Refunds</span><span>-{}</span></div>\
                 <div class=\"line\"><span>Voids</span><span>-{}</span></div>\
                 <div class=\"line\"><span>Expenses</span><span>-{}</span></div>\
                 <div class=\"line\"><span>Variance</span><span>{}</span></div></div>",
                esc(&doc.report_date),
                esc(&doc.generated_at),
                esc(&doc.shift_ref),
                esc(&doc.terminal_name),
                doc.total_orders,
                money(doc.gross_sales),
                money(doc.discounts_total),
                money(doc.net_sales),
                money(doc.cash_sales),
                money(doc.card_sales),
                money(doc.refunds_total),
                money(doc.voids_total),
                money(doc.expenses_total),
                money(doc.cash_variance)
            );
            html_shell("Z Report", &body)
        }
    }
}

fn emit_pair(builder: &mut EscPosBuilder, label: &str, value: &str, width: usize) {
    let label_len = label.chars().count();
    let value_len = value.chars().count();
    if label_len + value_len < width {
        builder.line_pair(label, value);
        return;
    }
    for line in wrap(label, width.saturating_sub(value_len + 1).max(8)) {
        builder.text(&line).lf();
    }
    builder.right().text(value).lf().left();
}

fn emit_wrapped(builder: &mut EscPosBuilder, text: &str, width: usize) {
    for line in wrap(text, width) {
        builder.text(&line).lf();
    }
}

#[derive(Debug, Clone, Copy)]
struct EscPosStyle {
    modern: bool,
    compact_width: bool,
}

fn escpos_style(cfg: &LayoutConfig) -> EscPosStyle {
    EscPosStyle {
        modern: cfg.template == ReceiptTemplate::Modern,
        compact_width: cfg.paper_width.chars() <= 32,
    }
}

fn should_use_large_item_text(style: EscPosStyle, width: usize, label: &str) -> bool {
    if !style.modern || style.compact_width {
        return false;
    }
    label.chars().count() <= width.saturating_sub(6).max(8)
}

fn emit_section_header(
    builder: &mut EscPosBuilder,
    title: &str,
    style: EscPosStyle,
    _width: usize,
) {
    builder.separator();
    if style.modern && !style.compact_width {
        builder
            .bold(true)
            .double_height()
            .text(title)
            .lf()
            .normal_size()
            .bold(false);
    } else {
        builder.bold(true).text(title).lf().bold(false);
    }
}

fn emit_item_line(
    builder: &mut EscPosBuilder,
    label: &str,
    value: &str,
    width: usize,
    style: EscPosStyle,
) {
    if style.modern {
        let large = should_use_large_item_text(style, width, label);
        builder.bold(true);
        if large {
            builder.double_height();
        }
        emit_pair(builder, label, value, width);
        if large {
            builder.normal_size();
        }
        builder.bold(false);
    } else {
        emit_pair(builder, label, value, width);
    }
}

fn emit_item_text(builder: &mut EscPosBuilder, text: &str, width: usize, style: EscPosStyle) {
    if style.modern {
        let large = should_use_large_item_text(style, width, text);
        builder.bold(true);
        if large {
            builder.double_height();
        }
        emit_wrapped(builder, text, width);
        if large {
            builder.normal_size();
        }
        builder.bold(false);
    } else {
        builder.bold(true);
        emit_wrapped(builder, text, width);
        builder.bold(false);
    }
}

fn emit_item_customizations_escpos(builder: &mut EscPosBuilder, item: &ReceiptItem, width: usize) {
    let (with_items, without_items) = split_customizations(item);

    if !with_items.is_empty() {
        emit_wrapped(builder, "  + Ingredients", width);
        for customization in with_items {
            emit_wrapped(
                builder,
                &format!("    + {}", customization_display(customization, true)),
                width,
            );
        }
    }

    if !without_items.is_empty() {
        emit_wrapped(builder, "  - Without", width);
        for customization in without_items {
            emit_wrapped(
                builder,
                &format!("    - {}", customization_display(customization, false)),
                width,
            );
        }
    }
}

fn emit_header(
    builder: &mut EscPosBuilder,
    cfg: &LayoutConfig,
    style: EscPosStyle,
    warnings: &mut Vec<RenderWarning>,
) {
    if cfg.show_logo
        && cfg
            .logo_url
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
    {
        warnings.push(RenderWarning {
            code: "logo_unavailable".to_string(),
            message: "Logo enabled but URL missing; using text header fallback".to_string(),
        });
    }
    builder.center();
    if style.modern && !style.compact_width {
        builder
            .bold(true)
            .double_height()
            .text(&cfg.organization_name)
            .lf()
            .normal_size()
            .bold(false);
    } else {
        builder
            .bold(true)
            .text(&cfg.organization_name)
            .lf()
            .bold(false);
    }
    if let Some(label) = cfg
        .copy_label
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        if style.modern {
            builder.bold(true).text(label).lf().bold(false);
        } else {
            builder.text(label).lf();
        }
    }
    if let Some(address) = cfg
        .store_address
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        emit_wrapped(builder, address, cfg.paper_width.chars());
    }
    if let Some(phone) = cfg
        .store_phone
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        builder.text(phone).lf();
    }
    builder.left().separator();
}

pub fn render_escpos(document: &ReceiptDocument, cfg: &LayoutConfig) -> EscPosRender {
    let width = cfg.paper_width.chars();
    let style = escpos_style(cfg);
    let mut builder = EscPosBuilder::new().with_paper(cfg.paper_width);
    builder.init();
    let mut warnings = apply_character_set(
        &mut builder,
        &cfg.character_set,
        cfg.greek_render_mode.as_deref(),
    );
    emit_header(&mut builder, cfg, style, &mut warnings);

    match document {
        ReceiptDocument::OrderReceipt(doc) => {
            emit_pair(
                &mut builder,
                "Order",
                &format!("#{}", doc.order_number),
                width,
            );
            emit_pair(&mut builder, "Type", &doc.order_type, width);
            emit_pair(&mut builder, "Date", &doc.created_at, width);
            if let Some(table) = doc
                .table_number
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                emit_pair(&mut builder, "Table", table, width);
            }
            if let Some(customer) = doc
                .customer_name
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                emit_pair(&mut builder, "Customer", customer, width);
            }
            if should_render_delivery_block(doc) {
                emit_section_header(&mut builder, "DELIVERY", style, width);
                if let Some(driver_name) = doc
                    .driver_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(&mut builder, "Driver", driver_name, width);
                }
                if let Some(address) = doc
                    .delivery_address
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(&mut builder, "Address", address, width);
                }
                if let Some(city) = doc
                    .delivery_city
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(&mut builder, "City", city, width);
                }
                if let Some(postal_code) = doc
                    .delivery_postal_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(&mut builder, "Postal Code", postal_code, width);
                }
                if let Some(floor) = doc
                    .delivery_floor
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(&mut builder, "Floor", floor, width);
                }
                if let Some(name_on_ringer) = doc
                    .name_on_ringer
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(&mut builder, "Name on ringer", name_on_ringer, width);
                }
            }
            emit_section_header(&mut builder, "ITEMS", style, width);
            if doc.items.is_empty() {
                builder.text("No items").lf();
            } else {
                for item in &doc.items {
                    emit_item_line(
                        &mut builder,
                        &format!("{}x {}", qty(item.quantity), item.name),
                        &money(item.total),
                        width,
                        style,
                    );
                    emit_item_customizations_escpos(&mut builder, item, width);
                    if let Some(note) = item
                        .note
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        emit_wrapped(&mut builder, &format!("  Note: {note}"), width);
                    }
                }
            }
            emit_section_header(&mut builder, "TOTALS", style, width);
            for total in &doc.totals {
                if total.emphasize {
                    if style.modern && !style.compact_width {
                        builder.bold(true).double_height();
                        emit_pair(&mut builder, &total.label, &money(total.amount), width);
                        builder.normal_size().bold(false);
                        continue;
                    }
                    builder.bold(true);
                }
                emit_pair(&mut builder, &total.label, &money(total.amount), width);
                if total.emphasize {
                    builder.bold(false);
                }
            }
            emit_section_header(&mut builder, "PAYMENT", style, width);
            if doc.payments.is_empty() {
                builder.text("No payment recorded").lf();
            } else {
                for payment in &doc.payments {
                    emit_pair(&mut builder, &payment.label, &money(payment.amount), width);
                }
            }
            if let Some(masked) = doc
                .masked_card
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                emit_pair(&mut builder, "Card", masked, width);
            }
            if !doc.adjustments.is_empty() {
                emit_section_header(&mut builder, "ADJUSTMENTS", style, width);
                for adjustment in &doc.adjustments {
                    emit_pair(
                        &mut builder,
                        &adjustment.label,
                        &format!("-{}", money(adjustment.amount)),
                        width,
                    );
                }
            }
            if cfg.show_qr_code {
                if let Some(qr) = cfg
                    .qr_data
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    builder.center().qr(qr).lf().left();
                }
            }
        }
        ReceiptDocument::KitchenTicket(doc) => {
            if style.modern && !style.compact_width {
                builder
                    .center()
                    .bold(true)
                    .double_height()
                    .text("KITCHEN")
                    .lf()
                    .normal_size()
                    .text("TICKET")
                    .lf()
                    .bold(false)
                    .left();
            } else {
                builder
                    .center()
                    .bold(true)
                    .text("KITCHEN TICKET")
                    .lf()
                    .bold(false)
                    .left();
            }
            emit_pair(
                &mut builder,
                "Order",
                &format!("#{}", doc.order_number),
                width,
            );
            emit_pair(&mut builder, "Type", &doc.order_type, width);
            emit_pair(&mut builder, "Date", &doc.created_at, width);
            emit_section_header(&mut builder, "ITEMS", style, width);
            if doc.items.is_empty() {
                builder.text("No items").lf();
            } else {
                for item in &doc.items {
                    emit_item_text(
                        &mut builder,
                        &format!("{}x {}", qty(item.quantity), item.name),
                        width,
                        style,
                    );
                    emit_item_customizations_escpos(&mut builder, item, width);
                    if let Some(note) = item
                        .note
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        emit_wrapped(&mut builder, &format!("  Note: {note}"), width);
                    }
                }
            }
        }
        ReceiptDocument::ShiftCheckout(doc) => {
            builder
                .center()
                .bold(true)
                .text("SHIFT CHECKOUT")
                .lf()
                .bold(false)
                .left();
            emit_pair(&mut builder, "Shift", &doc.shift_id, width);
            emit_pair(&mut builder, "Role", &doc.role_type, width);
            emit_pair(&mut builder, "Staff", &doc.staff_name, width);
            emit_pair(&mut builder, "Terminal", &doc.terminal_name, width);
            emit_pair(&mut builder, "Orders", &doc.orders_count.to_string(), width);
            emit_pair(&mut builder, "Sales", &money(doc.sales_amount), width);
            emit_pair(&mut builder, "Expenses", &money(doc.total_expenses), width);
            emit_pair(&mut builder, "Refunds", &money(doc.cash_refunds), width);
            emit_pair(&mut builder, "Opening", &money(doc.opening_amount), width);
            emit_pair(
                &mut builder,
                "Expected",
                &doc.expected_amount
                    .map(money)
                    .unwrap_or_else(|| "N/A".to_string()),
                width,
            );
            emit_pair(
                &mut builder,
                "Closing",
                &doc.closing_amount
                    .map(money)
                    .unwrap_or_else(|| "N/A".to_string()),
                width,
            );
            emit_pair(
                &mut builder,
                "Variance",
                &doc.variance_amount
                    .map(money)
                    .unwrap_or_else(|| "N/A".to_string()),
                width,
            );
        }
        ReceiptDocument::ZReport(doc) => {
            builder
                .center()
                .bold(true)
                .text("Z REPORT")
                .lf()
                .bold(false)
                .left();
            emit_pair(&mut builder, "Date", &doc.report_date, width);
            emit_pair(&mut builder, "Generated", &doc.generated_at, width);
            emit_pair(&mut builder, "Shift", &doc.shift_ref, width);
            emit_pair(&mut builder, "Terminal", &doc.terminal_name, width);
            builder.separator();
            emit_pair(&mut builder, "Orders", &doc.total_orders.to_string(), width);
            emit_pair(&mut builder, "Gross", &money(doc.gross_sales), width);
            emit_pair(
                &mut builder,
                "Discounts",
                &format!("-{}", money(doc.discounts_total)),
                width,
            );
            emit_pair(&mut builder, "Net", &money(doc.net_sales), width);
            emit_pair(&mut builder, "Cash", &money(doc.cash_sales), width);
            emit_pair(&mut builder, "Card", &money(doc.card_sales), width);
            emit_pair(
                &mut builder,
                "Refunds",
                &format!("-{}", money(doc.refunds_total)),
                width,
            );
            emit_pair(
                &mut builder,
                "Voids",
                &format!("-{}", money(doc.voids_total)),
                width,
            );
            emit_pair(
                &mut builder,
                "Expenses",
                &format!("-{}", money(doc.expenses_total)),
                width,
            );
            emit_pair(&mut builder, "Variance", &money(doc.cash_variance), width);
            if cfg.show_qr_code {
                if let Some(qr) = cfg
                    .qr_data
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    builder.center().qr(qr).lf().left();
                }
            }
        }
    }

    if let Some(footer) = cfg
        .footer_text
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        builder.separator().center();
        emit_wrapped(&mut builder, footer, width);
        builder.left();
    }
    builder.feed(4).cut();

    EscPosRender {
        bytes: builder.build(),
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count_sequence(bytes: &[u8], seq: &[u8]) -> usize {
        if seq.is_empty() {
            return 0;
        }
        bytes
            .windows(seq.len())
            .filter(|window| *window == seq)
            .count()
    }

    #[test]
    fn renders_qr_when_enabled() {
        let cfg = LayoutConfig {
            show_qr_code: true,
            qr_data: Some("https://example.com".to_string()),
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::ZReport(ZReportDoc {
            report_date: "2026-02-24".to_string(),
            generated_at: "2026-02-24T10:00:00Z".to_string(),
            ..ZReportDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        assert!(out.bytes.windows(3).any(|w| w == [0x1D, b'(', b'k']));
    }

    #[test]
    fn greek_bitmap_warns() {
        let cfg = LayoutConfig {
            character_set: "PC737_GREEK".to_string(),
            greek_render_mode: Some("bitmap".to_string()),
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-1".to_string(),
            order_type: "dine-in".to_string(),
            created_at: "2026-02-24".to_string(),
            ..OrderReceiptDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        assert!(out
            .warnings
            .iter()
            .any(|w| w.code == "greek_bitmap_fallback"));
    }

    #[test]
    fn modern_template_emits_more_large_text_commands_than_classic() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-12".to_string(),
            order_type: "dine-in".to_string(),
            created_at: "2026-02-24".to_string(),
            items: vec![ReceiptItem {
                name: "Club Sandwich".to_string(),
                quantity: 1.0,
                total: 8.5,
                ..ReceiptItem::default()
            }],
            totals: vec![TotalsLine {
                label: "TOTAL".to_string(),
                amount: 8.5,
                emphasize: true,
            }],
            ..OrderReceiptDoc::default()
        });

        let classic = LayoutConfig {
            template: ReceiptTemplate::Classic,
            ..LayoutConfig::default()
        };
        let modern = LayoutConfig {
            template: ReceiptTemplate::Modern,
            ..LayoutConfig::default()
        };

        let classic_render = render_escpos(&doc, &classic);
        let modern_render = render_escpos(&doc, &modern);
        let classic_large = count_sequence(&classic_render.bytes, &[0x1D, 0x21, 0x01]);
        let modern_large = count_sequence(&modern_render.bytes, &[0x1D, 0x21, 0x01]);
        assert!(modern_large > classic_large);
    }

    #[test]
    fn renders_customizations_with_plus_and_without_sections() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-99".to_string(),
            order_type: "delivery".to_string(),
            created_at: "2026-02-24".to_string(),
            items: vec![ReceiptItem {
                name: "Pizza".to_string(),
                quantity: 1.0,
                total: 10.0,
                customizations: vec![
                    ReceiptCustomizationLine {
                        name: "Mushrooms".to_string(),
                        quantity: 2.0,
                        is_without: false,
                        is_little: false,
                        price: Some(0.5),
                    },
                    ReceiptCustomizationLine {
                        name: "Onions".to_string(),
                        quantity: 1.0,
                        is_without: true,
                        is_little: false,
                        price: None,
                    },
                ],
                ..ReceiptItem::default()
            }],
            ..OrderReceiptDoc::default()
        });

        let out = render_escpos(&doc, &LayoutConfig::default());
        let text = String::from_utf8_lossy(&out.bytes);
        assert!(text.contains("+ Ingredients"));
        assert!(text.contains("- Without"));
        assert!(text.contains("Mushrooms"));
        assert!(text.contains("Onions"));
        let plus_pos = text.find("+ Ingredients").unwrap_or(usize::MAX);
        let without_pos = text.find("- Without").unwrap_or(usize::MAX);
        assert!(plus_pos < without_pos);
    }

    #[test]
    fn delivery_block_renders_for_completed_delivery_with_driver() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-77".to_string(),
            order_type: "delivery".to_string(),
            status: "completed".to_string(),
            created_at: "2026-02-24".to_string(),
            delivery_address: Some("Main St 12".to_string()),
            delivery_city: Some("Athens".to_string()),
            delivery_postal_code: Some("10558".to_string()),
            delivery_floor: Some("3".to_string()),
            name_on_ringer: Some("Papadopoulos".to_string()),
            driver_name: Some("Nikos Driver".to_string()),
            ..OrderReceiptDoc::default()
        });

        let out = render_escpos(&doc, &LayoutConfig::default());
        let text = String::from_utf8_lossy(&out.bytes);
        assert!(text.contains("DELIVERY"));
        assert!(text.contains("Driver"));
        assert!(text.contains("Nikos Driver"));
        assert!(text.contains("Main St 12"));
        assert!(text.contains("Athens"));
        assert!(text.contains("10558"));
        assert!(text.contains("Papadopoulos"));
    }

    #[test]
    fn delivery_block_hidden_for_non_final_delivery_status() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-78".to_string(),
            order_type: "delivery".to_string(),
            status: "preparing".to_string(),
            created_at: "2026-02-24".to_string(),
            driver_name: Some("Nikos Driver".to_string()),
            delivery_address: Some("Main St 12".to_string()),
            ..OrderReceiptDoc::default()
        });

        let out = render_escpos(&doc, &LayoutConfig::default());
        let text = String::from_utf8_lossy(&out.bytes);
        assert!(!text.contains("DELIVERY"));
        assert!(!text.contains("Nikos Driver"));
    }

    #[test]
    fn delivery_block_hidden_when_driver_name_missing() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-79".to_string(),
            order_type: "delivery".to_string(),
            status: "delivered".to_string(),
            created_at: "2026-02-24".to_string(),
            delivery_address: Some("Main St 12".to_string()),
            ..OrderReceiptDoc::default()
        });

        let out = render_escpos(&doc, &LayoutConfig::default());
        let text = String::from_utf8_lossy(&out.bytes);
        assert!(!text.contains("DELIVERY"));
        assert!(!text.contains("Driver"));
    }
}
