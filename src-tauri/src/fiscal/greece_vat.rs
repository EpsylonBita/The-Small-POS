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
use std::{collections::BTreeMap, sync::OnceLock};

/// The branch default category the server assumes without a compliance row.
pub const GREECE_DEFAULT_VAT_CATEGORY_CODE: &str = "gr_standard_24";
/// The region profile the server assumes without a compliance row.
pub const GREECE_DEFAULT_VAT_REGION_PROFILE: &str = "mainland";
/// In Greece a delivery fee carries the reduced 13% rate.
pub const GREECE_DELIVERY_FEE_VAT_CATEGORY_CODE: &str = "gr_reduced_13";
/// A tip is outside the scope of VAT.
pub const GREECE_TIP_VAT_CATEGORY_CODE: &str = "gr_out_of_scope";
/// The Swiss category an unknown or missing Swiss code falls back to
/// (`SWISS_DEFAULT_VAT_CATEGORY_CODE`).
pub const SWISS_DEFAULT_VAT_CATEGORY_CODE: &str = "ch_standard_81";
/// A tip in a Swiss branch is outside the scope of VAT.
pub const SWISS_TIP_VAT_CATEGORY_CODE: &str = "ch_out_of_scope";
/// An explicit 0% marker, not a fiscal VAT classification of any country:
/// an owner's 0% quote, and every line of a branch that is not VAT-registered.
pub const POS_RECEIPT_ZERO_VAT_CATEGORY: &str = "pos_receipt_zero";

/// Local settings (category `tax`) the server feed fills from the branch's
/// VAT profile (`greece_compliance`).
pub const VAT_SETTINGS_CATEGORY: &str = "tax";
pub const VAT_DEFAULT_CATEGORY_SETTING_KEY: &str = "vat_default_category_code";
pub const VAT_REGION_PROFILE_SETTING_KEY: &str = "vat_region_profile";
/// Any supported store country; Greece when absent or unknown.
pub const VAT_COUNTRY_SETTING_KEY: &str = "vat_country";
/// `true`/`false`; a branch is VAT-registered when the key is absent.
pub const VAT_REGISTERED_SETTING_KEY: &str = "vat_registered";

/// The Swiss catalogue of `GreeceVatService.ts` (MWST/TVA since 01/01/2024).
const SWISS_VAT_CATEGORIES: [(&str, f64); 5] = [
    ("ch_standard_81", 8.1),
    ("ch_reduced_26", 2.6),
    ("ch_accommodation_38", 3.8),
    ("ch_out_of_scope", 0.0),
    ("ch_exempt_platform", 0.0),
];

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

/// The country whose VAT a branch is set up for (`VatCountryCode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VatCountry {
    #[default]
    Greece,
    Switzerland,
    Generic(&'static str),
}

/// Generated from the shared country presets. Its keys are every store
/// country except GR/CH, which retain their dedicated catalogues.
fn generic_country_defaults() -> &'static BTreeMap<String, String> {
    static DEFAULTS: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    DEFAULTS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../shared/services/vat-country-standard-codes.generated.json"
        ))
        .expect("generated VAT country defaults parse")
    })
}

impl VatCountry {
    /// `normalizeVatCountry`: store ISO-2 codes in any case, else Greece.
    pub fn from_setting(raw: Option<&str>) -> Self {
        let code = raw.unwrap_or("").trim().to_uppercase();
        match code.as_str() {
            "GR" => Self::Greece,
            "CH" => Self::Switzerland,
            _ => generic_country_defaults()
                .get_key_value(&code)
                .map_or(Self::Greece, |(country, _)| Self::Generic(country)),
        }
    }

    /// The ISO code the server stores (`orders.country_code`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Greece => "GR",
            Self::Switzerland => "CH",
            Self::Generic(country) => country,
        }
    }

    /// The branch default when the till holds none, or a foreign one.
    fn default_category(self) -> &'static str {
        match self {
            Self::Greece => GREECE_DEFAULT_VAT_CATEGORY_CODE,
            Self::Switzerland => SWISS_DEFAULT_VAT_CATEGORY_CODE,
            Self::Generic(country) => &generic_country_defaults()[country],
        }
    }

    fn tip_category(self) -> String {
        match self {
            Self::Greece => GREECE_TIP_VAT_CATEGORY_CODE.into(),
            Self::Switzerland => SWISS_TIP_VAT_CATEGORY_CODE.into(),
            Self::Generic(country) => format!("{}_out_of_scope", country.to_lowercase()),
        }
    }
}

/// Exact shared grammar: two lowercase ASCII letters, then out_of_scope or
/// vat plus one/two whole digits and optionally one/two fractional digits.
fn parse_generic_vat_category_code(code: &str) -> Option<(VatCountry, f64)> {
    let bytes = code.as_bytes();
    if bytes.len() < 4 || !bytes[..2].iter().all(u8::is_ascii_lowercase) || bytes[2] != b'_' {
        return None;
    }
    let country = VatCountry::from_setting(Some(&code[..2]));
    if !matches!(country, VatCountry::Generic(_)) {
        return None;
    }
    let suffix = &code[3..];
    if suffix == "out_of_scope" {
        return Some((country, 0.0));
    }
    let mut parts = suffix.strip_prefix("vat_")?.split('_');
    let whole = parts.next()?;
    let fraction = parts.next();
    let digits = |part: &str| {
        (1..=2).contains(&part.len()) && part.as_bytes().iter().all(u8::is_ascii_digit)
    };
    if !digits(whole) || fraction.is_some_and(|part| !digits(part)) || parts.next().is_some() {
        return None;
    }
    let rate = match fraction {
        Some(fraction) => format!("{whole}.{fraction}"),
        None => whole.to_string(),
    }
    .parse::<f64>()
    .ok()?;
    (rate <= 100.0).then_some((country, rate))
}

/// `vatCategoryCountry`: the country a category code belongs to, `None` for
/// the `pos_receipt_zero` marker, unknown codes and a missing code.
pub fn vat_category_country(code: Option<&str>) -> Option<VatCountry> {
    let code = code.filter(|code| !code.is_empty())?;
    if SWISS_VAT_CATEGORIES
        .iter()
        .any(|(candidate, _)| *candidate == code)
    {
        Some(VatCountry::Switzerland)
    } else if GREECE_VAT_CATEGORIES
        .iter()
        .any(|(candidate, _)| *candidate == code)
    {
        Some(VatCountry::Greece)
    } else {
        parse_generic_vat_category_code(code).map(|(country, _)| country)
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

/// `resolveSwissVatCategory`: a known Swiss code, else `ch_standard_81`.
pub fn resolve_swiss_vat_category(code: Option<&str>) -> (&'static str, f64) {
    code.and_then(|code| {
        SWISS_VAT_CATEGORIES
            .iter()
            .find(|(candidate, _)| *candidate == code)
    })
    .or_else(|| {
        SWISS_VAT_CATEGORIES
            .iter()
            .find(|(candidate, _)| *candidate == SWISS_DEFAULT_VAT_CATEGORY_CODE)
    })
    .map(|(candidate, rate)| (*candidate, *rate))
    .unwrap_or((SWISS_DEFAULT_VAT_CATEGORY_CODE, 8.1))
}

/// `resolveVatCategoryRate`: the code and rate of a line's category in a
/// branch of `country`; `pos_receipt_zero` is 0% in every country.
pub fn resolve_vat_category_rate(
    code: Option<&str>,
    country: VatCountry,
    region: VatRegionProfile,
) -> (&str, f64) {
    if code == Some(POS_RECEIPT_ZERO_VAT_CATEGORY) {
        return (POS_RECEIPT_ZERO_VAT_CATEGORY, 0.0);
    }
    match country {
        VatCountry::Switzerland => resolve_swiss_vat_category(code),
        VatCountry::Greece => resolve_greece_vat_category(code, region),
        VatCountry::Generic(_) => {
            if let Some((own_country, rate)) = code.and_then(parse_generic_vat_category_code) {
                if own_country == country {
                    return (code.unwrap(), rate);
                }
            }
            let fallback = country.default_category();
            (
                fallback,
                parse_generic_vat_category_code(fallback).map_or(0.0, |(_, rate)| rate),
            )
        }
    }
}

/// `serviceSaleGrossPrice`: a net catalogue service sells VAT-inclusive.
/// Keep the operation order identical to TS, including tenths of a percent
/// (Swiss 2.6% is 26) and rounding the catalogue price to cents first.
#[allow(dead_code)] // Native mirror; service carts currently convert through shared TS.
pub fn service_sale_gross_price(
    catalog_price: f64,
    own_code: Option<&str>,
    price_includes_vat: Option<bool>,
    defaults: &GreeceVatSettings,
) -> f64 {
    if price_includes_vat != Some(false) || !catalog_price.is_finite() || catalog_price < 0.0 {
        return catalog_price;
    }
    let country = VatCountry::from_setting(defaults.country.as_deref());
    let branch_default = trimmed_text(defaults.default_vat_category_code.as_deref())
        .unwrap_or(country.default_category());
    let own = trimmed_text(own_code);
    let own_country = vat_category_country(own);
    let code = match own {
        Some(code) if own_country.is_none() || own_country == Some(country) => code,
        _ => branch_default,
    };
    let rate = if defaults.vat_registered == Some(false) {
        0.0
    } else {
        resolve_vat_category_rate(
            Some(code),
            country,
            VatRegionProfile::from_setting(defaults.vat_region_profile.as_deref()),
        )
        .1
    };
    let scaled = js_round(catalog_price * 100.0) * (1000.0 + js_round(rate * 10.0));
    js_round(scaled / 1000.0) / 100.0
}

/// One `FiscalTaxLineInput`.
#[derive(Debug, Clone, Default)]
pub struct FiscalTaxLineInput {
    pub line_role: Option<String>,
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
    pub vat_category_code: String,
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
    pub vat_category_code: String,
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

/// `calculateGreeceFiscalBreakdown`: country-specific codes and shared rounding.
pub fn calculate_greece_fiscal_breakdown(
    lines: &[FiscalTaxLineInput],
    order_discount_amount: Option<f64>,
    region: VatRegionProfile,
    country: VatCountry,
) -> GreeceFiscalBreakdown {
    struct Normalized {
        id: String,
        description: Option<String>,
        quantity: f64,
        line_kind: FiscalLineKind,
        vat_category_code: String,
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
                resolve_vat_category_rate(line.vat_category_code.as_deref(), country, region);
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
                vat_category_code: vat_category_code.to_string(),
                vat_rate,
                price_includes_vat: line.price_includes_vat != Some(false),
                tax_exemption_reason: line.tax_exemption_reason.clone(),
                fiscal_document_profile: line.fiscal_document_profile.clone(),
                original_gross_cents,
                participates_in_discount_allocation: line.line_role.as_deref() != Some("deposit")
                    && line.participates_in_discount_allocation.unwrap_or(
                        vat_rate > 0.0
                            || line.vat_category_code.as_deref().is_some_and(|code| {
                                code == POS_RECEIPT_ZERO_VAT_CATEGORY
                                    || code == "ch_exempt_platform"
                                    || (code.len() == 8
                                        && code.as_bytes()[..2].iter().all(u8::is_ascii_lowercase)
                                        && &code[2..] == "_vat_0")
                            }),
                    ),
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
            vat_category_code: line.vat_category_code.clone(),
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
    pub vat_class: Option<String>,
    pub line_role: Option<String>,
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
/// `tax.vat_region_profile`, `tax.vat_country`, `tax.vat_registered`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GreeceVatSettings {
    pub channel_defaults: Value,
    pub class_category_codes: Value,
    pub platform_vat_opt_in: Value,
    pub charges_vat_mode: Option<String>,
    pub delivery_fee_vat_category_code: Option<String>,
    pub tips_outside_vat: Option<bool>,
    pub default_vat_category_code: Option<String>,
    pub vat_region_profile: Option<String>,
    /// Any supported store country; Greece when absent or unknown.
    pub country: Option<String>,
    /// `Some(false)` for a branch that is not VAT-registered; registered
    /// when absent.
    pub vat_registered: Option<bool>,
}

/// `NormalizedOrderVatSettings`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedVatSettings {
    /// The branch default as the lines use it: `pos_receipt_zero` when not
    /// VAT-registered.
    pub default_vat_category_code: String,
    pub vat_region_profile: VatRegionProfile,
    pub country: VatCountry,
    pub vat_registered: bool,
}

/// `OrderVatLinePolicy`: the category every kind of order line takes in one
/// branch. Every till surface that computes an order's VAT (insert, local
/// edit, receipt payload, register lines) goes through it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderVatLinePolicy {
    pub class_category_codes: Value,
    pub sale_channel: Option<String>,
    pub delivery_fee_follows_lines: bool,
    pub service_fee_follows_lines: bool,
    pub tip_follows_lines: bool,
    pub settings: NormalizedVatSettings,
    pub delivery_fee_category: String,
    pub service_fee_category: String,
    pub tip_category: String,
}

/// `text` of the shared calculator: a trimmed, non-empty string.
fn trimmed_text(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

impl GreeceVatSettings {
    /// `normalizeGreeceOrderVatSettings`.
    pub fn normalized(&self) -> NormalizedVatSettings {
        let country = VatCountry::from_setting(self.country.as_deref());
        let vat_registered = self.vat_registered != Some(false);
        let code = trimmed_text(self.default_vat_category_code.as_deref());
        let code_country = vat_category_country(code);
        let default_vat_category_code = if !vat_registered {
            POS_RECEIPT_ZERO_VAT_CATEGORY
        } else {
            match code {
                Some(code) if code_country.is_none() || code_country == Some(country) => code,
                _ => country.default_category(),
            }
        };
        NormalizedVatSettings {
            default_vat_category_code: default_vat_category_code.to_string(),
            vat_region_profile: VatRegionProfile::from_setting(self.vat_region_profile.as_deref()),
            country,
            vat_registered,
        }
    }

    pub fn line_policy(&self) -> OrderVatLinePolicy {
        self.line_policy_for(None, None)
    }

    pub fn line_policy_for(
        &self,
        order_type: Option<&str>,
        platform: Option<&str>,
    ) -> OrderVatLinePolicy {
        let mut settings = self.normalized();
        let mut sale_channel = normalize_vat_sale_channel(order_type, platform).map(str::to_string);
        if sale_channel.as_deref() == Some("platform")
            && platform.is_some_and(|p| {
                self.platform_vat_opt_in
                    .get(p.trim().to_lowercase())
                    .and_then(Value::as_bool)
                    == Some(true)
            })
        {
            let kind = normalized_order_type(order_type);
            sale_channel = Some(
                if matches!(kind.as_str(), "pickup" | "takeaway" | "take_away") {
                    "takeaway"
                } else {
                    "own_delivery"
                }
                .into(),
            );
        }
        if settings.vat_registered {
            if let Some(code) = sale_channel
                .as_deref()
                .and_then(|channel| channel_code(&self.channel_defaults, channel))
                .and_then(|code| country_code(Some(code), settings.country))
            {
                settings.default_vat_category_code = code.into();
            }
        }
        let explicit_fee = country_code(
            self.delivery_fee_vat_category_code.as_deref(),
            settings.country,
        );
        let follows = settings.vat_registered
            && trimmed_text(self.charges_vat_mode.as_deref()) == Some("follow_lines");
        let delivery_fee_category = if !settings.vat_registered {
            POS_RECEIPT_ZERO_VAT_CATEGORY.to_string()
        } else {
            explicit_fee
                .unwrap_or(match settings.country {
                    VatCountry::Greece => GREECE_DELIVERY_FEE_VAT_CATEGORY_CODE,
                    _ => &settings.default_vat_category_code,
                })
                .to_string()
        };
        OrderVatLinePolicy {
            class_category_codes: self.class_category_codes.clone(),
            sale_channel,
            delivery_fee_follows_lines: follows && explicit_fee.is_none(),
            service_fee_follows_lines: follows,
            tip_follows_lines: settings.vat_registered
                && settings.country == VatCountry::Switzerland
                && self.tips_outside_vat == Some(false),
            service_fee_category: settings.default_vat_category_code.clone(),
            tip_category: settings.country.tip_category(),
            delivery_fee_category,
            settings,
        }
    }
}

fn normalized_order_type(value: Option<&str>) -> String {
    let mut out = String::new();
    let mut separator = false;
    for c in value.unwrap_or("").trim().to_lowercase().chars() {
        if c.is_whitespace() || c == '-' {
            if !separator {
                out.push('_');
            }
            separator = true;
        } else {
            out.push(c);
            separator = false;
        }
    }
    out
}

/// Only the delivery platform column is accepted here, never order source/origin.
pub fn normalize_vat_sale_channel(
    order_type: Option<&str>,
    platform: Option<&str>,
) -> Option<&'static str> {
    if platform.is_some_and(|p| {
        !matches!(
            p.trim().to_lowercase().as_str(),
            "" | "pos" | "web" | "kiosk" | "admin" | "mobile" | "unknown" | "store"
        )
    }) {
        return Some("platform");
    }
    match normalized_order_type(order_type).as_str() {
        "dine_in" | "dinein" | "eat_in" | "table" => Some("dine_in"),
        "pickup" | "takeaway" | "take_away" | "takeout" | "take_out" | "drive_through" => {
            Some("takeaway")
        }
        "delivery" | "own_delivery" => Some("own_delivery"),
        _ => None,
    }
}

fn channel_code<'a>(row: &'a Value, channel: &str) -> Option<&'a str> {
    trimmed_text(row.get(channel).and_then(Value::as_str)).or_else(|| {
        if channel == "own_delivery" {
            trimmed_text(row.get("delivery").and_then(Value::as_str))
        } else {
            None
        }
    })
}
fn country_code(code: Option<&str>, country: VatCountry) -> Option<&str> {
    trimmed_text(code).filter(|code| {
        *code == POS_RECEIPT_ZERO_VAT_CATEGORY || vat_category_country(Some(code)) == Some(country)
    })
}
impl OrderVatLinePolicy {
    pub fn item_category(&self, code: Option<&str>) -> String {
        self.item_class_category(code, None)
    }
    pub fn item_class_category(&self, code: Option<&str>, class: Option<&str>) -> String {
        if !self.settings.vat_registered {
            return POS_RECEIPT_ZERO_VAT_CATEGORY.into();
        }
        if let Some(own) = trimmed_text(code).filter(|own| {
            vat_category_country(Some(own)).map_or(true, |c| c == self.settings.country)
        }) {
            return own.into();
        }
        let class = class.unwrap_or("standard").trim().to_lowercase();
        if matches!(
            class.as_str(),
            "food"
                | "non_alcoholic_drink"
                | "plain_water"
                | "alcoholic_drink"
                | "basic_grocery"
                | "general_goods"
                | "tobacco"
                | "hairdressing_beauty"
                | "accommodation"
                | "small_repair"
                | "general_repair"
        ) {
            let row = &self.class_category_codes[&class];
            let code = self
                .sale_channel
                .as_deref()
                .and_then(|c| channel_code(row, c))
                .or_else(|| channel_code(row, "default"));
            if let Some(code) = country_code(code, self.settings.country) {
                return code.into();
            }
        }
        self.settings.default_vat_category_code.clone()
    }
}

/// `GreeceOrderVatInput`.
#[derive(Debug, Clone, Default)]
pub struct GreeceOrderVatInput {
    pub order_type: Option<String>,
    pub platform: Option<String>,
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
    pub fn tax_breakdown_json(&self) -> Value {
        Value::Array(self.breakdown.tax_breakdown.iter().map(|b| serde_json::json!({
            "vatCategoryCode": b.vat_category_code, "vatRate": b.vat_rate,
            "grossAmount": b.gross_cents as f64 / 100.0, "netAmount": b.net_cents as f64 / 100.0,
            "vatAmount": b.vat_cents as f64 / 100.0, "discountAmount": b.discount_cents as f64 / 100.0, "lineCount": b.line_count,
        })).collect())
    }

    /// The order's VAT as the server stores `orders.tax_amount`.
    pub fn tax_amount(&self) -> f64 {
        self.tax_amount_cents as f64 / 100.0
    }
}

/// `buildGreeceOrderTaxLines`.
pub fn build_greece_order_tax_lines(input: &GreeceOrderVatInput) -> Vec<FiscalTaxLineInput> {
    let policy = input
        .settings
        .line_policy_for(input.order_type.as_deref(), input.platform.as_deref());
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
                line_role: item.line_role.clone(),
                id: Some(
                    menu_item_id
                        .clone()
                        .unwrap_or_else(|| format!("manual-item-{}", index + 1)),
                ),
                description: item.name.clone().filter(|name| !name.is_empty()),
                quantity: Some(item.quantity),
                unit_price: item.unit_price,
                vat_category_code: Some(policy.item_class_category(
                    item.vat_category_code.as_deref(),
                    item.vat_class.as_deref(),
                )),
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

    let needs_split = (delivery_fee > 0.0 && policy.delivery_fee_follows_lines)
        || (service_fee > 0.0 && policy.service_fee_follows_lines)
        || (tip_amount > 0.0 && policy.tip_follows_lines);
    let item_breakdown = if needs_split {
        let subtotal = input
            .items
            .iter()
            .filter(|i| i.line_role.as_deref() != Some("deposit"))
            .map(|i| i.quantity * i.unit_price)
            .sum::<f64>()
            .max(0.0);
        calculate_greece_fiscal_breakdown(
            &lines,
            Some(finite_or_zero(input.discount_amount).max(0.0).min(subtotal)),
            policy.settings.vat_region_profile,
            policy.settings.country,
        )
        .lines
        .into_iter()
        .zip(&input.items)
        .filter(|(_, item)| item.line_role.as_deref() != Some("deposit"))
        .map(|(line, _)| line)
        .collect::<Vec<_>>()
    } else {
        vec![]
    };
    for (amount, id, description, kind, fixed, follows) in [
        (
            delivery_fee,
            "delivery-fee",
            "Delivery Fee",
            FiscalLineKind::DeliveryFee,
            policy.delivery_fee_category.as_str(),
            policy.delivery_fee_follows_lines,
        ),
        (
            service_fee,
            "service-fee",
            "Service Fee",
            FiscalLineKind::ServiceFee,
            policy.service_fee_category.as_str(),
            policy.service_fee_follows_lines,
        ),
        (
            tip_amount,
            "tip",
            "Tip",
            FiscalLineKind::Tip,
            policy.tip_category.as_str(),
            policy.tip_follows_lines,
        ),
    ] {
        if amount <= 0.0 {
            continue;
        }
        let parts = if follows {
            split_charge_over_lines(
                js_round(amount * 100.0) as i64,
                &item_breakdown,
                &policy.settings.default_vat_category_code,
            )
        } else {
            vec![(fixed.to_string(), js_round(amount * 100.0) as i64)]
        };
        let count = parts.len();
        for (index, (code, cents)) in parts.into_iter().enumerate() {
            lines.push(FiscalTaxLineInput {
                id: Some(if count == 1 {
                    id.into()
                } else {
                    format!("{id}-{}", index + 1)
                }),
                description: Some(description.into()),
                quantity: Some(1.0),
                unit_price: if follows {
                    cents as f64 / 100.0
                } else {
                    amount
                },
                vat_category_code: Some(code),
                price_includes_vat: Some(true),
                tax_exemption_reason: (kind == FiscalLineKind::Tip && !follows)
                    .then(|| "tip".into()),
                fiscal_document_profile: Some(kind.as_str().into()),
                line_kind: Some(kind),
                participates_in_discount_allocation: Some(false),
                ..Default::default()
            });
        }
    }
    lines
}

/// Split gross charge cents by discounted item net; largest remainder, earlier category wins ties.
fn split_charge_over_lines(
    cents: i64,
    lines: &[FiscalTaxLine],
    fallback: &str,
) -> Vec<(String, i64)> {
    if cents <= 0 {
        return vec![];
    }
    let mut nets: Vec<(String, i64)> = vec![];
    for line in lines {
        if let Some(row) = nets.iter_mut().find(|r| r.0 == line.vat_category_code) {
            row.1 += line.net_cents.max(0);
        } else {
            nets.push((line.vat_category_code.clone(), line.net_cents.max(0)));
        }
    }
    let total: i64 = nets.iter().map(|r| r.1).sum();
    if total <= 0 {
        return vec![(fallback.into(), cents)];
    }
    let mut parts: Vec<(String, i64, f64)> = nets
        .into_iter()
        .map(|(code, net)| {
            let raw = cents as f64 * net as f64 / total as f64;
            (code, raw.floor() as i64, raw - raw.floor())
        })
        .collect();
    let remaining = cents - parts.iter().map(|r| r.1).sum::<i64>();
    let mut indices: Vec<usize> = (0..parts.len()).collect();
    indices.sort_by(|a, b| parts[*b].2.total_cmp(&parts[*a].2).then(a.cmp(b)));
    for index in indices.into_iter().take(remaining.max(0) as usize) {
        parts[index].1 += 1;
    }
    parts
        .into_iter()
        .filter(|p| p.1 > 0)
        .map(|(code, cents, _)| (code, cents))
        .collect()
}

/// `calculateGreeceOrderVat`.
pub fn calculate_greece_order_vat(input: &GreeceOrderVatInput) -> GreeceOrderVatResult {
    let NormalizedVatSettings {
        vat_region_profile: region,
        country,
        ..
    } = input.settings.normalized();
    // The server caps the order discount at the non-deposit subtotal before the
    // breakdown caps it again at the lines that can carry it.
    let mut subtotal = 0.0_f64;
    for item in input
        .items
        .iter()
        .filter(|item| item.line_role.as_deref() != Some("deposit"))
    {
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
        country,
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

/// A boolean setting as the feed stores it (`true`/`false`, a JSON boolean
/// serialized as text); `None` for a missing or unreadable value.
pub(crate) fn setting_bool(raw: Option<&str>) -> Option<bool> {
    match raw?.trim().to_ascii_lowercase().as_str() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

/// The branch VAT settings as the till holds them. A missing value is the
/// server's own default (`gr_standard_24`, `mainland`, Greece, registered).
pub fn branch_vat_settings(conn: &Connection) -> GreeceVatSettings {
    let read = |key: &str| {
        crate::db::get_setting(conn, VAT_SETTINGS_CATEGORY, key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    GreeceVatSettings {
        default_vat_category_code: read(VAT_DEFAULT_CATEGORY_SETTING_KEY),
        vat_region_profile: read(VAT_REGION_PROFILE_SETTING_KEY),
        country: read(VAT_COUNTRY_SETTING_KEY),
        vat_registered: setting_bool(read(VAT_REGISTERED_SETTING_KEY).as_deref()),
        channel_defaults: serde_json::json!({"dine_in": read("vat_channel_default_dine_in"), "takeaway": read("vat_channel_default_takeaway"), "own_delivery": read("vat_channel_default_delivery"), "platform": read("vat_channel_default_platform")}),
        class_category_codes: read("vat_class_category_codes")
            .and_then(|v| serde_json::from_str::<Value>(&v).ok())
            .filter(Value::is_object)
            .unwrap_or_default(),
        platform_vat_opt_in: read("vat_platform_opt_in")
            .and_then(|v| serde_json::from_str::<Value>(&v).ok())
            .filter(Value::is_object)
            .unwrap_or_default(),
        charges_vat_mode: read("vat_charges_mode"),
        delivery_fee_vat_category_code: read("vat_delivery_fee_category_code"),
        tips_outside_vat: setting_bool(read("vat_tips_outside_vat").as_deref()),
    }
}

/// The branch's VAT country as the order create request names it
/// (`country_code`), `None` while the till holds no `tax.vat_country` (a
/// feed from before 21/10/2026): the request then keeps what it carried and
/// the server applies its own default.
pub fn branch_vat_country_code(conn: &Connection) -> Option<&'static str> {
    crate::db::get_setting(conn, VAT_SETTINGS_CATEGORY, VAT_COUNTRY_SETTING_KEY)
        .filter(|value| !value.trim().is_empty())
        .map(|value| VatCountry::from_setting(Some(&value)).as_str())
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
                    line_role: body_text(item, "line_role"),
                    menu_item_id: body_text(item, "menu_item_id"),
                    name: body_text(item, "name"),
                    quantity: item.get("quantity").and_then(Value::as_f64).unwrap_or(1.0),
                    unit_price: item
                        .get("unit_price")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                    vat_category_code: body_text(item, "vat_category_code"),
                    vat_class: body_text(item, "vat_class").or_else(|| body_text(item, "vatClass")),
                    price_includes_vat: item.get("price_includes_vat").and_then(Value::as_bool),
                    tax_exemption_reason: body_text(item, "tax_exemption_reason"),
                    fiscal_document_profile: body_text(item, "fiscal_document_profile"),
                })
                .collect()
        })
        .unwrap_or_default();
    // A percentage or capped discount is derived from the goods only: deposit
    // lines never carry an order discount (server and shared calculator).
    let mut subtotal = 0.0_f64;
    for item in items
        .iter()
        .filter(|item| item.line_role.as_deref() != Some("deposit"))
    {
        subtotal += item.quantity * item.unit_price;
    }
    let subtotal = f64::max(0.0, subtotal);
    let discount_amount = server_total_discount(body, subtotal);
    calculate_greece_order_vat(&GreeceOrderVatInput {
        settings: settings.clone(),
        order_type: body_text(body, "order_type"),
        platform: body_text(body, "platform").or_else(|| body_text(body, "plugin")),
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

/// Persist the VAT amount and camelCase category buckets together.
pub(crate) fn store_local_order_vat_result(
    conn: &Connection,
    id: &str,
    vat: &GreeceOrderVatResult,
) -> Result<bool, String> {
    let breakdown = vat.tax_breakdown_json().to_string();
    store_order_vat_details(conn, id, vat.tax_amount_cents, Some(&breakdown))
}

fn store_order_vat_details(
    conn: &Connection,
    local_order_id: &str,
    vat_cents: i64,
    breakdown: Option<&str>,
) -> Result<bool, String> {
    let vat_cents = vat_cents.max(0);
    let changed = conn
        .execute(
            "UPDATE orders
             SET tax_amount = ?1, tax_amount_cents = ?2, tax_breakdown = ?4
             WHERE id = ?3
               AND (tax_amount_cents IS NULL OR tax_amount_cents != ?2
                    OR tax_amount IS NULL OR ABS(tax_amount - ?1) > 0.000001)",
            rusqlite::params![
                vat_cents as f64 / 100.0,
                vat_cents,
                local_order_id,
                breakdown
            ],
        )
        .map_err(|error| format!("store local order VAT: {error}"))?;
    if changed > 0 {
        return Ok(true);
    }
    // A new bucket snapshot with the same VAT must not fire UPDATE OF
    // tax_amount guards (for example while a fiscal collection is pending).
    let metadata_changed = conn
        .execute(
            "UPDATE orders SET tax_breakdown=?4 WHERE id=?3
         AND tax_amount_cents=?2 AND ABS(tax_amount-?1)<=0.000001
         AND tax_breakdown IS NOT ?4",
            rusqlite::params![
                vat_cents as f64 / 100.0,
                vat_cents,
                local_order_id,
                breakdown
            ],
        )
        .map_err(|error| format!("store local order VAT breakdown: {error}"))?;
    Ok(metadata_changed > 0)
}

/// Recompute a local order's VAT from its own row, as the server would for
/// the same order, and store it. Used after a local edit rewrote the items or
/// the order's money without a server quote. Returns the VAT in cents.
pub(crate) fn refresh_local_order_vat(
    conn: &Connection,
    local_order_id: &str,
) -> Result<i64, String> {
    let vat = crate::sync_queue::order_insert_vat(conn, local_order_id, &Value::Null)?;
    store_local_order_vat_result(conn, local_order_id, &vat)?;
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
    let breakdown = server_order
        .get("tax_breakdown")
        .or_else(|| server_order.get("taxBreakdown"))
        .filter(|v| !v.is_null())
        .map(|v| {
            if let Some(text) = v.as_str() {
                text.to_string()
            } else {
                v.to_string()
            }
        });
    match store_order_vat_details(conn, local_order_id, server_vat_cents, breakdown.as_deref()) {
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

    #[test]
    fn every_store_country_normalizes_and_has_a_valid_fallback() {
        assert_eq!(generic_country_defaults().len(), 46);
        for (code, fallback) in generic_country_defaults() {
            let country = VatCountry::from_setting(Some(&format!(" {} ", code.to_lowercase())));
            assert_eq!(country.as_str(), code);
            assert_eq!(country.default_category(), fallback);
            assert_eq!(vat_category_country(Some(fallback)), Some(country));
            assert_eq!(
                resolve_vat_category_rate(Some("unknown"), country, VatRegionProfile::Mainland).0,
                fallback
            );
        }
        for raw in [None, Some(""), Some("ZZ"), Some("Greece"), Some("USA")] {
            assert_eq!(VatCountry::from_setting(raw), VatCountry::Greece);
        }
    }

    #[test]
    fn generic_codes_match_the_shared_grammar_and_country_rules() {
        for (code, country, rate) in [
            ("at_vat_20", "AT", 20.0),
            ("fi_vat_25_5", "FI", 25.5),
            ("at_vat_4_9", "AT", 4.9),
            ("at_vat_04_09", "AT", 4.09),
            ("at_vat_99_99", "AT", 99.99),
            ("ie_vat_0", "IE", 0.0),
            ("es_out_of_scope", "ES", 0.0),
        ] {
            assert_eq!(
                parse_generic_vat_category_code(code),
                Some((VatCountry::from_setting(Some(country)), rate))
            );
        }
        for code in [
            "gr_vat_24",
            "ch_vat_8_1",
            "zz_vat_20",
            "AT_vat_20",
            "at_vat_100",
            "at_vat_1_234",
            "at_vat_",
            "at_vat_1_",
            "at_vat_-1",
            "at_vat_2_5_1",
            "at_vat_20\n",
            "at_out_of_scope_extra",
            "é_vat_20",
        ] {
            assert_eq!(parse_generic_vat_category_code(code), None, "{code}");
        }
        let austria = VatCountry::from_setting(Some("AT"));
        for code in [Some("fi_vat_25_5"), Some("unknown"), None] {
            assert_eq!(
                resolve_vat_category_rate(code, austria, VatRegionProfile::IslandsReduced),
                ("at_vat_20", 20.0)
            );
        }
    }

    #[test]
    fn generic_country_is_preserved_by_the_local_settings_reader() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::run_migrations_for_test(&conn);
        crate::db::set_setting(&conn, "tax", "vat_country", " fi ").unwrap();
        let settings = branch_vat_settings(&conn);
        assert_eq!(settings.normalized().country.as_str(), "FI");
        assert_eq!(
            settings.normalized().default_vat_category_code,
            "fi_vat_25_5"
        );
        assert_eq!(branch_vat_country_code(&conn), Some("FI"));
    }

    #[test]
    fn adopting_new_buckets_with_unchanged_vat_never_rewrites_the_amount() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::run_migrations_for_test(&conn);
        conn.execute_batch("INSERT INTO orders(id,items,total_amount,total_amount_cents,tax_amount,tax_amount_cents,created_at,updated_at) VALUES('same-vat','[]',12.4,1240,2.4,240,'now','now');
            CREATE TRIGGER unchanged_vat_guard BEFORE UPDATE OF tax_amount ON orders BEGIN SELECT RAISE(ABORT,'UNCHANGED_VAT_MUST_NOT_BE_REWRITTEN'); END;").unwrap();
        let server = json!({"total_amount_cents":1240,"tax_amount_cents":240,"tax_breakdown":[{"vatCategoryCode":"gr_standard_24","vatRate":24,"grossAmount":12.4,"netAmount":10,"vatAmount":2.4}]});
        assert!(adopt_server_order_vat(&conn, "same-vat", &server));
        let raw: String = conn
            .query_row(
                "SELECT tax_breakdown FROM orders WHERE id='same-vat'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&raw).unwrap(),
            server["tax_breakdown"]
        );
        assert!(!adopt_server_order_vat(&conn, "same-vat", &server));
    }

    #[test]
    fn net_service_prices_use_tenths_of_a_percent_like_shared_ts() {
        let mut settings = GreeceVatSettings {
            country: Some("CH".into()),
            default_vat_category_code: Some("ch_reduced_26".into()),
            ..Default::default()
        };
        assert_eq!(
            service_sale_gross_price(25.0, None, Some(false), &settings),
            25.65
        );
        assert_eq!(
            service_sale_gross_price(25.0, Some("gr_standard_24"), Some(false), &settings),
            25.65
        );
        assert_eq!(
            service_sale_gross_price(25.0, Some("ch_standard_81"), Some(false), &settings),
            27.03
        );
        assert_eq!(
            service_sale_gross_price(25.0, Some("ch_accommodation_38"), Some(false), &settings),
            25.95
        );
        assert_eq!(
            service_sale_gross_price(25.0, Some("unknown"), Some(false), &settings),
            27.03
        );
        assert_eq!(
            service_sale_gross_price(25.0, None, Some(true), &settings),
            25.0
        );
        settings.vat_registered = Some(false);
        assert_eq!(
            service_sale_gross_price(25.0, Some("ch_standard_81"), Some(false), &settings),
            25.0
        );
    }

    #[test]
    fn percentage_discount_base_excludes_deposits_like_the_server() {
        // Round-3 re-audit: 10 % of the goods (EUR 20), never of the deposit too.
        let body = json!({"items":[
            {"name":"Goods 13", "quantity":1,"unit_price":10,"vat_category_code":"gr_reduced_13"},
            {"name":"Goods 24", "quantity":1,"unit_price":10,"vat_category_code":"gr_standard_24"},
            {"name":"Deposit", "quantity":1,"unit_price":2,"vat_category_code":"gr_reduced_13","line_role":"deposit"}
        ],"manual_discount_mode":"percentage","manual_discount_value":10});
        let result = calculate_order_vat_from_order_body(&body, &GreeceVatSettings::default());
        assert_eq!(result.breakdown.total_discount_cents, 200);
        assert_eq!(result.breakdown.total_gross_cents, 2000);
        assert_eq!(result.tax_amount_cents, 301);
    }

    #[test]
    fn deposits_never_share_order_discounts_even_when_allocation_is_explicitly_enabled() {
        let body = json!({"items":[
            {"name":"Goods 13", "quantity":1,"unit_price":10,"vat_category_code":"gr_reduced_13"},
            {"name":"Goods 24", "quantity":1,"unit_price":10,"vat_category_code":"gr_standard_24"},
            {"name":"Deposit", "quantity":1,"unit_price":2,"vat_category_code":"gr_reduced_13","line_role":"deposit"}
        ],"discount_amount":2});
        let result = calculate_order_vat_from_order_body(&body, &GreeceVatSettings::default());
        assert_eq!(result.breakdown.total_gross_cents, 2000);
        assert_eq!(result.tax_amount_cents, 301);
        assert_eq!(result.breakdown.lines[2].discount_cents, 0);
        assert_eq!(result.breakdown.lines[2].gross_cents, 200);

        let lines = [FiscalTaxLineInput {
            unit_price: 2.0,
            line_role: Some("deposit".into()),
            participates_in_discount_allocation: Some(true),
            ..Default::default()
        }];
        let deposit = calculate_greece_fiscal_breakdown(
            &lines,
            Some(2.0),
            VatRegionProfile::Mainland,
            VatCountry::Greece,
        );
        assert_eq!(deposit.total_discount_cents, 0);
    }

    fn vector_input(input: &Value) -> GreeceOrderVatInput {
        let text =
            |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        GreeceOrderVatInput {
            settings: GreeceVatSettings {
                default_vat_category_code: text(input, "defaultVatCategoryCode"),
                vat_region_profile: text(input, "vatRegionProfile"),
                country: text(input, "country"),
                vat_registered: input.get("vatRegistered").and_then(Value::as_bool),
                channel_defaults: input["channelDefaults"].clone(),
                class_category_codes: input["classCategoryCodes"].clone(),
                platform_vat_opt_in: input["platformVatOptIn"].clone(),
                charges_vat_mode: text(input, "chargesVatMode"),
                delivery_fee_vat_category_code: text(input, "deliveryFeeVatCategoryCode"),
                tips_outside_vat: input.get("tipsOutsideVat").and_then(Value::as_bool),
            },
            items: input["items"]
                .as_array()
                .expect("vector items")
                .iter()
                .map(|item| GreeceOrderVatItem {
                    line_role: text(item, "lineRole"),
                    menu_item_id: text(item, "menuItemId"),
                    name: text(item, "name"),
                    quantity: item["quantity"].as_f64().expect("vector quantity"),
                    unit_price: item["unitPrice"].as_f64().expect("vector unit price"),
                    vat_category_code: text(item, "vatCategoryCode"),
                    vat_class: text(item, "vatClass"),
                    price_includes_vat: item.get("priceIncludesVat").and_then(Value::as_bool),
                    tax_exemption_reason: text(item, "taxExemptionReason"),
                    fiscal_document_profile: text(item, "fiscalDocumentProfile"),
                })
                .collect(),
            order_type: text(input, "orderType"),
            platform: text(input, "platform"),
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
        assert_eq!(cases.len(), 73, "all v3 store-country VAT vectors");
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
            // The phase-2 vectors specify every line but omit aggregate
            // buckets. Derive those expectations from fixture facts, never
            // from the calculator output; retain older explicit bucket checks.
            let expected_buckets = expected.get("taxBreakdown").cloned().unwrap_or_else(|| {
                let mut buckets: Vec<Value> = Vec::new();
                for line in expected["lines"].as_array().expect("expected lines") {
                    let index = buckets.iter().position(|bucket| {
                        bucket["vatCategoryCode"] == line["vatCategoryCode"]
                            && bucket["vatRate"] == line["vatRate"]
                    });
                    let bucket = match index {
                        Some(index) => &mut buckets[index],
                        None => {
                            buckets.push(json!({
                                "vatCategoryCode": line["vatCategoryCode"],
                                "vatRate": line["vatRate"],
                                "grossCents": 0, "netCents": 0, "vatCents": 0,
                                "discountCents": 0, "lineCount": 0,
                            }));
                            buckets.last_mut().unwrap()
                        }
                    };
                    for field in ["grossCents", "netCents", "vatCents", "discountCents"] {
                        bucket[field] =
                            json!(bucket[field].as_i64().unwrap() + line[field].as_i64().unwrap());
                    }
                    bucket["lineCount"] = json!(bucket["lineCount"].as_i64().unwrap() + 1);
                }
                buckets.sort_by(|left, right| {
                    right["vatRate"]
                        .as_f64()
                        .unwrap()
                        .total_cmp(&left["vatRate"].as_f64().unwrap())
                });
                Value::Array(buckets)
            });
            assert_eq!(Value::Array(buckets), expected_buckets, "{name}: buckets");
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
            ..Default::default()
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
            ..Default::default()
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
    fn order_origin_is_never_a_delivery_platform() {
        let settings = GreeceVatSettings {
            country: Some("CH".into()),
            channel_defaults: json!({"platform":"ch_exempt_platform", "takeaway":"ch_reduced_26"}),
            ..Default::default()
        };
        for source in ["kiosk", "qr", "recovery", "kiosk_recovery"] {
            let body = json!({"items":[{"quantity":1,"unit_price":10.26}], "order_type":"pickup", "source":source, "ghost_source":source});
            assert_eq!(
                calculate_order_vat_from_order_body(&body, &settings).tax_amount_cents,
                26,
                "{source}"
            );
        }
        let body = json!({"items":[{"quantity":1,"unit_price":10.26}], "order_type":"pickup", "plugin":"wolt"});
        assert_eq!(
            calculate_order_vat_from_order_body(&body, &settings).tax_amount_cents,
            0
        );
    }

    #[test]
    fn every_country_preset_and_channel_keeps_prices_inclusive() {
        let presets: Value = serde_json::from_str(include_str!(
            "../../../../shared/services/__fixtures__/greece-order-vat-vectors.json"
        ))
        .unwrap();
        // Every fixture profile, including both GR/CH preset class rows, across every channel.
        for case in presets["cases"].as_array().unwrap() {
            let base = vector_input(&case["input"]);
            for (kind, platform) in [
                ("dine-in", None),
                ("pickup", None),
                ("delivery", None),
                ("delivery", Some("wolt")),
            ] {
                let mut input = base.clone();
                input.order_type = Some(kind.into());
                input.platform = platform.map(str::to_string);
                for item in &mut input.items {
                    item.price_includes_vat = Some(true);
                }
                input.discount_amount = Some(0.0);
                let expected = input
                    .items
                    .iter()
                    .map(|i| js_round(i.quantity * i.unit_price * 100.0) as i64)
                    .sum::<i64>()
                    + [input.delivery_fee, input.service_fee, input.tip_amount]
                        .into_iter()
                        .map(|v| js_round(finite_or_zero(v).max(0.0) * 100.0) as i64)
                        .sum::<i64>();
                assert_eq!(
                    calculate_greece_order_vat(&input)
                        .breakdown
                        .total_gross_cents,
                    expected,
                    "{} {kind} {platform:?}",
                    case["name"]
                );
            }
        }
    }

    #[test]
    fn inclusive_prices_add_no_vat_on_top() {
        assert_eq!(vat_added_on_top_of_subtotal(4.37), 0.0);
        assert_eq!(vat_added_on_top_of_subtotal(0.0), 0.0);
    }
}
