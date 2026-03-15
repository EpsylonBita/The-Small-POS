use chrono::DateTime;
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
        _ => {
            timestamp >= start_at
                && end_at
                    .map(|end| timestamp <= end)
                    .unwrap_or(true)
        }
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

pub(crate) fn resolve_period_start(
    conn: &Connection,
    branch_id: &str,
    cutoff_at: Option<&str>,
) -> String {
    if let Some(stored) = stored_period_start(conn).filter(|value| !is_epoch_timestamp(value)) {
        return stored;
    }

    infer_branch_period_start(conn, branch_id, cutoff_at).unwrap_or_else(|| EPOCH_RFC3339.to_string())
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
