//! Local cash custody for the cancellation notice and order details.
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::Manager;

use crate::{db::DbState, payment_review, payments, refunds, staff_cash_returns};

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DriverCashNotice {
    DriverCash {
        amount_cents: i64,
        currency: String,
        collector_name: Option<String>,
    },
    Review,
    Check,
}

/// A read for the cancellation notice. Its body runs off the runtime
/// workers, and an unreadable answer is "nothing to add", never an error the
/// notice would have to show.
#[tauri::command]
pub(crate) async fn order_driver_cash_for_notice(
    order_id: String,
    app: tauri::AppHandle,
) -> Result<Option<DriverCashNotice>, String> {
    crate::database_lock::run_blocking_command("order_driver_cash_for_notice", move || {
        let db = app.state::<DbState>();
        Ok(read_for_notice(&db, &order_id))
    })
    .await
}

pub(crate) fn read_for_notice(db: &DbState, order_id: &str) -> Option<DriverCashNotice> {
    let notice = db
        .conn
        .lock()
        .map_err(|error| error.to_string())
        .and_then(|conn| read_notice(&conn, order_id.trim()));
    notice.unwrap_or_else(|error| {
        tracing::warn!(%error, "Could not read cash custody for the cancellation notice");
        None
    })
}

fn read_notice(conn: &Connection, order_id: &str) -> Result<Option<DriverCashNotice>, String> {
    use DriverCashNotice::{Check, DriverCash, Review};

    // Resolve the same local and server ids as other till commands, preserving
    // storage errors for the log. Prefer an exact local id when both match.
    let (order, branch): (String, Option<String>) = conn
        .query_row(
            "SELECT id, branch_id FROM orders WHERE id = ?1 OR supabase_id = ?1
         ORDER BY id = ?1 DESC LIMIT 1",
            [order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    // An unresolved Review takes precedence over Check, which takes
    // precedence over any DriverCash amount from a different receipt.
    let review: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM order_payments WHERE order_id = ?1 AND status = ?2)",
            params![order, payment_review::DUPLICATE_REVIEW_PAYMENT_STATUS],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if review {
        return Ok(Some(Review));
    }

    let cash_payout = refunds::refund_counts_as_cash_sql("a", "p");
    let financial = payments::financial_payment_status_sql(conn, "p")?;
    let mut stmt = conn.prepare(&format!(
        "SELECT p.id, p.staff_id, p.staff_shift_id, p.metadata, p.currency,
                COALESCE(p.amount_cents, CAST(ROUND(p.amount * 100) AS INTEGER), 0),
                COALESCE((SELECT SUM(COALESCE(a.amount_cents, CAST(ROUND(a.amount * 100) AS INTEGER)))
                          FROM payment_adjustments a WHERE a.payment_id = p.id
                            AND a.adjustment_type = 'refund'), 0),
                COALESCE((SELECT SUM(COALESCE(a.amount_cents, CAST(ROUND(a.amount * 100) AS INTEGER)))
                          FROM payment_adjustments a WHERE a.payment_id = p.id
                            AND a.adjustment_type = 'refund' AND {cash_payout}
                            AND LOWER(TRIM(COALESCE(a.cash_handler, ''))) IN ('driver_shift', '')), 0),
                EXISTS(SELECT 1 FROM payment_adjustments a WHERE a.payment_id = p.id
                         AND a.adjustment_type = 'refund'
                         AND (COALESCE(a.amount_cents, CAST(ROUND(a.amount * 100) AS INTEGER), 0) <= 0
                              OR (COALESCE(a.imported_remote, 0) <> 0
                                  AND (TRIM(COALESCE(a.refund_method, '')) = ''
                                       OR (LOWER(TRIM(a.refund_method)) = 'cash'
                                           AND LOWER(TRIM(COALESCE(a.cash_handler, ''))) <> 'cashier_drawer')))
                              OR ({cash_payout} AND LOWER(TRIM(COALESCE(a.cash_handler, '')))
                                  NOT IN ('driver_shift', 'cashier_drawer', '')))),
                {financial} = 'refunded',
                p.voided_at IS NOT NULL OR EXISTS(SELECT 1 FROM payment_adjustments a
                    WHERE a.payment_id = p.id AND a.adjustment_type = 'void'),
                EXISTS(SELECT 1 FROM payment_adjustments a WHERE a.payment_id = p.id
                    AND a.adjustment_type = 'refund' AND {cash_payout}
                    AND LOWER(TRIM(COALESCE(a.cash_handler, ''))) = 'driver_shift')
         FROM order_payments p WHERE p.order_id = ?1 AND p.method = 'cash'
           AND p.status IN ('completed', 'refunded') AND {financial} <> 'voided'
           AND NOT {placeholder} AND NOT {settlement}",
        placeholder = payments::placeholder_payment_sql("p"),
        settlement = payments::platform_settlement_row_sql("p"),
    )).map_err(|error| error.to_string())?;
    let mut handbacks = conn
        .prepare(&format!(
            "SELECT COALESCE(SUM(r.amount_cents), 0),
                    COALESCE(MAX(r.source_staff_id <> ?3 OR r.source_staff_shift_id <> ?4
                        OR r.source_role <> ?5 OR r.currency <> ?6 OR r.branch_id <> ?7
                        OR (r.adjustment_id IS NOT NULL AND (a.id IS NULL
                            OR ({cash_payout} AND LOWER(TRIM(COALESCE(a.cash_handler, '')))
                                IN ('driver_shift', ''))))), 0)
             FROM staff_order_cash_returns r
             JOIN order_payments p ON p.id = r.payment_id
             LEFT JOIN payment_adjustments a ON a.id = r.adjustment_id
               AND a.payment_id = r.payment_id AND a.adjustment_type = 'refund'
             WHERE r.order_id = ?1 AND r.payment_id = ?2"
        ))
        .map_err(|error| error.to_string())?;
    let mut rows = stmt.query([&order]).map_err(|error| error.to_string())?;
    let mut owner: Option<(String, String, String, String)> = None;
    let mut amount_cents = 0_i64;
    let mut legacy_cash_limit = None;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let (
            payment,
            staff,
            shift,
            metadata,
            currency,
            gross,
            refunded,
            courier_payout,
            ambiguous_refund,
            marked_refunded,
            marked_voided,
            driver_funded_refund,
        ) = (|| -> rusqlite::Result<_> {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, bool>(8)?,
                row.get::<_, bool>(9)?,
                row.get::<_, bool>(10)?,
                row.get::<_, bool>(11)?,
            ))
        })()
        .map_err(|error| error.to_string())?;
        if ambiguous_refund
            || refunded < 0
            || refunded > gross
            || (marked_refunded && refunded != gross)
            || marked_voided
        {
            return Ok(Some(Check));
        }
        if gross == 0 {
            continue;
        }
        let Some(currency) = currency
            .filter(|unit| unit.len() == 3 && unit.bytes().all(|byte| byte.is_ascii_uppercase()))
        else {
            return Ok(Some(Check));
        };
        let branch = branch.as_deref().unwrap_or_default();
        let collector = match staff_cash_returns::original_cash_collector(
            conn,
            staff.as_deref(),
            shift.as_deref(),
            branch,
            metadata.as_deref(),
        ) {
            Ok(Some(collector)) => (
                collector.staff_id,
                collector.shift_id,
                collector.role,
                collector.currency,
            ),
            Ok(None) => {
                // The return planner can use a single driver earning when an
                // old receipt has no attribution. Its cash must cover all such receipts.
                let Some((staff, shift, unit, cash)) =
                    legacy_driver_collector(conn, &order, branch)?
                else {
                    return Ok(Some(Check));
                };
                legacy_cash_limit = Some(cash);
                (staff, shift, "driver".to_string(), unit)
            }
            Err(error) if error == "STAFF_CASH_CUSTODY_AMBIGUOUS" => return Ok(Some(Check)),
            Err(error) => return Err(error),
        };
        let (staff, shift, role, shift_currency) = collector;
        // Payout selection is order-wide, so even a cashier's receipt can
        // carry a refund paid out of the driver's pocket.
        if !matches!(role.as_str(), "driver" | "cashier" | "manager")
            || shift_currency.as_deref() != Some(currency.as_str())
            || (role != "driver" && driver_funded_refund)
        {
            return Ok(Some(Check));
        }
        let (handed_back, unverified) = handbacks
            .query_row(
                params![order, payment, staff, shift, role, currency, branch],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)),
            )
            .map_err(|error| error.to_string())?;
        // Customer returns through the drawer or bank leave the receipt with
        // its collector. A linked cashier return still counts its handback once.
        let payout = if role == "driver" {
            courier_payout
        } else {
            refunded
        };
        let Some(net) = gross
            .checked_sub(payout)
            .and_then(|net| net.checked_sub(handed_back))
            .filter(|net| *net >= 0 && !unverified)
        else {
            return Ok(Some(Check));
        };
        if net == 0 {
            continue;
        }
        let collector = (staff, shift, role, currency);
        if owner
            .as_ref()
            .is_some_and(|previous| previous != &collector)
        {
            return Ok(Some(Check));
        }
        owner = Some(collector);
        let Some(total) = amount_cents.checked_add(net) else {
            return Ok(Some(Check));
        };
        amount_cents = total;
    }

    if legacy_cash_limit.is_some_and(|cash| amount_cents > cash) {
        return Ok(Some(Check));
    }
    if let Some((staff, shift, role, currency)) = owner {
        if role != "driver" {
            return Ok(None);
        }
        // A driver cash payout against another tender cannot be assigned to
        // a cash receipt here. The staff cash return planner also flags it.
        let mixed_tender_payout: bool = conn
            .query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM payment_adjustments a
                     JOIN order_payments p ON p.id = a.payment_id
                     WHERE p.order_id = ?1 AND p.method <> 'cash' AND a.adjustment_type = 'refund'
                       AND {cash_payout}
                       AND LOWER(TRIM(COALESCE(a.cash_handler, ''))) IN ('driver_shift', ''))"
                ),
                [&order],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if mixed_tender_payout {
            return Ok(Some(Check));
        }
        let name: Option<String> = conn
            .query_row(
                "SELECT staff_name FROM staff_shifts WHERE id = ?1",
                [&shift],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let collector_name = name
            .as_deref()
            .map(str::trim)
            .filter(|name| {
                !name.is_empty()
                    && *name != staff
                    && *name != shift
                    && uuid::Uuid::parse_str(name).is_err()
            })
            .map(str::to_owned);
        return Ok(Some(DriverCash {
            amount_cents,
            currency,
            collector_name,
        }));
    }
    Ok(None)
}

fn legacy_driver_collector(
    conn: &Connection,
    order: &str,
    branch: &str,
) -> Result<Option<(String, String, Option<String>, i64)>, String> {
    conn.query_row(
        "SELECT s.staff_id, s.id, s.currency,
                COALESCE(de.cash_collected_cents, CAST(ROUND(de.cash_collected * 100) AS INTEGER), 0)
         FROM driver_earnings de JOIN staff_shifts s ON s.id = de.staff_shift_id
         WHERE de.order_id = ?1 AND s.branch_id = ?2 AND s.role_type = 'driver'
           AND de.driver_id = s.staff_id
           AND (SELECT COUNT(*) FROM driver_earnings WHERE order_id = ?1) = 1",
        [order, branch], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(|error| error.to_string())
}
