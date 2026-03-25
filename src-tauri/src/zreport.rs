//! Z-Report (end-of-day) generation for The Small POS.
//!
//! Produces a financial snapshot covering all closed shifts since the last
//! committed Z-Report.  Persists the snapshot locally in the `z_reports`
//! table and enqueues it for sync to the admin dashboard via
//! `/api/pos/z-report/submit`.
//!
//! Period-based filtering: all aggregate queries use `last_z_report_timestamp`
//! from `local_settings` (category='system') so that successive Z-Reports
//! never double-count orders or payments.

use chrono::{Local, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::db::{self, DbState};
use crate::{business_day, order_ownership, storage};

// ---------------------------------------------------------------------------
// Period filtering (Gap 9)
// ---------------------------------------------------------------------------

/// Get the timestamp of the last committed Z-Report from local_settings.
/// Returns epoch "1970-01-01T00:00:00Z" if no Z-Report has ever been committed.
fn get_period_start(conn: &Connection) -> String {
    db::get_setting(conn, "system", "last_z_report_timestamp")
        .unwrap_or_else(|| business_day::EPOCH_RFC3339.to_string())
}

const PENDING_Z_REPORT_CONTEXT_KEY: &str = "pending_z_report_context";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingZReportContext {
    branch_id: String,
    report_date: String,
    cutoff_at: String,
    period_start_at: String,
}

#[derive(Clone, Debug)]
struct EffectiveZReportWindow {
    report_date: String,
    period_start_at: String,
    cutoff_at: Option<String>,
    lower_bound_mode: LowerBoundMode,
}

#[derive(Default)]
struct RolloverProtection {
    shift_ids: HashSet<String>,
    shift_expense_ids: HashSet<String>,
    staff_payment_ids: HashSet<String>,
}

fn collect_rollover_protection(conn: &Connection) -> Result<RolloverProtection, String> {
    let mut protection = RolloverProtection::default();
    let mut stmt = conn
        .prepare(
            "SELECT entity_type, entity_id, COALESCE(payload, '')
             FROM sync_queue
             WHERE status != 'synced'
               AND entity_type IN ('shift', 'shift_expense', 'staff_payment', 'driver_earning', 'driver_earnings')",
        )
        .map_err(|e| format!("prepare rollover protection selector: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("query rollover protection selector: {e}"))?;

    for row in rows {
        let (entity_type, entity_id, payload) =
            row.map_err(|e| format!("collect rollover protection selector: {e}"))?;

        match entity_type.as_str() {
            "shift" => {
                protection.shift_ids.insert(entity_id);
            }
            "shift_expense" => {
                protection.shift_expense_ids.insert(entity_id);
            }
            "staff_payment" => {
                protection.staff_payment_ids.insert(entity_id);
            }
            _ => {}
        }

        if let Some(dependency) =
            crate::sync::resolve_financial_parent_shift_dependency(conn, &entity_type, &payload)
        {
            protection.shift_ids.insert(dependency.parent_shift_id);
        }
    }

    Ok(protection)
}

fn stage_rollover_protection(
    conn: &Connection,
    protection: &RolloverProtection,
) -> Result<(), String> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS temp_rollover_protected_shift_ids;
         CREATE TEMP TABLE temp_rollover_protected_shift_ids (
             id TEXT PRIMARY KEY
         );
         DROP TABLE IF EXISTS temp_rollover_protected_shift_expense_ids;
         CREATE TEMP TABLE temp_rollover_protected_shift_expense_ids (
             id TEXT PRIMARY KEY
         );
         DROP TABLE IF EXISTS temp_rollover_protected_staff_payment_ids;
         CREATE TEMP TABLE temp_rollover_protected_staff_payment_ids (
             id TEXT PRIMARY KEY
         );",
    )
    .map_err(|e| format!("prepare rollover protection temp tables: {e}"))?;

    for shift_id in &protection.shift_ids {
        conn.execute(
            "INSERT OR IGNORE INTO temp_rollover_protected_shift_ids (id) VALUES (?1)",
            params![shift_id],
        )
        .map_err(|e| format!("stage protected shift id: {e}"))?;
    }

    for expense_id in &protection.shift_expense_ids {
        conn.execute(
            "INSERT OR IGNORE INTO temp_rollover_protected_shift_expense_ids (id) VALUES (?1)",
            params![expense_id],
        )
        .map_err(|e| format!("stage protected shift expense id: {e}"))?;
    }

    for payment_id in &protection.staff_payment_ids {
        conn.execute(
            "INSERT OR IGNORE INTO temp_rollover_protected_staff_payment_ids (id) VALUES (?1)",
            params![payment_id],
        )
        .map_err(|e| format!("stage protected staff payment id: {e}"))?;
    }

    Ok(())
}

pub(crate) struct PreparedZReportSubmission {
    pub generated: Value,
    pub z_report_id: Option<String>,
    pub created_new_z_report: bool,
    pub report_date: String,
    pub rollover_timestamp: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LowerBoundMode {
    Inclusive,
    Exclusive,
}

impl LowerBoundMode {
    fn sql_operator(self) -> &'static str {
        match self {
            Self::Inclusive => ">=",
            Self::Exclusive => ">",
        }
    }

    fn sql_predicate(self, expr: &str, parameter: &str) -> String {
        format!("{expr} {} {parameter}", self.sql_operator())
    }
}

fn resolve_lower_bound_mode(conn: &Connection) -> LowerBoundMode {
    if business_day::stored_period_start(conn)
        .as_deref()
        .filter(|value| !business_day::is_epoch_timestamp(value))
        .is_some()
    {
        LowerBoundMode::Exclusive
    } else {
        // When there is no committed prior Z-report, period_start_at is inferred
        // from the earliest branch activity and must include that boundary row.
        LowerBoundMode::Inclusive
    }
}

fn default_report_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn report_date_for_business_window(period_start_at: &str, cutoff_at: &str) -> String {
    business_day::report_date_for_business_window(period_start_at, cutoff_at)
}

fn resolve_period_start_at(conn: &Connection, branch_id: &str, cutoff_at: Option<&str>) -> String {
    business_day::resolve_period_start(conn, branch_id, cutoff_at)
}

fn sanitize_terminal_display_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("terminal-")
        || lower.starts_with("terminal_")
        || lower.starts_with("pos-terminal-")
        || lower.starts_with("pos_terminal_")
        || lower.starts_with("term-")
    {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn resolve_terminal_display_name(conn: &Connection, explicit: Option<&str>) -> Option<String> {
    explicit
        .and_then(sanitize_terminal_display_name)
        .or_else(|| {
            ["name", "display_name", "displayName"]
                .iter()
                .find_map(|key| db::get_setting(conn, "terminal", key))
                .and_then(|value| sanitize_terminal_display_name(&value))
        })
}

fn load_stored_pending_z_report_context(
    conn: &Connection,
    branch_id: &str,
) -> Option<PendingZReportContext> {
    let raw = db::get_setting(conn, "system", PENDING_Z_REPORT_CONTEXT_KEY)?;
    let parsed: PendingZReportContext = serde_json::from_str(&raw).ok()?;
    if parsed.branch_id == branch_id {
        Some(parsed)
    } else {
        None
    }
}

fn synthesize_pending_z_report_context(
    conn: &Connection,
    branch_id: &str,
) -> Option<PendingZReportContext> {
    let latest_closed_at: Option<String> = conn
        .query_row(
            "SELECT COALESCE(check_out_time, check_in_time)
             FROM staff_shifts
             WHERE status = 'closed'
               AND (branch_id = ?1 OR branch_id IS NULL)
               AND COALESCE(check_out_time, check_in_time) > ?2
             ORDER BY COALESCE(check_out_time, check_in_time) DESC
             LIMIT 1",
            params![branch_id, get_period_start(conn)],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();

    latest_closed_at.and_then(|cutoff_at| {
        let period_start_at = resolve_period_start_at(conn, branch_id, Some(cutoff_at.as_str()));
        let report_date = report_date_for_business_window(&period_start_at, &cutoff_at);
        let today = Local::now().format("%Y-%m-%d").to_string();

        // Only synthesize a pending context for shifts from a previous day.
        // Same-day shifts should not lock the business day — staff can check
        // back in at any time.
        if report_date >= today {
            return None;
        }

        Some(PendingZReportContext {
            branch_id: branch_id.to_string(),
            report_date,
            period_start_at,
            cutoff_at,
        })
    })
}

fn load_pending_z_report_context(
    conn: &Connection,
    branch_id: &str,
) -> Option<PendingZReportContext> {
    let today = Local::now().format("%Y-%m-%d").to_string();

    if let Some(mut stored) = load_stored_pending_z_report_context(conn, branch_id) {
        if business_day::stored_period_start(conn)
            .as_deref()
            .filter(|value| !business_day::is_epoch_timestamp(value))
            .map(|value| value >= stored.cutoff_at.as_str())
            .unwrap_or(false)
        {
            let _ = clear_pending_z_report_context(conn);
            return None;
        }

        // A stored context for today (or later) is not actionable yet — the
        // business day is still in progress.  Clear it so it does not block
        // staff from checking back in.
        if stored.report_date >= today {
            let _ = clear_pending_z_report_context(conn);
            return None;
        }

        let normalized_period_start =
            resolve_period_start_at(conn, branch_id, Some(stored.cutoff_at.as_str()));
        if stored.period_start_at != normalized_period_start {
            stored.period_start_at = normalized_period_start;
            let _ = persist_pending_z_report_context(conn, &stored);
        }

        return Some(stored);
    }

    synthesize_pending_z_report_context(conn, branch_id)
}

fn persist_pending_z_report_context(
    conn: &Connection,
    context: &PendingZReportContext,
) -> Result<(), String> {
    let encoded = serde_json::to_string(context)
        .map_err(|e| format!("serialize pending z-report context: {e}"))?;
    db::set_setting(conn, "system", PENDING_Z_REPORT_CONTEXT_KEY, &encoded)
}

fn clear_pending_z_report_context(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM local_settings
         WHERE setting_category = 'system'
           AND setting_key = ?1",
        params![PENDING_Z_REPORT_CONTEXT_KEY],
    )
    .map_err(|e| format!("clear pending z-report context: {e}"))?;
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn ensure_pending_z_report_context_for_branch(
    conn: &Connection,
    branch_id: &str,
    cutoff_at: &str,
) -> Result<Option<Value>, String> {
    if branch_id.trim().is_empty() {
        return Ok(None);
    }

    if let Some(existing) = load_stored_pending_z_report_context(conn, branch_id) {
        return Ok(Some(serde_json::json!(existing)));
    }

    let period_start_at = resolve_period_start_at(conn, branch_id, Some(cutoff_at));
    let context = PendingZReportContext {
        branch_id: branch_id.to_string(),
        report_date: report_date_for_business_window(&period_start_at, cutoff_at),
        cutoff_at: cutoff_at.to_string(),
        period_start_at,
    };

    persist_pending_z_report_context(conn, &context)?;
    Ok(Some(serde_json::json!(context)))
}

fn resolve_effective_z_report_window(
    conn: &Connection,
    branch_id: &str,
    payload: &Value,
) -> EffectiveZReportWindow {
    let lower_bound_mode = resolve_lower_bound_mode(conn);

    if let Some(context) = load_pending_z_report_context(conn, branch_id) {
        return EffectiveZReportWindow {
            report_date: context.report_date,
            period_start_at: context.period_start_at,
            cutoff_at: Some(context.cutoff_at),
            lower_bound_mode,
        };
    }

    EffectiveZReportWindow {
        report_date: str_field(payload, "date").unwrap_or_else(default_report_date),
        period_start_at: resolve_period_start_at(conn, branch_id, None),
        cutoff_at: None,
        lower_bound_mode,
    }
}

fn extract_z_report_id(result: &Value) -> Option<String> {
    result
        .get("zReportId")
        .and_then(Value::as_str)
        .or_else(|| {
            result
                .get("report")
                .and_then(|report| report.get("id"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

fn z_report_result_is_existing(result: &Value) -> bool {
    result
        .get("existing")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn current_z_report_sync_state(conn: &Connection, z_report_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT sync_state FROM z_reports WHERE id = ?1",
        params![z_report_id],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn discard_generated_z_report(conn: &Connection, z_report_id: &str) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin z-report discard transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        conn.execute(
            "DELETE FROM sync_queue WHERE entity_type = 'z_report' AND entity_id = ?1",
            params![z_report_id],
        )
        .map_err(|e| format!("delete z_report sync queue entry: {e}"))?;

        conn.execute("DELETE FROM z_reports WHERE id = ?1", params![z_report_id])
            .map_err(|e| format!("delete z_report row: {e}"))?;

        Ok(())
    })();

    match result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("commit z-report discard: {e}")),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub(crate) fn discard_generated_z_report_by_id(
    db: &DbState,
    z_report_id: &str,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    discard_generated_z_report(&conn, z_report_id)
}

fn normalize_report_window_timestamp(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| {
            parsed
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
}

fn report_window_timestamp_matches(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            normalize_report_window_timestamp(left) == normalize_report_window_timestamp(right)
        }
        (None, None) => true,
        _ => false,
    }
}

fn extract_period_bounds_from_report_json(report_json: &Value) -> (Option<String>, Option<String>) {
    (
        str_field(report_json, "periodStart").or_else(|| str_field(report_json, "period_start")),
        str_field(report_json, "periodEnd").or_else(|| str_field(report_json, "period_end")),
    )
}

fn load_matching_local_z_report_ids_for_window(
    conn: &Connection,
    branch_id: &str,
    report_date: &str,
    period_start: &str,
    period_end: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, report_json
             FROM z_reports
             WHERE report_date = ?1
               AND (branch_id = ?2 OR branch_id IS NULL)
             ORDER BY generated_at DESC, created_at DESC, id DESC",
        )
        .map_err(|e| format!("prepare matching local z-report selector: {e}"))?;

    let rows = stmt
        .query_map(params![report_date, branch_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query matching local z-report selector: {e}"))?;

    let expected_start = Some(period_start);
    let expected_end = Some(period_end);
    let mut matching_ids = Vec::new();

    for row in rows {
        let (id, report_json_str) =
            row.map_err(|e| format!("collect matching local z-report selector: {e}"))?;
        let parsed = serde_json::from_str::<Value>(&report_json_str).unwrap_or_default();
        let (candidate_start, candidate_end) = extract_period_bounds_from_report_json(&parsed);
        if report_window_timestamp_matches(candidate_start.as_deref(), expected_start)
            && report_window_timestamp_matches(candidate_end.as_deref(), expected_end)
        {
            matching_ids.push(id);
        }
    }

    Ok(matching_ids)
}

fn ensure_z_report_sync_queue_row(
    conn: &Connection,
    z_report_id: &str,
    sync_payload: &str,
    now: &str,
) -> Result<(), String> {
    let existing_status: Option<String> = conn
        .query_row(
            "SELECT status
             FROM sync_queue
             WHERE entity_type = 'z_report'
               AND entity_id = ?1
             ORDER BY id DESC
             LIMIT 1",
            params![z_report_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("load existing z-report sync queue row: {e}"))?;

    if matches!(existing_status.as_deref(), Some("synced")) {
        return Ok(());
    }

    let idempotency_key = format!("zreport:{z_report_id}");
    match existing_status {
        Some(_) => {
            conn.execute(
                "UPDATE sync_queue
                 SET payload = ?1,
                     idempotency_key = ?2,
                     updated_at = ?3
                 WHERE id = (
                     SELECT id
                     FROM sync_queue
                     WHERE entity_type = 'z_report'
                       AND entity_id = ?4
                     ORDER BY id DESC
                     LIMIT 1
                 )",
                params![sync_payload, idempotency_key, now, z_report_id],
            )
            .map_err(|e| format!("update existing z-report sync queue row: {e}"))?;
        }
        None => {
            conn.execute(
                "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, created_at, updated_at)
                 VALUES ('z_report', ?1, 'insert', ?2, ?3, ?4, ?4)",
                params![z_report_id, sync_payload, idempotency_key, now],
            )
            .map_err(|e| format!("insert z-report sync queue row: {e}"))?;
        }
    }

    Ok(())
}

fn prune_duplicate_local_z_reports_for_window(
    conn: &Connection,
    branch_id: &str,
    report_date: &str,
    period_start: &str,
    period_end: &str,
    keep_id: &str,
) -> Result<usize, String> {
    let duplicate_ids = load_matching_local_z_report_ids_for_window(
        conn,
        branch_id,
        report_date,
        period_start,
        period_end,
    )?
    .into_iter()
    .filter(|candidate_id| candidate_id != keep_id)
    .collect::<Vec<_>>();

    let mut removed = 0usize;
    for duplicate_id in duplicate_ids {
        conn.execute(
            "DELETE FROM sync_queue WHERE entity_type = 'z_report' AND entity_id = ?1",
            params![duplicate_id],
        )
        .map_err(|e| format!("delete duplicate z-report sync queue row: {e}"))?;
        removed += conn
            .execute("DELETE FROM z_reports WHERE id = ?1", params![duplicate_id])
            .map_err(|e| format!("delete duplicate z-report row: {e}"))?;
    }

    Ok(removed)
}

fn preview_response_from_built_date_z_report(
    report: &BuiltDateZReport,
    preview_only: bool,
) -> Value {
    serde_json::json!({
        "success": true,
        "preview": preview_only,
        "existing": false,
        "report": {
            "shiftId": report.shift_id_for_db.clone().unwrap_or_default(),
            "shiftCount": report.shift_count,
            "branchId": report.branch_id,
            "terminalId": report.terminal_id,
            "terminalName": report.terminal_name,
            "reportDate": report.report_date,
            "generatedAt": report.generated_at,
            "grossSales": report.gross_sales,
            "netSales": report.net_sales,
            "totalOrders": report.total_orders,
            "cashSales": report.cash_sales,
            "cardSales": report.card_sales,
            "refundsTotal": report.refunds_total,
            "voidsTotal": report.voids_total,
            "discountsTotal": report.discounts_total,
            "tipsTotal": report.tips_total,
            "expensesTotal": report.expenses_total,
            "cashVariance": report.total_variance,
            "openingCash": report.total_opening,
            "closingCash": report.total_closing,
            "paymentsBreakdown": report.payments_breakdown,
            "reportJson": report.report_json,
            "syncState": if preview_only { "preview" } else { "pending" },
        },
    })
}

fn role_order_type_filter_sql(role_type: &str, order_alias: &str) -> String {
    match role_type {
        "driver" => format!("AND COALESCE({order_alias}.order_type, 'dine-in') = 'delivery'"),
        "server" => format!("AND COALESCE({order_alias}.order_type, 'dine-in') != 'delivery'"),
        _ => String::new(),
    }
}

fn build_staff_cash_breakdown_row(
    conn: &Connection,
    staff_shift_id: &str,
    staff_name: Option<&str>,
    role_type: &str,
    opening_amount: f64,
) -> Result<Value, String> {
    let (cash_collected, card_amount): (f64, f64) = if role_type == "driver" {
        let driver_totals = conn
            .query_row(
                "SELECT
                COALESCE(SUM(de.cash_collected), 0),
                COALESCE(SUM(de.card_amount), 0)
             FROM driver_earnings de
             LEFT JOIN orders o ON o.id = de.order_id
             WHERE de.staff_shift_id = ?1
               AND (o.id IS NULL OR COALESCE(o.is_ghost, 0) = 0)
               AND (o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded'))",
                params![staff_shift_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("query driver cash breakdown totals: {e}"))?;

        if driver_totals.0 > 0.0 || driver_totals.1 > 0.0 {
            driver_totals
        } else {
            let sql = "SELECT
                    COALESCE(SUM(CASE WHEN op.status = 'completed' AND op.method = 'cash' THEN op.amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN op.status = 'completed' AND op.method = 'card' THEN op.amount ELSE 0 END), 0)
                 FROM orders o
                 LEFT JOIN order_payments op ON op.order_id = o.id
                 WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
                   AND COALESCE(o.is_ghost, 0) = 0
                   AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
                   AND COALESCE(o.order_type, 'dine-in') = 'delivery'";

            conn.query_row(sql, params![staff_shift_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(|e| format!("fallback driver cash breakdown totals: {e}"))?
        }
    } else {
        let sql = format!(
            "SELECT
                COALESCE(SUM(CASE WHEN op.status = 'completed' AND op.method = 'cash' THEN op.amount ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN op.status = 'completed' AND op.method = 'card' THEN op.amount ELSE 0 END), 0)
             FROM orders o
             LEFT JOIN order_payments op ON op.order_id = o.id
             WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
               AND COALESCE(o.is_ghost, 0) = 0
               AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
               {}",
            role_order_type_filter_sql(role_type, "o")
        );

        conn.query_row(&sql, params![staff_shift_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| format!("query staff cash breakdown totals: {e}"))?
    };

    let expenses: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM shift_expenses WHERE staff_shift_id = ?1",
            params![staff_shift_id],
            |row| row.get(0),
        )
        .unwrap_or(0.0);

    Ok(serde_json::json!({
        "roleType": role_type,
        "driverName": staff_name.unwrap_or_default(),
        "driverShiftId": staff_shift_id,
        "startingAmount": opening_amount,
        "cashCollected": cash_collected,
        "cardAmount": card_amount,
        "cashToReturn": opening_amount + cash_collected - expenses,
        "expenses": expenses,
    }))
}

fn shift_summary_row_to_cash_breakdown(row: &Value) -> Value {
    serde_json::json!({
        "roleType": row.get("role_type").and_then(Value::as_str).unwrap_or("driver"),
        "driverName": row.get("driver_name")
            .or_else(|| row.get("staff_name"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "driverShiftId": row.get("shift_id").and_then(Value::as_str).unwrap_or_default(),
        "startingAmount": row.get("starting_amount").and_then(Value::as_f64).unwrap_or(0.0),
        "cashCollected": row.get("cash_collected").and_then(Value::as_f64).unwrap_or(0.0),
        "cardAmount": row.get("card_amount").and_then(Value::as_f64).unwrap_or(0.0),
        "cashToReturn": row.get("amount_to_return").and_then(Value::as_f64).unwrap_or(0.0),
        "expenses": row.get("expenses").and_then(Value::as_f64).unwrap_or(0.0),
    })
}

#[derive(Clone, Debug)]
struct ReportStaffShift {
    id: String,
    staff_id: String,
    staff_name: Option<String>,
    role_type: String,
    opening_cash: f64,
    closing_cash: Option<f64>,
    expected_cash: Option<f64>,
    cash_variance: Option<f64>,
    check_in_time: Option<String>,
    check_out_time: Option<String>,
}

#[derive(Clone)]
struct BuiltDateZReport {
    shift_id_for_db: Option<String>,
    shift_count: i64,
    branch_id: String,
    terminal_id: String,
    terminal_name: Option<String>,
    report_date: String,
    generated_at: String,
    gross_sales: f64,
    net_sales: f64,
    total_orders: i64,
    cash_sales: f64,
    card_sales: f64,
    refunds_total: f64,
    voids_total: f64,
    discounts_total: f64,
    tips_total: f64,
    expenses_total: f64,
    total_variance: f64,
    total_opening: f64,
    total_closing: f64,
    total_expected: f64,
    payments_breakdown: Value,
    report_json: Value,
}

fn normalize_order_type(value: &str) -> String {
    match value {
        "dine_in" => "dine-in".to_string(),
        "takeaway" => "pickup".to_string(),
        other => other.to_string(),
    }
}

fn display_staff_name(shift: &ReportStaffShift) -> String {
    shift
        .staff_name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| shift.staff_id.clone())
}

fn ensure_staff_payments_table(conn: &Connection) {
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS staff_payments (
            id TEXT PRIMARY KEY,
            cashier_shift_id TEXT NOT NULL,
            paid_to_staff_id TEXT NOT NULL,
            amount REAL NOT NULL,
            payment_type TEXT NOT NULL DEFAULT 'wage',
            notes TEXT,
            created_at TEXT NOT NULL
        );",
    );
}

fn load_staff_expense_items(conn: &Connection, shift_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, expense_type, amount, description, created_at
             FROM shift_expenses
             WHERE staff_shift_id = ?1
               AND (expense_type IS NULL OR expense_type != 'staff_payment')
             ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare staff expense items: {e}"))?;

    let items = stmt
        .query_map(params![shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "expenseType": row.get::<_, Option<String>>(1)?,
                "amount": row.get::<_, f64>(2)?,
                "description": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "createdAt": row.get::<_, Option<String>>(4)?,
            }))
        })
        .map_err(|e| format!("query staff expense items: {e}"))?
        .filter_map(|row| row.ok())
        .collect::<Vec<_>>();

    Ok(items)
}

fn load_staff_payment_items(
    conn: &Connection,
    shift: &ReportStaffShift,
) -> Result<Vec<Value>, String> {
    ensure_staff_payments_table(conn);

    if matches!(shift.role_type.as_str(), "cashier" | "manager") {
        let mut stmt = conn
            .prepare(
                "SELECT id, amount, payment_type, notes, created_at
                 FROM staff_payments
                 WHERE cashier_shift_id = ?1
                 ORDER BY created_at ASC",
            )
            .map_err(|e| format!("prepare cashier staff payments: {e}"))?;

        let payments = stmt
            .query_map(params![shift.id.as_str()], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "amount": row.get::<_, f64>(1)?,
                    "type": row.get::<_, Option<String>>(2)?,
                    "notes": row.get::<_, Option<String>>(3)?,
                    "createdAt": row.get::<_, Option<String>>(4)?,
                }))
            })
            .map_err(|e| format!("query cashier staff payments: {e}"))?
            .filter_map(|row| row.ok())
            .collect::<Vec<_>>();

        return Ok(payments);
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, amount, payment_type, notes, created_at
             FROM staff_payments
             WHERE paid_to_staff_id = ?1
               AND (?2 IS NULL OR created_at >= ?2)
               AND (?3 IS NULL OR created_at <= ?3)
             ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare received staff payments: {e}"))?;

    let payments = stmt
        .query_map(
            params![
                shift.staff_id.as_str(),
                shift.check_in_time.as_deref(),
                shift.check_out_time.as_deref()
            ],
            |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "amount": row.get::<_, f64>(1)?,
                    "type": row.get::<_, Option<String>>(2)?,
                    "notes": row.get::<_, Option<String>>(3)?,
                    "createdAt": row.get::<_, Option<String>>(4)?,
                }))
            },
        )
        .map_err(|e| format!("query received staff payments: {e}"))?
        .filter_map(|row| row.ok())
        .collect::<Vec<_>>();

    Ok(payments)
}

fn load_staff_drawer_snapshot(conn: &Connection, shift_id: &str) -> Result<Option<Value>, String> {
    conn.query_row(
        "SELECT opening_amount, expected_amount, closing_amount, variance_amount,
                total_cash_sales, total_card_sales, cash_drops,
                driver_cash_returned, driver_cash_given, total_staff_payments
         FROM cash_drawer_sessions
         WHERE staff_shift_id = ?1",
        params![shift_id],
        |row| {
            Ok(serde_json::json!({
                "opening": row.get::<_, f64>(0).unwrap_or(0.0),
                "expected": row.get::<_, Option<f64>>(1)?,
                "closing": row.get::<_, Option<f64>>(2)?,
                "variance": row.get::<_, Option<f64>>(3)?,
                "cashSales": row.get::<_, f64>(4).unwrap_or(0.0),
                "cardSales": row.get::<_, f64>(5).unwrap_or(0.0),
                "drops": row.get::<_, f64>(6).unwrap_or(0.0),
                "driverCashReturned": row.get::<_, f64>(7).unwrap_or(0.0),
                "driverCashGiven": row.get::<_, f64>(8).unwrap_or(0.0),
                "staffPayments": row.get::<_, f64>(9).unwrap_or(0.0),
            }))
        },
    )
    .optional()
    .map_err(|e| format!("query staff drawer snapshot: {e}"))
}

fn load_drawer_rows_for_period(
    conn: &Connection,
    period_start: &str,
    cutoff_at: Option<&str>,
    lower_bound_mode: LowerBoundMode,
) -> Result<Vec<Value>, String> {
    let opened_at_predicate = lower_bound_mode.sql_predicate("cds.opened_at", "?1");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT cds.id, cds.staff_shift_id, ss.staff_name,
                    cds.opening_amount, cds.expected_amount, cds.closing_amount,
                    cds.variance_amount, cds.total_cash_sales, cds.total_card_sales,
                    cds.driver_cash_given, cds.driver_cash_returned, cds.cash_drops,
                    cds.total_staff_payments, cds.opened_at, cds.closed_at, cds.reconciled
             FROM cash_drawer_sessions cds
             LEFT JOIN staff_shifts ss ON ss.id = cds.staff_shift_id
             WHERE {opened_at_predicate}
               AND (?2 IS NULL OR cds.opened_at <= ?2)
             ORDER BY cds.opened_at ASC"
        ))
        .map_err(|e| format!("prepare drawer rows for period: {e}"))?;

    let rows = stmt
        .query_map(params![period_start, cutoff_at], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "staffShiftId": row.get::<_, String>(1)?,
                "staffName": row.get::<_, Option<String>>(2)?,
                "opening": row.get::<_, f64>(3).unwrap_or(0.0),
                "expected": row.get::<_, Option<f64>>(4)?,
                "closing": row.get::<_, Option<f64>>(5)?,
                "variance": row.get::<_, Option<f64>>(6)?,
                "cashSales": row.get::<_, f64>(7).unwrap_or(0.0),
                "cardSales": row.get::<_, f64>(8).unwrap_or(0.0),
                "driverCashGiven": row.get::<_, f64>(9).unwrap_or(0.0),
                "driverCashReturned": row.get::<_, f64>(10).unwrap_or(0.0),
                "drops": row.get::<_, f64>(11).unwrap_or(0.0),
                "staffPayments": row.get::<_, f64>(12).unwrap_or(0.0),
                "openedAt": row.get::<_, Option<String>>(13)?,
                "closedAt": row.get::<_, Option<String>>(14)?,
                "reconciled": row.get::<_, i64>(15).unwrap_or(0) != 0,
            }))
        })
        .map_err(|e| format!("query drawer rows for period: {e}"))?
        .filter_map(|row| row.ok())
        .collect::<Vec<_>>();

    Ok(rows)
}

fn load_drawer_rows_for_shift(conn: &Connection, shift_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT cds.id, cds.staff_shift_id, ss.staff_name,
                    cds.opening_amount, cds.expected_amount, cds.closing_amount,
                    cds.variance_amount, cds.total_cash_sales, cds.total_card_sales,
                    cds.driver_cash_given, cds.driver_cash_returned, cds.cash_drops,
                    cds.total_staff_payments, cds.opened_at, cds.closed_at, cds.reconciled
             FROM cash_drawer_sessions cds
             LEFT JOIN staff_shifts ss ON ss.id = cds.staff_shift_id
             WHERE cds.staff_shift_id = ?1
             ORDER BY cds.opened_at ASC",
        )
        .map_err(|e| format!("prepare drawer rows for shift: {e}"))?;

    let rows = stmt
        .query_map(params![shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "staffShiftId": row.get::<_, String>(1)?,
                "staffName": row.get::<_, Option<String>>(2)?,
                "opening": row.get::<_, f64>(3).unwrap_or(0.0),
                "expected": row.get::<_, Option<f64>>(4)?,
                "closing": row.get::<_, Option<f64>>(5)?,
                "variance": row.get::<_, Option<f64>>(6)?,
                "cashSales": row.get::<_, f64>(7).unwrap_or(0.0),
                "cardSales": row.get::<_, f64>(8).unwrap_or(0.0),
                "driverCashGiven": row.get::<_, f64>(9).unwrap_or(0.0),
                "driverCashReturned": row.get::<_, f64>(10).unwrap_or(0.0),
                "drops": row.get::<_, f64>(11).unwrap_or(0.0),
                "staffPayments": row.get::<_, f64>(12).unwrap_or(0.0),
                "openedAt": row.get::<_, Option<String>>(13)?,
                "closedAt": row.get::<_, Option<String>>(14)?,
                "reconciled": row.get::<_, i64>(15).unwrap_or(0) != 0,
            }))
        })
        .map_err(|e| format!("query drawer rows for shift: {e}"))?
        .filter_map(|row| row.ok())
        .collect::<Vec<_>>();

    Ok(rows)
}

fn load_sales_by_type_for_period(
    conn: &Connection,
    branch_id: &str,
    period_start: &str,
    cutoff_at: Option<&str>,
    lower_bound_mode: LowerBoundMode,
) -> Result<Value, String> {
    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let financial_predicate = lower_bound_mode.sql_predicate(&financial_expr, "?1");
    let sql = format!(
        "SELECT
            CASE
                WHEN COALESCE(o.order_type, 'dine-in') = 'delivery' THEN 'delivery'
                ELSE 'instore'
            END AS bucket,
            op.method,
            COUNT(DISTINCT o.id),
            COALESCE(SUM(op.amount), 0)
         FROM order_payments op
         JOIN orders o ON o.id = op.order_id
         WHERE {financial_predicate}
           AND (?2 IS NULL OR {financial_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND op.status = 'completed'
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
         GROUP BY bucket, op.method"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare sales by type for period: {e}"))?;

    let mut instore_cash = (0_i64, 0.0_f64);
    let mut instore_card = (0_i64, 0.0_f64);
    let mut delivery_cash = (0_i64, 0.0_f64);
    let mut delivery_card = (0_i64, 0.0_f64);

    let rows = stmt
        .query_map(params![period_start, cutoff_at, branch_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })
        .map_err(|e| format!("query sales by type for period: {e}"))?;

    for row in rows.flatten() {
        let (bucket, method, count, total) = row;
        match (bucket.as_str(), method.as_str()) {
            ("delivery", "cash") => delivery_cash = (count, total),
            ("delivery", "card") => delivery_card = (count, total),
            ("instore", "cash") => instore_cash = (count, total),
            ("instore", "card") => instore_card = (count, total),
            _ => {}
        }
    }

    Ok(serde_json::json!({
        "instore": {
            "cash": { "count": instore_cash.0, "total": instore_cash.1 },
            "card": { "count": instore_card.0, "total": instore_card.1 },
        },
        "delivery": {
            "cash": { "count": delivery_cash.0, "total": delivery_cash.1 },
            "card": { "count": delivery_card.0, "total": delivery_card.1 },
        },
    }))
}

fn load_sales_by_type_for_shift(conn: &Connection, shift_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "SELECT
                CASE
                    WHEN COALESCE(o.order_type, 'dine-in') = 'delivery' THEN 'delivery'
                    ELSE 'instore'
                END AS bucket,
                op.method,
                COUNT(DISTINCT o.id),
                COALESCE(SUM(op.amount), 0)
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
               AND op.status = 'completed'
               AND COALESCE(o.is_ghost, 0) = 0
               AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
             GROUP BY bucket, op.method",
        )
        .map_err(|e| format!("prepare sales by type for shift: {e}"))?;

    let mut instore_cash = (0_i64, 0.0_f64);
    let mut instore_card = (0_i64, 0.0_f64);
    let mut delivery_cash = (0_i64, 0.0_f64);
    let mut delivery_card = (0_i64, 0.0_f64);

    let rows = stmt
        .query_map(params![shift_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })
        .map_err(|e| format!("query sales by type for shift: {e}"))?;

    for row in rows.flatten() {
        let (bucket, method, count, total) = row;
        match (bucket.as_str(), method.as_str()) {
            ("delivery", "cash") => delivery_cash = (count, total),
            ("delivery", "card") => delivery_card = (count, total),
            ("instore", "cash") => instore_cash = (count, total),
            ("instore", "card") => instore_card = (count, total),
            _ => {}
        }
    }

    Ok(serde_json::json!({
        "instore": {
            "cash": { "count": instore_cash.0, "total": instore_cash.1 },
            "card": { "count": instore_card.0, "total": instore_card.1 },
        },
        "delivery": {
            "cash": { "count": delivery_cash.0, "total": delivery_cash.1 },
            "card": { "count": delivery_card.0, "total": delivery_card.1 },
        },
    }))
}

fn load_non_driver_order_totals(
    conn: &Connection,
    shift: &ReportStaffShift,
) -> Result<(i64, f64, f64, f64), String> {
    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let shift_start = shift
        .check_in_time
        .as_deref()
        .unwrap_or(business_day::EPOCH_RFC3339);
    let order_scope_sql = format!(
        "SELECT COUNT(*), COALESCE(SUM(order_total), 0)
         FROM (
            SELECT o.id, MAX(COALESCE(o.total_amount, 0)) AS order_total
            FROM orders o
            LEFT JOIN order_payments op ON op.order_id = o.id
            WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
              AND {financial_expr} >= ?2
              AND (?3 IS NULL OR {financial_expr} <= ?3)
              AND COALESCE(o.is_ghost, 0) = 0
              AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
              {}
              AND NOT EXISTS (
                    SELECT 1 FROM driver_earnings de WHERE de.order_id = o.id
              )
            GROUP BY o.id
         )",
        role_order_type_filter_sql(&shift.role_type, "o")
    );

    let (order_count, total_amount): (i64, f64) = conn
        .query_row(
            &order_scope_sql,
            params![
                shift.id.as_str(),
                shift_start,
                shift.check_out_time.as_deref()
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("query non-driver order totals: {e}"))?;

    let payment_sql = format!(
        "SELECT
            COALESCE(SUM(CASE WHEN op.status = 'completed' AND op.method = 'cash' THEN op.amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN op.status = 'completed' AND op.method = 'card' THEN op.amount ELSE 0 END), 0)
         FROM orders o
         LEFT JOIN order_payments op ON op.order_id = o.id
         WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
           AND {financial_expr} >= ?2
           AND (?3 IS NULL OR {financial_expr} <= ?3)
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
           {}
           AND NOT EXISTS (
                SELECT 1 FROM driver_earnings de WHERE de.order_id = o.id
           )",
        role_order_type_filter_sql(&shift.role_type, "o")
    );

    let (cash_amount, card_amount): (f64, f64) = conn
        .query_row(
            &payment_sql,
            params![
                shift.id.as_str(),
                shift_start,
                shift.check_out_time.as_deref()
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("query non-driver payment totals: {e}"))?;

    Ok((order_count, cash_amount, card_amount, total_amount))
}

#[allow(clippy::type_complexity)]
fn load_driver_order_totals(
    conn: &Connection,
    shift_id: &str,
) -> Result<(i64, i64, i64, f64, f64, f64, f64), String> {
    conn.query_row(
        "SELECT
            COALESCE(SUM(CASE
                WHEN o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded') THEN 1
                ELSE 0
            END), 0),
            COALESCE(SUM(CASE
                WHEN o.id IS NULL OR o.status IN ('completed', 'delivered') THEN 1
                ELSE 0
            END), 0),
            COALESCE(SUM(CASE
                WHEN o.id IS NOT NULL AND o.status IN ('cancelled', 'canceled', 'refunded') THEN 1
                ELSE 0
            END), 0),
            COALESCE(SUM(CASE
                WHEN o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded') THEN de.total_earning
                ELSE 0
            END), 0),
            COALESCE(SUM(CASE
                WHEN o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded') THEN de.cash_collected
                ELSE 0
            END), 0),
            COALESCE(SUM(CASE
                WHEN o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded') THEN de.card_amount
                ELSE 0
            END), 0),
            COALESCE(SUM(CASE
                WHEN o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded') THEN COALESCE(o.total_amount, de.cash_collected + de.card_amount)
                ELSE 0
            END), 0)
         FROM driver_earnings de
         LEFT JOIN orders o ON o.id = de.order_id
         WHERE de.staff_shift_id = ?1
           AND (o.id IS NULL OR COALESCE(o.is_ghost, 0) = 0)",
        params![shift_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        },
    )
    .map_err(|e| format!("query driver order totals: {e}"))
}

fn load_non_driver_order_details(
    conn: &Connection,
    shift: &ReportStaffShift,
) -> Result<(Vec<Value>, bool), String> {
    let financial_expr = business_day::order_financial_timestamp_expr("o2");
    let shift_start = shift
        .check_in_time
        .as_deref()
        .unwrap_or(business_day::EPOCH_RFC3339);
    let detail_sql = format!(
        "SELECT o.id,
                COALESCE(NULLIF(TRIM(o.order_number), ''), o.id),
                COALESCE(o.order_type, 'dine-in'),
                o.table_number,
                o.delivery_address,
                COALESCE(o.total_amount, 0),
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM order_payments op2
                        WHERE op2.order_id = o.id
                          AND op2.status = 'completed'
                          AND op2.method = 'cash'
                    ) AND EXISTS (
                        SELECT 1 FROM order_payments op2
                        WHERE op2.order_id = o.id
                          AND op2.status = 'completed'
                          AND op2.method = 'card'
                    ) THEN 'mixed'
                    ELSE COALESCE((
                        SELECT op2.method
                        FROM order_payments op2
                        WHERE op2.order_id = o.id
                          AND op2.status = 'completed'
                        ORDER BY CASE op2.method
                            WHEN 'cash' THEN 0
                            WHEN 'card' THEN 1
                            ELSE 2
                        END
                        LIMIT 1
                    ), o.payment_method, 'cash')
                END AS payment_method,
                o.payment_status,
                o.status,
                o.created_at
         FROM orders o
         WHERE o.id IN (
            SELECT DISTINCT o2.id
            FROM orders o2
            LEFT JOIN order_payments op ON op.order_id = o2.id
            WHERE COALESCE(op.staff_shift_id, o2.staff_shift_id) = ?1
              AND {financial_expr} >= ?2
              AND (?3 IS NULL OR {financial_expr} <= ?3)
              AND COALESCE(o2.is_ghost, 0) = 0
              {}
              AND NOT EXISTS (
                    SELECT 1 FROM driver_earnings de WHERE de.order_id = o2.id
              )
         )
         ORDER BY o.created_at ASC
         LIMIT 1001",
        role_order_type_filter_sql(&shift.role_type, "o2")
    );

    let mut rows = conn
        .prepare(&detail_sql)
        .map_err(|e| format!("prepare non-driver order details: {e}"))?
        .query_map(
            params![
                shift.id.as_str(),
                shift_start,
                shift.check_out_time.as_deref()
            ],
            |row| {
                let raw_order_type = row.get::<_, String>(2)?;
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "orderNumber": row.get::<_, String>(1)?,
                    "orderType": normalize_order_type(&raw_order_type),
                    "tableNumber": row.get::<_, Option<String>>(3)?,
                    "deliveryAddress": row.get::<_, Option<String>>(4)?,
                    "amount": row.get::<_, f64>(5)?,
                    "paymentMethod": row.get::<_, Option<String>>(6)?,
                    "paymentStatus": row.get::<_, Option<String>>(7)?,
                    "status": row.get::<_, String>(8)?,
                    "createdAt": row.get::<_, String>(9)?,
                }))
            },
        )
        .map_err(|e| format!("query non-driver order details: {e}"))?
        .filter_map(|row| row.ok())
        .collect::<Vec<_>>();

    let truncated = rows.len() > 1000;
    if truncated {
        rows.truncate(1000);
    }

    Ok((rows, truncated))
}

fn load_driver_order_details(
    conn: &Connection,
    shift_id: &str,
) -> Result<(Vec<Value>, bool), String> {
    let mut rows = conn
        .prepare(
            "SELECT de.id,
                    COALESCE(o.id, de.order_id),
                    COALESCE(NULLIF(TRIM(o.order_number), ''), de.order_id),
                    COALESCE(o.order_type, 'delivery'),
                    o.delivery_address,
                    COALESCE(o.total_amount, de.cash_collected + de.card_amount),
                    de.payment_method,
                    COALESCE(o.payment_status, 'paid'),
                    COALESCE(o.status, 'completed'),
                    COALESCE(o.created_at, de.created_at)
             FROM driver_earnings de
             LEFT JOIN orders o ON o.id = de.order_id
             WHERE de.staff_shift_id = ?1
               AND (o.id IS NULL OR COALESCE(o.is_ghost, 0) = 0)
             ORDER BY COALESCE(o.created_at, de.created_at) ASC
             LIMIT 1001",
        )
        .map_err(|e| format!("prepare driver order details: {e}"))?
        .query_map(params![shift_id], |row| {
            let raw_order_type = row.get::<_, String>(3)?;
            Ok(serde_json::json!({
                "id": row.get::<_, String>(1)?,
                "orderNumber": row.get::<_, String>(2)?,
                "orderType": normalize_order_type(&raw_order_type),
                "deliveryAddress": row.get::<_, Option<String>>(4)?,
                "amount": row.get::<_, f64>(5)?,
                "paymentMethod": row.get::<_, Option<String>>(6)?,
                "paymentStatus": row.get::<_, Option<String>>(7)?,
                "status": row.get::<_, String>(8)?,
                "createdAt": row.get::<_, String>(9)?,
            }))
        })
        .map_err(|e| format!("query driver order details: {e}"))?
        .filter_map(|row| row.ok())
        .collect::<Vec<_>>();

    let truncated = rows.len() > 1000;
    if truncated {
        rows.truncate(1000);
    }

    Ok((rows, truncated))
}

fn load_driver_unsettled_counts_for_period(
    conn: &Connection,
    period_start: &str,
    cutoff_at: Option<&str>,
    lower_bound_mode: LowerBoundMode,
) -> Result<HashMap<String, i64>, String> {
    let created_at_predicate = lower_bound_mode.sql_predicate("de.created_at", "?1");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT de.driver_id, COUNT(*)
             FROM driver_earnings de
             LEFT JOIN orders o ON o.id = de.order_id
             WHERE {created_at_predicate}
               AND (?2 IS NULL OR de.created_at <= ?2)
               AND COALESCE(de.settled, 0) = 0
               AND (o.id IS NULL OR COALESCE(o.is_ghost, 0) = 0)
               AND (o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded'))
             GROUP BY de.driver_id"
        ))
        .map_err(|e| format!("prepare driver unsettled counts for period: {e}"))?;

    let rows = stmt
        .query_map(params![period_start, cutoff_at], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("query driver unsettled counts for period: {e}"))?;

    let mut unsettled = HashMap::new();
    for row in rows.flatten() {
        unsettled.insert(row.0, row.1);
    }
    Ok(unsettled)
}

fn load_driver_unsettled_counts_for_shift(
    conn: &Connection,
    shift: &ReportStaffShift,
) -> Result<HashMap<String, i64>, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM driver_earnings de
             LEFT JOIN orders o ON o.id = de.order_id
             WHERE de.staff_shift_id = ?1
               AND COALESCE(de.settled, 0) = 0
               AND (o.id IS NULL OR COALESCE(o.is_ghost, 0) = 0)
               AND (o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded'))",
            params![shift.id.as_str()],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let mut unsettled = HashMap::new();
    unsettled.insert(shift.staff_id.clone(), count);
    Ok(unsettled)
}

fn build_staff_report(
    conn: &Connection,
    shift: &ReportStaffShift,
    cash_breakdown_lookup: &HashMap<String, Value>,
) -> Result<Value, String> {
    let display_name = display_staff_name(shift);
    let expense_items = load_staff_expense_items(conn, &shift.id)?;
    let expenses_total = expense_items
        .iter()
        .map(|item| item.get("amount").and_then(Value::as_f64).unwrap_or(0.0))
        .sum::<f64>();
    let payment_items = load_staff_payment_items(conn, shift)?;
    let staff_payments_total = payment_items
        .iter()
        .map(|item| item.get("amount").and_then(Value::as_f64).unwrap_or(0.0))
        .sum::<f64>();
    let drawer_snapshot = load_staff_drawer_snapshot(conn, &shift.id)?;
    let cash_breakdown_row = cash_breakdown_lookup.get(&shift.id);

    let (
        orders_value,
        orders_details,
        orders_truncated,
        driver_value,
        returned_to_drawer_amount,
        drawer_value,
    ) = if shift.role_type == "driver" {
        let (details, truncated) = load_driver_order_details(conn, &shift.id)?;
        let (
            deliveries,
            completed_deliveries,
            cancelled_deliveries,
            earnings,
            cash_collected,
            card_amount,
            total_amount,
        ) = load_driver_order_totals(conn, &shift.id)?;
        let cash_to_return = cash_breakdown_row
            .and_then(|row| row.get("cashToReturn"))
            .and_then(Value::as_f64)
            .or(shift.expected_cash)
            .unwrap_or(shift.opening_cash + cash_collected - expenses_total);

        let drawer_value = drawer_snapshot.unwrap_or_else(|| {
            serde_json::json!({
                "opening": shift.opening_cash,
                "expected": shift.expected_cash.unwrap_or(cash_to_return),
                "closing": shift.closing_cash,
                "variance": shift.cash_variance,
                "cashSales": cash_collected,
                "cardSales": card_amount,
                "drops": 0.0,
                "driverCashReturned": cash_to_return,
                "driverCashGiven": 0.0,
            })
        });

        (
            serde_json::json!({
                "count": deliveries,
                "cashAmount": cash_collected,
                "cardAmount": card_amount,
                "totalAmount": total_amount,
            }),
            details,
            truncated,
            Some(serde_json::json!({
                "deliveries": deliveries,
                "completedDeliveries": completed_deliveries,
                "cancelledDeliveries": cancelled_deliveries,
                "earnings": earnings,
                "cashCollected": cash_collected,
                "cardAmount": card_amount,
                "cashToReturn": cash_to_return,
            })),
            cash_to_return,
            drawer_value,
        )
    } else {
        let (details, truncated) = load_non_driver_order_details(conn, shift)?;
        let (order_count, cash_amount, card_amount, total_amount) =
            load_non_driver_order_totals(conn, shift)?;
        let returned_to_drawer_amount = drawer_snapshot
            .as_ref()
            .and_then(|drawer| drawer.get("expected"))
            .and_then(Value::as_f64)
            .or_else(|| {
                cash_breakdown_row
                    .and_then(|row| row.get("cashToReturn"))
                    .and_then(Value::as_f64)
            })
            .or(shift.expected_cash)
            .unwrap_or(shift.opening_cash + cash_amount - expenses_total);

        let drawer_value = drawer_snapshot.unwrap_or_else(|| {
            serde_json::json!({
                "opening": shift.opening_cash,
                "expected": shift.expected_cash.unwrap_or(returned_to_drawer_amount),
                "closing": shift.closing_cash,
                "variance": shift.cash_variance,
                "cashSales": cash_amount,
                "cardSales": card_amount,
                "drops": 0.0,
                "driverCashReturned": 0.0,
                "driverCashGiven": 0.0,
            })
        });

        (
            serde_json::json!({
                "count": order_count,
                "cashAmount": cash_amount,
                "cardAmount": card_amount,
                "totalAmount": total_amount,
            }),
            details,
            truncated,
            None,
            returned_to_drawer_amount,
            drawer_value,
        )
    };

    Ok(serde_json::json!({
        "staffShiftId": shift.id,
        "staffId": shift.staff_id,
        "staffName": display_name,
        "role": shift.role_type,
        "checkIn": shift.check_in_time,
        "checkOut": shift.check_out_time,
        "shiftStatus": "closed",
        "orders": orders_value,
        "ordersDetails": orders_details,
        "ordersTruncated": orders_truncated,
        "payments": {
            "staffPayments": staff_payments_total,
            "list": payment_items,
        },
        "expenses": {
            "total": expenses_total,
            "items": expense_items,
        },
        "driver": driver_value,
        "drawer": drawer_value,
        "returnedToDrawerAmount": returned_to_drawer_amount,
    }))
}

fn build_driver_summary(staff_reports: &[Value], unsettled_counts: &HashMap<String, i64>) -> Value {
    #[derive(Default)]
    struct DriverAggregate {
        name: String,
        deliveries: i64,
        completed_deliveries: i64,
        cancelled_deliveries: i64,
        earnings: f64,
        cash_collected: f64,
        card_amount: f64,
        cash_to_return: f64,
        unsettled_count: i64,
    }

    let mut drivers: HashMap<String, DriverAggregate> = HashMap::new();

    for staff in staff_reports {
        if staff.get("role").and_then(Value::as_str) != Some("driver") {
            continue;
        }
        let Some(staff_id) = staff.get("staffId").and_then(Value::as_str) else {
            continue;
        };
        let Some(driver) = staff.get("driver") else {
            continue;
        };

        let entry = drivers.entry(staff_id.to_string()).or_default();
        if entry.name.is_empty() {
            entry.name = staff
                .get("staffName")
                .and_then(Value::as_str)
                .unwrap_or(staff_id)
                .to_string();
            entry.unsettled_count = *unsettled_counts.get(staff_id).unwrap_or(&0);
        }

        entry.deliveries += driver
            .get("deliveries")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        entry.completed_deliveries += driver
            .get("completedDeliveries")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        entry.cancelled_deliveries += driver
            .get("cancelledDeliveries")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        entry.earnings += driver
            .get("earnings")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        entry.cash_collected += driver
            .get("cashCollected")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        entry.card_amount += driver
            .get("cardAmount")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        entry.cash_to_return += driver
            .get("cashToReturn")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
    }

    let mut total_deliveries = 0_i64;
    let mut completed_deliveries = 0_i64;
    let mut cancelled_deliveries = 0_i64;
    let mut total_earnings = 0.0_f64;
    let mut total_cash_collected = 0.0_f64;
    let mut total_card_amount = 0.0_f64;
    let mut total_cash_to_return = 0.0_f64;
    let mut unsettled_total = 0_i64;

    let breakdown = drivers
        .into_iter()
        .map(|(driver_id, aggregate)| {
            total_deliveries += aggregate.deliveries;
            completed_deliveries += aggregate.completed_deliveries;
            cancelled_deliveries += aggregate.cancelled_deliveries;
            total_earnings += aggregate.earnings;
            total_cash_collected += aggregate.cash_collected;
            total_card_amount += aggregate.card_amount;
            total_cash_to_return += aggregate.cash_to_return;
            unsettled_total += aggregate.unsettled_count;

            serde_json::json!({
                "driverId": driver_id,
                "name": aggregate.name,
                "deliveries": aggregate.deliveries,
                "earnings": aggregate.earnings,
                "unsettled": aggregate.unsettled_count > 0,
                "cashCollected": aggregate.cash_collected,
                "cardAmount": aggregate.card_amount,
                "cashToReturn": aggregate.cash_to_return,
            })
        })
        .collect::<Vec<_>>();

    serde_json::json!({
        "totalDeliveries": total_deliveries,
        "completedDeliveries": completed_deliveries,
        "cancelledDeliveries": cancelled_deliveries,
        "totalEarnings": total_earnings,
        "unsettledCount": unsettled_total,
        "cashCollectedTotal": total_cash_collected,
        "cardAmountTotal": total_card_amount,
        "cashToReturnTotal": total_cash_to_return,
        "breakdown": breakdown,
    })
}

// ---------------------------------------------------------------------------
// Generate Z-report (single shift — legacy path)
// ---------------------------------------------------------------------------

/// Generate a Z-report for a closed shift.
///
/// Aggregates orders, payments, adjustments, and expenses for the given shift,
/// persists the snapshot in `z_reports`, and enqueues a sync entry.
///
/// **Idempotent:** If a z_report already exists for this shift, returns the
/// existing one without creating a duplicate.
pub fn generate_z_report(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let shift_id = str_field(payload, "shiftId")
        .or_else(|| str_field(payload, "shift_id"))
        .ok_or("Missing shiftId")?;

    // Check for existing z_report (idempotent)
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM z_reports WHERE shift_id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .ok();

    if let Some(existing_id) = existing {
        // Return the existing report
        return get_z_report_by_id(&conn, &existing_id).map(|mut report| {
            if let Some(obj) = report.as_object_mut() {
                if let Some(terminal_name) = resolve_terminal_display_name(&conn, None) {
                    obj.entry("terminalName".to_string())
                        .or_insert(serde_json::Value::String(terminal_name));
                }
                if obj.get("shiftCount").is_none() {
                    if let Some(report_json) =
                        obj.get("reportJson").and_then(|value| value.as_str())
                    {
                        if let Ok(parsed) = serde_json::from_str::<Value>(report_json) {
                            if let Some(count) = parsed
                                .pointer("/shifts/total")
                                .and_then(Value::as_i64)
                                .filter(|count| *count > 0)
                            {
                                obj.insert("shiftCount".to_string(), serde_json::json!(count));
                            }
                        }
                    }
                }
            }
            serde_json::json!({
                "success": true,
                "existing": true,
                "zReportId": existing_id,
                "report": report,
            })
        });
    }

    // Verify shift exists and is closed
    let shift = conn
        .query_row(
            "SELECT id, staff_id, staff_name, role_type, status,
                    opening_cash_amount, closing_cash_amount,
                    expected_cash_amount, cash_variance,
                    check_in_time, check_out_time, branch_id, terminal_id,
                    report_date, period_start_at
             FROM staff_shifts WHERE id = ?1",
            params![shift_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,          // id
                    row.get::<_, String>(1)?,          // staff_id
                    row.get::<_, Option<String>>(2)?,  // staff_name
                    row.get::<_, String>(3)?,          // role_type
                    row.get::<_, String>(4)?,          // status
                    row.get::<_, f64>(5)?,             // opening_cash
                    row.get::<_, Option<f64>>(6)?,     // closing_cash
                    row.get::<_, Option<f64>>(7)?,     // expected_cash
                    row.get::<_, Option<f64>>(8)?,     // cash_variance
                    row.get::<_, Option<String>>(9)?,  // check_in_time
                    row.get::<_, Option<String>>(10)?, // check_out_time
                    row.get::<_, Option<String>>(11)?, // branch_id
                    row.get::<_, Option<String>>(12)?, // terminal_id
                    row.get::<_, Option<String>>(13)?, // report_date
                    row.get::<_, Option<String>>(14)?, // period_start_at
                ))
            },
        )
        .map_err(|_| format!("Shift not found: {shift_id}"))?;

    let (
        _shift_id,
        staff_id,
        staff_name,
        role_type,
        status,
        opening_cash,
        closing_cash,
        expected_cash,
        cash_variance,
        check_in_time,
        check_out_time,
        shift_branch_id,
        shift_terminal_id,
        stored_report_date,
        stored_period_start_at,
    ) = shift;

    if status != "closed" {
        return Err(format!(
            "Shift must be closed to generate Z-report (current status: {status})"
        ));
    }

    let primary_shift = ReportStaffShift {
        id: shift_id.to_string(),
        staff_id: staff_id.clone(),
        staff_name: staff_name.clone(),
        role_type: role_type.clone(),
        opening_cash,
        closing_cash,
        expected_cash,
        cash_variance,
        check_in_time: check_in_time.clone(),
        check_out_time: check_out_time.clone(),
    };

    let terminal_id = shift_terminal_id
        .clone()
        .unwrap_or_else(|| storage::get_credential("terminal_id").unwrap_or_default());
    let terminal_name = resolve_terminal_display_name(&conn, None);
    let branch_id =
        shift_branch_id.unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default());

    // --- Aggregate data from the shift ---

    // Orders: count, gross sales, discounts, tips
    let order_agg = conn
        .query_row(
            "SELECT COUNT(*) as cnt,
                    COALESCE(SUM(total_amount), 0) as gross,
                    COALESCE(SUM(discount_amount), 0) as discounts,
                    COALESCE(SUM(tip_amount), 0) as tips
             FROM orders
             WHERE staff_shift_id = ?1
               AND COALESCE(is_ghost, 0) = 0
               AND status NOT IN ('cancelled', 'canceled')",
            params![shift_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            },
        )
        .unwrap_or((0, 0.0, 0.0, 0.0));

    let (total_orders, gross_sales, discounts_total, tips_total) = order_agg;

    // Payments: breakdown by method
    let mut pay_stmt = conn
        .prepare(
            "SELECT op.method, COUNT(*) as cnt, COALESCE(SUM(op.amount), 0) as total
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE op.staff_shift_id = ?1
               AND op.status = 'completed'
               AND COALESCE(o.is_ghost, 0) = 0
               AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
             GROUP BY op.method",
        )
        .map_err(|e| format!("prepare payment query: {e}"))?;

    let mut cash_sales = 0.0_f64;
    let mut card_sales = 0.0_f64;
    let mut other_sales = 0.0_f64;
    let mut cash_count = 0_i64;
    let mut card_count = 0_i64;
    let mut other_count = 0_i64;

    let pay_rows = pay_stmt
        .query_map(params![shift_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| format!("query payments: {e}"))?;

    for row in pay_rows.flatten() {
        let (method, count, total) = row;
        match method.as_str() {
            "cash" => {
                cash_sales = total;
                cash_count = count;
            }
            "card" => {
                card_sales = total;
                card_count = count;
            }
            _ => {
                other_sales += total;
                other_count += count;
            }
        }
    }

    // Adjustments: refunds and voids
    let mut adj_stmt = conn
        .prepare(
            "SELECT pa.adjustment_type, COALESCE(SUM(pa.amount), 0)
             FROM payment_adjustments pa
             JOIN order_payments op ON pa.payment_id = op.id
             JOIN orders o ON o.id = op.order_id
             WHERE op.staff_shift_id = ?1
               AND COALESCE(o.is_ghost, 0) = 0
               AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
             GROUP BY pa.adjustment_type",
        )
        .map_err(|e| format!("prepare adjustment query: {e}"))?;

    let mut refunds_total = 0.0_f64;
    let mut voids_total = 0.0_f64;

    let adj_rows = adj_stmt
        .query_map(params![shift_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })
        .map_err(|e| format!("query adjustments: {e}"))?;

    for row in adj_rows.flatten() {
        let (adj_type, amount) = row;
        match adj_type.as_str() {
            "refund" => refunds_total = amount,
            "void" => voids_total = amount,
            _ => warn!("Unknown adjustment type: {adj_type}"),
        }
    }

    // Expenses
    let expenses_total: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM shift_expenses WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .unwrap_or(0.0);

    // Expense items for report_json
    let mut exp_stmt = conn
        .prepare(
            "SELECT se.id, se.expense_type, se.amount, se.description, se.created_at, ss.staff_name
             FROM shift_expenses se
             LEFT JOIN staff_shifts ss ON ss.id = se.staff_shift_id
             WHERE se.staff_shift_id = ?1
             ORDER BY se.created_at ASC",
        )
        .map_err(|e| format!("prepare expense query: {e}"))?;

    let expense_items: Vec<Value> = exp_stmt
        .query_map(params![shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "expenseType": row.get::<_, Option<String>>(1)?,
                "amount": row.get::<_, f64>(2)?,
                "description": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "createdAt": row.get::<_, String>(4)?,
                "staffName": row.get::<_, Option<String>>(5)?,
            }))
        })
        .map_err(|e| format!("query expenses: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // Cash drawer session
    let mut drawer = conn
        .query_row(
            "SELECT opening_amount, closing_amount, expected_amount, variance_amount,
                    total_cash_sales, total_card_sales, total_refunds, total_expenses,
                    cash_drops, driver_cash_given, driver_cash_returned, reconciled,
                    total_staff_payments
             FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| {
                let reconciled: bool = row.get::<_, i64>(11).unwrap_or(0) != 0;
                Ok(serde_json::json!({
                    "openingTotal": row.get::<_, f64>(0).unwrap_or(0.0),
                    "closing": row.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                    "expected": row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                    "totalVariance": row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
                    "cashSales": row.get::<_, f64>(4).unwrap_or(0.0),
                    "cardSales": row.get::<_, f64>(5).unwrap_or(0.0),
                    "totalRefunds": row.get::<_, f64>(6).unwrap_or(0.0),
                    "totalExpenses": row.get::<_, f64>(7).unwrap_or(0.0),
                    "totalCashDrops": row.get::<_, f64>(8).unwrap_or(0.0),
                    "driverCashGiven": row.get::<_, f64>(9).unwrap_or(0.0),
                    "driverCashReturned": row.get::<_, f64>(10).unwrap_or(0.0),
                    "unreconciledCount": if reconciled { 0 } else { 1 },
                    "staffPaymentsTotal": row.get::<_, f64>(12).unwrap_or(0.0),
                }))
            },
        )
        .ok();

    let (driver_cash_breakdown, waiter_cash_breakdown) = match role_type.as_str() {
        "cashier" | "manager" => {
            let staff_rows = crate::shifts::build_cashier_staff_checkout_rows(
                &conn,
                &shift_id,
                &branch_id,
                &terminal_id,
                check_in_time.as_deref().unwrap_or(""),
                check_out_time.as_deref(),
            )?;
            let driver_rows = staff_rows
                .iter()
                .filter(|row| row["role_type"].as_str() == Some("driver"))
                .map(shift_summary_row_to_cash_breakdown)
                .collect::<Vec<Value>>();
            let waiter_rows = staff_rows
                .iter()
                .filter(|row| row["role_type"].as_str() == Some("server"))
                .map(shift_summary_row_to_cash_breakdown)
                .collect::<Vec<Value>>();
            (driver_rows, waiter_rows)
        }
        "driver" => (
            vec![build_staff_cash_breakdown_row(
                &conn,
                &shift_id,
                staff_name.as_deref(),
                "driver",
                opening_cash,
            )?],
            Vec::new(),
        ),
        "server" => (
            Vec::new(),
            vec![build_staff_cash_breakdown_row(
                &conn,
                &shift_id,
                staff_name.as_deref(),
                "server",
                opening_cash,
            )?],
        ),
        _ => (Vec::new(), Vec::new()),
    };

    if drawer.is_none() {
        drawer = Some(serde_json::json!({
            "totalVariance": cash_variance,
            "openingTotal": opening_cash,
            "closing": closing_cash,
            "expected": expected_cash,
            "totalCashDrops": 0.0,
            "driverCashGiven": 0.0,
            "driverCashReturned": 0.0,
            "staffPaymentsTotal": 0.0,
            "unreconciledCount": 0,
        }));
    }

    if let Some(ref mut drawer_obj) = drawer {
        if let Some(obj) = drawer_obj.as_object_mut() {
            obj.insert(
                "driverCashBreakdown".to_string(),
                Value::Array(driver_cash_breakdown.clone()),
            );
            obj.insert(
                "waiterCashBreakdown".to_string(),
                Value::Array(waiter_cash_breakdown.clone()),
            );
        }
    }

    // Order type breakdown (dine-in, takeaway, delivery)
    let mut ot_stmt = conn
        .prepare(
            "SELECT COALESCE(order_type, 'dine-in'), COUNT(*), COALESCE(SUM(total_amount), 0)
             FROM orders
             WHERE staff_shift_id = ?1
               AND COALESCE(is_ghost, 0) = 0
               AND status NOT IN ('cancelled', 'canceled')
             GROUP BY COALESCE(order_type, 'dine-in')",
        )
        .map_err(|e| format!("prepare order_type query: {e}"))?;

    let mut dine_in_orders = 0_i64;
    let mut dine_in_sales = 0.0_f64;
    let mut takeaway_orders = 0_i64;
    let mut takeaway_sales = 0.0_f64;
    let mut delivery_orders = 0_i64;
    let mut delivery_sales = 0.0_f64;

    let ot_rows = ot_stmt
        .query_map(params![shift_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| format!("query order_type: {e}"))?;

    for row in ot_rows.flatten() {
        let (otype, count, total) = row;
        match otype.as_str() {
            "dine-in" | "dine_in" => {
                dine_in_orders += count;
                dine_in_sales += total;
            }
            "takeaway" | "pickup" => {
                takeaway_orders += count;
                takeaway_sales += total;
            }
            "delivery" => {
                delivery_orders += count;
                delivery_sales += total;
            }
            _ => {
                // Unknown order types count as dine-in
                dine_in_orders += count;
                dine_in_sales += total;
            }
        }
    }

    // Staff payments total (from staff_payments table if it exists)
    let staff_payments_total: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM staff_payments WHERE cashier_shift_id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .unwrap_or(0.0);
    let pending_expenses_count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM shift_expenses
             WHERE staff_shift_id = ?1
               AND status = 'pending'
               AND (expense_type IS NULL OR expense_type != 'staff_payment')",
            params![shift_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // --- Compute derived totals ---

    let net_sales = gross_sales - refunds_total - voids_total - discounts_total;
    let opening = opening_cash;
    let closing = closing_cash.unwrap_or(0.0);
    let expected = expected_cash.unwrap_or(0.0);
    let variance = cash_variance.unwrap_or(0.0);

    let report_date = stored_report_date
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            let period_start_at = stored_period_start_at
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    check_in_time.as_deref().map(|timestamp| {
                        resolve_period_start_at(&conn, &branch_id, Some(timestamp))
                    })
                });

            period_start_at.as_deref().map(|period_start_at| {
                report_date_for_business_window(
                    period_start_at,
                    check_out_time.as_deref().unwrap_or_else(|| {
                        check_in_time.as_deref().unwrap_or("1970-01-01T00:00:00Z")
                    }),
                )
            })
        })
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

    // Build payments breakdown JSON
    let payments_breakdown = serde_json::json!({
        "cash": { "count": cash_count, "total": cash_sales },
        "card": { "count": card_count, "total": card_sales },
        "other": { "count": other_count, "total": other_sales },
    });
    let sales_by_type = load_sales_by_type_for_shift(&conn, &shift_id)?;
    let drawer_rows = load_drawer_rows_for_shift(&conn, &shift_id)?;
    let cash_breakdown_lookup = driver_cash_breakdown
        .iter()
        .chain(waiter_cash_breakdown.iter())
        .filter_map(|row| {
            row.get("driverShiftId")
                .and_then(Value::as_str)
                .map(|shift_id| (shift_id.to_string(), row.clone()))
        })
        .collect::<HashMap<_, _>>();
    let staff_reports = vec![build_staff_report(
        &conn,
        &primary_shift,
        &cash_breakdown_lookup,
    )?];
    let driver_summary = build_driver_summary(
        &staff_reports,
        &load_driver_unsettled_counts_for_shift(&conn, &primary_shift)?,
    );
    let shift_counts = serde_json::json!({
        "total": 1,
        "cashier": if matches!(role_type.as_str(), "cashier" | "manager") { 1 } else { 0 },
        "driver": if role_type == "driver" { 1 } else { 0 },
        "kitchen": if role_type == "kitchen" { 1 } else { 0 },
    });
    let now = Utc::now().to_rfc3339();

    // Build full report_json (matches Electron POS shape for server compat)
    let report_json = serde_json::json!({
        "date": report_date,
        "periodStart": check_in_time,
        "periodEnd": check_out_time.clone().unwrap_or_else(|| now.clone()),
        "shifts": shift_counts,
        "sales": {
            "totalOrders": total_orders,
            "totalSales": gross_sales,
            "cashSales": cash_sales,
            "cardSales": card_sales,
            "dineInOrders": dine_in_orders,
            "dineInSales": dine_in_sales,
            "takeawayOrders": takeaway_orders,
            "takeawaySales": takeaway_sales,
            "deliveryOrders": delivery_orders,
            "deliverySales": delivery_sales,
            "byType": sales_by_type,
        },
        "cashDrawer": drawer.as_ref().unwrap_or(&serde_json::json!({
            "totalVariance": variance,
            "openingTotal": opening,
        })),
        "expenses": {
            "total": expenses_total,
            "staffPaymentsTotal": staff_payments_total,
            "pendingCount": pending_expenses_count,
            "items": expense_items,
        },
        "driverEarnings": driver_summary,
        "drawers": drawer_rows,
        "staffPayments": {
            "total": staff_payments_total,
        },
        "tips": {
            "total": tips_total,
        },
        "daySummary": {
            "cashTotal": cash_sales,
            "cardTotal": card_sales,
            "total": cash_sales + card_sales + other_sales,
            "totalOrders": total_orders,
        },
        "staffReports": staff_reports,
    });

    // --- Persist in transaction ---

    let z_report_id = Uuid::new_v4().to_string();
    let payments_json_str = payments_breakdown.to_string();
    let report_json_str = report_json.to_string();
    let idempotency_key = format!("zreport:{z_report_id}");

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        conn.execute(
            "INSERT INTO z_reports (
                id, shift_id, branch_id, terminal_id, report_date, generated_at,
                gross_sales, net_sales, total_orders, cash_sales, card_sales,
                refunds_total, voids_total, discounts_total, tips_total,
                expenses_total, cash_variance, opening_cash, closing_cash, expected_cash,
                payments_breakdown_json, report_json,
                sync_state, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11,
                ?12, ?13, ?14, ?15,
                ?16, ?17, ?18, ?19, ?20,
                ?21, ?22,
                'pending', ?23, ?23
             )",
            params![
                z_report_id,
                shift_id,
                branch_id,
                terminal_id,
                report_date,
                now,
                gross_sales,
                net_sales,
                total_orders,
                cash_sales,
                card_sales,
                refunds_total,
                voids_total,
                discounts_total,
                tips_total,
                expenses_total,
                variance,
                opening,
                closing,
                expected,
                payments_json_str,
                report_json_str,
                now,
            ],
        )
        .map_err(|e| format!("insert z_report: {e}"))?;

        // Enqueue for sync — the payload for the server is the report_json
        // plus terminal/branch/date metadata.
        let sync_payload = serde_json::json!({
            "terminal_id": terminal_id,
            "branch_id": branch_id,
            "report_date": report_date,
            "report_data": report_json,
        })
        .to_string();

        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('z_report', ?1, 'insert', ?2, ?3)",
            params![z_report_id, sync_payload, idempotency_key],
        )
        .map_err(|e| format!("enqueue z_report sync: {e}"))?;

        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }

    info!(
        z_report_id = %z_report_id,
        shift_id = %shift_id,
        gross_sales = %gross_sales,
        net_sales = %net_sales,
        "Z-report generated"
    );

    Ok(serde_json::json!({
        "success": true,
        "existing": false,
        "zReportId": z_report_id,
        "report": {
            "id": z_report_id,
            "shiftId": shift_id,
            "shiftCount": 1,
            "branchId": branch_id,
            "terminalId": terminal_id,
            "terminalName": terminal_name,
            "reportDate": report_date,
            "generatedAt": now,
            "grossSales": gross_sales,
            "netSales": net_sales,
            "totalOrders": total_orders,
            "cashSales": cash_sales,
            "cardSales": card_sales,
            "refundsTotal": refunds_total,
            "voidsTotal": voids_total,
            "discountsTotal": discounts_total,
            "tipsTotal": tips_total,
            "expensesTotal": expenses_total,
            "cashVariance": variance,
            "openingCash": opening,
            "closingCash": closing,
            "expectedCash": expected,
            "paymentsBreakdown": payments_breakdown,
            "reportJson": report_json,
            "syncState": "pending",
        },
    }))
}

// ---------------------------------------------------------------------------
// Get / List
// ---------------------------------------------------------------------------

/// Get a single z_report by its ID.
pub fn get_z_report(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let z_report_id = str_field(payload, "zReportId")
        .or_else(|| str_field(payload, "z_report_id"))
        .or_else(|| str_field(payload, "id"))
        .ok_or("Missing zReportId")?;

    get_z_report_by_id(&conn, &z_report_id).map(|report| {
        serde_json::json!({
            "success": true,
            "report": report,
        })
    })
}

/// List z_reports filtered by shift or date range.
pub fn list_z_reports(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let shift_id = str_field(payload, "shiftId").or_else(|| str_field(payload, "shift_id"));
    let start_date = str_field(payload, "startDate").or_else(|| str_field(payload, "start_date"));
    let end_date = str_field(payload, "endDate").or_else(|| str_field(payload, "end_date"));

    let (sql, param_values): (String, Vec<String>) = if let Some(sid) = shift_id {
        (
            "SELECT * FROM z_reports WHERE shift_id = ?1 ORDER BY generated_at DESC".to_string(),
            vec![sid],
        )
    } else if let (Some(start), Some(end)) = (start_date, end_date) {
        (
            "SELECT * FROM z_reports WHERE report_date BETWEEN ?1 AND ?2 ORDER BY generated_at DESC"
                .to_string(),
            vec![start, end],
        )
    } else {
        // Default: last 30 days
        (
            "SELECT * FROM z_reports WHERE report_date >= date('now', '-30 days') ORDER BY generated_at DESC LIMIT 50"
                .to_string(),
            vec![],
        )
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {e}"))?;

    let reports: Vec<Value> = match param_values.len() {
        0 => {
            let rows = stmt
                .query_map([], map_z_report_row)
                .map_err(|e| format!("query: {e}"))?;
            rows.filter_map(|r| r.ok()).collect()
        }
        1 => {
            let rows = stmt
                .query_map(params![param_values[0]], map_z_report_row)
                .map_err(|e| format!("query: {e}"))?;
            rows.filter_map(|r| r.ok()).collect()
        }
        2 => {
            let rows = stmt
                .query_map(params![param_values[0], param_values[1]], map_z_report_row)
                .map_err(|e| format!("query: {e}"))?;
            rows.filter_map(|r| r.ok()).collect()
        }
        _ => return Err("Too many parameters".into()),
    };

    Ok(serde_json::json!({
        "success": true,
        "reports": reports,
        "count": reports.len(),
    }))
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

/// Enqueue a z_report for printing via the print spooler.
pub fn print_z_report(db: &DbState, payload: &Value) -> Result<Value, String> {
    let z_report_id = str_field(payload, "zReportId")
        .or_else(|| str_field(payload, "z_report_id"))
        .or_else(|| str_field(payload, "id"))
        .ok_or("Missing zReportId")?;

    // Verify the z_report exists
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM z_reports WHERE id = ?1",
            params![z_report_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| format!("Z-report not found: {z_report_id}"))?;
    }

    crate::print::enqueue_print_job(db, "z_report", &z_report_id, None)
}

pub fn get_end_of_day_status(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let branch_id = str_field(payload, "branchId")
        .or_else(|| str_field(payload, "branch_id"))
        .unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default());

    let _ = order_ownership::repair_historical_pickup_financial_attribution(
        &conn,
        branch_id.as_str(),
        &Utc::now().to_rfc3339(),
    )?;
    let now = Utc::now().to_rfc3339();
    let active_period_start_at = resolve_period_start_at(&conn, &branch_id, Some(now.as_str()));
    let active_report_date = report_date_for_business_window(&active_period_start_at, &now);

    let latest_z_report = conn
        .query_row(
            "SELECT id, sync_state, report_date
             FROM z_reports
             WHERE branch_id = ?1 OR branch_id IS NULL
             ORDER BY generated_at DESC
             LIMIT 1",
            params![branch_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("query latest z-report status: {e}"))?;

    if let Some(context) = load_pending_z_report_context(&conn, &branch_id) {
        return Ok(serde_json::json!({
            "status": "pending_local_submit",
            "pendingReportDate": context.report_date,
            "cutoffAt": context.cutoff_at,
            "periodStartAt": context.period_start_at,
            "activeReportDate": Value::Null,
            "activePeriodStartAt": Value::Null,
            "latestZReportId": latest_z_report.as_ref().map(|row| row.0.clone()),
            "latestZReportSyncState": latest_z_report.as_ref().map(|row| row.1.clone()),
            "canOpenPendingZReport": true,
        }));
    }

    if let Some((latest_id, latest_sync_state, latest_report_date)) = latest_z_report {
        if latest_sync_state != "applied" {
            return Ok(serde_json::json!({
                "status": "submitted_pending_admin",
                "pendingReportDate": latest_report_date,
                "cutoffAt": Value::Null,
                "periodStartAt": Value::Null,
                "activeReportDate": Value::Null,
                "activePeriodStartAt": Value::Null,
                "latestZReportId": latest_id,
                "latestZReportSyncState": latest_sync_state,
                "canOpenPendingZReport": false,
            }));
        }
    }

    Ok(serde_json::json!({
        "status": "idle",
        "pendingReportDate": Value::Null,
        "cutoffAt": Value::Null,
        "periodStartAt": Value::Null,
        "activeReportDate": active_report_date,
        "activePeriodStartAt": active_period_start_at,
        "latestZReportId": Value::Null,
        "latestZReportSyncState": Value::Null,
        "canOpenPendingZReport": false,
    }))
}

// ---------------------------------------------------------------------------
// Multi-shift aggregation (Gap 7)
// ---------------------------------------------------------------------------

/// Build a multi-shift Z-report snapshot for a branch/date window.
///
/// The returned value is not persisted. Callers choose whether the snapshot
/// is used as a preview or materialized into `z_reports` and `sync_queue`.
fn build_z_report_for_date(db: &DbState, payload: &Value) -> Result<BuiltDateZReport, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let branch_id = str_field(payload, "branchId")
        .or_else(|| str_field(payload, "branch_id"))
        .unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default());
    let now = Utc::now().to_rfc3339();
    let _ = order_ownership::repair_historical_pickup_financial_attribution(
        &conn,
        branch_id.as_str(),
        &now,
    )?;
    let window = resolve_effective_z_report_window(&conn, &branch_id, payload);
    let date = window.report_date.clone();
    let period_start = window.period_start_at.clone();
    let cutoff_at = window.cutoff_at.clone();
    let lower_bound_mode = window.lower_bound_mode;
    let cutoff_param = cutoff_at.as_deref();
    let period_end = cutoff_at.clone().unwrap_or_else(|| now.clone());

    info!(
        branch_id = %branch_id,
        date = %date,
        period_start = %period_start,
        cutoff_at = ?cutoff_at,
        "Generating multi-shift Z-report"
    );

    // --- Query all closed shifts since period_start for this branch ---
    let shift_start_predicate = lower_bound_mode.sql_predicate("check_in_time", "?1");
    let mut shift_stmt = conn
        .prepare(&format!(
            "SELECT id, staff_id, staff_name, role_type, status,
                    opening_cash_amount, closing_cash_amount,
                    expected_cash_amount, cash_variance,
                    check_in_time, check_out_time, branch_id, terminal_id,
                    calculation_version
             FROM staff_shifts
             WHERE {shift_start_predicate}
               AND (branch_id = ?2 OR branch_id IS NULL)
               AND status = 'closed'
               AND (?3 IS NULL OR COALESCE(check_out_time, check_in_time) <= ?3)
             ORDER BY check_in_time ASC"
        ))
        .map_err(|e| format!("prepare shift query: {e}"))?;

    let shifts: Vec<ReportStaffShift> = shift_stmt
        .query_map(params![period_start, branch_id, cutoff_param], |row| {
            Ok(ReportStaffShift {
                id: row.get(0)?,
                staff_id: row.get(1)?,
                staff_name: row.get(2)?,
                role_type: row.get(3)?,
                opening_cash: row.get(5)?,
                closing_cash: row.get(6)?,
                expected_cash: row.get(7)?,
                cash_variance: row.get(8)?,
                check_in_time: row.get(9)?,
                check_out_time: row.get(10)?,
            })
        })
        .map_err(|e| format!("query shifts: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // Count shifts by role
    let shifts_total = shifts.len() as i64;
    let shifts_cashier = shifts.iter().filter(|s| s.role_type == "cashier").count() as i64;
    let shifts_driver = shifts.iter().filter(|s| s.role_type == "driver").count() as i64;
    let shifts_kitchen = shifts.iter().filter(|s| s.role_type == "kitchen").count() as i64;

    // --- Aggregate orders across all shifts in the period ---
    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let financial_predicate = lower_bound_mode.sql_predicate(&financial_expr, "?1");
    let order_agg_sql = format!(
        "SELECT COUNT(*) as cnt,
                COALESCE(SUM(o.total_amount), 0) as gross,
                COALESCE(SUM(o.discount_amount), 0) as discounts,
                COALESCE(SUM(o.tip_amount), 0) as tips
         FROM orders o
         WHERE {financial_predicate}
           AND (?2 IS NULL OR {financial_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled')"
    );
    let order_agg = conn
        .query_row(
            &order_agg_sql,
            params![period_start, cutoff_param, branch_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            },
        )
        .unwrap_or((0, 0.0, 0.0, 0.0));

    let (total_orders, gross_sales, discounts_total, tips_total) = order_agg;

    // --- Payments: breakdown by method across all shifts ---
    let payment_scope_expr = business_day::order_financial_timestamp_expr("o");
    let payment_scope_predicate = lower_bound_mode.sql_predicate(&payment_scope_expr, "?1");
    let payment_scope_sql = format!(
        "SELECT op.method, COUNT(*) as cnt, COALESCE(SUM(op.amount), 0) as total
         FROM order_payments op
         JOIN orders o ON o.id = op.order_id
         WHERE {payment_scope_predicate}
           AND (?2 IS NULL OR {payment_scope_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND op.status = 'completed'
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
         GROUP BY op.method"
    );
    let mut pay_stmt = conn
        .prepare(&payment_scope_sql)
        .map_err(|e| format!("prepare payment query: {e}"))?;

    let mut cash_sales = 0.0_f64;
    let mut card_sales = 0.0_f64;
    let mut other_sales = 0.0_f64;
    let mut cash_count = 0_i64;
    let mut card_count = 0_i64;
    let mut other_count = 0_i64;

    let pay_rows = pay_stmt
        .query_map(params![period_start, cutoff_param, branch_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| format!("query payments: {e}"))?;

    for row in pay_rows.flatten() {
        let (method, count, total) = row;
        match method.as_str() {
            "cash" => {
                cash_sales = total;
                cash_count = count;
            }
            "card" => {
                card_sales = total;
                card_count = count;
            }
            _ => {
                other_sales += total;
                other_count += count;
            }
        }
    }

    // --- Adjustments: refunds and voids across all shifts ---
    let adjustment_scope_expr = business_day::order_financial_timestamp_expr("o");
    let adjustment_scope_predicate = lower_bound_mode.sql_predicate(&adjustment_scope_expr, "?1");
    let adjustment_scope_sql = format!(
        "SELECT pa.adjustment_type, COALESCE(SUM(pa.amount), 0)
         FROM payment_adjustments pa
         JOIN orders o ON o.id = pa.order_id
         WHERE {adjustment_scope_predicate}
           AND (?2 IS NULL OR {adjustment_scope_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
         GROUP BY pa.adjustment_type"
    );
    let mut adj_stmt = conn
        .prepare(&adjustment_scope_sql)
        .map_err(|e| format!("prepare adjustment query: {e}"))?;

    let mut refunds_total = 0.0_f64;
    let mut voids_total = 0.0_f64;

    let adj_rows = adj_stmt
        .query_map(params![period_start, cutoff_param, branch_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })
        .map_err(|e| format!("query adjustments: {e}"))?;

    for row in adj_rows.flatten() {
        let (adj_type, amount) = row;
        match adj_type.as_str() {
            "refund" => refunds_total = amount,
            "void" => voids_total = amount,
            _ => warn!("Unknown adjustment type: {adj_type}"),
        }
    }

    // --- Expenses (excluding staff_payment type) across all shifts ---
    let expenses_total: f64 = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(amount), 0) FROM shift_expenses
             WHERE {}
               AND (?2 IS NULL OR created_at <= ?2)
               AND (expense_type IS NULL OR expense_type != 'staff_payment')",
                lower_bound_mode.sql_predicate("created_at", "?1")
            ),
            params![period_start, cutoff_param],
            |row| row.get(0),
        )
        .unwrap_or(0.0);

    // Expense items for report_json
    let mut exp_stmt = conn
        .prepare(&format!(
            "SELECT se.id, se.expense_type, se.amount, se.description, se.created_at, ss.staff_name
             FROM shift_expenses se
             LEFT JOIN staff_shifts ss ON ss.id = se.staff_shift_id
             WHERE {}
               AND (?2 IS NULL OR se.created_at <= ?2)
               AND (se.expense_type IS NULL OR se.expense_type != 'staff_payment')
             ORDER BY se.created_at ASC",
            lower_bound_mode.sql_predicate("se.created_at", "?1")
        ))
        .map_err(|e| format!("prepare expense query: {e}"))?;

    let expense_items: Vec<Value> = exp_stmt
        .query_map(params![period_start, cutoff_param], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "expenseType": row.get::<_, Option<String>>(1)?,
                "amount": row.get::<_, f64>(2)?,
                "description": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "createdAt": row.get::<_, String>(4)?,
                "staffName": row.get::<_, Option<String>>(5)?,
            }))
        })
        .map_err(|e| format!("query expenses: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // --- Cash drawer sessions (aggregate across all shifts) ---
    let mut drawer_agg = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(opening_amount), 0),
                    COALESCE(SUM(closing_amount), 0),
                    COALESCE(SUM(expected_amount), 0),
                    COALESCE(SUM(variance_amount), 0),
                    COALESCE(SUM(total_cash_sales), 0),
                    COALESCE(SUM(total_card_sales), 0),
                    COALESCE(SUM(total_refunds), 0),
                    COALESCE(SUM(total_expenses), 0),
                    COALESCE(SUM(cash_drops), 0),
                    COALESCE(SUM(driver_cash_given), 0),
                    COALESCE(SUM(driver_cash_returned), 0),
                    SUM(CASE WHEN (reconciled = 0 OR reconciled IS NULL) THEN 1 ELSE 0 END),
                    COALESCE(SUM(total_staff_payments), 0)
             FROM cash_drawer_sessions
             WHERE {}
               AND (?2 IS NULL OR opened_at <= ?2)",
                lower_bound_mode.sql_predicate("opened_at", "?1")
            ),
            params![period_start, cutoff_param],
            |row| {
                Ok(serde_json::json!({
                    "openingTotal": row.get::<_, f64>(0)?,
                    "closing": row.get::<_, f64>(1)?,
                    "expected": row.get::<_, f64>(2)?,
                    "totalVariance": row.get::<_, f64>(3)?,
                    "cashSales": row.get::<_, f64>(4)?,
                    "cardSales": row.get::<_, f64>(5)?,
                    "totalRefunds": row.get::<_, f64>(6)?,
                    "totalExpenses": row.get::<_, f64>(7)?,
                    "totalCashDrops": row.get::<_, f64>(8)?,
                    "driverCashGiven": row.get::<_, f64>(9)?,
                    "driverCashReturned": row.get::<_, f64>(10)?,
                    "unreconciledCount": row.get::<_, i64>(11)?,
                    "staffPaymentsTotal": row.get::<_, f64>(12)?,
                }))
            },
        )
        .ok();

    let cash_breakdown_rows: Vec<Value> = shifts
        .iter()
        .filter(|shift| matches!(shift.role_type.as_str(), "driver" | "server"))
        .map(|shift| {
            build_staff_cash_breakdown_row(
                &conn,
                &shift.id,
                shift.staff_name.as_deref(),
                &shift.role_type,
                shift.opening_cash,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;

    let driver_cash_breakdown: Vec<Value> = cash_breakdown_rows
        .iter()
        .filter(|row| row["roleType"].as_str() == Some("driver"))
        .cloned()
        .collect();
    let waiter_cash_breakdown: Vec<Value> = cash_breakdown_rows
        .iter()
        .filter(|row| row["roleType"].as_str() == Some("server"))
        .cloned()
        .collect();

    // --- Order type breakdown across all shifts in the period ---
    let order_type_scope_expr = business_day::order_financial_timestamp_expr("o");
    let order_type_scope_predicate = lower_bound_mode.sql_predicate(&order_type_scope_expr, "?1");
    let order_type_scope_sql = format!(
        "SELECT COALESCE(o.order_type, 'dine-in'), COUNT(*), COALESCE(SUM(o.total_amount), 0)
         FROM orders o
         WHERE {order_type_scope_predicate}
           AND (?2 IS NULL OR {order_type_scope_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled')
         GROUP BY COALESCE(o.order_type, 'dine-in')"
    );
    let mut ot_stmt = conn
        .prepare(&order_type_scope_sql)
        .map_err(|e| format!("prepare order_type query: {e}"))?;

    let mut dine_in_orders = 0_i64;
    let mut dine_in_sales = 0.0_f64;
    let mut takeaway_orders = 0_i64;
    let mut takeaway_sales = 0.0_f64;
    let mut delivery_orders = 0_i64;
    let mut delivery_sales = 0.0_f64;

    let ot_rows = ot_stmt
        .query_map(params![period_start, cutoff_param, branch_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| format!("query order_type: {e}"))?;

    for row in ot_rows.flatten() {
        let (otype, count, total) = row;
        match otype.as_str() {
            "dine-in" | "dine_in" => {
                dine_in_orders += count;
                dine_in_sales += total;
            }
            "takeaway" | "pickup" => {
                takeaway_orders += count;
                takeaway_sales += total;
            }
            "delivery" => {
                delivery_orders += count;
                delivery_sales += total;
            }
            _ => {
                dine_in_orders += count;
                dine_in_sales += total;
            }
        }
    }

    // --- Staff payments total across all shifts ---
    let staff_payments_total: f64 = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(amount), 0) FROM staff_payments
             WHERE {}
               AND (?2 IS NULL OR created_at <= ?2)",
                lower_bound_mode.sql_predicate("created_at", "?1")
            ),
            params![period_start, cutoff_param],
            |row| row.get(0),
        )
        .unwrap_or(0.0);
    let pending_expenses_count: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*)
             FROM shift_expenses
             WHERE {}
               AND (?2 IS NULL OR created_at <= ?2)
               AND status = 'pending'
               AND (expense_type IS NULL OR expense_type != 'staff_payment')",
                lower_bound_mode.sql_predicate("created_at", "?1")
            ),
            params![period_start, cutoff_param],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // --- Compute derived totals ---
    let net_sales = gross_sales - refunds_total - voids_total - discounts_total;

    // Sum opening/closing/variance across all cashier shifts
    let total_opening: f64 = shifts.iter().map(|s| s.opening_cash).sum();
    let total_closing: f64 = shifts.iter().map(|s| s.closing_cash.unwrap_or(0.0)).sum();
    let total_expected: f64 = shifts.iter().map(|s| s.expected_cash.unwrap_or(0.0)).sum();
    let total_variance: f64 = shifts.iter().map(|s| s.cash_variance.unwrap_or(0.0)).sum();

    if drawer_agg.is_none() {
        drawer_agg = Some(serde_json::json!({
            "totalVariance": total_variance,
            "openingTotal": total_opening,
            "closing": total_closing,
            "expected": total_expected,
            "totalCashDrops": 0.0,
            "driverCashGiven": 0.0,
            "driverCashReturned": 0.0,
            "unreconciledCount": 0,
            "staffPaymentsTotal": staff_payments_total,
        }));
    }

    if let Some(ref mut drawer) = drawer_agg {
        if let Some(obj) = drawer.as_object_mut() {
            obj.insert(
                "driverCashBreakdown".to_string(),
                Value::Array(driver_cash_breakdown.clone()),
            );
            obj.insert(
                "waiterCashBreakdown".to_string(),
                Value::Array(waiter_cash_breakdown.clone()),
            );
        }
    }

    let terminal_id = storage::get_credential("terminal_id").unwrap_or_default();
    let terminal_name = resolve_terminal_display_name(&conn, None);

    let payments_breakdown = serde_json::json!({
        "cash": { "count": cash_count, "total": cash_sales },
        "card": { "count": card_count, "total": card_sales },
        "other": { "count": other_count, "total": other_sales },
    });
    let sales_by_type = load_sales_by_type_for_period(
        &conn,
        branch_id.as_str(),
        &period_start,
        cutoff_param,
        lower_bound_mode,
    )?;
    let drawer_rows =
        load_drawer_rows_for_period(&conn, &period_start, cutoff_param, lower_bound_mode)?;
    let cash_breakdown_lookup = driver_cash_breakdown
        .iter()
        .chain(waiter_cash_breakdown.iter())
        .filter_map(|row| {
            row.get("driverShiftId")
                .and_then(Value::as_str)
                .map(|shift_id| (shift_id.to_string(), row.clone()))
        })
        .collect::<HashMap<_, _>>();

    // --- Build per-staff reports ---
    let staff_reports: Vec<Value> = shifts
        .iter()
        .map(|shift| build_staff_report(&conn, shift, &cash_breakdown_lookup))
        .collect::<Result<Vec<_>, _>>()?;
    let driver_summary = build_driver_summary(
        &staff_reports,
        &load_driver_unsettled_counts_for_period(
            &conn,
            &period_start,
            cutoff_param,
            lower_bound_mode,
        )?,
    );

    // Build Electron-compatible report_json
    let report_json = serde_json::json!({
        "date": date,
        "periodStart": period_start,
        "periodEnd": period_end,
        "shifts": {
            "total": shifts_total,
            "cashier": shifts_cashier,
            "driver": shifts_driver,
            "kitchen": shifts_kitchen,
        },
        "sales": {
            "totalOrders": total_orders,
            "totalSales": gross_sales,
            "cashSales": cash_sales,
            "cardSales": card_sales,
            "dineInOrders": dine_in_orders,
            "dineInSales": dine_in_sales,
            "takeawayOrders": takeaway_orders,
            "takeawaySales": takeaway_sales,
            "deliveryOrders": delivery_orders,
            "deliverySales": delivery_sales,
            "byType": sales_by_type,
        },
        "cashDrawer": drawer_agg.as_ref().unwrap_or(&serde_json::json!({
            "totalVariance": total_variance,
            "openingTotal": total_opening,
        })),
        "expenses": {
            "total": expenses_total,
            "staffPaymentsTotal": staff_payments_total,
            "pendingCount": pending_expenses_count,
            "items": expense_items,
        },
        "driverEarnings": driver_summary,
        "drawers": drawer_rows,
        "staffPayments": {
            "total": staff_payments_total,
        },
        "tips": {
            "total": tips_total,
        },
        "daySummary": {
            "cashTotal": cash_sales,
            "cardTotal": card_sales,
            "total": cash_sales + card_sales + other_sales,
            "totalOrders": total_orders,
        },
        "staffReports": staff_reports,
    });

    Ok(BuiltDateZReport {
        shift_id_for_db: shifts.first().map(|s| s.id.clone()),
        shift_count: shifts.len() as i64,
        branch_id,
        terminal_id,
        terminal_name,
        report_date: date,
        generated_at: Utc::now().to_rfc3339(),
        gross_sales,
        net_sales,
        total_orders,
        cash_sales,
        card_sales,
        refunds_total,
        voids_total,
        discounts_total,
        tips_total,
        expenses_total,
        total_variance,
        total_opening,
        total_closing,
        total_expected: shifts
            .iter()
            .map(|s| s.expected_cash.unwrap_or(0.0))
            .sum::<f64>(),
        payments_breakdown,
        report_json,
    })
}

pub fn preview_z_report_for_date(db: &DbState, payload: &Value) -> Result<Value, String> {
    let built = build_z_report_for_date(db, payload)?;
    if built.shift_count == 0 {
        info!("No closed shifts in period — returning preview-only Z-report");
    }
    Ok(preview_response_from_built_date_z_report(&built, true))
}

pub fn generate_z_report_for_date(db: &DbState, payload: &Value) -> Result<Value, String> {
    let built = build_z_report_for_date(db, payload)?;
    if built.shift_count == 0 {
        info!("No closed shifts in period — returning preview-only Z-report");
        return Ok(preview_response_from_built_date_z_report(&built, true));
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let period_start = str_field(&built.report_json, "periodStart")
        .ok_or("Missing reportJson.periodStart for Z-report persistence")?;
    let period_end = str_field(&built.report_json, "periodEnd")
        .ok_or("Missing reportJson.periodEnd for Z-report persistence")?;
    let sync_payload = serde_json::json!({
        "terminal_id": built.terminal_id,
        "branch_id": built.branch_id,
        "report_date": built.report_date,
        "report_data": built.report_json,
    })
    .to_string();

    let matching_ids = load_matching_local_z_report_ids_for_window(
        &conn,
        built.branch_id.as_str(),
        built.report_date.as_str(),
        period_start.as_str(),
        period_end.as_str(),
    )?;

    if let Some(existing_id) = matching_ids.first() {
        let existing_id = existing_id.clone();
        ensure_z_report_sync_queue_row(&conn, &existing_id, &sync_payload, &built.generated_at)?;
        let _ = prune_duplicate_local_z_reports_for_window(
            &conn,
            built.branch_id.as_str(),
            built.report_date.as_str(),
            period_start.as_str(),
            period_end.as_str(),
            existing_id.as_str(),
        )?;

        return get_z_report_by_id(&conn, &existing_id).map(|mut report| {
            if let Some(obj) = report.as_object_mut() {
                if let Some(terminal_name) = built.terminal_name.clone() {
                    obj.entry("terminalName".to_string())
                        .or_insert(serde_json::Value::String(terminal_name));
                }
                obj.entry("shiftCount".to_string())
                    .or_insert(serde_json::json!(built.shift_count));
            }

            serde_json::json!({
                "success": true,
                "existing": true,
                "zReportId": existing_id,
                "report": report,
            })
        });
    }

    let z_report_id = Uuid::new_v4().to_string();
    let payments_json_str = built.payments_breakdown.to_string();
    let report_json_str = built.report_json.to_string();
    let shift_id_for_db = built
        .shift_id_for_db
        .clone()
        .ok_or("Missing shiftId for persisted multi-shift Z-report")?;

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        conn.execute(
            "INSERT INTO z_reports (
                id, shift_id, branch_id, terminal_id, report_date, generated_at,
                gross_sales, net_sales, total_orders, cash_sales, card_sales,
                refunds_total, voids_total, discounts_total, tips_total,
                expenses_total, cash_variance, opening_cash, closing_cash, expected_cash,
                payments_breakdown_json, report_json,
                sync_state, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11,
                ?12, ?13, ?14, ?15,
                ?16, ?17, ?18, ?19, ?20,
                ?21, ?22,
                'pending', ?23, ?23
             )",
            params![
                z_report_id,
                shift_id_for_db,
                built.branch_id,
                built.terminal_id,
                built.report_date,
                built.generated_at,
                built.gross_sales,
                built.net_sales,
                built.total_orders,
                built.cash_sales,
                built.card_sales,
                built.refunds_total,
                built.voids_total,
                built.discounts_total,
                built.tips_total,
                built.expenses_total,
                built.total_variance,
                built.total_opening,
                built.total_closing,
                built.total_expected,
                payments_json_str,
                report_json_str,
                built.generated_at,
            ],
        )
        .map_err(|e| format!("insert z_report: {e}"))?;

        ensure_z_report_sync_queue_row(&conn, &z_report_id, &sync_payload, &built.generated_at)?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
    }

    info!(
        z_report_id = %z_report_id,
        shifts_count = %built.shift_count,
        gross_sales = %built.gross_sales,
        net_sales = %built.net_sales,
        "Multi-shift Z-report generated"
    );

    Ok(serde_json::json!({
        "success": true,
        "existing": false,
        "zReportId": z_report_id,
        "report": {
            "id": z_report_id,
            "shiftId": shift_id_for_db,
            "shiftCount": built.shift_count,
            "branchId": built.branch_id,
            "terminalId": built.terminal_id,
            "terminalName": built.terminal_name,
            "reportDate": built.report_date,
            "generatedAt": built.generated_at,
            "grossSales": built.gross_sales,
            "netSales": built.net_sales,
            "totalOrders": built.total_orders,
            "cashSales": built.cash_sales,
            "cardSales": built.card_sales,
            "refundsTotal": built.refunds_total,
            "voidsTotal": built.voids_total,
            "discountsTotal": built.discounts_total,
            "tipsTotal": built.tips_total,
            "expensesTotal": built.expenses_total,
            "cashVariance": built.total_variance,
            "openingCash": built.total_opening,
            "closingCash": built.total_closing,
            "paymentsBreakdown": built.payments_breakdown,
            "reportJson": built.report_json,
            "syncState": "pending",
        },
    }))
}

// ---------------------------------------------------------------------------
// Submit Z-report + finalize end-of-day (Gap 8)
// ---------------------------------------------------------------------------

pub(crate) fn prepare_z_report_submission(
    db: &DbState,
    payload: &Value,
) -> Result<PreparedZReportSubmission, String> {
    let branch_id = str_field(payload, "branchId")
        .or_else(|| str_field(payload, "branch_id"))
        .unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default());
    let window = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let _ = order_ownership::repair_historical_pickup_financial_attribution(
            &conn,
            branch_id.as_str(),
            &Utc::now().to_rfc3339(),
        )?;
        resolve_effective_z_report_window(&conn, &branch_id, payload)
    };
    let cutoff_param = window.cutoff_at.as_deref();

    // --- Pre-condition: all staff must be checked out ---
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, COALESCE(staff_name, staff_id) as name
                 FROM staff_shifts
                 WHERE status = 'active'
                   AND (branch_id = ?1 OR branch_id IS NULL)
                   AND (?2 IS NULL OR check_in_time <= ?2)",
            )
            .map_err(|e| format!("prepare active-shift check: {e}"))?;

        let active_names: Vec<String> = stmt
            .query_map(params![branch_id, cutoff_param], |row| {
                row.get::<_, String>(1)
            })
            .map_err(|e| format!("query active shifts: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        if !active_names.is_empty() {
            return Err(format!(
                "Cannot generate Z-report: {} staff still checked in: {}",
                active_names.len(),
                active_names.join(", ")
            ));
        }
    }

    // --- Pre-condition: all orders must have settled payments ---
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let unpaid_financial_expr = business_day::order_financial_timestamp_expr("o");
        let unpaid_lower_bound = window
            .lower_bound_mode
            .sql_predicate(&unpaid_financial_expr, "?1");
        let unpaid_sql = format!(
            "WITH blocking_orders AS (
                SELECT
                    COALESCE((
                        SELECT SUM(op_settled.amount)
                        FROM order_payments op_settled
                        WHERE op_settled.order_id = o.id
                          AND op_settled.status = 'completed'
                    ), 0) AS settled_amount,
                    LOWER(COALESCE(o.payment_status, '')) AS payment_status,
                    LOWER(COALESCE(o.payment_method, '')) AS payment_method,
                    COALESCE(o.total_amount, 0) AS total_amount
                FROM orders o
                WHERE {unpaid_lower_bound}
                  AND (?2 IS NULL OR {unpaid_financial_expr} <= ?2)
                  AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
                  AND COALESCE(o.is_ghost, 0) = 0
                  AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
                  AND COALESCE((
                        SELECT SUM(op_settled.amount)
                        FROM order_payments op_settled
                        WHERE op_settled.order_id = o.id
                          AND op_settled.status = 'completed'
                  ), 0) + 0.009 < COALESCE(o.total_amount, 0)
            )
            SELECT
                COUNT(*),
                COALESCE(SUM(CASE
                    WHEN settled_amount = 0
                     AND payment_status = 'paid'
                     AND payment_method IN ('cash', 'card')
                    THEN 1 ELSE 0
                END), 0)
            FROM blocking_orders"
        );
        let (unpaid_count, missing_local_payment_rows): (i64, i64) = conn
            .query_row(
                &unpaid_sql,
                params![window.period_start_at, cutoff_param, branch_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((0, 0));

        if unpaid_count > 0 {
            let genuinely_unsettled = unpaid_count.saturating_sub(missing_local_payment_rows);
            let message = if missing_local_payment_rows > 0 && genuinely_unsettled > 0 {
                format!(
                    "Cannot generate Z-report: {unpaid_count} order(s) are blocked ({missing_local_payment_rows} missing local payment row(s), {genuinely_unsettled} genuinely unpaid/partial)"
                )
            } else if missing_local_payment_rows > 0 {
                format!(
                    "Cannot generate Z-report: {unpaid_count} order(s) are marked paid but missing local payment rows"
                )
            } else {
                format!(
                    "Cannot generate Z-report: {unpaid_count} order(s) have genuinely unsettled payments"
                )
            };
            return Err(message);
        }
    }

    // Step 1: Generate the report (multi-shift or single-shift)
    let has_shift_id = str_field(payload, "shiftId")
        .or_else(|| str_field(payload, "shift_id"))
        .is_some();
    let has_branch_date =
        str_field(payload, "branchId").is_some() || str_field(payload, "date").is_some();

    let generated = if has_shift_id && !has_branch_date {
        generate_z_report(db, payload)?
    } else {
        generate_z_report_for_date(db, payload)?
    };

    let z_report_id = extract_z_report_id(&generated);
    let created_new_z_report = z_report_id.is_some() && !z_report_result_is_existing(&generated);

    let rollover_timestamp = window
        .cutoff_at
        .clone()
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    info!(
        timestamp = %rollover_timestamp,
        z_report_id = ?z_report_id,
        "Starting local Z-report day rollover"
    );

    Ok(PreparedZReportSubmission {
        generated,
        z_report_id,
        created_new_z_report,
        report_date: window.report_date,
        rollover_timestamp,
    })
}

pub(crate) fn finalize_prepared_z_report_submission(
    db: &DbState,
    prepared: &PreparedZReportSubmission,
) -> Result<Value, String> {
    // Step 2: Atomically advance the business-day cutoff, reset counters, and
    // clear the local operational day tables.
    let cleanup = match apply_local_day_rollover(
        db,
        &prepared.report_date,
        &prepared.rollover_timestamp,
    ) {
        Ok(cleanup) => cleanup,
        Err(error) => {
            if prepared.created_new_z_report {
                if let Some(ref generated_id) = prepared.z_report_id {
                    match db.conn.lock() {
                        Ok(conn) => {
                            if let Err(discard_error) =
                                discard_generated_z_report(&conn, generated_id)
                            {
                                error!(
                                    z_report_id = %generated_id,
                                    discard_error = %discard_error,
                                    "Failed to discard generated Z-report after local rollover failure"
                                );
                            }
                        }
                        Err(lock_error) => {
                            error!(
                                z_report_id = %generated_id,
                                lock_error = %lock_error,
                                "Failed to lock DB for Z-report discard after local rollover failure"
                            );
                        }
                    }
                }
            }

            return Err(error);
        }
    };

    let sync_state = if let Some(ref generated_id) = prepared.z_report_id {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        current_z_report_sync_state(&conn, generated_id)
    } else {
        None
    };

    Ok(serde_json::json!({
        "success": true,
        "data": prepared.generated.clone(),
        "cleanup": cleanup,
        "lastZReportTimestamp": prepared.rollover_timestamp,
        "zReportId": prepared.z_report_id.clone(),
        "localDayClosed": true,
        "syncQueued": prepared.z_report_id.is_some(),
        "syncState": sync_state,
    }))
}

/// Submit a Z-report: generate (or return existing), perform the local
/// business-day rollover, and return the local close result plus queued
/// sync state for the admin submission.
#[cfg_attr(not(test), allow(dead_code))]
pub fn submit_z_report(db: &DbState, payload: &Value) -> Result<Value, String> {
    let prepared = prepare_z_report_submission(db, payload)?;
    finalize_prepared_z_report_submission(db, &prepared)
}

/// Finalize end-of-day: clear ALL operational data up to and including the
/// report date. Preserves z_reports, local_settings, menu_cache, and
/// printer_profiles.
///
/// Deletes in FK-safe order within a transaction.
/// Returns a JSON object with per-table deletion counts.
fn finalize_end_of_day_counts(conn: &Connection, cutoff_at: &str) -> Result<Value, String> {
    fn safe_delete(conn: &Connection, table: &str, sql: &str, cutoff_at: Option<&str>) -> i64 {
        let execution = if sql.contains("?1") {
            conn.execute(sql, params![cutoff_at.unwrap_or_default()])
        } else {
            conn.execute(sql, [])
        };

        match execution {
            Ok(count) => count as i64,
            Err(e) => {
                // Some tables may not exist yet in older local schemas.
                warn!(table = %table, error = %e, "Cleanup: table delete failed (may not exist)");
                0
            }
        }
    }

    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let target_order_ids_sql = format!(
        "SELECT o.id
         FROM orders o
         WHERE datetime({financial_expr}) <= datetime(?1)"
    );

    let target_order_ids: Vec<String> = conn
        .prepare(&target_order_ids_sql)
        .map_err(|e| format!("prepare cleanup order selector: {e}"))?
        .query_map(params![cutoff_at], |row| row.get::<_, String>(0))
        .map_err(|e| format!("query cleanup order selector: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect cleanup order selector: {e}"))?;

    let rollover_protection = collect_rollover_protection(conn)?;

    conn.execute_batch(
        "DROP TABLE IF EXISTS temp_z_report_order_ids;
         CREATE TEMP TABLE temp_z_report_order_ids (
             id TEXT PRIMARY KEY
         );",
    )
    .map_err(|e| format!("prepare cleanup temp table: {e}"))?;

    for order_id in &target_order_ids {
        conn.execute(
            "INSERT OR IGNORE INTO temp_z_report_order_ids (id) VALUES (?1)",
            params![order_id],
        )
        .map_err(|e| format!("stage cleanup order id: {e}"))?;
    }

    stage_rollover_protection(conn, &rollover_protection)?;

    let mut cleared = serde_json::Map::new();

    // 1. payment_adjustments linked to orders inside the closed business window.
    let c = safe_delete(
        conn,
        "payment_adjustments",
        "DELETE FROM payment_adjustments
         WHERE order_id IN (SELECT id FROM temp_z_report_order_ids)",
        None,
    );
    cleared.insert("payment_adjustments".into(), serde_json::json!(c));

    // 2. order_payments linked to the same closed orders.
    let c = safe_delete(
        conn,
        "order_payments",
        "DELETE FROM order_payments
         WHERE order_id IN (SELECT id FROM temp_z_report_order_ids)",
        None,
    );
    cleared.insert("order_payments".into(), serde_json::json!(c));

    // 3. driver_earnings linked to the closed orders.
    let c = safe_delete(
        conn,
        "driver_earnings",
        "DELETE FROM driver_earnings
         WHERE order_id IN (SELECT id FROM temp_z_report_order_ids)",
        None,
    );
    cleared.insert("driver_earnings".into(), serde_json::json!(c));

    // 4. sync_queue -- only clear synced items that were already materialized before the cutoff.
    let c = safe_delete(
        conn,
        "sync_queue",
        "DELETE FROM sync_queue
         WHERE status = 'synced'
           AND datetime(created_at) <= datetime(?1)",
        Some(cutoff_at),
    );
    cleared.insert("sync_queue".into(), serde_json::json!(c));

    // 5. shift_expenses by their own operational timestamp.
    let c = safe_delete(
        conn,
        "shift_expenses",
        "DELETE FROM shift_expenses
         WHERE datetime(created_at) <= datetime(?1)
           AND id NOT IN (SELECT id FROM temp_rollover_protected_shift_expense_ids)",
        Some(cutoff_at),
    );
    cleared.insert("shift_expenses".into(), serde_json::json!(c));

    // 6. staff_payments by their own operational timestamp.
    let c = safe_delete(
        conn,
        "staff_payments",
        "DELETE FROM staff_payments
         WHERE datetime(created_at) <= datetime(?1)
           AND id NOT IN (SELECT id FROM temp_rollover_protected_staff_payment_ids)",
        Some(cutoff_at),
    );
    cleared.insert("staff_payments".into(), serde_json::json!(c));

    // 7. print_jobs (standalone operational artifacts).
    let c = safe_delete(
        conn,
        "print_jobs",
        "DELETE FROM print_jobs
         WHERE datetime(created_at) <= datetime(?1)",
        Some(cutoff_at),
    );
    cleared.insert("print_jobs".into(), serde_json::json!(c));

    // 8. cash_drawer_sessions by close/open timestamp.
    let c = safe_delete(
        conn,
        "cash_drawer_sessions",
        "DELETE FROM cash_drawer_sessions
         WHERE datetime(COALESCE(closed_at, opened_at, created_at)) <= datetime(?1)
           AND staff_shift_id NOT IN (SELECT id FROM temp_rollover_protected_shift_ids)",
        Some(cutoff_at),
    );
    cleared.insert("cash_drawer_sessions".into(), serde_json::json!(c));

    // 9. staff_shifts by close/check-in timestamp.
    let c = safe_delete(
        conn,
        "staff_shifts",
        "DELETE FROM staff_shifts
         WHERE datetime(COALESCE(check_out_time, check_in_time, created_at)) <= datetime(?1)
           AND id NOT IN (SELECT id FROM temp_rollover_protected_shift_ids)",
        Some(cutoff_at),
    );
    cleared.insert("staff_shifts".into(), serde_json::json!(c));

    // 10. orders in the closed business window. Payments/adjustments were already removed above.
    let c = safe_delete(
        conn,
        "orders",
        "DELETE FROM orders
         WHERE id IN (SELECT id FROM temp_z_report_order_ids)",
        None,
    );
    cleared.insert("orders".into(), serde_json::json!(c));

    conn.execute_batch(
        "DROP TABLE IF EXISTS temp_z_report_order_ids;
         DROP TABLE IF EXISTS temp_rollover_protected_shift_ids;
         DROP TABLE IF EXISTS temp_rollover_protected_shift_expense_ids;
         DROP TABLE IF EXISTS temp_rollover_protected_staff_payment_ids;",
    )
    .map_err(|e| format!("cleanup temp tables: {e}"))?;

    Ok(Value::Object(cleared))
}

fn apply_local_day_rollover(
    db: &DbState,
    report_date: &str,
    rollover_timestamp: &str,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    info!(
        report_date = %report_date,
        timestamp = %rollover_timestamp,
        "Applying local Z-report day rollover"
    );

    conn.execute_batch("PRAGMA foreign_keys = OFF")
        .map_err(|e| format!("disable FK for local rollover: {e}"))?;
    if let Err(e) = conn.execute_batch("BEGIN IMMEDIATE") {
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON");
        return Err(format!("begin local rollover transaction: {e}"));
    }

    let result = (|| -> Result<Value, String> {
        db::set_setting(
            &conn,
            "system",
            "last_z_report_timestamp",
            rollover_timestamp,
        )?;
        db::set_setting(&conn, "sync", "orders_since", rollover_timestamp)?;
        clear_pending_z_report_context(&conn)?;

        conn.execute(
            "INSERT INTO local_settings (setting_category, setting_key, setting_value, updated_at) \
             VALUES ('orders', 'order_counter', '0', datetime('now')) \
             ON CONFLICT(setting_category, setting_key) DO UPDATE SET \
                setting_value = '0', updated_at = datetime('now')",
            [],
        )
        .map_err(|e| format!("reset order counter: {e}"))?;

        info!("Order counter reset to 0 after Z-report");

        finalize_end_of_day_counts(&conn, rollover_timestamp)
    })();

    match result {
        Ok(counts) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit local rollover: {e}"))?;
            let _ = conn.execute_batch("PRAGMA foreign_keys = ON");
            info!(report_date = %report_date, "Local Z-report day rollover complete: {}", counts);
            Ok(counts)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            let _ = conn.execute_batch("PRAGMA foreign_keys = ON");
            error!(error = %e, "Local Z-report day rollover failed, rolled back");
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// Z-report HTML generation (used by print worker)
// ---------------------------------------------------------------------------

/// Generate a printable HTML file for a z_report.
///
/// Called by the print worker when processing a `z_report` print job.
/// Returns the absolute file path to the generated HTML.
#[allow(dead_code)]
pub fn generate_z_report_file(
    db: &DbState,
    z_report_id: &str,
    data_dir: &std::path::Path,
) -> Result<String, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Fetch the z_report
    let report = conn
        .query_row(
            "SELECT id, shift_id, terminal_id, report_date, generated_at,
                    gross_sales, net_sales, total_orders, cash_sales, card_sales,
                    refunds_total, voids_total, discounts_total, tips_total,
                    expenses_total, cash_variance, opening_cash, closing_cash,
                    expected_cash, payments_breakdown_json, report_json
             FROM z_reports WHERE id = ?1",
            params![z_report_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,  // id
                    row.get::<_, String>(1)?,  // shift_id
                    row.get::<_, String>(2)?,  // terminal_id
                    row.get::<_, String>(3)?,  // report_date
                    row.get::<_, String>(4)?,  // generated_at
                    row.get::<_, f64>(5)?,     // gross_sales
                    row.get::<_, f64>(6)?,     // net_sales
                    row.get::<_, i64>(7)?,     // total_orders
                    row.get::<_, f64>(8)?,     // cash_sales
                    row.get::<_, f64>(9)?,     // card_sales
                    row.get::<_, f64>(10)?,    // refunds_total
                    row.get::<_, f64>(11)?,    // voids_total
                    row.get::<_, f64>(12)?,    // discounts_total
                    row.get::<_, f64>(13)?,    // tips_total
                    row.get::<_, f64>(14)?,    // expenses_total
                    row.get::<_, f64>(15)?,    // cash_variance
                    row.get::<_, f64>(16)?,    // opening_cash
                    row.get::<_, f64>(17)?,    // closing_cash
                    row.get::<_, f64>(18)?,    // expected_cash
                    row.get::<_, String>(19)?, // payments_breakdown_json
                    row.get::<_, String>(20)?, // report_json
                ))
            },
        )
        .map_err(|_| format!("Z-report not found: {z_report_id}"))?;

    let (
        id,
        shift_id,
        _terminal_id,
        report_date,
        generated_at,
        gross_sales,
        net_sales,
        total_orders,
        cash_sales,
        card_sales,
        refunds_total,
        voids_total,
        discounts_total,
        tips_total,
        expenses_total,
        cash_variance,
        opening_cash,
        closing_cash,
        expected_cash,
        payments_breakdown_str,
        report_json_str,
    ) = report;

    // Store settings for header
    let store_name =
        db::get_setting(&conn, "terminal", "store_name").unwrap_or_else(|| "The Small".to_string());
    let store_address = db::get_setting(&conn, "terminal", "store_address").unwrap_or_default();
    let store_phone = db::get_setting(&conn, "terminal", "store_phone").unwrap_or_default();
    let terminal_display_name = resolve_terminal_display_name(&conn, None).unwrap_or_default();

    // Staff name from shift
    let staff_name: String = conn
        .query_row(
            "SELECT COALESCE(staff_name, staff_id) FROM staff_shifts WHERE id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "N/A".to_string());

    // Parse payments breakdown for display
    let _breakdown: Value =
        serde_json::from_str(&payments_breakdown_str).unwrap_or(serde_json::json!({}));
    let report_json: Value = serde_json::from_str(&report_json_str).unwrap_or_default();
    let shift_count = report_json
        .pointer("/shifts/total")
        .and_then(Value::as_i64)
        .filter(|count| *count > 1);
    let shift_line = if let Some(count) = shift_count {
        format!("Shifts: {count}<br/>")
    } else if !shift_id.trim().is_empty() {
        format!("Shift: {}<br/>", shift_id)
    } else {
        String::new()
    };
    let terminal_line = if terminal_display_name.is_empty() {
        String::new()
    } else {
        format!("Terminal: {}<br/>", terminal_display_name)
    };

    // Build address/phone lines
    let address_line = if store_address.is_empty() {
        String::new()
    } else {
        format!("{store_address}<br/>")
    };
    let phone_line = if store_phone.is_empty() {
        String::new()
    } else {
        format!("Tel: {store_phone}<br/>")
    };

    // Variance styling
    let variance_style = if cash_variance.abs() > 0.01 {
        "color:#c00;font-weight:bold;"
    } else {
        ""
    };

    let html = format!(
        r#"<div style="font-family:monospace;font-size:10px;line-height:1.4;width:100%;">
<div style="text-align:center;margin-bottom:8px;">
<strong style="font-size:14px;">{store_name}</strong><br/>
{address_line}{phone_line}</div>
<hr style="border:none;border-top:2px solid #000;"/>
<div style="text-align:center;font-size:14px;font-weight:bold;margin:8px 0;">
Z - R E P O R T</div>
<hr style="border:none;border-top:2px solid #000;"/>
<div style="margin:4px 0;">
{shift_line}Staff: {staff_name}<br/>
Date: {report_date}<br/>
Generated: {generated_at}
</div>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;"><strong>SALES SUMMARY</strong></div>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Total Orders</td><td style="text-align:right;">{total_orders}</td></tr>
<tr><td>Gross Sales</td><td style="text-align:right;">{gross_sales:.2}</td></tr>
<tr><td>Discounts</td><td style="text-align:right;">-{discounts_total:.2}</td></tr>
<tr><td><strong>Net Sales</strong></td><td style="text-align:right;"><strong>{net_sales:.2}</strong></td></tr>
</table>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;"><strong>PAYMENT BREAKDOWN</strong></div>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Cash</td><td style="text-align:right;">{cash_sales:.2}</td></tr>
<tr><td>Card</td><td style="text-align:right;">{card_sales:.2}</td></tr>
</table>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;"><strong>ADJUSTMENTS</strong></div>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Refunds</td><td style="text-align:right;color:#c00;">-{refunds_total:.2}</td></tr>
<tr><td>Voids</td><td style="text-align:right;color:#c00;">-{voids_total:.2}</td></tr>
</table>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;"><strong>EXPENSES</strong></div>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Total</td><td style="text-align:right;">-{expenses_total:.2}</td></tr>
</table>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;"><strong>CASH DRAWER</strong></div>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Opening</td><td style="text-align:right;">{opening_cash:.2}</td></tr>
<tr><td>Expected</td><td style="text-align:right;">{expected_cash:.2}</td></tr>
<tr><td>Actual</td><td style="text-align:right;">{closing_cash:.2}</td></tr>
<tr><td><strong>Variance</strong></td><td style="text-align:right;{variance_style}"><strong>{cash_variance:.2}</strong></td></tr>
</table>
<hr style="border:none;border-top:1px dashed #000;"/>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Tips Total</td><td style="text-align:right;">{tips_total:.2}</td></tr>
</table>
<hr style="border:none;border-top:2px solid #000;"/>
<div style="text-align:center;margin-top:8px;font-size:9px;">
End of Report<br/>
{terminal_line}
ID: {id}
</div>
</div>"#,
    );

    // Wrap in standalone HTML document (same as generate_receipt_file)
    let full_html = format!(
        r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>Z-Report {report_date}</title>
<style>
body {{ margin: 8px; padding: 0; }}
@media print {{ body {{ margin: 0; }} }}
</style></head><body>{html}</body></html>"#,
    );

    // Ensure receipts directory exists
    let receipts_dir = data_dir.join("receipts");
    std::fs::create_dir_all(&receipts_dir).map_err(|e| format!("create receipts dir: {e}"))?;

    let ts = Utc::now().timestamp_millis();
    let filename = format!("zreport_{id}_{ts}.html");
    let file_path = receipts_dir.join(&filename);

    std::fs::write(&file_path, full_html).map_err(|e| format!("write z-report file: {e}"))?;

    let abs_path = file_path
        .to_str()
        .ok_or("Invalid path encoding")?
        .to_string();

    info!(z_report_id = %z_report_id, path = %abs_path, "Z-report HTML generated");
    Ok(abs_path)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Fetch a z_report row by ID and return as JSON Value.
fn get_z_report_by_id(conn: &rusqlite::Connection, z_report_id: &str) -> Result<Value, String> {
    conn.query_row(
        "SELECT * FROM z_reports WHERE id = ?1",
        params![z_report_id],
        map_z_report_row,
    )
    .map_err(|_| format!("Z-report not found: {z_report_id}"))
}

/// Map a z_reports row to a JSON value.
fn map_z_report_row(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "shiftId": row.get::<_, String>(1)?,
        "branchId": row.get::<_, String>(2)?,
        "terminalId": row.get::<_, String>(3)?,
        "reportDate": row.get::<_, String>(4)?,
        "generatedAt": row.get::<_, String>(5)?,
        "grossSales": row.get::<_, f64>(6)?,
        "netSales": row.get::<_, f64>(7)?,
        "totalOrders": row.get::<_, i64>(8)?,
        "cashSales": row.get::<_, f64>(9)?,
        "cardSales": row.get::<_, f64>(10)?,
        "refundsTotal": row.get::<_, f64>(11)?,
        "voidsTotal": row.get::<_, f64>(12)?,
        "discountsTotal": row.get::<_, f64>(13)?,
        "tipsTotal": row.get::<_, f64>(14)?,
        "expensesTotal": row.get::<_, f64>(15)?,
        "cashVariance": row.get::<_, f64>(16)?,
        "openingCash": row.get::<_, f64>(17)?,
        "closingCash": row.get::<_, f64>(18)?,
        "expectedCash": row.get::<_, f64>(19)?,
        "paymentsBreakdown": row.get::<_, String>(20)?,
        "reportJson": row.get::<_, String>(21)?,
        "syncState": row.get::<_, String>(22)?,
        "syncLastError": row.get::<_, Option<String>>(23)?,
        "syncRetryCount": row.get::<_, i64>(24)?,
        "syncNextRetryAt": row.get::<_, Option<String>>(25)?,
        "createdAt": row.get::<_, String>(26)?,
        "updatedAt": row.get::<_, String>(27)?,
    }))
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

#[allow(dead_code)]
fn num_field(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use chrono::TimeZone;
    use rusqlite::Connection;

    fn test_db() -> DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("set pragmas");
        db::run_migrations_for_test(&conn);
        DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    /// Insert a closed shift with associated data for testing.
    fn seed_closed_shift(db: &DbState) -> String {
        let conn = db.conn.lock().unwrap();
        let shift_id = "shift-zr-1";
        let now = "2026-02-16T18:00:00Z";

        // Insert shift
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'staff-1', 'John', 'branch-1', 'term-1', 'cashier',
                200.0, 235.0, 235.0, 0.0,
                '2026-02-16T09:00:00Z', ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![shift_id, now],
        )
        .expect("insert shift");

        // Insert cash drawer session
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, closing_amount, expected_amount, variance_amount,
                total_cash_sales, total_card_sales, total_refunds, total_expenses,
                cash_drops, driver_cash_given, driver_cash_returned,
                total_staff_payments, reconciled,
                opened_at, created_at, updated_at
             ) VALUES (
                'cds-1', ?1, 'staff-1', 'branch-1', 'term-1',
                200.0, 235.0, 235.0, 0.0,
                60.0, 40.0, 10.0, 15.0,
                0.0, 0.0, 0.0,
                0.0, 0,
                '2026-02-16T09:00:00Z', ?2, ?2
             )",
            params![shift_id, now],
        )
        .expect("insert drawer");

        // Insert 3 orders
        for (i, total) in [(1, 25.0), (2, 35.0), (3, 40.0)] {
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, status, order_type,
                    payment_status, staff_shift_id, discount_amount, tip_amount,
                    sync_status, created_at, updated_at
                 ) VALUES (?1, ?2, '[]', ?3, 'completed', 'dine-in',
                    'paid', ?4, 0.0, 0.0, 'pending', ?5, ?5)",
                params![format!("ord-{i}"), format!("#{i}"), total, shift_id, now,],
            )
            .expect("insert order");
        }

        // Insert payments: cash for orders 1+2, card for order 3
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-1', 'ord-1', 'cash', 25.0, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 1");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-2', 'ord-2', 'cash', 35.0, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 2");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-3', 'ord-3', 'card', 40.0, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 3");

        // Insert a refund adjustment on payment 1
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-1', 'pay-1', 'ord-1', 'refund', 10.0, 'wrong item', 'pending', ?1, ?1)",
            params![now],
        ).expect("insert adjustment");

        // Insert an expense
        conn.execute(
            "INSERT INTO shift_expenses (id, staff_shift_id, staff_id, branch_id, expense_type, amount, description, sync_status, created_at, updated_at)
             VALUES ('exp-1', ?1, 'staff-1', 'branch-1', 'supplies', 15.0, 'Napkins', 'pending', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert expense");

        shift_id.to_string()
    }

    #[test]
    fn test_generate_z_report_basic() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        let payload = serde_json::json!({ "shiftId": shift_id });
        let result = generate_z_report(&db, &payload).expect("generate should succeed");

        assert_eq!(result["success"], true);
        assert_eq!(result["existing"], false);

        let report = &result["report"];
        assert_eq!(report["grossSales"], 100.0);
        assert_eq!(report["cashSales"], 60.0);
        assert_eq!(report["cardSales"], 40.0);
        assert_eq!(report["refundsTotal"], 10.0);
        assert_eq!(report["voidsTotal"], 0.0);
        assert_eq!(report["expensesTotal"], 15.0);
        assert_eq!(report["totalOrders"], 3);
        // net_sales = 100 - 10 - 0 - 0 = 90
        assert_eq!(report["netSales"], 90.0);
        assert_eq!(report["cashVariance"], 0.0);
        assert_eq!(report["openingCash"], 200.0);
        assert_eq!(report["closingCash"], 235.0);
        assert_eq!(report["reportDate"], "2026-02-16");
        assert_eq!(report["syncState"], "pending");

        let report_json = report["reportJson"].as_object().expect("reportJson object");
        assert_eq!(report_json["periodStart"], "2026-02-16T09:00:00Z");
        assert_eq!(report_json["periodEnd"], "2026-02-16T18:00:00Z");
        assert_eq!(
            report_json["sales"]["byType"]["instore"]["cash"]["count"],
            2
        );
        assert_eq!(
            report_json["sales"]["byType"]["instore"]["card"]["total"],
            40.0
        );
        assert_eq!(report_json["expenses"]["staffPaymentsTotal"], 0.0);
        assert_eq!(report_json["expenses"]["pendingCount"], 1);
        assert_eq!(report_json["drawers"].as_array().unwrap().len(), 1);
        let staff_reports = report_json["staffReports"].as_array().unwrap();
        assert_eq!(staff_reports.len(), 1);
        assert_eq!(staff_reports[0]["orders"]["cashAmount"], 60.0);
        assert_eq!(staff_reports[0]["orders"]["cardAmount"], 40.0);
        assert_eq!(staff_reports[0]["returnedToDrawerAmount"], 235.0);

        // Verify z_reports table has 1 row
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        // Verify sync_queue has entry
        let sq_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'z_report'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_count, 1);
    }

    #[test]
    fn test_generate_z_report_prefers_stored_shift_report_date() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE staff_shifts
                 SET report_date = '2026-02-15',
                     period_start_at = '2026-02-15T16:00:00Z'
                 WHERE id = ?1",
                params![shift_id],
            )
            .expect("store business-day metadata");
        }

        let result = generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id }))
            .expect("generate should succeed");

        let report = &result["report"];
        assert_eq!(report["reportDate"], "2026-02-15");
        assert_eq!(report["reportJson"]["date"], "2026-02-15");
        assert_eq!(report["reportJson"]["periodStart"], "2026-02-16T09:00:00Z");
    }

    #[test]
    fn test_generate_z_report_idempotent() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        let payload = serde_json::json!({ "shiftId": shift_id });

        let result1 = generate_z_report(&db, &payload).expect("first generate");
        let result2 = generate_z_report(&db, &payload).expect("second generate");

        assert_eq!(result1["existing"], false);
        assert_eq!(result2["existing"], true);
        assert_eq!(result1["zReportId"], result2["zReportId"]);

        // Only 1 row in z_reports
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_generate_z_report_requires_closed_shift() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let now = "2026-02-16T18:00:00Z";

        // Insert an active (not closed) shift
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, branch_id, terminal_id, role_type,
                opening_cash_amount, check_in_time, status,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-active', 'staff-1', 'branch-1', 'term-1', 'cashier',
                200.0, ?1, 'active', 'pending', ?1, ?1
             )",
            params![now],
        )
        .expect("insert active shift");
        drop(conn);

        let payload = serde_json::json!({ "shiftId": "shift-active" });
        let result = generate_z_report(&db, &payload);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Shift must be closed"));
    }

    #[test]
    fn test_get_z_report() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        let gen_result =
            generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id })).unwrap();
        let z_report_id = gen_result["zReportId"].as_str().unwrap();

        let get_result =
            get_z_report(&db, &serde_json::json!({ "zReportId": z_report_id })).unwrap();

        assert_eq!(get_result["success"], true);
        assert_eq!(get_result["report"]["id"], z_report_id);
        assert_eq!(get_result["report"]["grossSales"], 100.0);
    }

    #[test]
    fn test_list_z_reports_by_shift() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id })).unwrap();

        let list_result = list_z_reports(&db, &serde_json::json!({ "shiftId": shift_id })).unwrap();

        assert_eq!(list_result["success"], true);
        assert_eq!(list_result["count"], 1);
        assert_eq!(list_result["reports"][0]["grossSales"], 100.0);
    }

    #[test]
    fn test_list_z_reports_by_date_range() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id })).unwrap();

        let list_result = list_z_reports(
            &db,
            &serde_json::json!({
                "startDate": "2026-02-01",
                "endDate": "2026-02-28",
            }),
        )
        .unwrap();

        assert_eq!(list_result["success"], true);
        assert_eq!(list_result["count"], 1);
    }

    // ---------------------------------------------------------------
    // Gap 9: Period filtering
    // ---------------------------------------------------------------

    #[test]
    fn test_period_start_defaults_to_epoch() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let period = get_period_start(&conn);
        assert_eq!(period, "1970-01-01T00:00:00Z");
    }

    #[test]
    fn test_period_start_reads_from_settings() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        db::set_setting(
            &conn,
            "system",
            "last_z_report_timestamp",
            "2026-02-16T22:00:00Z",
        )
        .expect("set timestamp");
        let period = get_period_start(&conn);
        assert_eq!(period, "2026-02-16T22:00:00Z");
    }

    // ---------------------------------------------------------------
    // Gap 7: Multi-shift aggregation
    // ---------------------------------------------------------------

    /// Insert a second closed shift with different data for multi-shift testing.
    fn seed_second_closed_shift(db: &DbState) {
        let conn = db.conn.lock().unwrap();
        let shift_id = "shift-zr-2";
        let now = "2026-02-16T22:00:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'staff-2', 'Jane', 'branch-1', 'term-1', 'cashier',
                300.0, 350.0, 350.0, 0.0,
                '2026-02-16T14:00:00Z', ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![shift_id, now],
        )
        .expect("insert shift 2");

        // 2 more orders for shift 2
        for (i, total) in [(4, 50.0), (5, 70.0)] {
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, status, order_type,
                    payment_status, staff_shift_id, discount_amount, tip_amount,
                    sync_status, created_at, updated_at
                 ) VALUES (?1, ?2, '[]', ?3, 'completed', 'dine-in',
                    'paid', ?4, 0.0, 0.0, 'pending', ?5, ?5)",
                params![format!("ord-{i}"), format!("#{i}"), total, shift_id, now],
            )
            .expect("insert order");
        }

        // Payments for shift 2: cash + card
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-4', 'ord-4', 'cash', 50.0, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 4");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-5', 'ord-5', 'card', 70.0, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 5");
    }

    fn seed_late_day_order(db: &DbState, created_at: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, status, order_type,
                payment_status, staff_shift_id, discount_amount, tip_amount,
                sync_status, created_at, updated_at
             ) VALUES (
                'ord-late', '#late', '[]', 80.0, 'completed', 'dine-in',
                'paid', 'shift-zr-1', 0.0, 0.0, 'pending', ?1, ?1
             )",
            params![created_at],
        )
        .expect("insert late order");
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at
             ) VALUES (
                'pay-late', 'ord-late', 'cash', 80.0, 'completed', 'shift-zr-1', 'EUR', ?1, ?1
             )",
            params![created_at],
        )
        .expect("insert late payment");
    }

    fn seed_next_day_active_shift(db: &DbState, check_in_time: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, check_in_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-next-day-active', 'staff-next', 'Next Day', 'branch-1', 'term-1', 'cashier',
                100.0, ?1, 'active', 2, 'pending', ?1, ?1
             )",
            params![check_in_time],
        )
        .expect("insert next day active shift");
    }

    fn seed_other_branch_unpaid_order(db: &DbState, created_at: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, status, order_type,
                payment_status, staff_shift_id, branch_id, discount_amount, tip_amount,
                sync_status, created_at, updated_at
             ) VALUES (
                'ord-other-branch-unpaid', '#other-branch', '[]', 22.0, 'completed', 'dine-in',
                'pending', 'shift-other-branch', 'branch-2', 0.0, 0.0, 'pending', ?1, ?1
             )",
            params![created_at],
        )
        .expect("insert other branch unpaid order");
    }

    fn seed_paid_order_with_stale_payment_status(db: &DbState, created_at: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, status, order_type,
                payment_status, payment_method, staff_shift_id, branch_id, discount_amount, tip_amount,
                sync_status, created_at, updated_at
             ) VALUES (
                'ord-stale-paid-status', '#stale-paid', '[]', 22.0, 'completed', 'pickup',
                'pending', 'cash', 'shift-zr-1', 'branch-1', 0.0, 0.0, 'pending', ?1, ?1
             )",
            params![created_at],
        )
        .expect("insert stale payment-status order");
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at
             ) VALUES (
                'pay-stale-paid-status', 'ord-stale-paid-status', 'cash', 22.0, 'completed',
                'shift-zr-1', 'EUR', ?1, ?1
             )",
            params![created_at],
        )
        .expect("insert settled payment for stale payment-status order");
    }

    fn seed_cashier_driver_zreport_day(db: &DbState) {
        let conn = db.conn.lock().unwrap();
        let cashier_shift_id = "cashier-zr-day";
        let driver_shift_id = "driver-zr-day";
        let now = "2026-03-06T19:05:40Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'cashier-11', 'Alexandra Evaggelou', 'branch-1', 'term-1', 'cashier',
                100.0, 130.0, 130.0, 0.0,
                '2026-03-06T12:10:16Z', ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![cashier_shift_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, closing_amount, expected_amount, variance_amount,
                total_cash_sales, total_card_sales, total_refunds, total_expenses,
                cash_drops, driver_cash_given, driver_cash_returned, total_staff_payments,
                reconciled, opened_at, created_at, updated_at
             ) VALUES (
                'drawer-zr-day', ?1, 'cashier-11', 'branch-1', 'term-1',
                100.0, 182.5, 182.5, 0.0,
                12.0, 18.0, 0.0, 0.0,
                0.0, 20.0, 52.5, 0.0,
                1, '2026-03-06T12:10:16Z', ?2, ?2
             )",
            params![cashier_shift_id, now],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'driver-11', 'Endrit Bashi', 'branch-1', 'term-1', 'driver',
                20.0, 52.5, 52.5, 0.0,
                '2026-03-06T14:07:42Z', ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![driver_shift_id, now],
        )
        .unwrap();

        for (order_id, total_amount, method) in [
            ("cashier-order-1", 12.0, "cash"),
            ("cashier-order-2", 18.0, "card"),
        ] {
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, status, order_type,
                    payment_status, payment_method, staff_shift_id, staff_id,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    ?1, ?1, '[]', ?2, 'completed', 'dine-in',
                    'paid', ?3, ?4, 'cashier-11',
                    'pending', '2026-03-06T15:00:00Z', '2026-03-06T15:00:00Z'
                 )",
                params![order_id, total_amount, method, cashier_shift_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 'completed', ?5, 'EUR', '2026-03-06T15:00:00Z', '2026-03-06T15:00:00Z')",
                params![format!("pay-{order_id}"), order_id, method, total_amount, cashier_shift_id],
            )
            .unwrap();
        }

        for (suffix, total_amount, cash_collected) in [("1", 13.0, 13.0), ("2", 19.5, 19.5)] {
            let order_id = format!("delivery-order-{suffix}");
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, status, order_type,
                    payment_status, payment_method, staff_shift_id, staff_id, driver_id,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    ?1, ?1, '[]', ?2, 'completed', 'delivery',
                    'paid', 'cash', ?3, 'cashier-11', 'driver-11',
                    'pending', '2026-03-06T16:00:00Z', '2026-03-06T16:00:00Z'
                 )",
                params![order_id, total_amount, cashier_shift_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at
                 ) VALUES (?1, ?2, 'cash', ?3, 'completed', ?4, 'EUR', '2026-03-06T16:00:00Z', '2026-03-06T16:00:00Z')",
                params![format!("pay-{order_id}"), order_id, total_amount, cashier_shift_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO driver_earnings (
                    id, driver_id, staff_shift_id, order_id, branch_id,
                    delivery_fee, tip_amount, total_earning, payment_method,
                    cash_collected, card_amount, cash_to_return, settled, created_at, updated_at
                 ) VALUES (
                    ?1, 'driver-11', ?2, ?3, 'branch-1',
                    2.5, 0.0, 2.5, 'cash',
                    ?4, 0.0, ?4, 0, '2026-03-06T16:00:00Z', '2026-03-06T16:00:00Z'
                 )",
                params![
                    format!("de-{suffix}"),
                    driver_shift_id,
                    order_id,
                    cash_collected
                ],
            )
            .unwrap();
        }
    }

    #[test]
    fn test_generate_z_report_for_date_multi_shift() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_second_closed_shift(&db);

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let result = generate_z_report_for_date(&db, &payload).expect("multi-shift generate");

        assert_eq!(result["success"], true);
        let report = &result["report"];

        // Combined: 3 orders from shift 1 + 2 orders from shift 2 = 5 orders
        assert_eq!(report["totalOrders"], 5);
        // Gross: 25+35+40 + 50+70 = 220
        assert_eq!(report["grossSales"], 220.0);
        // Cash: 25+35+50 = 110
        assert_eq!(report["cashSales"], 110.0);
        // Card: 40+70 = 110
        assert_eq!(report["cardSales"], 110.0);
        // Refunds: 10 (from shift 1 only)
        assert_eq!(report["refundsTotal"], 10.0);
        // Expenses: 15 (from shift 1 only)
        assert_eq!(report["expensesTotal"], 15.0);

        // Parse report_json to verify staffReports has 2 entries
        let report_json_str = report["reportJson"].as_object().unwrap();
        let staff_reports = report_json_str
            .get("staffReports")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(staff_reports.len(), 2, "should have 2 staff reports");
        assert_eq!(
            report_json_str["sales"]["byType"]["instore"]["cash"]["count"],
            3
        );
        assert_eq!(report_json_str["expenses"]["staffPaymentsTotal"], 0.0);
        assert_eq!(report_json_str["expenses"]["pendingCount"], 1);
        assert_eq!(report_json_str["drawers"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_preview_z_report_for_date_does_not_persist_or_enqueue() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_second_closed_shift(&db);

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let result = preview_z_report_for_date(&db, &payload).expect("preview should succeed");

        assert_eq!(result["success"], true);
        assert_eq!(result["preview"], true);

        let conn = db.conn.lock().unwrap();
        let z_reports_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        let queue_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'z_report'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(
            z_reports_count, 0,
            "preview should not persist local z_reports"
        );
        assert_eq!(
            queue_count, 0,
            "preview should not enqueue z_report sync rows"
        );
    }

    #[test]
    fn test_prepare_z_report_submission_reuses_existing_multi_shift_row_for_same_window() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_second_closed_shift(&db);

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });

        let first = prepare_z_report_submission(&db, &payload).expect("first prepare");
        let first_id = first
            .z_report_id
            .clone()
            .expect("first prepare should persist z-report");
        assert!(first.created_new_z_report);

        let second = prepare_z_report_submission(&db, &payload).expect("second prepare");
        let second_id = second
            .z_report_id
            .clone()
            .expect("second prepare should reuse z-report");
        assert_eq!(second_id, first_id);
        assert!(!second.created_new_z_report);

        let conn = db.conn.lock().unwrap();
        let z_reports_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        let queue_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'z_report'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(
            z_reports_count, 1,
            "should keep a single canonical local z-report row"
        );
        assert_eq!(queue_count, 1, "should keep a single z-report queue row");
    }

    #[test]
    fn test_generate_z_report_for_date_includes_first_shift_at_inferred_period_start() {
        let db = test_db();
        seed_closed_shift(&db);

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let result =
            generate_z_report_for_date(&db, &payload).expect("inferred-period-start generate");

        assert_eq!(result["success"], true);
        let report_json = result["report"]["reportJson"]
            .as_object()
            .expect("reportJson object");
        let staff_reports = report_json["staffReports"]
            .as_array()
            .expect("staffReports array");
        assert_eq!(
            staff_reports.len(),
            1,
            "should include the first closed shift at inferred period start"
        );
        assert_eq!(staff_reports[0]["staffShiftId"], "shift-zr-1");
        assert_eq!(report_json["cashDrawer"]["openingTotal"], 200.0);
        assert_eq!(report_json["cashDrawer"]["cashSales"], 60.0);
        assert_eq!(report_json["drawers"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_generate_z_report_for_date_enriches_driver_and_cashier_metrics() {
        let db = test_db();
        seed_cashier_driver_zreport_day(&db);

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-03-06",
        });
        let result = generate_z_report_for_date(&db, &payload).expect("driver/cashier z-report");

        assert_eq!(result["success"], true);
        let report_json = result["report"]["reportJson"]
            .as_object()
            .expect("reportJson object");
        let staff_reports = report_json["staffReports"].as_array().unwrap();
        assert_eq!(staff_reports.len(), 2);

        let cashier = staff_reports
            .iter()
            .find(|row| row["role"] == "cashier")
            .expect("cashier row");
        let driver = staff_reports
            .iter()
            .find(|row| row["role"] == "driver")
            .expect("driver row");

        assert_eq!(cashier["orders"]["count"], 2);
        assert_eq!(cashier["orders"]["cashAmount"], 12.0);
        assert_eq!(cashier["orders"]["cardAmount"], 18.0);
        assert_eq!(cashier["orders"]["totalAmount"], 30.0);

        assert_eq!(driver["driver"]["deliveries"], 2);
        assert_eq!(driver["driver"]["earnings"], 5.0);
        assert_eq!(driver["driver"]["cashCollected"], 32.5);
        assert_eq!(driver["driver"]["cardAmount"], 0.0);
        assert_eq!(driver["driver"]["cashToReturn"], 52.5);
        assert_eq!(driver["returnedToDrawerAmount"], 52.5);

        assert_eq!(
            report_json["sales"]["byType"]["delivery"]["cash"]["count"],
            2
        );
        assert_eq!(
            report_json["sales"]["byType"]["delivery"]["cash"]["total"],
            32.5
        );
        assert_eq!(report_json["driverEarnings"]["totalDeliveries"], 2);
        assert_eq!(report_json["driverEarnings"]["totalEarnings"], 5.0);
        assert_eq!(report_json["driverEarnings"]["cashCollectedTotal"], 32.5);
        assert_eq!(report_json["driverEarnings"]["cashToReturnTotal"], 52.5);
        assert_eq!(
            report_json["cashDrawer"]["driverCashBreakdown"][0]["cashCollected"],
            32.5
        );
        assert_eq!(
            report_json["cashDrawer"]["driverCashBreakdown"][0]["cashToReturn"],
            52.5
        );
    }

    #[test]
    fn test_generate_z_report_for_date_respects_period_start() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_second_closed_shift(&db);

        // Set period start to AFTER shift 1 but BEFORE shift 2
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(
                &conn,
                "system",
                "last_z_report_timestamp",
                "2026-02-16T13:00:00Z",
            )
            .expect("set period");
        }

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let result = generate_z_report_for_date(&db, &payload).expect("period-filtered generate");

        let report = &result["report"];

        // Only shift 2 data should appear (check_in_time > period_start)
        // But orders created_at after period_start: ord-4 and ord-5 only
        // However, payment timestamps of shift-1 orders are "2026-02-16T18:00:00Z" which is > 13:00
        // This is expected because period start filters by created_at not by shift
        // In the actual scenario the period start would be set AFTER all shift-1 data
        // Since shift-1 orders have created_at = 18:00 > 13:00 they DO appear
        // The real filtering happens at the shift level: shift 2 check_in = 14:00 > 13:00 OK
        // But shift 1 check_in = 09:00 < 13:00 so shift 1 is excluded from shift count
        // Note: orders are queried by created_at > period_start (not by shift assignment)

        // Shift 1 check_in 09:00 < 13:00 → excluded
        // Shift 2 check_in 14:00 > 13:00 → included
        // staffReports should only have 1 entry (shift 2)
        let report_json_val = report["reportJson"].as_object().unwrap();
        let staff_reports = report_json_val
            .get("staffReports")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(
            staff_reports.len(),
            1,
            "only shift 2 should be in staff reports"
        );
        assert_eq!(
            staff_reports[0]["staffName"], "Jane",
            "shift 2 staff is Jane"
        );
    }

    #[test]
    fn test_generate_single_shift_z_report_includes_driver_breakdown_starting_amount() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'cashier-zr', 'cashier-1', 'Cashier One', 'branch-1', 'term-1', 'cashier',
                100.0, 170.0, 170.0, 0.0,
                '2026-03-05T09:00:00Z', '2026-03-05T17:00:00Z', 'closed', 2,
                'pending', '2026-03-05T17:00:00Z', '2026-03-05T17:00:00Z'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, closing_amount, expected_amount, variance_amount,
                total_cash_sales, total_card_sales, total_refunds, total_expenses,
                cash_drops, driver_cash_given, driver_cash_returned, total_staff_payments,
                reconciled, opened_at, created_at, updated_at
             ) VALUES (
                'drawer-zr', 'cashier-zr', 'cashier-1', 'branch-1', 'term-1',
                100.0, 170.0, 170.0, 0.0,
                0.0, 0.0, 0.0, 0.0,
                0.0, 20.0, 70.0, 0.0,
                1, '2026-03-05T09:00:00Z', '2026-03-05T17:00:00Z', '2026-03-05T17:00:00Z'
             )",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'driver-zr', 'driver-1', 'Driver One', 'branch-1', 'term-1', 'driver',
                20.0, 70.0, 70.0, 0.0,
                '2026-03-05T10:00:00Z', '2026-03-05T16:00:00Z', 'closed', 2,
                'pending', '2026-03-05T16:00:00Z', '2026-03-05T16:00:00Z'
             )",
            [],
        )
        .unwrap();

        for (order_id, order_type, total_amount) in [
            ("delivery-order", "delivery", 50.0),
            ("pickup-order", "pickup", 40.0),
        ] {
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, status, order_type,
                    payment_status, payment_method, staff_shift_id, sync_status, created_at, updated_at
                 ) VALUES (?1, ?1, '[]', ?2, 'completed', ?3,
                    'paid', 'cash', 'driver-zr', 'pending', '2026-03-05T12:00:00Z', '2026-03-05T12:00:00Z')",
                params![order_id, total_amount, order_type],
            )
            .unwrap();

            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at
                 ) VALUES (?1, ?2, 'cash', ?3, 'completed', 'driver-zr', 'EUR', '2026-03-05T12:00:00Z', '2026-03-05T12:00:00Z')",
                params![format!("pay-{order_id}"), order_id, total_amount],
            )
            .unwrap();
        }
        drop(conn);

        let result = generate_z_report(&db, &serde_json::json!({ "shiftId": "cashier-zr" }))
            .expect("single-shift z-report");

        let breakdown = result["report"]["reportJson"]["cashDrawer"]["driverCashBreakdown"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(breakdown.len(), 1);
        assert_eq!(breakdown[0]["driverName"], "Driver One");
        assert_eq!(breakdown[0]["startingAmount"], 20.0);
        assert_eq!(breakdown[0]["cashCollected"], 50.0);
        assert_eq!(breakdown[0]["cashToReturn"], 70.0);
    }

    #[test]
    fn test_generate_driver_shift_z_report_includes_starting_amount_without_cash_drawer() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'driver-zr-single', 'driver-9', 'Driver Nine', 'branch-9', 'term-9', 'driver',
                20.0, 65.0, 65.0, 0.0,
                '2026-03-05T10:00:00Z', '2026-03-05T16:00:00Z', 'closed', 2,
                'pending', '2026-03-05T16:00:00Z', '2026-03-05T16:00:00Z'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, status, order_type,
                payment_status, payment_method, staff_shift_id, staff_id, driver_id,
                sync_status, created_at, updated_at
             ) VALUES (
                'delivery-zr-single', 'ORD-DRIVER-1', '[]', 45.0, 'completed', 'delivery',
                'paid', 'cash', 'driver-zr-single', 'driver-9', 'driver-9',
                'pending', '2026-03-05T12:00:00Z', '2026-03-05T12:00:00Z'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at
             ) VALUES (
                'pay-driver-zr-single', 'delivery-zr-single', 'cash', 45.0, 'completed',
                'driver-zr-single', 'EUR', '2026-03-05T12:00:00Z', '2026-03-05T12:00:00Z'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        let result = generate_z_report(&db, &serde_json::json!({ "shiftId": "driver-zr-single" }))
            .expect("driver single-shift z-report");

        let breakdown = result["report"]["reportJson"]["cashDrawer"]["driverCashBreakdown"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(breakdown.len(), 1);
        assert_eq!(breakdown[0]["driverName"], "Driver Nine");
        assert_eq!(breakdown[0]["startingAmount"], 20.0);
        assert_eq!(breakdown[0]["cashCollected"], 45.0);
        assert_eq!(breakdown[0]["cashToReturn"], 65.0);
    }

    // ---------------------------------------------------------------
    // Gap 8: Data clearing (local day rollover)
    // ---------------------------------------------------------------

    #[test]
    fn test_apply_local_day_rollover_clears_operational_data() {
        let db = test_db();
        seed_closed_shift(&db);

        // Verify data exists before cleanup
        {
            let conn = db.conn.lock().unwrap();
            let orders: i64 = conn
                .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
                .unwrap();
            assert_eq!(orders, 3, "should have 3 orders before cleanup");
            let payments: i64 = conn
                .query_row("SELECT COUNT(*) FROM order_payments", [], |row| row.get(0))
                .unwrap();
            assert_eq!(payments, 3, "should have 3 payments before cleanup");
        }

        let result = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("cleanup should succeed");

        // Verify counts returned
        assert_eq!(result["orders"], 3, "should clear 3 orders");
        assert_eq!(result["order_payments"], 3, "should clear 3 payments");
        assert_eq!(
            result["payment_adjustments"], 1,
            "should clear 1 adjustment"
        );
        assert_eq!(result["shift_expenses"], 1, "should clear 1 expense");
        assert_eq!(result["staff_shifts"], 1, "should clear 1 shift");
        assert_eq!(result["cash_drawer_sessions"], 1, "should clear 1 drawer");

        // Verify tables are empty after cleanup
        let conn = db.conn.lock().unwrap();
        let orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(orders, 0, "orders should be empty after cleanup");
        let shifts: i64 = conn
            .query_row("SELECT COUNT(*) FROM staff_shifts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(shifts, 0, "staff_shifts should be empty after cleanup");
    }

    #[test]
    fn test_apply_local_day_rollover_preserves_z_reports() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        // Generate a Z-report first
        generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id })).unwrap();

        // Verify z_report exists
        {
            let conn = db.conn.lock().unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1);
        }

        // Cleanup
        apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z").expect("cleanup");

        // z_reports should still be there
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "z_reports must be preserved after cleanup");

        // local_settings should still be there
        let settings: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_settings", [], |row| row.get(0))
            .unwrap();
        // We didn't explicitly seed local_settings, but schema creates the table
        assert!(settings >= 0, "local_settings table should exist");
    }

    #[test]
    fn test_apply_local_day_rollover_preserves_rows_after_cutoff() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_late_day_order(&db, "2026-02-16T19:00:00Z");
        seed_next_day_active_shift(&db, "2026-02-17T08:00:00Z");

        let result = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T18:00:00Z")
            .expect("cleanup should succeed");

        assert_eq!(
            result["orders"], 3,
            "only pre-cutoff orders should be cleared"
        );
        assert_eq!(
            result["order_payments"], 3,
            "only pre-cutoff payments should be cleared"
        );
        assert_eq!(
            result["staff_shifts"], 1,
            "only the closed business-day shift should be cleared"
        );

        let conn = db.conn.lock().unwrap();
        let remaining_orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining_orders, 1, "post-cutoff order must remain locally");

        let remaining_order_id: String = conn
            .query_row("SELECT id FROM orders LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining_order_id, "ord-late");

        let remaining_active_shifts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM staff_shifts WHERE status = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            remaining_active_shifts, 1,
            "next-day active shift must remain"
        );
    }

    #[test]
    fn test_local_day_rollover_preserves_unsynced_sync_queue() {
        let db = test_db();
        seed_closed_shift(&db);

        // Add a synced entry and a pending entry to sync_queue
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status, created_at)
                 VALUES ('order', 'ord-1', 'insert', '{}', 'key-synced', 'synced', '2026-02-16T10:00:00Z')",
                [],
            ).expect("insert synced entry");
            conn.execute(
                "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status, created_at)
                 VALUES ('order', 'ord-2', 'insert', '{}', 'key-pending', 'pending', '2026-02-16T10:00:00Z')",
                [],
            ).expect("insert pending entry");
        }

        let result =
            apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z").expect("cleanup");

        // Only synced entry should be deleted
        assert_eq!(
            result["sync_queue"], 1,
            "only synced entry should be cleared"
        );

        // Pending entry should remain
        let conn = db.conn.lock().unwrap();
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, 1, "pending sync_queue entry should be preserved");
    }

    #[test]
    fn test_local_day_rollover_preserves_parent_shift_for_unsynced_staff_payment() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        {
            let conn = db.conn.lock().unwrap();
            ensure_staff_payments_table(&conn);
            conn.execute(
                "INSERT INTO staff_payments (
                    id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at
                 ) VALUES (
                    'payment-orphan-risk', ?1, 'staff-2', 15.0, 'wage', 'late wage', '2026-02-16T18:30:38Z'
                 )",
                params![shift_id.clone()],
            )
            .expect("insert staff payment");
            conn.execute(
                "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status, created_at)
                 VALUES (
                    'staff_payment',
                    'payment-orphan-risk',
                    'insert',
                    ?1,
                    'staff-payment-pending',
                    'pending',
                    '2026-02-16T18:30:38Z'
                 )",
                params![serde_json::json!({
                    "id": "payment-orphan-risk",
                    "cashierShiftId": shift_id.clone(),
                    "paidByCashierShiftId": shift_id.clone(),
                    "paidToStaffId": "staff-2",
                    "amount": 15.0,
                    "paymentType": "wage",
                    "createdAt": "2026-02-16T18:30:38Z",
                    "updatedAt": "2026-02-16T18:30:38Z"
                })
                .to_string()],
            )
            .expect("insert pending staff payment sync row");
        }

        let result = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("cleanup should succeed");

        assert_eq!(
            result["staff_payments"], 0,
            "unsynced staff payment should remain locally"
        );
        assert_eq!(
            result["staff_shifts"], 0,
            "parent cashier shift should remain locally while payment is unsynced"
        );
        assert_eq!(
            result["cash_drawer_sessions"], 0,
            "cash drawer should remain locally while parent shift is protected"
        );

        let conn = db.conn.lock().unwrap();
        let remaining_payment: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM staff_payments WHERE id = 'payment-orphan-risk'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_payment, 1, "staff payment should remain");

        let remaining_shift: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM staff_shifts WHERE id = ?1",
                params![shift_id.clone()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_shift, 1, "parent shift should remain");

        let remaining_drawer: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
                params![shift_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_drawer, 1, "parent drawer should remain");
    }

    // ---------------------------------------------------------------
    // Submit Z-report (full flow)
    // ---------------------------------------------------------------

    #[test]
    fn test_submit_z_report_stores_timestamp_and_cleans() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_second_closed_shift(&db);

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let result = submit_z_report(&db, &payload).expect("submit should succeed");

        assert_eq!(result["success"], true);
        assert_eq!(result["localDayClosed"], true);
        assert_eq!(result["syncQueued"], true);
        assert_eq!(result["syncState"], "pending");
        assert!(result["cleanup"].is_object(), "should have cleanup counts");
        assert!(
            result["lastZReportTimestamp"].as_str().is_some(),
            "should have timestamp"
        );

        // Verify last_z_report_timestamp was stored
        let conn = db.conn.lock().unwrap();
        let stored = db::get_setting(&conn, "system", "last_z_report_timestamp");
        assert!(stored.is_some(), "timestamp should be stored in settings");
        let orders_since = db::get_setting(&conn, "sync", "orders_since");
        assert_eq!(
            orders_since, stored,
            "orders_since cursor should advance with z-report submit"
        );
        assert!(
            db::get_setting(&conn, "system", PENDING_Z_REPORT_CONTEXT_KEY).is_none(),
            "pending z-report context should be cleared after local close"
        );

        // Verify operational data was cleared
        let orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(orders, 0, "orders should be cleared after submit");

        // Verify z_reports persisted (the generated report + sync entry)
        let z_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        assert_eq!(z_count, 1, "z_report should be persisted");

        let queued_z_reports: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'z_report' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            queued_z_reports, 1,
            "z_report sync queue entry should be preserved for later admin sync"
        );
    }

    #[test]
    fn test_get_end_of_day_status_synthesizes_pending_context_from_closed_shifts() {
        let db = test_db();
        seed_closed_shift(&db);

        let status = get_end_of_day_status(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
            }),
        )
        .expect("status should load");

        assert_eq!(status["status"], "pending_local_submit");
        assert_eq!(status["pendingReportDate"], "2026-02-16");
        assert_eq!(status["cutoffAt"], "2026-02-16T18:00:00Z");
        assert_eq!(status["canOpenPendingZReport"], true);
    }

    #[test]
    fn test_get_end_of_day_status_idle_for_same_day_closed_shifts() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        // Insert a shift that closed *today* — this should NOT trigger pending status
        let today = Local::now();
        let check_in = (today - chrono::Duration::hours(8))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        let check_out = today.format("%Y-%m-%dT%H:%M:%SZ").to_string();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-today', 'staff-1', 'John', 'branch-1', 'term-1', 'cashier',
                200.0, 235.0, 235.0, 0.0,
                ?1, ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![check_in, check_out],
        )
        .expect("insert today shift");

        // Seed minimal order data so the repair query does not error
        conn.execute(
            "INSERT INTO orders (id, branch_id, order_number, order_type, status, total_amount, created_at, updated_at)
             VALUES ('ord-today', 'branch-1', 1001, 'dine_in', 'completed', 10.0, ?1, ?1)",
            params![check_out],
        )
        .expect("insert order");

        drop(conn);

        let status = get_end_of_day_status(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
            }),
        )
        .expect("status should load");

        // Same-day closed shifts must NOT produce a pending Z-report
        assert_eq!(
            status["status"], "idle",
            "same-day closed shifts should not trigger pending Z-report"
        );
    }

    #[test]
    fn test_get_end_of_day_status_uses_business_day_start_for_overnight_shift() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        let today = Local::now().date_naive();
        let previous_day = today
            .checked_sub_days(chrono::Days::new(1))
            .expect("previous day");
        let check_in_local = Local
            .from_local_datetime(&previous_day.and_hms_opt(15, 0, 0).expect("15:00"))
            .single()
            .expect("local 15:00");
        let check_out_local = Local
            .from_local_datetime(&today.and_hms_opt(6, 0, 0).expect("06:00"))
            .single()
            .expect("local 06:00");
        let check_in = check_in_local
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let check_out = check_out_local
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let expected_report_date = previous_day.format("%Y-%m-%d").to_string();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-overnight', 'staff-1', 'John', 'branch-1', 'term-1', 'cashier',
                200.0, 235.0, 235.0, 0.0,
                ?1, ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![check_in, check_out],
        )
        .expect("insert overnight shift");
        drop(conn);

        let status = get_end_of_day_status(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
            }),
        )
        .expect("status should load");

        assert_eq!(status["status"], "pending_local_submit");
        assert_eq!(status["pendingReportDate"], expected_report_date);
    }

    #[test]
    fn test_get_end_of_day_status_idle_exposes_active_business_window() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        let today = Local::now().date_naive();
        let previous_day = today
            .checked_sub_days(chrono::Days::new(1))
            .expect("previous day");
        let check_in_local = Local
            .from_local_datetime(&previous_day.and_hms_opt(15, 0, 0).expect("15:00"))
            .single()
            .expect("local 15:00");
        let check_in = check_in_local
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let expected_report_date = previous_day.format("%Y-%m-%d").to_string();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, check_in_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-active-overnight', 'staff-1', 'John', 'branch-1', 'term-1', 'cashier',
                200.0, ?1, 'active', 2,
                'pending', ?1, ?1
             )",
            params![check_in],
        )
        .expect("insert active overnight shift");
        drop(conn);

        let status = get_end_of_day_status(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
            }),
        )
        .expect("status should load");

        assert_eq!(status["status"], "idle");
        assert_eq!(status["activeReportDate"], expected_report_date);
        assert_eq!(status["activePeriodStartAt"], check_in);
    }

    #[test]
    fn test_generate_z_report_for_date_uses_frozen_cutoff_to_exclude_late_orders() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_late_day_order(&db, "2026-02-16T19:00:00Z");

        {
            let conn = db.conn.lock().unwrap();
            persist_pending_z_report_context(
                &conn,
                &PendingZReportContext {
                    branch_id: "branch-1".to_string(),
                    report_date: "2026-02-16".to_string(),
                    cutoff_at: "2026-02-16T18:00:00Z".to_string(),
                    period_start_at: "1970-01-01T00:00:00Z".to_string(),
                },
            )
            .expect("persist frozen context");
        }

        let result = generate_z_report_for_date(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
                "date": "2026-02-17",
            }),
        )
        .expect("generate should succeed");

        let report = &result["report"];
        assert_eq!(report["reportDate"], "2026-02-16");
        assert_eq!(report["totalOrders"], 3);
        assert_eq!(report["grossSales"], 100.0);
        assert_eq!(report["reportJson"]["periodStart"], "2026-02-16T09:00:00Z");
        assert_eq!(report["reportJson"]["periodEnd"], "2026-02-16T18:00:00Z");
    }

    #[test]
    fn test_submit_z_report_ignores_next_day_active_shift_after_cutoff() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_next_day_active_shift(&db, "2026-02-17T08:00:00Z");

        {
            let conn = db.conn.lock().unwrap();
            persist_pending_z_report_context(
                &conn,
                &PendingZReportContext {
                    branch_id: "branch-1".to_string(),
                    report_date: "2026-02-16".to_string(),
                    cutoff_at: "2026-02-16T18:00:00Z".to_string(),
                    period_start_at: "1970-01-01T00:00:00Z".to_string(),
                },
            )
            .expect("persist frozen context");
        }

        let result = submit_z_report(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
            }),
        )
        .expect("submit should succeed with next-day active shift");

        assert_eq!(result["localDayClosed"], true);
        assert_eq!(result["lastZReportTimestamp"], "2026-02-16T18:00:00Z");

        let conn = db.conn.lock().unwrap();
        let remaining_active_shifts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM staff_shifts WHERE status = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_active_shifts, 1, "next-day shift must remain");

        let status = get_end_of_day_status(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
            }),
        )
        .expect("status should load");
        assert_eq!(status["status"], "submitted_pending_admin");
        assert_eq!(status["canOpenPendingZReport"], false);
    }

    #[test]
    fn test_get_end_of_day_status_clears_stale_pending_context_after_local_rollover() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id })).unwrap();

        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(
                &conn,
                "system",
                "last_z_report_timestamp",
                "2026-02-16T18:00:00Z",
            )
            .unwrap();
            persist_pending_z_report_context(
                &conn,
                &PendingZReportContext {
                    branch_id: "branch-1".to_string(),
                    report_date: "2026-02-16".to_string(),
                    cutoff_at: "2026-02-16T18:00:00Z".to_string(),
                    period_start_at: "1970-01-01T00:00:00Z".to_string(),
                },
            )
            .unwrap();
        }

        let status = get_end_of_day_status(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
            }),
        )
        .expect("status should load");

        assert_eq!(status["status"], "submitted_pending_admin");

        let conn = db.conn.lock().unwrap();
        assert!(
            db::get_setting(&conn, "system", PENDING_Z_REPORT_CONTEXT_KEY).is_none(),
            "stale pending context should be cleared once last_z_report_timestamp covers cutoff"
        );
    }

    #[test]
    fn test_submit_z_report_ignores_unpaid_orders_from_other_branch() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_other_branch_unpaid_order(&db, "2026-02-16T17:00:00Z");

        let result = submit_z_report(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
                "date": "2026-02-16",
            }),
        )
        .expect("submit should ignore other-branch unpaid orders");

        assert_eq!(result["success"], true);
        assert_eq!(result["localDayClosed"], true);
    }

    #[test]
    fn test_submit_z_report_ignores_stale_payment_status_when_settled_payments_exist() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_paid_order_with_stale_payment_status(&db, "2026-02-16T17:00:00Z");

        let result = submit_z_report(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
                "date": "2026-02-16",
            }),
        )
        .expect("submit should treat settled payment rows as paid even if payment_status is stale");

        assert_eq!(result["success"], true);
        assert_eq!(result["localDayClosed"], true);
    }

    #[test]
    fn test_submit_z_report_discards_generated_report_when_local_rollover_fails() {
        let db = test_db();
        seed_closed_shift(&db);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute("DROP TABLE local_settings", [])
                .expect("drop local_settings to force rollover failure");
        }

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let result = submit_z_report(&db, &payload);
        assert!(
            result.is_err(),
            "submit should fail if rollover metadata cannot be written"
        );

        let conn = db.conn.lock().unwrap();

        let orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(orders, 3, "orders should remain when rollover fails");

        let shifts: i64 = conn
            .query_row("SELECT COUNT(*) FROM staff_shifts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(shifts, 1, "staff shifts should remain when rollover fails");

        let z_reports: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            z_reports, 0,
            "generated z_report should be discarded if the local rollover fails"
        );

        let queued_z_reports: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'z_report'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            queued_z_reports, 0,
            "z_report sync queue entry should be discarded with its generated report"
        );
    }
}
