use chrono::DateTime;
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
    pub customer_phone: Option<String>,
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
    pub customer_name: Option<String>,
    #[serde(default)]
    pub customer_phone: Option<String>,
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
    DeliverySlip(OrderReceiptDoc),
}

#[derive(Debug, Clone)]
pub struct LayoutConfig {
    pub paper_width: PaperWidth,
    pub template: ReceiptTemplate,
    pub organization_name: String,
    pub store_address: Option<String>,
    pub store_phone: Option<String>,
    pub vat_number: Option<String>,
    pub tax_office: Option<String>,
    pub footer_text: Option<String>,
    pub show_qr_code: bool,
    pub qr_data: Option<String>,
    pub show_logo: bool,
    pub logo_url: Option<String>,
    pub copy_label: Option<String>,
    pub character_set: String,
    pub greek_render_mode: Option<String>,
    pub escpos_code_page: Option<u8>,
    pub detected_brand: crate::printers::PrinterBrand,
    pub language: String,
    pub store_subtitle: Option<String>,
    pub currency_symbol: String,
}

impl Default for LayoutConfig {
    fn default() -> Self {
        Self {
            paper_width: PaperWidth::Mm80,
            template: ReceiptTemplate::Modern,
            organization_name: "The Small".to_string(),
            store_address: None,
            store_phone: None,
            vat_number: None,
            tax_office: None,
            footer_text: Some("Thank you".to_string()),
            show_qr_code: false,
            qr_data: None,
            show_logo: false,
            logo_url: None,
            copy_label: None,
            character_set: "PC437_USA".to_string(),
            greek_render_mode: None,
            escpos_code_page: None,
            detected_brand: crate::printers::PrinterBrand::Unknown,
            language: "en".to_string(),
            store_subtitle: None,
            currency_symbol: String::new(),
        }
    }
}

/// Translate a receipt label to the given language.
/// Returns the translated string for known keys, or the original key unchanged.
pub fn receipt_label<'a>(lang: &str, key: &'a str) -> &'a str {
    match lang {
        "el" => match key {
            "Order" => "\u{03A0}\u{03B1}\u{03C1}\u{03B1}\u{03B3}\u{03B3}\u{03B5}\u{03BB}\u{03AF}\u{03B1}",
            "Type" => "\u{03A4}\u{03CD}\u{03C0}\u{03BF}\u{03C2}",
            "Date" => "\u{0397}\u{03BC}/\u{03BD}\u{03AF}\u{03B1}",
            "Table" => "\u{03A4}\u{03C1}\u{03B1}\u{03C0}\u{03AD}\u{03B6}\u{03B9}",
            "Customer" => "\u{03A0}\u{03B5}\u{03BB}\u{03AC}\u{03C4}\u{03B7}\u{03C2}",
            "DELIVERY" => "\u{03A0}\u{0391}\u{03A1}\u{0391}\u{0394}\u{039F}\u{03A3}\u{0397}",
            "Driver" => "\u{039F}\u{03B4}\u{03B7}\u{03B3}\u{03CC}\u{03C2}",
            "Address" => "\u{0394}\u{03B9}\u{03B5}\u{03CD}\u{03B8}\u{03C5}\u{03BD}\u{03C3}\u{03B7}",
            "City" => "\u{03A0}\u{03CC}\u{03BB}\u{03B7}",
            "Postal Code" => "\u{03A4}.\u{039A}.",
            "Floor" => "\u{038C}\u{03C1}\u{03BF}\u{03C6}\u{03BF}\u{03C2}",
            "Name on ringer" => "\u{039A}\u{03BF}\u{03C5}\u{03B4}\u{03BF}\u{03CD}\u{03BD}\u{03B9}",
            "ITEMS" => "\u{0395}\u{0399}\u{0394}\u{0397}",
            "TOTALS" => "\u{03A3}\u{03A5}\u{039D}\u{039F}\u{039B}\u{0391}",
            "Subtotal" => "\u{03A5}\u{03C0}\u{03BF}\u{03C3}\u{03CD}\u{03BD}\u{03BF}\u{03BB}\u{03BF}",
            "Discount" => "\u{0388}\u{03BA}\u{03C0}\u{03C4}\u{03C9}\u{03C3}\u{03B7}",
            "Tax" => "\u{03A6}\u{03A0}\u{0391}",
            "Delivery" => "\u{039C}\u{03B5}\u{03C4}\u{03B1}\u{03C6}\u{03BF}\u{03C1}\u{03B9}\u{03BA}\u{03AC}",
            "Tip" => "\u{03A6}\u{03B9}\u{03BB}\u{03BF}\u{03B4}\u{03CE}\u{03C1}\u{03B7}\u{03BC}\u{03B1}",
            "TOTAL" => "\u{03A3}\u{03A5}\u{039D}\u{039F}\u{039B}\u{039F}",
            "PAYMENT" => "\u{03A0}\u{039B}\u{0397}\u{03A1}\u{03A9}\u{039C}\u{0397}",
            "Cash" => "\u{039C}\u{03B5}\u{03C4}\u{03C1}\u{03B7}\u{03C4}\u{03AC}",
            "Card" => "\u{039A}\u{03AC}\u{03C1}\u{03C4}\u{03B1}",
            "Received" => "\u{0395}\u{03B9}\u{03C3}\u{03C0}\u{03C1}\u{03AC}\u{03C7}\u{03B8}\u{03B7}\u{03BA}\u{03B5}",
            "Change" => "\u{03A1}\u{03AD}\u{03C3}\u{03C4}\u{03B1}",
            "Other" => "\u{0386}\u{03BB}\u{03BB}\u{03BF}",
            "ADJUSTMENTS" => "\u{03A0}\u{03A1}\u{039F}\u{03A3}\u{0391}\u{03A1}\u{039C}\u{039F}\u{0393}\u{0395}\u{03A3}",
            "Void" => "\u{0391}\u{03BA}\u{03CD}\u{03C1}\u{03C9}\u{03C3}\u{03B7}",
            "Refund" => "\u{0395}\u{03C0}\u{03B9}\u{03C3}\u{03C4}\u{03C1}\u{03BF}\u{03C6}\u{03AE}",
            "VOID" => "\u{0391}\u{039A}\u{03A5}\u{03A1}\u{03A9}\u{03A3}\u{0397}",
            "REFUND" => "\u{0395}\u{03A0}\u{0399}\u{03A3}\u{03A4}\u{03A1}\u{039F}\u{03A6}\u{0397}",
            "Thank you" => "\u{0395}\u{03C5}\u{03C7}\u{03B1}\u{03C1}\u{03B9}\u{03C3}\u{03C4}\u{03BF}\u{03CD}\u{03BC}\u{03B5}",
            "VAT" => "\u{0391}\u{03A6}\u{039C}",
            "TAX_OFFICE" => "\u{0394}.\u{039F}.\u{03A5}",
            "Shift" => "\u{0392}\u{03AC}\u{03C1}\u{03B4}\u{03B9}\u{03B1}",
            "Staff" => "\u{03A0}\u{03C1}\u{03BF}\u{03C3}\u{03C9}\u{03C0}\u{03B9}\u{03BA}\u{03CC}",
            "KITCHEN TICKET" => "\u{0394}\u{0395}\u{039B}\u{03A4}\u{0399}\u{039F} \u{039A}\u{039F}\u{03A5}\u{0396}\u{0399}\u{039D}\u{0391}\u{03A3}",
            "Phone" => "\u{03A4}\u{03B7}\u{03BB}.",
            "No items" => "\u{03A7}\u{03C9}\u{03C1}\u{03AF}\u{03C2} \u{03B5}\u{03AF}\u{03B4}\u{03B7}",
            "Road" => "\u{039F}\u{03B4}\u{03CC}\u{03C2}",
            "Ringer" => "\u{039A}\u{03BF}\u{03C5}\u{03B4}\u{03BF}\u{03CD}\u{03BD}\u{03B9}",
            "Postal" => "\u{03A4}.\u{039A}.",
            _ => key,
        },
        "de" => match key {
            "Order" => "Bestellung",
            "Type" => "Typ",
            "Date" => "Datum",
            "Table" => "Tisch",
            "Customer" => "Kunde",
            "DELIVERY" => "LIEFERUNG",
            "Driver" => "Fahrer",
            "Address" => "Adresse",
            "City" => "Stadt",
            "Postal Code" => "PLZ",
            "Floor" => "Etage",
            "Name on ringer" => "Name an Klingel",
            "ITEMS" => "ARTIKEL",
            "TOTALS" => "SUMMEN",
            "Subtotal" => "Zwischensumme",
            "Discount" => "Rabatt",
            "Tax" => "MwSt",
            "Delivery" => "Lieferung",
            "Tip" => "Trinkgeld",
            "TOTAL" => "GESAMT",
            "PAYMENT" => "ZAHLUNG",
            "Cash" => "Bar",
            "Card" => "Karte",
            "Received" => "Erhalten",
            "Change" => "Wechselgeld",
            "Other" => "Andere",
            "ADJUSTMENTS" => "KORREKTUREN",
            "Void" => "Storno",
            "Refund" => "Erstattung",
            "Thank you" => "Vielen Dank",
            "VAT" => "USt-IdNr.",
            "TAX_OFFICE" => "Finanzamt",
            "KITCHEN TICKET" => "K\u{00DC}CHENBON",
            "Phone" => "Tel.",
            "No items" => "Keine Artikel",
            "Road" => "Stra\u{00DF}e",
            "Ringer" => "Klingel",
            "Postal" => "PLZ",
            _ => key,
        },
        "fr" => match key {
            "Order" => "Commande",
            "Type" => "Type",
            "Date" => "Date",
            "Table" => "Table",
            "Customer" => "Client",
            "DELIVERY" => "LIVRAISON",
            "Driver" => "Livreur",
            "Address" => "Adresse",
            "City" => "Ville",
            "Postal Code" => "Code postal",
            "Floor" => "Etage",
            "Name on ringer" => "Nom sur sonnette",
            "ITEMS" => "ARTICLES",
            "TOTALS" => "TOTAUX",
            "Subtotal" => "Sous-total",
            "Discount" => "Remise",
            "Tax" => "TVA",
            "Delivery" => "Livraison",
            "Tip" => "Pourboire",
            "TOTAL" => "TOTAL",
            "PAYMENT" => "PAIEMENT",
            "Cash" => "Especes",
            "Card" => "Carte",
            "Received" => "Recu",
            "Change" => "Monnaie",
            "Other" => "Autre",
            "ADJUSTMENTS" => "AJUSTEMENTS",
            "Void" => "Annulation",
            "Refund" => "Remboursement",
            "Thank you" => "Merci",
            "VAT" => "TVA",
            "TAX_OFFICE" => "Bureau fiscal",
            "KITCHEN TICKET" => "BON CUISINE",
            "Phone" => "T\u{00E9}l.",
            "Road" => "Rue",
            "Ringer" => "Sonnette",
            "Postal" => "CP",
            "No items" => "Aucun article",
            _ => key,
        },
        "it" => match key {
            "Order" => "Ordine",
            "Type" => "Tipo",
            "Date" => "Data",
            "Table" => "Tavolo",
            "Customer" => "Cliente",
            "DELIVERY" => "CONSEGNA",
            "Driver" => "Corriere",
            "Address" => "Indirizzo",
            "City" => "Citta",
            "Postal Code" => "CAP",
            "Floor" => "Piano",
            "Name on ringer" => "Nome citofono",
            "ITEMS" => "ARTICOLI",
            "TOTALS" => "TOTALI",
            "Subtotal" => "Subtotale",
            "Discount" => "Sconto",
            "Tax" => "IVA",
            "Delivery" => "Consegna",
            "Tip" => "Mancia",
            "TOTAL" => "TOTALE",
            "PAYMENT" => "PAGAMENTO",
            "Cash" => "Contanti",
            "Card" => "Carta",
            "Received" => "Ricevuto",
            "Change" => "Resto",
            "Other" => "Altro",
            "ADJUSTMENTS" => "RETTIFICHE",
            "Void" => "Annullamento",
            "Refund" => "Rimborso",
            "Thank you" => "Grazie",
            "VAT" => "P.IVA",
            "TAX_OFFICE" => "Ufficio fiscale",
            "KITCHEN TICKET" => "COMANDA CUCINA",
            "Phone" => "Tel.",
            "Road" => "Via",
            "Ringer" => "Citofono",
            "Postal" => "CAP",
            "No items" => "Nessun articolo",
            _ => key,
        },
        _ => key,
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

fn money_with_currency(value: f64, symbol: &str) -> String {
    if symbol.is_empty() {
        money(value)
    } else {
        format!("{}{}", money(value), symbol)
    }
}

fn header_branch_line(cfg: &LayoutConfig) -> Option<&str> {
    let org = cfg.organization_name.trim();
    cfg.store_subtitle
        .as_deref()
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && *value != org && !value.eq_ignore_ascii_case(org)
        })
}

fn append_html_header_block(
    body: &mut String,
    cfg: &LayoutConfig,
    lang: &str,
    include_logo_placeholder: bool,
) {
    if include_logo_placeholder && cfg.show_logo {
        body.push_str("<div class=\"center\" style=\"font-size:24px;margin:8px 0\">[ LOGO ]</div>");
    }

    body.push_str(&format!(
        "<div class=\"center\"><strong>{}</strong></div>",
        esc(&cfg.organization_name)
    ));

    if let Some(branch_line) = header_branch_line(cfg) {
        body.push_str(&format!(
            "<div class=\"center\"><strong>{}</strong></div>",
            esc(branch_line)
        ));
    }

    if let Some(label) = cfg
        .copy_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.push_str(&format!("<div class=\"center\">{}</div>", esc(label)));
    }

    if let Some(address) = cfg
        .store_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.push_str(&format!("<div class=\"center\">{}</div>", esc(address)));
    }

    if let Some(phone) = cfg
        .store_phone
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.push_str(&format!("<div class=\"center\">{}</div>", esc(phone)));
    }

    if let Some(vat) = cfg
        .vat_number
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.push_str(&format!(
            "<div class=\"center\">{}: {}</div>",
            esc(receipt_label(lang, "VAT")),
            esc(vat)
        ));
    }

    if let Some(tax_office) = cfg
        .tax_office
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.push_str(&format!(
            "<div class=\"center\">{}: {}</div>",
            esc(receipt_label(lang, "TAX_OFFICE")),
            esc(tax_office)
        ));
    }
}

/// Format an ISO-8601 timestamp to `DD/MM/YYYY HH:MM`.
fn format_datetime_human(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|dt| dt.format("%d/%m/%Y %H:%M").to_string())
        .unwrap_or_else(|_| {
            let trimmed = &iso[..iso.len().min(26)];
            chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.f")
                .map(|dt| dt.format("%d/%m/%Y %H:%M").to_string())
                .unwrap_or_else(|_| iso.to_string())
        })
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
        for customization in with_items {
            body.push_str(&format!(
                "<div class=\"note\">+ {}</div>",
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
    escpos_code_page: Option<u8>,
    brand: crate::printers::PrinterBrand,
) -> Vec<RenderWarning> {
    let mut warnings = Vec::new();
    let cs = character_set.trim().to_ascii_uppercase();
    let is_star = brand == crate::printers::PrinterBrand::Star;

    // When user provides an explicit code page override, use it directly.
    // This lets users match the exact code page number for their printer model
    // (e.g. CP737 = 14 on Epson TM-T88III, 15 on Star mcPrint, 17 on some others).
    let is_greek = matches!(
        cs.as_str(),
        "PC737_GREEK" | "CP66_GREEK" | "PC851_GREEK" | "PC869_GREEK" | "PC1253_GREEK"
    );

    // Helper: select the right code page command for the printer brand.
    // Star Line Mode uses ESC GS t n (0x1B 0x1D 0x74 n), whereas
    // standard ESC/POS uses ESC t n (0x1B 0x74 n).
    let set_code_page = |b: &mut EscPosBuilder, page: u8| {
        if is_star {
            b.star_code_page(page);
        } else {
            b.code_page(page);
        }
    };

    if let Some(page) = escpos_code_page {
        if is_greek {
            set_code_page(builder, page);
            builder.set_greek_mode(true);
        } else {
            set_code_page(builder, page);
        }
    } else {
        // Default code page numbers (standard Epson ESC/POS)
        match cs.as_str() {
            "PC437_USA" => {
                set_code_page(builder, 0);
            }
            "PC850_MULTILINGUAL" => {
                set_code_page(builder, 2);
            }
            "PC852_LATIN2" => {
                set_code_page(builder, 18);
            }
            "PC866_CYRILLIC" => {
                set_code_page(builder, 17);
            }
            "PC1252_LATIN1" => {
                set_code_page(builder, 16);
            }
            "PC737_GREEK" | "CP66_GREEK" | "PC851_GREEK" | "PC869_GREEK" | "PC1253_GREEK" => {
                if is_star {
                    builder.star_code_page(15);
                } else {
                    builder.code_page(14);
                }
                builder.set_greek_mode(true);
            }
            _ => {
                set_code_page(builder, 0);
                warnings.push(RenderWarning {
                    code: "character_set_fallback".to_string(),
                    message: format!("Unsupported character set {cs}. Using PC437 fallback"),
                });
            }
        };
    }

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

/// Public wrapper for `apply_character_set` used by the Greek test print command.
pub fn apply_character_set_for_test(
    builder: &mut EscPosBuilder,
    character_set: &str,
    greek_render_mode: Option<&str>,
    escpos_code_page: Option<u8>,
    brand: crate::printers::PrinterBrand,
) -> Vec<RenderWarning> {
    apply_character_set(
        builder,
        character_set,
        greek_render_mode,
        escpos_code_page,
        brand,
    )
}

// ---------------------------------------------------------------------------
// Auto-configuration helpers
// ---------------------------------------------------------------------------

/// Map app language code to the appropriate ESC/POS character set.
///
/// Used for plug-and-play auto-configuration: when the user hasn't manually
/// set a character set and the app language is non-English, this provides
/// the best default character set for that language.
pub fn language_to_character_set(language: &str) -> &'static str {
    match language.trim().to_ascii_lowercase().as_str() {
        "el" => "PC737_GREEK",
        "de" | "fr" | "it" | "es" | "pt" | "nl" => "PC850_MULTILINGUAL",
        "ru" | "uk" | "bg" => "PC866_CYRILLIC",
        "pl" | "cs" | "sk" | "hr" | "hu" | "ro" => "PC852_LATIN2",
        _ => "PC437_USA",
    }
}

/// Resolve the ESC/POS code page number for a (brand, character_set) pair.
///
/// Different printer brands assign different numbers to the same code page
/// encoding. This lookup table is derived from the escpos-printer-db project
/// and official programming manuals.
///
/// Returns `None` if the combination is unknown.
pub fn resolve_auto_code_page(
    brand: crate::printers::PrinterBrand,
    character_set: &str,
) -> Option<u8> {
    use crate::printers::PrinterBrand::*;
    let cs = character_set.trim().to_ascii_uppercase();

    match cs.as_str() {
        "PC437_USA" => Some(match brand {
            Star => 1,
            _ => 0,
        }),
        "PC737_GREEK" => Some(match brand {
            Star => 15,
            _ => 14,
        }),
        "PC850_MULTILINGUAL" => Some(match brand {
            Star => 4,
            _ => 2,
        }),
        "PC852_LATIN2" => Some(match brand {
            Star => 5,
            _ => 18,
        }),
        "PC866_CYRILLIC" => Some(match brand {
            Star => 10,
            _ => 17,
        }),
        "PC1252_LATIN1" => Some(match brand {
            Star => 32,
            _ => 16,
        }),
        "PC851_GREEK" => Some(match brand {
            Star => 15, // Star maps both CP737 and CP851 to page 15
            _ => 11,
        }),
        "PC869_GREEK" => Some(match brand {
            Star => 17,
            _ => 15,
        }),
        "PC1253_GREEK" | "CP66_GREEK" => None, // non-standard; use profile override
        _ => None,
    }
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
            let render_delivery_block = should_render_delivery_block(doc);
            let mut body = String::new();
            append_html_header_block(&mut body, cfg, cfg.language.as_str(), cfg.show_logo);
            body.push_str(&format!(
                "<div class=\"section\"><div class=\"line\"><span>Order</span><span>#{}\
                 </span></div><div class=\"line\"><span>Type</span><span>{}</span></div>\
                 <div class=\"line\"><span>Date</span><span>{}</span></div>",
                esc(&doc.order_number),
                esc(&doc.order_type),
                esc(&doc.created_at)
            ));
            if let Some(table) = doc
                .table_number
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                body.push_str(&format!(
                    "<div class=\"line\"><span>Table</span><span>{}</span></div>",
                    esc(table)
                ));
            }
            if let Some(customer) = doc
                .customer_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                body.push_str(&format!(
                    "<div class=\"line\"><span>Customer</span><span>{}</span></div>",
                    esc(customer)
                ));
            }
            if let Some(phone) = doc
                .customer_phone
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if !render_delivery_block {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>Phone</span><span>{}</span></div>",
                        esc(phone)
                    ));
                }
            }
            body.push_str("</div>");
            if render_delivery_block {
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
                if let Some(phone) = doc
                    .customer_phone
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>Phone</span><span>{}</span></div>",
                        esc(phone)
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
            let lang = cfg.language.as_str();
            let mut body = String::new();
            append_html_header_block(&mut body, cfg, lang, cfg.show_logo);
            // Title
            body.push_str(&format!(
                "<div class=\"center\"><strong>{}</strong></div>",
                esc(receipt_label(lang, "KITCHEN TICKET"))
            ));
            // Order info
            body.push_str(&format!(
                "<div class=\"section\">\
                 <div class=\"line\"><span>{}</span><span>#{}</span></div>\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>",
                esc(receipt_label(lang, "Order")),
                esc(&doc.order_number),
                esc(receipt_label(lang, "Type")),
                esc(&doc.order_type),
                esc(receipt_label(lang, "Date")),
                esc(&doc.created_at),
            ));
            // Table number
            if let Some(table) = doc
                .table_number
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                body.push_str(&format!(
                    "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                    esc(receipt_label(lang, "Table")),
                    esc(table)
                ));
            }
            // Customer info
            if let Some(customer) = doc
                .customer_name
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                body.push_str(&format!(
                    "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                    esc(receipt_label(lang, "Customer")),
                    esc(customer)
                ));
            }
            if let Some(phone) = doc
                .customer_phone
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                body.push_str(&format!(
                    "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                    esc(receipt_label(lang, "Phone")),
                    esc(phone)
                ));
            }
            body.push_str("</div>");
            // Delivery section
            let is_delivery = doc.order_type.trim().eq_ignore_ascii_case("delivery");
            if is_delivery {
                body.push_str(&format!(
                    "<div class=\"section\"><h3>{}</h3>",
                    esc(receipt_label(lang, "DELIVERY"))
                ));
                // Driver first (bold value)
                if let Some(driver) = doc
                    .driver_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span><b>{}</b></span></div>",
                        esc(receipt_label(lang, "Driver")),
                        esc(driver)
                    ));
                }
                // Address fields (bold values): Address → City → Postal → Floor → Ringer
                if let Some(address) = doc
                    .delivery_address
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span><b>{}</b></span></div>",
                        esc(receipt_label(lang, "Address")),
                        esc(address)
                    ));
                }
                if let Some(city) = doc
                    .delivery_city
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span><b>{}</b></span></div>",
                        esc(receipt_label(lang, "City")),
                        esc(city)
                    ));
                }
                if let Some(postal) = doc
                    .delivery_postal_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span><b>{}</b></span></div>",
                        esc(receipt_label(lang, "Postal")),
                        esc(postal)
                    ));
                }
                if let Some(floor) = doc
                    .delivery_floor
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span><b>{}</b></span></div>",
                        esc(receipt_label(lang, "Floor")),
                        esc(floor)
                    ));
                }
                if let Some(ringer) = doc
                    .name_on_ringer
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span><b>{}</b></span></div>",
                        esc(receipt_label(lang, "Ringer")),
                        esc(ringer)
                    ));
                }
                body.push_str("</div>");
            }
            // Items section
            body.push_str(&format!(
                "<div class=\"{}\"><h3>{}</h3>",
                section_cls,
                esc(receipt_label(lang, "ITEMS"))
            ));
            if doc.items.is_empty() {
                body.push_str(&format!(
                    "<div class=\"note\">{}</div>",
                    esc(receipt_label(lang, "No items"))
                ));
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
            html_shell(receipt_label(lang, "KITCHEN TICKET"), &body)
        }
        ReceiptDocument::DeliverySlip(doc) => {
            let lang = cfg.language.as_str();
            let cur = cfg.currency_symbol.as_str();
            let mut body = String::new();
            append_html_header_block(&mut body, cfg, lang, cfg.show_logo);
            // Order info block
            body.push_str(&format!(
                "<div class=\"section\">\
                 <div class=\"center\"><strong>{} #{}</strong></div>\
                 <div class=\"center\">{}</div>\
                 <div class=\"center\">{}</div>\
                 </div>",
                esc(receipt_label(lang, "Order")),
                esc(&doc.order_number),
                esc(&format_datetime_human(&doc.created_at)),
                esc(&doc.order_type),
            ));
            // Customer info block
            body.push_str("<div class=\"section\">");
            if let Some(customer) = doc
                .customer_name
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                body.push_str(&format!(
                    "<div>{}: <b>{}</b></div>",
                    esc(receipt_label(lang, "Customer")),
                    esc(customer)
                ));
            }
            // Phone (always show label, even if empty)
            let phone_val = doc
                .customer_phone
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .unwrap_or("");
            body.push_str(&format!(
                "<div>{}: <b>{}</b></div>",
                esc(receipt_label(lang, "Phone")),
                esc(phone_val)
            ));
            // Address block
            let has_address = doc
                .delivery_address
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .is_some();
            if has_address {
                body.push_str(&format!(
                    "<div>{}:</div>",
                    esc(receipt_label(lang, "Address"))
                ));
                if let Some(street) = doc
                    .delivery_address
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!("<div>{}</div>", esc(street)));
                }
                // Postal + City on same line
                let postal = doc
                    .delivery_postal_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or("");
                let city = doc
                    .delivery_city
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or("");
                if !postal.is_empty() || !city.is_empty() {
                    body.push_str(&format!("<div>{} {}</div>", esc(postal), esc(city)));
                }
                // Floor | Ringer on same line
                let floor = doc
                    .delivery_floor
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty());
                let ringer = doc
                    .name_on_ringer
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty());
                match (floor, ringer) {
                    (Some(f), Some(r)) => {
                        body.push_str(&format!(
                            "<div>{} {} | {}: {}</div>",
                            esc(f),
                            esc(receipt_label(lang, "Floor")),
                            esc(receipt_label(lang, "Ringer")),
                            esc(r)
                        ));
                    }
                    (Some(f), None) => {
                        body.push_str(&format!(
                            "<div>{} {}</div>",
                            esc(f),
                            esc(receipt_label(lang, "Floor")),
                        ));
                    }
                    (None, Some(r)) => {
                        body.push_str(&format!(
                            "<div>{}: {}</div>",
                            esc(receipt_label(lang, "Ringer")),
                            esc(r)
                        ));
                    }
                    (None, None) => {}
                }
            }
            body.push_str("</div>");
            // Items section
            body.push_str(&format!(
                "<div class=\"section\"><h3>{}</h3>",
                esc(receipt_label(lang, "ITEMS"))
            ));
            if doc.items.is_empty() {
                body.push_str(&format!(
                    "<div class=\"note\">{}</div>",
                    esc(receipt_label(lang, "No items"))
                ));
            } else {
                for item in &doc.items {
                    let has_customizations = item
                        .customizations
                        .iter()
                        .any(|c| !c.name.trim().is_empty());
                    if has_customizations {
                        // Item name + price on same line, customizations below
                        body.push_str(&format!(
                            "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                            esc(&item.name),
                            money_with_currency(item.total, cur)
                        ));
                        append_customizations_html(&mut body, item);
                    } else {
                        // Simple item: name + price
                        body.push_str(&format!(
                            "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                            esc(&item.name),
                            money_with_currency(item.total, cur)
                        ));
                    }
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
            // Totals section
            body.push_str("<div class=\"section\">");
            for line in &doc.totals {
                let label = receipt_label(lang, &line.label);
                if line.emphasize {
                    body.push_str("<div style=\"border-top:3px double #111;border-bottom:3px double #111;padding:4px 0;margin-top:4px\">");
                    body.push_str(&format!(
                        "<div class=\"line\"><strong>{}</strong><strong>{}</strong></div>",
                        esc(label),
                        money_with_currency(line.amount, cur)
                    ));
                    body.push_str("</div>");
                } else {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(label),
                        money_with_currency(line.amount, cur)
                    ));
                }
            }
            body.push_str("</div>");
            // Footer
            body.push_str(&format!(
                "<div class=\"section center\">{}</div>",
                esc(cfg
                    .footer_text
                    .as_deref()
                    .unwrap_or(receipt_label(lang, "Thank you")))
            ));
            html_shell("Delivery Slip", &body)
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

/// Like `emit_pair` but prints the value in bold.
fn emit_pair_bold(builder: &mut EscPosBuilder, label: &str, value: &str, width: usize) {
    let label_len = label.chars().count();
    let value_len = value.chars().count();
    if label_len + value_len < width {
        builder.text(label);
        let gap = width.saturating_sub(label_len + value_len);
        for _ in 0..gap {
            builder.text(" ");
        }
        builder.bold(true).text(value).bold(false).lf();
        return;
    }
    for line in wrap(label, width.saturating_sub(value_len + 1).max(8)) {
        builder.text(&line).lf();
    }
    builder
        .right()
        .bold(true)
        .text(value)
        .bold(false)
        .lf()
        .left();
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
        for customization in with_items {
            emit_wrapped(
                builder,
                &format!("  + {}", customization_display(customization, true)),
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
    if let Some(branch_line) = header_branch_line(cfg) {
        if style.modern && !style.compact_width {
            builder.bold(true).text(branch_line).lf().bold(false);
        } else {
            builder.text(branch_line).lf();
        }
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
    if let Some(vat) = cfg
        .vat_number
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let vat_label = receipt_label(&cfg.language, "VAT");
        builder.text(&format!("{vat_label}: {vat}")).lf();
    }
    if let Some(office) = cfg
        .tax_office
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let office_label = receipt_label(&cfg.language, "TAX_OFFICE");
        builder.text(&format!("{office_label}: {office}")).lf();
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
        cfg.escpos_code_page,
        cfg.detected_brand,
    );
    emit_header(&mut builder, cfg, style, &mut warnings);

    let lang = cfg.language.as_str();

    match document {
        ReceiptDocument::OrderReceipt(doc) => {
            let render_delivery_block = should_render_delivery_block(doc);
            emit_pair(
                &mut builder,
                receipt_label(lang, "Order"),
                &format!("#{}", doc.order_number),
                width,
            );
            emit_pair(
                &mut builder,
                receipt_label(lang, "Type"),
                &doc.order_type,
                width,
            );
            emit_pair(
                &mut builder,
                receipt_label(lang, "Date"),
                &doc.created_at,
                width,
            );
            if let Some(table) = doc
                .table_number
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                emit_pair(&mut builder, receipt_label(lang, "Table"), table, width);
            }
            if let Some(customer) = doc
                .customer_name
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Customer"),
                    customer,
                    width,
                );
            }
            if let Some(phone) = doc
                .customer_phone
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                if !render_delivery_block {
                    emit_pair(&mut builder, receipt_label(lang, "Phone"), phone, width);
                }
            }
            if render_delivery_block {
                emit_section_header(&mut builder, receipt_label(lang, "DELIVERY"), style, width);
                if let Some(driver_name) = doc
                    .driver_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Driver"),
                        driver_name,
                        width,
                    );
                }
                if let Some(address) = doc
                    .delivery_address
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(&mut builder, receipt_label(lang, "Address"), address, width);
                }
                if let Some(phone) = doc
                    .customer_phone
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    emit_pair(&mut builder, receipt_label(lang, "Phone"), phone, width);
                }
                if let Some(city) = doc
                    .delivery_city
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(&mut builder, receipt_label(lang, "City"), city, width);
                }
                if let Some(postal_code) = doc
                    .delivery_postal_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Postal Code"),
                        postal_code,
                        width,
                    );
                }
                if let Some(floor) = doc
                    .delivery_floor
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(&mut builder, receipt_label(lang, "Floor"), floor, width);
                }
                if let Some(name_on_ringer) = doc
                    .name_on_ringer
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Name on ringer"),
                        name_on_ringer,
                        width,
                    );
                }
            }
            emit_section_header(&mut builder, receipt_label(lang, "ITEMS"), style, width);
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
            emit_section_header(&mut builder, receipt_label(lang, "TOTALS"), style, width);
            for total in &doc.totals {
                let label = receipt_label(lang, &total.label);
                if total.emphasize {
                    if style.modern && !style.compact_width {
                        builder.bold(true).double_height();
                        emit_pair(&mut builder, label, &money(total.amount), width);
                        builder.normal_size().bold(false);
                        continue;
                    }
                    builder.bold(true);
                }
                emit_pair(&mut builder, label, &money(total.amount), width);
                if total.emphasize {
                    builder.bold(false);
                }
            }
            emit_section_header(&mut builder, receipt_label(lang, "PAYMENT"), style, width);
            if doc.payments.is_empty() {
                builder.text("No payment recorded").lf();
            } else {
                for payment in &doc.payments {
                    let label = receipt_label(lang, &payment.label);
                    emit_pair(&mut builder, label, &money(payment.amount), width);
                }
            }
            if let Some(masked) = doc
                .masked_card
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                emit_pair(&mut builder, receipt_label(lang, "Card"), masked, width);
            }
            if !doc.adjustments.is_empty() {
                emit_section_header(
                    &mut builder,
                    receipt_label(lang, "ADJUSTMENTS"),
                    style,
                    width,
                );
                for adjustment in &doc.adjustments {
                    let label = receipt_label(lang, &adjustment.label);
                    emit_pair(
                        &mut builder,
                        label,
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
            let title = receipt_label(lang, "KITCHEN TICKET");
            let use_modern_prominent_header = style.modern && !style.compact_width;
            if use_modern_prominent_header {
                builder
                    .center()
                    .bold(true)
                    .double_height()
                    .text(title)
                    .lf()
                    .normal_size()
                    .double_width()
                    .double_height()
                    .text(&format!("{} #{}", receipt_label(lang, "Order"), doc.order_number))
                    .lf()
                    .normal_size()
                    .bold(false)
                    .left();
            } else {
                builder
                    .center()
                    .bold(true)
                    .text(title)
                    .lf()
                    .bold(false)
                    .left();
            }
            if !use_modern_prominent_header {
                builder.bold(true);
                if !style.compact_width {
                    builder.double_height();
                }
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Order"),
                    &format!("#{}", doc.order_number),
                    width,
                );
                if !style.compact_width {
                    builder.normal_size();
                }
                builder.bold(false);
            }
            emit_pair(
                &mut builder,
                receipt_label(lang, "Type"),
                &doc.order_type,
                width,
            );
            emit_pair(
                &mut builder,
                receipt_label(lang, "Date"),
                &doc.created_at,
                width,
            );
            if let Some(table) = doc
                .table_number
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                emit_pair(&mut builder, receipt_label(lang, "Table"), table, width);
            }
            if let Some(customer) = doc
                .customer_name
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Customer"),
                    customer,
                    width,
                );
            }
            if let Some(phone) = doc
                .customer_phone
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                emit_pair(&mut builder, receipt_label(lang, "Phone"), phone, width);
            }
            // Delivery block
            let is_delivery = doc.order_type.trim().eq_ignore_ascii_case("delivery");
            if is_delivery {
                emit_section_header(&mut builder, receipt_label(lang, "DELIVERY"), style, width);
                // Driver first (bold value)
                if let Some(driver_name) = doc
                    .driver_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    emit_pair_bold(
                        &mut builder,
                        receipt_label(lang, "Driver"),
                        driver_name,
                        width,
                    );
                }
                // Address fields (bold values): Address → City → Postal → Floor → Ringer
                if let Some(address) = doc
                    .delivery_address
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    emit_pair_bold(&mut builder, receipt_label(lang, "Address"), address, width);
                }
                if let Some(city) = doc
                    .delivery_city
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    emit_pair_bold(&mut builder, receipt_label(lang, "City"), city, width);
                }
                if let Some(postal_code) = doc
                    .delivery_postal_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    emit_pair_bold(
                        &mut builder,
                        receipt_label(lang, "Postal"),
                        postal_code,
                        width,
                    );
                }
                if let Some(floor) = doc
                    .delivery_floor
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    emit_pair_bold(&mut builder, receipt_label(lang, "Floor"), floor, width);
                }
                if let Some(name_on_ringer) = doc
                    .name_on_ringer
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    emit_pair_bold(
                        &mut builder,
                        receipt_label(lang, "Ringer"),
                        name_on_ringer,
                        width,
                    );
                }
            }
            emit_section_header(&mut builder, receipt_label(lang, "ITEMS"), style, width);
            if doc.items.is_empty() {
                builder.text(receipt_label(lang, "No items")).lf();
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
        ReceiptDocument::DeliverySlip(doc) => {
            let cur = cfg.currency_symbol.as_str();
            builder.separator();
            // Order info centered
            builder.center();
            builder.bold(true);
            if !style.compact_width {
                builder.double_height();
            }
            builder
                .text(&format!(
                    "{} #{}",
                    receipt_label(lang, "Order"),
                    doc.order_number
                ))
                .lf();
            if !style.compact_width {
                builder.normal_size();
            }
            builder.bold(false);
            builder.text(&format_datetime_human(&doc.created_at)).lf();
            builder.text(&doc.order_type).lf();
            builder.left();
            builder.separator();
            // Customer info
            if let Some(customer) = doc
                .customer_name
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                builder
                    .text(receipt_label(lang, "Customer"))
                    .text(": ")
                    .bold(true)
                    .text(customer)
                    .bold(false)
                    .lf();
            }
            let phone_val = doc
                .customer_phone
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .unwrap_or("");
            builder
                .text(receipt_label(lang, "Phone"))
                .text(": ")
                .bold(true)
                .text(phone_val)
                .bold(false)
                .lf();
            // Address block
            if let Some(street) = doc
                .delivery_address
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                builder.text(receipt_label(lang, "Address")).text(":").lf();
                emit_wrapped(&mut builder, street, width);
                let postal = doc
                    .delivery_postal_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or("");
                let city = doc
                    .delivery_city
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or("");
                if !postal.is_empty() || !city.is_empty() {
                    emit_wrapped(&mut builder, format!("{postal} {city}").trim(), width);
                }
                let floor = doc
                    .delivery_floor
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty());
                let ringer = doc
                    .name_on_ringer
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty());
                match (floor, ringer) {
                    (Some(f), Some(r)) => {
                        emit_wrapped(
                            &mut builder,
                            &format!(
                                "{f} {} | {}: {r}",
                                receipt_label(lang, "Floor"),
                                receipt_label(lang, "Ringer"),
                            ),
                            width,
                        );
                    }
                    (Some(f), None) => {
                        emit_wrapped(
                            &mut builder,
                            &format!("{f} {}", receipt_label(lang, "Floor")),
                            width,
                        );
                    }
                    (None, Some(r)) => {
                        emit_wrapped(
                            &mut builder,
                            &format!("{}: {r}", receipt_label(lang, "Ringer")),
                            width,
                        );
                    }
                    (None, None) => {}
                }
            }
            // Items
            emit_section_header(&mut builder, receipt_label(lang, "ITEMS"), style, width);
            if doc.items.is_empty() {
                builder.text(receipt_label(lang, "No items")).lf();
            } else {
                for item in &doc.items {
                    let price = money_with_currency(item.total, cur);
                    emit_item_line(&mut builder, &item.name, &price, width, style);
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
            // Totals
            builder.separator();
            for total in &doc.totals {
                let label = receipt_label(lang, &total.label);
                let val = money_with_currency(total.amount, cur);
                if total.emphasize {
                    // Double separator before TOTAL
                    let eq_line: String = "=".repeat(width);
                    builder.text(&eq_line).lf();
                    builder.bold(true);
                    if style.modern && !style.compact_width {
                        builder.double_height();
                    }
                    emit_pair(&mut builder, label, &val, width);
                    if style.modern && !style.compact_width {
                        builder.normal_size();
                    }
                    builder.bold(false);
                    builder.text(&eq_line).lf();
                } else {
                    emit_pair(&mut builder, label, &val, width);
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
        // Translate the default "Thank you" footer; custom text passes through unchanged
        let translated = receipt_label(lang, footer);
        emit_wrapped(&mut builder, translated, width);
        builder.left();
    }
    if cfg.detected_brand == crate::printers::PrinterBrand::Star {
        // Star Line Mode: LF feed + ESC d 1 partial cut.
        // Star does not recognize GS V A and prints literal "VA" text.
        builder.lf().lf().lf().lf().star_cut();
    } else {
        builder.feed(4).cut();
    }

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

    fn count_text(text: &str, needle: &str) -> usize {
        text.match_indices(needle).count()
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
        assert!(
            !text.contains("+ Ingredients"),
            "should not print 'Ingredients' header"
        );
        assert!(text.contains("- Without"));
        assert!(text.contains("Mushrooms"));
        assert!(text.contains("Onions"));
        let mushroom_pos = text.find("Mushrooms").unwrap_or(usize::MAX);
        let without_pos = text.find("- Without").unwrap_or(usize::MAX);
        assert!(mushroom_pos < without_pos);
    }

    #[test]
    fn delivery_block_renders_for_completed_delivery_with_driver() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-77".to_string(),
            order_type: "delivery".to_string(),
            status: "completed".to_string(),
            created_at: "2026-02-24".to_string(),
            customer_phone: Some("6900000000".to_string()),
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
        assert!(text.contains("6900000000"));
        let delivery_pos = text.find("DELIVERY").unwrap_or(usize::MAX);
        let phone_pos = text.find("Phone").unwrap_or(usize::MAX);
        assert!(delivery_pos < phone_pos);
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

    #[test]
    fn order_receipt_renders_customer_phone_when_present() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-80".to_string(),
            order_type: "dine-in".to_string(),
            status: "completed".to_string(),
            created_at: "2026-02-24".to_string(),
            customer_name: Some("John Doe".to_string()),
            customer_phone: Some("+30 6900000000".to_string()),
            ..OrderReceiptDoc::default()
        });

        let out = render_escpos(&doc, &LayoutConfig::default());
        let text = String::from_utf8_lossy(&out.bytes);
        assert!(text.contains("Phone"));
        assert!(text.contains("+30 6900000000"));
    }

    #[test]
    fn header_renders_brand_branch_address_phone_vat_and_tax_in_order() {
        let cfg = LayoutConfig {
            organization_name: "Brand Co".to_string(),
            store_subtitle: Some("Downtown Branch".to_string()),
            store_address: Some("Main St 10".to_string()),
            store_phone: Some("2100000000".to_string()),
            vat_number: Some("123456789".to_string()),
            tax_office: Some("DOY ATHENS".to_string()),
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-81".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24".to_string(),
            ..OrderReceiptDoc::default()
        });

        let out = render_escpos(&doc, &cfg);
        let text = String::from_utf8_lossy(&out.bytes);
        let brand_pos = text.find("Brand Co").unwrap_or(usize::MAX);
        let branch_pos = text.find("Downtown Branch").unwrap_or(usize::MAX);
        let address_pos = text.find("Main St 10").unwrap_or(usize::MAX);
        let phone_pos = text.find("2100000000").unwrap_or(usize::MAX);
        let vat_pos = text.find("VAT: 123456789").unwrap_or(usize::MAX);
        let tax_pos = text.find("TAX_OFFICE: DOY ATHENS").unwrap_or(usize::MAX);

        assert!(brand_pos < branch_pos);
        assert!(branch_pos < address_pos);
        assert!(address_pos < phone_pos);
        assert!(phone_pos < vat_pos);
        assert!(vat_pos < tax_pos);
    }

    #[test]
    fn delivery_slip_header_dedupes_branch_when_same_as_brand() {
        let cfg = LayoutConfig {
            organization_name: "Same Name".to_string(),
            store_subtitle: Some("Same Name".to_string()),
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::DeliverySlip(OrderReceiptDoc {
            order_number: "A-82".to_string(),
            order_type: "delivery".to_string(),
            created_at: "2026-02-24T10:00:00Z".to_string(),
            ..OrderReceiptDoc::default()
        });

        let out = render_escpos(&doc, &cfg);
        let text = String::from_utf8_lossy(&out.bytes);
        assert_eq!(count_text(&text, "Same Name"), 1);
    }

    #[test]
    fn kitchen_modern_receipt_keeps_prominent_order_identifier() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Modern,
            paper_width: PaperWidth::Mm80,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::KitchenTicket(KitchenTicketDoc {
            order_number: "KT-19".to_string(),
            order_type: "delivery".to_string(),
            created_at: "2026-02-24T12:30:00Z".to_string(),
            ..KitchenTicketDoc::default()
        });

        let out = render_escpos(&doc, &cfg);
        let text = String::from_utf8_lossy(&out.bytes);
        assert!(text.contains("KITCHEN TICKET"));
        assert!(text.contains("Order #KT-19"));
        assert!(text.contains("Type"));
        assert!(text.contains("Date"));
    }
}
