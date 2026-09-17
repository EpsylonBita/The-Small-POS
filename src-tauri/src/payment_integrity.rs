use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::business_day;
use crate::money::{serialize_cents_as_f64_dp2, Cents};

pub const UNSETTLED_PAYMENT_BLOCKER_ERROR_CODE: &str = "UNSETTLED_PAYMENT_BLOCKER";

/// Severity of a payment-integrity finding.
///
/// Every shipped reason code is `Blocking`: the Z must not close over money
/// that does not reconcile. `Warning` exists so a future advisory finding can
/// be surfaced in the reconciliation panel without freezing the till — it is
/// deliberately unused today, and the Z gate keys on
/// [`UnsettledPaymentBlocker::is_blocking`] rather than on the reason code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntegritySeverity {
    Blocking,
    Warning,
}

impl IntegritySeverity {
    fn as_str(self) -> &'static str {
        match self {
            IntegritySeverity::Blocking => "blocking",
            IntegritySeverity::Warning => "warning",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsettledPaymentBlocker {
    pub order_id: String,
    pub order_number: String,
    // W4b: internal Cents; serialized as f64-dp2 to keep the existing
    // admin-dashboard wire shape unchanged. The serializer adapter is
    // removed in 4d when the wire-format cutover lands.
    #[serde(serialize_with = "serialize_cents_as_f64_dp2")]
    pub total_amount: Cents,
    #[serde(serialize_with = "serialize_cents_as_f64_dp2")]
    pub settled_amount: Cents,
    pub payment_status: String,
    pub payment_method: String,
    pub reason_code: String,
    pub reason_text: String,
    pub suggested_fix: String,
    /// Additive wire field (16/09/2026 reconciliation work). Existing admin
    /// consumers read the keys above and ignore this one.
    pub severity: String,
    /// Signed order-total − settled difference in cents: negative means the
    /// ledger holds MORE than the order is worth (overpayment / duplicate).
    /// Lets the reconciliation panel show the money without re-deriving it.
    pub difference_cents: i64,
    /// The money the reason sentence names, in cents, keyed by the placeholder
    /// the localized sentence uses.
    ///
    /// Additive wire field (17/09/2026). The sentences below are written in
    /// English and interpolate their own figures, so a Greek till showed a
    /// Greek operator «The platform settles this order, but EUR 6.50 is
    /// recorded as cash/card in the till.» The renderer now builds the
    /// sentence from `reason_code` in the operator's language, and needs the
    /// figures separately to do it. `reason_text` stays as the fallback for a
    /// locale that has no entry for a code.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub reason_amounts: BTreeMap<String, i64>,
    /// Which sentence a reason code with more than one shape is telling.
    ///
    /// `platform_settlement_mismatch` covers two opposite breaks — platform
    /// money booked as drawer takings, and store money booked as platform
    /// revenue — and one translated sentence cannot honestly say both. The
    /// wire code stays as it is, because the admin and the Z gate key on it;
    /// this names the arm so the renderer can pick the right sentence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_variant: Option<String>,
}

impl UnsettledPaymentBlocker {
    pub fn is_blocking(&self) -> bool {
        self.severity == IntegritySeverity::Blocking.as_str()
    }
}

/// How a platform order is expected to settle, read from the same
/// `ghost_metadata.food_delivery` markers as
/// `payments::platform_settlement_kind`. Kept as a small integer in SQL so
/// the classifier and the ledger writer can never drift apart silently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExpectedPlatformSettlement {
    /// Not a platform-settled order: the store collects the money itself.
    /// Covers store orders AND platform orders our own driver delivers.
    None_,
    /// Customer paid the platform online; the money arrives by bank transfer.
    PrepaidOnline,
    /// COD collected by the PLATFORM's own rider; the platform banks it.
    PlatformCollectedCod,
}

impl ExpectedPlatformSettlement {
    fn from_sql(value: i64) -> Self {
        match value {
            1 => ExpectedPlatformSettlement::PrepaidOnline,
            2 => ExpectedPlatformSettlement::PlatformCollectedCod,
            _ => ExpectedPlatformSettlement::None_,
        }
    }

    fn is_platform_held(self) -> bool {
        !matches!(self, ExpectedPlatformSettlement::None_)
    }
}

#[derive(Clone, Debug)]
struct RawBlockerRow {
    order_id: String,
    order_number: String,
    total_amount: Cents,
    settled_amount: Cents,
    payment_status: String,
    payment_method: String,
    completed_payment_count: i64,
    invalid_completed_method_count: i64,
    /// Tips recorded on completed rows. Part of the overpayment ceiling: a
    /// payment may legitimately carry the tip inside its amount.
    tip_total: Cents,
    /// Completed settled amount NET of refund adjustments. Only this figure
    /// may be tested for overpayment — the gross sum double-counts a
    /// refund-then-recollect cycle and would cry wolf on every corrected order.
    net_settled_amount: Cents,
    /// Completed rows sharing one non-empty `transaction_ref`. One real
    /// transaction cannot settle twice, so >0 is an unambiguous replay.
    duplicate_transaction_ref_groups: i64,
    /// Completed rows sharing (method, amount). Ambiguous on its own — two
    /// guests really can hand over 5.00 each — so it only ever colours the
    /// overpayment message, never raises a finding by itself.
    duplicate_amount_groups: i64,
    expected_platform_settlement: ExpectedPlatformSettlement,
    /// Does the order actually carry `ghost_metadata.food_delivery`? Without
    /// it we do not KNOW how the platform settles this order — see the
    /// guard in `classify_settlement_shape`.
    platform_disposition_known: bool,
    /// Completed `platform_settlement:*` money: revenue the platform banks.
    platform_settled_amount: Cents,
    /// Completed cash/card money: what really passed through our drawer or
    /// card terminal.
    drawer_tender_amount: Cents,
    is_external_platform: bool,
}

impl UnsettledPaymentBlocker {
    pub fn missing_local_payment_row(&self) -> bool {
        self.reason_code == "missing_local_payment_row"
    }
}

fn normalize_payment_status(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        "pending".to_string()
    } else {
        normalized
    }
}

fn normalize_payment_method(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        "pending".to_string()
    } else {
        normalized
    }
}

fn format_money(amount: Cents) -> String {
    // Display-side conversion only: clamp negative values to zero for
    // operator-friendly text. Internal arithmetic stays in `Cents`.
    format!("EUR {:.2}", amount.to_f64_dp2().max(0.0))
}

fn build_blocker(
    row: &RawBlockerRow,
    reason_code: &str,
    reason_text: String,
    suggested_fix: String,
) -> UnsettledPaymentBlocker {
    build_blocker_with_severity(
        row,
        reason_code,
        reason_text,
        suggested_fix,
        IntegritySeverity::Blocking,
    )
}

fn build_blocker_with_severity(
    row: &RawBlockerRow,
    reason_code: &str,
    reason_text: String,
    suggested_fix: String,
    severity: IntegritySeverity,
) -> UnsettledPaymentBlocker {
    UnsettledPaymentBlocker {
        order_id: row.order_id.clone(),
        order_number: row.order_number.clone(),
        total_amount: row.total_amount,
        settled_amount: row.settled_amount,
        payment_status: row.payment_status.clone(),
        payment_method: row.payment_method.clone(),
        reason_code: reason_code.to_string(),
        reason_text,
        suggested_fix,
        severity: severity.as_str().to_string(),
        difference_cents: (row.total_amount - row.settled_amount).as_i64(),
        reason_amounts: BTreeMap::new(),
        reason_variant: None,
    }
}

/// Attach the money a reason sentence names, so the renderer can write that
/// sentence in the operator's language instead of shipping ours.
fn with_reason_amounts(
    mut blocker: UnsettledPaymentBlocker,
    amounts: impl IntoIterator<Item = (&'static str, Cents)>,
) -> UnsettledPaymentBlocker {
    blocker.reason_amounts = amounts
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.as_i64().max(0)))
        .collect();
    blocker
}

/// Name which arm of a two-shaped reason code this finding is.
fn with_reason_variant(
    mut blocker: UnsettledPaymentBlocker,
    variant: &'static str,
) -> UnsettledPaymentBlocker {
    blocker.reason_variant = Some(variant.to_string());
    blocker
}

/// Findings about the SHAPE of an order's settlement rather than its amount:
/// too much money, the same transaction twice, or the right money in the
/// wrong tender. Returns the most serious one, or `None` when the ledger's
/// shape is sound (it may still be short — that is the caller's job).
fn classify_settlement_shape(row: &RawBlockerRow) -> Option<UnsettledPaymentBlocker> {
    // Ceiling for "how much may this order legitimately hold": its own total
    // plus any tip recorded on the completed rows. Matches the server-side
    // `validateCanonicalPaymentAmountForOrder` ceiling (orderTotal + tip), so
    // a payment that the API accepted can never fail here.
    let ceiling = row.total_amount + row.tip_total;

    // 1. One real transaction settled twice. `transaction_ref` identifies a
    //    single card authorisation / platform settlement, so two completed
    //    rows sharing one are a replay by construction — no amount test can
    //    argue with that, and it is reported even when the totals happen to
    //    balance.
    if row.duplicate_transaction_ref_groups > 0 {
        return Some(build_blocker(
            row,
            "duplicate_payment",
            format!(
                "The same transaction is recorded more than once ({} recorded against an order of {}).",
                format_money(row.settled_amount),
                format_money(row.total_amount)
            ),
            "Void the duplicate payment row, keeping one payment per real transaction.".to_string(),
        ));
    }

    // 2. Overpayment, measured NET of refunds so a refund-then-recollect
    //    cycle is not mistaken for one. Duplicate (method, amount) rows are
    //    too ambiguous to raise on their own — two guests really can pay 5.00
    //    each in cash — but when the order is ALSO over its ceiling they name
    //    the likely cause, so the operator knows what to void.
    if row.net_settled_amount > ceiling {
        let overpaid = row.net_settled_amount - ceiling;
        let suggested_fix = if row.duplicate_amount_groups > 0 {
            "Void the repeated payment row — two completed payments share the same method and amount."
                .to_string()
        } else {
            "Refund or void the excess payment so the ledger matches the order total.".to_string()
        };
        return Some(with_reason_amounts(
            build_blocker(
                row,
                "overpaid_order",
                format!(
                    "Payments exceed the order by {}: {} recorded against an order of {}.",
                    format_money(overpaid),
                    format_money(row.net_settled_amount),
                    format_money(ceiling)
                ),
                suggested_fix,
            ),
            [
                ("overpaidAmount", overpaid),
                ("netSettledAmount", row.net_settled_amount),
                ("ceilingAmount", ceiling),
            ],
        ));
    }

    // 3. Platform settlement in the wrong direction.
    if row.expected_platform_settlement.is_platform_held() {
        // The platform is holding this money. Any cash/card row against it
        // means the same euros are counted twice: once as bank settlement,
        // once as drawer takings.
        if row.drawer_tender_amount > Cents::ZERO {
            return Some(with_reason_variant(with_reason_amounts(
                build_blocker(
                    row,
                    "platform_settlement_mismatch",
                    format!(
                        "The platform settles this order, but {} is recorded as cash/card in the till.",
                        format_money(row.drawer_tender_amount)
                    ),
                    "Void the cash/card row: prepaid and platform-rider COD money never enters the drawer."
                        .to_string(),
                ),
                [("drawerAmount", row.drawer_tender_amount)],
            ), "platform_holds"));
        }
        // Platform-settled, and no settlement row at all: the
        // `platform_settlement:*` write never happened (or was swept). This
        // is the efood half of the 16/09/2026 incident.
        //
        // Deliberately NOT gated on `payment_status == "paid"` (founder
        // review, 16/09/2026). The disposition already says the platform is
        // holding this money, so the settlement row is owed whatever the
        // order row claims. Gating on "paid" made the finding depend on the
        // very field a failed settlement corrects downward — write the honest
        // `pending` and the gap went silent exactly when it mattered most.
        if row.platform_settled_amount <= Cents::ZERO {
            return Some(build_blocker(
                row,
                "platform_settlement_missing",
                format!(
                    "The platform settles this order, but no platform settlement of {} is recorded.",
                    format_money(row.total_amount)
                ),
                "Re-run platform settlement for this order so the money is recorded as platform revenue."
                    .to_string(),
            ));
        }
    } else if row.platform_settled_amount > Cents::ZERO && row.platform_disposition_known {
        // The reverse: money we collect ourselves booked as platform-held.
        // Either a store order carrying a settlement row, or a platform order
        // OUR driver delivered — whose cash really did enter the drawer and
        // must not be reported as bank money.
        //
        // Guarded by `platform_disposition_known` on purpose: this arm needs
        // the order's OWN metadata to say the money is ours. A settlement row
        // on an order with no metadata is missing evidence, not contrary
        // evidence — and the reference is itself a record that the POS
        // classified the order as platform-held when it collected. Flagging
        // those would freeze every legacy platform order whose metadata
        // predates the aggregator ingest.
        let reason_text = if row.is_external_platform {
            format!(
                "This platform order is delivered by our own driver, but {} is booked as platform-settled money.",
                format_money(row.platform_settled_amount)
            )
        } else {
            format!(
                "A store order is booked as platform-settled money ({}).",
                format_money(row.platform_settled_amount)
            )
        };
        return Some(with_reason_variant(
            with_reason_amounts(
                build_blocker(
                    row,
                    "platform_settlement_mismatch",
                    reason_text,
                    "Void the platform settlement row and record the cash or card the store actually collected."
                        .to_string(),
                ),
                [("platformSettledAmount", row.platform_settled_amount)],
            ),
            if row.is_external_platform {
                "store_collects_platform_order"
            } else {
                "store_collects"
            },
        ));
    }

    None
}

fn classify_blocker_row(row: RawBlockerRow) -> Option<UnsettledPaymentBlocker> {
    // W4b: integer-cent comparisons — exact equality, no epsilon. The W1
    // C10 alignment with `payments::recompute_order_payment_state` is
    // preserved because that path also moves to integer math in W4b.
    // Previously this used MONEY_EPSILON (0.005) to guard against float
    // drift; with `Cents` the drift class disappears entirely.
    if row.total_amount <= Cents::ZERO {
        return None;
    }

    let remaining = std::cmp::max(row.total_amount - row.settled_amount, Cents::ZERO);

    // --- Settlement-shape findings (16/09/2026 reconciliation work) --------
    //
    // These run BEFORE the `remaining.is_zero()` early return below. The
    // shipped classifier only ever asked "is enough money recorded?", so an
    // order carrying TOO MUCH money, the same transaction twice, or the right
    // total in the wrong tender all read as perfectly settled and the Z closed
    // silently over them. Each one is a real reconciliation break:
    //
    //   * overpaid_order            — the ledger holds more than the order is
    //                                 worth; the day's takings are inflated.
    //   * duplicate_payment         — one real transaction settled twice.
    //   * platform_settlement_mismatch — money the platform is holding was
    //                                 booked as drawer cash/card (or the
    //                                 reverse). Cash counts would never
    //                                 balance, and the founder's «platform
    //                                 money is not drawer cash» rule breaks.
    if let Some(blocker) = classify_settlement_shape(&row) {
        return Some(blocker);
    }

    if row.invalid_completed_method_count > 0 {
        let reason_text = if remaining.is_zero() {
            "Completed payment rows contain an unsupported payment method.".to_string()
        } else {
            format!(
                "Completed payment rows contain an unsupported payment method and only {} of {} is recorded.",
                format_money(row.settled_amount),
                format_money(row.total_amount)
            )
        };
        return Some(build_blocker(
            &row,
            "unsupported_payment_method",
            reason_text,
            "Void the unsupported payment row and recollect the payment as cash or card."
                .to_string(),
        ));
    }

    if remaining.is_zero() {
        return None;
    }

    if row.completed_payment_count <= 0 && row.payment_status == "paid" {
        return Some(build_blocker(
            &row,
            "missing_local_payment_row",
            "Order is marked paid but its local payment record is missing.".to_string(),
            "Refresh payment mirrors or recreate the missing payment record.".to_string(),
        ));
    }

    if row.completed_payment_count <= 0 {
        // W6: with `orders.payment_method` dropped and `derive_payment_method`
        // returning None → "pending" when there are zero completed rows, the
        // specific `missing_cash_payment` / `missing_card_payment` /
        // `split_payment_incomplete` codes are unreachable for this branch.
        // Every zero-payment-count blocker collapses into `no_persisted_payment`.
        return Some(build_blocker(
            &row,
            "no_persisted_payment",
            "Order was completed without a persisted cash/card payment.".to_string(),
            "Record the missing cash or card payment.".to_string(),
        ));
    }

    // Note: `derive_payment_method` never emits "mixed" (canonical
    // vocabulary is "split"); the `== "mixed"` check is kept for
    // defence-in-depth against any stale data synced from older peers.
    if row.payment_method == "split" || row.payment_method == "mixed" {
        return Some(build_blocker(
            &row,
            "split_payment_incomplete",
            format!(
                "Split payment is incomplete. Only {} of {} is recorded.",
                format_money(row.settled_amount),
                format_money(row.total_amount)
            ),
            "Resume split payment and finish the remaining balance.".to_string(),
        ));
    }

    Some(match row.payment_method.as_str() {
        "cash" => build_blocker(
            &row,
            "partial_cash_payment",
            format!(
                "Cash payments only cover {} of {}.",
                format_money(row.settled_amount),
                format_money(row.total_amount)
            ),
            "Record the remaining cash payment to continue.".to_string(),
        ),
        "card" => build_blocker(
            &row,
            "partial_card_payment",
            format!(
                "Card payments only cover {} of {}.",
                format_money(row.settled_amount),
                format_money(row.total_amount)
            ),
            "Record the remaining card payment to continue.".to_string(),
        ),
        _ => build_blocker(
            &row,
            "partial_payment_remaining",
            format!(
                "Only {} of {} is recorded.",
                format_money(row.settled_amount),
                format_money(row.total_amount)
            ),
            "Record the remaining balance as cash or card.".to_string(),
        ),
    })
}

fn order_blocker_row_select() -> String {
    // W6: column 5 (payment_method) is derived via a subquery matching
    // `payments::derive_payment_method`. The stored `orders.payment_method`
    // column was dropped in migration v55. Semantic consequence: for
    // orders with zero completed payments (the `missing_local_payment_row`
    // and `no_persisted_payment` branches in `classify_blocker_row`), the
    // derived method is always "pending" — the three
    // `missing_cash_payment` / `missing_card_payment` /
    // `split_payment_incomplete` reason codes for that case were removed
    // and collapsed into the catch-all `no_persisted_payment`. The
    // operator UX loses specificity only for the "paid, but no local
    // row" edge case; the hint column in the blocker UI becomes the
    // generic "Record the missing cash or card payment".
    //
    // W4b: monetary columns now read from the `*_cents` integer siblings
    // (W4a v51 added `orders.total_amount_cents` and
    // `order_payments.amount_cents`; W4c populates them on every write).
    // W4b: COALESCE(cents_col, CAST(ROUND(real_col * 100) AS INTEGER)) is
    // a transition shim that lets pre-W4c fixtures (and any production
    // row written between v51/v53/v54 backfill and 4c landing that still
    // has NULL `_cents`) be read without silently zeroing money. 4e
    // removes the COALESCE arms when the REAL columns are dropped.
    "SELECT
        o.id,
        COALESCE(NULLIF(TRIM(o.order_number), ''), o.id),
        COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER), 0),
        COALESCE((
            SELECT SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER)))
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status = 'completed'
        ), 0),
        LOWER(TRIM(COALESCE(o.payment_status, 'pending'))),
        COALESCE((
            SELECT CASE
                WHEN COUNT(DISTINCT LOWER(TRIM(method))) > 1
                  THEN 'split'
                ELSE LOWER(TRIM(MIN(method)))
            END
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status = 'completed'
              AND TRIM(COALESCE(op.method, '')) != ''
        ), 'pending'),
        COALESCE((
            SELECT COUNT(*)
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status = 'completed'
        ), 0),
        COALESCE((
            SELECT COUNT(*)
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status = 'completed'
              AND LOWER(TRIM(COALESCE(op.method, ''))) NOT IN ('cash', 'card')
              -- THE-437 platform settlements are method='other' BY DESIGN:
              -- bank money the platform remits, never drawer cash and never
              -- the card terminal. They must not read as 'unsupported' — the
              -- first live settlements (01/09/2026, Το Μικρό Παρίσι) blocked
              -- the shift checkout of a fully settled day. Recognized by the
              -- same canonical markers the Z classifier keys on.
              AND NOT (
                LOWER(TRIM(COALESCE(op.method, ''))) = 'other'
                AND COALESCE(op.transaction_ref, '') LIKE 'platform_settlement:%'
              )
        ), 0),
        -- 8: tips on completed rows. Part of the overpayment ceiling.
        COALESCE((
            SELECT SUM(COALESCE(op.tip_amount_cents, CAST(ROUND(op.tip_amount * 100) AS INTEGER), 0))
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status = 'completed'
        ), 0),
        -- 9: completed money NET of refund adjustments. Only this may be
        -- tested for overpayment; the gross sum at column 3 double-counts a
        -- refund-then-recollect cycle.
        COALESCE((
            SELECT SUM(
                MAX(
                    COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0)
                    - COALESCE((
                        SELECT SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER), 0))
                        FROM payment_adjustments pa
                        WHERE pa.payment_id = op.id
                          AND pa.adjustment_type = 'refund'
                    ), 0),
                    0
                )
            )
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status = 'completed'
        ), 0),
        -- 10: completed rows sharing one non-empty transaction_ref. A single
        -- real transaction cannot settle twice, so any group of 2+ is a replay.
        COALESCE((
            SELECT COUNT(*) FROM (
                SELECT 1
                FROM order_payments op
                WHERE op.order_id = o.id
                  AND op.status = 'completed'
                  AND TRIM(COALESCE(op.transaction_ref, '')) <> ''
                GROUP BY TRIM(op.transaction_ref)
                HAVING COUNT(*) > 1
            )
        ), 0),
        -- 11: completed rows sharing (method, amount). Ambiguous alone; only
        -- used to explain an overpayment.
        COALESCE((
            SELECT COUNT(*) FROM (
                SELECT 1
                FROM order_payments op
                WHERE op.order_id = o.id
                  AND op.status = 'completed'
                  AND COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0) > 0
                GROUP BY LOWER(TRIM(COALESCE(op.method, ''))),
                         COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0)
                HAVING COUNT(*) > 1
            )
        ), 0),
        -- 12: how this order is EXPECTED to settle, mirroring
        -- `payments::platform_settlement_kind`:
        --   0 = the store collects it (store orders, and platform orders our
        --       own driver delivers — that cash really does enter the drawer)
        --   1 = prepaid online, 2 = COD collected by the platform's rider.
        -- `json_valid` guards the extract: ghost_metadata is free-form text
        -- on legacy rows and a raw json_extract would abort the whole query.
        CASE
            WHEN NOT (
                $EXTERNAL_PLATFORM_PREDICATE
                OR TRIM(COALESCE(o.external_plugin_order_id, '')) <> ''
                OR (
                    json_valid(COALESCE(o.ghost_metadata, ''))
                    AND json_extract(o.ghost_metadata, '$.food_delivery') IS NOT NULL
                )
            ) THEN 0
            WHEN NOT json_valid(COALESCE(o.ghost_metadata, '')) THEN 0
            WHEN COALESCE(json_extract(o.ghost_metadata, '$.food_delivery.prepaid'), 0) IN (1, 'true')
                 OR LOWER(TRIM(COALESCE(json_extract(o.ghost_metadata, '$.food_delivery.payment_method'), ''))) = 'online'
                THEN 1
            WHEN LOWER(TRIM(COALESCE(json_extract(o.ghost_metadata, '$.food_delivery.payment_method'), ''))) = 'cash'
                 AND LOWER(TRIM(COALESCE(json_extract(o.ghost_metadata, '$.food_delivery.delivery_provider'), ''))) = 'platform_delivery'
                THEN 2
            ELSE 0
        END,
        -- 13: completed platform-settlement money (bank money the platform remits).
        COALESCE((
            SELECT SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0))
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status = 'completed'
              AND COALESCE(op.transaction_ref, '') LIKE 'platform_settlement:%'
        ), 0),
        -- 14: completed cash/card money (what really passed through the till).
        COALESCE((
            SELECT SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0))
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status = 'completed'
              AND LOWER(TRIM(COALESCE(op.method, ''))) IN ('cash', 'card')
        ), 0),
        -- 15: does this order come from a marketplace we can NAME? `plugin =
        -- 'pos'` is our own till and must answer no; so must a slug we do not
        -- recognise — see `crate::platforms`. Only used to word the
        -- platform-settlement mismatch message, never to gate money.
        CASE WHEN $EXTERNAL_PLATFORM_PREDICATE THEN 1 ELSE 0 END,
        -- 16: do we actually KNOW how the platform settles this order?
        CASE
            WHEN json_valid(COALESCE(o.ghost_metadata, ''))
                 AND json_extract(o.ghost_metadata, '$.food_delivery') IS NOT NULL
                THEN 1
            ELSE 0
        END"
        .replace(
            "$EXTERNAL_PLATFORM_PREDICATE",
            &crate::platforms::external_marketplace_sql_predicate("o.plugin"),
        )
}

/// Reads the 17 columns of [`order_blocker_row_select`] into a [`RawBlockerRow`].
fn read_blocker_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawBlockerRow> {
    Ok(RawBlockerRow {
        order_id: row.get(0)?,
        order_number: row.get(1)?,
        // W4b: cols 2 and 3 select INTEGER cents columns.
        total_amount: Cents::new(row.get::<_, i64>(2)?),
        settled_amount: Cents::new(row.get::<_, i64>(3)?),
        payment_status: row.get(4)?,
        payment_method: row.get(5)?,
        completed_payment_count: row.get(6)?,
        invalid_completed_method_count: row.get(7)?,
        tip_total: Cents::new(row.get::<_, i64>(8)?),
        net_settled_amount: Cents::new(row.get::<_, i64>(9)?),
        duplicate_transaction_ref_groups: row.get(10)?,
        duplicate_amount_groups: row.get(11)?,
        expected_platform_settlement: ExpectedPlatformSettlement::from_sql(row.get::<_, i64>(12)?),
        platform_settled_amount: Cents::new(row.get::<_, i64>(13)?),
        drawer_tender_amount: Cents::new(row.get::<_, i64>(14)?),
        is_external_platform: row.get::<_, i64>(15)? == 1,
        platform_disposition_known: row.get::<_, i64>(16)? == 1,
    })
}

fn map_blocker_rows<F>(
    rows: rusqlite::MappedRows<'_, F>,
) -> Result<Vec<UnsettledPaymentBlocker>, String>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<RawBlockerRow>,
{
    let mut blockers = Vec::new();
    for row in rows {
        let mut raw = row.map_err(|e| format!("collect payment blocker row: {e}"))?;
        raw.payment_status = normalize_payment_status(raw.payment_status.as_str());
        raw.payment_method = normalize_payment_method(raw.payment_method.as_str());
        if let Some(blocker) = classify_blocker_row(raw) {
            blockers.push(blocker);
        }
    }
    Ok(blockers)
}

pub fn load_order_payment_blockers(
    conn: &Connection,
    order_id: &str,
) -> Result<Vec<UnsettledPaymentBlocker>, String> {
    let sql = format!(
        "{} FROM orders o
         WHERE o.id = ?1
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled', 'refunded')",
        order_blocker_row_select()
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare order payment blocker lookup: {e}"))?;
    let rows = stmt
        .query_map(params![order_id], read_blocker_row)
        .map_err(|e| format!("query order payment blocker lookup: {e}"))?;

    map_blocker_rows(rows)
}

pub fn load_branch_window_payment_blockers(
    conn: &Connection,
    branch_id: &str,
    period_start_at: &str,
    cutoff_at: Option<&str>,
    lower_bound_inclusive: bool,
) -> Result<Vec<UnsettledPaymentBlocker>, String> {
    let operator = if lower_bound_inclusive { ">=" } else { ">" };
    let order_financial_expr = business_day::order_financial_timestamp_expr("o");
    // Open tabs are exempt from blocking closeout; the same shared predicate
    // excludes them from Z revenue and protects them from rollover deletion
    // (see business_day::open_table_tab_expr).
    let open_table_tab_expr = business_day::open_table_tab_expr("o");
    // A day the last Z already closed cannot reopen through the checkout gate:
    // its paid orders lost their local payment rows to the rollover cleanup by
    // design, so they are excluded here no matter what bumped their updated_at
    // into this window (see business_day::paid_order_swept_by_last_z_expr).
    let swept_by_last_z_expr = business_day::paid_order_swept_by_last_z_expr("o", "?4");
    let last_z_anchor = business_day::last_z_anchor_utc(conn);
    // Population parity with the Z aggregates (review item E, 16/09/2026).
    // This loader feeds the day-close gate AND `integrity.findings`, so it must
    // count the same orders the Z counts, or the panel shows a blocker behind a
    // number that is not there.
    //
    // `is_test` (sandbox integration orders) is excluded everywhere in
    // `zreport.rs` and was NOT excluded here: a sandbox order left `paid`
    // without a ledger row blocked a real day close while contributing to
    // neither `orderTurnover` nor `paymentCoverage`. Test data is not money, so
    // dropping it cannot hide a real gap.
    //
    // `order_context = 'repair_settlement'` is deliberately NOT excluded. Those
    // orders are outside the Z's SALES aggregates (the repairs workspace
    // recognises them, see `load_server_repair_projection`), but they carry
    // real `order_payments` rows and real money. A repair settlement claiming
    // `paid` with no ledger row is a genuine gap, so it still blocks — it just
    // moves neither side of the turnover/coverage difference, which is why a
    // blocking finding can legitimately sit next to `unexplainedDifference` 0.
    let sql = format!(
        "{} FROM orders o
         WHERE {order_financial_expr} {operator} ?1
           AND (?2 IS NULL OR {order_financial_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
           AND NOT {open_table_tab_expr}
           AND NOT {swept_by_last_z_expr}
         ORDER BY COALESCE(o.updated_at, o.created_at) ASC, o.id ASC",
        order_blocker_row_select()
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare branch payment blocker lookup: {e}"))?;
    let rows = stmt
        .query_map(
            params![period_start_at, cutoff_at, branch_id, last_z_anchor],
            read_blocker_row,
        )
        .map_err(|e| format!("query branch payment blocker lookup: {e}"))?;

    map_blocker_rows(rows)
}

pub fn build_unsettled_payment_blocker_message(
    action_label: &str,
    blockers: &[UnsettledPaymentBlocker],
) -> Option<String> {
    if blockers.is_empty() {
        return None;
    }

    let prefix = if action_label.ends_with(':') {
        action_label.to_string()
    } else {
        format!("{action_label}:")
    };

    if blockers.len() == 1 {
        let blocker = &blockers[0];
        return Some(format!(
            "{prefix} {} {} {}",
            blocker.order_number, blocker.reason_text, blocker.suggested_fix
        ));
    }

    let first = &blockers[0];
    Some(format!(
        "{prefix} {} orders are blocked by payment integrity. First blocker {}: {} {}",
        blockers.len(),
        first.order_number,
        first.reason_text,
        first.suggested_fix
    ))
}

pub fn build_unsettled_payment_blocker_response(
    action_label: &str,
    blockers: &[UnsettledPaymentBlocker],
) -> Value {
    let error = build_unsettled_payment_blocker_message(action_label, blockers)
        .unwrap_or_else(|| format!("{action_label}: unresolved payment blockers"));
    json!({
        "success": false,
        "errorCode": UNSETTLED_PAYMENT_BLOCKER_ERROR_CODE,
        "error": error,
        "message": error,
        "blockers": blockers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn test_db() -> crate::db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        crate::db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    #[test]
    fn branch_window_blockers_classify_missing_local_payment_row() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, total_amount_cents,
                status, payment_status, created_at, updated_at
            ) VALUES (
                'ord-missing-local', 'ORD-1', 'branch-1', '[]', 13.7, 1370,
                'completed', 'paid', '2026-03-26T16:53:37Z', '2026-03-26T17:19:54Z'
            )",
            [],
        )
        .unwrap();

        let blockers = load_branch_window_payment_blockers(
            &conn,
            "branch-1",
            "2026-03-26T00:00:00Z",
            Some("2026-03-27T00:00:00Z"),
            true,
        )
        .expect("branch blockers");

        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].reason_code, "missing_local_payment_row");
        assert_eq!(blockers[0].order_number, "ORD-1");
    }

    /// Live 05/09/2026 (Το Μικρό Παρίσι): the 03:36Z Z-report closed the
    /// 04/09 day and its rollover deleted those orders' local payment rows
    /// by design. Later touches (remote snapshot refresh every sweep pass,
    /// platform ack replays) bumped their `updated_at` into the evening
    /// shift's window and 16 already-settled orders blocked the checkout as
    /// "paid but its local payment record is missing". A paid order created
    /// before the last Z with no local payment row IS that Z's footprint —
    /// never a blocker — while the same shape after the Z still is, and a
    /// genuinely unpaid old order still blocks.
    #[test]
    fn branch_window_blockers_ignore_paid_orders_swept_by_the_last_z() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        db::set_setting(
            &conn,
            "system",
            "last_z_report_timestamp",
            "2026-09-05T03:36:16+00:00",
        )
        .expect("seed last Z anchor");

        let seed =
            |id: &str, number: &str, created_at: &str, updated_at: &str, payment_status: &str| {
                conn.execute(
                    "INSERT INTO orders (
                    id, order_number, branch_id, items, total_amount, total_amount_cents,
                    status, payment_status, created_at, updated_at
                ) VALUES (?1, ?2, 'branch-1', '[]', 4.0, 400, 'completed', ?5, ?3, ?4)",
                    params![id, number, created_at, updated_at, payment_status],
                )
                .unwrap();
            };
        // Closed by the Z, payment rows swept, updated_at bumped tonight.
        seed(
            "ord-swept",
            "ORD-20260904-SWEPT",
            "2026-09-04T22:14:32Z",
            "2026-09-05T18:33:00Z",
            "paid",
        );
        // Today's order whose mirror is genuinely missing: still a blocker.
        seed(
            "ord-open",
            "ORD-20260905-OPEN",
            "2026-09-05T17:09:34Z",
            "2026-09-05T18:40:00Z",
            "paid",
        );
        // Old but never paid: the Z sweeps payments, not the debt.
        seed(
            "ord-unpaid-old",
            "ORD-20260904-UNPAID",
            "2026-09-04T23:00:00Z",
            "2026-09-05T18:00:00Z",
            "pending",
        );

        let blockers = load_branch_window_payment_blockers(
            &conn,
            "branch-1",
            "2026-09-05T15:05:40Z",
            Some("2026-09-05T20:00:00Z"),
            true,
        )
        .expect("branch blockers");

        let numbers: Vec<&str> = blockers
            .iter()
            .map(|blocker| blocker.order_number.as_str())
            .collect();
        assert_eq!(numbers, vec!["ORD-20260904-UNPAID", "ORD-20260905-OPEN"]);
        assert_eq!(blockers[0].reason_code, "no_persisted_payment");
        assert_eq!(blockers[1].reason_code, "missing_local_payment_row");

        // Without any Z on this terminal nothing is history yet: the old paid
        // order is a real missing mirror and blocks like before.
        conn.execute(
            "DELETE FROM local_settings WHERE setting_category = 'system' AND setting_key = 'last_z_report_timestamp'",
            [],
        )
        .unwrap();
        let blockers = load_branch_window_payment_blockers(
            &conn,
            "branch-1",
            "2026-09-05T15:05:40Z",
            Some("2026-09-05T20:00:00Z"),
            true,
        )
        .expect("branch blockers without Z");
        assert_eq!(blockers.len(), 3);
    }

    #[test]
    fn platform_settlement_other_rows_do_not_block_checkout() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, total_amount_cents,
                status, payment_status, created_at, updated_at
            ) VALUES (
                'ord-plat-settled', 'ORD-PS-1', 'branch-1', '[]', 8.0, 800,
                'delivered', 'paid', '2026-03-26T16:53:37Z', '2026-03-26T17:19:54Z'
            )",
            [],
        )
        .unwrap();
        // THE-437 bank settlement: method 'other' with the canonical marker.
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, transaction_ref,
                sync_status, created_at, updated_at
            ) VALUES (
                'pay-plat-settled', 'ord-plat-settled', 'other', 8.0, 800, 'completed',
                'platform_settlement:online:ord-plat-settled', 'pending',
                datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();

        let order_blockers =
            load_order_payment_blockers(&conn, "ord-plat-settled").expect("order blockers");
        assert!(
            order_blockers.is_empty(),
            "a fully settled platform order must not block: {order_blockers:?}"
        );
        let window_blockers = load_branch_window_payment_blockers(
            &conn,
            "branch-1",
            "2026-03-26T00:00:00Z",
            Some("2026-03-27T00:00:00Z"),
            true,
        )
        .expect("window blockers");
        assert!(
            window_blockers.is_empty(),
            "shift checkout must accept platform settlements: {window_blockers:?}"
        );

        // A generic 'other' row WITHOUT the settlement marker still blocks —
        // the guard narrows only the THE-437 shape, nothing else.
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, total_amount_cents,
                status, payment_status, created_at, updated_at
            ) VALUES (
                'ord-generic-other', 'ORD-GO-1', 'branch-1', '[]', 5.0, 500,
                'completed', 'paid', '2026-03-26T16:53:37Z', '2026-03-26T17:19:54Z'
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, transaction_ref,
                sync_status, created_at, updated_at
            ) VALUES (
                'pay-generic-other', 'ord-generic-other', 'other', 5.0, 500, 'completed',
                'MANUAL-REF-1', 'pending', datetime('now'), datetime('now')
            )",
            [],
        )
        .unwrap();

        let generic_blockers =
            load_order_payment_blockers(&conn, "ord-generic-other").expect("generic blockers");
        assert_eq!(generic_blockers.len(), 1);
        assert_eq!(
            generic_blockers[0].reason_code,
            "unsupported_payment_method"
        );
    }

    #[test]
    fn branch_window_blockers_ignore_open_pending_table_checks() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, total_amount_cents,
                status, order_type, table_number, payment_status, created_at, updated_at
            ) VALUES (
                'ord-table-open', 'ORD-TABLE-1', 'branch-1', '[]', 11.0, 1100,
                'pending', 'dine-in', 'T1', 'pending',
                '2026-03-26T16:53:37Z', '2026-03-26T17:19:54Z'
            )",
            [],
        )
        .unwrap();

        let blockers = load_branch_window_payment_blockers(
            &conn,
            "branch-1",
            "2026-03-26T00:00:00Z",
            Some("2026-03-27T00:00:00Z"),
            true,
        )
        .expect("branch blockers");

        assert!(
            blockers.is_empty(),
            "open table checks should not show as missing checkout payments"
        );
    }

    #[test]
    fn branch_window_blockers_classify_partial_split_payment() {
        // W6: the test previously seeded `payment_method='split'` on the
        // order row to force the split-blocker branch. Post-v55 the split
        // classification is derived from `order_payments` — seed two
        // different-method completed rows so derive returns "split".
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, total_amount_cents,
                status, payment_status, created_at, updated_at
            ) VALUES (
                'ord-split', 'ORD-2', 'branch-1', '[]', 20.0, 2000,
                'completed', 'partially_paid',
                '2026-03-26T16:53:37Z', '2026-03-26T17:19:54Z'
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, created_at, updated_at
            ) VALUES (
                'pay-split-cash', 'ord-split', 'cash', 8.0, 800, 'completed',
                '2026-03-26T16:55:00Z', '2026-03-26T16:55:00Z'
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, created_at, updated_at
            ) VALUES (
                'pay-split-card', 'ord-split', 'card', 4.0, 400, 'completed',
                '2026-03-26T16:56:00Z', '2026-03-26T16:56:00Z'
            )",
            [],
        )
        .unwrap();

        let blockers = load_branch_window_payment_blockers(
            &conn,
            "branch-1",
            "2026-03-26T00:00:00Z",
            Some("2026-03-27T00:00:00Z"),
            true,
        )
        .expect("branch blockers");

        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].reason_code, "split_payment_incomplete");
        assert!(
            blockers[0].suggested_fix.contains("Resume split payment"),
            "split payments should suggest resuming the split flow"
        );
    }

    /// Founder review, 16/09/2026, test 7: «το Z να μπλοκάρει missing platform
    /// settlement ακόμα με payment_status=pending».
    ///
    /// The finding used to require `payment_status == "paid"`, which made it
    /// depend on the very field a failed settlement honestly corrects
    /// downward. Write the truthful `pending` and the gap went silent exactly
    /// when it mattered most. The disposition is what owes the settlement row,
    /// so the disposition is what raises the finding.
    #[test]
    fn missing_platform_settlement_blocks_the_z_whatever_the_payment_status_says() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        const PREPAID: &str = r#"{"food_delivery":{"payment_method":"online","prepaid":true}}"#;
        const PLATFORM_COD: &str = r#"{"food_delivery":{"payment_method":"cash","prepaid":false,"delivery_provider":"platform_delivery"}}"#;

        // Every ledger status a failed settlement can legitimately leave
        // behind, plus the original 'paid' shape.
        for (index, status) in ["pending", "paid", "partially_paid"].iter().enumerate() {
            for (kind, metadata) in [("prepaid", PREPAID), ("platcod", PLATFORM_COD)] {
                let id = format!("ord-{kind}-{index}");
                seed_order(&conn, &id, 1450, status, Some("efood"), Some(metadata));
            }
        }

        let blockers = load_branch_window_payment_blockers(
            &conn,
            "branch-1",
            "2026-03-26T00:00:00Z",
            Some("2026-03-27T00:00:00Z"),
            true,
        )
        .expect("branch blockers");

        assert_eq!(
            blockers.len(),
            6,
            "every shape must be reported: {blockers:?}"
        );
        for blocker in &blockers {
            assert_eq!(
                blocker.reason_code, "platform_settlement_missing",
                "{}: {blocker:?}",
                blocker.order_id
            );
            assert!(
                blocker.is_blocking(),
                "{}: a missing settlement must BLOCK the close",
                blocker.order_id
            );
            assert!(
                !blocker.reason_text.contains("marked paid"),
                "{}: the text must not claim a status the order may not have: {}",
                blocker.order_id,
                blocker.reason_text
            );
        }

        // Control: once the canonical settlement row exists, the finding is
        // gone — even though the order is still `pending`. Coverage, not
        // status, is what clears it.
        seed_order(
            &conn,
            "ord-settled",
            1450,
            "pending",
            Some("efood"),
            Some(PREPAID),
        );
        seed_payment(
            &conn,
            "pay-settled",
            "ord-settled",
            "other",
            1450,
            Some("platform_settlement:online:ord-settled"),
        );
        let settled = load_order_payment_blockers(&conn, "ord-settled").expect("order blockers");
        assert!(
            settled.is_empty(),
            "a settled platform order is clean regardless of payment_status: {settled:?}"
        );
    }

    #[test]
    fn branch_window_blockers_skip_sandbox_orders_so_test_data_cannot_block_a_real_close() {
        // Review item E (founder, 16/09/2026): the day-close gate and the Z
        // aggregates must count the same orders. `is_test` orders are excluded
        // from every aggregate in `zreport.rs`, so a sandbox order left `paid`
        // with no ledger row used to block a real Z while contributing to
        // neither `orderTurnover` nor `paymentCoverage` — a blocker with no
        // number behind it, and no money behind it either.
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, total_amount_cents,
                status, payment_status, integration_environment, is_test,
                created_at, updated_at
            ) VALUES (
                'ord-sandbox-gate', 'TEST-1', 'branch-1', '[]', 44.0, 4400,
                'completed', 'paid', 'sandbox', 1,
                '2026-03-26T16:53:37Z', '2026-03-26T16:53:37Z'
            )",
            [],
        )
        .unwrap();
        // The same shape on a PRODUCTION order still blocks — this is the
        // control that proves the filter narrowed the population and did not
        // silence the finding.
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, total_amount_cents,
                status, payment_status, created_at, updated_at
            ) VALUES (
                'ord-live-gate', 'LIVE-1', 'branch-1', '[]', 44.0, 4400,
                'completed', 'paid',
                '2026-03-26T16:53:37Z', '2026-03-26T16:53:37Z'
            )",
            [],
        )
        .unwrap();

        let blockers = load_branch_window_payment_blockers(
            &conn,
            "branch-1",
            "2026-03-26T00:00:00Z",
            Some("2026-03-27T00:00:00Z"),
            true,
        )
        .expect("branch blockers");

        let ids: Vec<&str> = blockers.iter().map(|b| b.order_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["ord-live-gate"],
            "only the production order may block: {blockers:?}"
        );
    }

    #[test]
    fn branch_window_blockers_still_catch_repair_settlement_orders() {
        // The deliberate half of the same parity review: repair settlements sit
        // outside the Z's SALES aggregates (the repairs workspace recognises
        // them) but they carry real money, so a repair settlement claiming
        // `paid` with no ledger row must still refuse to close the day.
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, total_amount_cents,
                status, payment_status, order_context, created_at, updated_at
            ) VALUES (
                'ord-repair-gate', 'REP-1', 'branch-1', '[]', 60.0, 6000,
                'completed', 'paid', 'repair_settlement',
                '2026-03-26T16:53:37Z', '2026-03-26T16:53:37Z'
            )",
            [],
        )
        .unwrap();

        let blockers = load_branch_window_payment_blockers(
            &conn,
            "branch-1",
            "2026-03-26T00:00:00Z",
            Some("2026-03-27T00:00:00Z"),
            true,
        )
        .expect("branch blockers");

        assert_eq!(blockers.len(), 1, "{blockers:?}");
        assert_eq!(blockers[0].order_id, "ord-repair-gate");
        assert!(
            blockers[0].is_blocking(),
            "repair-settlement money is still money: {:?}",
            blockers[0]
        );
    }

    // ------------------------------------------------------------------
    // 16/09/2026 reconciliation work: settlement-shape findings.
    //
    // Before this, `classify_blocker_row` only asked «is enough money
    // recorded?», so an order holding TOO MUCH money, the same transaction
    // twice, or the right total in the wrong tender all read as settled and
    // the Z closed silently over them.
    // ------------------------------------------------------------------

    /// Seed one order plus its completed payments. `ghost_metadata` is raw so
    /// a test can pin the "no disposition recorded" case exactly.
    fn seed_order(
        conn: &Connection,
        id: &str,
        total_cents: i64,
        payment_status: &str,
        plugin: Option<&str>,
        ghost_metadata: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, total_amount_cents,
                status, payment_status, plugin, ghost_metadata, created_at, updated_at
            ) VALUES (?1, ?2, 'branch-1', '[]', ?3, ?4, 'completed', ?5, ?6, ?7,
                      '2026-03-26T16:53:37Z', '2026-03-26T17:19:54Z')",
            params![
                id,
                format!("ORD-{id}"),
                total_cents as f64 / 100.0,
                total_cents,
                payment_status,
                plugin,
                ghost_metadata,
            ],
        )
        .unwrap();
    }

    fn seed_payment(
        conn: &Connection,
        id: &str,
        order_id: &str,
        method: &str,
        amount_cents: i64,
        transaction_ref: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, transaction_ref,
                sync_status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6, 'pending',
                      '2026-03-26T17:00:00Z', '2026-03-26T17:00:00Z')",
            params![
                id,
                order_id,
                method,
                amount_cents as f64 / 100.0,
                amount_cents,
                transaction_ref,
            ],
        )
        .unwrap();
    }

    fn order_reason(conn: &Connection, order_id: &str) -> Option<String> {
        load_order_payment_blockers(conn, order_id)
            .expect("order blockers")
            .first()
            .map(|blocker| blocker.reason_code.clone())
    }

    #[test]
    fn overpaid_order_is_a_blocking_finding() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(&conn, "ord-over", 1000, "paid", Some("pos"), None);
        seed_payment(&conn, "pay-over-a", "ord-over", "cash", 1000, None);
        seed_payment(&conn, "pay-over-b", "ord-over", "cash", 1000, None);

        let blockers = load_order_payment_blockers(&conn, "ord-over").expect("blockers");
        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].reason_code, "overpaid_order");
        assert!(blockers[0].is_blocking());
        // Negative difference: the ledger holds more than the order is worth.
        assert_eq!(blockers[0].difference_cents, -1000);
        assert!(
            blockers[0].suggested_fix.contains("same method and amount"),
            "the duplicate (method, amount) signal should name the likely cause"
        );
    }

    #[test]
    fn duplicate_transaction_reference_is_reported_even_when_totals_balance() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // Two halves of a split that replayed under ONE card authorisation:
        // the money adds up, but one real transaction settled twice.
        seed_order(&conn, "ord-dup", 1000, "paid", Some("pos"), None);
        seed_payment(&conn, "pay-dup-a", "ord-dup", "card", 500, Some("auth-123"));
        seed_payment(&conn, "pay-dup-b", "ord-dup", "card", 500, Some("auth-123"));

        assert_eq!(
            order_reason(&conn, "ord-dup").as_deref(),
            Some("duplicate_payment")
        );
    }

    #[test]
    fn two_guests_paying_the_same_amount_is_not_a_duplicate() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(&conn, "ord-split-even", 1000, "paid", Some("pos"), None);
        seed_payment(&conn, "pay-even-a", "ord-split-even", "cash", 500, None);
        seed_payment(&conn, "pay-even-b", "ord-split-even", "cash", 500, None);

        assert_eq!(order_reason(&conn, "ord-split-even"), None);
    }

    #[test]
    fn a_refund_then_recollect_cycle_is_not_an_overpayment() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(&conn, "ord-refund", 1000, "paid", Some("pos"), None);
        seed_payment(&conn, "pay-refund-a", "ord-refund", "cash", 1000, None);
        seed_payment(&conn, "pay-refund-b", "ord-refund", "card", 1000, None);
        conn.execute(
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount, amount_cents, reason,
                created_at, updated_at
            ) VALUES ('adj-1', 'pay-refund-a', 'ord-refund', 'refund', 10.0, 1000,
                      'customer switched to card', '2026-03-26T17:05:00Z', '2026-03-26T17:05:00Z')",
            [],
        )
        .unwrap();

        // Gross is 20.00 against a 10.00 order, but NET is 10.00.
        assert_eq!(order_reason(&conn, "ord-refund"), None);
    }

    #[test]
    fn platform_held_money_recorded_as_drawer_cash_is_a_mismatch() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "ord-efood-cash",
            1000,
            "paid",
            Some("efood"),
            Some(r#"{"food_delivery":{"prepaid":true,"payment_method":"online"}}"#),
        );
        seed_payment(
            &conn,
            "pay-efood-cash",
            "ord-efood-cash",
            "cash",
            1000,
            None,
        );

        assert_eq!(
            order_reason(&conn, "ord-efood-cash").as_deref(),
            Some("platform_settlement_mismatch")
        );
    }

    #[test]
    fn our_own_drivers_cash_booked_as_platform_money_is_a_mismatch() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // efood order OUR driver delivers: the cash is really in our drawer,
        // so crediting the platform with it double-counts the money.
        seed_order(
            &conn,
            "ord-efood-ours",
            1000,
            "paid",
            Some("efood"),
            Some(
                r#"{"food_delivery":{"payment_method":"cash","delivery_provider":"vendor_delivery"}}"#,
            ),
        );
        seed_payment(
            &conn,
            "pay-efood-ours",
            "ord-efood-ours",
            "other",
            1000,
            Some("platform_settlement:cod:ord-efood-ours"),
        );

        assert_eq!(
            order_reason(&conn, "ord-efood-ours").as_deref(),
            Some("platform_settlement_mismatch")
        );
    }

    #[test]
    fn a_platform_order_our_driver_settled_in_cash_is_clean() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "ord-efood-drawer",
            1000,
            "paid",
            Some("efood"),
            Some(
                r#"{"food_delivery":{"payment_method":"cash","delivery_provider":"vendor_delivery"}}"#,
            ),
        );
        seed_payment(&conn, "pay-drawer", "ord-efood-drawer", "cash", 1000, None);

        assert_eq!(order_reason(&conn, "ord-efood-drawer"), None);
    }

    #[test]
    fn a_paid_platform_order_with_no_settlement_is_reported_specifically() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // The efood half of the 16/09/2026 incident: 13 orders, EUR 145,20,
        // paid on the order row and absent from the ledger.
        seed_order(
            &conn,
            "ord-efood-bare",
            1120,
            "paid",
            Some("efood"),
            Some(r#"{"food_delivery":{"prepaid":true}}"#),
        );

        let blockers = load_order_payment_blockers(&conn, "ord-efood-bare").expect("blockers");
        assert_eq!(blockers.len(), 1, "one finding per order, most specific");
        assert_eq!(blockers[0].reason_code, "platform_settlement_missing");
        assert_eq!(blockers[0].difference_cents, 1120);
    }

    #[test]
    fn a_settlement_row_without_a_recorded_disposition_is_left_alone() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // Legacy platform rows (and rows a rollover stripped) carry no
        // `food_delivery` metadata. The settlement reference is itself the
        // POS's record that it classified the order as platform-held, so
        // "unknown" must never be reported as "wrong".
        seed_order(&conn, "ord-legacy-plat", 800, "paid", None, None);
        seed_payment(
            &conn,
            "pay-legacy-plat",
            "ord-legacy-plat",
            "other",
            800,
            Some("platform_settlement:online:ord-legacy-plat"),
        );

        assert_eq!(order_reason(&conn, "ord-legacy-plat"), None);
    }

    #[test]
    fn plugin_pos_is_never_treated_as_an_external_platform_by_the_gate() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // «POS x37»: the store's own till must not be read as a platform,
        // here or anywhere else.
        seed_order(&conn, "ord-pos-plain", 1000, "paid", Some("pos"), None);
        seed_payment(&conn, "pay-pos-plain", "ord-pos-plain", "cash", 1000, None);

        assert_eq!(order_reason(&conn, "ord-pos-plain"), None);

        seed_order(&conn, "ord-pos-unpaid", 1000, "paid", Some("pos"), None);
        let blockers = load_order_payment_blockers(&conn, "ord-pos-unpaid").expect("blockers");
        assert_eq!(blockers.len(), 1);
        // Not `platform_settlement_missing` — a POS order has no platform.
        assert_eq!(blockers[0].reason_code, "missing_local_payment_row");
    }

    #[test]
    fn findings_carry_severity_and_a_signed_difference() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(&conn, "ord-short", 2000, "paid", Some("pos"), None);
        seed_payment(&conn, "pay-short", "ord-short", "cash", 1500, None);

        let blockers = load_order_payment_blockers(&conn, "ord-short").expect("blockers");
        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].severity, "blocking");
        assert!(blockers[0].is_blocking());
        assert_eq!(blockers[0].difference_cents, 500);
    }

    /// 17/09/2026: a Greek till showed its operator the sentences below in
    /// English, because they are written here and had no locale entry. The
    /// renderer now writes them, and needs the money and the arm separately to
    /// do it. If either stops being emitted, the translated sentence loses its
    /// figure or says the wrong thing — so both are pinned.
    #[test]
    fn a_mismatch_carries_the_money_and_the_arm_the_sentence_needs() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "ord-efood-locale",
            650,
            "paid",
            Some("efood"),
            Some(r#"{"food_delivery":{"prepaid":true,"payment_method":"online"}}"#),
        );
        seed_payment(
            &conn,
            "pay-efood-locale",
            "ord-efood-locale",
            "card",
            650,
            None,
        );

        let blockers = load_order_payment_blockers(&conn, "ord-efood-locale").expect("blockers");
        assert_eq!(blockers[0].reason_code, "platform_settlement_mismatch");
        assert_eq!(
            blockers[0].reason_variant.as_deref(),
            Some("platform_holds"),
            "the platform-holds arm must be named, or Greek says the opposite"
        );
        assert_eq!(blockers[0].reason_amounts.get("drawerAmount"), Some(&650));
        // The English sentence stays as the fallback for an untranslated code.
        assert!(
            blockers[0].reason_text.contains("6.50"),
            "{:?}",
            blockers[0]
        );
    }

    #[test]
    fn the_reverse_arm_is_named_separately_and_carries_its_own_money() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "ord-ours-locale",
            650,
            "paid",
            Some("efood"),
            Some(
                r#"{"food_delivery":{"payment_method":"cash","delivery_provider":"vendor_delivery"}}"#,
            ),
        );
        seed_payment(
            &conn,
            "pay-ours-locale",
            "ord-ours-locale",
            "other",
            650,
            Some("platform_settlement:cod:ord-ours-locale"),
        );

        let blockers = load_order_payment_blockers(&conn, "ord-ours-locale").expect("blockers");
        assert_eq!(blockers[0].reason_code, "platform_settlement_mismatch");
        assert_eq!(
            blockers[0].reason_variant.as_deref(),
            Some("store_collects_platform_order"),
        );
        assert_eq!(
            blockers[0].reason_amounts.get("platformSettledAmount"),
            Some(&650),
        );
    }

    /// The live 17/09/2026 order, end to end: the wrongly recorded drawer row
    /// is voided, and the settlement the platform owes is recorded from the
    /// order's own disposition. The Z must be clean afterwards — not holding a
    /// second blocker, which is where the printed advice «void the cash/card
    /// row» alone would have left the operator.
    #[test]
    fn voiding_the_drawer_row_and_settling_leaves_the_order_clean() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(
            &conn,
            "ord-efood-live",
            650,
            "paid",
            Some("efood"),
            Some(
                r#"{"food_delivery":{"prepaid":true,"payment_method":"online","delivery_provider":"platform_delivery"}}"#,
            ),
        );
        seed_payment(
            &conn,
            "pay-manual-card",
            "ord-efood-live",
            "card",
            650,
            None,
        );
        assert_eq!(
            order_reason(&conn, "ord-efood-live").as_deref(),
            Some("platform_settlement_mismatch"),
        );

        // Void the manual card row: the money never entered the drawer.
        conn.execute(
            "UPDATE order_payments SET status = 'voided' WHERE id = 'pay-manual-card'",
            [],
        )
        .expect("void the drawer row");

        // Voiding alone is not enough — this is the trap.
        assert_eq!(
            order_reason(&conn, "ord-efood-live").as_deref(),
            Some("platform_settlement_missing"),
            "a void on its own swaps one blocker for another"
        );

        assert!(
            crate::payments::auto_settle_platform_order(&conn, "ord-efood-live")
                .expect("settle from disposition"),
            "a prepaid platform-delivery order must be eligible"
        );

        assert_eq!(
            order_reason(&conn, "ord-efood-live"),
            None,
            "the Z must be clean once the settlement is recorded"
        );
    }

    /// The eligibility rule behind the one-action correction. It must reach the
    /// wrongly recorded till row on platform-held money, and nothing else.
    #[test]
    fn only_platform_held_money_exposes_its_till_rows_to_the_repair() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // (a) Prepaid online, platform delivery — the live 17/09/2026 shape.
        seed_order(
            &conn,
            "ord-prepaid",
            650,
            "paid",
            Some("efood"),
            Some(
                r#"{"food_delivery":{"prepaid":true,"payment_method":"online","delivery_provider":"platform_delivery"}}"#,
            ),
        );
        seed_payment(&conn, "pay-prepaid", "ord-prepaid", "card", 650, None);
        assert_eq!(
            crate::payments::platform_held_drawer_payment_ids(&conn, "ord-prepaid")
                .expect("eligibility"),
            vec!["pay-prepaid".to_string()],
        );

        // (b) A platform order OUR driver carried: that cash is genuinely ours.
        seed_order(
            &conn,
            "ord-our-driver",
            650,
            "paid",
            Some("efood"),
            Some(
                r#"{"food_delivery":{"payment_method":"cash","delivery_provider":"vendor_delivery"}}"#,
            ),
        );
        seed_payment(&conn, "pay-our-driver", "ord-our-driver", "cash", 650, None);
        assert!(
            crate::payments::platform_held_drawer_payment_ids(&conn, "ord-our-driver")
                .expect("eligibility")
                .is_empty(),
            "money our own driver brought back must be unreachable"
        );

        // (c) A plain store order.
        seed_order(&conn, "ord-store", 650, "paid", Some("pos"), None);
        seed_payment(&conn, "pay-store", "ord-store", "cash", 650, None);
        assert!(
            crate::payments::platform_held_drawer_payment_ids(&conn, "ord-store")
                .expect("eligibility")
                .is_empty(),
            "a store order's takings must be unreachable"
        );

        // (d) The settlement row itself is never a till row.
        seed_order(
            &conn,
            "ord-settled",
            650,
            "paid",
            Some("efood"),
            Some(r#"{"food_delivery":{"prepaid":true,"payment_method":"online"}}"#),
        );
        seed_payment(
            &conn,
            "pay-settled",
            "ord-settled",
            "other",
            650,
            Some("platform_settlement:online:ord-settled"),
        );
        assert!(
            crate::payments::platform_held_drawer_payment_ids(&conn, "ord-settled")
                .expect("eligibility")
                .is_empty(),
            "the settlement row must never be voided by this repair"
        );
    }

    /// An order that is simply short carries no extra figures: its sentence is
    /// written from the total and settled amounts the blocker already has.
    #[test]
    fn a_plain_shortfall_carries_no_reason_amounts_and_no_arm() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        seed_order(&conn, "ord-plain", 2000, "paid", Some("pos"), None);
        seed_payment(&conn, "pay-plain", "ord-plain", "cash", 1500, None);

        let blockers = load_order_payment_blockers(&conn, "ord-plain").expect("blockers");
        assert!(blockers[0].reason_amounts.is_empty());
        assert_eq!(blockers[0].reason_variant, None);
    }
}
