use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::{DateTime, Local};
use font8x8::UnicodeFonts;
use image::{GrayImage, Luma};
use rusttype::{point, Font as RustFont, Scale};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

use crate::escpos::{EscPosBuilder, PaperWidth};

pub const RECEIPT_LAYOUT_REVISION: &str = "2026-03-05-r16";

pub fn layout_revision() -> &'static str {
    RECEIPT_LAYOUT_REVISION
}

const NOTO_SERIF_REGULAR_TTF: &[u8] = include_bytes!("../assets/fonts/NotoSerif-Regular.ttf");
const NOTO_SERIF_BOLD_TTF: &[u8] = include_bytes!("../assets/fonts/NotoSerif-Bold.ttf");

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandProfile {
    FullStyle,
    SafeText,
}

impl CommandProfile {
    pub fn from_value(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("safe_text") => Self::SafeText,
            _ => Self::FullStyle,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FontType {
    A,
    B,
}

impl FontType {
    pub fn from_value(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("b") => Self::B,
            _ => Self::A,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LayoutDensity {
    Compact,
    Balanced,
    Spacious,
}

impl LayoutDensity {
    pub fn from_value(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("balanced") => Self::Balanced,
            Some("spacious") => Self::Spacious,
            _ => Self::Compact,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HeaderEmphasis {
    Normal,
    Strong,
}

impl HeaderEmphasis {
    pub fn from_value(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("normal") => Self::Normal,
            _ => Self::Strong,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClassicCustomerRenderMode {
    Text,
    RasterExact,
}

impl ClassicCustomerRenderMode {
    pub fn from_value(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("raster_exact") => Self::RasterExact,
            _ => Self::Text,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptEmulationMode {
    Auto,
    Escpos,
    StarLine,
}

impl ReceiptEmulationMode {
    pub fn from_value(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("escpos") => Self::Escpos,
            Some("star_line") => Self::StarLine,
            _ => Self::Auto,
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
    pub category_name: Option<String>,
    #[serde(default)]
    pub subcategory_name: Option<String>,
    #[serde(default)]
    pub category_path: Option<String>,
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
    #[serde(default)]
    pub discount_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PaymentLine {
    pub label: String,
    pub amount: f64,
    #[serde(default)]
    pub detail: Option<String>,
}

pub const PAYMENT_DETAIL_AMOUNT_UNKNOWN: &str = "__amount_unknown__";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AdjustmentLine {
    pub label: String,
    pub amount: f64,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DeliverySlipMode {
    #[default]
    DeliveryOrder,
    AssignDriver,
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
    pub driver_id: Option<String>,
    #[serde(default)]
    pub driver_name: Option<String>,
    #[serde(default)]
    pub delivery_slip_mode: DeliverySlipMode,
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
    #[serde(default)]
    pub order_notes: Vec<String>,
    /// Set by order_completed_receipt / order_canceled_receipt entity types.
    /// When Some, a status banner is rendered at the top of the receipt.
    #[serde(default)]
    pub status_label: Option<String>,
    /// Cancellation reason shown under the CANCELED banner.
    #[serde(default)]
    pub cancellation_reason: Option<String>,
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
pub struct DriverDeliveryLine {
    pub order_number: String,
    pub total_amount: f64,
    pub payment_method: String,
    pub cash_collected: f64,
    pub delivery_fee: f64,
    pub tip_amount: f64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StaffPayoutLine {
    pub staff_name: String,
    pub role_type: String,
    pub amount: f64,
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
    pub cash_sales: f64,
    #[serde(default)]
    pub card_sales: f64,
    #[serde(default)]
    pub cash_drops: f64,
    #[serde(default)]
    pub driver_cash_given: f64,
    #[serde(default)]
    pub driver_cash_returned: f64,
    #[serde(default)]
    pub staff_payouts_total: f64,
    #[serde(default)]
    pub staff_payout_lines: Vec<StaffPayoutLine>,
    #[serde(default)]
    pub transferred_staff_count: i64,
    #[serde(default)]
    pub transferred_staff_returns: f64,
    #[serde(default)]
    pub expected_amount: Option<f64>,
    #[serde(default)]
    pub closing_amount: Option<f64>,
    #[serde(default)]
    pub variance_amount: Option<f64>,
    #[serde(default)]
    pub driver_deliveries: Vec<DriverDeliveryLine>,
    #[serde(default)]
    pub total_cash_collected: f64,
    #[serde(default)]
    pub total_card_collected: f64,
    #[serde(default)]
    pub total_delivery_fees: f64,
    #[serde(default)]
    pub total_tips: f64,
    #[serde(default)]
    pub amount_to_return: f64,
    #[serde(default)]
    pub total_sells: f64,
    #[serde(default)]
    pub cancelled_or_refunded_total: f64,
    #[serde(default)]
    pub cancelled_or_refunded_count: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ZReportStaffEntry {
    pub name: String,
    pub role: String,
    pub check_in: Option<String>,
    pub check_out: Option<String>,
    pub order_count: i64,
    pub cash_amount: f64,
    pub card_amount: f64,
    pub total_amount: f64,
    pub opening_cash: f64,
    pub staff_payment: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ZReportDoc {
    pub report_id: String,
    pub report_date: String,
    pub generated_at: String,
    pub shift_ref: String,
    #[serde(default)]
    pub shift_count: Option<i64>,
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
    #[serde(default)]
    pub tips_total: f64,
    #[serde(default)]
    pub opening_cash: f64,
    #[serde(default)]
    pub closing_cash: f64,
    #[serde(default)]
    pub expected_cash: f64,
    #[serde(default)]
    pub cash_drops: f64,
    #[serde(default)]
    pub driver_cash_given: f64,
    #[serde(default)]
    pub driver_cash_returned: f64,
    #[serde(default)]
    pub staff_payments_total: f64,
    #[serde(default)]
    pub dine_in_orders: i64,
    #[serde(default)]
    pub dine_in_sales: f64,
    #[serde(default)]
    pub takeaway_orders: i64,
    #[serde(default)]
    pub takeaway_sales: f64,
    #[serde(default)]
    pub delivery_orders: i64,
    #[serde(default)]
    pub delivery_sales: f64,
    #[serde(default)]
    pub staff_reports: Vec<ZReportStaffEntry>,
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
    pub command_profile: CommandProfile,
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
    pub font_type: FontType,
    pub layout_density: LayoutDensity,
    pub header_emphasis: HeaderEmphasis,
    pub layout_density_scale: f32,
    /// Use comma as decimal separator (e.g. Greek: 17,70 instead of 17.70).
    pub decimal_comma: bool,
    pub classic_customer_render_mode: ClassicCustomerRenderMode,
    pub emulation_mode: ReceiptEmulationMode,
    pub printable_width_dots: u16,
    pub left_margin_dots: u16,
    pub raster_threshold: u8,
    /// User-configurable text scale for classic receipt layout (0.8–2.0, default 1.25).
    pub text_scale: f32,
    /// User-configurable logo scale (0.5–2.0, default 1.0).
    pub logo_scale: f32,
    /// CSS font-weight for body text (400–800). Controlled by local_settings receipt/body_boldness.
    pub body_font_weight: u32,
}

impl Default for LayoutConfig {
    fn default() -> Self {
        Self {
            paper_width: PaperWidth::Mm80,
            template: ReceiptTemplate::Modern,
            command_profile: CommandProfile::FullStyle,
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
            font_type: FontType::A,
            layout_density: LayoutDensity::Compact,
            header_emphasis: HeaderEmphasis::Strong,
            layout_density_scale: 1.0,
            decimal_comma: false,
            classic_customer_render_mode: ClassicCustomerRenderMode::Text,
            emulation_mode: ReceiptEmulationMode::Auto,
            printable_width_dots: 576,
            left_margin_dots: 0,
            raster_threshold: 160,
            text_scale: 1.25,
            logo_scale: 1.0,
            body_font_weight: 400,
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
            "DELIVERY SLIP" => "\u{0394}\u{0395}\u{039B}\u{03A4}\u{0399}\u{039F} \u{0394}\u{0399}\u{0391}\u{039D}\u{039F}\u{039C}\u{0397}\u{03A3}",
            "Driver" => "\u{039F}\u{03B4}\u{03B7}\u{03B3}\u{03CC}\u{03C2}",
            "Driver ID" => "ID \u{039F}\u{03B4}\u{03B7}\u{03B3}\u{03BF}\u{03CD}",
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
            "METHOD" => "\u{03A4}\u{03C1}\u{03CC}\u{03C0}\u{03BF}\u{03C2}",
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
            "Thank you visit" => "\u{0395}\u{03C5}\u{03C7}\u{03B1}\u{03C1}\u{03B9}\u{03C3}\u{03C4}\u{03BF}\u{03CD}\u{03BC}\u{03B5} \u{03B3}\u{03B9}\u{03B1} \u{03C4}\u{03B7}\u{03BD} \u{03B5}\u{03C0}\u{03AF}\u{03C3}\u{03BA}\u{03B5}\u{03C8}\u{03AE} \u{03C3}\u{03B1}\u{03C2}!",
            "Thank you preference" => "\u{0395}\u{03C5}\u{03C7}\u{03B1}\u{03C1}\u{03B9}\u{03C3}\u{03C4}\u{03BF}\u{03CD}\u{03BC}\u{03B5} \u{03B3}\u{03B9}\u{03B1} \u{03C4}\u{03B7}\u{03BD} \u{03C0}\u{03C1}\u{03BF}\u{03C4}\u{03AF}\u{03BC}\u{03B7}\u{03C3}\u{03B7}!",
            "Payment method" => "\u{03A4}\u{03C1}\u{03CC}\u{03C0}\u{03BF}\u{03C2} \u{03C0}\u{03BB}\u{03B7}\u{03C1}\u{03C9}\u{03BC}\u{03AE}\u{03C2}",
            "VAT" => "\u{0391}\u{03A6}\u{039C}",
            "TAX_OFFICE" => "\u{0394}\u{039F}\u{03A5}",
            "Shift" => "\u{0392}\u{03AC}\u{03C1}\u{03B4}\u{03B9}\u{03B1}",
            "Staff" => "\u{03A0}\u{03C1}\u{03BF}\u{03C3}\u{03C9}\u{03C0}\u{03B9}\u{03BA}\u{03CC}",
            "SHIFT CHECKOUT" => "ΚΛΕΙΣΙΜΟ ΒΑΡΔΙΑΣ",
            "Z REPORT" => "ΑΝΑΦΟΡΑ Z",
            "Role" => "Ρόλος",
            "Cashier" => "Ταμίας",
            "Manager" => "Διευθυντής",
            "Kitchen" => "Κουζίνα",
            "Server" => "Σερβιτόρος",
            "Shifts" => "Βάρδιες",
            "Terminal" => "Τερματικό",
            "Check-in" => "Έναρξη",
            "Check-out" => "Λήξη",
            "Orders" => "Παραγγελίες",
            "Sales" => "Πωλήσεις",
            "Expenses" => "Έξοδα",
            "Refunds" => "Επιστροφές",
            "Opening" => "Άνοιγμα",
            "Expected" => "Αναμενόμενο",
            "Closing" => "Κλείσιμο",
            "Variance" => "Διαφορά",
            "DRIVER DELIVERIES" => "ΠΑΡΑΔΟΣΕΙΣ ΟΔΗΓΟΥ",
            "Generated" => "Δημιουργία",
            "Gross" => "Μικτά",
            "Net" => "Καθαρά",
            "Voids" => "Ακυρώσεις",
            "Discounts" => "Εκπτώσεις",
            "DELIVERIES" => "ΠΑΡΑΔΟΣΕΙΣ",
            "DRIVER SUMMARY" => "ΣΥΝΟΨΗ ΟΔΗΓΟΥ",
            "Cash Collected" => "Εισπραχθέντα Μετρητά",
            "Card Collected" => "Εισπραχθείσα Κάρτα",
            "Delivery Fees" => "Χρεώσεις Παράδοσης",
            "Starting" => "Εκκίνηση",
            "Starting Amount" => "Αρχικό Ποσό",
            "Total Sells" => "Σύνολο Πωλήσεων",
            "+ Cash" => "+ Μετρητά",
            "- Expenses" => "- Έξοδα",
            "= To Return" => "= Προς Επιστροφή",
            "Amount to be Returned" => "Ποσό προς Επιστροφή",
            "Canceled/Refunded" => "Ακυρωμένα/Επιστροφές",
            "SALES" => "ΠΩΛΗΣΕΙΣ",
            "PAYMENTS" => "ΠΛΗΡΩΜΕΣ",
            "Tips" => "Φιλοδωρήματα",
            "ORDER BREAKDOWN" => "ΑΝΑΛΥΣΗ ΠΑΡΑΓΓΕΛΙΩΝ",
            "Dine-in" => "Επιτόπου",
            "Takeaway" => "Παραλαβή",
            "CASH DRAWER" => "ΤΑΜΕΙΟ",
            "STAFF" => "ΠΡΟΣΩΠΙΚΟ",
            "Cash Sales" => "Πωλήσεις Μετρητών",
            "Card Sales" => "Πωλήσεις Κάρτας",
            "Cash Drops" => "Αποσύρσεις Μετρητών",
            "Driver Given" => "Δόθηκαν σε Οδηγό",
            "Driver Returned" => "Επιστράφηκαν από Οδηγό",
            "Transferred Staff" => "Μεταφερμένο Προσωπικό",
            "Transferred Staff Returns" => "Επιστροφές Μεταφερμένου Προσωπικού",
            "Expected In Drawer" => "Αναμενόμενο στο Ταμείο",
            "Counted Cash" => "Μετρημένα Μετρητά",
            "Staff Payouts" => "Εκταμιεύσεις Προσωπικού",
            "Staff Payouts*" => "Εκταμιεύσεις Προσωπικού*",
            "STAFF PAYOUTS" => "ΕΚΤΑΜΙΕΥΣΕΙΣ ΠΡΟΣΩΠΙΚΟΥ",
            "Payout" => "Εκταμίευση",
            "Staff Payments*" => "Εκταμιεύσεις Προσωπικού*",
            "Informational only" => "Μόνο για ενημέρωση",
            "KITCHEN TICKET" => "\u{0394}\u{0395}\u{039B}\u{03A4}\u{0399}\u{039F} \u{039A}\u{039F}\u{03A5}\u{0396}\u{0399}\u{039D}\u{0391}\u{03A3}",
            "Phone" => "\u{03A4}\u{03B7}\u{03BB}",
            "No items" => "\u{03A7}\u{03C9}\u{03C1}\u{03AF}\u{03C2} \u{03B5}\u{03AF}\u{03B4}\u{03B7}",
            "No payment recorded" => "Δεν καταγράφηκε πληρωμή",
            "Note" => "Σημείωση",
            "Without" => "Χωρίς",
            "Little" => "Λίγο",
            "Category" => "Κατηγορία",
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
            "DELIVERY SLIP" => "LIEFERSCHEIN",
            "Driver" => "Fahrer",
            "Driver ID" => "Fahrer-ID",
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
            "METHOD" => "METHODE",
            "Cash" => "Bar",
            "Card" => "Karte",
            "Received" => "Erhalten",
            "Change" => "Wechselgeld",
            "Other" => "Andere",
            "ADJUSTMENTS" => "KORREKTUREN",
            "Void" => "Storno",
            "Refund" => "Erstattung",
            "Thank you" => "Vielen Dank",
            "Thank you visit" => "Vielen Dank f\u{00FC}r Ihren Besuch!",
            "Thank you preference" => "Vielen Dank f\u{00FC}r Ihre Wahl!",
            "Payment method" => "Zahlungsmethode",
            "VAT" => "USt-IdNr.",
            "TAX_OFFICE" => "Finanzamt",
            "Shift" => "Schicht",
            "Staff" => "Personal",
            "SHIFT CHECKOUT" => "SCHICHT-ABSCHLUSS",
            "Z REPORT" => "Z-BERICHT",
            "Role" => "Rolle",
            "Cashier" => "Kassierer",
            "Manager" => "Manager",
            "Kitchen" => "Kueche",
            "Server" => "Service",
            "Shifts" => "Schichten",
            "Terminal" => "Terminal",
            "Check-in" => "Check-in",
            "Check-out" => "Check-out",
            "Orders" => "Bestellungen",
            "Sales" => "Umsatz",
            "Expenses" => "Ausgaben",
            "Refunds" => "Erstattungen",
            "Opening" => "Anfang",
            "Expected" => "Erwartet",
            "Closing" => "Abschluss",
            "Variance" => "Differenz",
            "DRIVER DELIVERIES" => "FAHRER-LIEFERUNGEN",
            "Generated" => "Erstellt",
            "Gross" => "Brutto",
            "Net" => "Netto",
            "Voids" => "Stornos",
            "Discounts" => "Rabatte",
            "DELIVERIES" => "LIEFERUNGEN",
            "DRIVER SUMMARY" => "FAHRER-ZUSAMMENFASSUNG",
            "Cash Collected" => "Bar kassiert",
            "Card Collected" => "Karte kassiert",
            "Delivery Fees" => "Liefergebuhren",
            "Starting" => "Start",
            "Starting Amount" => "Startbetrag",
            "Total Sells" => "Gesamtumsatz",
            "+ Cash" => "+ Bar",
            "- Expenses" => "- Ausgaben",
            "= To Return" => "= Rueckgabe",
            "Amount to be Returned" => "Zurueckzugebender Betrag",
            "Canceled/Refunded" => "Storniert/Erstattet",
            "SALES" => "UMSATZ",
            "PAYMENTS" => "ZAHLUNGEN",
            "Tips" => "Trinkgelder",
            "ORDER BREAKDOWN" => "BESTELL-UEBERSICHT",
            "Dine-in" => "Vor Ort",
            "Takeaway" => "Mitnahme",
            "CASH DRAWER" => "KASSENSCHADE",
            "STAFF" => "PERSONAL",
            "Cash Sales" => "Barumsatz",
            "Card Sales" => "Kartenumsatz",
            "Cash Drops" => "Barentnahmen",
            "Driver Given" => "Fahrer ausgezahlt",
            "Driver Returned" => "Vom Fahrer retour",
            "Transferred Staff" => "Übertragenes Personal",
            "Transferred Staff Returns" => "Übernommene Personalrückgaben",
            "Expected In Drawer" => "Erwartet in der Kasse",
            "Counted Cash" => "Gezähltes Bargeld",
            "Staff Payouts" => "Mitarbeiterauszahlungen",
            "Staff Payouts*" => "Mitarbeiterauszahlungen*",
            "STAFF PAYOUTS" => "MITARBEITERAUSZAHLUNGEN",
            "Payout" => "Auszahlung",
            "Staff Payments*" => "Mitarbeiterauszahlungen*",
            "Informational only" => "Nur Information",
            "KITCHEN TICKET" => "K\u{00DC}CHENBON",
            "Phone" => "Tel.",
            "No items" => "Keine Artikel",
            "No payment recorded" => "Keine Zahlung erfasst",
            "Note" => "Notiz",
            "Without" => "Ohne",
            "Little" => "Wenig",
            "Category" => "Kategorie",
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
            "DELIVERY SLIP" => "BON DE LIVRAISON",
            "Driver" => "Livreur",
            "Driver ID" => "ID Livreur",
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
            "METHOD" => "MODE",
            "Cash" => "Especes",
            "Card" => "Carte",
            "Received" => "Recu",
            "Change" => "Monnaie",
            "Other" => "Autre",
            "ADJUSTMENTS" => "AJUSTEMENTS",
            "Void" => "Annulation",
            "Refund" => "Remboursement",
            "Thank you" => "Merci",
            "Thank you visit" => "Merci de votre visite!",
            "Thank you preference" => "Merci de votre pr\u{00E9}f\u{00E9}rence!",
            "Payment method" => "Mode de paiement",
            "VAT" => "TVA",
            "TAX_OFFICE" => "Bureau fiscal",
            "Shift" => "Shift",
            "Staff" => "Personnel",
            "SHIFT CHECKOUT" => "CLOTURE DE SHIFT",
            "Z REPORT" => "RAPPORT Z",
            "Role" => "Role",
            "Cashier" => "Caissier",
            "Manager" => "Manager",
            "Kitchen" => "Cuisine",
            "Server" => "Serveur",
            "Shifts" => "Shifts",
            "Terminal" => "Terminal",
            "Check-in" => "Debut",
            "Check-out" => "Fin",
            "Orders" => "Commandes",
            "Sales" => "Ventes",
            "Expenses" => "Depenses",
            "Refunds" => "Remboursements",
            "Opening" => "Ouverture",
            "Expected" => "Attendu",
            "Closing" => "Cloture",
            "Variance" => "Ecart",
            "DRIVER DELIVERIES" => "LIVRAISONS LIVREUR",
            "Generated" => "Genere",
            "Gross" => "Brut",
            "Net" => "Net",
            "Voids" => "Annulations",
            "Discounts" => "Remises",
            "DELIVERIES" => "LIVRAISONS",
            "DRIVER SUMMARY" => "RESUME LIVREUR",
            "Cash Collected" => "Especes encaissees",
            "Card Collected" => "Carte encaissee",
            "Delivery Fees" => "Frais de livraison",
            "Starting" => "Depart",
            "Starting Amount" => "Montant initial",
            "Total Sells" => "Ventes totales",
            "+ Cash" => "+ Especes",
            "- Expenses" => "- Depenses",
            "= To Return" => "= A rendre",
            "Amount to be Returned" => "Montant a rendre",
            "Canceled/Refunded" => "Annule/Rembourse",
            "SALES" => "VENTES",
            "PAYMENTS" => "PAIEMENTS",
            "Tips" => "Pourboires",
            "ORDER BREAKDOWN" => "REPARTITION COMMANDES",
            "Dine-in" => "Sur place",
            "Takeaway" => "A emporter",
            "CASH DRAWER" => "CAISSE",
            "STAFF" => "PERSONNEL",
            "Cash Sales" => "Ventes especes",
            "Card Sales" => "Ventes carte",
            "Cash Drops" => "Sorties especes",
            "Driver Given" => "Donne au livreur",
            "Driver Returned" => "Rendu par livreur",
            "Transferred Staff" => "Personnel transfere",
            "Transferred Staff Returns" => "Retours du personnel transfere",
            "Expected In Drawer" => "Attendu en caisse",
            "Counted Cash" => "Especes comptees",
            "Staff Payouts" => "Decaissements du personnel",
            "Staff Payouts*" => "Decaissements du personnel*",
            "STAFF PAYOUTS" => "DECAISSEMENTS DU PERSONNEL",
            "Payout" => "Decaissement",
            "Staff Payments*" => "Decaissements du personnel*",
            "Informational only" => "Information seulement",
            "KITCHEN TICKET" => "BON CUISINE",
            "Phone" => "T\u{00E9}l.",
            "Road" => "Rue",
            "Ringer" => "Sonnette",
            "Postal" => "CP",
            "No items" => "Aucun article",
            "No payment recorded" => "Aucun paiement enregistre",
            "Note" => "Note",
            "Without" => "Sans",
            "Little" => "Peu",
            "Category" => "Categorie",
            _ => key,
        },
        "it" => match key {
            "Order" => "Ordine",
            "Type" => "Tipo",
            "Date" => "Data",
            "Table" => "Tavolo",
            "Customer" => "Cliente",
            "DELIVERY" => "CONSEGNA",
            "DELIVERY SLIP" => "BOLLA CONSEGNA",
            "Driver" => "Corriere",
            "Driver ID" => "ID Corriere",
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
            "METHOD" => "METODO",
            "Cash" => "Contanti",
            "Card" => "Carta",
            "Received" => "Ricevuto",
            "Change" => "Resto",
            "Other" => "Altro",
            "ADJUSTMENTS" => "RETTIFICHE",
            "Void" => "Annullamento",
            "Refund" => "Rimborso",
            "Thank you" => "Grazie",
            "Thank you visit" => "Grazie per la vostra visita!",
            "Thank you preference" => "Grazie per la vostra preferenza!",
            "Payment method" => "Metodo di pagamento",
            "VAT" => "P.IVA",
            "TAX_OFFICE" => "Ufficio fiscale",
            "Shift" => "Turno",
            "Staff" => "Personale",
            "SHIFT CHECKOUT" => "CHIUSURA TURNO",
            "Z REPORT" => "RAPPORTO Z",
            "Role" => "Ruolo",
            "Cashier" => "Cassiere",
            "Manager" => "Manager",
            "Kitchen" => "Cucina",
            "Server" => "Cameriere",
            "Shifts" => "Turni",
            "Terminal" => "Terminale",
            "Check-in" => "Ingresso",
            "Check-out" => "Uscita",
            "Orders" => "Ordini",
            "Sales" => "Vendite",
            "Expenses" => "Spese",
            "Refunds" => "Rimborsi",
            "Opening" => "Apertura",
            "Expected" => "Atteso",
            "Closing" => "Chiusura",
            "Variance" => "Differenza",
            "DRIVER DELIVERIES" => "CONSEGNE CORRIERE",
            "Generated" => "Generato",
            "Gross" => "Lordo",
            "Net" => "Netto",
            "Voids" => "Annulli",
            "Discounts" => "Sconti",
            "DELIVERIES" => "CONSEGNE",
            "DRIVER SUMMARY" => "RIEPILOGO CORRIERE",
            "Cash Collected" => "Contanti incassati",
            "Card Collected" => "Carta incassata",
            "Delivery Fees" => "Spese consegna",
            "Starting" => "Inizio",
            "Starting Amount" => "Importo iniziale",
            "Total Sells" => "Vendite totali",
            "+ Cash" => "+ Contanti",
            "- Expenses" => "- Spese",
            "= To Return" => "= Da restituire",
            "Amount to be Returned" => "Importo da restituire",
            "Canceled/Refunded" => "Annullato/Rimborsato",
            "SALES" => "VENDITE",
            "PAYMENTS" => "PAGAMENTI",
            "Tips" => "Mance",
            "ORDER BREAKDOWN" => "RIPARTIZIONE ORDINI",
            "Dine-in" => "Al tavolo",
            "Takeaway" => "Asporto",
            "CASH DRAWER" => "CASSETTO CASSA",
            "STAFF" => "PERSONALE",
            "Cash Sales" => "Vendite contanti",
            "Card Sales" => "Vendite carta",
            "Cash Drops" => "Prelievi contanti",
            "Driver Given" => "Dato al corriere",
            "Driver Returned" => "Reso dal corriere",
            "Transferred Staff" => "Personale trasferito",
            "Transferred Staff Returns" => "Restituzioni personale trasferito",
            "Expected In Drawer" => "Atteso in cassa",
            "Counted Cash" => "Contanti contati",
            "Staff Payouts" => "Uscite personale",
            "Staff Payouts*" => "Uscite personale*",
            "STAFF PAYOUTS" => "USCITE PERSONALE",
            "Payout" => "Uscita",
            "Staff Payments*" => "Uscite personale*",
            "Informational only" => "Solo informativo",
            "KITCHEN TICKET" => "COMANDA CUCINA",
            "Phone" => "Tel.",
            "Road" => "Via",
            "Ringer" => "Citofono",
            "Postal" => "CAP",
            "No items" => "Nessun articolo",
            "No payment recorded" => "Nessun pagamento registrato",
            "Note" => "Nota",
            "Without" => "Senza",
            "Little" => "Poco",
            "Category" => "Categoria",
            _ => key,
        },
        _ => key,
    }
}

fn non_empty_receipt_value(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn title_case_words(value: &str) -> String {
    let words = value
        .split(|ch: char| ch == '_' || ch == '-' || ch.is_whitespace())
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let mut chars = segment.chars();
            match chars.next() {
                Some(first) => {
                    let mut word = String::new();
                    word.extend(first.to_uppercase());
                    word.push_str(&chars.as_str().to_ascii_lowercase());
                    word
                }
                None => String::new(),
            }
        })
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if words.is_empty() {
        "Staff".to_string()
    } else {
        words.join(" ")
    }
}

pub fn receipt_role_text(lang: &str, role_type: &str) -> String {
    let key = match role_type.trim().to_ascii_lowercase().as_str() {
        "cashier" => Some("Cashier"),
        "manager" => Some("Manager"),
        "driver" => Some("Driver"),
        "kitchen" => Some("Kitchen"),
        "server" => Some("Server"),
        "staff" => Some("Staff"),
        _ => None,
    };
    key.map(|value| receipt_label(lang, value).to_string())
        .unwrap_or_else(|| title_case_words(role_type))
}

fn z_report_shift_line(doc: &ZReportDoc, lang: &str) -> Option<(String, String)> {
    if let Some(shift_ref) = non_empty_receipt_value(&doc.shift_ref) {
        return Some((
            receipt_label(lang, "Shift").to_string(),
            shift_ref.to_string(),
        ));
    }
    doc.shift_count
        .filter(|count| *count > 0)
        .map(|count| (receipt_label(lang, "Shifts").to_string(), count.to_string()))
}

/// Translate an order type string (e.g. "pickup", "delivery", "dine_in", "takeaway")
/// to the configured receipt language. Returns an owned uppercase string.
fn translate_order_type(lang: &str, order_type: &str) -> String {
    let normalized = order_type.trim().to_ascii_lowercase().replace('-', "_");
    let translated = match lang {
        "el" => match normalized.as_str() {
            "pickup" => "\u{03A0}\u{0391}\u{03A1}\u{0391}\u{039B}\u{0391}\u{0392}\u{0397}", // ΠΑΡΑΛΑΒΗ
            "delivery" => "\u{03A0}\u{0391}\u{03A1}\u{0391}\u{0394}\u{039F}\u{03A3}\u{0397}", // ΠΑΡΑΔΟΣΗ
            "dine_in" => "\u{0395}\u{03A0}\u{0399}\u{03A4}\u{039F}\u{03A0}\u{039F}\u{03A5}", // ΕΠΙΤΟΠΟΥ
            "takeaway" => "TAKE AWAY",
            _ => return order_type.to_uppercase(),
        },
        "de" => match normalized.as_str() {
            "pickup" => "ABHOLUNG",
            "delivery" => "LIEFERUNG",
            "dine_in" => "VOR ORT",
            "takeaway" => "ZUM MITNEHMEN",
            _ => return order_type.to_uppercase(),
        },
        "fr" => match normalized.as_str() {
            "pickup" => "RETRAIT",
            "delivery" => "LIVRAISON",
            "dine_in" => "SUR PLACE",
            "takeaway" => "\u{00C0} EMPORTER",
            _ => return order_type.to_uppercase(),
        },
        "it" => match normalized.as_str() {
            "pickup" => "RITIRO",
            "delivery" => "CONSEGNA",
            "dine_in" => "AL TAVOLO",
            "takeaway" => "DA ASPORTO",
            _ => return order_type.to_uppercase(),
        },
        _ => return order_type.to_uppercase(),
    };
    translated.to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct EscPosRender {
    pub bytes: Vec<u8>,
    pub warnings: Vec<RenderWarning>,
    pub body_mode: EscPosBodyMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscPosBodyMode {
    Text,
    RasterExact,
}

fn esc(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Extract a short display number from an order ID.
///
/// `"ORD-20260303-00019"` → `"00019"`
/// `"A-12"` → `"A-12"` (returned as-is if no ORD- prefix)
/// `"00019"` → `"00019"` (returned as-is)
fn extract_short_order_number(order_number: &str) -> &str {
    let s = order_number.trim();
    // Handle ORD-YYYYMMDD-NNNNN format: take the last segment after the last dash
    if s.starts_with("ORD-") || s.starts_with("ord-") {
        if let Some(pos) = s.rfind('-') {
            let suffix = &s[pos + 1..];
            if !suffix.is_empty() {
                return suffix;
            }
        }
    }
    s
}

fn money(value: f64) -> String {
    format!("{value:.2}")
}

/// Format a monetary value using comma as decimal separator (e.g. Greek locale).
fn money_locale(value: f64, comma: bool) -> String {
    let s = format!("{value:.2}");
    if comma {
        s.replace('.', ",")
    } else {
        s
    }
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

fn money_with_currency_locale(value: f64, symbol: &str, comma: bool) -> String {
    let amount = money_locale(value, comma);
    if symbol.is_empty() {
        amount
    } else {
        format!("{}{}", amount, symbol)
    }
}

fn is_known_euro_character_set(character_set: &str) -> bool {
    matches!(
        character_set.trim().to_ascii_uppercase().as_str(),
        "PC437_USA"
            | "PC737_GREEK"
            | "PC850_MULTILINGUAL"
            | "PC852_LATIN2"
            | "PC866_CYRILLIC"
            | "PC1252_LATIN1"
            | "PC851_GREEK"
            | "PC869_GREEK"
    )
}

/// Normalize currency symbol rendering for ESC/POS compatibility.
///
/// Euro (`€`) is preferred, but when printer/code-page support is not
/// confidently known, fallback to ASCII `EUR` to avoid mojibake.
pub fn normalize_currency_symbol_for_layout(
    symbol: &str,
    character_set: &str,
    escpos_code_page: Option<u8>,
    brand: crate::printers::PrinterBrand,
) -> String {
    if !symbol.contains('€') {
        return symbol.to_string();
    }

    let charset_supported = is_known_euro_character_set(character_set);
    let brand_supported = !matches!(brand, crate::printers::PrinterBrand::Unknown);
    let code_page_supported = match escpos_code_page {
        Some(page) => resolve_auto_code_page(brand, character_set)
            .map(|expected| expected == page)
            .unwrap_or(false),
        None => true,
    };

    if charset_supported && brand_supported && code_page_supported {
        symbol.to_string()
    } else {
        symbol.replace('€', "EUR")
    }
}

fn header_primary_line(cfg: &LayoutConfig) -> &str {
    let org = cfg.organization_name.trim();
    if let Some(branch) = cfg
        .store_subtitle
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != org && !value.eq_ignore_ascii_case(org))
    {
        branch
    } else {
        org
    }
}

fn append_html_header_block(
    body: &mut String,
    cfg: &LayoutConfig,
    lang: &str,
    include_logo_placeholder: bool,
) {
    // Logo area
    if include_logo_placeholder && cfg.show_logo {
        body.push_str("<div class=\"logo-area\"><div class=\"logo-circle\">");
        if let Some(url) = cfg
            .logo_url
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            body.push_str(&format!("<img src=\"{}\" alt=\"Logo\"/>", esc(url)));
        } else {
            // Text fallback: use first significant word of org name
            let org = cfg.organization_name.trim();
            let abbreviation = org
                .split_whitespace()
                .next()
                .unwrap_or(org)
                .chars()
                .take(8)
                .collect::<String>();
            body.push_str(&format!(
                "<span class=\"logo-text\">{}</span>",
                esc(&abbreviation)
            ));
        }
        body.push_str("</div></div>");
    }

    // Branch info
    body.push_str("<div class=\"branch-info\">");

    let primary_line = header_primary_line(cfg);
    body.push_str(&format!(
        "<div class=\"store-name\">{}</div>",
        esc(primary_line)
    ));

    if let Some(label) = cfg
        .copy_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.push_str(&format!(
            "<div style=\"font-size:9px;color:#888\">{}</div>",
            esc(label)
        ));
    }

    // Subtitle (e.g. "la crêperie")
    if let Some(subtitle) = cfg
        .store_subtitle
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let org = cfg.organization_name.trim();
        // Only show subtitle if it's different from the org name
        if !subtitle.eq_ignore_ascii_case(org) {
            body.push_str(&format!("<div class=\"store-sub\">{}</div>", esc(subtitle)));
        }
    }

    // Store details (address, phone, vat)
    let mut detail_parts: Vec<String> = Vec::new();

    if let Some(address) = cfg
        .store_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        detail_parts.push(esc(address));
    }

    if let Some(phone) = cfg
        .store_phone
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let phone_label = receipt_label(lang, "Phone");
        detail_parts.push(format!("{}: {}", esc(phone_label), esc(phone)));
    }

    // VAT and tax office on same line if both exist
    let vat = cfg
        .vat_number
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let tax = cfg
        .tax_office
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match (vat, tax) {
        (Some(v), Some(t)) => {
            detail_parts.push(format!(
                "{}: {} &nbsp;|&nbsp; {}: {}",
                esc(receipt_label(lang, "VAT")),
                esc(v),
                esc(receipt_label(lang, "TAX_OFFICE")),
                esc(t)
            ));
        }
        (Some(v), None) => {
            detail_parts.push(format!("{}: {}", esc(receipt_label(lang, "VAT")), esc(v)));
        }
        (None, Some(t)) => {
            detail_parts.push(format!(
                "{}: {}",
                esc(receipt_label(lang, "TAX_OFFICE")),
                esc(t)
            ));
        }
        (None, None) => {}
    }

    if !detail_parts.is_empty() {
        body.push_str(&format!(
            "<div class=\"store-detail\">{}</div>",
            detail_parts.join("<br>")
        ));
    }

    body.push_str("</div>"); // close branch-info
}

/// Format an ISO-8601 timestamp to `DD/MM/YYYY HH:MM`.
fn format_datetime_human(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|dt| {
            dt.with_timezone(&Local)
                .format("%d/%m/%Y %H:%M")
                .to_string()
        })
        .unwrap_or_else(|_| {
            let trimmed = &iso[..iso.len().min(26)];
            chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.f")
                .map(|dt| dt.format("%d/%m/%Y %H:%M").to_string())
                .unwrap_or_else(|_| iso.to_string())
        })
}

fn should_render_shift_checkout_driver_summary(doc: &ShiftCheckoutDoc) -> bool {
    doc.role_type == "driver"
}

fn should_render_shift_checkout_cashier_summary(doc: &ShiftCheckoutDoc) -> bool {
    matches!(doc.role_type.as_str(), "cashier" | "manager")
}

fn should_render_minimal_shift_checkout(doc: &ShiftCheckoutDoc) -> bool {
    crate::shifts::is_non_financial_shift_role(&doc.role_type)
}

#[derive(Clone, Copy)]
struct DriverShiftCheckoutSummaryRow {
    label_key: &'static str,
    amount: f64,
    emphasize: bool,
}

fn driver_shift_checkout_summary_rows(
    doc: &ShiftCheckoutDoc,
) -> Vec<DriverShiftCheckoutSummaryRow> {
    let total_sells = if doc.total_sells > 0.0 {
        doc.total_sells
    } else {
        doc.total_cash_collected + doc.total_card_collected
    };

    let mut rows = vec![
        DriverShiftCheckoutSummaryRow {
            label_key: "Starting Amount",
            amount: doc.opening_amount,
            emphasize: false,
        },
        DriverShiftCheckoutSummaryRow {
            label_key: "Total Sells",
            amount: total_sells,
            emphasize: false,
        },
        DriverShiftCheckoutSummaryRow {
            label_key: "Card",
            amount: doc.total_card_collected,
            emphasize: false,
        },
        DriverShiftCheckoutSummaryRow {
            label_key: "Cash",
            amount: doc.total_cash_collected,
            emphasize: false,
        },
    ];

    if doc.total_expenses > 0.0 {
        rows.push(DriverShiftCheckoutSummaryRow {
            label_key: "Expenses",
            amount: -doc.total_expenses,
            emphasize: false,
        });
    }

    if doc.total_tips > 0.0 {
        rows.push(DriverShiftCheckoutSummaryRow {
            label_key: "Tips",
            amount: doc.total_tips,
            emphasize: false,
        });
    }

    if doc.cancelled_or_refunded_total > 0.0 {
        rows.push(DriverShiftCheckoutSummaryRow {
            label_key: "Canceled/Refunded",
            amount: doc.cancelled_or_refunded_total,
            emphasize: false,
        });
    }

    rows.push(DriverShiftCheckoutSummaryRow {
        label_key: "Amount to be Returned",
        amount: doc.amount_to_return,
        emphasize: true,
    });

    rows
}

fn customization_qty(value: f64) -> String {
    if value <= 0.0 {
        return "1".to_string();
    }
    qty(value)
}

fn trim_to_option(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn build_primary_category_name(item: &ReceiptItem) -> Option<String> {
    if let Some(category) = trim_to_option(item.category_name.as_deref()) {
        return Some(category);
    }

    if let Some(path) = trim_to_option(item.category_path.as_deref()) {
        let primary = path
            .split('>')
            .next()
            .map(str::trim)
            .filter(|entry| !entry.is_empty());
        if let Some(primary) = primary {
            return Some(primary.to_string());
        }
        return Some(path);
    }

    trim_to_option(item.subcategory_name.as_deref())
}

fn category_line(_lang: &str, item: &ReceiptItem) -> Option<String> {
    build_primary_category_name(item)
}

fn push_unique_line(lines: &mut Vec<String>, raw: Option<&str>) {
    let Some(trimmed) = trim_to_option(raw) else {
        return;
    };
    if lines
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&trimmed))
    {
        return;
    }
    lines.push(trimmed);
}

fn order_note_lines(doc: &OrderReceiptDoc) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in &doc.order_notes {
        push_unique_line(&mut lines, Some(raw.as_str()));
    }
    lines
}

fn kitchen_order_note_lines(doc: &KitchenTicketDoc) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    push_unique_line(&mut lines, doc.delivery_notes.as_deref());
    push_unique_line(&mut lines, doc.special_instructions.as_deref());
    lines
}

fn category_raster_style(base: RasterTextStyle) -> RasterTextStyle {
    RasterTextStyle {
        weight: RasterTextWeight::Bold,
        ..base
    }
}

fn format_discount_percent(percent: f64) -> String {
    let clamped = if percent.is_finite() {
        percent.max(0.0)
    } else {
        0.0
    };
    if (clamped.fract()).abs() < f64::EPSILON {
        format!("{}%", clamped as i64)
    } else {
        let raw = format!("{clamped:.2}");
        let trimmed = raw.trim_end_matches('0').trim_end_matches('.');
        format!("{trimmed}%")
    }
}

fn total_label_text(lang: &str, total: &TotalsLine) -> String {
    let base = receipt_label(lang, &total.label);
    if total.label.eq_ignore_ascii_case("discount") {
        if let Some(percent) = total.discount_percent.filter(|value| *value > 0.0) {
            return format!("{base} ({})", format_discount_percent(percent));
        }
    }
    base.to_string()
}

fn customization_display(
    lang: &str,
    customization: &ReceiptCustomizationLine,
    include_price: bool,
) -> String {
    let mut line = customization.name.trim().to_string();
    let quantity = customization_qty(customization.quantity);
    if quantity != "1" {
        line.push_str(&format!(" x{quantity}"));
    }
    if customization.is_little {
        line.push_str(&format!(" ({})", receipt_label(lang, "Little")));
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

fn append_customizations_html(body: &mut String, item: &ReceiptItem, lang: &str) {
    let (with_items, without_items) = split_customizations(item);
    if with_items.is_empty() && without_items.is_empty() {
        return;
    }

    if !with_items.is_empty() {
        for customization in with_items {
            body.push_str(&format!(
                "<div class=\"note\">+ {}</div>",
                esc(&customization_display(lang, customization, true))
            ));
        }
    }

    if !without_items.is_empty() {
        body.push_str(&format!(
            "<div class=\"note\">- {}</div>",
            esc(receipt_label(lang, "Without"))
        ));
        for customization in without_items {
            body.push_str(&format!(
                "<div class=\"note\">&nbsp;&nbsp;- {}</div>",
                esc(&customization_display(lang, customization, false))
            ));
        }
    }
}

fn delivery_value_or_dash(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| "-".to_string())
}

fn extract_postal_from_text(input: &str) -> Option<String> {
    let mut digit_tokens: Vec<String> = Vec::new();
    for token in input.split(|ch: char| !ch.is_ascii_digit()) {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            digit_tokens.push(trimmed.to_string());
        }
    }
    for (idx, token) in digit_tokens.iter().enumerate() {
        if token.len() == 5 {
            return Some(token.clone());
        }
        if token.len() == 3 {
            if let Some(next) = digit_tokens.get(idx + 1) {
                if next.len() == 2 {
                    return Some(format!("{token}{next}"));
                }
            }
        }
    }
    None
}

fn extract_floor_from_text(input: &str) -> Option<String> {
    let normalized = input.trim().to_ascii_lowercase();
    if !(normalized.contains("floor") || normalized.contains("όρο") || normalized.contains("οροφ"))
    {
        return None;
    }
    let digits: String = input.chars().filter(|ch| ch.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

fn extract_city_from_text(input: &str) -> Option<String> {
    let normalized = input.trim().to_ascii_lowercase();
    if normalized.contains("floor") || normalized.contains("όρο") || normalized.contains("οροφ")
    {
        return None;
    }

    let mut cleaned = String::new();
    for ch in input.chars() {
        if ch.is_ascii_digit() {
            continue;
        }
        if matches!(ch, ',' | ';' | ':' | '|' | '-' | '_') {
            cleaned.push(' ');
        } else {
            cleaned.push(ch);
        }
    }
    let collapsed = cleaned.split_whitespace().collect::<Vec<&str>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_delivery_address_components(
    doc: &OrderReceiptDoc,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let mut address = trim_to_option(doc.delivery_address.as_deref());
    let mut city = trim_to_option(doc.delivery_city.as_deref());
    let mut postal = trim_to_option(doc.delivery_postal_code.as_deref());
    let mut floor = trim_to_option(doc.delivery_floor.as_deref());

    if let Some(address_text) = address.as_deref() {
        let segments = split_address_segments(address_text);
        if let Some(first) = segments.first() {
            // Lock: the Address line is always the first street segment only.
            address = Some(first.clone());
        }
        for segment in segments.iter().skip(1) {
            if city.is_none() {
                city = extract_city_from_text(segment);
            }
            if postal.is_none() {
                postal = extract_postal_from_text(segment);
            }
            if floor.is_none() {
                floor = extract_floor_from_text(segment);
            }
        }
    }

    (address, city, postal, floor)
}

/// Collect delivery fields as (label, value) pairs for HTML rendering.
fn delivery_fields<'a>(doc: &'a OrderReceiptDoc, lang: &str) -> Vec<(&'a str, &'a str)> {
    let mut fields: Vec<(&str, &str)> = Vec::new();
    let try_field = |opt: &'a Option<String>| -> Option<&'a str> {
        opt.as_deref().map(str::trim).filter(|v| !v.is_empty())
    };
    if let Some(v) = try_field(&doc.driver_name) {
        fields.push((receipt_label(lang, "Driver"), v));
    }
    if let Some(v) = try_field(&doc.delivery_address) {
        fields.push((receipt_label(lang, "Address"), v));
    }
    if let Some(v) = try_field(&doc.customer_phone) {
        fields.push((receipt_label(lang, "Phone"), v));
    }
    if let Some(v) = try_field(&doc.delivery_city) {
        fields.push((receipt_label(lang, "City"), v));
    }
    if let Some(v) = try_field(&doc.delivery_postal_code) {
        fields.push((receipt_label(lang, "Postal Code"), v));
    }
    if let Some(v) = try_field(&doc.delivery_floor) {
        fields.push((receipt_label(lang, "Floor"), v));
    }
    if let Some(v) = try_field(&doc.name_on_ringer) {
        fields.push((receipt_label(lang, "Name on ringer"), v));
    }
    fields
}

fn delivery_slip_info_lines(doc: &OrderReceiptDoc, lang: &str) -> Vec<(String, String)> {
    let (address, city, postal, floor) = normalize_delivery_address_components(doc);
    let mut lines = Vec::new();
    lines.push((
        receipt_label(lang, "Driver").to_string(),
        delivery_value_or_dash(doc.driver_name.as_deref()),
    ));

    lines.push((
        receipt_label(lang, "Customer").to_string(),
        delivery_value_or_dash(doc.customer_name.as_deref()),
    ));
    lines.push((
        receipt_label(lang, "Phone").to_string(),
        delivery_value_or_dash(doc.customer_phone.as_deref()),
    ));
    lines.push((
        receipt_label(lang, "Address").to_string(),
        delivery_value_or_dash(address.as_deref()),
    ));
    lines.push((
        receipt_label(lang, "City").to_string(),
        delivery_value_or_dash(city.as_deref()),
    ));
    lines.push((
        receipt_label(lang, "Postal").to_string(),
        delivery_value_or_dash(postal.as_deref()),
    ));
    lines.push((
        receipt_label(lang, "Floor").to_string(),
        delivery_value_or_dash(floor.as_deref()),
    ));
    lines.push((
        receipt_label(lang, "Ringer").to_string(),
        delivery_value_or_dash(doc.name_on_ringer.as_deref()),
    ));

    lines
}

fn is_change_like_payment_label(label: &str) -> bool {
    let normalized = label.trim().to_lowercase();
    normalized == "change" || normalized == "received" || normalized == "ρέστα"
}

fn payment_amount_unknown(payment: &PaymentLine) -> bool {
    payment
        .detail
        .as_deref()
        .map(str::trim)
        .is_some_and(|detail| detail.eq_ignore_ascii_case(PAYMENT_DETAIL_AMOUNT_UNKNOWN))
}

fn method_only_payment_label(doc: &OrderReceiptDoc, lang: &str) -> Option<String> {
    doc.payments.iter().find_map(|payment| {
        if is_change_like_payment_label(&payment.label) {
            return None;
        }
        if !payment_amount_unknown(payment) {
            return None;
        }
        let mapped = receipt_label(lang, &payment.label).trim();
        if mapped.is_empty() {
            None
        } else {
            Some(mapped.to_string())
        }
    })
}

fn has_payment_amount_warning(doc: &OrderReceiptDoc) -> bool {
    doc.payments.iter().any(|payment| {
        !is_change_like_payment_label(&payment.label) && payment_amount_unknown(payment)
    })
}

/// Render item customizations using the new `item-mods` class.
fn append_customizations_html_v2(body: &mut String, item: &ReceiptItem, lang: &str) {
    let (with_items, without_items) = split_customizations(item);
    if with_items.is_empty() && without_items.is_empty() {
        return;
    }
    let mut mods = Vec::new();
    for customization in with_items {
        mods.push(format!(
            "+ {}",
            esc(&customization_display(lang, customization, true))
        ));
    }
    if !without_items.is_empty() {
        for customization in without_items {
            mods.push(format!(
                "- {}",
                esc(&customization_display(lang, customization, false))
            ));
        }
    }
    if !mods.is_empty() {
        body.push_str(&format!(
            "<div class=\"item-mods\">{}</div>",
            mods.join("<br>")
        ));
    }
}

fn should_render_delivery_block(doc: &OrderReceiptDoc) -> bool {
    if !doc.order_type.trim().eq_ignore_ascii_case("delivery") {
        return false;
    }

    [
        doc.driver_name.as_deref(),
        doc.delivery_address.as_deref(),
        doc.customer_phone.as_deref(),
        doc.delivery_city.as_deref(),
        doc.delivery_postal_code.as_deref(),
        doc.delivery_floor.as_deref(),
        doc.name_on_ringer.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .any(|value| !value.is_empty())
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
    use_star_commands: bool,
) -> Vec<RenderWarning> {
    let mut warnings = Vec::new();
    let cs = character_set.trim().to_ascii_uppercase();

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
        if use_star_commands {
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
                if use_star_commands {
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
    emulation_mode: ReceiptEmulationMode,
) -> Vec<RenderWarning> {
    apply_character_set(
        builder,
        character_set,
        greek_render_mode,
        escpos_code_page,
        uses_star_commands(brand, emulation_mode),
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

fn html_shell(title: &str, body: &str, cfg: &LayoutConfig) -> String {
    let template_cls = match cfg.template {
        ReceiptTemplate::Modern => "modern",
        ReceiptTemplate::Classic => "classic",
    };
    // Scale classic CSS font sizes: base_size * text_scale (base sizes are the
    // original unscaled values; at text_scale=1.0 they match the original CSS).
    let ts = cfg.text_scale;
    let classic_font_scale = match cfg.font_type {
        FontType::A => 1.0_f32,
        FontType::B => 0.88_f32,
    };
    let classic_spacing_scale = match cfg.layout_density {
        LayoutDensity::Compact => 0.9_f32,
        LayoutDensity::Balanced => 1.0_f32,
        LayoutDensity::Spacious => 1.18_f32,
    } * cfg.layout_density_scale.clamp(0.7, 1.35);
    let classic_meta_line_height = match cfg.layout_density {
        LayoutDensity::Compact => 1.65_f32,
        LayoutDensity::Balanced => 1.85_f32,
        LayoutDensity::Spacious => 2.05_f32,
    } * cfg.layout_density_scale.clamp(0.7, 1.35);
    let classic_detail_line_height = match cfg.layout_density {
        LayoutDensity::Compact => 1.55_f32,
        LayoutDensity::Balanced => 1.75_f32,
        LayoutDensity::Spacious => 1.95_f32,
    } * cfg.layout_density_scale.clamp(0.7, 1.35);
    let classic_footer_line_height = match cfg.layout_density {
        LayoutDensity::Compact => 1.7_f32,
        LayoutDensity::Balanced => 2.0_f32,
        LayoutDensity::Spacious => 2.2_f32,
    } * cfg.layout_density_scale.clamp(0.7, 1.35);
    let classic_header_weight = if cfg.header_emphasis == HeaderEmphasis::Strong {
        700
    } else {
        500
    };
    let classic_header_letter_spacing = if cfg.header_emphasis == HeaderEmphasis::Strong {
        3.0_f32
    } else {
        1.5_f32
    };
    let classic_section_padding_y = if cfg.header_emphasis == HeaderEmphasis::Strong {
        3.0_f32
    } else {
        2.0_f32
    };
    let classic_rule_margin = (10.0_f32 * classic_spacing_scale).round();
    let classic_section_margin_top = (10.0_f32 * classic_spacing_scale).round();
    let classic_section_margin_bottom = (8.0_f32 * classic_spacing_scale).round();
    let classic_item_margin_bottom = (6.0_f32 * classic_spacing_scale).round();
    let classic_item_mods_margin_top = classic_spacing_scale.max(1.0_f32);
    let classic_table_cell_padding = (2.0_f32 * classic_spacing_scale).round();
    let classic_footer_margin_top = (14.0_f32 * classic_spacing_scale).round();
    let c_store_name = 12.0_f32 * ts * classic_font_scale;
    let c_store_sub = 10.0_f32 * ts;
    let c_store_detail = 9.0_f32 * ts * classic_font_scale;
    let c_meta = 9.0_f32 * ts * classic_font_scale;
    let c_sec_head = 9.0_f32 * ts * classic_font_scale;
    let c_item = 10.0_f32 * ts * classic_font_scale;
    let c_item_mods = 8.5_f32 * ts * classic_font_scale;
    let c_table = 10.0_f32 * ts * classic_font_scale;
    let c_grand = 13.0_f32 * ts * classic_font_scale;
    let c_footer = 9.0_f32 * ts * classic_font_scale;
    // Logo dimensions scale with logo_scale (base: 60px circle, 11px text).
    let logo_w = (60.0_f32 * cfg.logo_scale).round();
    let logo_h = logo_w;
    let logo_font = (11.0_f32 * cfg.logo_scale).round();
    let body_font_weight = cfg.body_font_weight;
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>{title}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&amp;family=Courier+Prime:wght@400;700&amp;family=IBM+Plex+Mono:wght@400;500;700&amp;display=swap" rel="stylesheet"/>
<style>
*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{ background: #2a2a2a; display: flex; justify-content: center; padding: 32px 16px; min-height: 100vh; }}
.receipt {{ background: #fff; width: 300px; padding: 28px 22px 24px; box-shadow: 0 8px 40px rgba(0,0,0,0.5); color: #000; position: relative; }}
.receipt {{ font-weight: {body_font_weight}; }}
.receipt::before, .receipt::after {{ content: ''; position: absolute; left: 0; right: 0; height: 8px; background: repeating-linear-gradient(90deg, #fff 0 8px, transparent 8px 16px); }}
.receipt::before {{ top: -8px; }}
.receipt::after {{ bottom: -8px; }}

/* Logo */
.logo-area {{ text-align: center; margin-bottom: 12px; }}
.logo-circle {{ width: {logo_w}px; height: {logo_h}px; border: 2px solid #000; border-radius: 50%; margin: 0 auto 8px; display: flex; align-items: center; justify-content: center; overflow: hidden; }}
.logo-circle img {{ width: 100%; height: 100%; object-fit: contain; }}
.logo-circle .logo-text {{ font-size: {logo_font}px; font-weight: 700; text-transform: uppercase; text-align: center; line-height: 1.2; }}

/* Branch info (shared) */
.branch-info {{ text-align: center; margin-bottom: 14px; }}

/* ── MODERN ── */
.modern .branch-info .store-name {{ font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 1px; }}
.modern .branch-info .store-sub {{ font-family: 'Playfair Display', Georgia, serif; font-size: 10px; font-style: italic; color: #555; margin-bottom: 5px; }}
.modern .branch-info .store-detail {{ font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 8.5px; color: #555; line-height: 1.75; }}
.modern hr {{ border: none; border-top: 1px solid #000; margin: 12px 0; }}
.modern hr.thin {{ border-top: 1px dotted #bbb; margin: 10px 0; }}
.modern .order-type {{ font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 9px; font-weight: 700; letter-spacing: 2px; border: 1.5px solid #000; display: inline-block; padding: 2px 10px; text-align: center; margin-bottom: 8px; }}
.modern .meta-grid {{ display: grid; grid-template-columns: auto 1fr; column-gap: 10px; row-gap: 2px; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 9px; }}
.modern .meta-grid .k {{ color: #888; }}
.modern .meta-grid .v {{ text-align: right; font-weight: 500; }}
.modern .sec-head {{ font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 9px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; text-align: center; margin-bottom: 10px; }}
.modern .item {{ font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10px; margin-bottom: 8px; }}
.modern .item-row {{ display: flex; justify-content: space-between; }}
.modern .item-name {{ font-weight: 500; }}
.modern .item-price {{ font-weight: 700; }}
.modern .item-mods {{ font-size: 8.5px; color: #777; padding-left: 12px; margin-top: 2px; line-height: 1.6; }}
.modern table {{ width: 100%; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10px; border-collapse: collapse; }}
.modern table td {{ padding: 2px 0; }}
.modern table .r {{ text-align: right; }}
.modern table .dim {{ color: #777; }}
.modern .grand td {{ font-size: 13px; font-weight: 700; padding-top: 6px; }}
.modern .change td {{ font-size: 13px; font-weight: 700; padding-top: 6px; }}
.modern .footer {{ text-align: center; margin-top: 14px; font-family: 'Playfair Display', Georgia, serif; font-size: 11px; font-style: italic; color: #555; }}

/* ── CLASSIC ── */
.classic {{ font-family: 'Courier Prime', 'Courier New', monospace; }}
.classic .branch-info .store-name {{ font-family: 'Courier Prime', 'Courier New', monospace; font-size: {c_store_name}px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 1px; }}
.classic .branch-info .store-sub {{ font-family: 'Playfair Display', Georgia, serif; font-size: {c_store_sub}px; font-style: italic; color: #555; margin-bottom: 5px; }}
.classic .branch-info .store-detail {{ font-family: 'Courier Prime', 'Courier New', monospace; font-size: {c_store_detail}px; color: #444; line-height: {classic_detail_line_height}; }}
.classic hr {{ border: none; border-top: 1px dashed #999; margin: {classic_rule_margin}px 0; }}
.classic hr.solid {{ border-top: 1px solid #000; margin: {classic_rule_margin}px 0; }}
.classic hr.double {{ border-top: 3px double #000; margin: {classic_rule_margin}px 0; }}
.classic .meta-line {{ font-size: {c_meta}px; line-height: {classic_meta_line_height}; }}
.classic .meta-line b {{ font-weight: 700; }}
.classic .sec-head {{ background: #000; color: #fff; font-family: 'Courier Prime', 'Courier New', monospace; font-size: {c_sec_head}px; font-weight: {classic_header_weight}; letter-spacing: {classic_header_letter_spacing}px; text-align: center; padding: {classic_section_padding_y}px 0; margin: {classic_section_margin_top}px 0 {classic_section_margin_bottom}px; }}
.classic .item {{ font-size: {c_item}px; margin-bottom: {classic_item_margin_bottom}px; }}
.classic .item-row {{ display: flex; justify-content: space-between; }}
.classic .item-name {{ font-weight: 700; }}
.classic .item-price {{ font-weight: 700; }}
.classic .item-mods {{ font-size: {c_item_mods}px; color: #666; padding-left: 10px; margin-top: {classic_item_mods_margin_top}px; line-height: {classic_detail_line_height}; }}
.classic table {{ width: 100%; font-family: 'Courier Prime', 'Courier New', monospace; font-size: {c_table}px; border-collapse: collapse; }}
.classic table td {{ padding: {classic_table_cell_padding}px 0; }}
.classic table .r {{ text-align: right; }}
.classic table .dim {{ color: #555; }}
.classic .grand td {{ font-size: {c_grand}px; font-weight: 700; padding-top: 5px; }}
.classic .change td {{ font-size: {c_grand}px; font-weight: 700; padding-top: 5px; }}
.classic .footer {{ text-align: center; margin-top: {classic_footer_margin_top}px; font-family: 'Courier Prime', 'Courier New', monospace; font-size: {c_footer}px; color: #666; line-height: {classic_footer_line_height}; letter-spacing: 1px; }}

/* Legacy compat classes */
.line {{ display: flex; justify-content: space-between; gap: 8px; font-size: 10px; }}
.line strong {{ font-size: 11px; }}
.section {{ margin-top: 8px; border-top: 1px dashed #999; padding-top: 6px; }}
.note {{ color: #666; font-size: 9px; }}
.center {{ text-align: center; }}

/* Status banner (completed / canceled receipts) */
.status-banner {{ text-align: center; padding: 6px 0; margin-bottom: 10px; font-weight: 700; font-size: 13px; letter-spacing: 1px; border-radius: 4px; }}
.status-banner.completed {{ background: #e6f4ea; color: #1a7a34; border: 1px solid #a8d5b5; }}
.status-banner.canceled {{ background: #fce8e8; color: #b00020; border: 1px solid #f5b8b8; }}
.status-banner .cancel-reason {{ font-weight: 400; font-size: 10px; margin-top: 3px; }}
</style>
</head>
<body><div class="receipt {template_cls}">{body}</div></body>
</html>"#,
        title = esc(title),
        template_cls = template_cls,
        body = body,
        logo_w = logo_w,
        logo_h = logo_h,
        logo_font = logo_font,
        c_store_name = c_store_name,
        c_store_sub = c_store_sub,
        c_store_detail = c_store_detail,
        classic_detail_line_height = classic_detail_line_height,
        classic_rule_margin = classic_rule_margin,
        c_meta = c_meta,
        classic_meta_line_height = classic_meta_line_height,
        c_sec_head = c_sec_head,
        classic_header_weight = classic_header_weight,
        classic_header_letter_spacing = classic_header_letter_spacing,
        classic_section_padding_y = classic_section_padding_y,
        classic_section_margin_top = classic_section_margin_top,
        classic_section_margin_bottom = classic_section_margin_bottom,
        c_item = c_item,
        classic_item_margin_bottom = classic_item_margin_bottom,
        c_item_mods = c_item_mods,
        classic_item_mods_margin_top = classic_item_mods_margin_top,
        c_table = c_table,
        classic_table_cell_padding = classic_table_cell_padding,
        c_grand = c_grand,
        c_footer = c_footer,
        classic_footer_margin_top = classic_footer_margin_top,
        classic_footer_line_height = classic_footer_line_height,
    )
}

/// Build the HTML for the status banner shown at the top of completed / canceled
/// receipts. Returns an empty string when `doc.status_label` is `None`.
fn build_status_banner_html(doc: &OrderReceiptDoc) -> String {
    let Some(ref label) = doc.status_label else {
        return String::new();
    };
    let css_class = if label.to_uppercase().contains("CANCEL") {
        "canceled"
    } else {
        "completed"
    };
    let reason_html = doc
        .cancellation_reason
        .as_deref()
        .filter(|r| !r.is_empty())
        .map(|r| format!("<div class=\"cancel-reason\">{}</div>", esc(r)))
        .unwrap_or_default();
    // SAFETY: `label` is only ever set to compile-time literals ("✓ COMPLETED" / "✗ CANCELED").
    // If `status_label` is ever made user-configurable, wrap `label` with `esc()`.
    format!("<div class=\"status-banner {css_class}\"><div>{label}</div>{reason_html}</div>")
}

pub fn render_html(document: &ReceiptDocument, cfg: &LayoutConfig) -> String {
    let is_modern = cfg.template == ReceiptTemplate::Modern;
    let lang = cfg.language.as_str();
    let cur = cfg.currency_symbol.as_str();
    match document {
        ReceiptDocument::OrderReceipt(doc) => {
            let render_delivery_block = should_render_delivery_block(doc);
            let display_date = format_datetime_human(&doc.created_at);
            let order_type_display = translate_order_type(lang, &doc.order_type);
            let delivery_method_only_payment = method_only_payment_label(doc, lang);
            let mut body = String::new();
            let banner = build_status_banner_html(doc);
            body.push_str(&banner);
            append_html_header_block(&mut body, cfg, lang, cfg.show_logo);

            if is_modern {
                // ── Modern layout ──
                body.push_str("<hr>");
                body.push_str(&format!(
                    "<div style=\"text-align:center; margin-bottom:8px;\"><span class=\"order-type\">{}</span></div>",
                    esc(&order_type_display)
                ));
                body.push_str("<div class=\"meta-grid\">");
                body.push_str(&format!(
                    "<span class=\"k\">{}</span><span class=\"v\">#{}</span>",
                    esc(receipt_label(lang, "Order")),
                    esc(&doc.order_number)
                ));
                body.push_str(&format!(
                    "<span class=\"k\">{}</span><span class=\"v\">{}</span>",
                    esc(receipt_label(lang, "Date")),
                    esc(&display_date)
                ));
                if let Some(table) = doc
                    .table_number
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<span class=\"k\">{}</span><span class=\"v\">{}</span>",
                        esc(receipt_label(lang, "Table")),
                        esc(table)
                    ));
                }
                if let Some(customer) = doc
                    .customer_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<span class=\"k\">{}</span><span class=\"v\">{}</span>",
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
                    if !render_delivery_block {
                        body.push_str(&format!(
                            "<span class=\"k\">{}</span><span class=\"v\">{}</span>",
                            esc(receipt_label(lang, "Phone")),
                            esc(phone)
                        ));
                    }
                }
                body.push_str("</div>"); // close meta-grid

                // Delivery block (modern)
                if render_delivery_block {
                    body.push_str("<hr class=\"thin\">");
                    body.push_str(&format!(
                        "<div class=\"sec-head\">{}</div>",
                        esc(receipt_label(lang, "DELIVERY"))
                    ));
                    body.push_str("<div class=\"meta-grid\">");
                    for (key, val) in delivery_fields(doc, lang) {
                        body.push_str(&format!(
                            "<span class=\"k\">{}</span><span class=\"v\">{}</span>",
                            esc(key),
                            esc(val)
                        ));
                    }
                    body.push_str("</div>");
                }
                let order_notes = order_note_lines(doc);
                if !order_notes.is_empty() {
                    body.push_str("<hr class=\"thin\">");
                    for note in &order_notes {
                        body.push_str(&format!(
                            "<div class=\"item-mods\"><u>{}: {}</u></div>",
                            esc(receipt_label(lang, "Note")),
                            esc(note)
                        ));
                    }
                }

                // Items section
                body.push_str("<hr class=\"thin\">");
                body.push_str(&format!(
                    "<div class=\"sec-head\">{}</div>",
                    esc(receipt_label(lang, "Order"))
                ));
                if doc.items.is_empty() {
                    body.push_str(&format!(
                        "<div class=\"item\"><div class=\"item-mods\">{}</div></div>",
                        esc(receipt_label(lang, "No items"))
                    ));
                } else {
                    for item in &doc.items {
                        body.push_str("<div class=\"item\"><div class=\"item-row\">");
                        if let Some(cat_line) = category_line(lang, item) {
                            body.push_str(&format!(
                                "<span class=\"item-mods\"><strong>{}</strong></span>",
                                esc(&cat_line)
                            ));
                        }
                        body.push_str(&format!(
                            "<span class=\"item-name\">{}\u{00D7} {}</span>",
                            qty(item.quantity),
                            esc(&item.name)
                        ));
                        body.push_str(&format!(
                            "<span class=\"item-price\">{}</span>",
                            money_with_currency(item.total, cur)
                        ));
                        body.push_str("</div>");
                        append_customizations_html_v2(&mut body, item, lang);
                        if let Some(note) = item
                            .note
                            .as_deref()
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                        {
                            body.push_str(&format!(
                                "<div class=\"item-mods\"><u>{}: {}</u></div>",
                                esc(receipt_label(lang, "Note")),
                                esc(note)
                            ));
                        }
                        body.push_str("</div>");
                    }
                }

                // Totals
                body.push_str("<hr>");
                body.push_str("<table>");
                for total in &doc.totals {
                    let label = total_label_text(lang, total);
                    if total.emphasize {
                        body.push_str(&format!(
                            "<tr class=\"grand\"><td>{}</td><td class=\"r\">{}</td></tr>",
                            esc(&label),
                            money_with_currency(total.amount, cur)
                        ));
                    } else {
                        body.push_str(&format!(
                            "<tr><td class=\"dim\">{}</td><td class=\"r\">{}</td></tr>",
                            esc(&label),
                            money_with_currency(total.amount, cur)
                        ));
                    }
                }
                body.push_str("</table>");

                // Payments
                body.push_str("<hr class=\"thin\">");
                if let Some(method_label) = delivery_method_only_payment.as_deref() {
                    body.push_str(&format!(
                        "<div class=\"center\"><strong>{}</strong></div>",
                        esc(method_label)
                    ));
                } else {
                    body.push_str("<table>");
                    if doc.payments.is_empty() {
                        body.push_str(&format!(
                            "<tr><td class=\"dim\">{}</td><td></td></tr>",
                            esc(receipt_label(lang, "No payment recorded"))
                        ));
                    } else {
                        for payment in &doc.payments {
                            let label = receipt_label(lang, &payment.label);
                            // Use "change" class for Received/Change rows
                            let is_change = payment.label.eq_ignore_ascii_case("Change")
                                || payment.label == "\u{03A1}\u{03AD}\u{03C3}\u{03C4}\u{03B1}";
                            if payment_amount_unknown(payment) {
                                body.push_str(&format!(
                                    "<tr><td class=\"dim\">{}</td><td class=\"r\"></td></tr>",
                                    esc(label)
                                ));
                                continue;
                            }
                            if is_change {
                                body.push_str(&format!(
                                    "<tr class=\"change\"><td>{}</td><td class=\"r\">{}</td></tr>",
                                    esc(label),
                                    money_with_currency(payment.amount, cur)
                                ));
                            } else {
                                body.push_str(&format!(
                                    "<tr><td class=\"dim\">{}</td><td class=\"r\">{}</td></tr>",
                                    esc(label),
                                    money_with_currency(payment.amount, cur)
                                ));
                            }
                        }
                    }
                    if let Some(masked) = doc
                        .masked_card
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        body.push_str(&format!(
                            "<tr><td class=\"dim\">{}</td><td class=\"r\">{}</td></tr>",
                            esc(receipt_label(lang, "Card")),
                            esc(masked)
                        ));
                    }
                    body.push_str("</table>");
                }

                // Adjustments
                if !doc.adjustments.is_empty() {
                    body.push_str("<hr class=\"thin\">");
                    body.push_str("<table>");
                    for adj in &doc.adjustments {
                        let label = receipt_label(lang, &adj.label);
                        body.push_str(&format!(
                            "<tr><td class=\"dim\">{}</td><td class=\"r\">-{}</td></tr>",
                            esc(label),
                            money_with_currency(adj.amount, cur)
                        ));
                    }
                    body.push_str("</table>");
                }
            } else {
                // ── Classic layout ──
                body.push_str("<hr class=\"solid\">");
                body.push_str("<div class=\"meta-line\">");
                body.push_str(&format!(
                    "<b>{}:</b> #{}<br>",
                    esc(receipt_label(lang, "Order")),
                    esc(&doc.order_number)
                ));
                body.push_str(&format!(
                    "<b>{}:</b> {} &nbsp;&nbsp;&nbsp; <b>{}:</b> {}",
                    esc(receipt_label(lang, "Type")),
                    esc(&order_type_display),
                    esc(receipt_label(lang, "Date")),
                    esc(&display_date)
                ));
                if let Some(table) = doc
                    .table_number
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<br><b>{}:</b> {}",
                        esc(receipt_label(lang, "Table")),
                        esc(table)
                    ));
                }
                if let Some(customer) = doc
                    .customer_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<br><b>{}:</b> {}",
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
                    if !render_delivery_block {
                        body.push_str(&format!(
                            "<br><b>{}:</b> {}",
                            esc(receipt_label(lang, "Phone")),
                            esc(phone)
                        ));
                    }
                }
                body.push_str("</div>"); // close meta-line

                // Delivery block (classic)
                if render_delivery_block {
                    body.push_str(&format!(
                        "<div class=\"sec-head\">[ {} ]</div>",
                        esc(receipt_label(lang, "DELIVERY"))
                    ));
                    body.push_str("<div class=\"meta-line\">");
                    for (key, val) in delivery_fields(doc, lang) {
                        body.push_str(&format!("<b>{}:</b> {}<br>", esc(key), esc(val)));
                    }
                    body.push_str("</div>");
                }
                let order_notes = order_note_lines(doc);
                if !order_notes.is_empty() {
                    body.push_str("<div class=\"meta-line\">");
                    for note in &order_notes {
                        body.push_str(&format!(
                            "<u><b>{}:</b> {}</u><br>",
                            esc(receipt_label(lang, "Note")),
                            esc(note)
                        ));
                    }
                    body.push_str("</div>");
                }

                // Items section
                body.push_str(&format!(
                    "<div class=\"sec-head\">[ {} ]</div>",
                    esc(receipt_label(lang, "ITEMS"))
                ));
                if doc.items.is_empty() {
                    body.push_str(&format!(
                        "<div class=\"item\"><div class=\"item-mods\">{}</div></div>",
                        esc(receipt_label(lang, "No items"))
                    ));
                } else {
                    for item in &doc.items {
                        body.push_str("<div class=\"item\"><div class=\"item-row\">");
                        if let Some(cat_line) = category_line(lang, item) {
                            body.push_str(&format!(
                                "<span class=\"item-mods\"><strong>{}</strong></span>",
                                esc(&cat_line)
                            ));
                        }
                        body.push_str(&format!(
                            "<span class=\"item-name\">{}x {}</span>",
                            qty(item.quantity),
                            esc(&item.name)
                        ));
                        body.push_str(&format!(
                            "<span class=\"item-price\">{}</span>",
                            money(item.total)
                        ));
                        body.push_str("</div>");
                        append_customizations_html_v2(&mut body, item, lang);
                        if let Some(note) = item
                            .note
                            .as_deref()
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                        {
                            body.push_str(&format!(
                                "<div class=\"item-mods\"><u>{}: {}</u></div>",
                                esc(receipt_label(lang, "Note")),
                                esc(note)
                            ));
                        }
                        body.push_str("</div>");
                    }
                }

                // Totals
                body.push_str(&format!(
                    "<div class=\"sec-head\">[ {} ]</div>",
                    esc(receipt_label(lang, "TOTALS"))
                ));
                body.push_str("<table>");
                for total in &doc.totals {
                    let label = total_label_text(lang, total);
                    if total.emphasize {
                        body.push_str(&format!(
                            "<tr class=\"grand\"><td>{}</td><td class=\"r\">{}</td></tr>",
                            esc(&label),
                            money(total.amount)
                        ));
                    } else {
                        body.push_str(&format!(
                            "<tr><td class=\"dim\">{}</td><td class=\"r\">{}</td></tr>",
                            esc(&label),
                            money(total.amount)
                        ));
                    }
                }
                body.push_str("</table>");

                // Payments
                body.push_str(&format!(
                    "<div class=\"sec-head\">[ {} ]</div>",
                    esc(receipt_label(lang, "PAYMENT"))
                ));
                if let Some(method_label) = delivery_method_only_payment.as_deref() {
                    body.push_str(&format!(
                        "<div class=\"center\"><strong>{}</strong></div>",
                        esc(method_label)
                    ));
                } else {
                    body.push_str("<table>");
                    if doc.payments.is_empty() {
                        body.push_str(&format!(
                            "<tr><td class=\"dim\">{}</td><td></td></tr>",
                            esc(receipt_label(lang, "No payment recorded"))
                        ));
                    } else {
                        for payment in &doc.payments {
                            let label = receipt_label(lang, &payment.label);
                            let is_change = payment.label.eq_ignore_ascii_case("Change")
                                || payment.label == "\u{03A1}\u{03AD}\u{03C3}\u{03C4}\u{03B1}";
                            if is_change {
                                body.push_str(&format!(
                                    "<tr class=\"change\"><td>{}</td><td class=\"r\">{}</td></tr>",
                                    esc(label),
                                    money(payment.amount)
                                ));
                            } else {
                                body.push_str(&format!(
                                    "<tr><td class=\"dim\">{}</td><td class=\"r\">{}</td></tr>",
                                    esc(label),
                                    money(payment.amount)
                                ));
                            }
                        }
                    }
                    if let Some(masked) = doc
                        .masked_card
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        body.push_str(&format!(
                            "<tr><td class=\"dim\">{}</td><td class=\"r\">{}</td></tr>",
                            esc(receipt_label(lang, "Card")),
                            esc(masked)
                        ));
                    }
                    body.push_str("</table>");
                }

                // Adjustments
                if !doc.adjustments.is_empty() {
                    body.push_str(&format!(
                        "<div class=\"sec-head\">[ {} ]</div>",
                        esc(receipt_label(lang, "ADJUSTMENTS"))
                    ));
                    body.push_str("<table>");
                    for adj in &doc.adjustments {
                        let label = receipt_label(lang, &adj.label);
                        body.push_str(&format!(
                            "<tr><td class=\"dim\">{}</td><td class=\"r\">-{}</td></tr>",
                            esc(label),
                            money(adj.amount)
                        ));
                    }
                    body.push_str("</table>");
                }
            }

            // QR code (both templates)
            if cfg.show_qr_code {
                if let Some(qr) = cfg
                    .qr_data
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<div style=\"text-align:center;margin-top:8px;font-size:9px;color:#666\">QR: {}</div>",
                        esc(qr)
                    ));
                }
            }

            // Footer
            let footer = cfg.footer_text.as_deref().unwrap_or("Thank you");
            let translated_footer = receipt_label(lang, footer);
            body.push_str(&format!(
                "<div class=\"footer\">{}</div>",
                esc(translated_footer)
            ));

            html_shell("Order Receipt", &body, cfg)
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
            let order_notes = kitchen_order_note_lines(doc);
            if !order_notes.is_empty() {
                body.push_str("<div class=\"section\">");
                for note in &order_notes {
                    body.push_str(&format!(
                        "<div class=\"note\"><u>{}: {}</u></div>",
                        esc(receipt_label(lang, "Note")),
                        esc(note)
                    ));
                }
                body.push_str("</div>");
            }
            // Items section
            if is_modern {
                body.push_str(&format!(
                    "<div class=\"sec-head\">{}</div>",
                    esc(receipt_label(lang, "ITEMS"))
                ));
            } else {
                body.push_str(&format!(
                    "<div class=\"sec-head\">[ {} ]</div>",
                    esc(receipt_label(lang, "ITEMS"))
                ));
            }
            if doc.items.is_empty() {
                body.push_str(&format!(
                    "<div class=\"note\">{}</div>",
                    esc(receipt_label(lang, "No items"))
                ));
            } else {
                for item in &doc.items {
                    if let Some(cat_line) = category_line(lang, item) {
                        body.push_str(&format!(
                            "<div class=\"note\"><strong>{}</strong></div>",
                            esc(&cat_line)
                        ));
                    }
                    body.push_str(&format!(
                        "<div><strong>{}x {}</strong></div>",
                        qty(item.quantity),
                        esc(&item.name)
                    ));
                    append_customizations_html(&mut body, item, lang);
                    if let Some(note) = item
                        .note
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        body.push_str(&format!("<div class=\"note\"><u>{}</u></div>", esc(note)));
                    }
                }
            }
            body.push_str("</div>");
            html_shell(receipt_label(lang, "KITCHEN TICKET"), &body, cfg)
        }
        ReceiptDocument::DeliverySlip(doc) => {
            let lang = cfg.language.as_str();
            let cur = cfg.currency_symbol.as_str();
            let mut body = String::new();
            let banner = build_status_banner_html(doc);
            body.push_str(&banner);
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
            // Delivery/customer info block
            body.push_str("<div class=\"section\">");
            for (label, value) in delivery_slip_info_lines(doc, lang) {
                body.push_str(&format!(
                    "<div class=\"line\"><span>{}</span><span><b>{}</b></span></div>",
                    esc(&label),
                    esc(&value)
                ));
            }
            body.push_str("</div>");
            let order_notes = order_note_lines(doc);
            if !order_notes.is_empty() {
                body.push_str("<div class=\"section\">");
                for note in &order_notes {
                    body.push_str(&format!(
                        "<div class=\"note\"><u>{}: {}</u></div>",
                        esc(receipt_label(lang, "Note")),
                        esc(note)
                    ));
                }
                body.push_str("</div>");
            }
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
                    if let Some(cat_line) = category_line(lang, item) {
                        body.push_str(&format!(
                            "<div class=\"note\"><strong>{}</strong></div>",
                            esc(&cat_line)
                        ));
                    }
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
                        append_customizations_html(&mut body, item, lang);
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
                        body.push_str(&format!("<div class=\"note\"><u>{}</u></div>", esc(note)));
                    }
                }
            }
            body.push_str("</div>");
            // Totals section
            body.push_str("<div class=\"section\">");
            for line in &doc.totals {
                let label = total_label_text(lang, line);
                if line.emphasize {
                    body.push_str("<div style=\"border-top:3px double #111;border-bottom:3px double #111;padding:4px 0;margin-top:4px\">");
                    body.push_str(&format!(
                        "<div class=\"line\"><strong>{}</strong><strong>{}</strong></div>",
                        esc(&label),
                        money_with_currency(line.amount, cur)
                    ));
                    body.push_str("</div>");
                } else {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(&label),
                        money_with_currency(line.amount, cur)
                    ));
                }
            }
            body.push_str("</div>");
            body.push_str("<div class=\"section\">");
            if let Some(method_label) = method_only_payment_label(doc, lang) {
                body.push_str(&format!(
                    "<div class=\"center\"><strong>{}</strong></div>",
                    esc(&method_label)
                ));
            } else if doc.payments.is_empty() {
                body.push_str(&format!(
                    "<div class=\"line\"><span>{}</span><span></span></div>",
                    esc(receipt_label(lang, "No payment recorded"))
                ));
            } else {
                for payment in &doc.payments {
                    let label = receipt_label(lang, &payment.label);
                    if payment_amount_unknown(payment) {
                        body.push_str(&format!(
                            "<div class=\"center\"><strong>{}</strong></div>",
                            esc(label)
                        ));
                        continue;
                    }
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(label),
                        money_with_currency(payment.amount, cur)
                    ));
                }
                if let Some(masked) = doc
                    .masked_card
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(receipt_label(lang, "Card")),
                        esc(masked)
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
            html_shell(receipt_label(lang, "DELIVERY SLIP"), &body, cfg)
        }
        ReceiptDocument::ShiftCheckout(doc) => {
            let role_display = receipt_role_text(lang, &doc.role_type);
            let mut body = format!(
                "<div class=\"center\"><strong>{}</strong></div><div class=\"section\">\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>",
                esc(receipt_label(lang, "SHIFT CHECKOUT")),
                esc(receipt_label(lang, "Role")),
                esc(&role_display),
                esc(receipt_label(lang, "Staff")),
                esc(&doc.staff_name),
                esc(receipt_label(lang, "Check-in")),
                esc(&format_datetime_human(&doc.check_in)),
                esc(receipt_label(lang, "Check-out")),
                esc(&format_datetime_human(&doc.check_out)),
            );
            if !should_render_minimal_shift_checkout(doc) {
                if let Some(terminal_name) = non_empty_receipt_value(&doc.terminal_name) {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(receipt_label(lang, "Terminal")),
                        esc(terminal_name)
                    ));
                }
                if should_render_shift_checkout_driver_summary(doc) {
                    for row in driver_shift_checkout_summary_rows(doc) {
                        if row.emphasize {
                            body.push_str(&format!(
                                "<div class=\"line\"><strong>{}</strong><strong>{}</strong></div>",
                                esc(receipt_label(lang, row.label_key)),
                                money(row.amount),
                            ));
                        } else {
                            body.push_str(&format!(
                                "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                                esc(receipt_label(lang, row.label_key)),
                                money(row.amount),
                            ));
                        }
                    }

                    if !doc.driver_deliveries.is_empty() {
                        body.push_str(&format!(
                            "</div><div class=\"section\"><div class=\"center\"><strong>{}</strong></div>",
                            esc(receipt_label(lang, "DRIVER DELIVERIES"))
                        ));
                        for line in &doc.driver_deliveries {
                            let label = format!("#{} {}", line.order_number, line.payment_method);
                            body.push_str(&format!(
                                "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                                esc(&label),
                                money(line.total_amount),
                            ));
                        }
                    }
                } else if should_render_shift_checkout_cashier_summary(doc) {
                    let expected = doc
                        .expected_amount
                        .map(money)
                        .unwrap_or_else(|| "N/A".to_string());
                    let counted_cash = doc
                        .closing_amount
                        .map(money)
                        .unwrap_or_else(|| "N/A".to_string());
                    let variance = doc
                        .variance_amount
                        .map(money)
                        .unwrap_or_else(|| "N/A".to_string());

                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>-{}</span></div>",
                        esc(receipt_label(lang, "Orders")),
                        doc.orders_count,
                        esc(receipt_label(lang, "Sales")),
                        money(doc.sales_amount),
                        esc(receipt_label(lang, "Cash Sales")),
                        money(doc.cash_sales),
                        esc(receipt_label(lang, "Card Sales")),
                        money(doc.card_sales),
                        esc(receipt_label(lang, "Opening")),
                        money(doc.opening_amount),
                        esc(receipt_label(lang, "Refunds")),
                        money(doc.cash_refunds),
                    ));
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                        esc(receipt_label(lang, "Expenses")),
                        money(doc.total_expenses),
                    ));
                    if doc.cash_drops > 0.0 {
                        body.push_str(&format!(
                            "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                            esc(receipt_label(lang, "Cash Drops")),
                            money(doc.cash_drops),
                        ));
                    }
                    if doc.driver_cash_given > 0.0 {
                        body.push_str(&format!(
                            "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                            esc(receipt_label(lang, "Driver Given")),
                            money(doc.driver_cash_given),
                        ));
                    }
                    if doc.driver_cash_returned > 0.0 {
                        body.push_str(&format!(
                            "<div class=\"line\"><span>{}</span><span>+{}</span></div>",
                            esc(receipt_label(lang, "Driver Returned")),
                            money(doc.driver_cash_returned),
                        ));
                    }
                    if doc.transferred_staff_count > 0 {
                        body.push_str(&format!(
                            "<div class=\"line\"><span>{}</span><span>{}</span></div>\
                             <div class=\"line\"><span>{}</span><span>+{}</span></div>",
                            esc(receipt_label(lang, "Transferred Staff")),
                            doc.transferred_staff_count,
                            esc(receipt_label(lang, "Transferred Staff Returns")),
                            money(doc.transferred_staff_returns),
                        ));
                    }
                    if doc.staff_payouts_total > 0.0 {
                        body.push_str(&format!(
                            "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                            esc(receipt_label(lang, "Staff Payouts")),
                            money(doc.staff_payouts_total),
                        ));
                    }
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(receipt_label(lang, "Expected")),
                        expected,
                        esc(receipt_label(lang, "Counted Cash")),
                        counted_cash,
                        esc(receipt_label(lang, "Variance")),
                        variance,
                    ));
                    if let Some(expected_amount) = doc.expected_amount {
                        body.push_str(&format!(
                            "<div class=\"line\"><strong>{}</strong><strong>{}</strong></div>",
                            esc(receipt_label(lang, "Expected In Drawer")),
                            money(expected_amount),
                        ));
                    }
                    if !doc.staff_payout_lines.is_empty() {
                        body.push_str(&format!(
                            "</div><div class=\"section\"><div class=\"center\"><strong>{}</strong></div>",
                            esc(receipt_label(lang, "STAFF PAYOUTS"))
                        ));
                        for payout in &doc.staff_payout_lines {
                            let role_label = receipt_role_text(lang, &payout.role_type);
                            let label = format!("{} ({})", payout.staff_name, role_label);
                            body.push_str(&format!(
                                "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                                esc(&label),
                                money(payout.amount),
                            ));
                        }
                    }
                } else {
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

                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(receipt_label(lang, "Orders")),
                        doc.orders_count,
                        esc(receipt_label(lang, "Sales")),
                        money(doc.sales_amount),
                        esc(receipt_label(lang, "Expenses")),
                        money(doc.total_expenses),
                        esc(receipt_label(lang, "Refunds")),
                        money(doc.cash_refunds),
                        esc(receipt_label(lang, "Opening")),
                        money(doc.opening_amount),
                    ));
                    if doc.transferred_staff_count > 0 {
                        body.push_str(&format!(
                            "<div class=\"line\"><span>{}</span><span>{}</span></div>\
                             <div class=\"line\"><span>{}</span><span>+{}</span></div>",
                            esc(receipt_label(lang, "Transferred Staff")),
                            doc.transferred_staff_count,
                            esc(receipt_label(lang, "Transferred Staff Returns")),
                            money(doc.transferred_staff_returns),
                        ));
                    }
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>\
                         <div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(receipt_label(lang, "Expected")),
                        expected,
                        esc(receipt_label(lang, "Closing")),
                        closing,
                        esc(receipt_label(lang, "Variance")),
                        variance,
                    ));
                    if let Some(expected_amount) = doc.expected_amount {
                        body.push_str(&format!(
                            "<div class=\"line\"><strong>{}</strong><strong>{}</strong></div>",
                            esc(receipt_label(lang, "Expected In Drawer")),
                            money(expected_amount),
                        ));
                    }
                }
            }
            body.push_str("</div>");
            html_shell(receipt_label(lang, "SHIFT CHECKOUT"), &body, cfg)
        }
        ReceiptDocument::ZReport(doc) => {
            let shift_line = z_report_shift_line(doc, lang)
                .map(|(label, value)| {
                    format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(&label),
                        esc(&value)
                    )
                })
                .unwrap_or_default();
            let terminal_line = non_empty_receipt_value(&doc.terminal_name)
                .map(|terminal_name| {
                    format!(
                        "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                        esc(receipt_label(lang, "Terminal")),
                        esc(terminal_name)
                    )
                })
                .unwrap_or_default();
            let mut body = format!(
                "<div class=\"center\"><strong>{}</strong></div>\
                 <div class=\"section\">\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>\
                 {}{}\
                 </div>",
                esc(receipt_label(lang, "Z REPORT")),
                esc(receipt_label(lang, "Date")),
                esc(&doc.report_date),
                esc(receipt_label(lang, "Generated")),
                esc(&doc.generated_at),
                shift_line,
                terminal_line,
            );

            // Sales
            body.push_str(&format!(
                "<div class=\"section\"><div class=\"center\"><strong>{}</strong></div>\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>\
                 <div class=\"line\"><span>{}</span><span>-{}</span></div>\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>",
                esc(receipt_label(lang, "SALES")),
                esc(receipt_label(lang, "Orders")),
                doc.total_orders,
                esc(receipt_label(lang, "Gross")),
                money(doc.gross_sales),
                esc(receipt_label(lang, "Discounts")),
                money(doc.discounts_total),
                esc(receipt_label(lang, "Net")),
                money(doc.net_sales),
            ));
            if doc.tips_total > 0.0 {
                body.push_str(&format!(
                    "<div class=\"line\"><span>{}</span><span>{}</span></div>",
                    esc(receipt_label(lang, "Tips")),
                    money(doc.tips_total),
                ));
            }
            body.push_str("</div>");

            // Payments
            body.push_str(&format!(
                "<div class=\"section\"><div class=\"center\"><strong>{}</strong></div>\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>\
                 <div class=\"line\"><span>{}</span><span>{}</span></div>",
                esc(receipt_label(lang, "PAYMENTS")),
                esc(receipt_label(lang, "Cash")),
                money(doc.cash_sales),
                esc(receipt_label(lang, "Card")),
                money(doc.card_sales),
            ));
            if doc.refunds_total > 0.0 {
                body.push_str(&format!(
                    "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                    esc(receipt_label(lang, "Refunds")),
                    money(doc.refunds_total),
                ));
            }
            if doc.voids_total > 0.0 {
                body.push_str(&format!(
                    "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                    esc(receipt_label(lang, "Voids")),
                    money(doc.voids_total),
                ));
            }
            body.push_str("</div>");

            // Order breakdown
            let has_breakdown =
                doc.dine_in_orders > 0 || doc.takeaway_orders > 0 || doc.delivery_orders > 0;
            if has_breakdown {
                body.push_str(&format!(
                    "<div class=\"section\"><div class=\"center\"><strong>{}</strong></div>",
                    esc(receipt_label(lang, "ORDER BREAKDOWN"))
                ));
                if doc.dine_in_orders > 0 {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{} ({})</span><span>{}</span></div>",
                        esc(receipt_label(lang, "Dine-in")),
                        doc.dine_in_orders,
                        money(doc.dine_in_sales),
                    ));
                }
                if doc.takeaway_orders > 0 {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{} ({})</span><span>{}</span></div>",
                        esc(receipt_label(lang, "Takeaway")),
                        doc.takeaway_orders,
                        money(doc.takeaway_sales),
                    ));
                }
                if doc.delivery_orders > 0 {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{} ({})</span><span>{}</span></div>",
                        esc(receipt_label(lang, "Delivery")),
                        doc.delivery_orders,
                        money(doc.delivery_sales),
                    ));
                }
                body.push_str("</div>");
            }

            // Cash drawer
            let has_drawer =
                doc.opening_cash > 0.0 || doc.closing_cash > 0.0 || doc.expected_cash > 0.0;
            if has_drawer {
                body.push_str(&format!(
                    "<div class=\"section\"><div class=\"center\"><strong>{}</strong></div>\
                     <div class=\"line\"><span>{}</span><span>{}</span></div>\
                     <div class=\"line\"><span>{}</span><span>{}</span></div>",
                    esc(receipt_label(lang, "CASH DRAWER")),
                    esc(receipt_label(lang, "Opening")),
                    money(doc.opening_cash),
                    esc(receipt_label(lang, "Cash Sales")),
                    money(doc.cash_sales),
                ));
                if doc.expenses_total > 0.0 {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                        esc(receipt_label(lang, "Expenses")),
                        money(doc.expenses_total),
                    ));
                }
                if doc.cash_drops > 0.0 {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                        esc(receipt_label(lang, "Cash Drops")),
                        money(doc.cash_drops),
                    ));
                }
                if doc.driver_cash_given > 0.0 {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                        esc(receipt_label(lang, "Driver Given")),
                        money(doc.driver_cash_given),
                    ));
                }
                if doc.driver_cash_returned > 0.0 {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>+{}</span></div>",
                        esc(receipt_label(lang, "Driver Returned")),
                        money(doc.driver_cash_returned),
                    ));
                }
                if doc.staff_payments_total > 0.0 {
                    body.push_str(&format!(
                        "<div class=\"line\"><span>{}</span><span>-{}</span></div>",
                        esc(receipt_label(lang, "Staff Payouts*")),
                        money(doc.staff_payments_total),
                    ));
                }
                body.push_str(&format!(
                    "<hr/>\
                     <div class=\"line\"><span>{}</span><span>{}</span></div>\
                     <div class=\"line\"><span>{}</span><span>{}</span></div>\
                     <div class=\"line\"><strong>{}</strong><strong>{}</strong></div>",
                    esc(receipt_label(lang, "Expected")),
                    money(doc.expected_cash),
                    esc(receipt_label(lang, "Closing")),
                    money(doc.closing_cash),
                    esc(receipt_label(lang, "Variance")),
                    money(doc.cash_variance),
                ));
                if doc.staff_payments_total > 0.0 {
                    body.push_str(&format!(
                        "<div class=\"note\">* {}</div>",
                        esc(receipt_label(lang, "Informational only"))
                    ));
                }
                body.push_str("</div>");
            } else {
                body.push_str(&format!(
                    "<div class=\"section\">\
                     <div class=\"line\"><span>{}</span><span>-{}</span></div>\
                     <div class=\"line\"><span>{}</span><span>{}</span></div>\
                     </div>",
                    esc(receipt_label(lang, "Expenses")),
                    money(doc.expenses_total),
                    esc(receipt_label(lang, "Variance")),
                    money(doc.cash_variance),
                ));
            }

            html_shell(receipt_label(lang, "Z REPORT"), &body, cfg)
        }
    }
}

fn emit_rule(builder: &mut EscPosBuilder, width: usize, ch: char) {
    let line: String = std::iter::repeat(ch).take(width.max(8)).collect();
    builder.text(&line).lf();
}

fn emit_banner(builder: &mut EscPosBuilder, width: usize, ch: char, title: &str) {
    let width = width.max(8);
    let raw_title = title.trim();
    if raw_title.is_empty() {
        emit_rule(builder, width, ch);
        return;
    }

    let content = format!(" {raw_title} ");
    let content_len = content.chars().count();
    if content_len >= width {
        builder.text(raw_title).lf();
        return;
    }

    let fill_total = width - content_len;
    let left = fill_total / 2;
    let right = fill_total - left;
    let mut line = String::with_capacity(width);
    line.extend(std::iter::repeat(ch).take(left));
    line.push_str(&content);
    line.extend(std::iter::repeat(ch).take(right));
    builder.text(&line).lf();
}

fn emit_pair_internal(
    builder: &mut EscPosBuilder,
    label: &str,
    value: &str,
    width: usize,
    bold_value: bool,
) {
    let label = label.trim();
    let value = value.trim();
    if value.is_empty() {
        emit_wrapped(builder, label, width);
        return;
    }

    let value_len = value.chars().count();
    if value_len >= width.saturating_sub(2) {
        emit_wrapped(builder, label, width);
        if bold_value {
            builder
                .right()
                .bold(true)
                .text(value)
                .bold(false)
                .lf()
                .left();
        } else {
            builder.right().text(value).lf().left();
        }
        return;
    }

    let max_label_width = width.saturating_sub(value_len + 1).max(8);
    let lines = wrap(label, max_label_width);
    if lines.is_empty() {
        if bold_value {
            builder
                .right()
                .bold(true)
                .text(value)
                .bold(false)
                .lf()
                .left();
        } else {
            builder.right().text(value).lf().left();
        }
        return;
    }

    for line in &lines[..lines.len().saturating_sub(1)] {
        builder.text(line).lf();
    }

    let tail = lines.last().map(String::as_str).unwrap_or_default();
    let tail_len = tail.chars().count();
    if tail_len + value_len < width {
        if bold_value {
            builder.text(tail);
            let gap = width.saturating_sub(tail_len + value_len);
            for _ in 0..gap {
                builder.text(" ");
            }
            builder.bold(true).text(value).bold(false).lf();
        } else {
            // Use passed `width` for gap calculation instead of `line_pair()`
            // which uses `self.paper.chars()` (not scaled for 2×2 text).
            builder.text(tail);
            let gap = width.saturating_sub(tail_len + value_len);
            for _ in 0..gap {
                builder.text(" ");
            }
            builder.text(value).lf();
        }
    } else {
        builder.text(tail).lf();
        if bold_value {
            builder
                .right()
                .bold(true)
                .text(value)
                .bold(false)
                .lf()
                .left();
        } else {
            builder.right().text(value).lf().left();
        }
    }
}

fn emit_pair(builder: &mut EscPosBuilder, label: &str, value: &str, width: usize) {
    emit_pair_internal(builder, label, value, width, false);
}

/// Like `emit_pair` but prints the value in bold.
fn emit_pair_bold(builder: &mut EscPosBuilder, label: &str, value: &str, width: usize) {
    emit_pair_internal(builder, label, value, width, true);
}

fn emit_wrapped(builder: &mut EscPosBuilder, text: &str, width: usize) {
    for line in wrap(text, width) {
        builder.text(&line).lf();
    }
}

fn wrap_centered_header(text: &str, width: usize) -> Vec<String> {
    let value = text.trim();
    if value.is_empty() {
        return vec![];
    }

    let max_width = width.max(8);
    if value.contains(',') {
        let mut lines: Vec<String> = Vec::new();
        let mut current = String::new();
        for segment in value
            .split(',')
            .map(str::trim)
            .filter(|segment| !segment.is_empty())
        {
            let candidate = if current.is_empty() {
                segment.to_string()
            } else {
                format!("{current}, {segment}")
            };
            if candidate.chars().count() <= max_width {
                current = candidate;
                continue;
            }
            if !current.is_empty() {
                lines.push(current);
                current = segment.to_string();
            } else {
                lines.extend(wrap(segment, max_width));
            }
        }
        if !current.is_empty() {
            lines.push(current);
        }
        if !lines.is_empty() {
            return lines;
        }
    }

    wrap(value, max_width)
}

fn split_address_segments(value: &str) -> Vec<String> {
    value
        .split([',', '|', '\n', '\r'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn emit_centered_wrapped(builder: &mut EscPosBuilder, text: &str, width: usize) {
    for line in wrap_centered_header(text, width) {
        builder.center().text(&line).lf();
    }
}

#[derive(Debug, Clone, Copy)]
struct EscPosStyle {
    modern: bool,
    compact_width: bool,
    command_profile: CommandProfile,
    profile: EscPosVisualProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EscPosDocumentTarget {
    OrderReceipt,
    DeliverySlip,
    Other,
}

impl EscPosDocumentTarget {
    fn is_customer_receipt(self) -> bool {
        matches!(self, Self::OrderReceipt | Self::DeliverySlip)
    }
}

#[derive(Debug, Clone, Copy)]
struct EscPosVisualProfile {
    block_rule: char,
    section_rule: char,
    bracket_sections: bool,
    section_spacing_lines: usize,
    focus_spacing_lines: usize,
    framed_totals: bool,
    strong_headers: bool,
    currency_on_all: bool,
}

fn escpos_document_target(document: &ReceiptDocument) -> EscPosDocumentTarget {
    match document {
        ReceiptDocument::OrderReceipt(_) => EscPosDocumentTarget::OrderReceipt,
        ReceiptDocument::DeliverySlip(_) => EscPosDocumentTarget::DeliverySlip,
        _ => EscPosDocumentTarget::Other,
    }
}

fn escpos_style(cfg: &LayoutConfig, doc_target: EscPosDocumentTarget) -> EscPosStyle {
    let modern = cfg.template == ReceiptTemplate::Modern;
    let classic_customer_layout = !modern && doc_target.is_customer_receipt();
    let (section_spacing_lines, focus_spacing_lines) = match cfg.layout_density {
        LayoutDensity::Compact => (0, 0),
        LayoutDensity::Balanced => (1, 0),
        LayoutDensity::Spacious => (1, 1),
    };
    let strong_headers = cfg.header_emphasis == HeaderEmphasis::Strong;
    let profile = if modern {
        EscPosVisualProfile {
            block_rule: '-',
            section_rule: '-',
            bracket_sections: false,
            section_spacing_lines,
            focus_spacing_lines,
            framed_totals: false,

            strong_headers,
            currency_on_all: false,
        }
    } else {
        EscPosVisualProfile {
            block_rule: if classic_customer_layout { '-' } else { '─' },
            section_rule: if classic_customer_layout { '-' } else { '─' },
            bracket_sections: false,
            section_spacing_lines,
            focus_spacing_lines,
            framed_totals: false,

            strong_headers,
            currency_on_all: false,
        }
    };

    EscPosStyle {
        modern,
        compact_width: cfg.paper_width.chars() <= 32,
        command_profile: cfg.command_profile,
        profile,
    }
}

fn can_scale_text(style: EscPosStyle) -> bool {
    style.command_profile == CommandProfile::FullStyle
}

fn should_use_large_item_text(style: EscPosStyle, width: usize, label: &str) -> bool {
    if !style.modern || style.compact_width || !can_scale_text(style) {
        return false;
    }
    label.chars().count() <= width.saturating_sub(6).max(8)
}

fn emit_section_header(builder: &mut EscPosBuilder, title: &str, style: EscPosStyle, width: usize) {
    let title_upper = title.trim().to_ascii_uppercase();
    for _ in 0..style.profile.section_spacing_lines {
        builder.lf();
    }
    if style.modern {
        // Modern: thin dash rule above + centered bold title (matches HTML preview)
        let rule = "-".repeat(width.max(8));
        builder.text(&rule).lf();
        builder.center();
        builder.bold(true).text(&title_upper).lf().bold(false);
        builder.left();
        return;
    }
    if !style.profile.bracket_sections {
        // Classic: left-aligned bold title + rule below
        let rule: String = std::iter::repeat(style.profile.section_rule)
            .take(width.max(8))
            .collect();
        builder.left();
        if style.profile.strong_headers {
            builder.bold(true);
        }
        builder.text(&title_upper).lf();
        if style.profile.strong_headers {
            builder.bold(false);
        }
        builder.text(&rule).lf();
        return;
    }

    // Bracket mode: [ TITLE ] between rules
    let rule: String = std::iter::repeat(style.profile.section_rule)
        .take(width.max(8))
        .collect();
    let banner = format!("[ {} ]", title_upper);
    builder.center();
    builder.text(&rule).lf();
    builder.bold(true).text(&banner).lf().bold(false);
    builder.text(&rule).lf();
    builder.left();

    for _ in 0..style.profile.section_spacing_lines {
        builder.lf();
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

fn emit_item_customizations_escpos(
    builder: &mut EscPosBuilder,
    item: &ReceiptItem,
    width: usize,
    lang: &str,
) {
    let (with_items, without_items) = split_customizations(item);

    if !with_items.is_empty() {
        for customization in with_items {
            emit_wrapped(
                builder,
                &format!("  + {}", customization_display(lang, customization, true)),
                width,
            );
        }
    }

    if !without_items.is_empty() {
        emit_wrapped(
            builder,
            &format!("  - {}", receipt_label(lang, "Without")),
            width,
        );
        for customization in without_items {
            emit_wrapped(
                builder,
                &format!(
                    "    - {}",
                    customization_display(lang, customization, false)
                ),
                width,
            );
        }
    }
}

fn emit_header(
    builder: &mut EscPosBuilder,
    cfg: &LayoutConfig,
    style: EscPosStyle,
    doc_target: EscPosDocumentTarget,
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
    let header_width = if style.modern {
        cfg.paper_width.chars()
    } else {
        cfg.paper_width.chars() / 2
    };

    if style.modern {
        // ── Modern header ──────────────────────────────────────────────
        // Copy label
        if let Some(label) = cfg
            .copy_label
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            builder.center().bold(true).text(label).lf().bold(false);
        }
        // Address: bold centered, split on comma
        if let Some(address) = cfg
            .store_address
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            builder.center().bold(true);
            for part in address.split(',') {
                let part = part.trim();
                if !part.is_empty() {
                    builder.text(part).lf();
                }
            }
            builder.bold(false);
            emit_rule(builder, header_width, '-');
        }
        // Phone left-aligned, then AFM + ΔΟΥ
        let vat_val = cfg
            .vat_number
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty());
        let office_val = cfg
            .tax_office
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty());
        let vat_label = receipt_label(&cfg.language, "VAT");
        let office_label = receipt_label(&cfg.language, "TAX_OFFICE");
        let phone_val = cfg
            .store_phone
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty());
        builder.left();
        if let Some(phone) = phone_val {
            let phone_label = receipt_label(&cfg.language, "Phone");
            builder.text(&format!("{phone_label}: {phone}")).lf();
        }
        match (vat_val, office_val) {
            (Some(vat), Some(office)) => {
                builder
                    .text(&format!("{vat_label}: {vat}   {office_label}: {office}"))
                    .lf();
            }
            (Some(vat), None) => {
                builder.text(&format!("{vat_label}: {vat}")).lf();
            }
            (None, Some(office)) => {
                builder.text(&format!("{office_label}: {office}")).lf();
            }
            (None, None) => {}
        }
    } else {
        // ── Classic header ─────────────────────────────────────────────
        // Logo is injected by print.rs before the receipt body.
        if doc_target.is_customer_receipt() {
            emit_rule(builder, header_width, style.profile.block_rule);
            if let Some(label) = cfg
                .copy_label
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                builder.center().bold(true).text(label).lf().bold(false);
            }
            let primary_line = header_primary_line(cfg);
            if !primary_line.is_empty() {
                builder.center().bold(true);
                emit_centered_wrapped(builder, primary_line, header_width);
                builder.bold(false);
            }
            emit_rule(builder, header_width, style.profile.block_rule);
            // Phone + VAT/DOY are left aligned in classic receipt v2.
            if let Some(address) = cfg
                .store_address
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                for segment in split_address_segments(address) {
                    emit_wrapped(builder, &segment, header_width);
                }
            }
            let phone_val = cfg
                .store_phone
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());
            let vat_val = cfg
                .vat_number
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());
            let office_val = cfg
                .tax_office
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());
            let vat_label = receipt_label(&cfg.language, "VAT");
            let office_label = receipt_label(&cfg.language, "TAX_OFFICE");
            builder.left();
            if let Some(phone) = phone_val {
                let phone_label = receipt_label(&cfg.language, "Phone");
                builder.text(&format!("{phone_label}: {phone}")).lf();
            }
            match (vat_val, office_val) {
                (Some(vat), Some(office)) => {
                    builder
                        .text(&format!("{vat_label}: {vat}   {office_label}: {office}"))
                        .lf();
                }
                (Some(vat), None) => {
                    builder.text(&format!("{vat_label}: {vat}")).lf();
                }
                (None, Some(office)) => {
                    builder.text(&format!("{office_label}: {office}")).lf();
                }
                (None, None) => {}
            }
            emit_rule(builder, header_width, style.profile.block_rule);
        } else {
            // Top separator rule (legacy classic)
            emit_rule(builder, header_width, style.profile.block_rule);
            // Only show org name as fallback when no logo is configured.
            if !cfg.show_logo {
                let org = cfg.organization_name.trim();
                if !org.is_empty() {
                    builder.center().bold(true);
                    emit_centered_wrapped(builder, org, header_width);
                    builder.bold(false);
                }
                // Show subtitle (branch name) if different from org
                if let Some(subtitle) = cfg.store_subtitle.as_deref().map(str::trim).filter(|v| {
                    let org = cfg.organization_name.trim();
                    !v.is_empty() && *v != org && !v.eq_ignore_ascii_case(org)
                }) {
                    builder.center();
                    emit_centered_wrapped(builder, subtitle, header_width);
                }
            }
            // Copy label
            if let Some(label) = cfg
                .copy_label
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                builder.center().bold(true).text(label).lf().bold(false);
            }
            // Address: split on comma, each part bold centered
            if let Some(address) = cfg
                .store_address
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                builder.center().bold(true);
                for part in address.split(',') {
                    let part = part.trim();
                    if !part.is_empty() {
                        emit_centered_wrapped(builder, part, header_width);
                    }
                }
                builder.bold(false);
            }
            // Blank line after address
            builder.lf();
            // Phone centered
            let phone_val = cfg
                .store_phone
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());
            if let Some(phone) = phone_val {
                let phone_label = receipt_label(&cfg.language, "Phone");
                emit_centered_wrapped(builder, &format!("{phone_label}: {phone}"), header_width);
            }
            // AFM + ΔΟΥ centered (double-space separator, no pipe)
            let vat_val = cfg
                .vat_number
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());
            let office_val = cfg
                .tax_office
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());
            let vat_label = receipt_label(&cfg.language, "VAT");
            let office_label = receipt_label(&cfg.language, "TAX_OFFICE");
            match (vat_val, office_val) {
                (Some(vat), Some(office)) => {
                    let combined = format!("{vat_label}: {vat}   {office_label}: {office}");
                    emit_centered_wrapped(builder, &combined, header_width);
                }
                (Some(vat), None) => {
                    emit_centered_wrapped(builder, &format!("{vat_label}: {vat}"), header_width);
                }
                (None, Some(office)) => {
                    emit_centered_wrapped(
                        builder,
                        &format!("{office_label}: {office}"),
                        header_width,
                    );
                }
                (None, None) => {}
            }
        }
    }
    builder.left();
    // Classic customer receipts keep a compact handoff into the order banner.
    if !doc_target.is_customer_receipt() || style.modern {
        builder.lf();
    }
}

fn default_printable_width_dots_for_paper(paper: PaperWidth) -> u16 {
    match paper {
        PaperWidth::Mm58 => 384,
        PaperWidth::Mm80 => 576,
        PaperWidth::Mm112 => 832,
    }
}

pub fn uses_star_commands(
    brand: crate::printers::PrinterBrand,
    emulation_mode: ReceiptEmulationMode,
) -> bool {
    match emulation_mode {
        ReceiptEmulationMode::StarLine => true,
        ReceiptEmulationMode::Escpos => false,
        ReceiptEmulationMode::Auto => brand == crate::printers::PrinterBrand::Star,
    }
}

pub fn effective_code_page_brand(
    brand: crate::printers::PrinterBrand,
    emulation_mode: ReceiptEmulationMode,
) -> crate::printers::PrinterBrand {
    if uses_star_commands(brand, emulation_mode) {
        crate::printers::PrinterBrand::Star
    } else if brand == crate::printers::PrinterBrand::Star {
        crate::printers::PrinterBrand::Unknown
    } else {
        brand
    }
}

fn is_star_line_mode(cfg: &LayoutConfig) -> bool {
    uses_star_commands(cfg.detected_brand, cfg.emulation_mode)
}

#[derive(Debug, Clone, Copy)]
enum RasterTextWeight {
    Regular,
    Bold,
}

#[derive(Debug, Clone, Copy)]
struct RasterTextStyle {
    size_px: f32,
    line_height: i32,
    tracking_px: f32,
    weight: RasterTextWeight,
    ink: u8,
    apply_body_boldness: bool,
}

impl RasterTextStyle {
    fn with_ink(self, ink: u8) -> Self {
        Self { ink, ..self }
    }
}

#[derive(Debug, Clone, Copy)]
struct RasterExactPreset {
    top_inset: i32,
    bottom_padding: i32,
    small_gap: i32,
    medium_gap: i32,
    large_gap: i32,
    rule_dash_dots: i32,
    rule_gap_dots: i32,
    rule_thickness: i32,
    banner_padding_y: i32,
    short_star_count: usize,
    address_style: RasterTextStyle,
    contact_style: RasterTextStyle,
    banner_style: RasterTextStyle,
    meta_style: RasterTextStyle,
    section_style: RasterTextStyle,
    item_style: RasterTextStyle,
    customization_style: RasterTextStyle,
    subtotal_style: RasterTextStyle,
    total_style: RasterTextStyle,
    payment_style: RasterTextStyle,
    footer_star_style: RasterTextStyle,
    footer_text_style: RasterTextStyle,
}

fn raster_exact_preset_for_paper(paper: PaperWidth) -> RasterExactPreset {
    let scale = match paper {
        PaperWidth::Mm58 => 0.82_f32,
        PaperWidth::Mm80 => 1.0_f32,
        PaperWidth::Mm112 => 1.22_f32,
    };
    let scaled_i = |value: i32| ((value as f32) * scale).round() as i32;
    let style = |size_px: f32,
                 line_height: i32,
                 tracking_px: f32,
                 weight: RasterTextWeight,
                 apply_body_boldness: bool| {
        RasterTextStyle {
            size_px: size_px * scale,
            line_height: scaled_i(line_height).max(12),
            tracking_px: tracking_px * scale,
            weight,
            ink: 0,
            apply_body_boldness,
        }
    };

    RasterExactPreset {
        top_inset: scaled_i(20),
        bottom_padding: scaled_i(28),
        small_gap: scaled_i(3),
        medium_gap: scaled_i(7),
        large_gap: scaled_i(9),
        rule_dash_dots: scaled_i(8).max(3),
        rule_gap_dots: scaled_i(4).max(2),
        rule_thickness: scaled_i(2).max(1),
        banner_padding_y: scaled_i(4).max(2),
        short_star_count: 12,
        address_style: style(34.0, 42, 0.1, RasterTextWeight::Bold, false),
        contact_style: style(29.0, 36, 0.05, RasterTextWeight::Regular, true),
        banner_style: style(36.0, 44, 0.15, RasterTextWeight::Bold, false),
        meta_style: style(29.0, 36, 0.05, RasterTextWeight::Regular, true),
        section_style: style(33.0, 41, 0.1, RasterTextWeight::Bold, false),
        item_style: style(30.0, 38, 0.05, RasterTextWeight::Regular, true),
        customization_style: style(27.0, 34, 0.05, RasterTextWeight::Regular, true),
        subtotal_style: style(31.0, 39, 0.05, RasterTextWeight::Regular, true),
        total_style: style(44.0, 54, 0.15, RasterTextWeight::Bold, false),
        payment_style: style(31.0, 39, 0.05, RasterTextWeight::Regular, true),
        footer_star_style: style(22.0, 28, 0.1, RasterTextWeight::Regular, false),
        footer_text_style: style(30.0, 37, 0.05, RasterTextWeight::Regular, true),
    }
}

fn classic_raster_spacing_scale(cfg: &LayoutConfig) -> f32 {
    if cfg.template != ReceiptTemplate::Classic {
        return 1.0;
    }

    let base = match cfg.layout_density {
        LayoutDensity::Compact => 0.9_f32,
        LayoutDensity::Balanced => 1.0_f32,
        LayoutDensity::Spacious => 1.18_f32,
    };

    base * cfg.layout_density_scale.clamp(0.7, 1.35)
}

fn raster_readability_scale(cfg: &LayoutConfig) -> f32 {
    if cfg.font_type == FontType::B
        && cfg.layout_density == LayoutDensity::Compact
        && cfg.header_emphasis == HeaderEmphasis::Normal
    {
        0.92
    } else if cfg.font_type == FontType::A
        && matches!(
            cfg.layout_density,
            LayoutDensity::Balanced | LayoutDensity::Spacious
        )
        && cfg.header_emphasis == HeaderEmphasis::Strong
    {
        1.28
    } else {
        1.00
    }
}

fn scale_raster_text_style(style: RasterTextStyle, scale: f32) -> RasterTextStyle {
    RasterTextStyle {
        size_px: (style.size_px * scale).max(8.0),
        line_height: ((style.line_height as f32) * scale).round().max(10.0) as i32,
        tracking_px: style.tracking_px * scale,
        ..style
    }
}

fn scale_raster_text_spacing(style: RasterTextStyle, scale: f32) -> RasterTextStyle {
    RasterTextStyle {
        line_height: ((style.line_height as f32) * scale).round().max(10.0) as i32,
        ..style
    }
}

fn scale_raster_exact_preset(mut preset: RasterExactPreset, scale: f32) -> RasterExactPreset {
    let scaled_i = |value: i32| ((value as f32) * scale).round().max(1.0) as i32;
    preset.top_inset = scaled_i(preset.top_inset);
    preset.bottom_padding = scaled_i(preset.bottom_padding);
    preset.small_gap = scaled_i(preset.small_gap);
    preset.medium_gap = scaled_i(preset.medium_gap);
    preset.large_gap = scaled_i(preset.large_gap);
    preset.rule_dash_dots = scaled_i(preset.rule_dash_dots).max(2);
    preset.rule_gap_dots = scaled_i(preset.rule_gap_dots).max(1);
    preset.rule_thickness = scaled_i(preset.rule_thickness).max(1);
    preset.banner_padding_y = scaled_i(preset.banner_padding_y).max(1);
    preset.address_style = scale_raster_text_style(preset.address_style, scale);
    preset.contact_style = scale_raster_text_style(preset.contact_style, scale);
    preset.banner_style = scale_raster_text_style(preset.banner_style, scale);
    preset.meta_style = scale_raster_text_style(preset.meta_style, scale);
    preset.section_style = scale_raster_text_style(preset.section_style, scale);
    preset.item_style = scale_raster_text_style(preset.item_style, scale);
    preset.customization_style = scale_raster_text_style(preset.customization_style, scale);
    preset.subtotal_style = scale_raster_text_style(preset.subtotal_style, scale);
    preset.total_style = scale_raster_text_style(preset.total_style, scale);
    preset.payment_style = scale_raster_text_style(preset.payment_style, scale);
    preset.footer_star_style = scale_raster_text_style(preset.footer_star_style, scale);
    preset.footer_text_style = scale_raster_text_style(preset.footer_text_style, scale);
    preset
}

fn scale_raster_exact_spacing(mut preset: RasterExactPreset, scale: f32) -> RasterExactPreset {
    let scaled_i = |value: i32| ((value as f32) * scale).round().max(1.0) as i32;
    preset.top_inset = scaled_i(preset.top_inset);
    preset.bottom_padding = scaled_i(preset.bottom_padding);
    preset.small_gap = scaled_i(preset.small_gap);
    preset.medium_gap = scaled_i(preset.medium_gap);
    preset.large_gap = scaled_i(preset.large_gap);
    preset.rule_dash_dots = scaled_i(preset.rule_dash_dots).max(2);
    preset.rule_gap_dots = scaled_i(preset.rule_gap_dots).max(1);
    preset.banner_padding_y = scaled_i(preset.banner_padding_y).max(1);
    preset.address_style = scale_raster_text_spacing(preset.address_style, scale);
    preset.contact_style = scale_raster_text_spacing(preset.contact_style, scale);
    preset.banner_style = scale_raster_text_spacing(preset.banner_style, scale);
    preset.meta_style = scale_raster_text_spacing(preset.meta_style, scale);
    preset.section_style = scale_raster_text_spacing(preset.section_style, scale);
    preset.item_style = scale_raster_text_spacing(preset.item_style, scale);
    preset.customization_style = scale_raster_text_spacing(preset.customization_style, scale);
    preset.subtotal_style = scale_raster_text_spacing(preset.subtotal_style, scale);
    preset.total_style = scale_raster_text_spacing(preset.total_style, scale);
    preset.payment_style = scale_raster_text_spacing(preset.payment_style, scale);
    preset.footer_star_style = scale_raster_text_spacing(preset.footer_star_style, scale);
    preset.footer_text_style = scale_raster_text_spacing(preset.footer_text_style, scale);
    preset
}

fn apply_raster_header_emphasis(
    mut preset: RasterExactPreset,
    cfg: &LayoutConfig,
) -> RasterExactPreset {
    if cfg.template != ReceiptTemplate::Classic {
        return preset;
    }

    let strong_headers = cfg.header_emphasis == HeaderEmphasis::Strong;
    let tracking_scale = if strong_headers { 1.0_f32 } else { 0.5_f32 };
    let header_weight = if strong_headers {
        RasterTextWeight::Bold
    } else {
        RasterTextWeight::Regular
    };
    let header_padding_scale = if strong_headers {
        1.0_f32
    } else {
        2.0_f32 / 3.0_f32
    };

    preset.banner_padding_y = ((preset.banner_padding_y as f32) * header_padding_scale)
        .round()
        .max(1.0) as i32;
    preset.address_style.weight = header_weight;
    preset.address_style.tracking_px *= tracking_scale;
    preset.banner_style.weight = header_weight;
    preset.banner_style.tracking_px *= tracking_scale;
    preset.section_style.weight = header_weight;
    preset.section_style.tracking_px *= tracking_scale;
    preset
}

fn raster_exact_preset_for_layout(cfg: &LayoutConfig) -> RasterExactPreset {
    let base = raster_exact_preset_for_paper(cfg.paper_width);
    // Apply user-configurable text_scale for classic layout so raster-exact
    // text is larger on thermal paper, then layer on the readability adjustment.
    let classic_scale = if cfg.template != ReceiptTemplate::Modern {
        cfg.text_scale
    } else {
        1.0
    };
    let preset = scale_raster_exact_preset(base, classic_scale * raster_readability_scale(cfg));
    let preset = scale_raster_exact_spacing(preset, classic_raster_spacing_scale(cfg));
    apply_raster_header_emphasis(preset, cfg)
}

fn body_boldness_offsets(weight: u32) -> &'static [(i32, i32)] {
    const NONE: &[(i32, i32)] = &[];
    const LEVEL_3: &[(i32, i32)] = &[(1, 0)];
    const LEVEL_4: &[(i32, i32)] = &[(1, 0), (0, 1)];
    const LEVEL_5: &[(i32, i32)] = &[(1, 0), (0, 1), (1, 1)];

    match weight {
        600 => LEVEL_3,
        700 => LEVEL_4,
        800.. => LEVEL_5,
        _ => NONE,
    }
}

struct RasterFonts {
    regular: RustFont<'static>,
    bold: RustFont<'static>,
}

/// Cached parsed TTF fonts — parsing embedded TTF bytes is expensive (~100-500ms
/// per font).  Since the fonts are static, we parse once and reuse forever.
fn cached_raster_fonts() -> &'static RasterFonts {
    use std::sync::OnceLock;
    static FONTS: OnceLock<RasterFonts> = OnceLock::new();
    FONTS.get_or_init(|| {
        let regular = RustFont::try_from_bytes(NOTO_SERIF_REGULAR_TTF)
            .expect("embedded Noto Serif Regular must parse");
        let bold = RustFont::try_from_bytes(NOTO_SERIF_BOLD_TTF)
            .expect("embedded Noto Serif Bold must parse");
        RasterFonts { regular, bold }
    })
}

impl RasterFonts {
    fn load() -> Result<&'static Self, String> {
        Ok(cached_raster_fonts())
    }

    fn font(&self, weight: RasterTextWeight) -> &RustFont<'static> {
        match weight {
            RasterTextWeight::Regular => &self.regular,
            RasterTextWeight::Bold => &self.bold,
        }
    }

    fn supports_char(&self, ch: char) -> bool {
        if ch.is_whitespace() {
            return true;
        }
        self.regular.glyph(ch).id().0 != 0 && self.bold.glyph(ch).id().0 != 0
    }

    fn missing_glyphs(&self, text: &str, weight: RasterTextWeight) -> usize {
        let font = self.font(weight);
        text.chars()
            .filter(|ch| !ch.is_whitespace() && font.glyph(*ch).id().0 == 0)
            .count()
    }
}

fn wrap_pixels<F>(text: &str, max_width: i32, measure: F) -> Vec<String>
where
    F: Fn(&str) -> i32,
{
    let mut out = Vec::new();
    let width = max_width.max(8);

    for raw_line in text.replace('\t', " ").lines() {
        let line = raw_line.trim_end();
        if line.is_empty() {
            out.push(String::new());
            continue;
        }

        let indent_len = line.chars().take_while(|ch| *ch == ' ').count();
        let indent = " ".repeat(indent_len);
        let content = line.trim_start();
        let mut current = String::new();

        for token in content.split_whitespace() {
            let candidate = if current.is_empty() {
                format!("{indent}{token}")
            } else {
                format!("{current} {token}")
            };
            if measure(&candidate) <= width {
                current = candidate;
            } else if current.is_empty() {
                out.push(candidate);
            } else {
                out.push(current);
                current = format!("{indent}{token}");
            }
        }

        if !current.is_empty() {
            out.push(current);
        }
    }

    if out.is_empty() {
        out.push(String::new());
    }
    out
}

struct TtfReceiptComposer {
    image: GrayImage,
    physical_width: i32,
    left_margin: i32,
    content_width: i32,
    y: i32,
    preset: RasterExactPreset,
    fonts: &'static RasterFonts,
    missing_glyph_count: usize,
    body_font_weight: u32,
}

impl TtfReceiptComposer {
    fn try_new(cfg: &LayoutConfig) -> Result<Self, String> {
        let fonts = RasterFonts::load()?;
        let preset = raster_exact_preset_for_layout(cfg);

        let physical_width = default_printable_width_dots_for_paper(cfg.paper_width) as i32;
        let mut left_margin = cfg.left_margin_dots as i32;
        if left_margin < 0 {
            left_margin = 0;
        }
        let mut content_width = cfg.printable_width_dots as i32;
        content_width = content_width.clamp(64, physical_width.max(64));
        if left_margin >= physical_width {
            left_margin = 0;
        }
        if left_margin + content_width > physical_width {
            content_width = (physical_width - left_margin).max(64);
        }

        Ok(Self {
            image: GrayImage::from_pixel(physical_width as u32, 9000, Luma([255])),
            physical_width,
            left_margin,
            content_width,
            y: preset.top_inset,
            preset,
            fonts,
            missing_glyph_count: 0,
            body_font_weight: cfg.body_font_weight,
        })
    }

    fn has_missing_glyphs(&self) -> bool {
        self.missing_glyph_count > 0
    }

    fn text_width(&self, text: &str, style: RasterTextStyle) -> i32 {
        let font = self.fonts.font(style.weight);
        let scale = Scale::uniform(style.size_px.max(1.0));
        let mut width = 0.0_f32;
        let mut prev = None;
        for ch in text.chars() {
            if let Some(prev_ch) = prev {
                width += font.pair_kerning(scale, prev_ch, ch);
            }
            width += font.glyph(ch).scaled(scale).h_metrics().advance_width + style.tracking_px;
            prev = Some(ch);
        }
        if !text.is_empty() {
            width -= style.tracking_px.max(0.0);
        }
        width.max(0.0).ceil() as i32
    }

    fn blend_pixel(&mut self, x: i32, y: i32, ink: u8, alpha: f32) {
        if x < 0 || y < 0 || (x as u32) >= self.image.width() || (y as u32) >= self.image.height() {
            return;
        }
        let src = self.image.get_pixel(x as u32, y as u32).0[0] as f32;
        let dst = src + (ink as f32 - src) * alpha.clamp(0.0, 1.0);
        self.image.put_pixel(
            x as u32,
            y as u32,
            Luma([dst.round().clamp(0.0, 255.0) as u8]),
        );
    }

    fn draw_text_at_y(&mut self, text: &str, align: BitmapAlign, style: RasterTextStyle, y: i32) {
        let text = text.trim_end();
        let text_w = self.text_width(text, style);
        let start_x = match align {
            BitmapAlign::Left => self.left_margin,
            BitmapAlign::Center => self.left_margin + (self.content_width - text_w).max(0) / 2,
            BitmapAlign::Right => self.left_margin + (self.content_width - text_w).max(0),
        };

        let font = self.fonts.font(style.weight).clone();
        self.missing_glyph_count += self.fonts.missing_glyphs(text, style.weight);
        let scale = Scale::uniform(style.size_px.max(1.0));
        let v_metrics = font.v_metrics(scale);
        let baseline = y as f32 + v_metrics.ascent;
        let overdraw_offsets = if style.apply_body_boldness {
            body_boldness_offsets(self.body_font_weight)
        } else {
            &[]
        };

        let mut caret = start_x as f32;
        let mut prev = None;
        for ch in text.chars() {
            if let Some(prev_ch) = prev {
                caret += font.pair_kerning(scale, prev_ch, ch);
            }
            let glyph = font
                .glyph(ch)
                .scaled(scale)
                .positioned(point(caret, baseline));
            let advance = glyph.unpositioned().h_metrics().advance_width;
            if let Some(bounds) = glyph.pixel_bounding_box() {
                glyph.draw(|gx, gy, value| {
                    let px = bounds.min.x + gx as i32;
                    let py = bounds.min.y + gy as i32;
                    self.blend_pixel(px, py, style.ink, value);
                    for (dx, dy) in overdraw_offsets {
                        self.blend_pixel(px + dx, py + dy, style.ink, value);
                    }
                });
            }
            caret += advance + style.tracking_px;
            prev = Some(ch);
        }
    }

    fn draw_text_line(&mut self, text: &str, align: BitmapAlign, style: RasterTextStyle) {
        self.draw_text_at_y(text, align, style, self.y);
        self.y += style.line_height;
    }

    fn draw_wrapped(&mut self, text: &str, align: BitmapAlign, style: RasterTextStyle) {
        let lines = wrap_pixels(text, self.content_width, |line| {
            self.text_width(line, style)
        });
        for line in lines {
            self.draw_text_line(&line, align, style);
        }
    }

    fn draw_pair(&mut self, label: &str, value: &str, style: RasterTextStyle) {
        let label = label.trim_end();
        let value = value.trim();
        if value.is_empty() {
            self.draw_wrapped(label, BitmapAlign::Left, style);
            return;
        }

        let value_w = self.text_width(value, style);
        let pair_gap = (self.preset.medium_gap * 2).max(6);
        let max_label_width = self.content_width - value_w - pair_gap;
        if max_label_width <= 24 {
            self.draw_wrapped(label, BitmapAlign::Left, style);
            self.draw_text_line(value, BitmapAlign::Right, style);
            return;
        }

        let lines = wrap_pixels(label, max_label_width, |line| self.text_width(line, style));
        if lines.is_empty() {
            self.draw_text_line(value, BitmapAlign::Right, style);
            return;
        }

        for line in &lines[..lines.len().saturating_sub(1)] {
            self.draw_text_line(line, BitmapAlign::Left, style);
        }

        let tail = lines.last().map(String::as_str).unwrap_or_default();
        let y = self.y;
        self.draw_text_at_y(tail, BitmapAlign::Left, style, y);
        self.draw_text_at_y(value, BitmapAlign::Right, style, y);
        self.y += style.line_height;
    }

    fn draw_rule(&mut self) {
        let y = self.y + self.preset.contact_style.line_height / 2;
        let start = self.left_margin;
        let end = self.left_margin + self.content_width;
        let mut x = start;
        while x < end {
            let dash_end = (x + self.preset.rule_dash_dots).min(end);
            for px in x..dash_end {
                for dy in 0..self.preset.rule_thickness {
                    self.blend_pixel(px, y + dy, 0, 1.0);
                }
            }
            x += self.preset.rule_dash_dots + self.preset.rule_gap_dots;
        }
        self.y += self.preset.contact_style.line_height;
    }

    fn draw_reverse_banner(&mut self, text: &str) {
        let style = self.preset.banner_style;
        let banner_h = style.line_height + self.preset.banner_padding_y * 2;
        let top = self.y;
        for py in top..(top + banner_h) {
            for px in self.left_margin..(self.left_margin + self.content_width) {
                self.blend_pixel(px, py, 0, 1.0);
            }
        }
        self.draw_text_at_y(
            text,
            BitmapAlign::Center,
            style.with_ink(255),
            top + self.preset.banner_padding_y,
        );
        self.y += banner_h + self.preset.small_gap;
    }

    fn add_gap(&mut self, dots: i32) {
        self.y += dots.max(0);
    }

    fn stars_for_width(&self, style: RasterTextStyle) -> usize {
        let star_w = self.text_width("*", style).max(1);
        (self.content_width / star_w).max(24) as usize
    }

    fn into_cropped(self) -> GrayImage {
        let final_height =
            (self.y + self.preset.bottom_padding).clamp(1, self.image.height() as i32) as u32;
        image::imageops::crop_imm(
            &self.image,
            0,
            0,
            self.physical_width.max(1) as u32,
            final_height,
        )
        .to_image()
    }
}

fn resolve_raster_currency_symbol(cfg: &LayoutConfig, fonts: &RasterFonts) -> String {
    let mut symbol = if cfg.currency_symbol.trim().is_empty() {
        " \u{20AC}".to_string()
    } else {
        cfg.currency_symbol.clone()
    };
    if symbol.contains('\u{20AC}') && !fonts.supports_char('\u{20AC}') {
        symbol = symbol.replace('\u{20AC}', "EUR");
        if !symbol.contains(" EUR") {
            symbol = symbol.trim().replace("EUR", " EUR");
        }
    }
    symbol
}

fn glyph_for_char(ch: char) -> [u8; 8] {
    font8x8::BASIC_FONTS
        .get(ch)
        .or_else(|| font8x8::LATIN_FONTS.get(ch))
        .or_else(|| font8x8::GREEK_FONTS.get(ch))
        .or_else(|| font8x8::BOX_FONTS.get(ch))
        .or_else(|| font8x8::MISC_FONTS.get(ch))
        .unwrap_or_else(|| font8x8::BASIC_FONTS.get('?').unwrap_or([0; 8]))
}

#[allow(clippy::too_many_arguments)]
fn draw_bitmap_text(
    image: &mut GrayImage,
    text: &str,
    x: i32,
    y: i32,
    scale: u32,
    letter_spacing: i32,
    color: u8,
    bold: bool,
    extra_offsets: &[(i32, i32)],
) {
    let mut cursor_x = x;
    let scale_i32 = scale as i32;
    for ch in text.chars() {
        let glyph = glyph_for_char(ch);
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..8u8 {
                if bits & (1u8 << col) == 0 {
                    continue;
                }
                let px = cursor_x + col as i32 * scale_i32;
                let py = y + row as i32 * scale_i32;
                for dy in 0..scale_i32 {
                    for dx in 0..scale_i32 {
                        let tx = px + dx;
                        let ty = py + dy;
                        if tx >= 0
                            && ty >= 0
                            && (tx as u32) < image.width()
                            && (ty as u32) < image.height()
                        {
                            image.put_pixel(tx as u32, ty as u32, Luma([color]));
                        }
                        if bold {
                            let bx = tx + 1;
                            if bx >= 0
                                && ty >= 0
                                && (bx as u32) < image.width()
                                && (ty as u32) < image.height()
                            {
                                image.put_pixel(bx as u32, ty as u32, Luma([color]));
                            }
                        }
                        for (extra_x, extra_y) in extra_offsets {
                            let ox = tx + extra_x;
                            let oy = ty + extra_y;
                            if ox >= 0
                                && oy >= 0
                                && (ox as u32) < image.width()
                                && (oy as u32) < image.height()
                            {
                                image.put_pixel(ox as u32, oy as u32, Luma([color]));
                            }
                        }
                    }
                }
            }
        }
        cursor_x += 8 * scale_i32 + letter_spacing;
    }
}

fn bitmap_text_width(text: &str, scale: u32, letter_spacing: i32) -> i32 {
    let chars = text.chars().count() as i32;
    if chars == 0 {
        return 0;
    }
    chars * (8 * scale as i32 + letter_spacing) - letter_spacing
}

#[derive(Debug, Clone, Copy)]
enum BitmapAlign {
    Left,
    Center,
    Right,
}

struct BitmapReceiptComposer {
    image: GrayImage,
    physical_width: i32,
    left_margin: i32,
    content_width: i32,
    y: i32,
    normal_scale: u32,
    large_scale: u32,
    letter_spacing: i32,
    spacing_scale: f32,
    header_bold: bool,
    banner_padding_y: i32,
    body_font_weight: u32,
}

impl BitmapReceiptComposer {
    fn new(cfg: &LayoutConfig) -> Self {
        let physical_width = default_printable_width_dots_for_paper(cfg.paper_width) as i32;
        let readability_scale = raster_readability_scale(cfg);
        let spacing_scale = classic_raster_spacing_scale(cfg);
        let mut left_margin = cfg.left_margin_dots as i32;
        if left_margin < 0 {
            left_margin = 0;
        }
        let mut content_width = cfg.printable_width_dots as i32;
        content_width = content_width.clamp(64, physical_width.max(64));
        if left_margin >= physical_width {
            left_margin = 0;
        }
        if left_margin + content_width > physical_width {
            content_width = (physical_width - left_margin).max(64);
        }
        let (normal_scale, large_scale) = if readability_scale >= 1.20 {
            (3, 4)
        } else {
            (2, 3)
        };
        Self {
            image: GrayImage::from_pixel(physical_width as u32, 6000, Luma([255])),
            physical_width,
            left_margin,
            content_width,
            y: ((10.0 * readability_scale * spacing_scale).round() as i32).max(8),
            normal_scale,
            large_scale,
            letter_spacing: 2,
            spacing_scale,
            header_bold: cfg.header_emphasis == HeaderEmphasis::Strong,
            banner_padding_y: if cfg.header_emphasis == HeaderEmphasis::Strong {
                4
            } else {
                3
            },
            body_font_weight: cfg.body_font_weight,
        }
    }

    fn chars_per_line(&self) -> usize {
        let adv = (8 * self.normal_scale as i32 + self.letter_spacing).max(1);
        (self.content_width / adv).max(8) as usize
    }

    fn line_height_for_scale(&self, scale: u32) -> i32 {
        (((8 * scale as i32 + 6) as f32) * self.spacing_scale)
            .round()
            .max(10.0) as i32
    }

    fn draw_text_line_internal(
        &mut self,
        text: &str,
        align: BitmapAlign,
        bold: bool,
        scale: u32,
        color: u8,
        apply_body_boldness: bool,
    ) {
        let text = text.trim_end();
        let text_w = bitmap_text_width(text, scale, self.letter_spacing);
        let x = match align {
            BitmapAlign::Left => self.left_margin,
            BitmapAlign::Center => self.left_margin + (self.content_width - text_w).max(0) / 2,
            BitmapAlign::Right => self.left_margin + (self.content_width - text_w).max(0),
        };
        let extra_offsets = if apply_body_boldness {
            body_boldness_offsets(self.body_font_weight)
        } else {
            &[]
        };
        draw_bitmap_text(
            &mut self.image,
            text,
            x,
            self.y,
            scale,
            self.letter_spacing,
            color,
            bold,
            extra_offsets,
        );
        self.y += self.line_height_for_scale(scale);
    }

    fn draw_text_line(
        &mut self,
        text: &str,
        align: BitmapAlign,
        bold: bool,
        scale: u32,
        color: u8,
    ) {
        self.draw_text_line_internal(text, align, bold, scale, color, false);
    }

    fn draw_body_text_line(
        &mut self,
        text: &str,
        align: BitmapAlign,
        bold: bool,
        scale: u32,
        color: u8,
    ) {
        self.draw_text_line_internal(text, align, bold, scale, color, true);
    }

    fn draw_left_wrapped(&mut self, text: &str, bold: bool, scale: u32) {
        for line in wrap(text, self.chars_per_line()) {
            self.draw_text_line(&line, BitmapAlign::Left, bold, scale, 0);
        }
    }

    fn draw_left_wrapped_body(&mut self, text: &str, bold: bool, scale: u32) {
        for line in wrap(text, self.chars_per_line()) {
            self.draw_body_text_line(&line, BitmapAlign::Left, bold, scale, 0);
        }
    }

    fn draw_pair(&mut self, label: &str, value: &str, bold: bool, scale: u32) {
        self.draw_pair_internal(label, value, bold, scale, false);
    }

    fn draw_pair_body(&mut self, label: &str, value: &str, bold: bool, scale: u32) {
        self.draw_pair_internal(label, value, bold, scale, true);
    }

    fn draw_pair_internal(
        &mut self,
        label: &str,
        value: &str,
        bold: bool,
        scale: u32,
        apply_body_boldness: bool,
    ) {
        let label = label.trim();
        let value = value.trim();
        if value.is_empty() {
            if apply_body_boldness {
                self.draw_left_wrapped_body(label, bold, scale);
            } else {
                self.draw_left_wrapped(label, bold, scale);
            }
            return;
        }
        let width = self.chars_per_line();
        let value_len = value.chars().count();
        if value_len >= width.saturating_sub(2) {
            if apply_body_boldness {
                self.draw_left_wrapped_body(label, bold, scale);
                self.draw_body_text_line(value, BitmapAlign::Right, bold, scale, 0);
            } else {
                self.draw_left_wrapped(label, bold, scale);
                self.draw_text_line(value, BitmapAlign::Right, bold, scale, 0);
            }
            return;
        }
        let max_label_width = width.saturating_sub(value_len + 1).max(8);
        let lines = wrap(label, max_label_width);
        if lines.is_empty() {
            if apply_body_boldness {
                self.draw_body_text_line(value, BitmapAlign::Right, bold, scale, 0);
            } else {
                self.draw_text_line(value, BitmapAlign::Right, bold, scale, 0);
            }
            return;
        }
        for line in &lines[..lines.len().saturating_sub(1)] {
            if apply_body_boldness {
                self.draw_body_text_line(line, BitmapAlign::Left, bold, scale, 0);
            } else {
                self.draw_text_line(line, BitmapAlign::Left, bold, scale, 0);
            }
        }
        let tail = lines.last().map(String::as_str).unwrap_or_default();
        let tail_len = tail.chars().count();
        if tail_len + value_len < width {
            let gap = width.saturating_sub(tail_len + value_len);
            let merged = format!("{tail}{}{value}", " ".repeat(gap));
            if apply_body_boldness {
                self.draw_body_text_line(&merged, BitmapAlign::Left, bold, scale, 0);
            } else {
                self.draw_text_line(&merged, BitmapAlign::Left, bold, scale, 0);
            }
        } else {
            if apply_body_boldness {
                self.draw_body_text_line(tail, BitmapAlign::Left, bold, scale, 0);
                self.draw_body_text_line(value, BitmapAlign::Right, bold, scale, 0);
            } else {
                self.draw_text_line(tail, BitmapAlign::Left, bold, scale, 0);
                self.draw_text_line(value, BitmapAlign::Right, bold, scale, 0);
            }
        }
    }

    fn draw_rule(&mut self) {
        let y = self.y + self.line_height_for_scale(self.normal_scale) / 2;
        let start = self.left_margin;
        let end = self.left_margin + self.content_width;
        let mut x = start;
        while x < end {
            for dash in 0..4 {
                let px = x + dash;
                if px >= end {
                    break;
                }
                for dy in 0..2 {
                    let py = y + dy;
                    if px >= 0
                        && py >= 0
                        && (px as u32) < self.image.width()
                        && (py as u32) < self.image.height()
                    {
                        self.image.put_pixel(px as u32, py as u32, Luma([0]));
                    }
                }
            }
            x += 6;
        }
        self.y += self.line_height_for_scale(self.normal_scale);
    }

    fn draw_reverse_banner(&mut self, text: &str) {
        let banner_h = self.line_height_for_scale(self.normal_scale) + self.banner_padding_y.max(2);
        let top = self.y;
        let bottom = top + banner_h;
        for py in top..bottom {
            for px in self.left_margin..(self.left_margin + self.content_width) {
                if px >= 0
                    && py >= 0
                    && (px as u32) < self.image.width()
                    && (py as u32) < self.image.height()
                {
                    self.image.put_pixel(px as u32, py as u32, Luma([0]));
                }
            }
        }
        let text_y = top + (self.banner_padding_y / 2).max(1);
        let text_w = bitmap_text_width(text, self.normal_scale, self.letter_spacing);
        let text_x = self.left_margin + (self.content_width - text_w).max(0) / 2;
        draw_bitmap_text(
            &mut self.image,
            text,
            text_x,
            text_y,
            self.normal_scale,
            self.letter_spacing,
            255,
            self.header_bold,
            &[],
        );
        self.y += banner_h + 2;
    }

    fn add_spacer(&mut self, lines: i32) {
        self.y += self.line_height_for_scale(self.normal_scale) * lines.max(0);
    }

    fn into_cropped(self) -> GrayImage {
        let final_height = (self.y + (20.0_f32 * self.spacing_scale).round() as i32)
            .clamp(1, self.image.height() as i32) as u32;
        image::imageops::crop_imm(
            &self.image,
            0,
            0,
            self.physical_width.max(1) as u32,
            final_height,
        )
        .to_image()
    }
}

fn grayscale_to_raster_bytes(image: &GrayImage, threshold: u8) -> (u16, u16, Vec<u8>) {
    let width = image.width();
    let height = image.height();
    let width_bytes = width.div_ceil(8) as u16;
    let mut data = Vec::with_capacity(width_bytes as usize * height as usize);
    for y in 0..height {
        for bx in 0..width_bytes as u32 {
            let mut byte = 0u8;
            for bit in 0..8u32 {
                let x = bx * 8 + bit;
                if x >= width {
                    continue;
                }
                let luma = image.get_pixel(x, y).0[0];
                if luma < threshold {
                    byte |= 0x80 >> bit;
                }
            }
            data.push(byte);
        }
    }
    (width_bytes, height as u16, data)
}

const ESC_POS_RASTER_MAX_CHUNK_HEIGHT_DOTS: usize = 192;

fn raster_image_to_escpos_bytes(image: &GrayImage, cfg: &LayoutConfig) -> Vec<u8> {
    let threshold = cfg.raster_threshold.clamp(40, 240);
    let (width_bytes, height_dots, data) = grayscale_to_raster_bytes(image, threshold);
    let mut builder = EscPosBuilder::new().with_paper(cfg.paper_width);
    builder.init();
    if is_star_line_mode(cfg) {
        // Star printers require the Star-specific ESC * r raster protocol.
        // GS v 0 is NOT supported by Star mC-Print3 and similar models.
        builder.star_raster_image(width_bytes, height_dots, &data);
        builder.lf().lf().lf().lf().star_cut();
    } else {
        // Standard ESC/POS: chunk tall images into multiple GS v 0 commands
        // to stay within printer buffer limits.
        let row_bytes = width_bytes as usize;
        let total_rows = height_dots as usize;
        let chunk_height = ESC_POS_RASTER_MAX_CHUNK_HEIGHT_DOTS.max(1);
        for row_start in (0..total_rows).step_by(chunk_height) {
            let rows_in_chunk = (total_rows - row_start).min(chunk_height);
            let byte_start = row_start * row_bytes;
            let byte_end = byte_start + rows_in_chunk * row_bytes;
            builder.raster_image(
                width_bytes,
                rows_in_chunk as u16,
                &data[byte_start..byte_end],
            );
        }
        builder.feed(4).cut();
    }
    builder.build()
}

fn copy_gray_image(dst: &mut GrayImage, src: &GrayImage, offset_x: u32, offset_y: u32) {
    for y in 0..src.height() {
        for x in 0..src.width() {
            let target_x = offset_x + x;
            let target_y = offset_y + y;
            if target_x < dst.width() && target_y < dst.height() {
                let pixel = *src.get_pixel(x, y);
                dst.put_pixel(target_x, target_y, pixel);
            }
        }
    }
}

fn first_non_white_row(image: &GrayImage) -> Option<u32> {
    for y in 0..image.height() {
        for x in 0..image.width() {
            if image.get_pixel(x, y).0[0] < 250 {
                return Some(y);
            }
        }
    }
    None
}

fn trim_raster_body_top_margin(image: &GrayImage) -> GrayImage {
    let Some(first_dark_row) = first_non_white_row(image) else {
        return image.clone();
    };
    let crop_from = first_dark_row.saturating_sub(2);
    if crop_from == 0 {
        return image.clone();
    }
    image::imageops::crop_imm(
        image,
        0,
        crop_from,
        image.width(),
        image.height() - crop_from,
    )
    .to_image()
}

fn receipt_like_logo_top_padding(paper: PaperWidth) -> u32 {
    match paper {
        PaperWidth::Mm58 => 10,
        PaperWidth::Mm80 => 14,
        PaperWidth::Mm112 => 18,
    }
}

fn receipt_like_logo_gap(paper: PaperWidth) -> u32 {
    match paper {
        PaperWidth::Mm58 => 8,
        PaperWidth::Mm80 => 12,
        PaperWidth::Mm112 => 16,
    }
}

fn logo_fallback_warning(message: impl Into<String>) -> RenderWarning {
    RenderWarning {
        code: "logo_text_fallback".to_string(),
        message: message.into(),
    }
}

fn compose_receipt_like_logo_image(
    body: GrayImage,
    cfg: &LayoutConfig,
) -> (GrayImage, Vec<RenderWarning>) {
    if !cfg.show_logo {
        return (body, Vec::new());
    }

    if cfg
        .logo_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return (
            body,
            vec![logo_fallback_warning(
                "Logo enabled but no logo source is configured; using text header fallback",
            )],
        );
    }

    let logo = match crate::print::load_receipt_like_logo_image(cfg) {
        Ok(Some(logo)) => logo,
        Ok(None) => {
            return (
                body,
                vec![logo_fallback_warning(
                    "Logo rendering was skipped; using text header fallback",
                )],
            )
        }
        Err(err) => {
            tracing::warn!(error = %err, "Receipt logo embed failed; keeping body-only raster output");
            return (
                body,
                vec![logo_fallback_warning(format!(
                    "Logo rendering failed; using text header fallback ({err})"
                ))],
            );
        }
    };

    let body = trim_raster_body_top_margin(&body);
    let top_padding = receipt_like_logo_top_padding(cfg.paper_width);
    let gap = receipt_like_logo_gap(cfg.paper_width);
    let total_height = top_padding + logo.height() + gap + body.height();
    let mut combined = GrayImage::from_pixel(body.width(), total_height, Luma([255]));
    let logo_x = ((combined.width() as i32 - logo.width() as i32) / 2).max(0) as u32;
    copy_gray_image(&mut combined, &logo, logo_x, top_padding);
    copy_gray_image(&mut combined, &body, 0, top_padding + logo.height() + gap);
    (combined, Vec::new())
}

fn finalize_raster_exact_bytes(
    body: GrayImage,
    cfg: &LayoutConfig,
    embed_logo: bool,
) -> (Vec<u8>, Vec<RenderWarning>) {
    let (composed, warnings) = if embed_logo {
        compose_receipt_like_logo_image(body, cfg)
    } else {
        (body, Vec::new())
    };
    (raster_image_to_escpos_bytes(&composed, cfg), warnings)
}

fn render_classic_customer_raster_exact_ttf(
    document: &ReceiptDocument,
    cfg: &LayoutConfig,
) -> Result<GrayImage, String> {
    let (doc, is_delivery_slip) = match document {
        ReceiptDocument::OrderReceipt(doc) => (doc, false),
        ReceiptDocument::DeliverySlip(doc) => (doc, true),
        _ => return Err("raster exact mode applies to customer receipts only".to_string()),
    };

    let lang = cfg.language.as_str();
    let comma = cfg.decimal_comma;
    let order_label_upper = receipt_label(lang, "Order").to_uppercase();
    let type_label = receipt_label(lang, "Type");
    let items_label_upper = receipt_label(lang, "ITEMS").to_uppercase();
    let order_type_display = translate_order_type(lang, &doc.order_type);
    let short_number = extract_short_order_number(&doc.order_number);
    let render_delivery_block = should_render_delivery_block(doc);
    let mut canvas = TtfReceiptComposer::try_new(cfg)?;
    let preset = canvas.preset;
    let cur = resolve_raster_currency_symbol(cfg, canvas.fonts);

    canvas.draw_rule();
    if let Some(copy_label) = cfg
        .copy_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        canvas.draw_text_line(copy_label, BitmapAlign::Center, preset.section_style);
    }
    let primary_line = header_primary_line(cfg);
    if !primary_line.is_empty() {
        canvas.draw_text_line(primary_line, BitmapAlign::Center, preset.address_style);
    }
    canvas.draw_rule();
    if let Some(address) = cfg
        .store_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        for segment in split_address_segments(address) {
            canvas.draw_wrapped(&segment, BitmapAlign::Left, preset.contact_style);
        }
    }
    if let Some(phone) = cfg
        .store_phone
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let phone_label = receipt_label(lang, "Phone");
        canvas.draw_wrapped(
            &format!("{phone_label}: {phone}"),
            BitmapAlign::Left,
            preset.contact_style,
        );
    }
    let vat_val = cfg
        .vat_number
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let office_val = cfg
        .tax_office
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let vat_label = receipt_label(lang, "VAT");
    let office_label = receipt_label(lang, "TAX_OFFICE");
    match (vat_val, office_val) {
        (Some(vat), Some(office)) => {
            canvas.draw_wrapped(
                &format!("{vat_label}: {vat}   {office_label}: {office}"),
                BitmapAlign::Left,
                preset.contact_style,
            );
        }
        (Some(vat), None) => {
            canvas.draw_wrapped(
                &format!("{vat_label}: {vat}"),
                BitmapAlign::Left,
                preset.contact_style,
            );
        }
        (None, Some(office)) => {
            canvas.draw_wrapped(
                &format!("{office_label}: {office}"),
                BitmapAlign::Left,
                preset.contact_style,
            );
        }
        (None, None) => {}
    }
    canvas.draw_rule();

    let banner = format!("{order_label_upper} #{short_number}");
    canvas.draw_reverse_banner(&banner);
    let meta_line = format!(
        "{} | {}: {}",
        format_datetime_human(&doc.created_at).replace(' ', " | "),
        type_label,
        order_type_display,
    );
    canvas.draw_text_line(&meta_line, BitmapAlign::Left, preset.meta_style);
    canvas.draw_rule();
    if is_delivery_slip {
        for (label, value) in delivery_slip_info_lines(doc, lang) {
            canvas.draw_pair(&format!("{label}:"), &value, preset.contact_style);
        }
        canvas.draw_rule();
    } else if render_delivery_block {
        canvas.draw_text_line(
            receipt_label(lang, "DELIVERY"),
            BitmapAlign::Left,
            preset.section_style,
        );
        canvas.draw_rule();
        for (label, value) in delivery_fields(doc, lang) {
            canvas.draw_pair(&format!("{label}:"), value, preset.contact_style);
        }
        canvas.draw_rule();
    }
    let order_notes = order_note_lines(doc);
    for note in &order_notes {
        canvas.draw_wrapped(
            &format!("_{}: {note}_", receipt_label(lang, "Note")),
            BitmapAlign::Left,
            preset.customization_style,
        );
    }
    if !order_notes.is_empty() {
        canvas.draw_rule();
    }

    canvas.draw_text_line(&items_label_upper, BitmapAlign::Left, preset.section_style);
    canvas.draw_rule();
    for item in &doc.items {
        if let Some(cat_line) = category_line(lang, item) {
            canvas.draw_wrapped(
                &cat_line,
                BitmapAlign::Left,
                category_raster_style(preset.customization_style),
            );
        }
        canvas.draw_pair(
            &format!("{} x {}", qty(item.quantity), item.name),
            &money_locale(item.total, comma),
            preset.item_style,
        );
        let (with_items, without_items) = split_customizations(item);
        for customization in with_items {
            canvas.draw_wrapped(
                &format!("  + {}", customization_display(lang, customization, true)),
                BitmapAlign::Left,
                preset.customization_style,
            );
        }
        if !without_items.is_empty() {
            canvas.draw_wrapped(
                &format!("  - {}", receipt_label(lang, "Without")),
                BitmapAlign::Left,
                preset.customization_style,
            );
            for customization in without_items {
                canvas.draw_wrapped(
                    &format!(
                        "    - {}",
                        customization_display(lang, customization, false)
                    ),
                    BitmapAlign::Left,
                    preset.customization_style,
                );
            }
        }
        if let Some(note) = item
            .note
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            canvas.draw_wrapped(
                &format!("  _{}: {note}_", receipt_label(lang, "Note")),
                BitmapAlign::Left,
                preset.customization_style,
            );
        }
    }
    canvas.draw_rule();

    let mut emphasized_total: Option<&TotalsLine> = None;
    for total in &doc.totals {
        let raw_label = total_label_text(lang, total);
        let label = format!("{raw_label}:");
        if total.emphasize {
            if emphasized_total.is_none() {
                emphasized_total = Some(total);
            }
        } else {
            canvas.draw_pair(
                &label,
                &money_locale(total.amount, comma),
                preset.subtotal_style,
            );
        }
    }
    if let Some(total) = emphasized_total {
        let label = format!("{}:", total_label_text(lang, total));
        canvas.draw_rule();
        canvas.draw_pair(
            &label,
            &money_with_currency_locale(total.amount, &cur, comma),
            preset.total_style,
        );
        canvas.draw_rule();
    }

    if let Some(method_label) = method_only_payment_label(doc, lang) {
        canvas.add_gap(preset.small_gap);
        canvas.draw_text_line(&method_label, BitmapAlign::Center, preset.section_style);
    } else {
        for payment in &doc.payments {
            let pay_label = format!("{}:", receipt_label(lang, &payment.label));
            if payment_amount_unknown(payment) {
                canvas.add_gap(preset.small_gap);
                canvas.draw_text_line(&pay_label, BitmapAlign::Center, preset.section_style);
                continue;
            }
            let value = money_locale(payment.amount, comma);
            canvas.draw_pair(&pay_label, &value, preset.payment_style);
        }

        if let Some(masked) = doc
            .masked_card
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            canvas.draw_pair(receipt_label(lang, "Card"), masked, preset.payment_style);
        }
    }

    if let Some(footer) = cfg
        .footer_text
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        canvas.draw_rule();
        let footer_key = if footer == "Thank you" {
            "Thank you preference"
        } else {
            footer
        };
        let translated = receipt_label(lang, footer_key);
        canvas.add_gap(preset.medium_gap);
        canvas.draw_text_line(
            &"*".repeat(preset.short_star_count),
            BitmapAlign::Center,
            preset.footer_star_style,
        );
        canvas.add_gap(preset.small_gap);
        canvas.draw_wrapped(translated, BitmapAlign::Center, preset.footer_text_style);
        canvas.add_gap(preset.medium_gap);
        canvas.draw_text_line(
            &"*".repeat(canvas.stars_for_width(preset.footer_star_style)),
            BitmapAlign::Center,
            preset.footer_star_style,
        );
    }

    if canvas.has_missing_glyphs() {
        return Err("embedded font missing glyphs for classic raster exact body".to_string());
    }

    Ok(canvas.into_cropped())
}

fn render_classic_customer_raster_exact_bitmap(
    document: &ReceiptDocument,
    cfg: &LayoutConfig,
) -> Result<GrayImage, String> {
    let (doc, is_delivery_slip) = match document {
        ReceiptDocument::OrderReceipt(doc) => (doc, false),
        ReceiptDocument::DeliverySlip(doc) => (doc, true),
        _ => return Err("raster exact mode applies to customer receipts only".to_string()),
    };

    let lang = cfg.language.as_str();
    let comma = cfg.decimal_comma;
    let order_label_upper = receipt_label(lang, "Order").to_uppercase();
    let type_label = receipt_label(lang, "Type");
    let items_label_upper = receipt_label(lang, "ITEMS").to_ascii_uppercase();
    let order_type_display = translate_order_type(lang, &doc.order_type);
    let short_number = extract_short_order_number(&doc.order_number);
    let render_delivery_block = should_render_delivery_block(doc);
    let cur = if cfg.currency_symbol.trim().is_empty() {
        " \u{20AC}".to_string()
    } else {
        cfg.currency_symbol.clone()
    };

    let mut canvas = BitmapReceiptComposer::new(cfg);
    canvas.draw_rule();
    if let Some(copy_label) = cfg
        .copy_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        canvas.draw_text_line(
            copy_label,
            BitmapAlign::Center,
            canvas.header_bold,
            canvas.normal_scale,
            0,
        );
    }
    let primary_line = header_primary_line(cfg);
    if !primary_line.is_empty() {
        canvas.draw_text_line(
            primary_line,
            BitmapAlign::Center,
            canvas.header_bold,
            canvas.normal_scale,
            0,
        );
    }
    canvas.draw_rule();
    if let Some(address) = cfg
        .store_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        for segment in split_address_segments(address) {
            canvas.draw_left_wrapped_body(&segment, false, canvas.normal_scale);
        }
    }
    if let Some(phone) = cfg
        .store_phone
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let phone_label = receipt_label(lang, "Phone");
        canvas.draw_left_wrapped(
            &format!("{phone_label}: {phone}"),
            false,
            canvas.normal_scale,
        );
    }
    let vat_val = cfg
        .vat_number
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let office_val = cfg
        .tax_office
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let vat_label = receipt_label(lang, "VAT");
    let office_label = receipt_label(lang, "TAX_OFFICE");
    match (vat_val, office_val) {
        (Some(vat), Some(office)) => {
            canvas.draw_left_wrapped(
                &format!("{vat_label}: {vat}   {office_label}: {office}"),
                false,
                canvas.normal_scale,
            );
        }
        (Some(vat), None) => {
            canvas.draw_left_wrapped(&format!("{vat_label}: {vat}"), false, canvas.normal_scale);
        }
        (None, Some(office)) => {
            canvas.draw_left_wrapped(
                &format!("{office_label}: {office}"),
                false,
                canvas.normal_scale,
            );
        }
        (None, None) => {}
    }
    canvas.draw_rule();

    let banner = format!("{order_label_upper} #{short_number}");
    canvas.draw_reverse_banner(&banner);
    let meta_line = format!(
        "{} | {}: {}",
        format_datetime_human(&doc.created_at).replace(' ', " | "),
        type_label,
        order_type_display,
    );
    canvas.draw_body_text_line(&meta_line, BitmapAlign::Left, false, canvas.normal_scale, 0);
    canvas.draw_rule();
    if is_delivery_slip {
        for (label, value) in delivery_slip_info_lines(doc, lang) {
            canvas.draw_pair_body(&format!("{label}:"), &value, false, canvas.normal_scale);
        }
        canvas.draw_rule();
    } else if render_delivery_block {
        canvas.draw_text_line(
            receipt_label(lang, "DELIVERY"),
            BitmapAlign::Left,
            canvas.header_bold,
            canvas.normal_scale,
            0,
        );
        canvas.draw_rule();
        for (label, value) in delivery_fields(doc, lang) {
            canvas.draw_pair_body(&format!("{label}:"), value, false, canvas.normal_scale);
        }
        canvas.draw_rule();
    }
    let order_notes = order_note_lines(doc);
    for note in &order_notes {
        canvas.draw_left_wrapped_body(
            &format!("_{}: {note}_", receipt_label(lang, "Note")),
            false,
            canvas.normal_scale,
        );
    }
    if !order_notes.is_empty() {
        canvas.draw_rule();
    }

    canvas.draw_text_line(
        &items_label_upper,
        BitmapAlign::Left,
        canvas.header_bold,
        canvas.normal_scale,
        0,
    );
    canvas.draw_rule();
    for item in &doc.items {
        if let Some(cat_line) = category_line(lang, item) {
            canvas.draw_left_wrapped(&cat_line, true, canvas.normal_scale);
        }
        canvas.draw_pair_body(
            &format!("{} x {}", qty(item.quantity), item.name),
            &money_locale(item.total, comma),
            false,
            canvas.normal_scale,
        );
        let (with_items, without_items) = split_customizations(item);
        for customization in with_items {
            canvas.draw_left_wrapped_body(
                &format!("  + {}", customization_display(lang, customization, true)),
                false,
                canvas.normal_scale,
            );
        }
        if !without_items.is_empty() {
            canvas.draw_left_wrapped_body(
                &format!("  - {}", receipt_label(lang, "Without")),
                false,
                canvas.normal_scale,
            );
            for customization in without_items {
                canvas.draw_left_wrapped_body(
                    &format!(
                        "    - {}",
                        customization_display(lang, customization, false)
                    ),
                    false,
                    canvas.normal_scale,
                );
            }
        }
        if let Some(note) = item
            .note
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            canvas.draw_left_wrapped_body(
                &format!("  _{}: {note}_", receipt_label(lang, "Note")),
                false,
                canvas.normal_scale,
            );
        }
    }
    canvas.draw_rule();

    for total in &doc.totals {
        let raw_label = total_label_text(lang, total);
        let label = format!("{raw_label}:");
        if total.emphasize {
            canvas.draw_rule();
            canvas.draw_pair(
                &label,
                &money_with_currency_locale(total.amount, &cur, comma),
                true,
                canvas.large_scale,
            );
            canvas.draw_rule();
        } else {
            canvas.draw_pair_body(
                &label,
                &money_locale(total.amount, comma),
                false,
                canvas.normal_scale,
            );
        }
    }

    if let Some(method_label) = method_only_payment_label(doc, lang) {
        canvas.add_spacer(1);
        canvas.draw_text_line(
            &method_label,
            BitmapAlign::Center,
            canvas.header_bold,
            canvas.normal_scale,
            0,
        );
    } else {
        for payment in &doc.payments {
            let pay_label = format!("{}:", receipt_label(lang, &payment.label));
            if payment_amount_unknown(payment) {
                canvas.add_spacer(1);
                canvas.draw_text_line(
                    &pay_label,
                    BitmapAlign::Center,
                    canvas.header_bold,
                    canvas.normal_scale,
                    0,
                );
                continue;
            }
            let value = money_locale(payment.amount, comma);
            canvas.draw_pair_body(&pay_label, &value, false, canvas.normal_scale);
        }

        if let Some(masked) = doc
            .masked_card
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            canvas.draw_pair_body(
                receipt_label(lang, "Card"),
                masked,
                false,
                canvas.normal_scale,
            );
        }
    }

    if let Some(footer) = cfg
        .footer_text
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        canvas.draw_rule();
        let footer_key = if footer == "Thank you" {
            "Thank you preference"
        } else {
            footer
        };
        let translated = receipt_label(lang, footer_key);
        canvas.add_spacer(1);
        canvas.draw_text_line(
            &"*".repeat(14),
            BitmapAlign::Center,
            false,
            canvas.normal_scale,
            0,
        );
        canvas.add_spacer(1);
        let footer_width = canvas.chars_per_line().saturating_sub(2).max(12);
        for line in wrap(translated, footer_width) {
            canvas.draw_body_text_line(&line, BitmapAlign::Center, false, canvas.large_scale, 0);
        }
        canvas.draw_text_line(
            &"*".repeat(canvas.chars_per_line().max(24)),
            BitmapAlign::Center,
            false,
            canvas.normal_scale,
            0,
        );
    }

    Ok(canvas.into_cropped())
}

fn render_classic_customer_raster_exact(
    document: &ReceiptDocument,
    cfg: &LayoutConfig,
) -> Result<(Vec<u8>, Vec<RenderWarning>), String> {
    match render_classic_customer_raster_exact_ttf(document, cfg) {
        Ok(image) => Ok(finalize_raster_exact_bytes(image, cfg, true)),
        Err(err) => {
            tracing::warn!(error = %err, "Raster exact TTF render failed; using bitmap fallback");
            let image = render_classic_customer_raster_exact_bitmap(document, cfg)?;
            Ok(finalize_raster_exact_bytes(image, cfg, true))
        }
    }
}

fn emit_raster_common_header(
    canvas: &mut TtfReceiptComposer,
    cfg: &LayoutConfig,
    lang: &str,
    preset: RasterExactPreset,
) {
    canvas.draw_rule();
    if let Some(copy_label) = cfg
        .copy_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        canvas.draw_text_line(copy_label, BitmapAlign::Center, preset.section_style);
    }
    let primary_line = header_primary_line(cfg);
    if !primary_line.is_empty() {
        canvas.draw_text_line(primary_line, BitmapAlign::Center, preset.address_style);
    }
    canvas.draw_rule();
    if let Some(address) = cfg
        .store_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        for segment in split_address_segments(address) {
            canvas.draw_wrapped(&segment, BitmapAlign::Left, preset.contact_style);
        }
    }
    if let Some(phone) = cfg
        .store_phone
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let phone_label = receipt_label(lang, "Phone");
        canvas.draw_wrapped(
            &format!("{phone_label}: {phone}"),
            BitmapAlign::Left,
            preset.contact_style,
        );
    }
    let vat_val = cfg
        .vat_number
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let office_val = cfg
        .tax_office
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let vat_label = receipt_label(lang, "VAT");
    let office_label = receipt_label(lang, "TAX_OFFICE");
    match (vat_val, office_val) {
        (Some(vat), Some(office)) => {
            canvas.draw_wrapped(
                &format!("{vat_label}: {vat}   {office_label}: {office}"),
                BitmapAlign::Left,
                preset.contact_style,
            );
        }
        (Some(vat), None) => {
            canvas.draw_wrapped(
                &format!("{vat_label}: {vat}"),
                BitmapAlign::Left,
                preset.contact_style,
            );
        }
        (None, Some(office)) => {
            canvas.draw_wrapped(
                &format!("{office_label}: {office}"),
                BitmapAlign::Left,
                preset.contact_style,
            );
        }
        (None, None) => {}
    }
    canvas.draw_rule();
}

fn emit_raster_common_footer(
    canvas: &mut TtfReceiptComposer,
    cfg: &LayoutConfig,
    lang: &str,
    preset: RasterExactPreset,
) {
    if let Some(footer) = cfg
        .footer_text
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        canvas.draw_rule();
        let footer_key = if footer == "Thank you" {
            "Thank you preference"
        } else {
            footer
        };
        let translated = receipt_label(lang, footer_key);
        canvas.add_gap(preset.medium_gap);
        canvas.draw_text_line(
            &"*".repeat(preset.short_star_count),
            BitmapAlign::Center,
            preset.footer_star_style,
        );
        canvas.add_gap(preset.small_gap);
        canvas.draw_wrapped(translated, BitmapAlign::Center, preset.footer_text_style);
        canvas.add_gap(preset.medium_gap);
        canvas.draw_text_line(
            &"*".repeat(canvas.stars_for_width(preset.footer_star_style)),
            BitmapAlign::Center,
            preset.footer_star_style,
        );
    }
}

fn render_classic_non_customer_raster_exact_ttf(
    document: &ReceiptDocument,
    cfg: &LayoutConfig,
) -> Result<GrayImage, String> {
    let lang = cfg.language.as_str();
    let comma = cfg.decimal_comma;
    let mut canvas = TtfReceiptComposer::try_new(cfg)?;
    let preset = canvas.preset;
    let cur = resolve_raster_currency_symbol(cfg, canvas.fonts);

    emit_raster_common_header(&mut canvas, cfg, lang, preset);

    match document {
        ReceiptDocument::KitchenTicket(doc) => {
            let title = receipt_label(lang, "KITCHEN TICKET").to_uppercase();
            canvas.draw_reverse_banner(&title);
            let order_type_display = translate_order_type(lang, &doc.order_type);
            canvas.draw_text_line(
                &format!("{} #{}", receipt_label(lang, "Order"), doc.order_number),
                BitmapAlign::Left,
                preset.meta_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Type")),
                &order_type_display,
                preset.meta_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Date")),
                &format_datetime_human(&doc.created_at),
                preset.meta_style,
            );
            if let Some(table) = doc
                .table_number
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                canvas.draw_pair(
                    &format!("{}:", receipt_label(lang, "Table")),
                    table,
                    preset.meta_style,
                );
            }
            if let Some(customer) = doc
                .customer_name
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                canvas.draw_pair(
                    &format!("{}:", receipt_label(lang, "Customer")),
                    customer,
                    preset.meta_style,
                );
            }
            if let Some(phone) = doc
                .customer_phone
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                canvas.draw_pair(
                    &format!("{}:", receipt_label(lang, "Phone")),
                    phone,
                    preset.meta_style,
                );
            }
            canvas.draw_rule();
            canvas.draw_text_line(
                &receipt_label(lang, "ITEMS").to_uppercase(),
                BitmapAlign::Left,
                preset.section_style,
            );
            canvas.draw_rule();
            if doc.items.is_empty() {
                canvas.draw_text_line(
                    receipt_label(lang, "No items"),
                    BitmapAlign::Left,
                    preset.item_style,
                );
            } else {
                for item in &doc.items {
                    if let Some(cat_line) = category_line(lang, item) {
                        canvas.draw_wrapped(
                            &cat_line,
                            BitmapAlign::Left,
                            category_raster_style(preset.customization_style),
                        );
                    }
                    canvas.draw_pair(
                        &format!("{} x {}", qty(item.quantity), item.name),
                        &money_locale(item.total, comma),
                        preset.item_style,
                    );
                    let (with_items, without_items) = split_customizations(item);
                    for customization in with_items {
                        canvas.draw_wrapped(
                            &format!("  + {}", customization_display(lang, customization, true)),
                            BitmapAlign::Left,
                            preset.customization_style,
                        );
                    }
                    if !without_items.is_empty() {
                        canvas.draw_wrapped(
                            &format!("  - {}", receipt_label(lang, "Without")),
                            BitmapAlign::Left,
                            preset.customization_style,
                        );
                        for customization in without_items {
                            canvas.draw_wrapped(
                                &format!(
                                    "    - {}",
                                    customization_display(lang, customization, false)
                                ),
                                BitmapAlign::Left,
                                preset.customization_style,
                            );
                        }
                    }
                    if let Some(note) = item
                        .note
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        canvas.draw_wrapped(
                            &format!("  _{}: {note}_", receipt_label(lang, "Note")),
                            BitmapAlign::Left,
                            preset.customization_style,
                        );
                    }
                }
            }
        }
        ReceiptDocument::ShiftCheckout(doc) => {
            canvas.draw_reverse_banner(receipt_label(lang, "SHIFT CHECKOUT"));
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Staff")),
                &doc.staff_name,
                preset.meta_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Role")),
                &receipt_role_text(lang, &doc.role_type),
                preset.meta_style,
            );
            if !should_render_minimal_shift_checkout(doc) {
                if let Some(terminal_name) = non_empty_receipt_value(&doc.terminal_name) {
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Terminal")),
                        terminal_name,
                        preset.meta_style,
                    );
                }
            }
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Check-in")),
                &format_datetime_human(&doc.check_in),
                preset.meta_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Check-out")),
                &format_datetime_human(&doc.check_out),
                preset.meta_style,
            );
            if !should_render_minimal_shift_checkout(doc) {
                canvas.draw_rule();
                if should_render_shift_checkout_driver_summary(doc) {
                    for row in driver_shift_checkout_summary_rows(doc) {
                        let style = if row.emphasize {
                            preset.total_style
                        } else {
                            preset.item_style
                        };
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, row.label_key)),
                            &money_with_currency_locale(row.amount, &cur, comma),
                            style,
                        );
                    }

                    if !doc.driver_deliveries.is_empty() {
                        canvas.draw_rule();
                        canvas.draw_text_line(
                            receipt_label(lang, "DRIVER DELIVERIES"),
                            BitmapAlign::Left,
                            preset.section_style,
                        );
                        canvas.draw_rule();
                        for line in &doc.driver_deliveries {
                            let label = format!("#{} {}", line.order_number, line.payment_method);
                            canvas.draw_pair(
                                &label,
                                &money_with_currency_locale(line.total_amount, &cur, comma),
                                preset.item_style,
                            );
                        }
                    }
                } else if should_render_shift_checkout_cashier_summary(doc) {
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Orders")),
                        &doc.orders_count.to_string(),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Sales")),
                        &money_with_currency_locale(doc.sales_amount, &cur, comma),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Cash Sales")),
                        &money_with_currency_locale(doc.cash_sales, &cur, comma),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Card Sales")),
                        &money_with_currency_locale(doc.card_sales, &cur, comma),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Opening")),
                        &money_with_currency_locale(doc.opening_amount, &cur, comma),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Refunds")),
                        &format!(
                            "-{}",
                            money_with_currency_locale(doc.cash_refunds, &cur, comma)
                        ),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Expenses")),
                        &format!(
                            "-{}",
                            money_with_currency_locale(doc.total_expenses, &cur, comma)
                        ),
                        preset.item_style,
                    );
                    if doc.cash_drops > 0.0 {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Cash Drops")),
                            &format!(
                                "-{}",
                                money_with_currency_locale(doc.cash_drops, &cur, comma)
                            ),
                            preset.item_style,
                        );
                    }
                    if doc.driver_cash_given > 0.0 {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Driver Given")),
                            &format!(
                                "-{}",
                                money_with_currency_locale(doc.driver_cash_given, &cur, comma)
                            ),
                            preset.item_style,
                        );
                    }
                    if doc.driver_cash_returned > 0.0 {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Driver Returned")),
                            &format!(
                                "+{}",
                                money_with_currency_locale(doc.driver_cash_returned, &cur, comma)
                            ),
                            preset.item_style,
                        );
                    }
                    if doc.transferred_staff_count > 0 {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Transferred Staff")),
                            &doc.transferred_staff_count.to_string(),
                            preset.item_style,
                        );
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Transferred Staff Returns")),
                            &format!(
                                "+{}",
                                money_with_currency_locale(
                                    doc.transferred_staff_returns,
                                    &cur,
                                    comma
                                )
                            ),
                            preset.item_style,
                        );
                    }
                    if doc.staff_payouts_total > 0.0 {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Staff Payouts")),
                            &format!(
                                "-{}",
                                money_with_currency_locale(doc.staff_payouts_total, &cur, comma)
                            ),
                            preset.item_style,
                        );
                    }
                    if let Some(expected) = doc.expected_amount {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Expected")),
                            &money_with_currency_locale(expected, &cur, comma),
                            preset.item_style,
                        );
                    }
                    if let Some(closing) = doc.closing_amount {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Counted Cash")),
                            &money_with_currency_locale(closing, &cur, comma),
                            preset.item_style,
                        );
                    }
                    if let Some(variance) = doc.variance_amount {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Variance")),
                            &money_with_currency_locale(variance, &cur, comma),
                            preset.item_style,
                        );
                    }
                    if let Some(expected) = doc.expected_amount {
                        canvas.draw_rule();
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Expected In Drawer")),
                            &money_with_currency_locale(expected, &cur, comma),
                            preset.total_style,
                        );
                    }
                    if !doc.staff_payout_lines.is_empty() {
                        canvas.draw_rule();
                        canvas.draw_text_line(
                            receipt_label(lang, "STAFF PAYOUTS"),
                            BitmapAlign::Left,
                            preset.section_style,
                        );
                        canvas.draw_rule();
                        for payout in &doc.staff_payout_lines {
                            let role_label = receipt_role_text(lang, &payout.role_type);
                            let label = format!("{} ({})", payout.staff_name, role_label);
                            canvas.draw_pair(
                                &label,
                                &format!(
                                    "-{}",
                                    money_with_currency_locale(payout.amount, &cur, comma)
                                ),
                                preset.item_style,
                            );
                        }
                    }
                } else {
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Orders")),
                        &doc.orders_count.to_string(),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Sales")),
                        &money_with_currency_locale(doc.sales_amount, &cur, comma),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Expenses")),
                        &money_with_currency_locale(doc.total_expenses, &cur, comma),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Refunds")),
                        &money_with_currency_locale(doc.cash_refunds, &cur, comma),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("{}:", receipt_label(lang, "Opening")),
                        &money_with_currency_locale(doc.opening_amount, &cur, comma),
                        preset.item_style,
                    );
                    if doc.transferred_staff_count > 0 {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Transferred Staff")),
                            &doc.transferred_staff_count.to_string(),
                            preset.item_style,
                        );
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Transferred Staff Returns")),
                            &format!(
                                "+{}",
                                money_with_currency_locale(
                                    doc.transferred_staff_returns,
                                    &cur,
                                    comma
                                )
                            ),
                            preset.item_style,
                        );
                    }
                    if let Some(expected) = doc.expected_amount {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Expected")),
                            &money_with_currency_locale(expected, &cur, comma),
                            preset.item_style,
                        );
                    }
                    if let Some(closing) = doc.closing_amount {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Closing")),
                            &money_with_currency_locale(closing, &cur, comma),
                            preset.item_style,
                        );
                    }
                    if let Some(variance) = doc.variance_amount {
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Variance")),
                            &money_with_currency_locale(variance, &cur, comma),
                            preset.item_style,
                        );
                    }
                    if let Some(expected) = doc.expected_amount {
                        canvas.draw_rule();
                        canvas.draw_pair(
                            &format!("{}:", receipt_label(lang, "Expected In Drawer")),
                            &money_with_currency_locale(expected, &cur, comma),
                            preset.total_style,
                        );
                    }
                }
            }
        }
        ReceiptDocument::ZReport(doc) => {
            canvas.draw_reverse_banner(receipt_label(lang, "Z REPORT"));
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Date")),
                &doc.report_date,
                preset.meta_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Generated")),
                &format_datetime_human(&doc.generated_at),
                preset.meta_style,
            );
            if let Some((label, value)) = z_report_shift_line(doc, lang) {
                canvas.draw_pair(&format!("{label}:"), &value, preset.meta_style);
            }
            if let Some(terminal_name) = non_empty_receipt_value(&doc.terminal_name) {
                canvas.draw_pair(
                    &format!("{}:", receipt_label(lang, "Terminal")),
                    terminal_name,
                    preset.meta_style,
                );
            }
            canvas.draw_rule();
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Orders")),
                &doc.total_orders.to_string(),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Gross")),
                &money_with_currency_locale(doc.gross_sales, &cur, comma),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Net")),
                &money_with_currency_locale(doc.net_sales, &cur, comma),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Cash")),
                &money_with_currency_locale(doc.cash_sales, &cur, comma),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Card")),
                &money_with_currency_locale(doc.card_sales, &cur, comma),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Refunds")),
                &money_with_currency_locale(doc.refunds_total, &cur, comma),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Voids")),
                &money_with_currency_locale(doc.voids_total, &cur, comma),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Discounts")),
                &money_with_currency_locale(doc.discounts_total, &cur, comma),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Expenses")),
                &money_with_currency_locale(doc.expenses_total, &cur, comma),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Variance")),
                &money_with_currency_locale(doc.cash_variance, &cur, comma),
                preset.item_style,
            );

            // --- Staff details ---
            if !doc.staff_reports.is_empty() {
                canvas.draw_rule();
                canvas.draw_text_line(
                    receipt_label(lang, "STAFF"),
                    BitmapAlign::Left,
                    preset.section_style,
                );
                for staff in &doc.staff_reports {
                    let role_label = match staff.role.as_str() {
                        "driver" => receipt_label(lang, "Driver"),
                        "cashier" => receipt_label(lang, "Cashier"),
                        _ => &staff.role,
                    };
                    canvas.draw_text_line(
                        &format!("{} ({})", staff.name, role_label),
                        BitmapAlign::Left,
                        preset.section_style,
                    );
                    // Time range + staff payment on one line
                    let ci_display = staff
                        .check_in
                        .as_deref()
                        .and_then(|v| v.get(11..16))
                        .unwrap_or("--:--");
                    let co_display = staff
                        .check_out
                        .as_deref()
                        .and_then(|v| v.get(11..16))
                        .unwrap_or("--:--");
                    let time_range = format!("  {}-{}", ci_display, co_display);
                    if staff.staff_payment > 0.0 {
                        canvas.draw_pair(
                            &format!("{} {}", time_range, receipt_label(lang, "Payout")),
                            &money_with_currency_locale(staff.staff_payment, &cur, comma),
                            preset.item_style,
                        );
                    } else {
                        canvas.draw_text_line(&time_range, BitmapAlign::Left, preset.item_style);
                    }
                    if staff.opening_cash > 0.0 {
                        canvas.draw_pair(
                            &format!("  {}:", receipt_label(lang, "Starting")),
                            &money_with_currency_locale(staff.opening_cash, &cur, comma),
                            preset.item_style,
                        );
                    }
                    canvas.draw_pair(
                        &format!("  {}:", receipt_label(lang, "Orders")),
                        &staff.order_count.to_string(),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("  {}:", receipt_label(lang, "Cash")),
                        &money_with_currency_locale(staff.cash_amount, &cur, comma),
                        preset.item_style,
                    );
                    canvas.draw_pair(
                        &format!("  {}:", receipt_label(lang, "Card")),
                        &money_with_currency_locale(staff.card_amount, &cur, comma),
                        preset.item_style,
                    );
                }
            }

            // --- Daily totals ---
            canvas.draw_rule();
            canvas.draw_text_line(
                receipt_label(lang, "TOTAL"),
                BitmapAlign::Left,
                preset.section_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Orders")),
                &doc.total_orders.to_string(),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Cash")),
                &money_with_currency_locale(doc.cash_sales, &cur, comma),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Card")),
                &money_with_currency_locale(doc.card_sales, &cur, comma),
                preset.item_style,
            );
            canvas.draw_pair(
                &format!("{}:", receipt_label(lang, "Net")),
                &money_with_currency_locale(doc.net_sales, &cur, comma),
                preset.section_style,
            );
        }
        ReceiptDocument::OrderReceipt(_) | ReceiptDocument::DeliverySlip(_) => {
            return Err("customer documents must use customer raster exact path".to_string())
        }
    }

    // Skip "Thank you" footer for Z-report and shift-checkout receipts
    let skip_footer = matches!(
        document,
        ReceiptDocument::ZReport(_) | ReceiptDocument::ShiftCheckout(_)
    );
    if !skip_footer {
        emit_raster_common_footer(&mut canvas, cfg, lang, preset);
    }

    if canvas.has_missing_glyphs() {
        return Err("embedded font missing glyphs for classic raster exact body".to_string());
    }

    Ok(canvas.into_cropped())
}

fn render_classic_raster_exact(
    document: &ReceiptDocument,
    cfg: &LayoutConfig,
) -> Result<(Vec<u8>, Vec<RenderWarning>), String> {
    match document {
        ReceiptDocument::OrderReceipt(_) | ReceiptDocument::DeliverySlip(_) => {
            render_classic_customer_raster_exact(document, cfg)
        }
        ReceiptDocument::KitchenTicket(_)
        | ReceiptDocument::ShiftCheckout(_)
        | ReceiptDocument::ZReport(_) => {
            let image = render_classic_non_customer_raster_exact_ttf(document, cfg)?;
            Ok(finalize_raster_exact_bytes(image, cfg, true))
        }
    }
}

pub fn render_classic_raster_exact_preview_data_url(
    document: &ReceiptDocument,
    cfg: &LayoutConfig,
) -> Result<(String, Vec<RenderWarning>), String> {
    let body = match document {
        ReceiptDocument::OrderReceipt(_) | ReceiptDocument::DeliverySlip(_) => {
            match render_classic_customer_raster_exact_ttf(document, cfg) {
                Ok(image) => image,
                Err(err) => {
                    tracing::warn!(error = %err, "Raster exact preview TTF render failed; using bitmap fallback");
                    render_classic_customer_raster_exact_bitmap(document, cfg)?
                }
            }
        }
        ReceiptDocument::KitchenTicket(_)
        | ReceiptDocument::ShiftCheckout(_)
        | ReceiptDocument::ZReport(_) => {
            render_classic_non_customer_raster_exact_ttf(document, cfg)?
        }
    };
    let (composed, warnings) = compose_receipt_like_logo_image(body, cfg);
    let mut encoded = Vec::new();
    image::DynamicImage::ImageLuma8(composed)
        .write_to(&mut Cursor::new(&mut encoded), image::ImageFormat::Png)
        .map_err(|err| format!("failed to encode preview png: {err}"))?;
    Ok((
        format!("data:image/png;base64,{}", BASE64_STANDARD.encode(encoded)),
        warnings,
    ))
}

pub fn render_escpos(document: &ReceiptDocument, cfg: &LayoutConfig) -> EscPosRender {
    let doc_target = escpos_document_target(document);
    let style = escpos_style(cfg, doc_target);
    let classic_customer_layout = !style.modern && doc_target.is_customer_receipt();
    let mut warnings = Vec::new();
    let payment_warning_doc = match document {
        ReceiptDocument::OrderReceipt(doc) | ReceiptDocument::DeliverySlip(doc) => Some(doc),
        _ => None,
    };
    if payment_warning_doc.is_some_and(has_payment_amount_warning) {
        warnings.push(RenderWarning {
            code: "payment_amount_unavailable".to_string(),
            message:
                "Payment amount unavailable from stored payment rows; rendered method only from order snapshot"
                    .to_string(),
        });
    }
    if !style.modern && cfg.classic_customer_render_mode == ClassicCustomerRenderMode::RasterExact {
        match render_classic_raster_exact(document, cfg) {
            Ok((bytes, raster_warnings)) => {
                warnings.extend(raster_warnings);
                return EscPosRender {
                    bytes,
                    warnings,
                    body_mode: EscPosBodyMode::RasterExact,
                };
            }
            Err(err) => warnings.push(RenderWarning {
                code: "raster_exact_fallback".to_string(),
                message: format!("Raster exact render failed; falling back to text mode ({err})"),
            }),
        }
    }
    let use_star_commands = is_star_line_mode(cfg);
    let mut builder = if use_star_commands {
        EscPosBuilder::new()
            .with_paper(cfg.paper_width)
            .with_star_line_mode()
    } else {
        EscPosBuilder::new().with_paper(cfg.paper_width)
    };
    builder.init();
    warnings.extend(apply_character_set(
        &mut builder,
        &cfg.character_set,
        cfg.greek_render_mode.as_deref(),
        cfg.escpos_code_page,
        use_star_commands,
    ));
    let render_font = cfg.font_type;
    match render_font {
        FontType::A => {
            builder.font_a();
        }
        FontType::B => {
            builder.font_b();
        }
    }
    // Classic layout: double text size (2×2) for larger thermal print output.
    // Halve effective width since each character now occupies 2 columns.
    let width = if !style.modern {
        builder.text_size(2, 2);
        cfg.paper_width.chars() / 2
    } else {
        cfg.paper_width.chars()
    };
    emit_header(&mut builder, cfg, style, doc_target, &mut warnings);

    let lang = cfg.language.as_str();
    let comma = cfg.decimal_comma;
    match document {
        ReceiptDocument::OrderReceipt(doc) => {
            let render_delivery_block = should_render_delivery_block(doc);
            let order_type_display = translate_order_type(lang, &doc.order_type);
            let resolved_currency = if classic_customer_layout {
                normalize_currency_symbol_for_layout(
                    &cfg.currency_symbol,
                    &cfg.character_set,
                    cfg.escpos_code_page,
                    cfg.detected_brand,
                )
            } else {
                cfg.currency_symbol.clone()
            };
            let cur = resolved_currency.as_str();
            {
                let order_label = receipt_label(lang, "Order");
                let type_label = receipt_label(lang, "Type");
                if style.modern {
                    // Modern: bordered order-type box + meta-grid pairs (matches HTML preview)
                    emit_rule(&mut builder, width, '-');
                    builder.center().bold(true);
                    builder.text(&format!("[ {} ]", order_type_display)).lf();
                    builder.bold(false).left();
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Order"),
                        &format!("#{}", doc.order_number),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Date"),
                        &format_datetime_human(&doc.created_at),
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
                    if !render_delivery_block {
                        if let Some(phone) = doc
                            .customer_phone
                            .as_deref()
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                        {
                            emit_pair(&mut builder, receipt_label(lang, "Phone"), phone, width);
                        }
                    }
                } else {
                    // Classic: reverse (white-on-black) banner for order number
                    // Uppercase label (Παραγγελία → ΠΑΡΑΓΓΕΛΙΑ) and use short
                    // order number (ORD-20260303-00019 → 00019).
                    let order_label_upper = order_label.to_uppercase();
                    let short_number = extract_short_order_number(&doc.order_number);
                    let banner_text = format!("{} #{}", order_label_upper, short_number);
                    let text_len = banner_text.chars().count();
                    // Pad to full paper width for a solid black bar
                    let pad_total = width.saturating_sub(text_len);
                    let pad_left = pad_total / 2;
                    let pad_right = pad_total - pad_left;
                    let padded = format!(
                        "{}{}{}",
                        " ".repeat(pad_left),
                        banner_text,
                        " ".repeat(pad_right),
                    );
                    if !classic_customer_layout {
                        emit_rule(&mut builder, width, style.profile.block_rule);
                    }
                    builder.center().bold(true);
                    if use_star_commands {
                        builder.star_reverse(true);
                    } else {
                        builder.reverse(true);
                    }
                    builder.text(&padded).lf();
                    if use_star_commands {
                        builder.star_reverse(false);
                    } else {
                        builder.reverse(false);
                    }
                    builder.bold(false);
                    builder.left();
                    // Date with full year + single-space pipes
                    let meta_line = format!(
                        "{} | {}: {}",
                        format_datetime_human(&doc.created_at).replace(' ', " | "),
                        type_label,
                        order_type_display,
                    );
                    builder.text(&meta_line).lf();
                    if classic_customer_layout {
                        // Screenshot-2 structure: explicit separator after order meta.
                        emit_rule(&mut builder, width, style.profile.block_rule);
                    } else {
                        // Legacy classic spacing (kitchen/report paths unchanged).
                        builder.lf();
                    }
                }
            }
            // Classic only: table/customer/phone as bold-label pairs
            // (Modern handles these in the meta-grid above)
            if !style.modern {
                if let Some(table) = doc
                    .table_number
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    let table_label = receipt_label(lang, "Table");
                    builder
                        .bold(true)
                        .text(&format!("{table_label}:"))
                        .bold(false)
                        .text(&format!(" {table}"))
                        .lf();
                }
                if let Some(customer) = doc
                    .customer_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    let customer_label = receipt_label(lang, "Customer");
                    builder
                        .bold(true)
                        .text(&format!("{customer_label}:"))
                        .bold(false)
                        .text(&format!(" {customer}"))
                        .lf();
                }
                if let Some(phone) = doc
                    .customer_phone
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    if !render_delivery_block {
                        let phone_label = receipt_label(lang, "Phone");
                        builder
                            .bold(true)
                            .text(&format!("{phone_label}:"))
                            .bold(false)
                            .text(&format!(" {phone}"))
                            .lf();
                    }
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
                    if style.modern {
                        emit_pair_bold(
                            &mut builder,
                            receipt_label(lang, "Driver"),
                            driver_name,
                            width,
                        );
                    } else {
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Driver"),
                            driver_name,
                            width,
                        );
                    }
                }
                if let Some(address) = doc
                    .delivery_address
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if style.modern {
                        emit_pair_bold(
                            &mut builder,
                            receipt_label(lang, "Address"),
                            address,
                            width,
                        );
                    } else {
                        emit_pair(&mut builder, receipt_label(lang, "Address"), address, width);
                    }
                }
                if let Some(phone) = doc
                    .customer_phone
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    if style.modern {
                        emit_pair_bold(&mut builder, receipt_label(lang, "Phone"), phone, width);
                    } else {
                        emit_pair(&mut builder, receipt_label(lang, "Phone"), phone, width);
                    }
                }
                if let Some(city) = doc
                    .delivery_city
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if style.modern {
                        emit_pair_bold(&mut builder, receipt_label(lang, "City"), city, width);
                    } else {
                        emit_pair(&mut builder, receipt_label(lang, "City"), city, width);
                    }
                }
                if let Some(postal_code) = doc
                    .delivery_postal_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if style.modern {
                        emit_pair_bold(
                            &mut builder,
                            receipt_label(lang, "Postal Code"),
                            postal_code,
                            width,
                        );
                    } else {
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Postal Code"),
                            postal_code,
                            width,
                        );
                    }
                }
                if let Some(floor) = doc
                    .delivery_floor
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if style.modern {
                        emit_pair_bold(&mut builder, receipt_label(lang, "Floor"), floor, width);
                    } else {
                        emit_pair(&mut builder, receipt_label(lang, "Floor"), floor, width);
                    }
                }
                if let Some(name_on_ringer) = doc
                    .name_on_ringer
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if style.modern {
                        emit_pair_bold(
                            &mut builder,
                            receipt_label(lang, "Name on ringer"),
                            name_on_ringer,
                            width,
                        );
                    } else {
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Name on ringer"),
                            name_on_ringer,
                            width,
                        );
                    }
                }
            }
            let order_notes = order_note_lines(doc);
            for note in &order_notes {
                builder.underline(1);
                emit_wrapped(
                    &mut builder,
                    &format!("{}: {note}", receipt_label(lang, "Note")),
                    width,
                );
                builder.underline(0);
            }
            if !order_notes.is_empty() && !style.modern {
                emit_rule(&mut builder, width, style.profile.block_rule);
            }
            // Section header: modern uses "Order" (ΠΑΡΑΓΓΕΛΙΑ), classic uses "ITEMS" (ΕΙΔΗ)
            let items_label = if style.modern {
                receipt_label(lang, "Order")
            } else {
                receipt_label(lang, "ITEMS")
            };
            emit_section_header(&mut builder, items_label, style, width);
            if doc.items.is_empty() {
                builder.text(receipt_label(lang, "No items")).lf();
            } else {
                for item in &doc.items {
                    if let Some(cat_line) = category_line(lang, item) {
                        builder.bold(true);
                        emit_wrapped(&mut builder, &cat_line, width);
                        builder.bold(false);
                    }
                    let item_price = if style.profile.currency_on_all {
                        money_with_currency_locale(item.total, cur, comma)
                    } else {
                        money_locale(item.total, comma)
                    };
                    let qty_sep = if style.modern { "\u{00D7} " } else { " x " };
                    emit_item_line(
                        &mut builder,
                        &format!("{}{}{}", qty(item.quantity), qty_sep, item.name),
                        &item_price,
                        width,
                        style,
                    );
                    emit_item_customizations_escpos(&mut builder, item, width, lang);
                    if let Some(note) = item
                        .note
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        builder.underline(1);
                        emit_wrapped(
                            &mut builder,
                            &format!("  {}: {note}", receipt_label(lang, "Note")),
                            width,
                        );
                        builder.underline(0);
                    }
                }
            }
            if style.modern {
                // Modern: dash rule before totals (matches HTML <hr>)
                emit_rule(&mut builder, width, '-');
            } else {
                // Classic: rule before totals
                emit_rule(&mut builder, width, style.profile.block_rule);
            }
            for (idx, total) in doc.totals.iter().enumerate() {
                let raw_label = total_label_text(lang, total);
                // Classic: append colon to totals labels (Υποσύνολο: / ΣΥΝΟΛΟ:)
                let label_with_colon;
                let label = if !style.modern {
                    label_with_colon = format!("{}:", raw_label);
                    label_with_colon.as_str()
                } else {
                    raw_label.as_str()
                };
                if total.emphasize {
                    if !style.modern && !classic_customer_layout {
                        // Classic: rule before ΣΥΝΟΛΟ
                        emit_rule(&mut builder, width, style.profile.block_rule);
                    }
                    // Emphasized totals (ΣΥΝΟΛΟ) — bold + large, with currency
                    builder.bold(true);
                    if can_scale_text(style) {
                        if style.modern {
                            builder.double_height();
                        } else {
                            builder.text_size(2, 4);
                        }
                    }
                    emit_pair(
                        &mut builder,
                        label,
                        &money_with_currency_locale(total.amount, cur, comma),
                        width,
                    );
                    if can_scale_text(style) {
                        if style.modern {
                            builder.normal_size();
                        } else {
                            builder.text_size(2, 2);
                        }
                    }
                    builder.bold(false);
                    if !style.modern {
                        if classic_customer_layout {
                            // Classic customer text fallback: single rule after TOTAL.
                            emit_rule(&mut builder, width, style.profile.block_rule);
                        } else {
                            // Classic: rule after ΣΥΝΟΛΟ
                            emit_rule(&mut builder, width, style.profile.block_rule);
                        }
                    }
                    continue;
                }
                // Non-emphasized totals (e.g. Υποσύνολο) never show currency symbol
                let total_amount = money_locale(total.amount, comma);
                emit_pair(&mut builder, label, &total_amount, width);
                if !style.modern {
                    if classic_customer_layout {
                        let next_is_emphasized = doc
                            .totals
                            .get(idx + 1)
                            .map(|line| line.emphasize)
                            .unwrap_or(false);
                        if next_is_emphasized {
                            // Classic customer text fallback: single rule before TOTAL.
                            emit_rule(&mut builder, width, style.profile.block_rule);
                        } else if idx + 1 == doc.totals.len() {
                            emit_rule(&mut builder, width, style.profile.block_rule);
                        }
                    } else {
                        // Legacy classic: rule after each non-emphasized total
                        emit_rule(&mut builder, width, style.profile.block_rule);
                    }
                }
            }
            if style.modern {
                // Modern: dash rule separator before payments
                emit_rule(&mut builder, width, '-');
            }
            let delivery_method_only_payment = method_only_payment_label(doc, lang);
            if let Some(method_label) = delivery_method_only_payment.as_deref() {
                builder
                    .center()
                    .bold(true)
                    .text(method_label)
                    .lf()
                    .bold(false)
                    .left();
            } else {
                if doc.payments.is_empty() {
                    builder
                        .text(receipt_label(lang, "No payment recorded"))
                        .lf();
                } else {
                    for payment in &doc.payments {
                        let raw_pay_label = receipt_label(lang, &payment.label);
                        // Classic: append colon to payment labels (Μετρητά: / Ρέστα:)
                        let pay_label_colon;
                        let label = if !style.modern {
                            pay_label_colon = format!("{}:", raw_pay_label);
                            pay_label_colon.as_str()
                        } else {
                            raw_pay_label
                        };
                        if payment_amount_unknown(payment) {
                            builder
                                .center()
                                .bold(true)
                                .text(label)
                                .lf()
                                .bold(false)
                                .left();
                            continue;
                        }
                        let is_change = payment.label == "Change";
                        if is_change {
                            emit_pair(
                                &mut builder,
                                label,
                                &money_locale(payment.amount, comma),
                                width,
                            );
                        } else {
                            let pay_amount = if style.profile.currency_on_all {
                                money_with_currency_locale(payment.amount, cur, comma)
                            } else {
                                money_locale(payment.amount, comma)
                            };
                            emit_pair(&mut builder, label, &pay_amount, width);
                        }
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
                        &format!("-{}", money_locale(adjustment.amount, comma)),
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
            let display_date = format_datetime_human(&doc.created_at);
            let order_type_display = translate_order_type(lang, &doc.order_type);
            if style.modern {
                builder.center();
                if style.profile.strong_headers {
                    builder.bold(true);
                }
                emit_banner(&mut builder, width, style.profile.block_rule, title);
                builder
                    .text(&format!(
                        "{} #{}",
                        receipt_label(lang, "Order"),
                        doc.order_number
                    ))
                    .lf()
                    .text(&format!(
                        "{}: {}",
                        receipt_label(lang, "Type"),
                        order_type_display
                    ))
                    .lf();
                if style.profile.strong_headers {
                    builder.bold(false);
                }
                builder
                    .text(&format!(
                        "{}: {}",
                        receipt_label(lang, "Date"),
                        display_date
                    ))
                    .lf()
                    .left();
                emit_rule(&mut builder, width, style.profile.block_rule);
            } else {
                builder
                    .center()
                    .bold(true)
                    .text(title)
                    .lf()
                    .bold(false)
                    .left();
                emit_pair_bold(
                    &mut builder,
                    receipt_label(lang, "Order"),
                    &format!("#{}", doc.order_number),
                    width,
                );
                emit_pair_bold(
                    &mut builder,
                    receipt_label(lang, "Type"),
                    &order_type_display,
                    width,
                );
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Date"),
                    &display_date,
                    width,
                );
                emit_rule(&mut builder, width, style.profile.block_rule);
            }
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
                let is_delivery = doc.order_type.trim().eq_ignore_ascii_case("delivery");
                if is_delivery {
                    emit_pair_bold(&mut builder, receipt_label(lang, "Phone"), phone, width);
                } else {
                    emit_pair(&mut builder, receipt_label(lang, "Phone"), phone, width);
                }
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
                    if let Some(cat_line) = category_line(lang, item) {
                        builder.bold(true);
                        emit_wrapped(&mut builder, &cat_line, width);
                        builder.bold(false);
                    }
                    emit_item_text(
                        &mut builder,
                        &format!("{} x {}", qty(item.quantity), item.name),
                        width,
                        style,
                    );
                    emit_item_customizations_escpos(&mut builder, item, width, lang);
                    if let Some(note) = item
                        .note
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        builder.underline(1);
                        emit_wrapped(
                            &mut builder,
                            &format!("  {}: {note}", receipt_label(lang, "Note")),
                            width,
                        );
                        builder.underline(0);
                    }
                }
            }
        }
        ReceiptDocument::DeliverySlip(doc) => {
            let resolved_currency = if classic_customer_layout {
                normalize_currency_symbol_for_layout(
                    &cfg.currency_symbol,
                    &cfg.character_set,
                    cfg.escpos_code_page,
                    cfg.detected_brand,
                )
            } else {
                cfg.currency_symbol.clone()
            };
            let cur = resolved_currency.as_str();
            let display_date = format_datetime_human(&doc.created_at);
            let slip_title = receipt_label(lang, "DELIVERY SLIP");
            let order_type_display = translate_order_type(lang, &doc.order_type);
            if style.modern {
                builder.center();
                if style.profile.strong_headers {
                    builder.bold(true);
                }
                emit_banner(&mut builder, width, style.profile.block_rule, slip_title);
                builder
                    .text(&format!(
                        "{} #{}",
                        receipt_label(lang, "Order"),
                        doc.order_number
                    ))
                    .lf()
                    .text(&format!(
                        "{}: {}",
                        receipt_label(lang, "Type"),
                        order_type_display
                    ))
                    .lf();
                if style.profile.strong_headers {
                    builder.bold(false);
                }
                builder
                    .text(&format!(
                        "{}: {}",
                        receipt_label(lang, "Date"),
                        display_date
                    ))
                    .lf()
                    .left();
                emit_rule(&mut builder, width, style.profile.block_rule);
                for _ in 0..style.profile.focus_spacing_lines {
                    builder.lf();
                }
            } else {
                builder
                    .center()
                    .bold(true)
                    .text(slip_title)
                    .lf()
                    .bold(false)
                    .left();
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Order"),
                    &format!("#{}", doc.order_number),
                    width,
                );
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Type"),
                    &order_type_display,
                    width,
                );
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Date"),
                    &display_date,
                    width,
                );
                emit_rule(&mut builder, width, style.profile.block_rule);
            }
            // Driver/customer/address info (deterministic order + placeholder fallback).
            for (label, value) in delivery_slip_info_lines(doc, lang) {
                emit_pair_bold(&mut builder, &label, &value, width);
            }
            let order_notes = order_note_lines(doc);
            for note in &order_notes {
                builder.underline(1);
                emit_wrapped(
                    &mut builder,
                    &format!("{}: {note}", receipt_label(lang, "Note")),
                    width,
                );
                builder.underline(0);
            }
            if !order_notes.is_empty() {
                emit_rule(&mut builder, width, style.profile.block_rule);
            }
            // Items
            emit_section_header(&mut builder, receipt_label(lang, "ITEMS"), style, width);
            if doc.items.is_empty() {
                builder.text(receipt_label(lang, "No items")).lf();
            } else {
                for item in &doc.items {
                    if let Some(cat_line) = category_line(lang, item) {
                        builder.bold(true);
                        emit_wrapped(&mut builder, &cat_line, width);
                        builder.bold(false);
                    }
                    let price = money_with_currency_locale(item.total, cur, comma);
                    emit_item_line(&mut builder, &item.name, &price, width, style);
                    emit_item_customizations_escpos(&mut builder, item, width, lang);
                    if let Some(note) = item
                        .note
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        builder.underline(1);
                        emit_wrapped(
                            &mut builder,
                            &format!("  {}: {note}", receipt_label(lang, "Note")),
                            width,
                        );
                        builder.underline(0);
                    }
                }
            }
            // Totals
            emit_section_header(&mut builder, receipt_label(lang, "TOTALS"), style, width);
            if style.profile.framed_totals {
                emit_rule(&mut builder, width, style.profile.block_rule);
            }
            for total in &doc.totals {
                let label_text = total_label_text(lang, total);
                let val = money_with_currency_locale(total.amount, cur, comma);
                if total.emphasize {
                    builder.bold(true);
                    emit_pair(&mut builder, &label_text, &val, width);
                    builder.bold(false);
                    if style.profile.framed_totals {
                        emit_rule(&mut builder, width, style.profile.block_rule);
                    }
                } else {
                    emit_pair(&mut builder, &label_text, &val, width);
                }
            }
            let delivery_method_only_payment = method_only_payment_label(doc, lang);
            if delivery_method_only_payment.is_some()
                || !doc.payments.is_empty()
                || doc
                    .masked_card
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
            {
                emit_rule(&mut builder, width, style.profile.block_rule);
            }
            if let Some(method_label) = delivery_method_only_payment.as_deref() {
                builder
                    .center()
                    .bold(true)
                    .text(method_label)
                    .lf()
                    .bold(false)
                    .left();
            } else {
                for payment in &doc.payments {
                    let raw_pay_label = receipt_label(lang, &payment.label);
                    let pay_label_colon;
                    let label = if !style.modern {
                        pay_label_colon = format!("{}:", raw_pay_label);
                        pay_label_colon.as_str()
                    } else {
                        raw_pay_label
                    };
                    if payment_amount_unknown(payment) {
                        builder
                            .center()
                            .bold(true)
                            .text(label)
                            .lf()
                            .bold(false)
                            .left();
                        continue;
                    }
                    let pay_amount = if style.profile.currency_on_all {
                        money_with_currency_locale(payment.amount, cur, comma)
                    } else {
                        money_locale(payment.amount, comma)
                    };
                    emit_pair(&mut builder, label, &pay_amount, width);
                }
                if let Some(masked) = doc
                    .masked_card
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    emit_pair(&mut builder, receipt_label(lang, "Card"), masked, width);
                }
            }
        }
        ReceiptDocument::ShiftCheckout(doc) => {
            builder
                .center()
                .bold(true)
                .text(receipt_label(lang, "SHIFT CHECKOUT"))
                .lf()
                .bold(false)
                .left();
            emit_pair(
                &mut builder,
                receipt_label(lang, "Role"),
                &receipt_role_text(lang, &doc.role_type),
                width,
            );
            emit_pair(
                &mut builder,
                receipt_label(lang, "Staff"),
                &doc.staff_name,
                width,
            );
            if !should_render_minimal_shift_checkout(doc) {
                if let Some(terminal_name) = non_empty_receipt_value(&doc.terminal_name) {
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Terminal"),
                        terminal_name,
                        width,
                    );
                }
            }
            emit_pair(
                &mut builder,
                receipt_label(lang, "Check-in"),
                &format_datetime_human(&doc.check_in),
                width,
            );
            emit_pair(
                &mut builder,
                receipt_label(lang, "Check-out"),
                &format_datetime_human(&doc.check_out),
                width,
            );
            if !should_render_minimal_shift_checkout(doc) {
                if should_render_shift_checkout_driver_summary(doc) {
                    for row in driver_shift_checkout_summary_rows(doc) {
                        if row.emphasize {
                            emit_rule(&mut builder, width, '-');
                            emit_pair_bold(
                                &mut builder,
                                receipt_label(lang, row.label_key),
                                &money_locale(row.amount, comma),
                                width,
                            );
                        } else {
                            emit_pair(
                                &mut builder,
                                receipt_label(lang, row.label_key),
                                &money_locale(row.amount, comma),
                                width,
                            );
                        }
                    }

                    if !doc.driver_deliveries.is_empty() {
                        builder.lf();
                        builder
                            .center()
                            .bold(true)
                            .text(receipt_label(lang, "DELIVERIES"))
                            .lf()
                            .bold(false)
                            .left();
                        emit_rule(&mut builder, width, '-');
                        for d in &doc.driver_deliveries {
                            let label = format!("#{} {}", d.order_number, d.payment_method);
                            emit_pair(
                                &mut builder,
                                &label,
                                &money_locale(d.total_amount, comma),
                                width,
                            );
                        }
                        emit_rule(&mut builder, width, '-');
                    }
                } else if should_render_shift_checkout_cashier_summary(doc) {
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Orders"),
                        &doc.orders_count.to_string(),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Sales"),
                        &money_locale(doc.sales_amount, comma),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Cash Sales"),
                        &money_locale(doc.cash_sales, comma),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Card Sales"),
                        &money_locale(doc.card_sales, comma),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Opening"),
                        &money_locale(doc.opening_amount, comma),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Refunds"),
                        &format!("-{}", money_locale(doc.cash_refunds, comma)),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Expenses"),
                        &format!("-{}", money_locale(doc.total_expenses, comma)),
                        width,
                    );
                    if doc.cash_drops > 0.0 {
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Cash Drops"),
                            &format!("-{}", money_locale(doc.cash_drops, comma)),
                            width,
                        );
                    }
                    if doc.driver_cash_given > 0.0 {
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Driver Given"),
                            &format!("-{}", money_locale(doc.driver_cash_given, comma)),
                            width,
                        );
                    }
                    if doc.driver_cash_returned > 0.0 {
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Driver Returned"),
                            &format!("+{}", money_locale(doc.driver_cash_returned, comma)),
                            width,
                        );
                    }
                    if doc.transferred_staff_count > 0 {
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Transferred Staff"),
                            &doc.transferred_staff_count.to_string(),
                            width,
                        );
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Transferred Staff Returns"),
                            &format!("+{}", money_locale(doc.transferred_staff_returns, comma)),
                            width,
                        );
                    }
                    if doc.staff_payouts_total > 0.0 {
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Staff Payouts"),
                            &format!("-{}", money_locale(doc.staff_payouts_total, comma)),
                            width,
                        );
                    }
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Expected"),
                        &doc.expected_amount
                            .map(|v| money_locale(v, comma))
                            .unwrap_or_else(|| "N/A".to_string()),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Counted Cash"),
                        &doc.closing_amount
                            .map(|v| money_locale(v, comma))
                            .unwrap_or_else(|| "N/A".to_string()),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Variance"),
                        &doc.variance_amount
                            .map(|v| money_locale(v, comma))
                            .unwrap_or_else(|| "N/A".to_string()),
                        width,
                    );
                    if let Some(expected) = doc.expected_amount {
                        emit_rule(&mut builder, width, '-');
                        emit_pair_bold(
                            &mut builder,
                            receipt_label(lang, "Expected In Drawer"),
                            &money_locale(expected, comma),
                            width,
                        );
                    }
                    if !doc.staff_payout_lines.is_empty() {
                        emit_rule(&mut builder, width, '-');
                        builder
                            .bold(true)
                            .text(receipt_label(lang, "STAFF PAYOUTS"))
                            .lf()
                            .bold(false);
                        for payout in &doc.staff_payout_lines {
                            let role_label = receipt_role_text(lang, &payout.role_type);
                            let label = format!("{} ({})", payout.staff_name, role_label);
                            emit_pair(
                                &mut builder,
                                &label,
                                &format!("-{}", money_locale(payout.amount, comma)),
                                width,
                            );
                        }
                    }
                } else {
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Orders"),
                        &doc.orders_count.to_string(),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Sales"),
                        &money_locale(doc.sales_amount, comma),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Expenses"),
                        &money_locale(doc.total_expenses, comma),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Refunds"),
                        &money_locale(doc.cash_refunds, comma),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Opening"),
                        &money_locale(doc.opening_amount, comma),
                        width,
                    );
                    if doc.transferred_staff_count > 0 {
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Transferred Staff"),
                            &doc.transferred_staff_count.to_string(),
                            width,
                        );
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Transferred Staff Returns"),
                            &format!("+{}", money_locale(doc.transferred_staff_returns, comma)),
                            width,
                        );
                    }
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Expected"),
                        &doc.expected_amount
                            .map(|v| money_locale(v, comma))
                            .unwrap_or_else(|| "N/A".to_string()),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Closing"),
                        &doc.closing_amount
                            .map(|v| money_locale(v, comma))
                            .unwrap_or_else(|| "N/A".to_string()),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Variance"),
                        &doc.variance_amount
                            .map(|v| money_locale(v, comma))
                            .unwrap_or_else(|| "N/A".to_string()),
                        width,
                    );
                    if let Some(expected) = doc.expected_amount {
                        emit_rule(&mut builder, width, '-');
                        emit_pair_bold(
                            &mut builder,
                            receipt_label(lang, "Expected In Drawer"),
                            &money_locale(expected, comma),
                            width,
                        );
                    }
                }
            }
        }
        ReceiptDocument::ZReport(doc) => {
            builder
                .center()
                .bold(true)
                .text(receipt_label(lang, "Z REPORT"))
                .lf()
                .bold(false)
                .left();
            emit_pair(
                &mut builder,
                receipt_label(lang, "Date"),
                &doc.report_date,
                width,
            );
            emit_pair(
                &mut builder,
                receipt_label(lang, "Generated"),
                &doc.generated_at,
                width,
            );
            if let Some((label, value)) = z_report_shift_line(doc, lang) {
                emit_pair(&mut builder, &label, &value, width);
            }
            if let Some(terminal_name) = non_empty_receipt_value(&doc.terminal_name) {
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Terminal"),
                    terminal_name,
                    width,
                );
            }
            emit_rule(&mut builder, width, '-');

            // --- Sales summary ---
            builder
                .bold(true)
                .text(receipt_label(lang, "SALES"))
                .lf()
                .bold(false);
            emit_pair(
                &mut builder,
                receipt_label(lang, "Orders"),
                &doc.total_orders.to_string(),
                width,
            );
            emit_pair(
                &mut builder,
                receipt_label(lang, "Gross"),
                &money_locale(doc.gross_sales, comma),
                width,
            );
            emit_pair(
                &mut builder,
                receipt_label(lang, "Discounts"),
                &format!("-{}", money_locale(doc.discounts_total, comma)),
                width,
            );
            emit_pair(
                &mut builder,
                receipt_label(lang, "Net"),
                &money_locale(doc.net_sales, comma),
                width,
            );
            if doc.tips_total > 0.0 {
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Tips"),
                    &money_locale(doc.tips_total, comma),
                    width,
                );
            }
            if doc.refunds_total > 0.0 {
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Refunds"),
                    &format!("-{}", money_locale(doc.refunds_total, comma)),
                    width,
                );
            }
            if doc.voids_total > 0.0 {
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Voids"),
                    &format!("-{}", money_locale(doc.voids_total, comma)),
                    width,
                );
            }
            emit_rule(&mut builder, width, '-');

            // --- Order breakdown ---
            let has_breakdown =
                doc.dine_in_orders > 0 || doc.takeaway_orders > 0 || doc.delivery_orders > 0;
            if has_breakdown {
                builder
                    .bold(true)
                    .text(receipt_label(lang, "ORDER BREAKDOWN"))
                    .lf()
                    .bold(false);
                if doc.dine_in_orders > 0 {
                    emit_pair(
                        &mut builder,
                        &format!(
                            "{} ({})",
                            receipt_label(lang, "Dine-in"),
                            doc.dine_in_orders
                        ),
                        &money_locale(doc.dine_in_sales, comma),
                        width,
                    );
                }
                if doc.takeaway_orders > 0 {
                    emit_pair(
                        &mut builder,
                        &format!(
                            "{} ({})",
                            receipt_label(lang, "Takeaway"),
                            doc.takeaway_orders
                        ),
                        &money_locale(doc.takeaway_sales, comma),
                        width,
                    );
                }
                if doc.delivery_orders > 0 {
                    emit_pair(
                        &mut builder,
                        &format!(
                            "{} ({})",
                            receipt_label(lang, "Delivery"),
                            doc.delivery_orders
                        ),
                        &money_locale(doc.delivery_sales, comma),
                        width,
                    );
                }
                emit_rule(&mut builder, width, '-');
            }

            // --- Cash drawer ---
            let has_drawer =
                doc.opening_cash > 0.0 || doc.closing_cash > 0.0 || doc.expected_cash > 0.0;
            if has_drawer {
                builder
                    .bold(true)
                    .text(receipt_label(lang, "CASH DRAWER"))
                    .lf()
                    .bold(false);
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Opening"),
                    &money_locale(doc.opening_cash, comma),
                    width,
                );
                if doc.expenses_total > 0.0 {
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Expenses"),
                        &format!("-{}", money_locale(doc.expenses_total, comma)),
                        width,
                    );
                }
                if doc.cash_drops > 0.0 {
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Cash Drops"),
                        &format!("-{}", money_locale(doc.cash_drops, comma)),
                        width,
                    );
                }
                if doc.driver_cash_given > 0.0 {
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Driver Given"),
                        &format!("-{}", money_locale(doc.driver_cash_given, comma)),
                        width,
                    );
                }
                if doc.driver_cash_returned > 0.0 {
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Driver Returned"),
                        &format!("+{}", money_locale(doc.driver_cash_returned, comma)),
                        width,
                    );
                }
                if doc.staff_payments_total > 0.0 {
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Staff Payouts*"),
                        &format!("-{}", money_locale(doc.staff_payments_total, comma)),
                        width,
                    );
                }
                emit_rule(&mut builder, width, '-');
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Expected"),
                    &money_locale(doc.expected_cash, comma),
                    width,
                );
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Closing"),
                    &money_locale(doc.closing_cash, comma),
                    width,
                );
                builder.bold(true);
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Variance"),
                    &money_locale(doc.cash_variance, comma),
                    width,
                );
                builder.bold(false);
                if doc.staff_payments_total > 0.0 {
                    builder
                        .text(&format!("* {}", receipt_label(lang, "Informational only")))
                        .lf();
                }
            } else {
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Expenses"),
                    &format!("-{}", money_locale(doc.expenses_total, comma)),
                    width,
                );
                emit_pair(
                    &mut builder,
                    receipt_label(lang, "Variance"),
                    &money_locale(doc.cash_variance, comma),
                    width,
                );
            }

            // --- Staff details ---
            if !doc.staff_reports.is_empty() {
                emit_rule(&mut builder, width, '-');
                builder
                    .bold(true)
                    .text(receipt_label(lang, "STAFF"))
                    .lf()
                    .bold(false);
                for staff in &doc.staff_reports {
                    let role_label = match staff.role.as_str() {
                        "driver" => receipt_label(lang, "Driver"),
                        "cashier" => receipt_label(lang, "Cashier"),
                        _ => &staff.role,
                    };
                    builder
                        .bold(true)
                        .text(&format!("{} ({})", staff.name, role_label))
                        .lf()
                        .bold(false);
                    // Time range + staff payment on one line
                    let ci_display = staff
                        .check_in
                        .as_deref()
                        .and_then(|v| v.get(11..16))
                        .unwrap_or("--:--");
                    let co_display = staff
                        .check_out
                        .as_deref()
                        .and_then(|v| v.get(11..16))
                        .unwrap_or("--:--");
                    let time_range = format!("{}-{}", ci_display, co_display);
                    if staff.staff_payment > 0.0 {
                        emit_pair(
                            &mut builder,
                            &format!("{} {}", time_range, receipt_label(lang, "Payout")),
                            &money_locale(staff.staff_payment, comma),
                            width,
                        );
                    } else {
                        builder.text(&format!("  {}", time_range)).lf();
                    }
                    if staff.opening_cash > 0.0 {
                        emit_pair(
                            &mut builder,
                            receipt_label(lang, "Starting"),
                            &money_locale(staff.opening_cash, comma),
                            width,
                        );
                    }
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Orders"),
                        &staff.order_count.to_string(),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Cash"),
                        &money_locale(staff.cash_amount, comma),
                        width,
                    );
                    emit_pair(
                        &mut builder,
                        receipt_label(lang, "Card"),
                        &money_locale(staff.card_amount, comma),
                        width,
                    );
                }
            }

            // --- Daily totals ---
            emit_rule(&mut builder, width, '=');
            builder
                .bold(true)
                .text(receipt_label(lang, "TOTAL"))
                .lf()
                .bold(false);
            emit_pair(
                &mut builder,
                receipt_label(lang, "Orders"),
                &doc.total_orders.to_string(),
                width,
            );
            emit_pair(
                &mut builder,
                receipt_label(lang, "Cash"),
                &money_locale(doc.cash_sales, comma),
                width,
            );
            emit_pair(
                &mut builder,
                receipt_label(lang, "Card"),
                &money_locale(doc.card_sales, comma),
                width,
            );
            builder.bold(true);
            emit_pair(
                &mut builder,
                receipt_label(lang, "Net"),
                &money_locale(doc.net_sales, comma),
                width,
            );
            builder.bold(false);

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
        builder.center();
        if style.modern {
            // Modern: spaced star separator + footer + closing star separator
            let star_line: String = "* ".repeat(width / 2).trim_end().to_string();
            builder.text(&star_line).lf();
            let translated = receipt_label(lang, footer);
            emit_wrapped(&mut builder, translated, width);
            builder.text(&star_line).lf();
        } else {
            // Classic: dense asterisks + footer text (no sub-footer)
            // Map generic "Thank you" to the longer "Thank you preference" for Classic
            let footer_key = if footer == "Thank you" {
                "Thank you preference"
            } else {
                footer
            };
            let translated = receipt_label(lang, footer_key);
            if classic_customer_layout {
                // Classic receipt v2.1: short top stars + long bottom stars.
                let top_star_line = "*".repeat(14);
                let bottom_star_line = "*".repeat(width.max(8));
                emit_rule(&mut builder, width, style.profile.block_rule);
                builder.lf();
                builder.center().text(&top_star_line).lf();
                emit_centered_wrapped(&mut builder, translated, width);
                builder.left().text(&bottom_star_line).lf();
            } else {
                builder.lf().lf();
                let star_line = "*".repeat(14);
                builder.text(&star_line).lf();
                emit_wrapped(&mut builder, translated, width);
            }
        }
        builder.left();
    }
    if use_star_commands {
        // Star Line Mode: LF feed + ESC d 1 partial cut.
        // Star does not recognize GS V A and prints literal "VA" text.
        builder.lf().lf().lf().lf().star_cut();
    } else {
        builder.feed(4).cut();
    }

    EscPosRender {
        bytes: builder.build(),
        warnings,
        body_mode: EscPosBodyMode::Text,
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

    fn sample_driver_shift_checkout_doc() -> ShiftCheckoutDoc {
        ShiftCheckoutDoc {
            shift_id: "SHIFT-DRIVER-001".to_string(),
            role_type: "driver".to_string(),
            staff_name: "Driver One".to_string(),
            terminal_name: "Front".to_string(),
            check_in: "2026-03-05T08:00:00Z".to_string(),
            check_out: "2026-03-05T16:00:00Z".to_string(),
            orders_count: 4,
            sales_amount: 42.5,
            total_expenses: 3.0,
            cash_refunds: 0.0,
            opening_amount: 25.0,
            expected_amount: Some(40.0),
            closing_amount: Some(38.0),
            variance_amount: Some(-2.0),
            total_cash_collected: 18.0,
            total_card_collected: 12.5,
            total_delivery_fees: 4.0,
            total_tips: 2.0,
            amount_to_return: 40.0,
            total_sells: 30.5,
            cancelled_or_refunded_total: 5.5,
            cancelled_or_refunded_count: 1,
            ..ShiftCheckoutDoc::default()
        }
    }

    #[test]
    fn format_datetime_human_converts_rfc3339_timestamps_to_local_time() {
        let iso = "2026-03-05T16:00:00Z";
        let actual = format_datetime_human(iso);
        let parsed = chrono::DateTime::parse_from_rfc3339(iso).expect("parse rfc3339");
        let expected_local = parsed
            .with_timezone(&chrono::Local)
            .format("%d/%m/%Y %H:%M")
            .to_string();
        let raw_utc = parsed.format("%d/%m/%Y %H:%M").to_string();

        assert_eq!(actual, expected_local);
        if expected_local != raw_utc {
            assert_ne!(actual, raw_utc);
        }
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
    fn text_render_uses_star_commands_when_star_line_emulation_is_forced() {
        let cfg = LayoutConfig {
            character_set: "PC737_GREEK".to_string(),
            emulation_mode: ReceiptEmulationMode::StarLine,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-2".to_string(),
            order_type: "dine-in".to_string(),
            created_at: "2026-02-24".to_string(),
            ..OrderReceiptDoc::default()
        });
        let out = render_escpos(&doc, &cfg);

        assert!(out.bytes.windows(4).any(|w| w == [0x1B, 0x1D, 0x74, 15]));
        assert!(out.bytes.windows(3).any(|w| w == [0x1B, 0x64, 0x01]));
        assert!(!out.bytes.windows(4).any(|w| w == [0x1D, 0x56, 0x41, 0x10]));
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
                discount_percent: None,
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
    fn delivery_block_renders_for_delivery_orders_even_before_final_status() {
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
        assert!(text.contains("Driver"));
        assert!(text.contains("Nikos Driver"));
        assert!(text.contains("Main St 12"));
    }

    #[test]
    fn delivery_block_renders_address_when_driver_name_missing() {
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
        assert!(!text.contains("Driver"));
        assert!(text.contains("Main St 12"));
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
    fn classic_receipt_header_includes_branch_then_left_address_phone_vat_sequence() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
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
        let branch_pos = text.find("Downtown Branch").unwrap_or(usize::MAX);
        let address_pos = text.find("Main St 10").unwrap_or(usize::MAX);
        let phone_pos = text.find("2100000000").unwrap_or(usize::MAX);
        let vat_pos = text.find("VAT: 123456789").unwrap_or(usize::MAX);

        assert!(branch_pos < address_pos);
        assert!(address_pos < phone_pos);
        assert!(phone_pos < vat_pos);
        assert!(text.contains("Downtown Branch"));
        assert!(text.contains("Phone: 2100000000"));
        assert!(text.contains("VAT: 123456789"));
        assert!(text.contains("TAX_OFFICE: DOY ATHENS"));
        assert!(!text.contains("Brand Co"));

        // Modern template skips store name in HEADER (it appears in footer)
        let modern_cfg = LayoutConfig {
            template: ReceiptTemplate::Modern,
            organization_name: "Brand Co".to_string(),
            store_subtitle: Some("Downtown Branch".to_string()),
            store_address: Some("Main St 10".to_string()),
            ..LayoutConfig::default()
        };
        let modern_out = render_escpos(&doc, &modern_cfg);
        let modern_text = String::from_utf8_lossy(&modern_out.bytes);
        // Store name should NOT appear before the address (i.e. not in header)
        let addr_pos = modern_text.find("Main St 10").unwrap();
        assert!(!modern_text[..addr_pos].contains("Brand Co"));
        assert!(!modern_text[..addr_pos].contains("Downtown Branch"));
    }

    #[test]
    fn classic_receipt_header_has_three_rules_when_address_present() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            store_address: Some("Main St 10".to_string()),
            store_phone: Some("2100000000".to_string()),
            vat_number: Some("123456789".to_string()),
            tax_office: Some("DOY ATHENS".to_string()),
            footer_text: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-81A".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24".to_string(),
            ..OrderReceiptDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        let text = String::from_utf8_lossy(&out.bytes);
        let rule_str = "-".repeat(cfg.paper_width.chars() / 2);
        let rules = count_text(&text, &rule_str);
        assert!(rules >= 3, "expected at least 3 rules, got {rules}");
    }

    #[test]
    fn classic_receipt_header_splits_address_by_comma_newline_and_pipe() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            store_address: Some(
                "KONSTANTINOUPOLEOS 62\nTHESSALONIKI | CENTER, TK 54622".to_string(),
            ),
            footer_text: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "ORD-20260303-00019".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24".to_string(),
            ..OrderReceiptDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        let text = String::from_utf8_lossy(&out.bytes);
        assert!(text.contains("KONSTANTINOUPOLEOS 62"));
        assert!(text.contains("THESSALONIKI"));
        assert!(text.contains("CENTER"));
        assert!(text.contains("TK 54622"));
        assert!(!text.contains("THESSALONIKI | CENTER"));
    }

    #[test]
    fn classic_receipt_has_no_extra_rule_or_gap_before_order_banner() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            store_address: Some("Main St 10, Thessaloniki".to_string()),
            store_phone: Some("2100000000".to_string()),
            vat_number: Some("123456789".to_string()),
            tax_office: Some("DOY ATHENS".to_string()),
            footer_text: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "ORD-20260303-00019".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24".to_string(),
            ..OrderReceiptDoc::default()
        });

        let out = render_escpos(&doc, &cfg);
        let text = String::from_utf8_lossy(&out.bytes);
        let banner_pos = text.find("#00019").unwrap_or(usize::MAX);
        assert!(banner_pos != usize::MAX, "banner text not found");

        let prefix = &text[..banner_pos];
        let rule = "-".repeat(cfg.paper_width.chars() / 2);
        assert_eq!(
            count_text(prefix, &rule),
            3,
            "expected only header rules before banner"
        );

        let last_rule_pos = prefix.rfind(&rule).unwrap_or(usize::MAX);
        assert!(last_rule_pos != usize::MAX, "last header rule not found");
        let between = &prefix[last_rule_pos + rule.len()..];
        let lf_count = between.as_bytes().iter().filter(|&&b| b == b'\n').count();
        assert_eq!(
            lf_count, 1,
            "unexpected blank line between header and banner"
        );
    }

    #[test]
    fn classic_receipt_has_single_rule_between_subtotal_and_total() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            footer_text: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-81B".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24".to_string(),
            totals: vec![
                TotalsLine {
                    label: "Subtotal".to_string(),
                    amount: 9.2,
                    emphasize: false,
                    discount_percent: None,
                },
                TotalsLine {
                    label: "TOTAL".to_string(),
                    amount: 9.2,
                    emphasize: true,
                    discount_percent: None,
                },
            ],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 9.2,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });

        let out = render_escpos(&doc, &cfg);
        let text = String::from_utf8_lossy(&out.bytes);
        let subtotal_pos = text.find("Subtotal:").unwrap_or(usize::MAX);
        let total_pos = text.find("TOTAL:").unwrap_or(usize::MAX);
        assert!(subtotal_pos < total_pos);
        let between = &text[subtotal_pos..total_pos];
        assert!(!between.contains("\n\n\n"), "unexpected extra gap");
        let rule_str = "-".repeat(cfg.paper_width.chars() / 2);
        let between_rules = between.matches(&rule_str).count();
        assert_eq!(between_rules, 1, "expected single rule before TOTAL");
    }

    #[test]
    fn classic_receipt_footer_prints_separator_above_and_below() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            footer_text: Some("Thank you".to_string()),
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-81C".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24".to_string(),
            ..OrderReceiptDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        let text = String::from_utf8_lossy(&out.bytes);
        let eff_width = cfg.paper_width.chars() / 2;
        let short_star = "*".repeat(14);
        let long_star = "*".repeat(eff_width);
        let short_line = format!("{short_star}\n");
        let long_line = format!("{long_star}\n");
        let short_pos = text.find(&short_line).unwrap_or(usize::MAX);
        let long_pos = text.rfind(&long_line).unwrap_or(usize::MAX);
        assert!(short_pos != usize::MAX, "short top star line missing");
        assert!(long_pos != usize::MAX, "long bottom star line missing");
        assert!(
            short_pos < long_pos,
            "expected top short stars before bottom long stars"
        );
        let top_rule = "-".repeat(eff_width);
        let top_rule_pos = text.find(&top_rule).unwrap_or(usize::MAX);
        assert!(
            top_rule_pos < short_pos,
            "expected dashed separator before footer stars"
        );
    }

    #[test]
    fn classic_receipt_honors_requested_font_type_for_customer_receipts() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            font_type: FontType::B,
            footer_text: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "ORD-FONT-00019".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24".to_string(),
            ..OrderReceiptDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        assert!(count_sequence(&out.bytes, &[0x1B, 0x4D, 0x01]) >= 1);
    }

    #[test]
    fn classic_receipt_spacious_density_emits_more_blank_line_groups_than_compact() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-92D".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:00:00Z".to_string(),
            items: vec![ReceiptItem {
                name: "Waffle".to_string(),
                quantity: 1.0,
                total: 9.2,
                ..ReceiptItem::default()
            }],
            totals: vec![TotalsLine {
                label: "TOTAL".to_string(),
                amount: 9.2,
                emphasize: true,
                discount_percent: None,
            }],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 9.2,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });

        let compact = LayoutConfig {
            template: ReceiptTemplate::Classic,
            command_profile: CommandProfile::SafeText,
            layout_density: LayoutDensity::Compact,
            ..LayoutConfig::default()
        };
        let spacious = LayoutConfig {
            template: ReceiptTemplate::Classic,
            command_profile: CommandProfile::SafeText,
            layout_density: LayoutDensity::Spacious,
            ..LayoutConfig::default()
        };

        let compact_text =
            String::from_utf8_lossy(&render_escpos(&doc, &compact).bytes).to_string();
        let spacious_text =
            String::from_utf8_lossy(&render_escpos(&doc, &spacious).bytes).to_string();

        assert!(count_text(&compact_text, "\n\n") <= count_text(&spacious_text, "\n\n"));
    }

    #[test]
    fn classic_receipt_normal_header_emphasis_reduces_bold_section_headers() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-92E".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:00:00Z".to_string(),
            items: vec![ReceiptItem {
                name: "Waffle".to_string(),
                quantity: 1.0,
                total: 9.2,
                ..ReceiptItem::default()
            }],
            totals: vec![TotalsLine {
                label: "TOTAL".to_string(),
                amount: 9.2,
                emphasize: true,
                discount_percent: None,
            }],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 9.2,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });

        let strong = LayoutConfig {
            template: ReceiptTemplate::Classic,
            header_emphasis: HeaderEmphasis::Strong,
            ..LayoutConfig::default()
        };
        let normal = LayoutConfig {
            template: ReceiptTemplate::Classic,
            header_emphasis: HeaderEmphasis::Normal,
            ..LayoutConfig::default()
        };

        let strong_out = render_escpos(&doc, &strong);
        let normal_out = render_escpos(&doc, &normal);

        assert!(
            count_sequence(&strong_out.bytes, &[0x1B, 0x45, 0x01])
                > count_sequence(&normal_out.bytes, &[0x1B, 0x45, 0x01])
        );
    }

    #[test]
    fn euro_symbol_kept_for_supported_layout_combo() {
        let symbol = normalize_currency_symbol_for_layout(
            " \u{20AC}",
            "PC737_GREEK",
            Some(15),
            crate::printers::PrinterBrand::Star,
        );
        assert_eq!(symbol, " \u{20AC}");
    }

    #[test]
    fn euro_symbol_falls_back_to_ascii_for_unsupported_layout_combo() {
        let symbol = normalize_currency_symbol_for_layout(
            " \u{20AC}",
            "CP66_GREEK",
            Some(66),
            crate::printers::PrinterBrand::Unknown,
        );
        assert_eq!(symbol, " EUR");
    }

    #[test]
    fn raster_exact_ttf_embedded_fonts_cover_greek_accented_text() {
        let fonts = RasterFonts::load().expect("embedded Noto Serif fonts must load");
        assert_eq!(
            fonts.missing_glyphs(
                "\u{03A4}\u{03CD}\u{03C0}\u{03BF}\u{03C2}",
                RasterTextWeight::Regular
            ),
            0
        );
        assert_eq!(
            fonts.missing_glyphs(
                "\u{0395}\u{03C5}\u{03C7}\u{03B1}\u{03C1}\u{03B9}\u{03C3}\u{03C4}\u{03BF}\u{03CD}\u{03BC}\u{03B5} \u{03B3}\u{03B9}\u{03B1} \u{03C4}\u{03B7}\u{03BD} \u{03C0}\u{03C1}\u{03BF}\u{03C4}\u{03AF}\u{03BC}\u{03B7}\u{03C3}\u{03B7}!",
                RasterTextWeight::Regular,
            ),
            0
        );
    }

    #[test]
    fn raster_exact_preset_uses_larger_total_text_than_body() {
        let preset = raster_exact_preset_for_paper(PaperWidth::Mm80);
        assert!(preset.item_style.size_px >= 24.0);
        assert!(preset.total_style.size_px > preset.item_style.size_px);
        assert!(preset.top_inset >= 16);
    }

    #[test]
    fn raster_exact_large_readability_scales_text_up() {
        let normal_cfg = LayoutConfig {
            paper_width: PaperWidth::Mm80,
            ..LayoutConfig::default()
        };
        let large_cfg = LayoutConfig {
            paper_width: PaperWidth::Mm80,
            font_type: FontType::A,
            layout_density: LayoutDensity::Balanced,
            header_emphasis: HeaderEmphasis::Strong,
            ..LayoutConfig::default()
        };
        let normal = raster_exact_preset_for_layout(&normal_cfg);
        let large = raster_exact_preset_for_layout(&large_cfg);
        assert!(large.item_style.size_px > normal.item_style.size_px);
        assert!(large.total_style.size_px > normal.total_style.size_px);
    }

    #[test]
    fn total_label_text_includes_discount_percentage() {
        let line = TotalsLine {
            label: "Discount".to_string(),
            amount: -1.4,
            emphasize: false,
            discount_percent: Some(10.0),
        };
        assert_eq!(total_label_text("en", &line), "Discount (10%)");
        assert_eq!(total_label_text("el", &line), "Έκπτωση (10%)");
    }

    #[test]
    fn customization_display_localizes_little_suffix() {
        let line = ReceiptCustomizationLine {
            name: "Merenda".to_string(),
            quantity: 1.0,
            is_without: false,
            is_little: true,
            price: None,
        };
        assert!(customization_display("en", &line, false).contains("(Little)"));
        assert!(customization_display("el", &line, false).contains("(Λίγο)"));
    }

    #[test]
    fn classic_customer_raster_exact_returns_raster_body_mode() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            footer_text: Some("Thank you".to_string()),
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "ORD-20260303-00019".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:27:00Z".to_string(),
            items: vec![ReceiptItem {
                name: "Waffle".to_string(),
                quantity: 1.0,
                total: 9.2,
                ..ReceiptItem::default()
            }],
            totals: vec![
                TotalsLine {
                    label: "Subtotal".to_string(),
                    amount: 9.2,
                    emphasize: false,
                    discount_percent: None,
                },
                TotalsLine {
                    label: "TOTAL".to_string(),
                    amount: 9.2,
                    emphasize: true,
                    discount_percent: None,
                },
            ],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 10.0,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        assert_eq!(out.body_mode, EscPosBodyMode::RasterExact);
        assert!(count_sequence(&out.bytes, &[0x1D, b'v', b'0']) >= 1);
    }

    #[test]
    fn classic_customer_raster_exact_uses_star_raster_when_star_line_mode() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            emulation_mode: ReceiptEmulationMode::StarLine,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "ORD-STAR-00019".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:27:00Z".to_string(),
            ..OrderReceiptDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        assert_eq!(out.body_mode, EscPosBodyMode::RasterExact);
        // Star printers must use Star raster (ESC * r A), not GS v 0.
        assert!(
            count_sequence(&out.bytes, &[0x1B, b'*', b'r', b'A']) >= 1,
            "expected Star raster mode (ESC * r A) for Star Line Mode"
        );
        assert_eq!(
            count_sequence(&out.bytes, &[0x1D, b'v', b'0', 0x00]),
            0,
            "GS v 0 should not be used for Star printers"
        );
    }

    #[test]
    fn classic_shift_checkout_raster_exact_returns_raster_body_mode() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
            shift_id: "SHIFT-001".to_string(),
            role_type: "cashier".to_string(),
            staff_name: "Test Staff".to_string(),
            terminal_name: "Front".to_string(),
            check_in: "2026-03-05T08:00:00Z".to_string(),
            check_out: "2026-03-05T16:00:00Z".to_string(),
            orders_count: 12,
            sales_amount: 120.5,
            total_expenses: 8.0,
            cash_refunds: 1.5,
            opening_amount: 50.0,
            expected_amount: Some(161.0),
            closing_amount: Some(160.0),
            variance_amount: Some(-1.0),
            ..ShiftCheckoutDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        assert_eq!(out.body_mode, EscPosBodyMode::RasterExact);
        assert!(count_sequence(&out.bytes, &[0x1D, b'v', b'0']) >= 1);
    }

    #[test]
    fn classic_shift_checkout_raster_exact_expands_for_driver_delivery_rows() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            ..LayoutConfig::default()
        };
        let base_driver_doc = ReceiptDocument::ShiftCheckout(sample_driver_shift_checkout_doc());
        let deliveries_driver_doc = ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
            driver_deliveries: vec![DriverDeliveryLine {
                order_number: "00077".to_string(),
                total_amount: 24.0,
                payment_method: "cash".to_string(),
                cash_collected: 24.0,
                delivery_fee: 0.0,
                tip_amount: 0.0,
                status: "completed".to_string(),
            }],
            ..sample_driver_shift_checkout_doc()
        });

        let driver_out = render_escpos(&deliveries_driver_doc, &cfg);
        let base_image = render_classic_non_customer_raster_exact_ttf(&base_driver_doc, &cfg)
            .expect("render base driver raster image");
        let deliveries_image =
            render_classic_non_customer_raster_exact_ttf(&deliveries_driver_doc, &cfg)
                .expect("render driver raster image with deliveries");

        assert_eq!(driver_out.body_mode, EscPosBodyMode::RasterExact);
        assert!(
            deliveries_image.height() > base_image.height(),
            "driver raster receipt should grow when delivery rows are rendered"
        );
    }

    #[test]
    fn classic_z_report_raster_exact_returns_raster_body_mode() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::ZReport(ZReportDoc {
            report_id: "ZR-1".to_string(),
            report_date: "2026-03-05".to_string(),
            generated_at: "2026-03-05T23:59:00Z".to_string(),
            shift_ref: "SHIFT-001".to_string(),
            terminal_name: "Front".to_string(),
            total_orders: 120,
            gross_sales: 980.0,
            net_sales: 880.0,
            cash_sales: 500.0,
            card_sales: 380.0,
            refunds_total: 10.0,
            voids_total: 4.0,
            discounts_total: 6.0,
            expenses_total: 15.0,
            cash_variance: -1.0,
            ..ZReportDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        assert_eq!(out.body_mode, EscPosBodyMode::RasterExact);
        assert!(count_sequence(&out.bytes, &[0x1D, b'v', b'0']) >= 1);
    }

    #[test]
    fn classic_kitchen_ticket_raster_exact_returns_raster_body_mode() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::KitchenTicket(KitchenTicketDoc {
            order_number: "KT-RASTER-19".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:27:00Z".to_string(),
            ..KitchenTicketDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        assert_eq!(out.body_mode, EscPosBodyMode::RasterExact);
    }

    #[test]
    fn escpos_raster_exact_chunks_tall_images_into_multiple_gs_v0_commands() {
        let cfg = LayoutConfig {
            emulation_mode: ReceiptEmulationMode::Escpos,
            paper_width: PaperWidth::Mm80,
            ..LayoutConfig::default()
        };
        let image = GrayImage::from_pixel(576, 500, Luma([255]));
        let bytes = raster_image_to_escpos_bytes(&image, &cfg);

        assert!(
            count_sequence(&bytes, &[0x1D, b'v', b'0']) >= 3,
            "expected tall ESC/POS raster to be chunked into multiple GS v 0 commands"
        );
    }

    #[test]
    fn delivery_slip_header_dedupes_branch_when_same_as_brand() {
        // Classic template shows org name in header; subtitle is deduped if same
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            organization_name: "Same Name".to_string(),
            store_subtitle: Some("Same Name".to_string()),
            footer_text: None, // exclude footer to isolate header dedup test
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
    fn delivery_slip_info_lines_delivery_order_starts_with_driver_dash_fallback() {
        let doc = OrderReceiptDoc {
            delivery_slip_mode: DeliverySlipMode::DeliveryOrder,
            ..OrderReceiptDoc::default()
        };
        let lines = delivery_slip_info_lines(&doc, "en");
        assert_eq!(lines.first().map(|(k, _)| k.as_str()), Some("Driver"));
        assert_eq!(lines.first().map(|(_, v)| v.as_str()), Some("-"));
        assert!(lines.iter().all(|(label, _)| label != "Driver ID"));
    }

    #[test]
    fn delivery_slip_info_lines_assign_driver_starts_with_driver_name() {
        let doc = OrderReceiptDoc {
            delivery_slip_mode: DeliverySlipMode::AssignDriver,
            driver_id: Some("DRV-42".to_string()),
            driver_name: Some("Nikos Driver".to_string()),
            customer_name: Some("Customer A".to_string()),
            ..OrderReceiptDoc::default()
        };
        let lines = delivery_slip_info_lines(&doc, "en");
        assert_eq!(lines.first().map(|(k, _)| k.as_str()), Some("Driver"));
        assert_eq!(lines.first().map(|(_, v)| v.as_str()), Some("Nikos Driver"));
        assert!(lines.iter().all(|(label, _)| label != "Driver ID"));
    }

    #[test]
    fn delivery_slip_info_lines_splits_packed_address_fields_when_missing() {
        let doc = OrderReceiptDoc {
            delivery_slip_mode: DeliverySlipMode::DeliveryOrder,
            customer_name: Some("Endrit".to_string()),
            delivery_address: Some("Xenofontos 28, Thessaloniki 546 41, Floor: 2".to_string()),
            ..OrderReceiptDoc::default()
        };
        let lines = delivery_slip_info_lines(&doc, "en");
        let address = lines
            .iter()
            .find(|(label, _)| label == "Address")
            .map(|(_, value)| value.as_str())
            .unwrap_or("-");
        let city = lines
            .iter()
            .find(|(label, _)| label == "City")
            .map(|(_, value)| value.as_str())
            .unwrap_or("-");
        let postal = lines
            .iter()
            .find(|(label, _)| label == "Postal")
            .map(|(_, value)| value.as_str())
            .unwrap_or("-");
        let floor = lines
            .iter()
            .find(|(label, _)| label == "Floor")
            .map(|(_, value)| value.as_str())
            .unwrap_or("-");

        assert_eq!(address, "Xenofontos 28");
        assert_eq!(city, "Thessaloniki");
        assert_eq!(postal, "54641");
        assert_eq!(floor, "2");
    }

    #[test]
    fn delivery_slip_escpos_assign_driver_prints_driver_name_without_driver_id() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            footer_text: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::DeliverySlip(OrderReceiptDoc {
            order_number: "A-DEL-1".to_string(),
            order_type: "delivery".to_string(),
            created_at: "2026-03-05T16:32:00Z".to_string(),
            delivery_slip_mode: DeliverySlipMode::AssignDriver,
            driver_id: Some("DRV-99".to_string()),
            driver_name: Some("Nikos Driver".to_string()),
            customer_name: Some("Customer One".to_string()),
            customer_phone: Some("2100000000".to_string()),
            delivery_address: Some("Main St 42".to_string()),
            delivery_city: Some("Athens".to_string()),
            delivery_postal_code: Some("10558".to_string()),
            delivery_floor: Some("2".to_string()),
            name_on_ringer: Some("Papadopoulos".to_string()),
            ..OrderReceiptDoc::default()
        });

        let text = String::from_utf8_lossy(&render_escpos(&doc, &cfg).bytes).to_string();
        let driver_name_idx = text.find("Driver").unwrap_or(usize::MAX);
        let address_idx = text.find("Address").unwrap_or(usize::MAX);
        assert!(driver_name_idx < address_idx);
        assert!(text.contains("Nikos Driver"));
        assert!(!text.contains("Driver ID"));
        assert!(!text.contains("DRV-99"));
    }

    #[test]
    fn delivery_slip_payment_renders_amount_when_available() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            footer_text: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::DeliverySlip(OrderReceiptDoc {
            order_number: "A-DEL-PAY".to_string(),
            order_type: "delivery".to_string(),
            created_at: "2026-03-05T16:32:00Z".to_string(),
            totals: vec![TotalsLine {
                label: "TOTAL".to_string(),
                amount: 13.7,
                emphasize: true,
                discount_percent: None,
            }],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 11.2,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });

        let text = String::from_utf8_lossy(&render_escpos(&doc, &cfg).bytes).to_string();
        assert!(text.contains("Cash"));
        assert!(text.contains("11.20") || text.contains("11,20"));
    }

    #[test]
    fn delivery_order_receipt_payment_renders_amount_when_available() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            footer_text: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-ORD-DEL-PAY".to_string(),
            order_type: "delivery".to_string(),
            created_at: "2026-03-05T16:32:00Z".to_string(),
            items: vec![ReceiptItem {
                name: "Waffle".to_string(),
                quantity: 1.0,
                total: 13.7,
                ..ReceiptItem::default()
            }],
            totals: vec![TotalsLine {
                label: "TOTAL".to_string(),
                amount: 13.7,
                emphasize: true,
                discount_percent: None,
            }],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 11.2,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });

        let text = String::from_utf8_lossy(&render_escpos(&doc, &cfg).bytes).to_string();
        assert!(text.contains("Cash"));
        assert!(text.contains("11.20") || text.contains("11,20"));
    }

    #[test]
    fn pickup_order_receipt_payment_keeps_amount_rendered() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            footer_text: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-ORD-PICKUP-PAY".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-03-05T16:32:00Z".to_string(),
            items: vec![ReceiptItem {
                name: "Waffle".to_string(),
                quantity: 1.0,
                total: 13.7,
                ..ReceiptItem::default()
            }],
            totals: vec![TotalsLine {
                label: "TOTAL".to_string(),
                amount: 13.7,
                emphasize: true,
                discount_percent: None,
            }],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 11.2,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });

        let text = String::from_utf8_lossy(&render_escpos(&doc, &cfg).bytes).to_string();
        assert!(text.contains("Cash"));
        assert!(text.contains("11.20") || text.contains("11,20"));
    }

    #[test]
    fn header_falls_back_to_organization_when_branch_missing() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            organization_name: "Org Name".to_string(),
            store_subtitle: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-82B".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:00:00Z".to_string(),
            ..OrderReceiptDoc::default()
        });
        let text = String::from_utf8_lossy(&render_escpos(&doc, &cfg).bytes).to_string();
        // Org Name appears in header + Classic star footer sub-footer
        assert!(count_text(&text, "Org Name") >= 1);
    }

    #[test]
    fn classic_kitchen_header_keeps_legacy_org_line_behavior() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            organization_name: "Brand Co".to_string(),
            store_subtitle: Some("Downtown Branch".to_string()),
            footer_text: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::KitchenTicket(KitchenTicketDoc {
            order_number: "KT-LEGACY-1".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:00:00Z".to_string(),
            ..KitchenTicketDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        let text = String::from_utf8_lossy(&out.bytes);
        assert!(text.contains("Brand Co"));
        assert!(text.contains("Downtown Branch"));
        assert!(text.contains("KITCHEN TICKET"));
    }

    #[test]
    fn classic_zreport_header_keeps_legacy_org_line_behavior() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            organization_name: "Brand Co".to_string(),
            store_subtitle: Some("Downtown Branch".to_string()),
            footer_text: None,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::ZReport(ZReportDoc {
            report_date: "2026-02-24".to_string(),
            generated_at: "2026-02-24T10:00:00Z".to_string(),
            ..ZReportDoc::default()
        });
        let out = render_escpos(&doc, &cfg);
        let text = String::from_utf8_lossy(&out.bytes);
        assert!(text.contains("Brand Co"));
        assert!(text.contains("Downtown Branch"));
        assert!(text.contains("Z REPORT"));
    }

    #[test]
    fn receipt_label_translates_shift_and_zreport_terms() {
        assert_eq!(receipt_label("el", "SHIFT CHECKOUT"), "ΚΛΕΙΣΙΜΟ ΒΑΡΔΙΑΣ");
        assert_eq!(receipt_label("el", "Z REPORT"), "ΑΝΑΦΟΡΑ Z");
        assert_eq!(receipt_label("el", "Driver ID"), "ID Οδηγού");
        assert_eq!(receipt_label("fr", "Orders"), "Commandes");
        assert_eq!(receipt_label("de", "Generated"), "Erstellt");
        assert_eq!(receipt_label("it", "Variance"), "Differenza");
    }

    #[test]
    fn classic_text_non_customer_receipts_use_configured_language_labels() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            language: "it".to_string(),
            classic_customer_render_mode: ClassicCustomerRenderMode::Text,
            footer_text: None,
            ..LayoutConfig::default()
        };

        let shift = ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
            shift_id: "SHIFT-001".to_string(),
            role_type: "cashier".to_string(),
            staff_name: "Staff".to_string(),
            terminal_name: "Front".to_string(),
            check_in: "2026-03-05T08:00:00Z".to_string(),
            check_out: "2026-03-05T16:00:00Z".to_string(),
            orders_count: 12,
            sales_amount: 120.5,
            total_expenses: 8.0,
            cash_refunds: 1.5,
            opening_amount: 50.0,
            expected_amount: Some(161.0),
            closing_amount: Some(160.0),
            variance_amount: Some(-1.0),
            ..ShiftCheckoutDoc::default()
        });
        let shift_text = String::from_utf8_lossy(&render_escpos(&shift, &cfg).bytes).to_string();
        assert!(shift_text.contains(receipt_label("it", "SHIFT CHECKOUT")));
        assert!(shift_text.contains(receipt_label("it", "Orders")));
        assert!(shift_text.contains(receipt_label("it", "Role")));
        assert!(shift_text.contains(&receipt_role_text("it", "cashier")));
        assert!(!shift_text.contains("SHIFT-001"));

        let z_report = ReceiptDocument::ZReport(ZReportDoc {
            report_id: "ZR-1".to_string(),
            report_date: "2026-03-05".to_string(),
            generated_at: "2026-03-05T23:59:00Z".to_string(),
            shift_ref: String::new(),
            shift_count: Some(3),
            terminal_name: "Front".to_string(),
            total_orders: 120,
            gross_sales: 980.0,
            net_sales: 880.0,
            cash_sales: 500.0,
            card_sales: 380.0,
            refunds_total: 10.0,
            voids_total: 4.0,
            discounts_total: 6.0,
            expenses_total: 15.0,
            cash_variance: -1.0,
            ..ZReportDoc::default()
        });
        let z_text = String::from_utf8_lossy(&render_escpos(&z_report, &cfg).bytes).to_string();
        assert!(z_text.contains(receipt_label("it", "Z REPORT")));
        assert!(z_text.contains(receipt_label("it", "Generated")));
        assert!(z_text.contains(receipt_label("it", "Shifts")));
        assert!(z_text.contains("3"));
        assert!(z_text.contains("Front"));
        assert!(!z_text.contains("snapshot"));
    }

    #[test]
    fn classic_text_driver_shift_checkout_renders_summary_without_delivery_rows() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            language: "en".to_string(),
            classic_customer_render_mode: ClassicCustomerRenderMode::Text,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::ShiftCheckout(sample_driver_shift_checkout_doc());
        let text = String::from_utf8_lossy(&render_escpos(&doc, &cfg).bytes).to_string();
        let expected_checkout = chrono::DateTime::parse_from_rfc3339("2026-03-05T16:00:00Z")
            .expect("parse check-out")
            .with_timezone(&chrono::Local)
            .format("%d/%m/%Y %H:%M")
            .to_string();

        assert!(text.contains("Check-out"));
        assert!(text.contains(&expected_checkout));
        assert!(text.contains("Starting Amount"));
        assert!(text.contains("Total Sells"));
        assert!(text.contains("Canceled/Refunded"));
        assert!(text.contains("30.50") || text.contains("30,50"));
        assert!(text.contains("40.00") || text.contains("40,00"));
        assert!(!text.contains("DRIVER SUMMARY"));
        assert!(!text.contains("Expected"));
        assert!(!text.contains("Closing"));
        assert!(!text.contains("Variance"));
        assert!(!text.contains("42.50"));
        assert!(!text.contains("DRIVER DELIVERIES"));
    }

    #[test]
    fn classic_text_cashier_shift_checkout_renders_transferred_staff_returns() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            language: "en".to_string(),
            classic_customer_render_mode: ClassicCustomerRenderMode::Text,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
            shift_id: "SHIFT-CASHIER-002".to_string(),
            role_type: "cashier".to_string(),
            staff_name: "Cashier Two".to_string(),
            terminal_name: "Front".to_string(),
            check_in: "2026-03-05T08:00:00Z".to_string(),
            check_out: "2026-03-05T16:00:00Z".to_string(),
            orders_count: 12,
            sales_amount: 120.5,
            total_expenses: 8.0,
            cash_refunds: 1.5,
            opening_amount: 50.0,
            transferred_staff_count: 2,
            transferred_staff_returns: 63.5,
            expected_amount: Some(161.0),
            closing_amount: Some(160.0),
            variance_amount: Some(-1.0),
            ..ShiftCheckoutDoc::default()
        });
        let text = String::from_utf8_lossy(&render_escpos(&doc, &cfg).bytes).to_string();

        assert!(text.contains("Transferred Staff"));
        assert!(text.contains("63.50") || text.contains("63,50"));
    }

    #[test]
    fn html_driver_shift_checkout_renders_check_times_and_summary_without_delivery_rows() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            language: "en".to_string(),
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::ShiftCheckout(sample_driver_shift_checkout_doc());
        let html = render_html(&doc, &cfg);
        let expected_check_in = chrono::DateTime::parse_from_rfc3339("2026-03-05T08:00:00Z")
            .expect("parse check-in")
            .with_timezone(&chrono::Local)
            .format("%d/%m/%Y %H:%M")
            .to_string();
        let expected_check_out = chrono::DateTime::parse_from_rfc3339("2026-03-05T16:00:00Z")
            .expect("parse check-out")
            .with_timezone(&chrono::Local)
            .format("%d/%m/%Y %H:%M")
            .to_string();

        assert!(html.contains("Check-in"));
        assert!(html.contains("Check-out"));
        assert!(html.contains(&expected_check_in));
        assert!(html.contains(&expected_check_out));
        assert!(html.contains("Starting Amount"));
        assert!(html.contains("Total Sells"));
        assert!(html.contains("Amount to be Returned"));
        assert!(html.contains("Canceled/Refunded"));
        assert!(html.contains("30.50"));
        assert!(!html.contains("DRIVER SUMMARY"));
        assert!(!html.contains("Expected"));
        assert!(!html.contains("Closing"));
        assert!(!html.contains("Variance"));
        assert!(!html.contains("42.50"));
        assert!(!html.contains("DRIVER DELIVERIES"));
    }

    #[test]
    fn html_cashier_shift_checkout_renders_transferred_staff_returns() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            language: "en".to_string(),
            ..LayoutConfig::default()
        };
        let html = render_html(
            &ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
                shift_id: "SHIFT-CASHIER-003".to_string(),
                role_type: "cashier".to_string(),
                staff_name: "Cashier Three".to_string(),
                terminal_name: "Front Counter".to_string(),
                check_in: "2026-03-05T08:00:00Z".to_string(),
                check_out: "2026-03-05T16:00:00Z".to_string(),
                orders_count: 12,
                sales_amount: 120.5,
                total_expenses: 8.0,
                cash_refunds: 1.5,
                opening_amount: 50.0,
                cash_sales: 80.0,
                card_sales: 40.5,
                cash_drops: 5.0,
                driver_cash_given: 20.0,
                staff_payouts_total: 34.0,
                staff_payout_lines: vec![StaffPayoutLine {
                    staff_name: "Driver One".to_string(),
                    role_type: "driver".to_string(),
                    amount: 34.0,
                }],
                transferred_staff_count: 1,
                transferred_staff_returns: 60.0,
                expected_amount: Some(161.0),
                closing_amount: Some(160.0),
                variance_amount: Some(-1.0),
                ..ShiftCheckoutDoc::default()
            }),
            &cfg,
        );

        assert!(html.contains("Transferred Staff"));
        assert!(html.contains("Transferred Staff Returns"));
        assert!(html.contains("Cash Sales"));
        assert!(html.contains("Card Sales"));
        assert!(html.contains("Staff Payouts"));
        assert!(html.contains("Counted Cash"));
        assert!(html.contains("Driver One"));
        assert!(html.contains("Expected In Drawer"));
        assert!(html.contains("60.00"));
    }

    #[test]
    fn html_non_financial_shift_checkout_renders_minimal_fields_only() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            language: "en".to_string(),
            ..LayoutConfig::default()
        };
        let html = render_html(
            &ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
                shift_id: "SHIFT-KITCHEN-001".to_string(),
                role_type: "kitchen".to_string(),
                staff_name: "Kitchen Staff".to_string(),
                terminal_name: "Front Counter".to_string(),
                check_in: "2026-03-05T08:00:00Z".to_string(),
                check_out: "2026-03-05T16:00:00Z".to_string(),
                orders_count: 12,
                sales_amount: 120.5,
                total_expenses: 8.0,
                cash_refunds: 1.5,
                opening_amount: 50.0,
                expected_amount: Some(161.0),
                closing_amount: Some(160.0),
                variance_amount: Some(-1.0),
                ..ShiftCheckoutDoc::default()
            }),
            &cfg,
        );

        assert!(html.contains("Kitchen"));
        assert!(html.contains("Check-in"));
        assert!(html.contains("Check-out"));
        assert!(!html.contains("Terminal"));
        assert!(!html.contains("Orders"));
        assert!(!html.contains("Sales"));
        assert!(!html.contains("Expenses"));
        assert!(!html.contains("Expected"));
    }

    #[test]
    fn text_non_financial_shift_checkout_renders_minimal_fields_only() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            language: "en".to_string(),
            classic_customer_render_mode: ClassicCustomerRenderMode::Text,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
            shift_id: "SHIFT-KITCHEN-002".to_string(),
            role_type: "kitchen".to_string(),
            staff_name: "Kitchen Staff".to_string(),
            terminal_name: "Front Counter".to_string(),
            check_in: "2026-03-05T08:00:00Z".to_string(),
            check_out: "2026-03-05T16:00:00Z".to_string(),
            orders_count: 12,
            sales_amount: 120.5,
            total_expenses: 8.0,
            cash_refunds: 1.5,
            opening_amount: 50.0,
            expected_amount: Some(161.0),
            closing_amount: Some(160.0),
            variance_amount: Some(-1.0),
            ..ShiftCheckoutDoc::default()
        });
        let text = String::from_utf8_lossy(&render_escpos(&doc, &cfg).bytes).to_string();

        assert!(text.contains("SHIFT CHECKOUT"));
        assert!(text.contains("Kitchen"));
        assert!(text.contains("Check-in"));
        assert!(text.contains("Check-out"));
        assert!(!text.contains("Terminal"));
        assert!(!text.contains("Orders"));
        assert!(!text.contains("Sales"));
        assert!(!text.contains("Expenses"));
        assert!(!text.contains("Expected"));
    }

    #[test]
    fn classic_shift_checkout_raster_exact_expands_for_transferred_staff_audit_lines() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            ..LayoutConfig::default()
        };
        let base_doc = ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
            shift_id: "SHIFT-CASHIER-BASE".to_string(),
            role_type: "cashier".to_string(),
            staff_name: "Cashier Base".to_string(),
            terminal_name: "Front".to_string(),
            check_in: "2026-03-05T08:00:00Z".to_string(),
            check_out: "2026-03-05T16:00:00Z".to_string(),
            orders_count: 12,
            sales_amount: 120.5,
            total_expenses: 8.0,
            cash_refunds: 1.5,
            opening_amount: 50.0,
            expected_amount: Some(161.0),
            closing_amount: Some(160.0),
            variance_amount: Some(-1.0),
            ..ShiftCheckoutDoc::default()
        });
        let transfer_doc = ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
            transferred_staff_count: 2,
            transferred_staff_returns: 63.5,
            ..match &base_doc {
                ReceiptDocument::ShiftCheckout(doc) => doc.clone(),
                _ => unreachable!(),
            }
        });

        let base_image = render_classic_non_customer_raster_exact_ttf(&base_doc, &cfg)
            .expect("render base cashier raster image");
        let transfer_image = render_classic_non_customer_raster_exact_ttf(&transfer_doc, &cfg)
            .expect("render cashier transfer raster image");

        assert!(
            transfer_image.height() > base_image.height(),
            "cashier raster receipt should grow when transferred staff audit lines are rendered"
        );
    }

    #[test]
    fn classic_shift_checkout_raster_exact_expands_for_staff_payout_lines() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            ..LayoutConfig::default()
        };
        let base_doc = ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
            shift_id: "SHIFT-CASHIER-PAYOUT-BASE".to_string(),
            role_type: "cashier".to_string(),
            staff_name: "Cashier Base".to_string(),
            terminal_name: "Front".to_string(),
            check_in: "2026-03-05T08:00:00Z".to_string(),
            check_out: "2026-03-05T16:00:00Z".to_string(),
            orders_count: 12,
            sales_amount: 120.5,
            total_expenses: 8.0,
            cash_refunds: 1.5,
            opening_amount: 50.0,
            cash_sales: 80.0,
            card_sales: 40.5,
            expected_amount: Some(161.0),
            closing_amount: Some(160.0),
            variance_amount: Some(-1.0),
            ..ShiftCheckoutDoc::default()
        });
        let payout_doc = ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
            staff_payouts_total: 34.0,
            staff_payout_lines: vec![StaffPayoutLine {
                staff_name: "Driver One".to_string(),
                role_type: "driver".to_string(),
                amount: 34.0,
            }],
            ..match &base_doc {
                ReceiptDocument::ShiftCheckout(doc) => doc.clone(),
                _ => unreachable!(),
            }
        });

        let base_image = render_classic_non_customer_raster_exact_ttf(&base_doc, &cfg)
            .expect("render base cashier raster image");
        let payout_image = render_classic_non_customer_raster_exact_ttf(&payout_doc, &cfg)
            .expect("render cashier payout raster image");

        assert!(
            payout_image.height() > base_image.height(),
            "cashier raster receipt should grow when staff payout lines are rendered"
        );
    }

    #[test]
    fn text_cashier_shift_checkout_renders_cashier_breakdown_and_payout_lines() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            language: "en".to_string(),
            classic_customer_render_mode: ClassicCustomerRenderMode::Text,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
            shift_id: "SHIFT-CASHIER-TEXT".to_string(),
            role_type: "cashier".to_string(),
            staff_name: "Cashier Text".to_string(),
            terminal_name: "Front Counter".to_string(),
            check_in: "2026-03-05T08:00:00Z".to_string(),
            check_out: "2026-03-05T16:00:00Z".to_string(),
            orders_count: 12,
            sales_amount: 120.5,
            total_expenses: 8.0,
            cash_refunds: 1.5,
            opening_amount: 50.0,
            cash_sales: 80.0,
            card_sales: 40.5,
            cash_drops: 5.0,
            driver_cash_given: 20.0,
            staff_payouts_total: 34.0,
            staff_payout_lines: vec![StaffPayoutLine {
                staff_name: "Driver One".to_string(),
                role_type: "driver".to_string(),
                amount: 34.0,
            }],
            transferred_staff_count: 1,
            transferred_staff_returns: 60.0,
            expected_amount: Some(161.0),
            closing_amount: Some(160.0),
            variance_amount: Some(-1.0),
            ..ShiftCheckoutDoc::default()
        });
        let text = String::from_utf8_lossy(&render_escpos(&doc, &cfg).bytes).to_string();

        assert!(text.contains("Cash Sales"));
        assert!(text.contains("Card Sales"));
        assert!(text.contains("Staff Payouts"));
        assert!(text.contains("Counted Cash"));
        assert!(text.contains("STAFF PAYOUTS"));
        assert!(text.contains("Driver One"));
    }

    #[test]
    fn html_non_customer_receipts_hide_internal_shift_ids_and_show_display_metadata() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            language: "en".to_string(),
            ..LayoutConfig::default()
        };

        let shift_html = render_html(
            &ReceiptDocument::ShiftCheckout(ShiftCheckoutDoc {
                shift_id: "shift-serial-999".to_string(),
                role_type: "cashier".to_string(),
                staff_name: "Staff".to_string(),
                terminal_name: "Front Counter".to_string(),
                check_in: "2026-03-05T08:00:00Z".to_string(),
                check_out: "2026-03-05T16:00:00Z".to_string(),
                orders_count: 12,
                sales_amount: 120.5,
                total_expenses: 8.0,
                cash_refunds: 1.5,
                opening_amount: 50.0,
                expected_amount: Some(161.0),
                closing_amount: Some(160.0),
                variance_amount: Some(-1.0),
                ..ShiftCheckoutDoc::default()
            }),
            &cfg,
        );
        assert!(shift_html.contains("Role"));
        assert!(shift_html.contains("Cashier"));
        assert!(shift_html.contains("Front Counter"));
        assert!(!shift_html.contains("shift-serial-999"));

        let z_report_html = render_html(
            &ReceiptDocument::ZReport(ZReportDoc {
                report_id: "ZR-1".to_string(),
                report_date: "2026-03-05".to_string(),
                generated_at: "2026-03-05T23:59:00Z".to_string(),
                shift_ref: String::new(),
                shift_count: Some(4),
                terminal_name: "Main POS".to_string(),
                total_orders: 120,
                gross_sales: 980.0,
                net_sales: 880.0,
                cash_sales: 500.0,
                card_sales: 380.0,
                refunds_total: 10.0,
                voids_total: 4.0,
                discounts_total: 6.0,
                expenses_total: 15.0,
                cash_variance: -1.0,
                ..ZReportDoc::default()
            }),
            &cfg,
        );
        assert!(z_report_html.contains("Shifts"));
        assert!(z_report_html.contains("Main POS"));
        assert!(!z_report_html.contains("snapshot"));
    }

    #[test]
    fn font_type_selects_expected_escpos_font_command() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-FONT".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:00:00Z".to_string(),
            ..OrderReceiptDoc::default()
        });

        let cfg_a = LayoutConfig {
            font_type: FontType::A,
            ..LayoutConfig::default()
        };
        let cfg_b = LayoutConfig {
            font_type: FontType::B,
            ..LayoutConfig::default()
        };

        let out_a = render_escpos(&doc, &cfg_a);
        let out_b = render_escpos(&doc, &cfg_b);
        assert!(count_sequence(&out_a.bytes, &[0x1B, 0x4D, 0x00]) >= 1);
        assert!(count_sequence(&out_b.bytes, &[0x1B, 0x4D, 0x01]) >= 1);
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

    #[test]
    fn star_safe_text_profile_emits_no_gs_size_commands() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Modern,
            command_profile: CommandProfile::SafeText,
            detected_brand: crate::printers::PrinterBrand::Star,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-90".to_string(),
            order_type: "delivery".to_string(),
            created_at: "2026-02-24T10:00:00Z".to_string(),
            items: vec![ReceiptItem {
                name: "Waffle".to_string(),
                quantity: 1.0,
                total: 9.2,
                ..ReceiptItem::default()
            }],
            totals: vec![
                TotalsLine {
                    label: "Subtotal".to_string(),
                    amount: 9.2,
                    emphasize: false,
                    discount_percent: None,
                },
                TotalsLine {
                    label: "TOTAL".to_string(),
                    amount: 9.2,
                    emphasize: true,
                    discount_percent: None,
                },
            ],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 9.2,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });

        let out = render_escpos(&doc, &cfg);
        assert_eq!(count_sequence(&out.bytes, &[0x1D, 0x21]), 0);
    }

    #[test]
    fn safe_text_mode_keeps_amount_tokens_intact() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Modern,
            command_profile: CommandProfile::SafeText,
            detected_brand: crate::printers::PrinterBrand::Star,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-91".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:00:00Z".to_string(),
            items: vec![
                ReceiptItem {
                    name: "Waffle".to_string(),
                    quantity: 1.0,
                    total: 9.2,
                    ..ReceiptItem::default()
                },
                ReceiptItem {
                    name: "Water".to_string(),
                    quantity: 1.0,
                    total: 1.5,
                    ..ReceiptItem::default()
                },
            ],
            totals: vec![
                TotalsLine {
                    label: "Subtotal".to_string(),
                    amount: 10.7,
                    emphasize: false,
                    discount_percent: None,
                },
                TotalsLine {
                    label: "TOTAL".to_string(),
                    amount: 10.7,
                    emphasize: true,
                    discount_percent: None,
                },
            ],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 10.7,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });

        let out = render_escpos(&doc, &cfg);
        let text = String::from_utf8_lossy(&out.bytes);
        assert!(text.contains("9.20"));
        assert!(text.contains("10.70"));
    }

    #[test]
    fn classic_and_modern_keep_shared_section_order() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-92".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:00:00Z".to_string(),
            items: vec![ReceiptItem {
                name: "Waffle".to_string(),
                quantity: 1.0,
                total: 9.2,
                ..ReceiptItem::default()
            }],
            totals: vec![TotalsLine {
                label: "TOTAL".to_string(),
                amount: 9.2,
                emphasize: true,
                discount_percent: None,
            }],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 9.2,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });

        let classic = LayoutConfig {
            template: ReceiptTemplate::Classic,
            command_profile: CommandProfile::SafeText,
            ..LayoutConfig::default()
        };
        let modern = LayoutConfig {
            template: ReceiptTemplate::Modern,
            command_profile: CommandProfile::SafeText,
            ..LayoutConfig::default()
        };

        // Modern: ORDER < TOTAL < PAYMENT
        {
            let out = render_escpos(&doc, &modern);
            let text = String::from_utf8_lossy(&out.bytes);
            let items = text.find("ORDER").unwrap_or(usize::MAX);
            let total = text.find("TOTAL").unwrap_or(usize::MAX);
            let payment = text.find("PAYMENT").unwrap_or(usize::MAX);
            assert!(items < total);
            assert!(total < payment);
        }
        // Classic: ITEMS < TOTAL < "Payment method"
        {
            let out = render_escpos(&doc, &classic);
            let text = String::from_utf8_lossy(&out.bytes);
            let items = text.find("ITEMS").unwrap_or(usize::MAX);
            let total = text.find("TOTAL").unwrap_or(usize::MAX);
            let payment_method = text.find("Payment method").unwrap_or(usize::MAX);
            assert!(items < total);
            assert!(total < payment_method);
        }
    }

    #[test]
    fn modern_compact_density_emits_fewer_blank_line_groups_than_spacious() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-92D".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:00:00Z".to_string(),
            items: vec![ReceiptItem {
                name: "Waffle".to_string(),
                quantity: 1.0,
                total: 9.2,
                ..ReceiptItem::default()
            }],
            totals: vec![TotalsLine {
                label: "TOTAL".to_string(),
                amount: 9.2,
                emphasize: true,
                discount_percent: None,
            }],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 9.2,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });

        let compact = LayoutConfig {
            template: ReceiptTemplate::Modern,
            command_profile: CommandProfile::SafeText,
            layout_density: LayoutDensity::Compact,
            ..LayoutConfig::default()
        };
        let spacious = LayoutConfig {
            template: ReceiptTemplate::Modern,
            command_profile: CommandProfile::SafeText,
            layout_density: LayoutDensity::Spacious,
            ..LayoutConfig::default()
        };

        let compact_text =
            String::from_utf8_lossy(&render_escpos(&doc, &compact).bytes).to_string();
        let spacious_text =
            String::from_utf8_lossy(&render_escpos(&doc, &spacious).bytes).to_string();

        // Spacious may add extra focus_spacing_lines that compact omits
        assert!(count_text(&compact_text, "\n\n") <= count_text(&spacious_text, "\n\n"));
    }

    #[test]
    fn classic_and_modern_have_distinct_header_decoration_in_safe_text_mode() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "A-93".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-02-24T10:00:00Z".to_string(),
            items: vec![ReceiptItem {
                name: "Waffle".to_string(),
                quantity: 1.0,
                total: 9.2,
                ..ReceiptItem::default()
            }],
            totals: vec![TotalsLine {
                label: "TOTAL".to_string(),
                amount: 9.2,
                emphasize: true,
                discount_percent: None,
            }],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 9.2,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });

        let classic = LayoutConfig {
            template: ReceiptTemplate::Classic,
            command_profile: CommandProfile::SafeText,
            ..LayoutConfig::default()
        };
        let modern = LayoutConfig {
            template: ReceiptTemplate::Modern,
            command_profile: CommandProfile::SafeText,
            ..LayoutConfig::default()
        };

        let classic_text =
            String::from_utf8_lossy(&render_escpos(&doc, &classic).bytes).to_string();
        let modern_text = String::from_utf8_lossy(&render_escpos(&doc, &modern).bytes).to_string();

        // Modern uses "ORDER" section header, classic uses "ITEMS"
        assert!(modern_text.contains("ORDER"));
        assert!(classic_text.contains("ITEMS"));
        // Classic uses box-drawing rules; Modern uses dash rules
        assert!(!classic_text.contains("===="));
        assert!(!modern_text.contains("===="));
        // Classic no longer has star line at top
        assert!(!classic_text.contains("* * *"));
    }

    #[test]
    fn text_scale_affects_raster_preset_sizes() {
        let small = LayoutConfig {
            text_scale: 0.8,
            template: ReceiptTemplate::Classic,
            ..LayoutConfig::default()
        };
        let large = LayoutConfig {
            text_scale: 2.0,
            template: ReceiptTemplate::Classic,
            ..LayoutConfig::default()
        };
        let preset_small = raster_exact_preset_for_layout(&small);
        let preset_large = raster_exact_preset_for_layout(&large);
        // Larger text_scale must produce larger item font sizes
        assert!(
            preset_large.item_style.size_px > preset_small.item_style.size_px,
            "large text_scale ({}) should have bigger item font than small ({})",
            preset_large.item_style.size_px,
            preset_small.item_style.size_px,
        );
        assert!(
            preset_large.total_style.size_px > preset_small.total_style.size_px,
            "large text_scale ({}) should have bigger total font than small ({})",
            preset_large.total_style.size_px,
            preset_small.total_style.size_px,
        );
    }

    #[test]
    fn text_scale_default_matches_legacy_hardcoded_value() {
        // Default text_scale=1.25 must produce the same preset as the old
        // hardcoded classic_scale=1.25 path when using Classic template.
        let default_cfg = LayoutConfig::default();
        assert!(
            (default_cfg.text_scale - 1.25).abs() < f32::EPSILON,
            "default text_scale should be 1.25, got {}",
            default_cfg.text_scale
        );

        // Classic template applies text_scale: base 30px * 1.25 = 37.5
        let classic_cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            ..LayoutConfig::default()
        };
        let preset = raster_exact_preset_for_layout(&classic_cfg);
        assert!(
            (preset.item_style.size_px - 37.5).abs() < 0.01,
            "classic item_style.size_px should be 37.5px (30 * 1.25), got {}",
            preset.item_style.size_px,
        );

        // Modern template ignores text_scale: base 30px * 1.0 = 30
        let modern_preset = raster_exact_preset_for_layout(&default_cfg);
        assert!(
            (modern_preset.item_style.size_px - 30.0).abs() < 0.01,
            "modern item_style.size_px should be 30px (unscaled), got {}",
            modern_preset.item_style.size_px,
        );
    }

    #[test]
    fn modern_template_ignores_text_scale_for_raster() {
        // Modern template should use scale=1.0 regardless of text_scale
        let modern_low = LayoutConfig {
            text_scale: 0.8,
            template: ReceiptTemplate::Modern,
            ..LayoutConfig::default()
        };
        let modern_high = LayoutConfig {
            text_scale: 2.0,
            template: ReceiptTemplate::Modern,
            ..LayoutConfig::default()
        };
        let preset_low = raster_exact_preset_for_layout(&modern_low);
        let preset_high = raster_exact_preset_for_layout(&modern_high);
        // Modern ignores text_scale, so presets should be identical
        assert_eq!(
            preset_low.item_style.size_px, preset_high.item_style.size_px,
            "Modern template should ignore text_scale: low={}, high={}",
            preset_low.item_style.size_px, preset_high.item_style.size_px,
        );
    }

    #[test]
    fn html_render_includes_text_and_logo_scale_in_css() {
        let cfg = LayoutConfig {
            text_scale: 1.5,
            logo_scale: 1.5,
            organization_name: "Test Store".to_string(),
            show_logo: true,
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "S-1".to_string(),
            order_type: "dine-in".to_string(),
            created_at: "2026-03-09".to_string(),
            ..OrderReceiptDoc::default()
        });
        let html = render_html(&doc, &cfg);

        // text_scale=1.5: base store name font 12px * 1.5 = 18px
        assert!(
            html.contains("18px"),
            "HTML should contain 18px for store name at text_scale=1.5"
        );

        // logo_scale=1.5: logo circle 60 * 1.5 = 90px
        assert!(
            html.contains("90px"),
            "HTML should contain 90px for logo circle at logo_scale=1.5"
        );

        // Verify default scales produce default sizes
        let default_cfg = LayoutConfig {
            organization_name: "Test Store".to_string(),
            show_logo: true,
            ..LayoutConfig::default()
        };
        let default_html = render_html(&doc, &default_cfg);
        // text_scale=1.25: base 12 * 1.25 = 15px for store name
        assert!(
            default_html.contains("15px"),
            "Default HTML should contain 15px for store name at text_scale=1.25"
        );
        // logo_scale=1.0: logo circle 60 * 1.0 = 60px
        assert!(
            default_html.contains("60px"),
            "Default HTML should contain 60px for logo circle at logo_scale=1.0"
        );
    }

    #[test]
    fn classic_html_preview_reflects_typography_presets() {
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            font_type: FontType::B,
            layout_density: LayoutDensity::Spacious,
            header_emphasis: HeaderEmphasis::Normal,
            organization_name: "Test Store".to_string(),
            ..LayoutConfig::default()
        };
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "S-3".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-03-09".to_string(),
            ..OrderReceiptDoc::default()
        });

        let html = render_html(&doc, &cfg);

        assert!(html.contains("line-height: 2.05;"));
        assert!(html.contains("font-weight: 500;"));
        assert!(html.contains("letter-spacing: 1.5px;"));
        assert!(html.contains("margin: 12px 0 9px;"));
    }

    #[test]
    fn raster_exact_preview_data_url_changes_with_text_scale() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "S-2".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-03-09T18:00:00Z".to_string(),
            ..OrderReceiptDoc::default()
        });
        let small_cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            text_scale: 0.8,
            ..LayoutConfig::default()
        };
        let large_cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            text_scale: 1.8,
            ..LayoutConfig::default()
        };

        let (small, small_warnings) =
            render_classic_raster_exact_preview_data_url(&doc, &small_cfg)
                .expect("small preview should render");
        let (large, large_warnings) =
            render_classic_raster_exact_preview_data_url(&doc, &large_cfg)
                .expect("large preview should render");

        assert!(small_warnings.is_empty());
        assert!(large_warnings.is_empty());
        assert_ne!(
            small, large,
            "text scale should change raster preview output"
        );
    }

    #[test]
    fn raster_exact_preview_data_url_changes_with_logo_scale() {
        let mut encoded = Vec::new();
        let logo = image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(
            220,
            220,
            image::Luma([0]),
        ));
        logo.write_to(&mut Cursor::new(&mut encoded), image::ImageFormat::Png)
            .expect("encode logo");
        let logo_data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded)
        );
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "S-3".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-03-09T18:00:00Z".to_string(),
            ..OrderReceiptDoc::default()
        });
        let small_cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            show_logo: true,
            logo_url: Some(logo_data_url.clone()),
            logo_scale: 0.5,
            ..LayoutConfig::default()
        };
        let large_cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            show_logo: true,
            logo_url: Some(logo_data_url),
            logo_scale: 1.8,
            ..LayoutConfig::default()
        };

        let (small, small_warnings) =
            render_classic_raster_exact_preview_data_url(&doc, &small_cfg)
                .expect("small logo preview should render");
        let (large, large_warnings) =
            render_classic_raster_exact_preview_data_url(&doc, &large_cfg)
                .expect("large logo preview should render");

        assert!(small_warnings.is_empty());
        assert!(large_warnings.is_empty());
        assert_ne!(
            small, large,
            "logo scale should change raster preview output"
        );
    }

    #[test]
    fn raster_exact_preview_data_url_changes_with_layout_density() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "S-4".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-03-09T18:00:00Z".to_string(),
            ..OrderReceiptDoc::default()
        });
        let compact_cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            layout_density: LayoutDensity::Compact,
            ..LayoutConfig::default()
        };
        let spacious_cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            layout_density: LayoutDensity::Spacious,
            ..LayoutConfig::default()
        };

        let (compact, _) = render_classic_raster_exact_preview_data_url(&doc, &compact_cfg)
            .expect("compact preview should render");
        let (spacious, _) = render_classic_raster_exact_preview_data_url(&doc, &spacious_cfg)
            .expect("spacious preview should render");

        assert_ne!(
            compact, spacious,
            "layout density should change raster preview output"
        );
    }

    #[test]
    fn raster_exact_preview_data_url_changes_with_header_emphasis() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "S-5".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-03-09T18:00:00Z".to_string(),
            ..OrderReceiptDoc::default()
        });
        let normal_cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            header_emphasis: HeaderEmphasis::Normal,
            ..LayoutConfig::default()
        };
        let strong_cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            header_emphasis: HeaderEmphasis::Strong,
            ..LayoutConfig::default()
        };

        let (normal, _) = render_classic_raster_exact_preview_data_url(&doc, &normal_cfg)
            .expect("normal header preview should render");
        let (strong, _) = render_classic_raster_exact_preview_data_url(&doc, &strong_cfg)
            .expect("strong header preview should render");

        assert_ne!(
            normal, strong,
            "header emphasis should change raster preview output"
        );
    }

    #[test]
    fn raster_exact_preview_data_url_changes_with_body_boldness() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "S-6".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-03-09T18:00:00Z".to_string(),
            items: vec![ReceiptItem {
                name: "Waffle".to_string(),
                quantity: 1.0,
                total: 9.2,
                ..ReceiptItem::default()
            }],
            totals: vec![TotalsLine {
                label: "TOTAL".to_string(),
                amount: 9.2,
                emphasize: true,
                discount_percent: None,
            }],
            payments: vec![PaymentLine {
                label: "Cash".to_string(),
                amount: 9.2,
                detail: None,
            }],
            ..OrderReceiptDoc::default()
        });
        let normal_cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            body_font_weight: 400,
            ..LayoutConfig::default()
        };
        let bold_cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            body_font_weight: 800,
            ..LayoutConfig::default()
        };

        let (normal, _) = render_classic_raster_exact_preview_data_url(&doc, &normal_cfg)
            .expect("normal body preview should render");
        let (bold, _) = render_classic_raster_exact_preview_data_url(&doc, &bold_cfg)
            .expect("bold body preview should render");

        assert_ne!(
            normal, bold,
            "body boldness should change raster preview output"
        );
    }

    #[test]
    fn raster_exact_delivery_receipt_grows_when_delivery_fields_are_present() {
        let base_doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "S-7".to_string(),
            order_type: "delivery".to_string(),
            created_at: "2026-03-09T18:00:00Z".to_string(),
            ..OrderReceiptDoc::default()
        });
        let delivery_doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "S-8".to_string(),
            order_type: "delivery".to_string(),
            created_at: "2026-03-09T18:00:00Z".to_string(),
            customer_phone: Some("6900000000".to_string()),
            delivery_address: Some("Main St 12".to_string()),
            driver_name: Some("Nikos Driver".to_string()),
            ..OrderReceiptDoc::default()
        });
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            ..LayoutConfig::default()
        };

        let base = render_classic_customer_raster_exact_ttf(&base_doc, &cfg)
            .expect("base delivery preview should render");
        let with_fields = render_classic_customer_raster_exact_ttf(&delivery_doc, &cfg)
            .expect("delivery fields preview should render");

        assert!(
            with_fields.height() > base.height(),
            "delivery block should increase raster receipt height"
        );
    }

    #[test]
    fn raster_exact_preview_returns_logo_fallback_warning_when_source_missing() {
        let doc = ReceiptDocument::OrderReceipt(OrderReceiptDoc {
            order_number: "S-9".to_string(),
            order_type: "pickup".to_string(),
            created_at: "2026-03-09T18:00:00Z".to_string(),
            ..OrderReceiptDoc::default()
        });
        let cfg = LayoutConfig {
            template: ReceiptTemplate::Classic,
            classic_customer_render_mode: ClassicCustomerRenderMode::RasterExact,
            show_logo: true,
            logo_url: None,
            ..LayoutConfig::default()
        };

        let (_, warnings) = render_classic_raster_exact_preview_data_url(&doc, &cfg)
            .expect("preview with missing logo should render");

        assert!(
            warnings
                .iter()
                .any(|warning| warning.code == "logo_text_fallback"),
            "expected logo fallback warning when logo is enabled without a source"
        );
    }
}
