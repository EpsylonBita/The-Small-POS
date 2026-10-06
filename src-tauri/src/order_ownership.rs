use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use uuid::Uuid;

use crate::business_day;
use crate::money::Cents;

pub struct DriverOwnershipAssignment {
    pub driver_shift_id: String,
    pub branch_id: String,
    pub delivery_fee: f64,
    pub tip_amount: f64,
    pub payment_method: String,
    pub cash_collected: f64,
    pub card_amount: f64,
}

#[allow(dead_code)]
pub struct OrderAttributionSnapshot {
    pub shift_id: Option<String>,
    pub staff_id: Option<String>,
    pub driver_id: Option<String>,
    pub driver_name: Option<String>,
    pub branch_id: String,
    pub terminal_id: String,
    pub delivery_fee: f64,
    pub tip_amount: f64,
    pub status: String,
    pub order_type: String,
    pub payment_method: String,
    pub cash_collected: f64,
    pub card_amount: f64,
    pub total_paid: f64,
    pub recorded_cash_collected: f64,
    pub recorded_card_amount: f64,
}

fn normalize_opt_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn resolve_historical_financial_owner(
    conn: &Connection,
    current: &OrderAttributionSnapshot,
    financial_effective_at: &str,
) -> Result<Option<(String, String)>, String> {
    if let Some(current_shift_id) = current.shift_id.as_deref() {
        if let Some((role_type, staff_id, _, _)) = resolve_shift_context(conn, current_shift_id)? {
            if matches!(role_type.as_str(), "cashier" | "manager")
                && business_day::shift_contains_timestamp(
                    conn,
                    current_shift_id,
                    financial_effective_at,
                )?
            {
                return Ok(Some((current_shift_id.to_string(), staff_id)));
            }
        }
    }

    if current.branch_id.trim().is_empty() {
        return Ok(None);
    }

    business_day::find_cashier_owner_for_timestamp(
        conn,
        current.branch_id.as_str(),
        financial_effective_at,
    )
}

fn resolve_shift_context(
    conn: &Connection,
    shift_id: &str,
) -> Result<Option<(String, String, String, String)>, String> {
    let shift_context = conn
        .query_row(
            "SELECT
                role_type,
                staff_id,
                COALESCE(branch_id, ''),
                COALESCE(terminal_id, '')
             FROM staff_shifts
             WHERE id = ?1
             LIMIT 1",
            params![shift_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .ok();

    Ok(shift_context)
}

pub fn resolve_active_cashier_assignment(
    conn: &Connection,
    branch_id: &str,
    terminal_id: &str,
) -> Result<Option<(String, String)>, String> {
    let assignment = conn
        .query_row(
            "SELECT ss.id, ss.staff_id
             FROM staff_shifts ss
             LEFT JOIN cash_drawer_sessions cds
               ON cds.staff_shift_id = ss.id
              AND cds.closed_at IS NULL
             WHERE ss.branch_id = ?1
               AND ss.terminal_id = ?2
               AND ss.status = 'active'
               AND ss.role_type IN ('cashier', 'manager')
             ORDER BY
               CASE WHEN cds.id IS NULL THEN 1 ELSE 0 END,
               ss.check_in_time DESC
             LIMIT 1",
            params![branch_id, terminal_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();

    Ok(assignment)
}

pub fn resolve_active_cashier_assignment_for_branch(
    conn: &Connection,
    branch_id: &str,
) -> Result<Option<(String, String)>, String> {
    let assignment = conn
        .query_row(
            "SELECT ss.id, ss.staff_id
             FROM staff_shifts ss
             LEFT JOIN cash_drawer_sessions cds
               ON cds.staff_shift_id = ss.id
              AND cds.closed_at IS NULL
             WHERE ss.branch_id = ?1
               AND ss.status = 'active'
               AND ss.role_type IN ('cashier', 'manager')
             ORDER BY
               CASE WHEN cds.id IS NULL THEN 1 ELSE 0 END,
               ss.check_in_time DESC
             LIMIT 1",
            params![branch_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();

    Ok(assignment)
}

pub fn resolve_order_owner(
    conn: &Connection,
    order_type: &str,
    branch_id: &str,
    terminal_id: &str,
    driver_id: Option<&str>,
    requested_shift_id: Option<&str>,
    requested_staff_id: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    let normalized_order_type = order_type.trim().to_ascii_lowercase();
    let normalized_driver_id = normalize_opt_text(driver_id);
    let normalized_shift_id = normalize_opt_text(requested_shift_id);
    let mut normalized_staff_id = normalize_opt_text(requested_staff_id);
    let mut effective_branch_id = normalize_opt_text(Some(branch_id));
    let mut effective_terminal_id = normalize_opt_text(Some(terminal_id));

    if let Some(shift_id) = normalized_shift_id.as_deref() {
        if let Some((shift_role, shift_staff_id, shift_branch_id, shift_terminal_id)) =
            resolve_shift_context(conn, shift_id)?
        {
            if effective_branch_id.is_none() {
                effective_branch_id = normalize_opt_text(Some(shift_branch_id.as_str()));
            }
            if effective_terminal_id.is_none() {
                effective_terminal_id = normalize_opt_text(Some(shift_terminal_id.as_str()));
            }
            if normalized_staff_id.is_none() {
                normalized_staff_id = Some(shift_staff_id.clone());
            }
            let _ = shift_role;
        }
    }

    if normalized_order_type == "delivery" {
        if let Some(driver_id_value) = normalized_driver_id.as_deref() {
            if let Some(driver_shift_id) =
                resolve_driver_shift_id(conn, driver_id_value, normalized_shift_id.as_deref())?
            {
                return Ok((Some(driver_shift_id), Some(driver_id_value.to_string())));
            }
        }
    }

    if let (Some(branch_id_value), Some(terminal_id_value)) = (
        effective_branch_id.as_deref(),
        effective_terminal_id.as_deref(),
    ) {
        if let Some((cashier_shift_id, cashier_staff_id)) =
            resolve_active_cashier_assignment(conn, branch_id_value, terminal_id_value)?
        {
            return Ok((Some(cashier_shift_id), Some(cashier_staff_id)));
        }
    }

    if let Some(branch_id_value) = effective_branch_id.as_deref() {
        if let Some((cashier_shift_id, cashier_staff_id)) =
            resolve_active_cashier_assignment_for_branch(conn, branch_id_value)?
        {
            return Ok((Some(cashier_shift_id), Some(cashier_staff_id)));
        }
    }

    if normalized_order_type == "delivery" {
        return Ok((None, None));
    }

    let fallback_staff_id = if normalized_order_type == "delivery" {
        normalized_driver_id.or(normalized_staff_id)
    } else {
        normalized_staff_id
    };

    Ok((normalized_shift_id, fallback_staff_id))
}

pub fn resolve_driver_shift_id(
    conn: &Connection,
    driver_id: &str,
    requested_shift_id: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(shift_id) = requested_shift_id.filter(|sid| !sid.trim().is_empty()) {
        let matches_driver = conn
            .query_row(
                "SELECT CASE
                    WHEN staff_id = ?1 AND role_type = 'driver' AND status = 'active'
                    THEN 1 ELSE 0 END
                 FROM staff_shifts
                 WHERE id = ?2",
                params![driver_id, shift_id],
                |row| row.get::<_, i64>(0),
            )
            .ok()
            .unwrap_or(0)
            == 1;

        if matches_driver {
            return Ok(Some(shift_id.to_string()));
        }
    }

    let active_shift_id = conn
        .query_row(
            "SELECT id
             FROM staff_shifts
             WHERE staff_id = ?1
               AND role_type = 'driver'
               AND status = 'active'
             ORDER BY check_in_time DESC
             LIMIT 1",
            params![driver_id],
            |row| row.get::<_, String>(0),
        )
        .ok();

    Ok(active_shift_id)
}

pub fn assign_order_to_driver_shift(
    conn: &Connection,
    order_id: &str,
    driver_id: &str,
    driver_name: Option<&str>,
    driver_shift_id: &str,
    now: &str,
) -> Result<DriverOwnershipAssignment, String> {
    let current = load_order_attribution_snapshot(conn, order_id)?;
    let target_status = if is_final_order_status(&current.status) {
        None
    } else {
        Some("delivered")
    };
    let applied = apply_order_attribution(
        conn,
        order_id,
        Some(driver_shift_id),
        Some(driver_id),
        Some(driver_id),
        driver_name,
        Some("delivery"),
        target_status,
        true,
        now,
    )?;

    Ok(DriverOwnershipAssignment {
        driver_shift_id: driver_shift_id.to_string(),
        branch_id: applied.branch_id,
        delivery_fee: applied.delivery_fee,
        tip_amount: applied.tip_amount,
        payment_method: applied.payment_method,
        cash_collected: applied.cash_collected,
        card_amount: applied.card_amount,
    })
}

pub fn upsert_driver_earning(
    conn: &Connection,
    order_id: &str,
    driver_id: &str,
    assignment: &DriverOwnershipAssignment,
    now: &str,
) -> Result<String, String> {
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM driver_earnings WHERE order_id = ?1 LIMIT 1",
            params![order_id],
            |row| row.get(0),
        )
        .ok();

    let shift_currency = crate::shifts::recorded_operating_currency(
        conn,
        "staff_shifts",
        &assignment.driver_shift_id,
    )?;
    let order_currency = crate::shifts::recorded_operating_currency(conn, "orders", order_id)?;
    let currency = if let Some(id) = &existing_id {
        let original = crate::shifts::recorded_operating_currency(conn, "driver_earnings", id)?;
        if original.is_some() && (original != shift_currency || original != order_currency) {
            return Err("DRIVER_EARNING_CURRENCY_MISMATCH".to_string());
        }
        original
    } else {
        let current =
            crate::shifts::require_shift_operating_currency(conn, &assignment.driver_shift_id)?;
        if order_currency.as_deref() != Some(current.as_str())
            || crate::shifts::require_operating_currency(conn, &assignment.branch_id)? != current
        {
            return Err("DRIVER_EARNING_CURRENCY_MISMATCH".to_string());
        }
        Some(current)
    };
    let total_earning = assignment.delivery_fee + assignment.tip_amount;
    let cash_to_return = assignment.cash_collected;
    // W4c dual-write: every monetary REAL column gets its `_cents` sibling.
    let delivery_fee_cents = Cents::round_half_even(assignment.delivery_fee).as_i64();
    let tip_amount_cents = Cents::round_half_even(assignment.tip_amount).as_i64();
    let total_earning_cents = Cents::round_half_even(total_earning).as_i64();
    let cash_collected_cents = Cents::round_half_even(assignment.cash_collected).as_i64();
    let card_amount_cents = Cents::round_half_even(assignment.card_amount).as_i64();
    let cash_to_return_cents = Cents::round_half_even(cash_to_return).as_i64();

    if let Some(existing_id) = existing_id {
        conn.execute(
            "UPDATE driver_earnings
             SET driver_id = ?1,
                 staff_shift_id = ?2,
                 branch_id = ?3,
                 delivery_fee = ?4, delivery_fee_cents = ?5,
                 tip_amount = ?6, tip_amount_cents = ?7,
                 total_earning = ?8, total_earning_cents = ?9,
                 payment_method = ?10,
                 cash_collected = ?11, cash_collected_cents = ?12,
                 card_amount = ?13, card_amount_cents = ?14,
                 cash_to_return = ?15, cash_to_return_cents = ?16,
                 updated_at = ?17
             WHERE id = ?18",
            params![
                driver_id,
                assignment.driver_shift_id,
                assignment.branch_id,
                assignment.delivery_fee,
                delivery_fee_cents,
                assignment.tip_amount,
                tip_amount_cents,
                total_earning,
                total_earning_cents,
                assignment.payment_method,
                assignment.cash_collected,
                cash_collected_cents,
                assignment.card_amount,
                card_amount_cents,
                cash_to_return,
                cash_to_return_cents,
                now,
                existing_id
            ],
        )
        .map_err(|e| format!("update driver earning: {e}"))?;

        Ok(existing_id)
    } else {
        let earning_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO driver_earnings (
                id, driver_id, staff_shift_id, order_id, branch_id,
                delivery_fee, delivery_fee_cents,
                tip_amount, tip_amount_cents,
                total_earning, total_earning_cents,
                payment_method,
                cash_collected, cash_collected_cents,
                card_amount, card_amount_cents,
                cash_to_return, cash_to_return_cents,
                settled, created_at, updated_at, currency
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 0, ?19, ?19, ?20)",
            params![
                earning_id,
                driver_id,
                assignment.driver_shift_id,
                order_id,
                assignment.branch_id,
                assignment.delivery_fee,
                delivery_fee_cents,
                assignment.tip_amount,
                tip_amount_cents,
                total_earning,
                total_earning_cents,
                assignment.payment_method,
                assignment.cash_collected,
                cash_collected_cents,
                assignment.card_amount,
                card_amount_cents,
                cash_to_return,
                cash_to_return_cents,
                now,
                currency
            ],
        )
        .map_err(|e| format!("insert driver earning: {e}"))?;

        Ok(earning_id)
    }
}

/// What a courier carries for one order, in cents, read from its payment rows
/// only (founder rule 30/09/2026).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CourierTender {
    pub cash_cents: i64,
    pub card_cents: i64,
}

/// The cash and card money a courier carries for `order_id` (item D9, round
/// 2 of the 01/10/2026 fix review; shared rule R2, round 3): each row net of
/// the refunds taken back from it, and the courier's cash net of every cash
/// refund the courier handed back. The same reading as Android's
/// `readCourierOrderTenders`, so both apps count each refund once.
///
/// - A refund's tender is the one it names, else its payment's own.
/// - A cash refund is the COURIER's (they handed it back) when it says
///   `cash_handler = 'driver_shift'`, or names no handler (a refund recorded
///   before the field existed: on a courier's order, which every caller here
///   reads, the drawer never counts it, `refunds::refund_paid_by_drawer_sql`;
///   Android reads the same through its `driver_earnings` test). Every other
///   cash refund is a drawer's.
/// - A cash row is lowered by the courier's cash refunds of it. A refund the
///   drawer paid leaves the courier holding (and handing over) the cash, and
///   so does a card refund of a cash row (no cash left anyone's hands).
/// - A card row is lowered by its non-cash refunds (card or other: the sale
///   reversed off the cash).
/// - Cash the courier handed back for a card (or other) payment comes out of
///   the courier's cash for the order, never below zero.
///
/// Symptom before (round 3 review, 01/10/2026): a cash refund of a CARD
/// payment on a courier order whose earning was unsettled was booked
/// `driver_shift` and lowered the earning's cash at once, but every recount
/// (reassignment, a payment-method edit, the summary backfill) put it back,
/// because only refunds of CASH rows lowered the courier's cash; the drawer
/// skips a `driver_shift` refund. So the money the courier handed back was
/// counted nowhere and the courier looked short by it (7.00 cash + 6.00 card,
/// 5.00 handed back for the card: 2.00 expected after the write, 7.00 again
/// after a recount).
///
/// Rows: completed, or refunded on this till (a local refund adjustment
/// exists). A row the server voided or refunded with no local refund is gone
/// (`release_driver_earning_money_for_payment` already took it out), and a
/// set-aside, voided or 1.4.119 placeholder row is no money. Each row nets at
/// zero at least.
pub(crate) fn courier_order_tender_cents(
    conn: &Connection,
    order_id: &str,
) -> Result<CourierTender, String> {
    let refund_tender = "LOWER(TRIM(COALESCE(NULLIF(TRIM(pa.refund_method), ''), op.method, '')))";
    // A handler-less refund counts as the courier's whether or not the
    // earning row exists yet: assignment reads this BEFORE it writes the
    // earning, and the drawer stops counting such a refund once it does.
    let courier_cash_refund = "LOWER(TRIM(COALESCE(pa.cash_handler, ''))) IN ('driver_shift', '')";
    let sum_refunds = |filter: &str| {
        format!(
            "COALESCE((
                SELECT SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER), 0))
                FROM payment_adjustments pa
                WHERE pa.payment_id = op.id
                  AND pa.adjustment_type = 'refund'
                  AND {filter}
            ), 0)"
        )
    };
    let sql = format!(
        "SELECT LOWER(TRIM(COALESCE(op.method, ''))),
                COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0),
                {courier_cash},
                {non_cash}, op.staff_id, op.staff_shift_id, o.branch_id, op.metadata
         FROM order_payments op JOIN orders o ON o.id=op.order_id
         WHERE op.order_id = ?1
           AND NOT {placeholder}
           AND (
                op.status = 'completed'
                OR (op.status = 'refunded'
                    AND EXISTS (
                        SELECT 1 FROM payment_adjustments local_refund
                         WHERE local_refund.payment_id = op.id
                           AND local_refund.adjustment_type = 'refund'
                    ))
           )",
        courier_cash = sum_refunds(&format!(
            "{refund_tender} = 'cash' AND {courier_cash_refund}"
        )),
        non_cash = sum_refunds(&format!("{refund_tender} <> 'cash'")),
        placeholder = crate::payments::placeholder_payment_sql("op"),
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare courier tender for {order_id}: {e}"))?;
    let rows = statement
        .query_map(params![order_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(|e| format!("query courier tender for {order_id}: {e}"))?;
    let mut tender = CourierTender::default();
    let mut cash_handed_back_for_non_cash = 0_i64;
    for row in rows {
        let (method, gross, courier_cash_refunds, non_cash_refunds, staff, shift, branch, metadata) =
            row.map_err(|e| format!("read courier tender row for {order_id}: {e}"))?;
        if method == "cash"
            && crate::staff_cash_returns::original_cash_collector(
                conn,
                staff.as_deref(),
                shift.as_deref(),
                branch.as_deref().unwrap_or_default(),
                metadata.as_deref(),
            )?
            .is_some_and(|owner| matches!(owner.role.as_str(), "cashier" | "manager"))
        {
            // This original cash never entered courier custody. A later
            // delivery assignment or zero-cash earning cannot transfer it.
            continue;
        }
        match method.as_str() {
            "cash" => tender.cash_cents += (gross - courier_cash_refunds.max(0)).max(0),
            "card" => {
                tender.card_cents += (gross - non_cash_refunds.max(0)).max(0);
                cash_handed_back_for_non_cash += courier_cash_refunds.max(0);
            }
            // Other tenders are no courier money here; cash the courier
            // handed back for one still left the courier's pocket.
            _ => cash_handed_back_for_non_cash += courier_cash_refunds.max(0),
        }
    }
    tender.cash_cents = (tender.cash_cents - cash_handed_back_for_non_cash).max(0);
    Ok(tender)
}

/// The money a courier carries for an order: its completed cash and card
/// payment rows, nothing else ([`courier_order_tender_cents`]).
///
/// Founder's rule (30/09/2026): driver cash, driver earnings and the driver's
/// settlement come only from payment rows, never from the order's own total or
/// tender when rows are missing. An order with no row used to be charged to
/// the courier as its whole total in cash; a card-paid order whose row had not
/// been mirrored yet, a charge set aside as a duplicate, or money given back
/// all became cash the courier owed. Rows set aside for review or voided are
/// money the order does not hold; only a refund the courier handed back
/// lowers the courier's cash (item D9, round 2).
///
/// Item D3 (fix review 30/09/2026): the same guard as the payment record
/// path. On an order whose money a delivery platform holds (prepaid online,
/// or cash its own rider collected; [`order_money_is_platform_held`]) the
/// till refuses a cash or card collection, so a completed cash/card row there
/// is a mistake or predates that refusal: it is never cash or card the
/// store's courier carries. Assignment used to charge it to the courier.
pub fn get_order_payment_totals(
    conn: &Connection,
    order_id: &str,
) -> Result<(String, f64, f64, f64), String> {
    let total_paid: f64 = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(CASE WHEN {counted} THEN op.amount ELSE 0 END), 0)
                 FROM order_payments op
                 WHERE op.order_id = ?1",
                counted = crate::payments::counted_completed_payment_sql("op"),
            ),
            params![order_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("load order payments: {e}"))?;
    let tender = courier_order_tender_cents(conn, order_id)?;
    let cash_collected = Cents::new(tender.cash_cents).to_f64_dp2();
    let card_amount = Cents::new(tender.card_cents).to_f64_dp2();
    let (cash_collected, card_amount, total_paid) = if order_money_is_platform_held(conn, order_id)
    {
        (0.0, 0.0, total_paid)
    } else {
        (cash_collected, card_amount, total_paid)
    };

    // The label is descriptive only: `driver_earnings.payment_method` must be
    // cash, card or mixed, and with no money collected it keeps the historic
    // `cash` default. No amount and no tip is ever derived from it.
    let payment_method = if cash_collected > 0.0 && card_amount > 0.0 {
        "mixed".to_string()
    } else if card_amount > 0.0 {
        "card".to_string()
    } else {
        "cash".to_string()
    };

    Ok((payment_method, cash_collected, card_amount, total_paid))
}

/// Whether a delivery platform holds this order's money: prepaid online, or
/// cash collected by the platform's own rider (`ghost_metadata.food_delivery`,
/// read by [`crate::payments::platform_settlement_kind`]). The platform pays
/// it to the store by bank (its `platform_settlement:*` row, method `other`),
/// and the till refuses a cash or card collection on it. A platform order the
/// store's own driver carries as cash on delivery is the store's money.
pub(crate) fn order_money_is_platform_held(conn: &Connection, order_id: &str) -> bool {
    crate::payments::platform_settlement_kind(conn, order_id).is_some()
}

/// Refresh the payment-dependent fields of an existing courier earning from
/// the complete local completed-payment snapshot for its order.
///
/// Courier checkout reads `driver_earnings`, rather than `order_payments`
/// directly. Once a courier shift has been closed, settled, or transferred,
/// that materialization is financial history and must not be rewritten.
pub fn refresh_existing_driver_earning_payment_snapshot(
    conn: &Connection,
    order_id: &str,
    now: &str,
) -> Result<Option<String>, String> {
    let earning: Option<(
        String,
        String,
        Option<String>,
        String,
        i64,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = conn
        .query_row(
            "SELECT de.id,
                    de.driver_id,
                    de.staff_shift_id,
                    de.branch_id,
                    COALESCE(de.settled, 0),
                    COALESCE(de.is_transferred, 0),
                    ss.status,
                    ss.role_type,
                    ss.staff_id,
                    ss.branch_id,
                    o.branch_id,
                    o.driver_id,
                    o.staff_shift_id
             FROM driver_earnings de
             JOIN orders o ON o.id = de.order_id
             LEFT JOIN staff_shifts ss ON ss.id = de.staff_shift_id
             WHERE de.order_id = ?1
             LIMIT 1",
            params![order_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("load courier settlement context: {e}"))?;

    let Some((
        earning_id,
        driver_id,
        staff_shift_id,
        earning_branch_id,
        settled,
        is_transferred,
        shift_status,
        shift_role_type,
        shift_staff_id,
        shift_branch_id,
        order_branch_id,
        order_driver_id,
        order_staff_shift_id,
    )) = earning
    else {
        return Ok(None);
    };

    let has_active_shift = shift_status
        .as_deref()
        .map(|status| status.trim().eq_ignore_ascii_case("active"))
        .unwrap_or(false);
    let has_valid_driver_identity = shift_role_type
        .as_deref()
        .map(|role_type| role_type.trim().eq_ignore_ascii_case("driver"))
        .unwrap_or(false)
        && shift_staff_id.as_deref() == Some(driver_id.as_str())
        && shift_branch_id.as_deref() == Some(earning_branch_id.as_str())
        && order_branch_id.as_deref() == Some(earning_branch_id.as_str())
        && order_driver_id.as_deref() == Some(driver_id.as_str())
        && order_staff_shift_id.as_deref() == staff_shift_id.as_deref();
    if staff_shift_id.is_none()
        || !has_active_shift
        || settled != 0
        || is_transferred != 0
        || !has_valid_driver_identity
    {
        return Err("DRIVER_SETTLEMENT_NOT_EDITABLE".into());
    }

    // Item D9: only a refund the courier handed back lowers the courier's
    // cash (`courier_order_tender_cents`).
    let tender = courier_order_tender_cents(conn, order_id)
        .map_err(|e| format!("load courier payment snapshot: {e}"))?;
    let (cash_cents, card_cents) = (tender.cash_cents, tender.card_cents);
    // Item D3: money a delivery platform holds is never the courier's.
    let (cash_cents, card_cents) = if order_money_is_platform_held(conn, order_id) {
        (0, 0)
    } else {
        (cash_cents, card_cents)
    };
    let payment_method = if cash_cents > 0 && card_cents > 0 {
        "mixed"
    } else if card_cents > 0 {
        "card"
    } else {
        "cash"
    };

    conn.execute(
        "UPDATE driver_earnings
         SET payment_method = ?1,
             cash_collected = ?2,
             cash_collected_cents = ?3,
             card_amount = ?4,
             card_amount_cents = ?5,
             cash_to_return = ?2,
             cash_to_return_cents = ?3,
             updated_at = ?6
         WHERE id = ?7",
        params![
            payment_method,
            Cents::new(cash_cents).to_f64_dp2(),
            cash_cents,
            Cents::new(card_cents).to_f64_dp2(),
            card_cents,
            now,
            earning_id,
        ],
    )
    .map_err(|e| format!("refresh courier payment snapshot: {e}"))?;

    Ok(Some(earning_id))
}

/// Take one payment's money back out of the courier earning that carries it,
/// when that money left the order: the payment was set aside for review (a
/// possible duplicate, `payments_need_review`) or voided.
///
/// Founder's rule (30/09/2026): the courier's cash comes only from payment
/// rows, and the courier is never charged for money that is not there. The
/// earning is a snapshot taken at assignment (and added to when the courier
/// collects), and nothing took the money back out when it left the order, so
/// a charge set aside as a duplicate, or voided, stayed cash the courier owed
/// at checkout and in the Z. A set-aside payment later given back to the
/// customer has already left at this point.
///
/// Only a payment booked to the earning's own courier shift is the courier's
/// money: assignment books the order's completed rows there, and a payment
/// mirrored from another till keeps that till's shift. The same decrement as
/// a courier-handled refund (`refunds.rs`), so money the courier refunded is
/// never counted back. An earning that is financial history (its shift not
/// active, or settled, or handed over) keeps its numbers. Returns the
/// earning's id when it changed.
pub fn release_driver_earning_money_for_payment(
    conn: &Connection,
    payment_id: &str,
    now: &str,
) -> Result<Option<String>, String> {
    let payment: Option<(String, String, i64, Option<String>)> = conn
        .query_row(
            "SELECT order_id,
                    LOWER(TRIM(COALESCE(method, ''))),
                    COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0),
                    staff_shift_id
             FROM order_payments
             WHERE id = ?1",
            params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| format!("load payment leaving a courier earning: {e}"))?;
    let Some((order_id, method, amount_cents, Some(payment_shift_id))) = payment else {
        return Ok(None);
    };
    if amount_cents <= 0 || !matches!(method.as_str(), "cash" | "card") {
        return Ok(None);
    }

    let earning: Option<(String, i64, i64, i64)> = conn
        .query_row(
            "SELECT de.id,
                    COALESCE(de.cash_collected_cents, CAST(ROUND(de.cash_collected * 100) AS INTEGER), 0),
                    COALESCE(de.card_amount_cents, CAST(ROUND(de.card_amount * 100) AS INTEGER), 0),
                    COALESCE(de.cash_to_return_cents, CAST(ROUND(de.cash_to_return * 100) AS INTEGER), 0)
             FROM driver_earnings de
             JOIN staff_shifts ss ON ss.id = de.staff_shift_id
             WHERE de.order_id = ?1
               AND de.staff_shift_id = ?2
               AND COALESCE(de.settled, 0) = 0
               AND COALESCE(de.is_transferred, 0) = 0
               AND LOWER(TRIM(COALESCE(ss.status, ''))) = 'active'
             LIMIT 1",
            params![order_id, payment_shift_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| format!("load courier earning for {order_id}: {e}"))?;
    let Some((earning_id, cash_cents, card_cents, to_return_cents)) = earning else {
        return Ok(None);
    };

    let (cash_cents_after, card_cents_after, to_return_cents_after) = if method == "cash" {
        (
            (cash_cents - amount_cents).max(0),
            card_cents,
            (to_return_cents - amount_cents).max(0),
        )
    } else {
        (
            cash_cents,
            (card_cents - amount_cents).max(0),
            to_return_cents,
        )
    };
    if (cash_cents_after, card_cents_after, to_return_cents_after)
        == (cash_cents, card_cents, to_return_cents)
    {
        return Ok(None);
    }
    let payment_method = if cash_cents_after > 0 && card_cents_after > 0 {
        "mixed"
    } else if card_cents_after > 0 {
        "card"
    } else {
        "cash"
    };
    conn.execute(
        "UPDATE driver_earnings
         SET payment_method = ?1,
             cash_collected = ?2,
             cash_collected_cents = ?3,
             card_amount = ?4,
             card_amount_cents = ?5,
             cash_to_return = ?6,
             cash_to_return_cents = ?7,
             updated_at = ?8
         WHERE id = ?9",
        params![
            payment_method,
            Cents::new(cash_cents_after).to_f64_dp2(),
            cash_cents_after,
            Cents::new(card_cents_after).to_f64_dp2(),
            card_cents_after,
            Cents::new(to_return_cents_after).to_f64_dp2(),
            to_return_cents_after,
            now,
            earning_id,
        ],
    )
    .map_err(|e| format!("release courier money for {earning_id}: {e}"))?;
    let payload = build_driver_earning_sync_payload(conn, &earning_id)?;
    enqueue_or_refresh_driver_earning_sync_row(conn, &earning_id, &payload)?;
    Ok(Some(earning_id))
}

/// Build the canonical parity payload from the persisted earning row so every
/// producer shares the exact financial representation and timestamps.
pub fn build_driver_earning_sync_payload(
    conn: &Connection,
    earning_id: &str,
) -> Result<Value, String> {
    let (
        id,
        driver_id,
        staff_shift_id,
        order_id,
        branch_id,
        delivery_fee_cents,
        tip_amount_cents,
        total_earning_cents,
        payment_method,
        cash_collected_cents,
        card_amount_cents,
        cash_to_return_cents,
        created_at,
        updated_at,
    ): (
        String,
        String,
        Option<String>,
        String,
        String,
        i64,
        i64,
        i64,
        String,
        i64,
        i64,
        i64,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT id, driver_id, staff_shift_id, order_id, branch_id,
                    COALESCE(delivery_fee_cents, CAST(ROUND(delivery_fee * 100) AS INTEGER), 0),
                    COALESCE(tip_amount_cents, CAST(ROUND(tip_amount * 100) AS INTEGER), 0),
                    COALESCE(total_earning_cents, CAST(ROUND(total_earning * 100) AS INTEGER), 0),
                    payment_method,
                    COALESCE(cash_collected_cents, CAST(ROUND(cash_collected * 100) AS INTEGER), 0),
                    COALESCE(card_amount_cents, CAST(ROUND(card_amount * 100) AS INTEGER), 0),
                    COALESCE(cash_to_return_cents, CAST(ROUND(cash_to_return * 100) AS INTEGER), 0),
                    created_at, updated_at
             FROM driver_earnings
             WHERE id = ?1",
            params![earning_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                ))
            },
        )
        .map_err(|e| format!("load courier earning sync payload: {e}"))?;

    let mut payload = serde_json::json!({
        "id": id,
        "driver_id": driver_id,
        "staff_shift_id": staff_shift_id,
        "order_id": order_id,
        "branch_id": branch_id,
        "delivery_fee": Cents::new(delivery_fee_cents).to_f64_dp2(),
        "delivery_fee_cents": delivery_fee_cents,
        "tip_amount": Cents::new(tip_amount_cents).to_f64_dp2(),
        "tip_amount_cents": tip_amount_cents,
        "total_earning": Cents::new(total_earning_cents).to_f64_dp2(),
        "total_earning_cents": total_earning_cents,
        "payment_method": payment_method,
        "cash_collected": Cents::new(cash_collected_cents).to_f64_dp2(),
        "cash_collected_cents": cash_collected_cents,
        "card_amount": Cents::new(card_amount_cents).to_f64_dp2(),
        "card_amount_cents": card_amount_cents,
        "cash_to_return": Cents::new(cash_to_return_cents).to_f64_dp2(),
        "cash_to_return_cents": cash_to_return_cents,
        "createdAt": created_at,
        "updatedAt": updated_at,
    });
    crate::shifts::append_recorded_operating_currency(
        conn,
        "driver_earnings",
        earning_id,
        &mut payload,
    )?;
    Ok(payload)
}

/// Replace the outstanding canonical financial sync row for an earning.
pub fn enqueue_or_refresh_driver_earning_sync_row(
    conn: &Connection,
    earning_id: &str,
    payload: &Value,
) -> Result<(), String> {
    crate::sync_queue::clear_unsynced_items(conn, "driver_earnings", earning_id)?;
    crate::sync_queue::enqueue_payload_item(
        conn,
        "driver_earnings",
        earning_id,
        "INSERT",
        payload,
        Some(1),
        Some("financial"),
        Some("manual"),
        Some(1),
    )
    .map_err(|e| format!("enqueue driver earning parity row: {e}"))?;

    Ok(())
}

pub fn is_final_order_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "delivered" | "completed" | "cancelled" | "canceled" | "refunded"
    )
}

#[allow(clippy::type_complexity)]
pub fn load_order_attribution_snapshot(
    conn: &Connection,
    order_id: &str,
) -> Result<OrderAttributionSnapshot, String> {
    let (
        shift_id,
        staff_id,
        driver_id,
        driver_name,
        branch_id,
        terminal_id,
        delivery_fee,
        tip_amount,
        status,
        order_type,
    ): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
        f64,
        f64,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT
                staff_shift_id,
                staff_id,
                driver_id,
                driver_name,
                COALESCE(branch_id, ''),
                COALESCE(terminal_id, ''),
                COALESCE(delivery_fee, 0),
                COALESCE(tip_amount, 0),
                COALESCE(status, 'pending'),
                COALESCE(order_type, 'pickup')
             FROM orders
             WHERE id = ?1",
            params![order_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get::<_, f64>(6).unwrap_or(0.0),
                    row.get::<_, f64>(7).unwrap_or(0.0),
                    row.get(8)?,
                    row.get(9)?,
                ))
            },
        )
        .map_err(|e| format!("load order attribution snapshot: {e}"))?;

    let (payment_method, cash_collected, card_amount, total_paid) =
        get_order_payment_totals(conn, order_id)?;
    let (recorded_cash_collected, recorded_card_amount, _) =
        get_recorded_order_payment_totals(conn, order_id)?;

    Ok(OrderAttributionSnapshot {
        shift_id,
        staff_id,
        driver_id,
        driver_name,
        branch_id,
        terminal_id,
        delivery_fee,
        tip_amount,
        status,
        order_type,
        payment_method,
        cash_collected,
        card_amount,
        total_paid,
        recorded_cash_collected,
        recorded_card_amount,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn apply_order_attribution(
    conn: &Connection,
    order_id: &str,
    target_shift_id: Option<&str>,
    target_staff_id: Option<&str>,
    target_driver_id: Option<&str>,
    target_driver_name: Option<&str>,
    target_order_type: Option<&str>,
    target_status: Option<&str>,
    reassign_financial_owner: bool,
    now: &str,
) -> Result<OrderAttributionSnapshot, String> {
    let current = load_order_attribution_snapshot(conn, order_id)?;
    let normalized_shift_id = normalize_opt_text(target_shift_id);
    let normalized_staff_id = normalize_opt_text(target_staff_id);
    let normalized_driver_id = normalize_opt_text(target_driver_id);
    let normalized_driver_name = normalize_opt_text(target_driver_name);
    let normalized_order_type = target_order_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| current.order_type.clone());
    let normalized_status = target_status
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| current.status.clone());
    let effective_shift_id = if reassign_financial_owner {
        normalized_shift_id.clone()
    } else {
        current.shift_id.clone()
    };
    let effective_staff_id = if reassign_financial_owner {
        normalized_staff_id.clone()
    } else {
        current.staff_id.clone()
    };

    if reassign_financial_owner && current.shift_id != normalized_shift_id {
        adjust_drawer_totals(
            conn,
            current.shift_id.as_deref(),
            -current.recorded_cash_collected,
            -current.recorded_card_amount,
            now,
        )?;
        adjust_drawer_totals(
            conn,
            normalized_shift_id.as_deref(),
            current.recorded_cash_collected,
            current.recorded_card_amount,
            now,
        )?;
    }

    conn.execute(
        "UPDATE orders
         SET staff_id = ?1,
             staff_shift_id = ?2,
             driver_id = ?3,
             driver_name = ?4,
             order_type = ?5,
             status = ?6,
             sync_status = 'pending',
             updated_at = ?7
         WHERE id = ?8",
        params![
            effective_staff_id,
            effective_shift_id,
            normalized_driver_id,
            normalized_driver_name,
            normalized_order_type,
            normalized_status,
            now,
            order_id
        ],
    )
    .map_err(|e| format!("apply order attribution: {e}"))?;

    if reassign_financial_owner {
        conn.execute(
            "UPDATE order_payments
             SET staff_id = ?1,
                 staff_shift_id = ?2,
                 sync_status = 'pending',
                 updated_at = ?3
             WHERE order_id = ?4
               AND status = 'completed'",
            params![normalized_staff_id, normalized_shift_id, now, order_id],
        )
        .map_err(|e| format!("reassign order payments: {e}"))?;
    }

    Ok(OrderAttributionSnapshot {
        shift_id: effective_shift_id,
        staff_id: effective_staff_id,
        driver_id: normalized_driver_id,
        driver_name: normalized_driver_name,
        branch_id: current.branch_id,
        terminal_id: current.terminal_id,
        delivery_fee: current.delivery_fee,
        tip_amount: current.tip_amount,
        status: normalized_status,
        order_type: normalized_order_type,
        payment_method: current.payment_method,
        cash_collected: current.cash_collected,
        card_amount: current.card_amount,
        total_paid: current.total_paid,
        recorded_cash_collected: current.recorded_cash_collected,
        recorded_card_amount: current.recorded_card_amount,
    })
}

pub fn reverse_order_drawer_attribution(
    conn: &Connection,
    order_id: &str,
    now: &str,
) -> Result<OrderAttributionSnapshot, String> {
    let current = load_order_attribution_snapshot(conn, order_id)?;
    adjust_drawer_totals(
        conn,
        current.shift_id.as_deref(),
        -current.recorded_cash_collected,
        -current.recorded_card_amount,
        now,
    )?;
    Ok(current)
}

pub struct RemovedDriverEarning {
    pub id: String,
    pub supabase_id: Option<String>,
}

pub fn remove_driver_earning_for_order(
    conn: &Connection,
    order_id: &str,
) -> Result<Option<RemovedDriverEarning>, String> {
    let earning: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT id, supabase_id
             FROM driver_earnings
             WHERE order_id = ?1
             LIMIT 1",
            params![order_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .ok();

    let Some((earning_id, supabase_id)) = earning else {
        return Ok(None);
    };

    conn.execute(
        "DELETE FROM driver_earnings
         WHERE id = ?1",
        params![earning_id],
    )
    .map_err(|e| format!("delete driver earning: {e}"))?;

    Ok(Some(RemovedDriverEarning {
        id: earning_id,
        supabase_id: normalize_opt_text(supabase_id.as_deref()),
    }))
}

pub fn assign_order_to_cashier_pickup(
    conn: &Connection,
    order_id: &str,
    acting_terminal_id: Option<&str>,
    now: &str,
) -> Result<OrderAttributionSnapshot, String> {
    let current = load_order_attribution_snapshot(conn, order_id)?;
    let financial_effective_at =
        business_day::resolve_order_financial_effective_at(conn, order_id)?;
    let preferred_terminal_id = normalize_opt_text(acting_terminal_id)
        .or_else(|| normalize_opt_text(Some(current.terminal_id.as_str())));
    let original_terminal_id = normalize_opt_text(Some(current.terminal_id.as_str()));

    let mut cashier_assignment = None;
    if !current.branch_id.trim().is_empty() {
        if let Some(terminal_id) = preferred_terminal_id.as_deref() {
            cashier_assignment =
                resolve_active_cashier_assignment(conn, current.branch_id.as_str(), terminal_id)?;
        }

        if cashier_assignment.is_none() {
            if let Some(terminal_id) = original_terminal_id.as_deref() {
                if preferred_terminal_id.as_deref() != Some(terminal_id) {
                    cashier_assignment = resolve_active_cashier_assignment(
                        conn,
                        current.branch_id.as_str(),
                        terminal_id,
                    )?;
                }
            }
        }

        if cashier_assignment.is_none() {
            cashier_assignment =
                resolve_active_cashier_assignment_for_branch(conn, current.branch_id.as_str())?;
        }
    }

    let (cashier_shift_id, cashier_staff_id) =
        if let Some((shift_id, staff_id)) = cashier_assignment {
            (Some(shift_id), Some(staff_id))
        } else {
            resolve_order_owner(
                conn,
                "pickup",
                current.branch_id.as_str(),
                preferred_terminal_id
                    .as_deref()
                    .or(original_terminal_id.as_deref())
                    .unwrap_or_default(),
                current.driver_id.as_deref(),
                current.shift_id.as_deref(),
                current.staff_id.as_deref(),
            )?
        };

    let target_status = if current.status.eq_ignore_ascii_case("out_for_delivery") {
        Some("ready")
    } else {
        None
    };

    let reassign_to_cashier = cashier_shift_id
        .as_deref()
        .map(|shift_id| {
            business_day::shift_contains_timestamp(conn, shift_id, &financial_effective_at)
        })
        .transpose()?
        .unwrap_or(false);

    let (target_shift_id, target_staff_id, reassign_financial_owner) = if cashier_shift_id.is_some()
    {
        if reassign_to_cashier {
            (cashier_shift_id, cashier_staff_id, true)
        } else if let Some((historical_shift_id, historical_staff_id)) =
            resolve_historical_financial_owner(conn, &current, &financial_effective_at)?
        {
            (Some(historical_shift_id), Some(historical_staff_id), true)
        } else {
            (None, None, true)
        }
    } else {
        (cashier_shift_id, cashier_staff_id, false)
    };

    apply_order_attribution(
        conn,
        order_id,
        target_shift_id.as_deref(),
        target_staff_id.as_deref(),
        None,
        None,
        Some("pickup"),
        target_status,
        reassign_financial_owner,
        now,
    )
}

pub fn repair_historical_pickup_financial_attribution(
    conn: &Connection,
    branch_id: &str,
    now: &str,
) -> Result<usize, String> {
    if branch_id.trim().is_empty() {
        return Ok(0);
    }

    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let candidate_sql = format!(
        "SELECT o.id, {financial_expr}
         FROM orders o
         JOIN staff_shifts ss ON ss.id = o.staff_shift_id
         WHERE (?1 = '' OR o.branch_id = ?1 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.order_type, 'pickup') != 'delivery'
           AND o.staff_shift_id IS NOT NULL
           AND (
                {financial_expr} < ss.check_in_time
                OR (
                    ss.check_out_time IS NOT NULL
                    AND {financial_expr} > ss.check_out_time
                )
           )"
    );

    let candidates = conn
        .prepare(&candidate_sql)
        .map_err(|e| format!("prepare historical pickup repair query: {e}"))?
        .query_map(params![branch_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query historical pickup repair candidates: {e}"))?
        .filter_map(|row| row.ok())
        .collect::<Vec<_>>();

    let mut repaired = 0usize;
    for (order_id, financial_effective_at) in candidates {
        let current = load_order_attribution_snapshot(conn, order_id.as_str())?;
        let historical_owner =
            resolve_historical_financial_owner(conn, &current, financial_effective_at.as_str())?;
        let (target_shift_id, target_staff_id) =
            if let Some((shift_id, staff_id)) = historical_owner {
                (Some(shift_id), Some(staff_id))
            } else {
                (None, None)
            };

        if current.shift_id == target_shift_id && current.staff_id == target_staff_id {
            continue;
        }

        apply_order_attribution(
            conn,
            order_id.as_str(),
            target_shift_id.as_deref(),
            target_staff_id.as_deref(),
            current.driver_id.as_deref(),
            current.driver_name.as_deref(),
            Some(current.order_type.as_str()),
            Some(current.status.as_str()),
            true,
            now,
        )?;
        repaired += 1;
    }

    Ok(repaired)
}

fn get_recorded_order_payment_totals(
    conn: &Connection,
    order_id: &str,
) -> Result<(f64, f64, f64), String> {
    conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN status = 'completed' AND method = 'cash' THEN amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'completed' AND method = 'card' THEN amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0)
         FROM order_payments
         WHERE order_id = ?1",
        params![order_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .map_err(|e| format!("load recorded order payments: {e}"))
}

fn adjust_drawer_totals(
    conn: &Connection,
    shift_id: Option<&str>,
    cash_delta: f64,
    card_delta: f64,
    now: &str,
) -> Result<(), String> {
    let Some(shift_id) = shift_id.filter(|sid| !sid.trim().is_empty()) else {
        return Ok(());
    };

    // W4c dual-write: clamped delta also applied to cents siblings.
    let cash_delta_cents = Cents::round_half_even(cash_delta).as_i64();
    let card_delta_cents = Cents::round_half_even(card_delta).as_i64();
    // A fully returned cancellation has no sale-attribution delta. In
    // particular it must not touch a previously closed drawer's snapshot.
    if cash_delta_cents == 0 && card_delta_cents == 0 {
        return Ok(());
    }
    conn.execute(
        "UPDATE cash_drawer_sessions
         SET total_cash_sales = CASE
                WHEN COALESCE(total_cash_sales, 0) + ?1 < 0 THEN 0
                ELSE COALESCE(total_cash_sales, 0) + ?1
             END,
             total_cash_sales_cents = CASE
                WHEN COALESCE(total_cash_sales_cents, 0) + ?2 < 0 THEN 0
                ELSE COALESCE(total_cash_sales_cents, 0) + ?2
             END,
             total_card_sales = CASE
                WHEN COALESCE(total_card_sales, 0) + ?3 < 0 THEN 0
                ELSE COALESCE(total_card_sales, 0) + ?3
             END,
             total_card_sales_cents = CASE
                WHEN COALESCE(total_card_sales_cents, 0) + ?4 < 0 THEN 0
                ELSE COALESCE(total_card_sales_cents, 0) + ?4
             END,
             updated_at = ?5
         WHERE staff_shift_id = ?6",
        params![
            cash_delta,
            cash_delta_cents,
            card_delta,
            card_delta_cents,
            now,
            shift_id
        ],
    )
    .map_err(|e| format!("adjust drawer totals: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        conn
    }

    #[test]
    fn assign_pickup_prefers_acting_terminal_cashier_and_reassigns_payments() {
        let conn = test_conn();
        let now = "2026-03-13T10:00:00Z";

        // W4e Step 0: dual-populate every monetary column
        // (100.0/20.0/18.0 → 10000/2000/1800).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-shift', 'cashier-1', 'Cashier', 'branch-1', 'terminal-main', 'cashier',
                ?1, 100.0, 10000, 'active', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-main', 'cash-shift', 'cashier-1', 'branch-1', 'terminal-main',
                100.0, 10000, ?1, ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'driver-shift', 'driver-1', 'Driver', 'branch-1', 'terminal-delivery', 'driver',
                ?1, 20.0, 2000, 'active', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                opened_at, created_at, updated_at
            ) VALUES (
                'drawer-driver', 'driver-shift', 'driver-1', 'branch-1', 'terminal-delivery',
                20.0, 2000, 18.0, 1800, ?1, ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, order_type, payment_status,
                sync_status, branch_id, terminal_id, staff_shift_id, staff_id, driver_id,
                driver_name, created_at, updated_at
            ) VALUES (
                'order-1', '[]', 18.0, 1800, 'out_for_delivery', 'delivery', 'paid',
                'pending', 'branch-1', 'terminal-delivery', 'driver-shift', 'driver-1',
                'driver-1', 'Driver', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, staff_shift_id, staff_id, currency, created_at, updated_at
            ) VALUES (
                'payment-1', 'order-1', 'cash', 18.0, 1800, 'completed', 'driver-shift', 'driver-1', 'EUR', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        assign_order_to_cashier_pickup(&conn, "order-1", Some("terminal-main"), now)
            .expect("convert order to pickup");

        let (shift_id, staff_id, driver_id, order_type, status): (
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT staff_shift_id, staff_id, driver_id, order_type, status
                 FROM orders
                 WHERE id = 'order-1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        let payment_shift_id: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM order_payments WHERE id = 'payment-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let cashier_cash_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let driver_cash_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-driver'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(shift_id.as_deref(), Some("cash-shift"));
        assert_eq!(staff_id.as_deref(), Some("cashier-1"));
        assert_eq!(driver_id, None);
        assert_eq!(order_type, "pickup");
        assert_eq!(status, "ready");
        assert_eq!(payment_shift_id.as_deref(), Some("cash-shift"));
        assert_eq!(cashier_cash_sales, 18.0);
        assert_eq!(driver_cash_sales, 0.0);
    }

    #[test]
    fn assign_pickup_falls_back_to_existing_owner_when_no_cashier_is_active() {
        let conn = test_conn();
        let now = "2026-03-13T11:00:00Z";

        // W4e Step 0: dual-populate (20.0/12.0 → 2000/1200).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'driver-shift', 'driver-1', 'Driver', 'branch-1', 'terminal-delivery', 'driver',
                ?1, 20.0, 2000, 'active', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, order_type, payment_status,
                sync_status, branch_id, terminal_id, staff_shift_id, staff_id, driver_id,
                driver_name, created_at, updated_at
            ) VALUES (
                'order-2', '[]', 12.0, 1200, 'out_for_delivery', 'delivery', 'paid',
                'pending', 'branch-1', 'terminal-delivery', 'driver-shift', 'driver-1',
                'driver-1', 'Driver', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        let applied = assign_order_to_cashier_pickup(&conn, "order-2", Some("terminal-main"), now)
            .expect("pickup conversion should not fail without active cashier");

        assert_eq!(applied.shift_id.as_deref(), Some("driver-shift"));
        assert_eq!(applied.staff_id.as_deref(), Some("driver-1"));
        assert_eq!(applied.driver_id, None);
        assert_eq!(applied.order_type, "pickup");
        assert_eq!(applied.status, "ready");
    }

    #[test]
    fn assign_pickup_restores_previous_day_cashier_instead_of_current_cashier() {
        let conn = test_conn();
        let payment_time = "2026-03-12T17:30:00Z";
        let old_cashier_start = "2026-03-12T09:00:00Z";
        let old_cashier_end = "2026-03-12T18:00:00Z";
        let current_cashier_start = "2026-03-13T09:00:00Z";
        let now = "2026-03-13T10:00:00Z";

        // W4e Step 0: dual-populate (100.0/0.0/20.0/18.0 → 10000/0/2000/1800).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, check_out_time, opening_cash_amount, opening_cash_amount_cents,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-old', 'cashier-old', 'Old Cashier', 'branch-1', 'terminal-main', 'cashier',
                ?1, ?2, 100.0, 10000, 'closed', 'pending', ?1, ?2
            )",
            params![old_cashier_start, old_cashier_end],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                opened_at, closed_at, created_at, updated_at
            ) VALUES (
                'drawer-old', 'cash-old', 'cashier-old', 'branch-1', 'terminal-main',
                100.0, 10000, 0.0, 0, ?1, ?2, ?1, ?2
            )",
            params![old_cashier_start, old_cashier_end],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-new', 'cashier-new', 'Current Cashier', 'branch-1', 'terminal-main', 'cashier',
                ?1, 100.0, 10000, 'active', 'pending', ?1, ?1
            )",
            params![current_cashier_start],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                opened_at, created_at, updated_at
            ) VALUES (
                'drawer-new', 'cash-new', 'cashier-new', 'branch-1', 'terminal-main',
                100.0, 10000, 0.0, 0, ?1, ?1, ?1
            )",
            params![current_cashier_start],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'driver-old', 'driver-1', 'Driver', 'branch-1', 'terminal-delivery', 'driver',
                ?1, 20.0, 2000, 'active', 'pending', ?1, ?1
            )",
            params![payment_time],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, order_type, payment_status,
                sync_status, branch_id, terminal_id, staff_shift_id, staff_id, driver_id,
                driver_name, created_at, updated_at
            ) VALUES (
                'order-historical', '[]', 18.0, 1800, 'out_for_delivery', 'delivery', 'paid',
                'pending', 'branch-1', 'terminal-delivery', 'driver-old', 'driver-1',
                'driver-1', 'Driver', ?1, ?1
            )",
            params![payment_time],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, staff_shift_id, staff_id, currency, created_at, updated_at
            ) VALUES (
                'payment-historical', 'order-historical', 'cash', 18.0, 1800, 'completed',
                'driver-old', 'driver-1', 'EUR', ?1, ?1
            )",
            params![payment_time],
        )
        .unwrap();

        assign_order_to_cashier_pickup(&conn, "order-historical", Some("terminal-main"), now)
            .expect("historical conversion should succeed");

        let (order_shift_id, order_staff_id, driver_id, order_type): (
            Option<String>,
            Option<String>,
            Option<String>,
            String,
        ) = conn
            .query_row(
                "SELECT staff_shift_id, staff_id, driver_id, order_type
                 FROM orders
                 WHERE id = 'order-historical'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let payment_shift_id: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM order_payments WHERE id = 'payment-historical'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let old_drawer_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let new_drawer_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-new'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(order_shift_id.as_deref(), Some("cash-old"));
        assert_eq!(order_staff_id.as_deref(), Some("cashier-old"));
        assert_eq!(payment_shift_id.as_deref(), Some("cash-old"));
        assert_eq!(driver_id, None);
        assert_eq!(order_type, "pickup");
        assert_eq!(old_drawer_sales, 18.0);
        assert_eq!(new_drawer_sales, 0.0);
    }

    #[test]
    fn repair_historical_pickup_financial_attribution_reverses_late_cashier_assignment() {
        let conn = test_conn();
        let old_cashier_start = "2026-03-12T09:00:00Z";
        let old_cashier_end = "2026-03-12T18:00:00Z";
        let late_cashier_start = "2026-03-13T09:00:00Z";
        let payment_time = "2026-03-12T17:45:00Z";
        let now = "2026-03-13T10:15:00Z";

        // W4e Step 0: dual-populate (100.0/0.0/18.0 → 10000/0/1800).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, check_out_time, opening_cash_amount, opening_cash_amount_cents,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-prev', 'cashier-prev', 'Previous Cashier', 'branch-1', 'terminal-main', 'cashier',
                ?1, ?2, 100.0, 10000, 'closed', 'pending', ?1, ?2
            )",
            params![old_cashier_start, old_cashier_end],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                opened_at, closed_at, created_at, updated_at
            ) VALUES (
                'drawer-prev', 'cash-prev', 'cashier-prev', 'branch-1', 'terminal-main',
                100.0, 10000, 0.0, 0, ?1, ?2, ?1, ?2
            )",
            params![old_cashier_start, old_cashier_end],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-late', 'cashier-late', 'Late Cashier', 'branch-1', 'terminal-main', 'cashier',
                ?1, 100.0, 10000, 'active', 'pending', ?1, ?1
            )",
            params![late_cashier_start],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                opened_at, created_at, updated_at
            ) VALUES (
                'drawer-late', 'cash-late', 'cashier-late', 'branch-1', 'terminal-main',
                100.0, 10000, 18.0, 1800, ?1, ?1, ?1
            )",
            params![late_cashier_start],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, order_type, payment_status,
                sync_status, branch_id, terminal_id, staff_shift_id, staff_id, created_at, updated_at
            ) VALUES (
                'order-corrupt', '[]', 18.0, 1800, 'ready', 'pickup', 'paid',
                'pending', 'branch-1', 'terminal-main', 'cash-late', 'cashier-late', ?1, ?2
            )",
            params![payment_time, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, staff_shift_id, staff_id, currency, created_at, updated_at
            ) VALUES (
                'payment-corrupt', 'order-corrupt', 'cash', 18.0, 1800, 'completed',
                'cash-late', 'cashier-late', 'EUR', ?1, ?2
            )",
            params![payment_time, now],
        )
        .unwrap();

        let repaired =
            repair_historical_pickup_financial_attribution(&conn, "branch-1", now).unwrap();
        assert_eq!(repaired, 1);

        let order_shift_id: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM orders WHERE id = 'order-corrupt'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payment_shift_id: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM order_payments WHERE id = 'payment-corrupt'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let prev_drawer_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-prev'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let late_drawer_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-late'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(order_shift_id.as_deref(), Some("cash-prev"));
        assert_eq!(payment_shift_id.as_deref(), Some("cash-prev"));
        assert_eq!(prev_drawer_sales, 18.0);
        assert_eq!(late_drawer_sales, 0.0);
    }

    #[test]
    fn remove_driver_earning_for_order_deletes_row_and_returns_remote_id() {
        let conn = test_conn();
        let now = "2026-03-13T12:00:00Z";

        // W4e Step 0: dual-populate (10.0/3.0 → 1000/300).
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, total_amount_cents, status, order_type, sync_status, created_at, updated_at
            ) VALUES (
                'order-3', '[]', 10.0, 1000, 'completed', 'delivery', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO driver_earnings (
                id, driver_id, staff_shift_id, order_id, branch_id,
                total_earning, total_earning_cents, payment_method, supabase_id, created_at, updated_at
            ) VALUES (
                'earning-1', 'driver-1', NULL, 'order-3', 'branch-1',
                3.0, 300, 'cash', 'remote-earning-1', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        let removed = remove_driver_earning_for_order(&conn, "order-3")
            .expect("remove driver earning")
            .expect("driver earning should exist");
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM driver_earnings WHERE order_id = 'order-3'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(removed.id, "earning-1");
        assert_eq!(removed.supabase_id.as_deref(), Some("remote-earning-1"));
        assert_eq!(remaining, 0);
    }

    #[test]
    fn refresh_driver_earning_outbox_replaces_pending_without_clearing_processing_history() {
        let conn = test_conn();
        crate::sync_queue::enqueue_payload_item(
            &conn,
            "driver_earnings",
            "earning-processing",
            "INSERT",
            &serde_json::json!({ "id": "earning-processing", "payment_method": "cash" }),
            Some(1),
            Some("financial"),
            Some("manual"),
            Some(1),
        )
        .expect("seed processing courier earning row");
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'processing'
             WHERE table_name = 'driver_earnings'
               AND record_id = 'earning-processing'",
            [],
        )
        .expect("mark courier earning row processing");

        enqueue_or_refresh_driver_earning_sync_row(
            &conn,
            "earning-processing",
            &serde_json::json!({ "id": "earning-processing", "payment_method": "card" }),
        )
        .expect("refresh courier earning outbox");

        let (processing, pending): (i64, i64) = conn
            .query_row(
                "SELECT
                    SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)
                 FROM parity_sync_queue
                 WHERE table_name = 'driver_earnings'
                   AND record_id = 'earning-processing'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("count preserved processing and refreshed pending rows");
        assert_eq!((processing, pending), (1, 1));
    }
}
