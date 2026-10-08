//! Order-level Greek VAT, the desktop port of the shared contract.
//!
//! `shared/services/GreeceVatService.ts` (`calculateGreeceFiscalBreakdown`)
//! and `shared/services/GreeceOrderVat.ts` (`calculateGreeceOrderVat`) are
//! the exact mirror of the server's `computeOrderTotals`
//! (admin-dashboard `pos-orders-api-service.ts`). This module repeats their
//! arithmetic step by step, with the same float expressions and the same
//! rounding (JavaScript `Math.round`), and keeps every amount in integer
//! cents afterwards. `shared/services/__fixtures__/greece-order-vat-vectors.json`
//! pins the results; the test at the end of this file runs every vector.
//!
//! What the till stores as `orders.tax_amount` is this computation over the
//! same order body the till sends to `POST /api/pos/orders`
//! ([`calculate_order_vat_from_order_body`]), so till and server see the same
//! VAT. Prices are VAT-inclusive in this release: the stored VAT is inside the
//! total and is never added on top of a subtotal
//! ([`vat_added_on_top_of_subtotal`]).

use rusqlite::Connection;
use serde_json::Value;

/// The branch default category the server assumes without a compliance row.
pub const GREECE_DEFAULT_VAT_CATEGORY_CODE: &str = "gr_standard_24";
/// The region profile the server assumes without a compliance row.
pub const GREECE_DEFAULT_VAT_REGION_PROFILE: &str = "mainland";
/// A delivery fee always carries the reduced 13% rate.
pub const GREECE_DELIVERY_FEE_VAT_CATEGORY_CODE: &str = "gr_reduced_13";
/// A tip is outside the scope of VAT.
pub const GREECE_TIP_VAT_CATEGORY_CODE: &str = "gr_out_of_scope";

/// Local settings (category `tax`) the server feed fills from the branch's
/// Greek compliance row.
pub const VAT_SETTINGS_CATEGORY: &str = "tax";
pub const VAT_DEFAULT_CATEGORY_SETTING_KEY: &str = "vat_default_category_code";
pub const VAT_REGION_PROFILE_SETTING_KEY: &str = "vat_region_profile";

/// The category catalogue of `GreeceVatService.ts` (code, rate in percent).
const GREECE_VAT_CATEGORIES: [(&str, f64); 9] = [
    ("gr_standard_24", 24.0),
    ("gr_reduced_13", 13.0),
    ("gr_super_reduced_6", 6.0),
    ("gr_island_reduced_17", 17.0),
    ("gr_island_super_reduced_9", 9.0),
    ("gr_island_ultra_reduced_4", 4.0),
    ("gr_exempt", 0.0),
    ("gr_out_of_scope", 0.0),
    ("gr_article_39_small_business", 0.0),
];

/// JavaScript `Math.round`: the nearest integer, ties toward +infinity.
///
/// Rust's `f64::round` sends ties away from zero, which differs for negative
/// halves; `x - floor(x)` is exact for every finite money value, so the
/// comparison with 0.5 reproduces the JavaScript result.
pub(crate) fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Math.round(value * 100)` as integer cents.
fn js_cents(value: f64) -> i64 {
    js_round(value * 100.0) as i64
}

fn finite_or_zero(value: Option<f64>) -> f64 {
    value.filter(|value| value.is_finite()).unwrap_or(0.0)
}

/// The branch's VAT region.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VatRegionProfile {
    Mainland,
    IslandsReduced,
}

impl VatRegionProfile {
    /// `normalizeGreeceOrderVatSettings`: only the exact `islands_reduced`
    /// selects the islands; anything else is the mainland.
    pub fn from_setting(raw: Option<&str>) -> Self {
        if raw == Some("islands_reduced") {
            Self::IslandsReduced
        } else {
            Self::Mainland
        }
    }

    fn default_category(self) -> &'static str {
        match self {
            Self::Mainland => "gr_standard_24",
            Self::IslandsReduced => "gr_island_reduced_17",
        }
    }
}

/// `FiscalLineKind` of the shared contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FiscalLineKind {
    Item,
    DeliveryFee,
    ServiceFee,
    Tip,
    ManualItem,
    CustomCharge,
}

impl FiscalLineKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Item => "item",
            Self::DeliveryFee => "delivery_fee",
            Self::ServiceFee => "service_fee",
            Self::Tip => "tip",
            Self::ManualItem => "manual_item",
            Self::CustomCharge => "custom_charge",
        }
    }
}

/// `resolveGreeceVatCategory`: a known code, else the region's default.
pub fn resolve_greece_vat_category(
    code: Option<&str>,
    region: VatRegionProfile,
) -> (&'static str, f64) {
    let known = code.and_then(|code| {
        GREECE_VAT_CATEGORIES
            .iter()
            .find(|(candidate, _)| !code.is_empty() && *candidate == code)
    });
    let code = known
        .map(|(candidate, _)| *candidate)
        .unwrap_or_else(|| region.default_category());
    let rate = GREECE_VAT_CATEGORIES
        .iter()
        .find(|(candidate, _)| *candidate == code)
        .map(|(_, rate)| *rate)
        .unwrap_or(0.0);
    (code, rate)
}

/// One `FiscalTaxLineInput`.
#[derive(Debug, Clone, Default)]
pub struct FiscalTaxLineInput {
    pub id: Option<String>,
    pub description: Option<String>,
    pub quantity: Option<f64>,
    pub unit_price: f64,
    pub vat_category_code: Option<String>,
    pub price_includes_vat: Option<bool>,
    pub tax_exemption_reason: Option<String>,
    pub fiscal_document_profile: Option<String>,
    pub line_kind: Option<FiscalLineKind>,
    pub participates_in_discount_allocation: Option<bool>,
}

/// One computed line, in cents.
#[derive(Debug, Clone, PartialEq)]
pub struct FiscalTaxLine {
    pub id: String,
    pub description: Option<String>,
    pub quantity: f64,
    pub line_kind: FiscalLineKind,
    pub vat_category_code: &'static str,
    pub vat_rate: f64,
    pub price_includes_vat: bool,
    pub tax_exemption_reason: Option<String>,
    pub fiscal_document_profile: Option<String>,
    pub original_gross_cents: i64,
    pub discount_cents: i64,
    pub gross_cents: i64,
    pub net_cents: i64,
    pub vat_cents: i64,
}

/// One rate bucket, in cents.
#[derive(Debug, Clone, PartialEq)]
pub struct FiscalTaxBucket {
    pub vat_category_code: &'static str,
    pub vat_rate: f64,
    pub gross_cents: i64,
    pub net_cents: i64,
    pub vat_cents: i64,
    pub discount_cents: i64,
    pub line_count: usize,
}

/// `GreeceFiscalBreakdown`, in cents.
#[derive(Debug, Clone, PartialEq)]
pub struct GreeceFiscalBreakdown {
    pub lines: Vec<FiscalTaxLine>,
    pub tax_breakdown: Vec<FiscalTaxBucket>,
    pub total_gross_cents: i64,
    pub total_net_cents: i64,
    pub total_vat_cents: i64,
    pub total_discount_cents: i64,
}

/// `allocateDiscountAcrossLines`: proportional floors, then the remaining
/// cents by the largest remainder, ties to the higher index first.
fn allocate_discount_across_lines(gross_line_cents: &[i64], total_discount_cents: i64) -> Vec<i64> {
    if total_discount_cents <= 0 || gross_line_cents.is_empty() {
        return vec![0; gross_line_cents.len()];
    }
    let eligible_total: i64 = gross_line_cents.iter().sum();
    if eligible_total <= 0 {
        return vec![0; gross_line_cents.len()];
    }

    struct Raw {
        index: usize,
        floor: f64,
        remainder: f64,
    }
    let mut raw_allocations: Vec<Raw> = gross_line_cents
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let raw = (total_discount_cents as f64 * *value as f64) / eligible_total as f64;
            let floor = raw.floor();
            Raw {
                index,
                floor,
                remainder: raw - floor,
            }
        })
        .collect();

    let mut allocated: Vec<i64> = raw_allocations
        .iter()
        .map(|entry| entry.floor as i64)
        .collect();
    let mut remaining = total_discount_cents - allocated.iter().sum::<i64>();

    raw_allocations.sort_by(|left, right| {
        right
            .remainder
            .partial_cmp(&left.remainder)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.index.cmp(&left.index))
    });
    for entry in &raw_allocations {
        if remaining <= 0 {
            break;
        }
        allocated[entry.index] += 1;
        remaining -= 1;
    }
    allocated
}

/// `calculateGreeceFiscalBreakdown`.
pub fn calculate_greece_fiscal_breakdown(
    lines: &[FiscalTaxLineInput],
    order_discount_amount: Option<f64>,
    region: VatRegionProfile,
) -> GreeceFiscalBreakdown {
    struct Normalized {
        id: String,
        description: Option<String>,
        quantity: f64,
        line_kind: FiscalLineKind,
        vat_category_code: &'static str,
        vat_rate: f64,
        price_includes_vat: bool,
        tax_exemption_reason: Option<String>,
        fiscal_document_profile: Option<String>,
        original_gross_cents: i64,
        participates_in_discount_allocation: bool,
    }

    let normalized: Vec<Normalized> = lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let quantity = line
                .quantity
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(1.0);
            let original_gross_cents = js_cents(f64::max(0.0, quantity * line.unit_price));
            let (vat_category_code, vat_rate) =
                resolve_greece_vat_category(line.vat_category_code.as_deref(), region);
            Normalized {
                id: line
                    .id
                    .as_ref()
                    .filter(|id| !id.trim().is_empty())
                    .cloned()
                    .unwrap_or_else(|| format!("line-{}", index + 1)),
                description: line.description.clone(),
                quantity,
                line_kind: line.line_kind.unwrap_or(FiscalLineKind::Item),
                vat_category_code,
                vat_rate,
                price_includes_vat: line.price_includes_vat != Some(false),
                tax_exemption_reason: line.tax_exemption_reason.clone(),
                fiscal_document_profile: line.fiscal_document_profile.clone(),
                original_gross_cents,
                participates_in_discount_allocation: line
                    .participates_in_discount_allocation
                    .unwrap_or(vat_rate > 0.0),
            }
        })
        .collect();

    let eligible_indexes: Vec<usize> = normalized
        .iter()
        .enumerate()
        .filter(|(_, line)| {
            line.participates_in_discount_allocation && line.original_gross_cents > 0
        })
        .map(|(index, _)| index)
        .collect();
    let total_eligible_cents: i64 = eligible_indexes
        .iter()
        .map(|index| normalized[*index].original_gross_cents)
        .sum();
    let requested_discount_cents = js_cents(f64::max(0.0, order_discount_amount.unwrap_or(0.0)));
    let total_discount_cents = requested_discount_cents.min(total_eligible_cents);

    let mut discount_allocations = vec![0_i64; normalized.len()];
    if total_discount_cents > 0 && !eligible_indexes.is_empty() {
        let grosses: Vec<i64> = eligible_indexes
            .iter()
            .map(|index| normalized[*index].original_gross_cents)
            .collect();
        let allocations = allocate_discount_across_lines(&grosses, total_discount_cents);
        for (allocation_index, line_index) in eligible_indexes.iter().enumerate() {
            discount_allocations[*line_index] = allocations[allocation_index];
        }
    }

    let lines: Vec<FiscalTaxLine> = normalized
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            let discount_cents = discount_allocations[index];
            let discounted_gross_cents = (line.original_gross_cents - discount_cents).max(0);
            let divisor = 1.0 + line.vat_rate / 100.0;
            let (gross_cents, net_cents, vat_cents) = if line.price_includes_vat {
                let gross = discounted_gross_cents;
                if line.vat_rate > 0.0 && divisor > 0.0 {
                    let net = js_round(gross as f64 / divisor) as i64;
                    (gross, net, gross - net)
                } else {
                    (gross, gross, 0)
                }
            } else {
                let net = discounted_gross_cents;
                let vat = if line.vat_rate > 0.0 {
                    js_round(net as f64 * (line.vat_rate / 100.0)) as i64
                } else {
                    0
                };
                (net + vat, net, vat)
            };
            FiscalTaxLine {
                id: line.id,
                description: line.description,
                quantity: line.quantity,
                line_kind: line.line_kind,
                vat_category_code: line.vat_category_code,
                vat_rate: line.vat_rate,
                price_includes_vat: line.price_includes_vat,
                tax_exemption_reason: line.tax_exemption_reason,
                fiscal_document_profile: line.fiscal_document_profile,
                original_gross_cents: line.original_gross_cents,
                discount_cents,
                gross_cents,
                net_cents,
                vat_cents,
            }
        })
        .collect();

    // `buildTaxBreakdownBuckets`: insertion order, then a stable sort by
    // rate, highest first.
    let mut tax_breakdown: Vec<FiscalTaxBucket> = Vec::new();
    for line in &lines {
        if let Some(existing) = tax_breakdown.iter_mut().find(|bucket| {
            bucket.vat_category_code == line.vat_category_code && bucket.vat_rate == line.vat_rate
        }) {
            existing.gross_cents += line.gross_cents;
            existing.net_cents += line.net_cents;
            existing.vat_cents += line.vat_cents;
            existing.discount_cents += line.discount_cents;
            existing.line_count += 1;
            continue;
        }
        tax_breakdown.push(FiscalTaxBucket {
            vat_category_code: line.vat_category_code,
            vat_rate: line.vat_rate,
            gross_cents: line.gross_cents,
            net_cents: line.net_cents,
            vat_cents: line.vat_cents,
            discount_cents: line.discount_cents,
            line_count: 1,
        });
    }
    tax_breakdown.sort_by(|left, right| {
        right
            .vat_rate
            .partial_cmp(&left.vat_rate)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    GreeceFiscalBreakdown {
        total_gross_cents: lines.iter().map(|line| line.gross_cents).sum(),
        total_net_cents: lines.iter().map(|line| line.net_cents).sum(),
        total_vat_cents: lines.iter().map(|line| line.vat_cents).sum(),
        total_discount_cents: lines.iter().map(|line| line.discount_cents).sum(),
        lines,
        tax_breakdown,
    }
}

/// One item of `GreeceOrderVatInput`.
#[derive(Debug, Clone, Default)]
pub struct GreeceOrderVatItem {
    pub menu_item_id: Option<String>,
    pub name: Option<String>,
    pub quantity: f64,
    pub unit_price: f64,
    pub vat_category_code: Option<String>,
    pub price_includes_vat: Option<bool>,
    pub tax_exemption_reason: Option<String>,
    pub fiscal_document_profile: Option<String>,
}

/// The branch VAT settings the till holds (`tax.vat_default_category_code`,
/// `tax.vat_region_profile`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GreeceVatSettings {
    pub default_vat_category_code: Option<String>,
    pub vat_region_profile: Option<String>,
}

impl GreeceVatSettings {
    /// `normalizeGreeceOrderVatSettings`.
    fn normalized(&self) -> (String, VatRegionProfile) {
        let code = self
            .default_vat_category_code
            .as_deref()
            .map(str::trim)
            .filter(|code| !code.is_empty())
            .unwrap_or(GREECE_DEFAULT_VAT_CATEGORY_CODE)
            .to_string();
        (
            code,
            VatRegionProfile::from_setting(self.vat_region_profile.as_deref()),
        )
    }
}

/// `GreeceOrderVatInput`.
#[derive(Debug, Clone, Default)]
pub struct GreeceOrderVatInput {
    pub settings: GreeceVatSettings,
    pub items: Vec<GreeceOrderVatItem>,
    /// Manual and coupon discount together, as the order carries it.
    pub discount_amount: Option<f64>,
    pub delivery_fee: Option<f64>,
    pub service_fee: Option<f64>,
    pub tip_amount: Option<f64>,
}

/// `GreeceOrderVatResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct GreeceOrderVatResult {
    pub breakdown: GreeceFiscalBreakdown,
    /// The order's VAT in cents (`orders.tax_amount_cents`).
    pub tax_amount_cents: i64,
    /// The first `item_line_count` breakdown lines are the items, in order.
    pub item_line_count: usize,
}

impl GreeceOrderVatResult {
    /// The order's VAT as the server stores `orders.tax_amount`.
    pub fn tax_amount(&self) -> f64 {
        self.tax_amount_cents as f64 / 100.0
    }
}

/// `buildGreeceOrderTaxLines`.
pub fn build_greece_order_tax_lines(input: &GreeceOrderVatInput) -> Vec<FiscalTaxLineInput> {
    let (default_vat_category_code, _) = input.settings.normalized();
    let delivery_fee = finite_or_zero(input.delivery_fee);
    let service_fee = finite_or_zero(input.service_fee);
    let tip_amount = finite_or_zero(input.tip_amount);

    let mut lines: Vec<FiscalTaxLineInput> = input
        .items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let menu_item_id = item
                .menu_item_id
                .as_ref()
                .filter(|id| !id.is_empty())
                .cloned();
            FiscalTaxLineInput {
                id: Some(
                    menu_item_id
                        .clone()
                        .unwrap_or_else(|| format!("manual-item-{}", index + 1)),
                ),
                description: item.name.clone().filter(|name| !name.is_empty()),
                quantity: Some(item.quantity),
                unit_price: item.unit_price,
                vat_category_code: Some(
                    item.vat_category_code
                        .clone()
                        .unwrap_or_else(|| default_vat_category_code.clone()),
                ),
                price_includes_vat: Some(item.price_includes_vat.unwrap_or(true)),
                tax_exemption_reason: item.tax_exemption_reason.clone(),
                fiscal_document_profile: item.fiscal_document_profile.clone(),
                line_kind: Some(if menu_item_id.is_some() {
                    FiscalLineKind::Item
                } else {
                    FiscalLineKind::ManualItem
                }),
                participates_in_discount_allocation: None,
            }
        })
        .collect();

    if delivery_fee > 0.0 {
        lines.push(FiscalTaxLineInput {
            id: Some("delivery-fee".to_string()),
            description: Some("Delivery Fee".to_string()),
            quantity: Some(1.0),
            unit_price: delivery_fee,
            vat_category_code: Some(GREECE_DELIVERY_FEE_VAT_CATEGORY_CODE.to_string()),
            price_includes_vat: Some(true),
            tax_exemption_reason: None,
            fiscal_document_profile: Some("delivery_fee".to_string()),
            line_kind: Some(FiscalLineKind::DeliveryFee),
            participates_in_discount_allocation: Some(false),
        });
    }
    if service_fee > 0.0 {
        lines.push(FiscalTaxLineInput {
            id: Some("service-fee".to_string()),
            description: Some("Service Fee".to_string()),
            quantity: Some(1.0),
            unit_price: service_fee,
            vat_category_code: Some(default_vat_category_code.clone()),
            price_includes_vat: Some(true),
            tax_exemption_reason: None,
            fiscal_document_profile: Some("service_fee".to_string()),
            line_kind: Some(FiscalLineKind::ServiceFee),
            participates_in_discount_allocation: Some(false),
        });
    }
    if tip_amount > 0.0 {
        lines.push(FiscalTaxLineInput {
            id: Some("tip".to_string()),
            description: Some("Tip".to_string()),
            quantity: Some(1.0),
            unit_price: tip_amount,
            vat_category_code: Some(GREECE_TIP_VAT_CATEGORY_CODE.to_string()),
            price_includes_vat: Some(true),
            tax_exemption_reason: Some("tip".to_string()),
            fiscal_document_profile: Some("tip".to_string()),
            line_kind: Some(FiscalLineKind::Tip),
            participates_in_discount_allocation: Some(false),
        });
    }
    lines
}

/// `calculateGreeceOrderVat`.
pub fn calculate_greece_order_vat(input: &GreeceOrderVatInput) -> GreeceOrderVatResult {
    let (_, region) = input.settings.normalized();
    // The server caps the order discount at the items' subtotal before the
    // breakdown caps it again at the lines that can carry it.
    let mut subtotal = 0.0_f64;
    for item in &input.items {
        subtotal += item.quantity * item.unit_price;
    }
    let subtotal = f64::max(0.0, subtotal);
    let discount_amount = f64::min(
        f64::max(0.0, finite_or_zero(input.discount_amount)),
        subtotal,
    );
    let breakdown = calculate_greece_fiscal_breakdown(
        &build_greece_order_tax_lines(input),
        Some(discount_amount),
        region,
    );
    GreeceOrderVatResult {
        tax_amount_cents: breakdown.total_vat_cents,
        item_line_count: input.items.len(),
        breakdown,
    }
}

/// The VAT that sits on top of an order's subtotal.
///
/// Every price is VAT-inclusive in this release (the server serves
/// `tax.tax_inclusive` true and refuses exclusive pricing), so nothing is
/// added on top: the stored `tax_amount` is the VAT already inside the total.
/// Every till formula that used to add `tax_amount` to a subtotal (a missing
/// total, the missing-tip inference, a fallback subtotal) goes through here
/// instead of reading the stored VAT.
pub(crate) fn vat_added_on_top_of_subtotal(_stored_vat_amount: f64) -> f64 {
    0.0
}

/// The branch VAT settings as the till holds them. A missing value is the
/// server's own default (`gr_standard_24`, `mainland`).
pub fn branch_vat_settings(conn: &Connection) -> GreeceVatSettings {
    let read = |key: &str| {
        crate::db::get_setting(conn, VAT_SETTINGS_CATEGORY, key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    GreeceVatSettings {
        default_vat_category_code: read(VAT_DEFAULT_CATEGORY_SETTING_KEY),
        vat_region_profile: read(VAT_REGION_PROFILE_SETTING_KEY),
    }
}

/// `preferCents` of the server's order route: an integer `<key>_cents`
/// sibling wins over the float.
fn body_money(body: &Value, key: &str) -> Option<f64> {
    let cents = body
        .get(format!("{key}_cents").as_str())
        .filter(|value| !value.is_null())
        .and_then(Value::as_f64);
    if let Some(cents) = cents {
        return Some(cents / 100.0);
    }
    body.get(key)
        .filter(|value| !value.is_null())
        .and_then(Value::as_f64)
}

fn body_text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// The total order discount `computeOrderTotals` derives from an order body:
/// the manual discount (fixed, percentage or plain amount) capped at the
/// items' subtotal, then the coupon capped at what is left.
fn server_total_discount(body: &Value, subtotal: f64) -> f64 {
    let finite = |value: Option<f64>| value.filter(|value| value.is_finite());
    let mut manual = finite(body_money(body, "discount_amount")).unwrap_or(0.0);
    let percentage = finite(body.get("discount_percentage").and_then(Value::as_f64));
    let mode = body
        .get("manual_discount_mode")
        .and_then(Value::as_str)
        .map(str::to_string);
    let value = body_money(body, "manual_discount_value");

    match mode.as_deref() {
        Some("fixed") => {
            let fixed = value.unwrap_or(manual);
            // The server refuses an invalid fixed discount; the till keeps no
            // discount for it rather than inventing one.
            manual = if fixed.is_finite() && fixed >= 0.0 {
                f64::min(fixed, subtotal)
            } else {
                0.0
            };
        }
        Some("percentage") => {
            let requested = value.or(percentage).unwrap_or(0.0);
            manual = if requested.is_finite() && requested >= 0.0 {
                let bounded = f64::min(requested, 100.0);
                f64::min(subtotal, subtotal * (bounded / 100.0))
            } else {
                0.0
            };
        }
        _ => {
            manual = f64::min(f64::max(0.0, manual), subtotal);
        }
    }

    let coupon_raw = finite(body_money(body, "coupon_discount_amount")).unwrap_or(0.0);
    let subtotal_after_manual = f64::max(0.0, subtotal - manual);
    let coupon = f64::min(f64::max(0.0, coupon_raw), subtotal_after_manual);
    f64::min(subtotal, manual + coupon)
}

/// The VAT the server computes for an order body shaped like the till's
/// `POST /api/pos/orders` request (`sync_queue::build_order_insert_body`):
/// the same items, the same discount derivation and the same fees, with the
/// branch VAT settings the till holds.
pub fn calculate_order_vat_from_order_body(
    body: &Value,
    settings: &GreeceVatSettings,
) -> GreeceOrderVatResult {
    let items: Vec<GreeceOrderVatItem> = body
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| GreeceOrderVatItem {
                    menu_item_id: body_text(item, "menu_item_id"),
                    name: body_text(item, "name"),
                    quantity: item.get("quantity").and_then(Value::as_f64).unwrap_or(1.0),
                    unit_price: item
                        .get("unit_price")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                    vat_category_code: body_text(item, "vat_category_code"),
                    price_includes_vat: item.get("price_includes_vat").and_then(Value::as_bool),
                    tax_exemption_reason: body_text(item, "tax_exemption_reason"),
                    fiscal_document_profile: body_text(item, "fiscal_document_profile"),
                })
                .collect()
        })
        .unwrap_or_default();
    let mut subtotal = 0.0_f64;
    for item in &items {
        subtotal += item.quantity * item.unit_price;
    }
    let subtotal = f64::max(0.0, subtotal);
    let discount_amount = server_total_discount(body, subtotal);
    calculate_greece_order_vat(&GreeceOrderVatInput {
        settings: settings.clone(),
        items,
        discount_amount: Some(discount_amount),
        delivery_fee: body_money(body, "delivery_fee"),
        service_fee: body_money(body, "service_fee"),
        tip_amount: body_money(body, "tip_amount"),
    })
}

/// The server's VAT for an order snapshot it returned (an ACK `data`, a
/// pulled row): its own cents when present, else its amount in cents.
pub(crate) fn server_order_vat_cents(order: &Value) -> Option<i64> {
    let cents = order
        .get("tax_amount_cents")
        .or_else(|| order.get("taxAmountCents"))
        .filter(|value| !value.is_null())
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().filter(|n| n.is_finite()).map(js_round_cents))
        });
    cents
        .or_else(|| {
            order
                .get("tax_amount")
                .or_else(|| order.get("taxAmount"))
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .map(|value| crate::money::Cents::round_half_even(value).as_i64())
        })
        .filter(|cents| *cents >= 0)
}

fn js_round_cents(value: f64) -> i64 {
    js_round(value) as i64
}

/// The server's total for an order snapshot it returned, in cents.
fn server_order_total_cents(order: &Value) -> Option<i64> {
    order
        .get("total_amount_cents")
        .or_else(|| order.get("totalAmountCents"))
        .filter(|value| !value.is_null())
        .and_then(Value::as_i64)
        .or_else(|| {
            order
                .get("total_amount")
                .or_else(|| order.get("totalAmount"))
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .map(|value| crate::money::Cents::round_half_even(value).as_i64())
        })
}

fn local_order_total_cents(conn: &Connection, local_order_id: &str) -> Option<i64> {
    conn.query_row(
        "SELECT COALESCE(total_amount_cents, CAST(ROUND(COALESCE(total_amount, 0) * 100) AS INTEGER))
         FROM orders WHERE id = ?1",
        [local_order_id],
        |row| row.get::<_, i64>(0),
    )
    .ok()
}

/// Store a VAT on a local order, both columns, only when it differs (an
/// unchanged value fires no `UPDATE OF tax_amount` trigger). Returns whether
/// the row changed. This is the till's bookkeeping of the order's VAT: it
/// moves no money, bumps no version and queues nothing.
pub(crate) fn store_local_order_vat(
    conn: &Connection,
    local_order_id: &str,
    vat_cents: i64,
) -> Result<bool, String> {
    let vat_cents = vat_cents.max(0);
    let changed = conn
        .execute(
            "UPDATE orders
             SET tax_amount = ?1, tax_amount_cents = ?2
             WHERE id = ?3
               AND (tax_amount_cents IS NULL OR tax_amount_cents != ?2
                    OR tax_amount IS NULL OR ABS(tax_amount - ?1) > 0.000001)",
            rusqlite::params![vat_cents as f64 / 100.0, vat_cents, local_order_id],
        )
        .map_err(|error| format!("store local order VAT: {error}"))?;
    Ok(changed > 0)
}

/// Recompute a local order's VAT from its own row, as the server would for
/// the same order, and store it. Used after a local edit rewrote the items or
/// the order's money without a server quote. Returns the VAT in cents.
pub(crate) fn refresh_local_order_vat(
    conn: &Connection,
    local_order_id: &str,
) -> Result<i64, String> {
    let vat = crate::sync_queue::order_insert_vat(conn, local_order_id, &Value::Null)?;
    store_local_order_vat(conn, local_order_id, vat.tax_amount_cents)?;
    Ok(vat.tax_amount_cents)
}

/// Adopt the VAT the server stored for this order, when its snapshot carries
/// one and is about the same money: its total equals the local total within
/// the cent the server tolerates. A refused write (the outstanding-collection
/// guard) leaves the till's own computation in place. Returns whether the
/// stored VAT changed.
pub(crate) fn adopt_server_order_vat(
    conn: &Connection,
    local_order_id: &str,
    server_order: &Value,
) -> bool {
    let Some(server_vat_cents) = server_order_vat_cents(server_order) else {
        return false;
    };
    let Some(server_total_cents) = server_order_total_cents(server_order) else {
        return false;
    };
    let Some(local_total_cents) = local_order_total_cents(conn, local_order_id) else {
        return false;
    };
    if (server_total_cents - local_total_cents).abs() > 1 {
        return false;
    }
    match store_local_order_vat(conn, local_order_id, server_vat_cents) {
        Ok(changed) => changed,
        Err(error) => {
            tracing::warn!(
                order_id = %local_order_id,
                error = %error,
                "Server order VAT not adopted; the till's own computation stays"
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ORDER_VAT_VECTORS: &str =
        include_str!("../../../../shared/services/__fixtures__/greece-order-vat-vectors.json");

    fn vector_input(input: &Value) -> GreeceOrderVatInput {
        let text =
            |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        GreeceOrderVatInput {
            settings: GreeceVatSettings {
                default_vat_category_code: text(input, "defaultVatCategoryCode"),
                vat_region_profile: text(input, "vatRegionProfile"),
            },
            items: input["items"]
                .as_array()
                .expect("vector items")
                .iter()
                .map(|item| GreeceOrderVatItem {
                    menu_item_id: text(item, "menuItemId"),
                    name: text(item, "name"),
                    quantity: item["quantity"].as_f64().expect("vector quantity"),
                    unit_price: item["unitPrice"].as_f64().expect("vector unit price"),
                    vat_category_code: text(item, "vatCategoryCode"),
                    price_includes_vat: item.get("priceIncludesVat").and_then(Value::as_bool),
                    tax_exemption_reason: text(item, "taxExemptionReason"),
                    fiscal_document_profile: text(item, "fiscalDocumentProfile"),
                })
                .collect(),
            discount_amount: input.get("discountAmount").and_then(Value::as_f64),
            delivery_fee: input.get("deliveryFee").and_then(Value::as_f64),
            service_fee: input.get("serviceFee").and_then(Value::as_f64),
            tip_amount: input.get("tipAmount").and_then(Value::as_f64),
        }
    }

    fn rate_json(rate: f64) -> Value {
        // The vectors spell whole rates as integers (24, not 24.0).
        if rate.fract() == 0.0 {
            json!(rate as i64)
        } else {
            json!(rate)
        }
    }

    #[test]
    fn port_reproduces_every_shared_order_vat_vector() {
        let vectors: Value = serde_json::from_str(ORDER_VAT_VECTORS).expect("vectors parse");
        let cases = vectors["cases"].as_array().expect("vector cases");
        assert_eq!(cases.len(), 23, "the frozen vector set has 23 cases");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let input = vector_input(&case["input"]);
            let expected = &case["expected"];
            let result = calculate_greece_order_vat(&input);
            let breakdown = &result.breakdown;

            assert_eq!(
                result.item_line_count,
                input.items.len(),
                "{name}: item lines"
            );
            assert_eq!(
                result.tax_amount_cents,
                expected["taxAmountCents"].as_i64().unwrap(),
                "{name}: taxAmountCents"
            );
            for (field, actual) in [
                ("totalGrossCents", breakdown.total_gross_cents),
                ("totalNetCents", breakdown.total_net_cents),
                ("totalVatCents", breakdown.total_vat_cents),
                ("totalDiscountCents", breakdown.total_discount_cents),
            ] {
                assert_eq!(actual, expected[field].as_i64().unwrap(), "{name}: {field}");
            }
            let lines: Vec<Value> = breakdown
                .lines
                .iter()
                .map(|line| {
                    json!({
                        "id": line.id,
                        "lineKind": line.line_kind.as_str(),
                        "vatCategoryCode": line.vat_category_code,
                        "vatRate": rate_json(line.vat_rate),
                        "grossCents": line.gross_cents,
                        "netCents": line.net_cents,
                        "vatCents": line.vat_cents,
                        "discountCents": line.discount_cents,
                    })
                })
                .collect();
            assert_eq!(Value::Array(lines), expected["lines"], "{name}: lines");
            let buckets: Vec<Value> = breakdown
                .tax_breakdown
                .iter()
                .map(|bucket| {
                    json!({
                        "vatCategoryCode": bucket.vat_category_code,
                        "vatRate": rate_json(bucket.vat_rate),
                        "grossCents": bucket.gross_cents,
                        "netCents": bucket.net_cents,
                        "vatCents": bucket.vat_cents,
                        "discountCents": bucket.discount_cents,
                        "lineCount": bucket.line_count,
                    })
                })
                .collect();
            assert_eq!(
                Value::Array(buckets),
                expected["taxBreakdown"],
                "{name}: buckets"
            );
        }
    }

    #[test]
    fn js_round_matches_javascript_math_round() {
        for (value, expected) in [
            (2.5, 3.0),
            (-2.5, -2.0),
            (0.49999999999999994, 0.0),
            (1.5, 2.0),
            (-0.5, 0.0),
            (1048.3870967741937, 1048.0),
            (100.49999999999999, 100.0),
        ] {
            assert_eq!(js_round(value), expected, "Math.round({value})");
        }
    }

    #[test]
    fn order_body_vat_reads_the_server_discount_and_cents_siblings() {
        let settings = GreeceVatSettings::default();
        let body = json!({
            "items": [
                {"menu_item_id": "a", "name": "A", "quantity": 1, "unit_price": 10.0},
                {"menu_item_id": null, "name": "B", "quantity": 2, "unit_price": 5.0}
            ],
            // The integer cents sibling wins, as the server's preferCents.
            "discount_amount": 9.99,
            "discount_amount_cents": 200,
            "manual_discount_mode": null,
            "coupon_discount_amount": 1.0,
            "coupon_discount_amount_cents": 100,
            "delivery_fee": 2.5,
            "delivery_fee_cents": 250,
            "tip_amount": 1.0,
            "tip_amount_cents": 100,
            "tax_amount": 999.0,
        });
        let result = calculate_order_vat_from_order_body(&body, &settings);
        let same = calculate_greece_order_vat(&GreeceOrderVatInput {
            settings: settings.clone(),
            items: vec![
                GreeceOrderVatItem {
                    menu_item_id: Some("a".into()),
                    name: Some("A".into()),
                    quantity: 1.0,
                    unit_price: 10.0,
                    ..Default::default()
                },
                GreeceOrderVatItem {
                    name: Some("B".into()),
                    quantity: 2.0,
                    unit_price: 5.0,
                    ..Default::default()
                },
            ],
            discount_amount: Some(3.0),
            delivery_fee: Some(2.5),
            service_fee: None,
            tip_amount: Some(1.0),
        });
        assert_eq!(result, same);
        assert_eq!(result.breakdown.total_discount_cents, 300);
        assert_eq!(
            result.breakdown.lines[1].line_kind,
            FiscalLineKind::ManualItem
        );

        // Percentage mode: 10% of the 20.00 subtotal, coupon on what is left.
        let percentage = json!({
            "items": [{"menu_item_id": "a", "quantity": 2, "unit_price": 10.0}],
            "manual_discount_mode": "percentage",
            "manual_discount_value": 10.0,
            "discount_amount_cents": 0,
            "coupon_discount_amount_cents": 5000,
        });
        let result = calculate_order_vat_from_order_body(&percentage, &settings);
        assert_eq!(
            result.breakdown.total_discount_cents, 2000,
            "capped at subtotal"
        );
        assert_eq!(result.tax_amount_cents, 0);

        let fixed = json!({
            "items": [{"menu_item_id": "a", "quantity": 1, "unit_price": 12.4}],
            "manual_discount_mode": "fixed",
            "manual_discount_value": 1.24,
            "discount_amount": 0,
        });
        let result = calculate_order_vat_from_order_body(&fixed, &settings);
        assert_eq!(result.breakdown.total_discount_cents, 124);
        // 11.16 inclusive at 24%: net 9.00, VAT 2.16.
        assert_eq!(result.tax_amount_cents, 216);
    }

    #[test]
    fn island_settings_change_the_default_category() {
        let body = json!({"items": [{"menu_item_id": "a", "quantity": 1, "unit_price": 11.7}]});
        let islands = GreeceVatSettings {
            default_vat_category_code: Some("gr_island_reduced_17".into()),
            vat_region_profile: Some("islands_reduced".into()),
        };
        let result = calculate_order_vat_from_order_body(&body, &islands);
        assert_eq!(result.breakdown.lines[0].vat_rate, 17.0);
        assert_eq!(result.tax_amount_cents, 170);
        let mainland = calculate_order_vat_from_order_body(&body, &GreeceVatSettings::default());
        assert_eq!(mainland.breakdown.lines[0].vat_rate, 24.0);
    }

    #[test]
    fn server_order_vat_prefers_its_own_cents() {
        assert_eq!(
            server_order_vat_cents(&json!({"tax_amount": 4.37, "tax_amount_cents": 437})),
            Some(437)
        );
        assert_eq!(
            server_order_vat_cents(&json!({"tax_amount": 4.37})),
            Some(437)
        );
        assert_eq!(
            server_order_vat_cents(&json!({"taxAmount": 2.52})),
            Some(252)
        );
        assert_eq!(server_order_vat_cents(&json!({"total_amount": 10})), None);
        assert_eq!(server_order_vat_cents(&json!({"tax_amount": null})), None);
    }

    #[test]
    fn inclusive_prices_add_no_vat_on_top() {
        assert_eq!(vat_added_on_top_of_subtotal(4.37), 0.0);
        assert_eq!(vat_added_on_top_of_subtotal(0.0), 0.0);
    }
}
