//! Shared money-arithmetic constants.
//!
//! The POS stores monetary amounts as `f64` (see the review documented in
//! `D:\The-Small-002\planning\claude\now-create-a-plan-vivid-sutton.md`,
//! Wave 2a C3). Because floating-point equality is unreliable near the
//! ±0.005 boundary, every comparison that asks "are these two money
//! values equal / within a cent?" MUST go through `MONEY_EPSILON`.
//!
//! Before this module existed, `payments.rs`, `refunds.rs`, and
//! `zreport.rs` each carried their own bare literals (`0.005`, `0.009`,
//! `0.01`) — one of them was asymmetric (`+ 0.01` for overpayment guard,
//! `- 0.01` for "fully paid") and permitted a €0.01 under-payment to be
//! silently stamped "paid".
//!
//! Wave 2a will migrate all such call-sites to use this constant. Wave 0
//! introduces the constant without call-site changes so the regression
//! tests for C3 have a symbol to reference.

/// Symmetric epsilon for all money comparisons.
///
/// 0.005 = half a cent. Any two money values within this tolerance are
/// considered equal. Use strict inequality on the boundary so that the
/// fully-paid and overpayment thresholds remain symmetric:
///
/// ```text
///     total_paid >= order_total - MONEY_EPSILON  →  paid
///     total_paid >  order_total + MONEY_EPSILON  →  overpayment (reject)
/// ```
///
/// Do NOT add a second constant with a different value. If a specific
/// call-site needs a larger tolerance (e.g. cash rounding at settle
/// time), introduce a named constant that multiplies this one, not a
/// new bare literal.
///
pub const MONEY_EPSILON: f64 = 0.005;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn money_epsilon_is_half_a_cent() {
        assert!((MONEY_EPSILON - 0.005).abs() < f64::EPSILON);
    }
}
