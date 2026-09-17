//! Shared money-arithmetic primitives.
//!
//! Money is stored as `i64` minor units via the `Cents` newtype. The
//! W4 migration moved every monetary path off `f64` and the original
//! `MONEY_EPSILON` half-cent tolerance constant — comparisons now use
//! exact integer equality / ordering, so the epsilon is no longer
//! needed.
//!
//! For the migration rationale and full column inventory, see the plan
//! file `D:\The-Small-002\planning\claude\create-a-plan-to-rustling-pretzel.md`
//! (Wave 4).

use std::iter::Sum;
use std::ops::{Add, AddAssign, Neg, Sub, SubAssign};

/// Monetary amount in minor units (cents for EUR / lepta, USD cents, etc.).
///
/// Single-currency assumption: The Small POS runs per-tenant in one
/// currency (Greek restaurants default to EUR with 100 lepta per euro).
/// Multi-currency handling is explicitly out of scope for pos-tauri.
///
/// Integer math eliminates the f64 aggregation drift that motivated the
/// (now-removed) `MONEY_EPSILON`. Equality is exact; sums are
/// associative; `>=` / `>` comparisons are sharp. Serialization is a
/// plain JSON integer — this matches the `*_cents INTEGER` column shape
/// that migrations v51/v53/v54 added.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct Cents(i64);

impl Cents {
    /// Zero monetary amount. Cheaper than `Cents::from(0.0)` because it
    /// skips the float path entirely.
    pub const ZERO: Cents = Cents(0);

    /// Wrap a raw minor-unit count. No rounding.
    pub const fn new(value: i64) -> Self {
        Self(value)
    }

    /// Unwrap to a raw minor-unit count. No rounding.
    pub const fn as_i64(self) -> i64 {
        self.0
    }

    /// Convert a major-unit float to cents using IEEE-754 half-even
    /// ("banker's") rounding.
    ///
    /// Prefer this in computed / aggregated paths — half-even is
    /// statistically unbiased across a stream of rounding decisions,
    /// which matters for z-report totals where many small roundings
    /// accumulate. For operator-entered cash amounts that must match
    /// what a receipt printer shows, use [`Cents::round_half_up`].
    ///
    /// Relies on `f64::round_ties_even`, stable since Rust 1.77.
    pub fn round_half_even(major: f64) -> Self {
        Self((major * 100.0).round_ties_even() as i64)
    }

    /// Convert a major-unit float to cents using half-away-from-zero
    /// rounding (the rule most POS receipt printers and consumer
    /// calculators use). Use this on user-facing display paths.
    ///
    /// The rounding decision is taken on the DECIMAL value, not on the
    /// binary one: `(1.005 * 100.0).round()` is 100, because 1.005 is
    /// 100.49999999999999 once multiplied in IEEE-754, while the decimal
    /// answer — and the one the admin server, the Windows POS renderer and
    /// the Android POS all produce — is 101. `shared/types/money-fixtures.json`
    /// states the contract and `money_fixtures_match_every_platform` below
    /// measures this function against it (module audit closure, 2026-09-16).
    pub fn round_half_up(major: f64) -> Self {
        Self(decimal_to_cents(major))
    }

    /// Convert back to a major-unit float at 2 decimal places.
    ///
    /// Loss-free for all values representable within ±2⁵³ cents. Use
    /// only in display paths or for backward compatibility with legacy
    /// `f64` APIs during the Wave 4 migration; never re-aggregate the
    /// result.
    pub fn to_f64_dp2(self) -> f64 {
        (self.0 as f64) / 100.0
    }

    pub fn abs(self) -> Self {
        Self(self.0.abs())
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub fn is_negative(self) -> bool {
        self.0 < 0
    }

    pub fn is_positive(self) -> bool {
        self.0 > 0
    }
}

impl From<i64> for Cents {
    fn from(v: i64) -> Self {
        Self(v)
    }
}

impl From<Cents> for i64 {
    fn from(c: Cents) -> Self {
        c.0
    }
}

impl From<f64> for Cents {
    /// Default float→Cents conversion uses half-even (banker's) rounding.
    /// Call [`Cents::round_half_up`] explicitly for receipt-style rounding.
    fn from(major: f64) -> Self {
        Self::round_half_even(major)
    }
}

impl Add for Cents {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self(self.0 + rhs.0)
    }
}

impl AddAssign for Cents {
    fn add_assign(&mut self, rhs: Self) {
        self.0 += rhs.0;
    }
}

impl Sub for Cents {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        Self(self.0 - rhs.0)
    }
}

impl SubAssign for Cents {
    fn sub_assign(&mut self, rhs: Self) {
        self.0 -= rhs.0;
    }
}

impl Neg for Cents {
    type Output = Self;
    fn neg(self) -> Self {
        Self(-self.0)
    }
}

impl Sum for Cents {
    fn sum<I: Iterator<Item = Self>>(iter: I) -> Self {
        Self(iter.map(|c| c.0).sum())
    }
}

impl<'a> Sum<&'a Cents> for Cents {
    fn sum<I: Iterator<Item = &'a Cents>>(iter: I) -> Self {
        Self(iter.map(|c| c.0).sum())
    }
}

// Serde: on-the-wire shape is a JSON integer, matching the `*_cents`
// columns that Wave 4a adds to the SQLite schema.
impl serde::Serialize for Cents {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_i64(self.0)
    }
}

impl<'de> serde::Deserialize<'de> for Cents {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        i64::deserialize(de).map(Self)
    }
}

/// Integer cents of a major-unit amount, rounding half AWAY FROM ZERO on the
/// decimal representation.
///
/// Rust's `Display` for `f64` prints the shortest string that round-trips —
/// "1.005", never "1.00499999999999989" — which is the same value JavaScript's
/// `String(value)` produces. Shifting the decimal point in that string and
/// deciding on the third fractional digit therefore gives byte-for-byte the
/// same cents as `toCents` in `shared/types/pricing.ts`.
fn decimal_to_cents(major: f64) -> i64 {
    if !major.is_finite() {
        return 0;
    }

    let text = format!("{major}");
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.as_str()),
    };
    let (int_part, frac_part) = match digits.split_once('.') {
        Some((int_part, frac_part)) => (int_part, frac_part),
        None => (digits, ""),
    };

    let int_value: i128 = int_part.parse().unwrap_or(0);
    let digit_at = |index: usize| -> i128 {
        frac_part
            .as_bytes()
            .get(index)
            .map(|byte| i128::from(byte - b'0'))
            .unwrap_or(0)
    };

    let mut cents = int_value * 100 + digit_at(0) * 10 + digit_at(1);
    // Everything from the third fractional digit on is the remainder; it is at
    // least half a cent exactly when that digit is 5 or more.
    if digit_at(2) >= 5 {
        cents += 1;
    }

    let cents = i64::try_from(cents).unwrap_or(i64::MAX);
    if negative {
        -cents
    } else {
        cents
    }
}

/// Integer cents a discount of `value` takes off `subtotal`.
///
/// `percentage`: a share of the subtotal, the value clamped to 100, rounded
/// half away from zero. Anything else: a fixed major-unit amount. Never more
/// than the subtotal, never negative. Same rule as `discountCents` in
/// `shared/types/pricing.ts` and the two POS renderers.
pub fn discount_cents(discount_type: &str, value: f64, subtotal: Cents) -> Cents {
    let subtotal_cents = subtotal.as_i64().max(0);
    if subtotal_cents <= 0 {
        return Cents::ZERO;
    }

    let amount = if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    };

    if discount_type.eq_ignore_ascii_case("percentage") {
        let percentage = amount.min(100.0);
        let raw = (subtotal_cents as f64) * percentage / 100.0;
        Cents::new(subtotal_cents.min(raw.round() as i64))
    } else {
        Cents::new(subtotal_cents.min(Cents::round_half_up(amount).as_i64()))
    }
}

/// Serialize a `Cents` field as a JSON number with 2 decimal places of
/// major-unit precision (e.g. `12.34`).
///
/// Use this on Wave 4 transition structs whose `Serialize` derive is
/// consumed by an external surface that still expects float money.
/// Once Wave 4d cuts the wire format over to integer cents, this
/// adapter is removed.
///
/// Example:
/// ```ignore
/// #[derive(Serialize)]
/// struct UnsettledPaymentBlocker {
///     #[serde(serialize_with = "crate::money::serialize_cents_as_f64_dp2")]
///     total_amount: Cents,
///     ...
/// }
/// ```
pub fn serialize_cents_as_f64_dp2<S: serde::Serializer>(
    value: &Cents,
    ser: S,
) -> Result<S::Ok, S::Error> {
    ser.serialize_f64(value.to_f64_dp2())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cents_from_clean_major() {
        assert_eq!(Cents::from(0.0).as_i64(), 0);
        assert_eq!(Cents::from(1.00).as_i64(), 100);
        assert_eq!(Cents::from(12.34).as_i64(), 1234);
        assert_eq!(Cents::from(-5.25).as_i64(), -525);
    }

    #[test]
    fn round_half_even_on_exact_ties() {
        // Values chosen so that `major * 100.0` is an exact .5 in IEEE-754
        // (multiples of 1/8). Confirms banker's-rounding semantics.
        assert_eq!(Cents::round_half_even(0.005).as_i64(), 0, "0.5 → 0 (even)");
        assert_eq!(
            Cents::round_half_even(0.125).as_i64(),
            12,
            "12.5 → 12 (even)"
        );
        assert_eq!(
            Cents::round_half_even(0.375).as_i64(),
            38,
            "37.5 → 38 (round-up-to-even)"
        );
        assert_eq!(
            Cents::round_half_even(0.625).as_i64(),
            62,
            "62.5 → 62 (round-down-to-even)"
        );
    }

    #[test]
    fn round_half_up_on_exact_ties() {
        assert_eq!(Cents::round_half_up(0.005).as_i64(), 1);
        assert_eq!(Cents::round_half_up(0.125).as_i64(), 13);
        assert_eq!(Cents::round_half_up(-0.005).as_i64(), -1);
    }

    #[test]
    fn to_f64_dp2_is_lossfree_at_2dp() {
        assert_eq!(Cents::new(0).to_f64_dp2(), 0.0);
        assert_eq!(Cents::new(100).to_f64_dp2(), 1.0);
        assert_eq!(Cents::new(1234).to_f64_dp2(), 12.34);
        assert_eq!(Cents::new(-525).to_f64_dp2(), -5.25);
    }

    #[test]
    fn add_sub_neg_assign() {
        assert_eq!(Cents::new(100) + Cents::new(50), Cents::new(150));
        assert_eq!(Cents::new(100) - Cents::new(50), Cents::new(50));
        assert_eq!(-Cents::new(100), Cents::new(-100));

        let mut c = Cents::new(100);
        c += Cents::new(25);
        assert_eq!(c, Cents::new(125));
        c -= Cents::new(50);
        assert_eq!(c, Cents::new(75));
    }

    #[test]
    fn sum_of_owned_and_borrowed() {
        let values = [Cents::new(10), Cents::new(20), Cents::new(30)];
        let total: Cents = values.iter().copied().sum();
        assert_eq!(total, Cents::new(60));
        let total_ref: Cents = values.iter().sum();
        assert_eq!(total_ref, Cents::new(60));
    }

    #[test]
    fn serde_round_trips_as_plain_integer() {
        let c = Cents::new(1234);
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(json, "1234", "wire shape must be a JSON integer");
        let back: Cents = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
    }

    #[test]
    fn abs_and_sign_predicates() {
        assert_eq!(Cents::new(-100).abs(), Cents::new(100));
        assert_eq!(Cents::new(100).abs(), Cents::new(100));
        assert!(Cents::new(0).is_zero());
        assert!(Cents::new(-5).is_negative());
        assert!(Cents::new(5).is_positive());
        assert!(!Cents::ZERO.is_positive());
    }

    #[test]
    fn ordering_follows_integer_ordering() {
        assert!(Cents::new(100) > Cents::new(50));
        assert!(Cents::new(-10) < Cents::new(10));
        assert_eq!(Cents::new(42), Cents::new(42));
    }

    // ---------------------------------------------------------------------
    // Cross-platform money contract (module audit closure, 2026-09-16)
    // ---------------------------------------------------------------------

    #[derive(serde::Deserialize)]
    struct MoneyFixtures {
        rule: String,
        #[serde(rename = "toCents")]
        to_cents: Vec<ToCentsCase>,
        #[serde(rename = "couponDiscount")]
        coupon_discount: Vec<CouponCase>,
    }

    #[derive(serde::Deserialize)]
    struct ToCentsCase {
        amount: f64,
        cents: i64,
        why: String,
    }

    #[derive(serde::Deserialize)]
    struct CouponCase {
        #[serde(rename = "subtotalCents")]
        subtotal_cents: i64,
        #[serde(rename = "type")]
        kind: String,
        value: f64,
        #[serde(rename = "discountCents")]
        discount_cents: i64,
        why: String,
    }

    fn load_fixtures() -> MoneyFixtures {
        // The one specification, shared with the admin server, the Windows POS renderer and
        // the Android POS. Test-time read: the production build never touches the file.
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../shared/types/money-fixtures.json"
        );
        let raw = std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("money fixtures unreadable at {path}: {error}"));
        serde_json::from_str(&raw).expect("money fixtures are valid JSON")
    }

    #[test]
    fn money_fixtures_match_every_platform() {
        let fixtures = load_fixtures();
        assert_eq!(
            fixtures.rule, "round half away from zero at two decimal places",
            "the fixture file changed its rule; this core must follow it"
        );
        assert!(fixtures.to_cents.len() >= 20);

        for case in &fixtures.to_cents {
            assert_eq!(
                Cents::round_half_up(case.amount).as_i64(),
                case.cents,
                "{} euros must be {} cents ({})",
                case.amount,
                case.cents,
                case.why
            );
            // Round-tripping whole cents is lossless.
            assert_eq!(
                Cents::round_half_up(Cents::new(case.cents).to_f64_dp2()).as_i64(),
                case.cents,
                "{} cents did not survive a round trip",
                case.cents
            );
        }
    }

    #[test]
    fn coupon_fixtures_match_every_platform() {
        let fixtures = load_fixtures();
        assert!(fixtures.coupon_discount.len() >= 14);

        for case in &fixtures.coupon_discount {
            assert_eq!(
                discount_cents(&case.kind, case.value, Cents::new(case.subtotal_cents)).as_i64(),
                case.discount_cents,
                "a {} cent subtotal with a {} discount of {} must give {} cents ({})",
                case.subtotal_cents,
                case.kind,
                case.value,
                case.discount_cents,
                case.why
            );
        }
    }

    #[test]
    fn decimal_rounding_beats_binary_multiplication() {
        // The regression this closed: every one of these is wrong by a cent when the
        // decision is taken on `(major * 100.0).round()`.
        for (major, expected) in [
            (1.005_f64, 101_i64),
            (2.675, 268),
            (10.125, 1013),
            (9999.995, 1000000),
        ] {
            assert_eq!(Cents::round_half_up(major).as_i64(), expected);
        }
        assert_eq!(Cents::round_half_up(-1.005).as_i64(), -101);
        assert_eq!(Cents::round_half_up(-0.004).as_i64(), 0);
        assert_eq!(Cents::round_half_up(f64::NAN).as_i64(), 0);
        assert_eq!(Cents::round_half_up(f64::INFINITY).as_i64(), 0);
    }

    #[test]
    fn discount_cents_is_clamped_at_both_ends() {
        assert_eq!(
            discount_cents("percentage", 150.0, Cents::new(10000)).as_i64(),
            10000
        );
        assert_eq!(
            discount_cents("fixed", 80.0, Cents::new(5000)).as_i64(),
            5000
        );
        assert_eq!(
            discount_cents("percentage", -5.0, Cents::new(10000)).as_i64(),
            0
        );
        assert_eq!(
            discount_cents("fixed", f64::NAN, Cents::new(10000)).as_i64(),
            0
        );
        assert_eq!(
            discount_cents("percentage", 50.0, Cents::new(0)).as_i64(),
            0
        );
        assert_eq!(
            discount_cents("percentage", 50.0, Cents::new(-100)).as_i64(),
            0
        );
        // The type match is case-insensitive, like the payload it reads.
        assert_eq!(
            discount_cents("PERCENTAGE", 10.0, Cents::new(1005)).as_i64(),
            101
        );
    }
}
