use chrono::{DateTime, Local};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension};

use crate::db;

pub(crate) const EPOCH_RFC3339: &str = "1970-01-01T00:00:00Z";

pub(crate) fn is_epoch_timestamp(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty()
        || trimmed == EPOCH_RFC3339
        || trimmed.starts_with("1970-01-01T00:00:00")
        || trimmed.starts_with("1970-01-01 00:00:00")
}

pub(crate) fn order_financial_timestamp_expr(order_alias: &str) -> String {
    format!(
        "COALESCE(
            (
                SELECT MIN(op_fin.created_at)
                FROM order_payments op_fin
                WHERE op_fin.order_id = {order_alias}.id
                  AND op_fin.status = 'completed'
            ),
            CASE
                WHEN LOWER(COALESCE({order_alias}.status, '')) IN ('completed', 'delivered', 'refunded')
                    THEN COALESCE({order_alias}.updated_at, {order_alias}.created_at)
                ELSE {order_alias}.created_at
            END,
            {order_alias}.created_at
        )"
    )
}

/// SQL predicate matching the closeout gate's "open table tab" exemption
/// shape: a dine-in/table order with payment_status 'pending' and a table
/// link. This is the shipped gate semantics (payment_integrity) — the day may
/// close while such a tab is running. Do not tighten this shape: the gate's
/// own outer filters already exclude cancelled/refunded orders.
///
/// For revenue exclusion and deletion protection use
/// [`open_unsettled_table_tab_expr`], which additionally requires the order
/// to be genuinely unsettled.
pub(crate) fn open_table_tab_expr(order_alias: &str) -> String {
    format!(
        "(
            LOWER(TRIM(COALESCE({order_alias}.order_type, ''))) IN ('dine-in', 'dine_in', 'table')
            AND LOWER(TRIM(COALESCE({order_alias}.payment_status, ''))) = 'pending'
            AND (
                TRIM(COALESCE({order_alias}.table_number, '')) <> ''
                OR TRIM(COALESCE({order_alias}.table_id, '')) <> ''
                OR TRIM(COALESCE({order_alias}.table_session_id, '')) <> ''
            )
        )"
    )
}

/// Strict variant of [`open_table_tab_expr`]: a LIVE, genuinely-never-settled
/// table tab (gap review 2026-07-10 P0-03).
///
/// Adds two conditions the gate shape must not carry:
/// - a live order status — a cancelled/refunded tab is dead history and must
///   remain deletable at rollover, or it accumulates forever;
/// - no settled payment activity — a fully-refunded order can recompute back
///   to payment_status 'pending', but its money WAS collected and returned,
///   so Z gross must still include it (the refund line subtracts it) and the
///   rollover must still clear it.
///
/// Used by the Z-report revenue aggregates (exclude uncollected tab money),
/// the end-of-day rollover selector, and the clear-old-orders maintenance
/// path (never delete a live tab). The tab is reported and cleared on the
/// business day it is eventually settled, where its payment timestamp
/// places it.
pub(crate) fn open_unsettled_table_tab_expr(order_alias: &str) -> String {
    let gate_shape = open_table_tab_expr(order_alias);
    format!(
        "(
            {gate_shape}
            AND LOWER(TRIM(COALESCE({order_alias}.status, ''))) NOT IN ('cancelled', 'canceled', 'refunded')
            AND NOT EXISTS (
                SELECT 1 FROM order_payments op_tab
                WHERE op_tab.order_id = {order_alias}.id
                  AND op_tab.status IN ('completed', 'refunded')
            )
        )"
    )
}

pub(crate) fn resolve_order_financial_effective_at(
    conn: &Connection,
    order_id: &str,
) -> Result<String, String> {
    let expression = order_financial_timestamp_expr("o");
    let sql = format!(
        "SELECT {expression}
         FROM orders o
         WHERE o.id = ?1
         LIMIT 1"
    );

    conn.query_row(&sql, params![order_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("resolve order financial timestamp: {e}"))
}

pub(crate) fn load_shift_time_bounds(
    conn: &Connection,
    shift_id: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    conn.query_row(
        "SELECT check_in_time, check_out_time
         FROM staff_shifts
         WHERE id = ?1
         LIMIT 1",
        params![shift_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
    )
    .optional()
    .map_err(|e| format!("load shift time bounds: {e}"))
}

fn parse_rfc3339(value: &str) -> Option<DateTime<chrono::FixedOffset>> {
    DateTime::parse_from_rfc3339(value).ok()
}

// Founder rule R1 (13/10/2026): the business day is the POS lifecycle — it
// starts with the first check-in after the last Z and ends with the Z — and
// never a clock hour. The 07:00 `DEFAULT_BUSINESS_DAY_START_HOUR` and the
// synced `business_day_start_hour` / `business_day_start` settings used to
// decide when a pending Z appeared and which date it carried: at Tomikro
// (13/10/2026) the Z only became available after 07:00, so the Z button at
// 06:40 opened the check-in instead and a fresh shift survived the Z. Those
// settings may still arrive through the terminal-settings sync whitelist
// (`terminal_helpers::is_syncable_system_setting`); nothing reads them for
// the day any more. The clock helper below only remains, test-only, to pin
// the `+00:00` suffix trap.
#[cfg(test)]
fn business_day_report_date_at_minutes<Z: chrono::TimeZone>(
    now: DateTime<Z>,
    business_day_start_minutes: u32,
) -> String {
    use chrono::{Days, Timelike};

    let local_minutes = now.hour() * 60 + now.minute();
    let report_date = if local_minutes < business_day_start_minutes {
        now.date_naive()
            .checked_sub_days(Days::new(1))
            .unwrap_or_else(|| now.date_naive())
    } else {
        now.date_naive()
    };

    report_date.format("%Y-%m-%d").to_string()
}

/// The instant the CURRENT business day began, as a UTC RFC3339 string with a
/// `+00:00` offset — directly comparable to `orders.created_at`.
///
/// This exists because comparing a LOCAL date string against a UTC timestamp
/// prefix loses orders between local midnight and UTC midnight: at 01:12 local
/// (UTC+3), `Local::now()` says 2026-08-18 while a just-created order's
/// `created_at` still reads 2026-08-17TXX:XXZ — so `substr(created_at,1,10) >=
/// '2026-08-18'` silently drops every order of the running evening. The founder
/// watched an order vanish from the till at 01:12 the night this shipped.
///
/// The boundary is the configured business-day start (default 07:00 local),
/// which also gives the correct shop semantics for free: an order at 01:00
/// belongs to the evening still in progress, not to a calendar day nobody has
/// opened yet.
///
/// The `+00:00` suffix (never `Z`) is deliberate: `created_at` rows end in
/// `+00:00`, and lexicographic comparison of an exactly-equal second against a
/// `Z`-suffixed cutoff would order `'+' < 'Z'` and wrongly exclude the row.
// Test-only since the Z-anchored day shipped: production retention/view runs
// through `retention_cutoff_utc` (last Z report, floored to the oldest open
// shift), never a clock boundary — "τίποτα δεν διαγράφεται αν δεν γίνει
// αναφορά Ζ". The cfg(test) gate makes the old clock cutoff uncallable from
// release code while the tests below keep pinning the `+00:00` suffix trap.
//
// The zone is `now`'s own: `Local` for the device, a `chrono_tz::Tz` for the
// store (POS audit Π8).
#[cfg(test)]
fn business_day_start_utc_at_minutes<Z: chrono::TimeZone>(
    now: DateTime<Z>,
    start_minutes: u32,
) -> String {
    use chrono::{NaiveDate, Utc};

    let report_date = business_day_report_date_at_minutes(now.clone(), start_minutes);
    let date =
        NaiveDate::parse_from_str(&report_date, "%Y-%m-%d").unwrap_or_else(|_| now.date_naive());
    let naive_start = date
        .and_hms_opt(start_minutes / 60, start_minutes % 60, 0)
        .unwrap_or_else(|| date.and_hms_opt(0, 0, 0).expect("midnight exists"));
    // `earliest()` resolves the one ambiguous local hour a DST fall-back
    // creates; a boundary inside a spring-forward gap falls back to `now`,
    // which can only widen the window, never lose a fresh order.
    let local_start = now
        .timezone()
        .from_local_datetime(&naive_start)
        .earliest()
        .unwrap_or(now);
    local_start
        .with_timezone(&Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

/// The calendar date of an instant on the store's clock (POS audit Π8; the
/// founder's rule: every store uses its location's zone). `zone` comes from
/// `store_time::resolve_store_time_zone`; `None` keeps the device's zone.
/// Only the label moves: which instants a window holds never depends on it.
pub(crate) fn local_report_date_from_timestamp(value: &str, zone: Option<Tz>) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| match zone {
            Some(zone) => dt.with_timezone(&zone).format("%Y-%m-%d").to_string(),
            None => dt.with_timezone(&Local).format("%Y-%m-%d").to_string(),
        })
        .unwrap_or_else(|_| value.get(..10).unwrap_or("").to_string())
}

pub(crate) fn report_date_for_business_window(
    period_start_at: &str,
    fallback_at: &str,
    zone: Option<Tz>,
) -> String {
    if !period_start_at.trim().is_empty() && !is_epoch_timestamp(period_start_at) {
        return local_report_date_from_timestamp(period_start_at, zone);
    }

    local_report_date_from_timestamp(fallback_at, zone)
}

/// The first shift check-in after `period_start_at` (inclusive when the period
/// start is inferred), bounded by `cutoff_at`. A shift is dated by this alone:
/// an order synced in after the last Z does not open the day for the staff
/// (Android parity; a 23:45 order after a 23:30 Z must not date the 09:00
/// opening by the previous evening).
pub(crate) fn first_check_in_after(
    conn: &Connection,
    branch_id: &str,
    period_start_at: &str,
    inclusive: bool,
    cutoff_at: Option<&str>,
) -> Option<String> {
    let lower = (!is_epoch_timestamp(period_start_at)).then_some(period_start_at);
    conn.query_row(
        "SELECT check_in_time
         FROM staff_shifts
         WHERE (?1 = '' OR branch_id = ?1 OR branch_id IS NULL)
           AND julianday(check_in_time) IS NOT NULL
           AND (?2 IS NULL
                OR julianday(check_in_time) > julianday(?2)
                OR (?3 AND julianday(check_in_time) = julianday(?2)))
           AND (?4 IS NULL OR julianday(check_in_time) <= julianday(?4))
         ORDER BY julianday(check_in_time) ASC
         LIMIT 1",
        params![branch_id, lower, inclusive, cutoff_at],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// The instant the open POS day started on this terminal (founder rule R5,
/// 13/10/2026): the first shift check-in after the last Z; without one, the
/// earliest financial activity (an order or a completed payment) after it;
/// `None` while nothing has happened since the last Z.
///
/// `period_start_at` is the last Z (or, before any Z, the inferred earliest
/// activity, with `inclusive` set); `cutoff_at` bounds the search to a frozen
/// window. Timestamps are compared as instants (`julianday`), so `Z`,
/// `+00:00` and fractional-second spellings of one moment agree.
pub(crate) fn resolve_day_start_at(
    conn: &Connection,
    branch_id: &str,
    period_start_at: &str,
    inclusive: bool,
    cutoff_at: Option<&str>,
) -> Option<String> {
    let first_check_in =
        first_check_in_after(conn, branch_id, period_start_at, inclusive, cutoff_at);
    if first_check_in.is_some() {
        return first_check_in;
    }

    let lower = (!is_epoch_timestamp(period_start_at)).then_some(period_start_at);
    conn.query_row(
        "SELECT ts
         FROM (
            SELECT o.created_at AS ts
            FROM orders o
            WHERE (?1 = '' OR o.branch_id = ?1 OR o.branch_id IS NULL)
              AND COALESCE(o.is_ghost, 0) = 0

            UNION ALL

            SELECT op.created_at AS ts
            FROM order_payments op
            JOIN orders o ON o.id = op.order_id
            WHERE (?1 = '' OR o.branch_id = ?1 OR o.branch_id IS NULL)
              AND op.status = 'completed'
              AND COALESCE(o.is_ghost, 0) = 0
         )
         WHERE julianday(ts) IS NOT NULL
           AND (?2 IS NULL
                OR julianday(ts) > julianday(?2)
                OR (?3 AND julianday(ts) = julianday(?2)))
           AND (?4 IS NULL OR julianday(ts) <= julianday(?4))
         ORDER BY julianday(ts) ASC
         LIMIT 1",
        params![branch_id, lower, inclusive, cutoff_at],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// The report date of a POS day (founder rule R5, 13/10/2026): the store-zone
/// date of its day start ([`resolve_day_start_at`]); before anything
/// happened, the date of the period start (else of `fallback_at`). A day that
/// opens 13/10 at 17:00 and closes 14/10 at 06:30 is the 13/10 day whenever
/// its Z runs, and a clock hour never moves it. `zone`: see
/// [`local_report_date_from_timestamp`].
pub(crate) fn report_date_for_pos_day(
    day_start_at: Option<&str>,
    period_start_at: &str,
    fallback_at: &str,
    zone: Option<Tz>,
) -> String {
    match day_start_at.filter(|value| !is_epoch_timestamp(value)) {
        Some(day_start_at) => local_report_date_from_timestamp(day_start_at, zone),
        None => report_date_for_business_window(period_start_at, fallback_at, zone),
    }
}

pub(crate) fn timestamp_within_bounds(
    timestamp: &str,
    start_at: &str,
    end_at: Option<&str>,
) -> bool {
    match (
        parse_rfc3339(timestamp),
        parse_rfc3339(start_at),
        end_at.and_then(parse_rfc3339),
    ) {
        (Some(ts), Some(start), Some(end)) => ts >= start && ts <= end,
        (Some(ts), Some(start), None) => ts >= start,
        _ => timestamp >= start_at && end_at.map(|end| timestamp <= end).unwrap_or(true),
    }
}

pub(crate) fn shift_contains_timestamp(
    conn: &Connection,
    shift_id: &str,
    timestamp: &str,
) -> Result<bool, String> {
    let Some((check_in_time, check_out_time)) = load_shift_time_bounds(conn, shift_id)? else {
        return Ok(false);
    };

    Ok(timestamp_within_bounds(
        timestamp,
        &check_in_time,
        check_out_time.as_deref(),
    ))
}

pub(crate) fn stored_period_start(conn: &Connection) -> Option<String> {
    db::get_setting(conn, "system", "last_z_report_timestamp")
}

/// The moment the last Z closed a day on this terminal, or `None` when no Z
/// has ever run here (the epoch placeholder counts as "never").
pub(crate) fn last_z_anchor_utc(conn: &Connection) -> Option<String> {
    stored_period_start(conn).filter(|value| !is_epoch_timestamp(value))
}

/// SQL predicate matching the exact footprint the Z rollover leaves behind:
/// a paid order created before the last Z whose local payment rows are gone.
/// The rollover deletes the closed day's `order_payments` on purpose
/// (zreport cleanup step 2) and keeps the order rows for the retention view,
/// so after every Z the settled day reads as "paid with no local payment".
/// Such rows are history, not unsettled work: they must never block the next
/// shift's checkout nor be chased by the payment-mirror sweep, whatever
/// later touch (remote snapshot refresh, platform ack replay) bumps their
/// `updated_at` into the open window. Live 05/09/2026: 16 orders of the
/// 04/09 day, closed by the 03:36Z Z-report, blocked the evening checkout.
///
/// `anchor_param` is the bound parameter carrying [`last_z_anchor_utc`];
/// NULL (no Z yet) matches nothing.
pub(crate) fn paid_order_swept_by_last_z_expr(order_alias: &str, anchor_param: &str) -> String {
    format!(
        "({anchor_param} IS NOT NULL
          AND LOWER(TRIM(COALESCE({order_alias}.payment_status, ''))) = 'paid'
          AND julianday({order_alias}.created_at) < julianday({anchor_param})
          AND NOT EXISTS (
              SELECT 1 FROM order_payments op_swept
              WHERE op_swept.order_id = {order_alias}.id
                AND (op_swept.status = 'completed' AND NOT (COALESCE(op_swept.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op_swept.remote_payment_id, '')) = ''))
          ))"
    )
}

/// The order population a Z-report may report on, as one SQL predicate.
///
/// Two exclusions, and they MUST be the same two the closeout gate applies
/// (`payment_integrity::load_branch_window_payment_blockers`):
///
///   * an open, never-settled table tab — its money was not collected yet, so
///     it belongs to the day it is finally settled;
///   * a paid order the LAST Z already closed, whose local `order_payments`
///     rows the rollover deleted on purpose.
///
/// Before 16/09/2026 only the gate knew about the second one. The revenue
/// aggregates did not, so an order from an already-closed day whose
/// `updated_at` was bumped back into the open window (remote snapshot
/// refresh, platform ack replay — both routine) was counted as turnover a
/// second time while being exempt from the payment check that would have
/// caught it. That is how the founder's Z showed order-level turnover of
/// €1.636,16 against payment-level €1.105,73 and still closed without a
/// single warning: the €531 gap was, by construction, invisible to the gate.
///
/// Anything this predicate hides is reported as
/// `integrity.carriedOverFromClosedDays` on the Z payload — excluded from
/// the totals, never from the operator's sight.
///
/// `anchor_param` is the bound parameter carrying [`last_z_anchor_utc`].
pub(crate) fn z_report_reportable_order_expr(order_alias: &str, anchor_param: &str) -> String {
    let open_tab = open_unsettled_table_tab_expr(order_alias);
    let swept = paid_order_swept_by_last_z_expr(order_alias, anchor_param);
    format!("(NOT {open_tab} AND NOT {swept})")
}

/// The local ledger's retention cutoff under the founder's day model
/// (stated 2026-08-18, verbatim): «όλα πρέπει να είναι άνοιγμα ημέρας —
/// κλείσιμο ημέρας, όχι βάση ώρας ή ημέρας· ένα τερματικό μπορεί να ανοίγει
/// σήμερα και να κλείνει μετά από 5 μέρες, ή σε 2 ώρες». A terminal's
/// working day is opened by its first activity and closed ONLY by a Z
/// report — never by a clock or a calendar.
///
/// The cutoff is therefore the moment the last Z was generated: everything
/// before it belongs to settled, reported days and may be pruned locally
/// (the server keeps it forever); everything after it is the open day and
/// must survive. One refinement: a still-active staff shift that CROSSES
/// the last Z keeps its whole story — the cutoff is floored to the oldest
/// open shift's check-in, so closing another colleague's day can never hide
/// an open one's orders.
///
/// `None` means "no Z has ever closed a day on this terminal": nothing may
/// be pruned and the ledger read stays unbounded. Deletion is EARNED by a Z,
/// never by time passing. (Observed live 2026-08-18: overnight orders made
/// during an open check-in vanished from the till at a clock boundary while
/// their shift was still active — the clock-anchored cutoff this replaces.)
///
/// Offline week (founder 21/10/2026): this is the DAY VIEW, read from the day
/// cursor, which a Z closed on this till without a connection also advances.
/// Nothing deletes by it: every delete reads
/// [`retention_deletion_cutoff_utc`], which stays below every window the
/// server has not confirmed.
pub(crate) fn retention_cutoff_utc(conn: &Connection) -> Option<String> {
    let last_z = stored_period_start(conn)
        .as_deref()
        .and_then(parse_rfc3339)?;
    Some(floored_to_open_shift(conn, last_z))
}

/// The local ledger's deletion cutoff: [`retention_cutoff_utc`] anchored on
/// the deletion floor ([`deletion_floor_utc`]) instead of the day cursor.
/// `None`: nothing may be deleted.
pub(crate) fn retention_deletion_cutoff_utc(conn: &Connection) -> Option<String> {
    let floor = deletion_floor_utc(conn)
        .as_deref()
        .and_then(parse_rfc3339)?;
    Some(floored_to_open_shift(conn, floor))
}

/// The setting holding the deletion floor (offline week, founder 21/10/2026):
/// the cutoff of the last Z the server confirmed whose window was swept here.
pub(crate) const LAST_CONFIRMED_Z_CUTOFF_KEY: &str = "last_confirmed_z_cutoff";

/// `z_reports.close_state` of a Z closed on this till without the server, its
/// window not swept yet (migration v104).
pub(crate) const Z_CLOSE_STATE_LOCAL: &str = "closed_local";

/// The instant below which local records may be deleted (offline week,
/// founder 21/10/2026). Two cursors: the day cursor
/// (`last_z_report_timestamp`) moves at every Z, a local one included; this
/// floor moves only once the server confirmed a Z and its window was swept.
///
/// - The stored floor (`system/last_confirmed_z_cutoff`). Without one (a till
///   that never closed a Z locally), the day cursor: today's behaviour.
/// - An epoch floor (the first Z of this till was closed locally): `None`.
/// - Never above the start of a window a local Z still holds
///   (`close_state = 'closed_local'`), whatever the stored value says.
/// - A read that fails, or such a window without a readable start: `None`.
pub(crate) fn deletion_floor_utc(conn: &Connection) -> Option<String> {
    let floor = match db::get_setting(conn, "system", LAST_CONFIRMED_Z_CUTOFF_KEY) {
        Some(value) if is_epoch_timestamp(&value) => return None,
        Some(value) => value,
        None => last_z_anchor_utc(conn)?,
    };
    let mut floor_at = parse_rfc3339(&floor)?;
    let mut statement = conn
        .prepare("SELECT window_period_start FROM z_reports WHERE close_state = ?1")
        .ok()?;
    let starts = statement
        .query_map(params![Z_CLOSE_STATE_LOCAL], |row| {
            row.get::<_, Option<String>>(0)
        })
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    for start in starts {
        let start_at = start
            .filter(|value| !is_epoch_timestamp(value))
            .as_deref()
            .and_then(parse_rfc3339)?;
        if start_at < floor_at {
            floor_at = start_at;
        }
    }
    Some(
        floor_at
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
    )
}

/// An order a queue row of any status still needs (offline week, invariant
/// 1): its own row, its fiscal receipt, or a payment, refund, driver earning
/// or cash return of it. `order_alias` names the `orders` row. A table the
/// schema lacks adds nothing.
pub(crate) fn order_referenced_by_sync_queue_expr(
    conn: &Connection,
    order_alias: &str,
) -> Result<String, String> {
    let table_present = |table: &str| -> Result<bool, String> {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            params![table],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|e| format!("inspect {table} for queue references: {e}"))
    };
    if !table_present("parity_sync_queue")? {
        return Ok("0".to_string());
    }
    let mut references = vec![format!(
        "EXISTS (SELECT 1 FROM parity_sync_queue q_ref
                 WHERE q_ref.table_name IN ('orders', 'fiscal_submission')
                   AND q_ref.record_id = {order_alias}.id)"
    )];
    for (table, child, link) in [
        (
            "('payments', 'order_payments')",
            "order_payments",
            "child.order_id",
        ),
        (
            "('driver_earnings', 'driver_earning')",
            "driver_earnings",
            "child.order_id",
        ),
        (
            "('staff_order_cash_returns')",
            "staff_order_cash_returns",
            "child.order_id",
        ),
    ] {
        if table_present(child)? {
            references.push(format!(
                "EXISTS (SELECT 1 FROM parity_sync_queue q_ref
                         JOIN {child} child ON child.id = q_ref.record_id
                         WHERE q_ref.table_name IN {table}
                           AND {link} = {order_alias}.id)"
            ));
        }
    }
    if table_present("payment_adjustments")? {
        let via_payment = if table_present("order_payments")? {
            format!(
                "OR adj.payment_id IN (SELECT op_ref.id FROM order_payments op_ref
                                       WHERE op_ref.order_id = {order_alias}.id)"
            )
        } else {
            String::new()
        };
        references.push(format!(
            "EXISTS (SELECT 1 FROM parity_sync_queue q_ref
                     JOIN payment_adjustments adj ON adj.id = q_ref.record_id
                     WHERE q_ref.table_name = 'payment_adjustments'
                       AND (adj.order_id = {order_alias}.id {via_payment}))"
        ));
    }
    Ok(format!("({})", references.join(" OR ")))
}

/// `last_z` floored to the oldest open shift's check-in, as a `+00:00`
/// seconds string (see [`retention_cutoff_utc`]).
fn floored_to_open_shift(conn: &Connection, last_z: DateTime<chrono::FixedOffset>) -> String {
    let open_shift_floor = conn
        .query_row(
            "SELECT MIN(check_in_time) FROM staff_shifts WHERE status = 'active'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    let open_shift_floor = open_shift_floor.as_deref().and_then(parse_rfc3339);

    let cutoff = match open_shift_floor {
        Some(floor) if floor < last_z => floor,
        _ => last_z,
    };
    // `+00:00`, never `Z`: lexicographically '+' < 'Z', so an equal-second
    // row would be wrongly excluded by a 'Z'-suffixed cutoff. Seconds
    // precision truncates the cutoff EARLIER, which errs toward keeping and
    // showing a boundary row — the safe direction on both paths.
    cutoff
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

fn infer_branch_period_start(
    conn: &Connection,
    branch_id: &str,
    cutoff_at: Option<&str>,
) -> Option<String> {
    conn.query_row(
        "SELECT MIN(ts)
         FROM (
            SELECT MIN(check_in_time) AS ts
            FROM staff_shifts
            WHERE (?1 = '' OR branch_id = ?1 OR branch_id IS NULL)
              AND (?2 IS NULL OR check_in_time <= ?2)

            UNION ALL

            SELECT MIN(created_at) AS ts
            FROM orders
            WHERE (?1 = '' OR branch_id = ?1 OR branch_id IS NULL)
              AND COALESCE(is_ghost, 0) = 0
              AND (?2 IS NULL OR created_at <= ?2)

            UNION ALL

            SELECT MIN(op.created_at) AS ts
            FROM order_payments op
            JOIN orders o ON o.id = op.order_id
            WHERE (?1 = '' OR o.branch_id = ?1 OR o.branch_id IS NULL)
              AND op.status = 'completed'
              AND COALESCE(o.is_ghost, 0) = 0
              AND (?2 IS NULL OR op.created_at <= ?2)

            UNION ALL

            SELECT MIN(opened_at) AS ts
            FROM cash_drawer_sessions
            WHERE (?1 = '' OR branch_id = ?1 OR branch_id IS NULL)
              AND (?2 IS NULL OR opened_at <= ?2)

            UNION ALL

            SELECT MIN(se.created_at) AS ts
            FROM shift_expenses se
            JOIN staff_shifts ss ON ss.id = se.staff_shift_id
            WHERE (?1 = '' OR ss.branch_id = ?1 OR ss.branch_id IS NULL)
              AND (?2 IS NULL OR se.created_at <= ?2)
         )
         WHERE ts IS NOT NULL",
        params![branch_id, cutoff_at],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
}

/// The start of the open POS day that contains `at` (now when `None`).
///
/// Normally the last Z. While a Z is issued but not yet finalized here (its
/// post-submission sync failed and staff carried on, founder decision
/// 13/10/2026), the next day already started at that Z's frozen cutoff: a
/// check-in after it is dated, made the day start (cashier first, efood day
/// start) and windowed from that cutoff, not from the closed day's start.
/// An instant at or before the issued cutoff still belongs to the closed day.
pub(crate) fn resolve_period_start(conn: &Connection, branch_id: &str, at: Option<&str>) -> String {
    if let Some(issued_cutoff) = issued_z_cutoff(conn, branch_id) {
        let in_closed_day = at
            .map(|at| instant_at_or_after(&issued_cutoff, at))
            .unwrap_or(false);
        if !in_closed_day {
            return issued_cutoff;
        }
    }
    resolve_window_period_start(conn, branch_id, at)
}

/// Whether the open period's lower bound includes its own start instant:
/// only an inferred start (no Z ever, none issued) does.
pub(crate) fn open_period_lower_bound_inclusive(conn: &Connection, branch_id: &str) -> bool {
    last_z_anchor_utc(conn).is_none() && issued_z_cutoff(conn, branch_id).is_none()
}

/// The start of the Z window that is still open locally: the last Z, or before
/// any Z the earliest activity (bounded by `cutoff_at`). Unlike
/// [`resolve_period_start`] it never moves to an issued Z's cutoff: the window
/// of that issued Z itself starts here.
pub(crate) fn resolve_window_period_start(
    conn: &Connection,
    branch_id: &str,
    cutoff_at: Option<&str>,
) -> String {
    if let Some(stored) = stored_period_start(conn).filter(|value| !is_epoch_timestamp(value)) {
        return stored;
    }

    infer_branch_period_start(conn, branch_id, cutoff_at)
        .unwrap_or_else(|| EPOCH_RFC3339.to_string())
}

/// The setting holding the pending Z context (`zreport::PendingZReportContext`).
pub(crate) const PENDING_Z_REPORT_CONTEXT_KEY: &str = "pending_z_report_context";

/// The cutoff of a Z issued on this branch whose local day rollover has not
/// run yet (`frozen` pending context newer than the last Z), else `None`.
pub(crate) fn issued_z_cutoff(conn: &Connection, branch_id: &str) -> Option<String> {
    let raw = db::get_setting(conn, "system", PENDING_Z_REPORT_CONTEXT_KEY)?;
    let context: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if context.get("frozen").and_then(serde_json::Value::as_bool) != Some(true) {
        return None;
    }
    let context_branch = context
        .get("branchId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if !branch_id.is_empty() && context_branch != branch_id {
        return None;
    }
    let cutoff = context
        .get("cutoffAt")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())?
        .to_string();
    if last_z_anchor_utc(conn)
        .map(|last_z| instant_at_or_after(&last_z, &cutoff))
        .unwrap_or(false)
    {
        return None;
    }
    Some(cutoff)
}

/// `later` is at or after `earlier` as instants (RFC 3339 spellings of one
/// moment agree); unparseable values fall back to the string order.
pub(crate) fn instant_at_or_after(later: &str, earlier: &str) -> bool {
    match (parse_rfc3339(later), parse_rfc3339(earlier)) {
        (Some(later), Some(earlier)) => later >= earlier,
        _ => later >= earlier,
    }
}

pub(crate) fn find_cashier_owner_for_timestamp(
    conn: &Connection,
    branch_id: &str,
    timestamp: &str,
) -> Result<Option<(String, String)>, String> {
    conn.query_row(
        "SELECT id, staff_id
         FROM staff_shifts
         WHERE role_type IN ('cashier', 'manager')
           AND (?1 = '' OR branch_id = ?1 OR branch_id IS NULL)
           AND check_in_time <= ?2
           AND (check_out_time IS NULL OR check_out_time >= ?2)
         ORDER BY check_in_time DESC
         LIMIT 1",
        params![branch_id, timestamp],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()
    .map_err(|e| format!("find cashier owner for timestamp: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use chrono::{TimeZone, Timelike};
    use rusqlite::Connection;

    fn local_datetime(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
    ) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(year, month, day, hour, minute, second)
            .single()
            .expect("valid local datetime")
    }

    fn day_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        db::run_migrations_for_test(&conn);
        conn
    }

    fn utc_from_local(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> String {
        local_datetime(year, month, day, hour, minute, 0)
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    fn insert_shift(conn: &Connection, id: &str, check_in: &str, check_out: Option<&str>) {
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (?1, ?1, ?1, 'branch-day', 'term-day', 'cashier', 10.0, 1000,
                       ?2, ?3, CASE WHEN ?3 IS NULL THEN 'active' ELSE 'closed' END, 2,
                       'pending', ?2, ?2)",
            params![id, check_in, check_out],
        )
        .expect("insert shift");
    }

    /// R5: the POS day is dated by its first check-in after the last Z, not
    /// by the last Z itself and not by a clock hour. A Z at 23:30 on 12/10
    /// followed by an opening at 17:00 on 13/10 and a close at 06:30 on 14/10
    /// is the 13/10 day.
    #[test]
    fn report_date_is_the_local_date_of_the_first_check_in_after_the_last_z() {
        let conn = day_conn();
        let last_z = utc_from_local(2026, 10, 12, 23, 30);
        let earlier_day = utc_from_local(2026, 10, 12, 15, 0);
        let opening = utc_from_local(2026, 10, 13, 17, 0);
        let closing = utc_from_local(2026, 10, 14, 6, 30);
        insert_shift(&conn, "closed-day", &earlier_day, Some(&last_z));
        insert_shift(&conn, "night", &opening, Some(&closing));

        let day_start = resolve_day_start_at(&conn, "branch-day", &last_z, false, None);
        assert_eq!(day_start.as_deref(), Some(opening.as_str()));
        assert_eq!(
            report_date_for_pos_day(day_start.as_deref(), &last_z, &closing, None),
            "2026-10-13"
        );
        assert_eq!(
            report_date_for_business_window(&last_z, &closing, None),
            "2026-10-12",
            "the last Z's own date is what the old rule would have used"
        );
    }

    /// R5 fallbacks: without a check-in, the earliest order or payment after
    /// the last Z dates the day; with nothing at all, the period start does.
    #[test]
    fn report_date_falls_back_to_financial_activity_then_the_period_start() {
        let conn = day_conn();
        let last_z = utc_from_local(2026, 10, 12, 23, 30);
        let now = utc_from_local(2026, 10, 14, 1, 0);

        assert_eq!(
            resolve_day_start_at(&conn, "branch-day", &last_z, false, None),
            None
        );
        assert_eq!(
            report_date_for_pos_day(None, &last_z, &now, None),
            "2026-10-12"
        );

        let order_at = utc_from_local(2026, 10, 13, 12, 5);
        conn.execute(
            "INSERT INTO orders (id, order_number, items, total_amount, status, order_type,
                                 branch_id, created_at, updated_at)
             VALUES ('ord-day', '#1', '[]', 5.0, 'completed', 'pickup', 'branch-day', ?1, ?1)",
            params![order_at],
        )
        .expect("insert order");
        let day_start = resolve_day_start_at(&conn, "branch-day", &last_z, false, None);
        assert_eq!(day_start.as_deref(), Some(order_at.as_str()));
        assert_eq!(
            report_date_for_pos_day(day_start.as_deref(), &last_z, &now, None),
            "2026-10-13"
        );
    }

    /// The comparison is between instants: a check-in spelled with `Z`
    /// after a last Z spelled with `+00:00` and fractional seconds counts,
    /// one at the exact Z moment does not (it belongs to the closed day).
    #[test]
    fn day_start_compares_instants_not_strings() {
        let conn = day_conn();
        insert_shift(
            &conn,
            "at-z",
            "2026-10-13T04:04:00Z",
            Some("2026-10-13T04:10:00Z"),
        );
        insert_shift(&conn, "after-z", "2026-10-13T04:04:01Z", None);

        assert_eq!(
            resolve_day_start_at(
                &conn,
                "branch-day",
                "2026-10-13T04:04:00.000000000+00:00",
                false,
                None
            )
            .as_deref(),
            Some("2026-10-13T04:04:01Z")
        );
        assert_eq!(
            resolve_day_start_at(&conn, "branch-day", "2026-10-13T04:04:00Z", true, None)
                .as_deref(),
            Some("2026-10-13T04:04:00Z"),
            "without a prior Z the inferred period start is inclusive"
        );
    }

    /// R1: the old synced clock settings are inert; nothing here reads them.
    #[test]
    fn synced_business_day_start_settings_never_move_the_report_date() {
        let conn = day_conn();
        let last_z = utc_from_local(2026, 10, 13, 6, 0);
        let opening = utc_from_local(2026, 10, 13, 17, 0);
        insert_shift(&conn, "evening", &opening, None);
        for (key, value) in [
            ("business_day_start_hour", "7"),
            ("business_day_start", "06:00"),
        ] {
            db::set_setting(&conn, "system", key, value).expect("store legacy clock setting");
        }

        let day_start = resolve_day_start_at(&conn, "branch-day", &last_z, false, None);
        assert_eq!(
            report_date_for_pos_day(day_start.as_deref(), &last_z, &opening, None),
            "2026-10-13"
        );
    }

    fn zone(name: &str) -> Tz {
        name.parse().expect("IANA zone")
    }

    /// POS audit Π8: the store's zone labels the POS day, whatever the
    /// device's zone; the day start instant (the window) does not move.
    #[test]
    fn report_date_follows_the_store_zone_and_the_window_does_not_move() {
        let conn = day_conn();
        let last_z = "2026-10-13T08:00:00Z";
        // Auckland (UTC+13): 14/10 01:30. Los Angeles (UTC-7): 13/10 05:30.
        let opening = "2026-10-13T12:30:00Z";
        insert_shift(&conn, "opening", opening, None);

        let day_start = resolve_day_start_at(&conn, "branch-day", last_z, false, None);
        assert_eq!(day_start.as_deref(), Some(opening));
        let auckland = Some(zone("Pacific/Auckland"));
        let los_angeles = Some(zone("America/Los_Angeles"));
        assert_eq!(
            report_date_for_pos_day(day_start.as_deref(), last_z, opening, auckland),
            "2026-10-14"
        );
        assert_eq!(
            report_date_for_pos_day(day_start.as_deref(), last_z, opening, los_angeles),
            "2026-10-13"
        );
        // None keeps the device's date, as before.
        assert_eq!(
            report_date_for_pos_day(day_start.as_deref(), last_z, opening, None),
            DateTime::parse_from_rfc3339(opening)
                .unwrap()
                .with_timezone(&Local)
                .format("%Y-%m-%d")
                .to_string()
        );
        // The fallbacks label in the same zone.
        assert_eq!(
            report_date_for_pos_day(None, last_z, opening, auckland),
            "2026-10-13"
        );
        assert_eq!(
            report_date_for_business_window(EPOCH_RFC3339, opening, auckland),
            "2026-10-14"
        );
    }

    /// Π8 across DST in the store's zone (Europe/Athens: spring forward
    /// 29/03/2026 03:00 -> 04:00, fall back 25/10/2026 04:00 -> 03:00). The
    /// boundary helper keeps its DST rules in that zone: a boundary inside the
    /// spring-forward gap falls back to `now`, the repeated fall-back hour
    /// takes its earliest instant.
    #[test]
    fn store_zone_dates_and_boundaries_hold_across_dst() {
        let athens = zone("Europe/Athens");
        for (instant, date) in [
            ("2026-03-28T21:59:59Z", "2026-03-28"),
            ("2026-03-28T22:00:00Z", "2026-03-29"),
            ("2026-10-24T20:59:59Z", "2026-10-24"),
            ("2026-10-24T21:00:00Z", "2026-10-25"),
        ] {
            assert_eq!(
                local_report_date_from_timestamp(instant, Some(athens)),
                date,
                "{instant}"
            );
        }

        let half_past_three = 3 * 60 + 30;
        let gap_now = athens
            .with_ymd_and_hms(2026, 3, 29, 5, 0, 0)
            .single()
            .unwrap();
        assert_eq!(
            business_day_start_utc_at_minutes(gap_now, half_past_three),
            "2026-03-29T02:00:00+00:00"
        );
        let after_fall_back = athens
            .with_ymd_and_hms(2026, 10, 25, 5, 0, 0)
            .single()
            .unwrap();
        assert_eq!(
            business_day_start_utc_at_minutes(after_fall_back, half_past_three),
            "2026-10-25T00:30:00+00:00"
        );
    }

    /// The cutoff instant must be the boundary hour of the report date, in
    /// UTC, with a `+00:00` suffix — asserted by parsing the string back and
    /// converting to Local, so the test holds on any machine timezone (dev is
    /// UTC+3, CI is UTC).
    #[test]
    fn business_day_start_utc_is_the_boundary_hour_as_a_utc_instant() {
        use chrono::TimeZone;

        let boundary_minutes = 7 * 60;
        for (h, m) in [(1u32, 12u32), (6, 59), (7, 0), (13, 30), (23, 59)] {
            let now = Local.with_ymd_and_hms(2026, 8, 18, h, m, 0).unwrap();
            let cutoff = business_day_start_utc_at_minutes(now, boundary_minutes);

            assert!(
                cutoff.ends_with("+00:00"),
                "cutoff must carry +00:00, never Z, to compare against created_at: {cutoff}"
            );
            let parsed = DateTime::parse_from_rfc3339(&cutoff)
                .expect("cutoff parses")
                .with_timezone(&Local);
            assert_eq!(
                (parsed.hour(), parsed.minute()),
                (7, 0),
                "start instant must sit on the boundary hour (now {h:02}:{m:02})"
            );
            let expected_date = business_day_report_date_at_minutes(now, boundary_minutes);
            assert_eq!(
                parsed.date_naive().format("%Y-%m-%d").to_string(),
                expected_date,
                "before the boundary the day is yesterday's (now {h:02}:{m:02})"
            );
        }
    }

    /// Offline week (founder 21/10/2026): two cursors. The day view reads the
    /// day cursor, which a local Z advances; every delete reads the deletion
    /// floor, which stays at the last confirmed Z and never rises above the
    /// start of a window a local Z still holds.
    #[test]
    fn the_deletion_floor_stays_below_every_window_the_server_has_not_confirmed() {
        let conn = day_conn();
        // A till that never closed a Z: nothing may be deleted.
        assert_eq!(deletion_floor_utc(&conn), None);
        assert_eq!(retention_deletion_cutoff_utc(&conn), None);

        // A Z closed online, no floor stored: the floor is the day cursor
        // (today's behaviour).
        db::set_setting(
            &conn,
            "system",
            "last_z_report_timestamp",
            "2026-10-19T03:00:00Z",
        )
        .unwrap();
        assert_eq!(
            deletion_floor_utc(&conn).as_deref(),
            Some("2026-10-19T03:00:00+00:00")
        );
        assert_eq!(
            retention_cutoff_utc(&conn),
            retention_deletion_cutoff_utc(&conn)
        );

        // Two local Zs: the day cursor moved to the second one, the floor
        // stays at the last confirmed Z.
        db::set_setting(
            &conn,
            "system",
            LAST_CONFIRMED_Z_CUTOFF_KEY,
            "2026-10-19T03:00:00Z",
        )
        .unwrap();
        db::set_setting(
            &conn,
            "system",
            "last_z_report_timestamp",
            "2026-10-21T03:00:00Z",
        )
        .unwrap();
        for (id, start, cutoff) in [
            ("z-local-1", "2026-10-19T03:00:00Z", "2026-10-20T03:00:00Z"),
            ("z-local-2", "2026-10-20T03:00:00Z", "2026-10-21T03:00:00Z"),
        ] {
            insert_shift(&conn, id, start, Some(cutoff));
            conn.execute(
                "INSERT INTO z_reports (id, shift_id, branch_id, terminal_id, report_date,
                                        generated_at, report_json, sync_state, close_state,
                                        window_period_start, window_cutoff, created_at, updated_at)
                 VALUES (?1, ?1, 'branch-day', 'term-day', substr(?2, 1, 10), ?3, '{}', 'pending',
                         'closed_local', ?2, ?3, ?3, ?3)",
                params![id, start, cutoff],
            )
            .unwrap();
        }
        assert_eq!(
            retention_cutoff_utc(&conn).as_deref(),
            Some("2026-10-21T03:00:00+00:00"),
            "the day view starts after the last local Z"
        );
        assert_eq!(
            retention_deletion_cutoff_utc(&conn).as_deref(),
            Some("2026-10-19T03:00:00+00:00"),
            "deletion stays below both local windows"
        );

        // A stored floor above an unswept local window never wins.
        db::set_setting(
            &conn,
            "system",
            LAST_CONFIRMED_Z_CUTOFF_KEY,
            "2026-10-20T12:00:00Z",
        )
        .unwrap();
        assert_eq!(
            deletion_floor_utc(&conn).as_deref(),
            Some("2026-10-19T03:00:00+00:00")
        );

        // The first Z of the till was local: an epoch floor deletes nothing.
        db::set_setting(&conn, "system", LAST_CONFIRMED_Z_CUTOFF_KEY, EPOCH_RFC3339).unwrap();
        assert_eq!(deletion_floor_utc(&conn), None);

        // A local window without a readable start fails closed.
        db::set_setting(
            &conn,
            "system",
            LAST_CONFIRMED_Z_CUTOFF_KEY,
            "2026-10-19T03:00:00Z",
        )
        .unwrap();
        conn.execute(
            "UPDATE z_reports SET window_period_start = NULL WHERE id = 'z-local-2'",
            [],
        )
        .unwrap();
        assert_eq!(deletion_floor_utc(&conn), None);
    }

    /// Invariant 1: an order a queue row of any status still needs is
    /// recognised through its own row, its fiscal receipt and its money rows.
    #[test]
    fn an_order_needed_by_a_queue_row_is_recognised_through_its_rows() {
        let conn = day_conn();
        let referenced = order_referenced_by_sync_queue_expr(&conn, "o").unwrap();
        let needs = |order_id: &str| -> bool {
            conn.query_row(
                &format!("SELECT {referenced} FROM orders o WHERE o.id = ?1"),
                params![order_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap()
        };
        for id in ["ord-free", "ord-update", "ord-payment", "ord-refund"] {
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                                     status, sync_status, created_at, updated_at)
                 VALUES (?1, ?1, '[]', 10.0, 1000, 'completed', 'synced',
                         '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z')",
                params![id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                                         created_at, updated_at)
             VALUES ('pay-1', 'ord-payment', 'cash', 10.0, 1000, 'completed',
                     '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z'),
                    ('pay-2', 'ord-refund', 'cash', 10.0, 1000, 'completed',
                     '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount,
                                              reason, created_at, updated_at)
             VALUES ('adj-1', 'pay-2', 'ord-refund', 'refund', 5.0, 'r', '2026-10-21T10:00:00Z',
                     '2026-10-21T10:00:00Z')",
            [],
        )
        .unwrap();
        for (id, table, record) in [
            ("q-update", "orders", "ord-update"),
            ("q-payment", "payments", "pay-1"),
            ("q-refund", "payment_adjustments", "adj-1"),
        ] {
            conn.execute(
                "INSERT INTO parity_sync_queue (id, table_name, record_id, operation, data,
                                                organization_id, status)
                 VALUES (?1, ?2, ?3, 'INSERT', '{}', 'org-1', 'conflict')",
                params![id, table, record],
            )
            .unwrap();
        }
        assert!(!needs("ord-free"));
        assert!(needs("ord-update"));
        assert!(needs("ord-payment"));
        assert!(
            needs("ord-refund"),
            "a refund linked through its payment only"
        );
    }
}
