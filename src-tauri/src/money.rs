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
    pub fn round_half_up(major: f64) -> Self {
        Self((major * 100.0).round() as i64)
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
}
